from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import httpx


class TraccarClient:
    def __init__(self, base_url: Optional[str], token: Optional[str]):
        self.base_url = base_url.rstrip("/") if base_url else None
        self.token = token

    def _headers(self) -> dict:
        if self.token:
            return {"Authorization": f"Bearer {self.token}"}
        return {}

    async def fetch_devices(self) -> list[dict]:
        if not self.base_url or not self.token:
            return []
        url = f"{self.base_url}/api/devices"
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.get(url, headers=self._headers())
            res.raise_for_status()
            data = res.json()
            return data if isinstance(data, list) else []

    async def fetch_positions(self) -> list[dict]:
        if not self.base_url or not self.token:
            return []
        url = f"{self.base_url}/api/positions"
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.get(url, headers=self._headers())
            res.raise_for_status()
            data = res.json()
            return data if isinstance(data, list) else []

    async def fetch_route_report(self, device_id: int, from_dt: datetime, to_dt: datetime) -> list[dict]:
        if not self.base_url or not self.token:
            return []
        params = {
            "deviceId": str(device_id),
            "from": from_dt.astimezone(timezone.utc).isoformat(),
            "to": to_dt.astimezone(timezone.utc).isoformat(),
        }
        url = f"{self.base_url}/api/reports/route"
        async with httpx.AsyncClient(timeout=20) as client:
            res = await client.get(url, headers=self._headers(), params=params)
            res.raise_for_status()
            data = res.json()
            return data if isinstance(data, list) else []
