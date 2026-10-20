'use strict';
// Simulated UI only; no public YouTube calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { fixture } = require('../test/helpers');

test('workspace prototype demonstrates sources, playback, screen states and one-field pairing without network actions', async t => {
  let browser;
  const app = await fixture({ after: cleanup => t.after(async () => { await browser?.close(); await cleanup(); }) });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1024 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [], external = [], api = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== app.base) external.push(request.url());
    if (/\/(?:api|socket\.io|upload|youtube)\b/.test(url.pathname)) api.push(url.pathname);
  });
  // Scratch execution can override only the prototype document, not application assets.
  if (process.env.PROTOTYPE_FILE) {
    const html = await fs.readFile(path.resolve(process.env.PROTOTYPE_FILE), 'utf8');
    await page.route('**/prototypes/session-workspace.html', route => route.fulfill({ contentType: 'text/html', body: html }));
  }
  await page.goto(app.base + '/prototypes/session-workspace.html');
  assert.match(await page.locator('.demo-strip').textContent(), /демонстраційні дані/);
  assert.equal(await page.locator('#play').isDisabled(), true);
  assert.equal(await page.locator('.panel').first().evaluate(node => getComputedStyle(node).animationName), 'none');
  assert.equal(await page.locator('#screenList .screen-item').count(), 2);
  await page.locator('#addScreen').click();
  assert.equal(await page.locator('#screenList .screen-item').count(), 3);
  const screen = page.locator('[data-screen="3"]');
  await screen.getByRole('button', { name: 'Втратити з’єднання' }).click();
  assert.match(await screen.textContent(), /Відновлення/);
  await screen.getByRole('button', { name: 'Відновити', exact: true }).click();
  assert.match(await screen.textContent(), /Підключено/);
  await screen.getByRole('button', { name: 'Видалити екран 3' }).click();
  assert.equal(await page.locator('#screenList .screen-item').count(), 2);
  for (let index = 0; index < 3; index++) await page.locator('#addScreen').click();
  assert.equal(await page.locator('#addScreen').isDisabled(), true);
  await page.locator('#youtubeTab').click();
  await page.locator('#youtubeUrl').fill('https://example.com/watch?v=RoYXgdHafBA');
  await page.locator('#youtubeUrl').press('Enter');
  assert.equal(await page.locator('#youtubeUrl').getAttribute('aria-invalid'), 'true');
  await page.locator('#youtubeUrl').fill('https://www.youtube.com/watch?v=RoYXgdHafBA&list=example');
  await page.locator('#youtubeUrl').press('Enter');
  await page.locator('#sendMedia').click();
  assert.match(await page.locator('#mediaName').textContent(), /RoYXgdHafBA/);
  await page.locator('#play').click();
  assert.equal(await page.locator('#playbackBadge').textContent(), 'Відтворення');
  await page.locator('#pause').click();
  await page.locator('#seek').evaluate(input => { input.value = '73'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.locator('#position').textContent(), '1:13');
  await page.locator('#volume').evaluate(input => { input.value = '42'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.locator('#volumeValue').textContent(), '42%');
  await page.locator('summary').click();
  await page.locator('#loop').check();
  await page.locator('#inversion').check();
  assert.equal(await page.locator('#preview').evaluate(node => node.classList.contains('inverted')), true);
  await page.locator('#stop').click();
  assert.equal(await page.locator('#position').textContent(), '0:00');
  await page.locator('#fileTab').click();
  await page.locator('#videoFile').setInputFiles({ name: 'Приклад.webm', mimeType: 'video/webm', buffer: Buffer.from('metadata-only demo') });
  await page.locator('#sendMedia').click();
  assert.equal(await page.locator('#mediaName').textContent(), 'Приклад.webm');
  await page.locator('#displayRole').click();
  await page.locator('#pairingCode').fill('123');
  await page.locator('#pairingCode').press('Enter');
  assert.equal(await page.locator('#pairingCode').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#pairingCode').evaluate(node => node === document.activeElement), true);
  await page.locator('#pairingCode').fill('482619');
  await page.locator('#pairingCode').press('Enter');
  assert.equal(await page.locator('#displaySession').isVisible(), true);
  await page.locator('#simulateBlock').click();
  assert.equal(await page.locator('#resume').isVisible(), true);
  await page.locator('#resume').click();
  assert.match(await page.locator('#displayStatus').textContent(), /відновлено/);
  await page.locator('#disconnectDisplay').click();
  assert.equal(await page.locator('#pairingForm').isVisible(), true);
  await page.locator('#pairingCode').fill('482619');
  await page.locator('#pairingCode').press('Enter');
  assert.equal(await page.locator('#resume').isVisible(), false);
  assert.match(await page.locator('#displayStatus').textContent(), /Очікуємо відео/);
  await page.locator('#disconnectDisplay').click();
  await page.setViewportSize({ width: 320, height: 760 });
  for (const role of ['controllerRole', 'displayRole']) {
    await page.locator('#' + role).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, role + ' fits 320px');
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(api, []);
});
