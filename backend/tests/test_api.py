from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from backend.config import Settings
from backend.main import create_app


def write_gpx(tmp_path: Path) -> Path:
    gpx = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test">
  <trk><name>Test</name><trkseg>
    <trkpt lat="0.0" lon="0.0"></trkpt>
    <trkpt lat="0.0" lon="0.01"></trkpt>
  </trkseg></trk>
  <wpt lat="0.0" lon="0.0"><name>Start</name></wpt>
</gpx>"""
    path = tmp_path / "route.gpx"
    path.write_text(gpx, encoding="utf-8")
    return path


def write_gpx_no_waypoints(tmp_path: Path) -> Path:
    gpx = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test">
  <trk><name>Test</name><trkseg>
    <trkpt lat="0.0" lon="0.0"></trkpt>
    <trkpt lat="0.0" lon="0.01"></trkpt>
  </trkseg></trk>
</gpx>"""
    path = tmp_path / "route-no-wp.gpx"
    path.write_text(gpx, encoding="utf-8")
    return path


def write_gpx_invalid(tmp_path: Path) -> Path:
    path = tmp_path / "invalid.gpx"
    path.write_text("not xml", encoding="utf-8")
    return path


def build_app(tmp_path: Path, weather_enabled: bool = False) -> TestClient:
    settings = Settings(
        traccar_url="https://example.com",
        traccar_token="token",
        track_file=str(write_gpx(tmp_path)),
        translation_file="frontend/translations/en.json",
        weather_enabled=weather_enabled,
        refresh_seconds=0,
    )
    app = create_app(settings, use_config_file=False)
    state = app.state.app_state

    async def fetch_devices():
        return [{"id": 1, "name": "Alpha"}]

    async def fetch_positions():
        now = datetime.now(tz=timezone.utc).isoformat()
        return [{"deviceId": 1, "latitude": 0.0, "longitude": 0.0, "deviceTime": now}]

    async def fetch_route_report(device_id, from_dt, to_dt):
        t0 = (datetime.now(tz=timezone.utc) - timedelta(minutes=10)).isoformat()
        return [{"deviceId": device_id, "latitude": 0.0, "longitude": 0.0, "deviceTime": t0}]

    state.traccar.fetch_devices = fetch_devices
    state.traccar.fetch_positions = fetch_positions
    state.traccar.fetch_route_report = fetch_route_report

    return TestClient(app)


def test_config_endpoint(tmp_path: Path) -> None:
    client = build_app(tmp_path)
    res = client.get("/api/config")
    assert res.status_code == 200
    body = res.json()
    assert "title" in body
    assert "trackFile" in body


def test_route_endpoint(tmp_path: Path) -> None:
    client = build_app(tmp_path)
    res = client.get("/api/route")
    assert res.status_code == 200
    body = res.json()
    assert body["segments"]
    assert body["waypoints"]
    assert body["elevationProfile"]["totals"] is not None


def test_participants_flow(tmp_path: Path) -> None:
    client = build_app(tmp_path)
    res = client.get("/api/participants")
    assert res.status_code == 200
    body = res.json()
    assert body["participants"]
    participant_id = body["participants"][0]["id"]

    res = client.get(f"/api/participants/{participant_id}/waypoints")
    assert res.status_code == 200
    assert res.json()["waypoints"]

    res = client.get(f"/api/participants/{participant_id}/history")
    assert res.status_code == 200
    assert "kmEvents" in res.json()

    res = client.get(f"/api/participants/{participant_id}/eta", params={"lat": 0.0, "lng": 0.0})
    assert res.status_code == 200
    assert "eta" in res.json()


def test_weather_disabled(tmp_path: Path) -> None:
    client = build_app(tmp_path, weather_enabled=False)
    res = client.get("/api/weather")
    assert res.status_code == 404


def test_weather_enabled(tmp_path: Path) -> None:
    client = build_app(tmp_path, weather_enabled=True)
    app = client.app
    state = app.state.app_state

    async def fake_weather(_coord):
        return {"summary": {"temp": 10, "wind": 3, "precip": 0}, "rows": []}

    state.weather.fetch_weather_series = fake_weather
    res = client.get("/api/weather")
    assert res.status_code == 200
    assert res.json()["summary"]["temp"] == 10


def test_weather_failure(tmp_path: Path) -> None:
    client = build_app(tmp_path, weather_enabled=True)
    app = client.app
    state = app.state.app_state

    async def fail_weather(_coord):
        raise RuntimeError("boom")

    state.weather.fetch_weather_series = fail_weather
    res = client.get("/api/weather")
    assert res.status_code == 502


def test_participants_stale(tmp_path: Path) -> None:
    settings = Settings(
        traccar_url="https://example.com",
        traccar_token="token",
        track_file=str(write_gpx(tmp_path)),
        translation_file="frontend/translations/en.json",
        weather_enabled=False,
        refresh_seconds=0,
        stale_minutes=1,
    )
    app = create_app(settings, use_config_file=False)
    state = app.state.app_state

    async def fetch_devices():
        return [{"id": 1, "name": "Alpha"}]

    async def fetch_positions():
        past = (datetime.now(tz=timezone.utc) - timedelta(minutes=5)).isoformat()
        return [{"deviceId": 1, "latitude": 0.0, "longitude": 0.0, "deviceTime": past}]

    async def fetch_route_report(device_id, from_dt, to_dt):
        return []

    state.traccar.fetch_devices = fetch_devices
    state.traccar.fetch_positions = fetch_positions
    state.traccar.fetch_route_report = fetch_route_report

    client = TestClient(app)
    res = client.get("/api/participants")
    assert res.status_code == 200
    participant = res.json()["participants"][0]
    assert participant["isStale"] is True


