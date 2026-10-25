'use strict';
/**
 * Sender side of Selective Repeat ARQ over UDP, with the adaptive window and the network
 * impairment emulator.
 *
 *  - The file is cut into packets of `chunk` bytes, each with a sequence number and CRC-32.
 *  - Up to W packets may be outstanding: [base, base + W - 1]. W is set by AdaptiveWindow.
 *  - Every outstanding packet has its own timer (RTO from RFC 6298). On a timeout or a NAK only
 *    that packet is sent again.
 *  - Before a frame touches the real socket it passes the emulator, which can drop it (random
 *    loss or congestion over the capacity limit), flip a bit, or hold it back (jitter + queueing).
 *    ACK/NAK frames coming back can be dropped the same way.
 */
const fs = require('fs');
const { EventEmitter } = require('events');
const P = require('./protocol');
const { S, R, StateGrid } = require('./telemetry');
const { AdaptiveWindow } = require('./adaptive');

const INITIAL_RTO_MS = 500;
const MIN_RTO_MS = 30;
const MAX_RTO_MS = 8000;
const QUEUE_DELAY_PER_FRAME_MS = 4;
const OFFER_RETRY_MS = 700;
const OFFER_GIVE_UP_MS = 120000;
const FIN_RETRY_MS = 250;
const FIN_MAX_TRIES = 60;
const PEER_SILENT_MS = 20000;
const TIMER_SCAN_MS = 4;
const BLOCK_BYTES = 1 << 20;

class SendSession extends EventEmitter {
  /**
   * @param {object} o
   * @param {number} o.id            random transfer id
   * @param {object} o.file          { path, name, size, sha256 }
   * @param {object} o.peer          { address, port, name }
   * @param {object} o.settings      { chunk, initialWindow, minWindow, maxWindow, adaptive }
   * @param {object} o.impair        live, shared emulator settings
   */
  constructor({ id, appId, myName, file, peer, settings, impair, socket, log }) {
    super();
    this.id = id;
    this.appId = appId;
    this.myName = myName;
    this.file = file;
    this.peer = peer;
    this.impair = impair;
    this.socket = socket;
    this.log = log;
    this.chunk = settings.chunk;
    this.total = Math.max(1, Math.ceil(file.size / this.chunk));

    this.grid = new StateGrid(this.total);
    this.rxView = new StateGrid(this.total);    // receiver as seen through its ACK/NAK feedback
    this.firstSend = new Float64Array(this.total);
    this.lastSend = new Float64Array(this.total);
    this.tries = new Uint16Array(this.total);
    this.inNet = new Uint8Array(this.total);
    this.inNetCount = 0;

    this.ctrl = new AdaptiveWindow({
      initial: settings.initialWindow,
      min: settings.minWindow,
      max: settings.maxWindow,
      enabled: settings.adaptive,
    });

    this.base = 0;
    this.next = 0;
    this.ackedAhead = 0;       // ACKed packets at or above base
    this.rxExpected = 0;       // receiver's next expected seq, from cumulative ACK info
    this.srtt = -1;
    this.rttVar = 0;
    this.rto = INITIAL_RTO_MS;

    this.phase = 'offering';
    this.paused = false;
    this.error = null;
    this.result = null;
    this.createdAt = P.nowMs();
    this.startedAt = 0;
    this.finishedAt = 0;
    this.lastFeedback = 0;

    this.m = {
      transmissions: 0, retransmissions: 0, lostRandom: 0, lostCongestion: 0, corrupted: 0,
      timeouts: 0, naks: 0, acks: 0, duplicateAcks: 0, acksLost: 0, dupAtReceiver: 0,
      uniqueReceived: 0, delaySum: 0, delayCount: 0, rttSum: 0, rttCount: 0,
    };
    this.win = {
      min: this.ctrl.window, max: this.ctrl.window, increases: 0, decreases: 0,
      area: 0, lastT: 0, last: this.ctrl.window,
    };
    this.chart = [];           // [t, window, capacity]
    this.marks = [];           // [t, kind, from, to]
    this.chartSent = 0;
    this.marksSent = 0;
    this.rate = [];            // [t, acked] samples for the rolling throughput

    this.fd = null;
    this.blocks = new Map();
    this.perBlock = Math.max(1, Math.floor(BLOCK_BYTES / this.chunk));
    this.timers = [];
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    this.fd = fs.openSync(this.file.path, 'r');
    const offer = {
      name: this.file.name, size: this.file.size, chunk: this.chunk, total: this.total,
      sha256: this.file.sha256, from: this.myName, appId: this.appId,
    };
    const frame = P.encodeJson(P.T.OFFER, this.id, offer);
    const sendOffer = () => {
      if (this.phase !== 'offering') return;
      if (P.nowMs() - this.createdAt > OFFER_GIVE_UP_MS) return this.fail('No answer from the receiver');
      this.raw(frame);
    };
    sendOffer();
    this.every(OFFER_RETRY_MS, sendOffer);
    this.log.info('tx', 'INFO', `Offering ${this.file.name} (${fmtBytes(this.file.size)}, ${this.total} packets of ${this.chunk} B) to ${this.peer.name}`);
  }

