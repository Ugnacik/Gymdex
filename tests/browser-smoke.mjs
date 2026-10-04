// Optional browser regression test. See README for the Playwright setup command.
// Owns a temporary DB, an OS-assigned loopback port, and a separate headless browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.GYMDEX_PLAYWRIGHT_PATH || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = process.env.GYMDEX_BROWSER_ARTIFACTS || await mkdtemp(join(tmpdir(), 'gymdex-browser-'));
await mkdir(artifacts, { recursive: true });
const server = spawn('python3', ['-u', '-c',
  "import os; from pathlib import Path; from gymdex.server import GymdexServer; s=GymdexServer(('127.0.0.1',0),Path(os.environ['GYMDEX_DB_PATH'])); print('READY:'+str(s.server_port),flush=True); s.serve_forever()"], {
  cwd: root, env: { ...process.env, GYMDEX_DB_PATH: join(artifacts, 'test.sqlite3') }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '', browser, page;
server.stderr.on('data', data => { log += data; });
server.stdout.on('data', data => { log += data; });
const checks = [];
try {
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test server did not start')), 10000);
    server.on('error', reject);
    server.on('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}\n${log}`)); });
    server.stdout.on('data', () => {
      const match = log.match(/READY:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true,
    hasTouch: true, locale: 'en-GB', timezoneId: 'Europe/Bratislava' });
  page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const base = `http://127.0.0.1:${port}`;
  const read = async path => (await context.request.get(base + path)).json();
  const screenshot = name => page.screenshot({ path: join(artifacts, name + '.png') });
  const check = (name, value) => { assert.ok(value, name); checks.push(name); };
  async function verifyCreateAccessible(surface) {
    // Measure only after the sheet's entrance slide, or results and Create are read on different frames.
    await page.locator('#picker .sheet').evaluate(sheet => Promise.all(sheet.getAnimations().map(animation => animation.finished)));
    const search = page.locator('#exercise-search');
    await search.fill('');
    await page.locator('#muscle-group-filter').selectOption('');
    const create = page.locator('#create-exercise');
    const createControl = await create.elementHandle();
    for (const [width, height, overlayKeyboard] of [[390, 844, false], [320, 844, false], [390, 500, false], [390, 844, true]]) {
      await page.setViewportSize({ width, height });
      if (overlayKeyboard) {
        await page.locator('#muscle-group-filter').selectOption('Back');
        // Simulate an overlay keyboard through the same VisualViewport resize event as keyboard.mjs.
        await page.evaluate(() => {
          Object.defineProperties(window.visualViewport, { height: { configurable: true, value: 500 }, offsetTop: { configurable: true, value: 0 } });
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
      }
      const visibleHeight = overlayKeyboard ? 500 : height;
      await page.waitForFunction(visible => {
        const box = document.querySelector('#create-exercise').getBoundingClientRect();
        return box.top >= 0 && box.bottom <= visible;
      }, visibleHeight);
      const resultBox = await page.locator('#picker-results').boundingBox();
      const createBox = await create.boundingBox();
      check(`${surface}: Create remains reachable at ${width}x${height}${overlayKeyboard ? ' with simulated overlay keyboard' : ''}`,
        createBox.height >= 44 && createBox.x >= 0 && createBox.x + createBox.width <= width
        && createBox.y + createBox.height <= visibleHeight && resultBox.y + resultBox.height <= createBox.y);
      await page.locator('#picker-results').evaluate(results => { results.scrollTop = results.scrollHeight; });
      const last = await page.locator('#picker-results [data-variation-id]').last().boundingBox();
      check(`${surface}: last Exercise scrolls fully above Create at ${width}x${height}${overlayKeyboard ? ' overlay' : ''}`,
        last.y >= resultBox.y - 1 && last.y + last.height <= resultBox.y + resultBox.height + 1);
      if (overlayKeyboard) {
        await screenshot('create-footer-' + surface.toLowerCase() + '-simulated-keyboard');
        await page.evaluate(() => {
          delete window.visualViewport.height; delete window.visualViewport.offsetTop;
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#muscle-group-filter').selectOption('Back');
    await search.fill('New filtered exercise');
    check(`${surface}: Create stays the same control when filters give no matches`, await createControl.evaluate(button =>
      button === document.querySelector('#create-exercise') && !button.closest('#picker-results')));
    await create.click();
    check(`${surface}: Create prefills the current search and restores ordinary form scrolling`,
      await page.locator('#custom-exercise-form input[name=name]').inputValue() === 'New filtered exercise'
      && await page.locator('#picker .sheet').evaluate(sheet => !sheet.classList.contains('picker-catalog') && getComputedStyle(sheet).overflowY === 'auto'));
    await page.locator('#back-to-picker').click();
    check(`${surface}: creation Back preserves query and filter`, await search.inputValue() === 'New filtered exercise'
      && await page.locator('#muscle-group-filter').inputValue() === 'Back');
    await page.locator('#clear-muscle-group-filter').click();
    check(`${surface}: stable Create footer keeps Clear query semantics`, await search.inputValue() === 'New filtered exercise');
    await search.fill('Bench');
    await page.locator('#picker-results [data-variation-id]').first().click();
    check(`${surface}: ordinary Exercise still opens Configuration in one tap with form scrolling`, await page.locator('#configuration-form').isVisible()
      && await page.locator('#picker .sheet').evaluate(sheet => !sheet.classList.contains('picker-catalog') && getComputedStyle(sheet).overflowY === 'auto'));
    await page.locator('#back-to-picker').click();
    await search.fill('');
  }
  async function verifyMuscleGroupPicker(surface) {
    const search = page.locator('#exercise-search');
    await page.locator('#muscle-group-filter').selectOption('Back');
    await search.fill('bAcK');
    const searchControl = await search.elementHandle();
    await search.evaluate(input => { input.setSelectionRange(2, 2); input.dispatchEvent(new Event('input', { bubbles: true })); });
    check(`${surface}: typing keeps search input, focus and caret`, await searchControl.evaluate(input =>
      input === document.querySelector('#exercise-search') && input === document.activeElement && input.selectionStart === 2));
    check(`${surface}: Back search includes muscle targets`, await page.locator('[data-variation-id]', { hasText: 'Row' }).count() > 0
      && await page.locator('[data-variation-id]', { hasText: 'Pull-up' }).count() > 0);
    check(`${surface}: Back dropdown excludes Back Squat`, await page.locator('[data-variation-id]', { hasText: 'Back Squat' }).count() === 0);
    await search.fill('Bench');
    check(`${surface}: search and Muscle Group intersect`, await page.getByRole('heading', { name: 'No matches', exact: true }).isVisible());
    check(`${surface}: custom creation remains available with no matches`, await page.locator('#create-exercise').isVisible());
    await page.locator('#clear-muscle-group-filter').click();
    check(`${surface}: Clear retains text and restores matches`, await search.inputValue() === 'Bench'
      && await page.locator('[data-variation-id]', { hasText: 'Bench Press' }).count() > 0);
    await search.fill('');
    await page.locator('#muscle-group-filter').selectOption('Back');
    check(`${surface}: picker has no phone overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await screenshot('muscle-filter-' + surface.toLowerCase());
    await page.locator('#clear-muscle-group-filter').click();
  }

  const holdName = async locator => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.locator('#exercise-reorder').waitFor();
    await page.mouse.up();
  };
  const dragPreview = async (from, to) => {
    const handle = await page.locator('#reorder-list .reorder-handle').nth(from).boundingBox();
    const target = await page.locator('#reorder-list .reorder-row').nth(to).boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, to < from ? target.y + 2 : target.y + target.height - 2, { steps: 5 });
  };
  await page.goto(base);
  await page.locator('#open-settings').click();
  assert.equal(await page.locator('#settings-rest-duration').inputValue(), '120');
  const settingsBounds = await page.locator('#settings').boundingBox();
  check('Settings fills the phone viewport', settingsBounds.x === 0 && settingsBounds.y === 0
    && settingsBounds.width === 390 && settingsBounds.height === 844);
  await screenshot('settings-mobile');
  await page.locator('#settings-rest-duration').selectOption('90');
  await page.locator('#close-settings').click();
  await page.reload();
  await page.locator('#open-settings').click();
  check('Saved 90 second preference survives reload', await page.locator('#settings-rest-duration').inputValue() === '90');
  await page.locator('#close-settings').click();
  await page.locator('#gym-name').fill('Browser Test Gym');
  await page.locator('#add-gym-form button').click();
  await page.locator('#open-routines').click();
  await page.locator('[data-new-routine]').click();
  await page.getByRole('textbox', { name: 'Routine name' }).fill('First plan');
  await page.getByRole('button', { name: 'Create routine', exact: true }).click();
  await page.locator('[data-add-routine-exercise]').click();
  await verifyCreateAccessible('Routine');
  await verifyMuscleGroupPicker('Routine');
  await page.locator('#exercise-search').fill('Bench');
  await page.getByRole('button', { name: 'Bench Press Barbell · Dumbbell · Machine', exact: true }).click();
  await page.getByRole('button', { name: 'Dumbbell', exact: true }).click();
  await page.locator('#manufacturer').fill('Acme');
  await page.locator('#machine-label').fill('Rack 1');
  await page.getByRole('button', { name: 'Add to routine', exact: true }).click();
  await page.locator('[data-set-count]').waitFor();
  await page.locator('[data-set-count]').selectOption('2');
  await page.waitForFunction(() => document.querySelector('[data-set-count]')?.value === '2');
  check('Routine built without a workout', (await read('/api/history')).workouts.length === 0
    && (await read('/api/bootstrap')).active_workout === null);
  await page.locator('[data-add-routine-exercise]').click();
  await page.locator('#exercise-search').fill('bench');
  check('Routine search lists saved configurations beside the catalog',
    await page.locator('#picker-results h3', { hasText: 'Saved at Browser Test Gym' }).isVisible()
    && await page.locator('#picker-results [data-profile-id]', { hasText: 'Acme · Rack 1' }).isVisible()
    && await page.locator('#picker-results [data-variation-id]', { hasText: 'Bench Press' }).first().isVisible());
  await page.locator('#muscle-group-filter').selectOption('Chest');
  await page.locator('#exercise-search').fill('Acme');
  check('Routine: muscle filter matches saved configuration machine details', await page.locator('[data-profile-id]', { hasText: 'Acme · Rack 1' }).isVisible()
    && await page.locator('[data-variation-id]').count() === 0);
  await page.locator('#muscle-group-filter').selectOption('Back');
  check('Routine: saved configurations obey Muscle Group intersection', await page.locator('[data-profile-id]').count() === 0);
  await page.locator('#clear-muscle-group-filter').click();
  check('Routine: Clear retains machine search', await page.locator('#exercise-search').inputValue() === 'Acme'
    && await page.locator('[data-profile-id]', { hasText: 'Acme · Rack 1' }).isVisible());
  await page.locator('#exercise-search').fill('Long Custom Duration Exercise For Browser Testing');
  await page.locator('#create-exercise').click();
  await page.getByRole('radio', { name: 'Duration in seconds' }).check();
  await page.locator('#equipment-choice select').selectOption({ label: 'Machine' });
  await page.locator('#add-equipment').click();
  await page.locator('.custom-muscle-groups summary').click();
  await page.locator('#custom-exercise-form').getByLabel('Back', { exact: true }).check();
  await page.locator('#custom-exercise-form').getByLabel('Abs', { exact: true }).check();
  await page.locator('#custom-exercise-form button[type=submit]').click();
  await page.getByRole('button', { name: 'Add to routine', exact: true }).click();
  await page.locator('.routine-exercise').nth(1).waitFor();
  await screenshot('routine-from-catalog');
  check('Custom exercise can be created in a routine', (await read('/api/routines?gym_id=1')).routines[0].exercises.length === 2);
  const customVariation = (await read('/api/catalog?gym_id=1')).catalog.find(item => item.exercise_name === 'Long Custom Duration Exercise For Browser Testing');
  check('Custom Duration Variation keeps optional multiple Muscle Groups', JSON.stringify(customVariation.muscle_groups) === JSON.stringify(['Back', 'Abs']));

  const routineBeforeOrder = (await read('/api/routines?gym_id=1')).routines[0].exercises;
  await holdName(page.locator('.routine-exercise h3').first());
  await dragPreview(0, 1);
  await page.locator('#reorder-list').dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  check('Cancelled Routine drag restores the saved list', await page.locator('#reorder-list .reorder-name strong').first().innerText() === 'Bench Press'
    && (await read('/api/routines?gym_id=1')).routines[0].exercises[0].profile_id === routineBeforeOrder[0].profile_id);
  await dragPreview(0, 1);
  await page.mouse.up();
  await page.locator('#reorder-status').filter({ hasText: 'moved to position 2' }).waitFor();
  const reorderedRoutine = (await read('/api/routines?gym_id=1')).routines[0].exercises;
  check('Routine drag saves the order with its original Set counts', reorderedRoutine[0].profile_id === routineBeforeOrder[1].profile_id
    && reorderedRoutine[0].set_count === routineBeforeOrder[1].set_count && reorderedRoutine[1].set_count === routineBeforeOrder[0].set_count);
  await page.locator('#reorder-list').getByRole('button', { name: 'Move Bench Press up', exact: true }).click();
  await page.locator('#reorder-status').filter({ hasText: 'Bench Press moved to position 1' }).waitFor();
  await screenshot('routine-reorder-mobile');
  await page.locator('#close-reorder').click();
  const longRoutineResponse = await context.request.post(base + '/api/routines', { data: { gym_id: 1, name: 'Long order test',
    exercises: Array.from({ length: 15 }, (_, index) => ({ profile_id: routineBeforeOrder[0].profile_id, set_count: index + 1 })) } });
  assert.equal(longRoutineResponse.status(), 201);
  const longRoutine = await longRoutineResponse.json();
  await page.locator('#close-routines').click();
  await page.locator('#open-routines').click();
  await page.locator(`[data-open-routine="${longRoutine.id}"]`).click();
  await page.locator('[data-reorder-routine]').click();
  const listBounds = await page.locator('#reorder-list').boundingBox();
  const firstHandle = await page.locator('#reorder-list .reorder-handle').first().boundingBox();
  await page.mouse.move(firstHandle.x + 22, firstHandle.y + 22);
  await page.mouse.down();
  for (let step = 0; step < 65; step++) {
    await page.mouse.move(firstHandle.x + 22, listBounds.y + listBounds.height - 5 - (step % 2));
  }
  check('Held handle reaches destinations below the visible list', await page.locator('#reorder-list').evaluate(list => list.scrollTop > 300));
  await page.mouse.up();
  await page.locator('#reorder-status').filter({ hasText: 'Bench Press moved to position 15' }).waitFor();
  const savedLongRoutine = (await read('/api/routines?gym_id=1')).routines.find(routine => routine.id === longRoutine.id);
  check('Long-list drag moves the right repeated Configuration occurrence', savedLongRoutine.exercises.at(-1).set_count === 1
    && savedLongRoutine.exercises[0].set_count === 2);
  const stoppedScroll = await page.locator('#reorder-list').evaluate(list => list.scrollTop);
  await page.mouse.move(firstHandle.x + 22, listBounds.y + listBounds.height - 5);
  check('Edge scrolling stops after dropping', await page.locator('#reorder-list').evaluate(list => list.scrollTop) === stoppedScroll);
  await screenshot('long-routine-reorder-mobile');
  await page.locator('#close-reorder').click();
  await context.request.delete(base + `/api/routines/${longRoutine.id}`);
  await page.locator('#close-routines').click();
  await page.locator('[data-start-routine="1"]').click();
  await page.locator('.set-form').first().waitFor();
  check('Routine starts with correct empty slots', await page.locator('.set-form').count() === 5
    && await page.locator('.set-form input[name=weight], .set-form input[name=result]').evaluateAll(inputs => inputs.every(input => input.value === '')));
  await page.locator('#open-picker').click();
  await verifyCreateAccessible('Active');
  await verifyMuscleGroupPicker('Active');
  await page.locator('#muscle-group-filter').selectOption('Abs');
  check('Active: a Variation matches either of its Muscle Groups', await page.locator('[data-variation-id]', { hasText: 'Long Custom Duration' }).count() === 1);
  await page.locator('#close-picker').click();
  await page.locator('#open-picker').click();
  check('Active: new picker resets Muscle Group and query', await page.locator('#muscle-group-filter').inputValue() === ''
    && await page.locator('#exercise-search').inputValue() === '');
  await page.locator('#close-picker').click();
  const machineEdit = page.getByRole('button', { name: 'Edit manufacturer / machine for Bench Press', exact: true });
  check('Manufacturer editing is visible without Exercise options', await machineEdit.isVisible()
    && !await page.locator('.exercise-options').first().getAttribute('open'));
  const editBounds = await machineEdit.boundingBox();
  check('Manufacturer edit has a touch target at least 44px high', editBounds.height >= 44);
  await machineEdit.click();
  check('Manufacturer editing opens the clearly named sheet', await page.locator('#picker-title').innerText() === 'Edit manufacturer / machine'
    && await page.getByText('Manufacturer', { exact: false }).count() > 0);
  await page.locator('#close-picker').click();
  await page.locator('#rest-enabled').check();
  await page.evaluate(() => scrollTo(0, 0));
  await screenshot('compact-workout-mobile');
  check('First set visible with timer enabled', (await page.locator('.set-form').first().boundingBox()).y < 750);
  const draftSet = page.locator('.set-form').first();
  await draftSet.locator('[name=weight]').fill('43.5');
  await draftSet.locator('[name=result]').fill('7');
  await page.locator('[data-note-summary="workout"]').click();
  await page.locator('[data-note-target="workout"]').fill('Workout draft through Settings');
  await page.locator('#rest-start').click();
  await page.locator('#rest-pause').click();
  const pausedClock = await page.locator('#rest-clock').innerText();
  await page.locator('#open-settings').click();
  await page.locator('#settings-rest-duration').selectOption('120');
  await page.locator('#close-settings').click();
  check('Settings retains draft Sets and Notes', await draftSet.locator('[name=weight]').inputValue() === '43.5'
    && await draftSet.locator('[name=result]').inputValue() === '7'
    && await page.locator('[data-note-target="workout"]').inputValue() === 'Workout draft through Settings');
  check('Settings retains paused countdown while updating next rest', await page.locator('#rest-clock').innerText() === pausedClock
    && await page.locator('#rest-status').innerText() === 'Paused'
    && await page.locator('#rest-duration').inputValue() === '120');
  await draftSet.locator('[name=weight]').fill('');
  await draftSet.locator('[name=result]').fill('');
  await page.locator('[data-note-target="workout"]').fill('');
  await page.locator('[data-note-summary="workout"]').click();

  assert.equal(await page.locator('#rest-status').innerText(), 'Paused');
  await page.locator('.rest-settings summary').click();
  await page.locator('#rest-duration').selectOption('60');
  await page.locator('#rest-stop').click();
  await page.locator('.rest-settings summary').click();
  await page.locator('#rest-enabled').uncheck();
  check('Disabling rest hides timer controls', !await page.locator('#rest-controls').isVisible());
  const set = page.locator('.set-form').first();
  await set.locator('[name=weight]').fill('42.5');
  await set.locator('[name=result]').fill('8');
  await set.locator('[name=completed]').check();
  await page.waitForFunction(() => document.querySelector('[data-exercise-count]')?.textContent === '1/2 done');
  await page.locator('.exercise-summary').first().click();
  check('Exercise can collapse', !await page.locator('.workout-exercise').first().evaluate(card => card.open));
  await page.locator('.exercise-summary').first().click();
  check('Collapsing retains set values', await set.locator('[name=weight]').inputValue() === '42.5');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.locator('.workout-exercise-card > .note summary').first().click();
  await page.locator('[data-note-target="exercise:1"]').fill('Seat setting 3. Keep shoulders down through the whole set.');
  await page.locator('[data-note-target="exercise:1"]').blur();
  await page.waitForFunction(() => document.querySelector('#sync-status')?.textContent.includes('All changes saved'));
  await page.locator('.workout-exercise-card > .note summary').first().click();
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    check(`Saved exercise note fits ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    const note = await page.locator('.workout-exercise-card > .note').first().boundingBox();
    const heading = await page.locator('.exercise-summary').first().boundingBox();
    check(`Exercise note is above heading at ${width}px`, note.y + note.height <= heading.y);
    const done = await set.locator('[name=completed]').boundingBox();
    check(`Done stays within ${width}px`, done.x >= 0 && done.x + done.width <= width);
  }
  await page.locator('.exercise-summary').first().click();
  check('Saved note stays visible when the exercise collapses', await page.locator('.workout-exercise-card > .note summary').first().isVisible());
  await page.locator('.exercise-summary').first().click();
  await screenshot('exercise-note-above-heading');
  const exerciseName = page.locator('.exercise-summary h3').first();
  await exerciseName.scrollIntoViewIfNeeded();
  let nameBox = await exerciseName.boundingBox();
  await page.mouse.move(nameBox.x + 20, nameBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(nameBox.x + 20, nameBox.y + 30);
  await page.waitForTimeout(500);
  await page.mouse.up();
  check('Moving on an exercise name cancels its hold', await page.locator('#exercise-reorder').count() === 0);
  await exerciseName.scrollIntoViewIfNeeded();
  nameBox = await exerciseName.boundingBox();
  await page.mouse.move(nameBox.x + 20, nameBox.y + 10);
  await page.mouse.down();
  await page.evaluate(() => scrollBy(0, 40));
  await page.waitForTimeout(500);
  await page.mouse.up();
  check('Scrolling cancels the name hold', await page.locator('#exercise-reorder').count() === 0);
  if (!await page.locator('.workout-exercise').first().evaluate(card => card.open)) await exerciseName.click();
  const workoutBeforeOrder = (await read('/api/bootstrap')).workout_exercises;
  await holdName(exerciseName);
  check('Reorder list fits the phone and uses touch-sized handles', await page.locator('#exercise-reorder').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)
    && (await page.locator('#reorder-list .reorder-handle').first().boundingBox()).width >= 44);
  // Touch input exercises the dedicated handle's pointer capture and touch-action.
  const touch = await context.newCDPSession(page);
  const touchHandle = await page.locator('#reorder-list .reorder-handle').first().boundingBox();
  const touchTarget = await page.locator('#reorder-list .reorder-row').nth(1).boundingBox();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchHandle.x + 22, y: touchHandle.y + 22 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchHandle.x + 22, y: touchTarget.y + touchTarget.height - 2 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await page.locator('#reorder-status').filter({ hasText: 'Bench Press moved to position 2' }).waitFor();
  const workoutAfterOrder = (await read('/api/bootstrap')).workout_exercises;
  check('Active Workout touch drag preserves recorded Sets and Notes', workoutAfterOrder[1].id === workoutBeforeOrder[0].id
    && JSON.stringify(workoutAfterOrder[1].sets) === JSON.stringify(workoutBeforeOrder[0].sets)
    && workoutAfterOrder[1].note === workoutBeforeOrder[0].note);
  await page.locator('#reorder-list').getByRole('button', { name: 'Move Bench Press up', exact: true }).click();
  await page.locator('#reorder-status').filter({ hasText: 'Bench Press moved to position 1' }).waitFor();
  await page.route('**/api/workout-exercises/1', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Test move rejected"}' }));
  await page.locator('#reorder-list').getByRole('button', { name: 'Move Bench Press down', exact: true }).click();
  await page.locator('#reorder-status').filter({ hasText: 'Order unchanged. Test move rejected' }).waitFor();
  check('Failed Active Workout reorder keeps the saved order visible', await page.locator('#reorder-list .reorder-name strong').first().innerText() === 'Bench Press'
    && (await read('/api/bootstrap')).workout_exercises[0].id === workoutBeforeOrder[0].id);
  await page.unroute('**/api/workout-exercises/1');
  await screenshot('workout-reorder-mobile');
  await page.locator('#close-reorder').click();
  check('Name hold leaves the Workout exercise expanded', await page.locator('.workout-exercise').first().evaluate(card => card.open));
  await page.locator('.exercise-options > summary').first().click();
  await page.locator('.exercise-options > summary').nth(1).click();
  await page.getByRole('button', { name: 'Move Long Custom Duration Exercise For Browser Testing up', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.exercise-summary h3')?.textContent.startsWith('Long Custom'));
  check('Reordering retains focus in visible exercise options', await page.evaluate(() => document.activeElement.matches('[data-move-exercise]') && document.activeElement.getClientRects().length > 0));
  await page.getByRole('button', { name: 'Move Long Custom Duration Exercise For Browser Testing down', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.exercise-summary h3')?.textContent === 'Bench Press');
  await page.getByRole('button', { name: 'Edit manufacturer / machine for Bench Press', exact: true }).click();
  await page.getByRole('button', { name: 'Machine', exact: true }).click();
  await page.locator('#configuration-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.exercise-body .meta')?.textContent.startsWith('Machine'));
  check('Machine change preserves sets and visible trigger focus', (await read('/api/bootstrap')).workout_exercises[0].sets[0].weight === 42.5
    && await page.evaluate(() => document.activeElement.matches('[data-change-machine]') && document.activeElement.getClientRects().length > 0));
  await page.locator('.workout-exercise-card > .note summary').first().click();
  await context.setOffline(true);
  await set.locator('[name=weight]').fill('45.5');
  await set.locator('[name=weight]').blur();
  await page.locator('[data-note-target="exercise:1"]').fill('Offline seat setting');
  await page.locator('[data-note-target="exercise:1"]').blur();
  await page.reload();
  await page.locator('.set-form').first().waitFor();
  check('Offline draft survives reload', await page.locator('.set-form').first().locator('[name=weight]').inputValue() === '45.5');
  check('Offline note draft is visible above the restored exercise', await page.locator('[data-note-target="exercise:1"]').isVisible()
    && await page.locator('[data-note-target="exercise:1"]').inputValue() === 'Offline seat setting');
  await context.setOffline(false);
  await page.waitForFunction(() => document.querySelector('#sync-status')?.textContent.includes('All changes saved'));
  check('Offline draft syncs', (await read('/api/bootstrap')).workout_exercises[0].sets[0].weight === 45.5);
  await page.locator('#open-picker').click();
  await page.locator('#create-exercise').focus();
  await page.keyboard.press('Tab');
  check('Picker wraps forward focus', await page.evaluate(() => !!document.activeElement.closest('#picker')));
  await page.locator('#close-picker').focus();
  await page.keyboard.press('Shift+Tab');
  check('Picker wraps backward focus', await page.evaluate(() => document.activeElement.id === 'create-exercise'));
  await page.keyboard.press('Escape');
  await page.locator('#picker').waitFor({ state: 'detached' });
  check('Escape restores picker trigger focus', await page.evaluate(() => document.activeElement.id === 'open-picker'));
  const second = page.locator('.set-form').nth(1);
  await second.locator('[name=completed]').check();
  await page.locator('.exercise-summary').first().click();
  await page.locator('[data-finish-workout]').click();
  check('Invalid collapsed set expands and prevents finish', await page.locator('.workout-exercise').first().evaluate(card => card.open)
    && await page.locator('dialog').count() === 0);
  await second.locator('[name=result]').fill('6');
  await second.locator('[name=weight]').fill('50');
  await page.locator('[data-finish-workout]').click();
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await page.locator('.finish-summary').waitFor();
  check('Finish shows summary heading without a manual scroll', (await page.locator('#finish-summary-title').boundingBox()).y >= 0);
  check('Finish moves focus to summary heading', await page.evaluate(() => document.activeElement.id === 'finish-summary-title'));
  check('Summary counts only completed sets and exercises', (await page.locator('.finish-totals').innerText()).includes('1 exercise with completed sets · 2 completed sets'));
  await page.evaluate(() => scrollTo(0, 0));
  await screenshot('finish-summary-mobile');
  await page.locator('#summary-routine').click();
  await page.getByRole('textbox', { name: 'Routine name' }).fill('Saved from summary');
  await page.getByRole('button', { name: 'Save routine', exact: true }).click();
  await page.getByRole('button', { name: 'Start Saved from summary', exact: false }).waitFor();
  check('Summary saves a routine', (await read('/api/routines?gym_id=1')).routines.length === 2);
  await page.locator('#open-history').click();
  await page.locator('[data-history-id]').waitFor();
  check('Header History opens the list', await page.locator('#history-list-view').isVisible());
  await page.locator('#close-history').click();
  await page.locator('#summary-history').click();
  await page.locator('[data-repeat-workout]').waitFor();
  const historyNote = await page.locator('#history-detail .exercise-entry .note-text').first().boundingBox();
  const historyHeading = await page.locator('#history-detail .history-exercise-heading').first().boundingBox();
  check('Completed workout note is above its exercise heading', historyNote.y + historyNote.height <= historyHeading.y);
  for (const selector of ['#close-history', '#history-back']) {
    const bounds = await page.locator(selector).boundingBox();
    check(selector + ' visible when detail opens', bounds.y >= 0 && bounds.y + bounds.height <= 844);
  }
  await page.locator('#history').evaluate(dialog => { dialog.scrollTop = dialog.scrollHeight; });
  for (const selector of ['#close-history', '#history-back']) {
    const bounds = await page.locator(selector).boundingBox();
    check(selector + ' stays visible after scrolling', bounds.y >= 0 && bounds.y + bounds.height <= 844);
  }
  await screenshot('history-sticky-navigation');
  await page.setViewportSize({ width: 320, height: 568 });
  const shortClose = await page.locator('#close-history').boundingBox();
  check('History navigation fits a short phone viewport', shortClose.y >= 0 && shortClose.y + shortClose.height <= 568);
  await screenshot('history-small-phone');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#history-back').click();
  await page.locator('[data-history-id]').waitFor();
  await page.locator('#close-history').click();
  await page.locator('#open-progress').click();
  await page.locator('#progress-exercise').selectOption({ label: 'Bench Press' });
  await page.locator('.progress-chart [data-progress-point]').waitFor();
  await page.locator('.progress-chart [data-progress-point]').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#progress-point-details')?.textContent.includes('45.5 kg'));
  const detail = await page.locator('#progress-point-details').innerText();
  check('Chart point exposes actual paired sets', detail.includes('8 reps · 45.5 kg') && detail.includes('6 reps · 50 kg'));
  check('Chart includes date labels', await page.locator('.progress-chart text').count() >= 3);
  await screenshot('progress-point-mobile');
  await page.locator('#progress-metric').selectOption('best_weight');
  await page.locator('.progress-chart [data-progress-point]').click();
  await page.waitForFunction(() => document.querySelector('#progress-point-details')?.textContent.includes('50 kg'));
  check('Chart supports tapping after changing metric', (await page.locator('#progress-point-details').innerText()).includes('6 reps · 50 kg'));
  for (const [width, height] of [[320, 568], [768, 1024], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    check(`Progress has no horizontal overflow at ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await screenshot('progress-' + width);
  }
  await page.locator('#close-progress').click();
  for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    check(`No horizontal overflow at ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await screenshot('start-' + width);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#open-manage').click();
  await page.locator('[data-section="exercises"] > summary').click();
  await page.locator(`[data-manage-muscle-groups="variation:${customVariation.id}"]`).click();
  const muscleGroupForm = page.locator(`[data-manage-muscle-groups-form="variation:${customVariation.id}"]`);
  check('Manage restores checked Muscle Groups', await muscleGroupForm.getByLabel('Back', { exact: true }).isChecked()
    && await muscleGroupForm.getByLabel('Abs', { exact: true }).isChecked());
  await muscleGroupForm.getByLabel('Back', { exact: true }).uncheck();
  await muscleGroupForm.getByLabel('Forearms', { exact: true }).check();
  await muscleGroupForm.getByRole('button', { name: 'Save Muscle Groups', exact: true }).click();
  await page.waitForFunction(id => document.querySelector(`[data-manage-muscle-groups-form="variation:${id}"] input[value="Forearms"]`)?.checked, customVariation.id);
  check('Manage corrects Muscle Groups', JSON.stringify((await read('/api/catalog?gym_id=1')).catalog.find(item => item.id === customVariation.id).muscle_groups) === JSON.stringify(['Forearms', 'Abs']));
  await muscleGroupForm.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.waitForFunction(id => !document.querySelector(`[data-manage-muscle-groups-form="variation:${id}"] input:checked`), customVariation.id);
  check('Manage clears Muscle Groups', (await read('/api/catalog?gym_id=1')).catalog.find(item => item.id === customVariation.id).muscle_groups.length === 0);
  check('Muscle Group editor has no phone overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await screenshot('manage-muscle-groups');
  await page.locator('#close-manage').click();
  check('No unexpected JavaScript exceptions', errors.length === 0);
  await writeFile(join(artifacts, 'results.json'), JSON.stringify({ checks, errors, port }, null, 2));
  console.log(`${checks.length} browser checks passed. Artifacts: ${artifacts}`);
} catch (error) {
  if (page) await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(`Browser test failed. Artifacts: ${artifacts}`);
  throw error;
} finally {
  await browser?.close();
  if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
  await writeFile(join(artifacts, 'server.log'), log);
}
