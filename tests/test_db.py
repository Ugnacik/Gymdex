import tempfile
import unittest
from pathlib import Path

from gymdex import db


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.connection = db.connect(Path(self.temp_dir.name) / "test.sqlite3")
        db.initialize(self.connection)

    def tearDown(self):
        self.connection.close()
        self.temp_dir.cleanup()

    def test_workout_keeps_gym_specific_machine_snapshot(self):
        gym_one = db.create_gym(self.connection, "Gym One")
        gym_two = db.create_gym(self.connection, "Gym Two")
        variation = self.connection.execute(
            """SELECT v.id FROM exercise_variations v
               JOIN exercises e ON e.id = v.exercise_id
               WHERE e.name = 'Bench Press' AND v.name = 'Standard'"""
        ).fetchone()

        workout_one = db.start_workout(self.connection, gym_one["id"])
        first = db.add_workout_exercise(
            self.connection, workout_one["id"], variation["id"], "Machine", "Technogym", "Press 1"
        )
        db.complete_workout(self.connection, workout_one["id"])

        workout_two = db.start_workout(self.connection, gym_two["id"])
        second = db.add_workout_exercise(
            self.connection, workout_two["id"], variation["id"], "Machine", "Hammer Strength", "Plate loaded"
        )

        self.assertEqual(first["manufacturer"], "Technogym")
        self.assertEqual(second["manufacturer"], "Hammer Strength")
        profiles = self.connection.execute(
            "SELECT gym_id, manufacturer FROM gym_exercise_profiles ORDER BY gym_id"
        ).fetchall()
        self.assertEqual([(row["gym_id"], row["manufacturer"]) for row in profiles], [(gym_one["id"], "Technogym"), (gym_two["id"], "Hammer Strength")])

    def test_only_one_workout_can_be_active(self):
        gym = db.create_gym(self.connection, "Home")
        db.start_workout(self.connection, gym["id"])
        with self.assertRaises(RuntimeError):
            db.start_workout(self.connection, gym["id"])

    def test_catalog_preserves_curated_equipment_order(self):
        gym = db.create_gym(self.connection, "Home")
        catalog = db.catalog_for_gym(self.connection, gym["id"])["catalog"]
        curl = next(item for item in catalog if item["exercise_name"] == "Biceps Curl")
        self.assertEqual(curl["equipment"], ["Dumbbell", "Barbell", "Cable"])

    def test_recent_profile_is_reused_in_one_operation(self):
        gym = db.create_gym(self.connection, "Main Gym")
        variation_id = self.connection.execute(
            "SELECT id FROM exercise_variations ORDER BY id LIMIT 1"
        ).fetchone()["id"]
        first_workout = db.start_workout(self.connection, gym["id"])
        db.add_workout_exercise(
            self.connection, first_workout["id"], variation_id, "Barbell"
        )
        profile_id = self.connection.execute(
            "SELECT id FROM gym_exercise_profiles"
        ).fetchone()["id"]
        db.complete_workout(self.connection, first_workout["id"])

        second_workout = db.start_workout(self.connection, gym["id"])
        entry = db.add_recent_profile(self.connection, second_workout["id"], profile_id)
        self.assertEqual(entry["equipment"], "Barbell")

    def test_recent_profile_cannot_cross_gyms(self):
        gym_one = db.create_gym(self.connection, "Gym One")
        gym_two = db.create_gym(self.connection, "Gym Two")
        variation_id = self.connection.execute(
            "SELECT id FROM exercise_variations ORDER BY id LIMIT 1"
        ).fetchone()["id"]
        first_workout = db.start_workout(self.connection, gym_one["id"])
        db.add_workout_exercise(
            self.connection, first_workout["id"], variation_id, "Barbell"
        )
        profile_id = self.connection.execute(
            "SELECT id FROM gym_exercise_profiles WHERE gym_id = ?", (gym_one["id"],)
        ).fetchone()["id"]
        db.complete_workout(self.connection, first_workout["id"])

        second_workout = db.start_workout(self.connection, gym_two["id"])
        with self.assertRaises(LookupError):
            db.add_recent_profile(self.connection, second_workout["id"], profile_id)


if __name__ == "__main__":
    unittest.main()
