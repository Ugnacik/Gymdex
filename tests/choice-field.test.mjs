import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChoiceField, OTHER } from '../static/choice-field.mjs';
import { choiceContainer, choose, type } from './fake-choice-field.mjs';

const manufacturer = (container, options) => new ChoiceField(container, { id: 'manufacturer', name: 'manufacturer',
  title: 'Manufacturer', optional: true, empty: 'None', placeholder: 'e.g. Technogym', newLabel: 'New manufacturer', options });

test('without known values the field is just a text input that carries the form value', () => {
  const container = choiceContainer();
  const field = manufacturer(container, []);
  assert.equal(container.querySelector('#manufacturer-choice'), null);
  assert.match(container.innerHTML, /<label for="manufacturer">Manufacturer <small>\(optional\)<\/small><\/label>/);
  assert.match(container.innerHTML, /<input id="manufacturer" name="manufacturer" maxlength="80" autocomplete="off" placeholder="e\.g\. Technogym"/);
  type(container, 'manufacturer', '  Hammer   Strength ');
  assert.equal(field.value, 'Hammer Strength');
  assert.equal(field.typing, true);
});

test('known values are a select whose Other… option reveals the text input', () => {
  const container = choiceContainer();
  const field = manufacturer(container, ['Hammer Strength', 'Technogym']);
  const select = container.querySelector('#manufacturer-choice');
  assert.match(container.innerHTML, /<label for="manufacturer-choice">/);
  assert.deepEqual(select.options.map((option) => [option.value, option.text]),
    [['', 'None'], ['Hammer Strength', 'Hammer Strength'], ['Technogym', 'Technogym'], [OTHER, 'Other…']]);
  // Other…'s value survives HTML parsing (no NUL) and differs from every whitespace-collapsed value.
  assert.doesNotMatch(OTHER, /[\u0000-\u001f]/);
  assert.notEqual(OTHER, OTHER.split(/\s+/).filter(Boolean).join(' '));
  const input = container.querySelector('#manufacturer');
  assert.equal(input.hidden, true);
  assert.equal(input.value, '');
  assert.equal(input.name, 'manufacturer');
  assert.match(container.innerHTML, /aria-label="New manufacturer"/);
  assert.equal(field.value, '');

  choose(container, 'manufacturer-choice', 'Technogym');
  assert.equal(input.value, 'Technogym', 'the hidden input submits the chosen value');
  assert.equal(input.hidden, true);
  assert.equal(field.value, 'Technogym');

  choose(container, 'manufacturer-choice', OTHER);
  assert.equal(input.hidden, false);
  assert.equal(input.value, '');
  assert.equal(input.focused, true);
  assert.equal(field.typing, true);
  type(container, 'manufacturer', 'Cybex');
  assert.equal(field.value, 'Cybex');

  choose(container, 'manufacturer-choice', '');
  assert.equal(input.value, '');
  assert.equal(input.hidden, true);
  assert.equal(field.value, '');
});

test('new options keep the current choice and typed text', () => {
  const container = choiceContainer();
  const field = manufacturer(container, ['Technogym']);
  choose(container, 'manufacturer-choice', OTHER);
  type(container, 'manufacturer', 'Cy');
  field.setOptions(['Cybex', 'Technogym']);
  assert.equal(container.querySelector('#manufacturer-choice').value, OTHER);
  assert.equal(container.querySelector('#manufacturer').hidden, false);
  assert.equal(field.value, 'Cy');

  choose(container, 'manufacturer-choice', 'Technogym');
  field.setOptions(['Cybex', 'Technogym']);
  assert.equal(field.value, 'Technogym');
  field.setOptions(['Cybex']);
  assert.equal(container.querySelector('#manufacturer-choice').value, '', 'a value no longer offered falls back to the default');
  assert.equal(field.value, '');

  field.setOptions([]);
  assert.equal(container.querySelector('#manufacturer-choice'), null);
  assert.equal(container.querySelector('#manufacturer').hidden, false);
  assert.equal(field.value, 'Cy', 'the text typed earlier is kept');
});

test('disabled values are listed with their note, and without an empty option Other… is the default', () => {
  const container = choiceContainer();
  const field = new ChoiceField(container, { id: 'variation-name', name: 'variation_name', title: 'Variation',
    placeholder: 'Standard', newLabel: 'New variation',
    options: [{ value: 'Standard', disabled: true, note: 'already added' }, { value: 'Single <Leg>', disabled: true, note: 'already added' }] });
  const select = container.querySelector('#variation-name-choice');
  assert.deepEqual(select.options.map((option) => [option.text, option.disabled]),
    [['Standard (already added)', true], ['Single <Leg> (already added)', true], ['Other…', false]]);
  assert.match(container.innerHTML, /Single &lt;Leg&gt;/);
  assert.equal(select.value, OTHER);
  assert.equal(container.querySelector('#variation-name').hidden, false);

  field.setOptions(['Standard', { value: 'Incline', disabled: true, note: 'already added' }]);
  assert.equal(container.querySelector('#variation-name-choice').value, 'Standard', 'the first free value is the default');
  field.setOptions([]);
  type(container, 'variation-name', 'Heavy');
  field.setOptions(['Standard']);
  assert.equal(container.querySelector('#variation-name-choice').value, OTHER, 'text typed before values were known is kept');
  assert.equal(field.value, 'Heavy');
  choose(container, 'variation-name-choice', 'Standard');
  assert.equal(container.querySelector('#variation-name-choice').value, 'Standard');
  assert.equal(field.value, 'Standard');
});

test('Enter in the text input runs onEnter instead of submitting, and clear() starts over', () => {
  const container = choiceContainer();
  let entered = 0;
  const field = new ChoiceField(container, { id: 'equipment-entry', title: 'Equipment options', empty: 'Choose equipment',
    newLabel: 'New equipment option', options: ['Machine'], onEnter: () => { entered += 1; } });
  choose(container, 'equipment-entry-choice', OTHER);
  type(container, 'equipment-entry', 'Sled');
  const input = container.querySelector('#equipment-entry');
  let prevented = false;
  input.events.keydown({ key: 'a', preventDefault() { prevented = true; } });
  assert.deepEqual([entered, prevented], [0, false]);
  input.events.keydown({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.deepEqual([entered, prevented], [1, true]);
  assert.doesNotMatch(container.innerHTML, / name=/, 'a field without a name is not submitted with the form');

  field.clear();
  assert.equal(field.value, '');
  assert.equal(container.querySelector('#equipment-entry-choice').value, OTHER, 'typing stays open for the next value');
  field.setOptions(['Machine']);
  choose(container, 'equipment-entry-choice', 'Machine');
  field.clear();
  assert.equal(container.querySelector('#equipment-entry-choice').value, '');
  assert.equal(field.value, '');
});
