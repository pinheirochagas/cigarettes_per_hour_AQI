import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import MapView from './Map'
import Chart from './Chart'
import { aqiCategory, boundsAround, equivalent, normalizeLongitude, pm25Category, sizeOf, validBounds } from './geo'
import type { AirData, Bounds, DataSource, Place, Selection, StationData } from './types'

const Formula = lazy(() => import('./Formula'))

const activities = [
  { name: 'At rest', multiplier: 1, rate: '7.5' },
  { name: 'Walking', multiplier: 3, rate: '22.5' },
  { name: 'Running / cycling', multiplier: 8, rate: '60' },
]

function ConcentrationBand({ value }: { value: number | null }) {
  const band = pm25Category(value)
  return <div className="concentration-band" style={{ background: band.fill, color: band.color }}
    title={`${band.name}: ${band.range}${value === null ? '' : ' µg/m³'}. Current concentration band, not a daily AQI.`}>
    <span>PM₂.₅ · {value === null ? 'No recent reading' : band.name}</span>
    <span>current</span>
  </div>
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  if (!response.ok) {
    let message = 'Unable to load data. Please try again.'
    try { const body = await response.json(); if (typeof body.detail === 'string') message = body.detail } catch { /* readable fallback */ }
    throw new Error(message)
  }
  return response.json()
}

function initialSelection(): Selection | null {
  const p = new URLSearchParams(window.location.search)
  const values = ['south', 'west', 'north', 'east'].map(k => p.get(k))
  if (values.some(v => !v)) return null
  const [south, west, north, east] = values.map(Number)
  const bounds = { south, west, north, east }
  if (!validBounds(bounds)) return null
  return { latitude: (south + north) / 2, longitude: (west + east) / 2, name: p.get('place')?.slice(0, 100) || 'Shared area', region: '', bounds, custom: true }
}

function number(value: number) {
  if (value > 0 && value < 0.001) return '<0.001'
  return value.toFixed(value < 0.1 ? 3 : 2)
}

