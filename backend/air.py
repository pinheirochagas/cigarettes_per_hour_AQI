"""Spatial sampling and the Berkeley Earth comparison.

Uses PM2.5 concentrations, never reverse-converted AQI. Breathing multipliers
are exploratory assumptions, not validated health-risk adjustments.
"""
import math
from statistics import mean
from pydantic import BaseModel, Field, model_validator


class Bounds(BaseModel):
    south: float = Field(ge=-85, le=85, allow_inf_nan=False)
    west: float = Field(ge=-180, le=180, allow_inf_nan=False)
    north: float = Field(ge=-85, le=85, allow_inf_nan=False)
    east: float = Field(ge=-180, le=180, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_area(self):
        if self.north <= self.south or self.east <= self.west:
            raise ValueError("Choose a box with positive width and height, without crossing the date line.")
        mid = (self.north + self.south) / 2
        height = (self.north - self.south) * 111.32
        width = (self.east - self.west) * 111.32 * math.cos(math.radians(mid))
        if max(height, width) > 250 or min(height, width) < 0.5:
            raise ValueError("Choose an area between 0.5 and 250 km on each side.")
        return self


def sample_points(bounds: Bounds) -> list[tuple[float, float]]:
    """Nine equal-area tile midpoints (latitude distributed in sine space)."""
    low, high = math.sin(math.radians(bounds.south)), math.sin(math.radians(bounds.north))
    return [
        (
            round(math.degrees(math.asin(low + (high - low) * (row + 0.5) / 3)), 5),
            round(bounds.west + (bounds.east - bounds.west) * (col + 0.5) / 3, 5),
        )
        for row in (2, 1, 0) for col in range(3)
    ]


def valid_value(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def average(values):
    values = [v for v in values if valid_value(v)]
    return round(mean(values), 3) if values else None


def cigarette_equivalent(pm25: float, hours: float = 1, multiplier: float = 1) -> float:
    return pm25 * hours * multiplier / (22 * 24)


def summarize(bounds: Bounds, documents: list[dict]) -> dict:
    points = sample_points(bounds)
    if len(documents) != len(points):
        raise ValueError("The provider returned an incomplete sampling grid.")
    samples = []
    time_series: dict[str, list[float]] = {}
    for index, ((lat, lon), doc) in enumerate(zip(points, documents)):
        current = doc.get("current") or {}
        pm25 = current.get("pm2_5")
        samples.append({
            "id": index + 1,
            "latitude": lat, "longitude": lon,
            "grid_latitude": doc.get("latitude"), "grid_longitude": doc.get("longitude"),
            "pm25": pm25 if valid_value(pm25) else None,
            "aqi": current.get("us_aqi_pm2_5") if valid_value(current.get("us_aqi_pm2_5")) else None,
            "time": current.get("time"),
        })
        hourly = doc.get("hourly") or {}
        for time, value in zip(hourly.get("time", []), hourly.get("pm2_5", [])):
            if valid_value(value):
                time_series.setdefault(time, []).append(value)
    available = [s for s in samples if s["pm25"] is not None and s["time"]]
    if not available:
        raise ValueError("No PM₂.₅ data is available for this area.")
    timestamp = max(s["time"] for s in available)
    for sample in samples:
        if sample["time"] != timestamp:
            sample["pm25"] = sample["aqi"] = None
    available = [s for s in samples if s["pm25"] is not None]
    pm25 = average([s["pm25"] for s in available])
    return {
        "bounds": bounds.model_dump(), "time": timestamp + "Z", "pm25": pm25,
        "pm25_min": min(s["pm25"] for s in available),
        "pm25_max": max(s["pm25"] for s in available),
        "aqi": average([s["aqi"] for s in available]),
        "cigarettes_per_hour": cigarette_equivalent(pm25),
        "samples": samples, "sample_count": len(available), "requested_samples": 9,
        "grid_cells": len({(s["grid_latitude"], s["grid_longitude"]) for s in available}),
        "partial": len(available) < 9,
        "hourly": [
            {"time": t + "Z", "pm25": average(v), "sample_count": len(v)}
            for t, v in sorted(time_series.items()) if t >= timestamp
        ][:24],
        "source": "Open-Meteo / CAMS global", "resolution_km": 45,
    }
