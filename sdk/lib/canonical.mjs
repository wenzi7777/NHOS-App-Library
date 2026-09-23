// @ts-check
/**
 * Byte-exact package serialisation, so a rebuild of an unchanged app is a no-op.
 *
 * Published `<id>-<version>.nha` files are immutable -- the Desktop verifies
 * the sha256 recorded in index.json -- and every one of them was written by
 * the Python toolchain this replaced: `json.dumps(sort_keys=True,
 * separators=(",", ":"), ensure_ascii=False) + "\n"`. So the spelling here is
 * Python's, not JavaScript's, in the two places they differ:
 *
 * - A node's float fields (`value`, `hysteresis`, `lo`, `hi`) keep a `.0` when
 *   integral (`40.0`, where JSON.stringify writes `40`). The firmware reads
 *   them as float either way; the bytes are what the sha256 covers.
 * - Non-integral numbers use Python's repr thresholds for exponent notation
 *   (`1e-05`, where JavaScript writes `0.00001`).
 */

import { FLOAT_FIELDS } from "./opset.mjs";

const FLOAT_FIELD_SET = new Set(FLOAT_FIELDS);

/**
 * Python's `repr(float)`: shortest round-trip digits, fixed notation for
 * decimal exponents in [-4, 16), scientific otherwise.
 * @param {number} value
 */
export function pythonFloatRepr(value) {
  if (!Number.isFinite(value)) {
    // Python would write NaN/Infinity, which is not JSON and which the
    // firmware's parser would read as 0. Refuse rather than publish it.
    throw new RangeError(`cannot serialise non-finite number ${value}`);
  }
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";

  // toExponential() with no argument yields the shortest digit string that
  // round-trips -- the same digits Python's repr picks.
  const [mantissa, exponentText] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exponent = Number(exponentText);
  const sign = value < 0 ? "-" : "";

  if (exponent < -4 || exponent >= 16) {
    const head = digits[0];
    const tail = digits.slice(1);
    const expSign = exponent < 0 ? "-" : "+";
    const expDigits = String(Math.abs(exponent)).padStart(2, "0");
    return `${sign}${head}${tail ? `.${tail}` : ""}e${expSign}${expDigits}`;
  }
  if (exponent < 0) {
    return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  }
  const intLength = exponent + 1;
  if (digits.length <= intLength) {
    return `${sign}${digits.padEnd(intLength, "0")}.0`;
  }
  return `${sign}${digits.slice(0, intLength)}.${digits.slice(intLength)}`;
}

/**
 * @param {number} value
 * @param {boolean} asFloat
 */
function formatNumber(value, asFloat) {
  if (!asFloat && Number.isInteger(value) && Math.abs(value) < 1e21) return String(value);
  return pythonFloatRepr(value);
}

/**
 * @param {unknown} value
 * @param {boolean} inNode true while serialising an element of `nodes`
 * @param {string|null} key the key this value sits under
 * @returns {string}
 */
function serialise(value, inNode, key) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatNumber(value, inNode && key !== null && FLOAT_FIELD_SET.has(key));
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    // Only the top-level `nodes` array holds nodes. Array elements have no
    // key, so an `in` list inside a node stays plain integers.
    const elementsAreNodes = inNode || key === "nodes";
    return `[${value.map((item) => serialise(item, elementsAreNodes, null)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    // Python's sort_keys orders by code point; for the BMP that is the same
    // as JavaScript's default UTF-16 comparison.
    const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${serialise(record[k], inNode, k)}`).join(",")}}`;
  }
  throw new TypeError(`cannot serialise ${typeof value}`);
}

/**
 * The canonical text of a package, including the trailing newline.
 * @param {unknown} doc
 */
export function canonicalText(doc) {
  return `${serialise(doc, false, null)}\n`;
}

/**
 * The canonical bytes of a package: what is hashed, published and uploaded.
 * @param {unknown} doc
 */
export function canonicalBytes(doc) {
  return new TextEncoder().encode(canonicalText(doc));
}
