'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { Readable } = require('node:stream');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('../test/helpers');
const run = promisify(execFile);
async function ready(page) { await page.waitForFunction(() => playerSession.isReady()); }
async function stable(page, paused) {
  await page.waitForFunction(paused => {
    const raw = document.querySelector('#youtubePlayer video');
    return raw && raw.readyState >= 2 && raw.paused === paused && !raw.seeking && raw.getVideoPlaybackQuality().totalVideoFrames > 0;
  }, paused);
}
async function sample(pages, phase, paused) {
  await Promise.all(pages.map(page => stable(page, paused)));
  // Let native seeks finish and observe real decoded clocks, never facade.currentTime.
  await pages[0].waitForTimeout(250);
  const raw = await Promise.all(pages.map(page => page.evaluate(() => {
    const video = document.querySelector('#youtubePlayer video');
    return {time: video.currentTime, wallMs: performance.timeOrigin + performance.now(), paused: video.paused,
      seeking: video.seeking, frames: video.getVideoPlaybackQuality().totalVideoFrames};
  })));
  const commonWallMs = Math.max(...raw.map(value => value.wallMs));
  const projected = raw.map(value => value.time + (value.paused ? 0 : (commonWallMs - value.wallMs) / 1000));
  return { phase, raw, commonWallMs, projected, driftSeconds: Math.abs(projected[0] - projected[1]) };
}

test('YouTube explicit start/pause/resume aligns raw decoded clocks across delayed iframe API commands', {timeout:60000}, async t => {
  let bytes, browser;
  const app = await fixture({ after: cleanup => t.after(async () => { if (browser) await browser.close(); await cleanup(); }) },
    { ytdl: () => Readable.from([bytes]) });
  const fixturePath = path.join(app.root, 'youtube-sync.mp4');
  await run('ffmpeg', ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','20','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',fixturePath]);
  bytes = await fs.readFile(fixturePath);
  browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,
    args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
  const masterContext = await browser.newContext(), displayContext = await browser.newContext();
  for (const [context, delays] of [[masterContext,{playMs:0,pauseMs:0}],[displayContext,{playMs:600,pauseMs:150}]]) {
    await context.addInitScript(value => { window.fakeYoutubeDelays = value; }, delays);
    await context.addInitScript({path: path.join(__dirname, '../test/fake-youtube-delayed-api.js')});
    // Real iframe players implement seeking internally. The local native double
    // needs a seekable fixture response; the legacy streaming extractor is not it.
    await context.route('**/youtube/RoYXgdHafBA', route => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      return route.fulfill({status:range ? 206 : 200, headers:{'content-type':'video/mp4','accept-ranges':'bytes',
        'content-length':String(end-start+1), ...(range ? {'content-range':`bytes ${start}-${end}/${bytes.length}`} : {})}, body:bytes.subarray(start,end+1)});
    });

  }
  const master = await masterContext.newPage(), display = await displayContext.newPage();
  const errors = [];
  for (const page of [master,display]) page.on('pageerror', error => errors.push(error.message));
  await master.goto(app.base+'/master.html?type=url'); await ready(master);
  const code = (await master.locator('#showConnectionID').textContent()).match(/\b\d{6}\b/)?.[0];
  assert.ok(code);
  await display.goto(app.base+'/video'); await display.locator('#pairingCode').fill(code); await display.locator('#connectToMasterButton').click(); await ready(display);
  await master.locator('#youtubeUrlInput').fill('https://www.youtube.com/watch?v=RoYXgdHafBA&list=RDRoYXgdHafBA&start_radio=1');
  await master.locator('#streamButton').click();
  for (const page of [master,display]) await page.waitForFunction(() => videoPlayer.isYouTube && videoPlayer.readyState >= 1 && playerSession.isReady());
  const sessionId = await master.evaluate(() => controllerSession.sessionId);
  const samples = [];
  const canonical = () => app.sessionStore.sessions.get(sessionId).playback.snapshot();
  await master.locator('#youtubePlay').click(); samples.push({...await sample([master,display], 'start', false),canonical:canonical()});
  await master.locator('#youtubePause').click(); samples.push({...await sample([master,display], 'pause', true),canonical:canonical()});
  await master.locator('#youtubePlay').click(); samples.push({...await sample([master,display], 'resume', false),canonical:canonical()});
  console.log(JSON.stringify({description:'Local decoded media through simulated IFrame API; 600ms display play and 150ms pause delays; not live YouTube or LAN quality',browser:await browser.version(),samples}));
  assert.deepEqual(errors, []);
  for (const entry of samples) assert.ok(entry.driftSeconds <= 0.2, `${entry.phase}: raw decoded drift <=200ms, got ${entry.driftSeconds}`);
});
