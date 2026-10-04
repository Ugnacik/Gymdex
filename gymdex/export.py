"""Portable, spreadsheet-friendly export of recorded workouts."""

from __future__ import annotations

import csv
from io import StringIO
import sqlite3


COLUMNS = (
    "workout_id", "gym", "started_at_utc", "completed_at_utc",
    "workout_exercise_id", "exercise_position", "exercise", "variation",
    "equipment", "manufacturer", "machine_label", "tracking_type",
    "set_id", "set_position", "weight_kg", "result", "completed", "effort",
    "workout_note", "exercise_note",
)


def _spreadsheet_safe(value: object) -> object:
    """Prevent user-entered labels from being interpreted as spreadsheet formulas."""
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def workout_csv(connection: sqlite3.Connection) -> str:
    """Export one row per set, retaining empty exercises and workouts."""
    records = connection.execute(
        """SELECT w.id AS workout_id, g.name AS gym,
                  w.started_at AS started_at_utc, w.completed_at AS completed_at_utc,
                  e.id AS workout_exercise_id, e.position AS exercise_position,
                  e.exercise_name_snapshot AS exercise,
                  e.variation_name_snapshot AS variation,
                  e.equipment_snapshot AS equipment,
                  e.manufacturer_snapshot AS manufacturer,
                  e.label_snapshot AS machine_label,
                  e.tracking_type_snapshot AS tracking_type,
                  s.id AS set_id, s.position AS set_position,
                  s.weight AS weight_kg, s.result, s.completed, s.effort,
                  w.note AS workout_note, e.note AS exercise_note
           FROM workouts w
           JOIN gyms g ON g.id = w.gym_id
           LEFT JOIN workout_exercises e ON e.workout_id = w.id
           LEFT JOIN workout_sets s ON s.workout_exercise_id = e.id
           ORDER BY w.started_at, w.id, e.position, s.position"""
    )
    output = StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(COLUMNS)
    for record in records:
        writer.writerow(_spreadsheet_safe(record[column]) if record[column] is not None else ""
                        for column in COLUMNS)
    return output.getvalue()
