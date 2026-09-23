// @ts-check
/**
 * The op table and cost model -- the single source of truth for this library.
 *
 * `validate.mjs`, `compile.mjs`, `simulate.mjs` and the build all read from
 * here, and the firmware's `FlowApp::estimateUs()` must agree with it. That
 * agreement is a compatibility contract: if the two drift, an app passes
 * locally and is refused by the device, which is the most confusing failure
 * this system can produce. `test/firmware-contract.test.mjs` pins both
 * directions.
 *
 * Costs are deliberate OVER-estimates. The point is a bound, not a prediction
 * -- the same stance the firmware takes.
 */

// --- hard limits, all mirrored in the firmware -----------------------------

export const MAX_NODES = 24; // FlowApp::kMaxNodes
// Firmware before v1.3.0 holds 12 nodes per graph. A larger graph needs
// v1.3.0, and min_os says so -- otherwise an older device would refuse it as
// too_many_nodes after upload.
export const LEGACY_MAX_NODES = 12;
export const MIN_OS_FOR_LARGE_GRAPHS = "v1.3.0";
export const MAX_PACKAGE_BYTES = 4096; // FlowApp::kMaxPackageBytes
export const MAX_EVENT_NAME = 23; // FlowNode::event is char[24]
export const MAX_WINDOW = 128; // FlowApp::kMaxWindow
// One ring-buffer pool per slot, shared by every windowed node in the graph.
// Checking each window against MAX_WINDOW alone let two `mean(x, 100)` pass
// here and be refused by the device as window_pool_exhausted.
export const WINDOW_POOL = 128; // FlowApp::kWindowPool
// The allocation a graph is checked against when it is bound to a slot.
export const DEFAULT_BUDGET_US = 1500; // FlowApp::kDefaultBudgetUs
// At run time the apps share whatever the scanner leaves: this share of one
// frame period, divided among the apps actually running (AppGovernor).
export const GOVERNOR_CEILING_PERMILLE = 250; // AppGovernor::kDefaultCeilingPermille
export const MAX_SLOTS = 4; // AppRegistry::kMaxSlots
// FlowNode::ms is a uint16_t; a larger hold silently wraps on the device.
export const MAX_DEBOUNCE_MS = 65535;
// FlowNode::r0..c1 are uint8_t.
export const MAX_REGION_INDEX = 255;

// "/files/" (7) + "apps/" (5) + id + ".nha" (4) must fit SPIFFS' 31-char path
// limit, which leaves exactly 15 characters for the id.
export const MAX_APP_ID = 15;
export const APP_ID_RE = /^[a-z][a-z0-9_]{0,14}$/;
export const RESERVED_APP_IDS = new Set(["index"]);

// The cell count a package is judged against. 15x15 is the largest board.
export const DEFAULT_CELL_COUNT = 225;

// Cost constants. Must equal FlowApp::kCellOpNsPerCell / kScalarOpNs /
// kFeaturesNsPerCell.
//
// MEASURED on v1.5.F (ESP32-S3 @ 240MHz, 14x14), not guessed: a flat sweep
// runs about 86ns per cell and a features sweep about 235ns. The original
// 60/120/400 under-estimated by 1.4x to 9x, which made the install-time
// estimate optimistic exactly where an author relies on it. These carry
// roughly 2x margin over the measurements.
export const CELL_OP_NS_PER_CELL = 300;
export const SCALAR_OP_NS = 600;
// features does a compare plus two conditional multiply-adds per cell.
export const FEATURES_NS_PER_CELL = 500;

// Must equal MatrixScanner.h. The centroid weights only cells at or above the
// contact threshold, so it is the centre of FORCE, not of the bounding box.
export const PRESSURE_ACTIVE_THRESHOLD = 50;
export const PRESSURE_FULL_SCALE = 2000;

