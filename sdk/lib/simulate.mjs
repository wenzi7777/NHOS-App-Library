// @ts-check
/**
 * Run a flow graph against frames, without a device.
 *
 * This is more than a convenience. The graph's semantics -- how a threshold
 * latches, when a debounce commits, which edge emits -- would otherwise exist
 * only in the firmware's C++. This file is the executable specification of the
 * same rules, written against `FlowApp::evaluate` case for case, and the tests
 * pin the behaviour an author can rely on.
 *
 * It follows the device where the Python simulator it replaced did not:
 *
 * - Arithmetic is 32-bit float (`Math.fround` after every operation), as on
 *   the ESP32. Thresholds near a boundary and long integrations come out the
 *   way the device computes them, not the way a double would.
 * - `peak` and `arg_max` start from 0, so an all-negative frame reads 0 / 0.
 * - `delta` starts from the node's `value` field, which the device reuses as
 *   its previous-sample slot.
 * - Events are recorded only when the package declares `emit_event`, and LED
 *   changes are not events at all -- the device drives the LED and logs
 *   nothing. They are reported separately here so they can be shown.
 * - `budget_load` / `grace_left` read whatever `setBudget()` last latched,
 *   the same way a Budget event does on the device, so a self-degrading gate
 *   can be exercised offline.
 * - `button` is true for one frame per `pressButton()`, with a false frame
 *   between presses so each is its own rising edge, and only when the package
 *   declares `button` -- the device delivers presses to nobody else. At most
 *   MAX_PENDING_PRESSES wait; a press is taken even if a gate skips the node.
 * - The OLED rows are rebuilt every frame from the nodes that ran, so a row
 *   drawn inside a closed gate is blank, and a package without `display`
 *   draws nothing. `oledRows()` returns them rendered, via oled.mjs.
 */

import {
  FEATURE_FIELDS,
  LED_COLOURS,
  MAX_PENDING_PRESSES,
  OLED_ROWS,
  PRESSURE_ACTIVE_THRESHOLD,
  PRESSURE_FULL_SCALE,
} from "./opset.mjs";
import { formatOledTextLine, oledBarGeometry } from "./oled.mjs";

const f32 = Math.fround;
const ACTIVE = f32(PRESSURE_ACTIVE_THRESHOLD);
const FULL_SCALE = f32(PRESSURE_FULL_SCALE);

/**
 * @typedef {object} Frame
 * @property {number} seq frame sequence number (the device's frame_seq)
 * @property {number} timestampMs
 * @property {ArrayLike<number>} values row-major cell values
 * @property {number} rows
 * @property {number} cols
 */

/**
 * @typedef {object} SimEvent
 * @property {number} seq
 * @property {number} frameSeq
 * @property {number} timestampMs
 * @property {string} app
 * @property {string} event
 * @property {string} detail rise/fall, or the formatted value for emit_value
 * @property {number|null} value
 */

/**
 * @typedef {object} LedChange
 * @property {number} frameSeq
 * @property {number} timestampMs
 * @property {string} colour
 * @property {readonly [number, number, number]} rgb
 * @property {number} node
 */

/**
 * One OLED row as the device's "app" page draws it.
 * @typedef {object} OledRow
 * @property {"text"|"bar"} kind
 * @property {string} label
 * @property {number} value
 * @property {number} node the node that drew it
 * @property {string} [text] the whole row, for a text row (OLED_COLS characters)
 * @property {import("./oled.mjs").OledBarGeometry} [bar] for a bar row
 */

/**
 * @typedef {object} NodeValue
 * @property {string} op
 * @property {number} result
 * @property {boolean} bool
 * @property {boolean} skipped
 */

/**
 * The same eight fields the device's `features` op computes, in float32.
 * @param {Frame} frame
 * @returns {Record<string, number>}
 */
