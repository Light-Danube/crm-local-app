'use strict';
// node --test --test-timeout=120000 scripts/browser-media.cjs
// Requires ffmpeg and CHROMIUM_PATH (defaults to /usr/bin/chromium).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { PassThrough } = require('node:stream');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('../test/helpers');
const run = promisify(execFile);
async function ready(page) { await page.waitForFunction(() => playerSession.isReady(), null, { timeout:10000 }); }

test('media UI bounds local URLs, handles file cancellation/errors and buffers YouTube URLs before upstream completion', {timeout:120000}, async t => {
  let bytes, browser;
  const streams=[];
  const app=await fixture({after:cleanup=>t.after(async()=>{
    streams.forEach(stream=>stream.destroy());
    if(browser)await browser.close();
    await cleanup();
  })}, {mediaLimits:{maxFileBytes:1234567},ytdl:url=>{
    const stream=new PassThrough();streams.push(stream);
    setImmediate(()=>{
      if(url.includes('brokenERR00')) stream.destroy(new Error('Benign test upstream failure'));
      else stream.write(bytes); // Keep HTTP transfer open after all fixture bytes.
    });
    return stream;
  },youtubeOptions:{timeoutMs:30000}});
  const fixturePath=path.join(app.root,'browser-media.mp4');
  await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','4','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',fixturePath]);
  bytes=await fs.readFile(fixturePath);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--autoplay-policy=document-user-activation-required']});
  const context=await browser.newContext();
  await context.addInitScript(()=>{
    window.liveObjectUrls=new Set();window.objectUrlPeak=0;window.objectUrlsCreated=0;window.objectUrlsRevoked=0;
    const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
    URL.createObjectURL=value=>{const url=create(value);liveObjectUrls.add(url);objectUrlsCreated++;objectUrlPeak=Math.max(objectUrlPeak,liveObjectUrls.size);return url};
    URL.revokeObjectURL=url=>{if(liveObjectUrls.delete(url))objectUrlsRevoked++;revoke(url)};
  });
  const master=await context.newPage(),display=await context.newPage();
  const errors=[],alerts=[];let code;
  for(const page of [master,display])page.on('pageerror',error=>errors.push(error.message));
  master.on('dialog',async dialog=>{alerts.push(dialog.message());await dialog.dismiss()});
  display.on('dialog',async dialog=>{if(dialog.type()==='prompt')await dialog.accept(code);else{alerts.push(dialog.message());await dialog.dismiss()}});
  await master.goto(app.base+'/master.html?type=local');await ready(master);
  await master.waitForFunction(()=>document.querySelector('#uploadGuidance').textContent.includes('1234567'));
  assert.equal(await master.locator('#videoFile').getAttribute('multiple'),null);
  assert.equal(await master.locator('#videoFile').getAttribute('accept'),'video/mp4,video/webm,.mp4,.webm');
  code=(await master.locator('#showConnectionID').textContent()).match(/\b\d{6}\b/)?.[0];assert.ok(code);
  await display.goto(app.base+'/video');await display.locator('#connectToMasterButton').click();await ready(display);
  await master.locator('#videoFile').setInputFiles(fixturePath);
  await master.locator('#uploadButton').click();
  await display.waitForFunction(()=>document.querySelector('video').readyState>=2);
  const memorySamples=[];
  for(let i=0;i<20;i++){
    await master.locator('#videoFile').setInputFiles([]);
    await master.locator('#videoFile').setInputFiles(fixturePath);
    memorySamples.push(await master.evaluate(()=>({wallMs:performance.timeOrigin+performance.now(),usedJSHeapSize:performance.memory?.usedJSHeapSize??null,totalJSHeapSize:performance.memory?.totalJSHeapSize??null})));
  }
  const urlCounts=await master.evaluate(()=>({active:liveObjectUrls.size,peak:objectUrlPeak,created:objectUrlsCreated,revoked:objectUrlsRevoked}));
  assert.equal(urlCounts.active,1);assert.equal(urlCounts.peak,1);
  assert.ok(urlCounts.created>=21,'each replacement actually creates a new local preview');
  assert.ok(urlCounts.revoked>=20,'all superseded local previews are revoked');
  await master.locator('#videoFile').setInputFiles([]);
  assert.deepEqual(errors,[]);
  // A browser may provide an empty MIME type for a valid extension. The UI adds
  // only that known type; the server still verifies the actual container bytes.
  await master.locator('#videoFile').setInputFiles({name:'empty-type.mp4',mimeType:'',buffer:bytes});
  await master.locator('#videoFile').evaluate(input=>{
    // Playwright infers MIME from the filename; create the browser-provided
    // empty-type File explicitly to exercise that real input/change path.
    const original=input.files[0], transfer=new DataTransfer();
    transfer.items.add(new File([original],original.name,{type:''}));
    input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  });
  assert.equal(await master.locator('#videoFile').evaluate(input=>input.files[0].type),'');
  const upload=master.waitForResponse(response=>response.url().includes('/upload?'));
  await master.locator('#uploadButton').click();assert.equal((await upload).status(),201);
  await master.locator('#videoFile').setInputFiles({name:'invalid.mp4',mimeType:'video/mp4',buffer:Buffer.from('invalid fixture container')});
  const rejected=master.waitForResponse(response=>response.url().includes('/upload?'));
  const rejectedDialog=master.waitForEvent('dialog');
  await master.locator('#uploadButton').click();assert.equal((await rejected).status(),415);
  assert.match((await rejectedDialog).message(),/Video container does not match its type/);
  assert.equal(alerts.length,1);alerts.length=0;
  await master.goto(app.base+'/master.html?type=url');await ready(master);
  for(const url of ['https://youtu.be/abcdefghijk','https://www.youtube.com/watch?list=example&v=abcdefghijk&t=2']){
    const oldCount=streams.length;
    await master.locator('#youtubeUrlInput').fill(url);await master.locator('#streamButton').click();
    for(const page of [master,display])await page.waitForFunction(()=>document.querySelector('video').src.endsWith('/youtube/abcdefghijk')&&document.querySelector('video').readyState>=2,null,{timeout:10000});
    assert.ok(streams.length>=oldCount+2,'both clients request direct streaming URLs');
    assert.ok(streams.slice(oldCount).every(stream=>!stream.writableEnded),'both decode before upstream ends');
    assert.equal(await master.evaluate(()=>liveObjectUrls.size),0,'YouTube preview allocates no Blob URL');
    for(const stream of streams.slice(oldCount))stream.end();
    // Force a fresh source request for the second supported URL form.
    if(url.includes('youtu.be/')){
      await Promise.all([master,display].map(page=>page.locator('video').evaluate(video=>{video.removeAttribute('src');video.load()})));
    }
  }
  await master.locator('#youtubeUrlInput').fill('https://youtu.be/brokenERR00');
  await master.locator('#streamButton').click();
  for(const page of [master,display]){
    await page.waitForFunction(()=>Boolean(document.querySelector('video').error));
    await page.waitForFunction(()=>document.querySelector('#connectionStatus').textContent.includes('Не вдалося завантажити відео.'));
  }
  const recoveryStreams=streams.length;
  await master.locator('#youtubeUrlInput').fill('https://youtu.be/abcdefghijk');
  await master.locator('#streamButton').click();
  for(const page of [master,display]){
    await page.waitForFunction(()=>document.querySelector('video').readyState>=2&&!document.querySelector('video').error);
    assert.ok(!(await page.locator('#connectionStatus').textContent()).includes('Не вдалося завантажити відео.'));
  }
  for(const stream of streams.slice(recoveryStreams))stream.end();
  assert.deepEqual(errors,[]);assert.deepEqual(alerts,[]);
  console.log(JSON.stringify({browser:await browser.version(),fixtureBytes:bytes.length,replacements:20,urlCounts,memory:{description:'Chromium performance.memory JS heap estimates, without forced GC; excludes native/Blob retention and is not an RSS measurement',samples:memorySamples},cancelNoPageError:true,emptyMimeUpload:true,invalidContainerVisibleError:true,supportedYoutubeLinks:2,decodesBeforeUpstreamEnds:true,upstreamFailureVisibleBothPlayers:true,subsequentMediaClearsError:true}));
});
