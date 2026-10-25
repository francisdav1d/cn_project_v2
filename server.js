#!/usr/bin/env node
'use strict';
/**
 * ARQ Beam: reliable LAN file transfer over UDP with Selective Repeat ARQ and an adaptive
 * sliding window, plus a live dashboard.
 *
 *   node server.js [--port 47800] [--data-port 47801] [--dir <download folder>] [--name <device name>] [--no-open]
 *                  [--phone] [--phone-port 47803]
 *
 * The dashboard is served on 127.0.0.1 only; peers talk to each other over UDP. The optional phone
 * upload page (lib/phone.js) is the only thing served to the LAN, behind a PIN.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Engine } = require('./lib/engine');
const { Discovery, localAddresses } = require('./lib/discovery');
const { isFinal } = require('./lib/sender');
const P = require('./lib/protocol');
const { PhoneUpload } = require('./lib/phone');

const args = parseArgs(process.argv.slice(2));
const HTTP_PORT = Number(args.port || process.env.ARQ_PORT || 47800);
const DATA_PORT = Number(args['data-port'] || process.env.ARQ_DATA_PORT || HTTP_PORT + 1);
const DISCOVERY_PORT = 47802;
const PHONE_PORT = Number(args['phone-port'] || HTTP_PORT + 3);
const DOWNLOAD_DIR = path.resolve(args.dir || process.env.ARQ_DIR || path.join(os.homedir(), 'Downloads', 'ARQ Beam'));
const DEVICE_NAME = String(args.name || os.hostname()).slice(0, 48);
const STAGE_DIR = path.join(os.tmpdir(), 'arq-beam', `stage-${HTTP_PORT}`);
const PUBLIC = path.join(__dirname, 'public');
const SEA = seaRuntime();      // set inside the standalone exe, where public/ is embedded
const TICK_MS = 66;

const engine = new Engine({ dataPort: DATA_PORT, downloadDir: DOWNLOAD_DIR, name: DEVICE_NAME });
const phone = new PhoneUpload({
  port: PHONE_PORT, dir: DOWNLOAD_DIR, name: DEVICE_NAME,
  page: (cb) => readPublic(path.join(PUBLIC, 'phone.html'), cb),
});
let discovery = null;
const staged = new Map();      // stageId -> { path, name, size, sha256 }
const clients = new Set();
const recentLog = [];          // replayed to a dashboard that (re)connects
let peersDirty = true;

// ------------------------------------------------------------------ peers

function selfPeer() {
  return { id: 'self', name: `${DEVICE_NAME} (this device)`, address: '127.0.0.1', port: engine.dataPort, os: os.platform(), self: true };
}

function peerList() {
  return [selfPeer(), ...(discovery ? discovery.list() : [])];
}

function findPeer(id) {
  return peerList().find((p) => p.id === id) || null;
}

// ------------------------------------------------------------------ telemetry to the UI

function meInfo() {
  return {
    name: DEVICE_NAME, appId: engine.appId, dataPort: engine.dataPort, httpPort: HTTP_PORT,
    addresses: localAddresses(), downloadDir: DOWNLOAD_DIR,
    discovery: discovery && discovery.ok ? 'on' : `off${discovery && discovery.error ? `: ${discovery.error}` : ''}`,
  };
}

function config() {
  return { impair: engine.impair, settings: engine.settings, autoAccept: engine.autoAccept };
}

function hello() {
  const tx = engine.tx;
  const rx = engine.rx;
  const txSnap = tx ? tx.snapshot() : null;
  if (txSnap && rx && rx.id === tx.id && rx.grid) txSnap.rxGrid = rx.grid.snapshot();
  return {
    me: meInfo(), peers: peerList(), ...config(), phone: phone.state(),
    pending: engine.pending(), history: engine.history,
    tx: txSnap, rx: rx ? rx.snapshot() : null, now: P.nowMs(), log: recentLog.slice(-300),
  };
}

function tick() {
  const tx = engine.tx;
  const rx = engine.rx;
  const rxTick = rx ? rx.tick() : null;
  let txTick = null;
  if (tx) {
    txTick = tx.tick();
    const fb = tx.rxView.drain();
    // Sending to ourselves: show the real receiver; otherwise the view rebuilt from feedback.
    if (rx && rx.id === tx.id) {
      txTick.rxCells = rxTick.cells;
      txTick.rxSource = 'local';
    } else {
      txTick.rxCells = fb;
      txTick.rxSource = 'feedback';
    }
  }
  const log = engine.log.drain();
  if (log.items.length) {
    recentLog.push(...log.items);
    if (recentLog.length > 400) recentLog.splice(0, recentLog.length - 300);
  }
  if (!clients.size) return;
  const msg = { now: P.nowMs(), tx: txTick, rx: rxTick, log: log.items, suppressed: log.suppressed };
  if (peersDirty) {
    msg.peers = peerList();
    peersDirty = false;
  }
  broadcast('tick', msg);
}

function broadcast(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(line);
}

function pushMeta() {
  broadcast('meta', { ...config(), pending: engine.pending(), history: engine.history });
}

// ------------------------------------------------------------------ HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

const routes = {
  'POST /api/stage': stageUpload,
  'POST /api/send': async (req, res) => {
    const body = await readJson(req);
    const file = staged.get(body.stageId);
    if (!file) return json(res, 404, { error: 'Drop a file first' });
    const peer = body.peer && body.peer.address ? manualPeer(body.peer) : findPeer(body.peerId);
    if (!peer) return json(res, 404, { error: 'That device is no longer on the radar' });
    if (body.settings) engine.setSettings(body.settings);
    try {
      const tx = engine.send(file, peer);
      json(res, 200, { id: tx.id });
    } catch (err) {
      json(res, 409, { error: err.message });
    }
  },
  'POST /api/tx': async (req, res) => {
    const { action } = await readJson(req);
    const tx = engine.tx;
    if (!tx) return json(res, 404, { error: 'No transfer' });
    if (action === 'pause') tx.pause();
    else if (action === 'resume') tx.resume();
    else if (action === 'cancel') tx.cancel();
    json(res, 200, { ok: true });
  },
  'POST /api/impair': async (req, res) => {
    engine.setImpair(await readJson(req));
    pushMeta();
    json(res, 200, engine.impair);
  },
  'POST /api/settings': async (req, res) => {
    engine.setSettings(await readJson(req));
    pushMeta();
    json(res, 200, engine.settings);
  },
  'POST /api/rx': async (req, res) => {
    const { action, id } = await readJson(req);
    if (action === 'auto') {
      engine.autoAccept = !!id;
      pushMeta();
      return json(res, 200, { ok: true });
    }
    const rx = engine.receivers.get(id);
    if (!rx) return json(res, 404, { error: 'Unknown transfer' });
    if (action === 'accept') { rx.accept(); engine.rx = rx; }
    else if (action === 'decline') rx.decline();
    else if (action === 'cancel') rx.cancel();
    pushMeta();
    json(res, 200, { ok: true });
  },
  'POST /api/peers': async (req, res) => {
    const { action, address, port } = await readJson(req);
    if (!discovery || !discovery.ok) return json(res, 503, { error: 'Discovery is off' });
    if (action === 'scan') discovery.probe();
    if (action === 'add') {
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(address))) return json(res, 400, { error: 'Enter an IPv4 address' });
      discovery.addManual(String(address), Number(port) || 47801);
    }
    json(res, 200, { ok: true });
  },
  'POST /api/open': async (req, res) => {
    const { id } = await readJson(req);
    const item = id ? engine.history.find((h) => h.id === id) : null;
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    reveal(item ? item.path : DOWNLOAD_DIR, !!item);
    json(res, 200, { ok: true });
  },
  'GET /api/stream': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`retry: 1500\nevent: hello\ndata: ${JSON.stringify(hello())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  },
  'POST /api/phone': async (req, res) => {
    const { action } = await readJson(req);
    if (action === 'on') await phone.start();
    else if (action === 'off') phone.stop();
    else if (action === 'pin' && phone.running) phone.newPin();
    json(res, action === 'on' && !phone.running ? 409 : 200, phone.state());
  },
  'GET /api/state': (req, res) => json(res, 200, hello()),
};

const server = http.createServer(async (req, res) => {
  try {
    if (!allowed(req)) return json(res, 403, { error: 'Forbidden' });
    const url = new URL(req.url, 'http://localhost');
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return await route(req, res, url);
    if (req.method === 'GET') return serveStatic(url.pathname, res);
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
});

/** Dashboard is local only: refuse other hosts (DNS rebinding) and cross-site POSTs. */
function allowed(req) {
  const host = String(req.headers.host || '');
  if (host !== `127.0.0.1:${HTTP_PORT}` && host !== `localhost:${HTTP_PORT}`) return false;
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && origin !== `http://${host}`) return false;
  return true;
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'Forbidden' });
  readPublic(file, (err, data) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/** Dashboard files come from public/ on disk, or from the assets embedded in the standalone exe. */
function readPublic(file, cb) {
  if (!SEA) return fs.readFile(file, cb);
  const key = path.relative(__dirname, file).split(path.sep).join('/');
  let data;
  try {
    data = Buffer.from(SEA.getAsset(key));
  } catch (err) {
    return cb(err);
  }
  cb(null, data);
}

function seaRuntime() {
  try {
    const sea = require('node:sea');
    return sea.isSea() ? sea : null;
  } catch {
    return null;                 // Node before 20.12 has no node:sea
  }
}

/** Receives the dropped file from the browser into a temp folder, hashing it on the way. */
function stageUpload(req, res, url) {
  const name = String(url.searchParams.get('name') || 'file').slice(0, 255);
  for (const f of staged.values()) {
    if (!engine.tx || isFinal(engine.tx.phase) || engine.tx.file.path !== f.path) fs.rm(f.path, { force: true }, () => {});
  }
  staged.clear();
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  const stageId = crypto.randomBytes(8).toString('hex');
  const dest = path.join(STAGE_DIR, stageId);
  const out = fs.createWriteStream(dest);
  const hash = crypto.createHash('sha256');
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    hash.update(chunk);
  });
  req.pipe(out);
  out.on('finish', () => {
    const file = { path: dest, name, size, sha256: hash.digest('hex') };
    staged.set(stageId, file);
    json(res, 200, { stageId, name, size, sha256: file.sha256 });
  });
  const abort = () => {
    out.destroy();
    fs.rm(dest, { force: true }, () => {});
  };
  req.on('aborted', abort);
  out.on('error', (err) => {
    abort();
    if (!res.headersSent) json(res, 500, { error: err.message });
  });
}

