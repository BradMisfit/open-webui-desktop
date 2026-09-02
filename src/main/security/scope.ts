/**
 * Security Workspace — authorized scope (Desktop shell, main process).
 *
 * The scope is the safety backbone of the whole Pentest Workspace: a
 * user-declared set of authorized targets (hosts / IP literals / CIDR ranges).
 * Every *active* operation (intercept-modify, repeater send, fuzzing, active
 * checks) hard-refuses a target that is not in scope. Passive capture may be
 * filtered to in-scope only, but is never itself an attack.
 *
 * Trust boundary: scope lives only in the trusted main process. It is declared
 * by the user through the Security panel (never by the model, never by a page).
 * A model-issued request to *widen* scope is rejected here — the gateway only
 * ever calls `isInScope`, never `setScope`.
 */

export interface ScopeRule {
  /** Original text the user typed, e.g. "example.com", "*.lab.local", "10.0.0.0/24", "127.0.0.1:8080". */
  raw: string
  kind: 'host' | 'wildcard' | 'cidr' | 'ip'
  /** Normalized host (lowercased, no port) for host/wildcard/ip. */
  host?: string
  /** Optional port constraint; undefined = any port. */
  port?: number
  /** For cidr: parsed base + prefix (IPv4 only in Phase A). */
  cidrBase?: number
  cidrBits?: number
}

export interface ScopeState {
  /** Master switch. When false, every active op is refused regardless of rules. */
  enabled: boolean
  rules: ScopeRule[]
  /** When true, passive capture only records in-scope traffic. */
  captureInScopeOnly: boolean
}

let state: ScopeState = { enabled: true, rules: [], captureInScopeOnly: false }

export function getScope(): ScopeState {
  return { enabled: state.enabled, rules: state.rules.map((r) => ({ ...r })), captureInScopeOnly: state.captureInScopeOnly }
}

/** Replace the scope. Only ever called from the user-driven IPC path. */
export function setScope(input: { enabled?: boolean; targets?: string[]; captureInScopeOnly?: boolean }): ScopeState {
  const targets = Array.isArray(input.targets) ? input.targets : state.rules.map((r) => r.raw)
  const rules: ScopeRule[] = []
  for (const t of targets) {
    const rule = parseTarget(String(t || ''))
    if (rule) rules.push(rule)
  }
  state = {
    enabled: input.enabled === undefined ? state.enabled : !!input.enabled,
    rules,
    captureInScopeOnly: input.captureInScopeOnly === undefined ? state.captureInScopeOnly : !!input.captureInScopeOnly
  }
  return getScope()
}

function parseTarget(raw: string): ScopeRule | null {
  const v = raw.trim().toLowerCase()
  if (!v) return null
  // Strip scheme if the user pasted a URL.
  let s = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  // Strip path.
  s = s.split('/')[0]
  // CIDR (IPv4).
  const cidr = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(raw.trim())
  if (cidr) {
    const base = ipv4ToInt(cidr[1])
    const bits = parseInt(cidr[2], 10)
    if (base !== null && bits >= 0 && bits <= 32) {
      return { raw: raw.trim(), kind: 'cidr', cidrBase: base, cidrBits: bits }
    }
  }
  // host[:port]
  let host = s
  let port: number | undefined
  const portMatch = /^(.*):(\d{1,5})$/.exec(s)
  if (portMatch) {
    host = portMatch[1]
    port = parseInt(portMatch[2], 10)
  }
  if (!host) return null
  if (host.startsWith('*.')) {
    return { raw: raw.trim(), kind: 'wildcard', host, port }
  }
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return { raw: raw.trim(), kind: 'ip', host, port }
  }
  return { raw: raw.trim(), kind: 'host', host, port }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map((p) => parseInt(p, 10))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

/**
 * Is a URL (or bare host) an authorized *active* target?
 * Active tools MUST call this and refuse when it returns false.
 */
export function isInScope(target: string): boolean {
  if (!state.enabled) return false
  if (!state.rules.length) return false
  const { host, port } = hostPortOf(target)
  if (!host) return false
  for (const r of state.rules) {
    if (matchRule(r, host, port)) return true
  }
  return false
}

function hostPortOf(target: string): { host: string | null; port?: number } {
  let t = String(target || '').trim().toLowerCase()
  if (!t) return { host: null }
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(t)) {
      const u = new URL(t)
      return { host: u.hostname, port: u.port ? parseInt(u.port, 10) : undefined }
    }
  } catch {
    /* fall through to manual parse */
  }
  t = t.split('/')[0]
  const m = /^(.*):(\d{1,5})$/.exec(t)
  if (m) return { host: m[1], port: parseInt(m[2], 10) }
  return { host: t }
}

function matchRule(r: ScopeRule, host: string, port?: number): boolean {
  if (r.port !== undefined && port !== undefined && r.port !== port) return false
  switch (r.kind) {
    case 'host':
      return r.host === host
    case 'ip':
      return r.host === host
    case 'wildcard': {
      const base = (r.host || '').slice(2) // drop "*."
      return host === base || host.endsWith('.' + base)
    }
    case 'cidr': {
      if (r.cidrBase === undefined || r.cidrBits === undefined) return false
      const ip = ipv4ToInt(host)
      if (ip === null) return false
      if (r.cidrBits === 0) return true
      const mask = r.cidrBits === 32 ? 0xffffffff : (~(0xffffffff >>> r.cidrBits)) >>> 0
      return ((ip & mask) >>> 0) === ((r.cidrBase & mask) >>> 0)
    }
    default:
      return false
  }
}
