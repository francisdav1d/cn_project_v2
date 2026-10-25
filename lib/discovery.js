'use strict';
/**
 * Connected-device radar. Every instance broadcasts a small JSON beacon on the discovery port
 * every couple of seconds and answers probes, so peers on the same Wi-Fi / Ethernet segment find
 * each other without any setup. Devices that stop beaconing disappear after a few seconds.
 */
const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');

const APP = 'arq-beam';
const BEACON_MS = 2000;
const EXPIRE_MS = 7000;

class Discovery extends EventEmitter {
  constructor({ appId, name, dataPort, port }) {
    super();
    this.appId = appId;
    this.name = name;
    this.dataPort = dataPort;
    this.port = port;
    this.peers = new Map();
    this.socket = null;
    this.ok = false;
  }

  start() {
    return new Promise((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', (err) => {
        if (!this.ok) {
          this.error = err.message;
          resolve(false);
        }
      });
      sock.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
      sock.bind(this.port, () => {
        try { sock.setBroadcast(true); } catch { /* some adapters refuse; unicast still works */ }
        this.socket = sock;
        this.ok = true;
        this.probe();
        this.beaconTimer = setInterval(() => this.beacon(), BEACON_MS);
        this.expireTimer = setInterval(() => this.expire(), 1000);
        resolve(true);
      });
    });
  }

  stop() {
    clearInterval(this.beaconTimer);
    clearInterval(this.expireTimer);
    if (this.socket) this.socket.close();
  }

  message(kind) {
    return Buffer.from(JSON.stringify({
      app: APP, v: 1, kind, id: this.appId, name: this.name, port: this.dataPort, os: os.platform(),
    }));
  }

  beacon() {
    this.broadcast(this.message('beacon'));
  }

  /** Asks everyone to answer right away (used by the Rescan button). */
  probe() {
    this.broadcast(this.message('probe'));
  }

  broadcast(buf) {
    if (!this.socket) return;
    for (const addr of broadcastAddresses()) {
      this.socket.send(buf, this.port, addr, noop);
    }
  }

  /** A device typed in by hand (for networks that block broadcast). */
  addManual(address, port) {
    const id = `manual:${address}:${port}`;
    this.peers.set(id, { id, name: address, address, port, os: '', manual: true, lastSeen: Date.now() });
    if (this.socket) this.socket.send(this.message('probe'), this.port, address, noop);
    this.emit('change');
    return id;
  }

  onMessage(msg, rinfo) {
    let m;
    try { m = JSON.parse(msg.toString('utf8')); } catch { return; }
    if (!m || m.app !== APP || m.id === this.appId || typeof m.id !== 'string') return;
    if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) return;
    if (m.kind === 'probe') this.socket.send(this.message('beacon'), rinfo.port, rinfo.address, noop);

    // A beacon from a device we had added by hand replaces the manual entry.
    for (const [id, p] of this.peers) {
      if (p.manual && p.address === rinfo.address && p.port === m.port) this.peers.delete(id);
    }
    const name = String(m.name || rinfo.address).slice(0, 64);
    const existing = this.peers.get(m.id);
    const changed = !existing || existing.address !== rinfo.address || existing.port !== m.port || existing.name !== name;
    this.peers.set(m.id, {
      id: m.id, name, address: rinfo.address, port: m.port,
      os: String(m.os || '').slice(0, 16), manual: false, lastSeen: Date.now(),
    });
    if (changed) this.emit('change');
  }

  expire() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peers) {
      if (!p.manual && now - p.lastSeen > EXPIRE_MS) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }

  list() {
    return [...this.peers.values()].map((p) => ({ ...p, age: Date.now() - p.lastSeen }));
  }
}

/** Directed broadcast address of every IPv4 LAN interface, plus the limited broadcast. */
function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(interfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal || !ni.netmask) continue;
      const ip = ni.address.split('.').map(Number);
      const mask = ni.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b | (~mask[i] & 255)) & 255).join('.'));
    }
  }
  return out;
}

function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(interfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ iface: name, address: ni.address });
    }
  }
  return out;
}

/** Android can refuse to list interfaces; then only the limited broadcast and loopback are used. */
function interfaces() {
  try {
    return os.networkInterfaces();
  } catch {
    return {};
  }
}

function noop() {}

module.exports = { Discovery, localAddresses };