export default function App() {
  const [selection, setSelection] = useState<Selection | null>(initialSelection)
  const [data, setData] = useState<AirData | null>(null)
  const [source, setSource] = useState<DataSource>(() => {
    const value = new URLSearchParams(window.location.search).get('source')
    return value === 'model' || value === 'stations' ? value : 'purpleair'
  })
  const [stationData, setStationData] = useState<StationData | null>(null)
  const [stationId, setStationId] = useState('')
  const [size, setSize] = useState(25)
  const [hours, setHours] = useState(1)
  const [activity, setActivity] = useState(0)
  const [query, setQuery] = useState('')
  const [places, setPlaces] = useState<Place[]>([])
  const [searched, setSearched] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [loading, setLoading] = useState(false)
  const [locating, setLocating] = useState(false)
  const [error, setError] = useState('')
  const [drawing, setDrawing] = useState(false)
  const [retry, setRetry] = useState(0)
  const [shareLabel, setShareLabel] = useState('Copy link ↗')
  const [methodOpen, setMethodOpen] = useState(false)
  const [mobileView, setMobileView] = useState<'map' | 'results'>('results')
  const modal = useRef<HTMLDialogElement>(null)
  const searchAbort = useRef<AbortController | null>(null)
  const actionVersion = useRef(0)

  useEffect(() => {
    if (!selection) return
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort('timeout'), 35000)
    setData(null); setStationData(null); setStationId(''); setLoading(true); setError('')
    const params = new URLSearchParams({ place: selection.name, source })
    Object.entries(selection.bounds).forEach(([k, v]) => params.set(k, v.toFixed(5)))
    window.history.replaceState(null, '', `?${params}`)
    request<AirData | StationData>(source === 'purpleair' ? '/api/purpleair' : source === 'stations' ? '/api/stations' : '/api/air-quality', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selection.bounds), signal: controller.signal,
    }).then(result => {
      if (controller.signal.aborted) return
      if ('stations' in result) setStationData(result)
      else setData(result)
    })
      .catch(err => {
        if (!controller.signal.aborted) setError(err.message || 'Could not load air quality.')
        else if (controller.signal.reason === 'timeout') setError('The request took too long. Please try again.')
      }).finally(() => { clearTimeout(timeout); if (!controller.signal.aborted || controller.signal.reason === 'timeout') setLoading(false) })
    return () => { clearTimeout(timeout); controller.abort() }
  }, [selection, source, retry])

  useEffect(() => {
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') { setDrawing(false); setPlaces([]); setSearched(false) } }
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('keydown', escape); searchAbort.current?.abort() }
  }, [])

  useEffect(() => {
    if (methodOpen) modal.current?.showModal()
    else modal.current?.close()
  }, [methodOpen])

  function selectPoint(latitude: number, longitude: number, name = 'Selected area', region = '') {
    actionVersion.current++
    setLocating(false)
    if (Math.abs(latitude) > 85) { setError('Choose a place between 85° south and 85° north.'); return }
    const bounds = boundsAround(latitude, longitude, size)
    setSelection({ latitude: (bounds.south + bounds.north) / 2, longitude: (bounds.west + bounds.east) / 2, name, region, bounds })
    setPlaces([]); setSearched(false); setDrawing(false); setError('')
    searchAbort.current?.abort(); setSearching(false)
  }

  function selectBox(bounds: Bounds) {
    if (!validBounds(bounds)) {
      setDrawing(false)
      setError('Choose a box between 0.5 and 250 km on each side, without crossing the date line.')
      return
    }
    actionVersion.current++
    setLocating(false); setPlaces([]); setSearched(false)
    searchAbort.current?.abort(); setSearching(false)
    setSelection({ latitude: (bounds.south + bounds.north) / 2, longitude: (bounds.west + bounds.east) / 2, name: 'Drawn area', region: '', bounds, custom: true })
    setDrawing(false); setMobileView('results')
  }

  async function search(event: FormEvent) {
    event.preventDefault()
    if (query.trim().length < 2) return
    searchAbort.current?.abort()
    const controller = new AbortController()
    searchAbort.current = controller
    setSearching(true); setSearchError(''); setSearched(false); setPlaces([])
    try {
      const result = await request<{ results: Place[] }>(`/api/search?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal })
      if (!controller.signal.aborted) { setPlaces(result.results); setSearched(true) }
    } catch (err) {
      if (!controller.signal.aborted) setSearchError(err instanceof Error ? err.message : 'Place search failed.')
    } finally { if (!controller.signal.aborted) setSearching(false) }
  }

  function locate() {
    if (!navigator.geolocation) { setError('Location is unavailable in this browser. Search for a place or click the map.'); return }
    const version = ++actionVersion.current
    setLocating(true); setError('')
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => { if (version === actionVersion.current) selectPoint(coords.latitude, coords.longitude, 'Your location') },
      err => {
        if (version !== actionVersion.current) return
        setLocating(false)
        setError(err.code === 1 ? 'Location permission was declined. Search for a place or click the map.' : 'Could not find your location. Search for a place or click the map.')
      }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 },
    )
  }

  function resize(next: number) {
    actionVersion.current++; setLocating(false)
    setSize(next)
    if (selection) setSelection({ ...selection, bounds: boundsAround(selection.latitude, selection.longitude, next), custom: false })
  }

  async function share() {
    try { await navigator.clipboard.writeText(window.location.href); setShareLabel('Link copied ✓') }
    catch { setShareLabel('Copy the address bar URL') }
    window.setTimeout(() => setShareLabel('Copy link ↗'), 2500)
  }

  const stationMode = source !== 'model'
  const communityMode = source === 'purpleair'
  const network = communityMode ? 'PurpleAir' : 'AirNow'
  const siteNoun = communityMode ? 'sensors' : 'stations'
  const selectedStation = stationData?.stations.find(station => station.id === stationId)
  const concentration = stationMode ? (selectedStation ? selectedStation.pm25 : stationData?.pm25) : data?.pm25
  const category = stationMode ? pm25Category(concentration ?? null) : aqiCategory(data?.aqi ?? null)
  const comparison = concentration == null ? null : equivalent(concentration, hours, activities[activity].multiplier)
  const timeLabel = (time: string) => new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
  function changeSource(next: DataSource) {
    if (next === source) return
    setData(null); setStationData(null); setStationId(''); setSource(next); setError('')
  }
  const dimensions = selection ? sizeOf(selection.bounds) : null
  const coords = selection ? `${Math.abs(selection.latitude).toFixed(3)}° ${selection.latitude >= 0 ? 'N' : 'S'} / ${Math.abs(normalizeLongitude(selection.longitude)).toFixed(3)}° ${selection.longitude >= 0 ? 'E' : 'W'}` : ''

  return <div className={`app mobile-${mobileView}`} style={{ '--accent': concentration != null ? category.color : '#596c4e' } as CSSProperties}>
    <header className="masthead">
      <a href="/" className="wordmark" aria-label="Smoking Trails home">Smoking Trails</a>
      <nav className="header-links" aria-label="About">
        <button className="method-button" onClick={() => setMethodOpen(true)}>Method</button>
        <a href="https://pedrolab.org" target="_blank" rel="noreferrer">pedrolab.org ↗</a>
      </nav>
    </header>
    <nav className="mobile-tabs" aria-label="View">
      <button aria-pressed={mobileView === 'results'} onClick={() => setMobileView('results')}>Location & exposure</button>
      <button aria-pressed={mobileView === 'map'} onClick={() => setMobileView('map')}>Map</button>
    </nav>
    <main>
      <MapView selection={selection} data={data} drawing={drawing} onPoint={selectPoint} onBox={selectBox}
        mobileView={mobileView}
        source={source} stationData={stationData} stationId={stationId} loading={loading} onStation={setStationId}
        onDrawStart={() => { actionVersion.current++; setLocating(false); setDrawing(true); setError('') }} onCancel={() => setDrawing(false)} />
      <aside className="sidebar" aria-label="Location and exposure">
        <div className="intro">
          <h1>How many cigarettes am I passively smoking in nature?</h1>
        </div>
        <section className="location-controls" aria-label="Choose a location">
          <div className="source-options" role="group" aria-label="Air quality data source">
            <button aria-pressed={communityMode} onClick={() => changeSource('purpleair')}>PurpleAir</button>
            <button aria-pressed={source === 'stations'} onClick={() => changeSource('stations')}>AirNow</button>
            <button aria-pressed={source === 'model'} onClick={() => changeSource('model')}>Modeled air</button>
          </div>
          <form className="search" onSubmit={search}>
            <span className="search-symbol" aria-hidden="true">⌕</span>
            <input aria-label="Search a city or postal code" placeholder="Search a city or postal code" value={query} minLength={2} maxLength={120}
              onChange={e => { setQuery(e.target.value); setSearched(false); setPlaces([]); setSearchError(''); searchAbort.current?.abort(); setSearching(false) }} />
            <button type="submit" aria-label="Search" disabled={searching || query.trim().length < 2}>{searching ? '…' : '→'}</button>
          </form>
          {(places.length > 0 || searched || searchError) && <div className="search-results" aria-live="polite">
            {places.map(place => <button key={place.id} onClick={() => selectPoint(place.latitude, place.longitude, place.name, place.region)}>
              <strong>{place.name}</strong><span>{place.region}</span><span className="result-arrow">↗</span>
            </button>)}
            {searched && places.length === 0 && <p>No places found. Try a nearby city or click the map.</p>}
            {searchError && <p role="alert">{searchError}</p>}
          </div>}
          <div className="location-actions">
            <button onClick={locate} disabled={locating}><span aria-hidden="true">⌖</span> {locating ? 'Locating…' : 'Situate me'}</button>
            <button className="choose-map" onClick={() => setMobileView('map')}>Choose on map ↙</button>
          </div>
          <div className="area-controls">
            <label htmlFor="area-size">Selected area</label>
            <select id="area-size" value={selection?.custom ? 'custom' : size} onChange={e => resize(Number(e.target.value))}>
              {selection?.custom && <option value="custom">{dimensions?.width.toFixed(0)} × {dimensions?.height.toFixed(0)} km</option>}
              {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n} × {n} km</option>)}
            </select>
          </div>
        </section>
        {error && <div className="error" role="alert"><p>{error}</p>{selection && <button onClick={() => setRetry(v => v + 1)}>Try again ↻</button>}</div>}
        <section className={`reading ${loading ? 'is-loading' : ''}`} aria-label="Air quality reading" aria-busy={loading}>
          <div className="place-heading"><h2>{selection?.name || 'Air quality'}</h2>{selection && <button className="text-button share" onClick={share}>{shareLabel}</button>}</div>
          {coords && <p className="coordinates" title={selection?.region}>{coords}</p>}
          {loading ? <div className="reading-pending" role="status"><span className="loading-line" />Loading air quality…</div>
            : stationMode ? <>
              <div className="air-metrics">
                <div><div className="metric-label">PM₂.₅{communityMode ? ' ALT' : ''} <span>µg/m³</span></div><strong>{concentration == null ? '—' : concentration.toFixed(1)}</strong></div>
                <div><div className="metric-label">{network.toUpperCase()} <span>usable / sites</span></div><strong className="site-count">{stationData ? `${stationData.reporting_count} / ${stationData.station_count}` : '—'}</strong></div>
              </div>
              <ConcentrationBand value={concentration ?? null} />
              {stationData && stationData.station_count > 0 && <select className="station-select" aria-label="Monitor used for cigarette equivalent" value={stationId} onChange={event => setStationId(event.target.value)}>
                <option value="">Mean of {stationData.reporting_count} reporting {siteNoun}</option>
                {stationData.stations.map(station => <option key={station.id} value={station.id}>{station.name}{station.pm25 === null ? ' · no recent reading' : ''}</option>)}
              </select>}
              {stationData && stationData.reporting_count === 0 && <p className="small-note">
                {stationData.station_count === 0 ? `No ${network} ${communityMode ? 'recent outdoor sensors' : 'PM₂.₅ sites'} in this box.` : 'No usable recent PM₂.₅ readings in this box.'} Enlarge the area or select another source.
              </p>}
              {selectedStation && <p className="station-agency" title={selectedStation.agency}>{selectedStation.agency}</p>}
              {!communityMode && stationData && stationData.hours_available < stationData.lookback_hours && <p className="small-note">Some hourly files are unavailable; coverage is incomplete.</p>}
            </> : data ? <>
              <div className="air-metrics">
                <div><div className="metric-label">PM₂.₅ <span>µg/m³</span></div><strong>{data.pm25.toFixed(1)}</strong></div>
                <div><div className="metric-label">US AQI <span>PM₂.₅</span></div><strong>{data.aqi === null ? '—' : Math.round(data.aqi)}</strong><span className="category"><i />{category.name}</span></div>
              </div>
              <ConcentrationBand value={data.pm25} />
              <div className="reading-meta"><span>{data.sample_count}/9 query points</span><span>{data.pm25_min.toFixed(1)}–{data.pm25_max.toFixed(1)} µg/m³</span></div>
              {data.partial && <p className="small-note">Partial data: mean of available samples.</p>}
            </> : <div className="air-metrics empty-reading">
              <div><div className="metric-label">PM₂.₅ <span>µg/m³</span></div><strong>—</strong></div>
              <div><div className="metric-label">US AQI <span>PM₂.₅</span></div><strong>—</strong></div>
            </div>}
          <p className="model-note">{communityMode ? 'Community sensors · outdoors only · PM₂.₅ ALT' : stationMode ? 'AirNow monitoring network · hourly measurements' : 'CAMS model · ~45 km resolution · not monitoring stations'}</p>
        </section>
        <section className="exposure" aria-label="Exposure comparison">
          <div className="section-label"><label htmlFor="hours">TIME OUTDOORS</label><span className="hours-value">{hours} {hours === 1 ? 'hour' : 'hours'}</span></div>
          <input id="hours" type="range" min="0.5" max="24" step="0.5" value={hours} onChange={e => setHours(Number(e.target.value))} aria-valuetext={`${hours} hours`} />
          <div className="range-labels"><span>30 min</span><span>12 h</span><span>24 h</span></div>
          <div className="activity-buttons" role="group" aria-label="Breathing scenario">
            {activities.map((a, i) => <button key={a.name} aria-pressed={activity === i} onClick={() => setActivity(i)}>{a.name}</button>)}
          </div>
          <div className="equivalent-result">
            <div className="section-label"><span>{activity === 0 ? 'ROUGH CIGARETTE EQUIVALENT' : 'BREATHING-ADJUSTED SCENARIO'}</span><span>≈</span></div>
            <div className="equivalent-number" aria-live="polite">{comparison === null ? '—' : number(comparison)}<span>{comparison === 1 ? 'cigarette' : 'cigarettes'}</span></div>
            <div className="cigarette-track" aria-hidden="true"><div className="cigarette-filter" /><div className="cigarette-paper"><div style={{ width: `${Math.min(100, (comparison ?? 0) * 100)}%` }} /></div><span className="cigarette-ash" /></div>
            <p className="equivalent-caption">{comparison === null ? '— per hour' : `${number(comparison / hours)} per hour · at this concentration`}</p>
            {activity !== 0 && <p className="scenario-note">{activities[activity].multiplier}× breathing assumption · {activities[activity].rate} L/min · illustrative only</p>}
          </div>
          <p className="comparison-note">Rough comparison, not an individual health-risk estimate.</p>
        </section>
        {stationMode ? <div className="station-context">
          <p>{communityMode ? 'Latest sensor reports within one hour. Sensor mean ≠ area average. Click a sensor to use its reading.' : 'Latest reading per station in the last three completed hours. Station mean ≠ area average. Hollow markers: no usable recent reading.'}</p>
        </div> : data ? <Chart data={data} /> : <div className="forecast-placeholder" />}
        <footer className="panel-footer">
          {stationMode ? <>
            <div><a href={communityMode ? 'https://www2.purpleair.com/' : 'https://docs.airnowapi.org/docs/HourlyDataFactSheet.pdf'} target="_blank" rel="noreferrer">{communityMode ? 'PurpleAir · community sensor data ↗' : 'AirNow · preliminary observations ↗'}</a></div>
            {(selectedStation?.time || (!selectedStation && stationData?.time_start)) && <div><span>
              {communityMode ? 'Reported: ' : 'Observed: '}{timeLabel((selectedStation?.time || stationData!.time_start)!)}
              {(!communityMode || !selectedStation) && (selectedStation?.time_end || stationData?.time_end) && <> – {new Date((selectedStation?.time_end || stationData!.time_end)!).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</>}
            </span></div>}
          </> : <div><span><a href="https://open-meteo.com/en/docs/air-quality-api" target="_blank" rel="noreferrer">Open-Meteo</a> / <a href="https://atmosphere.copernicus.eu/" target="_blank" rel="noreferrer">CAMS</a></span>
            {data && <span>Model: {new Date(data.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}</span>}
          </div>}
        </footer>
      </aside>
    </main>
    <dialog ref={modal} className="method-dialog" onCancel={() => setMethodOpen(false)} onClick={e => { if (e.target === modal.current) setMethodOpen(false) }}>
      <div className="dialog-inner">
        <div className="eyebrow"><span>SMOKING TRAILS</span><button aria-label="Close methodology" onClick={() => setMethodOpen(false)}>Close ×</button></div>
        <h2>Method</h2>
        <h3>Air quality, in brief</h3>
        <p>Air quality describes how polluted the air is. This app focuses on <a href="https://www.epa.gov/pm-pollution/particulate-matter-pm-basics" target="_blank" rel="noreferrer">PM₂.₅</a>: fine particles and droplets about 2.5 micrometers across or smaller. Other pollutants, such as ozone, also affect air quality.</p>
        <p><strong>µg/m³ means micrograms per cubic meter of air.</strong> It measures particle mass in a volume of air; a microgram is one-millionth of a gram. Higher concentrations mean more particles by mass.</p>
        <p>Monitors sample the air. PurpleAir sensors use scattered light to estimate particle concentrations; monitoring stations use dedicated measurement instruments. The modeled-air option estimates concentrations with an atmospheric model.</p>
        <p><strong>AQI is different:</strong> the <a href="https://www.airnow.gov/aqi/aqi-basics/using-air-quality-index/" target="_blank" rel="noreferrer">Air Quality Index</a> converts concentrations into a unitless scale with health categories and specific averaging periods. A reading of 10 µg/m³ is not an AQI of 10. Our cigarette comparison uses PM₂.₅ concentration, not AQI.</p>
        <h3>Why the three sources can disagree</h3>
        <p>They describe the same pollutant, but sample different places and times using different methods. Selecting the same box does not make their readings directly equivalent.</p>
        <table className="method-comparison">
          <caption>What each source contributes in this app</caption>
          <thead><tr><th scope="col">Source</th><th scope="col">Reading and coverage</th></tr></thead>
          <tbody>
            <tr><th scope="row">PurpleAir</th><td>Local outdoor optical sensors; latest PM₂.₅ ALT reports received within one hour. That is a freshness limit, not a one-hour average.</td></tr>
            <tr><th scope="row">AirNow</th><td>Monitoring-station measurements; each site’s latest one-hour average from the last three completed hours. Stations may report different hours, and their locations differ from PurpleAir’s.</td></tr>
            <tr><th scope="row">Modeled air</th><td>A regional atmospheric estimate from CAMS, at about 45 km resolution. Our nine queries sample that model; they are not nine local monitors and cannot resolve every street or smoke plume.</td></tr>
          </tbody>
        </table>
        <p><strong>Instruments and corrections matter.</strong> Optical estimates depend on particle properties and humidity. We use PurpleAir’s ALT field without an additional EPA correction. These are different from the corrected sensor readings and NowCast AQI on <a href="https://document.airnow.gov/airnow-fire-and-smoke-map-questions-and-answers.pdf" target="_blank" rel="noreferrer">AirNow’s Fire and Smoke Map</a>.</p>
        <p><strong>The box averages different locations.</strong> Sensor and station means give each usable site equal weight, so a dense neighborhood can dominate the sensor mean. Modeled air averages nine evenly distributed query points, often sharing model cells. Nearby pollution sources, changing winds, reporting delays, and model uncertainty can all contribute to a discrepancy; no source will always read higher or lower.</p>
        <p><strong>When comparing:</strong> check PM₂.₅ in µg/m³, the timestamps, and whether you selected one site or the network mean. The current PM₂.₅ color band can differ from the modeled AQI category, which uses a preceding 24-hour average. Keep time outdoors and activity fixed: doubling PM₂.₅ doubles the cigarette comparison. We do not blend the three sources or adjust them to agree.</p>
        <h3>Cigarette equivalence</h3>
        <p><a href="https://berkeleyearth.org/air-pollution-and-cigarette-equivalence/" target="_blank" rel="noreferrer">Berkeley Earth’s approximation</a> compares 24 hours at 22 µg/m³ of PM₂.₅ with roughly one cigarette, using population-level health effects. Here, we scale that analogy by time. It is not a measurement of cigarette smoke, a safe-exposure threshold, or a prediction of your personal risk.</p>
        {methodOpen && <Suspense fallback={<div className="formula">Loading equation…</div>}><Formula /></Suspense>}
        <h3>PurpleAir community sensors</h3>
        <p><a href="https://api.purpleair.com/#api-sensors-get-sensors-data" target="_blank" rel="noreferrer">PurpleAir</a> supplies public outdoor sensor locations and their latest reported PM₂.₅ ALT concentrations. ALT estimates particle mass from particle counts; the provider averages sensor channels while excluding downgraded channels. This is a community sensor estimate, not a regulatory reference measurement. We label the concentration in µg/m³, not AQI; the values can differ from PurpleAir’s map when a different averaging period, correction, or AQI layer is selected there.</p>
        <p>Only reports received within the last hour contribute to the calculation. Indoor and private sensors are excluded. Missing, invalid, and stale readings are never replaced with zero. The popup shows the last report time and the provider’s channel confidence when available; that score is not a probability that the concentration is accurate. Sensor coordinates are those registered with PurpleAir.</p>
        <p>The default is the unweighted mean of usable sensors inside the box. It is not an area average, and dense groups of sensors carry more weight. Click a sensor or choose it from the menu to use its reading alone. Requests for the same box are cached for ten minutes to limit API usage, with freshness rechecked on each request. PurpleAir, AirNow, and model values remain separate.</p>
        <h3>Map colors</h3>
        <p>Marker colors follow the six <a href="https://www.epa.gov/system/files/documents/2024-02/pm-naaqs-air-quality-index-fact-sheet.pdf" target="_blank" rel="noreferrer">U.S. EPA PM₂.₅ concentration bands updated in 2024</a>, using a pastel palette. We apply the breakpoints to the displayed concentration after truncating to one decimal place. These current-reading color bands are not an official daily AQI or NowCast. PurpleAir’s own map may use a different correction or averaging period.</p>
        <h3>Fires</h3>
        <p>The optional Fires layer follows the visible map, independently of your air-quality box. Triangles show U.S. wildfire incidents marked active by <a href="https://data-nifc.opendata.arcgis.com/datasets/nifc::current-wildland-fire-incident-locations" target="_blank" rel="noreferrer">NIFC</a> with a discovery or incident report within the past 24 hours. We use the report’s period end when supplied, otherwise its report date; database edit times never qualify an old incident. Prescribed, controlled, extinguished, and fully contained records are excluded. This conservative filter can omit ongoing fires whose reports are delayed. Popups show the qualifying report time, size, and containment. A report does not confirm that flames are present at this moment, and an incident location is not a perimeter.</p>
        <p>Outside the U.S., triangles show <a href="https://www.gdacs.org/knowledge/models_wf.aspx" target="_blank" rel="noreferrer">GDACS / Copernicus GWIS</a> wildfire events derived from satellite observations. We include events marked current whose activity end date falls within the preceding 24 hours, never using a database edit to refresh an old fire. Daily dates are interpreted at 00:00 UTC and displayed as dates, not exact observation times. This strict cutoff can omit ongoing fires between daily updates. GDACS generally covers fires with at least 5,000 hectares burned, plus smaller events with humanitarian impacts; it is not a complete fire inventory. Markers are estimated event centers, and the reported area is estimated burned area, not the area currently burning. Each popup links to its source event. U.S. GDACS records are excluded to avoid duplicating NIFC coverage.</p>
        <p>Small terracotta squares show global <a href="https://firms.modaps.eosdis.nasa.gov/active_fire/" target="_blank" rel="noreferrer">NASA FIRMS S-NPP VIIRS</a> heat detections from the preceding 24 hours at nominal or high confidence. Numbered squares group nearby detections; their counts are satellite observations, not separate wildfires. Detections may include agricultural burning or other heat sources, and clouds or satellite timing can hide fires. The feeds are cached for ten minutes; missing feeds are identified on the map.</p>
        <h3>AirNow monitoring stations</h3>
        <p><a href="https://docs.airnowapi.org/docs/HourlyDataFactSheet.pdf" target="_blank" rel="noreferrer">AirNow hourly file products</a> provide measured PM₂.₅, joined to actual station coordinates from the monitoring-site registry. We show active PM₂.₅ sites inside your box, without a nine-point limit. This is the AirNow network, primarily in the US and Canada, with some other locations; it does not include PurpleAir’s community sensor network or every monitor in a city.</p>
        <p>For each station, we use its latest available hourly concentration from the previous three completed UTC hours. Observation times refer to the start of each one-hour measurement. Stations can report different hours; their exact times and reporting agency appear on click. Hollow markers lack a usable recent value. Missing, negative, and nonfinite concentrations are excluded from the calculation rather than replaced with zero. These preliminary measurements may be revised.</p>
        <p>The default concentration is the unweighted mean of reporting stations inside the box, not a spatially representative area average. Select a station on the map or in the menu to calculate from its measurement alone. We do not turn a single-hour reading into an official AQI. Data are cached for five minutes; no model values fill gaps in station mode.</p>
        <h3>Modeled air: spatial sampling</h3>
        <p>We divide your box into three columns and three equal-area rows, then query the center of each cell. Points 1–9 run left to right, from the northern row to the southern row. The displayed mean gives each available point equal weight. The map shows every query point and its PM₂.₅ value; click a point for its coordinates. “Model cells” also shows the grid coordinates returned by the provider, linked to the points that use them.</p>
        <p>These are model queries, not monitoring stations. The estimates come from the <a href="https://open-meteo.com/en/docs/air-quality-api" target="_blank" rel="noreferrer">CAMS global model via Open-Meteo</a>, with a native resolution of about 45 km. Returned grid coordinates may be finer because the provider processes the model; nearby samples are not independent measurements. The box is a sampling area, not a pollution boundary.</p>
        <p>The PM₂.₅ US AQI is the mean of the provider’s sample indices, based on a preceding 24-hour average. The cigarette comparison uses the current PM₂.₅ concentration instead. The forecast shows how the sampled mean may change; the exposure estimate holds the current concentration constant.</p>
        <h3>Activity assumptions</h3>
        <p>“At rest” is the original unadjusted analogy. Walking and running/cycling apply illustrative breathing multipliers of 3× and 8×, carried over from the original notebook (7.5, 22.5 and 60 L/min). Breathing varies widely, and multiplying intake does not establish an equivalent increase in health risk.</p>
        <h3>Credits</h3>
        <p>By <a href="https://pedrolab.org" target="_blank" rel="noreferrer">Pedro Pinheiro-Chagas</a>. Thanks to Brian Calcut for the idea, Sophia Hanley for suggestions, and Melissa Lunden for resources.</p>
        <p className="small-note">Your location is requested only when you choose “Situate me.” Coordinates are sent to this app and the air-quality provider to retrieve data, and included in shareable links. Mapbox serves the basemap, which includes OpenStreetMap data. No account or location history is stored by this app.</p>
      </div>
    </dialog>
  </div>
}
