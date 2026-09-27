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

    def test_added_set_copies_the_set_above_without_completing_it(self):
        self.save(self.first_set(), result=8, weight=42.5, completed=True)
        last = db.add_set(self.connection, self.entry['id'])
        self.save(last, result=6, weight=40, completed=False)
        added = db.add_set(self.connection, self.entry['id'])
        self.assertEqual((added['position'], added['weight'], added['result'], added['completed']), (3, 40, 6, 0))
        self.assertEqual(db.sets_for_exercise(self.connection, self.entry['id'])[2], added)
        plank = self.add_exercise(self.plank, 'Bodyweight')
        self.save(self.first_set(plank), result=60, weight=None)
        copied = db.add_set(self.connection, plank['id'])
        self.assertEqual((copied['weight'], copied['result'], copied['completed']), (None, 60, 0))

    def test_added_set_copies_assisted_counterweight_as_negative(self):
        catalog = db.catalog_for_gym(self.connection, self.gym['id'])['catalog']
        pull_up = next(v for v in catalog if v['exercise_name'] == 'Pull-up' and v['variation_name'] == 'Assisted')
        entry = self.add_exercise(pull_up, 'Machine')
        self.save(self.first_set(entry), result=8, weight=25)
        self.assertEqual(db.add_set(self.connection, entry['id'])['weight'], -25)

    def test_added_set_after_removing_every_set_starts_empty(self):
        self.save(self.first_set())
        db.delete_set(self.connection, self.first_set()['id'])
        added = db.add_set(self.connection, self.entry['id'])
        self.assertEqual((added['position'], added['weight'], added['result'], added['completed']), (1, None, None, 0))

    def test_removing_workout_exercise_deletes_its_sets_and_closes_the_gap(self):
        self.save(self.first_set())
        middle = self.add_exercise(self.plank, 'Bodyweight')
        db.add_set(self.connection, middle['id'])
        last = self.add_exercise(self.press, 'Dumbbell')
        self.assertEqual(db.remove_workout_exercise(self.connection, middle['id']), {'ok': True})
        entries = db.bootstrap(self.connection)['workout_exercises']
        self.assertEqual([(e['id'], e['position']) for e in entries], [(self.entry['id'], 1), (last['id'], 2)])
        self.assertEqual(entries[0]['sets'][0]['result'], 8)
        self.assertEqual(db.sets_for_exercise(self.connection, middle['id']), [])
        self.assertEqual(self.add_exercise(self.plank, 'Bodyweight')['position'], 3)

    def test_moving_workout_exercise_shifts_the_others(self):
        middle = self.add_exercise(self.plank, 'Bodyweight')
        last = self.add_exercise(self.press, 'Dumbbell')
        order = lambda: [e['id'] for e in db.bootstrap(self.connection)['workout_exercises']]
        moved = db.move_workout_exercise(self.connection, last['id'], 1)
        self.assertEqual(moved, {'workout_exercises': [
            {'id': last['id'], 'position': 1}, {'id': self.entry['id'], 'position': 2},
            {'id': middle['id'], 'position': 3}]})
        db.move_workout_exercise(self.connection, last['id'], 2)
        self.assertEqual(order(), [self.entry['id'], last['id'], middle['id']])
        db.move_workout_exercise(self.connection, last['id'], 2)
        self.assertEqual(order(), [self.entry['id'], last['id'], middle['id']])
        for position in [0, 4, -1, True, 1.0, '2', None]:
            with self.subTest(position=position), self.assertRaises(ValueError):
                db.move_workout_exercise(self.connection, last['id'], position)
        self.assertEqual(order(), [self.entry['id'], last['id'], middle['id']])

    def test_completed_workout_rejects_exercise_removal_and_reordering(self):
        second = self.add_exercise(self.plank, 'Bodyweight')
        db.complete_workout(self.connection, self.workout['id'])
        for action in [lambda: db.remove_workout_exercise(self.connection, second['id']),
                       lambda: db.move_workout_exercise(self.connection, second['id'], 1),
                       lambda: db.remove_workout_exercise(self.connection, 999)]:
            with self.assertRaises(LookupError):
                action()
        detail = db.completed_workout(self.connection, self.workout['id'])
        self.assertEqual([e['id'] for e in detail['workout_exercises']], [self.entry['id'], second['id']])

    def test_deletion_and_renumbering_helpers_work_on_completed_workouts(self):
        second = self.add_exercise(self.plank, 'Bodyweight')
        third = self.add_exercise(self.press, 'Dumbbell')
        sets = [self.first_set(third)] + [db.add_set(self.connection, third['id']) for _ in range(3)]
        db.complete_workout(self.connection, self.workout['id'])
        with self.connection:
            db.delete_workout_exercise(self.connection, second['id'])
            self.connection.execute('DELETE FROM workout_sets WHERE id = ?', (sets[1]['id'],))
            db.renumber_positions(self.connection, 'workout_sets', third['id'])
        detail = db.completed_workout(self.connection, self.workout['id'])
        self.assertEqual([(e['id'], e['position']) for e in detail['workout_exercises']],
                         [(self.entry['id'], 1), (third['id'], 2)])
        self.assertEqual([(s['id'], s['position']) for s in detail['workout_exercises'][1]['sets']],
                         [(sets[0]['id'], 1), (sets[2]['id'], 2), (sets[3]['id'], 3)])

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

    def finish_with_completed_sets(self, count, entry=None):
        entry = entry or self.entry
        self.save(self.first_set(entry), result=8, weight=40)
        for result in range(7, 8 - count, -1):
            self.save(db.add_set(self.connection, entry['id']), result=result, weight=40)
        db.complete_workout(self.connection, self.workout['id'])
        self.workout = db.start_workout(self.connection, self.gym['id'])

    def test_added_exercise_gets_one_empty_slot_per_set_of_last_matching_workout(self):
        self.finish_with_completed_sets(3)
        entry = self.add_exercise(self.press, 'Barbell')
        slots = db.sets_for_exercise(self.connection, entry['id'])
        self.assertEqual([(s['position'], s['weight'], s['result'], s['completed']) for s in slots],
                         [(1, None, None, 0), (2, None, None, 0), (3, None, None, 0)])

    def test_added_exercise_slots_only_count_the_same_gym_equipment_and_machine(self):
        self.finish_with_completed_sets(3)
        self.assertEqual(len(db.sets_for_exercise(self.connection, self.add_exercise(self.press, 'Dumbbell')['id'])), 1)
        self.assertEqual(len(db.sets_for_exercise(self.connection, self.add_exercise(self.press, 'Barbell', 'Different', 'Machine')['id'])), 1)
        db.cancel_workout(self.connection, self.workout['id'])
        other = db.create_gym(self.connection, 'Other gym')
        self.workout = db.start_workout(self.connection, other['id'])
        self.assertEqual(len(db.sets_for_exercise(self.connection, self.add_exercise(self.press, 'Barbell')['id'])), 1)

    def test_added_exercise_without_completed_history_gets_one_empty_slot(self):
        self.save(db.add_set(self.connection, self.entry['id']), result=5, completed=False)
        db.complete_workout(self.connection, self.workout['id'])
        self.workout = db.start_workout(self.connection, self.gym['id'])
        slots = db.sets_for_exercise(self.connection, self.add_exercise(self.press, 'Barbell')['id'])
        self.assertEqual([(s['weight'], s['result'], s['completed']) for s in slots], [(None, None, 0)])
        self.assertEqual(len(db.sets_for_exercise(self.connection, self.add_exercise(self.plank, 'Bodyweight')['id'])), 1)

    def test_migration_preserves_existing_workout_and_is_repeatable(self):
        self.connection.execute('DROP TABLE workout_sets')
        self.connection.execute('ALTER TABLE workout_exercises DROP COLUMN tracking_type_snapshot')
        self.connection.execute('ALTER TABLE exercise_variations DROP COLUMN assisted')
        self.connection.execute('PRAGMA user_version = 0')
        self.connection.commit()
        db.initialize(self.connection)
        db.initialize(self.connection)
        entry = db.bootstrap(self.connection)['workout_exercises'][0]
        self.assertEqual(entry['id'], self.entry['id'])
        self.assertEqual(entry['tracking_type'], 'repetitions')
        self.assertEqual(entry['sets'], [])
        self.assertEqual(db.add_set(self.connection, entry['id'])['position'], 1)

    def test_version_one_database_gains_assisted_variations_and_keeps_negative_sets(self):
        legacy = self.first_set()
        self.save(legacy, weight=-12.5)
        self.connection.execute('ALTER TABLE exercise_variations DROP COLUMN assisted')
        self.connection.execute("DELETE FROM variation_equipment WHERE variation_id IN (SELECT id FROM exercise_variations WHERE name = 'Assisted')")
        self.connection.execute("DELETE FROM exercise_variations WHERE name = 'Assisted'")
        self.connection.execute('PRAGMA user_version = 1')
        self.connection.commit()
        db.initialize(self.connection)
        db.initialize(self.connection)
        self.assertEqual(self.connection.execute('PRAGMA user_version').fetchone()[0], 2)
        catalog = db.catalog_for_gym(self.connection, self.gym['id'])['catalog']
        self.assertEqual({(v['exercise_name'], v['variation_name']) for v in catalog if v['assisted']},
                         {('Pull-up', 'Assisted'), ('Dip', 'Assisted')})
        entry = db.bootstrap(self.connection)['workout_exercises'][0]
        self.assertEqual(entry['assisted'], 0)
        self.assertEqual(entry['sets'][0]['weight'], -12.5)

    def test_assisted_variation_stores_counterweight_as_negative_weight(self):
        catalog = db.catalog_for_gym(self.connection, self.gym['id'])['catalog']
        pull_up = next(v for v in catalog if v['exercise_name'] == 'Pull-up' and v['variation_name'] == 'Assisted')
        self.assertEqual(pull_up['assisted'], 1)
        self.assertEqual(self.press['assisted'], 0)
        entry = self.add_exercise(pull_up, 'Machine')
        item = self.first_set(entry)
        self.save(item, weight=20)
        self.assertEqual(self.first_set(entry)['weight'], -20)
        self.save(item, weight=-15.5)
        self.assertEqual(self.first_set(entry)['weight'], -15.5)
        self.save(item, weight=None)
        self.assertIsNone(self.first_set(entry)['weight'])
        self.save(self.first_set(), weight=20)
        self.assertEqual(self.first_set()['weight'], 20)
        entries = db.bootstrap(self.connection)['workout_exercises']
        self.assertEqual([e['assisted'] for e in entries], [0, 1])
        self.save(item, weight=25)
        db.complete_workout(self.connection, self.workout['id'])
        detail = db.completed_workout(self.connection, self.workout['id'])
        self.assertEqual(detail['workout_exercises'][1]['assisted'], 1)
        corrected = db.correct_completed_set(self.connection, self.workout['id'], item['id'],
                                             dict(weight=30, result=8, completed=True))
        self.assertEqual(corrected['weight'], -30)

    def test_custom_exercise_can_be_assisted(self):
        status, created = self.request('POST', '/api/exercises', dict(
            name='Chin-up', variation_name='Assisted', tracking_type='repetitions',
            equipment=['Machine'], assisted=True))
        self.assertEqual(status, 201)
        self.assertEqual(created['assisted'], 1)
        status, plain = self.request('POST', '/api/exercises', dict(
            name='Chin-up', variation_name='', tracking_type='repetitions', equipment=['Bodyweight']))
        self.assertEqual((status, plain['assisted']), (201, 0))
        status, body = self.request('POST', '/api/exercises', dict(
            name='Chin-up', variation_name='Band', tracking_type='repetitions',
            equipment=['Band'], assisted='yes'))
        self.assertEqual(status, 400)
        self.assertIn('Assisted', body['error'])

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
        status, copied = self.request('POST', f'/api/workout-exercises/{self.entry["id"]}/sets', {})
        self.assertEqual((status, copied['result'], copied['completed']), (201, 12, 0))
        for payload in [[], None, dict(result=0, weight=None, completed=True)]:
            self.assertEqual(self.request('PUT', f'/api/sets/{item["id"]}', payload)[0], 400)
        self.assertEqual(self.request('PUT', '/api/sets/invalid', {})[0], 400)
        self.assertEqual(self.request('DELETE', f'/api/sets/{item["id"]}')[0], 200)
        self.assertEqual(self.request('DELETE', f'/api/sets/{item["id"]}')[0], 404)

    def test_workout_exercise_move_and_remove_routes(self):
        second = self.add_exercise(self.plank, 'Bodyweight')
        path = f'/api/workout-exercises/{second["id"]}'
        status, body = self.request('PUT', path, dict(position=1))
        self.assertEqual(status, 200)
        self.assertEqual([item['id'] for item in body['workout_exercises']], [second['id'], self.entry['id']])
        for payload in [dict(position=3), dict(position='1'), dict(), []]:
            with self.subTest(payload=payload):
                self.assertEqual(self.request('PUT', path, payload)[0], 400)
        self.assertEqual(self.request('PUT', '/api/workout-exercises/999', dict(position=1))[0], 404)
        self.assertEqual(self.request('DELETE', path), (200, {'ok': True}))
        self.assertEqual(self.request('DELETE', path)[0], 404)
        self.assertEqual(self.request('DELETE', '/api/workout-exercises/invalid')[0], 400)
        self.assertEqual([e['position'] for e in db.bootstrap(self.connection)['workout_exercises']], [1])

    def test_request_field_types_return_json_client_errors(self):
        for path, payload in [('/api/gyms', {'name': None}),
                              ('/api/workouts', {'gym_id': None})]:
            with self.subTest(path=path):
                status, body = self.request('POST', path, payload)
                self.assertEqual(status, 400)
                self.assertIsInstance(body['error'], str)

    def test_cancel_discards_active_workout_and_preserves_history_and_profiles(self):
        self.save(self.first_set())
        completed_id = self.workout['id']
        completed_entry_id = self.entry['id']
        db.complete_workout(self.connection, completed_id)
        self.workout = db.start_workout(self.connection, self.gym['id'])
        active_entry = self.add_exercise(self.press, 'Barbell')
        active_set = self.first_set(active_entry)
        self.save(active_set)
        self.add_exercise(self.plank, 'Bodyweight')
        profiles = db.rows(self.connection.execute('SELECT * FROM gym_exercise_profiles'))

        status, body = self.request('DELETE', f'/api/workouts/{self.workout["id"]}')
        self.assertEqual((status, body), (200, {'ok': True}))
        self.assertIsNone(db.bootstrap(self.connection)['active_workout'])
        self.assertEqual(db.bootstrap(self.connection)['workout_exercises'], [])
        self.assertEqual(db.sets_for_exercise(self.connection, active_entry['id']), [])
        self.assertEqual(self.connection.execute('SELECT COUNT(*) FROM workout_exercises').fetchone()[0], 1)
        self.assertEqual(self.connection.execute('SELECT COUNT(*) FROM workout_sets').fetchone()[0], 1)
        self.assertEqual(db.sets_for_exercise(self.connection, completed_entry_id)[0]['result'], 8)
        self.assertEqual(db.rows(self.connection.execute('SELECT * FROM gym_exercise_profiles')), profiles)
        self.assertEqual(self.request('DELETE', f'/api/workouts/{self.workout["id"]}')[0], 404)
        self.assertEqual(self.request('PUT', f'/api/sets/{active_set["id"]}', dict(result=8, weight=None, completed=True))[0], 404)

        self.workout = db.start_workout(self.connection, self.gym['id'])
        self.add_exercise(self.press, 'Barbell')
        self.assertEqual(db.bootstrap(self.connection)['workout_exercises'][0]['previous_sets'][0]['result'], 8)

    def test_cancel_rejects_completed_missing_and_invalid_workouts(self):
        self.save(self.first_set())
        db.complete_workout(self.connection, self.workout['id'])
        active = db.start_workout(self.connection, self.gym['id'])
        for workout_id, expected in [(self.workout['id'], 404), (999, 404), ('invalid', 400)]:
            with self.subTest(workout_id=workout_id):
                self.assertEqual(self.request('DELETE', f'/api/workouts/{workout_id}')[0], expected)
        self.assertEqual(db.bootstrap(self.connection)['active_workout']['id'], active['id'])
        self.assertEqual(self.first_set()['completed'], 1)

    def test_cancel_empty_workout(self):
        db.complete_workout(self.connection, self.workout['id'])
        empty = db.start_workout(self.connection, self.gym['id'])
        self.assertEqual(self.request('DELETE', f'/api/workouts/{empty["id"]}')[0], 200)
        self.assertIsNone(db.bootstrap(self.connection)['active_workout'])


if __name__ == '__main__':
    unittest.main()
