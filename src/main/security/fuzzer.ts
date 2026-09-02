/**
 * Controlled Fuzzer / Intruder (Security Workspace, main process). Substitutes
 * each payload into a marked request and sends it through the trusted, scope-gated
 * Repeater, collecting {payload, status, length, time, interesting}. Hard safety
 * bounds so this can never become an unbounded or out-of-scope mass-request
 * primitive: absolute request cap, capped concurrency, rate limit, per-request
 * timeout (via the Repeater), response-size cap (via the Repeater), and cancel.
 * Progress is pushed live; every request is auditable via the capture history.
 */
import type { Session } from 'electron'
import { sendRepeaterRequest, type RepeaterRequest } from './repeater'
import { isInScope } from './scope'

const ABS_MAX_REQUESTS = 1000
const MAX_CONCURRENCY = 10
const DEFAULT_MARKER = '§'

export interface FuzzConfig {
  marker?: string
  payloads: string[]
  concurrency?: number
  rateLimitMs?: number
  maxRequests?: number
}
export interface FuzzRequest extends RepeaterRequest {}
export interface FuzzRow {
  payload: string
  ok: boolean
  status?: number
  length?: number
  durationMs?: number
  error?: string
  interesting?: boolean
}

interface Job {
  id: string
  cancelled: boolean
}
const jobs = new Map<string, Job>()
let jobSeq = 1

let progressPush: ((data: object) => void) | null = null
export function setFuzzProgressPusher(fn: (data: object) => void): void {
  progressPush = fn
}

export function cancelFuzz(jobId: string): { ok: boolean } {
  const j = jobs.get(jobId)
  if (j) j.cancelled = true
  return { ok: !!j }
}

function applyPayload(req: FuzzRequest, marker: string, payload: string): FuzzRequest {
  const sub = (s: string): string => s.split(marker).join(payload)
  return {
    method: req.method,
    url: sub(req.url || ''),
    headers: (req.headers || []).map((h) => ({ name: h.name, value: sub(h.value) })),
    body: req.body != null ? sub(req.body) : undefined,
    protectedFromId: req.protectedFromId
  }
}

export async function runFuzz(
  browserSession: Session,
  req: FuzzRequest,
  cfg: FuzzConfig
): Promise<{ ok: boolean; error?: string; jobId?: string; baseline?: FuzzRow; rows?: FuzzRow[]; cancelled?: boolean }> {
  const marker = cfg.marker || DEFAULT_MARKER
  const url = String(req.url || '')
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http(s) URLs can be fuzzed' }
  if (!isInScope(url.split(marker).join(''))) {
    return { ok: false, error: 'target is not in the authorized scope; add it in the Scope tab first' }
  }
  const payloads = (Array.isArray(cfg.payloads) ? cfg.payloads : []).slice(0, ABS_MAX_REQUESTS)
  const maxReq = Math.min(cfg.maxRequests ?? payloads.length, ABS_MAX_REQUESTS, payloads.length)
  const list = payloads.slice(0, maxReq)
  if (!list.length) return { ok: false, error: 'no payloads' }
  const concurrency = Math.min(Math.max(cfg.concurrency ?? 3, 1), MAX_CONCURRENCY)
  const rateLimitMs = Math.min(Math.max(cfg.rateLimitMs ?? 0, 0), 5000)

  const jobId = `fz${jobSeq++}`
  const job: Job = { id: jobId, cancelled: false }
  jobs.set(jobId, job)

  // Baseline (marker removed) to flag anomalies.
  const baseResp = await sendRepeaterRequest(browserSession, applyPayload(req, marker, ''))
  const baseline: FuzzRow = {
    payload: '(baseline)', ok: baseResp.ok, status: baseResp.status,
    length: baseResp.body?.size, durationMs: baseResp.durationMs, error: baseResp.error
  }
  const baseStatus = baseResp.status
  const baseLen = baseResp.body?.size ?? 0

  const rows: FuzzRow[] = new Array(list.length)
  let done = 0
  let idx = 0
  let lastStart = 0

  async function worker(): Promise<void> {
    while (true) {
      if (job.cancelled) return
      const i = idx++
      if (i >= list.length) return
      // rate limit (space out request starts)
      if (rateLimitMs) {
        const wait = lastStart + rateLimitMs - Date.now()
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      }
      lastStart = Date.now()
      const payload = list[i]
      const resp = await sendRepeaterRequest(browserSession, applyPayload(req, marker, payload))
      const len = resp.body?.size ?? 0
      const interesting = resp.ok && (resp.status !== baseStatus || (baseLen > 0 && Math.abs(len - baseLen) / Math.max(baseLen, 1) > 0.15))
      rows[i] = { payload, ok: resp.ok, status: resp.status, length: len, durationMs: resp.durationMs, error: resp.error, interesting: !!interesting }
      done++
      if (progressPush) progressPush({ type: 'security:fuzz-progress', data: { jobId, done, total: list.length, row: rows[i] } })
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  jobs.delete(jobId)
  return { ok: true, jobId, baseline, rows: rows.filter(Boolean), cancelled: job.cancelled }
}
