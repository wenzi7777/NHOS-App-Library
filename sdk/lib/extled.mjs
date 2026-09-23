// @ts-check
/**
 * What the external LED strip shows, computed exactly as the device computes
 * it.
 *
 * A mirror of the firmware's AppExtLed.cpp, step for step and in float32, so
 * an editor can preview the strip offline and have it match the device pixel
 * for pixel. Brightness is left out: the device scales every channel by the
 * operator's brightness setting on the way to the LEDs, and that is not the
 * app's to decide.
 */

import { MAX_EXT_LEDS } from "./opset.mjs";

const f32 = Math.fround;
const METER_LOW = [0, 255, 0];
const METER_HIGH = [255, 0, 0];

/**
 * @typedef {object} ExtLedFrame
 * @property {{value: number, lo: number, hi: number} | null} meter
 * @property {(readonly [number, number, number] | null)[]} pixels one entry
 *   per possible pixel (MAX_EXT_LEDS), null where nothing lit it
 */

/**
 * How many of `count` pixels a meter lights for `value` over [lo, hi]: none
 * at or below lo (or for NaN), all at or above hi, and otherwise the fraction
 * rounded up, so any value above lo lights at least one.
 * @param {number} value
 * @param {number} lo
 * @param {number} hi
 * @param {number} count
 */
export function extMeterLit(value, lo, hi, count) {
  const span = f32(f32(hi) - f32(lo));
  if (!(span > 0)) return 0;
  const fraction = f32(f32(f32(value) - f32(lo)) / span);
  if (!(fraction > 0)) return 0;
  if (fraction >= 1) return count;
  const lit = Math.ceil(f32(fraction * count));
  return lit >= count ? count : lit;
}

/**
 * The colour of pixel `index` of a `count`-pixel meter: green at the start to
 * red at the end.
 * @param {number} index
 * @param {number} count
 * @returns {[number, number, number]}
 */
export function extMeterColour(index, count) {
  const t = count > 1 ? f32(index / (count - 1)) : 0;
  return /** @type {[number, number, number]} */ (METER_LOW.map((low, c) => Math.trunc(f32(low + f32((METER_HIGH[c] - low) * t)))));
}

/**
 * The strip as `frame` draws it on a `count`-pixel board: the meter, then the
 * pixels over it. Unlit pixels are [0, 0, 0].
 * @param {ExtLedFrame} frame
 * @param {number} count
 * @returns {[number, number, number][]}
 */
export function renderExtLeds(frame, count) {
  /** @type {[number, number, number][]} */
  const out = Array.from({ length: count }, () => [0, 0, 0]);
  if (frame.meter) {
    const lit = extMeterLit(frame.meter.value, frame.meter.lo, frame.meter.hi, count);
    for (let i = 0; i < lit; i += 1) out[i] = extMeterColour(i, count);
  }
  for (let i = 0; i < count && i < MAX_EXT_LEDS; i += 1) {
    const rgb = frame.pixels[i];
    if (rgb) out[i] = [rgb[0], rgb[1], rgb[2]];
  }
  return out;
}
