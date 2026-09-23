// The constants and rules this library shares with the firmware.
//
// If these drift, an app passes here and is refused by the device -- the most
// confusing failure this system can produce, because the author has no way to
// see the other side. The test reads the firmware's own sources rather than a
// copy, so it fails the moment either side moves.
//
// Skipped when the firmware is not checked out beside this repository.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  CAPABILITIES,
  CELL_OP_NS_PER_CELL,
  DEFAULT_BUDGET_US,
  FEATURES_NS_PER_CELL,
  FEATURE_FIELDS,
  GOVERNOR_CEILING_PERMILLE,
  LED_COLOURS,
  MAX_APP_ID,
  MAX_NODES,
  MAX_OLED_DIGITS,
  MAX_OLED_LABEL,
  MAX_PACKAGE_BYTES,
  MAX_PENDING_PRESSES,
  MAX_SLOTS,
  MAX_WINDOW,
  OLED_COLS,
  OLED_ROWS,
  OLED_ROW_PX,
  OLED_WIDTH_PX,
  OPS,
  PRESSURE_ACTIVE_THRESHOLD,
  PRESSURE_FULL_SCALE,
  SCALAR_OP_NS,
  WINDOW_POOL,
  formatOledTextLine,
  formatOledValue,
  oledBarGeometry,
} from "../lib/index.mjs";
import { APPS, FIRMWARE, appsWith } from "./helpers.mjs";

const present = existsSync(FIRMWARE);
const skip = present ? false : "NewHorizonsOS-OTA is not checked out beside this repo";

/** @param {string} name */
const source = (name) => readFileSync(join(FIRMWARE, name), "utf8");

/**
 * @param {string} text
 * @param {string} name
 */
function constant(text, name) {
  const match = new RegExp(`${name}\\s*=\\s*([0-9.]+)`).exec(text);
  assert.ok(match, `${name} not found in the firmware`);
  return Number(match[1]);
}

/**
 * The body of a C++ function, from its signature to the first closing brace
 * at column 0.
 * @param {string} text
 * @param {string} signature
 */
function body(text, signature) {
  const start = text.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = text.slice(start);
  return rest.slice(0, rest.indexOf("\n}"));
}

describe("cost model contract", { skip }, () => {
  const flowH = present ? source("FlowApp.h") : "";
  const flowCpp = present ? source("FlowApp.cpp") : "";

  test("the cost constants match", () => {
    assert.equal(constant(flowH, "kCellOpNsPerCell"), CELL_OP_NS_PER_CELL);
    assert.equal(constant(flowH, "kScalarOpNs"), SCALAR_OP_NS);
    assert.equal(constant(flowH, "kFeaturesNsPerCell"), FEATURES_NS_PER_CELL);
  });

  test("the hard limits match", () => {
    assert.equal(constant(flowH, "kMaxNodes"), MAX_NODES);
    assert.equal(constant(flowH, "kMaxPackageBytes"), MAX_PACKAGE_BYTES);
    // A window the library accepts but the device cannot allocate would be
    // rejected only after upload, as invalid_window.
    assert.equal(constant(flowH, "kMaxWindow"), MAX_WINDOW);
    // ... and a set of windows that do not fit the shared pool, as
    // window_pool_exhausted.
    assert.equal(constant(flowH, "kWindowPool"), WINDOW_POOL);
    assert.equal(constant(flowH, "kDefaultBudgetUs"), DEFAULT_BUDGET_US);
  });

  test("the governor's share matches", () => {
    assert.equal(constant(source("AppGovernor.h"), "kDefaultCeilingPermille"), GOVERNOR_CEILING_PERMILLE);
    assert.equal(constant(source("AppRegistry.h"), "kMaxSlots"), MAX_SLOTS);
  });

  test("the pressure constants the features sweep uses match", () => {
    const scanner = source("MatrixScanner.h");
    assert.equal(constant(scanner, "kPressureActiveThreshold"), PRESSURE_ACTIVE_THRESHOLD);
    assert.equal(constant(scanner, "kPressureFullScale"), PRESSURE_FULL_SCALE);
  });

  test("the app id cap matches", () => {
    // kIdLen counts the NUL, so the usable length is one less.
    assert.equal(constant(source("AppPackage.h"), "kIdLen") - 1, MAX_APP_ID);
  });

  test("the op sets agree in both directions", () => {
    // Scoped to opFromName: featureFieldFromName uses the same shape.
    const table = body(flowCpp, "FlowOp FlowApp::opFromName");
    const firmwareOps = new Set([...table.matchAll(/name == "([a-z_0-9]+)"/g)].map((m) => m[1]));
    const libraryOps = new Set(Object.keys(OPS));
    assert.deepEqual([...libraryOps].filter((op) => !firmwareOps.has(op)), [], "the firmware has no case for these");
    assert.deepEqual([...firmwareOps].filter((op) => !libraryOps.has(op)), [], "the library cannot emit these");
  });

  test("the feature fields agree, in order", () => {
    const fields = [...flowCpp.matchAll(/name == "([a-z_0-9]+)"\) return static_cast<uint8_t>\(FeatureField::(\w+)\)/g)].map((m) => m[1]);
    assert.deepEqual(new Set(fields), new Set(FEATURE_FIELDS));
    // FeatureField's enum order is the wire order the library documents.
    const enumBody = /enum class FeatureField : uint8_t \{([^}]*)\}/.exec(flowH);
    assert.ok(enumBody);
    const members = enumBody[1].split(",").map((m) => m.trim().split(/\s|=/)[0]).filter((m) => m && m !== "Count");
    const camel = FEATURE_FIELDS.map((f) => f.replace(/(^|_)([a-z0-9])/g, (_, __, c) => c.toUpperCase()));
    assert.deepEqual(members, camel);
  });

  test("the LED palette agrees", () => {
    // An unknown colour is refused on the device only after upload.
    const colours = [...flowCpp.matchAll(/rgb == "([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(new Set(colours), new Set(Object.keys(LED_COLOURS)));
  });

  test("the capability names agree", () => {
    const block = body(source("AppPackage.cpp"), "uint16_t AppPackage::capabilityFromName");
    const firmwareCaps = new Set([...block.matchAll(/name == "([a-z_]+)"/g)].map((m) => m[1]));
    // The library only lets an author declare the data capabilities; the
    // event-source bits are set by the device, not by a package.
    assert.deepEqual(Object.keys(CAPABILITIES).filter((cap) => !firmwareCaps.has(cap)), []);
  });
});

