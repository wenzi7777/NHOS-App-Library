// @ts-check
/**
 * The arithmetic the v1.6.0 ops share with the firmware's FlowMath.cpp.
 *
 * Kept apart from the simulator so `test/firmware-contract.test.mjs` can run
 * the firmware's own FlowMath.cpp against exactly these functions. Region
 * resolution is integer arithmetic and must agree exactly; the trigonometry is
 * float32 on the device and double-then-fround here, which can differ in the
 * last place -- the contract test allows for that and nothing more.
 */

import { IMU_FIELDS, MAG_FIELDS, MAX_REL_PERCENT } from "./opset.mjs";

const f32 = Math.fround;
const RAD_TO_DEG = f32(57.29578);

/**
 * The rows (or columns) a region spans on a matrix `count` long.
 *
 * Absolute bounds pass through untouched; the sweep clips them to the frame.
 * Relative bounds are percentages: the first index is floor(a% of count) and
 * the last is ceil(b% of count) - 1, so `0..50` and `50..100` on an odd count
 * both include the middle row -- symmetric, which is what a left/right split
 * wants. The result always spans at least one index of a non-empty matrix.
 * @param {number} a first bound (index, or percent when `relative`)
 * @param {number} b last bound
 * @param {boolean} relative
 * @param {number} count rows or columns in the frame
 * @returns {{lo: number, hi: number}} an empty span has hi < lo
 */
export function resolveSpan(a, b, relative, count) {
  if (!relative) return { lo: a, hi: b };
  if (count <= 0) return { lo: 1, hi: 0 };
  const pa = Math.min(a, MAX_REL_PERCENT);
  const pb = Math.min(b, MAX_REL_PERCENT);
  let lo = Math.floor((pa * count) / 100);
  let hi = Math.floor((pb * count + 99) / 100) - 1;
  if (lo > count - 1) lo = count - 1;
  if (hi > count - 1) hi = count - 1;
  if (hi < lo) hi = lo;
  return { lo, hi };
}

/** @param {number} x */
export function sqrtSafe(x) {
  return x > 0 ? f32(Math.sqrt(x)) : 0;
}

/**
 * atan2 in degrees, -180 to 180.
 * @param {number} y
 * @param {number} x
 */
export function atan2Deg(y, x) {
  return f32(f32(Math.atan2(y, x)) * RAD_TO_DEG);
}

/**
 * One imu() field from a six-float sample (ax, ay, az in g; gx, gy, gz in deg/s).
 * @param {ArrayLike<number>} s
 * @param {number} field index into IMU_FIELDS
 */
export function imuField(s, field) {
  const ax = f32(s[0]);
  const ay = f32(s[1]);
  const az = f32(s[2]);
  switch (IMU_FIELDS[field]) {
    case "ax": return ax;
    case "ay": return ay;
    case "az": return az;
    case "gx": return f32(s[3]);
    case "gy": return f32(s[4]);
    case "gz": return f32(s[5]);
    case "acc_mag": return sqrtSafe(f32(f32(f32(ax * ax) + f32(ay * ay)) + f32(az * az)));
    case "gyro_mag": {
      const gx = f32(s[3]);
      const gy = f32(s[4]);
      const gz = f32(s[5]);
      return sqrtSafe(f32(f32(f32(gx * gx) + f32(gy * gy)) + f32(gz * gz)));
    }
    // Tilt from gravity alone, so only meaningful while the board is not
    // accelerating: pitch about y, roll about x, in the board's own axes.
    case "pitch": return atan2Deg(f32(-ax), sqrtSafe(f32(f32(ay * ay) + f32(az * az))));
    case "roll": return atan2Deg(ay, az);
    default: return 0;
  }
}

/**
 * One mag() field from a three-float sample in microtesla.
 * @param {ArrayLike<number>} s
 * @param {number} field index into MAG_FIELDS
 */
export function magField(s, field) {
  const mx = f32(s[0]);
  const my = f32(s[1]);
  const mz = f32(s[2]);
  switch (MAG_FIELDS[field]) {
    case "mx": return mx;
    case "my": return my;
    case "mz": return mz;
    case "strength": return sqrtSafe(f32(f32(f32(mx * mx) + f32(my * my)) + f32(mz * mz)));
    // Not tilt-compensated: the angle of the horizontal field in the board's
    // x-y plane, 0 to 360. Only a compass while the board lies flat.
    case "heading": {
      const angle = atan2Deg(my, mx);
      return angle < 0 ? f32(angle + 360) : angle;
    }
    default: return 0;
  }
}
