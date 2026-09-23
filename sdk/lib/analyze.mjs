// @ts-check
/**
 * One call for an editor: compile, validate, and turn every problem into a
 * diagnostic with a place in the source.
 *
 * compileSource() and validatePackage() throw on the first problem, which is
 * right for a build. An editor wants the same verdict as data -- including
 * the device-side refusals the compiler cannot see (window pool, budget) --
 * pinned to the line that caused it.
 */

import { canonicalBytes } from "./canonical.mjs";
import { CompileError, compileSource } from "./compile.mjs";
import { MAX_SLOTS, appShareUs } from "./opset.mjs";
import { PackageError, validatePackage } from "./validate.mjs";

/**
 * @typedef {object} Diagnostic
 * @property {"error"|"warning"|"info"} severity
 * @property {string} message
 * @property {number|null} line 1-based, null when it applies to the whole app
 * @property {number|null} col 1-based
 * @property {number|null} endCol
 * @property {string|null} code validator code, for errors the device would report
 */

/**
 * @typedef {object} Analysis
 * @property {boolean} ok true when the package would be accepted by the device
 * @property {"flow"|"readout"} kind
 * @property {Record<string, any>|null} package
 * @property {Uint8Array|null} bytes canonical bytes, when ok
 * @property {import("./compile.mjs").CompileReport|null} report compile report (flow only)
 * @property {import("./validate.mjs").PackageReport|null} validation
 * @property {Diagnostic[]} diagnostics
 */

/**
 * @param {Partial<Diagnostic> & {message: string}} fields
 * @returns {Diagnostic}
 */
function diagnostic(fields) {
  return { severity: "error", line: null, col: null, endCol: null, code: null, ...fields };
}

/**
 * The case a warning is judged against: every slot enabled at the fastest
 * scan rate a board runs. A graph that fits alone may not fit beside three
 * others, and the device then suspends it rather than miss a frame.
 */
const WARN_FPS = 120;

/**
 * Analyse a .nhs flow source.
 * @param {string} source
 * @param {{cellCount?: number}} [options]
 * @returns {Analysis}
 */
export function analyzeFlow(source, options = {}) {
  /** @type {Analysis} */
  const result = { ok: false, kind: "flow", package: null, bytes: null, report: null, validation: null, diagnostics: [] };
  try {
    const { package: pkg, report } = compileSource(source, options);
    result.package = pkg;
    result.report = report;
    for (const note of report.notes) {
      result.diagnostics.push(diagnostic({ severity: "info", message: note.message, line: note.line, col: note.col }));
    }
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    result.diagnostics.push(diagnostic({ message: error.reason, line: error.line, col: error.col, endCol: error.endCol }));
    return result;
  }

  try {
    const bytes = canonicalBytes(result.package);
    result.validation = validatePackage(result.package, bytes, options);
    result.bytes = bytes;
    result.ok = true;
  } catch (error) {
    if (!(error instanceof PackageError)) throw error;
    const line = error.node !== null && result.report ? result.report.nodeLines[error.node] ?? null : null;
    result.diagnostics.push(diagnostic({ message: describeCode(error.code), code: error.code, line }));
    return result;
  }

  const estimated = result.validation.estimatedUs;
  const share = appShareUs(WARN_FPS, MAX_SLOTS);
  if (estimated > share) {
    result.diagnostics.push(diagnostic({
      severity: "warning",
      message: `~${estimated}us per frame at ${result.validation.cellCount} cells exceeds the ${share}us each app gets `
        + `with all ${MAX_SLOTS} slots running at ${WARN_FPS} Hz; the device may suspend it then`,
    }));
  }
  return result;
}

/**
 * Analyse a readout package written as JSON.
 * @param {string} source
 * @returns {Analysis}
 */
export function analyzeReadout(source) {
  /** @type {Analysis} */
  const result = { ok: false, kind: "readout", package: null, bytes: null, report: null, validation: null, diagnostics: [] };
  let doc;
  try {
    doc = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = /position (\d+)/.exec(message);
    let line = null;
    let col = null;
    if (position) {
      const before = source.slice(0, Number(position[1]));
      line = before.split("\n").length;
      col = before.length - before.lastIndexOf("\n");
    }
    result.diagnostics.push(diagnostic({ message: `invalid JSON: ${message}`, line, col }));
    return result;
  }
  result.package = doc;
  try {
    const bytes = canonicalBytes(doc);
    result.validation = validatePackage(doc, bytes);
    result.bytes = bytes;
    result.ok = true;
  } catch (error) {
    if (!(error instanceof PackageError)) throw error;
    result.diagnostics.push(diagnostic({ message: describeCode(error.code), code: error.code, line: lineOfCode(source, error.code) }));
  }
  return result;
}

/**
 * Best-effort: point a readout error at the line holding the offending value.
 * @param {string} source
 * @param {string} code
 */
function lineOfCode(source, code) {
  const detail = code.split(":").slice(1).join(":");
  if (!detail) return null;
  const index = source.indexOf(`"${detail}"`);
  return index < 0 ? null : source.slice(0, index).split("\n").length;
}

/** @type {Record<string, string>} */
const CODE_MESSAGES = {
  over_budget: "the graph costs more per frame than the device allows",
  window_pool_exhausted: "the windows add up to more than the device's 128-float pool",
  unknown_colour: "the device's LED palette is red, green, blue, white and off",
  invalid_window: "a window must be 1 to 128 frames",
  invalid_debounce_ms: "a debounce time must be 0 to 65535 ms",
  package_too_large: "the package exceeds the device's 4096-byte limit",
  invalid_id: "the app id must be lowercase letters, digits and _, starting with a letter, at most 15 characters",
  reserved_id: "that app id is reserved",
  invalid_version: "the version must be MAJOR.MINOR.PATCH",
  readout_source_not_allowed: "a readout may only poll read-only commands",
  unknown_source: "the section refers to a source that is not declared",
  missing_manifest_field: "a required app field is missing",
};

/** @param {string} code */
export function describeCode(code) {
  const reason = code.split(":")[0];
  const explanation = CODE_MESSAGES[reason];
  return explanation ? `${code} -- ${explanation}` : code;
}
