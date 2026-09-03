import type { BrowserBounds } from './browserControl'

export function resolveOverlayRect(
  rect: BrowserBounds,
  containerW: number,
  containerH: number
): { x: number; y: number; width: number; height: number }
