import tempfile
import unittest
from pathlib import Path

from gymdex import db


class ManageGymTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.connection = db.connect(Path(self.directory.name) / 'manage.sqlite3')
        db.initialize(self.connection)
        self.home = db.create_gym(self.connection, 'Home')
        self.other = db.create_gym(self.connection, 'Other')
        catalog = db.catalog_for_gym(self.connection, self.home['id'])['catalog']
        self.press = next(v for v in catalog if (v['exercise_name'], v['variation_name']) == ('Bench Press', 'Standard'))

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()

    def completed_workout_at(self, gym):
        workout = db.start_workout(self.connection, gym['id'])
        entry = db.add_workout_exercise(self.connection, workout['id'], self.press['id'], 'Barbell')
        slot = db.sets_for_exercise(self.connection, entry['id'])[0]
        db.update_set(self.connection, slot['id'], {'weight': 60, 'result': 5, 'completed': True})
        db.complete_workout(self.connection, workout['id'])
        return workout

    def start_gyms(self):
        return [gym['name'] for gym in db.bootstrap(self.connection)['gyms']]

    def archived_gyms(self):
        return [gym['name'] for gym in db.bootstrap(self.connection)['archived_gyms']]

    def test_a_never_used_gym_is_deleted(self):
        self.assertEqual(db.remove_item(self.connection, 'gym', self.other['id']), {'outcome': 'deleted'})
        self.assertEqual(self.start_gyms(), ['Home'])
        self.assertEqual(self.archived_gyms(), [])
        self.assertEqual([gym['name'] for gym in db.manage_overview(self.connection)['gyms']], ['Home'])
        # The name is free again.
        self.assertEqual(db.create_gym(self.connection, 'other')['name'], 'other')

    def test_a_used_gym_is_archived_but_stays_in_history_and_progress(self):
        workout = self.completed_workout_at(self.other)
        self.assertEqual(db.remove_item(self.connection, 'gym', self.other['id']), {'outcome': 'archived'})
        self.assertEqual(self.start_gyms(), ['Home'])
        self.assertEqual(db.bootstrap(self.connection)['archived_gyms'], [{'id': self.other['id'], 'name': 'Other'}])
        history = db.workout_history(self.connection, gym_id=str(self.other['id']))['workouts']
        self.assertEqual([(item['id'], item['gym_name']) for item in history], [(workout['id'], 'Other')])
        detail = db.completed_workout(self.connection, workout['id'])
        self.assertEqual((detail['workout']['gym_name'], detail['workout']['gym_archived']), ('Other', True))
        progress = db.exercise_progress(self.connection, self.press['id'], self.other['id'])
        self.assertEqual([point['best_weight'] for point in progress['points']], [60])
        gym = next(item for item in db.manage_overview(self.connection)['gyms'] if item['id'] == self.other['id'])
        self.assertEqual((gym['archived'], gym['used']), (True, True))

    def test_an_archived_gym_cannot_start_or_repeat_a_workout(self):
        workout = self.completed_workout_at(self.other)
        db.remove_item(self.connection, 'gym', self.other['id'])
        with self.assertRaisesRegex(RuntimeError, 'Other is archived. Restore it in Manage'):
            db.start_workout(self.connection, self.other['id'])
        with self.assertRaisesRegex(RuntimeError, 'Other is archived. Restore it in Manage'):
            db.repeat_workout(self.connection, workout['id'])
        self.assertIsNone(db.bootstrap(self.connection)['active_workout'])

    def test_restoring_a_gym_offers_it_for_new_workouts_again(self):
        workout = self.completed_workout_at(self.other)
        db.remove_item(self.connection, 'gym', self.other['id'])
        restored = db.restore_item(self.connection, 'gym', self.other['id'])
        self.assertEqual((restored['id'], restored['name'], restored['archived']), (self.other['id'], 'Other', False))
        self.assertEqual(self.start_gyms(), ['Home', 'Other'])
        self.assertEqual(self.archived_gyms(), [])
        self.assertFalse(db.completed_workout(self.connection, workout['id'])['workout']['gym_archived'])
        self.assertEqual(db.repeat_workout(self.connection, workout['id'])['gym_name'], 'Other')

    def test_the_active_workouts_gym_cannot_be_archived(self):
        self.completed_workout_at(self.home)
        active = db.start_workout(self.connection, self.other['id'])
        with self.assertRaisesRegex(RuntimeError, 'Finish or cancel the active workout first'):
            db.remove_item(self.connection, 'gym', self.other['id'])
        self.assertEqual(self.start_gyms(), ['Home', 'Other'])
        # Another used gym can still be archived during the workout.
        self.assertEqual(db.remove_item(self.connection, 'gym', self.home['id']), {'outcome': 'archived'})
        self.assertEqual(db.bootstrap(self.connection)['active_workout']['id'], active['id'])

    def test_a_new_gym_cannot_reuse_an_archived_gyms_name(self):
        self.completed_workout_at(self.other)
        db.remove_item(self.connection, 'gym', self.other['id'])
        with self.assertRaisesRegex(RuntimeError, 'An archived gym is named Other. Restore it in Manage.'):
            db.create_gym(self.connection, '  OTHER ')
        with self.assertRaisesRegex(RuntimeError, 'A gym named Home already exists.'):
            db.create_gym(self.connection, 'home')

    def test_renaming_a_gym_shows_the_new_name_everywhere(self):
        workout = self.completed_workout_at(self.home)
        renamed = db.rename_item(self.connection, 'gym', self.home['id'], '  City   Gym ')
        self.assertEqual((renamed['id'], renamed['name']), (self.home['id'], 'City Gym'))
        self.assertEqual(self.start_gyms(), ['City Gym', 'Other'])
        self.assertEqual(db.workout_history(self.connection)['workouts'][0]['gym_name'], 'City Gym')
        self.assertEqual(db.completed_workout(self.connection, workout['id'])['workout']['gym_name'], 'City Gym')
        # A case-only rename of the same gym is allowed.
        self.assertEqual(db.rename_item(self.connection, 'gym', self.home['id'], 'city gym')['name'], 'city gym')

    def test_a_gym_rename_cannot_collide_or_be_blank(self):
        self.completed_workout_at(self.other)
        archived = db.create_gym(self.connection, 'Old')
        self.completed_workout_at(archived)
        db.remove_item(self.connection, 'gym', archived['id'])
        with self.assertRaisesRegex(RuntimeError, 'A gym named Other already exists.'):
            db.rename_item(self.connection, 'gym', self.home['id'], 'OTHER')
        with self.assertRaisesRegex(RuntimeError, 'An archived gym is named Old. Restore it in Manage.'):
            db.rename_item(self.connection, 'gym', self.home['id'], 'old')
        with self.assertRaisesRegex(ValueError, 'Gym name is required.'):
            db.rename_item(self.connection, 'gym', self.home['id'], '   ')
        with self.assertRaisesRegex(ValueError, '80 characters'):
            db.rename_item(self.connection, 'gym', self.home['id'], 'x' * 81)
        with self.assertRaises(ValueError):
            db.rename_item(self.connection, 'gym', self.home['id'], None)
        self.assertEqual(self.start_gyms(), ['Home', 'Other'])

    def test_unknown_items_and_unsupported_actions_are_not_found(self):
        for action in (lambda: db.remove_item(self.connection, 'gym', 9999),
                       lambda: db.restore_item(self.connection, 'gym', 9999),
                       lambda: db.rename_item(self.connection, 'gym', 9999, 'Gym'),
                       lambda: db.remove_item(self.connection, 'gym', 2**70),
                       lambda: db.remove_item(self.connection, 'exercise', self.home['id']),
                       lambda: db.rename_item(self.connection, 'configuration', 1, 'Name'),
                       lambda: db.restore_item(self.connection, 'workout', 1)):
            with self.subTest(action=action), self.assertRaises(LookupError):
                action()


class ManageOverviewTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.connection = db.connect(Path(self.directory.name) / 'overview.sqlite3')
        db.initialize(self.connection)

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()

    def test_overview_lists_gyms_configurations_and_custom_exercises_with_use(self):
        home = db.create_gym(self.connection, 'Home')
        spare = db.create_gym(self.connection, 'Annex')
        sled = db.create_exercise(self.connection, 'Sled Push', 'Heavy', 'duration', ['Sled', 'Prowler'])
        db.create_exercise(self.connection, 'Sled Push', 'Light', 'duration', ['Sled'])
        press = next(v for v in db.catalog_for_gym(self.connection, home['id'])['catalog']
                     if (v['exercise_name'], v['variation_name']) == ('Bench Press', 'Standard'))
        workout = db.start_workout(self.connection, home['id'])
        db.add_workout_exercise(self.connection, workout['id'], sled['id'], 'Prowler', 'Rogue', 'Red')
        db.add_workout_exercise(self.connection, workout['id'], press['id'], 'Machine')
        db.complete_workout(self.connection, workout['id'])

        overview = db.manage_overview(self.connection)

        self.assertEqual(overview['gyms'], [
            {'id': spare['id'], 'name': 'Annex', 'archived': False, 'used': False},
            {'id': home['id'], 'name': 'Home', 'archived': False, 'used': True},
        ])
        self.assertEqual(
            [(c['gym_name'], c['exercise_name'], c['variation_name'], c['equipment'], c['manufacturer'],
              c['label'], c['archived'], c['used']) for c in overview['configurations']],
            [('Home', 'Bench Press', 'Standard', 'Machine', '', '', False, True),
             ('Home', 'Sled Push', 'Heavy', 'Prowler', 'Rogue', 'Red', False, True)],
        )
        # Starter catalog exercises are not listed; custom ones list their custom variations.
        self.assertEqual([exercise['name'] for exercise in overview['exercises']], ['Sled Push'])
        heavy, light = overview['exercises'][0]['variations']
        self.assertEqual((heavy['id'], heavy['name'], heavy['tracking_type'], heavy['used'], heavy['archived']),
                         (sled['id'], 'Heavy', 'duration', True, False))
        self.assertEqual(heavy['equipment'], [{'name': 'Sled', 'used': False}, {'name': 'Prowler', 'used': True}])
        self.assertEqual((light['name'], light['used']), ('Light', False))


class ManageCustomExerciseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.connection = db.connect(Path(self.directory.name) / 'custom.sqlite3')
        db.initialize(self.connection)
        self.home = db.create_gym(self.connection, 'Home')
        self.heavy = db.create_exercise(self.connection, 'Sled Push', 'Heavy', 'duration', ['Sled', 'Prowler'])

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()

    def completed_workout_with(self, variation, equipment):
        workout = db.start_workout(self.connection, self.home['id'])
        entry = db.add_workout_exercise(self.connection, workout['id'], variation['id'], equipment)
        slot = db.sets_for_exercise(self.connection, entry['id'])[0]
        db.update_set(self.connection, slot['id'], {'weight': 40, 'result': 30, 'completed': True})
        db.complete_workout(self.connection, workout['id'])
        return workout

    def picker(self, include_archived=False):
        catalog = db.catalog_for_gym(self.connection, self.home['id'], include_archived=include_archived)['catalog']
        return {(item['exercise_name'], item['variation_name']) for item in catalog}

    def starter(self, exercise_name, variation_name):
        return next(item for item in db.catalog_for_gym(self.connection, self.home['id'])['catalog']
                    if (item['exercise_name'], item['variation_name']) == (exercise_name, variation_name))

    def test_renaming_a_custom_variation_keeps_recorded_names(self):
        workout = self.completed_workout_with(self.heavy, 'Sled')
        renamed = db.rename_item(self.connection, 'variation', self.heavy['id'], '  Very   Heavy ')
        self.assertEqual((renamed['id'], renamed['name']), (self.heavy['id'], 'Very Heavy'))
        self.assertIn(('Sled Push', 'Very Heavy'), self.picker())
        self.assertNotIn(('Sled Push', 'Heavy'), self.picker())
        self.assertEqual(db.exercise_progress(self.connection, self.heavy['id'])['variation_name'], 'Very Heavy')
        # Completed workouts keep the name they were recorded with.
        entry = db.completed_workout(self.connection, workout['id'])['workout_exercises'][0]
        self.assertEqual(entry['variation_name'], 'Heavy')
        # A case-only rename of the same variation is allowed.
        self.assertEqual(db.rename_item(self.connection, 'variation', self.heavy['id'], 'very heavy')['name'], 'very heavy')

    def test_a_variation_rename_cannot_collide_within_its_exercise_or_be_blank(self):
        light = db.create_exercise(self.connection, 'Sled Push', 'Light', 'duration', ['Sled'])
        old = db.create_exercise(self.connection, 'Sled Push', 'Old', 'duration', ['Sled'])
        self.completed_workout_with(old, 'Sled')
        db.remove_item(self.connection, 'variation', old['id'])
        with self.assertRaisesRegex(RuntimeError, 'Sled Push already has a variation named Light.'):
            db.rename_item(self.connection, 'variation', self.heavy['id'], 'LIGHT')
        with self.assertRaisesRegex(RuntimeError, 'Sled Push already has an archived variation named Old. Restore it in Manage.'):
            db.rename_item(self.connection, 'variation', self.heavy['id'], 'old')
        with self.assertRaisesRegex(ValueError, 'Variation name is required.'):
            db.rename_item(self.connection, 'variation', self.heavy['id'], '  ')
        with self.assertRaisesRegex(ValueError, '80 characters'):
            db.rename_item(self.connection, 'variation', self.heavy['id'], 'x' * 81)
        with self.assertRaises(ValueError):
            db.rename_item(self.connection, 'variation', self.heavy['id'], 5)
        # Another exercise may use the same variation name.
        other = db.create_exercise(self.connection, 'Carry', 'Farmer', 'duration', ['Dumbbell'])
        self.assertEqual(db.rename_item(self.connection, 'variation', other['id'], 'Light')['name'], 'Light')
        self.assertEqual(db.rename_item(self.connection, 'variation', light['id'], 'Light')['name'], 'Light')

    def test_a_never_used_variation_is_deleted_with_its_configurations_and_empty_exercise(self):
        workout = db.start_workout(self.connection, self.home['id'])
        db.add_workout_exercise(self.connection, workout['id'], self.heavy['id'], 'Sled')
        db.cancel_workout(self.connection, workout['id'])
        self.assertEqual(db.remove_item(self.connection, 'variation', self.heavy['id']), {'outcome': 'deleted'})
        self.assertNotIn(('Sled Push', 'Heavy'), self.picker(include_archived=True))
        self.assertEqual(db.catalog_for_gym(self.connection, self.home['id'])['recent'], [])
        self.assertEqual(db.manage_overview(self.connection), {
            'gyms': [{'id': self.home['id'], 'name': 'Home', 'archived': False, 'used': False}],
            'configurations': [], 'exercises': [],
        })
        # Both names are free again.
        recreated = db.create_exercise(self.connection, 'sled push', 'heavy', 'repetitions', ['Rope'])
        self.assertEqual((recreated['exercise_name'], recreated['variation_name']), ('sled push', 'heavy'))

    def test_deleting_one_variation_keeps_its_exercise_and_siblings(self):
        light = db.create_exercise(self.connection, 'Sled Push', 'Light', 'duration', ['Sled'])
        close = db.create_exercise(self.connection, 'Bench Press', 'Close Grip', 'repetitions', ['Barbell'])
        db.remove_item(self.connection, 'variation', self.heavy['id'])
        db.remove_item(self.connection, 'variation', close['id'])
        self.assertIn(('Sled Push', 'Light'), self.picker())
        self.assertIn(('Bench Press', 'Standard'), self.picker())
        self.assertNotIn(('Bench Press', 'Close Grip'), self.picker())
        exercise, = db.manage_overview(self.connection)['exercises']
        self.assertEqual([variation['id'] for variation in exercise['variations']], [light['id']])

    def test_a_used_variation_is_archived_hidden_from_the_picker_and_kept_in_progress(self):
        workout = self.completed_workout_with(self.heavy, 'Prowler')
        self.assertEqual(db.remove_item(self.connection, 'variation', self.heavy['id']), {'outcome': 'archived'})
        self.assertNotIn(('Sled Push', 'Heavy'), self.picker())
        archived = next(item for item in db.catalog_for_gym(self.connection, self.home['id'], include_archived=True)['catalog']
                        if item['id'] == self.heavy['id'])
        self.assertEqual((archived['variation_name'], archived['archived']), ('Heavy', True))
        progress = db.exercise_progress(self.connection, self.heavy['id'])
        self.assertEqual([point['best_result'] for point in progress['points']], [30])
        self.assertEqual(db.completed_workout(self.connection, workout['id'])['workout_exercises'][0]['variation_name'], 'Heavy')
        exercise, = db.manage_overview(self.connection)['exercises']
        self.assertEqual((exercise['archived'], exercise['variations'][0]['archived']), (True, True))

    def test_restoring_a_variation_offers_it_in_the_picker_again(self):
        self.completed_workout_with(self.heavy, 'Prowler')
        db.remove_item(self.connection, 'variation', self.heavy['id'])
        restored = db.restore_item(self.connection, 'variation', self.heavy['id'])
        self.assertEqual((restored['id'], restored['name'], restored['archived']), (self.heavy['id'], 'Heavy', False))
        self.assertIn(('Sled Push', 'Heavy'), self.picker())
        self.assertFalse(db.manage_overview(self.connection)['exercises'][0]['archived'])

    def test_a_new_variation_cannot_reuse_an_archived_variations_name(self):
        self.completed_workout_with(self.heavy, 'Prowler')
        db.remove_item(self.connection, 'variation', self.heavy['id'])
        with self.assertRaisesRegex(RuntimeError, 'Sled Push already has an archived variation named Heavy. Restore it in Manage.'):
            db.create_exercise(self.connection, 'SLED PUSH', ' heavy ', 'duration', ['Sled'])
        with self.assertRaisesRegex(RuntimeError, 'Bench Press already has a variation named Incline.'):
            db.create_exercise(self.connection, 'bench press', 'incline', 'repetitions', ['Barbell'])

    def test_starter_catalog_variations_cannot_be_changed(self):
        press = self.starter('Bench Press', 'Standard')
        for action in (lambda: db.rename_item(self.connection, 'variation', press['id'], 'Flat'),
                       lambda: db.remove_item(self.connection, 'variation', press['id']),
                       lambda: db.restore_item(self.connection, 'variation', press['id'])):
            with self.subTest(action=action), self.assertRaisesRegex(RuntimeError, "Starter catalog exercises can't be changed."):
                action()
        self.assertIn(('Bench Press', 'Standard'), self.picker())
        with self.assertRaisesRegex(LookupError, 'Exercise variation not found.'):
            db.remove_item(self.connection, 'variation', 99999)

    def test_renaming_a_custom_exercise_keeps_recorded_names(self):
        workout = self.completed_workout_with(self.heavy, 'Sled')
        exercise_id = db.manage_overview(self.connection)['exercises'][0]['id']
        renamed = db.rename_item(self.connection, 'exercise', exercise_id, ' Sled   Drive ')
        self.assertEqual((renamed['id'], renamed['name'], renamed['renamable']), (exercise_id, 'Sled Drive', True))
        self.assertIn(('Sled Drive', 'Heavy'), self.picker())
        self.assertEqual(db.exercise_progress(self.connection, self.heavy['id'])['exercise_name'], 'Sled Drive')
        entry = db.completed_workout(self.connection, workout['id'])['workout_exercises'][0]
        self.assertEqual(entry['exercise_name'], 'Sled Push')
        self.assertEqual(db.rename_item(self.connection, 'exercise', exercise_id, 'sled drive')['name'], 'sled drive')

    def test_an_exercise_rename_cannot_collide_or_be_blank(self):
        exercise_id = db.manage_overview(self.connection)['exercises'][0]['id']
        db.create_exercise(self.connection, 'Carry', 'Farmer', 'duration', ['Dumbbell'])
        with self.assertRaisesRegex(RuntimeError, 'An exercise named Carry already exists.'):
            db.rename_item(self.connection, 'exercise', exercise_id, 'carry')
        with self.assertRaisesRegex(RuntimeError, 'An exercise named Squat already exists.'):
            db.rename_item(self.connection, 'exercise', exercise_id, 'SQUAT')
        with self.assertRaisesRegex(ValueError, 'Exercise name is required.'):
            db.rename_item(self.connection, 'exercise', exercise_id, ' ')
        with self.assertRaisesRegex(ValueError, '80 characters'):
            db.rename_item(self.connection, 'exercise', exercise_id, 'x' * 81)
        self.assertIn(('Sled Push', 'Heavy'), self.picker())

    def test_an_exercise_with_starter_variations_cannot_be_renamed(self):
        db.create_exercise(self.connection, 'Bench Press', 'Close Grip', 'repetitions', ['Barbell'])
        bench = next(item for item in db.manage_overview(self.connection)['exercises'] if item['name'] == 'Bench Press')
        self.assertFalse(bench['renamable'])
        with self.assertRaisesRegex(RuntimeError, "Starter catalog exercises can't be changed."):
            db.rename_item(self.connection, 'exercise', bench['id'], 'Chest Press')
        with self.assertRaises(LookupError):
            db.remove_item(self.connection, 'exercise', bench['id'])
        self.assertIn(('Bench Press', 'Close Grip'), self.picker())

    def equipment(self, variation_id):
        return next(item['equipment'] for item in db.catalog_for_gym(self.connection, self.home['id'], include_archived=True)['catalog']
                    if item['id'] == variation_id)

    def test_equipment_can_be_added_reordered_and_unused_values_removed(self):
        self.completed_workout_with(self.heavy, 'Prowler')
        # A cancelled workout leaves a never-used Sled configuration behind.
        workout = db.start_workout(self.connection, self.home['id'])
        db.add_workout_exercise(self.connection, workout['id'], self.heavy['id'], 'Sled', 'Rogue')
        db.cancel_workout(self.connection, workout['id'])
        saved = db.set_variation_equipment(self.connection, self.heavy['id'], [' Rope  Sled ', 'Prowler'])
        self.assertEqual(saved['equipment'], [{'name': 'Rope Sled', 'used': False}, {'name': 'Prowler', 'used': True}])
        self.assertEqual(self.equipment(self.heavy['id']), ['Rope Sled', 'Prowler'])
        # Removing Sled also deleted its never-used configuration.
        self.assertEqual([(item['equipment'], item['manufacturer']) for item in db.manage_overview(self.connection)['configurations']],
                         [('Prowler', '')])
        workout = db.start_workout(self.connection, self.home['id'])
        added = db.add_workout_exercise(self.connection, workout['id'], self.heavy['id'], 'Rope Sled')
        self.assertEqual(added['equipment'], 'Rope Sled')
        with self.assertRaisesRegex(ValueError, 'not available'):
            db.add_workout_exercise(self.connection, workout['id'], self.heavy['id'], 'Sled')

    def test_used_equipment_cannot_be_removed(self):
        self.completed_workout_with(self.heavy, 'Prowler')
        with self.assertRaisesRegex(RuntimeError, 'Prowler is used in recorded workouts, so it cannot be removed.'):
            db.set_variation_equipment(self.connection, self.heavy['id'], ['Sled'])
        with self.assertRaisesRegex(RuntimeError, 'Prowler is used in recorded workouts'):
            db.set_variation_equipment(self.connection, self.heavy['id'], ['Sled', 'prowler'])
        self.assertEqual(self.equipment(self.heavy['id']), ['Sled', 'Prowler'])

    def test_equipment_lists_are_validated_like_new_custom_exercises(self):
        for equipment, message in ((['Sled', 'SLED'], 'unique'), ([], '1 to 20'), (['a|b'], 'cannot contain'),
                                   ('Sled', '1 to 20'), ([' '], '1 to 80'), ([7], 'strings'),
                                   ([str(n) for n in range(21)], '1 to 20')):
            with self.subTest(equipment=equipment), self.assertRaisesRegex(ValueError, message):
                db.set_variation_equipment(self.connection, self.heavy['id'], equipment)
        self.assertEqual(self.equipment(self.heavy['id']), ['Sled', 'Prowler'])
        press = self.starter('Bench Press', 'Standard')
        with self.assertRaisesRegex(RuntimeError, "Starter catalog exercises can't be changed."):
            db.set_variation_equipment(self.connection, press['id'], ['Barbell'])
        with self.assertRaisesRegex(LookupError, 'Exercise variation not found.'):
            db.set_variation_equipment(self.connection, 99999, ['Sled'])


if __name__ == '__main__':
    unittest.main()
