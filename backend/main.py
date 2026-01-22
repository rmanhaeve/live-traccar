from __future__ import annotations

import asyncio
import math
import random
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request, Response, UploadFile, File
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import ROOT_DIR, Settings
from .services.admin_auth import AdminAuth
from .services.config_store import ConfigStore
from .services.progress import ProgressService, ACTIVE_DISTANCE_THRESHOLD
from .services.route import RouteService
from .services.traccar import TraccarClient
from .services.weather import WeatherService


def parse_time_ms(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    try:
        if value.endswith("Z"):
            value = value.replace("Z", "+00:00")
        return int(datetime.fromisoformat(value).timestamp() * 1000)
    except Exception:
        return None


CONFIG_TO_SETTINGS = {
    "traccarUrl": "traccar_url",
    "token": "traccar_token",
    "title": "title",
    "refreshSeconds": "refresh_seconds",
    "staleMinutes": "stale_minutes",
    "historyHours": "history_hours",
    "showViewerLocation": "show_viewer_location",
    "showKmMarkers": "show_km_markers",
    "showWaypoints": "show_waypoints",
    "trackFile": "track_file",
    "weatherEnabled": "weather_enabled",
    "weatherHours": "weather_hours",
    "debug": "debug",
    "debugSpeedKph": "debug_speed_kph",
    "debugStartTime": "debug_start_time",
    "debugDeviceIds": "debug_device_ids",
}


def apply_config_to_settings(settings: Settings, base_settings: Settings, config_data: dict) -> None:
    for field in settings.model_fields:
        setattr(settings, field, getattr(base_settings, field))
    for key, attr in CONFIG_TO_SETTINGS.items():
        if key not in config_data:
            continue
        value = config_data[key]
        if isinstance(value, str) and value.strip() == "":
            continue
        if attr in {"track_file", "translation_file"} and isinstance(value, str):
            path = Path(value)
            if not path.is_absolute():
                direct = ROOT_DIR / path
                if not direct.exists():
                    candidate = ROOT_DIR / "frontend" / path
                    if candidate.exists():
                        value = str(candidate.relative_to(ROOT_DIR))
        if attr == "debug_device_ids" and isinstance(value, list):
            value = ",".join(str(item) for item in value)
        setattr(settings, attr, value)


def build_public_config(settings: Settings, config_data: dict) -> dict:
    frontend_root = ROOT_DIR / "frontend"
    track_rel = (
        settings.track_path.relative_to(frontend_root)
        if settings.track_path.is_relative_to(frontend_root)
        else settings.track_path.name
    )
    return {
        "title": config_data.get("title", settings.title),
        "refreshSeconds": config_data.get("refreshSeconds", settings.refresh_seconds),
        "staleMinutes": config_data.get("staleMinutes", settings.stale_minutes),
        "showViewerLocation": config_data.get("showViewerLocation", settings.show_viewer_location),
        "showKmMarkers": config_data.get("showKmMarkers", settings.show_km_markers),
        "showWaypoints": config_data.get("showWaypoints", settings.show_waypoints),
        "historyHours": config_data.get("historyHours", settings.history_hours),
        "trackFile": str(track_rel),
        "deviceIds": config_data.get("deviceIds"),
        "startTime": config_data.get("startTime"),
        "debug": config_data.get("debug", settings.debug),
        "debugStartTime": config_data.get("debugStartTime", settings.debug_start_time),
        "debugSpeedKph": config_data.get("debugSpeedKph", settings.debug_speed_kph),
        "debugDeviceIds": config_data.get("debugDeviceIds", settings.debug_device_id_list),
    }


def build_admin_config(settings: Settings, config_data: dict) -> dict:
    frontend_root = ROOT_DIR / "frontend"
    track_rel = (
        settings.track_path.relative_to(frontend_root)
        if settings.track_path.is_relative_to(frontend_root)
        else settings.track_path.name
    )
    debug_device_ids = settings.debug_device_id_list
    return {
        "traccarUrl": config_data.get("traccarUrl", settings.traccar_url),
        "token": config_data.get("token", settings.traccar_token),
        "title": config_data.get("title", settings.title),
        "refreshSeconds": config_data.get("refreshSeconds", settings.refresh_seconds),
        "staleMinutes": config_data.get("staleMinutes", settings.stale_minutes),
        "historyHours": config_data.get("historyHours", settings.history_hours),
        "showViewerLocation": config_data.get("showViewerLocation", settings.show_viewer_location),
        "showKmMarkers": config_data.get("showKmMarkers", settings.show_km_markers),
        "showWaypoints": config_data.get("showWaypoints", settings.show_waypoints),
        "trackFile": config_data.get("trackFile", str(track_rel)),
        "weatherEnabled": config_data.get("weatherEnabled", settings.weather_enabled),
        "weatherHours": config_data.get("weatherHours", settings.weather_hours),
        "debug": config_data.get("debug", settings.debug),
        "debugSpeedKph": config_data.get("debugSpeedKph", settings.debug_speed_kph),
        "debugStartTime": config_data.get("debugStartTime", settings.debug_start_time),
        "debugDeviceIds": config_data.get("debugDeviceIds", debug_device_ids),
        "deviceIds": config_data.get("deviceIds"),
        "startTime": config_data.get("startTime"),
    }


class AppState:
    DEBUG_DEVICE_IDS = [10001, 10002, 10003, 10004, 10005]
    DEBUG_JITTER_METERS = 5
    HISTORY_INTERVAL_SECONDS = 5

    def __init__(self, settings: Settings):
        self.settings = settings
        self.route_service = RouteService(settings.track_path)
        self.progress_service = ProgressService(self.route_service)
        self.traccar = TraccarClient(settings.traccar_url, settings.traccar_token)
        self.weather = WeatherService(hours=settings.weather_hours)
        self.last_refresh = 0.0
        self.refresh_lock = asyncio.Lock()
        self.devices: dict[int, dict] = {}
        self.last_positions: dict[int, dict] = {}
        self.last_seen: dict[int, str] = {}
        self.positions_history: dict[int, list[dict]] = {}
        self.active_start_times: dict[int, int] = {}
        self.last_projection: dict[int, dict] = {}
        self.progress_events: dict[int, dict] = {}
        self.history_loaded: set[int] = set()
        self.debug_state: dict[int, dict] = {}
        self.distance_ticks: list[float] = []
        self.km_markers: list[dict] = []
        self.elevation_totals: dict | None = None

    def apply_settings(self, settings: Settings) -> None:
        self.settings = settings
        self.route_service = RouteService(settings.track_path)
        self.progress_service = ProgressService(self.route_service)
        self.traccar = TraccarClient(settings.traccar_url, settings.traccar_token)
        self.weather = WeatherService(hours=settings.weather_hours)
        self._reset_cached_state()

    def _reset_cached_state(self) -> None:
        self.last_refresh = 0.0
        self.devices = {}
        self.last_positions = {}
        self.last_seen = {}
        self.positions_history = {}
        self.active_start_times = {}
        self.last_projection = {}
        self.progress_events = {}
        self.history_loaded = set()
        self.debug_state = {}
        self.distance_ticks = []
        self.km_markers = []
        self.elevation_totals = None

    def _build_distance_ticks(self) -> list[float]:
        total = self.route_service.load().total
        ticks: list[float] = []
        step = 1000.0
        d = step
        while d <= total + 1e-6:
            ticks.append(d)
            d += step
        return ticks

    def ensure_route_loaded(self) -> None:
        if self.distance_ticks and self.km_markers and self.elevation_totals is not None:
            return
        self.distance_ticks = self._build_distance_ticks()
        self.km_markers = self.route_service.km_markers()
        self.elevation_totals = self.route_service.compute_elevation_totals()

    async def refresh(self) -> None:
        now = time.time()
        if now - self.last_refresh < max(1, self.settings.refresh_seconds):
            return
        async with self.refresh_lock:
            now = time.time()
            if now - self.last_refresh < max(1, self.settings.refresh_seconds):
                return
            self.last_refresh = now
            if self.settings.debug:
                self._load_debug_data()
            else:
                await self._load_traccar_data()

    async def _load_traccar_data(self) -> None:
        devices = await self.traccar.fetch_devices()
        positions = await self.traccar.fetch_positions()
        self.devices = {d["id"]: {"id": d["id"], "name": d.get("name") or f"Participant {d['id']}"} for d in devices}
        await self._ensure_histories(devices)
        for pos in positions:
            self._handle_position(pos)

    def _load_debug_data(self) -> None:
        now_ms = int(time.time() * 1000)
        device_ids = self.settings.debug_device_id_list or self.DEBUG_DEVICE_IDS
        self.devices = {
            device_id: {"id": device_id, "name": f"Debug Participant {idx + 1}"}
            for idx, device_id in enumerate(device_ids)
        }
        positions = self._build_debug_positions(now_ms)
        for device_id in device_ids:
            self.history_loaded.add(device_id)
        for pos in positions:
            self._handle_position(pos)

    def _build_debug_positions(self, now_ms: int) -> list[dict]:
        profile = self.route_service.load()
        total = profile.total or 0
        points = profile.points or []
        speed_ms = max((self.settings.debug_speed_kph or 60) / 3.6, 0)
        base_start_ms = self._parse_debug_start_ms(now_ms)
        device_ids = self.settings.debug_device_id_list or self.DEBUG_DEVICE_IDS
        if not total or not points or speed_ms <= 0:
            return [
                {
                    "deviceId": device_id,
                    "latitude": idx * 0.01,
                    "longitude": idx * 0.01,
                    "speed": speed_ms / 0.514444 if speed_ms else 0,
                    "deviceTime": datetime.now(tz=timezone.utc).isoformat(),
                }
                for idx, device_id in enumerate(device_ids)
            ]
        results = []
        for idx, device_id in enumerate(device_ids):
            state = self.debug_state.get(device_id)
            if not state:
                start_ms = self._initial_start_ms_for_device(idx, total, speed_ms, base_start_ms, now_ms, len(device_ids))
                state = {"start_ms": start_ms}
                self.debug_state[device_id] = state
            elapsed_sec = max(0, (now_ms - state["start_ms"]) / 1000)
            traveled = min(total, speed_ms * elapsed_sec)
            base_pt = self.route_service.point_at_distance(traveled) or {"lat": points[0]["lat"], "lng": points[0]["lng"]}
            noisy = self._jitter_point(base_pt)
            self._ensure_debug_history(device_id, state["start_ms"], now_ms, total, speed_ms)
            results.append(
                {
                    "deviceId": device_id,
                    "latitude": noisy["lat"],
                    "longitude": noisy["lng"],
                    "speed": speed_ms / 0.514444,
                    "deviceTime": datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).isoformat(),
                    "projHintDistanceAlong": traveled,
                }
            )
        return results

    def _jitter_point(self, base: dict) -> dict:
        theta = random.random() * math.pi * 2
        r = math.sqrt(random.random()) * self.DEBUG_JITTER_METERS
        dx = r * math.cos(theta)
        dy = r * math.sin(theta)
        lat_scale = 111_000
        lng_scale = max(math.cos(base["lat"] * math.pi / 180), 1e-6) * lat_scale
        return {"lat": base["lat"] + dy / lat_scale, "lng": base["lng"] + dx / lng_scale}

    def _ensure_debug_history(self, device_id: int, start_ms: int, now_ms: int, total: float, speed_ms: float) -> None:
        history = self.positions_history.get(device_id, [])
        if not history:
            pt0 = self.route_service.point_at_distance(0) or {"lat": 0.0, "lng": 0.0}
            history.append({"t": start_ms, "lat": pt0["lat"], "lng": pt0["lng"]})
        interval_ms = self.HISTORY_INTERVAL_SECONDS * 1000
        last_t = history[-1]["t"] if history else start_ms
        t = last_t + interval_ms
        while t <= now_ms:
            elapsed_sec = max(0, (t - start_ms) / 1000)
            dist = min(total, speed_ms * elapsed_sec)
            pt = self.route_service.point_at_distance(dist) or {"lat": 0.0, "lng": 0.0}
            history.append({"t": t, "lat": pt["lat"], "lng": pt["lng"]})
            t += interval_ms
        self.positions_history[device_id] = history

    def _parse_debug_start_ms(self, now_ms: int) -> int:
        raw = self.settings.debug_start_time
        if raw:
            try:
                if raw.endswith("Z"):
                    raw = raw.replace("Z", "+00:00")
                return int(datetime.fromisoformat(raw).timestamp() * 1000)
            except Exception:
                return now_ms
        return now_ms

    def _initial_start_ms_for_device(
        self,
        idx: int,
        total: float,
        speed_ms: float,
        base_start_ms: int,
        now_ms: int,
        device_count: int,
    ) -> int:
        spacing = total / max(device_count, 1) if total > 0 else 0
        target_dist = min(total, spacing * idx)
        offset_ms = (target_dist / speed_ms) * 1000 if speed_ms > 0 else 0
        est_start = base_start_ms - offset_ms
        return min(est_start, now_ms)

    async def _ensure_histories(self, devices: list[dict]) -> None:
        tasks = []
        for device in devices:
            device_id = device["id"]
            if device_id in self.history_loaded:
                continue
            tasks.append(self._load_device_history(device_id))
        if tasks:
            await asyncio.gather(*tasks)

    async def _load_device_history(self, device_id: int) -> None:
        now = datetime.now(tz=timezone.utc)
        from_dt = now - timedelta(hours=self.settings.history_hours)
        try:
            data = await self.traccar.fetch_route_report(device_id, from_dt, now)
        except Exception:
            data = []
        samples = []
        for item in data:
            time_str = item.get("deviceTime") or item.get("fixTime") or item.get("serverTime")
            t = parse_time_ms(time_str)
            if t is None:
                continue
            samples.append({"t": t, "lat": item.get("latitude"), "lng": item.get("longitude")})
        samples.sort(key=lambda s: s["t"])
        self.positions_history[device_id] = samples
        self.history_loaded.add(device_id)

    def _handle_position(self, position: dict) -> None:
        device_id = position.get("deviceId")
        if device_id is None:
            return
        time_str = position.get("deviceTime") or position.get("fixTime") or position.get("serverTime")
        time_ms = parse_time_ms(time_str)
        if time_str:
            self.last_seen[device_id] = time_str
        prev_proj = self.last_projection.get(device_id)
        self.last_positions[device_id] = position
        if position.get("projHintDistanceAlong") is not None and time_ms is not None:
            self.last_projection[device_id] = {"distanceAlong": position["projHintDistanceAlong"], "t": time_ms}
        if time_ms is not None:
            self._update_history(device_id, position, time_ms)
        history = self.positions_history.get(device_id, [])
        progress = self.progress_service.compute_progress(position, self.last_projection.get(device_id), history)
        if progress and time_ms is not None:
            self.progress_service.mark_active_on_route(progress, self.active_start_times, device_id, time_ms, history)
            self._record_progress_events(device_id, prev_proj, progress, time_ms)
            self.last_projection[device_id] = {"distanceAlong": progress.distance_along, "t": time_ms}

    def _update_history(self, device_id: int, position: dict, time_ms: int) -> None:
        samples = self.positions_history.get(device_id, [])
        samples.append({"t": time_ms, "lat": position.get("latitude"), "lng": position.get("longitude")})
        cutoff = int(time.time() * 1000) - int(self.settings.history_hours * 60 * 60 * 1000)
        while samples and samples[0]["t"] < cutoff:
            samples.pop(0)
        self.positions_history[device_id] = samples

    def _ensure_progress_events(self, device_id: int) -> dict:
        entry = self.progress_events.get(device_id)
        if not entry:
            entry = {"km": {}, "waypoints": {}, "backfilled": False}
            self.progress_events[device_id] = entry
        return entry

    def _update_waypoint_event(self, entry: dict, wp: dict, prev_dist: Optional[float], curr_dist: Optional[float], prev_time: Optional[int], curr_time: Optional[int]) -> None:
        pad = ACTIVE_DISTANCE_THRESHOLD
        low = (wp.get("distanceAlong") or 0) - pad
        high = (wp.get("distanceAlong") or 0) + pad
        prev_in = prev_dist is not None and low <= prev_dist <= high
        curr_in = curr_dist is not None and low <= curr_dist <= high
        crossed = prev_dist is not None and curr_dist is not None and prev_dist < low and curr_dist > high
        if entry.get("enterMs") is None and (curr_in or crossed):
            entry["enterMs"] = prev_time or curr_time or int(time.time() * 1000)
        if entry.get("enterMs") is not None and entry.get("leaveMs") is None:
            if (prev_in and not curr_in and curr_dist is not None and curr_dist > high) or crossed:
                entry["leaveMs"] = curr_time or prev_time or entry["enterMs"]

    def _backfill_progress_from_history(self, device_id: int) -> None:
        events = self._ensure_progress_events(device_id)
        if events.get("backfilled"):
            return
        history = self.positions_history.get(device_id, [])
        if not history:
            return
        max_dist = 0.0
        last_time = None
        first_dist = None
        first_time = None
        last_dist = None
        hint = None
        waypoints = [
            {"id": w.id, "name": w.name, "distanceAlong": w.distance_along}
            for w in self.route_service.load().waypoints
        ]
        for sample in history:
            if not math.isfinite(sample["t"]):
                continue
            proj = self.route_service.project_on_route_with_hint({"lat": sample["lat"], "lng": sample["lng"]}, hint)
            if not proj or proj.get("distanceAlong") is None:
                continue
            dist = proj["distanceAlong"]
            prev_dist = last_dist
            prev_time = last_time
            if first_dist is None:
                first_dist = dist
                first_time = sample["t"]
            max_dist = max(max_dist, dist)
            last_time = sample["t"]
            if last_dist is not None:
                for tick in self.distance_ticks:
                    if tick in events["km"]:
                        continue
                    if dist >= tick and last_dist < tick:
                        events["km"][tick] = sample["t"]
                for idx, wp in enumerate(waypoints):
                    key = f"{idx}:{round(wp['distanceAlong'])}"
                    entry = events["waypoints"].get(key) or {
                        "name": wp["name"],
                        "distanceAlong": wp["distanceAlong"],
                        "enterMs": None,
                        "leaveMs": None,
                    }
                    self._update_waypoint_event(entry, wp, prev_dist, dist, prev_time, sample["t"])
                    if entry.get("enterMs") or entry.get("leaveMs"):
                        events["waypoints"][key] = entry
            last_dist = dist
            hint = dist
        if max_dist >= 0 and last_time is not None:
            for tick in self.distance_ticks:
                if tick in events["km"]:
                    continue
                if max_dist >= tick:
                    t = first_time if first_dist is not None and tick <= first_dist else last_time
                    events["km"][tick] = t
            for idx, wp in enumerate(waypoints):
                key = f"{idx}:{round(wp['distanceAlong'])}"
                if key in events["waypoints"]:
                    continue
                pad = ACTIVE_DISTANCE_THRESHOLD
                high = (wp.get("distanceAlong") or 0) + pad
                if max_dist >= wp.get("distanceAlong", 0):
                    t = first_time if first_dist is not None and wp["distanceAlong"] <= first_dist else last_time
                    events["waypoints"][key] = {
                        "name": wp["name"],
                        "distanceAlong": wp["distanceAlong"],
                        "enterMs": t,
                        "leaveMs": last_time if max_dist > high else None,
                    }
        events["backfilled"] = True

    def _record_progress_events(self, device_id: int, prev_proj: Optional[dict], curr_progress, time_ms: int) -> None:
        self._backfill_progress_from_history(device_id)
        if not curr_progress or curr_progress.distance_along is None or time_ms is None:
            return
        prev = prev_proj.get("distanceAlong") if prev_proj else None
        curr = curr_progress.distance_along
        prev_time = prev_proj.get("t") if prev_proj else time_ms
        events = self._ensure_progress_events(device_id)
        for tick in self.distance_ticks:
            if tick in events["km"]:
                continue
            crossed = curr >= tick if prev is None else curr >= tick and prev < tick
            if crossed:
                events["km"][tick] = time_ms
        waypoints = [
            {"id": w.id, "name": w.name, "distanceAlong": w.distance_along}
            for w in self.route_service.load().waypoints
        ]
        for idx, wp in enumerate(waypoints):
            key = f"{idx}:{round(wp['distanceAlong'])}"
            entry = events["waypoints"].get(key) or {
                "name": wp["name"],
                "distanceAlong": wp["distanceAlong"],
                "enterMs": None,
                "leaveMs": None,
            }
            self._update_waypoint_event(entry, wp, prev, curr, prev_time, time_ms)
            if entry.get("enterMs") or entry.get("leaveMs"):
                events["waypoints"][key] = entry

    def build_participants_payload(self) -> dict:
        participants = []
        now_ms = int(time.time() * 1000)
        for device_id, device in self.devices.items():
            pos = self.last_positions.get(device_id)
            if not pos:
                continue
            history = self.positions_history.get(device_id, [])
            active_start = self.active_start_times.get(device_id)
            progress = self.progress_service.compute_progress(pos, self.last_projection.get(device_id), history)
            speed_ms = self.progress_service.get_average_speed_ms(history, active_start, now_ms)
            speed_kph = speed_ms * 3.6 if speed_ms else 0.0
            last_seen = self.last_seen.get(device_id)
            stale = False
            if last_seen:
                ts = parse_time_ms(last_seen)
                if ts is not None:
                    age_ms = now_ms - ts
                    stale = age_ms > self.settings.stale_minutes * 60 * 1000
            elevation = None
            if progress and progress.distance_along is not None:
                elevation = self.route_service.compute_elevation_totals(progress.distance_along)
            participants.append(
                {
                    "id": device_id,
                    "name": device.get("name") or f"Participant {device_id}",
                    "position": pos,
                    "lastSeen": last_seen,
                    "isStale": stale,
                    "progress": {
                        "distanceAlong": progress.distance_along if progress else None,
                        "point": progress.point if progress else None,
                        "offtrack": progress.offtrack if progress else True,
                        "endpoint": progress.endpoint if progress else None,
                        "elevation": elevation,
                    },
                    "speedKph": speed_kph,
                }
            )
        return {"serverTime": datetime.now(tz=timezone.utc).isoformat(), "participants": participants}

    def build_waypoint_eta_payload(self, participant_id: int) -> dict:
        now_ms = int(time.time() * 1000)
        pos = self.last_positions.get(participant_id)
        history = self.positions_history.get(participant_id, [])
        active_start = self.active_start_times.get(participant_id)
        progress = self.progress_service.compute_progress(pos, self.last_projection.get(participant_id), history)
        waypoints_payload = []
        for wp in self.route_service.load().waypoints:
            eta = self.progress_service.compute_eta(progress, wp.distance_along, history, active_start, now_ms)
            distance_to = None
            if progress and progress.distance_along is not None:
                distance_to = max(wp.distance_along - progress.distance_along, 0.0)
            waypoints_payload.append(
                {
                    "id": wp.id,
                    "name": wp.name,
                    "distanceAlong": wp.distance_along,
                    "eta": eta,
                    "distanceToMeters": distance_to,
                }
            )
        return {"waypoints": waypoints_payload}

    def build_history_payload(self, participant_id: int) -> dict:
        now_ms = int(time.time() * 1000)
        self._backfill_progress_from_history(participant_id)
        events = self.progress_events.get(participant_id)
        km_events = []
        waypoint_events = []
        if events:
            km_events = [
                {"distanceAlong": dist, "timeMs": ts}
                for dist, ts in sorted(events["km"].items(), key=lambda x: x[0])
            ]
            waypoint_events = sorted(events["waypoints"].values(), key=lambda e: e["distanceAlong"])
        history = self.positions_history.get(participant_id, [])
        active_start = self.active_start_times.get(participant_id)
        progress = None
        if self.last_positions.get(participant_id):
            progress = self.progress_service.compute_progress(
                self.last_positions[participant_id],
                self.last_projection.get(participant_id),
                history,
            )
        km_events = self._add_km_speeds(km_events, active_start)
        completed = {round(wp.get("distanceAlong", 0)) for wp in waypoint_events}
        upcoming = []
        if progress and progress.distance_along is not None:
            for wp in self.route_service.load().waypoints:
                key = round(wp.distance_along)
                if key in completed:
                    continue
                if wp.distance_along <= progress.distance_along:
                    continue
                eta = self.progress_service.compute_eta(progress, wp.distance_along, history, active_start, now_ms)
                upcoming.append(
                    {
                        "id": wp.id,
                        "name": wp.name,
                        "distanceAlong": wp.distance_along,
                        "eta": eta,
                        "distanceToMeters": max(wp.distance_along - progress.distance_along, 0.0),
                    }
                )
        return {
            "kmEvents": km_events,
            "waypointEvents": waypoint_events,
            "upcoming": upcoming,
        }

    def _add_km_speeds(self, km_events: list[dict], active_start: Optional[int]) -> list[dict]:
        result = []
        prev = None
        start_dist = ACTIVE_DISTANCE_THRESHOLD
        for item in km_events:
            speed_kph = None
            if prev and prev.get("timeMs") and item.get("timeMs"):
                delta_dist = item["distanceAlong"] - prev["distanceAlong"]
                delta_time = item["timeMs"] - prev["timeMs"]
                if delta_dist > 0 and delta_time > 0:
                    speed_kph = (delta_dist / (delta_time / 1000)) * 3.6
            elif active_start and item.get("timeMs"):
                delta_dist = max(item["distanceAlong"] - start_dist, 0)
                delta_time = item["timeMs"] - active_start
                if delta_dist > 0 and delta_time > 0:
                    speed_kph = (delta_dist / (delta_time / 1000)) * 3.6
            result.append({**item, "speedKph": speed_kph})
            prev = item
        return result

    def build_eta_for_point(self, participant_id: int, lat: float, lng: float) -> dict:
        now_ms = int(time.time() * 1000)
        history = self.positions_history.get(participant_id, [])
        active_start = self.active_start_times.get(participant_id)
        pos = self.last_positions.get(participant_id)
        progress = self.progress_service.compute_progress(pos, self.last_projection.get(participant_id), history)
        snapped = self.route_service.project_on_route({"lat": lat, "lng": lng})
        eta = None
        if snapped and not snapped.get("offtrack"):
            eta = self.progress_service.compute_eta(progress, snapped["distanceAlong"], history, active_start, now_ms)
        return {"eta": eta, "snapped": snapped}


