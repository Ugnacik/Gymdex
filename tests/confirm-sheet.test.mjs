import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmInPage } from '../static/confirm-sheet.mjs';

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
      dispatch(event, target = this) { (listeners[event] ?? []).forEach((callback) => callback({ target })); },
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
