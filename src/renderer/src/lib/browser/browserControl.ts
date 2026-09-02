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

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
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
