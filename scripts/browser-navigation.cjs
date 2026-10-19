'use strict';

// Run from repository root: node --test --test-timeout=30000 scripts/browser-navigation.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { fixture } = require('../test/helpers');

async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    `${page.url()} fits the viewport`);
}

test('entry navigation explains each role, reaches both sources and opens a display', async t => {
  let browser;
  const app = await fixture({ after: cleanup => t.after(async () => {
    await browser?.close();
    await cleanup();
  }) });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox'],
  });
  const errors = [];
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.base);
  assert.equal(await page.locator('html').getAttribute('lang'), 'uk');
  assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1);
  await noOverflow(page);
  assert.equal(await page.locator('.start-main').evaluate(element => getComputedStyle(element).animationName), 'none');
  const local = page.getByRole('link', { name: /Відео з пристрою/ });
  await local.focus();
  assert.equal(await local.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
  assert.equal(await local.evaluate(element => getComputedStyle(element).transitionDuration), '0s');

  // Ordinary links also work when navigation JavaScript is disabled.
  const plain = await browser.newContext({ javaScriptEnabled: false });
  const plainPage = await plain.newPage();
  await plainPage.goto(app.base);
  await Promise.all([plainPage.waitForURL('**/video'), plainPage.getByRole('link', { name: 'Приєднати екран' }).first().click()]);
  assert.equal(await plainPage.locator('#connectToMasterButton').isVisible(), true);
  await plain.close();

  for (const [name, query, visible, hidden] of [
    [/Відео з пристрою/, 'local', '#uploadButton', '#streamButton'],
    [/YouTube/, 'url', '#streamButton', '#uploadButton'],
  ]) {
    await page.goto(app.base);
    await Promise.all([page.waitForURL(`**/master.html?type=${query}`), page.getByRole('link', { name }).click()]);
    await page.locator(visible).waitFor({ state: 'visible' });
    assert.equal(await page.locator(hidden).isVisible(), false);
    await noOverflow(page);
  }
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('link', { name: /Відкрити екран/ }).click();
  const display = await popupPromise;
  await display.waitForURL('**/video');
  assert.equal(await display.locator('#connectToMasterButton').isVisible(), true);
  assert.equal(await display.evaluate(() => window.opener === null), true);
  await display.close();

  // Missing or unrecognized source parameters have a usable local-file default.
  for (const suffix of ['/master.html', '/master.html?type=unknown']) {
    await page.goto(app.base + suffix);
    await page.locator('#uploadButton').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#streamButton').isVisible(), false);
  }

  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto(app.base);
  await noOverflow(page);
  assert.ok((await page.locator('.start-header-display').boundingBox()).y < 100, 'display entry is visible at the top on mobile');
  for (const name of [/Відео з пристрою/, /YouTube/, 'Приєднати екран']) {
    assert.equal(await page.getByRole('link', { name }).first().isVisible(), true);
  }
  await Promise.all([page.waitForURL('**/video'), page.getByRole('link', { name: 'Приєднати екран' }).first().click()]);
  assert.equal(await page.locator('#connectToMasterButton').isVisible(), true);
  await page.goto(app.base + '/master.html');
  await page.locator('#uploadButton').waitFor({ state: 'visible' });
  await noOverflow(page);
  assert.equal(await page.locator('#openDisplay').isVisible(), true);
  await page.locator('#videoFile').focus();
  assert.equal(await page.locator('.input__file-button').evaluate(el=>getComputedStyle(el).outlineStyle), 'solid');
  assert.deepEqual(errors, []);
});
