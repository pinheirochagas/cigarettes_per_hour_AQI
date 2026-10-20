from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.fires import FireViewport, group_hotspots, parse_hotspots, parse_incidents, parse_global_incidents
from backend.main import app

NOW = datetime.now(timezone.utc)
VIEW = {"south": 30, "north": 50, "west": -130, "east": -110, "zoom": 5}
HEADER = "latitude,longitude,acq_date,acq_time,confidence,frp\n"


def row(lat=38, lon=-120, when=None, confidence="nominal", frp=5):
    when = when or NOW - timedelta(hours=1)
    return f"{lat},{lon},{when:%Y-%m-%d},{when:%H%M},{confidence},{frp}\n"


def incident(**changes):
    attributes = {
        "OBJECTID": 1, "IncidentName": "Test wildfire", "IncidentSize": 120,
        "PercentContained": 0, "ActiveFireCandidate": 1, "IncidentTypeCategory": "WF",
        "FireOutDateTime": None, "ModifiedOnDateTime_dt": NOW.timestamp() * 1000,
        "FireDiscoveryDateTime": (NOW - timedelta(hours=1)).timestamp() * 1000,
    }
    attributes.update(changes)
    return {"attributes": attributes, "geometry": {"x": -120, "y": 38}}


def global_incident(**changes):
    properties = {
        "eventtype": "WF", "eventid": 123, "name": "Forest fires in Brazil",
        "iscurrent": "true", "iso3": "BRA", "affectedcountries": [{"iso3": "BRA"}],
        "todate": (NOW - timedelta(hours=1)).isoformat(),
        "fromdate": (NOW - timedelta(days=30)).isoformat(),
        "datemodified": NOW.isoformat(),
        "severitydata": {"severity": 6000, "severityunit": "ha"},
    }
    properties.update(changes)
    return {"type": "Feature", "properties": properties,
            "geometry": {"type": "Point", "coordinates": [-50, -10]}}


def test_international_event_has_attribution_burned_area_and_distinct_id():
    parsed = parse_global_incidents([global_incident()], NOW)[0]
    assert parsed["source"] == "GDACS"
    assert parsed["source_url"] == "https://www.gdacs.org/report.aspx?eventtype=WF&eventid=123"
    assert parsed["id"] == "gdacs:123"
    assert parsed["hectares"] == 6000
    assert parsed["acres"] is None
    assert parsed["contained"] is None
    assert parsed["latitude"] == -10
    assert parsed["longitude"] == -50


@pytest.mark.parametrize("change", [
    {"iscurrent": "false"}, {"iscurrent": False}, {"iscurrent": None},
    {"eventtype": "FL"}, {"todate": None}, {"todate": "invalid"},
    {"todate": (NOW - timedelta(days=365)).isoformat()},
    {"todate": (NOW + timedelta(hours=1)).isoformat()},
    {"iso3": "USA"}, {"iso3": None}, {"affectedcountries": [{"iso3": "USA"}]},
    {"eventid": None}, {"eventid": "<script>"},
])
def test_global_filters_exclude_old_closed_invalid_and_us_events(change):
    assert parse_global_incidents([global_incident(**change)], NOW) == []


@pytest.mark.parametrize("geometry", [
    {"type": "Polygon", "coordinates": [[[-50, -10]]]},
    {"type": "Point", "coordinates": [190, -10]},
    {"type": "Point", "coordinates": [float("nan"), -10]},
    {"type": "Point", "coordinates": []},
])
def test_global_invalid_coordinates_are_excluded(geometry):
    feature = global_incident()
    feature["geometry"] = geometry
    assert parse_global_incidents([feature], NOW) == []


def test_global_daily_dates_and_rolling_boundary():
    midnight = NOW.replace(hour=0, minute=0, second=0, microsecond=0)
    feature = global_incident(todate=midnight.replace(tzinfo=None).isoformat())
    parsed = parse_global_incidents([feature], midnight + timedelta(hours=24))
    assert parsed[0]["activity_at"] == midnight.isoformat()
    assert parsed[0]["activity_precision"] == "day"
    assert parse_global_incidents([feature], midnight + timedelta(hours=24, seconds=1)) == []


def test_global_duplicate_events_keep_latest_activity_and_missing_area_stays_missing():
    old = global_incident(todate=(NOW - timedelta(hours=2)).isoformat())
    latest = global_incident(severitydata={"severity": None, "severityunit": "ha"})
    parsed = parse_global_incidents([latest, old, latest], NOW)
    assert len(parsed) == 1
    assert parsed[0]["activity_at"] == latest["properties"]["todate"]
    assert parsed[0]["hectares"] is None


