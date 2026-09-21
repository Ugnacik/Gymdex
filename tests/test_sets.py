import io
import json
import math
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from gymdex import db
from gymdex.server import GymdexHandler


class SetTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'sets.sqlite3'
        self.connection = db.connect(self.path)
        db.initialize(self.connection)
        self.gym = db.create_gym(self.connection, 'Home')
        self.workout = db.start_workout(self.connection, self.gym['id'])
        catalog = db.catalog_for_gym(self.connection, self.gym['id'])['catalog']
        self.press = next(v for v in catalog if v['exercise_name'] == 'Bench Press' and v['variation_name'] == 'Standard')
        self.plank = next(v for v in catalog if v['tracking_type'] == 'duration')
        self.entry = self.add_exercise(self.press, 'Barbell')

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()

    def add_exercise(self, variation, equipment, manufacturer='', label=''):
        return db.add_workout_exercise(self.connection, self.workout['id'], variation['id'], equipment, manufacturer, label)

    def first_set(self, entry=None):
        return db.sets_for_exercise(self.connection, (entry or self.entry)['id'])[0]

    def save(self, item, result=8, weight=42.5, completed=True):
        return db.update_set(self.connection, item['id'], dict(result=result, weight=weight, completed=completed))

    def test_repetitions_completion_and_persistence(self):
        initial = self.first_set()
        self.assertEqual(initial['completed'], 0)
        self.save(initial)
        with db.connect(self.path) as reopened:
            entry = db.bootstrap(reopened)['workout_exercises'][0]
        self.assertEqual(entry['tracking_type'], 'repetitions')
        self.assertEqual(entry['sets'][0]['weight'], 42.5)
        self.assertEqual(entry['sets'][0]['result'], 8)
        self.assertEqual(entry['sets'][0]['completed'], 1)
        self.save(initial, completed=False)
        self.assertEqual(self.first_set()['completed'], 0)

    def test_duration_and_optional_or_assisted_weight(self):
        entry = self.add_exercise(self.plank, 'Bodyweight')
        item = self.first_set(entry)
        self.save(item, result=60, weight=None)
        self.assertEqual(self.first_set(entry)['result'], 60)
        self.assertIsNone(self.first_set(entry)['weight'])
        self.save(item, result=45, weight=-12.5)
        self.assertEqual(self.first_set(entry)['weight'], -12.5)
        self.assertEqual(db.bootstrap(self.connection)['workout_exercises'][1]['tracking_type'], 'duration')

    def test_invalid_inputs_do_not_change_saved_set(self):
        item = self.first_set()
        self.save(item)
        for values in [dict(result=None), dict(result=0), dict(result=-1), dict(result=1.5),
                       dict(result=True), dict(result='8'), dict(result=1000001),
                       dict(weight=math.inf), dict(weight=math.nan), dict(weight=True),
                       dict(weight='heavy'), dict(completed=1)]:
            with self.subTest(values=values):
                payload = dict(result=8, weight=42.5, completed=True) | values
                with self.assertRaises(ValueError):
                    db.update_set(self.connection, item['id'], payload)
                self.assertEqual(self.first_set()['result'], 8)
        self.save(item, result=None, weight=None, completed=False)
        self.assertIsNone(self.first_set()['result'])

    def test_set_order_removal_and_missing_ids(self):
        second = db.add_set(self.connection, self.entry['id'])
        third = db.add_set(self.connection, self.entry['id'])
        db.delete_set(self.connection, second['id'])
        fourth = db.add_set(self.connection, self.entry['id'])
        self.assertEqual([s['position'] for s in db.sets_for_exercise(self.connection, self.entry['id'])], [1, 3, 4])
        self.assertNotEqual(fourth['id'], second['id'])
        for action in [lambda: db.add_set(self.connection, 999), lambda: db.delete_set(self.connection, second['id']), lambda: self.save(second)]:
            with self.assertRaises(LookupError):
                action()
        self.assertEqual(third['position'], 3)

    def test_completed_workout_rejects_set_mutations(self):
        item = self.first_set()
        self.save(item)
        db.complete_workout(self.connection, self.workout['id'])
        for action in [lambda: db.add_set(self.connection, self.entry['id']), lambda: self.save(item), lambda: db.delete_set(self.connection, item['id'])]:
            with self.assertRaises(LookupError):
                action()
        self.assertEqual(self.first_set()['completed'], 1)

    def test_previous_sets_match_gym_variation_and_equipment_details(self):
        self.save(self.first_set())
        draft = db.add_set(self.connection, self.entry['id'])
        self.save(draft, result=7, completed=False)
        db.complete_workout(self.connection, self.workout['id'])
        self.workout = db.start_workout(self.connection, self.gym['id'])
        self.add_exercise(self.press, 'Barbell')
        self.add_exercise(self.press, 'Dumbbell')
        self.add_exercise(self.press, 'Barbell', 'Different', 'Machine')
        entries = db.bootstrap(self.connection)['workout_exercises']
        self.assertEqual(len(entries[0]['previous_sets']), 1)
        self.assertEqual(entries[0]['previous_sets'][0]['result'], 8)
        self.assertEqual(entries[1]['previous_sets'], [])
        self.assertEqual(entries[2]['previous_sets'], [])
        db.complete_workout(self.connection, self.workout['id'])
        other = db.create_gym(self.connection, 'Other gym')
        self.workout = db.start_workout(self.connection, other['id'])
        self.add_exercise(self.press, 'Barbell')
        self.assertEqual(db.bootstrap(self.connection)['workout_exercises'][0]['previous_sets'], [])

    def test_migration_preserves_existing_workout_and_is_repeatable(self):
        self.connection.execute('DROP TABLE workout_sets')
        self.connection.execute('ALTER TABLE workout_exercises DROP COLUMN tracking_type_snapshot')
        self.connection.execute('PRAGMA user_version = 0')
        self.connection.commit()
        db.initialize(self.connection)
        db.initialize(self.connection)
        entry = db.bootstrap(self.connection)['workout_exercises'][0]
        self.assertEqual(entry['id'], self.entry['id'])
        self.assertEqual(entry['tracking_type'], 'repetitions')
        self.assertEqual(entry['sets'], [])
        self.assertEqual(db.add_set(self.connection, entry['id'])['position'], 1)

    def request(self, method, path, payload=None):
        handler = object.__new__(GymdexHandler)
        handler.server = SimpleNamespace(db_path=self.path)
        handler.path = path
        body = json.dumps(payload).encode()
        handler.headers = {'Content-Length': str(len(body))}
        handler.rfile = io.BytesIO(body)
        response = []
        handler._json = lambda data, status=200: response.append((int(status), data))
        getattr(handler, f'do_{method}')()
        return response[0]

    def test_set_routes_and_bad_payloads(self):
        status, item = self.request('POST', f'/api/workout-exercises/{self.entry["id"]}/sets', {})
        self.assertEqual(status, 201)
        status, saved = self.request('PUT', f'/api/sets/{item["id"]}', dict(result=12, weight=None, completed=True))
        self.assertEqual(status, 200)
        self.assertEqual(saved['completed'], 1)
        for payload in [[], None, dict(result=0, weight=None, completed=True)]:
            self.assertEqual(self.request('PUT', f'/api/sets/{item["id"]}', payload)[0], 400)
        self.assertEqual(self.request('PUT', '/api/sets/invalid', {})[0], 400)
        self.assertEqual(self.request('DELETE', f'/api/sets/{item["id"]}')[0], 200)
        self.assertEqual(self.request('DELETE', f'/api/sets/{item["id"]}')[0], 404)


if __name__ == '__main__':
    unittest.main()
