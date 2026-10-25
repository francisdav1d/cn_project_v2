'use strict';
/**
 * Receiver side of Selective Repeat ARQ.
 *
 *  - Checks the CRC-32 of every packet. A damaged packet is discarded and a NAK asks the sender
 *    for that packet immediately.
 *  - Accepts correct packets even when earlier ones are missing and buffers them (up to the
 *    receive window), acknowledging each one individually, duplicates included.
 *  - Writes data to disk strictly in order once a gap is filled, hashing it on the way, and
 *    checks the SHA-256 against the sender's when the transfer finishes.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('./protocol');
const { R, StateGrid } = require('./telemetry');

const BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_RWND = 4096;
const IDLE_GIVE_UP_MS = 30000;

class ReceiveSession extends EventEmitter {
  constructor({ id, offer, from, socket, dir, log, loopback }) {
    super();
    this.id = id;
    this.offer = offer;
    this.from = from;               // { address, port, name }
    this.socket = socket;
    this.dir = dir;
    this.log = log;
    this.loopback = loopback;
    this.total = offer.total;
    this.chunk = offer.chunk;
    this.rwnd = Math.max(1, Math.min(MAX_RWND, Math.floor(BUFFER_BYTES / offer.chunk)));

    this.phase = 'pending';
    this.error = null;
    this.result = null;
    this.createdAt = P.nowMs();
    this.startedAt = 0;
    this.finishedAt = 0;
    this.lastPacket = 0;

    this.grid = null;
    this.buffer = new Map();
    this.expected = 0;
    this.m = {
      frames: 0, unique: 0, duplicates: 0, crcErrors: 0, outOfOrder: 0,
      acks: 0, naks: 0, maxBuffered: 0, bytes: 0,
    };
    this.chart = [];                // [t, goodput pkt/s, buffered]
    this.chartSent = 0;
    this.rate = [];
    this.stream = null;
    this.hash = null;
    this.finalPath = null;
    this.partPath = null;
    this.watchdog = null;
    this.reply = null;              // last control reply, re-sent on duplicate requests
  }

  // ---------------------------------------------------------------- lifecycle

  accept() {
    if (this.phase !== 'pending') return;
    fs.mkdirSync(this.dir, { recursive: true });
    this.finalPath = uniquePath(this.dir, this.offer.name);
    this.partPath = `${this.finalPath}.arqpart`;
    this.stream = fs.createWriteStream(this.partPath, { flags: 'wx' });
    this.stream.on('error', (err) => this.fail(`Cannot write file: ${err.message}`, true));
    this.hash = crypto.createHash('sha256');
    this.grid = new StateGrid(this.total);
    this.phase = 'receiving';
    this.startedAt = this.lastPacket = P.nowMs();
    this.watchdog = setInterval(() => {
      if (this.phase === 'receiving' && P.nowMs() - this.lastPacket > IDLE_GIVE_UP_MS) {
        this.fail('Sender stopped sending', true);
      }
    }, 2000);
    this.reply = P.encodeJson(P.T.ACCEPT, this.id, { rwnd: this.rwnd });
    this.raw(this.reply);
    this.log.info('rx', 'INFO', `Receiving ${this.offer.name} (${this.total} packets) from ${this.from.name} → ${this.finalPath}`);
    this.emit('change', this);
  }

  decline() {
    if (this.phase !== 'pending') return;
    this.phase = 'declined';
    this.reply = P.encode(P.T.DECLINE, this.id, 0, 0, 0, 0);
    this.raw(this.reply);
    this.log.info('rx', 'INFO', `Declined ${this.offer.name} from ${this.from.name}`);
    this.emit('change', this);
    this.emit('end', this);
  }

  cancel() {
    this.fail('Cancelled by you', true, 'cancelled');
  }

  fail(reason, tellSender, phase = 'failed') {
    if (this.phase !== 'receiving' && this.phase !== 'pending') return;
    this.phase = phase;
    this.error = reason;
    this.finishedAt = P.nowMs();
    if (tellSender) {
      const frame = P.encode(P.T.CANCEL, this.id, 0, 1, 0, 0);
      for (let i = 0; i < 3; i++) this.raw(frame);
    }
    this.cleanup(true);
    this.log.info('rx', phase === 'failed' ? 'ERROR' : 'INFO', `Receive ${phase}: ${reason}`);
    this.emit('change', this);
    this.emit('end', this);
  }

  cleanup(removePart) {
    clearInterval(this.watchdog);
    this.buffer.clear();
    if (this.stream) {
      const part = this.partPath;
      this.stream.destroy();
      this.stream = null;
      if (removePart && part) fs.rm(part, { force: true }, () => {});
    }
  }

  // ---------------------------------------------------------------- inbound frames

  handle(frame, rinfo) {
    if (rinfo.address !== this.from.address) return;
    switch (frame.type) {
      case P.T.OFFER: if (this.reply) this.raw(this.reply); return;
      case P.T.DATA: return this.onData(frame, rinfo);
      case P.T.FIN: return frame.crcOk && this.onFin(frame);
      case P.T.CANCEL: return this.fail('Sender cancelled the transfer', false, 'cancelled');
    }
  }

  onData(frame, rinfo) {
    if (this.phase !== 'receiving') {
      // Late duplicates after completion still need an ACK, or the sender keeps retrying.
      if (this.phase === 'complete' && frame.crcOk && frame.seq < this.total) this.ack(frame, rinfo, P.F.DUP);
      return;
    }
    const seq = frame.seq;
    if (seq >= this.total) return;
    this.lastPacket = P.nowMs();
    this.m.frames++;

    if (!frame.crcOk) {
      this.m.crcErrors++;
      if (this.grid.get(seq) === R.NONE) this.grid.set(seq, R.REJECTED);
      this.m.naks++;
      this.send(P.encode(P.T.NAK, this.id, seq, this.expected, frame.ts, 0), rinfo);
      if (this.log.want(true)) this.log.push('rx', 'CRC_FAIL', `P${seq} failed CRC-32 check → discarded, NAK ${seq} sent`, true);
      return;
    }

    if (seq < this.expected || this.buffer.has(seq)) {
      this.m.duplicates++;
      if (this.log.want(true)) this.log.push('rx', 'DUPLICATE', `Duplicate P${seq} (its ACK was lost or late) → ACK ${seq} sent again`, true);
      return this.ack(frame, rinfo, P.F.DUP);
    }
    if (seq >= this.expected + this.rwnd) return;   // beyond the receive window

    this.m.unique++;
    const expectedBefore = this.expected;
    if (seq === this.expected) {
      this.write(seq, frame.payload);
      while (this.buffer.has(this.expected)) {
        const data = this.buffer.get(this.expected);
        this.buffer.delete(this.expected);
        this.write(this.expected, data);
      }
      if (this.expected - expectedBefore > 1) {
        if (this.log.want(true)) this.log.push('rx', 'DELIVERED', `Gap filled → P${expectedBefore}..P${this.expected - 1} delivered in order`, true);
      } else if (this.log.want(false)) {
        this.log.push('rx', 'RECEIVED', `P${seq} received correctly → ACK ${seq}`, false);
      }
    } else {
      this.buffer.set(seq, frame.payload);
      this.grid.set(seq, R.BUFFERED);
      this.m.outOfOrder++;
      if (this.buffer.size > this.m.maxBuffered) this.m.maxBuffered = this.buffer.size;
      if (this.log.want(true)) this.log.push('rx', 'BUFFERED', `P${seq} out of order → buffered, ACK ${seq} (still waiting for P${this.expected})`, true);
    }
    this.ack(frame, rinfo, 0);
  }

  write(seq, data) {
    this.grid.set(seq, R.DELIVERED);
    this.expected = seq + 1;
    if (data.length) {
      this.stream.write(data);
      this.hash.update(data);
      this.m.bytes += data.length;
    }
  }

  ack(frame, rinfo, flags) {
    this.m.acks++;
    this.send(P.encode(P.T.ACK, this.id, frame.seq, this.expected, frame.ts, flags), rinfo);
  }

  onFin(frame) {
    if (this.phase === 'complete' || this.phase === 'verifying') {
      if (this.reply) this.raw(this.reply);
      return;
    }
    if (this.phase !== 'receiving') return;
    const info = P.parseJson(frame) || {};
    if (this.expected < this.total) {
      this.raw(P.encodeJson(P.T.FIN_ACK, this.id, { ok: false, reason: `receiver only has ${this.expected}/${this.total} packets` }));
      return;
    }
    this.phase = 'verifying';
    this.finishedAt = P.nowMs();
    clearInterval(this.watchdog);
    const stream = this.stream;
    this.stream = null;
    stream.end(() => {
      const digest = this.hash.digest('hex');
      const verified = !!info.sha256 && digest === info.sha256 && this.m.bytes === this.offer.size;
      fs.rename(this.partPath, this.finalPath, (err) => {
        if (err) return this.fail(`Cannot finalise file: ${err.message}`, true);
        this.phase = 'complete';
        const secs = (this.finishedAt - this.startedAt) / 1000;
        this.result = { verified, sha256: digest, path: this.finalPath, seconds: secs, mbps: secs > 0 ? this.m.bytes / secs / 1e6 : 0 };
        this.reply = P.encodeJson(P.T.FIN_ACK, this.id, { ok: true, verified, savedAs: path.basename(this.finalPath) });
        this.raw(this.reply);
        this.log.info('rx', verified ? 'DONE' : 'ERROR', verified
          ? `Saved ${path.basename(this.finalPath)}. SHA-256 matches the sender's: byte-for-byte identical.`
          : `Saved ${path.basename(this.finalPath)}, but the SHA-256 does NOT match the sender's.`);
        this.emit('change', this);
        this.emit('end', this);
      });
    });
  }

  send(buf, rinfo) {
    this.socket.send(buf, rinfo.port, rinfo.address, noop);
  }

  raw(buf) {
    this.socket.send(buf, this.from.port, this.from.address, noop);
  }

  // ---------------------------------------------------------------- telemetry

  elapsedSec() {
    if (!this.startedAt) return 0;
    return ((this.finishedAt || P.nowMs()) - this.startedAt) / 1000;
  }

  rollingRate() {
    const now = P.nowMs();
    const r = this.rate;
    r.push([now, this.expected]);
    while (r.length > 2 && now - r[0][0] > 1000) r.shift();
    if (this.finishedAt) return 0;
    const dt = (r[r.length - 1][0] - r[0][0]) / 1000;
    return dt > 0 ? (r[r.length - 1][1] - r[0][1]) / dt : 0;
  }

  metrics() {
    const m = this.m;
    const elapsed = this.elapsedSec();
    const pktRate = this.rollingRate();
    return {
      delivered: this.expected, total: this.total,
      deliveryRate: 100 * this.expected / this.total,
      throughputPkt: pktRate, throughputMB: pktRate * this.chunk / 1e6,
      avgMB: elapsed > 0 ? m.bytes / elapsed / 1e6 : 0,
      elapsed,
      frames: m.frames, unique: m.unique, duplicates: m.duplicates, crcErrors: m.crcErrors,
      outOfOrder: m.outOfOrder, acks: m.acks, naks: m.naks,
      buffered: this.buffer.size, maxBuffered: m.maxBuffered, rwnd: this.rwnd, bytes: m.bytes,
    };
  }

  header() {
    return {
      id: this.id, kind: 'rx', phase: this.phase, error: this.error, result: this.result,
      loopback: this.loopback,
      file: { name: this.offer.name, size: this.offer.size, total: this.total, chunk: this.chunk },
      from: { name: this.from.name, address: this.from.address },
      expected: this.expected, buffered: this.buffer.size,
    };
  }

  tick() {
    const metrics = this.metrics();
    if (this.phase === 'receiving' || this.phase === 'verifying') {
      this.chart.push([this.elapsedSec(), Math.round(metrics.throughputPkt), this.buffer.size]);
    }
    const out = {
      ...this.header(), metrics,
      cells: this.grid ? this.grid.drain() : [],
      chart: this.chart.slice(this.chartSent),
    };
    this.chartSent = this.chart.length;
    return out;
  }

  snapshot() {
    return {
      ...this.header(), metrics: this.metrics(),
      grid: this.grid ? this.grid.snapshot() : null,
      chart: this.chart.slice(0, this.chartSent),
    };
  }
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Turns a name chosen by a remote peer into a safe file name inside `dir`. */
function safeName(name) {
  let n = path.basename(String(name || 'file').replace(/\\/g, '/'));
  n = n.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  if (!n) n = 'file';
  if (RESERVED.test(n)) n = `_${n}`;
  if (n.length > 180) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n;
}

function uniquePath(dir, name) {
  const clean = safeName(name);
  const ext = path.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  for (let i = 0; i < 10000; i++) {
    const candidate = path.join(dir, i === 0 ? clean : `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate) && !fs.existsSync(`${candidate}.arqpart`)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

/** Checks an OFFER from the network before anything is created for it. */
function validOffer(o) {
  return o && typeof o.name === 'string' && o.name.length > 0 && o.name.length < 1024
    && Number.isSafeInteger(o.size) && o.size >= 0
    && Number.isInteger(o.chunk) && o.chunk >= 64 && o.chunk <= 65000
    && o.total === Math.max(1, Math.ceil(o.size / o.chunk)) && o.total < 0xffffffff
    && (o.sha256 === undefined || /^[0-9a-f]{64}$/.test(o.sha256));
}

function noop() {}

module.exports = { ReceiveSession, validOffer, safeName, uniquePath };
