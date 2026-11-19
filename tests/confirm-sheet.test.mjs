import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askTextInPage, chooseInPage, confirmInPage } from '../static/confirm-sheet.mjs';

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

test('leaving the text sheet while the name is being saved still answers with what was saved', async () => {
  // On a slow connection Escape or a backdrop tap can close the sheet after Save was tapped;
  // the server still saves, so the caller must learn about it rather than hear "cancelled".
  const { document, all, sheet } = page();
  let finish;
  const answer = askTextInPage(document, 'New routine', { label: 'Routine name', confirmLabel: 'Create routine',
    submit: () => new Promise((resolve) => { finish = resolve; }) });
  const dialog = sheet();
  all(dialog).find((item) => item.tagName === 'INPUT').value = 'Legs';
  all(dialog).find((item) => item.tagName === 'FORM').dispatch('submit');
  await settle();
  dialog.close(); // Escape while the request is in flight
  finish({ id: 7, name: 'Legs' });
  assert.deepEqual(await answer, { id: 7, name: 'Legs' });

  // A save that fails after the sheet was left answers nothing.
  const failed = askTextInPage(document, 'New routine', { label: 'Routine name', confirmLabel: 'Create routine',
    submit: () => new Promise((_, reject) => { finish = reject; }) });
  const second = sheet();
  all(second).find((item) => item.tagName === 'INPUT').value = 'Legs';
  all(second).find((item) => item.tagName === 'FORM').dispatch('submit');
  await settle();
  second.dispatch('click'); // backdrop tap
  finish(new Error('offline'));
  assert.equal(await failed, null);
});

test('the choice sheet shows the selected value pressed and answers with the tapped one, or nothing when left', async () => {
  const { document, sheet, button, opener } = page();
  const choices = [{ value: 'failure', label: 'Failure', wide: true }, { value: '2', label: '2', name: '2 reps left' }];
  let answer = chooseInPage(document, 'Effort for Bench Press, set 1', { choices, selected: '2' });
  assert.equal(button('2').attributes['aria-pressed'], 'true');
  assert.equal(button('2').attributes['aria-label'], '2 reps left');
  assert.equal(button('Failure').attributes['aria-pressed'], 'false');
  assert.equal(document.activeElement, button('2'), 'focus starts on the selected value');
  button('2').click();
  assert.equal(await answer, '2', 'the selected value answers too, so the caller can clear it');
  assert.equal(document.activeElement, opener);

  answer = chooseInPage(document, 'Effort', { choices });
  button('Cancel').click();
  assert.equal(await answer, undefined);
  answer = chooseInPage(document, 'Effort', { choices });
  sheet().dispatch('click');
  assert.equal(await answer, undefined);
  assert.equal(sheet(), undefined);
});

test('a refused name can offer a destructive alternative that asks first, saves once, and is withdrawn when the text changes', async () => {
  const { document, all, sheet, button } = page();
  const submitted = [];
  const ran = [];
  let confirms = [];
  let finishRun;
  const taken = Object.assign(new Error('Home already has a routine named Back & Biceps.'), { existing: 'Back & Biceps' });
  const answer = askTextInPage(document, 'Save this workout as a routine', {
    label: 'Routine name', value: 'back & biceps', confirmLabel: 'Save routine',
    submit: async (text) => { submitted.push(text); throw text.toLowerCase() === 'back & biceps' ? taken : new Error('Offline.'); },
    errorAction: (error) => error.existing ? {
      label: 'Replace routine', busyLabel: 'Replacing…',
      confirm: () => new Promise((resolve) => confirms.push(resolve)),
      run: (text) => { ran.push(text); return new Promise((resolve) => { finishRun = resolve; }); },
    } : null,
  });
  const dialog = sheet();
  const input = all(dialog).find((item) => item.tagName === 'INPUT');
  const form = all(dialog).find((item) => item.tagName === 'FORM');
  const status = all(dialog).find((item) => item.attributes.role === 'status');
  const replace = all(dialog).find((item) => item.className.includes('text-sheet-alternative'));
  assert.equal(replace.hidden, true, 'nothing to replace before a name is refused');

  form.dispatch('submit');
  await settle();
  assert.equal(status.textContent, 'Home already has a routine named Back & Biceps.', 'the message stays');
  assert.equal(replace.hidden, false);
  assert.equal(replace.textContent, 'Replace routine');
  assert.match(replace.className, /\bdanger\b/);

  // Declining the confirmation saves nothing and keeps the offer.
  replace.click();
  replace.click();
  await settle();
  assert.equal(confirms.length, 1, 'a second tap while asking does nothing');
  assert.equal(button('Save routine').disabled, true);
  confirms[0](false);
  await settle();
  assert.deepEqual(ran, []);
  assert.equal(replace.disabled, false);
  assert.equal(button('Save routine').disabled, false);

  // Editing the name withdraws the offer; typing it back differently cased does not need it.
  input.value = 'Back & Biceps 2';
  input.dispatch('input');
  assert.equal(replace.hidden, true);
  assert.equal(status.textContent, '');
  input.value = 'BACK & BICEPS';
  form.dispatch('submit');
  await settle();
  assert.equal(replace.hidden, false);
  input.value = ' back  &  biceps ';
  input.dispatch('input');
  assert.equal(replace.hidden, false, 'the same name with other spacing or case keeps the offer');

  // Confirmed: one run, a busy label, and Enter or more taps do nothing while it saves.
  replace.click();
  await settle();
  confirms[1](true);
  await settle();
  assert.equal(replace.textContent, 'Replacing…');
  assert.equal(replace.attributes['aria-busy'], 'true');
  replace.click();
  form.dispatch('submit');
  await settle();
  assert.deepEqual(ran, ['BACK & BICEPS']);
  assert.equal(confirms.length, 2);
  assert.deepEqual(submitted, ['back & biceps', 'BACK & BICEPS']);
  finishRun({ id: 7, name: 'Back & Biceps', replaced: true });
  assert.deepEqual(await answer, { id: 7, name: 'Back & Biceps', replaced: true });
  assert.equal(sheet(), undefined);
});

test('a failed replace shows its error and offers to try again', async () => {
  const { document, all, sheet } = page();
  let runs = 0;
  const answer = askTextInPage(document, 'Save', {
    label: 'Routine name', value: 'Legs', confirmLabel: 'Save routine',
    submit: async () => { throw Object.assign(new Error('Taken.'), { taken: true }); },
    errorAction: (error) => error.taken ? { label: 'Replace routine', confirm: async () => true,
      run: async () => { runs++; if (runs === 1) throw new Error('Cannot reach the server.'); return { id: 1 }; } } : null,
  });
  const dialog = sheet();
  const form = all(dialog).find((item) => item.tagName === 'FORM');
  const status = all(dialog).find((item) => item.attributes.role === 'status');
  const replace = all(dialog).find((item) => item.className.includes('text-sheet-alternative'));
  form.dispatch('submit');
  await settle();
  replace.click();
  await settle();
  assert.equal(status.textContent, 'Cannot reach the server.');
  assert.equal(replace.hidden, false, 'a failed replace can be tried again');
  assert.equal(replace.textContent, 'Replace routine');
  assert.equal(replace.disabled, false);
  replace.click();
  await settle();
  assert.deepEqual(await answer, { id: 1 });
  assert.equal(runs, 2);
});
