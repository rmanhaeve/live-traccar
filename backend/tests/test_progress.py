from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from backend.services.progress import ProgressService
from backend.services.route import RouteService


def write_gpx(tmp_path: Path) -> Path:
    gpx = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test">
  <trk><name>Test</name><trkseg>
    <trkpt lat="0.0" lon="0.0"></trkpt>
    <trkpt lat="0.0" lon="0.01"></trkpt>
  </trkseg></trk>
</gpx>"""
    path = tmp_path / "route.gpx"
    path.write_text(gpx, encoding="utf-8")
    return path


def make_history() -> list[dict]:
    now = datetime.now(tz=timezone.utc)
    t0 = int((now - timedelta(minutes=10)).timestamp() * 1000)
    t1 = int((now - timedelta(minutes=5)).timestamp() * 1000)
    return [
        {"t": t0, "lat": 0.0, "lng": 0.0},
        {"t": t1, "lat": 0.0, "lng": 0.01},
    ]


def test_compute_eta(tmp_path: Path) -> None:
    route = RouteService(write_gpx(tmp_path))
    progress_service = ProgressService(route)
    history = make_history()
    position = {"latitude": 0.0, "longitude": 0.005}
    progress = progress_service.compute_progress(position, None, history)
    assert progress is not None
    now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    eta = progress_service.compute_eta(progress, route.load().total, history, None, now_ms)
    assert eta["status"] in {"eta", "passed", "unknown"}


def test_offtrack_eta(tmp_path: Path) -> None:
    route = RouteService(write_gpx(tmp_path))
    progress_service = ProgressService(route)
    history = make_history()
    position = {"latitude": 10.0, "longitude": 10.0}
    progress = progress_service.compute_progress(position, None, history)
    eta = progress_service.compute_eta(progress, route.load().total, history, None, int(datetime.now(tz=timezone.utc).timestamp() * 1000))
    assert eta["status"] == "offtrack"
