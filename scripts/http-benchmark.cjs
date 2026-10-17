'use strict';

// Bounded loopback comparison, not a browser decoding or production capacity test.
// Usage: node scripts/http-benchmark.cjs [work/http-before-pr10.json]
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { createApplication } = require('../server');

const FILE_BYTES = 2 * 1024 * 1024;
const ASSET_REQUESTS = 100;
const PAUSE_MS = 10;
const ASSET_PATH = '/src/components/styles/index.css';
const percentile = (samples, quantile) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * quantile) - 1];
const milliseconds = value => Number(value.toFixed(3));

function readHttp(url, { agent, headers = {}, pauseMs = 0, onHeaders = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent, headers }, response => {
      onHeaders(response);
      let bytes = 0;
      let pause;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (pauseMs) {
          response.pause();
          pause = setTimeout(() => response.resume(), pauseMs);
        }
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Response aborted')));
      response.on('close', () => clearTimeout(pause));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes }));
    });
    request.setTimeout(10_000, () => request.destroy(new Error('Benchmark request deadline')));
    request.on('error', reject);
  });
}

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'player-http-benchmark-'));
  const mediaRoot = path.join(root, 'uploads');
  const logDirectory = path.join(root, 'logs');
  await Promise.all([fs.mkdir(mediaRoot), fs.mkdir(logDirectory)]);
  let app;
  const assetAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const mediaAgent = new http.Agent({ keepAlive: true, maxSockets: 5 });
  try {
    app = createApplication({ mediaRoot, logDirectory });
    const { port } = await app.start(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    const created = await fetch(base + '/api/sessions', { method: 'POST' });
    assert.equal(created.status, 201);
    const session = await created.json();
    const fixture = Buffer.alloc(FILE_BYTES, 0x61);
    Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex').copy(fixture);
    const form = new FormData();
    form.append('video', new Blob([fixture], { type: 'video/mp4' }), 'benchmark.mp4');
    const uploaded = await fetch(`${base}/upload?sessionId=${session.sessionId}`, {
      method: 'POST', headers: { authorization: `Bearer ${session.ownerToken}` }, body: form,
    });
    assert.equal(uploaded.status, 201);
    const media = await uploaded.json();
    for (let index = 0; index < 5; index++) await readHttp(base + ASSET_PATH, { agent: assetAgent });
    const scenarios = [];
    for (const concurrentDownloads of [1, 5]) {
      const delay = monitorEventLoopDelay({ resolution: 10 });
      delay.enable();
      let peakRss = process.memoryUsage().rss;
      const rssSample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
      const cpuStart = process.cpuUsage();
      const started = performance.now();
      let active = 0;
      const ready = [];
      const downloads = Array.from({ length: concurrentDownloads }, () => {
        let headersReady;
        ready.push(new Promise(resolve => { headersReady = resolve; }));
        active++;
        return readHttp(base + media.url, {
          agent: mediaAgent, headers: { authorization: `Bearer ${session.ownerToken}` }, pauseMs: PAUSE_MS,
          onHeaders: () => headersReady(),
        }).finally(() => { active--; headersReady(); });
      });
      // Observe failures immediately while the asset requests are running.
      const complete = Promise.all(downloads);
      complete.catch(() => {});
      try {
        await Promise.all(ready);
        const latency = [];
        let assetBytes = 0;
        let overlappedAssetRequests = 0;
        let assetHeaders;
        for (let index = 0; index < ASSET_REQUESTS; index++) {
          if (active > 0) overlappedAssetRequests++;
          const before = performance.now();
          const asset = await readHttp(base + ASSET_PATH, { agent: assetAgent });
          latency.push(performance.now() - before);
          assert.equal(asset.status, 200);
          assetBytes += asset.bytes;
          assetHeaders = { cacheControl: asset.headers['cache-control'], etag: asset.headers.etag, contentType: asset.headers['content-type'] };
        }
        const received = await complete;
        for (const download of received) {
          assert.equal(download.status, 200);
          assert.equal(download.bytes, FILE_BYTES);
        }
        const cpu = process.cpuUsage(cpuStart);
        const finalRss = process.memoryUsage().rss;
        peakRss = Math.max(peakRss, finalRss);
        scenarios.push({
          concurrentDownloads, assetRequests: ASSET_REQUESTS, overlappedAssetRequests,
          assetLatencyMs: { p50: milliseconds(percentile(latency, 0.5)), p95: milliseconds(percentile(latency, 0.95)) },
          elapsedMs: milliseconds(performance.now() - started),
          processCpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
          processRssBytes: { final: finalRss, peakSampled: peakRss },
          eventLoopDelayMs: { p95: milliseconds(delay.percentile(95) / 1e6), max: milliseconds(delay.max / 1e6) },
          bytes: { assets: assetBytes, media: received.reduce((sum, item) => sum + item.bytes, 0) }, assetHeaders,
        });
      } finally {
        clearInterval(rssSample);
        delay.disable();
      }
    }
    const result = {
      generatedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`,
      transport: 'HTTP/1.1 loopback; node:http keep-alive; asset maxSockets=1, media maxSockets=5',
      workload: { fileBytes: FILE_BYTES, fixture: 'generated MP4-signature bytes; decoding not tested', assetPath: ASSET_PATH, clientPauseAfterChunkMs: PAUSE_MS, assetRequests: ASSET_REQUESTS },
      measurementScope: 'One process contains application and client driver; CPU/RSS/event-loop include both. Responses always fetched; browser cache-hit savings are not simulated. Single short run, no production capacity claim.',
      scenarios,
    };
    const output = path.resolve(process.argv[2] || 'work/http-benchmark.json');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ output, scenarios }, null, 2));
  } finally {
    assetAgent.destroy();
    mediaAgent.destroy();
    if (app) await app.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
