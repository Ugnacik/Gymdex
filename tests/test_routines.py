import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from gymdex import db
from gymdex.server import GymdexHandler


class RoutineTests(unittest.TestCase):
    """A Routine is a saved plan of Exercise Configurations and set counts for one Gym."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'routines.sqlite3'
        self.connection = db.connect(self.path)
        db.initialize(self.connection)
        self.home = db.create_gym(self.connection, 'Home')
        self.other = db.create_gym(self.connection, 'Other')
        catalog = db.catalog_for_gym(self.connection, self.home['id'])['catalog']
        self.press = next(v for v in catalog if (v['exercise_name'], v['variation_name']) == ('Bench Press', 'Standard'))
        self.plank = next(v for v in catalog if v['exercise_name'] == 'Plank')

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()

    def request(self, method, path, payload=None):
        handler = object.__new__(GymdexHandler)
        handler.server = SimpleNamespace(db_path=self.path)
        handler.path = path
        body = json.dumps(payload if payload is not None else {}).encode()
        handler.headers = {'Content-Length': str(len(body))}
        handler.rfile = io.BytesIO(body)
        response = []
        handler._json = lambda data, status=200: response.append((int(status), data))
        getattr(handler, f'do_{method}')()
        return response[0]

    def completed_workout(self, gym=None, sets=((60, 5, True), (60, 5, True), (60, 4, False))):
        """A completed workout with Bench Press (Rack 1) and Plank at the gym."""
        workout = db.start_workout(self.connection, (gym or self.home)['id'])
        press = db.add_workout_exercise(self.connection, workout['id'], self.press['id'], 'Barbell', '', 'Rack 1')
        plank = db.add_workout_exercise(self.connection, workout['id'], self.plank['id'], 'Bodyweight')
        slot = db.sets_for_exercise(self.connection, press['id'])[0]
        for index, (weight, result, completed) in enumerate(sets):
            if index:
                slot = db.add_set(self.connection, press['id'])
            db.update_set(self.connection, slot['id'], {'weight': weight, 'result': result, 'completed': completed})
        db.complete_workout(self.connection, workout['id'])
        return workout, press, plank

    def profile_id(self, label='Rack 1', variation=None, gym=None):
        return self.connection.execute(
            'SELECT id FROM gym_exercise_profiles WHERE gym_id = ? AND variation_id = ? AND label = ?',
            ((gym or self.home)['id'], (variation or self.press)['id'], label),
        ).fetchone()['id']

    def summary(self, routine):
        return [(item['exercise_name'], item['label'], item['set_count']) for item in routine['exercises']]

    # Migration 5

    def test_version_four_database_gains_empty_routine_tables_and_keeps_its_workouts(self):
        workout, _, _ = self.completed_workout()
        self.connection.execute('DROP TABLE routine_exercises')
        self.connection.execute('DROP TABLE routines')
        self.connection.execute('PRAGMA user_version = 4')
        self.connection.commit()

        db.initialize(self.connection)
        db.initialize(self.connection)

        self.assertEqual(self.connection.execute('PRAGMA user_version').fetchone()[0], 5)
        self.assertEqual(db.routines_for_gym(self.connection, self.home['id'])['routines'], [])
        self.assertEqual(db.workout_history(self.connection)['workouts'][0]['id'], workout['id'])

    def test_routine_rows_refuse_invalid_set_counts_and_unknown_parents(self):
        routine = db.create_routine(self.connection, self.home['id'], 'Push')
        self.completed_workout()
        profile = self.profile_id()
        for set_count in (0, 21):
            with self.subTest(set_count=set_count), self.assertRaises(sqlite3.IntegrityError):
                self.connection.execute(
                    'INSERT INTO routine_exercises(routine_id, position, profile_id, set_count) VALUES (?, 1, ?, ?)',
                    (routine['id'], profile, set_count))
        self.connection.rollback()
        with self.assertRaises(sqlite3.IntegrityError):
            self.connection.execute('INSERT INTO routines(gym_id, name) VALUES (9999, ?)', ('Ghost',))
        self.connection.rollback()

    # Creating and editing

    def test_a_routine_is_created_empty_for_a_gym_and_listed_by_name(self):
        db.create_routine(self.connection, self.home['id'], '  Pull   day ')
        created = db.create_routine(self.connection, self.home['id'], 'Legs')
        db.create_routine(self.connection, self.other['id'], 'Elsewhere')
        self.assertEqual((created['gym_id'], created['name'], created['exercises']), (self.home['id'], 'Legs', []))
        routines = db.routines_for_gym(self.connection, self.home['id'])['routines']
        self.assertEqual([routine['name'] for routine in routines], ['Legs', 'Pull day'])

    def test_routine_names_are_required_short_and_unique_per_gym_ignoring_case(self):
        db.create_routine(self.connection, self.home['id'], 'Push')
        for name, error in (('  ', ValueError), ('x' * 81, ValueError), (7, ValueError), ('push', RuntimeError)):
            with self.subTest(name=name), self.assertRaises(error):
                db.create_routine(self.connection, self.home['id'], name)
        self.assertEqual(db.create_routine(self.connection, self.other['id'], 'Push')['name'], 'Push')
        with self.assertRaises(LookupError):
            db.create_routine(self.connection, 9999, 'Push')

    def test_saving_a_workout_as_a_routine_keeps_configurations_in_order_with_completed_set_counts(self):
        workout, _, _ = self.completed_workout()
        routine = db.save_workout_as_routine(self.connection, workout['id'], 'Monday')
        self.assertEqual(routine['skipped'], 0)
        self.assertEqual(routine['gym_id'], self.home['id'])
        # Two of three press sets were completed; the plank had none, so it keeps one slot.
        self.assertEqual(self.summary(routine), [('Bench Press', 'Rack 1', 2), ('Plank', '', 1)])
        self.assertEqual([item['position'] for item in routine['exercises']], [1, 2])
        self.assertEqual(routine['exercises'][0]['profile_id'], self.profile_id())
        # The source workout stays as it was.
        self.assertEqual(len(db.completed_workout(self.connection, workout['id'])['workout_exercises']), 2)

    def test_saving_as_a_routine_skips_archived_configurations_and_refuses_archived_gyms_and_active_workouts(self):
        workout, _, _ = self.completed_workout()
        db.remove_item(self.connection, 'configuration', self.profile_id())
        routine = db.save_workout_as_routine(self.connection, workout['id'], 'Core')
        self.assertEqual((routine['skipped'], self.summary(routine)), (1, [('Plank', '', 1)]))
        active = db.start_workout(self.connection, self.other['id'])
        with self.assertRaises(LookupError):
            db.save_workout_as_routine(self.connection, active['id'], 'Active')
        db.cancel_workout(self.connection, active['id'])
        db.remove_item(self.connection, 'gym', self.home['id'])
        with self.assertRaisesRegex(RuntimeError, 'Home is archived'):
            db.save_workout_as_routine(self.connection, workout['id'], 'Later')

    def test_updating_a_routine_renames_it_and_replaces_its_exercises_and_set_counts(self):
        self.completed_workout()
        routine = db.create_routine(self.connection, self.home['id'], 'Push')
        press, plank = self.profile_id(), self.profile_id('', self.plank)
        updated = db.update_routine(self.connection, routine['id'], {'name': 'Push A', 'exercises': [
            {'profile_id': plank, 'set_count': 3}, {'profile_id': press, 'set_count': 5},
        ]})
        self.assertEqual(updated['name'], 'Push A')
        self.assertEqual(self.summary(updated), [('Plank', '', 3), ('Bench Press', 'Rack 1', 5)])
        reordered = db.update_routine(self.connection, routine['id'], {'exercises': [
            {'profile_id': press, 'set_count': 4}, {'profile_id': plank, 'set_count': 3}, {'profile_id': press, 'set_count': 1},
        ]})
        self.assertEqual(reordered['name'], 'Push A')
        self.assertEqual(self.summary(reordered), [('Bench Press', 'Rack 1', 4), ('Plank', '', 3), ('Bench Press', 'Rack 1', 1)])
        self.assertEqual([item['position'] for item in reordered['exercises']], [1, 2, 3])
        self.assertEqual(self.summary(db.update_routine(self.connection, routine['id'], {'exercises': []})), [])

    def test_routine_exercises_are_validated_and_must_belong_to_the_routines_gym(self):
        self.completed_workout()
        self.completed_workout(gym=self.other)
        routine = db.create_routine(self.connection, self.home['id'], 'Push')
        db.create_routine(self.connection, self.home['id'], 'Pull')
        press = self.profile_id()
        for exercises in ('x', [{'profile_id': press}], [{'profile_id': press, 'set_count': 0}],
                          [{'profile_id': press, 'set_count': 21}], [{'profile_id': press, 'set_count': True}],
                          [{'profile_id': '1', 'set_count': 1}], [{'profile_id': press, 'set_count': 1}] * 51,
                          [{'profile_id': self.profile_id(gym=self.other), 'set_count': 1}],
                          [{'profile_id': 9999, 'set_count': 1}]):
            with self.subTest(exercises=exercises), self.assertRaises(ValueError):
                db.update_routine(self.connection, routine['id'], {'exercises': exercises})
        with self.assertRaises(RuntimeError):
            db.update_routine(self.connection, routine['id'], {'name': 'PULL'})
        with self.assertRaises(LookupError):
            db.update_routine(self.connection, 9999, {'name': 'Nope'})
        self.assertEqual(db.update_routine(self.connection, routine['id'], {'name': 'push'})['name'], 'push')

    def test_deleting_a_routine_removes_it_and_its_exercises(self):
        workout, _, _ = self.completed_workout()
        routine = db.save_workout_as_routine(self.connection, workout['id'], 'Monday')
        self.assertEqual(db.delete_routine(self.connection, routine['id']), {'ok': True})
        self.assertEqual(db.routines_for_gym(self.connection, self.home['id'])['routines'], [])
        self.assertEqual(self.connection.execute('SELECT COUNT(*) FROM routine_exercises').fetchone()[0], 0)
        with self.assertRaises(LookupError):
            db.delete_routine(self.connection, routine['id'])

    def test_the_routines_screen_offers_the_gyms_unarchived_configurations_most_recent_first(self):
        self.completed_workout()
        self.completed_workout(gym=self.other)
        db.remove_item(self.connection, 'configuration', self.profile_id('', self.plank))
        configurations = db.routines_for_gym(self.connection, self.home['id'])['configurations']
        self.assertEqual([(item['profile_id'], item['exercise_name'], item['label']) for item in configurations],
                         [(self.profile_id(), 'Bench Press', 'Rack 1')])

    # Starting

    def test_starting_a_routine_starts_a_workout_with_its_set_count_of_empty_slots(self):
        workout, _, _ = self.completed_workout()
        routine = db.save_workout_as_routine(self.connection, workout['id'], 'Monday')
        db.update_routine(self.connection, routine['id'], {'exercises': [
            {'profile_id': self.profile_id('', self.plank), 'set_count': 1},
            {'profile_id': self.profile_id(), 'set_count': 3},
        ]})
        started = db.start_routine(self.connection, routine['id'])
        self.assertEqual((started['gym_id'], started['gym_name'], started['skipped']), (self.home['id'], 'Home', 0))
        state = db.bootstrap(self.connection)
        self.assertEqual(state['active_workout']['id'], started['id'])
        entries = state['workout_exercises']
        self.assertEqual([(entry['exercise_name'], entry['label'], entry['position']) for entry in entries],
                         [('Plank', '', 1), ('Bench Press', 'Rack 1', 2)])
        press = entries[1]
        self.assertEqual([(s['position'], s['weight'], s['result'], s['completed']) for s in press['sets']],
                         [(1, None, None, 0), (2, None, None, 0), (3, None, None, 0)])
        # Last workout references come from the last matching workout, as for any added exercise.
        self.assertEqual([(s['weight'], s['result']) for s in press['previous_sets']], [(60, 5), (60, 5)])
        self.assertEqual(self.connection.execute(
            'SELECT gym_profile_id FROM workout_exercises WHERE id = ?', (press['id'],)).fetchone()[0], self.profile_id())

    def test_starting_a_routine_uses_current_names_and_skips_archived_configurations_and_variations(self):
        sled = db.create_exercise(self.connection, 'Sled Push', 'Heavy', 'duration', ['Sled'])
        workout = db.start_workout(self.connection, self.home['id'])
        db.add_workout_exercise(self.connection, workout['id'], sled['id'], 'Sled')
        db.complete_workout(self.connection, workout['id'])
        workout, _, _ = self.completed_workout()
        routine = db.create_routine(self.connection, self.home['id'], 'Mixed')
        sled_profile = self.profile_id('', sled)
        db.update_routine(self.connection, routine['id'], {'exercises': [
            {'profile_id': sled_profile, 'set_count': 2}, {'profile_id': self.profile_id(), 'set_count': 2},
            {'profile_id': self.profile_id('', self.plank), 'set_count': 1},
        ]})
        db.remove_item(self.connection, 'variation', sled['id'])
        db.remove_item(self.connection, 'configuration', self.profile_id('', self.plank))
        listed = db.routines_for_gym(self.connection, self.home['id'])['routines'][0]
        self.assertEqual([item['archived'] for item in listed['exercises']], [True, False, True])

        started = db.start_routine(self.connection, routine['id'])

        self.assertEqual(started['skipped'], 2)
        entries = db.bootstrap(self.connection)['workout_exercises']
        self.assertEqual([(entry['exercise_name'], entry['position'], len(entry['sets'])) for entry in entries],
                         [('Bench Press', 1, 2)])

    def test_a_routine_cannot_start_during_an_active_workout_or_at_an_archived_gym(self):
        workout, _, _ = self.completed_workout()
        routine = db.save_workout_as_routine(self.connection, workout['id'], 'Monday')
        active = db.start_workout(self.connection, self.other['id'])
        with self.assertRaisesRegex(RuntimeError, 'already active'):
            db.start_routine(self.connection, routine['id'])
        db.cancel_workout(self.connection, active['id'])
        db.remove_item(self.connection, 'gym', self.home['id'])
        with self.assertRaisesRegex(RuntimeError, 'Home is archived'):
            db.start_routine(self.connection, routine['id'])
        with self.assertRaises(LookupError):
            db.start_routine(self.connection, 9999)
        self.assertIsNone(db.bootstrap(self.connection)['active_workout'])

    # Start screen and Manage

    def test_bootstrap_lists_routines_of_unarchived_gyms_for_the_start_screen(self):
        workout, _, _ = self.completed_workout()
        db.save_workout_as_routine(self.connection, workout['id'], 'Monday')
        db.create_routine(self.connection, self.other['id'], 'Empty')
        listed = db.bootstrap(self.connection)['routines']
        self.assertEqual([(item['gym_id'], item['name'], item['exercise_count']) for item in listed],
                         [(self.home['id'], 'Monday', 2), (self.other['id'], 'Empty', 0)])
        db.remove_item(self.connection, 'gym', self.home['id'])
        self.assertEqual([item['name'] for item in db.bootstrap(self.connection)['routines']], ['Empty'])

    def test_deleting_a_gym_or_configuration_in_manage_removes_it_from_routines(self):
        workout = db.start_workout(self.connection, self.other['id'])
        db.add_workout_exercise(self.connection, workout['id'], self.press['id'], 'Barbell', '', 'Rack 1')
        db.add_workout_exercise(self.connection, workout['id'], self.plank['id'], 'Bodyweight')
        db.cancel_workout(self.connection, workout['id'])
        routine = db.create_routine(self.connection, self.other['id'], 'Unused')
        db.update_routine(self.connection, routine['id'], {'exercises': [
            {'profile_id': self.profile_id(gym=self.other), 'set_count': 2},
            {'profile_id': self.profile_id('', self.plank, self.other), 'set_count': 1},
        ]})
        self.assertEqual(db.remove_item(self.connection, 'configuration', self.profile_id(gym=self.other)), {'outcome': 'deleted'})
        remaining = db.routines_for_gym(self.connection, self.other['id'])['routines'][0]
        self.assertEqual([(item['exercise_name'], item['position']) for item in remaining['exercises']], [('Plank', 1)])
        self.assertEqual(db.remove_item(self.connection, 'gym', self.other['id']), {'outcome': 'deleted'})
        self.assertEqual(self.connection.execute('SELECT COUNT(*) FROM routines').fetchone()[0], 0)

    # HTTP routes

    def test_routine_routes_create_edit_start_and_delete(self):
        workout, _, _ = self.completed_workout()
        status, saved = self.request('POST', f'/api/history/{workout["id"]}/routine', {'name': 'Monday'})
        self.assertEqual((status, saved['name'], saved['skipped']), (201, 'Monday', 0))
        self.assertEqual(self.request('POST', f'/api/history/{workout["id"]}/routine', {'name': 'monday'})[0], 409)
        self.assertEqual(self.request('POST', '/api/history/9999/routine', {'name': 'X'})[0], 404)

        status, listing = self.request('GET', f'/api/routines?gym_id={self.home["id"]}')
        self.assertEqual((status, [item['name'] for item in listing['routines']]), (200, ['Monday']))
        self.assertEqual(len(listing['configurations']), 2)
        self.assertEqual(self.request('GET', '/api/routines?gym_id=x')[0], 400)
        self.assertEqual(self.request('GET', '/api/routines?gym_id=9999')[0], 404)

        status, created = self.request('POST', '/api/routines', {'gym_id': self.home['id'], 'name': 'Core'})
        self.assertEqual((status, created['exercises']), (201, []))
        self.assertEqual(self.request('POST', '/api/routines', {'gym_id': 'x', 'name': 'Core'})[0], 400)
        path = f'/api/routines/{created["id"]}'
        status, updated = self.request('PUT', path, {'name': 'Core A', 'exercises': [
            {'profile_id': self.profile_id('', self.plank), 'set_count': 3}]})
        self.assertEqual((status, updated['name'], self.summary(updated)), (200, 'Core A', [('Plank', '', 3)]))
        self.assertEqual(self.request('PUT', path, {'exercises': [{'profile_id': 1, 'set_count': 0}]})[0], 400)
        self.assertEqual(self.request('PUT', '/api/routines/9999', {'name': 'X'})[0], 404)

        status, started = self.request('POST', f'{path}/start')
        self.assertEqual((status, started['gym_id'], started['skipped']), (201, self.home['id'], 0))
        self.assertEqual(self.request('POST', f'{path}/start')[0], 409)
        self.request('DELETE', f'/api/workouts/{started["id"]}')

        self.assertEqual(self.request('DELETE', path), (200, {'ok': True}))
        self.assertEqual(self.request('DELETE', path)[0], 404)
        self.assertEqual(self.request('POST', '/api/routines/9999/start')[0], 404)


if __name__ == '__main__':
    unittest.main()
