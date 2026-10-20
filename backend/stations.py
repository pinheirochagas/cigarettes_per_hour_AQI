"""AirNow monitoring-site metadata joined to measured hourly PM2.5.

Public file products, not reporting-area AQIs or interpolated map pixels.
Field definitions: https://docs.airnowapi.org/docs/HourlyDataFactSheet.pdf
and https://docs.airnowapi.org/docs/MonitoringSiteV2FactSheet.pdf.
"""
import asyncio
import csv
import io
import math
import time
from datetime import datetime, timedelta, timezone

import httpx

from .air import Bounds, average

BASE_URL = "https://files.airnowtech.org/airnow"
CATALOG_URL = f"{BASE_URL}/today/Monitoring_Site_Locations_V2.dat"
LOOKBACK_HOURS = 3


def parse_sites(text: str) -> dict[str, dict]:
    sites = {}
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")), delimiter="|")
    required = {"StationID", "AQSID", "FullAQSID", "Parameter", "SiteName", "Status",
                "AgencyName", "Latitude", "Longitude"}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError("Unexpected AirNow station file")
    for row in reader:
        if row["Parameter"] != "PM2.5" or row["Status"] != "Active":
            continue
        try:
            lat, lon = float(row["Latitude"]), float(row["Longitude"])
        except (TypeError, ValueError):
            continue
        if not (-85 <= lat <= 85 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
            continue
        station_id = row["FullAQSID"] or row["StationID"]
        if not station_id:
            continue
        sites[station_id] = {
            "id": station_id, "name": row["SiteName"] or station_id,
            "latitude": lat, "longitude": lon, "agency": row["AgencyName"] or "AirNow partner",
            "aliases": {row[key] for key in ("StationID", "AQSID", "FullAQSID") if row[key]},
        }
    if not sites:
        raise ValueError("AirNow returned no station metadata")
    return sites


def parse_observations(text: str, sites: dict, start: datetime, end: datetime) -> dict:
    # Some international sites share a short AQS ID. Never join ambiguous aliases.
    aliases: dict[str, str | None] = {}
    for site in sites.values():
        for alias in site["aliases"]:
            if alias in aliases and aliases[alias] != site["id"]:
                aliases[alias] = None
            else:
                aliases[alias] = site["id"]
    observations = {}
    for row in csv.reader(io.StringIO(text), delimiter="|"):
        if len(row) < 9 or row[5] != "PM2.5" or row[6].upper() != "UG/M3":
            continue
        station_id = aliases.get(row[2])
        if station_id is None:
            continue
        try:
            measured_at = datetime.strptime(f"{row[0]} {row[1]}", "%m/%d/%y %H:%M").replace(tzinfo=timezone.utc)
            value = float(row[7])
        except (ValueError, TypeError):
            continue
        # Negative instrument-drift values are not usable in the smoke analogy.
        if not math.isfinite(value) or value < 0 or not start <= measured_at < end:
            continue
        timestamp = measured_at.isoformat()
        if station_id not in observations or timestamp > observations[station_id]["time"]:
            observations[station_id] = {
                "pm25": value, "time": timestamp,
                "time_end": (measured_at + timedelta(hours=1)).isoformat(),
                "agency": row[8] or sites[station_id]["agency"],
            }
    return observations


def summarize_stations(bounds: Bounds, sites: dict, observations: dict, now: datetime,
                       hours_available: int) -> dict:
    stations = []
    for site in sites.values():
        if not (bounds.south <= site["latitude"] <= bounds.north and
                bounds.west <= site["longitude"] <= bounds.east):
            continue
        record = {key: value for key, value in site.items() if key != "aliases"}
        record.update({"pm25": None, "time": None, "time_end": None})
        record.update(observations.get(site["id"], {}))
        stations.append(record)
    stations.sort(key=lambda site: (site["name"], site["id"]))
    available = [site for site in stations if site["pm25"] is not None]
    end = now.replace(minute=0, second=0, microsecond=0)
    return {
        "bounds": bounds.model_dump(), "source": "AirNow", "stations": stations,
        "station_count": len(stations), "reporting_count": len(available),
        "pm25": average([site["pm25"] for site in available]),
        "pm25_min": min((site["pm25"] for site in available), default=None),
        "pm25_max": max((site["pm25"] for site in available), default=None),
        "time_start": min((site["time"] for site in available), default=None),
        "time_end": max((site["time_end"] for site in available), default=None),
        "window_start": (end - timedelta(hours=LOOKBACK_HOURS)).isoformat(),
        "window_end": end.isoformat(), "lookback_hours": LOOKBACK_HOURS,
        "hours_available": hours_available, "fetched_at": now.isoformat(),
    }


class AirNow:
    """Share downloads across every bounding box; refresh observations every 5 min."""

    def __init__(self):
        self.lock = asyncio.Lock()
        self.sites = {}
        self.sites_until = 0
        self.observations = {}
        self.observations_until = 0
        self.observation_hour = None
        self.hours_available = 0
        self.fetched_at = None

    async def query(self, client: httpx.AsyncClient, bounds: Bounds) -> dict:
        async with self.lock:
            now = datetime.now(timezone.utc)
            hour = now.replace(minute=0, second=0, microsecond=0)
            if time.monotonic() >= self.sites_until:
                response = await client.get(CATALOG_URL)
                response.raise_for_status()
                self.sites = parse_sites(response.content.decode("utf-8-sig"))
                self.sites_until = time.monotonic() + 3600
                self.observations_until = 0
            if time.monotonic() >= self.observations_until or self.observation_hour != hour:
                async def get_hour(offset: int):
                    date = hour - timedelta(hours=offset)
                    url = f"{BASE_URL}/{date:%Y}/{date:%Y%m%d}/HourlyData_{date:%Y%m%d%H}.dat"
                    response = await client.get(url)
                    response.raise_for_status()
                    # Hourly files are legacy ASCII with occasional extended characters.
                    return response.content.decode("utf-8", errors="replace")

                results = await asyncio.gather(
                    *(get_hour(i) for i in range(1, LOOKBACK_HOURS + 1)),
                    return_exceptions=True,
                )
                texts = [value for value in results if isinstance(value, str)]
                observations = parse_observations(
                    "\n".join(texts), self.sites, hour - timedelta(hours=LOOKBACK_HOURS), hour,
                )
                if not observations:
                    raise ValueError("No recent AirNow observations available")
                self.observations = observations
                self.hours_available = len(texts)
                self.observation_hour = hour
                self.observations_until = time.monotonic() + 300
                self.fetched_at = now
            result = summarize_stations(bounds, self.sites, self.observations, now, self.hours_available)
            result["fetched_at"] = self.fetched_at.isoformat()
            return result
