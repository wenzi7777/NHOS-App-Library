// @ts-check
/**
 * Validate a .nha package against everything the device will check, and more.
 *
 * The rule is simple: if this passes, the device must accept the package.
 * Anything the firmware refuses has to be refused here too, with a message
 * that says why -- the device's own errors arrive far too late and say far
 * too little. Error codes reuse the firmware's own spelling where one exists
 * (`unknown_colour`, `window_pool_exhausted`, `over_budget`), so the two sides
 * can be matched up.
 */

import {
  APP_ID_RE,
  CAPABILITIES,
  DEFAULT_BUDGET_US,
  DEFAULT_CELL_COUNT,
  FEATURE_FIELDS,
  LED_COLOURS,
  MAX_DEBOUNCE_MS,
  MAX_EVENT_NAME,
  MAX_NODES,
  MAX_OLED_DIGITS,
  MAX_OLED_LABEL,
  MAX_PACKAGE_BYTES,
  MAX_REGION_INDEX,
  MAX_WINDOW,
  OLED_LABEL_RE,
  OLED_ROWS,
  OPS,
  RESERVED_APP_IDS,
  WINDOW_POOL,
  compareVersions,
  graphCostUs,
  graphMemoryBytes,
  minOsFor,
  windowFloats,
} from "./opset.mjs";
import {
  ALLOWED_SOURCES,
  FORMATS,
  MAX_COLUMNS,
  MAX_REFRESH_MS,
  MAX_SECTIONS,
  MAX_SOURCES,
  MAX_STATS,
  MIN_REFRESH_MS,
  SECTION_KINDS,
} from "./readoutset.mjs";
import { canonicalBytes } from "./canonical.mjs";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const MIN_OS_RE = /^v?\d+\.\d+\.\d+$/;
const SOURCE_ID_RE = /^[a-z][a-z0-9_]*$/;
const MANIFEST_REQUIRED = ["id", "name", "version", "author", "summary"];
// A package's flow graph is read with the same flat key scan the firmware
// uses, so a manifest field named like a top-level key would shadow it.
const MANIFEST_FORBIDDEN_KEYS = ["nodes", "kind", "nhapp"];

/** A package the device would refuse. `code` is `reason:detail`. */
export class PackageError extends Error {
  /**
   * @param {string} code
   * @param {number|null} [node] the offending node's index, when there is one
   */
  constructor(code, node = null) {
    super(code);
    this.name = "PackageError";
    this.code = code;
    this.node = node;
  }
}

/**
 * @param {unknown} condition
 * @param {string} code
 * @param {number|null} [node]
 * @returns {asserts condition}
 */
