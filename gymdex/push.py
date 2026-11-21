"""Web Push for the rest timer and the hourly Still working out? reminder.

The phone may be locked or the app suspended (iOS stops a Home Screen web app's timers), so the
server sends the reminders itself through the phone's push service. Messages are encrypted for
the subscription as RFC 8291 requires and signed with this server's VAPID key (RFC 8292).

The crypto uses the `cryptography` package (Debian's python3-cryptography). It is optional:
without it the server runs as before and reports that notifications are unavailable.
"""
from __future__ import annotations

import base64
import json
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

from gymdex import db

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
except ImportError:  # pragma: no cover - exercised only where the package is missing
    ec = None

# Apple and Mozilla require a contact in the VAPID claims: a mailto: or https: URL.
DEFAULT_SUBJECT = "https://github.com/Ugnacik/Gymdex"
HOUR = 3600
# A rest that ended longer ago than this (the server was down) is dropped, like the in-app cue.
REST_LATE_SECONDS = 60
# An hourly reminder found this late (after a restart) is skipped until the next hour.
HOURLY_LATE_SECONDS = 5 * 60


def available() -> bool:
    return ec is not None


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _point(public_key) -> bytes:
    return public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def encrypt(plaintext: bytes, ua_public: bytes, auth_secret: bytes, *, as_private=None, salt: bytes | None = None) -> bytes:
    """The aes128gcm body (RFC 8188 header and one record) of a push message for one subscription.
    as_private and salt are fresh for every message; tests pass the RFC 8291 example values."""
    as_private = as_private or ec.generate_private_key(ec.SECP256R1())
    salt = salt or os.urandom(16)
    as_public = _point(as_private.public_key())
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    ecdh_secret = as_private.exchange(ec.ECDH(), ua_key)
    ikm = _hkdf(auth_secret, ecdh_secret, b"WebPush: info\x00" + ua_public + as_public, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    record_size = 4096
    if len(plaintext) + 1 + 16 > record_size:
        raise ValueError("Push message is too long.")
    header = salt + record_size.to_bytes(4, "big") + bytes([len(as_public)]) + as_public
    # 0x02 marks the last (only) record; no extra padding.
    return header + AESGCM(cek).encrypt(nonce, plaintext + b"\x02", None)


class Vapid:
    """This server's VAPID key pair, created once and kept in a file outside git (mode 0600)."""

    def __init__(self, private_key, subject: str = DEFAULT_SUBJECT):
        self.private_key = private_key
        self.subject = subject
        self.public_key = b64url(_point(private_key.public_key()))
        self._tokens: dict[str, tuple[float, str]] = {}

    @classmethod
    def load_or_create(cls, path: Path, subject: str = DEFAULT_SUBJECT) -> "Vapid":
        path = Path(path)
        if path.exists():
            key = serialization.load_pem_private_key(path.read_bytes(), password=None)
        else:
            key = ec.generate_private_key(ec.SECP256R1())
            pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                    serialization.NoEncryption())
            path.parent.mkdir(parents=True, exist_ok=True)
            # Created with 0600 from the start, and never replaced: a new key ends every subscription.
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as file:
                file.write(pem)
        return cls(key, subject)

    def authorization(self, endpoint: str, now: float) -> str:
        """The Authorization header for a push service, reusing a token for up to 12 hours."""
        url = urlparse(endpoint)
        audience = f"{url.scheme}://{url.netloc}"
        cached = self._tokens.get(audience)
        if not cached or cached[0] - now < HOUR:
            expires = int(now) + 12 * HOUR
            header = b64url(json.dumps({"typ": "JWT", "alg": "ES256"}).encode())
            claims = b64url(json.dumps({"aud": audience, "exp": expires, "sub": self.subject}).encode())
            signing_input = f"{header}.{claims}".encode()
            r, s = decode_dss_signature(self.private_key.sign(signing_input, ec.ECDSA(hashes.SHA256())))
            token = f"{header}.{claims}.{b64url(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"
            cached = self._tokens[audience] = (expires, token)
        return f"vapid t={cached[1]}, k={self.public_key}"


