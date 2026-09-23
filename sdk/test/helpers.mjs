import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileSource } from "../lib/index.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const APPS = join(ROOT, "apps");
export const FIRMWARE = resolve(ROOT, "..", "NewHorizonsOS-OTA", "firmware", "newhorizons_os");

export const HEADER = `app demo {
  name    "Demo"
  version 1.0.0
  author  wenzi7777
  summary "test fixture"
}
`;

/** @param {string} body */
export function build(body) {
  return compileSource(HEADER + body);
}

/** @param {string} id */
export function loadPackage(id) {
  return JSON.parse(readFileSync(join(APPS, id, "app.nha"), "utf8"));
}

/** App directories containing `name`. */
export function appsWith(name) {
  return readdirSync(APPS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(APPS, entry.name, name)))
    .map((entry) => entry.name)
    .sort();
}

/**
 * @param {number[][]} valuesPerFrame
 * @param {{msStep?: number, rows?: number, cols?: number}} [shape]
 */
export function flatFrames(valuesPerFrame, { msStep = 16, rows = 1, cols } = {}) {
  return valuesPerFrame.map((values, index) => ({
    seq: 1000 + index,
    timestampMs: index * msStep,
    values,
    rows,
    cols: cols ?? values.length,
  }));
}

/** @param {unknown} value */
export const clone = (value) => structuredClone(value);
