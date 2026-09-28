import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from gymdex import db
from gymdex.server import GymdexHandler


class ChangeConfigurationTests(unittest.TestCase):
    """A Workout Exercise in the Active Workout can switch to another Exercise Configuration
    (equipment, manufacturer, machine label) of its Variation, keeping its sets and note."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'change.sqlite3'
        self.connection = db.connect(self.path)
        db.initialize(self.connection)
        self.gym = db.create_gym(self.connection, 'Home')
        catalog = db.catalog_for_gym(self.connection, self.gym['id'])['catalog']
        self.press = next(v for v in catalog if (v['exercise_name'], v['variation_name']) == ('Bench Press', 'Standard'))

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

    def configurations(self):
        return [(row['equipment'], row['manufacturer'], row['label'], row['archived_at'] is not None)
                for row in self.connection.execute(
                    'SELECT * FROM gym_exercise_profiles WHERE variation_id = ? ORDER BY id', (self.press['id'],))]

    def logged_press(self, equipment='Machine', manufacturer='Cybex', label='', finish=False):
        """A workout with Bench Press whose first set is 50 kg x 8, completed."""
        workout = db.start_workout(self.connection, self.gym['id'])
        entry = db.add_workout_exercise(self.connection, workout['id'], self.press['id'], equipment, manufacturer, label)
        slot = db.sets_for_exercise(self.connection, entry['id'])[0]
        db.update_set(self.connection, slot['id'], {'weight': 50, 'result': 8, 'completed': True})
        if finish:
            db.complete_workout(self.connection, workout['id'])
        return workout, entry

    def test_switching_keeps_sets_and_note_and_deletes_the_mistaken_unused_configuration(self):
        workout, entry = self.logged_press()
        db.set_workout_exercise_note(self.connection, entry['id'], 'Seat 4')
        extra = db.add_set(self.connection, entry['id'])

        changed = db.change_workout_exercise_configuration(
            self.connection, workout['id'], entry['id'], 'Machine', '  Technogym ', 'Upstairs  2')

        self.assertEqual((changed['id'], changed['equipment'], changed['manufacturer'], changed['label']),
                         (entry['id'], 'Machine', 'Technogym', 'Upstairs 2'))
        shown = db.bootstrap(self.connection)['workout_exercises'][0]
        self.assertEqual((shown['equipment'], shown['manufacturer'], shown['label'], shown['note']),
                         ('Machine', 'Technogym', 'Upstairs 2', 'Seat 4'))
        self.assertEqual([(s['id'], s['weight'], s['result'], s['completed']) for s in shown['sets']],
                         [(shown['sets'][0]['id'], 50, 8, 1), (extra['id'], 50, 8, 0)])
        # Cybex was only ever this Workout Exercise's configuration, so it no longer lingers in Recent.
        self.assertEqual(self.configurations(), [('Machine', 'Technogym', 'Upstairs 2', False)])
        profile = self.connection.execute(
            'SELECT gym_profile_id FROM workout_exercises WHERE id = ?', (entry['id'],)).fetchone()[0]
        recent = db.catalog_for_gym(self.connection, self.gym['id'])['recent']
        self.assertEqual([(item['profile_id'], item['manufacturer']) for item in recent], [(profile, 'Technogym')])

    def test_last_workout_follows_the_new_configuration(self):
        self.logged_press(manufacturer='Technogym', finish=True)
        workout, entry = self.logged_press(manufacturer='Cybex')
        self.assertEqual(db.bootstrap(self.connection)['workout_exercises'][0]['previous_sets'], [])

        db.change_workout_exercise_configuration(self.connection, workout['id'], entry['id'], 'Machine', 'Technogym', '')

        previous = db.bootstrap(self.connection)['workout_exercises'][0]['previous_sets']
        self.assertEqual([(s['weight'], s['result']) for s in previous], [(50, 8)])

    def test_an_existing_configuration_is_reused_and_restored_when_archived(self):
        self.logged_press(manufacturer='Technogym', finish=True)
        technogym = self.connection.execute(
            "SELECT id FROM gym_exercise_profiles WHERE manufacturer = 'Technogym'").fetchone()[0]
        db.remove_item(self.connection, 'configuration', technogym)
        workout, entry = self.logged_press(manufacturer='Cybex')

        db.change_workout_exercise_configuration(self.connection, workout['id'], entry['id'], 'Machine', 'Technogym', '')

        self.assertEqual(self.configurations(), [('Machine', 'Technogym', '', False)])
        self.assertEqual(self.connection.execute(
            'SELECT gym_profile_id FROM workout_exercises WHERE id = ?', (entry['id'],)).fetchone()[0], technogym)

    def test_the_old_configuration_stays_when_another_workout_or_a_routine_uses_it(self):
        self.logged_press(manufacturer='Cybex', finish=True)
        workout, entry = self.logged_press(manufacturer='Cybex')
        db.change_workout_exercise_configuration(self.connection, workout['id'], entry['id'], 'Barbell', '', '')
        self.assertIn(('Machine', 'Cybex', '', False), self.configurations())

        db.cancel_workout(self.connection, workout['id'])
        workout, entry = self.logged_press(manufacturer='Hammer')
        hammer = self.connection.execute(
            "SELECT id FROM gym_exercise_profiles WHERE manufacturer = 'Hammer'").fetchone()[0]
        db.create_routine(self.connection, self.gym['id'], 'Push', [{'profile_id': hammer, 'set_count': 3}])
        db.change_workout_exercise_configuration(self.connection, workout['id'], entry['id'], 'Barbell', '', '')
        self.assertIn(('Machine', 'Hammer', '', False), self.configurations())

    def test_choosing_the_same_configuration_changes_nothing(self):
        workout, entry = self.logged_press()
        db.change_workout_exercise_configuration(self.connection, workout['id'], entry['id'], 'Machine', 'Cybex', '')
        self.assertEqual(self.configurations(), [('Machine', 'Cybex', '', False)])

    def test_only_equipment_of_the_variation_in_the_active_workout_can_be_chosen(self):
        workout, entry = self.logged_press()
        with self.assertRaisesRegex(ValueError, 'equipment is not available'):
            db.change_workout_exercise_configuration(self.connection, workout['id'], entry['id'], 'Rope', '', '')
        with self.assertRaises(LookupError):
            db.change_workout_exercise_configuration(self.connection, workout['id'] + 1, entry['id'], 'Machine', '', '')
        db.complete_workout(self.connection, workout['id'])
        with self.assertRaises(LookupError):
            db.change_workout_exercise_configuration(self.connection, workout['id'], entry['id'], 'Machine', '', '')
        self.assertEqual(self.configurations(), [('Machine', 'Cybex', '', False)])

    def test_an_archived_variation_cannot_change_machine(self):
        created = db.create_exercise(self.connection, 'Sled Push', 'Standard', 'repetitions', ['Sled', 'Machine'])
        workout = db.start_workout(self.connection, self.gym['id'])
        entry = db.add_workout_exercise(self.connection, workout['id'], created['id'], 'Sled')
        db.remove_item(self.connection, 'variation', created['id'])
        with self.assertRaisesRegex(RuntimeError, 'archived'):
            db.change_workout_exercise_configuration(self.connection, workout['id'], entry['id'], 'Machine', '', '')

    def test_the_route_changes_the_configuration_and_reports_errors(self):
        workout, entry = self.logged_press()
        path = f"/api/workouts/{workout['id']}/exercises/{entry['id']}/configuration"
        status, body = self.request('PUT', path, {'equipment': 'Barbell', 'manufacturer': 'Eleiko', 'label': 'Rack 2'})
        self.assertEqual((status, body['equipment'], body['manufacturer'], body['label']), (200, 'Barbell', 'Eleiko', 'Rack 2'))
        self.assertEqual(self.request('PUT', path, {'equipment': 'Rope'})[0], 400)
        self.assertEqual(self.request('PUT', path, {'equipment': 3})[0], 400)
        self.assertEqual(self.request('PUT', f"/api/workouts/{workout['id']}/exercises/999/configuration",
                                      {'equipment': 'Machine'})[0], 404)
        self.assertEqual(self.request('PUT', f"/api/workouts/x/exercises/{entry['id']}/configuration",
                                      {'equipment': 'Machine'})[0], 404)


if __name__ == '__main__':
    unittest.main()
