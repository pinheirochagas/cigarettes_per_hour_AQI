"""Public outdoor PurpleAir sensors. The API read key stays on the server."""
import asyncio
import math
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import HTTPException

from .air import Bounds, average, valid_value

URL = "https://api.purpleair.com/v1/sensors"
FIELDS = "name,latitude,longitude,location_type,private,last_seen,confidence,pm2.5_alt"
MAX_AGE = 3600
CACHE_SECONDS = 600


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def summarize_purpleair(bounds: Bounds, payload: dict, now: datetime) -> dict:
    fields, rows = payload.get("fields"), payload.get("data")
    required = {"sensor_index", *FIELDS.split(",")}
    if not isinstance(fields, list) or not all(isinstance(field, str) for field in fields):
        raise ValueError("Invalid PurpleAir fields")
    if not required.issubset(fields) or not isinstance(rows, list):
        raise ValueError("Incomplete PurpleAir response")
    sensors = {}
    for values in rows:
        if not isinstance(values, list) or len(values) != len(fields):
            raise ValueError("Incomplete PurpleAir sensor row")
        row = dict(zip(fields, values))
        sensor_id, lat, lon = row["sensor_index"], row["latitude"], row["longitude"]
        if row["location_type"] != 0 or row["private"] != 0:
            continue
        if not isinstance(sensor_id, int) or isinstance(sensor_id, bool) or sensor_id <= 0:
            continue
        if not finite(lat) or not finite(lon):
            continue
        if not bounds.south <= lat <= bounds.north or not bounds.west <= lon <= bounds.east:
            continue
        last_seen = row["last_seen"]
        recent = finite(last_seen) and 0 <= now.timestamp() - last_seen <= MAX_AGE
        value = row["pm2.5_alt"]
        usable = recent and valid_value(value)
        # A report timestamp is not an hourly measurement interval.
        timestamp = datetime.fromtimestamp(last_seen, timezone.utc).isoformat() if recent else None
        confidence = row["confidence"]
        sensors[str(sensor_id)] = {
            "id": str(sensor_id), "name": str(row["name"] or f"Sensor {sensor_id}"),
            "latitude": lat, "longitude": lon, "agency": "PurpleAir community sensor",
            "pm25": value if usable else None, "time": timestamp, "time_end": None,
            "confidence": confidence if finite(confidence) and 0 <= confidence <= 100 else None,
            "unavailable_reason": None if usable else (
                "No report within the last hour" if not recent else "PM₂.₅ ALT reading unavailable"
            ),
        }
    stations = sorted(sensors.values(), key=lambda sensor: (sensor["name"], sensor["id"]))
    available = [sensor for sensor in stations if sensor["pm25"] is not None]
    timestamps = [sensor["time"] for sensor in available]
    return {
        "bounds": bounds.model_dump(), "source": "PurpleAir", "stations": stations,
        "station_count": len(stations), "reporting_count": len(available),
        "pm25": average([sensor["pm25"] for sensor in available]),
        "pm25_min": min((sensor["pm25"] for sensor in available), default=None),
        "pm25_max": max((sensor["pm25"] for sensor in available), default=None),
        "time_start": min(timestamps, default=None), "time_end": max(timestamps, default=None),
        "window_start": (now - timedelta(seconds=MAX_AGE)).isoformat(),
        "window_end": now.isoformat(), "lookback_hours": 1, "hours_available": 1,
        "measurement": "PM₂.₅ ALT", "fetched_at": now.isoformat(),
    }


class PurpleAir:
    def __init__(self):
        self.cache = OrderedDict()
        self.lock = asyncio.Lock()
        self.last_request = 0

    async def query(self, client: httpx.AsyncClient, bounds: Bounds, api_key: str):
        if not api_key:
            raise HTTPException(503, "PurpleAir is not connected yet.")
        key = tuple(bounds.model_dump().values())
        async with self.lock:
            cached = self.cache.get(key)
            if cached and cached[0] > time.monotonic():
                self.cache.move_to_end(key)
                # Recheck freshness even while the raw provider response is cached.
                result = summarize_purpleair(bounds, cached[1], datetime.now(timezone.utc))
                result["fetched_at"] = cached[2]
                return result
            await asyncio.sleep(max(0, 0.6 - (time.monotonic() - self.last_request)))
            self.last_request = time.monotonic()
            try:
                response = await client.get(URL, headers={"X-API-Key": api_key}, params={
                    "fields": FIELDS, "location_type": 0, "max_age": MAX_AGE,
                    "nwlat": bounds.north, "nwlng": bounds.west,
                    "selat": bounds.south, "selng": bounds.east,
                })
                if response.status_code in (401, 403):
                    raise HTTPException(502, "PurpleAir rejected the API key. Check that it is an active API read key.")
                if response.status_code == 402:
                    raise HTTPException(502, "PurpleAir API points are exhausted. Check the developer account balance.")
                if response.status_code == 429:
                    raise HTTPException(503, "PurpleAir is rate-limiting requests. Please try again shortly.")
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict) or payload.get("error"):
                    raise ValueError("PurpleAir provider error")
                # Never retain or forward API credentials echoed by the provider.
                safe_payload = {field: payload.get(field) for field in ("fields", "data")}
                result = summarize_purpleair(bounds, safe_payload, datetime.now(timezone.utc))
            except (httpx.HTTPError, ValueError, TypeError) as exc:
                raise HTTPException(502, "PurpleAir data is temporarily unavailable. Retry or select another source.") from exc
            self.cache[key] = (time.monotonic() + CACHE_SECONDS, safe_payload, result["fetched_at"])
            self.cache.move_to_end(key)
            while len(self.cache) > 128:
                self.cache.popitem(last=False)
            return result
