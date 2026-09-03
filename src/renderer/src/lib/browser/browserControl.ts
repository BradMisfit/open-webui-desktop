/**
 * Browser Workspace control (Desktop shell side).
 *
 * The Open WebUI web app runs as a <webview> guest and cannot nest another
 * webview, so the visible browser surface is a SEPARATE <webview> that the shell
 * owns and positions over the right-panel region the guest reports. This module
 * is the shell-side registry/controller: it holds the desired geometry/visibility
 * per browser tab (rendered reactively by BrowserOverlay), keeps imperative refs
 * to the live <webview> elements for navigation, and relays bounded state
 * (url/title/favicon/nav/loading) back to the guest.
 *
 * Trust boundary: only the guest→shell allowlist in Content.svelte reaches
 * handleBrowserRequest(). The browser <webview> content itself has NO preload and
 * cannot reach any shell/Electron API. No page content or cookies cross back to
 * the guest — only the small state object below.
 */
import { writable, get } from 'svelte/store'
import { buildPageScript } from './pageScript'

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
  // Guest viewport size at measurement time. When present, BrowserOverlay treats
  // x/y/width/height as fractions of this and multiplies by the live overlay
  // container size — zoom/DPR/origin-invariant. Absent (older guest) ⇒ raw px.
  viewportWidth?: number
  viewportHeight?: number
}

export interface BrowserTab {
  tabId: string
  initialUrl: string
  rect: BrowserBounds | null
  visible: boolean
}

export interface BrowserTabState {
  tabId: string
  url: string
  title: string
  favicon: string | null
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  error?: string | null
}

// Shared session for all browser tabs (like a normal browser: one cookie jar,
// kept entirely inside the trusted shell — never exposed to the model/guest).
export const BROWSER_PARTITION = 'persist:browser-workspace'

export const browserTabs = writable<BrowserTab[]>([])

// Imperative refs to the live <webview> elements, registered by BrowserOverlay.
const elements = new Map<string, any>()

// Shell → guest push (set by Content.svelte to target the active OWUI guest).
let pusher: ((payload: { type: string; data: unknown }) => void) | null = null
export function setBrowserStatePusher(fn: (payload: { type: string; data: unknown }) => void): void {
  pusher = fn
}
export function pushBrowserState(state: BrowserTabState): void {
  pusher?.({ type: 'browser:state', data: state })
}
export function pushOpenTab(url: string): void {
  // Ask the guest to create a new workspace browser tab (e.g. target=_blank).
  pusher?.({ type: 'browser:open-tab', data: { url } })
}

export function registerWebview(tabId: string, el: any): void {
  elements.set(tabId, el)
}
export function unregisterWebview(tabId: string): void {
  elements.delete(tabId)
  logBuffers.delete(tabId)
}

/** Resolve a browser tab to its live WebContents id (for CDP/DevTools in main). */
export function webContentsIdForTab(tabId: string): number {
  const el = elements.get(tabId)
  try {
    return el?.getWebContentsId?.() ?? -1
  } catch {
    return -1
  }
}

// ── Bounded diagnostics buffers (populated by BrowserOverlay) ──────────────
interface LogBuffers {
  console: Array<{ level: string; message: string }>
  failures: Array<{ url: string; error: string }>
}
const logBuffers = new Map<string, LogBuffers>()
const RING = 40
function buf(tabId: string): LogBuffers {
  let b = logBuffers.get(tabId)
  if (!b) {
    b = { console: [], failures: [] }
    logBuffers.set(tabId, b)
  }
  return b
}
export function recordConsole(tabId: string, level: string, message: string): void {
  const b = buf(tabId)
  b.console.push({ level, message: String(message || '').slice(0, 500) })
  if (b.console.length > RING) b.console.shift()
}
export function recordFailure(tabId: string, url: string, error: string): void {
  const b = buf(tabId)
  b.failures.push({ url: String(url || '').slice(0, 300), error: String(error || '').slice(0, 200) })
  if (b.failures.length > RING) b.failures.shift()
}

// ── AI action engine ───────────────────────────────────────────────────────
// Executes one bounded action on the visible browser tab and returns a small
// serializable observation. No cookies/secrets ever leave the page (see
// pageScript.ts password guard); screenshots are downscaled.
const DOM_ACTIONS = new Set(['get_page', 'read_text', 'find', 'inspect', 'click', 'type', 'select', 'scroll'])

function waitForLoad(el: any, ms = 8000): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      try { el.removeEventListener('did-stop-loading', finish) } catch (_) { /* noop */ }
      resolve()
    }
    try { el.addEventListener('did-stop-loading', finish) } catch (_) { /* noop */ }
    setTimeout(finish, ms)
  })
}

