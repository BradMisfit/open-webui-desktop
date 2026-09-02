/**
 * Findings store + report generation (Security Workspace, main process).
 * Holds bounded security findings from passive analysis, the user, or (later)
 * AI/active checks, and renders an exportable Markdown report. Findings are
 * annotations over captured evidence — no raw secrets are stored here.
 */
import type { FindingCandidate } from './captureEngine'

export interface Finding extends FindingCandidate {
  id: string
  source: 'passive' | 'user' | 'ai' | 'active'
  createdAt: number
  status: 'open' | 'confirmed' | 'dismissed'
  notes?: string
}

const MAX_FINDINGS = 500
const findings = new Map<string, Finding>()
let nextId = 1

const SEV_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 }

function keyOf(f: { category: string; host: string; path: string; title: string }): string {
  return `${f.category}|${f.host}|${f.path}|${f.title}`
}

export function addFindings(cands: FindingCandidate[], source: Finding['source'] = 'passive'): { added: number } {
  const existing = new Set([...findings.values()].map(keyOf))
  let added = 0
  for (const c of cands) {
    if (findings.size >= MAX_FINDINGS) break
    const k = keyOf(c)
    if (existing.has(k)) continue
    existing.add(k)
    const id = `f${nextId++}`
    findings.set(id, { ...c, id, source, createdAt: Date.now(), status: 'open' })
    added++
  }
  return { added }
}

export function addFinding(input: Partial<Finding>, source: Finding['source'] = 'user'): Finding {
  const id = `f${nextId++}`
  const f: Finding = {
    id,
    severity: (input.severity as Finding['severity']) || 'info',
    category: input.category || 'custom',
    title: input.title || 'Finding',
    method: input.method || '',
    url: input.url || '',
    host: input.host || '',
    path: input.path || '',
    description: input.description || '',
    remediation: input.remediation || '',
    evidence: input.evidence || '',
    entryId: input.entryId || '',
    source,
    createdAt: Date.now(),
    status: 'open',
    notes: input.notes
  }
  findings.set(id, f)
  return f
}

export function listFindings(): Finding[] {
  return [...findings.values()].sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || (b.createdAt - a.createdAt))
}

export function updateFinding(id: string, patch: Partial<Finding>): Finding | null {
  const f = findings.get(id)
  if (!f) return null
  const next = { ...f, ...patch, id: f.id }
  findings.set(id, next)
  return next
}

export function deleteFinding(id: string): boolean {
  return findings.delete(id)
}

export function clearFindings(): void {
  findings.clear()
}

export function findingsSummary(): { total: number; bySeverity: Record<string, number> } {
  const bySeverity: Record<string, number> = { high: 0, medium: 0, low: 0, info: 0 }
  for (const f of findings.values()) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1
  return { total: findings.size, bySeverity }
}

/** Render a Markdown security report from the current findings. */
export function generateReport(meta: { title?: string; scope?: string[] } = {}): string {
  const list = listFindings()
  const s = findingsSummary()
  const now = new Date().toISOString()
  const lines: string[] = []
  lines.push(`# ${meta.title || 'Web Security Assessment'}`)
  lines.push('')
  lines.push(`_Generated ${now} — for authorized testing only._`)
  lines.push('')
  if (meta.scope?.length) {
    lines.push(`**Authorized scope:** ${meta.scope.join(', ')}`)
    lines.push('')
  }
  lines.push('## Summary')
  lines.push('')
  lines.push(`| Severity | Count |`)
  lines.push(`| --- | --- |`)
  for (const sev of ['high', 'medium', 'low', 'info']) lines.push(`| ${sev} | ${s.bySeverity[sev] || 0} |`)
  lines.push(`| **Total** | **${s.total}** |`)
  lines.push('')
  lines.push('## Findings')
  lines.push('')
  if (!list.length) lines.push('_No findings recorded._')
  let n = 1
  for (const f of list) {
    lines.push(`### ${n}. [${f.severity.toUpperCase()}] ${f.title}`)
    lines.push('')
    if (f.method || f.url) lines.push(`- **Endpoint:** \`${f.method} ${f.url}\``)
    lines.push(`- **Category:** ${f.category}`)
    lines.push(`- **Status:** ${f.status}`)
    if (f.evidence) lines.push(`- **Evidence:** ${f.evidence}`)
    lines.push('')
    if (f.description) { lines.push(f.description); lines.push('') }
    if (f.remediation) { lines.push(`**Remediation:** ${f.remediation}`); lines.push('') }
    if (f.notes) { lines.push(`**Notes:** ${f.notes}`); lines.push('') }
    n++
  }
  return lines.join('\n')
}
