/**
 * Pure geometry for positioning a Browser Workspace <webview> over the OWUI
 * guest's reported placeholder rectangle. Shared by BrowserOverlay (app) and the
 * bounds regression test.
 *
 * The guest reports its placeholder rect AND its own viewport size. Dividing by
 * the viewport gives a fraction that is invariant to the guest webview's zoom
 * factor, Windows display scaling, and DPR; multiplying by the live overlay
 * container size (== the guest webview's on-screen area) yields the exact CSS
 * pixels. Result is clamped into the container so the surface can never spill
 * over unrelated Open WebUI UI. When viewport dims are absent (older guest), the
 * raw px are used unchanged (previous behaviour).
 *
 * @param {{x:number,y:number,width:number,height:number,viewportWidth?:number,viewportHeight?:number}} rect
 * @param {number} containerW
 * @param {number} containerH
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function resolveOverlayRect(rect, containerW, containerH) {
  let x = rect.x
  let y = rect.y
  let width = rect.width
  let height = rect.height

  if (rect.viewportWidth && rect.viewportHeight && containerW && containerH) {
    x = (rect.x / rect.viewportWidth) * containerW
    y = (rect.y / rect.viewportHeight) * containerH
    width = (rect.width / rect.viewportWidth) * containerW
    height = (rect.height / rect.viewportHeight) * containerH
  }

  if (containerW && containerH) {
    x = Math.max(0, Math.min(x, containerW))
    y = Math.max(0, Math.min(y, containerH))
    width = Math.max(0, Math.min(width, containerW - x))
    height = Math.max(0, Math.min(height, containerH - y))
  }

  return { x, y, width, height }
}
