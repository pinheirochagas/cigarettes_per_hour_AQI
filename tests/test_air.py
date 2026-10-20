import copy
import math

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.air import Bounds, cigarette_equivalent, sample_points, summarize
from backend.main import app


BOX = {"south": 37.65, "west": -122.6, "north": 37.85, "east": -122.3}


def documents():
    return [
        {
            "latitude": 37.8, "longitude": -122.4,
            "current": {"time": "2026-10-20T12:00", "pm2_5": v, "us_aqi_pm2_5": v * 2},
            "hourly": {"time": ["2026-10-20T12:00", "2026-10-20T13:00"], "pm2_5": [v, v + 1]},
        } for v in range(18, 27)
    ]


def test_known_berkeley_comparison_and_duration():
    assert cigarette_equivalent(22, 24) == 1
    assert cigarette_equivalent(22, 1) == pytest.approx(1 / 24)
    assert cigarette_equivalent(22, 24, 3) == 3
    assert cigarette_equivalent(0, 24) == 0


def test_samples_are_inside_box_and_equal_area():
    b = Bounds(**BOX)
    points = sample_points(b)
    assert len(points) == len(set(points)) == 9
    assert all(b.south < lat < b.north and b.west < lon < b.east for lat, lon in points)
    latitudes = sorted(set(math.sin(math.radians(lat)) for lat, _ in points))
    # Five-decimal API coordinates introduce a maximum ~1 m rounding error.
    assert latitudes[1] - latitudes[0] == pytest.approx(latitudes[2] - latitudes[1], abs=4e-7)
    assert points[0][0] > points[-1][0]  # IDs run north to south.
    assert points[0][1] < points[2][1]  # IDs run west to east.


@pytest.mark.parametrize("change", [
    {"north": 37.65}, {"east": -123}, {"south": -90}, {"east": 181},
    {"north": 45}, {"south": float("nan")}, {"north": float("inf")},
    {"north": 37.651}, {"west": 179, "east": -179},
])
def test_invalid_boxes(change):
    with pytest.raises(ValidationError):
        Bounds(**(BOX | change))


def test_summary_uses_concentration_and_reports_repeated_cells():
    result = summarize(Bounds(**BOX), documents())
    assert result["pm25"] == 22
    assert result["pm25_min"] == 18
    assert result["pm25_max"] == 26
    assert result["cigarettes_per_hour"] == pytest.approx(1 / 24)
    assert result["sample_count"] == 9
    assert result["grid_cells"] == 1
    assert result["hourly"][1]["pm25"] == 23
    assert not result["partial"]


def test_missing_and_negative_are_not_treated_as_clean_air():
    docs = documents()
    for i, v in enumerate([None, -1, float("nan")]):
        docs[i]["current"]["pm2_5"] = v
    result = summarize(Bounds(**BOX), docs)
    assert result["sample_count"] == 6
    assert result["pm25"] == 23.5
    assert result["partial"]
    for doc in docs:
        doc["current"]["pm2_5"] = None
    with pytest.raises(ValueError):
        summarize(Bounds(**BOX), docs)


def test_different_model_hours_not_mixed():
    docs = documents()
    docs[0]["current"]["time"] = "2026-10-20T11:00"
    result = summarize(Bounds(**BOX), docs)
    assert result["sample_count"] == 8
    assert result["samples"][0]["pm25"] is None
    assert result["time"] == "2026-10-20T12:00Z"


def test_incomplete_grid_rejected():
    with pytest.raises(ValueError):
        summarize(Bounds(**BOX), documents()[:4])


def test_api_caches_and_keeps_search_results_plain_text():
    calls = []

    def handler(request):
        calls.append(request)
        if request.url.path == "/v1/search":
            return httpx.Response(200, json={"results": [{
                "id": 1, "name": "<script>test</script>", "admin1": "California",
                "country": "United States", "latitude": 37.77, "longitude": -122.42,
            }]})
        assert len(request.url.params["latitude"].split(",")) == 9
        return httpx.Response(200, json=documents())

    with TestClient(app) as client:
        app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        assert client.get("/api/health").json() == {"status": "ok"}
        for _ in range(2):
            r = client.post("/api/air-quality", json=BOX)
            assert r.status_code == 200
            assert r.json()["pm25"] == 22
        assert len(calls) == 1
        assert [s["id"] for s in r.json()["samples"]] == list(range(1, 10))
        assert [s["latitude"] for s in r.json()["samples"]] == [
            float(x) for x in calls[0].url.params["latitude"].split(",")
        ]
        assert [s["longitude"] for s in r.json()["samples"]] == [
            float(x) for x in calls[0].url.params["longitude"].split(",")
        ]
        assert client.get("/api/search?q=San").json()["results"][0]["name"] == "<script>test</script>"
        assert client.post("/api/air-quality", json=BOX | {"north": 80}).status_code == 422
        assert client.get("/api/search?q= ").status_code == 422
        assert r.headers["permissions-policy"] == "geolocation=(self), camera=(), microphone=()"


@pytest.mark.parametrize("kind", ["timeout", "rate_limit", "bad_json", "missing"])
def test_provider_errors_are_recoverable(kind):
    def handler(request):
        if kind == "timeout":
            raise httpx.ReadTimeout("upstream timeout")
        if kind == "rate_limit":
            return httpx.Response(429, text="rate limited")
        if kind == "bad_json":
            return httpx.Response(200, text="not json")
        docs = copy.deepcopy(documents())
        for doc in docs:
            doc["current"]["pm2_5"] = None
        return httpx.Response(200, json=docs)

    with TestClient(app) as client:
        app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        result = client.post("/api/air-quality", json=BOX)
        assert result.status_code == 502
        assert isinstance(result.json()["detail"], str)


@pytest.mark.parametrize("token,status", [("", 503), ("sk.do-not-expose", 503), ("pk.browser-token", 200)])
def test_map_config_only_exposes_public_tokens(monkeypatch, token, status):
    monkeypatch.setenv("MAPBOX_TOKEN", token)
    with TestClient(app) as client:
        result = client.get("/api/map-config")
        assert result.status_code == status
        if status == 200:
            assert result.json() == {"mapbox_token": token, "style": "mapbox/light-v11"}
        else:
            assert "sk.do-not-expose" not in result.text
            assert "mapbox_token" not in result.json()
