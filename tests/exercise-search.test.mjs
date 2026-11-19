import assert from 'node:assert/strict';
import test from 'node:test';
import { ExerciseSearch, filterByText, foldText, sortByName } from '../static/exercise-search.mjs';
import { searchContainer, shown, tapOption, typeSearch } from './fake-exercise-search.mjs';

const item = (id, name, exercise = name, variation = 'Standard', note = '') => ({ id, name, texts: [name, exercise, variation], note });
const catalog = [
  item(1, 'Incline Bench Press', 'Bench Press', 'Incline'),
  item(2, 'Bench Press'),
  item(3, 'Standing Biceps Curl', 'Biceps Curl', 'Standing'),
  item(4, 'Leg Press Calf Press', 'Calf Press', 'Leg Press'),
  item(5, 'preacher curl', 'Preacher Curl', 'Standard'),
  item(6, 'Développé Couché', 'Développé Couché', 'Standard', '(archived)'),
];

test('text folds case and accents', () => {
  assert.equal(foldText('Développé COUCHÉ'), 'developpe couche');
  assert.equal(foldText(null), '');
});

test('exercises sort alphabetically ignoring case and accents', () => {
  assert.deepEqual(sortByName(catalog, (entry) => entry.name).map((entry) => entry.name), [
    'Bench Press', 'Développé Couché', 'Incline Bench Press', 'Leg Press Calf Press', 'preacher curl', 'Standing Biceps Curl']);
});

test('search matches any part of the exercise or variation name, every word, any case or accent', () => {
  const names = (query) => filterByText(catalog, query, (entry) => entry.texts).map((entry) => entry.name);
  assert.deepEqual(names('CURL'), ['Standing Biceps Curl', 'preacher curl']);
  assert.deepEqual(names('developpe'), ['Développé Couché']);
  assert.deepEqual(names('press incl'), ['Incline Bench Press']);
  assert.deepEqual(names('standing'), ['Standing Biceps Curl']);
  assert.deepEqual(names('  '), names(''));
  assert.deepEqual(names('zzz'), []);
});

test('the picker shows the chosen exercise, opens a sorted searchable list and chooses a tapped match', () => {
  const container = searchContainer();
  const chosen = [];
  const search = new ExerciseSearch(container, { id: 'pe', label: 'Exercise', items: catalog, selectedId: 4, onChange: (entry) => chosen.push(entry.id) });
  const current = container.querySelector('#pe-current');
  const panel = container.querySelector('#pe-panel');
  assert.equal(search.value, '4');
  assert.equal(current.textContent, 'Leg Press Calf Press');
  assert.equal(panel.hidden, true);
  current.events.click();
  assert.equal(panel.hidden, false);
  assert.equal(current.attributes['aria-expanded'], 'true');
  assert.equal(container.focused, container.querySelector('#pe-search'));
  assert.deepEqual(shown(container, 'pe'), ['Bench Press', 'Développé Couché (archived)', 'Incline Bench Press',
    'Leg Press Calf Press', 'preacher curl', 'Standing Biceps Curl']);
  assert.deepEqual(container.querySelector('#pe-list').options.filter((option) => option.selected).map((option) => option.text), ['Leg Press Calf Press']);
  typeSearch(container, 'pe', 'curl');
  assert.deepEqual(shown(container, 'pe'), ['preacher curl', 'Standing Biceps Curl']);
  assert.equal(container.querySelector('#pe-status').textContent, '2 matches');
  typeSearch(container, 'pe', 'zzz');
  assert.deepEqual(shown(container, 'pe'), []);
  assert.equal(container.querySelector('#pe-status').textContent, 'No exercises match “zzz”.');
  typeSearch(container, 'pe', 'preacher');
  tapOption(container, 'pe', 'preacher curl');
  assert.deepEqual(chosen, [5]);
  assert.equal(search.value, '5');
  assert.equal(current.textContent, 'preacher curl');
  assert.equal(panel.hidden, true);
  assert.equal(current.attributes['aria-expanded'], 'false');
  assert.equal(container.focused, current);
  // Reopening starts from the full list again; choosing the same exercise changes nothing.
  current.events.click();
  assert.equal(shown(container, 'pe').length, 6);
  tapOption(container, 'pe', 'preacher curl');
  assert.deepEqual(chosen, [5]);
});

test('the picker works from the keyboard: arrows move through matches, Enter picks the first, Escape closes', () => {
  const container = searchContainer();
  const chosen = [];
  new ExerciseSearch(container, { id: 'pe', label: 'Exercise', items: catalog, onChange: (entry) => chosen.push(entry.id) });
  assert.equal(container.querySelector('#pe-current').textContent, 'Bench Press');
  const current = container.querySelector('#pe-current');
  const search = container.querySelector('#pe-search');
  const list = container.querySelector('#pe-list');
  const key = (target, name) => { let prevented = false; target.events.keydown({ key: name, target: container.focused, preventDefault: () => { prevented = true; } }); return prevented; };
  current.events.click();
  typeSearch(container, 'pe', 'press');
  assert.equal(key(search, 'ArrowDown'), true);
  assert.equal(container.focused.text, 'Bench Press');
  key(list, 'ArrowDown');
  assert.equal(container.focused.text, 'Incline Bench Press');
  key(list, 'ArrowUp');
  key(list, 'ArrowUp');
  assert.equal(container.focused, search);
  key(list, 'Escape');
  assert.equal(container.querySelector('#pe-panel').hidden, true);
  assert.equal(container.focused, current);
  current.events.click();
  typeSearch(container, 'pe', 'calf');
  assert.equal(key(search, 'Enter'), true, 'Enter does not submit the progress form');
  assert.deepEqual(chosen, [4]);
  current.events.click();
  typeSearch(container, 'pe', 'zzz');
  key(search, 'Enter');
  assert.deepEqual(chosen, [4]);
  assert.equal(container.querySelector('#pe-panel').hidden, false);
});

test('an empty catalog shows no exercises and does not open', () => {
  const container = searchContainer();
  const search = new ExerciseSearch(container, { id: 'pe', label: 'Exercise', items: [] });
  assert.equal(search.value, '');
  assert.equal(container.querySelector('#pe-current').textContent, 'No exercises yet');
  container.querySelector('#pe-current').events.click();
  assert.equal(container.querySelector('#pe-panel').hidden, true);
});
