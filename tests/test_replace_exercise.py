import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from gymdex import db
from gymdex.server import GymdexHandler


class ReplaceExerciseTests(unittest.TestCase):
    """An Active Workout's Workout Exercise can be replaced with another Variation.
    Finished workouts cannot. Sets stay; incompatible weight/result/effort clear."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'replace.sqlite3'
        self.connection = db.connect(self.path)
        db.initialize(self.connection)
        self.gym = db.create_gym(self.connection, 'Home')
        catalog = db.catalog_for_gym(self.connection, self.gym['id'])['catalog']
        self.press = next(v for v in catalog if (v['exercise_name'], v['variation_name']) == ('Bench Press', 'Standard'))
        self.plank = next(v for v in catalog if (v['exercise_name'], v['variation_name']) == ('Plank', 'Front Plank'))
        self.assisted = next(v for v in catalog if (v['exercise_name'], v['variation_name']) == ('Pull-up', 'Assisted'))
        self.pull_up = next(v for v in catalog if (v['exercise_name'], v['variation_name']) == ('Pull-up', 'Standard'))

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

    def logged_press(self, finish=False):
        workout = db.start_workout(self.connection, self.gym['id'])
        entry = db.add_workout_exercise(self.connection, workout['id'], self.press['id'], 'Barbell')
        slot = db.sets_for_exercise(self.connection, entry['id'])[0]
        db.update_set(self.connection, slot['id'], {
            'weight': 60, 'result': 8, 'completed': True, 'effort': '1', 'side': 'left', 'set_type': 'warmup',
        })
        extra = db.add_set(self.connection, entry['id'])
        db.update_set(self.connection, extra['id'], {'weight': 62.5, 'result': 6, 'completed': False})
        db.set_workout_exercise_note(self.connection, entry['id'], 'Seat 3')
        if finish:
            db.complete_workout(self.connection, workout['id'])
        return workout, entry

    def test_replacing_keeps_note_sets_and_compatible_values(self):
        workout, entry = self.logged_press()
        incline = next(
            v for v in db.catalog_for_gym(self.connection, self.gym['id'])['catalog']
            if (v['exercise_name'], v['variation_name']) == ('Bench Press', 'Incline')
        )

        saved = db.replace_workout_exercise(
            self.connection, workout['id'], entry['id'], incline['id'], 'Dumbbell', 'Rogue', 'Bench 2',
        )

        self.assertEqual(
            (saved['variation_id'], saved['exercise_name'], saved['variation_name'], saved['cleared']),
            (incline['id'], 'Bench Press', 'Incline', False),
        )
        self.assertEqual(
            (saved['equipment'], saved['manufacturer'], saved['label']),
            ('Dumbbell', 'Rogue', 'Bench 2'),
        )
        shown = db.bootstrap(self.connection)['workout_exercises'][0]
        self.assertEqual(
            (shown['variation_id'], shown['variation_name'], shown['equipment'], shown['note']),
            (incline['id'], 'Incline', 'Dumbbell', 'Seat 3'),
        )
        self.assertEqual(
            [(s['weight'], s['result'], s['completed'], s['effort'], s['side'], s['set_type']) for s in shown['sets']],
            [(60.0, 8, 1, '1', 'left', 'warmup'), (62.5, 6, 0, None, 'right', 'warmup')],
        )

    def test_tracking_type_mismatch_clears_weight_result_and_effort(self):
        workout, entry = self.logged_press()

        saved = db.replace_workout_exercise(
            self.connection, workout['id'], entry['id'], self.plank['id'], 'Bodyweight',
        )

        self.assertTrue(saved['cleared'])
        self.assertEqual(saved['tracking_type'], 'duration')
        shown = db.bootstrap(self.connection)['workout_exercises'][0]
        self.assertEqual(
            [(s['weight'], s['result'], s['completed'], s['effort'], s['side'], s['set_type']) for s in shown['sets']],
            [(None, None, 0, None, 'left', 'warmup'), (None, None, 0, None, 'right', 'warmup')],
        )
        self.assertEqual(shown['note'], 'Seat 3')

    def test_assisted_mismatch_clears_weight_result_and_effort(self):
        workout = db.start_workout(self.connection, self.gym['id'])
        entry = db.add_workout_exercise(self.connection, workout['id'], self.pull_up['id'], 'Bodyweight')
        slot = db.sets_for_exercise(self.connection, entry['id'])[0]
        db.update_set(self.connection, slot['id'], {'weight': 10, 'result': 5, 'completed': True, 'effort': '0'})

        saved = db.replace_workout_exercise(
            self.connection, workout['id'], entry['id'], self.assisted['id'], 'Machine',
        )

        self.assertTrue(saved['cleared'])
        self.assertTrue(saved['assisted'])
        shown = db.bootstrap(self.connection)['workout_exercises'][0]
        self.assertEqual(
            [(s['weight'], s['result'], s['completed'], s['effort']) for s in shown['sets']],
            [(None, None, 0, None)],
        )

    def test_finished_workout_cannot_be_replaced(self):
        workout, entry = self.logged_press(finish=True)
        with self.assertRaises(LookupError):
            db.replace_workout_exercise(
                self.connection, workout['id'], entry['id'], self.plank['id'], 'Bodyweight',
            )
        detail = db.completed_workout(self.connection, workout['id'])
        self.assertEqual(detail['workout_exercises'][0]['variation_id'], self.press['id'])
        self.assertEqual(detail['workout_exercises'][0]['sets'][0]['weight'], 60)

    def test_route_replaces_and_refuses_finished_or_bad_payloads(self):
        workout, entry = self.logged_press()
        path = f"/api/workouts/{workout['id']}/exercises/{entry['id']}/replace"
        status, body = self.request('PUT', path, {
            'variation_id': self.plank['id'], 'equipment': 'Bodyweight',
            'manufacturer': '', 'label': '',
        })
        self.assertEqual((status, body['variation_id'], body['cleared']), (200, self.plank['id'], True))

        db.complete_workout(self.connection, workout['id'])
        self.assertEqual(self.request('PUT', path, {
            'variation_id': self.press['id'], 'equipment': 'Barbell',
        })[0], 404)
        active = db.start_workout(self.connection, self.gym['id'])
        again = db.add_workout_exercise(self.connection, active['id'], self.press['id'], 'Barbell')
        bad = f"/api/workouts/{active['id']}/exercises/{again['id']}/replace"
        self.assertEqual(self.request('PUT', bad, {'variation_id': 'x', 'equipment': 'Barbell'})[0], 400)
        self.assertEqual(self.request('PUT', bad, {'variation_id': self.press['id'], 'equipment': 3})[0], 400)
        self.assertEqual(self.request('PUT', f"/api/workouts/{active['id']}/exercises/999/replace", {
            'variation_id': self.plank['id'], 'equipment': 'Bodyweight',
        })[0], 404)


if __name__ == '__main__':
    unittest.main()
