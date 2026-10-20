import { useEffect, useState } from 'react'
import L from 'leaflet'
import type { FireData } from './types'
import { fireViewport } from './mapViewport'

export default function FireLayer({ map, enabled }: { map: L.Map | null; enabled: boolean }) {
  const [data, setData] = useState<FireData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (!map || !enabled) return
    const pane = map.getPane('fires') || map.createPane('fires')
    pane.style.zIndex = '450'
    const group = L.layerGroup().addTo(map)
    let controller: AbortController | null = null
    let debounce: number | undefined
    let timeout: number | undefined
    let disposed = false

    function popup(title: string, lines: string[]) {
      const content = document.createElement('div')
      content.className = 'sample-popup'
      const heading = document.createElement('strong')
      heading.textContent = title
      content.append(heading)
      lines.forEach(line => {
        const p = document.createElement('p')
        p.textContent = line
        content.append(p)
      })
      return content
    }

    async function load() {
      if (!map || disposed) return
      const bounds = map.getBounds()
      const viewport = fireViewport({
        south: bounds.getSouth(), north: bounds.getNorth(),
        west: bounds.getWest(), east: bounds.getEast(),
      }, map.getZoom(), map.getSize())
      if (!viewport) {
        setLoading(false)
        setError('Waiting for a usable map view. Try recentering or zooming in.')
        return
      }
      const request = new AbortController()
      controller = request
      timeout = window.setTimeout(() => request.abort('timeout'), 35000)
      setLoading(true); setError(''); setData(null); group.clearLayers()
      try {
        const response = await fetch('/api/fires', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          signal: request.signal,
          body: JSON.stringify(viewport),
        })
        if (!response.ok) throw new Error(response.status === 422
          ? 'This map view could not be queried. Recenter or zoom in, then retry.'
          : response.status === 429 ? 'Too many requests. Please wait a moment and retry.'
            : 'Fire feeds are unavailable. Try again.')
        const result: FireData = await response.json()
        if (request.signal.aborted || disposed) return
        setData(result)
        result.hotspots.forEach(point => {
          const clustered = point.count > 1
          const marker = L.marker([point.latitude, point.longitude], {
            pane: 'fires', bubblingMouseEvents: false, keyboard: true,
            title: clustered ? `${point.count} satellite heat detections` : 'Satellite heat detection',
            icon: L.divIcon({
              className: `fire-marker hotspot-marker ${clustered ? 'fire-cluster' : ''}`,
              html: `<span>${clustered ? point.count.toLocaleString() : ''}</span>`,
              iconSize: clustered ? [32, 24] : [12, 12], iconAnchor: clustered ? [16, 12] : [6, 6],
            }),
          })
          const content = popup(clustered ? `${point.count.toLocaleString()} heat detections` : 'Satellite heat detection', [
            'NASA FIRMS · S-NPP VIIRS · preceding 24 hours',
            `Latest observation: ${new Date(point.time).toLocaleString()}`,
            clustered ? 'Grouped satellite observations, not a count of wildfires.'
              : `Confidence: ${point.confidence}${point.frp == null ? '' : ` · Radiative power: ${point.frp} MW`}`,
            'May include agricultural burning or other heat sources.',
          ])
          if (clustered) {
            const button = document.createElement('button')
            button.className = 'popup-link'
            button.textContent = 'Zoom to detections ↗'
            button.addEventListener('click', () => map.fitBounds(
              [[point.south, point.west], [point.north, point.east]], { padding: [70, 100], maxZoom: 17 },
            ))
            content.append(button)
          }
          marker.bindPopup(content, { autoPan: false }).addTo(group)
        })
        result.incidents.forEach(fire => {
          const marker = L.marker([fire.latitude, fire.longitude], {
            pane: 'fires', bubblingMouseEvents: false, keyboard: true,
            title: `${fire.name} · wildfire report within 24 hours`,
            icon: L.divIcon({
              className: 'fire-marker wildfire-marker', html: '<span>▲</span>',
              iconSize: [24, 24], iconAnchor: [12, 12],
            }),
          })
          const international = fire.source === 'GDACS'
          const activityDate = fire.activity_precision === 'day'
            ? `${fire.activity_at.slice(0, 10)} (UTC date; exact time not supplied)`
            : new Date(fire.activity_at).toLocaleString()
          const content = popup(fire.name, [
            international ? 'GDACS / GWIS · satellite-derived wildfire event · marked current'
              : 'NIFC · active, not fully contained · report within 24 h',
            international
              ? `${fire.hectares == null ? 'Burned area unreported' : `${fire.hectares.toLocaleString()} ha estimated burned area`} · Containment unreported`
              : `${fire.acres == null ? 'Size unreported' : `${fire.acres.toLocaleString()} acres`} · ${fire.contained == null ? 'Containment unreported' : `${fire.contained}% contained`}`,
            `Latest ${fire.activity_basis}: ${activityDate}`,
            international ? 'Estimated event center, not a fire perimeter. A daily report does not confirm flames now.'
              : 'Incident location, not a fire perimeter.',
          ])
          const link = document.createElement('a')
          link.href = fire.source_url
          link.textContent = international ? `GDACS event ${fire.id.split(':')[1]} ↗` : 'NIFC source ↗'
          link.target = '_blank'; link.rel = 'noreferrer'
          content.append(link)
          marker.bindPopup(content, { autoPan: false }).addTo(group)
        })
      } catch (err) {
        if (disposed || controller !== request) return
        if (!request.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load fires.')
        else if (request.signal.reason === 'timeout') setError('Fire feeds took too long. Try again.')
      } finally {
        if (controller === request) {
          clearTimeout(timeout)
          if (!disposed) setLoading(false)
        }
      }
    }
    function schedule() {
      controller?.abort()
      clearTimeout(timeout); clearTimeout(debounce)
      setData(null); setLoading(true); group.clearLayers()
      debounce = window.setTimeout(() => { void load() }, 350)
    }
    map.on('moveend resize', schedule)
    schedule()
    // Recheck the rolling cutoff even while upstream downloads remain cached.
    const refresh = window.setInterval(schedule, 60000)
    return () => {
      disposed = true; controller?.abort()
      clearTimeout(timeout); clearTimeout(debounce); clearInterval(refresh)
      map.off('moveend resize', schedule); group.remove()
    }
  }, [map, enabled, retry])

  if (!enabled) return null
  return <div className="fire-status" aria-live="polite">
    <div className="fire-status-title"><span>FIRE ACTIVITY · LAST 24 H</span><span>Visible map</span></div>
    {loading ? <p>Loading fire activity…</p> : error ? <p role="alert">{error} <button onClick={() => setRetry(value => value + 1)}>Retry ↻</button></p> : data && <>
      <p><i className="wildfire-key">▲</i> {data.incidents.length} wildfire events{data.unavailable.some(source => source === 'NIFC' || source === 'GDACS') ? ' · partial coverage' : ' · worldwide sources'}</p>
      <p>{data.unavailable.includes('NIFC') ? 'US: unavailable' : `US: ${data.incidents.filter(f => f.source === 'NIFC').length}`}
        {' · '}{data.unavailable.includes('GDACS') ? 'International: unavailable' : `International: ${data.incidents.filter(f => f.source === 'GDACS').length}`}</p>
      <p><i className="hotspot-key" /> {data.unavailable.includes('NASA FIRMS') ? 'NASA FIRMS unavailable' : `${data.detection_count.toLocaleString()} heat detections · 24 h`}</p>
      <div className="fire-source-links">
        <a href="https://data-nifc.opendata.arcgis.com/" target="_blank" rel="noreferrer">NIFC ↗</a>
        <a href="https://www.gdacs.org/knowledge/models_wf.aspx" target="_blank" rel="noreferrer">GDACS ↗</a>
        <a href="https://firms.modaps.eosdis.nasa.gov/active_fire/" target="_blank" rel="noreferrer">NASA FIRMS ↗</a>
        <span>Fetched {new Date(data.fetched_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    </>}
  </div>
}
