import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askTextInPage, confirmInPage } from '../static/confirm-sheet.mjs';

// A minimal DOM: elements keep their children, listeners and focus, and a dialog
// fires close like a browser's when it is closed with or without a return value.
function page() {
  const document = { activeElement: null, body: null };
  const element = (tagName) => {
    const listeners = {};
    return {
      tagName: tagName.toUpperCase(), children: [], attributes: {}, className: '', textContent: '', isConnected: false,
      append(...nodes) { for (const item of nodes) { item.parentNode = this; item.isConnected = this.isConnected; this.children.push(item); } },
      remove() { this.parentNode.children = this.parentNode.children.filter((item) => item !== this); this.isConnected = false; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(event, callback) { (listeners[event] ??= []).push(callback); },
      dispatch(event, target = this) { (listeners[event] ?? []).forEach((callback) => callback({ target, preventDefault() {} })); },
      click() { this.dispatch('click'); },
      focus() { document.activeElement = this; },
      showModal() { this.open = true; this.returnValue = ''; },
      close(value) {
        if (!this.open) return;
        this.open = false;
        if (value !== undefined) this.returnValue = value;
        this.dispatch('close');
      },
    };
  };
  document.createElement = element;
  document.body = Object.assign(element('body'), { isConnected: true });
  const all = (node) => node.children.flatMap((child) => [child, ...all(child)]);
  const sheet = () => document.body.children.find((item) => item.tagName === 'DIALOG');
  const button = (label) => all(sheet()).find((item) => item.tagName === 'BUTTON' && item.textContent === label);
  const opener = Object.assign(element('button'), { isConnected: true });
  opener.focus();
  return { document, all, sheet, button, opener };
}

test('the sheet asks the question on top of the page and answers yes from its action button', async () => {
  const { document, all, sheet, button, opener } = page();
  const answer = confirmInPage(document, 'Finish this workout?', { confirmLabel: 'Finish', cancelLabel: 'Back' });
  const dialog = sheet();
  assert.equal(dialog.open, true, 'opened as a modal so it stacks above open dialogs and an inert page');
  assert.match(dialog.className, /\bconfirm-sheet\b/);
  const question = all(dialog).find((item) => item.textContent === 'Finish this workout?');
  assert.equal(dialog.attributes['aria-labelledby'], question.id);
  assert.deepEqual(all(dialog).filter((item) => item.tagName === 'BUTTON').map((item) => item.textContent), ['Back', 'Finish']);
  assert.equal(document.activeElement, button('Back'), 'focus starts on the safe answer');
  assert.doesNotMatch(button('Finish').className, /danger/);
  button('Finish').click();
  assert.equal(await answer, true);
  assert.equal(sheet(), undefined);
  assert.equal(document.activeElement, opener, 'focus returns to where it was');
});

test('the safe button, Escape and a backdrop tap all answer no', async () => {
  const { document, sheet, button, all } = page();
  const ask = () => confirmInPage(document, 'Remove set 2?', { confirmLabel: 'Remove', danger: true });
  let answer = ask();
  assert.match(button('Remove').className, /\bdanger\b/, 'destructive actions use the danger colour');
  button('Keep').click();
  assert.equal(await answer, false);

  answer = ask();
  sheet().close(); // Escape closes a modal dialog without a return value.
  assert.equal(await answer, false);

  answer = ask();
  const dialog = sheet();
  dialog.dispatch('click', all(dialog)[0]);
  assert.equal(dialog.open, true, 'a tap inside the sheet is not a backdrop tap');
  dialog.dispatch('click');
  assert.equal(await answer, false);
  assert.equal(sheet(), undefined);
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the text sheet asks for a name in the page and answers with what the action accepted', async () => {
  const { document, all, sheet, button, opener } = page();
  const submitted = [];
  const answer = askTextInPage(document, 'Save this workout as a routine', {
    label: 'Routine name', value: 'Home 21 Sep', confirmLabel: 'Save routine',
    submit: async (text) => { submitted.push(text); if (submitted.length === 1) throw new Error('Home already has a routine named Legs.'); return { id: 4, name: text }; },
  });
  const dialog = sheet();
  assert.equal(dialog.open, true);
  assert.match(dialog.className, /\bconfirm-sheet\b/);
  const input = all(dialog).find((item) => item.tagName === 'INPUT');
  assert.equal(input.value, 'Home 21 Sep');
  assert.equal(input.maxLength, 80);
  assert.equal(document.activeElement, input, 'focus starts in the field');
  assert.ok(all(dialog).some((item) => item.tagName === 'LABEL' && item.textContent === 'Routine name'));
  assert.deepEqual(all(dialog).filter((item) => item.tagName === 'BUTTON').map((item) => item.textContent), ['Cancel', 'Save routine']);
  const form = all(dialog).find((item) => item.tagName === 'FORM');
  const status = all(dialog).find((item) => item.attributes.role === 'status');

  input.value = '   ';
  form.dispatch('submit');
  await settle();
  assert.equal(status.textContent, 'Routine name is required.');
  assert.deepEqual(submitted, []);

  input.value = '  Legs  ';
  form.dispatch('submit');
  await settle();
  assert.equal(dialog.open, true, 'a refused name keeps the sheet open');
  assert.equal(status.textContent, 'Home already has a routine named Legs.');
  assert.equal(button('Save routine').disabled, false);

  input.value = 'Leg day';
  form.dispatch('submit');
  assert.deepEqual(await answer, { id: 4, name: 'Leg day' });
  assert.deepEqual(submitted, ['Legs', 'Leg day']);
  assert.equal(sheet(), undefined);
  assert.equal(document.activeElement, opener);
});

test('Cancel, Escape and a backdrop tap leave the text sheet without an answer', async () => {
  const { document, sheet, button } = page();
  const ask = () => askTextInPage(document, 'Rename routine', { label: 'Routine name', confirmLabel: 'Save name', submit: async () => { throw new Error('not called'); } });
  let answer = ask();
  button('Cancel').click();
  assert.equal(await answer, null);
  answer = ask();
  sheet().close();
  assert.equal(await answer, null);
  answer = ask();
  sheet().dispatch('click');
  assert.equal(await answer, null);
});
