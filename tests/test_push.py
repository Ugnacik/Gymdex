import base64
import io
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace

from gymdex import db, push
from gymdex.server import GymdexHandler

if push.available():
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def b64(text):
    return push.unb64url(text.replace(" ", ""))


def private_key(raw):
    return ec.derive_private_key(int.from_bytes(b64(raw), "big"), ec.SECP256R1())


def decrypt(body, ua_private, auth_secret):
    """What the phone does with a push message (RFC 8291), written separately from push.encrypt."""
    salt, record_size, key_length = body[:16], int.from_bytes(body[16:20], "big"), body[20]
    as_public = body[21:21 + key_length]
    ua_public = ua_private.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    secret = ua_private.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public))
    hkdf = lambda salt, ikm, info, n: HKDF(hashes.SHA256(), n, salt, info).derive(ikm)
    ikm = hkdf(auth_secret, secret, b"WebPush: info\x00" + ua_public + as_public, 32)
    plain = AESGCM(hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)).decrypt(
        hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12), body[21 + key_length:], None)
    assert record_size == 4096 and plain.endswith(b"\x02")
    return plain[:-1]


def new_subscriber():
    key = ec.generate_private_key(ec.SECP256R1())
    auth = os.urandom(16)
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return key, auth, {"p256dh": push.b64url(public), "auth": push.b64url(auth)}


@unittest.skipUnless(push.available(), "cryptography is not installed")
class EncryptionTests(unittest.TestCase):
    def test_matches_the_rfc_8291_example(self):
        body = push.encrypt(
            b64("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
            b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
            b64("BTBZMqHH6r4Tts7J_aSIgg"),
            as_private=private_key("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
            salt=b64("DGv6ra1nlYgDCS1FRnbzlw"),
        )
        expected = b64("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
                       "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8") + b64(
            "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ")
        self.assertEqual(body, expected)

    def test_a_subscriber_can_read_a_fresh_message(self):
        key, auth, keys = new_subscriber()
        body = push.encrypt(b'{"title":"Rest over"}', b64(keys["p256dh"]), auth)
        self.assertEqual(decrypt(body, key, auth), b'{"title":"Rest over"}')


@unittest.skipUnless(push.available(), "cryptography is not installed")
class VapidTests(unittest.TestCase):
    def test_key_is_created_once_private_to_the_owner_and_signs_a_valid_token(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "vapid-private-key.pem"
            vapid = push.Vapid.load_or_create(path)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(push.Vapid.load_or_create(path).public_key, vapid.public_key)
            header = vapid.authorization("https://web.push.apple.com/QGuQyavXutnMH/abc", now=1_000_000)
        token, key = header.removeprefix("vapid t=").split(", k=")
        self.assertEqual(key, vapid.public_key)
        head, claims, signature = token.split(".")
        claims_json = json.loads(push.unb64url(claims))
        self.assertEqual(claims_json["aud"], "https://web.push.apple.com")
        self.assertEqual(claims_json["exp"], 1_000_000 + 12 * 3600)
        self.assertTrue(claims_json["sub"].startswith(("https:", "mailto:")))
        raw = push.unb64url(signature)
        public = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), push.unb64url(key))
        public.verify(encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
                      f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))


class ReminderTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "push.sqlite3"
        self.connection = db.connect(self.path)
        db.initialize(self.connection)
        self.gym = db.create_gym(self.connection, "Home")
        self.workout = db.start_workout(self.connection, self.gym["id"])
        self.started = push.server_time(self.workout["started_at"])

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()

    def due(self, at):
        messages, next_due = push.due_messages(self.connection, at)
        self.connection.commit()
        return [message["kind"] for message in messages], next_due

    def test_rest_over_is_sent_once_when_the_reported_rest_ends(self):
        now = self.started + 100
        push.set_rest(self.connection, 90_000, now)
        self.assertEqual(self.due(now + 89), ([], now + 90))
        self.assertEqual(self.due(now + 91)[0], ["rest"])
        self.assertEqual(self.due(now + 92)[0], [])

    def test_canceled_and_long_overdue_rests_are_not_sent(self):
        push.set_rest(self.connection, 60_000, self.started)
        push.set_rest(self.connection, None, self.started + 10)
        self.assertEqual(self.due(self.started + 61)[0], [])
        push.set_rest(self.connection, 60_000, self.started)
        # The server was down when the rest ended: a late "Rest over" would mislead.
        self.assertEqual(self.due(self.started + 60 + push.REST_LATE_SECONDS + 1)[0], [])

    def test_still_working_out_comes_every_hour_since_the_start_and_survives_a_restart(self):
        self.assertEqual(self.due(self.started + 10), ([], self.started + 3600))
        messages, _ = push.due_messages(self.connection, self.started + 3601)
        self.assertEqual(messages[0]["kind"], "hourly")
        self.assertIn("1 h 00 min", messages[0]["body"])
        self.assertIn("Home", messages[0]["body"])
        self.connection.commit()
        # A new connection stands in for a restarted server: the next reminder is still hour two.
        self.connection.close()
        self.connection = db.connect(self.path)
        self.assertEqual(self.due(self.started + 3700), ([], self.started + 7200))
        self.assertEqual(self.due(self.started + 7200)[0], ["hourly"])

    def test_an_hour_missed_while_the_server_was_down_is_skipped(self):
        self.due(self.started + 10)
        self.assertEqual(self.due(self.started + 3600 + push.HOURLY_LATE_SECONDS + 1), ([], self.started + 7200))

    def test_finishing_or_canceling_the_workout_ends_its_reminders(self):
        push.set_rest(self.connection, 60_000, self.started)
        self.due(self.started + 1)
        db.complete_workout(self.connection, self.workout["id"])
        self.assertEqual(self.due(self.started + 3601), ([], None))
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM push_reminders").fetchone()[0], 0)
        with self.assertRaises(LookupError):
            push.set_rest(self.connection, 60_000, self.started)

    def test_a_new_workout_starts_its_own_hours(self):
        self.due(self.started + 10)
        db.cancel_workout(self.connection, self.workout["id"])
        later = db.start_workout(self.connection, self.gym["id"])
        self.connection.execute("UPDATE workouts SET started_at = datetime(started_at, '+30 minutes') WHERE id = ?", (later["id"],))
        self.assertEqual(self.due(self.started + 1900), ([], self.started + 1800 + 3600))

    def request(self, method, path, payload=None):
        handler = object.__new__(GymdexHandler)
        handler.server = SimpleNamespace(db_path=self.path)
        handler.path = path
        body = json.dumps(payload if payload is not None else {}).encode()
        handler.headers = {"Content-Length": str(len(body))}
        handler.rfile = io.BytesIO(body)
        response = []
        handler._json = lambda data, status=200: response.append((int(status), data))
        getattr(handler, f"do_{method}")()
        return response[0]

    def test_phones_subscribe_unsubscribe_and_report_rests_over_http(self):
        keys = {"p256dh": push.b64url(b"\x04" + bytes(64)), "auth": push.b64url(bytes(16))}
        endpoint = "https://web.push.apple.com/abc"
        self.assertEqual(self.request("POST", "/api/push/subscriptions", {"endpoint": endpoint, "keys": keys})[0], 200)
        # Subscribing again after a reinstall updates the keys instead of adding a copy.
        self.assertEqual(self.request("POST", "/api/push/subscriptions", {"endpoint": endpoint, "keys": keys})[0], 200)
        status, info = self.request("GET", "/api/push")
        self.assertEqual((status, info["subscriptions"], info["available"]), (200, 1, False))
        self.assertEqual(self.request("POST", "/api/push/subscriptions", {"endpoint": "http://x", "keys": keys})[0], 400)
        self.assertEqual(self.request("POST", "/api/push/subscriptions", {"endpoint": endpoint, "keys": {"auth": "x"}})[0], 400)
        self.assertEqual(self.request("POST", "/api/push/rest", {"remaining_ms": 120_000}), (200, {"rest_due_in_ms": 120_000}))
        self.assertEqual(self.request("POST", "/api/push/rest", {"remaining_ms": -5})[0], 400)
        self.assertEqual(self.request("POST", "/api/push/rest", {"remaining_ms": None}), (200, {"rest_due_in_ms": None}))
        self.assertEqual(self.request("POST", "/api/push/unsubscribe", {"endpoint": endpoint})[0], 200)
        self.assertEqual(self.request("GET", "/api/push")[1]["subscriptions"], 0)
        self.assertEqual(self.request("POST", "/api/push/test")[0], 503)


@unittest.skipUnless(push.available(), "cryptography is not installed")
class DeliveryTests(unittest.TestCase):
    """Sends real HTTP requests to a stand-in push service on localhost."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "push.sqlite3"
        with db.connect(self.path) as connection:
            db.initialize(connection)
        received = self.received = []

        class PushService(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                received.append((self.path, dict(self.headers), body))
                self.send_response(410 if self.path == "/gone" else 201)
                self.end_headers()

            def log_message(self, *args):
                pass

        self.service = HTTPServer(("127.0.0.1", 0), PushService)
        threading.Thread(target=self.service.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.service.server_port}"
        self.vapid = push.Vapid.load_or_create(Path(self.directory.name) / "vapid.pem")

    def tearDown(self):
        self.service.shutdown()
        self.service.server_close()
        self.directory.cleanup()

    def subscribe(self, path):
        key, auth, keys = new_subscriber()
        with db.connect(self.path) as connection:
            connection.execute("INSERT INTO push_subscriptions(endpoint, p256dh, auth) VALUES (?, ?, ?)",
                               (self.base + path, keys["p256dh"], keys["auth"]))
        connection.close()
        return key, auth

    def test_due_rest_reaches_the_phone_and_ended_subscriptions_are_forgotten(self):
        key, auth = self.subscribe("/phone")
        self.subscribe("/gone")
        clock = [1_000_000.0]
        notifier = push.Notifier(self.path, self.vapid, clock=lambda: clock[0])
        with db.connect(self.path) as connection:
            gym = db.create_gym(connection, "Home")
            db.start_workout(connection, gym["id"])
            push.set_rest(connection, 30_000, clock[0])
        connection.close()
        notifier.tick()
        self.assertEqual(self.received, [])
        clock[0] += 31
        notifier.tick()
        by_path = {path: (headers, body) for path, headers, body in self.received}
        headers, body = by_path["/phone"]
        self.assertEqual(headers["Content-Encoding"], "aes128gcm")
        self.assertEqual(headers["Urgency"], "high")
        self.assertEqual(headers["Topic"], "gymdex-rest")
        self.assertTrue(headers["Authorization"].startswith("vapid t="))
        self.assertEqual(json.loads(decrypt(body, key, auth))["title"], "Rest over")
        with db.connect(self.path) as connection:
            left = [row[0] for row in connection.execute("SELECT endpoint FROM push_subscriptions")]
        connection.close()
        self.assertEqual(left, [self.base + "/phone"])


if __name__ == "__main__":
    unittest.main()