export async function executeBrowserAction(
  tabId: string,
  action: string,
  params: Record<string, unknown>
): Promise<any> {
  const el = elements.get(tabId)
  if (!el) return { ok: false, error: 'no visible browser tab for this session' }

  try {
    if (action === 'navigate' || action === 'open') {
      const url = sanitizeUrl(String((params as any)?.url ?? ''))
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http(s) URLs can be opened' }
      el.loadURL(url)
      await waitForLoad(el)
      let cur = url
      let title = ''
      try { cur = el.getURL() } catch (_) { /* noop */ }
      try { title = el.getTitle() } catch (_) { /* noop */ }
      return { ok: true, url: cur, title }
    }
    if (action === 'back') { try { if (el.canGoBack()) el.goBack() } catch (_) { /* noop */ } await waitForLoad(el, 4000); return { ok: true, url: safeUrl(el) } }
    if (action === 'forward') { try { if (el.canGoForward()) el.goForward() } catch (_) { /* noop */ } await waitForLoad(el, 4000); return { ok: true, url: safeUrl(el) } }
    if (action === 'reload') { try { el.reload() } catch (_) { /* noop */ } await waitForLoad(el, 6000); return { ok: true, url: safeUrl(el) } }
    if (action === 'stop') { try { el.stop() } catch (_) { /* noop */ } return { ok: true } }

    if (action === 'screenshot') {
      const img = await el.capturePage()
      const resized = img.resize({ width: 1000 })
      const dataUrl = resized.toDataURL ? resized.toDataURL() : `data:image/png;base64,${resized.toPNG().toString('base64')}`
      return { ok: true, url: safeUrl(el), image: dataUrl }
    }
    if (action === 'console_errors') {
      return { ok: true, entries: buf(tabId).console.slice(-20) }
    }
    if (action === 'network_failures') {
      return { ok: true, entries: buf(tabId).failures.slice(-20) }
    }
    if (DOM_ACTIONS.has(action)) {
      const result = await el.executeJavaScript(buildPageScript(action, params), true)
      return result
    }
    return { ok: false, error: 'unknown browser action: ' + action }
  } catch (e: any) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

function safeUrl(el: any): string {
  try {
    const u = el.getURL()
    return u === 'about:blank' ? '' : u
  } catch (_) {
    return ''
  }
}

function sanitizeUrl(raw: string): string {
  const v = (raw || '').trim()
  if (!v) return 'about:blank'
  // Only http(s)/about are allowed to load in the visible surface. file:// and
  // custom/dangerous protocols are refused here (defence-in-depth; main also
  // blocks them at the network layer).
  if (/^https?:\/\//i.test(v) || v === 'about:blank') return v
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return 'about:blank'
  return `https://${v}`
}

function updateTab(tabId: string, patch: Partial<BrowserTab>): void {
  browserTabs.update((list) => list.map((t) => (t.tabId === tabId ? { ...t, ...patch } : t)))
}

export function handleBrowserRequest(
  type: string,
  data: any
): { ok: boolean; error?: string } {
  const tabId = String(data?.tabId ?? '')
  if (!tabId) return { ok: false, error: 'missing-tabId' }
  const el = elements.get(tabId)
  switch (type) {
    case 'browser:open': {
      const exists = get(browserTabs).some((t) => t.tabId === tabId)
      if (!exists) {
        browserTabs.update((list) => [
          ...list,
          { tabId, initialUrl: sanitizeUrl(data?.url ?? ''), rect: null, visible: true }
        ])
      }
      return { ok: true }
    }
    case 'browser:navigate': {
      const url = sanitizeUrl(data?.url ?? '')
      try {
        el?.loadURL?.(url)
      } catch {
        /* element may still be booting; ignore */
      }
      return { ok: true }
    }
    case 'browser:back':
      try { if (el?.canGoBack?.()) el.goBack() } catch { /* noop */ }
      return { ok: true }
    case 'browser:forward':
      try { if (el?.canGoForward?.()) el.goForward() } catch { /* noop */ }
      return { ok: true }
    case 'browser:reload':
      try { el?.reload?.() } catch { /* noop */ }
      return { ok: true }
    case 'browser:stop':
      try { el?.stop?.() } catch { /* noop */ }
      return { ok: true }
    case 'browser:setBounds':
      updateTab(tabId, {
        rect: data?.rect ?? null,
        visible: !!data?.visible
      })
      return { ok: true }
    case 'browser:close':
      elements.delete(tabId)
      browserTabs.update((list) => list.filter((t) => t.tabId !== tabId))
      return { ok: true }
    default:
      return { ok: false, error: 'unknown-browser-request' }
  }
}