/** @type {Readonly<Record<string, number>>} */
export const CAPABILITIES = Object.freeze({
  read_matrix: 1 << 0,
  read_imu: 1 << 1,
  emit_event: 1 << 2,
  drive_led: 1 << 3,
  write_file: 1 << 4,
  // Short presses of the action button. Long presses never reach an app.
  button: 1 << 6,
  // Rows on the OLED, shown while the device's OLED page is "app".
  display: 1 << 10,
});

// The OLED an app draws on: a 128x32 SSD1306 at text size 1, so four rows of
// 21 characters. Mirrored in the firmware's AppDisplay.h.
export const OLED_ROWS = 4; // kOledRows
export const OLED_COLS = 21; // kOledCols
export const OLED_ROW_PX = 8; // kOledRowPx
export const OLED_WIDTH_PX = 128; // kOledWidthPx
export const MAX_OLED_LABEL = 10; // kMaxOledLabel
export const MAX_OLED_DIGITS = 3; // kMaxOledDigits
// Presses held for frames not yet evaluated (FlowApp::kMaxPendingPresses).
export const MAX_PENDING_PRESSES = 3;
// The panel's font draws printable ASCII and nothing else.
export const OLED_LABEL_RE = /^[\x20-\x7e]*$/;

/** Feature fields exposed by the `features` op, in the order the firmware packs them. */
export const FEATURE_FIELDS = Object.freeze([
  "total_force", "peak", "peak01", "peak_index",
  "active_cells", "centroid_row", "centroid_col", "in_contact",
]);

/**
 * The firmware's whole LED palette (FlowApp::parse). Anything else is refused
 * on the device as unknown_colour.
 * @type {Readonly<Record<string, readonly [number, number, number]>>}
 */
export const LED_COLOURS = Object.freeze({
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  white: [255, 255, 255],
  off: [0, 0, 0],
});

/**
 * Node fields the firmware reads as float. The Python toolchain this replaced
 * wrote them as Python floats (`40.0`), and published packages are immutable,
 * so canonical serialisation has to keep that spelling byte for byte.
 */
export const FLOAT_FIELDS = Object.freeze(["value", "hysteresis", "lo", "hi"]);

/**
 * @typedef {object} OpSpec
 * @property {string} name
 * @property {number} inputs how many earlier nodes this op consumes
 * @property {boolean} sweep true when the op sweeps the whole matrix
 * @property {number} nsPerCell ns per cell for a sweep op
 * @property {number} nsFlat flat ns for a scalar op
 * @property {readonly string[]} required extra required keys on the node
 * @property {readonly string[]} optional optional keys the node may carry
 * @property {string|null} windowKey the key naming this op's ring-buffer length
 * @property {string} since introduced in this OS version
 * @property {boolean} boolean produces a boolean (may feed threshold/debounce/emit/gate)
 * @property {string} summary one line for the reference
 */

/**
 * @param {string} name
 * @param {Partial<Omit<OpSpec, "name">>} [spec]
 * @returns {OpSpec}
 */
function op(name, spec = {}) {
  return Object.freeze({
    name,
    inputs: 0,
    sweep: false,
    nsPerCell: CELL_OP_NS_PER_CELL,
    nsFlat: SCALAR_OP_NS,
    required: [],
    optional: [],
    windowKey: null,
    since: "v1.0.0",
    boolean: false,
    summary: "",
    ...spec,
  });
}

const V11 = "v1.1.0";
const V14 = "v1.4.0";

