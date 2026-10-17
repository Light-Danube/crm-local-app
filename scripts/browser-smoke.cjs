'use strict';

// Run explicitly: node --test --test-timeout=120000 scripts/browser-smoke.cjs
// Requires ffmpeg and CHROMIUM_PATH (defaults to /usr/bin/chromium).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { chromium } = require('playwright-core');
const { fixture } = require('../test/helpers');
const { createApplication } = require('../server');

const run = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function ready(page, timeout = 5000) {
  await page.waitForFunction(() => typeof playerSession !== 'undefined' && playerSession.isReady(), null, { timeout });
}

async function volume(page, value) {
  await page.locator('#volumeControl').evaluate((input, next) => {
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function seek(page, time) {
  // Native media controls ultimately change the media element's currentTime.
  // Use that same path and its native seeking event, never socket.emit().
  await page.locator('#videoPlayer').evaluate((video, next) => { video.currentTime = next; }, time);
}

async function effect(page, selector, checked) {
  // Styled checkboxes are intentionally hidden; exercise their UI handlers.
  await page.locator(selector).evaluate((input, value) => {
    input.checked = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, checked);
}

async function play(page) {
  await page.locator('#videoPlayer').evaluate(video => video.play());
  await page.waitForFunction(() => !document.querySelector('#videoPlayer').paused);
}

async function pause(page) {
  await page.locator('#videoPlayer').evaluate(video => video.pause());
  await page.waitForFunction(() => document.querySelector('#videoPlayer').paused);
}

async function pairedDisplay(context, base, controller) {
  await Promise.all([
    controller.waitForResponse(response => response.url().includes('/pairing') && response.request().method() === 'POST' && response.ok()),
    controller.locator('#refreshPairing').click(),
  ]);
  const code = await controller.locator('#showConnectionID').textContent();
  const pairingCode = code.match(/\b\d{6}\b/)?.[0];
  assert.ok(pairingCode, 'controller visibly supplies a pairing code');
  const display = await context.newPage();
  await display.goto(base + '/video');
  display.once('dialog', dialog => dialog.accept(pairingCode));
  await display.locator('#connectToMasterButton').click();
  await ready(display);
  return display;
}

test('real media, autoplay recovery, ten network recoveries, offline commands and server restart', async t => {
  const app = await fixture(t);
  const sample = path.join(app.root, 'browser-sample.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-movflags', '+faststart', sample]);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox', '--autoplay-policy=document-user-activation-required'] });
  t.after(() => browser.close());
  const controllerContext = await browser.newContext();
  const displayContext = await browser.newContext();
  const controller = await controllerContext.newPage();
  const errors = [];
  const watch = page => page.on('pageerror', error => errors.push(error.message));
  watch(controller);
  await controller.goto(app.base + '/master.html?type=local');
  await ready(controller);
  const display = await pairedDisplay(displayContext, app.base, controller);
  watch(display);

  await controller.locator('#videoFile').setInputFiles(sample);
  await controller.locator('#uploadButton').click();
  await display.waitForFunction(() => {
    const video = document.querySelector('#videoPlayer');
    return video.readyState >= 2 && video.videoWidth > 0 && video.duration > 30;
  });
  await ready(controller);
  await ready(display);
  await play(controller);
  await display.waitForFunction(() => !document.querySelector('#videoPlayer').paused);
  const before = await display.locator('#videoPlayer').evaluate(video => video.currentTime);
  await display.waitForFunction(time => document.querySelector('#videoPlayer').currentTime > time + 0.2, before);
  assert.ok(await display.locator('#videoPlayer').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames > 0), 'browser decodes real video frames');
  await pause(controller);
  await display.waitForFunction(() => document.querySelector('#videoPlayer').paused);
  await seek(controller, 7);
  await volume(controller, 0.42);
  await effect(controller, '#toggleLoopButton', true);
  await effect(controller, '#optimizeButton', true);
  await effect(controller, '#optimizeColorButton', true);
  await effect(controller, '#enhanceDetailsCheckbox', true);
  await effect(controller, '#optimizeBackground', true);
  await display.waitForFunction(() => {
    const v = document.querySelector('#videoPlayer');
    return Math.abs(v.currentTime - 7) < 0.3 && Math.abs(v.volume - 0.42) < 0.001
      && v.loop && v.style.transform.includes('-1') && v.style.filter.includes('hue-rotate');
  });
  const media = await display.locator('#videoPlayer').evaluate(video => video.currentSrc);

  for (let cycle = 0; cycle < 10; cycle++) {
    await displayContext.setOffline(true);
    await display.evaluate(() => socket.io.engine.close());
    await display.waitForFunction(() => !playerSession.isReady());
    assert.equal(await display.locator('#videoPlayer').evaluate(video => video.currentSrc), media, 'drop preserves media');
    await wait(2000);
    const target = 8 + cycle;
    const level = 0.2 + cycle / 100;
    await seek(controller, target);
    await volume(controller, level);
    await displayContext.setOffline(false);
    await ready(display, 5000);
    await display.waitForFunction(({ target, level, media }) => {
      const v = document.querySelector('#videoPlayer');
      return v.currentSrc === media && v.paused && Math.abs(v.currentTime - target) < 0.3
        && Math.abs(v.volume - level) < 0.001 && v.loop && v.style.filter.includes('hue-rotate');
    }, { target, level, media }, { timeout: 5000 });
    t.diagnostic(`network recovery ${cycle + 1}/10 restored media and latest snapshot within 5 seconds`);
  }

  // Offline controller changes must never enter Socket.IO's reconnect queue.
  const authoritativeVolume = await display.locator('#videoPlayer').evaluate(video => video.volume);
  await controllerContext.setOffline(true);
  await controller.evaluate(() => socket.io.engine.close());
  await controller.waitForFunction(() => !playerSession.isReady());
  await volume(controller, 0.99);
  await effect(controller, '#toggleLoopButton', false);
  assert.equal(await controller.evaluate(() => socket.sendBuffer.length), 0);
  await controllerContext.setOffline(false);
  await ready(controller);
  await controller.waitForFunction(expected => Math.abs(document.querySelector('#videoPlayer').volume - expected) < 0.001, authoritativeVolume);
  assert.equal(await display.locator('#videoPlayer').evaluate(video => video.loop), true);
  assert.equal(await display.locator('#videoPlayer').evaluate(video => video.volume), authoritativeVolume);

  // A new document has saved display credentials but no user activation. The
  // browser itself must reject audible autoplay and expose the real recovery UI.
  const credentials = await display.evaluate(() => sessionStorage.getItem('displaySession'));
  await displayContext.close();
  await play(controller);
  const freshContext = await browser.newContext();
  await freshContext.addInitScript(value => sessionStorage.setItem('displaySession', value), credentials);
  const freshDisplay = await freshContext.newPage();
  watch(freshDisplay);
  await freshDisplay.goto(app.base + '/video');
  await freshDisplay.locator('#resumePlayback').waitFor({ state: 'visible' });
  assert.match(await freshDisplay.locator('#connectionStatus').textContent(), /Відновити|відновити|дозволити/);
  assert.equal(await freshDisplay.locator('#videoPlayer').evaluate(video => video.paused), true);
  await freshDisplay.locator('#resumePlayback').click();
  await freshDisplay.waitForFunction(() => !document.querySelector('#videoPlayer').paused);
  await pause(controller);

  // Close the original listener without ending its fixture-owned log stream;
  // fixture cleanup still stops its timers and removes all generated artifacts.
  const port = new URL(app.base).port;
  await new Promise(resolve => app.io.close(resolve));
  const replacement = createApplication({ mediaRoot: app.mediaRoot, logDirectory: app.logDirectory });
  t.after(() => replacement.stop());
  await replacement.start(Number(port), '127.0.0.1');
  await Promise.all([controller, freshDisplay].map(page => page.waitForFunction(() => {
    const text = document.querySelector('#connectionStatus').textContent;
    return /Сесію завершено|код доступу|повторн.*[єе]днан/i.test(text)
      && !document.querySelector('#resetSession').hidden;
  }, null, { timeout: 10000 })));
  assert.deepEqual(errors, [], 'no uncaught browser errors');
});
