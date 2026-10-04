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
  await page.goto(base);
  await page.locator('#gym-name').fill('Browser Test Gym');
  await page.locator('#add-gym-form button').click();
  await page.locator('#open-routines').click();
  await page.locator('[data-new-routine]').click();
  await page.getByRole('textbox', { name: 'Routine name' }).fill('First plan');
  await page.getByRole('button', { name: 'Create routine', exact: true }).click();
  await page.locator('[data-add-routine-exercise]').click();
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
  await page.locator('#exercise-search').fill('Long Custom Duration Exercise For Browser Testing');
  await page.locator('#create-exercise').click();
  await page.getByRole('radio', { name: 'Duration in seconds' }).check();
  await page.locator('#equipment-choice select').selectOption({ label: 'Machine' });
  await page.locator('#add-equipment').click();
  await page.locator('#custom-exercise-form button[type=submit]').click();
  await page.getByRole('button', { name: 'Add to routine', exact: true }).click();
  await page.locator('.routine-exercise').nth(1).waitFor();
  await screenshot('routine-from-catalog');
  check('Custom exercise can be created in a routine', (await read('/api/routines?gym_id=1')).routines[0].exercises.length === 2);
  await page.locator('#close-routines').click();
  await page.locator('[data-start-routine]').click();
  await page.locator('.set-form').first().waitFor();
  check('Routine starts with correct empty slots', await page.locator('.set-form').count() === 5
    && await page.locator('.set-form input[name=weight], .set-form input[name=result]').evaluateAll(inputs => inputs.every(input => input.value === '')));
  await page.locator('#rest-enabled').check();
  await page.evaluate(() => scrollTo(0, 0));
  await screenshot('compact-workout-mobile');
  check('First set visible with timer enabled', (await page.locator('.set-form').first().boundingBox()).y < 750);
  await page.locator('#rest-start').click();
  await page.locator('#rest-pause').click();
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
  await page.locator('.exercise-options > summary').first().click();
  await page.locator('.exercise-options > summary').nth(1).click();
  await page.getByRole('button', { name: 'Move Long Custom Duration Exercise For Browser Testing up', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.exercise-summary h3')?.textContent.startsWith('Long Custom'));
  check('Reordering retains focus in visible exercise options', await page.evaluate(() => document.activeElement.matches('[data-move-exercise]') && document.activeElement.getClientRects().length > 0));
  await page.getByRole('button', { name: 'Move Long Custom Duration Exercise For Browser Testing down', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.exercise-summary h3')?.textContent === 'Bench Press');
  await page.getByRole('button', { name: 'Change machine for Bench Press', exact: true }).click();
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