def test_satellite_filter_excludes_old_future_low_confidence_and_bad_coords():
    rows = [
        row(), row(), row(confidence="high", lat=39),
        row(when=NOW - timedelta(hours=25)), row(when=NOW + timedelta(hours=1)),
        row(confidence="low"), row(lat="NaN"), row(lon=190),
    ]
    parsed = parse_hotspots(HEADER + "".join(rows), NOW)
    assert len(parsed) == 2  # Duplicate observations removed.
    assert {p["confidence"] for p in parsed} == {"nominal", "high"}


@pytest.mark.parametrize("text", ["<html>unavailable</html>", HEADER, HEADER + row(when=NOW - timedelta(days=2))])
def test_stale_or_malformed_global_feed_not_reported_as_no_fires(text):
    with pytest.raises(ValueError):
        parse_hotspots(text, NOW)


@pytest.mark.parametrize("change", [
    {"IncidentTypeCategory": "RX"}, {"ActiveFireCandidate": 0},
    {"FireOutDateTime": NOW.timestamp() * 1000},
    {"ControlDateTime": NOW.timestamp() * 1000},
    {"PercentContained": 100},
])
def test_only_reported_active_wildfires_are_included(change):
    assert parse_incidents([incident(**change)], NOW) == []


def test_containment_zero_and_unreported_are_preserved():
    parsed = parse_incidents([incident()], NOW)
    assert parsed[0]["contained"] == 0
    assert parsed[0]["acres"] == 120
    assert parsed[0]["updated_at"] == NOW.isoformat()
    parsed = parse_incidents([incident(IncidentSize=None, PercentContained=None)], NOW)
    assert parsed[0]["contained"] is None
    assert parsed[0]["acres"] is None


@pytest.mark.parametrize("discovered", [None, NOW - timedelta(days=365), NOW + timedelta(hours=1)])
def test_recent_database_edits_do_not_make_old_or_undated_fires_current(discovered):
    feature = incident(FireDiscoveryDateTime=discovered.timestamp() * 1000 if discovered else None)
    assert parse_incidents([feature], NOW) == []


def test_recent_report_can_qualify_an_ongoing_fire_discovered_last_year():
    feature = incident(
        FireDiscoveryDateTime=(NOW - timedelta(days=365)).timestamp() * 1000,
        ICS209ReportForTimePeriodTo=(NOW - timedelta(hours=2)).timestamp() * 1000,
    )
    parsed = parse_incidents([feature], NOW)
    assert len(parsed) == 1
    assert parsed[0]["activity_basis"] == "reporting period"
    assert datetime.fromisoformat(parsed[0]["activity_at"]) == NOW - timedelta(hours=2)


def test_recent_submission_of_old_reporting_period_is_excluded():
    feature = incident(
        FireDiscoveryDateTime=(NOW - timedelta(days=365)).timestamp() * 1000,
        ICS209ReportForTimePeriodTo=(NOW - timedelta(days=2)).timestamp() * 1000,
        ICS209ReportDateTime=NOW.timestamp() * 1000,
    )
    assert parse_incidents([feature], NOW) == []


def test_report_date_used_when_reporting_period_missing():
    parsed = parse_incidents([incident(
        FireDiscoveryDateTime=None, ICS209ReportDateTime=NOW.timestamp() * 1000,
    )], NOW)
    assert parsed[0]["activity_basis"] == "incident report"


def test_exact_24_hour_boundary():
    feature = incident(FireDiscoveryDateTime=(NOW - timedelta(hours=24)).timestamp() * 1000)
    assert len(parse_incidents([feature], NOW)) == 1
    assert parse_incidents([feature], NOW + timedelta(seconds=1)) == []


def test_clusters_preserve_detection_counts_and_split_on_zoom():
    parsed = parse_hotspots(HEADER + row() + row(lat=38.01, lon=-120.01), NOW)
    groups, count = group_hotspots(parsed, FireViewport(**VIEW), NOW)
    assert count == 2
    assert sum(g["count"] for g in groups) == 2
    assert len(groups) == 1
    groups, count = group_hotspots(parsed, FireViewport(**(VIEW | {"zoom": 17})), NOW)
    assert len(groups) == count == 2
    _, count = group_hotspots(parsed, FireViewport(**VIEW), NOW + timedelta(days=2))
    assert count == 0  # Cache hits recheck the rolling time window.


def test_viewport_crosses_date_line_without_including_rest_of_world():
    view = FireViewport(south=-10, north=10, west=170, east=-170, zoom=3)
    assert view.contains(0, 179)
    assert view.contains(0, -179)
    assert not view.contains(0, 0)
    assert not view.contains(30, 179)


