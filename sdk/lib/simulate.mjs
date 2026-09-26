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
 * - The external strip is rebuilt the same way: a pixel is lit on frames its
 *   node runs with a true input, the meter shows its node's last value, and a
 *   package without `drive_ext_led` holds nothing. `extLedFrame()` returns
 *   the state and `extLeds(count)` the strip as a board of `count` pixels
 *   shows it, via extled.mjs.
 * - `imu` and `mag` read the frame's `imu` / `mag` sample, and hold their last
 *   value when a frame has none or the package lacks read_imu / read_mag.
 *   `battery` reads -1 without `power`, `linked` false without `link`, as the
 *   device strips them. `setBattery()` / `setLinked()` set what they read.
 * - `tick(nowMs)` is the device's 10 Hz tick: a package with `tick` is
 *   evaluated on it only while no frame has arrived for TICK_FALLBACK_MS, and
 *   every matrix read then holds its last value.
 * - Counters marked `persist` are what `persisted()` returns and what the
 *   `restore` option seeds, as the device's NVS would across a reboot.
 */

import {
  FEATURE_FIELDS,
  IMU_FIELDS,
  LED_COLOURS,
  MAG_FIELDS,
  MAX_EXT_LEDS,
  MAX_PENDING_PRESSES,
  OLED_ROWS,
  OPS,
  PRESSURE_ACTIVE_THRESHOLD,
  PRESSURE_FULL_SCALE,
  REL_COLS,
  REL_ROWS,
  TICK_FALLBACK_MS,
} from "./opset.mjs";
import { atan2Deg, imuField, magField, resolveSpan, sqrtSafe } from "./flowmath.mjs";
import { renderExtLeds } from "./extled.mjs";
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
 * @property {ArrayLike<number>} [imu] ax, ay, az (g), gx, gy, gz (deg/s)
 * @property {ArrayLike<number>} [mag] mx, my, mz (microtesla)
 * @property {number} [battery] percent; overrides setBattery() for this frame
 * @property {boolean} [linked] overrides setLinked() for this frame
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
    this.lastBool2 = false;
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
   * @param {{appName?: string, restore?: Record<number, number>}} [options]
   *   `appName` is the name events are recorded under (the device uses the
   *   slot name, e.g. "flow1"; defaults to the package id). `restore` seeds
   *   persisted counters by node index, as a reboot would.
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
    this.canDriveExtLed = caps.has("drive_ext_led");
    this.readsImu = caps.has("read_imu");
    this.readsMag = caps.has("read_mag");
    this.readsPower = caps.has("power");
    this.readsLink = caps.has("link");
    this.onTicks = caps.has("tick");
    this.canPersist = caps.has("persist");
    this.restoreValues = options.restore ?? null;
    /** Battery percent, or -1 for no gauge reading. */
    this.battery = -1;
    this.linkUp = false;
    this.pendingPresses = 0;
    this.pressShown = false;
    /** Which node drew each OLED row on the last frame, or -1. */
    /** @type {number[]} */
    this.displayNode = new Array(OLED_ROWS).fill(-1);
    /** Which node lit each external pixel on the last frame, or -1. */
    /** @type {number[]} */
    this.extPixelNode = new Array(MAX_EXT_LEDS).fill(-1);
    this.extMeterNode = -1;
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
    if (this.canPersist && this.restoreValues) {
      for (const [index, value] of Object.entries(this.restoreValues)) {
        const node = this.nodes[Number(index)];
        if (node && node.persist && (node.op === "counter" || node.op === "counter_reset")) {
          this.states[Number(index)].result = f32(value);
        }
      }
    }
    /** The last frame evaluated, for ticks and their events. */
    this.lastFrameSeq = 0;
    /** @type {number|null} */
    this.lastFrameMs = null;
    this.ticks = 0;
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
    this.extPixelNode = new Array(MAX_EXT_LEDS).fill(-1);
    this.extMeterNode = -1;
  }

  /**
   * What battery() reads from now on: percent, or -1 for no gauge reading.
   * @param {number} percent
   */
  setBattery(percent) {
    this.battery = f32(percent);
  }

  /**
   * What linked() reads from now on.
   * @param {boolean} linked
   */
  setLinked(linked) {
    this.linkUp = Boolean(linked);
  }

  /**
   * Persisted counters by node index -- what the device writes to NVS.
   * @returns {Record<number, number>}
   */
  persisted() {
    /** @type {Record<number, number>} */
    const out = {};
    if (!this.canPersist) return out;
    this.nodes.forEach((node, index) => {
      if (node.persist && (node.op === "counter" || node.op === "counter_reset")) out[index] = this.states[index].result;
    });
    return out;
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
   * @param {{seq: number, timestampMs: number}} frame the frame, or for a tick
   *   the last frame's seq and the tick's time
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
    this.frames += 1;
    this.lastFrameSeq = frame.seq;
    this.lastFrameMs = frame.timestampMs >>> 0;
    return this.evaluate(frame, frame.timestampMs >>> 0, frame);
  }

  /**
   * The device's 10 Hz tick. A package with `tick` is evaluated on it only
   * while no frame has arrived for TICK_FALLBACK_MS; every matrix read holds.
   * @param {number} nowMs
   * @param {{imu?: ArrayLike<number>, mag?: ArrayLike<number>, battery?: number, linked?: boolean}} [sensors]
   * @returns {SimEvent[]} the events it produced (none when it did not run)
   */
  tick(nowMs, sensors = {}) {
    if (!this.onTicks || this.nodes.length === 0) return [];
    if (this.lastFrameMs !== null && ((nowMs - this.lastFrameMs) >>> 0) < TICK_FALLBACK_MS) return [];
    this.ticks += 1;
    return this.evaluate(null, nowMs >>> 0, { seq: this.lastFrameSeq, timestampMs: nowMs, ...sensors });
  }

  /**
   * @param {Frame|null} frame null on a tick
   * @param {number} nowMs
   * @param {{seq: number, timestampMs: number, imu?: ArrayLike<number>, mag?: ArrayLike<number>, battery?: number, linked?: boolean}} at
   * @returns {SimEvent[]}
   */
  evaluate(frame, nowMs, at) {
    const firstEvent = this.events.length;
    const values = frame ? frame.values : [];
    const cells = values.length;
    const rows = frame ? frame.rows : 0;
    const cols = frame ? frame.cols || 1 : 1;
    const imu = this.readsImu && at.imu && at.imu.length >= 6 ? at.imu : null;
    const mag = this.readsMag && at.mag && at.mag.length >= 3 ? at.mag : null;
    const battery = this.readsPower ? f32(at.battery ?? this.battery) : -1;
    const linked = this.readsLink ? Boolean(at.linked ?? this.linkUp) : false;
    const states = this.states;
    const count = this.nodes.length;
    let skipUntil = 0;
    let skippedAny = false;
    let pressed = false;
    if (this.pressShown) {
      this.pressShown = false;
    } else if (this.pendingPresses !== 0) {
      this.pendingPresses -= 1;
      pressed = true;
      this.pressShown = true;
    }
    this.displayNode.fill(-1);
    this.extPixelNode.fill(-1);
    this.extMeterNode = -1;

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
      // On a tick there is no frame: every read of the matrix holds.
      if (!frame && SWEEP_OPS.has(node.op)) continue;

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
        case "region_sum":
        case "region_peak":
        case "region_active":
        case "region_row_centroid":
        case "region_col_centroid": {
          const rel = Number(node.rel ?? 0);
          const rs = resolveSpan(Number(node.r0) & 0xff, Number(node.r1) & 0xff, (rel & REL_ROWS) !== 0, rows);
          const cs = resolveSpan(Number(node.c0) & 0xff, Number(node.c1) & 0xff, (rel & REL_COLS) !== 0, cols);
          const limit = f32(Number(node.value ?? 0));
          let sum = 0;
          let peak = 0;
          let active = 0;
          let weighted = 0;
          for (let r = rs.lo; r <= rs.hi && r < rows; r += 1) {
            for (let c = cs.lo; c <= cs.hi && c < cols; c += 1) {
              const index = r * cols + c;
              if (index >= cells) continue;
              const value = f32(values[index]);
              if (node.op === "region_sum") {
                sum = f32(sum + value);
              } else if (node.op === "region_peak") {
                if (value > peak) peak = value;
              } else if (node.op === "region_active") {
                if (value >= limit) active += 1;
              } else if (value >= ACTIVE) {
                sum = f32(sum + value);
                weighted = f32(weighted + f32(value * (node.op === "region_row_centroid" ? r : c)));
              }
            }
          }
          if (node.op === "region_sum") state.result = sum;
          else if (node.op === "region_peak") state.result = peak;
          else if (node.op === "region_active") state.result = active;
          else state.result = sum > 0 ? f32(weighted / sum) : 0;
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
          this.features = computeFeatures(/** @type {Frame} */ (frame));
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
        case "counter_reset": {
          // The reset is looked at first, so a count and a reset on the same
          // frame leave 1: the edge that arrived with the reset still counts.
          const reset = b().boolResult;
          if (reset && !state.lastBool2) state.result = 0;
          state.lastBool2 = reset;
          const current = a().boolResult;
          if (current && !state.lastBool) state.result = f32(state.result + 1);
          state.lastBool = current;
          break;
        }
        case "not":
          state.boolResult = !a().boolResult;
          state.result = state.boolResult ? 1 : 0;
          break;
        case "duration": {
          const current = a().boolResult;
          if (current && !state.lastBool) state.sinceMs = nowMs;
          state.lastBool = current;
          state.result = current ? f32((nowMs - state.sinceMs) >>> 0) : 0;
          break;
        }
        case "interval": {
          const current = a().boolResult;
          if (current && !state.lastBool) {
            // `filled` marks that a first rise has been seen.
            if (state.filled > 0) state.result = f32((nowMs - state.sinceMs) >>> 0);
            state.sinceMs = nowMs;
            state.filled = 1;
          }
          state.lastBool = current;
          break;
        }
        case "peak_since": {
          const value = a().result;
          const reset = b().boolResult;
          if ((reset && !state.lastBool) || state.filled === 0) {
            state.result = value;
            state.filled = 1;
          } else if (value > state.result) {
            state.result = value;
          }
          state.lastBool = reset;
          break;
        }
        case "sqrt": state.result = sqrtSafe(a().result); break;
        case "atan2": state.result = atan2Deg(a().result, b().result); break;
        case "imu":
          if (imu) state.result = imuField(imu, IMU_FIELDS.indexOf(String(node.field)));
          break;
        case "mag":
          if (mag) state.result = magField(mag, MAG_FIELDS.indexOf(String(node.field)));
          break;
        case "battery": state.result = battery; break;
        case "linked":
          state.boolResult = linked;
          state.result = linked ? 1 : 0;
          break;
        case "uptime": state.result = f32(nowMs / 1000); break;
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
            this.record(at, String(node.event), current ? "rise" : "fall");
          }
          break;
        }
        case "emit_value": {
          const current = a().boolResult;
          const edge = node.fall ? !current && state.lastBool : current && !state.lastBool;
          if (edge) {
            const value = b().result;
            this.record(at, String(node.event), value.toFixed(3), value);
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
              this.ledChanges.push({ frameSeq: at.seq, timestampMs: at.timestampMs, colour, rgb, node: i });
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
        case "ext_pixel": {
          // Lit only on frames it runs with a true input, so a pixel inside a
          // closed gate goes dark; the later of two nodes on a pixel wins.
          state.boolResult = a().boolResult;
          state.result = state.boolResult ? 1 : 0;
          const pixel = Number(node.index);
          if (state.boolResult && pixel >= 0 && pixel < MAX_EXT_LEDS) this.extPixelNode[pixel] = i;
          break;
        }
        case "ext_meter":
          state.result = a().result;
          this.extMeterNode = i;
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
      this.record(at, "degraded", skippedAny ? "rise" : "fall");
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
   * What the last frame put on the external strip, or null for a package
   * that may not drive it (the device leaves its preset showing then).
   * @returns {import("./extled.mjs").ExtLedFrame | null}
   */
  extLedFrame() {
    if (!this.canDriveExtLed) return null;
    const meterNode = this.extMeterNode >= 0 ? this.nodes[this.extMeterNode] : null;
    return {
      meter: meterNode
        ? { value: this.states[this.extMeterNode].result, lo: Number(meterNode.lo ?? 0), hi: Number(meterNode.hi ?? 0) }
        : null,
      pixels: this.extPixelNode.map((index) => (index >= 0 ? LED_COLOURS[String(this.nodes[index].rgb)] ?? LED_COLOURS.off : null)),
    };
  }

  /**
   * The strip as a board with `count` external pixels shows it after the last
   * frame, before brightness; null when the package does not drive it.
   * @param {number} count
   */
  extLeds(count) {
    const frame = this.extLedFrame();
    return frame ? renderExtLeds(frame, count) : null;
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

/** Ops that read the matrix, and hold their value on a tick. */
const SWEEP_OPS = new Set(Object.values(OPS).filter((spec) => spec.sweep).map((spec) => spec.name));

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
