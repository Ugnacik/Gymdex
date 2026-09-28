from __future__ import annotations

import math
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable


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
    # Bodyweight variations record optional weight as added load.
    ("Pull-up", "Standard", "repetitions", ("Bodyweight",)),
    ("Dip", "Standard", "repetitions", ("Bodyweight",)),
    ("Push-up", "Standard", "repetitions", ("Bodyweight",)),
    ("Leg Press", "Standard", "repetitions", ("Machine",)),
    ("Leg Curl", "Seated", "repetitions", ("Machine",)),
    ("Leg Curl", "Lying", "repetitions", ("Machine",)),
    ("Leg Extension", "Standard", "repetitions", ("Machine",)),
    ("Lunge", "Standard", "repetitions", ("Dumbbell", "Barbell", "Bodyweight")),
    ("Deadlift", "Romanian", "repetitions", ("Barbell", "Dumbbell")),
    ("Hip Thrust", "Standard", "repetitions", ("Barbell", "Machine")),
    ("Lateral Raise", "Standard", "repetitions", ("Dumbbell", "Cable", "Machine")),
    ("Face Pull", "Standard", "repetitions", ("Cable",)),
    ("Calf Raise", "Standing", "repetitions", ("Machine", "Bodyweight", "Dumbbell")),
    ("Calf Raise", "Seated", "repetitions", ("Machine",)),
    ("Chest Fly", "Standard", "repetitions", ("Machine", "Cable", "Dumbbell")),
    ("Crunch", "Standard", "repetitions", ("Bodyweight", "Cable", "Machine")),
    ("Leg Raise", "Hanging", "repetitions", ("Bodyweight",)),
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
        # Seed only missing variations, so existing catalog entries and
        # user-created variations with the same name keep their equipment.
        if connection.execute(
            """SELECT 1 FROM exercise_variations
               WHERE exercise_id = ? AND name = ? COLLATE NOCASE""",
            (exercise_id, variation_name),
        ).fetchone():
            continue
        variation_id = connection.execute(
            """INSERT INTO exercise_variations
               (exercise_id, name, tracking_type, assisted) VALUES (?, ?, ?, ?)""",
            (exercise_id, variation_name, tracking_type, int(any(assisted))),
        ).lastrowid
        for position, equipment in enumerate(equipment_values):
            connection.execute(
                """INSERT INTO variation_equipment
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
    if version < 3:
        with connection:
            connection.execute("BEGIN IMMEDIATE")
            for table in ("workouts", "workout_exercises"):
                columns = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}
                if "note" not in columns:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN note TEXT NOT NULL DEFAULT ''")
            connection.execute("PRAGMA user_version = 3")
    if version < 4:
        with connection:
            connection.execute("BEGIN IMMEDIATE")
            # archived_at is NULL for items offered for new Workouts; see "Archived" in CONTEXT.md.
            for table in ("gyms", "gym_exercise_profiles", "exercise_variations"):
                columns = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}
                if "archived_at" not in columns:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN archived_at TEXT")
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(exercise_variations)")}
            if "custom" not in columns:
                connection.execute(
                    """ALTER TABLE exercise_variations ADD COLUMN
                       custom INTEGER NOT NULL DEFAULT 0 CHECK (custom IN (0, 1))"""
                )
            # Variations outside the starter catalog were created by the user. A created
            # variation that happens to share a starter name counts as catalog.
            starter = {(entry[0].casefold(), entry[1].casefold()) for entry in CATALOG}
            custom_ids = [
                (row["id"],) for row in connection.execute(
                    """SELECT v.id, e.name AS exercise_name, v.name AS variation_name
                       FROM exercise_variations v JOIN exercises e ON e.id = v.exercise_id"""
                )
                if (row["exercise_name"].casefold(), row["variation_name"].casefold()) not in starter
            ]
            connection.executemany("UPDATE exercise_variations SET custom = 1 WHERE id = ?", custom_ids)
            connection.execute("PRAGMA user_version = 4")


def rows(cursor: sqlite3.Cursor) -> list[dict[str, Any]]:
    return [dict(row) for row in cursor.fetchall()]


def bootstrap(connection: sqlite3.Connection) -> dict[str, Any]:
    gyms = rows(connection.execute("SELECT id, name FROM gyms WHERE archived_at IS NULL ORDER BY name"))
    # Archived gyms stay selectable where recorded workouts are browsed: history and progress.
    archived_gyms = rows(connection.execute(
        "SELECT id, name FROM gyms WHERE archived_at IS NOT NULL ORDER BY name"
    ))
    active = connection.execute(
        """SELECT w.id, w.started_at, w.note, g.id AS gym_id, g.name AS gym_name
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
                          label_snapshot AS label, note,
                          (SELECT assisted FROM exercise_variations
                           WHERE id = workout_exercises.variation_id) AS assisted
                   FROM workout_exercises WHERE workout_id = ? ORDER BY position""",
                (active_workout["id"],),
            )
        )
    for entry in workout_exercises:
        entry["sets"] = sets_for_exercise(connection, entry["id"])
        entry["previous_sets"] = previous_sets(
            connection, active_workout["gym_id"], entry["variation_id"], entry["equipment"],
            entry["manufacturer"], entry["label"], entry["tracking_type"],
        )
    return {
        "gyms": gyms,
        "archived_gyms": archived_gyms,
        "active_workout": active_workout,
        "workout_exercises": workout_exercises,
    }


def previous_sets(
    connection: sqlite3.Connection, gym_id: int, variation_id: int, equipment: str,
    manufacturer: str, label: str, tracking_type: str,
) -> list[dict[str, Any]]:
    """Completed sets of the last matching Workout Exercise in a completed workout."""
    previous = connection.execute(
        """SELECT we.id FROM workout_exercises we
           JOIN workouts w ON w.id = we.workout_id
           WHERE w.completed_at IS NOT NULL AND w.gym_id = ?
             AND we.variation_id = ? AND we.equipment_snapshot = ?
             AND we.manufacturer_snapshot = ? AND we.label_snapshot = ?
             AND we.tracking_type_snapshot = ?
           ORDER BY w.completed_at DESC, w.id DESC, we.position DESC LIMIT 1""",
        (gym_id, variation_id, equipment, manufacturer, label, tracking_type),
    ).fetchone()
    return [
        item for item in sets_for_exercise(connection, previous["id"]) if item["completed"]
    ] if previous else []


def catalog_for_gym(
    connection: sqlite3.Connection, gym_id: int, include_archived: bool = False,
) -> dict[str, Any]:
    """The picker's Variations and Recent. Progress includes archived Variations."""
    catalog_rows = connection.execute(
        """SELECT v.id, e.name AS exercise_name, v.name AS variation_name,
                  v.tracking_type, v.assisted, v.archived_at IS NOT NULL AS archived,
                  (SELECT GROUP_CONCAT(ordered.equipment, '|')
                   FROM (SELECT equipment FROM variation_equipment
                         WHERE variation_id = v.id ORDER BY position) AS ordered) AS equipment
           FROM exercise_variations v
           JOIN exercises e ON e.id = v.exercise_id
           WHERE ? OR v.archived_at IS NULL
           ORDER BY e.name, v.name""",
        (int(include_archived),),
    ).fetchall()
    catalog = []
    for row in catalog_rows:
        item = dict(row)
        item["equipment"] = item["equipment"].split("|")
        item["archived"] = bool(item["archived"])
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
               WHERE p.gym_id = ? AND p.archived_at IS NULL AND v.archived_at IS NULL
               GROUP BY p.id
               ORDER BY last_used DESC, use_count DESC, e.name
               LIMIT 8""",
            (gym_id,),
        )
    )
    return {"catalog": catalog, "recent": recent}


def _utc_timestamp(value: str) -> str:
    """Convert an ISO 8601 instant to the UTC format SQLite uses for CURRENT_TIMESTAMP."""
    try:
        moment = datetime.fromisoformat(value)
        if moment.tzinfo is None:
            raise ValueError
        moment = moment.astimezone(timezone.utc)
        if moment.microsecond:
            # Stored times have whole seconds; round up so the bound keeps its meaning.
            moment = moment.replace(microsecond=0) + timedelta(seconds=1)
    except (ValueError, OverflowError):
        raise ValueError("Date filters must be times with a time zone, such as 2026-09-21T22:00:00Z.") from None
    return moment.replace(tzinfo=None).isoformat(sep=" ")


def workout_history(connection: sqlite3.Connection, gym_id: str = "", start: str = "",
                    end: str = "", offset: str = "0") -> dict[str, Any]:
    """Page completed workouts started at or after start and before end.

    The bounds are ISO 8601 instants with a time zone, such as the UTC instants of
    the device's local midnights, so date filters follow the user's local days.
    """
    clauses = ["w.completed_at IS NOT NULL"]
    parameters: list[Any] = []
    if gym_id:
        gym = int(gym_id)
        if not 1 <= gym <= 9223372036854775807:
            raise ValueError("A valid gym_id is required.")
        clauses.append("w.gym_id = ?")
        parameters.append(gym)
    start_at, end_at = (_utc_timestamp(value) if value else "" for value in (start, end))
    if start_at and end_at and start_at >= end_at:
        raise ValueError("From date must not be after To date.")
    if start_at:
        clauses.append("w.started_at >= ?")
        parameters.append(start_at)
    if end_at:
        clauses.append("w.started_at < ?")
        parameters.append(end_at)
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
        """SELECT w.id, w.started_at, w.completed_at, w.note, w.gym_id, g.name AS gym_name,
                  g.archived_at IS NOT NULL AS gym_archived
           FROM workouts w JOIN gyms g ON g.id = w.gym_id
           WHERE w.id = ? AND w.completed_at IS NOT NULL""", (workout_id,),
    ).fetchone()
    if not workout:
        raise LookupError("Completed workout not found.")
    workout = {**dict(workout), "gym_archived": bool(workout["gym_archived"])}
    entries = rows(connection.execute(
        """SELECT id, variation_id, position, exercise_name_snapshot AS exercise_name,
                  variation_name_snapshot AS variation_name, equipment_snapshot AS equipment,
                  manufacturer_snapshot AS manufacturer, label_snapshot AS label,
                  tracking_type_snapshot AS tracking_type, note,
                  (SELECT assisted FROM exercise_variations
                   WHERE id = workout_exercises.variation_id) AS assisted
           FROM workout_exercises WHERE workout_id = ? ORDER BY position""", (workout_id,),
    ))
    for entry in entries:
        entry["sets"] = sets_for_exercise(connection, entry["id"])
    return {"workout": workout, "workout_exercises": entries}


def clean_gym_name(name: object) -> str:
    if not isinstance(name, str):
        raise ValueError("Gym name must be text.")
    clean_name = " ".join(name.split())
    if not clean_name:
        raise ValueError("Gym name is required.")
    if len(clean_name) > 80:
        raise ValueError("Gym name must be 80 characters or fewer.")
    return clean_name


def require_free_gym_name(connection: sqlite3.Connection, name: str, gym_id: int | None = None) -> None:
    """Gym names are unique ignoring case, archived gyms included; a gym may keep its own name."""
    taken = connection.execute(
        "SELECT name, archived_at FROM gyms WHERE name = ? AND id IS NOT ?", (name, gym_id),
    ).fetchone()
    if taken and taken["archived_at"]:
        raise RuntimeError(f"An archived gym is named {taken['name']}. Restore it in Manage.")
    if taken:
        raise RuntimeError(f"A gym named {taken['name']} already exists.")


def create_gym(connection: sqlite3.Connection, name: str) -> dict[str, Any]:
    clean_name = clean_gym_name(name)
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        require_free_gym_name(connection, clean_name)
        cursor = connection.execute("INSERT INTO gyms(name) VALUES (?)", (clean_name,))
    return {"id": cursor.lastrowid, "name": clean_name}


def require_unarchived_gym(name: str, archived_at: str | None) -> None:
    """New workouts, started or repeated, are refused at an archived gym."""
    if archived_at:
        raise RuntimeError(f"{name} is archived. Restore it in Manage to train there.")


def clean_equipment_list(equipment: object) -> list[str]:
    """A Variation's ordered Equipment values: 1 to 20, unique ignoring case."""
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
    return clean_equipment


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
    clean_equipment = clean_equipment_list(equipment)

    with connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("INSERT OR IGNORE INTO exercises(name) VALUES (?)", (exercise_name,))
        exercise = connection.execute(
            "SELECT id, name FROM exercises WHERE name = ? COLLATE NOCASE", (exercise_name,)
        ).fetchone()
        require_free_variation_name(connection, exercise["id"], variation_name)
        cursor = connection.execute(
            """INSERT INTO exercise_variations(exercise_id, name, tracking_type, assisted, custom)
               VALUES (?, ?, ?, ?, 1)""",
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
        "archived": False,
        "equipment": clean_equipment,
    }


def start_workout(connection: sqlite3.Connection, gym_id: int) -> dict[str, Any]:
    gym = connection.execute("SELECT id, name, archived_at FROM gyms WHERE id = ?", (gym_id,)).fetchone()
    if not gym:
        raise LookupError("Gym not found.")
    require_unarchived_gym(gym["name"], gym["archived_at"])
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
    """Start a new workout with the source configurations and blank set slots.

    Archived Variations and Exercise Configurations are skipped and counted.
    """
    if not 1 <= workout_id <= 9223372036854775807:
        raise LookupError("Completed workout not found.")
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        source = connection.execute(
            """SELECT w.gym_id, g.name AS gym_name, g.archived_at FROM workouts w
               JOIN gyms g ON g.id = w.gym_id
               WHERE w.id = ? AND w.completed_at IS NOT NULL""",
            (workout_id,),
        ).fetchone()
        if not source:
            raise LookupError("Completed workout not found.")
        require_unarchived_gym(source["gym_name"], source["archived_at"])
        if connection.execute(
            "SELECT 1 FROM workouts WHERE completed_at IS NULL"
        ).fetchone():
            raise RuntimeError("A workout is already active.")
        workout_cursor = connection.execute(
            "INSERT INTO workouts(gym_id) VALUES (?)", (source["gym_id"],)
        )
        new_workout_id = workout_cursor.lastrowid
        source_entries = connection.execute(
            """SELECT we.id, we.variation_id, we.gym_profile_id,
                      we.exercise_name_snapshot, we.variation_name_snapshot,
                      we.equipment_snapshot, we.manufacturer_snapshot, we.label_snapshot,
                      we.tracking_type_snapshot,
                      v.archived_at IS NOT NULL OR p.archived_at IS NOT NULL AS archived
               FROM workout_exercises we
               JOIN exercise_variations v ON v.id = we.variation_id
               LEFT JOIN gym_exercise_profiles p ON p.id = we.gym_profile_id
               WHERE we.workout_id = ? ORDER BY we.position""",
            (workout_id,),
        ).fetchall()
        # Archived Variations and Exercise Configurations are not offered for new
        # Workouts, so Repeat skips them and closes the gaps they leave.
        kept = [entry for entry in source_entries if not entry["archived"]]
        for position, entry in enumerate(kept, start=1):
            entry_cursor = connection.execute(
                """INSERT INTO workout_exercises
                   (workout_id, variation_id, gym_profile_id, position,
                    exercise_name_snapshot, variation_name_snapshot,
                    equipment_snapshot, manufacturer_snapshot, label_snapshot,
                    tracking_type_snapshot)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (new_workout_id, entry["variation_id"], entry["gym_profile_id"], position,
                 *(entry[key] for key in (
                    "exercise_name_snapshot", "variation_name_snapshot",
                    "equipment_snapshot", "manufacturer_snapshot", "label_snapshot",
                    "tracking_type_snapshot",
                 ))),
            )
            slots = [row["position"] for row in connection.execute(
                """SELECT position FROM workout_sets
                   WHERE workout_exercise_id = ? ORDER BY position""",
                (entry["id"],),
            )]
            for slot in slots or [1]:
                connection.execute(
                    """INSERT INTO workout_sets(workout_exercise_id, position)
                       VALUES (?, ?)""",
                    (entry_cursor.lastrowid, slot),
                )
        workout = connection.execute(
            "SELECT id, started_at FROM workouts WHERE id = ?", (new_workout_id,)
        ).fetchone()
    return {
        "id": workout["id"],
        "started_at": workout["started_at"],
        "gym_id": source["gym_id"],
        "gym_name": source["gym_name"],
        "skipped": len(source_entries) - len(kept),
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
    # Choosing an archived Exercise Configuration's combination again restores it.
    connection.execute(
        "UPDATE gym_exercise_profiles SET archived_at = NULL WHERE id = ?", (profile["id"],)
    )
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
    slots = len(previous_sets(
        connection, workout["gym_id"], variation_id, equipment, manufacturer, label,
        variation["tracking_type"],
    ))
    connection.executemany(
        "INSERT INTO workout_sets(workout_exercise_id, position) VALUES (?, ?)",
        [(cursor.lastrowid, slot) for slot in range(1, max(slots, 1) + 1)],
    )
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


NOTE_MAX_LENGTH = 1000


def clean_note(note: object) -> str:
    """A Note is optional free text; an empty string means no note."""
    if not isinstance(note, str):
        raise ValueError("Note must be text.")
    clean = note.strip()
    if len(clean) > NOTE_MAX_LENGTH:
        raise ValueError(f"Notes must be {NOTE_MAX_LENGTH} characters or fewer.")
    return clean


def _set_note(connection: sqlite3.Connection, table: str, row_id: int, note: object,
              missing: str) -> dict[str, Any]:
    """Save a note on an active or completed workout record."""
    clean = clean_note(note)
    if not 1 <= row_id <= 9223372036854775807:
        raise LookupError(missing)
    with connection:
        cursor = connection.execute(f"UPDATE {table} SET note = ? WHERE id = ?", (clean, row_id))
        if not cursor.rowcount:
            raise LookupError(missing)
    return {"id": row_id, "note": clean}


def set_workout_note(connection: sqlite3.Connection, workout_id: int, note: object) -> dict[str, Any]:
    return _set_note(connection, "workouts", workout_id, note, "Workout not found.")


def set_workout_exercise_note(
    connection: sqlite3.Connection, exercise_id: int, note: object
) -> dict[str, Any]:
    return _set_note(connection, "workout_exercises", exercise_id, note, "Workout exercise not found.")


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


def append_set(connection: sqlite3.Connection, exercise_id: int) -> dict[str, Any]:
    """Append a set that copies the weight and result of the set above, not completed.

    Works for active and completed workouts; the caller owns the transaction.
    """
    above = connection.execute(
        """SELECT position, weight, result FROM workout_sets
           WHERE workout_exercise_id = ? ORDER BY position DESC LIMIT 1""",
        (exercise_id,),
    ).fetchone()
    cursor = connection.execute(
        "INSERT INTO workout_sets(workout_exercise_id, position, weight, result) VALUES (?, ?, ?, ?)",
        (exercise_id, above["position"] + 1, above["weight"], above["result"]) if above else (exercise_id, 1, None, None),
    )
    return dict(connection.execute("SELECT id, position, weight, result, completed FROM workout_sets WHERE id = ?", (cursor.lastrowid,)).fetchone())


def add_set(connection: sqlite3.Connection, exercise_id: int) -> dict[str, Any]:
    """Append a set to an active Workout Exercise (see append_set)."""
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        require_active_exercise(connection, exercise_id)
        return append_set(connection, exercise_id)


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


def _require_completed_id(*ids: int) -> None:
    if not all(1 <= value <= 9223372036854775807 for value in ids):
        raise LookupError("Completed workout not found.")


def add_completed_set(
    connection: sqlite3.Connection, workout_id: int, exercise_id: int
) -> dict[str, Any]:
    """Append a set to a Workout Exercise of the specified completed workout.

    Like Add set in the active workout, it copies the set above and is not completed.
    """
    _require_completed_id(workout_id, exercise_id)
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        if not connection.execute(
            """SELECT 1 FROM workout_exercises e JOIN workouts w ON w.id = e.workout_id
               WHERE e.id = ? AND w.id = ? AND w.completed_at IS NOT NULL""",
            (exercise_id, workout_id),
        ).fetchone():
            raise LookupError("Completed workout exercise not found.")
        return append_set(connection, exercise_id)


def delete_completed_set(
    connection: sqlite3.Connection, workout_id: int, set_id: int
) -> dict[str, bool]:
    """Delete a set of the specified completed workout and renumber the remaining sets."""
    _require_completed_id(workout_id, set_id)
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        item = connection.execute(
            """SELECT s.workout_exercise_id FROM workout_sets s
               JOIN workout_exercises e ON e.id = s.workout_exercise_id
               JOIN workouts w ON w.id = e.workout_id
               WHERE s.id = ? AND w.id = ? AND w.completed_at IS NOT NULL""",
            (set_id, workout_id),
        ).fetchone()
        if not item:
            raise LookupError("Completed workout set not found.")
        connection.execute("DELETE FROM workout_sets WHERE id = ?", (set_id,))
        renumber_positions(connection, "workout_sets", item["workout_exercise_id"])
    return {"ok": True}


def delete_completed_workout(connection: sqlite3.Connection, workout_id: int) -> dict[str, bool]:
    """Delete a completed workout with its exercises and sets. Active workouts are refused."""
    _require_completed_id(workout_id)
    with connection:
        # Workout Exercises and their sets cascade with the workout, as in cancel_workout.
        cursor = connection.execute(
            "DELETE FROM workouts WHERE id = ? AND completed_at IS NOT NULL", (workout_id,),
        )
        if not cursor.rowcount:
            raise LookupError("Completed workout not found.")
    return {"ok": True}


def delete_set(connection: sqlite3.Connection, set_id: int) -> dict[str, bool]:
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        item = connection.execute("SELECT workout_exercise_id FROM workout_sets WHERE id = ?", (set_id,)).fetchone()
        if not item:
            raise LookupError("Set not found.")
        require_active_exercise(connection, item["workout_exercise_id"])
        connection.execute("DELETE FROM workout_sets WHERE id = ?", (set_id,))
    return {"ok": True}


# Manage: rename, remove and restore the items new Workouts are built from. Removing
# deletes a never-used item and archives a used one. An item is used when a surviving
# Workout, active or completed, refers to it (see "Archived" in CONTEXT.md).
# Each kind of item registers its rules in MANAGED_KINDS; rename_item, remove_item and
# restore_item are the only entry points and apply them in one transaction.


@dataclass(frozen=True)
class ManagedKind:
    table: str
    missing: str
    # Selects a row when a surviving Workout uses the item with the given id.
    used_sql: str
    # The item as manage_overview lists it.
    describe: Callable[[sqlite3.Connection, int], dict[str, Any]]
    # Validates and applies a new name. None means the kind cannot be renamed.
    rename: Callable[[sqlite3.Connection, int, object], None] | None = None
    # Deletes a never-used item and its dependents. None means the kind cannot be removed.
    delete: Callable[[sqlite3.Connection, int], None] | None = None
    # Raises to refuse archiving a used item, such as the Active Workout's gym.
    before_archive: Callable[[sqlite3.Connection, int], None] | None = None
    # Raises to refuse any change to the item, such as a starter catalog Variation.
    require_changeable: Callable[[sqlite3.Connection, int], None] | None = None


def _gym_rows(connection: sqlite3.Connection, gym_id: int | None = None) -> list[dict[str, Any]]:
    items = rows(connection.execute(
        """SELECT id, name, archived_at IS NOT NULL AS archived,
                  EXISTS (SELECT 1 FROM workouts WHERE gym_id = gyms.id) AS used
           FROM gyms WHERE ? IS NULL OR id = ? ORDER BY name, id""",
        (gym_id, gym_id),
    ))
    return [{**item, "archived": bool(item["archived"]), "used": bool(item["used"])} for item in items]


def _rename_gym(connection: sqlite3.Connection, gym_id: int, name: object) -> None:
    clean_name = clean_gym_name(name)
    require_free_gym_name(connection, clean_name, gym_id)
    connection.execute("UPDATE gyms SET name = ? WHERE id = ?", (clean_name, gym_id))


def _delete_gym(connection: sqlite3.Connection, gym_id: int) -> None:
    # A never-used gym's Exercise Configurations are never used either.
    connection.execute("DELETE FROM gym_exercise_profiles WHERE gym_id = ?", (gym_id,))
    connection.execute("DELETE FROM gyms WHERE id = ?", (gym_id,))


def _before_gym_archive(connection: sqlite3.Connection, gym_id: int) -> None:
    if connection.execute(
        "SELECT 1 FROM workouts WHERE gym_id = ? AND completed_at IS NULL", (gym_id,)
    ).fetchone():
        raise RuntimeError("Finish or cancel the active workout first.")


MANAGED_KINDS: dict[str, ManagedKind] = {
    "gym": ManagedKind(
        table="gyms",
        missing="Gym not found.",
        used_sql="SELECT 1 FROM workouts WHERE gym_id = ? LIMIT 1",
        describe=lambda connection, gym_id: _gym_rows(connection, gym_id)[0],
        rename=_rename_gym,
        delete=_delete_gym,
        before_archive=_before_gym_archive,
    ),
    # An Exercise Configuration has no name of its own: manufacturer and label are its identity.
    "configuration": ManagedKind(
        table="gym_exercise_profiles",
        missing="Exercise configuration not found.",
        used_sql="SELECT 1 FROM workout_exercises WHERE gym_profile_id = ? LIMIT 1",
        describe=lambda connection, configuration_id: _configuration_rows(connection, configuration_id)[0],
        delete=lambda connection, configuration_id: connection.execute(
            "DELETE FROM gym_exercise_profiles WHERE id = ?", (configuration_id,)
        ),
    ),
}


def _configuration_rows(
    connection: sqlite3.Connection, configuration_id: int | None = None
) -> list[dict[str, Any]]:
    items = rows(connection.execute(
        """SELECT p.id, p.gym_id, g.name AS gym_name, g.archived_at IS NOT NULL AS gym_archived,
                  p.variation_id, e.name AS exercise_name, v.name AS variation_name,
                  v.archived_at IS NOT NULL AS variation_archived,
                  p.equipment, p.manufacturer, p.label,
                  p.archived_at IS NOT NULL AS archived,
                  EXISTS (SELECT 1 FROM workout_exercises WHERE gym_profile_id = p.id) AS used
           FROM gym_exercise_profiles p
           JOIN gyms g ON g.id = p.gym_id
           JOIN exercise_variations v ON v.id = p.variation_id
           JOIN exercises e ON e.id = v.exercise_id
           WHERE ? IS NULL OR p.id = ?
           ORDER BY g.name, g.id, e.name, v.name, p.equipment, p.manufacturer, p.label""",
        (configuration_id, configuration_id),
    ))
    flags = ("gym_archived", "variation_archived", "archived", "used")
    return [{**item, **{flag: bool(item[flag]) for flag in flags}} for item in items]


def _has_starter_variations(connection: sqlite3.Connection, exercise_id: int) -> bool:
    return bool(connection.execute(
        "SELECT 1 FROM exercise_variations WHERE exercise_id = ? AND custom = 0", (exercise_id,)
    ).fetchone())


def _custom_exercise_rows(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    """Exercises that have custom Variations, each listing only those Variations."""
    exercises: dict[int, dict[str, Any]] = {}
    for variation in rows(connection.execute(
        """SELECT v.id, v.exercise_id, e.name AS exercise_name, v.name, v.tracking_type,
                  v.assisted, v.archived_at IS NOT NULL AS archived,
                  EXISTS (SELECT 1 FROM workout_exercises WHERE variation_id = v.id) AS used
           FROM exercise_variations v JOIN exercises e ON e.id = v.exercise_id
           WHERE v.custom = 1 ORDER BY e.name, e.id, v.name, v.id"""
    )):
        exercise_id, exercise_name = variation.pop("exercise_id"), variation.pop("exercise_name")
        exercise = exercises.setdefault(exercise_id, {
            "id": exercise_id, "name": exercise_name, "variations": [],
            # A custom Exercise is archived when all its Variations are, and can be
            # renamed only when it has no starter catalog Variations.
            "archived": True, "renamable": not _has_starter_variations(connection, exercise_id),
        })
        # An Equipment value is used when a Workout Exercise of this Variation recorded it.
        equipment = [{"name": row["equipment"], "used": bool(row["used"])} for row in connection.execute(
            """SELECT equipment, EXISTS (
                   SELECT 1 FROM workout_exercises
                   WHERE variation_id = ve.variation_id AND equipment_snapshot = ve.equipment
               ) AS used
               FROM variation_equipment ve WHERE variation_id = ? ORDER BY position""",
            (variation["id"],),
        )]
        exercise["archived"] = exercise["archived"] and bool(variation["archived"])
        exercise["variations"].append({
            **variation, "archived": bool(variation["archived"]), "used": bool(variation["used"]),
            "equipment": equipment,
        })
    return list(exercises.values())


STARTER_CATALOG_UNCHANGEABLE = "Starter catalog exercises can't be changed."


def clean_variation_name(name: object) -> str:
    if not isinstance(name, str):
        raise ValueError("Variation name must be text.")
    clean_name = " ".join(name.split())
    if not clean_name:
        raise ValueError("Variation name is required.")
    if len(clean_name) > 80:
        raise ValueError("Variation name must be 80 characters or fewer.")
    return clean_name


def require_free_variation_name(
    connection: sqlite3.Connection, exercise_id: int, name: str, variation_id: int | None = None,
) -> None:
    """Variation names are unique within an Exercise ignoring case, archived Variations included."""
    taken = connection.execute(
        """SELECT e.name AS exercise_name, v.name, v.archived_at
           FROM exercise_variations v JOIN exercises e ON e.id = v.exercise_id
           WHERE v.exercise_id = ? AND v.name = ? COLLATE NOCASE AND v.id IS NOT ?""",
        (exercise_id, name, variation_id),
    ).fetchone()
    if taken and taken["archived_at"]:
        raise RuntimeError(
            f"{taken['exercise_name']} already has an archived variation named {taken['name']}. "
            "Restore it in Manage."
        )
    if taken:
        raise RuntimeError(f"{taken['exercise_name']} already has a variation named {taken['name']}.")


def _require_custom_variation(connection: sqlite3.Connection, variation_id: int) -> None:
    if not connection.execute(
        "SELECT custom FROM exercise_variations WHERE id = ?", (variation_id,)
    ).fetchone()["custom"]:
        raise RuntimeError(STARTER_CATALOG_UNCHANGEABLE)


def _describe_variation(connection: sqlite3.Connection, variation_id: int) -> dict[str, Any]:
    return next(variation for exercise in _custom_exercise_rows(connection)
                for variation in exercise["variations"] if variation["id"] == variation_id)


def _rename_variation(connection: sqlite3.Connection, variation_id: int, name: object) -> None:
    clean_name = clean_variation_name(name)
    exercise_id = connection.execute(
        "SELECT exercise_id FROM exercise_variations WHERE id = ?", (variation_id,)
    ).fetchone()["exercise_id"]
    require_free_variation_name(connection, exercise_id, clean_name, variation_id)
    # Workout Exercises keep the name they were recorded with (see CONTEXT.md).
    connection.execute("UPDATE exercise_variations SET name = ? WHERE id = ?", (clean_name, variation_id))


def _delete_variation(connection: sqlite3.Connection, variation_id: int) -> None:
    exercise_id = connection.execute(
        "SELECT exercise_id FROM exercise_variations WHERE id = ?", (variation_id,)
    ).fetchone()["exercise_id"]
    # A never-used Variation's Exercise Configurations are never used either.
    connection.execute("DELETE FROM gym_exercise_profiles WHERE variation_id = ?", (variation_id,))
    connection.execute("DELETE FROM variation_equipment WHERE variation_id = ?", (variation_id,))
    connection.execute("DELETE FROM exercise_variations WHERE id = ?", (variation_id,))
    connection.execute(
        """DELETE FROM exercises WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM exercise_variations WHERE exercise_id = exercises.id)""",
        (exercise_id,),
    )


MANAGED_KINDS["variation"] = ManagedKind(
    table="exercise_variations",
    missing="Exercise variation not found.",
    used_sql="SELECT 1 FROM workout_exercises WHERE variation_id = ? LIMIT 1",
    describe=_describe_variation,
    rename=_rename_variation,
    delete=_delete_variation,
    require_changeable=_require_custom_variation,
)


def _require_custom_exercise(connection: sqlite3.Connection, exercise_id: int) -> None:
    # Startup seeding would recreate a renamed starter Exercise.
    if _has_starter_variations(connection, exercise_id):
        raise RuntimeError(STARTER_CATALOG_UNCHANGEABLE)


def _rename_exercise(connection: sqlite3.Connection, exercise_id: int, name: object) -> None:
    if not isinstance(name, str):
        raise ValueError("Exercise name must be text.")
    clean_name = " ".join(name.split())
    if not clean_name:
        raise ValueError("Exercise name is required.")
    if len(clean_name) > 80:
        raise ValueError("Exercise name must be 80 characters or fewer.")
    taken = connection.execute(
        "SELECT name FROM exercises WHERE name = ? AND id IS NOT ?", (clean_name, exercise_id),
    ).fetchone()
    if taken:
        raise RuntimeError(f"An exercise named {taken['name']} already exists.")
    # Workout Exercises keep the name they were recorded with (see CONTEXT.md).
    connection.execute("UPDATE exercises SET name = ? WHERE id = ?", (clean_name, exercise_id))


# A custom Exercise is not archived itself: it follows its Variations.
MANAGED_KINDS["exercise"] = ManagedKind(
    table="exercises",
    missing="Exercise not found.",
    used_sql="SELECT 1 FROM workout_exercises we JOIN exercise_variations v ON v.id = we.variation_id"
             " WHERE v.exercise_id = ? LIMIT 1",
    describe=lambda connection, exercise_id: next(
        exercise for exercise in _custom_exercise_rows(connection) if exercise["id"] == exercise_id
    ),
    rename=_rename_exercise,
    require_changeable=_require_custom_exercise,
)


def set_variation_equipment(
    connection: sqlite3.Connection, variation_id: int, equipment: object,
) -> dict[str, Any]:
    """Replace a custom Variation's ordered Equipment list. Only unused values can be removed."""
    clean_equipment = clean_equipment_list(equipment)
    spec = MANAGED_KINDS["variation"]
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        _require_managed_item(connection, spec, variation_id)
        current = [row["equipment"] for row in connection.execute(
            "SELECT equipment FROM variation_equipment WHERE variation_id = ? ORDER BY position",
            (variation_id,),
        )]
        removed = [value for value in current if value not in clean_equipment]
        for value in removed:
            if connection.execute(
                """SELECT 1 FROM workout_exercises
                   WHERE variation_id = ? AND equipment_snapshot = ? LIMIT 1""",
                (variation_id, value),
            ).fetchone():
                raise RuntimeError(f"{value} is used in recorded workouts, so it cannot be removed.")
            # Configurations of an unused Equipment value are never used either.
            connection.execute(
                "DELETE FROM gym_exercise_profiles WHERE variation_id = ? AND equipment = ?",
                (variation_id, value),
            )
        connection.execute("DELETE FROM variation_equipment WHERE variation_id = ?", (variation_id,))
        connection.executemany(
            "INSERT INTO variation_equipment(variation_id, equipment, position) VALUES (?, ?, ?)",
            [(variation_id, value, position) for position, value in enumerate(clean_equipment)],
        )
        return spec.describe(connection, variation_id)


def manage_overview(connection: sqlite3.Connection) -> dict[str, Any]:
    """Gyms, Exercise Configurations and custom Exercises, each marked archived and used."""
    return {
        "gyms": _gym_rows(connection),
        "configurations": _configuration_rows(connection),
        "exercises": _custom_exercise_rows(connection),
    }


def _managed_kind(kind: str, action: str) -> ManagedKind:
    spec = MANAGED_KINDS.get(kind)
    if not spec or not (spec.rename if action == "rename" else spec.delete):
        raise LookupError(f"Cannot {action} {kind} items.")
    return spec


def _require_managed_item(connection: sqlite3.Connection, spec: ManagedKind, item_id: int) -> None:
    if type(item_id) is not int or not 1 <= item_id <= 9223372036854775807 or not connection.execute(
        f"SELECT 1 FROM {spec.table} WHERE id = ?", (item_id,)
    ).fetchone():
        raise LookupError(spec.missing)
    if spec.require_changeable:
        spec.require_changeable(connection, item_id)


def rename_item(connection: sqlite3.Connection, kind: str, item_id: int, name: object) -> dict[str, Any]:
    spec = _managed_kind(kind, "rename")
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        _require_managed_item(connection, spec, item_id)
        spec.rename(connection, item_id, name)
        return spec.describe(connection, item_id)


def remove_item(connection: sqlite3.Connection, kind: str, item_id: int) -> dict[str, str]:
    """Delete a never-used item or archive a used one, deciding inside the transaction."""
    spec = _managed_kind(kind, "remove")
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        _require_managed_item(connection, spec, item_id)
        if not connection.execute(spec.used_sql, (item_id,)).fetchone():
            spec.delete(connection, item_id)
            return {"outcome": "deleted"}
        if spec.before_archive:
            spec.before_archive(connection, item_id)
        connection.execute(
            f"UPDATE {spec.table} SET archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP) WHERE id = ?",
            (item_id,),
        )
        return {"outcome": "archived"}


def restore_item(connection: sqlite3.Connection, kind: str, item_id: int) -> dict[str, Any]:
    spec = _managed_kind(kind, "restore")
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        _require_managed_item(connection, spec, item_id)
        connection.execute(f"UPDATE {spec.table} SET archived_at = NULL WHERE id = ?", (item_id,))
        return spec.describe(connection, item_id)