export function computeFeatures(frame) {
  const values = frame.values;
  const cols = frame.cols || 1;
  let total = 0;
  let peak = 0;
  let peakIndex = 0;
  let active = 0;
  let weightedRow = 0;
  let weightedCol = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = f32(values[i]);
    total = f32(total + value);
    if (value > peak) {
      peak = value;
      peakIndex = i;
    }
    if (value >= ACTIVE) {
      active += 1;
      // Weight by pressure, so the centroid is the centre of *force*, not the
      // centre of the contact patch's bounding box.
      weightedRow = f32(weightedRow + f32(value * Math.floor(i / cols)));
      weightedCol = f32(weightedCol + f32(value * (i % cols)));
    }
  }
  const peak01 = Math.min(f32(peak / FULL_SCALE), 1);
  return {
    total_force: total,
    peak,
    peak01,
    peak_index: peakIndex,
    active_cells: active,
    centroid_row: total > 0 ? f32(weightedRow / total) : 0,
    centroid_col: total > 0 ? f32(weightedCol / total) : 0,
    in_contact: active > 0 ? 1 : 0,
  };
}

/** @param {unknown} raw */
function inputsOf(raw) {
  if (raw === undefined || raw === null) return [];
  return Array.isArray(raw) ? raw.map(Number) : [Number(raw)];
}

/** Per-node evaluation state, as FlowNode keeps it. */
class NodeState {
  /** @param {Record<string, any>} node */
  constructor(node) {
    this.result = 0;
    this.boolResult = false;
    this.lastBool = false;
    this.sinceMs = 0;
    // Delta keeps its previous sample in the node's own `value`.
    this.prev = f32(Number(node.value ?? 0));
    const window = Math.max(0, Math.trunc(Number(node.window ?? 0)));
    this.ring = new Float32Array(window);
    this.cursor = 0;
    this.filled = 0;
    this.skipped = false;
  }
}

export class Simulator {
  /**
   * @param {Record<string, any>} pkg a flow package
   * @param {{appName?: string}} [options] the name events are recorded under
   *   (the device uses the slot name, e.g. "flow1"; defaults to the package id)
   */
  constructor(pkg, options = {}) {
    if (pkg.kind === "readout") throw new Error("a readout package has no graph to simulate");
    /** @type {Record<string, any>[]} */
    this.nodes = Array.isArray(pkg.nodes) ? pkg.nodes : [];
    const manifest = pkg.manifest ?? {};
    const caps = new Set(Array.isArray(manifest.capabilities) ? manifest.capabilities : []);
    this.canEmit = caps.has("emit_event");
    this.canDriveLed = caps.has("drive_led");
    this.canDisplay = caps.has("display");
    this.hearsButton = caps.has("button");
    this.pendingPresses = 0;
    this.pressShown = false;
    /** Which node drew each OLED row on the last frame, or -1. */
    /** @type {number[]} */
    this.displayNode = new Array(OLED_ROWS).fill(-1);
    this.appName = options.appName ?? String(manifest.id ?? pkg.name ?? "flow");
    this.budgetLoad = 0;
    this.graceLeft = 0;
    /** @type {NodeState[]} */
    this.states = [];
    /** @type {Record<string, number>} */
    this.features = {};
    /** @type {SimEvent[]} */
    this.events = [];
    /** @type {LedChange[]} */
    this.ledChanges = [];
    /** @type {readonly [number, number, number]} */
    this.led = LED_COLOURS.off;
    this.seq = 0;
    this.frames = 0;
    /** @type {boolean} */
    this.degraded = false;
    this.degradations = 0;
    this.reset();
  }

  /** Forget all state, as a fresh load on the device would. */
  reset() {
    this.states = this.nodes.map((node) => new NodeState(node));
    this.features = Object.fromEntries(FEATURE_FIELDS.map((name) => [name, 0]));
    this.events = [];
    this.ledChanges = [];
    this.led = LED_COLOURS.off;
    this.seq = 0;
    this.frames = 0;
    this.degraded = false;
    this.degradations = 0;
    this.pendingPresses = 0;
    this.pressShown = false;
    this.displayNode = new Array(OLED_ROWS).fill(-1);
  }

