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


class CompletedWorkoutSetsTests(unittest.TestCase):
    """Completed Workouts can gain and lose sets, and can be deleted as a whole."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.connection = db.connect(Path(self.directory.name) / 'corrections.sqlite3')
        db.initialize(self.connection)
        self.gym = db.create_gym(self.connection, 'Home')
        catalog = db.catalog_for_gym(self.connection, self.gym['id'])['catalog']
        self.press = next(v for v in catalog if v['exercise_name'] == 'Bench Press'
                          and v['variation_name'] == 'Standard')

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()

    def completed(self, *results, weight=60, complete=True):
        """A Completed Workout with one Bench Press Workout Exercise and completed sets."""
        workout = db.start_workout(self.connection, self.gym['id'])
        entry = db.add_workout_exercise(self.connection, workout['id'], self.press['id'], 'Barbell')
        for index, result in enumerate(results):
            set_item = (db.sets_for_exercise(self.connection, entry['id'])[0] if index == 0
                        else db.add_set(self.connection, entry['id']))
            db.update_set(self.connection, set_item['id'], dict(weight=weight, result=result, completed=True))
        if complete:
            db.complete_workout(self.connection, workout['id'])
        return workout, entry

    def sets(self, entry):
        return [(s['position'], s['weight'], s['result'], s['completed'])
                for s in db.sets_for_exercise(self.connection, entry['id'])]

    def test_adding_a_set_copies_the_set_above_without_completing_it(self):
        workout, entry = self.completed(8, 6)
        added = db.add_completed_set(self.connection, workout['id'], entry['id'])
        self.assertEqual((added['position'], added['weight'], added['result'], added['completed']),
                         (3, 60, 6, 0))
        self.assertEqual(self.sets(entry), [(1, 60, 8, 1), (2, 60, 6, 1), (3, 60, 6, 0)])

    def test_sets_cannot_be_added_to_an_active_or_different_workout(self):
        workout, entry = self.completed(8)
        other, _ = self.completed(5)
        active, active_entry = self.completed(5, complete=False)
        for workout_id, exercise_id in ((other['id'], entry['id']), (active['id'], active_entry['id']),
                                        (workout['id'], 99999), (workout['id'], 2**63)):
            with self.subTest(workout_id=workout_id, exercise_id=exercise_id):
                with self.assertRaises(LookupError):
                    db.add_completed_set(self.connection, workout_id, exercise_id)
        self.assertEqual(len(self.sets(entry)), 1)
        self.assertEqual(len(self.sets(active_entry)), 1)

    def test_deleting_a_completed_workout_falls_back_to_the_workout_before_it(self):
        earlier, _ = self.completed(8, weight=50)
        later, later_entry = self.completed(12, weight=70)
        self.assertEqual(self.last_workout_results(), [(70, 12)])
        self.assertEqual(db.delete_completed_workout(self.connection, later['id']), {'ok': True})
        self.assertEqual([w['id'] for w in db.workout_history(self.connection)['workouts']], [earlier['id']])
        with self.assertRaises(LookupError):
            db.completed_workout(self.connection, later['id'])
        self.assertEqual(self.sets(later_entry), [])
        self.assertEqual(self.best_results(), [8])
        self.assertEqual(self.last_workout_results(), [(50, 8)])

    def test_an_active_workout_cannot_be_deleted_from_history(self):
        active, active_entry = self.completed(5, complete=False)
        for workout_id in (active['id'], 99999, 0, 2**63):
            with self.subTest(workout_id=workout_id):
                with self.assertRaises(LookupError):
                    db.delete_completed_workout(self.connection, workout_id)
        self.assertEqual(db.bootstrap(self.connection)['active_workout']['id'], active['id'])
        self.assertEqual(len(self.sets(active_entry)), 1)

    def last_workout_results(self):
        """The "Last workout" results shown for Bench Press in a new active workout."""
        active = db.start_workout(self.connection, self.gym['id'])
        db.add_workout_exercise(self.connection, active['id'], self.press['id'], 'Barbell')
        previous = db.bootstrap(self.connection)['workout_exercises'][0]['previous_sets']
        db.cancel_workout(self.connection, active['id'])
        return [(s['weight'], s['result']) for s in previous]

    def best_results(self):
        return [p['best_result'] for p in db.exercise_progress(self.connection, self.press['id'])['points']]

    def test_deleting_a_set_closes_the_gap_and_updates_progress_and_last_workout(self):
        workout, entry = self.completed(8, 12, 6)
        top = db.sets_for_exercise(self.connection, entry['id'])[1]
        self.assertEqual(self.best_results(), [12])
        self.assertEqual(db.delete_completed_set(self.connection, workout['id'], top['id']), {'ok': True})
        self.assertEqual(self.sets(entry), [(1, 60, 8, 1), (2, 60, 6, 1)])
        self.assertEqual(self.best_results(), [8])
        self.assertEqual(self.last_workout_results(), [(60, 8), (60, 6)])
        self.assertEqual(db.workout_history(self.connection)['workouts'][0]['completed_set_count'], 2)

    def test_an_added_set_counts_once_it_is_corrected_to_completed(self):
        workout, entry = self.completed(8)
        added = db.add_completed_set(self.connection, workout['id'], entry['id'])
        self.assertEqual(self.last_workout_results(), [(60, 8)])
        db.correct_completed_set(self.connection, workout['id'], added['id'],
                                 dict(weight=62.5, result=10, completed=True))
        self.assertEqual(self.best_results(), [10])
        self.assertEqual(self.last_workout_results(), [(60, 8), (62.5, 10)])

    def test_sets_of_an_active_or_different_workout_cannot_be_deleted_from_history(self):
        workout, entry = self.completed(8)
        other, _ = self.completed(5)
        active, active_entry = self.completed(5, complete=False)
        set_id = db.sets_for_exercise(self.connection, entry['id'])[0]['id']
        active_set_id = db.sets_for_exercise(self.connection, active_entry['id'])[0]['id']
        for workout_id, target in ((other['id'], set_id), (active['id'], active_set_id),
                                   (workout['id'], 99999), (2**63, set_id)):
            with self.subTest(workout_id=workout_id, set_id=target):
                with self.assertRaises(LookupError):
                    db.delete_completed_set(self.connection, workout_id, target)
        self.assertEqual(len(self.sets(entry)), 1)
        self.assertEqual(len(self.sets(active_entry)), 1)
