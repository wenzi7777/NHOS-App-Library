// @ts-check
/**
 * What an OLED row looks like, computed exactly as the device computes it.
 *
 * A mirror of the firmware's AppDisplay.cpp, step for step and in float32, so
 * an editor can preview the panel offline and have it match the device to the
 * character and the pixel. An app says WHAT to show; drawing is the firmware's
 * job, which is why this can be exact at all.
 */

import { MAX_OLED_DIGITS, MAX_OLED_LABEL, OLED_COLS, OLED_WIDTH_PX } from "./opset.mjs";

const f32 = Math.fround;
const GLYPH_PX = 6;
const DIGIT_SCALE = [1, 10, 100, 1000];

/**
 * `value` with `digits` decimals, rounded half away from zero. A value whose
 * magnitude times 10^digits reaches 1e9 -- and NaN or infinity -- is "#".
 *
 * Rounded by hand, not with toFixed(): printf and toFixed disagree on exact
 * ties, and this has to match the device, which does the same by hand. The
 * device does it in double because a float32 times at most 1000, plus 0.5, is
 * exact there -- so it is exact here too, and fused multiply-add on the S3
 * cannot make the two disagree.
 * @param {number} value
 * @param {number} digits
 */
export function formatOledValue(value, digits) {
  const d = Math.max(0, Math.min(MAX_OLED_DIGITS, Math.trunc(digits) || 0));
  const v = f32(value);
  const negative = v < 0;
  const scaled = Math.abs(v) * DIGIT_SCALE[d];
  if (!(scaled < 1e9)) return "#";
  const rounded = Math.floor(scaled + 0.5);
  const sign = negative && rounded !== 0 ? "-" : "";
  if (d === 0) return `${sign}${rounded}`;
  const divisor = DIGIT_SCALE[d];
  return `${sign}${Math.floor(rounded / divisor)}.${String(rounded % divisor).padStart(d, "0")}`;
}

/**
 * A text row as the panel shows it: the label at the left, the value
 * right-aligned to the last column, exactly OLED_COLS characters. A value that
 * does not fit beside the label is shown as "#".
 * @param {string} label
 * @param {number} value
 * @param {number} digits
 */
export function formatOledTextLine(label, value, digits) {
  const shown = String(label).slice(0, MAX_OLED_LABEL);
  let number = formatOledValue(value, digits);
  const room = OLED_COLS - shown.length - (shown.length !== 0 ? 1 : 0);
  if (number.length > room) number = "#";
  return shown.padEnd(OLED_COLS - number.length, " ") + number;
}

/**
 * @typedef {object} OledBarGeometry
 * @property {number} x0 left edge of the outline, in pixels
 * @property {number} width outline width, reaching the right edge of the panel
 * @property {number} fillPx filled pixels inside the outline, 0..width-2
 */

/**
 * A bar row's geometry for `value` in [lo, hi].
 * @param {number} labelLen
 * @param {number} value
 * @param {number} lo
 * @param {number} hi
 * @returns {OledBarGeometry}
 */
export function oledBarGeometry(labelLen, value, lo, hi) {
  const len = Math.min(MAX_OLED_LABEL, Math.max(0, Math.trunc(labelLen)));
  const x0 = len !== 0 ? (len + 1) * GLYPH_PX : 0;
  const width = OLED_WIDTH_PX - x0;
  const inner = width - 2;
  let fraction = f32(f32(f32(value) - f32(lo)) / f32(f32(hi) - f32(lo)));
  // NaN fails every comparison, so it lands on empty rather than on garbage.
  if (!(fraction > 0)) fraction = 0;
  else if (fraction > 1) fraction = 1;
  return { x0, width, fillPx: Math.floor(f32(fraction * inner)) };
}