@pytest.mark.parametrize("change", [
    {"north": 90}, {"east": 200}, {"zoom": 1}, {"south": 50}, {"west": -110},
])
def test_fire_viewport_validation(change):
    with pytest.raises(ValidationError):
        FireViewport(**(VIEW | change))


def test_fire_api_downloads_shared_between_viewports_and_handles_nifc_pagination():
    calls = []

    def handler(request):
        calls.append(request)
        if "gdacs.org" in request.url.host:
            return httpx.Response(200, json={"type": "FeatureCollection", "features": [global_incident()]})
        if "nasa.gov" in request.url.host:
            return httpx.Response(200, text=HEADER + row())
        assert request.url.params["outSR"] == "4326"
        assert "FireOutDateTime IS NULL" in request.url.params["where"]
        offset = request.url.params["resultOffset"]
        return httpx.Response(200, json={
            "features": [incident(OBJECTID=1 if offset == "0" else 2)],
            "exceededTransferLimit": offset == "0",
        })

    with TestClient(app) as client:
        app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        response = client.post("/api/fires", json=VIEW)
        assert response.status_code == 200
        assert response.json()["detection_count"] == 1
        assert len(response.json()["incidents"]) == 2
        assert response.json()["unavailable"] == []
        empty = client.post("/api/fires", json=VIEW | {"west": 10, "east": 20})
        assert empty.json()["detection_count"] == 0
        assert empty.json()["incidents"] == []
        assert len(calls) == 4
        # Cached incidents must age out even before the next download.
        app.state.fires.incidents[0]["activity_at"] = (NOW - timedelta(days=2)).isoformat()
        refreshed = client.post("/api/fires", json=VIEW)
        assert len(refreshed.json()["incidents"]) == 1
        assert len(calls) == 4
        brazil = client.post("/api/fires", json=VIEW | {"south": -20, "north": 0, "west": -60, "east": -40})
        assert len(brazil.json()["incidents"]) == 1
        assert brazil.json()["incidents"][0]["source"] == "GDACS"
        app.state.fires.incidents[-1]["activity_at"] = (NOW - timedelta(days=2)).isoformat()
        assert client.post("/api/fires", json=VIEW | {"south": -20, "north": 0, "west": -60, "east": -40}).json()["incidents"] == []
        assert len(calls) == 4


@pytest.mark.parametrize("failed", [
    {"NASA FIRMS"}, {"NIFC"}, {"GDACS"}, {"NASA FIRMS", "NIFC"},
    {"NASA FIRMS", "GDACS"}, {"NIFC", "GDACS"}, {"NASA FIRMS", "NIFC", "GDACS"},
])
def test_partial_feed_failure_is_explicit_and_total_failure_is_error(failed):
    def handler(request):
        source = "NASA FIRMS" if "nasa.gov" in request.url.host else "GDACS" if "gdacs.org" in request.url.host else "NIFC"
        if source in failed:
            return httpx.Response(503)
        return httpx.Response(200, text=HEADER + row()) if source == "NASA FIRMS" else httpx.Response(200, json={"type": "FeatureCollection", "features": []})

    with TestClient(app) as client:
        app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        response = client.post("/api/fires", json=VIEW)
        if len(failed) == 3:
            assert response.status_code == 502
        else:
            assert response.status_code == 200
            assert set(response.json()["unavailable"]) == failed


def test_gdacs_pagination_includes_more_than_100_events_and_all_alert_levels():
    pages = []

    def handler(request):
        if "nasa.gov" in request.url.host:
            return httpx.Response(200, text=HEADER + row())
        if "gdacs.org" not in request.url.host:
            return httpx.Response(200, json={"features": []})
        assert request.url.params["alertlevel"] == "Green,Orange,Red"
        assert "fromDate" not in request.url.params
        page = int(request.url.params["pageNumber"])
        pages.append(page)
        features = [global_incident(eventid=i) for i in range(1, 101)] if page == 1 else [global_incident(eventid=101)]
        return httpx.Response(200, json={"type": "FeatureCollection", "features": features})

    with TestClient(app) as client:
        app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        response = client.post("/api/fires", json=VIEW | {"south": -20, "north": 0, "west": -60, "east": -40})
        assert response.status_code == 200
        assert len(response.json()["incidents"]) == 101
        assert response.json()["unavailable"] == []
        assert pages == [1, 2]


def test_malformed_global_feed_is_unavailable_not_zero_events():
    def handler(request):
        if "nasa.gov" in request.url.host:
            return httpx.Response(200, text=HEADER + row())
        if "gdacs.org" in request.url.host:
            return httpx.Response(200, text="")
        return httpx.Response(200, json={"features": []})

    with TestClient(app) as client:
        app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        response = client.post("/api/fires", json=VIEW)
        assert response.status_code == 200
        assert response.json()["unavailable"] == ["GDACS"]
