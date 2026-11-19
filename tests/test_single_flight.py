import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

from gymdex import db
from gymdex.server import GymdexHandler


class AddExerciseOnceTests(unittest.TestCase):
    """Add exercise requests carrying the same request_id add one Workout Exercise."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'once.sqlite3'
        self.connection = db.connect(self.path)
        db.initialize(self.connection)
        self.gym = db.create_gym(self.connection, 'Home')
        catalog = db.catalog_for_gym(self.connection, self.gym['id'])['catalog']
        self.curl = next(v for v in catalog if (v['exercise_name'], v['variation_name']) == ('Biceps Curl', 'Standing'))
        self.workout = db.start_workout(self.connection, self.gym['id'])
        self.route = f"/api/workouts/{self.workout['id']}/exercises"

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

    def add(self, request_id=None, **choice):
        payload = {'variation_id': self.curl['id'], 'equipment': 'Dumbbell', 'manufacturer': '', 'label': '', **choice}
        if request_id is not None:
            payload['request_id'] = request_id
        return self.request('POST', self.route, payload)

    def count(self):
        return self.connection.execute(
            'SELECT COUNT(*) FROM workout_exercises WHERE workout_id = ?', (self.workout['id'],)).fetchone()[0]

    def test_a_repeated_request_id_answers_with_the_first_add(self):
        first = self.add('picker-1:curl')
        again = self.add('picker-1:curl')
        self.assertEqual(first[0], 201)
        self.assertEqual(again, first)
        self.assertEqual(self.count(), 1)

    def test_seven_simultaneous_taps_add_one(self):
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.add('picker-2:curl'))) for _ in range(7)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(self.count(), 1)
        self.assertEqual({status for status, _ in results}, {201})
        self.assertEqual(len({data['id'] for _, data in results}), 1)

    def test_separate_adds_and_requests_without_an_id_still_add_each_time(self):
        self.add('picker-3:curl')
        self.add('picker-4:curl')
        self.add()
        self.add()
        self.assertEqual(self.count(), 4)

    def test_a_failed_request_is_not_remembered(self):
        status, _ = self.add('picker-5:curl', equipment='Hovercraft')
        self.assertGreaterEqual(status, 400)
        self.assertEqual(self.count(), 0)
        self.assertEqual(self.add('picker-5:curl')[0], 201)
        self.assertEqual(self.count(), 1)

    def test_adding_from_recent_is_guarded_too(self):
        entry = db.add_workout_exercise(self.connection, self.workout['id'], self.curl['id'], 'Dumbbell')
        profile_id = entry['gym_profile_id'] if 'gym_profile_id' in entry else self.connection.execute(
            'SELECT gym_profile_id FROM workout_exercises WHERE id = ?', (entry['id'],)).fetchone()[0]
        payload = {'profile_id': profile_id, 'request_id': 'picker-6:recent'}
        first = self.request('POST', self.route, payload)
        self.assertEqual(self.request('POST', self.route, payload), first)
        self.assertEqual(self.count(), 2)

    def test_the_same_request_id_in_another_workout_adds_there(self):
        self.add('picker-7:curl')
        db.complete_workout(self.connection, self.workout['id'])
        self.workout = db.start_workout(self.connection, self.gym['id'])
        self.route = f"/api/workouts/{self.workout['id']}/exercises"
        self.assertEqual(self.add('picker-7:curl')[0], 201)
        self.assertEqual(self.count(), 1)


if __name__ == '__main__':
    unittest.main()
