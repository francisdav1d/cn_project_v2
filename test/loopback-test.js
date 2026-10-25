'use strict';
/**
 * Headless end-to-end check: two engines on this machine (as if they were two devices) send a
 * random file to each other over real UDP sockets under several impairment profiles, and the
 * received file must match the original byte for byte.
 *
 *   node test/loopback-test.js [sizeMB]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Engine } = require('../lib/engine');

const SIZE_MB = Number(process.argv[2] || 4);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'arq-beam-test-'));

const profiles = [
  { name: 'clean', impair: { preset: 'clean' } },
  { name: 'lossy 10% + corrupt 5% + ack loss', impair: { loss: 0.10, corrupt: 0.05, jitter: 0, capacity: 0, ackLoss: true } },
  { name: 'jitter 30ms (reordering)', impair: { loss: 0.02, corrupt: 0.01, jitter: 30, capacity: 0, ackLoss: true } },
  { name: 'congested, capacity 24', impair: { loss: 0, corrupt: 0, jitter: 5, capacity: 24, severity: 0.8, ackLoss: true } },
];

async function main() {
  const src = path.join(work, 'source.bin');
  fs.writeFileSync(src, crypto.randomBytes(SIZE_MB * 1024 * 1024));
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
  const file = { path: src, name: 'source.bin', size: fs.statSync(src).size, sha256 };

  const a = new Engine({ dataPort: 48801, downloadDir: path.join(work, 'a'), name: 'A' });
  const b = new Engine({ dataPort: 48851, downloadDir: path.join(work, 'b'), name: 'B' });
  await a.start();
  await b.start();
  b.autoAccept = true;
  setInterval(() => { a.log.drain(); b.log.drain(); }, 100);

  let failed = 0;
  for (const p of profiles) {
    a.setImpair(p.impair);
    const t0 = Date.now();
    const tx = a.send(file, { address: '127.0.0.1', port: b.dataPort, name: 'B' });
    const ticker = setInterval(() => { tx.tick(); tx.rxView.drain(); if (b.rx) b.rx.tick(); }, 66);
    await new Promise((resolve) => tx.once('end', resolve));
    clearInterval(ticker);
    const rx = b.rx;
    const m = tx.metrics();
    const ok = tx.phase === 'done' && tx.result.verified && rx.result
      && crypto.createHash('sha256').update(fs.readFileSync(rx.result.path)).digest('hex') === sha256;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${p.name.padEnd(36)} ${((Date.now() - t0) / 1000).toFixed(2)}s  ` +
      `${m.avgMB.toFixed(1)} MB/s  tx=${m.transmissions} retx=${m.retransmissions} lost=${m.lost} corrupt=${m.corrupted} ` +
      `timeouts=${m.timeouts} naks=${m.naks} acksLost=${m.acksLost} dup=${m.duplicates} ` +
      `W avg=${m.avgWindow.toFixed(1)} min/max=${m.minWindow}/${m.maxWindow} +${m.increases}/-${m.decreases} ` +
      `rtt=${m.avgRtt.toFixed(2)}ms rto=${m.rto.toFixed(0)}ms ooo=${rx.m.outOfOrder} maxBuf=${rx.m.maxBuffered}` +
      (ok ? '' : `  phase=${tx.phase} err=${tx.error}`));
  }
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
