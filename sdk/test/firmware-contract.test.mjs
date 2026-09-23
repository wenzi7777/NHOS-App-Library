// The constants and rules this library shares with the firmware.
//
// If these drift, an app passes here and is refused by the device -- the most
// confusing failure this system can produce, because the author has no way to
// see the other side. The test reads the firmware's own sources rather than a
// copy, so it fails the moment either side moves.
//
// Skipped when the firmware is not checked out beside this repository.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
  MAX_PACKAGE_BYTES,
  MAX_SLOTS,
  MAX_WINDOW,
  OPS,
  PRESSURE_ACTIVE_THRESHOLD,
  PRESSURE_FULL_SCALE,
  SCALAR_OP_NS,
  WINDOW_POOL,
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
