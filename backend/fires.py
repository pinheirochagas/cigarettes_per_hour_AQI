"""Recent NIFC/GDACS wildfire events and NASA FIRMS heat detections."""
import asyncio
import csv
import io
import math
import time
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field, model_validator

FIRMS_URL = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv"
NIFC_URL = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query"
NIFC_FIELDS = "OBJECTID,IncidentName,IncidentSize,PercentContained,FireDiscoveryDateTime,ModifiedOnDateTime_dt,FireOutDateTime,ControlDateTime,ActiveFireCandidate,IncidentTypeCategory,ICS209ReportDateTime,ICS209ReportForTimePeriodTo"
GDACS_URL = "https://www.gdacs.org/gdacsapi/api/Events/geteventlist/search"
ACTIVITY_HOURS = 24


class FireViewport(BaseModel):
    south: float = Field(ge=-85, le=85, allow_inf_nan=False)
    north: float = Field(ge=-85, le=85, allow_inf_nan=False)
    west: float = Field(ge=-180, le=180, allow_inf_nan=False)
    east: float = Field(ge=-180, le=180, allow_inf_nan=False)
    zoom: int = Field(ge=2, le=17)

    @model_validator(mode="after")
    def valid_area(self):
        if self.south >= self.north or self.west == self.east:
            raise ValueError("Invalid fire-map viewport")
        return self

    def contains(self, lat, lon):
        longitude_inside = self.west <= lon <= self.east if self.west < self.east else lon >= self.west or lon <= self.east
        return self.south <= lat <= self.north and longitude_inside


