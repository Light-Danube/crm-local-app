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

async function waitServer(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await wait(20);
  assert.ok(predicate(), message);
}

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
  const extraContexts = [await browser.newContext(), await browser.newContext()];
  const siblings = [];
  for (const context of extraContexts) {
    const sibling = await pairedDisplay(context, app.base, controller);
    watch(sibling);
    siblings.push(sibling);
  }
  const sessionId = await controller.evaluate(() => controllerSession.sessionId);
  const serverState = () => app.sessionStore.sessions.get(sessionId).playback.snapshot();

  await controller.locator('#videoFile').setInputFiles(sample);
  await controller.locator('#uploadButton').click();
  await display.waitForFunction(() => {
    const video = document.querySelector('#videoPlayer');
    return video.readyState >= 2 && video.videoWidth > 0 && video.duration > 30;
  });
  await ready(controller);
  await ready(display);
  await play(controller);
  for (const page of [display, ...siblings]) {
    await ready(page);
    await page.waitForFunction(() => {
      const v = document.querySelector('#videoPlayer');
      return !v.paused && v.getVideoPlaybackQuality().totalVideoFrames > 0;
    });
  }
  const before = await display.locator('#videoPlayer').evaluate(video => video.currentTime);
  await display.waitForFunction(time => document.querySelector('#videoPlayer').currentTime > time + 0.2, before);
  assert.ok(await display.locator('#videoPlayer').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames > 0), 'browser decodes real video frames');
  await pause(controller);
  for (const page of [display, ...siblings]) await page.waitForFunction(() => document.querySelector('#videoPlayer').paused);
  for (const context of extraContexts) await context.close();
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
    // An elapsed server clock can exceed a looping video's duration.
    const restoredTime = cycle === 0 ? 0.5 : target;
    if (cycle === 0) {
      await controller.evaluate(() => { socket.emit('player timeupdate', videoPlayer.duration + 0.5); });
      await waitServer(() => serverState().time > 60, 'server retains elapsed loop time');
    }
    await displayContext.setOffline(false);
    await ready(display, 5000);
    await display.waitForFunction(({ target, level, media }) => {
      const v = document.querySelector('#videoPlayer');
      return v.currentSrc === media && v.paused && Math.abs(v.currentTime - target) < 0.3
        && Math.abs(v.volume - level) < 0.001 && v.loop && v.style.filter.includes('hue-rotate');
    }, { target: restoredTime, level, media }, { timeout: 5000 });
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
  const displayId = JSON.parse(credentials).displayId;
  await waitServer(() => !app.sessionStore.sessions.get(sessionId).displays.get(displayId).socketId,
    'closed display releases its server socket before credential reuse');
  await play(controller);
  await waitServer(() => !serverState().paused, 'play is canonical before the fresh display snapshot');
  // Use a separate Chromium process/profile so earlier controller gestures and
  // media engagement cannot grant autoplay permission to this display.
  const freshBrowser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox', '--autoplay-policy=document-user-activation-required'] });
  t.after(() => freshBrowser.close());
  const freshContext = await freshBrowser.newContext();
  await freshContext.addInitScript(value => sessionStorage.setItem('displaySession', value), credentials);
  const freshDisplay = await freshContext.newPage();
  watch(freshDisplay);
  await freshDisplay.goto(app.base + '/video');
  // Playwright's regular locator/evaluate polling sets CDP userGesture:true.
  // Poll through CDP without activation until the native autoplay rejection;
  // otherwise the assertion itself can silently authorize audible playback.
  const cdp = await freshContext.newCDPSession(freshDisplay);
  const observed = await cdp.send('Runtime.evaluate', { userGesture: false, awaitPromise: true, returnByValue: true,
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      function inspect() {
        const video = document.querySelector('#videoPlayer');
        const state = { status: document.querySelector('#connectionStatus').textContent,
          paused: video.paused, muted: video.muted, readyState: video.readyState,
          activated: navigator.userActivation.hasBeenActive, connected: socket.connected,
          ready: playerSession.isReady(), mediaError: video.error?.code };
        if (!document.querySelector('#resumePlayback').hidden && playerSession.isReady()) resolve(state);
        else if (Date.now() >= deadline) reject(new Error('Native autoplay recovery missing: ' + JSON.stringify(state)));
        else setTimeout(inspect, 20);
      }
      inspect();
    })` });
  assert.equal(observed.exceptionDetails, undefined, observed.exceptionDetails?.exception?.description);
  assert.match(observed.result.value.status, /дозволити відео/);
  assert.equal(observed.result.value.paused, true);
  assert.equal(observed.result.value.activated, false, 'autoplay denial is observed without granting user activation');
  await freshDisplay.locator('#resumePlayback').click();
  const activated = await cdp.send('Runtime.evaluate', { userGesture: false, returnByValue: true,
    expression: 'navigator.userActivation.hasBeenActive' });
  assert.equal(activated.result.value, true, 'the visible resume click supplies real user activation');
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
