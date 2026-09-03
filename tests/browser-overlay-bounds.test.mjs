/**
 * Coordinate/bounds regression test for the Browser Workspace overlay.
 *
 * Reproduces the acceptance bug (0.0.22-bradmisfit.2): the browser surface landed
 * several hundred px too far right with a black left margin and right clipping,
 * because the guest's raw px were placed directly while the guest webview was
 * scaled (Electron per-origin zoom / Windows display scaling). The fix relays a
 * fraction of the guest viewport and multiplies by the live container size.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveOverlayRect } from '../src/renderer/src/lib/browser/overlayBounds.mjs'

test('identity: guest viewport == container ⇒ px unchanged', () => {
  const r = resolveOverlayRect(
    { x: 600, y: 60, width: 400, height: 700, viewportWidth: 1000, viewportHeight: 800 },
    1000,
    800
  )
  assert.deepEqual(r, { x: 600, y: 60, width: 400, height: 700 })
})

test('THE BUG: guest scaled (viewport 1000) but on-screen container 800 ⇒ surface follows the chrome', () => {
  // The chrome (rendered inside the zoomed guest) sits at 600*0.8 = 480px on
  // screen. The OLD code placed the webview at raw x=600 → 120px too far right,
  // dark container bg on the left, right clipped. The fix must yield x=480.
  const r = resolveOverlayRect(
    { x: 600, y: 100, width: 400, height: 600, viewportWidth: 1000, viewportHeight: 1000 },
    800,
    800
  )
  assert.equal(r.x, 480, 'x tracks the zoomed chrome position, not the raw guest px')
  assert.equal(r.width, 320, 'width scales down so the right edge is not clipped')
  assert.equal(r.x + r.width, 800, 'surface reaches exactly the container right edge')
  assert.equal(r.y, 80)
  assert.equal(r.height, 480)
})

test('guest zoomed IN (viewport smaller than container) scales up correctly', () => {
  const r = resolveOverlayRect(
    { x: 300, y: 0, width: 200, height: 500, viewportWidth: 500, viewportHeight: 500 },
    1000,
    1000
  )
  assert.equal(r.x, 600)
  assert.equal(r.width, 400)
})

test('older guest without viewport dims ⇒ raw px (previous behaviour), still clamped', () => {
  const r = resolveOverlayRect({ x: 600, y: 60, width: 400, height: 700 }, 1000, 800)
  assert.equal(r.x, 600)
  assert.equal(r.width, 400)
})

test('clamps into the container so the surface cannot cover unrelated OWUI UI', () => {
  // A rect that would overflow the right/bottom edges is trimmed to fit.
  const r = resolveOverlayRect(
    { x: 900, y: 700, width: 400, height: 400, viewportWidth: 1000, viewportHeight: 800 },
    1000,
    800
  )
  assert.equal(r.x, 900)
  assert.equal(r.width, 100, 'width trimmed to the container right edge')
  assert.equal(r.x + r.width, 1000)
  assert.equal(r.y + r.height, 800, 'height trimmed to the container bottom edge')
})

test('zero container (not measured yet) ⇒ no NaN, falls back to raw px', () => {
  const r = resolveOverlayRect(
    { x: 10, y: 20, width: 30, height: 40, viewportWidth: 1000, viewportHeight: 800 },
    0,
    0
  )
  assert.deepEqual(r, { x: 10, y: 20, width: 30, height: 40 })
})
