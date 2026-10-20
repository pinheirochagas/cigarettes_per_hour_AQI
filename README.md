# Smoking Trails

A React / TypeScript map and FastAPI backend for exploring air pollution and
rough cigarette equivalents. Locate yourself, search for a city or postal code,
click the map, or draw a box using two corners.

## Run locally

Requires Node.js 22.18+ and Python 3.12+.

```sh
uv sync --locked
cd frontend
npm ci
npm run build
cd ..
uv run python -m backend.main
```

Open [localhost:8000](http://localhost:8000). FastAPI serves the built frontend
and the API from the same origin. Put a browser-safe Mapbox public token (`pk.*`)
in an ignored root `.env` as `MAPBOX_TOKEN=...` (see `.env.example`).
The local configuration reuses the public token from `route_biodiversity`.
FastAPI exposes only a public token through `/api/map-config`; secret tokens
are rejected. AirNow's public file products and the current noncommercial
Open-Meteo endpoints do not require an API key.

For PurpleAir, add an API **read** key as `PURPLE_AIR_API_KEY` in the root `.env`.
Create/manage it in the [PurpleAir developer dashboard](https://develop.purpleair.com/).
The backend sends it only to PurpleAir in the `X-API-Key` header; it is never
returned to the browser or put in a URL. Requests use the account's API points.
Restart the backend after changing environment variables.

For frontend development, leave the API running and run `npm run dev` inside
`frontend/`. Vite proxies `/api` to port 8000.

## Data and calculation

- **PurpleAir (default):** public outdoor community sensors within the selected
  box, via the [PurpleAir API](https://api.purpleair.com/#api-sensors-get-sensors-data).
  Uses `pm2.5_alt`, explicitly labeled **PM₂.₅ ALT**, in µg/m³. It is neither AQI
  nor an EPA-corrected concentration. The provider combines channels excluding
  downgraded channels. Popups include channel confidence when available.
  Counts can differ from PurpleAir's own map because we request outdoor public
  devices updated within one hour and require recent telemetry for calculations.
  Map layer/averaging settings also affect the displayed values.
- Each PurpleAir sensor's last report must be within one hour. Invalid, missing,
  and stale measurements do not enter the mean; zero remains a valid reported
  value. Sensor markers use provider coordinates. At wider zoom levels only
  dots are shown to reduce overlapping labels; zoom in, hover, or select for values.
  Click a sensor to calculate from its reading. Otherwise the app uses the
  unweighted mean, which can overweight densely instrumented neighborhoods.
  No AirNow or modeled readings are blended in.
- PurpleAir downloads for identical boxes are cached for ten minutes (128 entries
  maximum), with freshness rechecked on cache hits. Requests are serialized with
  a minimum 600 ms between upstream calls. Bounds limit each query to the selected
  area. Only the needed fields are requested to reduce API point usage.
- **AirNow:** measured PM₂.₅ from
  [AirNow hourly files](https://docs.airnowapi.org/docs/HourlyDataFactSheet.pdf),
  joined to the
  [monitoring-site registry](https://docs.airnowapi.org/docs/MonitoringSiteV2FactSheet.pdf).
  The map shows all active PM₂.₅ sites in the selected box, at their actual
  coordinates. This covers the AirNow network; PurpleAir is a separate source.
  No nine-station cap is applied.
  Click a station or use the selector to calculate from its measurement alone.
- Each station uses its latest usable hourly observation in the previous three
  completed UTC hours. Popups identify the station, reporting agency, and exact
  measurement interval. Hollow markers mean no usable recent reading. Missing,
  negative, and nonfinite values are excluded, never treated as clean air.
  The default is the unweighted mean of reporting stations (potentially different
  observation hours), **not** an area average. AirNow data are preliminary.
  We do not derive an official AQI from a single hourly concentration.
- Station metadata refreshes hourly; hourly files refresh every five minutes,
  shared across bounding boxes. Missing hourly files are flagged. A provider
  failure does not silently return old readings or switch to modeled values.
  Empty areas offer an explicit choice to enlarge the box or use Modeled air.
- **Modeled air (optional):** the box is divided into three equal-area rows and three columns. One query
  is made at each cell center, numbered 1–9 from northwest to southeast.
  The map draws the grid, numbered query markers, and each PM₂.₅ reading.
  Clicking a marker shows its query coordinates and the provider's returned
  model-grid coordinates. “Model cells” displays those grid locations and links.
  These are modeled queries, not monitoring stations.
- Concentrations come from the CAMS global model through
  [Open-Meteo](https://open-meteo.com/en/docs/air-quality-api), with a native
  resolution of approximately 45 km. Smaller sampling boxes do not establish
  street-level accuracy. Returned grid locations are not necessarily independent
  model cells.
- The estimate uses current PM₂.₅ directly: `PM₂.₅ × hours / (22 × 24)`,
  following [Berkeley Earth's approximation](https://berkeleyearth.org/air-pollution-and-cigarette-equivalence/).
  It assumes concentration stays constant for the chosen duration.
- Activity options retain the notebook's illustrative 1×, 3×, and 8× breathing
  assumptions. These are not validated health-risk multipliers.
- In model mode, the displayed US AQI is the mean of the provider's PM₂.₅ indices, which use a
  preceding 24-hour average. It is distinct from instantaneous concentration.
- Missing samples are excluded and flagged; they are never replaced with zero.
  Failed requests clear the result and offer a retry.
- Search and air data are cached in bounded process memory. No database, user
  account, analytics, or stored location history is used. Share URLs include the
  selected coordinates. A restart clears the cache.
- The basemap uses Mapbox Light v11, matching `route_biodiversity`, with 512px
  retina tiles, the Mapbox logo, and Mapbox / OpenStreetMap attribution.
  The logo is the unmodified asset from the existing local Mapbox stylesheet.
- Sensor and query markers use pastel green/yellow/orange/red/purple/maroon
  fills based on the [EPA's current PM₂.₅ concentration breakpoints](https://aqs.epa.gov/aqsweb/documents/codetables/aqi_breakpoints.html).
  Values are truncated to one decimal before assigning a band. This colors the
  displayed concentration; it does not establish an official daily AQI/NowCast.
  Popups and the numeric legend explain the categories.

## Fire overlay

The **Fires** toggle adds three public sources, following the visible map:

- **Triangles:** reported active U.S. wildfire incidents from
  [NIFC/WFIGS](https://data-nifc.opendata.arcgis.com/datasets/nifc::current-wildland-fire-incident-locations).
  Filters: `IncidentTypeCategory = WF`, `ActiveFireCandidate = 1`,
  `FireOutDateTime IS NULL`, `ControlDateTime IS NULL`, and containment below
  100% or unreported. A discovery or incident-report timestamp must also fall
  within the preceding 24 hours. `ICS209ReportForTimePeriodTo` takes precedence
  over `ICS209ReportDateTime`; `ModifiedOnDateTime_dt` never qualifies an old
  record. The cutoff is reapplied on cache hits. Prescribed burns, controlled,
  out, fully contained, and stale records are excluded. This conservative rule
  can omit ongoing incidents with delayed reports. Popups show the qualifying
  report/discovery time. Locations are not fire perimeters or proof of current flames.
- **International triangles:** satellite-derived wildfire events from
  [GDACS / GWIS](https://www.gdacs.org/knowledge/models_wf.aspx), fetched directly
  from GDACS's paginated search API with all three alert levels. Only `WF` events
  marked `iscurrent` qualify, and `todate` must fall in the preceding 24 hours;
  `datemodified` never qualifies an event. Daily dates use midnight UTC and are
  labeled as dates without an exact observation time. This can omit ongoing fires
  between daily updates. U.S. records are excluded using country metadata.
  Markers represent event centers; popups link to the report and label hectares
  as estimated burned area. Coverage generally starts at 5,000 ha, with smaller
  events included for humanitarian impacts. This is not a complete inventory.
  EONET is not used: its GDACS feed returned stale open events during verification.
- **Terracotta squares:** global S-NPP VIIRS thermal detections from
  [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/active_fire/), filtered to the
  preceding 24 hours and nominal/high confidence. These are approximately 375 m
  satellite detections, which may include agricultural burns or other heat
  sources. They are not confirmed wildfire incidents or smoke plumes.
- At wider zooms, detections are grouped in 24-pixel cells. Labels count
  observations, not fires; popup controls zoom to the group's extent.
  The fire overlay does not change the PM₂.₅ calculation or selected box.
- All three public feeds require no key. Downloads are shared and cached for ten
  minutes; viewport changes only filter/regroup cached data. The visible layer
  rechecks the time window every minute. Partial feed failures are explicit; a stale or
  malformed global satellite feed is not silently represented as zero fires.

The original notebook is retained for historical reference, with its embedded
API credential and saved outputs removed. Its old AQI conversion is not used by
the web application.

## Checks

```sh
uv run pytest -q
cd frontend
npm test
npm run build
```

The tests cover the reference conversion, sampling geometry, coordinate limits,
partial data, mismatched model hours, caching, provider failures, and AQI categories.
Station tests cover metadata joins, real coordinate filtering, observation windows,
invalid readings, missing hours, empty areas, and shared caching across boxes.
PurpleAir tests cover field-order independence, public/outdoor and bounds filters,
stale/invalid readings, missing keys, upstream errors, caching, and secret redaction.

## Railway

The multi-stage Dockerfile builds React and serves it through FastAPI as one
service. Python dependencies are pinned in `requirements.lock`; JavaScript
dependencies are pinned in `frontend/package-lock.json`. The container runs as
an unprivileged user and listens on Railway's `PORT`. Set `MAPBOX_TOKEN` as a
Railway service variable before deploying, along with `PURPLE_AIR_API_KEY` for
community sensors; `.env` is never uploaded.

The Railway project `smoking` and service `web` have been created. To deploy
from GitHub, connect `pinheirochagas/cigarettes_per_hour_AQI`, select the `master`
branch, and use the repository root as the service root directory.
`railway.toml` selects the Dockerfile and health check. Add the two environment
variables above in Railway, then deploy from the repository.

Health check: `/api/health`.

The custom domain has been registered on Railway. Its pending Squarespace DNS
record is:

| Type | Host | Value |
| --- | --- | --- |
| CNAME | `smoking` | `np9k447r.up.railway.app` |

Confirm the current requirement with
`railway domain status smoking.pedrolab.org --service web` before editing DNS.
CLI uploads exclude notebooks, virtual environments, caches, and local secrets;
the Docker build also has an explicit application-file allowlist.
