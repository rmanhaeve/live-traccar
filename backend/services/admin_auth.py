from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from typing import Optional

from .config_store import ConfigStore


SESSION_TTL_SECONDS = 12 * 60 * 60
HASH_ITERATIONS = 200_000


def _hash_password(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, HASH_ITERATIONS)


class AdminAuth:
    def __init__(self, config_store: ConfigStore):
        self._store = config_store
        self._sessions: dict[str, float] = {}

    def is_initialized(self) -> bool:
        admin = self._store.get_admin()
        return bool(admin.get("passwordHash") and admin.get("passwordSalt"))

    def set_password(self, password: str) -> None:
        salt = secrets.token_bytes(16)
        digest = _hash_password(password, salt)
        admin = {
            "passwordSalt": base64.b64encode(salt).decode("ascii"),
            "passwordHash": base64.b64encode(digest).decode("ascii"),
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        self._store.set_admin(admin)

    def verify_password(self, password: str) -> bool:
        admin = self._store.get_admin()
        salt_b64 = admin.get("passwordSalt")
        hash_b64 = admin.get("passwordHash")
        if not salt_b64 or not hash_b64:
            return False
        try:
            salt = base64.b64decode(salt_b64)
            expected = base64.b64decode(hash_b64)
        except Exception:
            return False
        digest = _hash_password(password, salt)
        return hmac.compare_digest(digest, expected)

    def create_session(self) -> str:
        token = secrets.token_urlsafe(32)
        token_hash = self._hash_token(token)
        self._sessions[token_hash] = time.time() + SESSION_TTL_SECONDS
        return token

    def revoke_session(self, token: Optional[str]) -> None:
        if not token:
            return
        token_hash = self._hash_token(token)
        self._sessions.pop(token_hash, None)

    def is_authenticated(self, token: Optional[str]) -> bool:
        if not token:
            return False
        token_hash = self._hash_token(token)
        expiry = self._sessions.get(token_hash)
        if not expiry:
            return False
        if expiry < time.time():
            self._sessions.pop(token_hash, None)
            return False
        return True

    @staticmethod
    def _hash_token(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()
