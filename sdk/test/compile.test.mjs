// Compiler tests.
//
// The three jobs the compiler exists to do -- topological ordering, common
// subexpression elimination, and honest cost reporting -- each get a test,
// because each one is something an author would otherwise have to do by hand
// and would get wrong silently.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { CompileError, FEATURE_FIELDS, canonicalText, compileSource, validatePackage } from "../lib/index.mjs";
import { APPS, appsWith, build } from "./helpers.mjs";

/** @param {Record<string, unknown>} node */
const refsOf = (node) => (node.in === undefined ? [] : Array.isArray(node.in) ? node.in : [node.in]);

/**
 * @param {string} body
 * @param {string} fragment
 */
function assertFails(body, fragment) {
  assert.throws(() => build(body), (error) => {
    assert.ok(error instanceof CompileError, `expected a CompileError, got ${error}`);
    assert.match(error.message, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    return true;
  });
}

describe("seed apps", () => {
  test("every source compiles to its committed artifact, byte for byte", () => {
    for (const id of appsWith("app.nhs")) {
      const { package: pkg } = compileSource(readFileSync(join(APPS, id, "app.nhs"), "utf8"));
      assert.equal(canonicalText(pkg), readFileSync(join(APPS, id, "app.nha"), "utf8"), `${id}: app.nha is stale`);
    }
  });
});

describe("ordering", () => {
  test("references always point backwards", () => {
    const { package: pkg } = build("signal a = total()\nsignal b = a * 2 + peak()\nevent hot when b > 10\n");
    pkg.nodes.forEach((node, index) => {
      for (const ref of refsOf(node)) assert.ok(ref < index, `node ${index} references ${ref}`);
    });
  });

  test("inserting an intermediate value does not break indices", () => {
    // The renumbering an author would have to do by hand.
    const direct = build("signal a = total() + peak()\nevent e when a > 1\n").package;
    const staged = build("signal t = total()\nsignal p = peak()\nsignal a = t + p\nevent e when a > 1\n").package;
    assert.deepEqual(direct.nodes, staged.nodes);
  });
});

describe("sharing", () => {
  test("identical subexpressions cost one node", () => {
    const { package: pkg, report } = build("signal x = total() / (total() + peak())\nevent e when x > 1\n");
    assert.equal(pkg.nodes.filter((n) => n.op === "total").length, 1, "the second total() should have been shared");
    assert.ok(report.reused > 0);
  });

  test("features collapses to a single sweep", () => {
    // Eight feature reads, one sweep -- the whole reason feature_get exists.
    const body = FEATURE_FIELDS.map((name, i) => `signal f${i} = feature(${name})\n`).join("");
    const { package: pkg } = build(`${body}event e when f0 > 1\n`);
    assert.equal(pkg.nodes.filter((n) => n.op === "features").length, 1);
  });
});

describe("cost report", () => {
  test("over the node limit names the biggest contributors", () => {
    const body = Array.from({ length: 14 }, (_, i) => `signal s${i} = total() + ${i}\n`).join("");
    assertFails(`${body}event e when s0 > 1\n`, "exceeds the 12-node limit");
    assertFails(`${body}event e when s0 > 1\n`, "Largest contributors");
  });

  test("a literal argument does not become a node", () => {
    // It used to, which wasted a slot and dragged min_os up to v1.1.0 for a
    // graph that only used v1.0.0 operators.
    const { package: pkg } = build("signal c = active(3.0)\nevent e when c > 1\n");
    assert.ok(!pkg.nodes.some((n) => n.op === "const"));
    assert.equal(pkg.manifest.min_os, "v1.0.0");
  });

  test("min_os is derived from the ops used", () => {
    assert.equal(build("signal a = total()\nevent e when a > 1\n").package.manifest.min_os, "v1.0.0");
    assert.equal(build("signal a = total()\nsignal b = mean(a, 10)\nevent e when b > 1\n").package.manifest.min_os, "v1.1.0");
  });

  test("capabilities are derived, not declared", () => {
    assert.deepEqual(build("signal a = total()\nevent e when a > 1\n").package.manifest.capabilities, ["emit_event", "read_matrix"]);
  });

  test("the report maps every node back to its source line", () => {
    const { report } = build("signal a = total()\nevent e when a > 1\n");
    // HEADER is six lines, so the body starts on line 7.
    assert.deepEqual(report.nodeLines, [7, 8, 8]);
    assert.equal(report.signals.a, 0);
    assert.equal(report.events.e, 1);
  });
});

describe("diagnostics", () => {
  test("unknown value", () => assertFails("event e when nope > 1\n", "unknown value"));
  test("a dash inside a name gets a hint", () => assertFails("signal l = total()\nsignal r = peak()\nsignal d = l-r\n", "put spaces around '-'"));
  test("unknown function", () => assertFails("signal a = teleport()\nevent e when a > 1\n", "unknown function"));
  test("unknown region", () => assertFails("signal a = sum(nowhere)\nevent e when a > 1\n", "sum() takes a region"));
  test("inverted region", () => assertFails("region r = rows 9..2, cols 0..3\nsignal a = sum(r)\nevent e when a > 1\n", "inverted range"));
  test("a region index must be whole", () => assertFails("region r = rows 0..2.5, cols 0..3\n", "whole number"));
  test("led needs a known event", () => assertFails("signal a = total()\nled green when nothing\n", "unknown event"));
  test("led colour must be in the device palette", () => assertFails("signal a = total()\nevent e when a > 1\nled purple when e\n", "unknown colour 'purple'"));
  test("a debounce longer than the device can store is refused", () => assertFails("signal a = total()\nevent e when a > 1 for 70000ms\n", "exceeds 65535ms"));
  test("an unterminated gate is reported", () => assertFails("signal a = total()\ngate (a > 1) {\n event e when a > 2\n", "unterminated gate"));

  test("event name length is checked against the firmware buffer", () => {
    assertFails(`signal a = total()\nevent ${"e".repeat(24)} when a > 1\n`, "exceeds 23 characters");
  });

  test("errors carry a line and a column", () => {
    assert.throws(() => build("signal a = total()\nevent e when a > 1\nsignal b = nope\n"), (error) => {
      assert.ok(error instanceof CompileError);
      assert.equal(error.line, 9);
      assert.equal(error.col, 12);
      assert.equal(error.endCol, 16);
      return true;
    });
  });

  test("an unexpected character is placed exactly", () => {
    assert.throws(() => build("signal a = total() $\n"), (error) => {
      assert.ok(error instanceof CompileError);
      assert.deepEqual([error.line, error.col], [7, 20]);
      return true;
    });
  });
});

describe("comparisons", () => {
  test("less-than is compiled and the cost is disclosed", () => {
    const { package: pkg, report } = build("signal load = budget_load()\nevent easy when load < 0.9\n");
    assert.ok(report.notes.some((note) => note.message.includes("compiled as a subtraction")));
    assert.ok(pkg.nodes.some((n) => n.op === "sub"));
  });

  test("hysteresis and debounce reach the nodes", () => {
    const { package: pkg } = build("signal a = total()\nevent e when a > 40 hyst 6 for 30ms\n");
    assert.equal(pkg.nodes.find((n) => n.op === "threshold").hysteresis, 6);
    assert.equal(pkg.nodes.find((n) => n.op === "debounce").ms, 30);
  });
});

describe("output", () => {
  test("compiled packages validate", () => {
    const { package: pkg } = build("region r = rows 0..3, cols 0..3\nsignal a = sum(r)\nevent e when a > 1\nled green when e\n");
    assert.equal(validatePackage(pkg).id, "demo");
  });

  test("led declares its capability", () => {
    const { package: pkg } = build("signal a = total()\nevent e when a > 1\nled green when e\n");
    assert.ok(pkg.manifest.capabilities.includes("drive_led"));
  });
});
