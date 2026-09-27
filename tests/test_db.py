import tempfile
import unittest
from pathlib import Path
from unittest import mock

from gymdex import db


# The starter Exercise Catalog as it shipped before it was extended.
OLD_CATALOG = (
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
    ("Pull-up", "Assisted", "repetitions", ("Machine",), True),
    ("Dip", "Assisted", "repetitions", ("Machine",), True),
)


class CatalogUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.path = Path(self.temp_dir.name) / "old.sqlite3"

    def tearDown(self):
        self.temp_dir.cleanup()

    def catalog(self, connection, gym_id):
        return {
            (item["exercise_name"], item["variation_name"]): item
            for item in db.catalog_for_gym(connection, gym_id)["catalog"]
        }

    def test_startup_adds_new_catalog_entries_without_disturbing_existing_ones(self):
        connection = db.connect(self.path)
        with mock.patch.object(db, "CATALOG", OLD_CATALOG):
            db.initialize(connection)
        gym = db.create_gym(connection, "Home")
        leg_press = db.create_exercise(
            connection, "Leg Press", "Standard", "repetitions", ["Plate-loaded"]
        )
        hip_thrust = db.create_exercise(
            connection, "hip thrust", "standard", "repetitions", ["Smith Machine"]
        )
        bench = self.catalog(connection, gym["id"])[("Bench Press", "Standard")]
        workout = db.start_workout(connection, gym["id"])
        db.add_workout_exercise(connection, workout["id"], bench["id"], "Barbell")
        db.complete_workout(connection, workout["id"])
        before = self.catalog(connection, gym["id"])
        connection.close()

        for _ in range(2):
            connection = db.connect(self.path)
            db.initialize(connection)
            after = self.catalog(connection, gym["id"])
            connection.close()

            for key, item in before.items():
                with self.subTest(kept=key):
                    self.assertEqual(after[key], item)
            self.assertEqual(after[("Pull-up", "Standard")]["equipment"], ["Bodyweight"])
            self.assertEqual(after[("Leg Curl", "Lying")]["equipment"], ["Machine"])
            self.assertEqual(
                [item["id"] for item in after.values() if item["exercise_name"] == "Leg Press"],
                [leg_press["id"]],
            )
            self.assertEqual(after[("Leg Press", "Standard")]["equipment"], ["Plate-loaded"])
            self.assertEqual(
                [item["id"] for item in after.values()
                 if item["exercise_name"].casefold() == "hip thrust"],
                [hip_thrust["id"]],
            )
            self.assertEqual(len(after), len(db.CATALOG))


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

    def test_starter_catalog_offers_common_movements_with_relevant_equipment(self):
        gym = db.create_gym(self.connection, "Home")
        catalog = {
            (item["exercise_name"], item["variation_name"]): item
            for item in db.catalog_for_gym(self.connection, gym["id"])["catalog"]
        }
        expected = {
            ("Pull-up", "Standard"): ["Bodyweight"],
            ("Dip", "Standard"): ["Bodyweight"],
            ("Push-up", "Standard"): ["Bodyweight"],
            ("Leg Press", "Standard"): ["Machine"],
            ("Leg Curl", "Seated"): ["Machine"],
            ("Leg Curl", "Lying"): ["Machine"],
            ("Leg Extension", "Standard"): ["Machine"],
            ("Lunge", "Standard"): ["Dumbbell", "Barbell", "Bodyweight"],
            ("Deadlift", "Romanian"): ["Barbell", "Dumbbell"],
            ("Hip Thrust", "Standard"): ["Barbell", "Machine"],
            ("Lateral Raise", "Standard"): ["Dumbbell", "Cable", "Machine"],
            ("Face Pull", "Standard"): ["Cable"],
            ("Calf Raise", "Standing"): ["Machine", "Bodyweight", "Dumbbell"],
            ("Calf Raise", "Seated"): ["Machine"],
            ("Chest Fly", "Standard"): ["Machine", "Cable", "Dumbbell"],
            ("Crunch", "Standard"): ["Bodyweight", "Cable", "Machine"],
            ("Leg Raise", "Hanging"): ["Bodyweight"],
        }
        for key, equipment in expected.items():
            with self.subTest(exercise=key):
                self.assertIn(key, catalog)
                self.assertEqual(catalog[key]["equipment"], equipment)
                self.assertEqual(catalog[key]["tracking_type"], "repetitions")
                self.assertEqual(catalog[key]["assisted"], 0)

    def test_bodyweight_variation_records_optional_added_load(self):
        gym = db.create_gym(self.connection, "Home")
        pull_up = next(
            item for item in db.catalog_for_gym(self.connection, gym["id"])["catalog"]
            if (item["exercise_name"], item["variation_name"]) == ("Pull-up", "Standard")
        )
        workout = db.start_workout(self.connection, gym["id"])
        db.add_workout_exercise(self.connection, workout["id"], pull_up["id"], "Bodyweight")
        set_id = db.bootstrap(self.connection)["workout_exercises"][0]["sets"][0]["id"]
        unloaded = db.update_set(
            self.connection, set_id, {"weight": None, "result": 8, "completed": True}
        )
        loaded = db.update_set(
            self.connection, set_id, {"weight": 10, "result": 8, "completed": True}
        )
        self.assertIsNone(unloaded["weight"])
        self.assertEqual(loaded["weight"], 10)

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