def post(url: str, body: bytes, headers: dict[str, str]) -> int:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def send(vapid: Vapid, subscription: dict[str, str], message: dict[str, Any], *, ttl: int, topic: str | None = None,
         now: float | None = None, transport: Callable[[str, bytes, dict[str, str]], int] = post) -> int:
    """Encrypts message for one subscription and posts it. Answers the push service's HTTP status."""
    body = encrypt(json.dumps(message).encode(), unb64url(subscription["p256dh"]), unb64url(subscription["auth"]))
    headers = {
        "Authorization": vapid.authorization(subscription["endpoint"], time.time() if now is None else now),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": str(ttl),
        "Urgency": "high",
    }
    if topic:
        headers["Topic"] = topic  # A newer message with the same topic replaces an undelivered one.
    return transport(subscription["endpoint"], body, headers)


def server_time(text: str) -> float:
    """Epoch seconds of a SQLite CURRENT_TIMESTAMP value, which is UTC."""
    return datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()


def elapsed_text(seconds: float) -> str:
    minutes = max(0, int(seconds // 60))
    return f"{minutes} min" if minutes < 60 else f"{minutes // 60} h {minutes % 60:02d} min"


def due_messages(connection: sqlite3.Connection, now: float) -> tuple[list[dict[str, Any]], float | None]:
    """Moves the stored reminders forward to now. Answers the messages due and when the next one is.

    The rest reminder is the end time the phone reported. The hourly reminder is kept as the next
    whole hour since the Active Workout started, so a restart neither repeats nor loses one."""
    messages: list[dict[str, Any]] = []
    active = connection.execute(
        """SELECT w.id, w.started_at, g.name AS gym_name FROM workouts w JOIN gyms g ON g.id = w.gym_id
           WHERE w.completed_at IS NULL"""
    ).fetchone()
    if active is None:
        connection.execute("DELETE FROM push_reminders")
        return messages, None
    connection.execute("DELETE FROM push_reminders WHERE workout_id IS NOT ?", (active["id"],))
    reminders = {row["kind"]: row["due_at"] for row in connection.execute("SELECT kind, due_at FROM push_reminders")}

    rest = reminders.get("rest")
    if rest is not None and rest <= now:
        connection.execute("DELETE FROM push_reminders WHERE kind = 'rest'")
        if now - rest <= REST_LATE_SECONDS:
            messages.append({"kind": "rest", "title": "Rest over", "body": "Time for your next set.",
                             "tag": "gymdex-rest", "url": "/"})
        rest = None

    started = server_time(active["started_at"])
    hourly = reminders.get("hourly")
    if hourly is not None and hourly <= now:
        if now - hourly <= HOURLY_LATE_SECONDS:
            messages.append({
                "kind": "hourly", "title": "Still working out?",
                "body": f"Your workout at {active['gym_name']} has been going for {elapsed_text(now - started)}.",
                "tag": "gymdex-hourly", "url": "/?still-training=1",
            })
        hourly = None
    if hourly is None:
        hourly = started + (int(max(0, now - started) // HOUR) + 1) * HOUR
        connection.execute(
            """INSERT INTO push_reminders(kind, workout_id, due_at) VALUES ('hourly', ?, ?)
               ON CONFLICT(kind) DO UPDATE SET workout_id = excluded.workout_id, due_at = excluded.due_at""",
            (active["id"], hourly),
        )
    return messages, min(due for due in (rest, hourly) if due is not None)


def set_rest(connection: sqlite3.Connection, remaining_ms: Any, now: float) -> dict[str, Any]:
    """Schedules Rest over for remaining_ms from now, or cancels it when remaining_ms is null.
    The phone sends the time left rather than a clock time, so a phone clock that is off does not matter."""
    if remaining_ms is None:
        connection.execute("DELETE FROM push_reminders WHERE kind = 'rest'")
        return {"rest_due_in_ms": None}
    if type(remaining_ms) not in (int, float) or not 0 < remaining_ms <= 3600 * 1000:
        raise ValueError("remaining_ms must be a number of milliseconds up to one hour, or null.")
    active = connection.execute("SELECT id FROM workouts WHERE completed_at IS NULL").fetchone()
    if active is None:
        raise LookupError("Active workout not found.")
    connection.execute(
        """INSERT INTO push_reminders(kind, workout_id, due_at) VALUES ('rest', ?, ?)
           ON CONFLICT(kind) DO UPDATE SET workout_id = excluded.workout_id, due_at = excluded.due_at""",
        (active["id"], now + remaining_ms / 1000),
    )
    return {"rest_due_in_ms": int(remaining_ms)}


def save_subscription(connection: sqlite3.Connection, payload: dict) -> dict[str, Any]:
    endpoint = payload.get("endpoint")
    keys = payload.get("keys") if isinstance(payload.get("keys"), dict) else {}
    p256dh, auth = keys.get("p256dh"), keys.get("auth")
    if not isinstance(endpoint, str) or not endpoint.startswith("https://") or len(endpoint) > 2048:
        raise ValueError("A push subscription needs an https endpoint.")
    try:
        valid = len(unb64url(p256dh)) == 65 and len(unb64url(auth)) == 16
    except (TypeError, ValueError, AttributeError):
        valid = False
    if not valid:
        raise ValueError("A push subscription needs its p256dh and auth keys.")
    connection.execute(
        """INSERT INTO push_subscriptions(endpoint, p256dh, auth) VALUES (?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth""",
        (endpoint, p256dh, auth),
    )
    return {"ok": True}


def delete_subscription(connection: sqlite3.Connection, endpoint: Any) -> dict[str, Any]:
    if not isinstance(endpoint, str):
        raise ValueError("endpoint must be a string.")
    connection.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
    return {"ok": True}


def subscriptions(connection: sqlite3.Connection) -> list[dict[str, str]]:
    return db.rows(connection.execute("SELECT endpoint, p256dh, auth FROM push_subscriptions"))


class Notifier:
    """Sends due reminders from a background thread. Call wake() after changing a reminder."""

    def __init__(self, db_path: Path, vapid: Vapid, *, clock: Callable[[], float] = time.time,
                 transport: Callable[[str, bytes, dict[str, str]], int] = post):
        self.db_path = db_path
        self.vapid = vapid
        self.clock = clock
        self.transport = transport
        self._wake = threading.Event()
        self._stopped = False
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="gymdex-push", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stopped = True
        self._wake.set()

    def wake(self) -> None:
        self._wake.set()

    def _run(self) -> None:
        while not self._stopped:
            try:
                next_due = self.tick()
            except Exception as error:  # Keep reminding after a bad tick (locked database, network).
                print(f"Push reminders failed: {error!r}")
                next_due = None
            # Wake for the next reminder, a changed one, or a minute later to notice a new workout.
            delay = 60.0 if next_due is None else min(60.0, max(0.0, next_due - self.clock()))
            self._wake.wait(delay)
            self._wake.clear()

    def tick(self) -> float | None:
        """Sends what is due now. Answers when the next reminder is due."""
        with closing(db.connect(self.db_path)) as connection, connection:
            messages, next_due = due_messages(connection, self.clock())
            targets = subscriptions(connection) if messages else []
        for message in messages:
            self.broadcast(message, targets)
        return next_due

    def broadcast(self, message: dict[str, Any], targets: list[dict[str, str]] | None = None) -> int:
        """Sends message to every subscribed phone and forgets subscriptions the push service ended.
        Answers how many phones accepted it."""
        if targets is None:
            with closing(db.connect(self.db_path)) as connection:
                targets = subscriptions(connection)
        delivered, gone = 0, []
        for subscription in targets:
            try:
                status = send(self.vapid, subscription, message, ttl=600 if message["kind"] == "rest" else 1800,
                              topic=message["tag"], now=self.clock(), transport=self.transport)
            except (OSError, ValueError) as error:
                print(f"Push to {urlparse(subscription['endpoint']).netloc} failed: {error!r}")
                continue
            if status in (404, 410):
                gone.append(subscription["endpoint"])
            elif 200 <= status < 300:
                delivered += 1
            else:
                print(f"Push to {urlparse(subscription['endpoint']).netloc} answered {status}")
        if gone:
            with closing(db.connect(self.db_path)) as connection, connection:
                connection.executemany("DELETE FROM push_subscriptions WHERE endpoint = ?", [(e,) for e in gone])
        return delivered