  pause() {
    if (this.phase !== 'running' || this.paused) return;
    this.paused = true;
    this.log.info('tx', 'INFO', 'Transfer paused');
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    const now = P.nowMs();
    for (let s = this.base; s < this.next; s++) this.lastSend[s] = now;   // restart every timer
    this.log.info('tx', 'INFO', 'Transfer resumed');
    this.pump();
  }

  cancel() {
    if (isFinal(this.phase)) return;
    const frame = P.encode(P.T.CANCEL, this.id, 0, 0, 0, 0);
    for (let i = 0; i < 3; i++) this.raw(frame);
    this.end('cancelled', 'Transfer cancelled');
  }

  fail(reason) {
    if (isFinal(this.phase)) return;
    this.error = reason;
    this.end('failed', `Transfer failed: ${reason}`);
  }

  end(phase, msg) {
    this.phase = phase;
    if (!this.finishedAt) this.finishedAt = P.nowMs();
    this.closeWindowStats();
    this.log.info('tx', phase === 'done' ? 'DONE' : phase === 'failed' ? 'ERROR' : 'INFO', msg);
    this.dispose();
    this.emit('end', this);
  }

  dispose() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* already closed */ }
      this.fd = null;
    }
    this.blocks.clear();
  }

  every(ms, fn) {
    this.timers.push(setInterval(fn, ms));
  }

  // ---------------------------------------------------------------- inbound frames

  handle(frame, rinfo) {
    if (rinfo.address !== this.peer.address) return;
    switch (frame.type) {
      case P.T.ACCEPT: return this.onAccept(frame);
      case P.T.DECLINE: return this.onDecline();
      case P.T.ACK:
      case P.T.NAK: return frame.crcOk && this.onFeedback(frame);
      case P.T.FIN_ACK: return this.onFinAck(frame);
      case P.T.CANCEL: return this.fail('Receiver cancelled the transfer');
    }
  }

  onAccept(frame) {
    if (this.phase !== 'offering' || !frame.crcOk) return;
    const info = P.parseJson(frame) || {};
    if (info.rwnd > 0) this.ctrl.capMax(info.rwnd);
    this.phase = 'running';
    this.startedAt = this.lastFeedback = this.win.lastT = P.nowMs();
    this.win.last = this.win.min = this.win.max = this.ctrl.window;
    this.log.info('tx', 'INFO', `${this.peer.name} accepted. Receive window ${info.rwnd || '?'} packets, starting with W = ${this.ctrl.window} (${this.ctrl.mode.toLowerCase()})`);
    this.every(TIMER_SCAN_MS, () => this.scanTimers());
    this.pump();
  }

  onDecline() {
    if (this.phase !== 'offering') return;
    this.end('declined', `${this.peer.name} declined the file`);
  }

  onFeedback(frame) {
    if (this.phase !== 'running' && this.phase !== 'finishing') return;
    const seq = frame.seq;
    if (seq >= this.total) return;
    const isNak = frame.type === P.T.NAK;
    const imp = this.impair;

    // Return path through the emulator
    const backlog = this.backlog();
    const randomLoss = imp.ackLoss && chance(imp.loss);
    if (randomLoss || chance(this.congestionDropP(backlog))) {
      this.m.acksLost++;
      if (!isNak && this.grid.get(seq) !== S.ACKED) this.grid.set(seq, S.ACK_LOST);
      if (this.log.want(true)) {
        this.log.push('tx', 'ACK_LOST', `${isNak ? 'NAK' : 'ACK'} ${seq} ${randomLoss ? 'lost on the way back' : 'dropped: network congested'}`, true);
      }
      return;
    }

    this.lastFeedback = P.nowMs();
    const rtt = P.rttFromEcho(frame.ts);
    const validRtt = rtt >= 0 && rtt < 60000;
    if (validRtt) this.updateRtt(rtt);
    this.leaveNet(seq);

    // Cumulative information: everything below the receiver's next expected seq is delivered,
    // which also settles packets whose own ACK was lost. The frame's own seq is handled below.
    const expected = Math.min(frame.aux, this.total);
    if (expected > this.rxExpected) {
      for (let s = this.rxExpected; s < expected; s++) {
        this.rxView.set(s, R.DELIVERED);
        if ((isNak || s !== seq) && this.grid.get(s) !== S.ACKED) this.markAcked(s);
      }
      this.rxExpected = expected;
    }

    if (isNak) {
      this.m.naks++;
      if (seq >= this.rxExpected && this.rxView.get(seq) === R.NONE) this.rxView.set(seq, R.REJECTED);
      this.recordFailure('nak');
      if (this.grid.get(seq) !== S.ACKED && this.phase === 'running') {
        if (this.log.want(true)) this.log.push('tx', 'NAK', `NAK ${seq}: receiver rejected a corrupted copy, resending P${seq} now`, true);
        this.transmit(seq, true);
      }
    } else {
      if (frame.flags & P.F.DUP) this.m.dupAtReceiver++;
      if (seq >= this.rxExpected) this.rxView.set(seq, R.BUFFERED);
      if (this.grid.get(seq) === S.ACKED) {
        this.m.duplicateAcks++;
      } else {
        this.m.acks++;
        this.markAcked(seq);
        if (validRtt) {
          this.m.rttSum += rtt;
          this.m.rttCount++;
          // first transmission -> first correct copy at the receiver (sent at now - rtt, one way ~ rtt/2)
          this.m.delaySum += P.nowMs() - this.firstSend[seq] - rtt / 2;
          this.m.delayCount++;
        }
        if (this.log.want(false)) this.log.push('tx', 'ACK', `ACK ${seq} received, RTT ${rtt.toFixed(1)} ms`, false);
        this.applyChange(this.ctrl.onAck(validRtt ? rtt : this.srtt));
      }
    }

    this.advanceBase();
    if (this.phase === 'running') {
      if (this.base >= this.total) this.finish();
      else this.pump();
    }
  }

  onFinAck(frame) {
    if (this.phase !== 'finishing' || !frame.crcOk) return;
    const info = P.parseJson(frame) || {};
    const secs = (this.finishedAt - this.startedAt) / 1000;
    this.result = {
      verified: !!info.verified, savedAs: info.savedAs || null,
      seconds: secs, mbps: secs > 0 ? this.file.size / secs / 1e6 : 0,
    };
    if (info.ok) {
      this.end('done', `Done: ${this.file.name} delivered in ${secs.toFixed(2)} s (${this.result.mbps.toFixed(2)} MB/s). ` +
        (info.verified ? 'Receiver verified SHA-256, byte-for-byte identical.' : 'Receiver could not verify SHA-256!'));
    } else {
      this.fail(info.reason || 'Receiver reported an incomplete file');
    }
  }

  // ---------------------------------------------------------------- sending

  pump() {
    if (this.phase !== 'running' || this.paused) return;
    const limit = Math.min(this.total, this.base + this.ctrl.window);
    while (this.next < limit) {
      this.transmit(this.next, false);
      this.next++;
    }
  }

  transmit(seq, isRetx) {
    const now = P.nowMs();
    const m = this.m;
    m.transmissions++;
    if (isRetx) {
      m.retransmissions++;
      if (this.log.want(true)) this.log.push('tx', 'RETRANSMIT', `Selective retransmission of P${seq} only (attempt ${this.tries[seq] + 1})`, true);
    } else {
      this.firstSend[seq] = now;
      if (this.log.want(false)) this.log.push('tx', 'SEND', `P${seq} sent (window ${this.base}–${this.base + this.ctrl.window - 1})`, false);
    }
    this.tries[seq]++;
    this.lastSend[seq] = now;
    this.grid.set(seq, isRetx ? S.RETX : S.SENT);

    const imp = this.impair;
    const backlog = this.backlog();
    if (chance(imp.loss)) {
      m.lostRandom++;
      this.grid.set(seq, S.LOST);
      if (this.log.want(true)) this.log.push('tx', 'LOST', `P${seq} lost in the network (random loss)`, true);
      return;
    }
    if (chance(this.congestionDropP(backlog))) {
      m.lostCongestion++;
      this.grid.set(seq, S.LOST);
      if (this.log.want(true)) this.log.push('tx', 'LOST', `P${seq} dropped: network congested (${backlog} frames over capacity)`, true);
      return;
    }

    const payload = this.readChunk(seq);
    const buf = P.encode(P.T.DATA, this.id, seq, this.total, P.nowUs32(), isRetx ? P.F.RETX : 0, payload);
    if (chance(imp.corrupt)) {
      P.corrupt(buf);
      m.corrupted++;
      this.grid.set(seq, S.CORRUPTED);
      if (this.log.want(true)) this.log.push('tx', 'CORRUPTED', `P${seq} corrupted in transit (bit error)`, true);
    }
    if (!this.inNet[seq]) {
      this.inNet[seq] = 1;
      this.inNetCount++;
    }
    const delay = (imp.jitter > 0 ? Math.random() * imp.jitter : 0) + imp.severity * backlog * QUEUE_DELAY_PER_FRAME_MS;
    if (delay >= 1) setTimeout(() => this.raw(buf), delay);
    else this.raw(buf);
  }

  scanTimers() {
    if (this.phase !== 'running' || this.paused) return;
    const now = P.nowMs();
    if (now - this.lastFeedback > PEER_SILENT_MS) return this.fail('Receiver stopped responding');
    for (let s = this.base; s < this.next; s++) {
      if (this.grid.get(s) === S.ACKED) continue;
      // Back off a packet's timer only while the receiver is silent; if feedback is still
      // arriving the path is alive and the packet was just unlucky.
      const t = this.tries[s];
      const silent = this.lastFeedback < this.lastSend[s];
      const rto = Math.min(MAX_RTO_MS, silent && t > 3 ? this.rto * 2 ** Math.min(t - 3, 6) : this.rto);
      if (now - this.lastSend[s] < rto) continue;
      this.m.timeouts++;
      this.leaveNet(s);
      if (this.log.want(true)) this.log.push('tx', 'TIMEOUT', `Timer of P${s} expired (RTO ${rto.toFixed(0)} ms), no ACK`, true);
      this.recordFailure('timeout');
      if (this.phase !== 'running') return;
      this.transmit(s, true);
    }
  }

  finish() {
    this.phase = 'finishing';
    this.finishedAt = P.nowMs();
    this.closeWindowStats();
    this.log.info('tx', 'INFO', `All ${this.total} packets acknowledged. Asking receiver to verify the file…`);
    const frame = P.encodeJson(P.T.FIN, this.id, { total: this.total, size: this.file.size, sha256: this.file.sha256 });
    let tries = 0;
    const sendFin = () => {
      if (this.phase !== 'finishing') return;
      if (++tries > FIN_MAX_TRIES) return this.fail('Receiver did not confirm the finished file');
      this.raw(frame);
    };
    sendFin();
    this.every(FIN_RETRY_MS, sendFin);
  }

  raw(buf) {
    this.socket.send(buf, this.peer.port, this.peer.address, noop);
  }

  // ---------------------------------------------------------------- bookkeeping

  markAcked(seq) {
    this.grid.set(seq, S.ACKED);
    this.ackedAhead++;
    this.m.uniqueReceived++;
    this.leaveNet(seq);
  }

  advanceBase() {
    const before = this.base;
    while (this.base < this.total && this.grid.get(this.base) === S.ACKED) {
      this.base++;
      this.ackedAhead--;
    }
    if (this.base !== before) {
      const keep = Math.floor(this.base / this.perBlock);
      for (const k of this.blocks.keys()) if (k < keep) this.blocks.delete(k);
    }
  }

  leaveNet(seq) {
    if (this.inNet[seq]) {
      this.inNet[seq] = 0;
      this.inNetCount--;
    }
  }

  backlog() {
    const cap = this.impair.capacity;
    return cap > 0 ? Math.max(0, this.inNetCount + 1 - cap) : 0;
  }

  congestionDropP(backlog) {
    return backlog === 0 ? 0 : this.impair.severity * backlog / (this.inNetCount + 1);
  }

  updateRtt(sample) {
    if (this.srtt < 0) {
      this.srtt = sample;
      this.rttVar = sample / 2;
    } else {
      this.rttVar = 0.75 * this.rttVar + 0.25 * Math.abs(this.srtt - sample);
      this.srtt = 0.875 * this.srtt + 0.125 * sample;
    }
    this.rto = Math.max(MIN_RTO_MS, Math.min(MAX_RTO_MS, this.srtt + 4 * this.rttVar));
  }

  recordFailure(kind) {
    const t = this.elapsedSec();
    if (this.marks.length < 20000) this.marks.push([t, kind, 0, 0]);
    this.applyChange(this.ctrl.onFailure());
  }

  applyChange(change) {
    if (!change) return;
    const now = P.nowMs();
    const w = this.win;
    w.area += (now - w.lastT) * w.last;
    w.lastT = now;
    w.last = change.to;
    w.min = Math.min(w.min, change.to);
    w.max = Math.max(w.max, change.to);
    if (change.to > change.from) w.increases++; else w.decreases++;
    if (change.to < change.from) this.marks.push([this.elapsedSec(), change.kind, change.from, change.to]);
    const important = change.to < change.from;
    if (this.log.want(important)) {
      this.log.push('tx', 'WINDOW', `Window ${change.from} → ${change.to}  [failures ${pct(change.failureRate)} (normal ${pct(change.normal)}), delay ×${change.delayRatio.toFixed(2)}]  ${change.verdict}`, important);
    }
    this.pump();
  }

  closeWindowStats() {
    const w = this.win;
    if (!w.lastT) return;
    const now = this.finishedAt || P.nowMs();
    w.area += (now - w.lastT) * w.last;
    w.lastT = now;
  }

  readChunk(seq) {
    const blockIdx = Math.floor(seq / this.perBlock);
    let blk = this.blocks.get(blockIdx);
    if (!blk) {
      const offset = blockIdx * this.perBlock * this.chunk;
      const len = Math.max(0, Math.min(this.perBlock * this.chunk, this.file.size - offset));
      blk = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(this.fd, blk, got, len - got, offset + got);
        if (n === 0) break;
        got += n;
      }
      this.blocks.set(blockIdx, blk);
    }
    const rel = (seq - blockIdx * this.perBlock) * this.chunk;
    return blk.subarray(rel, Math.min(rel + this.chunk, blk.length));
  }

  elapsedSec() {
    if (!this.startedAt) return 0;
    return ((this.finishedAt || P.nowMs()) - this.startedAt) / 1000;
  }

  // ---------------------------------------------------------------- telemetry

  metrics() {
    const m = this.m;
    const elapsed = this.elapsedSec();
    const now = P.nowMs();
    const w = this.win;
    const spanMs = w.lastT ? (this.finishedAt || now) - this.startedAt : 0;
    const area = w.area + (this.finishedAt ? 0 : (now - (w.lastT || now)) * w.last);
    const delivered = this.rxExpected;
    const pktRate = this.rollingRate();
    return {
      delivered, total: this.total,
      deliveryRate: 100 * delivered / this.total,
      throughputPkt: pktRate,
      throughputMB: pktRate * this.chunk / 1e6,
      avgMB: elapsed > 0 ? Math.min(this.file.size, delivered * this.chunk) / elapsed / 1e6 : 0,
      elapsed,
      transmissions: m.transmissions, retransmissions: m.retransmissions,
      lost: m.lostRandom + m.lostCongestion, lostRandom: m.lostRandom, lostCongestion: m.lostCongestion,
      corrupted: m.corrupted, timeouts: m.timeouts, naks: m.naks, acksLost: m.acksLost,
      duplicates: m.dupAtReceiver,
      lossRate: m.transmissions ? 100 * (m.lostRandom + m.lostCongestion) / m.transmissions : 0,
      efficiency: m.transmissions ? 100 * m.uniqueReceived / m.transmissions : 0,
      avgDelay: m.delayCount ? m.delaySum / m.delayCount : 0,
      avgRtt: m.rttCount ? m.rttSum / m.rttCount : 0,
      srtt: Math.max(0, this.srtt), rto: this.rto,
      mode: this.ctrl.mode, window: this.ctrl.window,
      avgWindow: spanMs > 0 ? area / spanMs : this.ctrl.window,
      minWindow: w.min, maxWindow: w.max, increases: w.increases, decreases: w.decreases,
      lastFailure: 100 * this.ctrl.lastFailureRate,
      normalFailure: 100 * Math.max(0, this.ctrl.normalFailureRate),
      delayRatio: this.ctrl.lastDelayRatio,
    };
  }

  rollingRate() {
    const now = P.nowMs();
    const r = this.rate;
    r.push([now, this.rxExpected]);
    while (r.length > 2 && now - r[0][0] > 1000) r.shift();
    if (this.finishedAt) return 0;
    const dt = (r[r.length - 1][0] - r[0][0]) / 1000;
    return dt > 0 ? (r[r.length - 1][1] - r[0][1]) / dt : 0;
  }

  header() {
    return {
      id: this.id, kind: 'tx', phase: this.phase, paused: this.paused, error: this.error, result: this.result,
      file: { name: this.file.name, size: this.file.size, total: this.total, chunk: this.chunk },
      peer: { name: this.peer.name, address: this.peer.address, port: this.peer.port },
      base: this.base, next: this.next, window: this.ctrl.window,
      outstanding: this.next - this.base - this.ackedAhead, inNet: this.inNetCount,
      rxExpected: this.rxExpected, capacity: this.impair.capacity,
    };
  }

  /** Per-tick delta for the UI. */
  tick() {
    if (this.phase === 'running' || this.phase === 'finishing') {
      this.chart.push([this.elapsedSec(), this.ctrl.window, this.impair.capacity]);
    }
    const out = {
      ...this.header(),
      metrics: this.metrics(),
      cells: this.grid.drain(),
      chart: this.chart.slice(this.chartSent),
      marks: this.marks.slice(this.marksSent),
    };
    this.chartSent = this.chart.length;
    this.marksSent = this.marks.length;
    return out;
  }

  /** Full state for a UI that connects mid-transfer. */
  snapshot() {
    return {
      ...this.header(),
      metrics: this.metrics(),
      grid: this.grid.snapshot(),
      rxGrid: this.rxView.snapshot(),
      chart: this.chart.slice(0, this.chartSent),
      marks: this.marks.slice(0, this.marksSent),
    };
  }
}

function isFinal(phase) {
  return phase === 'done' || phase === 'failed' || phase === 'cancelled' || phase === 'declined';
}

function chance(p) {
  return p > 0 && Math.random() < p;
}

function pct(x) {
  return `${(x * 100).toFixed(0)}%`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 2 : 1)} ${u[i]}`;
}

function noop() {}

module.exports = { SendSession, isFinal, fmtBytes };
