'use strict';
/**
 * Minimal QR code encoder for the phone-upload link: byte mode, error correction level M,
 * versions 1–10 (up to 213 bytes). QR.matrix(text) returns rows of booleans (true = dark),
 * QR.svg(text) an SVG string with a 4-module quiet zone.
 */
(function (root) {
  const EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];   // level M, by version
  const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
    (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
  ];

  /** Modules left for data and error correction once the function patterns are placed. */
  function rawModules(ver) {
    let n = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const align = Math.floor(ver / 7) + 2;
      n -= (25 * align - 10) * align - 55;
      if (ver >= 7) n -= 36;
    }
    return n;
  }
  const totalCodewords = (ver) => Math.floor(rawModules(ver) / 8);
  const dataCodewords = (ver) => totalCodewords(ver) - EC_PER_BLOCK[ver] * BLOCKS[ver];

  // ---------------------------------------------------------------- Reed–Solomon over GF(256)

  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function rsDivisor(degree) {
    const r = new Array(degree).fill(0);
    r[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        r[j] = gfMul(r[j], root);
        if (j + 1 < degree) r[j] ^= r[j + 1];
      }
      root = gfMul(root, 2);
    }
    return r;
  }

  function rsRemainder(data, divisor) {
    const out = new Array(divisor.length).fill(0);
    for (const b of data) {
      const factor = b ^ out.shift();
      out.push(0);
      for (let i = 0; i < divisor.length; i++) out[i] ^= gfMul(divisor[i], factor);
    }
    return out;
  }

  // ---------------------------------------------------------------- codewords

  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let ver = 1;
    while (ver <= 10 && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
    if (ver > 10) throw new Error('Text too long for this QR encoder');
    const bits = [];
    const push = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    push(0b0100, 4);                                    // byte mode
    push(bytes.length, ver < 10 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    const capacity = dataCodewords(ver) * 8;
    push(0, Math.min(4, capacity - bits.length));      // terminator
    push(0, (8 - (bits.length % 8)) % 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let pad = 0xec; data.length < capacity / 8; pad ^= 0xec ^ 0x11) data.push(pad);
    return { ver, codewords: interleave(ver, data) };
  }

  /** Splits data into blocks, adds error correction to each, then interleaves them. */
  function interleave(ver, data) {
    const nBlocks = BLOCKS[ver];
    const ec = EC_PER_BLOCK[ver];
    const total = totalCodewords(ver);
    const shortLen = Math.floor(total / nBlocks);
    const nShort = nBlocks - (total % nBlocks);
    const divisor = rsDivisor(ec);
    const blocks = [];
    for (let i = 0, k = 0; i < nBlocks; i++) {
      const len = shortLen - ec + (i < nShort ? 0 : 1);
      const d = data.slice(k, k + len);
      k += len;
      blocks.push({ d, e: rsRemainder(d, divisor) });
    }
    const out = [];
    for (let i = 0; i <= shortLen - ec; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
    for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i]);
    return out;
  }

  // ---------------------------------------------------------------- matrix

  function alignPositions(ver) {
    if (ver === 1) return [];
    const n = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const out = [6];
    for (let pos = ver * 4 + 10; out.length < n; pos -= step) out.splice(1, 0, pos);
    return out;
  }

  function drawFormat(set, size, mask) {
    const data = mask;                                  // level M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  }

  function drawVersion(set, size, ver) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  /** opts.mask forces one of the 8 masks instead of picking the lowest penalty. */
  function matrix(text, opts = {}) {
    const { ver, codewords } = encode(text);
    const size = ver * 4 + 17;
    const grid = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => {
      grid[y][x] = dark;
      fixed[y][x] = true;
    };

    for (let i = 0; i < size; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const al = alignPositions(ver);
    const last = al.length - 1;
    for (let i = 0; i < al.length; i++) {
      for (let j = 0; j < al.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    drawFormat(set, size, 0);                           // reserves the format area
    if (ver >= 7) drawVersion(set, size, ver);

    // Data in two-module columns, zigzagging up and down from the bottom right.
    let bit = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let v = 0; v < size; v++) {
        const y = upward ? size - 1 - v : v;
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          if (fixed[y][x] || bit >= codewords.length * 8) continue;
          grid[y][x] = ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1;
          bit++;
        }
      }
    }

    let best = null;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      if (opts.mask !== undefined && mask !== opts.mask) continue;
      const m = grid.map((row, y) => row.map((dark, x) => (fixed[y][x] ? dark : dark !== MASKS[mask](x, y))));
      drawFormat((x, y, dark) => { m[y][x] = dark; }, size, mask);
      const score = penalty(m);
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  }

  /** The standard mask penalty: long runs, 2×2 blocks, finder look-alikes, dark/light balance. */
  function penalty(m) {
    const size = m.length;
    let score = 0;
    let dark = 0;
    const finderA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const finderB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const scan = (get) => {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && get(i) === get(i - 1)) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      const at = (i) => (i >= 0 && i < size && get(i) ? 1 : 0);
      for (let i = -4; i + 11 <= size + 4; i++) {
        let a = true, b = true;
        for (let k = 0; k < 11; k++) {
          const v = at(i + k);
          if (v !== finderA[k]) a = false;
          if (v !== finderB[k]) b = false;
        }
        if (a) score += 40;
        if (b) score += 40;
      }
    };
    for (let y = 0; y < size; y++) {
      scan((x) => m[y][x]);
      scan((x) => m[x][y]);
      for (let x = 0; x < size; x++) {
        if (m[y][x]) dark++;
        if (y < size - 1 && x < size - 1) {
          const c = m[y][x];
          if (m[y][x + 1] === c && m[y + 1][x] === c && m[y + 1][x + 1] === c) score += 3;
        }
      }
    }
    const total = size * size;
    score += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }

  function svg(text, { margin = 4, dark = '#000', light = '#fff' } = {}) {
    const m = matrix(text);
    const n = m.length + margin * 2;
    let d = '';
    m.forEach((row, y) => row.forEach((on, x) => {
      if (on) d += `M${x + margin} ${y + margin}h1v1h-1z`;
    }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">`
      + `<rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
  }

  const QR = { matrix, svg };
  if (typeof module !== 'undefined' && module.exports) module.exports = QR;
  else root.QR = QR;
})(this);
