from __future__ import annotations

import math
import sqlite3
from datetime import date, timedelta
from pathlib import Path
from typing import Any


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS gyms (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE
);

CREATE TABLE IF NOT EXISTS exercise_variations (
    id INTEGER PRIMARY KEY,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    name TEXT NOT NULL,
    tracking_type TEXT NOT NULL CHECK (tracking_type IN ('repetitions', 'duration')),
    UNIQUE(exercise_id, name)
);

CREATE TABLE IF NOT EXISTS variation_equipment (
    variation_id INTEGER NOT NULL REFERENCES exercise_variations(id),
    equipment TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (variation_id, equipment)
);

CREATE TABLE IF NOT EXISTS gym_exercise_profiles (
    id INTEGER PRIMARY KEY,
    gym_id INTEGER NOT NULL REFERENCES gyms(id),
    variation_id INTEGER NOT NULL REFERENCES exercise_variations(id),
    equipment TEXT NOT NULL,
    manufacturer TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(gym_id, variation_id, equipment, manufacturer, label)
);

CREATE TABLE IF NOT EXISTS workouts (
    id INTEGER PRIMARY KEY,
    gym_id INTEGER NOT NULL REFERENCES gyms(id),
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_workout
ON workouts ((1)) WHERE completed_at IS NULL;

CREATE TABLE IF NOT EXISTS workout_exercises (
    id INTEGER PRIMARY KEY,
    workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
    variation_id INTEGER NOT NULL REFERENCES exercise_variations(id),
    gym_profile_id INTEGER REFERENCES gym_exercise_profiles(id),
    position INTEGER NOT NULL,
    exercise_name_snapshot TEXT NOT NULL,
    variation_name_snapshot TEXT NOT NULL,
    equipment_snapshot TEXT NOT NULL,
    manufacturer_snapshot TEXT NOT NULL DEFAULT '',
    label_snapshot TEXT NOT NULL DEFAULT '',
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


CATALOG = (
    ("Bench Press", "Standard", "repetitions", ("Barbell", "Dumbbell", "Machine")),
    ("Bench Press", "Incline", "repetitions", ("Barbell", "Dumbbell", "Machine")),
    ("Squat", "Back Squat", "repetitions", ("Barbell", "Machine")),
    ("Deadlift", "Conventional", "repetitions", ("Barbell",)),
    ("Lat Pulldown", "Standard", "repetitions", ("Machine", "Cable")),
    ("Row", "Seated", "repetitions", ("Cable", "Machine")),
    ("Shoulder Press", "Seated", "repetitions", ("Dumbbell", "Machine")),
    ("Biceps Curl", "Standing", "repetitions", ("Dumbbell", "Barbell", "Cable")),
    ("Triceps Pushdown", "Standard", "repetitions", ("Cable", "Rope")),
    ("Plank", "Front Plank", "duration", ("Bodyweight",)),
    # Assisted variations record the machine counterweight as negative weight.
    ("Pull-up", "Assisted", "repetitions", ("Machine",), True),
    ("Dip", "Assisted", "repetitions", ("Machine",), True),
)


def connect(path: str | Path) -> sqlite3.Connection:
    db_path = Path(path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path, timeout=10, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize(connection: sqlite3.Connection) -> None:
    connection.executescript(SCHEMA)
    migrate(connection)
    for exercise_name, variation_name, tracking_type, equipment_values, *assisted in CATALOG:
        connection.execute(
            "INSERT OR IGNORE INTO exercises(name) VALUES (?)", (exercise_name,)
        )
        exercise_id = connection.execute(
            "SELECT id FROM exercises WHERE name = ?", (exercise_name,)
        ).fetchone()["id"]
        connection.execute(
            """INSERT OR IGNORE INTO exercise_variations
               (exercise_id, name, tracking_type, assisted) VALUES (?, ?, ?, ?)""",
            (exercise_id, variation_name, tracking_type, int(any(assisted))),
        )
        variation_id = connection.execute(
            """SELECT id FROM exercise_variations
               WHERE exercise_id = ? AND name = ?""",
            (exercise_id, variation_name),
        ).fetchone()["id"]
        for position, equipment in enumerate(equipment_values):
            connection.execute(
                """INSERT OR IGNORE INTO variation_equipment
                   (variation_id, equipment, position) VALUES (?, ?, ?)""",
                (variation_id, equipment, position),
            )
    connection.commit()


def migrate(connection: sqlite3.Connection) -> None:
    """Upgrade existing databases without replacing workout records."""
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    if version < 1:
        with connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "ALTER TABLE workout_exercises ADD COLUMN tracking_type_snapshot TEXT"
            )
            connection.execute(
                """UPDATE workout_exercises SET tracking_type_snapshot = (
                   SELECT tracking_type FROM exercise_variations
                   WHERE id = workout_exercises.variation_id)"""
            )
            connection.execute("""CREATE TABLE workout_sets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workout_exercise_id INTEGER NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,
                position INTEGER NOT NULL CHECK (position > 0),
                weight REAL,
                result INTEGER CHECK (result > 0),
                completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
                CHECK (completed = 0 OR result IS NOT NULL),
                UNIQUE(workout_exercise_id, position)
            )""")
            connection.execute("PRAGMA user_version = 1")
    if version < 2:
        with connection:
            connection.execute("BEGIN IMMEDIATE")
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(exercise_variations)")}
            if "assisted" not in columns:
                connection.execute(
                    """ALTER TABLE exercise_variations ADD COLUMN
                       assisted INTEGER NOT NULL DEFAULT 0 CHECK (assisted IN (0, 1))"""
                )
            connection.execute("PRAGMA user_version = 2")


def rows(cursor: sqlite3.Cursor) -> list[dict[str, Any]]:
    return [dict(row) for row in cursor.fetchall()]


def bootstrap(connection: sqlite3.Connection) -> dict[str, Any]:
    gyms = rows(connection.execute("SELECT id, name FROM gyms ORDER BY name"))
    active = connection.execute(
        """SELECT w.id, w.started_at, g.id AS gym_id, g.name AS gym_name
           FROM workouts w JOIN gyms g ON g.id = w.gym_id
           WHERE w.completed_at IS NULL"""
    ).fetchone()
    active_workout = dict(active) if active else None
    workout_exercises: list[dict[str, Any]] = []
    if active_workout:
        workout_exercises = rows(
            connection.execute(
                """SELECT id, variation_id, position, tracking_type_snapshot AS tracking_type,
                          exercise_name_snapshot AS exercise_name,
                          variation_name_snapshot AS variation_name,
                          equipment_snapshot AS equipment,
                          manufacturer_snapshot AS manufacturer,
                          label_snapshot AS label,
                          (SELECT assisted FROM exercise_variations
                           WHERE id = workout_exercises.variation_id) AS assisted
                   FROM workout_exercises WHERE workout_id = ? ORDER BY position""",
                (active_workout["id"],),
            )
        )
    for entry in workout_exercises:
        entry["sets"] = sets_for_exercise(connection, entry["id"])
        previous = connection.execute(
            """SELECT we.id FROM workout_exercises we
               JOIN workouts w ON w.id = we.workout_id
               WHERE w.completed_at IS NOT NULL AND w.gym_id = ?
                 AND we.variation_id = ? AND we.equipment_snapshot = ?
                 AND we.manufacturer_snapshot = ? AND we.label_snapshot = ?
                 AND we.tracking_type_snapshot = ?
               ORDER BY w.completed_at DESC, w.id DESC, we.position DESC LIMIT 1""",
            (active_workout["gym_id"], entry["variation_id"], entry["equipment"],
             entry["manufacturer"], entry["label"], entry["tracking_type"]),
        ).fetchone()
        entry["previous_sets"] = [
            item for item in sets_for_exercise(connection, previous["id"]) if item["completed"]
        ] if previous else []
    return {
        "gyms": gyms,
        "active_workout": active_workout,
        "workout_exercises": workout_exercises,
    }


def catalog_for_gym(connection: sqlite3.Connection, gym_id: int) -> dict[str, Any]:
    catalog_rows = connection.execute(
        """SELECT v.id, e.name AS exercise_name, v.name AS variation_name,
                  v.tracking_type, v.assisted,
                  (SELECT GROUP_CONCAT(ordered.equipment, '|')
                   FROM (SELECT equipment FROM variation_equipment
                         WHERE variation_id = v.id ORDER BY position) AS ordered) AS equipment
           FROM exercise_variations v
           JOIN exercises e ON e.id = v.exercise_id
           ORDER BY e.name, v.name"""
    ).fetchall()
    catalog = []
    for row in catalog_rows:
        item = dict(row)
        item["equipment"] = item["equipment"].split("|")
        catalog.append(item)

    recent = rows(
        connection.execute(
            """SELECT p.id AS profile_id, p.variation_id, e.name AS exercise_name,
                      v.name AS variation_name, p.equipment, p.manufacturer, p.label,
                      MAX(we.added_at) AS last_used, COUNT(we.id) AS use_count
               FROM gym_exercise_profiles p
               JOIN exercise_variations v ON v.id = p.variation_id
               JOIN exercises e ON e.id = v.exercise_id
               LEFT JOIN workout_exercises we ON we.gym_profile_id = p.id
               WHERE p.gym_id = ?
               GROUP BY p.id
               ORDER BY last_used DESC, use_count DESC, e.name
               LIMIT 8""",
            (gym_id,),
        )
    )
    return {"catalog": catalog, "recent": recent}


def workout_history(connection: sqlite3.Connection, gym_id: str = "", start: str = "",
                    end: str = "", offset: str = "0") -> dict[str, Any]:
    """Page completed workouts, filtering by their UTC start date."""
    clauses = ["w.completed_at IS NOT NULL"]
    parameters: list[Any] = []
    if gym_id:
        gym = int(gym_id)
        if not 1 <= gym <= 9223372036854775807:
            raise ValueError("A valid gym_id is required.")
        clauses.append("w.gym_id = ?")
        parameters.append(gym)
    for value in (start, end):
        if value and (len(value) != 10 or date.fromisoformat(value).isoformat() != value):
            raise ValueError("Dates must use YYYY-MM-DD.")
    if start and end and start > end:
        raise ValueError("From date must not be after To date.")
    if start:
        clauses.append("w.started_at >= ?")
        parameters.append(start)
    if end:
        clauses.append("w.started_at < ?")
        try:
            parameters.append((date.fromisoformat(end) + timedelta(days=1)).isoformat())
        except OverflowError:
            raise ValueError("To date must be before 9999-12-31.") from None
    page_offset = int(offset)
    if not 0 <= page_offset <= 1000000:
        raise ValueError("Invalid history offset.")
    items = rows(connection.execute(
        f"""SELECT w.id, w.started_at, w.completed_at, w.gym_id, g.name AS gym_name,
                   (SELECT COUNT(*) FROM workout_exercises e WHERE e.workout_id = w.id) AS exercise_count,
                   (SELECT COUNT(*) FROM workout_sets s JOIN workout_exercises e
                    ON e.id = s.workout_exercise_id WHERE e.workout_id = w.id AND s.completed = 1) AS completed_set_count
            FROM workouts w JOIN gyms g ON g.id = w.gym_id
            WHERE {' AND '.join(clauses)}
            ORDER BY w.started_at DESC, w.id DESC LIMIT 21 OFFSET ?""",
        (*parameters, page_offset),
    ))
    return {"workouts": items[:20], "next_offset": page_offset + 20 if len(items) > 20 else None}


def completed_workout(connection: sqlite3.Connection, workout_id: int) -> dict[str, Any]:
    if not 1 <= workout_id <= 9223372036854775807:
        raise LookupError("Completed workout not found.")
    workout = connection.execute(
        """SELECT w.id, w.started_at, w.completed_at, w.gym_id, g.name AS gym_name
           FROM workouts w JOIN gyms g ON g.id = w.gym_id
           WHERE w.id = ? AND w.completed_at IS NOT NULL""", (workout_id,),
    ).fetchone()
    if not workout:
        raise LookupError("Completed workout not found.")
    entries = rows(connection.execute(
        """SELECT id, variation_id, position, exercise_name_snapshot AS exercise_name,
                  variation_name_snapshot AS variation_name, equipment_snapshot AS equipment,
                  manufacturer_snapshot AS manufacturer, label_snapshot AS label,
                  tracking_type_snapshot AS tracking_type,
                  (SELECT assisted FROM exercise_variations
                   WHERE id = workout_exercises.variation_id) AS assisted
           FROM workout_exercises WHERE workout_id = ? ORDER BY position""", (workout_id,),
    ))
    for entry in entries:
        entry["sets"] = sets_for_exercise(connection, entry["id"])
    return {"workout": dict(workout), "workout_exercises": entries}


def create_gym(connection: sqlite3.Connection, name: str) -> dict[str, Any]:
    clean_name = " ".join(name.split())
    if not clean_name:
        raise ValueError("Gym name is required.")
    if len(clean_name) > 80:
        raise ValueError("Gym name must be 80 characters or fewer.")
    cursor = connection.execute("INSERT INTO gyms(name) VALUES (?)", (clean_name,))
    connection.commit()
    return {"id": cursor.lastrowid, "name": clean_name}


def create_exercise(
    connection: sqlite3.Connection,
    name: str,
    variation_name: str,
    tracking_type: str,
    equipment: list[str],
    assisted: bool = False,
) -> dict[str, Any]:
    """Add a variation to a new or existing exercise in one transaction."""
    if not isinstance(name, str) or not isinstance(variation_name, str):
        raise ValueError("Exercise and variation names must be strings.")
    exercise_name = " ".join(name.split())
    variation_name = " ".join(variation_name.split()) or "Standard"
    if not exercise_name or len(exercise_name) > 80:
        raise ValueError("Exercise name must be 1 to 80 characters.")
    if len(variation_name) > 80:
        raise ValueError("Variation name must be 80 characters or fewer.")
    if tracking_type not in ("repetitions", "duration"):
        raise ValueError("Tracking type must be repetitions or duration.")
    if type(assisted) is not bool:
        raise ValueError("Assisted must be true or false.")
    if not isinstance(equipment, list) or not 1 <= len(equipment) <= 20:
        raise ValueError("Choose 1 to 20 equipment options.")
    clean_equipment = []
    for value in equipment:
        if not isinstance(value, str):
            raise ValueError("Equipment names must be strings.")
        clean = " ".join(value.split())
        if not clean or len(clean) > 80 or "|" in clean:
            raise ValueError("Equipment names must be 1 to 80 characters and cannot contain |.")
        clean_equipment.append(clean)
    if len({value.casefold() for value in clean_equipment}) != len(clean_equipment):
        raise ValueError("Equipment options must be unique.")

    with connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("INSERT OR IGNORE INTO exercises(name) VALUES (?)", (exercise_name,))
        exercise = connection.execute(
            "SELECT id, name FROM exercises WHERE name = ? COLLATE NOCASE", (exercise_name,)
        ).fetchone()
        if connection.execute(
            """SELECT 1 FROM exercise_variations
               WHERE exercise_id = ? AND name = ? COLLATE NOCASE""",
            (exercise["id"], variation_name),
        ).fetchone():
            raise RuntimeError("That exercise variation already exists.")
        cursor = connection.execute(
            """INSERT INTO exercise_variations(exercise_id, name, tracking_type, assisted)
               VALUES (?, ?, ?, ?)""",
            (exercise["id"], variation_name, tracking_type, int(assisted)),
        )
        for position, option in enumerate(clean_equipment):
            connection.execute(
                """INSERT INTO variation_equipment(variation_id, equipment, position)
                   VALUES (?, ?, ?)""",
                (cursor.lastrowid, option, position),
            )
    return {
        "id": cursor.lastrowid,
        "exercise_name": exercise["name"],
        "variation_name": variation_name,
        "tracking_type": tracking_type,
        "assisted": int(assisted),
        "equipment": clean_equipment,
    }


def start_workout(connection: sqlite3.Connection, gym_id: int) -> dict[str, Any]:
    gym = connection.execute("SELECT id, name FROM gyms WHERE id = ?", (gym_id,)).fetchone()
    if not gym:
        raise LookupError("Gym not found.")
    if connection.execute(
        "SELECT 1 FROM workouts WHERE completed_at IS NULL"
    ).fetchone():
        raise RuntimeError("A workout is already active.")
    cursor = connection.execute("INSERT INTO workouts(gym_id) VALUES (?)", (gym_id,))
    connection.commit()
    workout = connection.execute(
        "SELECT id, started_at FROM workouts WHERE id = ?", (cursor.lastrowid,)
    ).fetchone()
    return {
        "id": workout["id"],
        "started_at": workout["started_at"],
        "gym_id": gym["id"],
        "gym_name": gym["name"],
    }


def repeat_workout(connection: sqlite3.Connection, workout_id: int) -> dict[str, Any]:
    """Start a new workout with the source configurations and blank set slots."""
    if not 1 <= workout_id <= 9223372036854775807:
        raise LookupError("Completed workout not found.")
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        source = connection.execute(
            """SELECT w.gym_id, g.name AS gym_name FROM workouts w
               JOIN gyms g ON g.id = w.gym_id
               WHERE w.id = ? AND w.completed_at IS NOT NULL""",
            (workout_id,),
        ).fetchone()
        if not source:
            raise LookupError("Completed workout not found.")
        if connection.execute(
            "SELECT 1 FROM workouts WHERE completed_at IS NULL"
        ).fetchone():
            raise RuntimeError("A workout is already active.")
        workout_cursor = connection.execute(
            "INSERT INTO workouts(gym_id) VALUES (?)", (source["gym_id"],)
        )
        new_workout_id = workout_cursor.lastrowid
        source_entries = connection.execute(
            """SELECT id, variation_id, gym_profile_id, position,
                      exercise_name_snapshot, variation_name_snapshot,
                      equipment_snapshot, manufacturer_snapshot, label_snapshot,
                      tracking_type_snapshot
               FROM workout_exercises WHERE workout_id = ? ORDER BY position""",
            (workout_id,),
        ).fetchall()
        for entry in source_entries:
            entry_cursor = connection.execute(
                """INSERT INTO workout_exercises
                   (workout_id, variation_id, gym_profile_id, position,
                    exercise_name_snapshot, variation_name_snapshot,
                    equipment_snapshot, manufacturer_snapshot, label_snapshot,
                    tracking_type_snapshot)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (new_workout_id, *(entry[key] for key in (
                    "variation_id", "gym_profile_id", "position",
                    "exercise_name_snapshot", "variation_name_snapshot",
                    "equipment_snapshot", "manufacturer_snapshot", "label_snapshot",
                    "tracking_type_snapshot",
                ))),
            )
            positions = [row["position"] for row in connection.execute(
                """SELECT position FROM workout_sets
                   WHERE workout_exercise_id = ? ORDER BY position""",
                (entry["id"],),
            )]
            for position in positions or [1]:
                connection.execute(
                    """INSERT INTO workout_sets(workout_exercise_id, position)
                       VALUES (?, ?)""",
                    (entry_cursor.lastrowid, position),
                )
        workout = connection.execute(
            "SELECT id, started_at FROM workouts WHERE id = ?", (new_workout_id,)
        ).fetchone()
    return {
        "id": workout["id"],
        "started_at": workout["started_at"],
        "gym_id": source["gym_id"],
        "gym_name": source["gym_name"],
    }


def exercise_progress(
    connection: sqlite3.Connection, variation_id: int, gym_id: int | None = None,
    equipment: str | None = None, manufacturer: str | None = None,
    label: str | None = None,
) -> dict[str, Any]:
    if not 1 <= variation_id <= 9223372036854775807:
        raise ValueError("A valid variation_id is required.")
    if gym_id is not None and not 1 <= gym_id <= 9223372036854775807:
        raise ValueError("A valid gym_id is required.")
    variation = connection.execute(
        """SELECT v.id, e.name AS exercise_name, v.name AS variation_name,
                  v.tracking_type
           FROM exercise_variations v JOIN exercises e ON e.id = v.exercise_id
           WHERE v.id = ?""",
        (variation_id,),
    ).fetchone()
    if not variation:
        raise LookupError("Exercise variation not found.")
    points = rows(connection.execute(
        """SELECT w.id AS workout_id, w.completed_at,
                  MAX(s.weight) AS best_weight, MAX(s.result) AS best_result,
                  COUNT(s.id) AS completed_sets
           FROM workouts w
           JOIN workout_exercises e ON e.workout_id = w.id
           JOIN workout_sets s ON s.workout_exercise_id = e.id
           WHERE w.completed_at IS NOT NULL AND e.variation_id = ?
             AND s.completed = 1 AND (? IS NULL OR w.gym_id = ?)
             AND (? IS NULL OR e.equipment_snapshot = ?)
             AND (? IS NULL OR e.manufacturer_snapshot = ?)
             AND (? IS NULL OR e.label_snapshot = ?)
           GROUP BY w.id ORDER BY w.completed_at, w.id""",
        (variation_id, gym_id, gym_id, equipment, equipment,
         manufacturer, manufacturer, label, label),
    ))
    return {
        "variation_id": variation["id"],
        "exercise_name": variation["exercise_name"],
        "variation_name": variation["variation_name"],
        "tracking_type": variation["tracking_type"],
        "points": points,
    }


def add_workout_exercise(
    connection: sqlite3.Connection,
    workout_id: int,
    variation_id: int,
    equipment: str,
    manufacturer: str = "",
    label: str = "",
) -> dict[str, Any]:
    workout = connection.execute(
        "SELECT id, gym_id FROM workouts WHERE id = ? AND completed_at IS NULL",
        (workout_id,),
    ).fetchone()
    if not workout:
        raise LookupError("Active workout not found.")
    variation = connection.execute(
        """SELECT v.id, v.tracking_type, v.name AS variation_name, e.name AS exercise_name
           FROM exercise_variations v JOIN exercises e ON e.id = v.exercise_id
           WHERE v.id = ?""",
        (variation_id,),
    ).fetchone()
    if not variation:
        raise LookupError("Exercise variation not found.")
    allowed = connection.execute(
        "SELECT 1 FROM variation_equipment WHERE variation_id = ? AND equipment = ?",
        (variation_id, equipment),
    ).fetchone()
    if not allowed:
        raise ValueError("That equipment is not available for this exercise.")

    manufacturer = " ".join(manufacturer.split())[:80]
    label = " ".join(label.split())[:80]
    connection.execute(
        """INSERT OR IGNORE INTO gym_exercise_profiles
           (gym_id, variation_id, equipment, manufacturer, label)
           VALUES (?, ?, ?, ?, ?)""",
        (workout["gym_id"], variation_id, equipment, manufacturer, label),
    )
    profile = connection.execute(
        """SELECT id FROM gym_exercise_profiles
           WHERE gym_id = ? AND variation_id = ? AND equipment = ?
             AND manufacturer = ? AND label = ?""",
        (workout["gym_id"], variation_id, equipment, manufacturer, label),
    ).fetchone()
    position = connection.execute(
        "SELECT COALESCE(MAX(position), 0) + 1 AS next FROM workout_exercises WHERE workout_id = ?",
        (workout_id,),
    ).fetchone()["next"]
    cursor = connection.execute(
        """INSERT INTO workout_exercises
           (workout_id, variation_id, gym_profile_id, position,
            exercise_name_snapshot, variation_name_snapshot, equipment_snapshot,
            manufacturer_snapshot, label_snapshot, tracking_type_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            workout_id,
            variation_id,
            profile["id"],
            position,
            variation["exercise_name"],
            variation["variation_name"],
            equipment,
            manufacturer,
            label,
            variation["tracking_type"],
        ),
    )
    connection.execute("INSERT INTO workout_sets(workout_exercise_id, position) VALUES (?, 1)", (cursor.lastrowid,))
    connection.commit()
    return {
        "id": cursor.lastrowid,
        "position": position,
        "exercise_name": variation["exercise_name"],
        "variation_name": variation["variation_name"],
        "equipment": equipment,
        "manufacturer": manufacturer,
        "label": label,
    }


def add_recent_profile(
    connection: sqlite3.Connection, workout_id: int, profile_id: int
) -> dict[str, Any]:
    workout = connection.execute(
        "SELECT gym_id FROM workouts WHERE id = ? AND completed_at IS NULL",
        (workout_id,),
    ).fetchone()
    if not workout:
        raise LookupError("Active workout not found.")
    profile = connection.execute(
        """SELECT variation_id, equipment, manufacturer, label
           FROM gym_exercise_profiles WHERE id = ? AND gym_id = ?""",
        (profile_id, workout["gym_id"]),
    ).fetchone()
    if not profile:
        raise LookupError("Exercise configuration not found.")
    return add_workout_exercise(
        connection,
        workout_id,
        profile["variation_id"],
        profile["equipment"],
        profile["manufacturer"],
        profile["label"],
    )


def complete_workout(connection: sqlite3.Connection, workout_id: int) -> None:
    cursor = connection.execute(
        """UPDATE workouts SET completed_at = CURRENT_TIMESTAMP
           WHERE id = ? AND completed_at IS NULL""",
        (workout_id,),
    )
    if not cursor.rowcount:
        raise LookupError("Active workout not found.")
    connection.commit()


def cancel_workout(connection: sqlite3.Connection, workout_id: int) -> dict[str, bool]:
    with connection:
        cursor = connection.execute(
            "DELETE FROM workouts WHERE id = ? AND completed_at IS NULL",
            (workout_id,),
        )
        if not cursor.rowcount:
            raise LookupError("Active workout not found.")
    return {"ok": True}


def sets_for_exercise(connection: sqlite3.Connection, exercise_id: int) -> list[dict[str, Any]]:
    return rows(connection.execute(
        "SELECT id, position, weight, result, completed FROM workout_sets WHERE workout_exercise_id = ? ORDER BY position",
        (exercise_id,),
    ))


def require_active_exercise(connection: sqlite3.Connection, exercise_id: int) -> None:
    if not connection.execute(
        """SELECT 1 FROM workout_exercises e JOIN workouts w ON w.id = e.workout_id
           WHERE e.id = ? AND w.completed_at IS NULL""", (exercise_id,),
    ).fetchone():
        raise LookupError("Active workout exercise not found.")


# Tables whose rows are numbered 1..n by position within a parent row.
POSITIONED_TABLES = {"workout_exercises": "workout_id", "workout_sets": "workout_exercise_id"}


def renumber_positions(
    connection: sqlite3.Connection, table: str, parent_id: int,
    ordered_ids: list[int] | None = None,
) -> None:
    """Number a parent's rows 1..n in ordered_ids order, or their current order.

    Works for active and completed workouts; the caller owns the transaction.
    """
    parent_column = POSITIONED_TABLES[table]
    current = connection.execute(
        f"SELECT id, position FROM {table} WHERE {parent_column} = ? ORDER BY position, id",
        (parent_id,),
    ).fetchall()
    ids = [row["id"] for row in current] if ordered_ids is None else ordered_ids
    # Move every row above the current maximum first so UNIQUE positions never collide.
    offset = max((row["position"] for row in current), default=0)
    for step in (offset, 0):
        for index, row_id in enumerate(ids, 1):
            connection.execute(f"UPDATE {table} SET position = ? WHERE id = ?", (step + index, row_id))


def delete_workout_exercise(connection: sqlite3.Connection, exercise_id: int) -> None:
    """Delete a Workout Exercise and its sets, then close the position gap.

    Works for active and completed workouts; the caller owns the transaction.
    """
    entry = connection.execute(
        "SELECT workout_id FROM workout_exercises WHERE id = ?", (exercise_id,)
    ).fetchone()
    if not entry:
        raise LookupError("Workout exercise not found.")
    connection.execute("DELETE FROM workout_sets WHERE workout_exercise_id = ?", (exercise_id,))
    connection.execute("DELETE FROM workout_exercises WHERE id = ?", (exercise_id,))
    renumber_positions(connection, "workout_exercises", entry["workout_id"])


def remove_workout_exercise(connection: sqlite3.Connection, exercise_id: int) -> dict[str, bool]:
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        require_active_exercise(connection, exercise_id)
        delete_workout_exercise(connection, exercise_id)
    return {"ok": True}


def move_workout_exercise(
    connection: sqlite3.Connection, exercise_id: int, position: int
) -> dict[str, Any]:
    """Move an active Workout Exercise to a 1-based position, shifting the others."""
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        require_active_exercise(connection, exercise_id)
        workout_id = connection.execute(
            "SELECT workout_id FROM workout_exercises WHERE id = ?", (exercise_id,)
        ).fetchone()["workout_id"]
        ids = [row["id"] for row in connection.execute(
            "SELECT id FROM workout_exercises WHERE workout_id = ? ORDER BY position, id",
            (workout_id,),
        )]
        if type(position) is not int or not 1 <= position <= len(ids):
            raise ValueError(f"Position must be a whole number from 1 to {len(ids)}.")
        ids.remove(exercise_id)
        ids.insert(position - 1, exercise_id)
        renumber_positions(connection, "workout_exercises", workout_id, ids)
    return {"workout_exercises": [
        {"id": row_id, "position": index} for index, row_id in enumerate(ids, 1)
    ]}


def add_set(connection: sqlite3.Connection, exercise_id: int) -> dict[str, Any]:
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        require_active_exercise(connection, exercise_id)
        cursor = connection.execute(
            """INSERT INTO workout_sets(workout_exercise_id, position)
               SELECT ?, COALESCE(MAX(position), 0) + 1 FROM workout_sets WHERE workout_exercise_id = ?""",
            (exercise_id, exercise_id),
        )
        return dict(connection.execute("SELECT id, position, weight, result, completed FROM workout_sets WHERE id = ?", (cursor.lastrowid,)).fetchone())


def validate_set_values(payload: dict) -> tuple[int | float | None, int | None, bool]:
    weight, result, completed = (payload.get(key) for key in ("weight", "result", "completed"))
    if weight is not None and (type(weight) not in (int, float) or not math.isfinite(weight) or abs(weight) > 100000):
        raise ValueError("Weight must be a finite number between -100000 and 100000 kg.")
    if result is not None and (type(result) is not int or not 1 <= result <= 1000000):
        raise ValueError("Reps or seconds must be a whole number between 1 and 1000000.")
    if type(completed) is not bool:
        raise ValueError("Completed must be true or false.")
    if completed and result is None:
        raise ValueError("Enter reps or seconds before completing this set.")
    return weight, result, completed


def variation_assisted(connection: sqlite3.Connection, set_id: int) -> bool:
    row = connection.execute(
        """SELECT v.assisted FROM workout_sets s
           JOIN workout_exercises e ON e.id = s.workout_exercise_id
           JOIN exercise_variations v ON v.id = e.variation_id
           WHERE s.id = ?""", (set_id,),
    ).fetchone()
    return bool(row and row["assisted"])


def assisted_weight(weight: int | float | None, assisted: bool) -> int | float | None:
    """Assisted variations always store their counterweight as a negative weight."""
    return -abs(weight) if assisted and weight else weight


def update_set(connection: sqlite3.Connection, set_id: int, payload: dict) -> dict[str, Any]:
    weight, result, completed = validate_set_values(payload)
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        item = connection.execute("SELECT workout_exercise_id FROM workout_sets WHERE id = ?", (set_id,)).fetchone()
        if not item:
            raise LookupError("Set not found.")
        require_active_exercise(connection, item["workout_exercise_id"])
        weight = assisted_weight(weight, variation_assisted(connection, set_id))
        connection.execute("UPDATE workout_sets SET weight = ?, result = ?, completed = ? WHERE id = ?", (weight, result, completed, set_id))
        return dict(connection.execute("SELECT id, position, weight, result, completed FROM workout_sets WHERE id = ?", (set_id,)).fetchone())


def correct_completed_set(
    connection: sqlite3.Connection, workout_id: int, set_id: int, payload: dict
) -> dict[str, Any]:
    """Correct a set only when it belongs to the specified completed workout."""
    if not 1 <= workout_id <= 9223372036854775807 or not 1 <= set_id <= 9223372036854775807:
        raise LookupError("Completed workout set not found.")
    weight, result, completed = validate_set_values(payload)
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        if not connection.execute(
            """SELECT 1 FROM workout_sets s
               JOIN workout_exercises e ON e.id = s.workout_exercise_id
               JOIN workouts w ON w.id = e.workout_id
               WHERE s.id = ? AND w.id = ? AND w.completed_at IS NOT NULL""",
            (set_id, workout_id),
        ).fetchone():
            raise LookupError("Completed workout set not found.")
        weight = assisted_weight(weight, variation_assisted(connection, set_id))
        connection.execute(
            """UPDATE workout_sets SET weight = ?, result = ?, completed = ?
               WHERE id = ?""",
            (weight, result, completed, set_id),
        )
        return dict(connection.execute(
            """SELECT id, position, weight, result, completed
               FROM workout_sets WHERE id = ?""", (set_id,),
        ).fetchone())


def delete_set(connection: sqlite3.Connection, set_id: int) -> dict[str, bool]:
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        item = connection.execute("SELECT workout_exercise_id FROM workout_sets WHERE id = ?", (set_id,)).fetchone()
        if not item:
            raise LookupError("Set not found.")
        require_active_exercise(connection, item["workout_exercise_id"])
        connection.execute("DELETE FROM workout_sets WHERE id = ?", (set_id,))
    return {"ok": True}
