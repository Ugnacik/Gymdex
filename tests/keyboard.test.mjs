import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followVisualViewport } from '../static/keyboard.mjs';

function page() {
  const listeners = {};
  const on = (target) => (event, callback) => { (listeners[`${target}:${event}`] ??= []).push(callback); };
  const fire = (target, event, detail) => (listeners[`${target}:${event}`] ?? []).forEach((callback) => callback(detail));
  const style = {};
  const frames = [];
  const viewport = { offsetTop: 0, height: 780, addEventListener: on('viewport') };
  const window = { visualViewport: viewport, requestAnimationFrame: (callback) => frames.push(callback) };
  const document = {
    activeElement: null,
    documentElement: { clientHeight: 780, style: { setProperty: (name, value) => { style[name] = value; } } },
    addEventListener: on('document'),
  };
  const field = (inSheet, tagName = 'INPUT') => ({ tagName, scrolled: [],
    closest: (selector) => (inSheet && selector === '.sheet, dialog' ? {} : null),
    scrollIntoView(options) { this.scrolled.push(options); } });
  const runFrames = () => frames.splice(0).forEach((callback) => callback());
  return { window, document, viewport, style, fire, field, runFrames };
}

test('sheets and dialogs follow the visible area when the keyboard opens and closes', () => {
  const { window, document, viewport, style, fire } = page();
  followVisualViewport({ window, document });
  assert.deepEqual(style, { '--viewport-top': '0px', '--viewport-bottom': '0px', '--viewport-height': '780px' });
  Object.assign(viewport, { offsetTop: 40, height: 400 });
  fire('viewport', 'resize');
  assert.deepEqual(style, { '--viewport-top': '40px', '--viewport-bottom': '340px', '--viewport-height': '400px' });
  Object.assign(viewport, { offsetTop: 0, height: 780 });
  fire('viewport', 'scroll');
  assert.deepEqual(style, { '--viewport-top': '0px', '--viewport-bottom': '0px', '--viewport-height': '780px' });
});

test('the focused field in a sheet or dialog is scrolled to the middle once the keyboard has resized the view', () => {
  const { window, document, viewport, fire, field, runFrames } = page();
  followVisualViewport({ window, document });
  const equipment = field(true);
  document.activeElement = equipment;
  fire('document', 'focusin', { target: equipment });
  runFrames();
  assert.deepEqual(equipment.scrolled, [{ block: 'center' }]);
  viewport.height = 400;
  fire('viewport', 'resize');
  runFrames();
  assert.deepEqual(equipment.scrolled, [{ block: 'center' }, { block: 'center' }]);

  const setInput = field(false);
  document.activeElement = setInput;
  fire('document', 'focusin', { target: setInput });
  fire('viewport', 'resize');
  runFrames();
  assert.deepEqual(setInput.scrolled, [], 'the page itself scrolls fine, so fields outside sheets are left alone');
  const button = field(true, 'BUTTON');
  document.activeElement = button;
  fire('document', 'focusin', { target: button });
  runFrames();
  assert.deepEqual(button.scrolled, [], 'buttons do not open the keyboard');
});

test('without visualViewport nothing is changed', () => {
  const { window, document, style } = page();
  delete window.visualViewport;
  followVisualViewport({ window, document });
  assert.deepEqual(style, {});
});