  /** A short press of the action button, seen by the next free frame. */
  pressButton() {
    if (this.hearsButton && this.pendingPresses < MAX_PENDING_PRESSES) this.pendingPresses += 1;
  }

  /**
   * Latch budget pressure, as a Budget event does on the device.
   * @param {number} load measured cost over allocation
   * @param {number} graceLeft overruns left before the app is stopped
   */
  setBudget(load, graceLeft) {
    this.budgetLoad = f32(load);
    this.graceLeft = Math.max(0, Math.min(255, Math.trunc(graceLeft)));
  }

  /**
   * @param {Frame} frame
   * @param {string} event
   * @param {string} detail
   * @param {number|null} [value]
   */
  record(frame, event, detail, value = null) {
    if (!this.canEmit) return;
    this.seq += 1;
    this.events.push({
      seq: this.seq,
      frameSeq: frame.seq,
      timestampMs: frame.timestampMs,
      app: this.appName,
      event,
      detail,
      value,
    });
  }

  /** @param {Iterable<Frame>} frames */
  run(frames) {
    for (const frame of frames) this.step(frame);
    return this;
  }

  /**
   * Evaluate one frame. Returns the events that frame produced.
   * @param {Frame} frame
   * @returns {SimEvent[]}
   */
  step(frame) {
    const firstEvent = this.events.length;
    const values = frame.values;
    const cells = values.length;
    const rows = frame.rows;
    const cols = frame.cols || 1;
    const nowMs = frame.timestampMs >>> 0;
    const states = this.states;
    const count = this.nodes.length;
    let skipUntil = 0;
    let skippedAny = false;
    this.frames += 1;
    let pressed = false;
    if (this.pressShown) {
      this.pressShown = false;
    } else if (this.pendingPresses !== 0) {
      this.pendingPresses -= 1;
      pressed = true;
      this.pressShown = true;
    }
    this.displayNode.fill(-1);

    for (let i = 0; i < count; i += 1) {
      const node = this.nodes[i];
      const state = states[i];
      if (i < skipUntil) {
        // Held at its previous value rather than zeroed, so a gated branch
        // resumes from where it was instead of glitching through zero.
        state.skipped = true;
        skippedAny = true;
        continue;
      }
      state.skipped = false;
      const refs = inputsOf(node.in);
      const a = () => states[refs[0]];
      const b = () => states[refs[1]];

      switch (node.op) {
        case "total": {
          let sum = 0;
          for (let c = 0; c < cells; c += 1) sum = f32(sum + values[c]);
          state.result = sum;
          break;
        }
        case "peak": {
          let peak = 0;
          for (let c = 0; c < cells; c += 1) if (f32(values[c]) > peak) peak = f32(values[c]);
          state.result = peak;
          break;
        }
        case "region_sum": {
          let sum = 0;
          const r0 = Number(node.r0) & 0xff;
          const r1 = Number(node.r1) & 0xff;
          const c0 = Number(node.c0) & 0xff;
          const c1 = Number(node.c1) & 0xff;
          for (let r = r0; r <= r1 && r < rows; r += 1) {
            for (let c = c0; c <= c1 && c < cols; c += 1) {
              const index = r * cols + c;
              if (index < cells) sum = f32(sum + values[index]);
            }
          }
          state.result = sum;
          break;
        }
        case "active_cells": {
          const limit = f32(Number(node.value ?? 0));
          let active = 0;
          for (let c = 0; c < cells; c += 1) if (f32(values[c]) >= limit) active += 1;
          state.result = active;
          break;
        }
        case "arg_max": {
          let peak = 0;
          let index = 0;
          for (let c = 0; c < cells; c += 1) {
            if (f32(values[c]) > peak) {
              peak = f32(values[c]);
              index = c;
            }
          }
          state.result = index;
          break;
        }
        case "row_centroid":
        case "col_centroid": {
          let total = 0;
          let weighted = 0;
          for (let c = 0; c < cells; c += 1) {
            const value = f32(values[c]);
            if (value < ACTIVE) continue;
            total = f32(total + value);
            const position = node.op === "row_centroid" ? Math.floor(c / cols) : c % cols;
            weighted = f32(weighted + f32(value * position));
          }
          state.result = total > 0 ? f32(weighted / total) : 0;
          break;
        }
        case "features":
          this.features = computeFeatures(frame);
          state.result = this.features.total_force;
          break;
        case "feature_get":
          state.result = this.features[String(node.field)] ?? 0;
          state.boolResult = state.result !== 0;
          break;
        case "const":
          state.result = f32(Number(node.value ?? 0));
          break;
        case "add": state.result = f32(a().result + b().result); break;
        case "sub": state.result = f32(a().result - b().result); break;
        case "mul": state.result = f32(a().result * b().result); break;
        case "div": {
          const divisor = b().result;
          // Zero rather than NaN: one bad frame must not poison every
          // downstream node for the rest of the session.
          state.result = divisor !== 0 ? f32(a().result / divisor) : 0;
          break;
        }
        case "min": state.result = a().result < b().result ? a().result : b().result; break;
        case "max": state.result = a().result > b().result ? a().result : b().result; break;
        case "abs": state.result = Math.abs(a().result); break;
        case "clamp": {
          let value = a().result;
          const lo = f32(Number(node.lo ?? 0));
          const hi = f32(Number(node.hi ?? 0));
          if (value < lo) value = lo;
          if (value > hi) value = hi;
          state.result = value;
          break;
        }
        case "mean":
        case "max_hold":
        case "integrate":
          state.result = pushWindow(state, a().result, node.op);
          break;
        case "delta": {
          const current = a().result;
          state.result = f32(current - state.prev);
          state.prev = current;
          break;
        }
        case "counter": {
          const current = a().boolResult;
          if (current && !state.lastBool) state.result = f32(state.result + 1);
          state.lastBool = current;
          break;
        }
        case "threshold": {
          const input = a().result;
          const value = f32(Number(node.value ?? 0));
          // Hysteresis: once latched, hold until the input falls below
          // value - hysteresis. Without it a signal sitting on the threshold
          // emits an event every single frame.
          const releaseAt = f32(value - f32(Number(node.hysteresis ?? 0)));
          state.boolResult = state.boolResult ? input > releaseAt : input >= value;
          state.result = state.boolResult ? 1 : 0;
          break;
        }
        case "debounce": {
          const raw = a().boolResult;
          const ms = Number(node.ms ?? 0) > 0 ? Number(node.ms) & 0xffff : 0;
          if (raw !== state.lastBool) {
            state.lastBool = raw;
            state.sinceMs = nowMs;
          } else if (raw !== state.boolResult && ((nowMs - state.sinceMs) >>> 0) >= ms) {
            state.boolResult = raw;
          }
          state.result = state.boolResult ? 1 : 0;
          break;
        }
        case "emit": {
          const current = a().boolResult;
          if (current !== state.lastBool) {
            state.lastBool = current;
            state.boolResult = current;
            this.record(frame, String(node.event), current ? "rise" : "fall");
          }
          break;
        }
        case "emit_value": {
          const current = a().boolResult;
          if (current && !state.lastBool) {
            const value = b().result;
            this.record(frame, String(node.event), value.toFixed(3), value);
          }
          state.lastBool = current;
          break;
        }
        case "led": {
          const current = a().boolResult;
          if (current !== state.lastBool) {
            state.lastBool = current;
            if (this.canDriveLed) {
              const colour = current ? String(node.rgb) : "off";
              const rgb = LED_COLOURS[colour] ?? LED_COLOURS.off;
              this.led = rgb;
              this.ledChanges.push({ frameSeq: frame.seq, timestampMs: frame.timestampMs, colour, rgb, node: i });
            }
          }
          break;
        }
        case "select":
          state.result = a().boolResult ? b().result : states[refs[2]].result;
          break;
        case "gate": {
          // Skips FOLLOWING nodes, not earlier ones: with backward-only data
          // references a subtree has already run by the time we reach here.
          state.boolResult = a().boolResult;
          state.result = state.boolResult ? 1 : 0;
          const span = Number(node.span ?? 0) & 0xff;
          if (!state.boolResult && span > 0) skipUntil = Math.min(i + 1 + span, count);
          break;
        }
        case "mod": {
          const divisor = b().result;
          // Zero rather than NaN, as div does. JavaScript's % is C's fmod.
          state.result = divisor !== 0 ? f32(a().result % divisor) : 0;
          break;
        }
        case "button":
          state.boolResult = pressed;
          state.result = pressed ? 1 : 0;
          break;
        case "oled_text":
        case "oled_bar":
          // Two nodes on one row is legitimate (two gated pages): the later
          // one wins, as on the device.
          state.result = a().result;
          if (Number(node.row) >= 0 && Number(node.row) < OLED_ROWS) this.displayNode[Number(node.row)] = i;
          break;
        case "budget_load": state.result = this.budgetLoad; break;
        case "grace_left": state.result = this.graceLeft; break;
        default:
          break;
      }
    }

    // Degradation is recorded, not silent: on a research instrument a signal
    // that quietly changes fidelity would put a step in the data that has
    // nothing to do with the subject.
    if (skippedAny !== this.degraded) {
      this.degraded = skippedAny;
      if (skippedAny) this.degradations += 1;
      this.record(frame, "degraded", skippedAny ? "rise" : "fall");
    }
    return this.events.slice(firstEvent);
  }

