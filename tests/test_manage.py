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


if __name__ == '__main__':
    unittest.main()
