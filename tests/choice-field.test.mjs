import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChoiceField } from '../static/choice-field.mjs';
import { choiceContainer, choose, listed, pick, toggleList, type } from './fake-choice-field.mjs';

const manufacturer = (container, options, value) => new ChoiceField(container, { id: 'manufacturer', name: 'manufacturer',
  title: 'Manufacturer', optional: true, placeholder: 'e.g. Technogym', options, value });

test('without known values the field is just a text input that carries the form value', () => {
  const container = choiceContainer();
  const field = manufacturer(container, []);
  assert.equal(container.querySelector('#manufacturer-toggle').hidden, true);
  assert.match(container.innerHTML, /<label for="manufacturer">Manufacturer <small>\(optional\)<\/small><\/label>/);
  assert.match(container.innerHTML, /<input id="manufacturer" name="manufacturer" maxlength="80" autocomplete="off" placeholder="e\.g\. Technogym"/);
  assert.doesNotMatch(container.innerHTML, /<select|Other…|None/);
  type(container, 'manufacturer', '  Hammer   Strength ');
  assert.equal(field.value, 'Hammer Strength');
  assert.deepEqual(listed(container, 'manufacturer'), []);
});

test('the chevron lists known values and picking one fills the text input', () => {
  const container = choiceContainer();
  const field = manufacturer(container, ['Hammer Strength', 'Single <Leg>']);
  const input = container.querySelector('#manufacturer');
  assert.equal(container.querySelector('#manufacturer-toggle').hidden, false);
  assert.equal(input.classList.contains('has-choices'), true);
  assert.deepEqual([field.value, listed(container, 'manufacturer')], ['', []]);

  toggleList(container, 'manufacturer');
  assert.deepEqual(listed(container, 'manufacturer'), ['Hammer Strength', 'Single <Leg>']);
  assert.equal(input.attributes['aria-expanded'], 'true');
  assert.equal(input.focused, false, 'opening the list does not raise the keyboard');
  pick(container, 'manufacturer', 'Single <Leg>');
  assert.equal(input.value, 'Single <Leg>', 'the input submits the picked value');
  assert.equal(field.value, 'Single <Leg>');
  assert.deepEqual(listed(container, 'manufacturer'), [], 'picking closes the list');
  assert.equal(input.attributes['aria-expanded'], 'false');

  toggleList(container, 'manufacturer');
  toggleList(container, 'manufacturer');
  assert.deepEqual(listed(container, 'manufacturer'), [], 'the chevron closes the list again');
});

test('typing narrows the list to matching values and a value typed in full closes it', () => {
  const container = choiceContainer();
  const field = manufacturer(container, ['Hammer Strength', 'Technogym', 'Matrix']);
  type(container, 'manufacturer', 'm');
  assert.deepEqual(listed(container, 'manufacturer'), ['Hammer Strength', 'Technogym', 'Matrix']);
  type(container, 'manufacturer', 'TECH');
  assert.deepEqual(listed(container, 'manufacturer'), ['Technogym']);
  type(container, 'manufacturer', 'technogym');
  assert.deepEqual(listed(container, 'manufacturer'), []);
  type(container, 'manufacturer', 'Cybex');
  assert.deepEqual(listed(container, 'manufacturer'), [], 'a new value lists nothing');
  assert.equal(field.value, 'Cybex');
  type(container, 'manufacturer', '');
  assert.deepEqual(listed(container, 'manufacturer'), []);
});

test('new options keep the typed text and close the list', () => {
  const container = choiceContainer();
  const field = manufacturer(container, ['Technogym']);
  type(container, 'manufacturer', 'Te');
  field.setOptions(['Cybex', 'Technogym']);
  assert.deepEqual([field.value, listed(container, 'manufacturer')], ['Te', []]);
  field.setOptions([]);
  assert.equal(container.querySelector('#manufacturer-toggle').hidden, true);
  assert.equal(field.value, 'Te', 'the text typed earlier is kept');
  field.setOptions(['Cybex']);
  choose(container, 'manufacturer', 'Cybex');
  assert.equal(field.value, 'Cybex');
});

test('a starting value fills the input whether or not it is listed', () => {
  assert.equal(manufacturer(choiceContainer(), ['Cybex', 'Technogym'], 'Technogym').value, 'Technogym');
  assert.equal(manufacturer(choiceContainer(), ['Technogym'], 'Cy"bex').value, 'Cy"bex');
  assert.equal(manufacturer(choiceContainer(), ['Technogym'], undefined).value, '');
});

test('Enter and picking run onEnter instead of submitting, and clear() starts over', () => {
  const container = choiceContainer();
  const entered = [];
  const field = new ChoiceField(container, { id: 'equipment-entry', title: 'Equipment options',
    options: ['Machine'], onEnter: (picked) => entered.push([picked, field.value]) });
  type(container, 'equipment-entry', 'Sled');
  const input = container.querySelector('#equipment-entry');
  let prevented = false;
  input.events.keydown({ key: 'a', preventDefault() { prevented = true; } });
  assert.deepEqual([entered, prevented], [[], false]);
  input.events.keydown({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.deepEqual([entered, prevented], [[[false, 'Sled']], true]);
  assert.doesNotMatch(container.innerHTML, / name=/, 'a field without a name is not submitted with the form');

  choose(container, 'equipment-entry', 'Machine');
  assert.deepEqual(entered.at(-1), [true, 'Machine']);
  field.clear();
  assert.equal(field.value, '');
});
