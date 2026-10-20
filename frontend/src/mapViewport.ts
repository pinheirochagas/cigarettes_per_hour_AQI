import type { Bounds } from './types'
import { normalizeLongitude } from './geo.ts'

// Leaflet can briefly report zero-sized bounds while a mobile tab is hidden
// or its viewport is being resized. Those are not valid API queries.
export function fireViewport(bounds: Bounds, zoom: number, size: { x: number; y: number }) {
  if (![...Object.values(bounds), zoom, size.x, size.y].every(Number.isFinite)
    || size.x <= 0 || size.y <= 0 || bounds.east <= bounds.west) return null
  const south = Math.max(-85, Math.min(85, bounds.south))
  const north = Math.max(-85, Math.min(85, bounds.north))
  const world = bounds.east - bounds.west >= 360
  const west = world ? -180 : normalizeLongitude(bounds.west)
  const east = world ? 180 : normalizeLongitude(bounds.east)
  if (south >= north || west === east) return null
  return { south, north, west, east, zoom: Math.max(2, Math.min(17, Math.round(zoom))) }
}
