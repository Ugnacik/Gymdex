from __future__ import annotations

import argparse
from contextlib import closing
import json
import mimetypes
import os
import sqlite3
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from gymdex import db


ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"


def text_field(payload: dict, name: str) -> str:
    value = payload.get(name, "")
    if not isinstance(value, str):
        raise ValueError(f"{name} must be a string.")
    return value


# /api/manage/<segment>/<id> names a db item kind; db.MANAGED_KINDS decides what each supports.
MANAGE_SEGMENTS = {
    "gyms": "gym", "configurations": "configuration", "exercises": "exercise", "variations": "variation",
}


def manage_kind(parts: list[str], length: int) -> str | None:
    """The item kind of a /api/manage/<segment>/<id>[/...] path with the given part count."""
    if len(parts) == length and parts[:2] == ["api", "manage"]:
        return MANAGE_SEGMENTS.get(parts[2])
    return None


def id_field(payload: dict, name: str) -> int:
    value = payload.get(name)
    if type(value) is not int or not 0 < value <= 2**63 - 1:
        raise ValueError(f"{name} must be a positive integer.")
    return value


class GymdexServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], db_path: Path):
        super().__init__(address, GymdexHandler)
        self.db_path = db_path
        with closing(db.connect(db_path)) as connection, connection:
            db.initialize(connection)