  /**
   * The OLED rows the last frame drew, `null` where it drew nothing.
   * @returns {(OledRow|null)[]}
   */
  oledRows() {
    return this.displayNode.map((index) => {
      if (!this.canDisplay || index < 0) return null;
      const node = this.nodes[index];
      const label = String(node.label ?? "");
      const value = this.states[index].result;
      if (node.op === "oled_bar") {
        const bar = oledBarGeometry(label.length, value, Number(node.lo ?? 0), Number(node.hi ?? 0));
        return { kind: "bar", label, value, node: index, bar };
      }
      const text = formatOledTextLine(label, value, Number(node.digits ?? 0));
      return { kind: "text", label, value, node: index, text };
    });
  }

  /**
   * Every node's current output, for a live trace.
   * @returns {NodeValue[]}
   */
  nodeValues() {
    return this.nodes.map((node, index) => ({
      op: String(node.op),
      result: this.states[index].result,
      bool: this.states[index].boolResult,
      skipped: this.states[index].skipped,
    }));
  }
}

/**
 * Mirrors FlowApp::pushWindow, including its warm-up behaviour: only the
 * samples actually written are considered, so a mean over the first few
 * frames is the mean of those frames -- not of them plus a tail of zeros the
 * device has never seen.
 * @param {NodeState} state
 * @param {number} sample
 * @param {string} op
 */
function pushWindow(state, sample, op) {
  const ring = state.ring;
  const window = ring.length;
  if (window === 0) return 0;
  ring[state.cursor] = sample;
  state.cursor = (state.cursor + 1) % window;
  if (state.filled < window) state.filled += 1;
  if (op === "max_hold") {
    let peak = ring[0];
    for (let i = 1; i < state.filled; i += 1) if (ring[i] > peak) peak = ring[i];
    return peak;
  }
  let sum = 0;
  for (let i = 0; i < state.filled; i += 1) sum = f32(sum + ring[i]);
  // Integrate reports the accumulated total over the window; mean divides it.
  return op === "integrate" ? sum : state.filled > 0 ? f32(sum / state.filled) : 0;
}

/**
 * Convenience: run a package over frames from a fresh start.
 * @param {Record<string, any>} pkg
 * @param {Iterable<Frame>} frames
 * @param {{appName?: string}} [options]
 */
export function simulate(pkg, frames, options = {}) {
  return new Simulator(pkg, options).run(frames);
}
