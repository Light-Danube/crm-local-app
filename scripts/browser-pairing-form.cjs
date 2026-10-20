'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { fixture } = require('../test/helpers');

async function ready(page) { await page.waitForFunction(() => playerSession.isReady()); }
async function codeReady(page) { await page.locator('#pairingCode').waitFor({state:'visible'}); await page.waitForFunction(()=>!document.querySelector('#pairingCode').disabled&&!document.querySelector('#connectToMasterButton').disabled); }
async function enter(page, code) { await page.locator('#pairingCode').fill(code); await page.locator('#pairingCode').press('Enter'); }

test('inline pairing validates locally, preserves zeroes, handles capacity and recovers without dialogs', {timeout:60000}, async t => {
  let browser;
  const app = await fixture({after:cleanup=>t.after(async()=>{await browser?.close();await cleanup()})}, {sessionOptions:{maxDisplays:1,maxPairingAttempts:20}});
  const owner = await app.createSession();
  await app.connectController(owner);
  const packets = [];
  let dropNextPairing = false;
  let confirmDroppedPairing;
  app.io.of('/playerControls').on('connection', socket => {
    const handlers = socket.listeners('connectToMaster');
    socket.removeAllListeners('connectToMaster');
    socket.on('connectToMaster', code => {
      packets.push(code);
      if (dropNextPairing) { dropNextPairing = false; confirmDroppedPairing(); return; }
      for (const handler of handlers) handler.call(socket, code);
    });
  });
  browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const context = await browser.newContext({viewport:{width:320,height:760},reducedMotion:'reduce'});
  const displayPath = '/video';
  const first = await context.newPage(), second = await context.newPage();
  const dialogs = [], errors = [];
  for (const page of [first,second]) {
    page.on('dialog', async dialog=>{dialogs.push(dialog.type());await dialog.dismiss()});
    page.on('pageerror', error=>errors.push(error.message));
  }
  await first.goto(app.base+displayPath); await codeReady(first);
  assert.equal(await first.locator('#pairingCode').getAttribute('type'), 'text');
  assert.equal(await first.locator('#pairingCode').getAttribute('inputmode'), 'numeric');
  assert.equal(await first.locator('.pairing-card').evaluate(el=>getComputedStyle(el).animationName), 'none');
  assert.equal(await first.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth), true);
  await first.locator('#pairingCode').focus();
  assert.equal(await first.locator('#pairingCode').evaluate(el=>getComputedStyle(el).outlineStyle), 'solid');
  await enter(first, '12a');
  assert.equal(packets.length, 0, 'local validation sends no pairing attempt');
  assert.match(await first.locator('#pairingError').textContent(), /рівно 6 цифр/);
  assert.equal(await first.locator('#pairingCode').getAttribute('aria-invalid'), 'true');
  const invalidCode = owner.pairingCode === '000000' ? '000001' : '000000';
  await first.locator('#pairingCode').evaluate((input, code) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text', code.slice(0, 3) + ' ' + code.slice(3));
    input.dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData}));
  }, invalidCode);
  assert.equal(await first.locator('#pairingCode').inputValue(), invalidCode);
  await first.locator('#pairingCode').press('Enter');
  await first.waitForFunction(()=>document.querySelector('#pairingError').textContent.includes('Код не знайдено'));
  assert.equal(packets.at(-1), invalidCode, 'leading zeroes reach the server as a six-character string');
  await enter(first, owner.pairingCode); await ready(first);
  assert.equal(await first.locator('#pairingPanel').isVisible(), false);
  const identity = await first.evaluate(()=>JSON.parse(sessionStorage.getItem('displaySession')).displayId);
  await second.goto(app.base+displayPath); await codeReady(second);
  await enter(second, owner.pairingCode);
  await second.waitForFunction(()=>document.querySelector('#pairingError').textContent.includes('Усі місця'));
  assert.equal(await second.locator('#pairingCode').getAttribute('aria-invalid'), 'false');
  const revoke = id=>fetch(`${app.base}/api/sessions/${owner.sessionId}/displays/${id}`,{method:'DELETE',headers:{authorization:`Bearer ${owner.ownerToken}`}});
  assert.equal((await revoke(identity)).status,204);
  await first.locator('#resetSession').waitFor({state:'visible'});
  await enter(second, owner.pairingCode); await ready(second);
  const beforeReload = packets.length;
  await second.reload(); await ready(second);
  assert.equal(await second.locator('#pairingPanel').isVisible(), false);
  assert.equal(packets.length, beforeReload, 'credential reconnect does not submit a pairing code');
  await first.locator('#resetSession').click(); await codeReady(first);
  assert.equal(await first.evaluate(()=>sessionStorage.getItem('displaySession')),null);
  await first.clock.install();
  dropNextPairing = true;
  const droppedPairing = new Promise(resolve => { confirmDroppedPairing = resolve; });
  await enter(first, owner.pairingCode);
  await droppedPairing;
  await first.waitForFunction(() => document.querySelector('#pairingForm').getAttribute('aria-busy') === 'true');
  assert.equal(await first.locator('#connectToMasterButton').isDisabled(), true);
  await first.clock.fastForward(10001);
  await first.clock.resume();
  assert.match(await first.locator('#pairingError').textContent(), /Сервер не підтвердив приєднання/);
  assert.equal(await first.locator('#pairingCode').isEnabled(), true);
  assert.equal(await first.locator('#connectToMasterButton').isEnabled(), true);
  const beforeOffline = packets.length;
  await context.setOffline(true);
  await first.evaluate(()=>socket.io.engine.close());
  await first.waitForFunction(()=>!socket.connected);
  assert.match(await first.locator('#pairingConnection').textContent(), /Немає з’єднання/);
  await first.locator('#pairingCode').fill(owner.pairingCode);
  await first.locator('#pairingForm').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  assert.match(await first.locator('#pairingError').textContent(), /Немає з’єднання/);
  assert.equal(packets.length,beforeOffline);
  await context.setOffline(false); await codeReady(first);
  assert.equal(packets.length,beforeOffline, 'offline submission is not replayed');
  assert.deepEqual(dialogs,[]); assert.deepEqual(errors,[]);
});
