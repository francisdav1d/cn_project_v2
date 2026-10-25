'use strict';
/**
 * Phone upload: a small HTTP server on the LAN so any phone browser can send files to this device
 * without installing anything. It serves one page and one upload endpoint, both behind a 6-digit
 * PIN shown on the dashboard. Off until the dashboard turns it on.
 *
 * Uploads travel over plain HTTP (TCP), not the ARQ protocol: browsers cannot send raw UDP.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { uniquePath } = require('./receiver');
const { localAddresses } = require('./discovery');

const NEW_PIN_AFTER = 10;      // wrong PINs before a fresh one is drawn
const PROGRESS_MS = 250;

class PhoneUpload extends EventEmitter {
  /** page(cb) reads the phone page; cb(err, buffer). */
  constructor({ port, dir, name, page }) {
    super();
    this.port = port;
    this.dir = dir;
    this.name = name;
    this.page = page;
    this.server = null;
    this.error = null;
    this.pin = '';
    this.fails = 0;
    this.lockedUntil = 0;
    this.uploads = new Map();
    this.changeTimer = null;
  }

  get running() {
    return !!this.server;
  }

  start() {
    if (this.server) return Promise.resolve(true);
    this.newPin();
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.requestTimeout = 0;           // big videos can take longer than the 5 min default
      server.once('error', (err) => {
        this.error = err.code === 'EADDRINUSE' ? `Port ${this.port} is busy` : err.message;
        this.changed();
        resolve(false);
      });
      server.listen(this.port, '0.0.0.0', () => {
        this.server = server;
        this.error = null;
        this.changed();
        resolve(true);
      });
    });
  }

  stop() {
    if (!this.server) return;
    for (const up of this.uploads.values()) up.req.destroy();
    this.server.close();
    this.server.closeAllConnections();
    this.server = null;
    this.changed();
  }

  newPin() {
    this.pin = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    this.fails = 0;
    this.lockedUntil = 0;
    this.changed();
  }

  /** Addresses a phone can reach, most likely Wi-Fi / Ethernet first, virtual adapters last. */
  urls() {
    const score = ({ iface, address }) => (/wi-?fi|wlan|wireless/i.test(iface) ? 4 : 0)
      + (/ethernet|^en|^eth/i.test(iface) ? 2 : 0)
      - (/vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|tailscale|zerotier|bluetooth/i.test(iface) ? 8 : 0)
      + (address.startsWith('192.168.') ? 1 : 0) - (/^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 1 : 0);
    return localAddresses()
      .sort((a, b) => score(b) - score(a))
      .map((a) => ({ iface: a.iface, url: `http://${a.address}:${this.port}/?pin=${this.pin}` }));
  }

  state() {
    return {
      running: this.running, port: this.port, pin: this.running ? this.pin : '', error: this.error,
      urls: this.running ? this.urls() : [],
      uploads: [...this.uploads.values()].map((u) => ({ id: u.id, name: u.name, bytes: u.bytes, size: u.size, from: u.from })),
    };
  }

  changed() {
    clearTimeout(this.changeTimer);
    this.changeTimer = null;
    this.emit('change');
  }

  /** Like changed(), but at most every PROGRESS_MS while bytes stream in. */
  progress() {
    if (!this.changeTimer) this.changeTimer = setTimeout(() => this.changed(), PROGRESS_MS);
  }

  // ---------------------------------------------------------------- HTTP

  handle(req, res) {
    const url = new URL(req.url, 'http://phone');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return this.servePage(res);
    if (req.method === 'GET' && url.pathname === '/info') {
      if (!this.checkPin(url, res)) return;
      return json(res, 200, { name: this.name });
    }
    if (req.method === 'POST' && url.pathname === '/upload') {
      if (!this.checkPin(url, res)) return req.resume();
      return this.upload(req, res, url);
    }
    json(res, 404, { error: 'Not found' });
  }

  servePage(res) {
    this.page((err, data) => {
      if (err) return json(res, 500, { error: 'Page missing' });
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      });
      res.end(data);
    });
  }

  /** Wrong PINs lock the endpoint for longer each time, and enough of them draw a new PIN. */
  checkPin(url, res) {
    const now = Date.now();
    if (now < this.lockedUntil) {
      json(res, 429, { error: `Too many wrong PINs. Try again in ${Math.ceil((this.lockedUntil - now) / 1000)} s.` });
      return false;
    }
    const given = Buffer.from(String(url.searchParams.get('pin') || '').padEnd(6).slice(0, 6));
    if (crypto.timingSafeEqual(given, Buffer.from(this.pin))) return true;
    this.fails++;
    this.lockedUntil = now + Math.min(30, this.fails) * 1000;
    if (this.fails >= NEW_PIN_AFTER) this.newPin();
    json(res, 403, { error: 'Wrong PIN' });
    return false;
  }

  upload(req, res, url) {
    const declared = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(declared) || declared < 0) return json(res, 411, { error: 'File size missing' });
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
    const final = uniquePath(this.dir, String(url.searchParams.get('name') || 'file').slice(0, 255));
    const part = `${final}.arqpart`;
    const from = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const up = {
      id: `phone-${crypto.randomBytes(6).toString('hex')}`, name: path.basename(final), size: declared, bytes: 0,
      from, req, startedAt: Date.now(),
    };
    this.uploads.set(up.id, up);
    this.changed();

    const out = fs.createWriteStream(part, { flags: 'wx' });
    let settled = false;
    const fail = (status, msg) => {
      if (settled) return;
      settled = true;
      out.destroy();
      fs.rm(part, { force: true }, () => {});
      this.uploads.delete(up.id);
      this.changed();
      this.emit('failed', { name: up.name, from, error: msg });
      if (!res.headersSent && !res.destroyed) json(res, status, { error: msg });
    };
    req.on('data', (chunk) => {
      up.bytes += chunk.length;
      this.progress();
    });
    req.on('close', () => {
      if (!req.complete) fail(400, 'Upload interrupted');
    });
    out.on('error', (err) => fail(500, err.message));
    out.on('finish', () => {
      if (settled) return;
      if (up.bytes !== declared) return fail(400, `Received ${up.bytes} of ${declared} bytes`);
      fs.rename(part, final, (err) => {
        if (err) return fail(500, err.message);
        settled = true;
        this.uploads.delete(up.id);
        this.changed();
        const seconds = (Date.now() - up.startedAt) / 1000;
        this.emit('received', {
          id: up.id, name: up.name, size: up.bytes, from: `Phone ${from}`, path: final,
          verified: true, via: 'phone', seconds, at: Date.now(),
        });
        json(res, 200, { ok: true, savedAs: up.name, bytes: up.bytes });
      });
    });
    req.pipe(out);
  }
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

module.exports = { PhoneUpload };
