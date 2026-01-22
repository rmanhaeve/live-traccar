from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class ConfigStore:
    def __init__(self, path: Path):
        self.path = path
        self._data: dict[str, Any] = self._load()

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        try:
            raw = self.path.read_text(encoding="utf-8")
            data = json.loads(raw)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def data(self) -> dict[str, Any]:
        return dict(self._data)

    def get_config(self) -> dict[str, Any]:
        return {key: value for key, value in self._data.items() if key != "admin"}

    def get_admin(self) -> dict[str, Any]:
        admin = self._data.get("admin")
        return admin if isinstance(admin, dict) else {}

    def set_admin(self, admin: dict[str, Any]) -> None:
        self._data["admin"] = admin
        self._save()

    def update_config(self, updates: dict[str, Any]) -> None:
        for key, value in updates.items():
            if value is None:
                self._data.pop(key, None)
            else:
                self._data[key] = value
        self._save()

    def _save(self) -> None:
        payload = json.dumps(self._data, indent=2, sort_keys=True)
        self.path.write_text(payload + "\n", encoding="utf-8")
