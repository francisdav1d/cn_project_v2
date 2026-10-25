'use strict';
/**
 * One UDP data socket per running app. It serves both roles at once, so a device can send and
 * receive at the same time and can send to itself over loopback.
 */
const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('./protocol');
const { EventLog } = require('./telemetry');
const { SendSession, isFinal } = require('./sender');
const { ReceiveSession, validOffer } = require('./receiver');

const PRESETS = {
  clean: { loss: 0, corrupt: 0, jitter: 0, capacity: 0, severity: 0.6, ackLoss: true },
  good: { loss: 0.02, corrupt: 0.01, jitter: 80, capacity: 16, severity: 0.3, ackLoss: true },
  moderate: { loss: 0.06, corrupt: 0.03, jitter: 220, capacity: 10, severity: 0.6, ackLoss: true },
  poor: { loss: 0.15, corrupt: 0.06, jitter: 450, capacity: 6, severity: 0.9, ackLoss: true },
};

class Engine extends EventEmitter {
  constructor({ dataPort, downloadDir, name }) {
    super();
    this.appId = crypto.randomBytes(6).toString('hex');
    this.name = name;
    this.dataPort = dataPort;
    this.downloadDir = downloadDir;
    this.log = new EventLog();
    this.impair = { ...PRESETS.clean, preset: 'clean' };
    this.settings = { chunk: 1400, initialWindow: 4, minWindow: 1, maxWindow: 512, adaptive: true };
    this.autoAccept = false;
    this.senders = new Map();
    this.receivers = new Map();
    this.tx = null;              // transfer shown on the Send side
    this.rx = null;              // transfer shown on the Receive side
    this.history = [];           // finished incoming files
  }

  async start() {
    for (let port = this.dataPort; port < this.dataPort + 20; port++) {
      try {
        this.socket = await bindUdp(port);
        this.dataPort = port;
        break;
      } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err;
      }
    }
    if (!this.socket) throw new Error('No free UDP port for data');
    try {
      this.socket.setRecvBufferSize(16 * 1024 * 1024);
      this.socket.setSendBufferSize(8 * 1024 * 1024);
    } catch { /* the OS keeps its default */ }
    this.socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
    this.socket.on('error', () => {});
  }

  onMessage(msg, rinfo) {
    const frame = P.decode(msg);
    if (!frame) return;
    const T = P.T;
    switch (frame.type) {
      case T.DATA:
      case T.FIN: {
        const rx = this.receivers.get(frame.id);
        if (rx) rx.handle(frame, rinfo);
        return;
      }
      case T.OFFER:
        return this.onOffer(frame, rinfo);
      case T.CANCEL: {
        // aux = 1: the receiver gave up, tell the sender; aux = 0: the sender gave up
        const s = frame.aux === 1 ? this.senders.get(frame.id) : this.receivers.get(frame.id);
        if (s) s.handle(frame, rinfo);
        return;
      }
      default: {
        const tx = this.senders.get(frame.id);
        if (tx) tx.handle(frame, rinfo);
      }
    }
  }

  onOffer(frame, rinfo) {
    if (!frame.crcOk) return;
    const existing = this.receivers.get(frame.id);
    if (existing) return existing.handle(frame, rinfo);
    const offer = P.parseJson(frame);
    if (!validOffer(offer)) return;
    const loopback = offer.appId === this.appId;
    const rx = new ReceiveSession({
      id: frame.id, offer, socket: this.socket, dir: this.downloadDir, log: this.log, loopback,
      from: { address: rinfo.address, port: rinfo.port, name: loopback ? 'This device' : String(offer.from || rinfo.address).slice(0, 64) },
    });
    this.receivers.set(frame.id, rx);
    rx.on('end', () => this.onReceiveEnd(rx));
    this.rx = rx;
    this.log.info('rx', 'INFO', `Incoming file ${offer.name} from ${rx.from.name} (${rinfo.address})`);
    if (this.autoAccept || loopback) rx.accept();
    this.emit('incoming', rx);
  }

  onReceiveEnd(rx) {
    if (rx.phase === 'complete') {
      this.history.unshift({
        id: rx.id, name: rx.offer.name, size: rx.offer.size, from: rx.from.name,
        path: rx.result.path, verified: rx.result.verified, seconds: rx.result.seconds, at: Date.now(),
      });
      this.history.length = Math.min(this.history.length, 30);
    }
    // Keep finished sessions around briefly to answer late duplicates, then forget them.
    setTimeout(() => {
      if (this.receivers.get(rx.id) === rx) this.receivers.delete(rx.id);
    }, 60000);
  }

  /** Starts sending a staged file. */
  send(file, peer, overrides = {}) {
    if (this.tx && !isFinal(this.tx.phase)) throw new Error('A transfer is already running');
    const settings = { ...this.settings, ...overrides };
    let id;
    do { id = crypto.randomBytes(4).readUInt32BE(0); } while (!id || this.senders.has(id) || this.receivers.has(id));
    const tx = new SendSession({
      id, appId: this.appId, myName: this.name, file, peer, settings,
      impair: this.impair, socket: this.socket, log: this.log,
    });
    this.senders.set(id, tx);
    tx.on('end', () => setTimeout(() => {
      if (this.senders.get(id) === tx) this.senders.delete(id);
    }, 60000));
    this.tx = tx;
    tx.start();
    return tx;
  }

  setImpair(patch) {
    if (patch.preset && PRESETS[patch.preset]) {
      Object.assign(this.impair, PRESETS[patch.preset], { preset: patch.preset });
      this.log.info('sys', 'INFO', `Network preset: ${patch.preset}`);
      return;
    }
    const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
    const imp = this.impair;
    if ('loss' in patch) imp.loss = num(patch.loss, 0, 0.9);
    if ('corrupt' in patch) imp.corrupt = num(patch.corrupt, 0, 0.9);
    if ('jitter' in patch) imp.jitter = num(patch.jitter, 0, 5000);
    if ('capacity' in patch) imp.capacity = Math.round(num(patch.capacity, 0, 4096));
    if ('severity' in patch) imp.severity = num(patch.severity, 0, 1);
    if ('ackLoss' in patch) imp.ackLoss = !!patch.ackLoss;
    imp.preset = 'custom';
  }

  setSettings(patch) {
    const s = this.settings;
    const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v))));
    if ('chunk' in patch) s.chunk = int(patch.chunk, 64, 65000);
    if ('minWindow' in patch) s.minWindow = int(patch.minWindow, 1, 4096);
    if ('maxWindow' in patch) s.maxWindow = int(patch.maxWindow, 1, 4096);
    if ('initialWindow' in patch) s.initialWindow = int(patch.initialWindow, 1, 4096);
    if ('adaptive' in patch) {
      s.adaptive = !!patch.adaptive;
      if (this.tx && !isFinal(this.tx.phase)) this.tx.ctrl.enabled = s.adaptive;   // live switch
    }
    s.maxWindow = Math.max(s.maxWindow, s.minWindow);
    s.initialWindow = Math.max(s.minWindow, Math.min(s.maxWindow, s.initialWindow));
  }

  pending() {
    return [...this.receivers.values()]
      .filter((r) => r.phase === 'pending')
      .map((r) => ({ id: r.id, name: r.offer.name, size: r.offer.size, total: r.total, from: r.from.name, address: r.from.address }));
  }
}

function bindUdp(port) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', reject);
    sock.bind(port, () => {
      sock.off('error', reject);
      resolve(sock);
    });
  });
}

module.exports = { Engine, PRESETS };
