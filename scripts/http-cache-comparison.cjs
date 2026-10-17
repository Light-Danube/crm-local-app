'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { Module } = require('node:module');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const sourcePath = path.resolve(__dirname, '../server.js');
const baselineRef = process.env.BASELINE_REF;
if (!baselineRef) throw new Error('Set BASELINE_REF to the pre-change commit to compare');
const beforeSource = execFileSync('git', ['show', `${baselineRef}:server.js`], { cwd: path.dirname(sourcePath), encoding: 'utf8' });
function factory(source) {
  const compiled = new Module(sourcePath, module);
  compiled.filename = sourcePath;
  compiled.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  compiled._compile(source, sourcePath);
  return compiled.exports.createApplication;
}
const quantile = (samples, q) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * q) - 1];
const median = samples => {
  const sorted = [...samples].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2;
};
function read(url, agent, headers = {}, onHeaders, slow = false) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent, headers }, res => {
      onHeaders?.();
      let bytes = 0;
      let pause;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (slow) { res.pause(); pause = setTimeout(() => res.resume(), 10); }
      });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Aborted')));
      res.on('close', () => clearTimeout(pause));
      res.on('end', () => resolve({ bytes, status: res.statusCode, cacheControl: res.headers['cache-control'] }));
    });
    req.setTimeout(10000, () => req.destroy(new Error('Deadline')));
    req.on('error', reject);
  });
}
async function setup(createApplication, root, label) {
  const mediaRoot = path.join(root, label, 'uploads');
  const logDirectory = path.join(root, label, 'logs');
  await Promise.all([fs.mkdir(mediaRoot, { recursive: true }), fs.mkdir(logDirectory, { recursive: true })]);
  const app = createApplication({ mediaRoot, logDirectory });
  const { port } = await app.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const created = await fetch(base + '/api/sessions', { method: 'POST' });
  assert.equal(created.status, 201);
  const session = await created.json();
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x61);
  Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex').copy(bytes);
  const form = new FormData();
  form.append('video', new Blob([bytes], { type: 'video/mp4' }), 'fixture.mp4');
  const uploaded = await fetch(`${base}/upload?sessionId=${session.sessionId}`, { method: 'POST', headers: { authorization: `Bearer ${session.ownerToken}` }, body: form });
  assert.equal(uploaded.status, 201);
  const media = await uploaded.json();
  return { app, base, media, session, assetAgent: new http.Agent({ keepAlive: true, maxSockets: 1 }), mediaAgent: new http.Agent({ keepAlive: true, maxSockets: 5 }) };
}
async function scenario(variant, concurrentDownloads) {
  let active = concurrentDownloads;
  const readiness = [];
  const downloads = Array.from({ length: concurrentDownloads }, () => {
    let resolve;
    readiness.push(new Promise(done => { resolve = done; }));
    return read(variant.base + variant.media.url, variant.mediaAgent, { authorization: `Bearer ${variant.session.ownerToken}` }, resolve, true).finally(() => { active--; resolve(); });
  });
  const complete = Promise.all(downloads);
  complete.catch(() => {});
  await Promise.all(readiness);
  const latency = [];
  let overlapped = 0;
  let assetBytes = 0;
  let cacheControl;
  for (let index = 0; index < 100; index++) {
    if (active) overlapped++;
    const start = performance.now();
    const response = await read(variant.base + '/src/components/styles/index.css', variant.assetAgent);
    latency.push(performance.now() - start);
    assert.equal(response.status, 200);
    assetBytes += response.bytes;
    cacheControl = response.cacheControl;
  }
  const media = await complete;
  for (const response of media) { assert.equal(response.status, 200); assert.equal(response.bytes, 2 * 1024 * 1024); }
  return { concurrentDownloads, assetLatencyMs: { p50: quantile(latency, 0.5), p95: quantile(latency, 0.95) }, overlappedAssetRequests: overlapped, bytes: { assets: assetBytes, media: media.reduce((sum, response) => sum + response.bytes, 0) }, cacheControl };
}
async function main() {
  const afterSource = await fs.readFile(sourcePath, 'utf8');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'http-cache-abba-'));
  const variants = {};
  try {
    variants.before = await setup(factory(beforeSource), root, 'before');
    variants.after = await setup(factory(afterSource), root, 'after');
    // Warm the full workload on both factories; subsequent cycles balance order ABBA.
    for (const concurrency of [1, 5]) for (const label of ['before', 'after']) await scenario(variants[label], concurrency);
    const samples = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const concurrentDownloads of [1, 5]) {
        for (const label of ['before', 'after', 'after', 'before']) {
          samples.push({ cycle, variant: label, ...await scenario(variants[label], concurrentDownloads) });
        }
      }
    }
    const comparisons = [1, 5].map(concurrency => {
      const data = label => samples.filter(sample => sample.variant === label && sample.concurrentDownloads === concurrency).map(sample => sample.assetLatencyMs);
      const before = data('before');
      const after = data('after');
      return { concurrentDownloads: concurrency, beforeP95Ms: before.map(sample => sample.p95), afterP95Ms: after.map(sample => sample.p95), medianP95Ms: { before: median(before.map(sample => sample.p95)), after: median(after.map(sample => sample.p95)) }, medianP50Ms: { before: median(before.map(sample => sample.p50)), after: median(after.map(sample => sample.p50)) }, changeMedianP95Percent: (median(after.map(sample => sample.p95)) / median(before.map(sample => sample.p95)) - 1) * 100 };
    });
    const result = { generatedAt: new Date().toISOString(), node: process.version, methodology: 'One Node process, two isolated applications compiled from BASELINE_REF and current source, fully warmed; 3 ABBA cycles per concurrency, six samples per variant; max5 concurrent downloads globally, each2MiB signaturefixture; 100sequentialCSS requests persample; media client pauses10ms/chunk. Driver/server share CPU and event loop. No browser cache hits simulated.', sourceSha256: { before: createHash('sha256').update(beforeSource).digest('hex'), after: createHash('sha256').update(afterSource).digest('hex') }, comparisons, samples };
    const output = path.resolve(process.argv[2] || 'work/http-cache-comparison.json');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(comparisons, null, 2));
  } finally {
    for (const variant of Object.values(variants)) { variant.assetAgent.destroy(); variant.mediaAgent.destroy(); await variant.app.stop(); }
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