function require(condition, code, node = null) {
  if (!condition) throw new PackageError(code, node);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value */
const text = (value) => (value === null || value === undefined ? "" : String(value));
/** @param {unknown} value */
const isInt = (value) => typeof value === "number" && Number.isInteger(value);

/** @param {Record<string, unknown>} manifest */
export function validateManifest(manifest) {
  for (const key of MANIFEST_REQUIRED) {
    require(text(manifest[key]).trim(), `missing_manifest_field:${key}`);
  }

  const appId = text(manifest.id);
  require(APP_ID_RE.test(appId), `invalid_id:${appId}`);
  require(!RESERVED_APP_IDS.has(appId), `reserved_id:${appId}`);

  require(SEMVER_RE.test(text(manifest.version)), `invalid_version:${text(manifest.version)}`);
  if ("min_os" in manifest) {
    require(MIN_OS_RE.test(text(manifest.min_os)), `invalid_min_os:${text(manifest.min_os)}`);
  }
  if ("budget_us" in manifest) {
    require(isInt(manifest.budget_us) && /** @type {number} */ (manifest.budget_us) > 0,
      `invalid_budget_us:${text(manifest.budget_us)}`);
  }

  for (const key of MANIFEST_FORBIDDEN_KEYS) {
    require(!(key in manifest), `manifest_key_shadows_package_key:${key}`);
  }

  const caps = manifest.capabilities ?? [];
  require(Array.isArray(caps), "capabilities_must_be_a_list");
  for (const cap of caps) require(Object.hasOwn(CAPABILITIES, String(cap)), `unknown_capability:${cap}`);
}

/**
 * @typedef {object} ValidateOptions
 * @property {number} [cellCount] cells on the target board (default 225, the largest)
 */

/**
 * @param {unknown} nodes
 * @param {Record<string, unknown>} manifest
 * @param {ValidateOptions} [options]
 */
export function validateGraph(nodes, manifest, options = {}) {
  const cellCount = options.cellCount ?? DEFAULT_CELL_COUNT;
  require(Array.isArray(nodes), "missing_nodes");
  require(nodes.length > 0, "empty_graph");
  require(nodes.length <= MAX_NODES, `too_many_nodes:${nodes.length}>${MAX_NODES}`);

  const caps = new Set(/** @type {unknown[]} */ (manifest.capabilities ?? []).map(String));
  // The device evaluates a graph once per frame and wakes it for frames only
  // when it may read the matrix. An empty list means the device's default,
  // which includes it; a list without it means a graph that never runs.
  require(caps.size === 0 || caps.has("read_matrix"), "never_evaluated:read_matrix_not_declared");
  let poolUsed = 0;
  nodes.forEach((node, index) => {
    require(isObject(node), `node_not_an_object:${index}`, index);
    const name = text(node.op);
    require(Object.hasOwn(OPS, name), `unknown_op:${name}`, index);
    const op = OPS[name];

    // Inputs may only reference EARLIER nodes -- that is what makes a cycle
    // unrepresentable and the array order a valid evaluation order.
    if (op.inputs === 0) {
      require(!("in" in node), `unexpected_input:${name}`, index);
    } else {
      /** @type {unknown[]} */
      let refs;
      if (op.inputs === 1) {
        refs = [node.in];
      } else {
        require(Array.isArray(node.in) && node.in.length === op.inputs, `expected_${op.inputs}_inputs:${name}`, index);
        refs = /** @type {unknown[]} */ (node.in);
      }
      for (const ref of refs) {
        require(isInt(ref), `missing_input:${name}`, index);
        require(/** @type {number} */ (ref) >= 0 && /** @type {number} */ (ref) < index, `input_out_of_order:${name}@${index}`, index);
      }
    }

    for (const key of op.required) require(key in node, `missing_field:${name}.${key}`, index);

    if (name === "emit" || name === "emit_value") {
      const event = text(node.event);
      require(event, "missing_event_name", index);
      require(event.length <= MAX_EVENT_NAME, `event_name_too_long:${event}`, index);
      require(caps.has("emit_event"), "capability_not_declared:emit_event", index);
    }
    if (name === "led") {
      require(caps.has("drive_led"), "capability_not_declared:drive_led", index);
      require(Object.hasOwn(LED_COLOURS, text(node.rgb)), `unknown_colour:${text(node.rgb)}`, index);
    }
    if (name === "oled_text" || name === "oled_bar") {
      require(caps.has("display"), "capability_not_declared:display", index);
      require(isInt(node.row) && /** @type {number} */ (node.row) >= 0 && /** @type {number} */ (node.row) < OLED_ROWS,
        `invalid_oled_row:${text(node.row)}`, index);
      const label = node.label;
      require(typeof label === "string" && label.length <= MAX_OLED_LABEL && OLED_LABEL_RE.test(label),
        `invalid_oled_label:${text(label)}`, index);
    }
    if (name === "oled_text" && "digits" in node) {
      require(isInt(node.digits) && /** @type {number} */ (node.digits) >= 0 && /** @type {number} */ (node.digits) <= MAX_OLED_DIGITS,
        `invalid_oled_digits:${text(node.digits)}`, index);
    }
    if (name === "oled_bar") {
      require(typeof node.lo === "number" && typeof node.hi === "number" && node.hi > node.lo,
        `invalid_bar_range:${text(node.lo)}..${text(node.hi)}`, index);
    }
    if (name === "button") require(caps.has("button"), "capability_not_declared:button", index);
    if (name === "feature_get") {
      const field = text(node.field);
      require(FEATURE_FIELDS.includes(field), `unknown_feature_field:${field}`, index);
      const source = /** @type {Record<string, unknown>} */ (nodes[/** @type {number} */ (node.in)]);
      require(text(source.op) === "features", "feature_get_input_must_be_features", index);
    }
    if (name === "debounce") {
      require(isInt(node.ms) && /** @type {number} */ (node.ms) >= 0 && /** @type {number} */ (node.ms) <= MAX_DEBOUNCE_MS,
        `invalid_debounce_ms:${text(node.ms)}`, index);
    }
    if (name === "region_sum") {
      for (const key of ["r0", "c0", "r1", "c1"]) {
        const value = node[key];
        require(isInt(value) && /** @type {number} */ (value) >= 0 && /** @type {number} */ (value) <= MAX_REGION_INDEX,
          `invalid_region:${key}=${text(value)}`, index);
      }
    }
    for (const key of ["value", "hysteresis", "lo", "hi"]) {
      if (key in node) require(typeof node[key] === "number" && Number.isFinite(node[key]), `invalid_number:${name}.${key}`, index);
    }
    if (op.sweep) require(caps.has("read_matrix"), "capability_not_declared:read_matrix", index);
    if (op.windowKey) {
      const window = node[op.windowKey];
      require(isInt(window) && /** @type {number} */ (window) >= 1 && /** @type {number} */ (window) <= MAX_WINDOW,
        `invalid_window:${text(window)}`, index);
      // Every windowed node draws from one pool per slot; the device refuses
      // the graph at load when the pool runs out.
      poolUsed += /** @type {number} */ (window);
      require(poolUsed <= WINDOW_POOL, `window_pool_exhausted:${poolUsed}>${WINDOW_POOL}`, index);
    }
  });

  const flowNodes = /** @type {Record<string, unknown>[]} */ (nodes);
  const declaredMinOs = text(manifest.min_os) || "v1.0.0";
  const neededMinOs = minOsFor(flowNodes);
  require(compareVersions(declaredMinOs, neededMinOs) >= 0,
    `min_os_too_low:declares_v${declaredMinOs.replace(/^v/, "")}_needs_v${neededMinOs.replace(/^v/, "")}`);

  // The device dry-runs the graph at install against the package's declared
  // budget (or the default), and again against the slot's allocation when it
  // is bound. Either one refusing it is `over_budget`.
  const estimatedUs = graphCostUs(flowNodes, cellCount);
  const declared = isInt(manifest.budget_us) ? /** @type {number} */ (manifest.budget_us) : DEFAULT_BUDGET_US;
  const budgetUs = Math.min(declared, DEFAULT_BUDGET_US);
  require(estimatedUs <= budgetUs, `over_budget:${estimatedUs}us>${budgetUs}us`);

  return {
    nodes: flowNodes.length,
    estimatedUs,
    budgetUs,
    cellCount,
    memoryBytes: graphMemoryBytes(flowNodes),
    windowFloats: windowFloats(flowNodes),
    minOs: neededMinOs,
  };
}

/**
 * A readout names commands to read and widgets to draw. Nothing else.
 * @param {unknown} readout
 */
export function validateReadout(readout) {
  require(isObject(readout), "missing_readout");

  const refresh = readout.refresh_ms ?? 1000;
  require(isInt(refresh) && /** @type {number} */ (refresh) >= MIN_REFRESH_MS && /** @type {number} */ (refresh) <= MAX_REFRESH_MS,
    `invalid_refresh_ms:${text(refresh)}`);

  const sources = readout.sources;
  require(Array.isArray(sources) && sources.length > 0, "missing_sources");
  require(sources.length <= MAX_SOURCES, `too_many_sources:${sources.length}`);
  /** @type {Set<string>} */
  const ids = new Set();
  for (const source of sources) {
    require(isObject(source), "invalid_source");
    const sourceId = text(source.id);
    require(SOURCE_ID_RE.test(sourceId), `invalid_source_id:${sourceId}`);
    require(!ids.has(sourceId), `duplicate_source_id:${sourceId}`);
    ids.add(sourceId);
    const command = text(source.command);
    // A readout is read-only by construction: it cannot be used to
    // reconfigure or write to a device, whatever its author intended.
    require(ALLOWED_SOURCES.has(command), `readout_source_not_allowed:${command}`);
  }

  const sections = readout.sections;
  require(Array.isArray(sections) && sections.length > 0, "missing_sections");
  require(sections.length <= MAX_SECTIONS, `too_many_sections:${sections.length}`);
  for (const section of sections) {
    require(isObject(section), "invalid_section");
    const kind = text(section.kind);
    require(SECTION_KINDS.has(kind), `unknown_section_kind:${kind}`);
    require(text(section.title).trim(), "missing_section_title");

    if (kind === "stats") {
      const items = section.items;
      require(Array.isArray(items) && items.length > 0, "missing_stats_items");
      require(items.length <= MAX_STATS, `too_many_stats:${items.length}`);
      for (const item of items) {
        require(isObject(item), "invalid_stat");
        require(ids.has(text(item.source)), `unknown_source:${text(item.source)}`);
        require(text(item.field), "missing_stat_field");
        require(FORMATS.has(text(item.format ?? "raw")), `unknown_format:${text(item.format)}`);
      }
    } else {
      require(ids.has(text(section.source)), `unknown_source:${text(section.source)}`);
      const columns = section.columns;
      require(Array.isArray(columns) && columns.length > 0, "missing_columns");
      require(columns.length <= MAX_COLUMNS, `too_many_columns:${columns.length}`);
      for (const column of columns) {
        require(isObject(column), "invalid_column");
        require(text(column.field), "missing_column_field");
        require(FORMATS.has(text(column.format ?? "raw")), `unknown_format:${text(column.format)}`);
      }
    }
  }

  return { sources: sources.length, sections: sections.length, refreshMs: /** @type {number} */ (refresh) };
}

/**
 * @typedef {object} PackageReport
 * @property {"flow"|"readout"} kind
 * @property {string} id
 * @property {string} version
 * @property {number} size canonical bytes
 * @property {number} nodes
 * @property {number} estimatedUs
 * @property {number} memoryBytes
 * @property {string} minOs
 * @property {number} [budgetUs]
 * @property {number} [cellCount]
 * @property {number} [windowFloats]
 * @property {number} [sources]
 * @property {number} [sections]
 * @property {number} [refreshMs]
 */

/**
 * Validate a whole package. Throws PackageError on the first problem.
 * @param {unknown} doc
 * @param {Uint8Array|null} [raw] the bytes that will be uploaded (default: canonical)
 * @param {ValidateOptions} [options]
 * @returns {PackageReport}
 */
export function validatePackage(doc, raw = null, options = {}) {
  require(isObject(doc), "not_a_package");
  require(doc.nhapp === 1, `unsupported_package_version:${text(doc.nhapp)}`);
  const kind = text(doc.kind) || "flow";
  require(kind === "flow" || kind === "readout", `unsupported_kind:${text(doc.kind)}`);

  const manifest = doc.manifest;
  require(isObject(manifest), "missing_manifest");
  validateManifest(manifest);

  /** @type {Omit<PackageReport, "id"|"version"|"size">} */
  let report;
  if (kind === "readout") {
    // Stored by the device but never dispatched: it holds a registry entry
    // and nothing else -- no nodes, no budget, no slot.
    require(!("nodes" in doc), "readout_must_not_declare_nodes");
    report = {
      ...validateReadout(doc.readout),
      kind: "readout",
      nodes: 0,
      estimatedUs: 0,
      memoryBytes: 0,
      minOs: text(manifest.min_os) || "v1.0.0",
    };
  } else {
    require(!("readout" in doc), "flow_must_not_declare_a_readout");
    report = { ...validateGraph(doc.nodes, manifest, options), kind: "flow" };
  }

  const bytes = raw ?? canonicalBytes(doc);
  require(bytes.length <= MAX_PACKAGE_BYTES, `package_too_large:${bytes.length}>${MAX_PACKAGE_BYTES}`);

  return { ...report, id: text(manifest.id), version: text(manifest.version), size: bytes.length };
}
