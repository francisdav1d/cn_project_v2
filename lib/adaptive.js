'use strict';
/**
 * Adaptive window controller, ported from AdaptiveWindowController.java of Adaptive-SR-ARQ.
 *
 * Feedback is collected for one "round" (one window's worth of ACKs and failures, about one RTT).
 * At the end of each round:
 *   failure rate   f = (timeouts + NAKs) / feedback, compared with the network's normal rate p
 *   variation      sigma = sqrt(p(1-p)/n)
 *   delay ratio    d = round's average RTT / long-term average RTT
 *
 *   f - p > max(3 sigma, 20%)  or d >= 2.0  ->  window / 2
 *   f - p > 2 sigma            or d >= 1.4  ->  window - 1
 *   f - p <= sigma            and d <= 1.2  ->  window + 1   (x2 during slow start)
 *   otherwise                               ->  unchanged
 *
 * One change for real networks: the delay ratio adds a small floor to both RTTs. A LAN round trip
 * is well under a millisecond and OS scheduling noise alone could double it, which would otherwise
 * read as congestion.
 */
const SEVERE_EXCESS_SIGMAS = 3.0;
const SEVERE_EXCESS_MIN = 0.20;
const HIGH_EXCESS_SIGMAS = 2.0;
const LOW_EXCESS_SIGMAS = 1.0;
const SEVERE_DELAY_RATIO = 2.0;
const HIGH_DELAY_RATIO = 1.4;
const LOW_DELAY_RATIO = 1.2;
const BASELINE_LEARN_BETTER = 0.20;
const BASELINE_LEARN_WORSE = 0.05;
const RTT_SMOOTHING = 0.20;
const DELAY_FLOOR_MS = 4;

class AdaptiveWindow {
  constructor({ initial = 4, min = 1, max = 256, enabled = true }) {
    this.min = Math.max(1, min);
    this.max = Math.max(this.min, max);
    this.window = clamp(initial, this.min, this.max);
    this.enabled = enabled;
    this.slowStart = true;
    this.slowStartThreshold = Math.max(this.min, Math.floor(this.max / 2));
    this.roundAcks = 0;
    this.roundFailures = 0;
    this.roundRttSum = 0;
    this.normalFailureRate = -1;
    this.longTermRtt = -1;
    this.lastFailureRate = 0;
    this.lastDelayRatio = 1;
  }

  /** Receiver advertised a smaller buffer than our maximum. */
  capMax(limit) {
    this.max = Math.max(this.min, Math.min(this.max, limit));
    this.slowStartThreshold = Math.max(this.min, Math.floor(this.max / 2));
    this.window = clamp(this.window, this.min, this.max);
  }

  get mode() {
    if (!this.enabled) return 'Fixed window';
    return this.slowStart ? 'Slow start' : 'Congestion avoidance';
  }

  /** A new packet was acknowledged after `rtt` ms. Returns a change record or null. */
  onAck(rtt) {
    this.roundAcks++;
    this.roundRttSum += rtt;
    return this.evaluate();
  }

  /** A packet had to be retransmitted (timeout or NAK). */
  onFailure() {
    this.roundFailures++;
    return this.evaluate();
  }

  evaluate() {
    const current = this.window;
    const feedback = this.roundAcks + this.roundFailures;
    if (feedback < current) return null;

    const failureRate = this.roundFailures / feedback;
    if (this.normalFailureRate < 0) this.normalFailureRate = failureRate;
    const normal = this.normalFailureRate;
    const sigma = Math.sqrt(Math.max(normal * (1 - normal), 0.01) / feedback);
    const excess = failureRate - normal;
    const learn = failureRate > normal ? BASELINE_LEARN_WORSE : BASELINE_LEARN_BETTER;
    this.normalFailureRate += learn * (failureRate - this.normalFailureRate);

    let delayRatio = 1;
    if (this.roundAcks > 0) {
      const avg = this.roundRttSum / this.roundAcks;
      if (this.longTermRtt < 0) this.longTermRtt = avg;
      delayRatio = (avg + DELAY_FLOOR_MS) / (this.longTermRtt + DELAY_FLOOR_MS);
      this.longTermRtt += RTT_SMOOTHING * (avg - this.longTermRtt);
    }

    this.lastFailureRate = failureRate;
    this.lastDelayRatio = delayRatio;
    this.roundAcks = 0;
    this.roundFailures = 0;
    this.roundRttSum = 0;

    if (!this.enabled) return null;

    let target, verdict, kind;
    if (excess > Math.max(SEVERE_EXCESS_SIGMAS * sigma, SEVERE_EXCESS_MIN) || delayRatio >= SEVERE_DELAY_RATIO) {
      target = Math.floor(current / 2);
      this.slowStart = false;
      kind = 'halve';
      verdict = 'failure spike: loss/delay jumped well above normal, halving window';
    } else if (excess > HIGH_EXCESS_SIGMAS * sigma || delayRatio >= HIGH_DELAY_RATIO) {
      target = current - 1;
      this.slowStart = false;
      kind = 'shrink';
      verdict = 'loss/delay rising, shrinking window';
    } else if (excess <= LOW_EXCESS_SIGMAS * sigma && delayRatio <= LOW_DELAY_RATIO) {
      if (this.slowStart && current * 2 >= this.slowStartThreshold) {
        this.slowStart = false;
        target = Math.max(current + 1, this.slowStartThreshold);
      } else {
        target = this.slowStart ? current * 2 : current + 1;
      }
      kind = target >= current * 2 ? 'double' : 'grow';
      verdict = kind === 'double' ? 'no rise in loss or delay, doubling (slow start)' : 'no rise in loss or delay, growing window';
    } else {
      return null;
    }
    target = clamp(target, this.min, this.max);
    if (target === current) return null;
    this.window = target;
    return { from: current, to: target, kind, verdict, failureRate, normal, delayRatio };
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

module.exports = { AdaptiveWindow };
