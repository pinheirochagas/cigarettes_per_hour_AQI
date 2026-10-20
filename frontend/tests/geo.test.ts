import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boundsAround, sizeOf, validBounds, equivalent, aqiCategory, normalizeLongitude, sampleGrid, pm25Category, airBands } from '../src/geo.ts'

test('boxes have the requested ground dimensions across latitudes', () => {
  for (const lat of [-75, -20, 0, 37.77, 75]) {
    for (const size of [10, 25, 50, 100]) {
      const box = boundsAround(lat, 40, size)
      assert.ok(validBounds(box))
      const dimensions = sizeOf(box)
      assert.ok(Math.abs(dimensions.width - size) < 0.001)
      assert.ok(Math.abs(dimensions.height - size) < 0.001)
    }
  }
})

test('polar and date-line boxes stay inside supported coordinates', () => {
  for (const lat of [-85, 85]) for (const lon of [-180, 180, 540]) {
    assert.ok(validBounds(boundsAround(lat, lon, 100)))
  }
  assert.equal(normalizeLongitude(540), -180)
  assert.equal(normalizeLongitude(-190), 170)
})

test('invalid geometry does not become a shareable selection', () => {
  assert.equal(validBounds({south: 0, north: 0, east: 1, west: 0}), false)
  assert.equal(validBounds({south: 0, north: 60, east: 1, west: 0}), false)
  assert.equal(validBounds({south: 0, north: 1, east: -179, west: 179}), false)
  assert.equal(validBounds({south: NaN, north: 1, east: 1, west: 0}), false)
})

test('comparison preserves the reference and illustrative multipliers', () => {
  assert.equal(equivalent(22, 24), 1)
  assert.equal(equivalent(22, 24, 8), 8)
  assert.equal(equivalent(0, 24), 0)
})

test('AQI categories include exact boundaries and absent values', () => {
  assert.equal(aqiCategory(null).name, 'Unavailable')
  assert.equal(aqiCategory(50).name, 'Good')
  assert.equal(aqiCategory(51).name, 'Moderate')
  assert.equal(aqiCategory(100).name, 'Moderate')
  assert.equal(aqiCategory(150).name, 'Unhealthy for sensitive groups')
  assert.equal(aqiCategory(200).name, 'Unhealthy')
  assert.equal(aqiCategory(300).name, 'Very unhealthy')
  assert.equal(aqiCategory(501).name, 'Hazardous')
})

test('pastel marker colors use current EPA concentration bands at every breakpoint', () => {
  for (const [value, expected] of [
    [0, 0], [9, 0], [9.099, 0], [9.1, 1], [35.4, 1], [35.499, 1], [35.5, 2],
    [55.4, 2], [55.5, 3], [125.4, 3], [125.5, 4], [225.4, 4], [225.5, 5], [999, 5],
  ]) assert.equal(pm25Category(value), airBands[expected])
})

test('missing and invalid concentrations never receive a good-air color', () => {
  for (const value of [null, NaN, Infinity, -1]) {
    assert.equal(pm25Category(value).name, 'Unavailable')
    assert.equal(aqiCategory(value).name, 'Unavailable')
  }
})

test('visible sampling grid has one numbered query per equal-area cell', () => {
  for (const latitude of [-75, 0, 37.77, 75]) {
    const b = boundsAround(latitude, -122.42, 25)
    const grid = sampleGrid(b)
    assert.deepEqual(grid.points.map(p => p.id), [1, 2, 3, 4, 5, 6, 7, 8, 9])
    const rows = [b.north, ...grid.latitudes.toReversed(), b.south]
    const cols = [b.west, ...grid.longitudes, b.east]
    grid.points.forEach((p, i) => {
      const row = Math.floor(i / 3), col = i % 3
      assert.ok(p.latitude < rows[row] && p.latitude > rows[row + 1])
      assert.ok(p.longitude > cols[col] && p.longitude < cols[col + 1])
      assert.ok(Math.abs(p.longitude - (cols[col] + cols[col + 1]) / 2) < 0.000006)
      assert.ok(Math.abs(Math.sin(p.latitude * Math.PI / 180) -
        (Math.sin(rows[row] * Math.PI / 180) + Math.sin(rows[row + 1] * Math.PI / 180)) / 2) < 1e-7)
    })
  }
})