def test_eta_offroute_point(tmp_path: Path) -> None:
    client = build_app(tmp_path)
    res = client.get("/api/participants")
    participant_id = res.json()["participants"][0]["id"]
    res = client.get(f"/api/participants/{participant_id}/eta", params={"lat": 10.0, "lng": 10.0})
    assert res.status_code == 200
    body = res.json()
    assert body["snapped"]["offtrack"] is True
    assert body["eta"] is None


def test_participants_empty(tmp_path: Path) -> None:
    settings = Settings(
        traccar_url="https://example.com",
        traccar_token="token",
        track_file=str(write_gpx(tmp_path)),
        translation_file="frontend/translations/en.json",
        weather_enabled=False,
        refresh_seconds=0,
    )
    app = create_app(settings, use_config_file=False)
    state = app.state.app_state

    async def fetch_devices():
        return []

    async def fetch_positions():
        return []

    async def fetch_route_report(device_id, from_dt, to_dt):
        return []

    state.traccar.fetch_devices = fetch_devices
    state.traccar.fetch_positions = fetch_positions
    state.traccar.fetch_route_report = fetch_route_report

    client = TestClient(app)
    res = client.get("/api/participants")
    assert res.status_code == 200
    assert res.json()["participants"] == []


def test_route_missing_returns_error(tmp_path: Path) -> None:
    settings = Settings(
        traccar_url="https://example.com",
        traccar_token="token",
        track_file=str(tmp_path / "missing.gpx"),
        translation_file="frontend/translations/en.json",
        weather_enabled=False,
        refresh_seconds=0,
    )
    app = create_app(settings, use_config_file=False)
    client = TestClient(app)
    res = client.get("/api/route")
    assert res.status_code == 404


def test_route_invalid_returns_error(tmp_path: Path) -> None:
    settings = Settings(
        traccar_url="https://example.com",
        traccar_token="token",
        track_file=str(write_gpx_invalid(tmp_path)),
        translation_file="frontend/translations/en.json",
        weather_enabled=False,
        refresh_seconds=0,
    )
    app = create_app(settings, use_config_file=False)
    client = TestClient(app)
    res = client.get("/api/route")
    assert res.status_code == 500


def test_route_no_waypoints_adds_endpoints(tmp_path: Path) -> None:
    settings = Settings(
        traccar_url="https://example.com",
        traccar_token="token",
        track_file=str(write_gpx_no_waypoints(tmp_path)),
        translation_file="frontend/translations/en.json",
        weather_enabled=False,
        refresh_seconds=0,
    )
    app = create_app(settings, use_config_file=False)
    client = TestClient(app)
    res = client.get("/api/route")
    assert res.status_code == 200
    waypoints = res.json()["waypoints"]
    names = {wp["name"] for wp in waypoints}
    assert {"Start", "Finish"}.issubset(names)


def test_waypoint_eta_without_position(tmp_path: Path) -> None:
    settings = Settings(
        traccar_url="https://example.com",
        traccar_token="token",
        track_file=str(write_gpx(tmp_path)),
        translation_file="frontend/translations/en.json",
        weather_enabled=False,
        refresh_seconds=0,
    )
    app = create_app(settings, use_config_file=False)
    state = app.state.app_state

    async def fetch_devices():
        return [{"id": 1, "name": "Alpha"}]

    async def fetch_positions():
        return []

    async def fetch_route_report(device_id, from_dt, to_dt):
        return []

    state.traccar.fetch_devices = fetch_devices
    state.traccar.fetch_positions = fetch_positions
    state.traccar.fetch_route_report = fetch_route_report

    client = TestClient(app)
    res = client.get("/api/participants/1/waypoints")
    assert res.status_code == 200
    waypoints = res.json()["waypoints"]
    assert waypoints
    assert waypoints[0]["eta"]["status"] == "offtrack"


def test_history_without_data(tmp_path: Path) -> None:
    settings = Settings(
        traccar_url="https://example.com",
        traccar_token="token",
        track_file=str(write_gpx(tmp_path)),
        translation_file="frontend/translations/en.json",
        weather_enabled=False,
        refresh_seconds=0,
    )
    app = create_app(settings, use_config_file=False)
    state = app.state.app_state

    async def fetch_devices():
        return [{"id": 1, "name": "Alpha"}]

    async def fetch_positions():
        return []

    async def fetch_route_report(device_id, from_dt, to_dt):
        return []

    state.traccar.fetch_devices = fetch_devices
    state.traccar.fetch_positions = fetch_positions
    state.traccar.fetch_route_report = fetch_route_report

    client = TestClient(app)
    res = client.get("/api/participants/1/history")
    assert res.status_code == 200
    body = res.json()
    assert body["kmEvents"] == []
    assert body["waypointEvents"] == []


def test_debug_participants(tmp_path: Path) -> None:
    settings = Settings(
        traccar_url="https://example.com",
        traccar_token="token",
        track_file=str(write_gpx(tmp_path)),
        translation_file="frontend/translations/en.json",
        weather_enabled=False,
        refresh_seconds=0,
        debug=True,
    )
    app = create_app(settings, use_config_file=False)
    client = TestClient(app)
    res = client.get("/api/participants")
    assert res.status_code == 200
    participants = res.json()["participants"]
    assert participants
    assert participants[0]["name"].startswith("Debug Participant")
