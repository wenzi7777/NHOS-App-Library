// Canonical bytes are what the sha256 in index.json covers. Every published
// package was written by the Python toolchain, so the spelling must be
// Python's, byte for byte, or a rebuild would rewrite immutable artifacts.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { canonicalText, pythonFloatRepr } from "../lib/index.mjs";
import { APPS, ROOT, appsWith } from "./helpers.mjs";

describe("python float repr", () => {
  const cases = [
    [0, "0.0"], [-0, "-0.0"], [40, "40.0"], [0.05, "0.05"], [1e-5, "1e-05"], [1e-4, "0.0001"],
    [1e16, "1e+16"], [1e15, "1000000000000000.0"], [1.5e-7, "1.5e-07"], [-3.25, "-3.25"],
    [0.1 + 0.2, "0.30000000000000004"], [123456.789, "123456.789"], [2.5e20, "2.5e+20"],
  ];
  for (const [value, expected] of cases) {
    test(`${expected}`, () => assert.equal(pythonFloatRepr(/** @type {number} */ (value)), expected));
  }

  test("non-finite numbers are refused rather than published", () => {
    assert.throws(() => pythonFloatRepr(Number.NaN), RangeError);
  });
});

describe("package spelling", () => {
  test("node float fields keep their .0; everything else stays an integer", () => {
    const doc = { nhapp: 1, nodes: [{ op: "threshold", in: 0, value: 40, hysteresis: 6 }, { op: "mean", in: [0, 1], window: 30 }], manifest: { b: 1, a: 2 } };
    assert.equal(canonicalText(doc),
      '{"manifest":{"a":2,"b":1},"nhapp":1,"nodes":[{"hysteresis":6.0,"in":0,"op":"threshold","value":40.0},{"in":[0,1],"op":"mean","window":30}]}\n');
  });

  test("non-ASCII text is written as-is, as with ensure_ascii=False", () => {
    assert.equal(canonicalText({ s: "左右平衡" }), '{"s":"左右平衡"}\n');
  });

  test("every published package round-trips unchanged", () => {
    for (const id of appsWith("app.nha")) {
      const text = readFileSync(join(APPS, id, "app.nha"), "utf8");
      assert.equal(canonicalText(JSON.parse(text)), text, id);
    }
    // Every version ever published, not just the current ones.
    for (const id of readdirSync(join(ROOT, "dist"))) {
      for (const file of readdirSync(join(ROOT, "dist", id)).filter((name) => name.endsWith(".nha"))) {
        const text = readFileSync(join(ROOT, "dist", id, file), "utf8");
        assert.equal(canonicalText(JSON.parse(text)), text, file);
      }
    }
  });
});
