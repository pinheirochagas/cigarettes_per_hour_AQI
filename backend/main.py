import asyncio
import os
import time
from collections import OrderedDict, defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from .air import Bounds, sample_points, summarize
from .stations import AirNow
from .purpleair import PurpleAir
from .fires import FireViewport, Fires

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env", override=False)
DIST = ROOT / "frontend" / "dist"
AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
SEARCH_URL = "https://geocoding-api.open-meteo.com/v1/search"


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient(timeout=25, headers={"User-Agent": "Smoking/1.0 (smoking.pedrolab.org)"}) as client:
        app.state.client = client
        app.state.cache = OrderedDict()
        app.state.limits = defaultdict(deque)
        app.state.upstream_slots = asyncio.Semaphore(6)
        app.state.airnow = AirNow()
        app.state.purpleair = PurpleAir()
        app.state.fires = Fires()
        yield


app = FastAPI(title="Smoking Trails", version="1.0.0", lifespan=lifespan)


@app.middleware("http")
async def response_headers(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.url.path != "/api/health":
        key = request.client.host if request.client else "unknown"
        now = time.monotonic()
        limits = request.app.state.limits
        if len(limits) > 5000:
            for old_key in list(limits):
                if not limits[old_key] or limits[old_key][-1] < now - 60:
                    del limits[old_key]
        hits = limits[key]
        while hits and hits[0] < now - 60:
            hits.popleft()
        if len(hits) >= 120:
            return JSONResponse({"detail": "Too many requests. Please try again in a minute."}, 429, headers={"Retry-After": "60"})
        hits.append(now)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(self), camera=(), microphone=()"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


async def provider_json(request: Request, url: str, params: dict):
    async with request.app.state.upstream_slots:
        try:
            response = await request.app.state.client.get(url, params=params)
            response.raise_for_status()
            data = response.json()
            if isinstance(data, dict) and data.get("error"):
                raise ValueError("Provider error")
            return data
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(502, "The data provider is temporarily unavailable. Please try again.") from exc


def cache_get(request, key):
    cache = request.app.state.cache
    cached = cache.get(key)
    if cached and cached[0] > time.monotonic():
        cache.move_to_end(key)
        return cached[1]
    return None


def cache_put(request, key, value, ttl=600):
    cache = request.app.state.cache
    cache[key] = (time.monotonic() + ttl, value)
    cache.move_to_end(key)
    while len(cache) > 256:
        cache.popitem(last=False)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/map-config")
async def map_config():
    token = os.getenv("MAPBOX_TOKEN", "").strip()
    if not token.startswith("pk."):
        raise HTTPException(503, "A public Mapbox token is required to load the map.")
    return {"mapbox_token": token, "style": "mapbox/light-v11"}


@app.get("/api/search")
async def search(request: Request, q: str = Query(min_length=2, max_length=120)):
    query = q.strip()
    if len(query) < 2:
        raise HTTPException(422, "Enter at least two characters.")
    key = ("search", query.casefold())
    if (cached := cache_get(request, key)) is not None:
        return cached
    data = await provider_json(request, SEARCH_URL, {"name": query, "count": 6, "language": "en", "format": "json"})
    if not isinstance(data, dict):
        raise HTTPException(502, "The place search returned an unexpected response.")
    results = {"results": [
        {
            "id": p["id"], "name": p["name"],
            "region": ", ".join(dict.fromkeys(x for x in [p.get("admin1"), p.get("country")] if x)),
            "latitude": p["latitude"], "longitude": p["longitude"],
        }
        for p in data.get("results", [])
        if all(k in p for k in ["id", "name", "latitude", "longitude"]) and -85 <= p["latitude"] <= 85
    ]}
    cache_put(request, key, results, ttl=86400)
    return results


@app.post("/api/air-quality")
async def air_quality(bounds: Bounds, request: Request):
    key = ("air", bounds.south, bounds.west, bounds.north, bounds.east)
    if (cached := cache_get(request, key)) is not None:
        return cached
    points = sample_points(bounds)
    data = await provider_json(request, AIR_URL, {
        "latitude": ",".join(f"{lat:.5f}" for lat, _ in points),
        "longitude": ",".join(f"{lon:.5f}" for _, lon in points),
        "current": "pm2_5,us_aqi_pm2_5", "hourly": "pm2_5", "forecast_hours": 24,
        "timezone": "GMT", "domains": "cams_global",
    })
    try:
        result = summarize(bounds, data if isinstance(data, list) else [data])
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        raise HTTPException(502, "Air-quality data is missing or incomplete for this area. Please try another location.") from exc
    result["fetched_at"] = datetime.now(timezone.utc).isoformat()
    cache_put(request, key, result)
    return result


@app.post("/api/stations")
async def monitoring_stations(bounds: Bounds, request: Request):
    try:
        return await request.app.state.airnow.query(request.app.state.client, bounds)
    except (httpx.HTTPError, ValueError, UnicodeError) as exc:
        raise HTTPException(502, "AirNow station data is temporarily unavailable. Retry or select Modeled air.") from exc


@app.post("/api/purpleair")
async def community_sensors(bounds: Bounds, request: Request):
    return await request.app.state.purpleair.query(
        request.app.state.client, bounds, os.getenv("PURPLE_AIR_API_KEY", "").strip(),
    )


@app.post("/api/fires")
async def fire_layer(viewport: FireViewport, request: Request):
    return await request.app.state.fires.query(request.app.state.client, viewport)


if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    async def index():
        return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/favicon.svg")
    async def favicon():
        return FileResponse(DIST / "favicon.svg")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