function manualPeer(p) {
  return { id: 'direct', name: String(p.address), address: String(p.address), port: Number(p.port) || 47801 };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Bad JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function reveal(target, select) {
  if (process.platform === 'win32') launch('explorer.exe', select ? [`/select,${target}`] : [target]);
  else if (process.platform === 'darwin') launch('open', select ? ['-R', target] : [target]);
  else launch('xdg-open', [select ? path.dirname(target) : target]);
}

/** Starts a helper program in the background. A missing one (no xdg-open on Android) is ignored. */
function launch(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false });
  child.on('error', () => {});
  child.unref();
  return child;
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    // Edge app mode gives a chromeless window; fall back to the default browser.
    const edge = launch('cmd.exe', ['/c', 'start', '', 'msedge', `--app=${url}`, '--window-size=1600,1000']);
    edge.on('exit', (code) => {
      if (code) launch('cmd.exe', ['/c', 'start', '', url]);
    });
  } else if (process.platform === 'darwin') {
    launch('open', [url]);
  } else {
    launch('xdg-open', [url]);
  }
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (i + 1 < list.length && !list[i + 1].startsWith('--')) out[key] = list[++i];
    else out[key] = true;
  }
  return out;
}

// ------------------------------------------------------------------ start

(async () => {
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  await engine.start();
  discovery = new Discovery({ appId: engine.appId, name: DEVICE_NAME, dataPort: engine.dataPort, port: DISCOVERY_PORT });
  await discovery.start();
  discovery.on('change', () => { peersDirty = true; });
  phone.on('change', () => broadcast('phone', phone.state()));
  phone.on('received', (item) => {
    engine.history.unshift(item);
    engine.history.length = Math.min(engine.history.length, 30);
    engine.log.info('rx', 'DONE', `Phone upload: saved ${item.name} (${(item.size / 1048576).toFixed(1)} MB) from ${item.from} over HTTP.`);
    pushMeta();
    broadcast('phonefile', item);
  });
  phone.on('failed', (f) => engine.log.info('rx', 'ERROR', `Phone upload of ${f.name} from ${f.from} failed: ${f.error}`));
  if (args.phone) await phone.start();
  engine.on('incoming', (rx) => {
    pushMeta();
    rx.on('change', pushMeta);
  });
  engine.log.info('sys', 'INFO', `Listening for transfers on UDP ${engine.dataPort}. Discovery ${discovery.ok ? 'on' : 'off'}. Saving to ${DOWNLOAD_DIR}`);
  setInterval(tick, TICK_MS);
  setInterval(() => {
    // Refresh the "last seen" ages and anything a session changed.
    peersDirty = true;
    pushMeta();
  }, 2000);

  server.listen(HTTP_PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${HTTP_PORT}`;
    const ips = localAddresses().map((a) => a.address).join(', ') || 'no LAN address';
    console.log(`\n  ARQ Beam is running`);
    console.log(`  Dashboard   ${url}`);
    console.log(`  Device      ${DEVICE_NAME}  (${ips})  UDP ${engine.dataPort}`);
    console.log(`  Downloads   ${DOWNLOAD_DIR}`);
    console.log(`  Discovery   ${discovery.ok ? `UDP ${DISCOVERY_PORT}` : `off (${discovery.error})`}`);
    const phoneUrl = phone.running && phone.urls()[0];
    console.log(`  Phone page  ${phoneUrl ? phoneUrl.url : phone.running ? `port ${PHONE_PORT}` : 'off (turn it on in the dashboard)'}\n`);
    if (!args['no-open']) openBrowser(url);
  });
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE'
      ? `Port ${HTTP_PORT} is busy. Is ARQ Beam already running? Start a second copy with --port ${HTTP_PORT + 10}`
      : err.message);
    process.exit(1);
  });
})();

function shutdown() {
  for (const tx of engine.senders.values()) tx.cancel();
  phone.stop();
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
