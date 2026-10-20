"""Synthetic provider fixtures; live readings are checked separately."""
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.air import Bounds
from backend.main import app
from backend.stations import parse_observations, parse_sites, summarize_stations

BOX = {"south": 37.65, "west": -122.6, "north": 37.85, "east": -122.3}
END = datetime(2026, 10, 20, 14, tzinfo=timezone.utc)
HEADER = "StationID|AQSID|FullAQSID|Parameter|MonitorType|SiteCode|SiteName|Status|AgencyID|AgencyName|EPARegion|Latitude|Longitude"


def site(short="060750005", lat=37.7658, lon=-122.3978, **fields):
    data = dict(zip(HEADER.split("|"), [
        short, short, "840" + short, "PM2.5", "Permanent", "0005",
        "Test monitoring site", "Active", "CA2", "Test agency", "R9", str(lat), str(lon),
    ]))
    data.update(fields)
    return "|".join(data.values())


def catalog(*rows):
    return HEADER + "\n" + "\n".join(rows or [site()])


def observation(station="060750005", value="10", when=END - timedelta(hours=1),
                parameter="PM2.5", units="UG/M3"):
    return f"{when:%m/%d/%y}|{when:%H:%M}|{station}|Test site|-8|{parameter}|{units}|{value}|Reporting agency"


def test_catalog_requires_active_pm25_and_valid_coordinates():
    sites = parse_sites(catalog(
        site(), site("000000002", Parameter="O3"), site("000000003", Status="Inactive"),
        site("000000004", lat="NaN"), site("000000005", lon=181),
        site("000000006", lat=0, lon=0),
    ))
    assert list(sites) == ["840060750005"]
    assert sites["840060750005"]["latitude"] == 37.7658
    assert sites["840060750005"]["aliases"] == {"060750005", "840060750005"}


@pytest.mark.parametrize("text", ["<html>maintenance</html>", HEADER, catalog(site(Status="Inactive"))])
def test_invalid_catalog_is_not_an_empty_network(text):
    with pytest.raises(ValueError):
        parse_sites(text)


def test_short_and_full_ids_join_to_one_station_latest_wins():
    sites = parse_sites(catalog())
    rows = [
        observation(value="10", when=END - timedelta(hours=2)),
        observation(station="840060750005", value="20"),
        observation(value="15", when=END - timedelta(hours=3)),
    ]
    obs = parse_observations("\n".join(rows), sites, END - timedelta(hours=3), END)
    assert list(obs) == ["840060750005"]
    assert obs["840060750005"]["pm25"] == 20
    assert obs["840060750005"]["time_end"] == END.isoformat()
    assert obs["840060750005"]["agency"] == "Reporting agency"


@pytest.mark.parametrize("changes", [
    {"value": "-1"}, {"value": "NaN"}, {"value": "inf"}, {"value": ""},
    {"station": "unknown"}, {"parameter": "PM10"}, {"units": "PPB"},
    {"when": END}, {"when": END - timedelta(hours=4)},
])
def test_unusable_observations_are_excluded(changes):
    assert parse_observations(observation(**changes), parse_sites(catalog()),
                              END - timedelta(hours=3), END) == {}


def test_zero_is_a_valid_measurement():
    obs = parse_observations(observation(value="0"), parse_sites(catalog()),
                             END - timedelta(hours=3), END)
    assert obs["840060750005"]["pm25"] == 0


def test_ambiguous_international_short_id_does_not_join_to_wrong_country():
    sites = parse_sites(catalog(
        site("000000001", StationID="100000000001", FullAQSID="100000000001"),
        site("000000001", StationID="200000000001", FullAQSID="200000000001"),
    ))
    rows = observation(station="000000001") + "\n" + observation(station="100000000001")
    obs = parse_observations(rows, sites, END - timedelta(hours=3), END)
    assert list(obs) == ["100000000001"]


def test_bbox_filters_real_sites_no_nine_site_cap_or_fabricated_points():
    sites = parse_sites(catalog(
        *[site(f"06075{i:04}", lat=37.7 + i * .001) for i in range(12)],
        site("000000099", lat=38.5),
    ))
    obs = parse_observations("\n".join(observation(station=f"06075{i:04}", value=str(i))
                                      for i in range(10)),
                             sites, END - timedelta(hours=3), END)
    result = summarize_stations(Bounds(**BOX), sites, obs, END, 3)
    assert result["station_count"] == 12
    assert result["reporting_count"] == 10
    assert result["pm25"] == 4.5
    assert len([s for s in result["stations"] if s["pm25"] is None]) == 2
    assert all("aliases" not in s for s in result["stations"])
    assert "aqi" not in result


def test_empty_box_returns_no_measurement_not_zero():
    result = summarize_stations(Bounds(**BOX), parse_sites(catalog(site(lat=39))), {}, END, 3)
    assert result["stations"] == []
    assert result["pm25"] is None
    assert result["time_start"] is None
    assert result["reporting_count"] == 0


def handler_for(calls, missing_hour=False, fail=False):
    def handler(request):
        calls.append(str(request.url))
        if request.url.path.endswith("Monitoring_Site_Locations_V2.dat"):
            return httpx.Response(200, text=catalog())
        if fail:
            return httpx.Response(503)
        date = datetime.strptime(request.url.path.split("_")[-1].split(".")[0], "%Y%m%d%H").replace(tzinfo=timezone.utc)
        newest = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)
        if missing_hour and date == newest:
            return httpx.Response(404)
        return httpx.Response(200, text=observation(when=date))
    return handler


def test_station_api_reuses_downloads_across_boxes_and_reports_missing_hour():
    calls = []
    with TestClient(app) as client:
        app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler_for(calls, missing_hour=True)))
        result = client.post("/api/stations", json=BOX)
        assert result.status_code == 200
        data = result.json()
        assert data["source"] == "AirNow"
        assert data["hours_available"] == 2
        assert data["station_count"] == data["reporting_count"] == 1
        assert data["pm25"] == 10
        empty = client.post("/api/stations", json=BOX | {"south": 37.8, "north": 37.9})
        assert empty.json()["stations"] == []
        assert len(calls) == 4  # One catalog, three hourly files, shared across areas.
        assert client.post("/api/stations", json=BOX | {"north": 80}).status_code == 422


def test_station_api_provider_failure_is_not_empty_success_or_model_fallback():
    calls = []
    with TestClient(app) as client:
        app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler_for(calls, fail=True)))
        result = client.post("/api/stations", json=BOX)
        assert result.status_code == 502
        assert "AirNow" in result.json()["detail"]
        assert all("airnowtech.org" in url for url in calls)


def test_expired_observations_are_not_returned_after_upstream_failure():
    calls = []
    with TestClient(app) as client:
        mock = httpx.MockTransport(handler_for(calls))
        app.state.client = httpx.AsyncClient(transport=mock)
        assert client.post("/api/stations", json=BOX).status_code == 200
        app.state.airnow.observations_until = 0
        app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler_for(calls, fail=True)))
        assert client.post("/api/stations", json=BOX).status_code == 502