describe("OLED contract", { skip }, () => {
  test("the panel's shape and limits match", () => {
    const display = source("AppDisplay.h");
    assert.equal(constant(display, "kOledRows"), OLED_ROWS);
    assert.equal(constant(display, "kOledCols"), OLED_COLS);
    assert.equal(constant(display, "kOledRowPx"), OLED_ROW_PX);
    assert.equal(constant(display, "kOledWidthPx"), OLED_WIDTH_PX);
    assert.equal(constant(display, "kMaxOledLabel"), MAX_OLED_LABEL);
    assert.equal(constant(display, "kMaxOledDigits"), MAX_OLED_DIGITS);
    assert.equal(constant(source("FlowApp.h"), "kMaxPendingPresses"), MAX_PENDING_PRESSES);
  });

  // The strongest form of the contract: the firmware's own formatting code,
  // compiled for this machine, against oled.mjs, value for value. Skipped
  // without a C++ toolchain that can link a program; everything above still
  // runs. CXXFLAGS is passed through, e.g. an -isysroot for a working SDK.
  const cxxflags = (process.env.CXXFLAGS ?? "").split(/\s+/).filter(Boolean);
  const compiler = present ? ["c++", "clang++", "g++"].find((name) => {
    const dir = mkdtempSync(join(tmpdir(), "nhos-cxx-"));
    try {
      writeFileSync(join(dir, "probe.cpp"), "int main() { return 0; }\n");
      execFileSync(name, [...cxxflags, join(dir, "probe.cpp"), "-o", join(dir, "probe")], { stdio: "ignore" });
      execFileSync(join(dir, "probe"), { stdio: "ignore" });
      return true;
    } catch {
      return false;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }) : undefined;
  test("the firmware draws every row the way oled.mjs says", { skip: compiler ? false : "no C++ toolchain that links" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "nhos-oled-"));
    try {
      writeFileSync(join(dir, "harness.cpp"), `
#include <cstdio>
#include <cstring>
#include "AppDisplay.h"
using namespace nhos;
static float fromBits(unsigned bits) { float f; std::memcpy(&f, &bits, 4); return f; }
int main() {
  char kind;
  while (std::scanf(" %c", &kind) == 1) {
    unsigned bits, a, b, c;
    if (kind == 'v') {
      std::scanf("%x %u", &bits, &a);
      char out[16];
      formatOledValue(fromBits(bits), static_cast<uint8_t>(a), out, sizeof(out));
      std::printf("%s\\n", out);
    } else if (kind == 't') {
      char label[16];
      std::scanf("%15s %x %u", label, &bits, &a);
      char out[kOledCols + 1];
      formatOledTextLine(std::strcmp(label, "-") == 0 ? "" : label, fromBits(bits), static_cast<uint8_t>(a), out);
      std::printf("[%s]\\n", out);
    } else if (kind == 'b') {
      std::scanf("%u %x %x %x", &a, &bits, &b, &c);
      const OledBarGeometry g = oledBarGeometry(static_cast<uint8_t>(a), fromBits(bits), fromBits(b), fromBits(c));
      std::printf("%d %d %d\\n", g.x0, g.width, g.fillPx);
    }
  }
}
`);
      const binary = join(dir, "harness");
      execFileSync(/** @type {string} */ (compiler), [...cxxflags, "-std=c++17", "-O2", "-I", FIRMWARE, join(dir, "harness.cpp"), join(FIRMWARE, "AppDisplay.cpp"), "-o", binary]);

      const bits = (/** @type {number} */ value) => new Uint32Array(new Float32Array([value]).buffer)[0].toString(16);
      const f32 = Math.fround;
      // Ties, near-ties, signs, the overflow edge, and a spread of magnitudes.
      /** @type {number[]} */
      const values = [0, -0, 0.5, -0.5, 1.5, 2.5, 0.125, 0.0625, 1.05, 12.345, 999.9995, 99999.99,
        999999.9, 1e6, 1e9, 4e9, -1234.5678, 1e-7, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
      let seed = 7;
      for (let i = 0; i < 400; i += 1) {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        const magnitude = 10 ** ((seed % 1000) / 100 - 3);
        values.push(f32((seed % 2 ? -1 : 1) * magnitude * ((seed % 997) / 997)));
      }
      const lines = [];
      const expected = [];
      for (const value of values) {
        for (let digits = 0; digits <= MAX_OLED_DIGITS; digits += 1) {
          lines.push(`v ${bits(value)} ${digits}`);
          expected.push(formatOledValue(value, digits));
        }
        lines.push(`t Load ${bits(value)} 1`);
        expected.push(`[${formatOledTextLine("Load", value, 1)}]`);
        lines.push(`t abcdefghij ${bits(value)} 3`);
        expected.push(`[${formatOledTextLine("abcdefghij", value, 3)}]`);
        lines.push(`t - ${bits(value)} 0`);
        expected.push(`[${formatOledTextLine("", value, 0)}]`);
        for (const [len, lo, hi] of [[0, 0, 100], [4, -50, 50], [10, 0.1, 0.7]]) {
          lines.push(`b ${len} ${bits(value)} ${bits(lo)} ${bits(hi)}`);
          const g = oledBarGeometry(len, value, lo, hi);
          expected.push(`${g.x0} ${g.width} ${g.fillPx}`);
        }
      }
      const actual = execFileSync(binary, { input: `${lines.join("\n")}\n` }).toString().trimEnd().split("\n");
      assert.equal(actual.length, expected.length);
      const mismatches = actual
        .map((line, i) => (line === expected[i] ? null : `${lines[i]}: firmware ${line}, library ${expected[i]}`))
        .filter(Boolean);
      assert.deepEqual(mismatches, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("package contract", { skip }, () => {
  test("the firmware accepts every kind this library emits", () => {
    const packageCpp = source("AppPackage.cpp");
    for (const id of appsWith("app.nha")) {
      const { kind } = JSON.parse(readFileSync(join(APPS, id, "app.nha"), "utf8"));
      assert.ok(["flow", "readout"].includes(kind), id);
      // A kind the device does not know is refused as unsupported_kind AFTER
      // upload, which is a confusing place to find out.
      assert.ok(packageCpp.includes(`"${kind}"`), kind);
    }
  });

  test("the firmware never dispatches a readout", () => {
    const registry = source("AppRegistry.cpp");
    // A readout holds a registry entry so that what a device has travels with
    // the device -- but it has nothing to run.
    assert.ok(registry.includes("not_activatable:readout"));
    assert.ok(registry.includes("kAppPackageReadout"));
  });

  test("the install-time dry run uses the declared budget or the default", () => {
    // validate.mjs refuses over_budget on the same terms; if the device ever
    // checks against something else, that rule has to move with it.
    const registry = source("AppRegistry.cpp");
    assert.match(registry, /manifest\.declaredBudgetUs != 0 \? manifest\.declaredBudgetUs\s*:\s*FlowApp::kDefaultBudgetUs/);
    assert.match(source("AppPackage.cpp"), /jsonExtractInt\(manifest, "budget_us"/);
  });
});
