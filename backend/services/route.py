from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional
from xml.etree import ElementTree


def distance_meters(a: tuple[float, float], b: tuple[float, float]) -> float:
    R = 6371000
    dlat = math.radians(b[0] - a[0])
    dlon = math.radians(b[1] - a[1])
    lat1 = math.radians(a[0])
    lat2 = math.radians(b[0])
    sin_dlat = math.sin(dlat / 2)
    sin_dlon = math.sin(dlon / 2)
    h = sin_dlat * sin_dlat + math.cos(lat1) * math.cos(lat2) * sin_dlon * sin_dlon
    return 2 * R * math.asin(math.sqrt(h))


@dataclass
class Waypoint:
    id: str
    name: str
    desc: str
    distance_along: float
    coord: dict


@dataclass
class RouteProfile:
    segments: list[list[list[float]]]
    waypoints: list[Waypoint]
    distances: list[float]
    elevations: list[Optional[float]]
    total: float
    avg_lat: float
    points: list[dict]


class RouteService:
    HINT_TOLERANCE_METERS = 150
    HINT_PENALTY_PER_METER = 0.2
    HEADING_PENALTY_METERS = 30

    def __init__(self, gpx_path: Path):
        self.gpx_path = gpx_path
        self._profile: Optional[RouteProfile] = None

    def load(self) -> RouteProfile:
        if self._profile:
            return self._profile
        segments, raw_waypoints = self._parse_gpx(self.gpx_path)
        profile = self._build_profile(segments, raw_waypoints)
        self._profile = profile
        return profile

    def _parse_gpx(self, path: Path) -> tuple[list[list[list[float]]], list[dict]]:
        tree = ElementTree.parse(path)
        root = tree.getroot()
        ns = ""
        if root.tag.startswith("{"):
            ns = root.tag.split("}")[0] + "}"
        segments: list[list[list[float]]] = []
        for trk in root.findall(f"{ns}trk"):
            for seg in trk.findall(f"{ns}trkseg"):
                pts: list[list[float]] = []
                for pt in seg.findall(f"{ns}trkpt"):
                    lat = float(pt.get("lat"))
                    lon = float(pt.get("lon"))
                    ele_node = pt.find(f"{ns}ele")
                    ele = float(ele_node.text) if ele_node is not None and ele_node.text else None
                    coords = [lat, lon]
                    if ele is not None:
                        coords.append(ele)
                    pts.append(coords)
                if pts:
                    segments.append(pts)
        waypoints: list[dict] = []
        for wpt in root.findall(f"{ns}wpt"):
            lat = float(wpt.get("lat"))
            lon = float(wpt.get("lon"))
            name = (wpt.findtext(f"{ns}name") or "").strip()
            desc = (wpt.findtext(f"{ns}desc") or "").strip()
            waypoints.append({"lat": lat, "lng": lon, "name": name, "desc": desc})
        return segments, waypoints

    def _build_profile(self, segments: list[list[list[float]]], raw_waypoints: list[dict]) -> RouteProfile:
        points: list[dict] = []
        for seg in segments:
            for pt in seg:
                points.append({"lat": pt[0], "lng": pt[1], "ele": pt[2] if len(pt) > 2 else None})
        if not points:
            profile = RouteProfile(
                segments=segments,
                waypoints=[],
                distances=[],
                elevations=[],
                total=0,
                avg_lat=0,
                points=[],
            )
            return profile
        avg_lat = sum(p["lat"] for p in points) / len(points)
        distances = [0.0 for _ in points]
        elevations = [p["ele"] for p in points]
        for i in range(1, len(points)):
            distances[i] = distances[i - 1] + distance_meters(
                (points[i - 1]["lat"], points[i - 1]["lng"]),
                (points[i]["lat"], points[i]["lng"]),
            )
        total = distances[-1] if distances else 0.0
        rad = math.pi / 180
        R = 6371000
        ref_lat = avg_lat or points[0]["lat"]
        for p in points:
            p["_x"] = p["lng"] * rad * math.cos(ref_lat * rad) * R
            p["_y"] = p["lat"] * rad * R
        for i in range(len(points) - 1):
            a = points[i]
            b = points[i + 1]
            dx = b["_x"] - a["_x"]
            dy = b["_y"] - a["_y"]
            a["_seg_angle"] = math.atan2(dy, dx)
            a["_seg_len2"] = dx * dx + dy * dy
        waypoints = self._map_waypoints(points, distances, raw_waypoints)
        return RouteProfile(
            segments=segments,
            waypoints=waypoints,
            distances=distances,
            elevations=elevations,
            total=total,
            avg_lat=avg_lat,
            points=points,
        )

    def _map_waypoints(
        self,
        points: list[dict],
        distances: list[float],
        raw_waypoints: list[dict],
    ) -> list[Waypoint]:
        if not points:
            return []
        mapped: list[Waypoint] = []
        for idx, wp in enumerate(raw_waypoints):
            proj = self._match_position_on_points(
                {"lat": wp["lat"], "lng": wp["lng"]},
                points,
                distances,
                self._avg_lat(points),
                None,
                None,
            )
            if not proj:
                continue
            name = wp["name"] or wp["desc"] or f"Point {idx + 1}"
            mapped.append(
                Waypoint(
                    id=f"wp-{idx}",
                    name=name,
                    desc=wp["desc"] or "",
                    distance_along=proj["distanceAlong"],
                    coord=proj["point"],
                )
            )
        if not mapped and points:
            mapped.append(
                Waypoint(
                    id="wp-start",
                    name="Start",
                    desc="",
                    distance_along=0.0,
                    coord={"lat": points[0]["lat"], "lng": points[0]["lng"]},
                )
            )
            mapped.append(
                Waypoint(
                    id="wp-finish",
                    name="Finish",
                    desc="",
                    distance_along=distances[-1] if distances else 0.0,
                    coord={"lat": points[-1]["lat"], "lng": points[-1]["lng"]},
                )
            )
        mapped.sort(key=lambda w: w.distance_along)
        return mapped

    def _avg_lat(self, points: list[dict]) -> float:
        if not points:
            return 0.0
        return sum(p["lat"] for p in points) / len(points)

    def point_at_distance(self, distance_along: float) -> Optional[dict]:
        profile = self.load()
        if not profile.points or not profile.distances:
            return None
        target = max(0.0, min(distance_along, profile.distances[-1]))
        idx = next((i for i, d in enumerate(profile.distances) if d >= target), -1)
        if idx <= 0:
            pt = profile.points[0]
            return {"lat": pt["lat"], "lng": pt["lng"]}
        if profile.distances[idx] == target:
            pt = profile.points[idx]
            return {"lat": pt["lat"], "lng": pt["lng"]}
        prev_idx = idx - 1
        segment_len = profile.distances[idx] - profile.distances[prev_idx]
        t = (target - profile.distances[prev_idx]) / segment_len if segment_len > 0 else 0
        a = profile.points[prev_idx]
        b = profile.points[idx]
        return {
            "lat": a["lat"] + (b["lat"] - a["lat"]) * t,
            "lng": a["lng"] + (b["lng"] - a["lng"]) * t,
        }

    def project_on_route_with_hint(
        self,
        latlng: dict,
        hint_distance_along: Optional[float],
        heading_deg: Optional[float] = None,
    ) -> Optional[dict]:
        return self._match_position(latlng, hint_distance_along, heading_deg)

    def project_on_route(self, latlng: dict) -> Optional[dict]:
        return self._match_position(latlng, None, None)

    def _match_position(
        self,
        latlng: dict,
        hint_distance_along: Optional[float],
        heading_deg: Optional[float],
    ) -> Optional[dict]:
        profile = self.load()
        return self._match_position_on_points(
            latlng,
            profile.points,
            profile.distances,
            profile.avg_lat or latlng["lat"],
            hint_distance_along,
            heading_deg,
        )

    def _match_position_on_points(
        self,
        latlng: dict,
        points: list[dict],
        distances: list[float],
        ref_lat: float,
        hint_distance_along: Optional[float],
        heading_deg: Optional[float],
    ) -> Optional[dict]:
        if not points:
            return None
        rad = math.pi / 180
        R = 6371000
        tx = latlng["lng"] * rad * math.cos(ref_lat * rad) * R
        ty = latlng["lat"] * rad * R
        want_heading = heading_deg is not None
        heading_rad = math.radians(heading_deg) if want_heading else None
        candidates = []
        for i in range(len(points) - 1):
            a = points[i]
            b = points[i + 1]
            seg_len2 = a.get("_seg_len2") or 0
            if seg_len2 == 0:
                continue
            apx = tx - a["_x"]
            apy = ty - a["_y"]
            t = (apx * (b["_x"] - a["_x"]) + apy * (b["_y"] - a["_y"])) / seg_len2
            t = max(0.0, min(1.0, t))
            px = a["_x"] + (b["_x"] - a["_x"]) * t
            py = a["_y"] + (b["_y"] - a["_y"]) * t
            d2 = (px - tx) ** 2 + (py - ty) ** 2
            seg_dist = (distances[i] if i < len(distances) else 0) + math.sqrt(seg_len2) * t
            heading_penalty = 0.0
            if want_heading:
                seg_angle = a.get("_seg_angle")
                if seg_angle is not None:
                    diff = abs(seg_angle - heading_rad)
                    diff = min(diff, abs(2 * math.pi - diff))
                    heading_penalty = (1 - math.cos(diff)) * self.HEADING_PENALTY_METERS
            lateral = math.sqrt(d2)
            hint_penalty = 0.0
            if hint_distance_along is not None:
                hint_penalty = max(abs(seg_dist - hint_distance_along) - self.HINT_TOLERANCE_METERS, 0) * self.HINT_PENALTY_PER_METER
            combined = lateral + hint_penalty + heading_penalty
            candidates.append(
                {
                    "d2": d2,
                    "combined": combined,
                    "lateral": lateral,
                    "segDist": seg_dist,
                    "point": {"lat": a["lat"] + (b["lat"] - a["lat"]) * t, "lng": a["lng"] + (b["lng"] - a["lng"]) * t},
                }
            )
        if not candidates:
            return None
        candidates.sort(key=lambda c: (c["combined"], c["lateral"]))
        best = candidates[0]
        offtrack = math.sqrt(best["d2"]) > 200
        return {
            "distanceAlong": best["segDist"],
            "point": best["point"],
            "offtrack": offtrack,
            "dist2": best["d2"],
        }

    def compute_elevation_totals(self, limit_distance: Optional[float] = None) -> dict:
        profile = self.load()
        if not profile.distances or not profile.elevations:
            return {"gain": 0, "loss": 0}
        distances = profile.distances
        elevations = profile.elevations
        total_dist = distances[-1] if distances else 0
        target = total_dist if limit_distance is None else max(0.0, min(limit_distance, total_dist))
        gain = 0.0
        loss = 0.0
        for i in range(1, len(distances)):
            d0 = distances[i - 1]
            d1 = distances[i]
            if not (math.isfinite(d0) and math.isfinite(d1)):
                continue
            e0 = elevations[i - 1]
            e1 = elevations[i]
            if e0 is None or e1 is None:
                continue
            if d0 >= target:
                break
            if target >= d1:
                seg_end_ele = e1
                seg_end_dist = d1
            else:
                ratio = (target - d0) / (d1 - d0) if d1 != d0 else 0
                seg_end_ele = e0 + (e1 - e0) * ratio
                seg_end_dist = target
            diff = seg_end_ele - e0
            if diff > 0:
                gain += diff
            elif diff < 0:
                loss += abs(diff)
            if seg_end_dist >= target:
                break
        return {"gain": gain, "loss": loss}

    def km_markers(self, interval_meters: float = 1000.0) -> list[dict]:
        profile = self.load()
        if not profile.segments or interval_meters <= 0:
            return []
        total = 0.0
        next_mark = interval_meters
        markers: list[dict] = []
        for seg in profile.segments:
            if len(seg) < 2:
                continue
            for i in range(1, len(seg)):
                prev = seg[i - 1]
                curr = seg[i]
                seg_dist = distance_meters((prev[0], prev[1]), (curr[0], curr[1]))
                start_total = total
                total += seg_dist
                while next_mark <= total and seg_dist > 0:
                    ratio = (next_mark - start_total) / seg_dist
                    pt = [
                        prev[0] + (curr[0] - prev[0]) * ratio,
                        prev[1] + (curr[1] - prev[1]) * ratio,
                    ]
                    markers.append({"km": next_mark / 1000, "coord": {"lat": pt[0], "lng": pt[1]}})
                    next_mark += interval_meters
        return markers