class GymdexHandler(BaseHTTPRequestHandler):
    server: GymdexServer

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/bootstrap":
            return self._with_db(lambda connection: db.bootstrap(connection))
        if parsed.path == "/api/manage":
            return self._with_db(lambda connection: db.manage_overview(connection))
        if parsed.path == "/api/history":
            query = parse_qs(parsed.query)
            return self._with_db(lambda connection: db.workout_history(
                connection,
                gym_id=query.get("gym_id", [""])[0],
                start=query.get("start", [""])[0],
                end=query.get("end", [""])[0],
                offset=query.get("offset", ["0"])[0],
            ))
        if parsed.path == "/api/progress":
            query = parse_qs(parsed.query, keep_blank_values=True)
            try:
                variation_id = int(query.get("variation_id", [""])[0])
                gym_value = query.get("gym_id", [""])[0]
                gym_id = int(gym_value) if gym_value else None
            except ValueError:
                return self._json_error("Valid variation_id and gym_id values are required.", HTTPStatus.BAD_REQUEST)
            return self._with_db(lambda connection: db.exercise_progress(
                connection, variation_id, gym_id,
                equipment=query["equipment"][0] if "equipment" in query else None,
                manufacturer=query["manufacturer"][0] if "manufacturer" in query else None,
                label=query["label"][0] if "label" in query else None,
            ))
        if parsed.path == "/api/routines":
            try:
                gym_id = int(parse_qs(parsed.query).get("gym_id", [""])[0])
            except ValueError:
                return self._json_error("A valid gym_id is required.", HTTPStatus.BAD_REQUEST)
            return self._with_db(lambda connection: db.routines_for_gym(connection, gym_id))
        if parsed.path == "/api/export/workouts.csv":
            from gymdex.export import workout_csv
            with closing(db.connect(self.server.db_path)) as connection, connection:
                return self._csv(workout_csv(connection))
        parts = parsed.path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "history"]:
            return self._with_db(lambda connection: db.completed_workout(connection, int(parts[2])))
        if parsed.path == "/api/catalog":
            query = parse_qs(parsed.query)
            try:
                gym_id = int(query.get("gym_id", [""])[0])
            except ValueError:
                return self._json_error("A valid gym_id is required.", HTTPStatus.BAD_REQUEST)
            # Progress lists archived Variations too; the picker does not.
            include_archived = query.get("include_archived", [""])[0] == "1"
            return self._with_db(lambda connection: db.catalog_for_gym(connection, gym_id, include_archived))
        self._serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            payload = self._read_json()
        except (ValueError, json.JSONDecodeError):
            return self._json_error("The request body must be valid JSON.", HTTPStatus.BAD_REQUEST)

        if parsed.path == "/api/gyms":
            return self._with_db(
                lambda connection: db.create_gym(connection, text_field(payload, "name")),
                status=HTTPStatus.CREATED,
            )
        if parsed.path == "/api/workouts":
            return self._with_db(
                lambda connection: db.start_workout(connection, id_field(payload, "gym_id")),
                status=HTTPStatus.CREATED,
            )
        if parsed.path == "/api/exercises":
            return self._with_db(
                lambda connection: db.create_exercise(
                    connection,
                    text_field(payload, "name"),
                    text_field(payload, "variation_name"),
                    text_field(payload, "tracking_type"),
                    payload.get("equipment"),
                    payload.get("assisted", False),
                ),
                status=HTTPStatus.CREATED,
            )

        if parsed.path == "/api/routines":
            return self._with_db(
                lambda connection: db.create_routine(
                    connection, id_field(payload, "gym_id"), payload.get("name"), payload.get("exercises"),
                ),
                status=HTTPStatus.CREATED,
            )

        parts = parsed.path.strip("/").split("/")
        if len(parts) == 4 and parts[:2] == ["api", "routines"] and parts[3] == "start":
            return self._with_db(
                lambda connection: db.start_routine(connection, int(parts[2])),
                status=HTTPStatus.CREATED,
            )
        if len(parts) == 4 and parts[:2] == ["api", "history"] and parts[3] == "routine":
            return self._with_db(
                lambda connection: db.save_workout_as_routine(connection, int(parts[2]), payload.get("name")),
                status=HTTPStatus.CREATED,
            )
        kind = manage_kind(parts, 5)
        if kind and parts[4] == "restore":
            return self._with_db(lambda connection: db.restore_item(connection, kind, int(parts[3])))
        if len(parts) == 4 and parts[:2] == ["api", "history"] and parts[3] == "repeat":
            return self._with_db(
                lambda connection: db.repeat_workout(connection, int(parts[2])),
                status=HTTPStatus.CREATED,
            )
        if (len(parts) == 6 and parts[:2] == ["api", "history"]
                and parts[3] == "exercises" and parts[5] == "sets"):
            return self._with_db(
                lambda connection: db.add_completed_set(connection, int(parts[2]), int(parts[4])),
                status=HTTPStatus.CREATED,
            )
        if len(parts) == 4 and parts[:2] == ["api", "workout-exercises"] and parts[3] == "sets":
            return self._with_db(lambda connection: db.add_set(connection, int(parts[2])), status=HTTPStatus.CREATED)
        if len(parts) == 4 and parts[:2] == ["api", "workouts"]:
            try:
                workout_id = int(parts[2])
            except ValueError:
                return self._json_error("Workout not found.", HTTPStatus.NOT_FOUND)
            if parts[3] == "exercises":
                if "profile_id" in payload:
                    operation = lambda connection: db.add_recent_profile(
                        connection, workout_id, id_field(payload, "profile_id")
                    )
                else:
                    operation = lambda connection: db.add_workout_exercise(
                        connection,
                        workout_id,
                        id_field(payload, "variation_id"),
                        text_field(payload, "equipment"),
                        text_field(payload, "manufacturer"),
                        text_field(payload, "label"),
                    )
                return self._with_db(operation, status=HTTPStatus.CREATED)
            if parts[3] == "complete":
                return self._with_db(
                    lambda connection: db.complete_workout(connection, workout_id) or {"ok": True}
                )
        self._json_error("Route not found.", HTTPStatus.NOT_FOUND)

    def do_PUT(self) -> None:
        parts = urlparse(self.path).path.strip("/").split("/")
        active_set = len(parts) == 3 and parts[:2] == ["api", "sets"]
        history_set = (len(parts) == 5 and parts[:2] == ["api", "history"]
                       and parts[3] == "sets")
        workout_exercise = len(parts) == 3 and parts[:2] == ["api", "workout-exercises"]
        note = (len(parts) == 4 and parts[3] == "note"
                and parts[1] in ("workouts", "workout-exercises") and parts[0] == "api")
        kind = manage_kind(parts, 4)
        routine = len(parts) == 3 and parts[:2] == ["api", "routines"]
        if not active_set and not history_set and not workout_exercise and not note and not kind and not routine:
            return self._json_error("Route not found.", HTTPStatus.NOT_FOUND)
        try:
            payload = self._read_json()
        except ValueError:
            return self._json_error("The request body must be a JSON object.", HTTPStatus.BAD_REQUEST)
        if routine:
            return self._with_db(lambda connection: db.update_routine(connection, int(parts[2]), payload))
        if kind == "variation" and "equipment" in payload:
            return self._with_db(lambda connection: db.set_variation_equipment(
                connection, int(parts[3]), payload["equipment"],
            ))
        if kind:
            return self._with_db(lambda connection: db.rename_item(
                connection, kind, int(parts[3]), payload.get("name"),
            ))
        if note:
            save_note = db.set_workout_note if parts[1] == "workouts" else db.set_workout_exercise_note
            return self._with_db(lambda connection: save_note(
                connection, int(parts[2]), payload.get("note"),
            ))
        if workout_exercise:
            return self._with_db(lambda connection: db.move_workout_exercise(
                connection, int(parts[2]), payload.get("position"),
            ))
        if history_set:
            return self._with_db(lambda connection: db.correct_completed_set(
                connection, int(parts[2]), int(parts[4]), payload,
            ))
        self._with_db(lambda connection: db.update_set(connection, int(parts[2]), payload))

    def do_DELETE(self) -> None:
        parts = urlparse(self.path).path.strip("/").split("/")
        kind = manage_kind(parts, 4)
        if kind:
            return self._with_db(lambda connection: db.remove_item(connection, kind, int(parts[3])))
        if len(parts) == 3 and parts[:2] == ["api", "workouts"]:
            return self._with_db(lambda connection: db.cancel_workout(connection, int(parts[2])))
        if len(parts) == 3 and parts[:2] == ["api", "routines"]:
            return self._with_db(lambda connection: db.delete_routine(connection, int(parts[2])))
        if len(parts) == 3 and parts[:2] == ["api", "workout-exercises"]:
            return self._with_db(lambda connection: db.remove_workout_exercise(connection, int(parts[2])))
        if len(parts) == 3 and parts[:2] == ["api", "history"]:
            return self._with_db(lambda connection: db.delete_completed_workout(connection, int(parts[2])))
        if len(parts) == 5 and parts[:2] == ["api", "history"] and parts[3] == "sets":
            return self._with_db(lambda connection: db.delete_completed_set(
                connection, int(parts[2]), int(parts[4]),
            ))
        if len(parts) != 3 or parts[:2] != ["api", "sets"]:
            return self._json_error("Route not found.", HTTPStatus.NOT_FOUND)
        self._with_db(lambda connection: db.delete_set(connection, int(parts[2])))

    def _with_db(self, operation, status: HTTPStatus = HTTPStatus.OK) -> None:
        try:
            with closing(db.connect(self.server.db_path)) as connection, connection:
                result = operation(connection)
        except ValueError as error:
            return self._json_error(str(error), HTTPStatus.BAD_REQUEST)
        except LookupError as error:
            return self._json_error(str(error), HTTPStatus.NOT_FOUND)
        except OverflowError:
            # An id beyond SQLite's 64-bit INTEGER range cannot name any row.
            return self._json_error("Item not found.", HTTPStatus.NOT_FOUND)
        except RuntimeError as error:
            return self._json_error(str(error), HTTPStatus.CONFLICT)
        except sqlite3.IntegrityError:
            return self._json_error("That item already exists.", HTTPStatus.CONFLICT)
        self._json(result, status)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 16_384:
            raise ValueError("Request body is too large.")
        if length < 0:
            raise ValueError("Invalid request length.")
        payload = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(payload, dict):
            raise ValueError("The request body must be a JSON object.")
        return payload

    def _json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json_error(self, message: str, status: HTTPStatus) -> None:
        self._json({"error": message}, status)

    def _csv(self, content: str) -> None:
        body = content.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="gymdex-workouts.csv"')
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, request_path: str) -> None:
        relative = "index.html" if request_path == "/" else request_path.lstrip("/")
        path = (STATIC / relative).resolve()
        if STATIC.resolve() not in path.parents and path != STATIC.resolve():
            return self.send_error(HTTPStatus.NOT_FOUND)
        if not path.is_file():
            path = STATIC / "index.html"
        body = path.read_bytes()
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if mime_type.startswith("text/") or mime_type.endswith(("json", "javascript")):
            mime_type += "; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        )
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Gymdex web server.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    db_path = Path(os.environ.get("GYMDEX_DB_PATH", ROOT / "data" / "gymdex.sqlite3"))
    server = GymdexServer((args.host, args.port), db_path)
    print(f"Gymdex is running at http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
