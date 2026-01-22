from __future__ import annotations

import asyncio
import math
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from .config import ROOT_DIR, Settings
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


class AppState:
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
        self.distance_ticks: list[float] = []
        self.km_markers: list[dict] = []
        self.elevation_totals: dict | None = None

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
            await self._load_traccar_data()

    async def _load_traccar_data(self) -> None:
        devices = await self.traccar.fetch_devices()
        positions = await self.traccar.fetch_positions()
        self.devices = {d["id"]: {"id": d["id"], "name": d.get("name") or f"Participant {d['id']}"} for d in devices}
        await self._ensure_histories(devices)
        for pos in positions:
            self._handle_position(pos)

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


def create_app(settings: Settings) -> FastAPI:
    app = FastAPI()
    state = AppState(settings)
    app.state.settings = settings
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
        frontend_root = ROOT_DIR / "frontend"
        track_rel = (
            settings.track_path.relative_to(frontend_root)
            if settings.track_path.is_relative_to(frontend_root)
            else settings.track_path.name
        )
        translation_rel = (
            settings.translation_path.relative_to(frontend_root)
            if settings.translation_path.is_relative_to(frontend_root)
            else settings.translation_path.name
        )
        return {
            "title": settings.title,
            "refreshSeconds": settings.refresh_seconds,
            "staleMinutes": settings.stale_minutes,
            "showViewerLocation": settings.show_viewer_location,
            "showKmMarkers": settings.show_km_markers,
            "showWaypoints": settings.show_waypoints,
            "historyHours": settings.history_hours,
            "trackFile": str(track_rel),
            "translationFile": str(translation_rel),
        }

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
        if not settings.weather_enabled:
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

    frontend_dir = ROOT_DIR / "frontend"
    if frontend_dir.exists():
        app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")

    return app


settings = Settings()
app = create_app(settings)
