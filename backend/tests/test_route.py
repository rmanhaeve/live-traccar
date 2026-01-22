from __future__ import annotations

from pathlib import Path

import pytest

from backend.services.route import RouteService


def write_gpx(tmp_path: Path) -> Path:
    gpx = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test">
  <trk><name>Test</name><trkseg>
    <trkpt lat="0.0" lon="0.0"><ele>10</ele></trkpt>
    <trkpt lat="0.0" lon="0.01"><ele>20</ele></trkpt>
    <trkpt lat="0.01" lon="0.01"><ele>30</ele></trkpt>
  </trkseg></trk>
  <wpt lat="0.0" lon="0.0"><name>Start</name></wpt>
</gpx>"""
    path = tmp_path / "route.gpx"
    path.write_text(gpx, encoding="utf-8")
    return path


def test_route_profile(tmp_path: Path) -> None:
    route = RouteService(write_gpx(tmp_path))
    profile = route.load()
    assert profile.total > 0
    assert len(profile.segments) == 1
    assert profile.waypoints
    assert profile.avg_lat != 0


def test_point_at_distance(tmp_path: Path) -> None:
    route = RouteService(write_gpx(tmp_path))
    profile = route.load()
    pt0 = route.point_at_distance(0)
    assert pytest.approx(pt0["lat"], abs=1e-6) == 0.0
    assert pytest.approx(pt0["lng"], abs=1e-6) == 0.0
    mid = route.point_at_distance(profile.total / 2)
    assert mid is not None
    assert 0.0 <= mid["lat"] <= 0.01
    assert 0.0 <= mid["lng"] <= 0.01