class AdminSetupPayload(BaseModel):
    password: str = Field(min_length=8)


class AdminLoginPayload(BaseModel):
    password: str


class AdminConfigPayload(BaseModel):
    traccarUrl: Optional[str] = None
    token: Optional[str] = None
    title: Optional[str] = None
    refreshSeconds: Optional[int] = None
    staleMinutes: Optional[int] = None
    historyHours: Optional[int] = None
    showViewerLocation: Optional[bool] = None
    showKmMarkers: Optional[bool] = None
    showWaypoints: Optional[bool] = None
    trackFile: Optional[str] = None
    weatherEnabled: Optional[bool] = None
    weatherHours: Optional[int] = None
    debug: Optional[bool] = None
    debugSpeedKph: Optional[int] = None
    debugStartTime: Optional[str] = None
    debugDeviceIds: Optional[list[int]] = None
    deviceIds: Optional[list[int]] = None
    startTime: Optional[str] = None


def create_app(settings: Settings, *, use_config_file: bool = True) -> FastAPI:
    app = FastAPI()
    config_store = ConfigStore(ROOT_DIR / "config.json")
    admin_auth = AdminAuth(config_store)
    base_settings = settings.model_copy()
    if use_config_file:
        apply_config_to_settings(settings, base_settings, config_store.get_config())
    state = AppState(settings)
    app.state.settings = settings
    app.state.base_settings = base_settings
    app.state.config_store = config_store
    app.state.config_enabled = use_config_file
    app.state.admin_auth = admin_auth
    app.state.app_state = state

    def ensure_route_loaded() -> None:
        try:
            state.ensure_route_loaded()
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Route missing") from exc
        except Exception as exc:
            raise HTTPException(status_code=500, detail="Route error") from exc

    @app.get("/api/config")
    async def get_config():
        ensure_route_loaded()
        current_settings = app.state.settings
        config_data = app.state.config_store.get_config() if app.state.config_enabled else {}
        return build_public_config(current_settings, config_data)

    @app.get("/api/route")
    async def get_route():
        ensure_route_loaded()
        profile = state.route_service.load()
        return {
            "segments": profile.segments,
            "waypoints": [
                {
                    "id": wp.id,
                    "name": wp.name,
                    "desc": wp.desc,
                    "distanceAlong": wp.distance_along,
                    "coord": wp.coord,
                }
                for wp in profile.waypoints
            ],
            "totalMeters": profile.total,
            "avgLat": profile.avg_lat,
            "elevationProfile": {
                "distances": profile.distances,
                "elevations": profile.elevations,
                "totals": state.elevation_totals,
            },
            "kmMarkers": state.km_markers,
        }

    @app.get("/api/participants")
    async def get_participants():
        ensure_route_loaded()
        await state.refresh()
        return state.build_participants_payload()

    @app.get("/api/participants/{participant_id}/waypoints")
    async def get_participant_waypoints(participant_id: int):
        ensure_route_loaded()
        await state.refresh()
        return state.build_waypoint_eta_payload(participant_id)

    @app.get("/api/participants/{participant_id}/history")
    async def get_participant_history(participant_id: int):
        ensure_route_loaded()
        await state.refresh()
        return state.build_history_payload(participant_id)

    @app.get("/api/participants/{participant_id}/eta")
    async def get_participant_eta(
        participant_id: int,
        lat: float = Query(...),
        lng: float = Query(...),
    ):
        ensure_route_loaded()
        await state.refresh()
        return state.build_eta_for_point(participant_id, lat, lng)

    @app.get("/api/weather")
    async def get_weather(participant_id: Optional[int] = Query(default=None, alias="participantId")):
        current_settings = app.state.settings
        if not current_settings.weather_enabled:
            raise HTTPException(status_code=404, detail="Weather disabled")
        ensure_route_loaded()
        await state.refresh()
        coord = None
        if participant_id is not None:
            participant = state.build_participants_payload()
            for item in participant["participants"]:
                if item["id"] == participant_id and item.get("position"):
                    coord = {"lat": item["position"]["latitude"], "lng": item["position"]["longitude"]}
                    break
        if coord is None:
            total = state.route_service.load().total
            center = state.route_service.point_at_distance(total / 2 if total else 0)
            if not center:
                raise HTTPException(status_code=404, detail="Route missing")
            coord = center
        try:
            data = await state.weather.fetch_weather_series(coord)
        except Exception as exc:
            raise HTTPException(status_code=502, detail="Weather unavailable") from exc
        return data

    def require_admin_session(request: Request) -> str:
        token = request.cookies.get("admin_session")
        if not app.state.admin_auth.is_authenticated(token):
            raise HTTPException(status_code=401, detail="Unauthorized")
        return token

    def list_track_files() -> list[str]:
        tracks_dir = ROOT_DIR / "frontend" / "tracks"
        if not tracks_dir.exists():
            return []
        files = []
        for path in tracks_dir.glob("*.gpx"):
            files.append(f"tracks/{path.name}")
        return sorted(files)

    @app.get("/api/admin/status")
    async def admin_status(request: Request):
        token = request.cookies.get("admin_session")
        return {
            "initialized": app.state.admin_auth.is_initialized(),
            "authenticated": app.state.admin_auth.is_authenticated(token),
        }

    @app.post("/api/admin/setup")
    async def admin_setup(payload: AdminSetupPayload):
        if app.state.admin_auth.is_initialized():
            raise HTTPException(status_code=409, detail="Admin already configured")
        app.state.admin_auth.set_password(payload.password)
        return {"ok": True}

    @app.post("/api/admin/login")
    async def admin_login(payload: AdminLoginPayload, response: Response):
        if not app.state.admin_auth.is_initialized():
            raise HTTPException(status_code=400, detail="Admin not configured")
        if not app.state.admin_auth.verify_password(payload.password):
            raise HTTPException(status_code=401, detail="Invalid credentials")
        token = app.state.admin_auth.create_session()
        response.set_cookie("admin_session", token, httponly=True, samesite="strict")
        return {"ok": True}

    @app.post("/api/admin/logout")
    async def admin_logout(request: Request, response: Response):
        token = request.cookies.get("admin_session")
        app.state.admin_auth.revoke_session(token)
        response.delete_cookie("admin_session")
        return {"ok": True}

    @app.get("/api/admin/config")
    async def get_admin_config(request: Request):
        require_admin_session(request)
        current_settings = app.state.settings
        config_data = app.state.config_store.get_config()
        return build_admin_config(current_settings, config_data)

    @app.put("/api/admin/config")
    async def update_admin_config(payload: AdminConfigPayload, request: Request):
        require_admin_session(request)
        updates = payload.model_dump(exclude_unset=True)
        normalized = {}
        for key, value in updates.items():
            if isinstance(value, str):
                value = value.strip()
                if value == "":
                    value = None
            normalized[key] = value
        app.state.config_store.update_config(normalized)
        if app.state.config_enabled:
            apply_config_to_settings(app.state.settings, app.state.base_settings, app.state.config_store.get_config())
            app.state.app_state.apply_settings(app.state.settings)
        return build_admin_config(app.state.settings, app.state.config_store.get_config())

    @app.get("/api/admin/tracks")
    async def get_admin_tracks(request: Request):
        require_admin_session(request)
        return {"tracks": list_track_files()}

    @app.post("/api/admin/tracks")
    async def upload_admin_track(request: Request, file: UploadFile = File(...)):
        require_admin_session(request)
        if not file.filename:
            raise HTTPException(status_code=400, detail="Missing filename")
        name = Path(file.filename).name
        if not name.lower().endswith(".gpx"):
            raise HTTPException(status_code=400, detail="Only .gpx files are allowed")
        tracks_dir = ROOT_DIR / "frontend" / "tracks"
        tracks_dir.mkdir(parents=True, exist_ok=True)
        dest = tracks_dir / name
        try:
            contents = await file.read()
            if not contents:
                raise HTTPException(status_code=400, detail="Empty file")
            dest.write_bytes(contents)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail="Failed to upload track") from exc
        return {"ok": True, "track": f"tracks/{name}", "tracks": list_track_files()}

    frontend_dir = ROOT_DIR / "frontend"
    if frontend_dir.exists():
        app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")

    return app


settings = Settings()
app = create_app(settings)
