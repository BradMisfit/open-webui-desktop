<script lang="ts">
  /**
   * Browser Workspace overlay (Desktop shell side).
   *
   * Renders one real <webview> per browser tab, positioned absolutely over the
   * right-panel rectangle the Open WebUI guest reports. These are top-level
   * WebContents (not iframes) so sites that block framing still load. The guest
   * page never nests here; it only draws chrome + reports geometry.
   *
   * Security: browser <webview>s use a dedicated partition, NO preload (page
   * content cannot reach any shell/Electron API), default sandbox + no node
   * integration, and links/popups stay inside this surface (handled in main).
   * Only bounded state (url/title/favicon/nav/loading) is pushed to the guest.
   */
  import {
    browserTabs,
    registerWebview,
    unregisterWebview,
    pushBrowserState,
    recordConsole,
    recordFailure,
    BROWSER_PARTITION,
    type BrowserTab,
    type BrowserTabState
  } from '../../browser/browserControl'

  const favicons = new Map<string, string | null>()

  function styleFor(tab: BrowserTab): string {
    if (!tab.rect || !tab.visible) return 'display:none;'
    const { x, y, width, height } = tab.rect
    return `position:absolute; left:${x}px; top:${y}px; width:${width}px; height:${height}px; display:flex; pointer-events:auto; background:#fff;`
  }

  function emit(el: any, tabId: string, loading?: boolean, error?: string | null): void {
    if (!el) return
    let url = ''
    let title = ''
    let canGoBack = false
    let canGoForward = false
    try { url = el.getURL?.() ?? '' } catch { /* still booting */ }
    try { title = el.getTitle?.() ?? '' } catch { /* still booting */ }
    try { canGoBack = !!el.canGoBack?.() } catch { /* still booting */ }
    try { canGoForward = !!el.canGoForward?.() } catch { /* still booting */ }
    const state: BrowserTabState = {
      tabId,
      url: url === 'about:blank' ? '' : url,
      title,
      favicon: favicons.get(tabId) ?? null,
      canGoBack,
      canGoForward,
      loading: !!loading,
      error: error ?? null
    }
    pushBrowserState(state)
  }

  // Svelte action: wire a <webview> element's lifecycle + nav events once mounted.
  function wireWebview(el: any, tabId: string) {
    registerWebview(tabId, el)
    const onStart = (): void => emit(el, tabId, true)
    const onStop = (): void => emit(el, tabId, false)
    const onNav = (): void => emit(el, tabId, false)
    const onTitle = (): void => emit(el, tabId, false)
    const onFavicon = (e: any): void => {
      favicons.set(tabId, Array.isArray(e?.favicons) && e.favicons.length ? e.favicons[0] : null)
      emit(el, tabId, false)
    }
    const onFail = (e: any): void => {
      // Record all main + sub-resource failures for AI "network failures", but
      // only surface a main-frame failure as page-level error state.
      if (e?.errorCode !== -3) {
        recordFailure(tabId, e?.validatedURL || '', e?.errorDescription || 'load failed')
      }
      if (e?.errorCode === -3 || e?.isMainFrame === false) return
      emit(el, tabId, false, e?.errorDescription || 'Failed to load page')
    }
    const onConsole = (e: any): void => {
      // level: 0 verbose, 1 info, 2 warning, 3 error — keep warnings + errors.
      if ((e?.level ?? 0) >= 2) recordConsole(tabId, e?.level >= 3 ? 'error' : 'warning', e?.message || '')
    }
    // Correlate this browser tab to its WebContents so the Security Workspace
    // capture engine (main process) can attribute traffic to the tab.
    let mappedWcId = -1
    const mapTab = (): void => {
      try {
        const wcId = el.getWebContentsId?.()
        if (typeof wcId === 'number' && wcId !== mappedWcId) {
          mappedWcId = wcId
          ;(window as any).electronAPI?.securityMapTab?.(tabId, wcId)
        }
      } catch {
        /* not attached yet */
      }
    }
    const onReady = (): void => {
      mapTab()
      emit(el, tabId, false)
    }
    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('did-navigate', onNav)
    el.addEventListener('did-navigate-in-page', onNav)
    el.addEventListener('page-title-updated', onTitle)
    el.addEventListener('page-favicon-updated', onFavicon)
    el.addEventListener('did-fail-load', onFail)
    el.addEventListener('console-message', onConsole)
    el.addEventListener('dom-ready', onReady)
    return {
      destroy(): void {
        el.removeEventListener('did-start-loading', onStart)
        el.removeEventListener('did-stop-loading', onStop)
        el.removeEventListener('did-navigate', onNav)
        el.removeEventListener('did-navigate-in-page', onNav)
        el.removeEventListener('page-title-updated', onTitle)
        el.removeEventListener('page-favicon-updated', onFavicon)
        el.removeEventListener('did-fail-load', onFail)
        el.removeEventListener('console-message', onConsole)
        el.removeEventListener('dom-ready', onReady)
        try {
          if (mappedWcId >= 0) (window as any).electronAPI?.securityUnmapTab?.(mappedWcId)
        } catch {
          /* noop */
        }
        unregisterWebview(tabId)
        favicons.delete(tabId)
      }
    }
  }
</script>

<!-- Overlay layer: transparent to pointer events except where a browser webview
     sits, so the OWUI guest keeps receiving clicks everywhere else. -->
<div class="pointer-events-none absolute inset-0 z-30">
  {#each $browserTabs as tab (tab.tabId)}
    <webview
      src={tab.initialUrl}
      partition={BROWSER_PARTITION}
      allowpopups
      class="border-none"
      style={styleFor(tab)}
      use:wireWebview={tab.tabId}
    ></webview>
  {/each}
</div>
