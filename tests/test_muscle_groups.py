import tempfile
import unittest
from pathlib import Path

from gymdex import db


class MuscleGroupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.connection = db.connect(Path(self.directory.name) / 'groups.sqlite3')
        db.initialize(self.connection)
        self.gym = db.create_gym(self.connection, 'Home')

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()

    def catalog(self, include_archived=False):
        return db.catalog_for_gym(self.connection, self.gym['id'], include_archived)

    def variation(self, name, variation='Standard'):
        return next(item for item in self.catalog()['catalog']
                    if (item['exercise_name'], item['variation_name']) == (name, variation))

    def custom(self, groups=(), tracking='repetitions'):
        return db.create_exercise(self.connection, 'Custom movement', 'Intentional', tracking,
                                  ['Bodyweight'], muscle_groups=groups)

    def test_starter_targets_are_intentional_and_cover_every_variation(self):
        catalog = self.catalog()
        self.assertEqual(catalog['muscle_groups'], [
            'Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Forearms', 'Abs',
            'Glutes', 'Quadriceps', 'Hamstrings', 'Calves',
        ])
        self.assertEqual(len(catalog['catalog']), 29)
        self.assertTrue(all(item['muscle_groups'] for item in catalog['catalog']))
        self.assertEqual(self.variation('Squat', 'Back Squat')['muscle_groups'], ['Glutes', 'Quadriceps'])
        self.assertEqual(self.variation('Deadlift', 'Conventional')['muscle_groups'], ['Glutes', 'Hamstrings'])
        self.assertEqual(self.variation('Face Pull')['muscle_groups'], ['Back', 'Shoulders'])
        for variation in ('Standard', 'Assisted'):
            self.assertEqual(self.variation('Pull-up', variation)['muscle_groups'], ['Back'])
            self.assertEqual(self.variation('Dip', variation)['muscle_groups'], ['Chest', 'Triceps'])
        self.assertEqual(self.variation('Plank', 'Front Plank')['muscle_groups'], ['Abs'])

    def test_optional_custom_targets_can_be_multiple_and_reordered(self):
        custom = self.custom(['Forearms', 'Back'])
        self.assertEqual(custom['muscle_groups'], ['Back', 'Forearms'])
        self.assertIn(custom, self.catalog()['catalog'])
        self.assertEqual(db.manage_overview(self.connection)['exercises'][0]['variations'][0]['muscle_groups'],
                         ['Back', 'Forearms'])
        self.assertEqual(db.manage_overview(self.connection)['muscle_groups'], list(db.MUSCLE_GROUPS))

    def test_omitting_groups_leaves_a_custom_variation_unassigned(self):
        self.assertEqual(self.custom()['muscle_groups'], [])

    def test_invalid_groups_leave_no_partial_exercise_or_assignment(self):
        for groups in (None, 'Back', ['Core'], ['back'], ['Back', 'Back'], [1], {'Back': True}):
            with self.subTest(groups=groups), self.assertRaises(ValueError):
                self.custom(groups)
        self.assertFalse(self.connection.execute("SELECT 1 FROM exercises WHERE name = 'Custom movement'").fetchone())
        custom = self.custom(['Abs'])
        for groups in (None, ['Back', 'Back'], ['Unknown']):
            with self.subTest(groups=groups), self.assertRaises(ValueError):
                db.set_variation_muscle_groups(self.connection, custom['id'], groups)
        self.assertEqual(db.muscle_groups_for_variation(self.connection, custom['id']), ['Abs'])

    def test_correction_and_clear_preserve_recorded_duration_sets_and_notes(self):
        custom = self.custom(['Abs'], 'duration')
        workout = db.start_workout(self.connection, self.gym['id'])
        entry = db.add_workout_exercise(self.connection, workout['id'], custom['id'], 'Bodyweight')
        set_id = db.sets_for_exercise(self.connection, entry['id'])[0]['id']
        db.update_set(self.connection, set_id, {'weight': None, 'result': 30, 'completed': True})
        db.set_workout_exercise_note(self.connection, entry['id'], 'Kept note')
        db.complete_workout(self.connection, workout['id'])
        before = db.completed_workout(self.connection, workout['id'])
        self.assertEqual(db.set_variation_muscle_groups(self.connection, custom['id'], ['Back'])['muscle_groups'], ['Back'])
        self.assertEqual(db.set_variation_muscle_groups(self.connection, custom['id'], [])['muscle_groups'], [])
        self.assertEqual(db.completed_workout(self.connection, workout['id']), before)

    def test_starter_assignments_are_not_editable_and_missing_rows_are_reported(self):
        with self.assertRaisesRegex(RuntimeError, "Starter catalog exercises can't be changed"):
            db.set_variation_muscle_groups(self.connection, self.variation('Bench Press')['id'], ['Back'])
        with self.assertRaises(LookupError):
            db.set_variation_muscle_groups(self.connection, 99999, [])

    def test_archive_restore_and_permanent_delete_keep_or_remove_assignments(self):
        custom = self.custom(['Forearms'])
        workout = db.start_workout(self.connection, self.gym['id'])
        db.add_workout_exercise(self.connection, workout['id'], custom['id'], 'Bodyweight')
        db.complete_workout(self.connection, workout['id'])
        self.assertEqual(db.remove_item(self.connection, 'variation', custom['id'])['outcome'], 'archived')
        self.assertNotIn(custom['id'], [item['id'] for item in self.catalog()['catalog']])
        archived = next(item for item in self.catalog(True)['catalog'] if item['id'] == custom['id'])
        self.assertEqual(archived['muscle_groups'], ['Forearms'])
        self.assertEqual(db.restore_item(self.connection, 'variation', custom['id'])['muscle_groups'], ['Forearms'])
        unused = db.create_exercise(self.connection, 'Never used', '', 'repetitions', ['Machine'], muscle_groups=['Chest'])
        self.assertEqual(db.remove_item(self.connection, 'variation', unused['id'])['outcome'], 'deleted')
        self.assertEqual(db.muscle_groups_for_variation(self.connection, unused['id']), [])
        self.assertEqual(self.connection.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_version_five_migration_preserves_records_and_does_not_label_same_name_custom_rows(self):
        # Replace one starter with a same-name Custom Variation, as if it existed before catalog expansion.
        leg_press = self.variation('Leg Press')
        self.connection.execute('DELETE FROM variation_equipment WHERE variation_id = ?', (leg_press['id'],))
        self.connection.execute('DELETE FROM exercise_variations WHERE id = ?', (leg_press['id'],))
        self.connection.commit()
        custom = db.create_exercise(self.connection, 'leg press', 'standard', 'duration', ['Sled'])
        unmatched = self.custom()
        press = self.variation('Bench Press')
        workout = db.start_workout(self.connection, self.gym['id'])
        entry = db.add_workout_exercise(self.connection, workout['id'], press['id'], 'Barbell')
        set_id = db.sets_for_exercise(self.connection, entry['id'])[0]['id']
        db.update_set(self.connection, set_id, {'weight': 40, 'result': 8, 'completed': True})
        db.complete_workout(self.connection, workout['id'])
        db.set_workout_note(self.connection, workout['id'], 'Workout note')
        db.set_workout_exercise_note(self.connection, entry['id'], 'Exercise note')
        profile_id = self.connection.execute('SELECT gym_profile_id FROM workout_exercises WHERE id = ?',
                                             (entry['id'],)).fetchone()[0]
        db.create_routine(self.connection, self.gym['id'], 'Preserved plan',
                          [{'profile_id': profile_id, 'set_count': 3}])
        tables = ('gyms', 'exercises', 'exercise_variations', 'variation_equipment', 'gym_exercise_profiles',
                  'workouts', 'workout_exercises', 'workout_sets', 'routines', 'routine_exercises')
        before = {table: [tuple(row) for row in self.connection.execute(f'SELECT * FROM {table} ORDER BY rowid')]
                  for table in tables}
        self.connection.execute('DROP TABLE variation_muscle_groups')
        self.connection.execute('PRAGMA user_version = 5')
        self.connection.commit()
        db.initialize(self.connection)
        db.initialize(self.connection)
        self.assertEqual(self.connection.execute('PRAGMA user_version').fetchone()[0], 7)
        self.assertEqual(before, {table: [tuple(row) for row in self.connection.execute(f'SELECT * FROM {table} ORDER BY rowid')]
                                 for table in tables})
        self.assertEqual(db.muscle_groups_for_variation(self.connection, press['id']), ['Chest'])
        self.assertEqual(db.muscle_groups_for_variation(self.connection, custom['id']), [])
        self.assertEqual(db.muscle_groups_for_variation(self.connection, unmatched['id']), [])
        self.assertEqual(self.connection.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_repeated_startup_preserves_corrected_and_cleared_custom_assignments(self):
        custom = self.custom(['Back'])
        db.set_variation_muscle_groups(self.connection, custom['id'], ['Forearms'])
        db.initialize(self.connection)
        self.assertEqual(db.muscle_groups_for_variation(self.connection, custom['id']), ['Forearms'])
        db.set_variation_muscle_groups(self.connection, custom['id'], [])
        db.initialize(self.connection)
        self.assertEqual(db.muscle_groups_for_variation(self.connection, custom['id']), [])
