import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from gymdex import db
from gymdex.server import GymdexHandler


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'history.sqlite3'
        self.connection = db.connect(self.path)
        db.initialize(self.connection)
        self.gym = db.create_gym(self.connection, 'Home')
        self.other = db.create_gym(self.connection, 'Other gym')

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()

    def workout(self, gym=None, started='2026-09-22 10:00:00', completed=True):
        item = db.start_workout(self.connection, (gym or self.gym)['id'])
        self.connection.execute('UPDATE workouts SET started_at = ? WHERE id = ?', (started, item['id']))
        self.connection.commit()
        if completed:
            db.complete_workout(self.connection, item['id'])
        return item

    def request(self, path):
        handler = object.__new__(GymdexHandler)
        handler.server = SimpleNamespace(db_path=self.path)
        handler.path = path
        response = []
        handler._json = lambda data, status=200: response.append((int(status), data))
        handler.do_GET()
        return response[0]

    def test_history_excludes_active_and_canceled_workouts(self):
        completed = self.workout()
        canceled = self.workout(completed=False)
        db.cancel_workout(self.connection, canceled['id'])
        active = self.workout(completed=False)
        status, page = self.request('/api/history')
        self.assertEqual(status, 200)
        self.assertEqual([w['id'] for w in page['workouts']], [completed['id']])
        self.assertEqual(page['workouts'][0]['exercise_count'], 0)
        self.assertEqual(page['workouts'][0]['completed_set_count'], 0)
        self.assertIsNone(page['next_offset'])
        for workout_id in (active['id'], 9999):
            self.assertEqual(self.request(f'/api/history/{workout_id}')[0], 404)
        self.assertEqual(db.completed_workout(self.connection, completed['id'])['workout_exercises'], [])

    def test_pagination_is_stable_for_matching_timestamps(self):
        ids = [self.workout()['id'] for _ in range(23)]
        first = db.workout_history(self.connection)
        second = db.workout_history(self.connection, offset=str(first['next_offset']))
        self.assertEqual(len(first['workouts']), 20)
        self.assertEqual([w['id'] for w in first['workouts'] + second['workouts']], ids[::-1])
        self.assertIsNone(second['next_offset'])
        self.assertEqual(db.workout_history(self.connection, offset='40')['workouts'], [])

    def test_gym_and_start_time_filters_use_utc_instant_bounds(self):
        # A phone at UTC+2 asks for its local 21-22 September: 20 Sep 22:00 UTC to 22 Sep 22:00 UTC.
        self.workout(started='2026-09-20 21:59:59')
        first = self.workout(started='2026-09-20 22:00:00')
        last = self.workout(started='2026-09-22 21:59:59')
        self.workout(started='2026-09-22 22:00:00')
        self.workout(gym=self.other, started='2026-09-22 10:00:00')
        status, page = self.request(f'/api/history?gym_id={self.gym["id"]}'
                                    '&start=2026-09-20T22:00:00.000Z&end=2026-09-22T22:00:00.000Z')
        self.assertEqual(status, 200)
        self.assertEqual([w['id'] for w in page['workouts']], [last['id'], first['id']])
        self.assertEqual(len(db.workout_history(self.connection, start='2026-09-22T22:00:00Z')['workouts']), 1)
        self.assertEqual(len(db.workout_history(self.connection, end='2026-09-20T22:00:00Z')['workouts']), 1)
        # Offsets are converted to UTC: the same bounds written as local midnights at UTC+2.
        status, page = self.request(f'/api/history?gym_id={self.gym["id"]}'
                                    '&start=2026-09-21T00:00:00%2B02:00&end=2026-09-23T00:00:00%2B02:00')
        self.assertEqual([w['id'] for w in page['workouts']], [last['id'], first['id']])

    def test_invalid_filters_and_ids_return_errors(self):
        for query in ('gym_id=no', 'gym_id=-1', 'gym_id=999999999999999999999',
                      'offset=-1', 'offset=1.5', 'offset=1000001',
                      'start=2026-02-30T00:00:00Z', 'start=2026-09-22', 'start=2026-09-22T00:00:00',
                      'end=bad', 'end=9999-12-31T23:00:00-05:00',
                      'start=2026-09-22T00:00:00Z&end=2026-09-21T00:00:00Z',
                      'start=2026-09-22T00:00:00Z&end=2026-09-22T00:00:00Z'):
            with self.subTest(query=query):
                self.assertEqual(self.request('/api/history?' + query)[0], 400)
        self.assertEqual(self.request('/api/history/invalid')[0], 400)
        self.assertEqual(self.request('/api/history/999999999999999999999')[0], 404)

    def test_detail_preserves_snapshots_set_order_and_completion(self):
        workout = self.workout(completed=False)
        catalog = db.catalog_for_gym(self.connection, self.gym['id'])['catalog']
        press = next(v for v in catalog if v['variation_name'] == 'Incline')
        plank = next(v for v in catalog if v['tracking_type'] == 'duration')
        entry = db.add_workout_exercise(self.connection, workout['id'], press['id'], 'Machine', 'Acme', 'A1')
        first = db.sets_for_exercise(self.connection, entry['id'])[0]
        db.update_set(self.connection, first['id'], dict(weight=-12.5, result=8, completed=True))
        removed = db.add_set(self.connection, entry['id'])
        db.delete_set(self.connection, removed['id'])
        db.add_set(self.connection, entry['id'])
        duration = db.add_workout_exercise(self.connection, workout['id'], plank['id'], 'Bodyweight')
        duration_set = db.sets_for_exercise(self.connection, duration['id'])[0]
        db.update_set(self.connection, duration_set['id'], dict(weight=None, result=60, completed=True))
        db.complete_workout(self.connection, workout['id'])
        # Catalog/profile edits must not rewrite historical snapshots.
        self.connection.execute("UPDATE exercise_variations SET name = 'Changed' WHERE id = ?", (press['id'],))
        self.connection.execute("UPDATE gym_exercise_profiles SET label = 'Changed'")
        self.connection.commit()
        status, detail = self.request(f'/api/history/{workout["id"]}')
        self.assertEqual(status, 200)
        entries = detail['workout_exercises']
        self.assertEqual([e['id'] for e in entries], [entry['id'], duration['id']])
        self.assertEqual(entries[0]['variation_name'], 'Incline')
        self.assertEqual(entries[0]['label'], 'A1')
        self.assertEqual(entries[0]['manufacturer'], 'Acme')
        self.assertEqual([s['position'] for s in entries[0]['sets']], [1, 2])
        self.assertEqual(entries[0]['sets'][0]['weight'], -12.5)
        self.assertEqual(entries[0]['sets'][1]['completed'], 0)
        self.assertEqual(entries[1]['tracking_type'], 'duration')
        self.assertEqual(entries[1]['sets'][0]['result'], 60)
        self.assertIsNone(entries[1]['sets'][0]['weight'])
        summary = db.workout_history(self.connection)['workouts'][0]
        self.assertEqual((summary['exercise_count'], summary['completed_set_count']), (2, 2))
        # History remains read-only; the active-set mutation route stays protected.
        with self.assertRaises(LookupError):
            db.update_set(self.connection, first['id'], dict(weight=1, result=1, completed=True))
