'use strict';
/**
 * Wire format shared by every ARQ Beam frame (big-endian, 28-byte header):
 *
 *   0  u16 magic 0x4142 ("AB")     12 u32 aux   (ACK: receiver's next expected seq)
 *   2  u8  version                 16 u32 ts    (µs clock of the sender; echoed back in ACK/NAK)
 *   3  u8  type                    20 u16 payload length
 *   4  u32 transfer id             22 u16 flags
 *   8  u32 sequence number         24 u32 CRC-32 over header (crc field = 0) + payload
 *
 * Control frames (OFFER, ACCEPT, FIN, ...) carry a small JSON payload.
 */
const zlib = require('zlib');

const MAGIC = 0x4142;
const VERSION = 1;
const HEADER = 28;

const T = {
  DATA: 1, ACK: 2, NAK: 3,
  OFFER: 4, ACCEPT: 5, DECLINE: 6,
  FIN: 7, FIN_ACK: 8, CANCEL: 9,
};
const TYPE_NAME = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

const F = {
  RETX: 1,        // DATA: this is a retransmission
  DUP: 2,         // ACK: receiver already had this packet
};

const crc32 = zlib.crc32 || jsCrc32;

function encode(type, id, seq, aux, ts, flags, payload) {
  const len = payload ? payload.length : 0;
  const buf = Buffer.allocUnsafe(HEADER + len);
  buf.writeUInt16BE(MAGIC, 0);
  buf.writeUInt8(VERSION, 2);
  buf.writeUInt8(type, 3);
  buf.writeUInt32BE(id >>> 0, 4);
  buf.writeUInt32BE(seq >>> 0, 8);
  buf.writeUInt32BE(aux >>> 0, 12);
  buf.writeUInt32BE(ts >>> 0, 16);
  buf.writeUInt16BE(len, 20);
  buf.writeUInt16BE(flags & 0xffff, 22);
  buf.writeUInt32BE(0, 24);
  if (len) payload.copy(buf, HEADER);
  let crc = crc32(buf.subarray(0, 24));
  if (len) crc = crc32(buf.subarray(HEADER), crc);
  buf.writeUInt32BE(crc >>> 0, 24);
  return buf;
}

/** Returns null for frames that are not ours. `crcOk` is false for damaged frames. */
function decode(buf) {
  if (buf.length < HEADER || buf.readUInt16BE(0) !== MAGIC || buf.readUInt8(2) !== VERSION) return null;
  const len = buf.readUInt16BE(20);
  if (HEADER + len !== buf.length) return null;
  const stored = buf.readUInt32BE(24);
  buf.writeUInt32BE(0, 24);
  let crc = crc32(buf.subarray(0, 24));
  if (len) crc = crc32(buf.subarray(HEADER), crc);
  buf.writeUInt32BE(stored, 24);
  return {
    type: buf.readUInt8(3),
    id: buf.readUInt32BE(4),
    seq: buf.readUInt32BE(8),
    aux: buf.readUInt32BE(12),
    ts: buf.readUInt32BE(16),
    flags: buf.readUInt16BE(22),
    payload: buf.subarray(HEADER),
    crcOk: (crc >>> 0) === stored,
  };
}

function encodeJson(type, id, obj) {
  return encode(type, id, 0, 0, 0, 0, Buffer.from(JSON.stringify(obj)));
}

function parseJson(frame) {
  try { return JSON.parse(frame.payload.toString('utf8')); } catch { return null; }
}

/** Flip one random payload bit after the CRC was computed, so the receiver's check fails. */
function corrupt(buf) {
  const len = buf.length - HEADER;
  const at = len > 0 ? HEADER + Math.floor(Math.random() * len) : 24;
  buf[at] ^= 1 << Math.floor(Math.random() * 8);
}

const T0 = process.hrtime.bigint();
/** Monotonic milliseconds since start (float). */
function nowMs() {
  return Number(process.hrtime.bigint() - T0) / 1e6;
}
/** 32-bit wrapping microsecond clock used for the timestamp echo. */
function nowUs32() {
  return Number((process.hrtime.bigint() - T0) / 1000n & 0xffffffffn);
}
/** Round trip in ms from an echoed timestamp. */
function rttFromEcho(tsecr) {
  return ((nowUs32() - tsecr) >>> 0) / 1000;
}

let table;
function jsCrc32(data, value = 0) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = ~value;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

module.exports = {
  MAGIC, VERSION, HEADER, T, TYPE_NAME, F,
  encode, decode, encodeJson, parseJson, corrupt,
  nowMs, nowUs32, rttFromEcho,
};
