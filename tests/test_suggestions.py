import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from gymdex import db
from gymdex.server import GymdexHandler

STARTER_EQUIPMENT = ['Barbell', 'Bodyweight', 'Cable', 'Dumbbell', 'Machine', 'Rope']


class SuggestionTests(unittest.TestCase):
    """Suggestions offered by the custom exercise form and the Exercise Configuration form."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.connection = db.connect(Path(self.directory.name) / 'suggestions.sqlite3')
        db.initialize(self.connection)
        self.home = db.create_gym(self.connection, 'Home')
        self.other = db.create_gym(self.connection, 'Other')
        catalog = db.catalog_for_gym(self.connection, self.home['id'])['catalog']
        self.leg_press = next(v for v in catalog if (v['exercise_name'], v['variation_name']) == ('Leg Press', 'Standard'))
        self.press = next(v for v in catalog if (v['exercise_name'], v['variation_name']) == ('Bench Press', 'Standard'))

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()

    def configure(self, gym, variation, equipment, manufacturer='', label='', complete=True):
        """Save an Exercise Configuration by adding it to a Workout at the gym."""
        workout = db.start_workout(self.connection, gym['id'])
        db.add_workout_exercise(self.connection, workout['id'], variation['id'], equipment, manufacturer, label)
        if complete:
            db.complete_workout(self.connection, workout['id'])
        else:
            db.cancel_workout(self.connection, workout['id'])

    def configuration_id(self, manufacturer):
        return next(item['id'] for item in db.manage_overview(self.connection)['configurations']
                    if item['manufacturer'] == manufacturer)

    def suggestions(self, exercise_name):
        found = db.exercise_suggestions(self.connection)
        return next((item for item in found['exercises'] if item['name'] == exercise_name), None)

    def test_new_exercises_are_offered_the_starter_equipment(self):
        self.assertEqual(db.exercise_suggestions(self.connection)['equipment'], STARTER_EQUIPMENT)

    def test_an_exercise_offers_its_variations_equipment_and_machine_details_from_every_gym(self):
        single = db.create_exercise(self.connection, 'leg press', 'Single Leg', 'repetitions', ['Sled', 'machine'])
        self.configure(self.home, self.leg_press, 'Machine', 'Technogym', 'Upstairs')
        self.configure(self.other, single, 'Sled', ' technogym ', '')
        self.configure(self.other, self.leg_press, 'Machine', 'Hammer Strength', 'upstairs')
        # Bench Press's machine label is not offered for Leg Press.
        self.configure(self.home, self.press, 'Barbell', 'Eleiko', 'Rack 2')

        leg_press = self.suggestions('Leg Press')

        self.assertEqual(leg_press['variations'], ['Single Leg', 'Standard'])
        self.assertEqual(leg_press['equipment'], sorted(STARTER_EQUIPMENT + ['Sled']))
        self.assertEqual(leg_press['manufacturers'], ['Hammer Strength', 'Technogym'])
        self.assertEqual(leg_press['labels'], ['Upstairs'])
        self.assertEqual(self.suggestions('Bench Press')['manufacturers'], ['Eleiko'])
        self.assertEqual(self.suggestions('Bench Press')['variations'], ['Incline', 'Standard'])
        global_choices = db.exercise_suggestions(self.connection)
        self.assertEqual(global_choices['manufacturers'], ['Eleiko', 'Hammer Strength', 'Technogym'])
        self.assertNotIn('labels', global_choices)

    def test_suggestions_disappear_with_their_archived_or_deleted_source_rows(self):
        heavy = db.create_exercise(self.connection, 'Sled Push', 'Heavy', 'duration', ['Sled'])
        light = db.create_exercise(self.connection, 'Sled Push', 'Light', 'duration', ['Prowler'])
        self.configure(self.home, heavy, 'Sled', 'Rogue', 'Turf')
        self.configure(self.home, light, 'Prowler', 'Eleiko', 'Lane 1')
        self.configure(self.home, light, 'Prowler', 'Watson', '', complete=False)

        self.assertEqual(db.remove_item(self.connection, 'configuration', self.configuration_id('Eleiko')), {'outcome': 'archived'})
        self.assertEqual(db.remove_item(self.connection, 'configuration', self.configuration_id('Watson')), {'outcome': 'deleted'})
        self.assertEqual(db.remove_item(self.connection, 'variation', heavy['id']), {'outcome': 'archived'})

        sled_push = self.suggestions('Sled Push')
        self.assertEqual(sled_push['variations'], ['Light'])
        self.assertEqual(sled_push['equipment'], sorted(STARTER_EQUIPMENT + ['Prowler']))
        self.assertEqual((sled_push['manufacturers'], sled_push['labels']), ([], []))

        db.remove_item(self.connection, 'variation', light['id'])
        self.assertIsNone(self.suggestions('Sled Push'))
        choices = db.exercise_suggestions(self.connection)
        self.assertNotIn('Heavy', choices['variations'])
        self.assertNotIn('Light', choices['variations'])
        self.assertEqual(choices['manufacturers'], [])
        db.restore_item(self.connection, 'variation', heavy['id'])
        self.assertIn('Heavy', db.exercise_suggestions(self.connection)['variations'])

    def test_variation_names_are_reusable_across_exercises(self):
        db.create_exercise(self.connection, 'First Exercise', 'Boy', 'duration', ['Bodyweight'])
        choices = db.catalog_for_gym(self.connection, self.other['id'])['suggestions']
        self.assertIn('Boy', choices['variations'])
        created = db.create_exercise(self.connection, 'Second Exercise', 'Boy', 'repetitions', ['Machine'])
        self.assertEqual(created['variation_name'], 'Boy')
        self.assertEqual(db.exercise_suggestions(self.connection)['variations'].count('Boy'), 1)

    def test_an_archived_gyms_configurations_are_still_offered_at_other_gyms(self):
        self.configure(self.other, self.leg_press, 'Machine', 'Cybex', 'Left')

        self.assertEqual(db.remove_item(self.connection, 'gym', self.other['id']), {'outcome': 'archived'})

        self.assertEqual(self.suggestions('Leg Press')['manufacturers'], ['Cybex'])


    def test_the_picker_catalog_route_includes_suggestions(self):
        self.configure(self.home, self.press, 'Barbell', 'Eleiko', 'Rack 2')
        handler = object.__new__(GymdexHandler)
        handler.server = SimpleNamespace(db_path=Path(self.directory.name) / 'suggestions.sqlite3')
        handler.path = f'/api/catalog?gym_id={self.other["id"]}'
        handler.headers = {'Content-Length': '0'}
        handler.rfile = io.BytesIO(b'')
        response = []
        handler._json = lambda data, status=200: response.append((int(status), json.loads(json.dumps(data))))

        handler.do_GET()

        status, body = response[0]
        self.assertEqual(status, 200)
        self.assertEqual(body['suggestions']['equipment'], STARTER_EQUIPMENT)
        self.assertEqual(body['suggestions']['manufacturers'], ['Eleiko'])
        press = next(item for item in body['suggestions']['exercises'] if item['name'] == 'Bench Press')
        self.assertEqual((press['manufacturers'], press['labels']), (['Eleiko'], ['Rack 2']))
