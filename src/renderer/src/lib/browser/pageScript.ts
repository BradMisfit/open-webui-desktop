/**
 * Bounded page-world inspection/action script for AI browser actions.
 *
 * Runs inside the browsed page via webview.executeJavaScript. It returns only
 * SMALL, serializable, progressive results — never the raw DOM, cookies, or
 * secrets. Password field values are never read. Element references are stable
 * within a page load (kept in window.__owuiRefs) so discover→inspect→act works.
 *
 * The AI flow is deliberately progressive: get_page / read_text / find to
 * discover, then click / type / select by ref to act.
 */
export type BrowserPageAction =
  | 'get_page'
  | 'read_text'
  | 'find'
  | 'inspect'
  | 'click'
  | 'type'
  | 'select'
  | 'scroll'

export function buildPageScript(action: string, params: Record<string, unknown>): string {
  // Serialized as JSON and embedded; the IIFE below is self-contained.
  const a = JSON.stringify(String(action))
  const p = JSON.stringify(params ?? {})
  return `(${pageRuntime.toString()})(${a}, ${p})`
}

// This function's SOURCE is stringified and injected — keep it self-contained
// (no imports, no outer refs). It always returns a bounded plain object.
function pageRuntime(action: string, params: any): any {
  const MAX_TEXT = Math.min(Number(params.maxChars) || 4000, 20000)
  const LIMIT = Math.min(Number(params.limit) || 20, 50)
  const w: any = window as any
  const reg: Record<string, Element> = (w.__owuiRefs = w.__owuiRefs || {})

  function isVisible(el: Element): boolean {
    const r = (el as HTMLElement).getBoundingClientRect()
    return r.width > 1 && r.height > 1
  }
  function truncate(s: string, n: number): string {
    s = (s || '').replace(/\s+/g, ' ').trim()
    return s.length > n ? s.slice(0, n) + '…' : s
  }
  function isSecret(el: Element): boolean {
    const t = ((el as HTMLInputElement).type || '').toLowerCase()
    const n = ((el.getAttribute('name') || '') + ' ' + (el.getAttribute('autocomplete') || '')).toLowerCase()
    return t === 'password' || /pass|otp|cvv|card|secret|token/.test(n)
  }
  function assignRef(el: Element, i: number): string {
    const ref = 'e' + i
    reg[ref] = el
    try { el.setAttribute('data-owui-ref', ref) } catch (_) { /* noop */ }
    return ref
  }
  function info(el: Element, ref: string): any {
    const secret = isSecret(el)
    const val = (el as HTMLInputElement).value
    return {
      ref,
      tag: el.tagName.toLowerCase(),
      type: (el as HTMLInputElement).type || undefined,
      role: el.getAttribute('role') || undefined,
      name:
        truncate(
          el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || '',
          80
        ) || undefined,
      text: truncate((el as HTMLElement).innerText || (secret ? '' : val || ''), 120) || undefined,
      href: (el as HTMLAnchorElement).href || undefined
    }
  }
  function resolve(): Element | null {
    if (params.ref && reg[params.ref] && (reg[params.ref] as any).isConnected) return reg[params.ref]
    if (params.selector) { try { return document.querySelector(String(params.selector)) } catch (_) { /* noop */ } }
    return null
  }

  try {
    if (action === 'get_page') {
      return { ok: true, url: location.href, title: document.title }
    }
    if (action === 'read_text') {
      const t = document.body ? (document.body as HTMLElement).innerText : ''
      return {
        ok: true, url: location.href, title: document.title,
        text: truncate(t, MAX_TEXT), truncated: (t || '').length > MAX_TEXT
      }
    }
    if (action === 'find' || action === 'inspect') {
      const sel = String(params.selector || 'a,button,input,textarea,select,[role=button],[role=link],[role=tab],[onclick],summary,[contenteditable=true]')
      let cands = Array.prototype.slice.call(document.querySelectorAll(sel)).filter(isVisible)
      const q = String(params.query || '').toLowerCase()
      if (q) {
        cands = cands.filter((el: Element) =>
          (((el as HTMLElement).innerText || '') + ' ' +
            (el.getAttribute('aria-label') || '') + ' ' +
            (isSecret(el) ? '' : (el as HTMLInputElement).value || '') + ' ' +
            (el.getAttribute('placeholder') || '')).toLowerCase().includes(q)
        )
      }
      const out = cands.slice(0, LIMIT).map((el: Element, i: number) => info(el, assignRef(el, i)))
      return { ok: true, url: location.href, title: document.title, count: out.length, total: cands.length, elements: out }
    }
    if (action === 'click') {
      const el = resolve()
      if (!el) return { ok: false, error: 'element not found (call find first)' }
      // Consequential-action gate: submit/purchase/delete/publish-style controls
      // require confirm=true (the model must ask the user first).
      const label = (
        ((el as HTMLElement).innerText || '') + ' ' +
        (el.getAttribute('aria-label') || '') + ' ' +
        (isSecret(el) ? '' : (el as HTMLInputElement).value || '') + ' ' +
        (el.getAttribute('name') || '')
      ).toLowerCase()
      const t = ((el as HTMLInputElement).type || '').toLowerCase()
      const consequential =
        t === 'submit' ||
        /submit|buy|purchase|checkout|place order|\bpay\b|delete|remove|publish|confirm|subscribe|sign ?up|create account|transfer|withdraw|deploy|merge/.test(label) ||
        (el.tagName === 'BUTTON' && !!(el as HTMLButtonElement).form && !(el as HTMLButtonElement).type)
      if (consequential && params.confirm !== true) {
        return {
          ok: false,
          confirmation_required: true,
          element: info(el, String(params.ref || assignRef(el, 0))),
          reason: 'This looks like a consequential action (submit / purchase / delete / publish). Ask the user to confirm, then retry with confirm=true.'
        }
      }
      ;(el as HTMLElement).scrollIntoView({ block: 'center' })
      ;(el as HTMLElement).click()
      return { ok: true, clicked: true, url: location.href }
    }
    if (action === 'type') {
      const el = resolve() as HTMLInputElement | null
      if (!el) return { ok: false, error: 'element not found (call find first)' }
      ;(el as HTMLElement).focus()
      if ('value' in el) {
        el.value = String(params.text ?? '')
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      } else {
        ;(el as HTMLElement).textContent = String(params.text ?? '')
      }
      return { ok: true, typed: true, chars: String(params.text ?? '').length }
    }
    if (action === 'select') {
      const el = resolve() as HTMLSelectElement | null
      if (!el) return { ok: false, error: 'element not found (call find first)' }
      el.value = String(params.value ?? '')
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, selected: el.value }
    }
    if (action === 'scroll') {
      const amt = Math.min(Number(params.amount) || 600, 5000)
      const el = params.ref ? resolve() : null
      if (el) (el as HTMLElement).scrollIntoView({ block: 'center' })
      else window.scrollBy(0, (String(params.direction) === 'up' ? -1 : 1) * amt)
      return { ok: true, scrollY: Math.round(window.scrollY), scrollHeight: document.body ? document.body.scrollHeight : 0 }
    }
    return { ok: false, error: 'unknown DOM action: ' + action }
  } catch (e: any) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
