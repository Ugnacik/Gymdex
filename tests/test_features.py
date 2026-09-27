import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from gymdex import db
from gymdex.server import GymdexHandler


class FeatureTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'features.sqlite3'
        self.connection = db.connect(self.path)
        db.initialize(self.connection)
        self.gym = db.create_gym(self.connection, 'Home')
        self.other_gym = db.create_gym(self.connection, 'Other')
        catalog = db.catalog_for_gym(self.connection, self.gym['id'])['catalog']
        self.press = next(item for item in catalog if item['exercise_name'] == 'Bench Press'
                          and item['variation_name'] == 'Standard')
        self.plank = next(item for item in catalog if item['tracking_type'] == 'duration')

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

    def workout_with_set(self, gym_id=None, variation=None, equipment='Barbell',
                         weight=40, result=8, completed=True):
        workout = db.start_workout(self.connection, gym_id or self.gym['id'])
        variation = variation or self.press
        entry = db.add_workout_exercise(
            self.connection, workout['id'], variation['id'], equipment,
        )
        set_item = db.sets_for_exercise(self.connection, entry['id'])[0]
        db.update_set(self.connection, set_item['id'], {
            'weight': weight, 'result': result, 'completed': completed,
        })
        db.complete_workout(self.connection, workout['id'])
        return workout, entry, set_item

    def test_custom_exercise_and_variation_are_available_in_catalog(self):
        status, item = self.request('POST', '/api/exercises', {
            'name': '  Glute   Bridge ', 'variation_name': '',
            'tracking_type': 'repetitions', 'equipment': ['Barbell', 'Machine'],
        })
        self.assertEqual(status, 201)
        self.assertEqual(item['exercise_name'], 'Glute Bridge')
        self.assertEqual(item['variation_name'], 'Standard')
        self.assertEqual(item['equipment'], ['Barbell', 'Machine'])
        catalog = db.catalog_for_gym(self.connection, self.gym['id'])['catalog']
        self.assertIn(item, catalog)
        self.assertEqual(self.request('POST', '/api/exercises', {
            'name': 'glute bridge', 'variation_name': 'standard',
            'tracking_type': 'duration', 'equipment': ['Bodyweight'],
        })[0], 409)
        status, incline = self.request('POST', '/api/exercises', {
            'name': 'Glute Bridge', 'variation_name': 'Single Leg',
            'tracking_type': 'repetitions', 'equipment': ['Bodyweight'],
        })
        self.assertEqual(status, 201)
        self.assertNotEqual(item['id'], incline['id'])
        self.assertEqual(incline['exercise_name'], 'Glute Bridge')
        workout = db.start_workout(self.connection, self.gym['id'])
        entry = db.add_workout_exercise(
            self.connection, workout['id'], incline['id'], 'Bodyweight',
        )
        self.assertEqual(entry['variation_name'], 'Single Leg')

    def test_custom_exercise_validation_does_not_leave_partial_catalog_rows(self):
        base = {'name': 'New Movement', 'variation_name': 'Standard',
                'tracking_type': 'repetitions', 'equipment': ['Machine']}
        invalid = [
            {'name': ''}, {'name': 'x' * 81}, {'tracking_type': 'distance'},
            {'equipment': []}, {'equipment': 'Machine'},
            {'equipment': ['Machine', 'machine']}, {'equipment': ['Cable|Rope']},
            {'equipment': [None]},
        ]
        for fields in invalid:
            with self.subTest(fields=fields):
                self.assertEqual(self.request('POST', '/api/exercises', base | fields)[0], 400)
        self.assertIsNone(self.connection.execute(
            "SELECT id FROM exercises WHERE name = 'New Movement'"
        ).fetchone())

    def test_repeat_copies_snapshots_and_set_slots_with_blank_values(self):
        original = db.start_workout(self.connection, self.gym['id'])
        press = db.add_workout_exercise(
            self.connection, original['id'], self.press['id'], 'Machine', 'Acme', 'Rack 1',
        )
        first = db.sets_for_exercise(self.connection, press['id'])[0]
        db.update_set(self.connection, first['id'], {
            'weight': 50, 'result': 8, 'completed': True,
        })
        second = db.add_set(self.connection, press['id'])
        db.update_set(self.connection, second['id'], {
            'weight': 55, 'result': 6, 'completed': True,
        })
        third = db.add_set(self.connection, press['id'])
        db.update_set(self.connection, third['id'], {
            'weight': 60, 'result': 5, 'completed': False,
        })
        plank = db.add_workout_exercise(
            self.connection, original['id'], self.plank['id'], 'Bodyweight',
        )
        db.complete_workout(self.connection, original['id'])
        self.connection.execute(
            "UPDATE exercise_variations SET name = 'Renamed' WHERE id = ?",
            (self.press['id'],),
        )
        self.connection.commit()

        status, repeated = self.request('POST', f'/api/history/{original["id"]}/repeat')
        self.assertEqual(status, 201)
        self.assertEqual(repeated['gym_id'], self.gym['id'])
        self.assertNotEqual(repeated['id'], original['id'])
        active = db.bootstrap(self.connection)
        entries = active['workout_exercises']
        self.assertEqual([entry['position'] for entry in entries], [1, 2])
        self.assertEqual(entries[0]['variation_name'], 'Standard')
        self.assertEqual(entries[0]['manufacturer'], 'Acme')
        self.assertEqual(entries[0]['label'], 'Rack 1')
        self.assertEqual([set_item['position'] for set_item in entries[0]['sets']], [1, 2, 3])
        self.assertTrue(all(set_item['result'] is None and set_item['weight'] is None
                            and set_item['completed'] == 0 for set_item in entries[0]['sets']))
        self.assertEqual(len(entries[0]['previous_sets']), 2)
        self.assertEqual(entries[1]['id'] != plank['id'], True)
        self.assertEqual(len(entries[1]['sets']), 1)
        self.assertEqual(self.request('POST', f'/api/history/{original["id"]}/repeat')[0], 409)
        self.assertEqual(self.request('POST', '/api/history/99999/repeat')[0], 404)
        self.assertEqual(self.connection.execute(
            'SELECT COUNT(*) FROM workouts WHERE completed_at IS NULL'
        ).fetchone()[0], 1)

    def test_picker_and_recent_add_empty_slots_for_each_set_of_last_matching_workout(self):
        original = db.start_workout(self.connection, self.gym['id'])
        press = db.add_workout_exercise(
            self.connection, original['id'], self.press['id'], 'Machine', 'Acme', 'Rack 1',
        )
        db.update_set(self.connection, db.sets_for_exercise(self.connection, press['id'])[0]['id'],
                      {'weight': 50, 'result': 8, 'completed': True})
        db.update_set(self.connection, db.add_set(self.connection, press['id'])['id'],
                      {'weight': 55, 'result': 6, 'completed': True})
        db.complete_workout(self.connection, original['id'])
        workout = db.start_workout(self.connection, self.gym['id'])
        recent = db.catalog_for_gym(self.connection, self.gym['id'])['recent']
        profile_id = next(item['profile_id'] for item in recent if item['variation_id'] == self.press['id'])

        for payload in [
            {'variation_id': self.press['id'], 'equipment': 'Machine', 'manufacturer': 'Acme', 'label': 'Rack 1'},
            {'profile_id': profile_id},
        ]:
            with self.subTest(payload=payload):
                status, added = self.request('POST', f'/api/workouts/{workout["id"]}/exercises', payload)
                self.assertEqual(status, 201)
                entry = next(item for item in db.bootstrap(self.connection)['workout_exercises']
                             if item['id'] == added['id'])
                self.assertEqual([(s['position'], s['weight'], s['result'], s['completed'])
                                  for s in entry['sets']],
                                 [(1, None, None, 0), (2, None, None, 0)])
                self.assertEqual([s['result'] for s in entry['previous_sets']], [8, 6])

    def test_progress_uses_completed_sets_and_gym_filter(self):
        first, _, first_set = self.workout_with_set(weight=40, result=10)
        self.connection.execute(
            "UPDATE workouts SET completed_at = '2026-09-20 10:00:00' WHERE id = ?",
            (first['id'],),
        )
        second, _, second_set = self.workout_with_set(weight=45, result=8)
        self.connection.execute(
            "UPDATE workouts SET completed_at = '2026-09-21 10:00:00' WHERE id = ?",
            (second['id'],),
        )
        self.workout_with_set(gym_id=self.other_gym['id'], weight=60, result=4)
        dumbbell, _, _ = self.workout_with_set(
            equipment='Dumbbell', weight=32, result=12,
        )
        self.connection.commit()
        status, progress = self.request(
            'GET', f'/api/progress?variation_id={self.press["id"]}&gym_id={self.gym["id"]}',
        )
        self.assertEqual(status, 200)
        self.assertEqual(progress['tracking_type'], 'repetitions')
        self.assertEqual([point['workout_id'] for point in progress['points']],
                         [first['id'], second['id'], dumbbell['id']])
        self.assertEqual([point['best_weight'] for point in progress['points']], [40, 45, 32])
        self.assertEqual([point['best_result'] for point in progress['points']], [10, 8, 12])
        self.assertEqual([point['completed_sets'] for point in progress['points']], [1, 1, 1])
        self.assertEqual(len(self.request('GET', f'/api/progress?variation_id={self.press["id"]}')[1]['points']), 4)
        status, configured = self.request(
            'GET', f'/api/progress?variation_id={self.press["id"]}&gym_id={self.gym["id"]}'
                   '&equipment=Barbell&manufacturer=&label=',
        )
        self.assertEqual(status, 200)
        self.assertEqual([point['workout_id'] for point in configured['points']],
                         [first['id'], second['id']])
        for path in ('/api/progress', '/api/progress?variation_id=no',
                     '/api/progress?variation_id=0',
                     f'/api/progress?variation_id={self.press["id"]}&gym_id=-1'):
            self.assertEqual(self.request('GET', path)[0], 400)
        self.assertEqual(self.request('GET', '/api/progress?variation_id=99999')[0], 404)
        self.assertNotEqual(first_set['id'], second_set['id'])

    def test_completed_set_correction_is_scoped_and_updates_history(self):
        workout, entry, set_item = self.workout_with_set(weight=40, result=8)
        other, _, other_set = self.workout_with_set(weight=50, result=6)
        path = f'/api/history/{workout["id"]}/sets/{set_item["id"]}'
        self.assertEqual(self.request('PUT', f'/api/sets/{set_item["id"]}', {
            'weight': 42, 'result': 9, 'completed': True,
        })[0], 404)
        self.assertEqual(self.request('PUT', path, {
            'weight': 42.5, 'result': 9, 'completed': True,
        }), (200, {'id': set_item['id'], 'position': 1, 'weight': 42.5,
                  'result': 9, 'completed': 1}))
        self.assertEqual(db.completed_workout(self.connection, workout['id'])
                         ['workout_exercises'][0]['sets'][0]['result'], 9)
        self.assertEqual(self.request('PUT', f'/api/history/{other["id"]}/sets/{set_item["id"]}', {
            'weight': 50, 'result': 8, 'completed': True,
        })[0], 404)
        self.assertEqual(self.request('PUT', path, {
            'weight': 10, 'result': 0, 'completed': True,
        })[0], 400)
        self.assertEqual(db.sets_for_exercise(self.connection, entry['id'])[0]['result'], 9)
        self.assertEqual(self.request('PUT', path, {
            'weight': None, 'result': None, 'completed': False,
        })[0], 200)
        summary = db.workout_history(self.connection)['workouts']
        corrected = next(item for item in summary if item['id'] == workout['id'])
        self.assertEqual(corrected['completed_set_count'], 0)
        progress = db.exercise_progress(self.connection, self.press['id'])
        self.assertEqual([point['workout_id'] for point in progress['points']], [other['id']])
        self.assertNotEqual(other_set['id'], set_item['id'])

    def test_csv_export_route_downloads_without_caching(self):
        self.workout_with_set()
        handler = object.__new__(GymdexHandler)
        handler.server = SimpleNamespace(db_path=self.path)
        handler.path = '/api/export/workouts.csv'
        handler.wfile = io.BytesIO()
        response = []
        headers = {}
        handler.send_response = lambda status: response.append(int(status))
        handler.send_header = lambda name, value: headers.__setitem__(name, value)
        handler.end_headers = lambda: None
        handler.do_GET()
        self.assertEqual(response, [200])
        self.assertEqual(headers['Content-Type'], 'text/csv; charset=utf-8')
        self.assertEqual(headers['Content-Disposition'],
                         'attachment; filename="gymdex-workouts.csv"')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(int(headers['Content-Length']), len(handler.wfile.getvalue()))
        self.assertIn(b'Bench Press', handler.wfile.getvalue())

    def get_static(self, path):
        handler = object.__new__(GymdexHandler)
        handler.server = SimpleNamespace(db_path=self.path)
        handler.path = path
        handler.wfile = io.BytesIO()
        headers = {}
        handler.send_response = lambda status: None
        handler.send_header = lambda name, value: headers.__setitem__(name, value)
        handler.end_headers = lambda: None
        handler.do_GET()
        return headers, handler.wfile.getvalue()

    def test_app_icons_are_served_as_png_without_charset(self):
        for path in ('/icon-192.png', '/icon-512.png', '/icon-maskable-512.png',
                     '/apple-touch-icon.png'):
            with self.subTest(path=path):
                headers, body = self.get_static(path)
                self.assertEqual(headers['Content-Type'], 'image/png')
                self.assertTrue(body.startswith(b'\x89PNG\r\n\x1a\n'))

    def test_text_assets_keep_utf8_charset(self):
        headers, _ = self.get_static('/styles.css')
        self.assertEqual(headers['Content-Type'], 'text/css; charset=utf-8')


if __name__ == '__main__':
    unittest.main()