/** @type {Readonly<Record<string, OpSpec>>} */
export const OPS = Object.freeze(Object.fromEntries([
  // --- v1.0.0: shipped, do not change semantics -----------------------------
  op("total", { sweep: true, summary: "Sum of every cell." }),
  op("peak", { sweep: true, summary: "Largest cell (0 if none is positive)." }),
  op("region_sum", { sweep: true, required: ["r0", "c0", "r1", "c1"], summary: "Sum over a rectangle of cells." }),
  op("active_cells", { sweep: true, required: ["value"], summary: "Count of cells at or above `value`." }),
  op("threshold", { inputs: 1, required: ["value"], optional: ["hysteresis"], boolean: true, summary: "True while input >= value; once latched, holds until input <= value - hysteresis." }),
  op("debounce", { inputs: 1, required: ["ms"], boolean: true, summary: "Passes a boolean only after it has held steady for `ms`." }),
  op("emit", { inputs: 1, required: ["event"], summary: "Records `event` with detail rise/fall on each edge." }),

  // --- v1.1.0: arithmetic ---------------------------------------------------
  op("const", { required: ["value"], since: V11, summary: "A constant." }),
  op("add", { inputs: 2, since: V11, summary: "a + b" }),
  op("sub", { inputs: 2, since: V11, summary: "a - b" }),
  op("mul", { inputs: 2, since: V11, summary: "a * b" }),
  // Division by zero yields 0 rather than NaN, so one bad frame cannot poison
  // every downstream node for the rest of the session.
  op("div", { inputs: 2, since: V11, summary: "a / b, or 0 when b is 0." }),
  op("min", { inputs: 2, since: V11, summary: "Smaller of a and b." }),
  op("max", { inputs: 2, since: V11, summary: "Larger of a and b." }),
  op("abs", { inputs: 1, since: V11, summary: "Absolute value." }),
  op("clamp", { inputs: 1, required: ["lo", "hi"], since: V11, summary: "Input limited to [lo, hi]." }),

  // --- v1.1.0: time series (ring buffers sized at load) ---------------------
  op("mean", { inputs: 1, required: ["window"], windowKey: "window", since: V11, summary: "Mean of the last `window` frames (of those seen so far)." }),
  op("max_hold", { inputs: 1, required: ["window"], windowKey: "window", since: V11, summary: "Largest value in the last `window` frames." }),
  op("delta", { inputs: 1, since: V11, summary: "Change since the previous frame." }),
  op("integrate", { inputs: 1, required: ["window"], windowKey: "window", since: V11, summary: "Sum of the last `window` frames." }),
  op("counter", { inputs: 1, since: V11, summary: "Counts rising edges of a boolean." }),

  // --- v1.1.0: richer sweeps ------------------------------------------------
  op("features", { sweep: true, nsPerCell: FEATURES_NS_PER_CELL, since: V11, summary: "One sweep computing every feature field; read with feature_get." }),
  op("feature_get", { inputs: 1, required: ["field"], since: V11, summary: "One field of a features sweep." }),
  op("arg_max", { sweep: true, since: V11, summary: "Index of the largest cell." }),
  op("row_centroid", { sweep: true, since: V11, summary: "Force-weighted row of cells at or above the contact threshold." }),
  op("col_centroid", { sweep: true, since: V11, summary: "Force-weighted column of cells at or above the contact threshold." }),

  // --- v1.1.0: output -------------------------------------------------------
  op("led", { inputs: 1, required: ["rgb"], since: V11, summary: "Sets the LED to `rgb` while a boolean is true, off when it falls." }),
  op("emit_value", { inputs: 2, required: ["event"], since: V11, summary: "Records `event` carrying b's value on each rise of a." }),

  // --- v1.1.0: conditionals for self-degradation ----------------------------
  // Branches keep execution bounded (worst case = every node runs); only
  // loops would make it unbounded, and there are none.
  op("select", { inputs: 3, since: V11, summary: "b if a is true, else c." }),
  op("gate", { inputs: 2, since: V11, summary: "When a is false, skips the following `span` nodes (they hold their values)." }),
  op("budget_load", { since: V11, summary: "This app's measured cost over its allocation." }),
  op("grace_left", { since: V11, summary: "Overruns left before this app is stopped." }),

  // --- v1.4.0: interaction --------------------------------------------------
  // All scalar: an OLED node only records what to show. The panel is redrawn
  // at the OLED's own update_hz, outside every app's budget.
  op("mod", { inputs: 2, since: V14, summary: "a mod b (C fmodf: the sign of a), or 0 when b is 0." }),
  op("button", { boolean: true, since: V14, summary: "True for one frame per short press of the action button, false for at least one frame between presses." }),
  op("oled_text", { inputs: 1, required: ["row", "label"], optional: ["digits"], since: V14, summary: "Shows `label` and the input's value on OLED row `row`." }),
  op("oled_bar", { inputs: 1, required: ["row", "label", "lo", "hi"], since: V14, summary: "Shows `label` and the input as a bar over [lo, hi] on OLED row `row`." }),
].map((spec) => [spec.name, spec])));

