import csv
from io import StringIO
import sqlite3
import tempfile
import unittest
from pathlib import Path

from gymdex import db
from gymdex.backup import copy_database
from gymdex.export import COLUMNS, workout_csv


class ExportAndBackupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "gymdex.sqlite3"
        self.connection = db.connect(self.path)
        db.initialize(self.connection)

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()

    def test_export_keeps_empty_workouts_and_completed_and_unfinished_sets(self):
        gym = db.create_gym(self.connection, "=Evil Gym")
        empty = db.start_workout(self.connection, gym["id"])
        db.complete_workout(self.connection, empty["id"])
        workout = db.start_workout(self.connection, gym["id"])
        variation = next(item for item in db.catalog_for_gym(self.connection, gym["id"])["catalog"]
                         if item["exercise_name"] == "Bench Press" and item["variation_name"] == "Standard")
        exercise = db.add_workout_exercise(self.connection, workout["id"], variation["id"], "Barbell")
        first = db.sets_for_exercise(self.connection, exercise["id"])[0]
        db.update_set(self.connection, first["id"], {"weight": 42.5, "result": 8, "completed": True})
        db.add_set(self.connection, exercise["id"])
        db.complete_workout(self.connection, workout["id"])

        exported = list(csv.DictReader(StringIO(workout_csv(self.connection))))
        self.assertEqual(len(exported), 3)
        self.assertEqual(set(exported[0]), set(COLUMNS))
        self.assertEqual(exported[0]["workout_id"], str(empty["id"]))
        self.assertEqual(exported[0]["exercise"], "")
        self.assertEqual(exported[0]["gym"], "'=Evil Gym")
        self.assertEqual(exported[1]["weight_kg"], "42.5")
        self.assertEqual(exported[1]["result"], "8")
        self.assertEqual(exported[1]["completed"], "1")
        self.assertEqual(exported[2]["set_position"], "2")
        self.assertEqual(exported[2]["completed"], "0")

    def test_backup_and_restore_round_trip_and_validate_source(self):
        db.create_gym(self.connection, "Home")
        backup = Path(self.directory.name) / "snapshots" / "backup.sqlite3"
        copy_database(self.path, backup)
        with self.assertRaises(ValueError):
            copy_database(self.path, backup)
        db.create_gym(self.connection, "Added after backup")
        self.connection.close()
        sidecar = Path(f"{self.path}-wal")
        sidecar.write_bytes(b"uncheckpointed")
        with self.assertRaisesRegex(ValueError, "journal files exist"):
            copy_database(backup, self.path, replace=True)
        sidecar.unlink()
        copy_database(backup, self.path, replace=True)
        self.connection = db.connect(self.path)
        self.assertEqual([gym["name"] for gym in db.bootstrap(self.connection)["gyms"]], ["Home"])
        with self.assertRaises(ValueError):
            copy_database(backup, backup, replace=True)
        new_destination = Path(self.directory.name) / "new.sqlite3"
        orphaned_sidecar = Path(f"{new_destination}-wal")
        orphaned_sidecar.write_bytes(b"stale")
        with self.assertRaisesRegex(ValueError, "journal files exist"):
            copy_database(backup, new_destination)
        self.assertFalse(new_destination.exists())
        bad = Path(self.directory.name) / "bad.sqlite3"
        bad.write_text("not sqlite")
        with self.assertRaises(Exception):
            copy_database(bad, self.path, replace=True)
        self.assertEqual([gym["name"] for gym in db.bootstrap(self.connection)["gyms"]], ["Home"])
        wrong_schema = Path(self.directory.name) / "wrong-schema.sqlite3"
        with sqlite3.connect(wrong_schema) as empty:
            for table in ("gyms", "workouts", "workout_exercises", "workout_sets"):
                empty.execute(f"CREATE TABLE {table}(id INTEGER PRIMARY KEY)")
        with self.assertRaisesRegex(ValueError, "Not a compatible Gymdex database"):
            copy_database(wrong_schema, self.path, replace=True)

    def test_backup_rejects_broken_references(self):
        self.connection.execute("PRAGMA foreign_keys = OFF")
        self.connection.execute("INSERT INTO workouts(gym_id, completed_at) VALUES (999, CURRENT_TIMESTAMP)")
        self.connection.commit()
        backup = Path(self.directory.name) / "invalid-backup.sqlite3"
        with self.assertRaisesRegex(ValueError, "broken references"):
            copy_database(self.path, backup)
        self.assertFalse(backup.exists())


if __name__ == "__main__":
    unittest.main()
