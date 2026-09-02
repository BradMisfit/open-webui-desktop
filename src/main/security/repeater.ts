/**
 * Repeater (Security Workspace, main process). Re-sends an edited HTTP request
 * through the visible browser session's network stack (Electron `net` bound to
 * the browser partition, so it shares cookies/TLS with the tab the user sees),
 * and returns the bounded response.
 *
 * Two safety properties:
 *  • Scope-gated: refuses any target not in the user-declared authorized scope.
 *  • Protected-auth reuse: a header the caller left as "[REDACTED]" is filled
 *    from the raw captured request (main-process only) so an authorized request
 *    can be replayed WITHOUT the secret ever passing through the model or the UI.
 */
import { net, type Session } from 'electron'
import { isInScope } from './scope'
import { getRawRequest } from './captureEngine'

const MAX_RESP_BODY = 512 * 1024
const REDACTED = '[REDACTED]'

export interface RepeaterRequest {
  method?: string
  url?: string
  headers?: Array<{ name: string; value: string }>
  body?: string
  /** Fill any "[REDACTED]" header value from this captured entry's raw headers. */
  protectedFromId?: string
}

export interface RepeaterResult {
  ok: boolean
  error?: string
  status?: number
  statusText?: string
  headers?: Array<{ name: string; value: string }>
  body?: { text?: string; base64?: boolean; size: number; truncated: boolean; binary?: boolean }
  durationMs?: number
  url?: string
  outOfScope?: boolean
}

// headers net won't let us set (managed by the stack); skip silently.
const FORBIDDEN = /^(host|content-length|connection|transfer-encoding|:.*)/i

function fillProtected(headers: Array<{ name: string; value: string }>, protectedFromId?: string): Array<{ name: string; value: string }> {
  const raw = protectedFromId ? getRawRequest(protectedFromId) : null
  const out: Array<{ name: string; value: string }> = []
  for (const h of headers) {
    if (h.value === REDACTED) {
      const src = raw?.headers.find((r) => r.name.toLowerCase() === h.name.toLowerCase())
      if (src) out.push({ name: h.name, value: src.value })
      // else: drop the header rather than send the literal "[REDACTED]"
      continue
    }
    out.push(h)
  }
  return out
}

export async function sendRepeaterRequest(browserSession: Session, req: RepeaterRequest): Promise<RepeaterResult> {
  const url = String(req.url || '').trim()
  const method = String(req.method || 'GET').toUpperCase()
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http(s) URLs can be sent' }
  if (!isInScope(url)) {
    return { ok: false, outOfScope: true, error: 'target is not in the authorized scope; add it in the Scope tab first' }
  }
  const headers = fillProtected(Array.isArray(req.headers) ? req.headers : [], req.protectedFromId)
  const started = Date.now()

  return await new Promise<RepeaterResult>((resolve) => {
    let settled = false
    const done = (r: RepeaterResult): void => {
      if (settled) return
      settled = true
      resolve(r)
    }
    let request: Electron.ClientRequest
    try {
      request = net.request({ method, url, session: browserSession, redirect: 'follow' })
    } catch (e) {
      done({ ok: false, error: String((e as Error)?.message || e) })
      return
    }
    for (const h of headers) {
      if (FORBIDDEN.test(h.name)) continue
      try {
        request.setHeader(h.name, h.value)
      } catch {
        /* skip a header the stack refuses */
      }
    }
    request.on('response', (response) => {
      const chunks: Buffer[] = []
      let total = 0
      let truncated = false
      response.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (!truncated) {
          if (total > MAX_RESP_BODY) {
            truncated = true
            chunks.push(chunk.subarray(0, Math.max(0, MAX_RESP_BODY - (total - chunk.length))))
          } else {
            chunks.push(chunk)
          }
        }
      })
      response.on('end', () => {
        const buf = Buffer.concat(chunks)
        const binary = buf.subarray(0, 1024).includes(0)
        const respHeaders: Array<{ name: string; value: string }> = []
        for (const [name, value] of Object.entries(response.headers || {})) {
          if (Array.isArray(value)) for (const v of value) respHeaders.push({ name, value: String(v) })
          else respHeaders.push({ name, value: String(value) })
        }
        done({
          ok: true,
          status: response.statusCode,
          statusText: String((response as { statusMessage?: string }).statusMessage || ''),
          headers: respHeaders,
          body: binary
            ? { size: total, truncated, binary: true }
            : { text: buf.toString('utf-8'), size: total, truncated },
          durationMs: Date.now() - started,
          url
        })
      })
    })
    request.on('error', (err) => done({ ok: false, error: String(err?.message || err), durationMs: Date.now() - started }))
    // hard timeout so a hung target never wedges the Repeater
    setTimeout(() => done({ ok: false, error: 'request timed out', durationMs: Date.now() - started }), 30000)
    try {
      if (req.body) request.write(req.body)
      request.end()
    } catch (e) {
      done({ ok: false, error: String((e as Error)?.message || e) })
    }
  })
}