export const V1_0_OPS = Object.freeze(
  new Set(Object.values(OPS).filter((spec) => spec.since === "v1.0.0").map((spec) => spec.name)),
);

/**
 * @param {unknown} name
 * @returns {OpSpec}
 */
export function opSpec(name) {
  const spec = OPS[String(name)];
  if (!spec) throw new Error(`unknown op ${String(name)}`);
  return spec;
}

/**
 * Worst-case cost of one node. `gate` is charged as if it never skips.
 * @param {{op?: unknown}} node
 * @param {number} cellCount
 */
export function nodeCostNs(node, cellCount) {
  const spec = opSpec(node.op);
  return spec.sweep ? spec.nsPerCell * cellCount : spec.nsFlat;
}

/**
 * @param {ReadonlyArray<{op?: unknown}>} nodes
 * @param {number} cellCount
 */
export function graphCostUs(nodes, cellCount) {
  let totalNs = 0;
  for (const node of nodes) totalNs += nodeCostNs(node, cellCount);
  return Math.floor((totalNs + 999) / 1000);
}

/**
 * Ring-buffer memory a graph reserves, in bytes. Windows are fixed at load time.
 * @param {ReadonlyArray<Record<string, unknown>>} nodes
 */
export function graphMemoryBytes(nodes) {
  return windowFloats(nodes) * 4;
}

/**
 * Floats a graph takes from the slot's shared window pool.
 * @param {ReadonlyArray<Record<string, unknown>>} nodes
 */
export function windowFloats(nodes) {
  let total = 0;
  for (const node of nodes) {
    const spec = opSpec(node.op);
    if (spec.windowKey) total += Math.trunc(Number(node[spec.windowKey] ?? 0)) || 0;
  }
  return total;
}

/**
 * What one app may spend per frame at run time, before the governor starts
 * counting overruns. An upper bound: the governor shrinks it further when the
 * scanner misses deadlines.
 * @param {number} fps scan rate
 * @param {number} runningApps apps sharing the allowance
 */
export function appShareUs(fps, runningApps) {
  const periodUs = 1e6 / Math.max(1, fps);
  return Math.floor((periodUs * GOVERNOR_CEILING_PERMILLE) / 1000 / Math.max(1, runningApps));
}

/**
 * The oldest firmware that can load a graph: from the ops it uses, and from
 * its size.
 * @param {ReadonlyArray<{op?: unknown}>} nodes
 */
export function minOsFor(nodes) {
  let needed = nodes.length > LEGACY_MAX_NODES ? MIN_OS_FOR_LARGE_GRAPHS : "v1.0.0";
  for (const node of nodes) {
    const since = opSpec(node.op).since;
    if (compareVersions(since, needed) > 0) needed = since;
  }
  return needed;
}

/** @param {readonly string[]} names */
export function capabilitiesMask(names) {
  let mask = 0;
  for (const name of names) {
    const bit = CAPABILITIES[name];
    if (bit === undefined) throw new Error(`unknown capability ${name}`);
    mask |= bit;
  }
  return mask;
}

/**
 * Compare two `v1.2.3` / `1.2.3` versions numerically. String comparison, which
 * this replaced, orders v1.10.0 before v1.9.0.
 * @param {string} a
 * @param {string} b
 * @returns {number} negative, zero or positive
 */
export function compareVersions(a, b) {
  const parse = (/** @type {string} */ v) => String(v).replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
