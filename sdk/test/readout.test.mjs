// Readout packages.
//
// A readout renders in the operator's browser, so the property that matters
// most is that it carries no code and can only READ. Everything else is
// presentation.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { PackageError, analyzeReadout, canonicalBytes, readoutset, validatePackage } from "../lib/index.mjs";
import { APPS, ROOT, clone, loadPackage } from "./helpers.mjs";

const SOURCE = readFileSync(join(APPS, "sysmon", "readout.json"), "utf8");
const GOOD = JSON.parse(SOURCE);

/** @param {Record<string, unknown>} changes */
function mutate(changes) {
  const doc = clone(GOOD);
  Object.assign(doc.readout, changes);
  return doc;
}

/**
 * @param {unknown} doc
 * @param {string} prefix
 */
function assertRejects(doc, prefix) {
  assert.throws(() => validatePackage(doc), (error) => {
    assert.ok(error instanceof PackageError);
    assert.ok(error.code.startsWith(prefix), `expected ${prefix}, got ${error.code}`);
    return true;
  });
}

describe("sysmon", () => {
  test("the shipped readout validates", () => {
    const report = validatePackage(clone(GOOD), canonicalBytes(GOOD));
    assert.equal(report.kind, "readout");
    assert.equal(report.nodes, 0);
    assert.equal(report.estimatedUs, 0);
  });

  test("it fits the device package limit", () => {
    // It is stored on the device like any other package, so it is bound by
    // the same 4096-byte parse buffer.
    assert.ok(canonicalBytes(GOOD).length <= 4096);
  });

  test("it only reports what the device measures", () => {
    // No per-task RAM accounting and no current sensor exist, so a column for
    // either would be invented. Guard against one creeping in.
    const text = JSON.stringify(GOOD, null, 1).toLowerCase();
    for (const invented of ['"field": "ram"', '"field": "power"', '"field": "energy"', '"field": "watts"', '"field": "current_ma"']) {
      assert.ok(!text.includes(invented), invented);
    }
  });

  test("the editor analysis accepts it", () => {
    const analysis = analyzeReadout(SOURCE);
    assert.equal(analysis.ok, true, JSON.stringify(analysis.diagnostics));
  });
});

describe("read-only", () => {
  test("a write command is refused", () => {
    // The point of the allowlist: a readout renders in a browser and must not
    // be a way to reconfigure someone's device.
    for (const command of ["file_write_begin", "app_uninstall", "reboot", "set_scan_timing", "config_set", "app_install", "enter_maintenance"]) {
      assertRejects(mutate({ sources: [{ id: "x", command }] }), "readout_source_not_allowed");
    }
  });

  test("every allowed source is read-only", () => {
    for (const command of readoutset.ALLOWED_SOURCES) {
      assert.ok(!/^(set_|file_write|file_delete)/.test(command), `${command} mutates and must not be pollable`);
      assert.ok(!["reboot", "enter_maintenance", "exit_maintenance", "app_install", "app_uninstall", "app_activate"].includes(command));
    }
  });

  test("a readout may not carry a graph", () => {
    const doc = clone(GOOD);
    doc.nodes = [{ op: "total" }];
    assertRejects(doc, "readout_must_not_declare_nodes");
  });

  test("a flow may not carry a readout", () => {
    const doc = loadPackage("heel_strike");
    doc.readout = GOOD.readout;
    assertRejects(doc, "flow_must_not_declare_a_readout");
  });
});

describe("shape", () => {
  test("a section must reference a declared source", () => {
    assertRejects(mutate({ sections: [{ kind: "table", title: "X", source: "nope", columns: [{ label: "A", field: "a" }] }] }), "unknown_source");
  });

  test("unknown section kinds are refused", () => {
    assertRejects(mutate({ sections: [{ kind: "iframe", title: "X" }] }), "unknown_section_kind");
  });

  test("unknown formats are refused", () => {
    assertRejects(mutate({ sections: [{ kind: "table", title: "X", source: "tasks", columns: [{ label: "A", field: "a", format: "eval" }] }] }), "unknown_format");
  });

  test("the refresh interval is bounded", () => {
    // A readout polls a device; letting a package ask for 1ms would be a
    // denial of service on the device.
    assertRejects(mutate({ refresh_ms: 10 }), "invalid_refresh_ms");
    assertRejects(mutate({ refresh_ms: 10 ** 7 }), "invalid_refresh_ms");
  });

  test("duplicate source ids are refused", () => {
    assertRejects(mutate({ sources: [{ id: "a", command: "task_list" }, { id: "a", command: "scan_health" }] }), "duplicate_source_id");
  });

  test("a readout error is pinned to the offending line", () => {
    const source = SOURCE.replace('"command": "scan_health"', '"command": "reboot"');
    const analysis = analyzeReadout(source);
    assert.equal(analysis.ok, false);
    const line = source.split("\n").findIndex((l) => l.includes('"reboot"')) + 1;
    assert.equal(analysis.diagnostics[0].line, line);
  });

  test("invalid JSON is reported with a position", () => {
    const analysis = analyzeReadout('{\n  "nhapp": 1,\n  oops\n}');
    assert.equal(analysis.ok, false);
    assert.equal(analysis.diagnostics[0].line, 3);
  });
});

describe("catalog", () => {
  test("the index records the kind", () => {
    const index = JSON.parse(readFileSync(join(ROOT, "index.json"), "utf8"));
    const kinds = Object.fromEntries(index.apps.map((/** @type {{id: string, kind: string}} */ e) => [e.id, e.kind]));
    assert.equal(kinds.sysmon, "readout");
    assert.equal(kinds.heel_strike, "flow");
  });
});
