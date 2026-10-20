import assert from 'node:assert/strict'
import test from 'node:test'
import { fireViewport } from '../src/mapViewport.ts'

const bounds = { south: 32, north: 42, west: -125, east: -114 }
const phone = { x: 390, y: 650 }

test('mobile views with no laid-out dimensions never generate a fire request', () => {
  assert.equal(fireViewport(bounds, 6, { x: 390, y: 0 }), null)
  assert.equal(fireViewport(bounds, 6, { x: 0, y: 650 }), null)
  assert.deepEqual(fireViewport(bounds, 6, phone), { ...bounds, zoom: 6 })
})

test('collapsed, nonfinite and fully polar bounds are rejected before fetch', () => {
  for (const change of [
    { north: bounds.south }, { east: bounds.west }, { north: NaN },
    { west: Infinity }, { south: 86, north: 89 }, { south: -89, north: -86 },
  ]) assert.equal(fireViewport({ ...bounds, ...change }, 6, phone), null)
  assert.equal(fireViewport(bounds, NaN, phone), null)
})

test('world-spanning and wrapped mobile viewports respect API bounds', () => {
  assert.deepEqual(fireViewport({ south: -90, north: 90, west: -200, east: 200 }, 2, phone),
    { south: -85, north: 85, west: -180, east: 180, zoom: 2 })
  assert.deepEqual(fireViewport({ south: -10, north: 10, west: 170, east: 190 }, 4, phone),
    { south: -10, north: 10, west: 170, east: -170, zoom: 4 })
})

test('transient pinch zoom stays inside the server zoom range', () => {
  assert.equal(fireViewport(bounds, 17.8, phone)?.zoom, 17)
  assert.equal(fireViewport(bounds, 1.2, phone)?.zoom, 2)
  assert.equal(fireViewport(bounds, 6.3, phone)?.zoom, 6)
})
