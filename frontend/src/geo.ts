import type { Bounds } from './types.ts'

export function normalizeLongitude(longitude: number) {
  return ((longitude + 180) % 360 + 360) % 360 - 180
}

export function boundsAround(latitude: number, longitude: number, size: number): Bounds {
  const halfLat = size / (2 * 111.32)
  const lat = Math.max(-85 + halfLat, Math.min(85 - halfLat, latitude))
  const halfLon = size / (2 * 111.32 * Math.cos(lat * Math.PI / 180))
  const lon = Math.max(-180 + halfLon, Math.min(180 - halfLon, normalizeLongitude(longitude)))
  return { south: lat - halfLat, north: lat + halfLat, west: lon - halfLon, east: lon + halfLon }
}

export function sizeOf(b: Bounds) {
  return {
    height: (b.north - b.south) * 111.32,
    width: (b.east - b.west) * 111.32 * Math.cos((b.north + b.south) * Math.PI / 360),
  }
}

export function validBounds(b: Bounds) {
  const { width, height } = sizeOf(b)
  return Object.values(b).every(Number.isFinite) && b.south >= -85 && b.north <= 85 &&
    b.west >= -180 && b.east <= 180 && Math.min(width, height) >= 0.5 && Math.max(width, height) <= 250
}

export const airBands = [
  { name: 'Good', short: 'Good', color: '#536a48', fill: '#bfd2ad', max: 9, range: '0–9.0' },
  { name: 'Moderate', short: 'Moderate', color: '#87703b', fill: '#eedca2', max: 35.4, range: '9.1–35.4' },
  { name: 'Unhealthy for sensitive groups', short: 'Sensitive', color: '#9a633c', fill: '#e9bf9c', max: 55.4, range: '35.5–55.4' },
  { name: 'Unhealthy', short: 'Unhealthy', color: '#a05e59', fill: '#dfa9a2', max: 125.4, range: '55.5–125.4' },
  { name: 'Very unhealthy', short: 'Very unhealthy', color: '#805d88', fill: '#cbb6d5', max: 225.4, range: '125.5–225.4' },
  { name: 'Hazardous', short: 'Hazardous', color: '#7c4657', fill: '#c39ba9', max: Infinity, range: '225.5+' },
]
const unavailableBand = { name: 'Unavailable', short: 'Unavailable', color: '#747970', fill: '#e1e1d8', max: 0, range: 'No reading' }

export function aqiCategory(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return unavailableBand
  return airBands[value <= 50 ? 0 : value <= 100 ? 1 : value <= 150 ? 2 : value <= 200 ? 3 : value <= 300 ? 4 : 5]
}

// EPA 2024 concentration breakpoints, truncated to 0.1 µg/m³.
// Coloring current readings with these bands does not calculate a daily AQI.
export function pm25Category(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return unavailableBand
  const concentration = Math.floor((value + 1e-9) * 10) / 10
  return airBands.find(band => concentration <= band.max)!
}

export function equivalent(pm25: number, hours: number, multiplier = 1) {
  return pm25 * hours * multiplier / 528
}

// Match backend.air.sample_points: equal-area rows on a sphere, numbered
// northwest to southeast. Coordinates use the same precision as the API query.
export function sampleGrid(b: Bounds) {
  const low = Math.sin(b.south * Math.PI / 180)
  const high = Math.sin(b.north * Math.PI / 180)
  const latAt = (fraction: number) => Math.asin(low + (high - low) * fraction) * 180 / Math.PI
  const points = [2, 1, 0].flatMap((row, index) => [0, 1, 2].map(col => ({
    id: index * 3 + col + 1,
    latitude: Number(latAt((row + 0.5) / 3).toFixed(5)),
    longitude: Number((b.west + (b.east - b.west) * (col + 0.5) / 3).toFixed(5)),
  })))
  return {
    points,
    latitudes: [latAt(1 / 3), latAt(2 / 3)],
    longitudes: [b.west + (b.east - b.west) / 3, b.west + (b.east - b.west) * 2 / 3],
  }
}