def number(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (ValueError, TypeError):
        return None


def parse_hotspots(text: str, now: datetime) -> list[dict]:
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    if not {"latitude", "longitude", "acq_date", "acq_time", "confidence", "frp"}.issubset(reader.fieldnames or []):
        raise ValueError("Invalid FIRMS CSV")
    points = {}
    for row in reader:
        lat, lon = number(row["latitude"]), number(row["longitude"])
        if lat is None or lon is None or not (-85 <= lat <= 85 and -180 <= lon <= 180):
            continue
        try:
            observed = datetime.strptime(
                row["acq_date"] + row["acq_time"].zfill(4), "%Y-%m-%d%H%M",
            ).replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue
        if not now - timedelta(hours=24) <= observed <= now:
            continue
        confidence = row["confidence"].lower()
        if confidence not in {"nominal", "high", "n", "h"}:
            continue
        frp = number(row["frp"])
        timestamp = observed.isoformat()
        points[(lat, lon, timestamp)] = {
            "latitude": lat, "longitude": lon, "time": timestamp,
            "confidence": "high" if confidence in {"high", "h"} else "nominal",
            "frp": frp if frp is not None and frp >= 0 else None,
        }
    # A worldwide feed with no recent detections is treated as unavailable.
    if not points:
        raise ValueError("No recent global FIRMS observations")
    return list(points.values())


def iso_milliseconds(value):
    value = number(value)
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat()
    except (ValueError, OverflowError, OSError):
        return None


def recent_activity(timestamp: str | None, now: datetime) -> bool:
    if not timestamp:
        return False
    return now - timedelta(hours=ACTIVITY_HOURS) <= datetime.fromisoformat(timestamp) <= now


def gdacs_timestamp(value):
    """GDACS dates without an offset are UTC; never use database edit time."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).astimezone(timezone.utc).isoformat()
    except ValueError:
        return None


def parse_global_incidents(features: list[dict], now: datetime) -> list[dict]:
    incidents = {}
    for feature in features:
        if not isinstance(feature, dict):
            continue
        p, g = feature.get("properties") or {}, feature.get("geometry") or {}
        if not isinstance(p, dict) or not isinstance(g, dict):
            continue
        if p.get("eventtype") != "WF" or str(p.get("iscurrent")).lower() != "true":
            continue
        # NIFC supplies US incidents. Use country metadata, not a rough US box.
        countries = p.get("affectedcountries") or []
        if not p.get("iso3") or p["iso3"] == "USA" or any(
            isinstance(country, dict) and country.get("iso3") == "USA" for country in countries
        ):
            continue
        activity_at = gdacs_timestamp(p.get("todate"))
        if not recent_activity(activity_at, now):
            continue
        coordinates = g.get("coordinates")
        if g.get("type") != "Point" or not isinstance(coordinates, list) or len(coordinates) < 2:
            continue
        lon, lat = number(coordinates[0]), number(coordinates[1])
        if lat is None or lon is None or not (-85 <= lat <= 85 and -180 <= lon <= 180):
            continue
        event_id = p.get("eventid")
        if not isinstance(event_id, int) or isinstance(event_id, bool) or event_id <= 0:
            continue
        severity = p.get("severitydata") or {}
        hectares = number(severity.get("severity")) if severity.get("severityunit") == "ha" else None
        incident = {
            "id": f"gdacs:{event_id}",
            "name": str(p.get("eventname") or p.get("name") or "Wildfire event"),
            "source": "GDACS", "source_url": f"https://www.gdacs.org/report.aspx?eventtype=WF&eventid={event_id}",
            "latitude": lat, "longitude": lon, "acres": None,
            "hectares": hectares if hectares is not None and hectares >= 0 else None,
            "contained": None, "updated_at": gdacs_timestamp(p.get("datemodified")),
            "discovered_at": gdacs_timestamp(p.get("fromdate")),
            "activity_at": activity_at, "activity_basis": "reported activity",
            "activity_precision": "day" if activity_at[11:19] == "00:00:00" else "time",
        }
        previous = incidents.get(event_id)
        if previous is None or incident["activity_at"] > previous["activity_at"]:
            incidents[event_id] = incident
    return list(incidents.values())


def parse_incidents(features: list[dict], now: datetime) -> list[dict]:
    incidents = {}
    for feature in features:
        a, g = feature.get("attributes") or {}, feature.get("geometry") or {}
        if (a.get("IncidentTypeCategory") != "WF" or a.get("ActiveFireCandidate") != 1
                or a.get("FireOutDateTime") is not None or a.get("ControlDateTime") is not None):
            continue
        # Database modification is not evidence of current incident activity.
        # Prefer the reporting period over submission time: an old report may
        # have been submitted or edited today.
        discovered = iso_milliseconds(a.get("FireDiscoveryDateTime"))
        report_field = "ICS209ReportForTimePeriodTo" if a.get("ICS209ReportForTimePeriodTo") is not None else "ICS209ReportDateTime"
        reported = iso_milliseconds(a.get(report_field))
        candidates = [(discovered, "discovery"), (reported, "reporting period" if report_field == "ICS209ReportForTimePeriodTo" else "incident report")]
        candidates = [(timestamp, basis) for timestamp, basis in candidates if recent_activity(timestamp, now)]
        if not candidates:
            continue
        activity_at, activity_basis = max(candidates)
        lat, lon = number(g.get("y")), number(g.get("x"))
        if lat is None or lon is None or not (-85 <= lat <= 85 and -180 <= lon <= 180):
            continue
        acres, contained = number(a.get("IncidentSize")), number(a.get("PercentContained"))
        if contained is not None and contained >= 100:
            continue
        incident_id = a.get("OBJECTID")
        if not isinstance(incident_id, int):
            continue
        incidents[incident_id] = {
            "id": f"nifc:{incident_id}", "name": str(a.get("IncidentName") or "Unnamed wildfire"),
            "source": "NIFC",
            "source_url": "https://data-nifc.opendata.arcgis.com/datasets/nifc::current-wildland-fire-incident-locations",
            "latitude": lat, "longitude": lon,
            "acres": acres if acres is not None and acres >= 0 else None,
            "contained": contained if contained is not None and 0 <= contained <= 100 else None,
            "updated_at": iso_milliseconds(a.get("ModifiedOnDateTime_dt")),
            "discovered_at": discovered,
            "activity_at": activity_at, "activity_basis": activity_basis,
            "activity_precision": "time", "hectares": None,
        }
    return list(incidents.values())


def group_hotspots(points: list[dict], viewport: FireViewport, now: datetime) -> tuple[list, int]:
    """Group detections in 24-screen-pixel cells, never report clusters as fires."""
    groups = {}
    cutoff = (now - timedelta(hours=24)).isoformat()
    for point in points:
        lat, lon = point["latitude"], point["longitude"]
        if point["time"] < cutoff or not viewport.contains(lat, lon):
            continue
        scale = 256 * 2 ** viewport.zoom
        x = (lon + 180) / 360 * scale
        y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * scale
        groups.setdefault((int(x // 24), int(y // 24)), []).append(point)
    result = []
    for values in groups.values():
        latitudes = [p["latitude"] for p in values]
        longitudes = [p["longitude"] for p in values]
        result.append({
            "latitude": sum(latitudes) / len(values), "longitude": sum(longitudes) / len(values),
            "count": len(values), "time": max(p["time"] for p in values),
            "first_time": min(p["time"] for p in values),
            "south": min(latitudes), "north": max(latitudes), "west": min(longitudes), "east": max(longitudes),
            "confidence": values[0]["confidence"] if len(values) == 1 else None,
            "frp": values[0]["frp"] if len(values) == 1 else None,
        })
    return result, sum(p["count"] for p in result)


class Fires:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.until = 0
        self.hotspots = []
        self.incidents = []
        self.unavailable = []
        self.fetched_at = None

    async def query(self, client: httpx.AsyncClient, viewport: FireViewport):
        async with self.lock:
            now = datetime.now(timezone.utc)
            if time.monotonic() >= self.until:
                async def firms():
                    response = await client.get(FIRMS_URL)
                    response.raise_for_status()
                    return parse_hotspots(response.text, now)

                async def nifc():
                    features = []
                    offset = 0
                    while True:
                        response = await client.get(NIFC_URL, params={
                            "f": "json", "where": "IncidentTypeCategory = 'WF' AND ActiveFireCandidate = 1 AND FireOutDateTime IS NULL AND ControlDateTime IS NULL AND (PercentContained IS NULL OR PercentContained < 100)",
                            "outFields": NIFC_FIELDS, "outSR": 4326, "orderByFields": "OBJECTID",
                            "resultRecordCount": 2000, "resultOffset": offset,
                        })
                        response.raise_for_status()
                        data = response.json()
                        if not isinstance(data, dict) or data.get("error") or not isinstance(data.get("features"), list):
                            raise ValueError("Invalid NIFC response")
                        features.extend(data["features"])
                        if not data.get("exceededTransferLimit"):
                            return parse_incidents(features, now)
                        if not data["features"] or offset >= 20000:
                            raise ValueError("Incomplete NIFC response")
                        offset += len(data["features"])

                async def gdacs():
                    features = []
                    previous_pages = set()
                    cutoff = (now - timedelta(hours=ACTIVITY_HOURS)).isoformat()
                    for page in range(1, 21):
                        response = await client.get(GDACS_URL, params={
                            "eventlist": "WF", "alertlevel": "Green,Orange,Red",
                            "pageSize": 100, "pageNumber": page,
                        })
                        response.raise_for_status()
                        data = response.json()
                        if not isinstance(data, dict) or data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
                            raise ValueError("Invalid GDACS response")
                        batch = data["features"]
                        fingerprint = response.content
                        if fingerprint in previous_pages:
                            raise ValueError("Repeated GDACS page")
                        previous_pages.add(fingerprint)
                        features.extend(batch)
                        # Search is ordered by activity end descending. Do not
                        # filter by start date: an older fire may still be active.
                        dates = [gdacs_timestamp((f.get("properties") or {}).get("todate")) for f in batch if isinstance(f, dict)]
                        if len(batch) < 100 or any(date and date < cutoff for date in dates):
                            return parse_global_incidents(features, now)
                    raise ValueError("Incomplete GDACS response")

                results = await asyncio.gather(firms(), nifc(), gdacs(), return_exceptions=True)
                self.unavailable = [name for name, value in zip(("NASA FIRMS", "NIFC", "GDACS"), results) if isinstance(value, Exception)]
                if len(self.unavailable) == 3:
                    raise HTTPException(502, "Fire feeds are temporarily unavailable. Please try again.")
                self.hotspots, domestic, international = [value if isinstance(value, list) else [] for value in results]
                self.incidents = domestic + international
                self.fetched_at = now.isoformat()
                self.until = time.monotonic() + (60 if self.unavailable else 600)
            hotspots, count = group_hotspots(self.hotspots, viewport, now)
            incidents = [
                p for p in self.incidents
                if recent_activity(p["activity_at"], now) and viewport.contains(p["latitude"], p["longitude"])
            ]
            return {
                "hotspots": hotspots, "detection_count": count, "incidents": incidents,
                "unavailable": self.unavailable, "fetched_at": self.fetched_at,
                "latest_detection": max((p["time"] for p in hotspots), default=None),
                "window_hours": ACTIVITY_HOURS,
            }
