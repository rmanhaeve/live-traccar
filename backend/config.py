from __future__ import annotations

from pathlib import Path
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parents[1]


def resolve_path(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = ROOT_DIR / path
    return path


class Settings(BaseSettings):
    traccar_url: Optional[str] = Field(default=None)
    traccar_token: Optional[str] = Field(default=None)
    title: str = Field(default="Live Tracker")
    refresh_seconds: int = Field(default=8)
    stale_minutes: int = Field(default=15)
    history_hours: int = Field(default=24)
    show_viewer_location: bool = Field(default=True)
    show_km_markers: bool = Field(default=True)
    show_waypoints: bool = Field(default=True)
    track_file: str = Field(default="frontend/tracks/stapvoorstap.gpx")
    translation_file: str = Field(default="frontend/translations/en.json")
    weather_enabled: bool = Field(default=True)
    weather_hours: int = Field(default=4)
    start_time: Optional[str] = Field(default=None)
    debug: bool = Field(default=False)
    debug_speed_kph: int = Field(default=60)
    debug_device_ids: Optional[str] = Field(default=None)

    model_config = SettingsConfigDict(env_prefix="APP_")

    @property
    def track_path(self) -> Path:
        return resolve_path(self.track_file)

    @property
    def translation_path(self) -> Path:
        return resolve_path(self.translation_file)

    @property
    def debug_device_id_list(self) -> list[int]:
        if not self.debug_device_ids:
            return []
        values = []
        for raw in self.debug_device_ids.split(","):
            raw = raw.strip()
            if not raw:
                continue
            try:
                values.append(int(raw))
            except ValueError:
                continue
        return values
