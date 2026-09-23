// Negative cases for the package validator.
//
// A validator that never rejects is worse than none: it teaches authors to
// trust it and then hands them an opaque device error instead.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  FEATURE_FIELDS,
  MAX_NODES,
  PackageError,
  SCALAR_OP_NS,
  canonicalBytes,
  graphCostUs,
  graphMemoryBytes,
  nodeCostNs,
  validatePackage,
} from "../lib/index.mjs";
import { appsWith, clone, loadPackage } from "./helpers.mjs";

const GOOD = loadPackage("heel_strike");

/** @param {Record<string, unknown>} changes */
function mutate(changes) {
  const doc = clone(GOOD);
  Object.assign(doc.manifest, changes);
  return doc;
}

/**
 * @param {unknown} doc
 * @param {string} prefix
 * @param {object} [options]
 */
function assertRejects(doc, prefix, options) {
  assert.throws(() => validatePackage(doc, null, options), (error) => {
    assert.ok(error instanceof PackageError, `expected a PackageError, got ${error}`);
    assert.ok(error.code.startsWith(prefix), `expected ${prefix}, got ${error.code}`);
    return true;
  });
}

/**
 * @param {unknown[]} nodes
 * @param {string} prefix
 * @param {Record<string, unknown>} [manifest]
 * @param {object} [options]
 */
function assertGraphRejects(nodes, prefix, manifest = {}, options = undefined) {
  const doc = clone(GOOD);
  doc.nodes = nodes;
  Object.assign(doc.manifest, manifest);
  assertRejects(doc, prefix, options);
}

describe("valid packages", () => {
  test("seed apps all validate", () => {
    for (const id of appsWith("app.nha")) assert.equal(validatePackage(loadPackage(id)).id, id);
  });

  test("features is expressible as a flow graph", () => {
    // The acceptance criterion for the op set: if the native FeatureExtractor
    // cannot be written as a graph, the op set is not complete enough.
    const doc = loadPackage("features");
    const report = validatePackage(doc);
    const fields = new Set(doc.nodes.filter((n) => n.op === "feature_get").map((n) => n.field));
    assert.deepEqual(fields, new Set(FEATURE_FIELDS));
    assert.ok(report.nodes <= MAX_NODES);
  });
});

describe("manifest rejection", () => {
  test("id must match the device path rules", () => {
    assertRejects(mutate({ id: "Heel-Strike" }), "invalid_id");
    assertRejects(mutate({ id: "9lives" }), "invalid_id");
  });

  test("id is capped at fifteen characters", () => {
    // "/files/apps/" + id + ".nha" must fit SPIFFS' 31-char path limit.
    assertRejects(mutate({ id: "a".repeat(16) }), "invalid_id");
    validatePackage(mutate({ id: "a".repeat(15) }));
  });

  test("reserved ids are refused", () => assertRejects(mutate({ id: "index" }), "reserved_id"));
  test("version must be semver", () => assertRejects(mutate({ version: "1.0" }), "invalid_version"));

  test("required fields are required", () => {
    const doc = clone(GOOD);
    delete doc.manifest.author;
    assertRejects(doc, "missing_manifest_field:author");
  });

  test("unknown capabilities are refused", () => {
    assertRejects(mutate({ capabilities: ["read_matrix", "launch_missiles"] }), "unknown_capability");
  });

  test("a manifest key may not shadow a package key", () => {
    // The firmware reads "nodes" with a flat key scan, so a manifest field of
    // the same name could be found first.
    assertRejects(mutate({ nodes: 3 }), "manifest_key_shadows_package_key");
  });

  test("min_os is compared as a version, not as a string", () => {
    // As strings "1.10.0" < "1.9.0", which let a v1.10 package claim too low.
    assert.equal(validatePackage(mutate({ min_os: "v1.10.0" })).id, "heel_strike");
  });
});

