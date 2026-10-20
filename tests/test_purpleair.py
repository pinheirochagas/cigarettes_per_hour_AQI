"""Synthetic PurpleAir responses; no real API key or requests in tests."""
import copy
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.air import Bounds
from backend.main import app
from backend.purpleair import FIELDS, summarize_purpleair

BOX = {"south": 37.65, "west": -122.6, "north": 37.85, "east": -122.3}
NOW = datetime.now(timezone.utc)
FAKE_KEY = "test-only-purpleair-secret"


def document(**changes):
    sensor = {
        "sensor_index": 123, "name": "Test community sensor", "latitude": 37.77,
        "longitude": -122.42, "location_type": 0, "private": 0,
        "last_seen": int((NOW - timedelta(minutes=2)).timestamp()),
        "confidence": 95, "pm2.5_alt": 8.5,
    }
    sensor.update(changes)
    # Reordered fields ensure parsing never depends on column positions.
    fields = list(reversed(sensor))
    return {"fields": fields, "data": [[sensor[field] for field in fields]], "api_key": FAKE_KEY}


def summary(payload):
    return summarize_purpleair(Bounds(**BOX), payload, NOW)


def test_maps_fields_by_name_and_uses_alt_mass_not_aqi():
    result = summary(document())
    assert result["pm25"] == 8.5
    assert result["source"] == "PurpleAir"
    assert result["stations"][0]["confidence"] == 95
    assert result["stations"][0]["time_end"] is None  # No fabricated hourly interval.
    assert "aqi" not in result
    assert FAKE_KEY not in str(result)


@pytest.mark.parametrize("change", [
    {"location_type": 1}, {"private": 1}, {"latitude": 38}, {"longitude": -123},
    {"latitude": None}, {"longitude": float("nan")}, {"sensor_index": False},
])
def test_excludes_indoor_private_invalid_or_outside_box(change):
    result = summary(document(**change))
    assert result["stations"] == []
    assert result["pm25"] is None


@pytest.mark.parametrize("change", [
    {"last_seen": int((NOW - timedelta(hours=2)).timestamp())},
    {"last_seen": int((NOW + timedelta(minutes=5)).timestamp())},
    {"last_seen": None}, {"pm2.5_alt": None}, {"pm2.5_alt": -1},
    {"pm2.5_alt": float("nan")}, {"pm2.5_alt": True},
])
def test_unusable_readings_show_hollow_site_and_do_not_enter_mean(change):
    result = summary(document(**change))
    assert result["station_count"] == 1
    assert result["reporting_count"] == 0
    assert result["pm25"] is None
    assert result["stations"][0]["pm25"] is None
    assert result["stations"][0]["unavailable_reason"]


def test_zero_is_not_missing_and_no_sensor_count_cap():
    payload = document(**{"pm2.5_alt": 0})
    index = payload["fields"].index("sensor_index")
    for number in range(124, 400):
        row = payload["data"][0].copy()
        row[index] = number
        payload["data"].append(row)
    result = summary(payload)
    assert result["reporting_count"] == 277
    assert result["pm25"] == 0


@pytest.mark.parametrize("payload", [
    {}, {"fields": FIELDS.split(","), "data": []},
    {"fields": document()["fields"], "data": [[1]]},
    {"fields": document()["fields"], "data": None},
])
def test_bad_schema_is_not_silently_empty_coverage(payload):
    with pytest.raises(ValueError):
        summary(payload)


def test_empty_network_response_is_valid():
    payload = document()
    payload["data"] = []
    assert summary(payload)["station_count"] == 0


def test_api_key_is_header_only_response_redacted_and_box_cached(monkeypatch):
    monkeypatch.setenv("PURPLE_AIR_API_KEY", FAKE_KEY)
    calls = []

    def handler(request):
        calls.append(request)
        assert request.headers["X-API-Key"] == FAKE_KEY
        assert FAKE_KEY not in str(request.url)
        assert request.url.params["location_type"] == "0"
        assert request.url.params["nwlat"] == str(BOX["north"])
        assert request.url.params["selat"] == str(BOX["south"])
        assert request.url.params["nwlng"] == str(BOX["west"])
        assert request.url.params["selng"] == str(BOX["east"])
        assert request.url.params["fields"] == FIELDS
        return httpx.Response(200, json=document(name="<script>sensor name</script>"))

    with TestClient(app) as client:
        app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        for _ in range(2):
            response = client.post("/api/purpleair", json=BOX)
            assert response.status_code == 200
            assert FAKE_KEY not in response.text
            assert response.json()["stations"][0]["name"] == "<script>sensor name</script>"
        assert len(calls) == 1
        assert FAKE_KEY not in str(app.state.purpleair.cache)
        assert FAKE_KEY not in client.get("/api/map-config").text
        assert client.post("/api/purpleair", json=BOX | {"north": 80}).status_code == 422


def test_missing_key_fails_without_contacting_provider(monkeypatch):
    monkeypatch.delenv("PURPLE_AIR_API_KEY", raising=False)
    with TestClient(app) as client:
        def handler(request):
            pytest.fail("Should not call provider without a key")
        app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        assert client.post("/api/purpleair", json=BOX).status_code == 503


@pytest.mark.parametrize("status", [401, 402, 403, 429, 500])
def test_provider_failures_do_not_leak_credentials_or_fall_back(monkeypatch, status):
    monkeypatch.setenv("PURPLE_AIR_API_KEY", FAKE_KEY)
    with TestClient(app) as client:
        app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(
            lambda request: httpx.Response(status, text=FAKE_KEY),
        ))
        result = client.post("/api/purpleair", json=BOX)
        assert result.status_code in (502, 503)
        assert FAKE_KEY not in result.text
        assert "PurpleAir" in result.json()["detail"]


def test_cached_values_are_rechecked_for_freshness(monkeypatch):
    monkeypatch.setenv("PURPLE_AIR_API_KEY", FAKE_KEY)
    with TestClient(app) as client:
        app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json=document()),
        ))
        assert client.post("/api/purpleair", json=BOX).json()["reporting_count"] == 1
        cache = app.state.purpleair.cache
        key = next(iter(cache))
        expiry, payload, fetched_at = cache[key]
        payload = copy.deepcopy(payload)
        payload["data"][0][payload["fields"].index("last_seen")] = int((NOW - timedelta(hours=2)).timestamp())
        cache[key] = expiry, payload, fetched_at
        result = client.post("/api/purpleair", json=BOX).json()
        assert result["reporting_count"] == 0
        assert result["pm25"] is None
