'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const MONO = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace';
  const DPR = () => Math.min(window.devicePixelRatio || 1, 2);

  // Grid states (same order as lib/telemetry.js). Each state that matters for errors also gets a
  // glyph, so it never relies on colour alone.
  const C = {
    idle: '#212830', fg: '#f0f6fc', muted: '#9198a1', bg: '#0d1117', grid: '#3d444d',
    accent: '#4493f8', blue: '#1f6feb', green: '#238636', red: '#da3633', redFg: '#f85149',
    orange: '#bd561d', orangeFg: '#db6d28', yellow: '#9e6a03', yellowFg: '#d29922', purple: '#8957e5', pink: '#bf4b8a',
  };
  const TX_STATES = [
    { name: 'Not sent', color: C.idle },
    { name: 'Sent, awaiting ACK', color: C.blue },
    { name: 'Retransmitted', color: C.purple, glyph: 'dot' },
    { name: 'Lost', color: C.red, glyph: 'slash' },
    { name: 'Corrupted', color: C.orange, glyph: 'hatch' },
    { name: 'ACK lost', color: C.pink, glyph: 'ring' },
    { name: 'ACKed', color: C.green },
  ];
  const RX_STATES = [
    { name: 'Not received', color: C.idle },
    { name: 'Delivered', color: C.green },
    { name: 'Buffered', color: C.yellow, glyph: 'hatch' },
    { name: 'CRC error', color: C.red, glyph: 'slash' },
  ];
  const TX_RANK = [0, 2, 3, 6, 5, 4, 1];     // minimap: which state wins a pixel
  const RX_RANK = [0, 1, 2, 3];
  const CAP_STEPS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128, 192, 256, 0];
  const PHASE = {
    offering: 'Waiting for receiver', running: 'Transferring', finishing: 'Verifying', done: 'Complete',
    failed: 'Failed', cancelled: 'Cancelled', declined: 'Declined',
    pending: 'Awaiting your answer', receiving: 'Receiving', verifying: 'Verifying', complete: 'Complete',
  };
  const FINAL = new Set(['done', 'failed', 'cancelled', 'declined', 'complete']);
  const PRESET_NAME = { clean: 'Clean LAN', good: 'Good', moderate: 'Moderate', poor: 'Poor', custom: 'Custom' };

  const app = {
    me: null, peers: [], impair: {}, settings: {}, autoAccept: false, pending: [], history: [],
    mode: 'send', selectedPeer: 'self', staged: null, tx: null, rx: null, clock: 0,
    seenOffers: new Set(), lastPhase: {}, phone: null, phoneAddr: 0,
  };

  // ================================================================== helpers

  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return `${n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0)} ${u[i]}`;
  }
  const fmtNum = (n) => Math.round(n || 0).toLocaleString('en-US');
  function fmtMs(ms) {
    if (!ms) return '—';
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
    return ms >= 100 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
  }
  function fmtDur(s) {
    if (!s) return '0.00 s';
    if (s < 60) return `${s.toFixed(2)} s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${String(Math.floor(s % 60)).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }
  const pct = (x, d = 1) => `${(x || 0).toFixed(d)}%`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function clockStr(t) {
    const d = new Date(t + app.clock);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }
  function b64ToBytes(b64, size) {
    const out = new Uint8Array(size);
    if (!b64) return out;
    const bin = atob(b64);
    for (let i = 0; i < bin.length && i < size; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function applyRle(arr, cells, view) {
    if (!cells) return;
    for (let i = 0; i < cells.length; i += 3) {
      const s = cells[i], n = cells[i + 1];
      arr.fill(cells[i + 2], s, s + n);
      if (view) view.touched(s, n);
    }
  }
  async function api(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }
  function niceStep(raw) {
    const p = 10 ** Math.floor(Math.log10(raw || 1));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  const tip = $('tooltip');
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.classList.add('show');
    const r = tip.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > innerHeight - 8) top = y - r.height - 14;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  const hideTip = () => tip.classList.remove('show');
  function setHTML(el, html) {
    if (el._html !== html) {
      el._html = html;
      el.innerHTML = html;
    }
  }

  function toast(title, body, kind = '', actions = [], ms = 7000) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `<b>${esc(title)}</b><div>${esc(body)}</div>`;
    if (actions.length) {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.justifyContent = 'flex-end';
      for (const a of actions) {
        const b = document.createElement('button');
        b.className = `btn small${a.primary ? ' primary' : ''}`;
        b.textContent = a.label;
        b.onclick = () => { a.fn(); el.remove(); };
        row.append(b);
      }
      el.append(row);
    }
    $('toasts').append(el);
    if (ms) setTimeout(() => el.remove(), ms);
  }

  // ================================================================== cell drawing

  function drawCell(ctx, x, y, w, h, def) {
    rr(ctx, x, y, w, h, Math.min(3, h / 4));
    ctx.fillStyle = def.color;
    ctx.fill();
    if (!def.glyph) return;
    ctx.save();
    switch (def.glyph) {
      case 'dot':
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.beginPath();
        ctx.arc(x + w - Math.min(5, w / 4), y + Math.min(5, h / 4), Math.max(1.4, Math.min(2.2, w / 7)), 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'slash':
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x + 3, y + h - 3);
        ctx.lineTo(x + w - 3, y + 3);
        ctx.stroke();
        break;
      case 'hatch':
        rr(ctx, x, y, w, h, Math.min(3, h / 4));
        ctx.clip();
        ctx.strokeStyle = 'rgba(0,0,0,0.26)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = -h; i < w; i += 6) {
          ctx.moveTo(x + i, y + h);
          ctx.lineTo(x + i + h, y);
        }
        ctx.stroke();
        break;
      case 'ring':
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.5;
        rr(ctx, x + 2, y + 2, w - 4, h - 4, Math.min(2, h / 5));
        ctx.stroke();
        break;
    }
    ctx.restore();
  }

  function legend(el, states, extra) {
    el.innerHTML = '';
    const add = (label, paint) => {
      const span = document.createElement('span');
      const c = document.createElement('canvas');
      const d = DPR();
      c.width = 14 * d; c.height = 14 * d;
      const ctx = c.getContext('2d');
      ctx.scale(d, d);
      paint(ctx);
      span.append(c, label);
      el.append(span);
    };
    states.forEach((s) => add(s.name, (ctx) => drawCell(ctx, 1, 1, 12, 12, s)));
    if (extra) add(extra.label, extra.paint);
  }

  // ================================================================== packet grid

  class GridView {
    constructor(o) {
      Object.assign(this, o);
      this.ctx = this.canvas.getContext('2d');
      this.mctx = this.mini.getContext('2d');
      this.data = null;
      this.total = 0;
      this.focus = 0;
      this.winStart = 0;
      this.winEnd = -1;
      this.sF = 0;
      this.eF = -1;
      this.rowF = 0;
      this.rowTarget = 0;
      this.follow = true;
      this.flash = new Map();
      this.gap = 4;
      this.ch = 24;
      this.needs = true;
      this.miniAt = 0;
      this.pulse = false;
      new ResizeObserver(() => this.layout()).observe(this.canvas.parentElement);
      this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
      this.canvas.addEventListener('mouseleave', hideTip);
      this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
      this.mini.addEventListener('click', (e) => this.onMini(e));
      this.followBtn.addEventListener('click', () => this.setFollow(!this.follow));
      this.setFollow(true);
    }

    setFollow(on) {
      this.follow = on;
      this.followBtn.setAttribute('aria-pressed', String(on));
      this.needs = true;
    }

    setData(data, total) {
      if (data === this.data) return;
      this.data = data;
      this.total = data ? total : 0;
      this.flash.clear();
      this.rowF = this.rowTarget = 0;
      this.sF = 0;
      this.eF = -1;
      this.setFollow(true);
      this.layout();
    }

    setMeta({ focus = 0, winStart = 0, winEnd = -1 }) {
      if (focus !== this.focus || winStart !== this.winStart || winEnd !== this.winEnd) this.needs = true;
      this.focus = focus;
      this.winStart = winStart;
      this.winEnd = winEnd;
    }

    layout() {
      const width = Math.max(160, this.canvas.parentElement.clientWidth);
      const digits = Math.max(2, String(Math.max(this.total - 1, 9)).length);
      const minCell = Math.max(26, digits * 7.4 + 10);
      const gap = this.gap;
      this.cols = Math.max(4, Math.floor((width + gap) / (minCell + gap)));
      this.cw = (width - (this.cols - 1) * gap) / this.cols;
      this.rows = this.total ? Math.max(1, Math.min(this.maxRows, Math.ceil(this.total / this.cols))) : Math.min(this.maxRows, 4);
      const height = this.rows * (this.ch + gap) - gap;
      const d = DPR();
      this.width = width;
      this.height = height;
      this.canvas.width = Math.round(width * d);
      this.canvas.height = Math.round(height * d);
      this.canvas.style.height = `${height}px`;
      this.ctx.setTransform(d, 0, 0, d, 0, 0);
      this.mini.hidden = !this.total || this.total <= this.cols * this.rows;
      this.mini.width = Math.round(width * d);
      this.mini.height = Math.round(12 * d);
      this.miniAt = 0;
      this.needs = true;
    }

    touched(start, n) {
      this.needs = true;
      const v0 = (Math.floor(this.rowF) - 1) * this.cols;
      const v1 = v0 + (this.rows + 3) * this.cols;
      const a = Math.max(start, v0), b = Math.min(start + n, v1);
      if (b - a > 300 || this.flash.size > 2000) return;
      const now = performance.now();
      for (let s = a; s < b; s++) this.flash.set(s, now);
    }

    frame(now) {
      if (!this.data) {
        if (this.needs) this.drawEmpty();
        this.needs = false;
        return;
      }
      const cols = this.cols;
      const maxStart = Math.max(0, Math.ceil(this.total / cols) - this.rows);
      if (this.follow) this.rowTarget = Math.floor(this.focus / cols) - (this.rows > 3 ? 1 : 0);
      this.rowTarget = Math.max(0, Math.min(maxStart, this.rowTarget));
      let anim = false;
      const ease = (a, b, snap) => {
        const d = b - a;
        if (Math.abs(d) < 0.01 || Math.abs(d) > snap) return b;
        anim = true;
        return a + d * 0.2;
      };
      this.rowF = ease(this.rowF, this.rowTarget, this.rows * 3);
      if (this.kind === 'tx') {
        if (this.eF < this.sF) { this.sF = this.winStart; this.eF = this.winEnd; }
        const snap = cols * this.rows * 2;
        this.sF = ease(this.sF, this.winStart, snap);
        this.eF = ease(this.eF, this.winEnd, snap);
      }
      if (this.flash.size) {
        anim = true;
        for (const [s, t] of this.flash) if (now - t > 520) this.flash.delete(s);
      }
      if (this.pulse) anim = true;
      if (!this.needs && !anim) return;
      this.needs = false;
      this.draw(now);
      if (!this.mini.hidden && now - this.miniAt > 250) {
        this.drawMini();
        this.miniAt = now;
      }
    }

    drawEmpty() {
      const { ctx, cols, cw, ch, gap } = this;
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.fillStyle = '#151b23';
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < cols; c++) {
          rr(ctx, c * (cw + gap), r * (ch + gap), cw, ch, 3);
          ctx.fill();
        }
      }
    }

    draw(now) {
      const { ctx, cols, cw, ch, gap, data, states } = this;
      const px = cw + gap, py = ch + gap;
      ctx.clearRect(0, 0, this.width, this.height);
      const fs = Math.min(11, Math.max(8, cw * 0.36));
      ctx.font = `600 ${fs}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const r0 = Math.floor(this.rowF);
      for (let r = r0; r <= r0 + this.rows; r++) {
        const y = (r - this.rowF) * py;
        if (y > this.height) break;
        for (let c = 0; c < cols; c++) {
          const s = r * cols + c;
          if (s >= this.total) break;
          const x = c * px;
          const st = data[s];
          const def = states[st] || states[0];
          drawCell(ctx, x, y, cw, ch, def);
          const t = this.flash.get(s);
          if (t !== undefined && now - t < 500) {
            ctx.save();
            ctx.globalAlpha = (1 - (now - t) / 500) * 0.3;
            rr(ctx, x, y, cw, ch, 3);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.restore();
          }
          ctx.fillStyle = st === 0 ? C.muted : '#ffffff';
          ctx.fillText(String(s), x + cw / 2, y + ch / 2 + 0.5);
        }
      }
      if (this.kind === 'tx' && this.eF >= this.sF) this.drawWindow(px, py);
      if (this.kind === 'rx' && this.focus < this.total) this.drawExpected(px, py, now);
    }

    drawWindow(px, py) {
      const { ctx, cols } = this;
      const sF = this.sF, eF = this.eF + 1;
      const rA = Math.max(Math.floor(this.rowF), Math.floor(sF / cols));
      const rB = Math.min(Math.floor(this.rowF) + this.rows, Math.floor((eF - 1e-6) / cols));
      ctx.save();
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 2;
      ctx.fillStyle = 'rgba(56,139,253,0.1)';
      for (let r = rA; r <= rB; r++) {
        const a = Math.max(sF, r * cols) - r * cols;
        const b = Math.min(eF, (r + 1) * cols) - r * cols;
        if (b <= a) continue;
        const x0 = a * px - 3, x1 = b * px - this.gap + 3;
        rr(ctx, x0, (r - this.rowF) * py - 3, x1 - x0, this.ch + 6, 6);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    drawExpected(px, py, now) {
      const { ctx, cols } = this;
      const s = this.focus;
      const x = (s % cols) * px, y = (Math.floor(s / cols) - this.rowF) * py;
      const p = 0.5 + 0.5 * Math.sin(now / 200);
      ctx.save();
      ctx.strokeStyle = C.fg;
      ctx.globalAlpha = this.pulse ? 0.45 + 0.55 * p : 1;
      ctx.lineWidth = 2;
      rr(ctx, x - 2.5, y - 2.5, this.cw + 5, this.ch + 5, 5);
      ctx.stroke();
      ctx.restore();
    }

    drawMini() {
      const ctx = this.mctx, W = this.mini.width, H = this.mini.height, total = this.total, d = this.data;
      const rank = this.kind === 'tx' ? TX_RANK : RX_RANK;
      const top = this.kind === 'tx' ? 6 : 3;
      ctx.clearRect(0, 0, W, H);
      const per = total / W;
      let last = -1;
      for (let x = 0; x < W; x++) {
        const a = Math.floor(x * per), b = Math.min(total, Math.max(a + 1, Math.floor((x + 1) * per)));
        let best = 0, bestR = -1;
        for (let s = a; s < b; s++) {
          const r = rank[d[s]];
          if (r > bestR) {
            bestR = r;
            best = d[s];
            if (r === top) break;
          }
        }
        if (best !== last) {
          ctx.fillStyle = this.states[best].color;
          last = best;
        }
        ctx.fillRect(x, 0, 1, H);
      }
      const v0 = Math.floor(this.rowF) * this.cols / total * W;
      const v1 = Math.min(total, (Math.floor(this.rowF) + this.rows) * this.cols) / total * W;
      const lw = Math.max(1, DPR());
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = lw;
      ctx.strokeRect(v0 + lw / 2, lw / 2, Math.max(3, v1 - v0) - lw, H - lw);
    }

    seqAt(e) {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const px = this.cw + this.gap, py = this.ch + this.gap;
      const c = Math.floor(x / px);
      const rowPos = y / py + this.rowF;
      const r = Math.floor(rowPos);
      if (c < 0 || c >= this.cols || x - c * px > this.cw || (rowPos - r) * py > this.ch) return -1;
      const s = r * this.cols + c;
      return s >= 0 && s < this.total ? s : -1;
    }

    onMove(e) {
      if (!this.data) return hideTip();
      const s = this.seqAt(e);
      if (s < 0) return hideTip();
      const def = this.states[this.data[s]];
      let extra = '';
      if (this.kind === 'tx' && s >= this.winStart && s <= this.winEnd) extra = `<br><span class="k">inside the sliding window [${this.winStart}, ${this.winEnd}]</span>`;
      if (this.kind === 'rx' && s === this.focus) extra = '<br><span class="k">next expected packet</span>';
      const bytes = app.tx && this.kind === 'tx' ? app.tx.file.chunk : (app.rx ? app.rx.file.chunk : 0);
      const off = bytes ? `<br><span class="k">bytes ${fmtNum(s * bytes)}–${fmtNum((s + 1) * bytes - 1)}</span>` : '';
      showTip(`<b>P${s}</b>&nbsp; <span class="sw" style="background:${def.color}"></span>${def.name}${extra}${off}`, e.clientX, e.clientY);
    }

    onWheel(e) {
      if (!this.data || this.total <= this.cols * this.rows) return;
      e.preventDefault();
      this.rowTarget = Math.floor(this.rowTarget) + Math.sign(e.deltaY) * Math.max(1, Math.floor(this.rows / 2));
      this.setFollow(false);
    }

    onMini(e) {
      if (!this.data) return;
      const rect = this.mini.getBoundingClientRect();
      const seq = Math.floor((e.clientX - rect.left) / rect.width * this.total);
      this.rowTarget = Math.floor(seq / this.cols) - 1;
      this.setFollow(false);
    }
  }

  // ================================================================== line chart

  class ChartView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.points = [];
      this.marks = [];
      this.kind = null;
      this.all = false;
      this.live = false;
      this.tickAt = 0;
      this.hover = null;
      this.needs = true;
      new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
      canvas.addEventListener('mousemove', (e) => {
        const r = canvas.getBoundingClientRect();
        this.hover = { x: e.clientX - r.left, cx: e.clientX, cy: e.clientY };
        this.needs = true;
      });
      canvas.addEventListener('mouseleave', () => { this.hover = null; hideTip(); this.needs = true; });
    }

    resize() {
      const r = this.canvas.parentElement.getBoundingClientRect();
      const d = DPR();
      this.w = r.width;
      this.h = r.height;
      this.canvas.width = Math.round(r.width * d);
      this.canvas.height = Math.round(r.height * d);
      this.ctx.setTransform(d, 0, 0, d, 0, 0);
      this.needs = true;
    }

    set(points, marks, kind, live) {
      if (kind !== this.kind) {
        this.kind = kind;
        $('chartTitle').textContent = kind === 'tx' ? 'Window size' : 'Goodput';
        const vline = (c, style) => `<i style="width:2px;height:12px;border-top:0;border-left:2px ${style} ${c}"></i>`;
        $('chartLegend').innerHTML = kind === 'tx'
          ? `<span><i style="border-color:${C.accent}"></i>Window</span>`
            + `<span><i style="border-color:${C.muted};border-top-style:dashed"></i>Capacity</span>`
            + `<span>${vline(C.redFg, 'dashed')}Halved</span>`
            + `<span>${vline(C.orangeFg, 'dashed')}−1</span>`
            + `<span><i style="width:2px;height:7px;border-top:0;border-left:2px solid ${C.redFg}"></i>Timeout / NAK</span>`
          : `<span><i style="border-color:${C.accent}"></i>Packets/s in order</span>`;
      }
      this.points = points;
      this.marks = marks;
      this.live = live;
      this.tickAt = performance.now();
      this.needs = true;
    }

    frame(now) {
      if (!this.needs && !this.live) return;
      this.needs = false;
      this.render(now);
    }

    render(now) {
      const { ctx, w, h } = this;
      if (!w) return;
      ctx.clearRect(0, 0, w, h);
      const pad = { l: 46, r: 14, t: 12, b: 26 };
      const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
      const pts = this.points;
      ctx.font = `11px ${MONO}`;
      if (!pts.length) {
        ctx.strokeStyle = 'rgba(61,68,77,0.6)';
        for (let i = 0; i <= 4; i++) {
          const y = Math.round(pad.t + ph * i / 4) + 0.5;
          ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
        }
        ctx.fillStyle = C.muted;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `14px ${getComputedStyle(document.body).fontFamily}`;
        ctx.fillText('No data yet', pad.l + pw / 2, pad.t + ph / 2);
        return;
      }
      let tEnd = pts[pts.length - 1][0];
      if (this.live) tEnd += Math.min(0.5, (now - this.tickAt) / 1000);
      const windowed = !this.all && tEnd > 60;
      const t0 = windowed ? tEnd - 60 : 0;
      const span = windowed ? 60 : Math.max(tEnd, 5);
      const X = (t) => pad.l + (t - t0) / span * pw;

      let i0 = 0;
      if (windowed) {
        let lo = 0, hi = pts.length - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m][0] < t0) lo = m + 1; else hi = m; }
        i0 = Math.max(0, lo - 1);
      }
      let ymax = 0;
      for (let i = i0; i < pts.length; i++) ymax = Math.max(ymax, pts[i][1], pts[i][2] || 0);
      const ystep = niceStep(Math.max(ymax * 1.12, this.kind === 'tx' ? 8 : 10) / 4);
      ymax = Math.ceil(Math.max(ymax * 1.12, this.kind === 'tx' ? 8 : 10) / ystep) * ystep;
      const Y = (v) => pad.t + ph - v / ymax * ph;

      // grid + axes (recessive)
      ctx.strokeStyle = 'rgba(61,68,77,0.6)';
      ctx.lineWidth = 1;
      ctx.fillStyle = C.muted;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let v = 0; v <= ymax + 1e-9; v += ystep) {
        const y = Math.round(Y(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
        ctx.fillText(fmtNum(v), pad.l - 8, y);
      }
      const xstep = niceStep(span / Math.max(2, Math.floor(pw / 90)));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let t = Math.ceil(t0 / xstep) * xstep; t <= t0 + span + 1e-9; t += xstep) {
        ctx.fillText(`${+t.toFixed(2)}s`, X(t), h - pad.b + 8);
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(pad.l, pad.t - 4, pw + 2, ph + 8);
      ctx.clip();

      // capacity (dashed step line)
      if (this.kind === 'tx') {
        ctx.strokeStyle = C.muted;
        ctx.setLineDash([6, 5]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let prev = null;
        for (let i = i0; i < pts.length; i++) {
          const cap = pts[i][2];
          const x = X(pts[i][0]);
          if (!cap) { prev = null; continue; }
          const y = Y(cap);
          if (prev === null) ctx.moveTo(x, y);
          else { ctx.lineTo(x, prev); ctx.lineTo(x, y); }
          prev = y;
        }
        if (prev !== null) ctx.lineTo(X(tEnd), prev);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // series, bucketed to one point per pixel column (peak kept)
      const xy = [];
      let lastCol = -1e9;
      for (let i = i0; i < pts.length; i++) {
        const x = X(pts[i][0]), y = Y(pts[i][1]);
        const col = Math.round(x);
        if (col === lastCol) {
          const L = xy[xy.length - 1];
          if (y < L[1]) L[1] = y;
        } else {
          xy.push([x, y]);
          lastCol = col;
        }
      }
      if (this.live && xy.length) {
        const ex = X(tEnd);
        if (ex - xy[xy.length - 1][0] >= 1) xy.push([ex, xy[xy.length - 1][1]]);
      }
      if (xy.length) {
        ctx.beginPath();
        monotone(ctx, xy);
        ctx.lineTo(xy[xy.length - 1][0], pad.t + ph);
        ctx.lineTo(xy[0][0], pad.t + ph);
        ctx.closePath();
        ctx.fillStyle = 'rgba(56,139,253,0.1)';
        ctx.fill();
        ctx.beginPath();
        monotone(ctx, xy);
        ctx.strokeStyle = C.accent;
        ctx.lineWidth = 2;
        ctx.stroke();
        const L = xy[xy.length - 1];
        ctx.beginPath();
        ctx.arc(L[0], L[1], 3.5, 0, Math.PI * 2);
        ctx.fillStyle = C.accent;
        ctx.fill();
      }

      // AIMD reductions (full-height) and failure ticks (bottom)
      const used = new Set();
      for (const m of this.marks) {
        if (m[0] < t0) continue;
        const x = Math.round(X(m[0]));
        const key = `${m[1]}:${x}`;
        if (used.has(key)) continue;
        used.add(key);
        if (m[1] === 'halve' || m[1] === 'shrink') {
          const c = m[1] === 'halve' ? C.redFg : C.orangeFg;
          ctx.strokeStyle = c;
          ctx.globalAlpha = 0.7;
          ctx.setLineDash([3, 4]);
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(x + 0.5, pad.t); ctx.lineTo(x + 0.5, pad.t + ph); ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          ctx.fillStyle = c;
          ctx.beginPath(); ctx.moveTo(x - 4, pad.t); ctx.lineTo(x + 5, pad.t); ctx.lineTo(x + 0.5, pad.t + 6); ctx.fill();
        } else {
          ctx.strokeStyle = m[1] === 'nak' ? C.yellowFg : C.redFg;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(x + 0.5, pad.t + ph); ctx.lineTo(x + 0.5, pad.t + ph - 7); ctx.stroke();
        }
      }
      ctx.restore();

      // hover crosshair
      if (this.hover && this.hover.x >= pad.l && this.hover.x <= w - pad.r) {
        const t = t0 + (this.hover.x - pad.l) / pw * span;
        let lo = i0, hi = pts.length - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m][0] < t) lo = m + 1; else hi = m; }
        if (lo > i0 && Math.abs(pts[lo - 1][0] - t) < Math.abs(pts[lo][0] - t)) lo--;
        const p = pts[lo];
        const x = X(p[0]);
        ctx.strokeStyle = C.grid;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x + 0.5, pad.t); ctx.lineTo(x + 0.5, pad.t + ph); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, Y(p[1]), 4.5, 0, Math.PI * 2);
        ctx.fillStyle = C.accent; ctx.fill();
        ctx.strokeStyle = C.bg; ctx.lineWidth = 2; ctx.stroke();
        const near = span / pw * 6;
        let fails = 0, cut = null;
        for (const m of this.marks) {
          if (Math.abs(m[0] - p[0]) > near) continue;
          if (m[1] === 'halve' || m[1] === 'shrink') cut = m; else fails++;
        }
        const html = this.kind === 'tx'
          ? `<b>${p[0].toFixed(2)} s</b><br><span class="sw" style="background:${C.accent}"></span>Window <b>${p[1]}</b>`
            + (p[2] ? `<br><span class="k">Capacity ${p[2]} frames</span>` : '')
            + (cut ? `<br><span class="sw" style="background:${cut[1] === 'halve' ? C.redFg : C.orangeFg}"></span>Cut ${cut[2]} → ${cut[3]}` : '')
            + (fails ? `<br><span class="k">${fails} timeout/NAK nearby</span>` : '')
          : `<b>${p[0].toFixed(2)} s</b><br><span class="sw" style="background:${C.accent}"></span><b>${fmtNum(p[1])}</b> packets/s<br><span class="k">${p[2]} buffered out of order</span>`;
        showTip(html, this.hover.cx, this.hover.cy);
      }
    }
  }

  /** Monotone cubic (Fritsch–Carlson): smooth, but never overshoots a step. */
  function monotone(ctx, p) {
    const n = p.length;
    ctx.moveTo(p[0][0], p[0][1]);
    if (n < 2) return;
    const dx = [], m = [], t = new Array(n);
    for (let i = 0; i < n - 1; i++) {
      dx[i] = p[i + 1][0] - p[i][0];
      m[i] = dx[i] ? (p[i + 1][1] - p[i][1]) / dx[i] : 0;
    }
    t[0] = m[0];
    t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (m[i - 1] * m[i] <= 0) t[i] = 0;
      else {
        const a = dx[i - 1], b = dx[i];
        t[i] = 3 * (a + b) / ((2 * b + a) / m[i - 1] + (b + 2 * a) / m[i]);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const h3 = dx[i] / 3;
      ctx.bezierCurveTo(p[i][0] + h3, p[i][1] + t[i] * h3, p[i + 1][0] - h3, p[i + 1][1] - t[i + 1] * h3, p[i + 1][0], p[i + 1][1]);
    }
  }

  // ================================================================== views

  const txView = new GridView({ canvas: $('txCanvas'), mini: $('txMini'), kind: 'tx', states: TX_STATES, maxRows: 8, followBtn: $('txFollow') });
  const rxView = new GridView({ canvas: $('rxCanvas'), mini: $('rxMini'), kind: 'rx', states: RX_STATES, maxRows: 5, followBtn: $('rxFollow') });
  const chart = new ChartView($('chart'));

  legend($('txLegend'), TX_STATES, {
    label: 'Sliding window',
    paint: (ctx) => {
      ctx.strokeStyle = C.accent; ctx.lineWidth = 1.6;
      rr(ctx, 1.5, 2.5, 11, 9, 3); ctx.stroke();
    },
  });
  legend($('rxLegend'), RX_STATES, {
    label: 'Next expected',
    paint: (ctx) => {
      drawCell(ctx, 2.5, 2.5, 9, 9, RX_STATES[0]);
      ctx.strokeStyle = C.fg; ctx.lineWidth = 1.6; rr(ctx, 1, 1, 12, 12, 3); ctx.stroke();
    },
  });

  function loop(now) {
    txView.frame(now);
    rxView.frame(now);
    chart.frame(now);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ================================================================== metrics panel

  const metricsEl = $('metrics');
  let metricsKind = null;
  let M = {};
  const kv = (label, key, sub) => `<div class="kv"><span class="k${sub ? ' sub' : ''}">${label}</span><span class="v" data-k="${key}">—</span></div>`;
  const bar = (key, color) => `<div class="minibar"><i data-k="${key}" style="width:0;background:${color}"></i></div>`;
  const heroCard = `
    <section class="box">
      <h2 class="box-title">Delivery <span class="tag" data-k="phase">Idle</span></h2>
      <div class="hero">
        <div class="ring"><svg viewBox="0 0 80 80"><circle class="bg" cx="40" cy="40" r="34"/><circle class="fg" data-k="ring" cx="40" cy="40" r="34" stroke-dasharray="213.63" stroke-dashoffset="213.63"/></svg><span data-k="pctBig">0%</span></div>
        <div><div class="big"><span data-k="mbps">0.00</span> <small>MB/s</small></div><div class="cap"><span data-k="pps">0</span> packets/s</div></div>
      </div>
      ${kv('Packets delivered', 'delivered')}
      ${kv('Delivery rate', 'deliveryRate')}
      ${kv('Average speed', 'avg')}
      ${kv('Data delivered', 'bytes')}
      ${kv('Elapsed', 'elapsed')}
    </section>`;

  function buildMetrics(kind) {
    metricsKind = kind;
    if (kind === 'tx') {
      metricsEl.innerHTML = heroCard + `
        <section class="box">
          <h2 class="box-title">Reliability</h2>
          ${kv('Total transmissions', 'transmissions')}
          ${kv('Retransmissions', 'retransmissions')}
          ${kv('Packets dropped', 'lost')}
          ${kv('random / congestion', 'lostSplit', true)}
          ${kv('Packets corrupted', 'corrupted')}
          ${kv('Timeouts', 'timeouts')}
          ${kv('NAKs', 'naks')}
          ${kv('ACKs lost', 'acksLost')}
          ${kv('Duplicates at receiver', 'duplicates')}
          ${kv('Packet loss rate', 'lossRate')}${bar('lossBar', 'var(--danger-em)')}
          ${kv('Network efficiency', 'efficiency')}${bar('effBar', 'var(--success-em)')}
        </section>
        <section class="box">
          <h2 class="box-title">Delay</h2>
          ${kv('Avg. transmission delay', 'avgDelay')}
          ${kv('Avg. round-trip time', 'avgRtt')}
          ${kv('Smoothed RTT', 'srtt')}
          ${kv('Retransmission timeout', 'rto')}
        </section>
        <section class="box">
          <h2 class="box-title">Sliding window <span class="tag" data-k="mode">—</span></h2>
          <div class="hero"><div class="big"><span data-k="window">—</span> <small>packets</small></div></div>
          ${kv('Average window', 'avgWindow')}
          ${kv('Min / max window', 'minmax')}
          ${kv('Increases / decreases', 'incdec')}
          ${kv('Last-round failures', 'lastFailure')}
          ${kv('Failure rate (moving avg)', 'normalFailure')}
          ${kv('Last-round delay', 'delayRatio')}
          ${kv('Outstanding packets', 'outstanding')}
          ${kv('Frames in network', 'inNet')}
        </section>`;
    } else {
      metricsEl.innerHTML = heroCard + `
        <section class="box">
          <h2 class="box-title">Reception</h2>
          ${kv('Frames received', 'frames')}
          ${kv('Unique packets', 'unique')}
          ${kv('Duplicates', 'duplicates')}
          ${kv('CRC errors (NAK sent)', 'crcErrors')}
          ${kv('Arrived out of order', 'outOfOrder')}
          ${kv('ACKs sent', 'acks')}
          ${kv('Buffered now / window', 'buffered')}
          ${kv('Peak buffer', 'maxBuffered')}
        </section>
        <section class="box">
          <h2 class="box-title">Integrity</h2>
          ${kv('SHA-256 check', 'verify')}
          ${kv('Digest', 'sha')}
          ${kv('Saved as', 'saved')}
          ${kv('From', 'from')}
        </section>`;
    }
    M = {};
    metricsEl.querySelectorAll('[data-k]').forEach((el) => { M[el.dataset.k] = el; });
  }
  function setM(k, v) {
    const el = M[k];
    if (el && el.textContent !== v) el.textContent = v;
  }
  function phaseTone(s) {
    if (s.phase === 'done' || s.phase === 'complete') return s.result && !s.result.verified ? 'danger' : 'live';
    if (s.phase === 'failed' || s.phase === 'cancelled' || s.phase === 'declined') return 'danger';
    return s.paused ? '' : 'accent';
  }
  function setRing(p) {
    if (M.ring) M.ring.setAttribute('stroke-dashoffset', String(213.63 * (1 - Math.min(1, p / 100))));
    setM('pctBig', `${Math.floor(p)}%`);
  }

  function updateMetrics(kind, s) {
    if (kind !== metricsKind) buildMetrics(kind);
    if (!s) {
      setM('phase', 'Idle');
      if (M.phase) M.phase.className = 'tag';
      setRing(0);
      return;
    }
    const m = s.metrics;
    setM('phase', s.paused ? 'Paused' : PHASE[s.phase] || s.phase);
    if (M.phase) M.phase.className = `tag ${phaseTone(s)}`;
    setRing(m.deliveryRate);
    setM('mbps', m.throughputMB.toFixed(2));
    setM('pps', fmtNum(m.throughputPkt));
    setM('delivered', `${fmtNum(m.delivered)} / ${fmtNum(m.total)}`);
    setM('deliveryRate', pct(m.deliveryRate));
    setM('avg', `${m.avgMB.toFixed(2)} MB/s`);
    setM('bytes', `${fmtBytes(Math.min(s.file.size, m.delivered * s.file.chunk))} / ${fmtBytes(s.file.size)}`);
    setM('elapsed', fmtDur(m.elapsed));
    if (kind === 'tx') {
      setM('transmissions', fmtNum(m.transmissions));
      setM('retransmissions', fmtNum(m.retransmissions));
      setM('lost', fmtNum(m.lost));
      setM('lostSplit', `${fmtNum(m.lostRandom)} / ${fmtNum(m.lostCongestion)}`);
      setM('corrupted', fmtNum(m.corrupted));
      setM('timeouts', fmtNum(m.timeouts));
      setM('naks', fmtNum(m.naks));
      setM('acksLost', fmtNum(m.acksLost));
      setM('duplicates', fmtNum(m.duplicates));
      setM('lossRate', pct(m.lossRate));
      setM('efficiency', pct(m.efficiency));
      if (M.lossBar) M.lossBar.style.width = `${Math.min(100, m.lossRate * 2)}%`;
      if (M.effBar) M.effBar.style.width = `${Math.min(100, m.efficiency)}%`;
      setM('avgDelay', fmtMs(m.avgDelay));
      setM('avgRtt', fmtMs(m.avgRtt));
      setM('srtt', fmtMs(m.srtt));
      setM('rto', fmtMs(m.rto));
      const mode = s.phase === 'offering' ? 'Waiting' : m.mode;
      setM('mode', mode);
      if (M.mode) M.mode.className = `tag ${mode === 'Slow start' ? 'accent' : mode === 'Congestion avoidance' ? 'done' : ''}`;
      setM('window', String(m.window));
      setM('avgWindow', m.avgWindow.toFixed(1));
      setM('minmax', `${m.minWindow} / ${m.maxWindow}`);
      setM('incdec', `${fmtNum(m.increases)} / ${fmtNum(m.decreases)}`);
      setM('lastFailure', pct(m.lastFailure));
      setM('normalFailure', pct(m.normalFailure));
      setM('delayRatio', `×${m.delayRatio.toFixed(2)}`);
      setM('outstanding', fmtNum(s.outstanding));
      setM('inNet', fmtNum(s.inNet));
    } else {
      setM('frames', fmtNum(m.frames));
      setM('unique', fmtNum(m.unique));
      setM('duplicates', fmtNum(m.duplicates));
      setM('crcErrors', fmtNum(m.crcErrors));
      setM('outOfOrder', fmtNum(m.outOfOrder));
      setM('acks', fmtNum(m.acks));
      setM('buffered', `${fmtNum(m.buffered)} / ${fmtNum(m.rwnd)}`);
      setM('maxBuffered', fmtNum(m.maxBuffered));
      const r = s.result;
      setM('verify', r ? (r.verified ? 'Match' : 'Mismatch') : s.phase === 'receiving' ? 'Hashing…' : PHASE[s.phase] || '—');
      if (M.verify) M.verify.className = `v ${r ? (r.verified ? 'ok-ink' : 'bad-ink') : ''}`;
      setM('sha', r ? `${r.sha256.slice(0, 16)}…` : '—');
      setM('saved', r ? r.path.split(/[\\/]/).pop() : '—');
      setM('from', `${s.from.name}`);
    }
  }

  // ================================================================== event log

  const logEl = $('log');
  const LOG_MAX = 600;
  const PER_TICK = 80;
  const logStore = [];
  let logFilter = 'all';
  let suppressedAcc = 0;
  let suppressedAt = 0;
  const ERR_TYPES = new Set(['LOST', 'TIMEOUT', 'CRC_FAIL', 'ERROR', 'CORRUPTED', 'NAK', 'ACK_LOST', 'DUPLICATE', 'RETRANSMIT']);

  function passes(e) {
    switch (logFilter) {
      case 'err': return ERR_TYPES.has(e[2]);
      case 'win': return e[2] === 'WINDOW' || e[2] === 'INFO' || e[2] === 'DONE';
      case 'rx': return e[1] === 'rx';
      default: return true;
    }
  }
  function logRow(e, fresh) {
    const d = document.createElement('div');
    if (fresh) d.className = 'fresh';
    d.innerHTML = `<span class="t">${clockStr(e[0])}</span><span class="ty ${e[2]}">${e[2].replace('_', ' ')}</span><span class="m" title="${esc(e[3])}">${esc(e[3])}</span>`;
    return d;
  }
  function addLog(items, suppressed, cap = PER_TICK) {
    suppressedAcc += suppressed || 0;
    const frag = document.createDocumentFragment();
    let shown = 0;
    for (const e of items || []) {
      logStore.push(e);
      if (!passes(e)) continue;
      if (shown++ < cap) frag.append(logRow(e, true));
      else suppressedAcc++;
    }
    const now = performance.now();
    if (suppressedAcc && now - suppressedAt > 1000) {
      if (logFilter === 'all') {
        const n = document.createElement('span');
        n.className = 'note';
        n.textContent = `${fmtNum(suppressedAcc)} routine sends / ACKs hidden`;
        frag.append(n);
      }
      suppressedAcc = 0;
      suppressedAt = now;
    }
    if (logStore.length > 4000) logStore.splice(0, logStore.length - 2500);
    if (!frag.childNodes.length) return;
    logEl.append(frag);
    while (logEl.childElementCount > LOG_MAX) logEl.firstElementChild.remove();
    if ($('autoScroll').checked) logEl.scrollTop = logEl.scrollHeight;
  }
  function rerenderLog() {
    logEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    const list = logStore.filter(passes).slice(-LOG_MAX);
    for (const e of list) frag.append(logRow(e, false));
    logEl.append(frag);
    logEl.scrollTop = logEl.scrollHeight;
  }
  $('logFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    logFilter = b.dataset.f;
    for (const c of $('logFilter').children) c.setAttribute('aria-pressed', String(c === b));
    rerenderLog();
  });
  $('clearLog').onclick = () => { logStore.length = 0; logEl.innerHTML = ''; };
  logEl.addEventListener('scroll', () => {
    const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24;
    $('autoScroll').checked = atBottom;
  });

  // ================================================================== mirrors of server state

  function header(dst, src) {
    for (const k in src) {
      if (k !== 'cells' && k !== 'rxCells' && k !== 'chart' && k !== 'marks' && k !== 'grid' && k !== 'rxGrid') dst[k] = src[k];
    }
  }
  function ensureTx(t) {
    if (!app.tx || app.tx.id !== t.id) {
      const n = t.file.total;
      app.tx = { id: t.id, grid: new Uint8Array(n), rxGrid: new Uint8Array(n), chart: [], marks: [] };
    }
    return app.tx;
  }
  function ensureRx(r) {
    if (!app.rx || app.rx.id !== r.id) {
      app.rx = { id: r.id, grid: new Uint8Array(r.file.total), chart: [] };
    }
    return app.rx;
  }

  function onHello(h) {
    app.me = h.me;
    app.peers = h.peers;
    app.clock = Date.now() - h.now;
    app.tx = null;
    app.rx = null;
    if (h.tx) {
      const t = ensureTx(h.tx);
      t.grid = b64ToBytes(h.tx.grid, h.tx.file.total);
      t.rxGrid = b64ToBytes(h.tx.rxGrid, h.tx.file.total);
      t.chart = h.tx.chart;
      t.marks = h.tx.marks;
      header(t, h.tx);
      app.lastPhase[t.id] = t.phase;
    }
    if (h.rx) {
      const r = ensureRx(h.rx);
      r.grid = b64ToBytes(h.rx.grid, h.rx.file.total);
      r.chart = h.rx.chart;
      header(r, h.rx);
      app.lastPhase[`rx${r.id}`] = r.phase;
    }
    for (const p of h.pending) app.seenOffers.add(p.id);
    logStore.length = 0;
    logEl.innerHTML = '';
    addLog(h.log || [], 0, Infinity);
    renderMe();
    onMeta(h);
    renderPeers();
    app.phone = h.phone;
    renderPhone();
    compose();
  }

  function onTick(m) {
    app.clock = Date.now() - m.now;
    if (m.peers) {
      app.peers = m.peers;
      renderPeers();
    }
    if (m.tx) {
      const t = ensureTx(m.tx);
      applyRle(t.grid, m.tx.cells, txView.data === t.grid ? txView : null);
      applyRle(t.rxGrid, m.tx.rxCells, rxView.data === t.rxGrid ? rxView : null);
      if (m.tx.chart.length) t.chart.push(...m.tx.chart);
      if (m.tx.marks.length) t.marks.push(...m.tx.marks);
      header(t, m.tx);
      phaseToasts('tx', t);
    }
    if (m.rx) {
      const r = ensureRx(m.rx);
      applyRle(r.grid, m.rx.cells, rxView.data === r.grid ? rxView : null);
      if (m.rx.chart.length) r.chart.push(...m.rx.chart);
      header(r, m.rx);
      phaseToasts('rx', r);
    }
    addLog(m.log, m.suppressed);
    compose();
  }

  function phaseToasts(kind, s) {
    const key = kind === 'tx' ? s.id : `rx${s.id}`;
    const prev = app.lastPhase[key];
    if (prev === s.phase) return;
    app.lastPhase[key] = s.phase;
    if (!prev) return;
    if (kind === 'tx') {
      if (s.phase === 'done') {
        toast(s.result.verified ? 'Delivered' : 'Delivered, not verified', `${s.file.name} to ${s.peer.name} · ${fmtDur(s.result.seconds)} · ${s.result.mbps.toFixed(2)} MB/s${s.result.verified ? ' · SHA-256 verified' : ''}`, s.result.verified ? 'good' : 'bad');
      } else if (s.phase === 'failed') {
        toast('Transfer failed', s.error || 'Unknown error', 'bad');
      } else if (s.phase === 'declined') {
        toast('Declined', `${s.peer.name} declined ${s.file.name}`, 'bad');
      }
    } else if (s.phase === 'complete' && !s.loopback) {
      toast(s.result.verified ? 'File received' : 'File received, SHA-256 mismatch', `${s.file.name} from ${s.from.name}${s.result.verified ? ' · SHA-256 verified' : ''}`, s.result.verified ? 'good' : 'bad',
        [{ label: 'Show in folder', fn: () => api('/api/open', { id: s.id }).catch(() => {}) }]);
    } else if (s.phase === 'failed') {
      toast('Receive failed', s.error || 'Unknown error', 'bad');
    }
  }

  function onMeta(meta) {
    app.impair = meta.impair;
    app.settings = meta.settings;
    app.autoAccept = meta.autoAccept;
    app.pending = meta.pending || [];
    app.history = meta.history || [];
    syncControls();
    renderOffers();
    renderHistory();
    compose();
  }

  // ================================================================== composition

  function compose() {
    const { mode, tx, rx } = app;
    let sGrid = null, sTotal = 0, rGrid = null, rTotal = 0, rFocus = 0, src = '', rxActive = false;
    const txPh = $('txPlaceholder'), rxPh = $('rxPlaceholder');
    if (mode === 'send') {
      if (tx) {
        sGrid = tx.grid; sTotal = tx.file.total;
        rGrid = tx.rxGrid; rTotal = tx.file.total; rFocus = tx.rxExpected;
        src = tx.rxSource === 'local' ? 'local receiver' : 'from ACK/NAK feedback';
        rxActive = tx.phase === 'running';
      }
      setHTML(txPh, '<div><b>No outgoing transfer</b>Drop a file and press Start.</div>');
      setHTML(rxPh, '<div><b>Nothing to show</b>Starts with a transfer.</div>');
    } else {
      if (rx) {
        rGrid = rx.grid; rTotal = rx.file.total; rFocus = rx.expected;
        src = rx.loopback ? 'loopback' : `${rx.from.name} · ${rx.from.address}`;
        rxActive = rx.phase === 'receiving';
      }
      if (tx && rx && tx.id === rx.id) {
        sGrid = tx.grid; sTotal = tx.file.total;
      } else {
        setHTML(txPh, rx
          ? `<div><b>Sent from ${esc(rx.from.name)}</b>Its sender view is on that device.</div>`
          : '<div><b>Waiting for a sender</b></div>');
      }
      setHTML(rxPh, '<div><b>Nothing arriving yet</b></div>');
    }
    txView.setData(sGrid, sTotal);
    rxView.setData(rGrid, rTotal);
    if (sGrid) txView.setMeta({ focus: tx.base, winStart: tx.base, winEnd: Math.min(tx.base + tx.window - 1, tx.file.total - 1) });
    rxView.setMeta({ focus: rFocus });
    rxView.pulse = !!rGrid && rxActive && rFocus < rTotal;
    txPh.hidden = !!sGrid;
    rxPh.hidden = !!rGrid;
    $('rxSource').textContent = src;

    // header chips
    if (sGrid) {
      setHTML($('txStats'), [
        ['base', tx.base], ['next', tx.next], ['window', tx.window], ['outstanding', tx.outstanding], ['in network', tx.inNet],
      ].map(([k, v]) => `<span class="stat">${k} <b>${fmtNum(v)}</b></span>`).join('') + `<span class="stat">to <b>${esc(tx.peer.name)}</b></span>`);
    } else {
      setHTML($('txStats'), '');
    }
    if (rGrid) {
      const delivered = mode === 'send' ? tx.rxExpected : rx.expected;
      const buffered = mode === 'send' ? null : rx.buffered;
      setHTML($('rxStats'), `<span class="stat">expecting <b>P${fmtNum(rFocus)}</b></span>`
        + (buffered !== null ? `<span class="stat">buffered <b>${fmtNum(buffered)}</b></span>` : '')
        + `<span class="stat">delivered <b>${fmtNum(delivered)} / ${fmtNum(rTotal)}</b></span>`);
    } else {
      setHTML($('rxStats'), '');
    }

    if (mode === 'send') {
      chart.set(tx ? tx.chart : [], tx ? tx.marks : [], 'tx', !!tx && tx.phase === 'running' && !tx.paused);
      updateMetrics('tx', tx);
    } else {
      chart.set(rx ? rx.chart : [], [], 'rx', !!rx && rx.phase === 'receiving');
      updateMetrics('rx', rx);
    }
    renderStatus();
    renderButtons();
    renderRxNow();
  }

  function renderStatus() {
    const { tx, rx, mode, impair } = app;
    const parts = [];
    const preset = `network <b>${PRESET_NAME[impair.preset] || 'Custom'}</b>`;
    if (mode === 'send' && tx) {
      parts.push(`<span class="phase">${tx.paused ? 'Paused' : PHASE[tx.phase]}</span>`,
        `t <b>${tx.metrics.elapsed.toFixed(2)} s</b>`, `RTO <b>${fmtMs(tx.metrics.rto)}</b>`, preset);
    } else if (mode === 'receive' && rx) {
      parts.push(`<span class="phase">${PHASE[rx.phase]}</span>`, `t <b>${rx.metrics.elapsed.toFixed(2)} s</b>`,
        `from <b>${esc(rx.from.name)}</b>`);
    } else {
      parts.push('<span class="phase">Idle</span>');
      if (app.me) parts.push(`device <b>${esc(app.me.name)}</b>`, `UDP <b>${app.me.dataPort}</b>`, `discovery <b>${esc(app.me.discovery)}</b>`);
      parts.push(preset);
    }
    setHTML($('statusbar'), parts.map((p) => `<span>${p}</span>`).join(''));
  }

  function renderButtons() {
    const tx = app.tx;
    const active = tx && !FINAL.has(tx.phase);
    const peerOk = app.peers.some((p) => p.id === app.selectedPeer);
    $('startBtn').disabled = !app.staged || !peerOk || active;
    $('pauseBtn').disabled = !tx || tx.phase !== 'running';
    $('pauseBtn').textContent = tx && tx.paused ? 'Resume' : 'Pause';
    $('cancelBtn').disabled = !active;
  }

  // ================================================================== send panel

  function renderMe() {
    const me = app.me;
    if (!me) return;
    $('meName').textContent = me.name;
    const ip = me.addresses[0] ? me.addresses[0].address : '127.0.0.1';
    $('meAddr').textContent = `${ip}:${me.dataPort}`;
    $('listenAddr').textContent = me.addresses.length
      ? me.addresses.map((a) => `${a.address}:${me.dataPort}  (${a.iface})`).join('\n')
      : `127.0.0.1:${me.dataPort}`;
    $('listenAddr').style.whiteSpace = 'pre-line';
    $('saveDir').textContent = `Saving to ${me.downloadDir}`;
    $('discoTag').textContent = me.discovery === 'on' ? 'auto' : 'discovery off';
    $('discoTag').className = `tag${me.discovery === 'on' ? ' live' : ''}`;
  }

  const icon = (d) => `<svg class="oct" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICON_SELF = icon('M2.5 7 8 2.5 13.5 7v6.5a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5zM6.5 14v-4h3v4');
  const ICON_PC = icon('M2.5 2.5h11a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1zM5.5 14h5M8 11v3');
  const ICON_FILE = icon('M4 1.5h5L12.5 5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5zM9 1.5V5h3.5');
  const ICON_PHONE = icon('M5.5 1.5h5a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 4 13V3a1.5 1.5 0 0 1 1.5-1.5zM7 12.5h2');

  function renderPeers() {
    const list = $('peers');
    const peers = app.peers;
    if (!peers.some((p) => p.id === app.selectedPeer)) app.selectedPeer = 'self';
    list.innerHTML = '';
    for (const p of peers) {
      const li = document.createElement('li');
      li.className = `nav-item${p.id === app.selectedPeer ? ' sel' : ''}`;
      li.tabIndex = 0;
      const label = p.self ? 'loopback' : p.manual ? 'added by IP' : p.os || '';
      li.innerHTML = `<span class="av">${p.self ? ICON_SELF : ICON_PC}</span>
        <div class="txt"><div class="nm">${esc(p.name)}</div><div class="ad mono">${esc(p.address)}:${p.port}${label ? ` · ${esc(label)}` : ''}</div></div>`;
      const pick = () => { app.selectedPeer = p.id; renderPeers(); renderButtons(); };
      li.onclick = pick;
      li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
      list.append(li);
    }
    $('peerCount').textContent = String(peers.length);
  }

  function renderStaged() {
    const s = app.staged;
    $('fileChip').hidden = !s;
    if (!s) return renderButtons();
    const chunk = app.settings.chunk || 1400;
    $('fileName').textContent = s.name;
    $('fileName').title = s.name;
    $('fileSub').textContent = `${fmtBytes(s.size)} · ${fmtNum(Math.max(1, Math.ceil(s.size / chunk)))} packets · ${s.sha256.slice(0, 8)}`;
    renderButtons();
  }

  function stage(file) {
    if (app.mode !== 'send') setMode('send');
    const bar = $('stageProgress');
    bar.hidden = false;
    bar.firstElementChild.style.width = '0%';
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/stage?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) bar.firstElementChild.style.width = `${(e.loaded / e.total * 100).toFixed(1)}%`;
    };
    xhr.onload = () => {
      bar.hidden = true;
      if (xhr.status === 200) {
        app.staged = JSON.parse(xhr.responseText);
        renderStaged();
      } else {
        toast('Could not load the file', xhr.responseText || xhr.statusText, 'bad');
      }
    };
    xhr.onerror = () => { bar.hidden = true; toast('Could not load the file', 'The app server did not answer.', 'bad'); };
    xhr.send(file);
  }

  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) stage(f);
    e.target.value = '';
  });
  $('drop').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); }
  });
  $('clearFile').onclick = (e) => { e.preventDefault(); app.staged = null; renderStaged(); };

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    $('dropveil').classList.add('show');
    $('drop').classList.add('over');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) { $('dropveil').classList.remove('show'); $('drop').classList.remove('over'); }
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropveil').classList.remove('show');
    $('drop').classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) stage(f);
  });

  $('startBtn').onclick = async () => {
    try {
      await api('/api/send', { stageId: app.staged.stageId, peerId: app.selectedPeer });
    } catch (err) {
      toast('Could not start', err.message, 'bad');
    }
  };
  $('pauseBtn').onclick = () => api('/api/tx', { action: app.tx && app.tx.paused ? 'resume' : 'pause' }).catch(() => {});
  $('cancelBtn').onclick = () => api('/api/tx', { action: 'cancel' }).catch(() => {});
  $('rescan').onclick = () => {
    api('/api/peers', { action: 'scan' }).catch((e) => toast('Scan failed', e.message, 'bad'));
    $('rescan').classList.add('spin');
    setTimeout(() => $('rescan').classList.remove('spin'), 1600);
  };
  $('manualAdd').onclick = async () => {
    const address = $('manualIp').value.trim();
    const port = Number($('manualPort').value) || 47801;
    try {
      await api('/api/peers', { action: 'add', address, port });
      app.selectedPeer = `manual:${address}:${port}`;
      $('manualIp').value = '';
    } catch (err) {
      toast('Could not add device', err.message, 'bad');
    }
  };

  // ================================================================== receive panel

  function renderOffers() {
    const box = $('offers');
    box.innerHTML = '';
    for (const o of app.pending) {
      const d = document.createElement('div');
      d.className = 'offer incoming';
      d.innerHTML = `<div class="title">${esc(o.name)}</div>
        <div class="hint" style="margin:2px 0 0">${fmtBytes(o.size)} · from ${esc(o.from)} (${esc(o.address)})</div>`;
      const row = document.createElement('div');
      row.className = 'row';
      const no = document.createElement('button');
      no.className = 'btn small';
      no.textContent = 'Decline';
      no.onclick = () => api('/api/rx', { action: 'decline', id: o.id }).catch(() => {});
      const yes = document.createElement('button');
      yes.className = 'btn small primary';
      yes.textContent = 'Accept';
      yes.onclick = () => { api('/api/rx', { action: 'accept', id: o.id }).catch(() => {}); setMode('receive'); };
      row.append(no, yes);
      d.append(row);
      box.append(d);
      if (!app.seenOffers.has(o.id)) {
        app.seenOffers.add(o.id);
        const idle = !app.tx || FINAL.has(app.tx.phase);
        if (idle) setMode('receive');
        toast('Incoming file', `${o.name} (${fmtBytes(o.size)}) from ${o.from}`, '', [
          { label: 'Decline', fn: () => api('/api/rx', { action: 'decline', id: o.id }).catch(() => {}) },
          { label: 'Accept', primary: true, fn: () => { api('/api/rx', { action: 'accept', id: o.id }).catch(() => {}); setMode('receive'); } },
        ], 30000);
      }
    }
    const badge = $('pendingBadge');
    badge.hidden = !app.pending.length;
    badge.textContent = String(app.pending.length);
  }

  function renderRxNow() {
    const rx = app.rx;
    const box = $('rxNow');
    if (!rx || rx.phase === 'pending' || rx.phase === 'declined') { box.innerHTML = ''; return; }
    const p = rx.metrics.deliveryRate;
    const key = `${rx.id}:${rx.phase}`;
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.innerHTML = `<div class="offer">
        <div class="head"><b>${esc(rx.file.name)}</b><span class="tag" id="rxNowPhase"></span></div>
        <div class="progress"><i id="rxNowBar"></i></div>
        <div class="hint mono" id="rxNowSub"></div>
        ${rx.phase === 'receiving' ? '<div class="row"><button class="btn small danger" id="rxCancel">Cancel</button></div>' : ''}
      </div>`;
      const c = $('rxCancel');
      if (c) c.onclick = () => api('/api/rx', { action: 'cancel', id: rx.id }).catch(() => {});
    }
    $('rxNowPhase').textContent = PHASE[rx.phase] || rx.phase;
    $('rxNowPhase').className = `tag ${phaseTone(rx)}`;
    $('rxNowBar').style.width = `${p.toFixed(1)}%`;
    $('rxNowSub').textContent = rx.result
      ? `${rx.result.verified ? 'SHA-256 verified' : 'SHA-256 mismatch'} · ${fmtDur(rx.result.seconds)} · ${rx.result.mbps.toFixed(2)} MB/s`
      : rx.error || `${pct(p)} · ${rx.metrics.throughputMB.toFixed(2)} MB/s · ${fmtNum(rx.buffered)} buffered`;
  }

  function renderHistory() {
    const ul = $('history');
    ul.innerHTML = app.history.length ? '' : '<li class="empty">No files yet.</li>';
    for (const h of app.history) {
      const li = document.createElement('li');
      li.className = 'nav-item';
      const check = h.via === 'phone' ? 'over HTTP'
        : `<span class="${h.verified ? 'ok-ink' : 'bad-ink'}">${h.verified ? 'verified' : 'mismatch'}</span>`;
      li.innerHTML = `<span class="av">${h.via === 'phone' ? ICON_PHONE : ICON_FILE}</span><div class="txt"><div class="nm" title="${esc(h.path)}">${esc(h.name)}</div>
        <div class="ad">${fmtBytes(h.size)} · ${esc(h.from)} · ${check}</div></div>`;
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = 'Show';
      b.onclick = () => api('/api/open', { id: h.id }).catch(() => {});
      li.append(b);
      ul.append(li);
    }
  }

  $('autoAccept').onchange = (e) => api('/api/rx', { action: 'auto', id: e.target.checked }).catch(() => {});
  $('openFolder').onclick = () => api('/api/open', {}).catch(() => {});

  // ================================================================== phone upload

  function renderPhone() {
    const p = app.phone;
    if (!p) return;
    $('phoneOn').checked = p.running;
    $('phoneBox').hidden = !p.running;
    $('phoneErr').hidden = p.running || !p.error;
    $('phoneErr').textContent = p.error || '';
    $('phoneBtn').setAttribute('aria-pressed', String(p.running));
    if (!p.running) return;
    const urls = p.urls.length ? p.urls : [{ iface: 'no network', url: `http://127.0.0.1:${p.port}/?pin=${p.pin}` }];
    if (app.phoneAddr >= urls.length) app.phoneAddr = 0;
    const sel = $('phoneAddr');
    sel.hidden = urls.length < 2;
    setHTML(sel, urls.map((u, i) => `<option value="${i}">${esc(u.iface)} · ${esc(new URL(u.url).hostname)}</option>`).join(''));
    sel.value = String(app.phoneAddr);
    const url = urls[app.phoneAddr].url;
    if ($('phoneQr').dataset.url !== url) {
      $('phoneQr').dataset.url = url;
      $('phoneQr').innerHTML = QR.svg(url);
    }
    $('phoneUrl').textContent = url;
    $('phonePin').textContent = `${p.pin.slice(0, 3)} ${p.pin.slice(3)}`;
    setHTML($('phoneUploads'), p.uploads.map((u) => {
      const pc = u.size ? (u.bytes / u.size) * 100 : 100;
      return `<div class="offer"><div class="head"><b>${esc(u.name)}</b><span class="tag accent">${Math.floor(pc)}%</span></div>
        <div class="progress"><i style="width:${pc.toFixed(1)}%"></i></div>
        <div class="hint mono" style="margin:0">${fmtBytes(u.bytes)} / ${fmtBytes(u.size)} · ${esc(u.from)}</div></div>`;
    }).join(''));
  }

  async function setPhone(action) {
    try {
      app.phone = await api('/api/phone', { action });
    } catch (err) {
      toast('Phone upload page', err.message, 'bad');
    }
    renderPhone();
  }
  $('phoneOn').onchange = (e) => setPhone(e.target.checked ? 'on' : 'off');
  $('phonePinNew').onclick = () => setPhone('pin');
  $('phoneAddr').onchange = (e) => { app.phoneAddr = +e.target.value; renderPhone(); };
  $('phoneBtn').onclick = async () => {
    setMode('receive');
    if (!app.phone || !app.phone.running) await setPhone('on');
    $('phoneSection').scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  // ================================================================== impairments & window settings

  const capIndex = (v) => {
    if (!v) return CAP_STEPS.length - 1;
    let best = 0;
    CAP_STEPS.forEach((s, i) => { if (s && Math.abs(s - v) < Math.abs(CAP_STEPS[best] - v)) best = i; });
    return best;
  };
  const SLIDERS = {
    loss: { toUi: (v) => v * 100, toSrv: (v) => v / 100, fmt: (v) => `${(+v).toFixed(1)}%` },
    corrupt: { toUi: (v) => v * 100, toSrv: (v) => v / 100, fmt: (v) => `${(+v).toFixed(1)}%` },
    jitter: { toUi: (v) => v, toSrv: (v) => v, fmt: (v) => (+v ? `0–${v} ms` : 'none') },
    capacity: { toUi: capIndex, toSrv: (i) => CAP_STEPS[i], fmt: (i) => (CAP_STEPS[i] ? `${CAP_STEPS[i]} frames` : 'Off') },
    severity: { toUi: (v) => Math.round(v * 100), toSrv: (v) => v / 100, fmt: (v) => `${v}%` },
  };
  function paint(el) {
    el.style.setProperty('--p', `${(el.value - el.min) / (el.max - el.min) * 100}%`);
  }
  let impairPatch = {};
  let impairTimer = 0;
  for (const [key, cfg] of Object.entries(SLIDERS)) {
    const el = $(key);
    el.addEventListener('input', () => {
      paint(el);
      $(`${key}Out`).textContent = cfg.fmt(el.value);
      impairPatch[key] = cfg.toSrv(+el.value);
      for (const c of $('presets').children) c.setAttribute('aria-pressed', 'false');
      clearTimeout(impairTimer);
      impairTimer = setTimeout(() => {
        const patch = impairPatch;
        impairPatch = {};
        api('/api/impair', patch).catch(() => {});
      }, 70);
    });
  }
  $('ackLoss').onchange = (e) => api('/api/impair', { ackLoss: e.target.checked }).catch(() => {});
  $('presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (b) api('/api/impair', { preset: b.dataset.preset }).catch(() => {});
  });

  function syncControls() {
    const imp = app.impair;
    for (const [key, cfg] of Object.entries(SLIDERS)) {
      const el = $(key);
      if (document.activeElement !== el) el.value = cfg.toUi(imp[key]);
      paint(el);
      $(`${key}Out`).textContent = cfg.fmt(el.value);
    }
    $('ackLoss').checked = !!imp.ackLoss;
    for (const c of $('presets').children) c.setAttribute('aria-pressed', String(c.dataset.preset === imp.preset));
    const s = app.settings;
    for (const k of ['initialWindow', 'minWindow', 'maxWindow']) {
      if (document.activeElement !== $(k)) $(k).value = s[k];
    }
    if (document.activeElement !== $('chunk')) $('chunk').value = String(s.chunk);
    $('adaptive').checked = !!s.adaptive;
    $('autoAccept').checked = !!app.autoAccept;
    renderStaged();
  }

  $('chunk').onchange = (e) => api('/api/settings', { chunk: +e.target.value }).catch(() => {});
  for (const k of ['initialWindow', 'minWindow', 'maxWindow']) {
    $(k).onchange = (e) => api('/api/settings', { [k]: +e.target.value }).catch(() => {});
  }
  $('adaptive').onchange = (e) => api('/api/settings', { adaptive: e.target.checked }).catch(() => {});
  $('chartRange').onclick = (e) => {
    chart.all = !chart.all;
    e.target.setAttribute('aria-pressed', String(chart.all));
    e.currentTarget.textContent = chart.all ? 'Last 60 s' : 'Show all';
    chart.needs = true;
  };

  // ================================================================== mode

  function setMode(m) {
    app.mode = m;
    $('modeSwitch').dataset.mode = m;
    for (const b of $('modeSwitch').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.mode === m));
    $('sendPanel').hidden = m !== 'send';
    $('receivePanel').hidden = m !== 'receive';
    $('impairHint').textContent = m === 'send' ? 'Applied to outgoing traffic.' : "Incoming files use the sender's settings.";
    compose();
  }
  $('modeSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });

  // ================================================================== connection

  function connect() {
    const es = new EventSource('/api/stream');
    es.addEventListener('hello', (e) => onHello(JSON.parse(e.data)));
    es.addEventListener('tick', (e) => onTick(JSON.parse(e.data)));
    es.addEventListener('meta', (e) => onMeta(JSON.parse(e.data)));
    es.addEventListener('phone', (e) => { app.phone = JSON.parse(e.data); renderPhone(); });
    es.addEventListener('phonefile', (e) => {
      const f = JSON.parse(e.data);
      toast('File received', `${f.name} (${fmtBytes(f.size)}) from ${f.from}`, 'good',
        [{ label: 'Show in folder', fn: () => api('/api/open', { id: f.id }).catch(() => {}) }]);
    });
    es.onopen = () => { $('linkTag').textContent = 'Live'; $('linkTag').className = 'tag live'; };
    es.onerror = () => { $('linkTag').textContent = 'Reconnecting…'; $('linkTag').className = 'tag'; };
  }
  connect();
  compose();
})();
