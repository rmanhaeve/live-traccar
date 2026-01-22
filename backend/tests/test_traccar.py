from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from backend.services.traccar import TraccarClient


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

    async def get(self, url, headers=None, params=None):
        self.calls.append({"url": url, "headers": headers, "params": params})
        payload = self.payloads.pop(0)
        return DummyResponse(payload)


def test_fetch_devices(monkeypatch):
    calls = []
    payloads = [[{"id": 1, "name": "Alice"}]]

    def factory(*args, **kwargs):
        return DummyAsyncClient(payloads, calls, timeout=kwargs.get("timeout"))

    monkeypatch.setattr("backend.services.traccar.httpx.AsyncClient", factory)
    client = TraccarClient("https://example.com/base/", "token")

    devices = asyncio.run(client.fetch_devices())
    assert devices == [{"id": 1, "name": "Alice"}]
    assert calls[0]["url"] == "https://example.com/base/api/devices"
    assert calls[0]["headers"] == {"Authorization": "Bearer token"}


def test_fetch_positions(monkeypatch):
    calls = []
    payloads = [[{"deviceId": 1, "latitude": 1, "longitude": 2}]]

    def factory(*args, **kwargs):
        return DummyAsyncClient(payloads, calls, timeout=kwargs.get("timeout"))

    monkeypatch.setattr("backend.services.traccar.httpx.AsyncClient", factory)
    client = TraccarClient("https://example.com/base", "token")

    positions = asyncio.run(client.fetch_positions())
    assert positions and positions[0]["deviceId"] == 1
    assert calls[0]["url"] == "https://example.com/base/api/positions"


def test_fetch_route_report(monkeypatch):
    calls = []
    payloads = [[{"deviceId": 1, "latitude": 1, "longitude": 2}]]

    def factory(*args, **kwargs):
        return DummyAsyncClient(payloads, calls, timeout=kwargs.get("timeout"))

    monkeypatch.setattr("backend.services.traccar.httpx.AsyncClient", factory)
    client = TraccarClient("https://example.com/base", "token")

    start = datetime(2024, 1, 1, tzinfo=timezone.utc)
    end = datetime(2024, 1, 1, 1, tzinfo=timezone.utc)
    data = asyncio.run(client.fetch_route_report(5, start, end))

    assert data and calls[0]["params"]["deviceId"] == "5"

