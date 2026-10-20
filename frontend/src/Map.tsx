import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import type { AirData, Bounds, DataSource, Selection, StationData } from './types'
import { airBands, aqiCategory, pm25Category, sampleGrid } from './geo'
import FireLayer from './FireLayer'
import mapboxLogo from './assets/mapbox-logo.svg'

interface Props {
  mobileView: 'map' | 'results';
  selection: Selection | null; data: AirData | null; drawing: boolean;
  source: DataSource; stationData: StationData | null; loading: boolean;
  stationId: string;
  onStation: (id: string) => void;
  onPoint: (lat: number, lon: number) => void; onBox: (bounds: Bounds) => void;
  onDrawStart: () => void; onCancel: () => void;
}

export default function MapView(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layers = useRef<L.LayerGroup | null>(null)
  const stationMarkers = useRef(new Map<string, L.Marker>())
  const current = useRef(props)
  current.current = props
  const [firstCorner, setFirstCorner] = useState(false)
  const [tileError, setTileError] = useState(false)
  const [configError, setConfigError] = useState('')
  const [showCells, setShowCells] = useState(false)
  const [zoom, setZoom] = useState(3)
  const [showFires, setShowFires] = useState(false)
  const [mapInstance, setMapInstance] = useState<L.Map | null>(null)
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  const visible = !mobile || props.mobileView === 'map'

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const update = () => setMobile(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const m = L.map(host.current!, { zoomControl: false, minZoom: 2, maxZoom: 17, worldCopyJump: true }).setView([27, -26], 3)
    map.current = m
    setMapInstance(m)
    m.on('zoomend', () => setZoom(m.getZoom()))
    const controller = new AbortController()
    async function loadMapbox() {
      try {
        const response = await fetch('/api/map-config', { signal: controller.signal })
        if (!response.ok) throw new Error('Mapbox is not configured. Please check the public token.')
        const config = await response.json()
        if (!config.mapbox_token?.startsWith('pk.')) throw new Error('A public Mapbox token is required.')
        if (controller.signal.aborted) return
        const token = encodeURIComponent(config.mapbox_token)
        L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/512/{z}/{x}/{y}@2x?access_token=${token}`, {
          tileSize: 512, zoomOffset: -1, maxZoom: 22,
          attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> ' +
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
            '<a href="https://apps.mapbox.com/feedback/">Improve this map</a>',
        }).on('tileerror', () => { if (!controller.signal.aborted) setTileError(true) })
          .on('tileload', () => { if (!controller.signal.aborted) setTileError(false) }).addTo(m)
      } catch (err) {
        if (!controller.signal.aborted) setConfigError(err instanceof Error ? err.message : 'Could not load Mapbox.')
      }
    }
    void loadMapbox()
    L.control.zoom({ position: 'topleft' }).addTo(m)
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(m)
    layers.current = L.layerGroup().addTo(m)
    let corner: L.LatLng | null = null
    let preview: L.Rectangle | null = null
    function clearDraft() {
      corner = null
      if (preview) { preview.remove(); preview = null }
      setFirstCorner(false)
    }
    m.on('click', (event: L.LeafletMouseEvent) => {
      const p = event.latlng.wrap()
      if (current.current.drawing) {
        if (!corner) {
          corner = p; setFirstCorner(true)
          preview = L.rectangle(L.latLngBounds(p, p), { color: '#4e6050', weight: 1, dashArray: '5 5', fillOpacity: 0.06 }).addTo(m)
        } else {
          const b = L.latLngBounds(corner, p)
          clearDraft()
          current.current.onBox({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() })
        }
      } else {
        clearDraft()
        current.current.onPoint(p.lat, p.lng)
      }
    })
    m.on('mousemove', (event: L.LeafletMouseEvent) => {
      if (corner && preview) preview.setBounds(L.latLngBounds(corner, event.latlng.wrap()))
    })
    function cancelDraft() { clearDraft() }
    host.current!.addEventListener('cancel-draw', cancelDraft)
    const node = host.current!
    let resizeFrame = 0
    const resize = () => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        if (node.clientWidth > 0 && node.clientHeight > 0) m.invalidateSize({ animate: false, debounceMoveend: true })
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(node)
    window.visualViewport?.addEventListener('resize', resize)
    window.addEventListener('pageshow', resize)
    return () => {
      controller.abort(); observer.disconnect(); cancelAnimationFrame(resizeFrame)
      window.visualViewport?.removeEventListener('resize', resize)
      window.removeEventListener('pageshow', resize)
      node.removeEventListener('cancel-draw', cancelDraft); m.remove(); map.current = null
    }
  }, [])

  useEffect(() => {
    if (!props.drawing) host.current?.dispatchEvent(new Event('cancel-draw'))
    map.current?.doubleClickZoom[props.drawing ? 'disable' : 'enable']()
  }, [props.drawing])

  useEffect(() => {
    if (!visible || !mapInstance) return
    // Visibility changes do not trigger ResizeObserver. Wait for the mobile
    // panel's layout, then refresh Leaflet's cached dimensions before fitting.
    const frame = requestAnimationFrame(() => {
      const container = mapInstance.getContainer()
      if (container.clientWidth <= 0 || container.clientHeight <= 0) return
      mapInstance.invalidateSize({ animate: false, debounceMoveend: true })
      if (props.selection) {
        const b = props.selection.bounds
        mapInstance.fitBounds([[b.south, b.west], [b.north, b.east]], {
          paddingTopLeft: [40, 70], paddingBottomRight: [40, 125], maxZoom: 12, animate: false,
        })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [props.selection, visible, mapInstance])

  useEffect(() => {
    const group = layers.current
    if (!group) return
    group.clearLayers()
    stationMarkers.current.clear()
    if (!props.selection) return
    const b = props.selection.bounds
    const grid = sampleGrid(b)
    const color = props.data ? aqiCategory(props.data.aqi).color : '#616b5c'
    L.rectangle([[b.south, b.west], [b.north, b.east]], {
      color, weight: 1.5, fillColor: color, fillOpacity: 0.055, interactive: false,
    }).addTo(group)
    if (props.source !== 'model') {
      const community = props.source === 'purpleair'
      const network = community ? 'PurpleAir' : 'AirNow'
      props.stationData?.stations.forEach(station => {
        const label = station.pm25 === null ? '—' : station.pm25.toFixed(1)
        const band = pm25Category(station.pm25)
        const marker = L.marker([station.latitude, station.longitude], {
          icon: L.divIcon({
            className: `station-marker ${community ? 'community-marker' : ''} ${station.pm25 === null ? 'station-missing' : ''}`,
            html: `<span class="station-dot" style="--sensor-fill:${band.fill};--sensor-color:${band.color}"></span><span class="sample-value">${label}</span>`,
            iconSize: community ? [16, 16] : [52, 35], iconAnchor: community ? [8, 8] : [26, 6], popupAnchor: [0, -7],
          }),
          title: `${station.name}: ${label} µg/m³ PM₂.₅${community ? ' ALT' : ''} · ${band.name} color band · ${network}`,
          keyboard: true, bubblingMouseEvents: false, riseOnHover: true,
        })
        const content = document.createElement('div')
        content.className = 'sample-popup'
        const title = document.createElement('strong')
        title.textContent = `${station.name} · ${label} µg/m³ PM₂.₅${community ? ' ALT' : ''}`
        const agency = document.createElement('p')
        agency.textContent = community ? 'PurpleAir · outdoor community sensor' : `AirNow · ${station.agency}`
        const time = document.createElement('p')
        time.textContent = community
          ? (station.time ? `Last report: ${new Date(station.time).toLocaleString()} (your local time)` : station.unavailable_reason || 'No recent usable report.')
          : station.time && station.time_end
          ? `Hourly measurement: ${new Date(station.time).toLocaleString()} – ${new Date(station.time_end).toLocaleTimeString()} (your local time)`
          : 'No usable PM₂.₅ reading in the last three completed hours.'
        const coords = document.createElement('p')
        coords.textContent = `${community ? 'Sensor' : 'Station'} ${station.id} · ${station.latitude.toFixed(5)}, ${station.longitude.toFixed(5)}`
        const note = document.createElement('p')
        note.textContent = community
          ? `${station.confidence == null ? '' : `Channel confidence: ${station.confidence}%. `}PM₂.₅ ALT concentration; not an AQI value.`
          : 'Preliminary hourly observation from AirNow.'
        const category = document.createElement('p')
        category.textContent = `Color band: ${band.name} · based on this concentration, not daily AQI.`
        content.append(title, agency, time, coords, category, note)
        marker.bindPopup(content).on('click', () => current.current.onStation(station.id)).addTo(group)
        stationMarkers.current.set(station.id, marker)
      })
      return
    }
    // The grid makes the sampling scheme explicit: one point per equal-area cell.
    grid.latitudes.forEach(lat => L.polyline([[lat, b.west], [lat, b.east]], {
      color, weight: 1, opacity: 0.45, dashArray: '3 5', interactive: false,
    }).addTo(group))
    grid.longitudes.forEach(lon => L.polyline([[b.south, lon], [b.north, lon]], {
      color, weight: 1, opacity: 0.45, dashArray: '3 5', interactive: false,
    }).addTo(group))

    if (showCells && props.data) {
      const cells = new Map<string, { lat: number; lon: number; ids: number[] }>()
      props.data.samples.forEach((sample, index) => {
        if (sample.grid_latitude === null || sample.grid_longitude === null) return
        const key = `${sample.grid_latitude},${sample.grid_longitude}`
        const cell = cells.get(key) ?? { lat: sample.grid_latitude, lon: sample.grid_longitude, ids: [] }
        cell.ids.push(index + 1); cells.set(key, cell)
        L.polyline([[sample.latitude, sample.longitude], [cell.lat, cell.lon]], {
          color: '#8a7966', weight: 1, dashArray: '2 4', opacity: 0.65, interactive: false,
        }).addTo(group)
      })
      cells.forEach(cell => {
        const marker = L.marker([cell.lat, cell.lon], {
          icon: L.divIcon({
            className: 'model-cell-marker',
            html: '<span aria-hidden="true"></span>', iconSize: [12, 12], iconAnchor: [6, 6],
          }),
          title: `Model grid location for points ${cell.ids.join(', ')}`,
          keyboard: true, bubblingMouseEvents: false,
        })
        const text = document.createElement('div')
        text.className = 'sample-popup'
        const title = document.createElement('strong'); title.textContent = 'Returned model grid location'
        const detail = document.createElement('p'); detail.textContent = `Used by points ${cell.ids.join(', ')}`
        const coords = document.createElement('p'); coords.textContent = `${cell.lat.toFixed(5)}, ${cell.lon.toFixed(5)}`
        text.append(title, detail, coords)
        marker.bindPopup(text).addTo(group)
      })
    }
    grid.points.forEach((point, index) => {
      // Once loaded, use exactly the coordinates returned by our API.
      const sample = props.data?.samples[index]
      const latitude = sample?.latitude ?? point.latitude
      const longitude = sample?.longitude ?? point.longitude
      const value = sample?.pm25
      const valueLabel = value == null ? '—' : value.toFixed(1)
      const band = pm25Category(value ?? null)
      const marker = L.marker([latitude, longitude], {
        icon: L.divIcon({
          className: `sample-marker ${sample && value === null ? 'sample-missing' : ''}`,
          html: `<span class="sample-number" style="--sample-color:${band.color};--sample-fill:${band.fill}">${point.id}</span><span class="sample-value">${valueLabel}</span>`,
          iconSize: [52, 43], iconAnchor: [26, 12], popupAnchor: [0, -13],
        }),
        title: `Point ${point.id}: ${sample ? value == null ? 'no data' : `${valueLabel} µg/m³ PM2.5` : 'waiting for data'}`,
        keyboard: true, bubblingMouseEvents: false, riseOnHover: true,
      })
      const content = document.createElement('div')
      content.className = 'sample-popup'
      const title = document.createElement('strong')
      title.textContent = `Point ${point.id} · ${sample ? value == null ? 'No data' : `${valueLabel} µg/m³ PM₂.₅` : 'Awaiting data'}`
      const coords = document.createElement('p')
      coords.textContent = `Query: ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
      const source = document.createElement('p')
      source.textContent = sample && sample.grid_latitude !== null && sample.grid_longitude !== null
        ? `Model grid: ${sample.grid_latitude.toFixed(5)}, ${sample.grid_longitude.toFixed(5)}`
        : 'Center of one cell in the 3 × 3 sampling grid.'
      const note = document.createElement('p'); note.textContent = 'Modeled concentration; not a monitoring station.'
      content.append(title, coords, source, note)
      marker.bindPopup(content).addTo(group)
    })
  }, [props.selection, props.data, props.source, props.stationData, showCells])

  useEffect(() => {
    stationMarkers.current.forEach((marker, id) => {
      marker.getElement()?.classList.toggle('station-selected', id === props.stationId)
      marker.setZIndexOffset(id === props.stationId ? 500 : 0)
    })
  }, [props.stationId, props.stationData, props.source, showCells])

  function recenter() {
    const b = props.selection?.bounds
    if (b) map.current?.fitBounds([[b.south, b.west], [b.north, b.east]], { paddingTopLeft: [65, 70], paddingBottomRight: [65, 125] })
    else map.current?.setView([27, -26], 3)
  }

  const network = props.source === 'purpleair' ? 'PurpleAir' : 'AirNow'
  return <section className={`map-panel ${props.drawing ? 'drawing' : ''} ${props.source === 'purpleair' && zoom < 13 ? 'sensor-overview' : ''}`} aria-label="Air quality map">
    <div ref={host} className="map-canvas" aria-label="Click the map to select an area. You can also use the place search." />
    <div className="map-tools">
      <button onClick={() => setShowFires(value => !value)} className={showFires ? 'active' : ''} aria-pressed={showFires} title="Show U.S. and international wildfire events and global satellite heat detections">Fires</button>
      {props.selection && props.source === 'model' && <button onClick={() => setShowCells(v => !v)} className={showCells ? 'active' : ''} aria-pressed={showCells} title="Show the model grid coordinates returned by the air-quality provider">Model cells</button>}
      <button onClick={props.drawing ? props.onCancel : props.onDrawStart} className={props.drawing ? 'active' : ''} aria-pressed={props.drawing}>
        <span aria-hidden="true">⌑</span> {props.drawing ? 'Cancel drawing' : 'Draw an area'}
      </button>
      <button onClick={recenter} aria-label="Recenter map" title="Recenter map">⌖</button>
    </div>
    <FireLayer map={mapInstance} enabled={showFires && visible} />
    {(tileError || configError) && <p className="tile-error" role="status">{configError || 'Mapbox tiles are unavailable. Check the token’s URL permissions or try reloading.'}</p>}
    <a className="mapbox-logo" href="https://www.mapbox.com/about/maps/" aria-label="Mapbox" target="_blank" rel="noreferrer"><img src={mapboxLogo} alt="Mapbox" /></a>
    <div className="map-caption" aria-live="polite">
      <span className="caption-index">{props.drawing ? '↳' : props.source !== 'model' ? '●' : props.selection ? '01—09' : '↳'}</span>
      <div>{props.drawing ? (firstCorner ? 'Choose the opposite corner to finish.' : 'Click two corners to select an area.')
        : props.selection ? props.source !== 'model' ? <>
          <span>{props.loading ? `Loading ${network}…` : props.stationData ? `${props.stationData.station_count} ${network} sites · ${props.stationData.reporting_count} usable readings` : network}</span>
          <span className="map-caption-detail">{props.source === 'purpleair' ? 'Outdoor sensor locations · zoom in for values · click to use a reading' : 'Actual station locations · values in µg/m³ · click to use a reading'}</span>
          <span className="map-caption-detail">{props.source === 'purpleair' ? 'PM₂.₅ ALT in µg/m³ · reports within one hour · hollow: no usable reading' : 'AirNow monitoring network · hourly measurements'}</span>
        </> : <>
          <span>Modeled estimates · not monitoring stations</span>
          <span className="map-caption-detail">3 × 3 equal-area grid · one query at each cell center</span>
          <span className="map-caption-detail">Numbers: point IDs · values: PM₂.₅ in µg/m³ · click a point for details</span>
          {showCells && <span className="map-caption-detail"><i className="model-cell-key" /> Returned model grid locations · dashed lines link queries</span>}
        </> : 'Click the map to select a location'}
        {props.selection && <div className="air-legend" aria-label="PM2.5 concentration color bands">
          <span className="legend-heading">PM₂.₅ color bands · µg/m³</span>
          <div className="air-legend-bands">{airBands.map(band => <span key={band.name} className="air-legend-band" title={`${band.name}: ${band.range} µg/m³`}>
            <i style={{ background: band.fill, borderColor: band.color }} /><span>{band.range}</span>
          </span>)}</div>
        </div>}
      </div>
    </div>
  </section>
}
