import csv
import io
import json
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from types import SimpleNamespace

from gymdex import db
from gymdex.export import workout_csv
from gymdex.server import GymdexHandler


class NoteTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'notes.sqlite3'
        self.connection = db.connect(self.path)
        db.initialize(self.connection)
        self.gym = db.create_gym(self.connection, 'Home')
        self.workout = db.start_workout(self.connection, self.gym['id'])
        catalog = db.catalog_for_gym(self.connection, self.gym['id'])['catalog']
        self.press = next(v for v in catalog if v['exercise_name'] == 'Bench Press' and v['variation_name'] == 'Standard')
        self.entry = db.add_workout_exercise(self.connection, self.workout['id'], self.press['id'], 'Barbell')

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

    def test_version_two_database_gains_empty_notes_and_keeps_its_workouts(self):
        # A version 2 database has no note columns.
        self.connection.execute('ALTER TABLE workouts DROP COLUMN note')
        self.connection.execute('ALTER TABLE workout_exercises DROP COLUMN note')
        self.connection.execute('PRAGMA user_version = 2')
        self.connection.commit()
        db.initialize(self.connection)
        db.initialize(self.connection)
        self.assertEqual(self.connection.execute('PRAGMA user_version').fetchone()[0], 3)
        data = db.bootstrap(self.connection)
        self.assertEqual(data['active_workout']['id'], self.workout['id'])
        self.assertEqual(data['active_workout']['note'], '')
        self.assertEqual([(e['id'], e['note']) for e in data['workout_exercises']], [(self.entry['id'], '')])
        db.set_workout_note(self.connection, self.workout['id'], 'Migrated fine')
        self.assertEqual(db.bootstrap(self.connection)['active_workout']['note'], 'Migrated fine')

    def test_active_workout_and_exercise_notes_are_saved_trimmed_and_cleared(self):
        status, saved = self.request('PUT', f'/api/workouts/{self.workout["id"]}/note', {'note': '  Felt strong.\nSlept badly.  '})
        self.assertEqual((status, saved), (200, {'id': self.workout['id'], 'note': 'Felt strong.\nSlept badly.'}))
        status, saved = self.request('PUT', f'/api/workout-exercises/{self.entry["id"]}/note', {'note': 'Left shoulder <tight>'})
        self.assertEqual((status, saved), (200, {'id': self.entry['id'], 'note': 'Left shoulder <tight>'}))
        data = db.bootstrap(self.connection)
        self.assertEqual(data['active_workout']['note'], 'Felt strong.\nSlept badly.')
        self.assertEqual(data['workout_exercises'][0]['note'], 'Left shoulder <tight>')
        self.assertEqual(self.request('PUT', f'/api/workout-exercises/{self.entry["id"]}/note', {'note': '   '})[1]['note'], '')
        self.assertEqual(db.bootstrap(self.connection)['workout_exercises'][0]['note'], '')

    def test_invalid_notes_and_unknown_targets_are_rejected(self):
        workout_path = f'/api/workouts/{self.workout["id"]}/note'
        for payload in ({}, {'note': None}, {'note': 5}, {'note': ['a']}, {'note': 'x' * 1001}):
            with self.subTest(payload=payload):
                self.assertEqual(self.request('PUT', workout_path, payload)[0], 400)
                self.assertEqual(self.request('PUT', f'/api/workout-exercises/{self.entry["id"]}/note', payload)[0], 400)
        self.assertEqual(self.request('PUT', workout_path, {'note': 'x' * 1000})[0], 200)
        for path in ('/api/workouts/999/note', '/api/workout-exercises/999/note',
                     '/api/workouts/999999999999999999999/note', '/api/workout-exercises/0/note'):
            with self.subTest(path=path):
                self.assertEqual(self.request('PUT', path, {'note': 'Hi'})[0], 404)
        self.assertEqual(self.request('PUT', '/api/workouts/abc/note', {'note': 'Hi'})[0], 400)

    def test_completed_workout_notes_are_shown_and_editable_in_history(self):
        db.set_workout_note(self.connection, self.workout['id'], 'Deload week')
        db.set_workout_exercise_note(self.connection, self.entry['id'], 'Paused reps')
        db.complete_workout(self.connection, self.workout['id'])
        detail = db.completed_workout(self.connection, self.workout['id'])
        self.assertEqual(detail['workout']['note'], 'Deload week')
        self.assertEqual(detail['workout_exercises'][0]['note'], 'Paused reps')
        self.assertEqual(self.request('PUT', f'/api/workouts/{self.workout["id"]}/note', {'note': 'Deload week, knee ok'})[0], 200)
        self.assertEqual(self.request('PUT', f'/api/workout-exercises/{self.entry["id"]}/note', {'note': ''})[0], 200)
        status, detail = self.request('GET', f'/api/history/{self.workout["id"]}')
        self.assertEqual(status, 200)
        self.assertEqual(detail['workout']['note'], 'Deload week, knee ok')
        self.assertEqual(detail['workout_exercises'][0]['note'], '')

    def test_repeating_a_workout_does_not_copy_notes(self):
        db.set_workout_note(self.connection, self.workout['id'], 'Tired')
        db.set_workout_exercise_note(self.connection, self.entry['id'], 'Grip slipped')
        db.complete_workout(self.connection, self.workout['id'])
        db.repeat_workout(self.connection, self.workout['id'])
        data = db.bootstrap(self.connection)
        self.assertEqual(data['active_workout']['note'], '')
        self.assertEqual([e['note'] for e in data['workout_exercises']], [''])

    def test_csv_export_includes_notes_and_neutralizes_formulas(self):
        db.set_workout_note(self.connection, self.workout['id'], '=HYPERLINK("http://x")')
        db.set_workout_exercise_note(self.connection, self.entry['id'], 'Seat 4, "slow"\nsecond line')
        db.complete_workout(self.connection, self.workout['id'])
        rows = list(csv.DictReader(StringIO(workout_csv(self.connection))))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['workout_note'], '\'=HYPERLINK("http://x")')
        self.assertEqual(rows[0]['exercise_note'], 'Seat 4, "slow"\nsecond line')
        self.assertEqual(rows[0]['exercise'], 'Bench Press')


if __name__ == '__main__':
    unittest.main()
