from __future__ import annotations

import asyncio
from datetime import datetime, timezone, timedelta

from backend.services.weather import WeatherService


class DummyResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class DummyAsyncClient:
    def __init__(self, payloads, calls, timeout=None):
        self.payloads = list(payloads)
        self.calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url, params=None):
        self.calls.append({"url": url, "params": params})
        payload = self.payloads.pop(0)
        return DummyResponse(payload)


def test_weather_fetch(monkeypatch):
    now = datetime.now(tz=timezone.utc)
    hourly_times = [(now.replace(minute=0, second=0, microsecond=0) + i * timedelta(hours=1)).isoformat() for i in range(6)]
    payload = {
        "current": {"temperature_2m": 12.5, "wind_speed_10m": 5.0, "precipitation": 0.3},
        "hourly": {
            "time": hourly_times,
            "temperature_2m": [10, 11, 12, 13, 14, 15],
            "precipitation_probability": [10, 20, 30, 40, 50, 60],
            "wind_speed_10m": [3, 4, 5, 6, 7, 8],
        },
    }
    calls = []

    def factory(*args, **kwargs):
        return DummyAsyncClient([payload], calls, timeout=kwargs.get("timeout"))

    monkeypatch.setattr("backend.services.weather.httpx.AsyncClient", factory)
    service = WeatherService(hours=2)
    data = asyncio.run(service.fetch_weather_series({"lat": 1.23, "lng": 4.56}))

    assert data["summary"]["temp"] == 12.5
    assert len(data["rows"]) == 2
    assert calls

    # second call should hit cache
    data2 = asyncio.run(service.fetch_weather_series({"lat": 1.23, "lng": 4.56}))
    assert data2["summary"]["wind"] == 5.0
    assert len(calls) == 1