describe("graph rejection", () => {
  test("empty graph", () => assertGraphRejects([], "empty_graph"));
  test("too many nodes", () => assertGraphRejects(Array(13).fill({ op: "total" }), "too_many_nodes"));
  test("unknown op", () => assertGraphRejects([{ op: "teleport" }], "unknown_op"));

  test("forward references are impossible", () => {
    assertGraphRejects([{ op: "threshold", in: 1, value: 1 }, { op: "total" }], "input_out_of_order");
  });

  test("self reference is impossible", () => {
    assertGraphRejects([{ op: "total" }, { op: "threshold", in: 1, value: 1 }], "input_out_of_order");
  });

  test("emit needs a name within the firmware buffer", () => {
    assertGraphRejects([
      { op: "total" }, { op: "threshold", in: 0, value: 1 }, { op: "emit", in: 1, event: "e".repeat(24) },
    ], "event_name_too_long");
  });

  test("capabilities must cover what the graph does", () => {
    assertGraphRejects([
      { op: "total" }, { op: "threshold", in: 0, value: 1 }, { op: "emit", in: 1, event: "x" },
    ], "capability_not_declared:emit_event", { capabilities: ["read_matrix"] });
  });

  test("feature_get must read a features node", () => {
    assertGraphRejects([{ op: "total" }, { op: "feature_get", in: 0, field: "peak" }], "feature_get_input_must_be_features", { min_os: "v1.1.0" });
  });

  test("unknown feature field", () => {
    assertGraphRejects([{ op: "features" }, { op: "feature_get", in: 0, field: "vibes" }], "unknown_feature_field", { min_os: "v1.1.0" });
  });

  test("min_os must admit the ops used", () => {
    // A v1.1.0 op in a package that claims v1.0.0 would be accepted by the
    // library and then rejected by the device as unknown_op.
    assertGraphRejects([{ op: "features" }], "min_os_too_low", { min_os: "v1.0.0" });
  });

  test("windows are bounded", () => {
    assertGraphRejects([{ op: "total" }, { op: "mean", in: 0, window: 5000 }], "invalid_window", { min_os: "v1.1.0" });
  });
});

// Each of these passed the Python validator and was then refused by the
// device, after upload, with an error the author never saw locally.
describe("device-side refusals caught locally", () => {
  test("windows share one 128-float pool", () => {
    assertGraphRejects([
      { op: "total" }, { op: "mean", in: 0, window: 100 }, { op: "mean", in: 1, window: 100 },
    ], "window_pool_exhausted:200>128", { min_os: "v1.1.0" });
  });

  test("the LED palette is the firmware's", () => {
    assertGraphRejects([
      { op: "total" }, { op: "threshold", in: 0, value: 1 }, { op: "led", in: 1, rgb: "purple" },
    ], "unknown_colour:purple", { min_os: "v1.1.0", capabilities: ["read_matrix", "drive_led"] });
  });

  test("a debounce the device cannot store is refused", () => {
    assertGraphRejects([
      { op: "total" }, { op: "threshold", in: 0, value: 1 }, { op: "debounce", in: 1, ms: 70000 },
    ], "invalid_debounce_ms");
  });

  test("region indices must fit a byte", () => {
    assertGraphRejects([{ op: "region_sum", r0: 0, c0: 0, r1: 300, c1: 1 }], "invalid_region");
  });

  test("a graph over the device's budget is refused", () => {
    // Twelve features sweeps: 12 x 500ns x 256 cells = 1536us > 1500us.
    const nodes = Array(12).fill({ op: "features" });
    assertGraphRejects(nodes, "over_budget:1536us>1500us", { min_os: "v1.1.0" }, { cellCount: 256 });
    // The same graph fits the default 225-cell board.
    const doc = clone(GOOD);
    doc.nodes = nodes;
    doc.manifest.min_os = "v1.1.0";
    assert.equal(validatePackage(doc).estimatedUs, 1350);
  });

  test("a declared budget lowers the limit", () => {
    assertRejects(mutate({ budget_us: 50 }), "over_budget:70us>50us");
  });
});

describe("size", () => {
  test("oversized packages are refused", () => {
    const doc = clone(GOOD);
    doc.manifest.summary = "x".repeat(5000);
    assert.throws(() => validatePackage(doc, canonicalBytes(doc)), (error) => error instanceof PackageError && error.code.startsWith("package_too_large"));
  });
});

describe("cost model", () => {
  test("sweep cost scales with cells and scalars do not", () => {
    const sweep = [{ op: "total" }];
    const scalar = [{ op: "budget_load" }];
    assert.ok(graphCostUs(sweep, 225) > graphCostUs(sweep, 16));
    assert.equal(graphCostUs(scalar, 225), graphCostUs(scalar, 16));
  });

  test("gate is costed at its worst case", () => {
    // Charging the average would understate the bound and make the install
    // estimate a lie on the frames that matter.
    const ungated = [{ op: "budget_load" }, { op: "total" }];
    const gated = [...ungated, { op: "gate", in: [0, 1] }];
    const cost = (/** @type {{op: string}[]} */ nodes) => nodes.reduce((sum, node) => sum + nodeCostNs(node, 225), 0);
    assert.equal(cost(gated) - cost(ungated), SCALAR_OP_NS);
  });

  test("window memory is reserved up front", () => {
    assert.equal(graphMemoryBytes([{ op: "total" }, { op: "mean", in: 0, window: 30 }]), 120);
  });
});
