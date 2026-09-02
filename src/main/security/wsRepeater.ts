/**
 * WebSocket repeater (Security Workspace, main process). Opens a controlled
 * WebSocket to a captured endpoint, sends one message, and collects the replies
 * for a bounded window — so a captured client frame can be manually resent and
 * its effect observed. Scope-gated: refuses any target not in the authorized
 * scope. Bounded: capped wait, frame count, and frame size.
 */
import { isInScope } from './scope'

const MAX_WAIT_MS = 8000
const MAX_FRAMES = 100
const MAX_FRAME_BYTES = 64 * 1024

export interface WsSendRequest {
  url?: string
  message?: string
  waitMs?: number
}
export interface WsSendResult {
  ok: boolean
  error?: string
  outOfScope?: boolean
  frames?: Array<{ direction: 'sent' | 'received'; text: string; size: number; truncated: boolean }>
  closed?: { code?: number; reason?: string }
}

export async function sendWsMessage(req: WsSendRequest): Promise<WsSendResult> {
  const url = String(req.url || '').trim()
  if (!/^wss?:\/\//i.test(url)) return { ok: false, error: 'only ws(s):// URLs can be sent' }
  // scope is declared for hosts; a ws(s) URL maps to the same host authorization
  const httpish = url.replace(/^ws/i, 'http')
  if (!isInScope(httpish)) {
    return { ok: false, outOfScope: true, error: 'target is not in the authorized scope; add it in the Scope tab first' }
  }
  if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'function') {
    return { ok: false, error: 'WebSocket client is unavailable in this runtime' }
  }
  const waitMs = Math.min(Math.max(Number(req.waitMs) || 4000, 500), MAX_WAIT_MS)
  const message = String(req.message ?? '')
  const frames: WsSendResult['frames'] = []

  return await new Promise<WsSendResult>((resolve) => {
    let settled = false
    let ws: WebSocket
    const finish = (extra: Partial<WsSendResult>): void => {
      if (settled) return
      settled = true
      try { ws?.close() } catch { /* noop */ }
      resolve({ ok: true, frames, ...extra })
    }
    try {
      ws = new WebSocket(url)
    } catch (e) {
      resolve({ ok: false, error: String((e as Error)?.message || e) })
      return
    }
    const timer = setTimeout(() => finish({}), waitMs)
    ws.onopen = () => {
      try {
        ws.send(message)
        frames.push({ direction: 'sent', text: message.slice(0, MAX_FRAME_BYTES), size: message.length, truncated: message.length > MAX_FRAME_BYTES })
      } catch (e) {
        clearTimeout(timer)
        finish({ error: String((e as Error)?.message || e) })
      }
    }
    ws.onmessage = (ev: MessageEvent) => {
      if (frames!.length >= MAX_FRAMES) return
      const text = typeof ev.data === 'string' ? ev.data : '[binary frame]'
      frames!.push({ direction: 'received', text: text.slice(0, MAX_FRAME_BYTES), size: text.length, truncated: text.length > MAX_FRAME_BYTES })
      if (frames!.length >= MAX_FRAMES) { clearTimeout(timer); finish({}) }
    }
    ws.onerror = () => {
      clearTimeout(timer)
      if (!frames!.length) finish({ error: 'WebSocket error (handshake refused or connection failed)' })
      else finish({})
    }
    ws.onclose = (ev: CloseEvent) => {
      clearTimeout(timer)
      finish({ closed: { code: ev.code, reason: ev.reason } })
    }
  })
}
