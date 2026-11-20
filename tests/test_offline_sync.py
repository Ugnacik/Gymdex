import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from gymdex import db
from gymdex.server import GymdexHandler


class OfflineSyncTests(unittest.TestCase):
    """What the phone's outbox relies on: idempotent adds and finish, and full entries in answers."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'offline.sqlite3'
        self.connection = db.connect(self.path)
        db.initialize(self.connection)
        self.gym = db.create_gym(self.connection, 'Home')
        catalog = db.catalog_for_gym(self.connection, self.gym['id'])['catalog']
        self.curl = next(v for v in catalog if (v['exercise_name'], v['variation_name']) == ('Biceps Curl', 'Standing'))
        self.workout = db.start_workout(self.connection, self.gym['id'])

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

    def add_curl(self, request_id='outbox-1'):
        return self.request('POST', f"/api/workouts/{self.workout['id']}/exercises", {
            'variation_id': self.curl['id'], 'equipment': 'Dumbbell', 'manufacturer': '', 'label': '', 'request_id': request_id})

    def set_count(self, exercise_id):
        return self.connection.execute(
            'SELECT COUNT(*) FROM workout_sets WHERE workout_exercise_id = ?', (exercise_id,)).fetchone()[0]

    def test_add_exercise_answers_with_the_entry_as_bootstrap_shows_it(self):
        status, added = self.add_curl()
        self.assertEqual(status, 201)
        entry = added['entry']
        self.assertEqual(entry['id'], added['id'])
        self.assertEqual(entry['exercise_name'], 'Biceps Curl')
        for key in ('sets', 'previous_sets', 'record_bests', 'records', 'tracking_type', 'assisted'):
            self.assertIn(key, entry)
        bootstrap = db.bootstrap(self.connection)['workout_exercises']
        self.assertEqual(entry, next(item for item in bootstrap if item['id'] == added['id']))

    def test_add_set_with_a_request_id_adds_once_and_keeps_the_values_the_phone_showed(self):
        _, added = self.add_curl()
        route = f"/api/workout-exercises/{added['id']}/sets"
        payload = {'weight': 12.5, 'result': 10, 'side': 'right', 'set_type': 'warmup', 'request_id': 'outbox-2'}
        first = self.request('POST', route, payload)
        again = self.request('POST', route, payload)
        self.assertEqual(first, again)
        self.assertEqual(first[0], 201)
        self.assertEqual(self.set_count(added['id']), 2)
        saved = first[1]
        self.assertEqual((saved['weight'], saved['result'], saved['side'], saved['set_type'], bool(saved['completed'])),
                         (12.5, 10, 'right', 'warmup', False))

    def test_add_set_without_values_still_copies_the_set_above(self):
        _, added = self.add_curl()
        set_id = added['entry']['sets'][0]['id']
        db.update_set(self.connection, set_id, {'weight': 14, 'result': 9, 'completed': True})
        status, copy = self.request('POST', f"/api/workout-exercises/{added['id']}/sets", {})
        self.assertEqual(status, 201)
        self.assertEqual((copy['weight'], copy['result'], bool(copy['completed'])), (14, 9, False))

    def test_add_set_rejects_bad_values_and_adds_nothing(self):
        _, added = self.add_curl()
        route = f"/api/workout-exercises/{added['id']}/sets"
        for payload in ({'side': 'middle'}, {'set_type': 'giant'}, {'result': -1}, {'weight': 'heavy'}):
            status, _ = self.request('POST', route, {**payload, 'request_id': json.dumps(payload)})
            self.assertEqual(status, 400, payload)
        self.assertEqual(self.set_count(added['id']), 1)

    def test_finishing_twice_is_fine_and_unknown_workouts_still_fail(self):
        route = f"/api/workouts/{self.workout['id']}/complete"
        self.assertEqual(self.request('POST', route)[0], 200)
        self.assertEqual(self.request('POST', route)[0], 200)
        self.assertIsNone(db.bootstrap(self.connection)['active_workout'])
        self.assertEqual(self.request('POST', '/api/workouts/999/complete')[0], 404)

    def test_change_machine_and_replace_answer_with_the_entry(self):
        _, added = self.add_curl()
        base = f"/api/workouts/{self.workout['id']}/exercises/{added['id']}"
        status, changed = self.request('PUT', f'{base}/configuration', {'equipment': 'Cable', 'manufacturer': '', 'label': ''})
        self.assertEqual(status, 200)
        self.assertEqual(changed['entry']['equipment'], 'Cable')
        catalog = db.catalog_for_gym(self.connection, self.gym['id'])['catalog']
        plank = next(v for v in catalog if (v['exercise_name'], v['variation_name']) == ('Plank', 'Front Plank'))
        status, replaced = self.request('PUT', f'{base}/replace', {
            'variation_id': plank['id'], 'equipment': 'Bodyweight', 'manufacturer': '', 'label': ''})
        self.assertEqual(status, 200, replaced)
        self.assertEqual(replaced['entry']['variation_name'], 'Front Plank')
        self.assertEqual(replaced['entry']['tracking_type'], 'duration')


if __name__ == '__main__':
    unittest.main()
