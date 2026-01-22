from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from .route import RouteService, distance_meters

ACTIVE_DISTANCE_THRESHOLD = 50
HISTORY_WINDOW_MS = 60 * 60 * 1000
ENDPOINT_PROXIMITY_METERS = 30
ETA_CONFIDENCE_Z = 1.645
HINT_STALE_MS = 5 * 60 * 1000


@dataclass
class Progress:
    distance_along: float
    point: dict
    offtrack: bool
    endpoint: Optional[str]


@dataclass
class SpeedStats:
    average_ms: float
    speed_stddev: float
    segment_count: int


class ProgressService:
    def __init__(self, route: RouteService):
        self.route = route

    @staticmethod
    def _select_history_samples(history: list[dict], active_start: Optional[int], now_ms: int) -> list[dict]:
        cutoff = now_ms - HISTORY_WINDOW_MS
        filtered = [p for p in history if p["t"] >= cutoff and (active_start is None or p["t"] >= active_start)]
        if len(filtered) >= 2:
            return filtered
        if filtered:
            return filtered
        return history

    def _summarize_speeds(self, samples: list[dict]) -> Optional[SpeedStats]:
        if len(samples) < 2:
            return None
        speeds = []
        total_dist = 0.0
        total_time_ms = 0.0
        for i in range(1, len(samples)):
            prev = samples[i - 1]
            curr = samples[i]
            span_ms = curr["t"] - prev["t"]
            if not math.isfinite(span_ms) or span_ms <= 0:
                continue
            seg_dist = distance_meters((prev["lat"], prev["lng"]), (curr["lat"], curr["lng"]))
            seg_speed = seg_dist / (span_ms / 1000)
            if math.isfinite(seg_speed) and seg_speed >= 0:
                speeds.append(seg_speed)
                total_dist += seg_dist
                total_time_ms += span_ms
        if not speeds or total_time_ms <= 0:
            return None
        average_ms = total_dist / (total_time_ms / 1000)
        variance_sum = sum((s - average_ms) ** 2 for s in speeds)
        speed_stddev = math.sqrt(variance_sum / (len(speeds) - 1)) if len(speeds) > 1 else 0.0
        return SpeedStats(average_ms=average_ms, speed_stddev=speed_stddev, segment_count=len(speeds))

    def get_speed_stats(self, history: list[dict], active_start: Optional[int], now_ms: int) -> Optional[SpeedStats]:
        samples = self._select_history_samples(history, active_start, now_ms)
        if len(samples) < 2:
            return None
        return self._summarize_speeds(samples)

    def get_average_speed_ms(self, history: list[dict], active_start: Optional[int], now_ms: int) -> float:
        stats = self.get_speed_stats(history, active_start, now_ms)
        return stats.average_ms if stats else 0.0

    @staticmethod
    def _get_recent_heading(history: list[dict], points: int = 5) -> Optional[float]:
        if not history:
            return None
        n = min(points, len(history))
        a = history[-n]
        b = history[-1]
        if any(v is None for v in (a.get("lat"), a.get("lng"), b.get("lat"), b.get("lng"))):
            return None
        y = math.sin(math.radians(b["lng"] - a["lng"])) * math.cos(math.radians(b["lat"]))
        x = (
            math.cos(math.radians(a["lat"])) * math.sin(math.radians(b["lat"]))
            - math.sin(math.radians(a["lat"]))
            * math.cos(math.radians(b["lat"]))
            * math.cos(math.radians(b["lng"] - a["lng"]))
        )
        bearing = (math.degrees(math.atan2(y, x)) + 360) % 360
        return bearing

    def _infer_endpoint(self, distance_along: float, total: float, last_projection: Optional[dict], history: list[dict]) -> Optional[str]:
        if not math.isfinite(distance_along) or not math.isfinite(total) or total <= 0:
            return None
        dist_to_start = distance_along
        dist_to_finish = max(total - distance_along, 0)
        near_start = dist_to_start <= ENDPOINT_PROXIMITY_METERS
        near_finish = dist_to_finish <= ENDPOINT_PROXIMITY_METERS
        if near_start and not near_finish:
            return "start"
        if near_finish and not near_start:
            return "finish"
        if not near_start and not near_finish:
            return None
        prev_dist = last_projection.get("distanceAlong") if last_projection else None
        if math.isfinite(prev_dist or float("nan")):
            return "finish" if prev_dist > total / 2 else "start"
        if history:
            prev_sample = history[-2] if len(history) > 1 else history[0]
            proj = self.route.project_on_route_with_hint(
                {"lat": prev_sample["lat"], "lng": prev_sample["lng"]}, prev_dist
            )
            if proj and proj.get("distanceAlong") is not None:
                return "finish" if proj["distanceAlong"] > total / 2 else "start"
        return "start"

    def compute_progress(
        self,
        position: dict,
        last_projection: Optional[dict],
        history: list[dict],
    ) -> Optional[Progress]:
        if not position:
            return None
        now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
        hint = None
        if last_projection and last_projection.get("t"):
            if now_ms - last_projection["t"] <= HINT_STALE_MS:
                hint = last_projection.get("distanceAlong")
        heading = self._get_recent_heading(history)
        proj = self.route.project_on_route_with_hint(
            {"lat": position["latitude"], "lng": position["longitude"]},
            hint,
            heading,
        )
        if not proj or proj.get("offtrack"):
            fallback = self.route.project_on_route({"lat": position["latitude"], "lng": position["longitude"]})
            if fallback and (not fallback.get("offtrack") or (proj and fallback.get("dist2", 0) < proj.get("dist2", 1e12))):
                proj = fallback
        if not proj:
            return None
        offtrack = bool(proj.get("offtrack"))
        total = self.route.load().total
        endpoint = None
        if not offtrack:
            endpoint = self._infer_endpoint(proj["distanceAlong"], total, last_projection, history)
        return Progress(distance_along=proj["distanceAlong"], point=proj["point"], offtrack=offtrack, endpoint=endpoint)

    def mark_active_on_route(
        self,
        progress: Progress,
        active_start_times: dict[int, int],
        device_id: int,
        now_ms: int,
        history: list[dict],
    ) -> None:
        if not progress or progress.offtrack:
            return
        if progress.distance_along is None or progress.distance_along < ACTIVE_DISTANCE_THRESHOLD:
            return
        if device_id in active_start_times:
            return
        start_ms = self._find_active_start_time(history)
        active_start_times[device_id] = start_ms if start_ms is not None else now_ms

    def _find_active_start_time(self, history: list[dict]) -> Optional[int]:
        hint = None
        for sample in history:
            if not math.isfinite(sample["t"]):
                continue
            proj = self.route.project_on_route_with_hint({"lat": sample["lat"], "lng": sample["lng"]}, hint)
            if not proj or proj.get("distanceAlong") is None:
                continue
            hint = proj["distanceAlong"]
            if proj["distanceAlong"] >= ACTIVE_DISTANCE_THRESHOLD:
                return sample["t"]
        return None

    def compute_eta(
        self,
        progress: Optional[Progress],
        target_distance: float,
        history: list[dict],
        active_start: Optional[int],
        now_ms: int,
    ) -> dict:
        if not progress or progress.offtrack:
            return {"status": "offtrack"}
        speed_stats = self.get_speed_stats(history, active_start, now_ms)
        speed_ms = speed_stats.average_ms if speed_stats else 0.0
        delta = target_distance - progress.distance_along
        if delta <= 0:
            return {"status": "passed"}
        if speed_ms <= 0:
            return {"status": "unknown"}
        arrival = datetime.fromtimestamp((now_ms + (delta / speed_ms) * 1000) / 1000, tz=timezone.utc)
        interval = self._compute_eta_interval(delta, speed_stats, now_ms)
        payload = {"status": "eta", "arrival": arrival.isoformat()}
        if interval:
            payload["interval"] = interval
        return payload

    def _compute_eta_interval(self, delta: float, speed_stats: Optional[SpeedStats], now_ms: int) -> Optional[dict]:
        if not speed_stats:
            return None
        avg = speed_stats.average_ms
        std = speed_stats.speed_stddev
        if not avg or avg <= 0 or not std or std <= 0 or speed_stats.segment_count < 2:
            return None
        standard_error = std / math.sqrt(speed_stats.segment_count)
        if not math.isfinite(standard_error) or standard_error <= 0:
            return None
        margin = ETA_CONFIDENCE_Z * standard_error
        if not math.isfinite(margin) or margin <= 0 or margin >= avg:
            return None
        fast_speed = avg + margin
        slow_speed = avg - margin
        if fast_speed <= 0 or slow_speed <= 0:
            return None
        low_arrival = datetime.fromtimestamp((now_ms + (delta / fast_speed) * 1000) / 1000, tz=timezone.utc)
        high_arrival = datetime.fromtimestamp((now_ms + (delta / slow_speed) * 1000) / 1000, tz=timezone.utc)
        return {"low": low_arrival.isoformat(), "high": high_arrival.isoformat(), "confidence": 0.9}
