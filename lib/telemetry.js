'use strict';
/**
 * Plumbing between the protocol sessions and the UI:
 *  - StateGrid: one state byte per packet, plus the set of packets that changed since the last
 *    UI tick, sent as run-length triples [start, count, state].
 *  - EventLog: the live event stream. A busy transfer produces far more events than anyone can
 *    read, so each tick keeps every important event (up to a cap) and a sample of routine ones.
 */
const { nowMs } = require('./protocol');

// Sender grid states
const S = { NOT_SENT: 0, SENT: 1, RETX: 2, LOST: 3, CORRUPTED: 4, ACK_LOST: 5, ACKED: 6 };
// Receiver grid states
const R = { NONE: 0, DELIVERED: 1, BUFFERED: 2, REJECTED: 3 };

class StateGrid {
  constructor(size) {
    this.s = new Uint8Array(size);
    this.mark = new Uint8Array(size);
    this.dirty = [];
  }

  get(i) {
    return this.s[i];
  }

  set(i, v) {
    if (this.s[i] === v) return;
    this.s[i] = v;
    if (!this.mark[i]) {
      this.mark[i] = 1;
      this.dirty.push(i);
    }
  }

  /** Changes since the last call as flat [start, count, state, ...] triples. */
  drain() {
    const d = this.dirty;
    if (!d.length) return [];
    const idx = Uint32Array.from(d).sort();
    const out = [];
    let start = idx[0], count = 1, state = this.s[start];
    this.mark[start] = 0;
    for (let k = 1; k < idx.length; k++) {
      const i = idx[k];
      this.mark[i] = 0;
      const v = this.s[i];
      if (i === start + count && v === state) {
        count++;
      } else {
        out.push(start, count, state);
        start = i; count = 1; state = v;
      }
    }
    out.push(start, count, state);
    this.dirty = [];
    return out;
  }

  snapshot() {
    return Buffer.from(this.s.buffer, this.s.byteOffset, this.s.byteLength).toString('base64');
  }
}

const IMPORTANT_CAP = 160;
const ROUTINE_CAP = 28;

class EventLog {
  constructor() {
    this.reset();
  }

  reset() {
    this.items = [];
    this.important = 0;
    this.routine = 0;
    this.suppressed = 0;
  }

  /** Call before formatting a message; false means this event is dropped from the stream. */
  want(important) {
    if (important ? this.important < IMPORTANT_CAP : this.routine < ROUTINE_CAP) return true;
    this.suppressed++;
    return false;
  }

  /** side: 'tx' | 'rx' | 'sys'.  type: SEND, ACK, TIMEOUT, ... (coloured by the UI). */
  push(side, type, msg, important) {
    if (important) this.important++; else this.routine++;
    this.items.push([Math.round(nowMs()), side, type, msg]);
  }

  /** Always shown: session lifecycle messages. */
  info(side, type, msg) {
    this.items.push([Math.round(nowMs()), side, type, msg]);
  }

  drain() {
    const out = { items: this.items, suppressed: this.suppressed };
    this.reset();
    return out;
  }
}

module.exports = { S, R, StateGrid, EventLog };
