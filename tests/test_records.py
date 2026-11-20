import tempfile
import unittest
from pathlib import Path

from gymdex import db, records


class RecordRulesTests(unittest.TestCase):
    """The pure rules, mirrored by static/records.mjs (see tests/records.test.mjs)."""

    def test_values_by_kind_of_set(self):
        done = dict(completed=1, set_type=None, side=None)
        self.assertEqual(records.record_values({**done, 'weight': 100, 'result': 5}, 'repetitions'),
                         {'weight': 100, 'volume': 500, 'e1rm': 100 * 36 / 32})
        self.assertNotIn('e1rm', records.record_values({**done, 'weight': 40, 'result': 13}, 'repetitions'),
                         'Strong leaves sets above 12 reps out of 1RM')
        self.assertEqual(records.record_values({**done, 'weight': -20, 'result': 8}, 'repetitions'), {'weight': -20})
        self.assertEqual(records.record_values({**done, 'weight': None, 'result': 15}, 'repetitions'), {'reps': 15})
        self.assertEqual(records.record_values({**done, 'weight': 0, 'result': 15}, 'repetitions'), {'reps': 15})
        self.assertEqual(records.record_values({**done, 'weight': 10, 'result': 60}, 'duration'), {'duration': 60})
        for skipped in ({**done, 'set_type': 'warmup', 'weight': 200, 'result': 5}, {**done, 'completed': 0, 'weight': 200, 'result': 5},
                        {**done, 'weight': 200, 'result': None}):
            self.assertEqual(records.record_values(skipped, 'repetitions'), {})

    def test_only_the_workouts_best_set_beating_history_is_marked_and_ties_do_not_count(self):
        previous = records.bests([dict(completed=1, weight=100, result=5)], 'repetitions')
        sets = [dict(id=1, completed=1, weight=100, result=5), dict(id=2, completed=1, weight=102.5, result=3),
                dict(id=3, completed=1, weight=102.5, result=3), dict(id=4, completed=1, weight=90, result=10)]
        found = records.records(previous, sets, 'repetitions')
        self.assertEqual([(item['set_id'], item['type'], item['value'], item['previous']) for item in found],
                         [(2, 'weight', 102.5, 100), (4, 'e1rm', 120, 112.5), (4, 'volume', 900, 500)])

    def test_no_history_means_no_records_and_sides_compare_with_their_own_side(self):
        self.assertEqual(records.records({}, [dict(id=1, completed=1, weight=100, result=5)], 'repetitions'), [])
        previous = records.bests([dict(completed=1, weight=20, result=10, side='left'),
                                  dict(completed=1, weight=24, result=10, side='right')], 'repetitions')
        found = records.records(previous, [dict(id=1, completed=1, weight=22, result=10, side='left'),
                                           dict(id=2, completed=1, weight=22, result=10, side='right')], 'repetitions')
        self.assertEqual({(item['set_id'], item['side']) for item in found}, {(1, 'left')})


class RecordQueryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.connection = db.connect(Path(self.directory.name) / 'records.sqlite3')
        db.initialize(self.connection)
        self.gym = db.create_gym(self.connection, 'Home')
        self.other = db.create_gym(self.connection, 'Other')
        catalog = db.catalog_for_gym(self.connection, self.gym['id'])['catalog']
        find = lambda name, variation: next(v for v in catalog if (v['exercise_name'], v['variation_name']) == (name, variation))
        self.press = find('Bench Press', 'Standard')
        self.dip = find('Dip', 'Assisted')
        self.plank = find('Plank', 'Front Plank')

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()

    def workout(self, variation, equipment, sets, gym=None, finish=True):
        workout = db.start_workout(self.connection, (gym or self.gym)['id'])
        entry = db.add_workout_exercise(self.connection, workout['id'], variation['id'], equipment)
        slots = db.sets_for_exercise(self.connection, entry['id'])
        for index, values in enumerate(sets):
            slot = slots[index] if index < len(slots) else db.add_set(self.connection, entry['id'])
            db.update_set(self.connection, slot['id'], {'completed': True, **values})
        for extra in db.sets_for_exercise(self.connection, entry['id'])[len(sets):]:
            db.delete_set(self.connection, extra['id'])
        if finish:
            db.complete_workout(self.connection, workout['id'])
        return workout, entry

    def history_records(self, workout):
        detail = db.completed_workout(self.connection, workout['id'])
        return detail['workout']['record_count'], [
            (item['type'], round(item['value'], 1), round(item['previous'], 1)) for entry in detail['workout_exercises'] for item in entry['records']]

    def test_history_marks_new_bests_against_earlier_workouts_only(self):
        first, _ = self.workout(self.press, 'Barbell', [dict(weight=100, result=5)])
        second, _ = self.workout(self.press, 'Barbell', [dict(weight=105, result=5), dict(weight=60, result=5, set_type='warmup')])
        third, _ = self.workout(self.press, 'Barbell', [dict(weight=100, result=8)])
        self.assertEqual(self.history_records(first), (0, []), 'the first workout has nothing to beat')
        self.assertEqual(self.history_records(second), (3, [('weight', 105, 100), ('e1rm', 118.1, 112.5), ('volume', 525, 500)]))
        # Later workouts do not take records away from earlier ones.
        self.assertEqual(self.history_records(third), (2, [('e1rm', 124.1, 118.1), ('volume', 800, 525)]))
        self.assertEqual(self.history_records(second)[0], 3)

    def test_other_gyms_and_configurations_have_their_own_bests(self):
        self.workout(self.press, 'Barbell', [dict(weight=100, result=5)])
        elsewhere, _ = self.workout(self.press, 'Barbell', [dict(weight=60, result=5)], gym=self.other)
        dumbbell, _ = self.workout(self.press, 'Dumbbell', [dict(weight=30, result=5)])
        self.assertEqual(self.history_records(elsewhere), (0, []))
        self.assertEqual(self.history_records(dumbbell), (0, []))

    def test_assisted_records_less_assistance_and_duration_records_longest(self):
        self.workout(self.dip, 'Machine', [dict(weight=-30, result=8)])
        less, _ = self.workout(self.dip, 'Machine', [dict(weight=-25, result=6)])
        self.assertEqual(self.history_records(less), (1, [('weight', -25, -30)]))
        self.workout(self.plank, 'Bodyweight', [dict(result=60)])
        longer, _ = self.workout(self.plank, 'Bodyweight', [dict(result=75)])
        self.assertEqual(self.history_records(longer), (1, [('duration', 75, 60)]))

    def test_the_active_workout_gets_bests_and_live_records(self):
        self.workout(self.press, 'Barbell', [dict(weight=100, result=5)])
        _, entry = self.workout(self.press, 'Barbell', [dict(weight=102.5, result=5)], finish=False)
        live = db.bootstrap(self.connection)['workout_exercises'][0]
        self.assertEqual(live['record_bests'], {'': {'weight': 100, 'volume': 500, 'e1rm': 112.5}})
        self.assertEqual([item['type'] for item in live['records']], ['weight', 'e1rm', 'volume'])
        db.update_set(self.connection, live['sets'][0]['id'], {'weight': 102.5, 'result': 5, 'completed': False})
        self.assertEqual(db.bootstrap(self.connection)['workout_exercises'][0]['records'], [], 'uncompleting removes it')


if __name__ == '__main__':
    unittest.main()
