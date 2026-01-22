from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime

import httpx


@dataclass
class WeatherCacheEntry:
    data: dict
    last_fetch: float


class WeatherService:
    STALE_SECONDS = 10 * 60

    def __init__(self, hours: int = 4):
        self.hours = hours
        self.cache: dict[str, WeatherCacheEntry] = {}

    async def fetch_weather_series(self, coord: dict) -> dict:
        cache_key = f"{coord['lat']:.4f},{coord['lng']:.4f}"
        cached = self.cache.get(cache_key)
        if cached and time.time() - cached.last_fetch < self.STALE_SECONDS:
            return cached.data
        params = {
            "latitude": f"{coord['lat']:.4f}",
            "longitude": f"{coord['lng']:.4f}",
            "current": "temperature_2m,wind_speed_10m,precipitation",
            "hourly": "temperature_2m,precipitation_probability,wind_speed_10m",
            "forecast_days": "2",
            "timezone": "auto",
        }
        url = "https://api.open-meteo.com/v1/forecast"
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.get(url, params=params)
            res.raise_for_status()
            data = res.json()
        now_ms = int(time.time() * 1000)
        rows = []
        for idx in range(self.hours):
            target_ms = now_ms + (idx + 1) * 60 * 60 * 1000
            rows.append(self._build_hour_row(data, target_ms, coord))
        summary = None
        if data.get("current"):
            summary = {
                "temp": data["current"].get("temperature_2m"),
                "wind": data["current"].get("wind_speed_10m"),
                "precip": data["current"].get("precipitation"),
            }
        payload = {"summary": summary, "rows": rows}
        self.cache[cache_key] = WeatherCacheEntry(data=payload, last_fetch=time.time())
        return payload

    def _build_hour_row(self, data: dict, target_ms: int, coord: dict) -> dict:
        times = data.get("hourly", {}).get("time") or []
        temps = data.get("hourly", {}).get("temperature_2m") or []
        precips = data.get("hourly", {}).get("precipitation_probability") or []
        winds = data.get("hourly", {}).get("wind_speed_10m") or []
        best_idx = None
        best_diff = None
        for idx, time_str in enumerate(times):
            try:
                if time_str.endswith("Z"):
                    time_str = time_str.replace("Z", "+00:00")
                ts = int(datetime.fromisoformat(time_str).timestamp() * 1000)
            except Exception:
                continue
            diff = abs(ts - target_ms)
            if best_diff is None or diff < best_diff:
                best_diff = diff
                best_idx = idx
        row = {
            "label": None,
            "timeMs": target_ms,
            "temp": None,
            "precip": None,
            "wind": None,
            "distanceAlong": None,
        }
        if best_idx is not None:
            row["temp"] = temps[best_idx] if best_idx < len(temps) else None
            row["precip"] = precips[best_idx] if best_idx < len(precips) else None
            row["wind"] = winds[best_idx] if best_idx < len(winds) else None
        return row
