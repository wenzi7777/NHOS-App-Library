// Transitional: the JS toolchain against the Python one it replaces.
//
// Runs only while tools/*.py still exist and python3 is on the PATH. It pins
// that the rewrite changed nothing an author could observe -- the same
// packages for the same sources, the same events for the same frames -- apart
// from the device-faithfulness fixes listed in simulate.mjs. Delete this file
// together with tools/.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { Simulator, canonicalText, compileSource, parseSamplesCsv } from "../lib/index.mjs";
import { APPS, HEADER, ROOT, appsWith, loadPackage } from "./helpers.mjs";

const TOOLS = join(ROOT, "tools");

function pythonAvailable() {
  if (!existsSync(join(TOOLS, "compile.py"))) return false;
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const skip = pythonAvailable() ? false : "the Python toolchain is gone or python3 is not installed";

/** @param {string} script */
function python(script) {
  return execFileSync("python3", ["-c", script], { cwd: TOOLS, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * A deterministic pseudo-random walk, so every run tests the same frames.
 * @param {number} seed
 */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * Frames that sweep through each app's thresholds: integer-valued, so float32
 * and double agree exactly and any difference is a real semantic one.
 * @param {number} seed
 * @param {number} count
 */
function recording(seed, count) {
  const random = lcg(seed);
  const lines = [`timestamp_ms,${Array.from({ length: 225 }, (_, i) => `P${i + 1}`).join(",")},frame_seq`];
  let level = 0;
  for (let f = 0; f < count; f += 1) {
    level = Math.max(0, Math.min(400, level + Math.round((random() - 0.5) * 120)));
    const cells = Array.from({ length: 225 }, (_, i) => {
      const row = Math.floor(i / 15);
      const col = i % 15;
      const bias = col < 7 ? 1 : 0.6;
      const heel = row >= 8 ? 1.4 : 0.5;
      return random() < 0.3 ? 0 : Math.round(level * bias * heel * random() * 0.4);
    });
    lines.push(`${f * 17},${cells.join(",")},${5000 + f}`);
  }
  return `${lines.join("\n")}\n`;
}

describe("parity with the Python toolchain", { skip }, () => {
  test("every app source compiles to the same package", () => {
    for (const id of appsWith("app.nhs")) {
      const path = join(APPS, id, "app.nhs");
      const expected = python(`import sys; sys.path.insert(0, "."); from compile import compile_file; from validate import canonical_bytes; from pathlib import Path
sys.stdout.write(canonical_bytes(compile_file(Path(${JSON.stringify(path)}))[0]).decode())`);
      assert.equal(canonicalText(compileSource(readFileSync(path, "utf8")).package), expected, id);
    }
  });

  test("tricky sources compile to the same package", () => {
    const bodies = [
      "signal a = total()\nsignal b = 3 * (a - 1.5)\nevent e when b <= 2 hyst 0.25 for 12ms\n",
      "signal a = -peak() / 2\nevent e when a > 1\n",
      "region r = rows 1..3, cols 2..9\nsignal s = clamp(sum(r), 0, 500)\nsignal m = max_hold(delta(s), 20)\nevent jump when m > 30\nemit size value mean(s, 10) on rise(jump)\nled blue when jump\n",
      "signal load = budget_load()\ngate (load < 0.8) {\n  signal c = col_centroid()\n  event right when c > 7.5 for 40ms\n}\n",
      "signal n = counter(feature(in_contact))\nsignal ratio = feature(peak) / (feature(total_force) + 1)\nevent busy when n >= 3\nevent spiky when ratio > 0.2\n",
    ];
    for (const body of bodies) {
      const source = HEADER + body;
      const expected = python(`import sys; sys.path.insert(0, "."); from compile import compile_source; from validate import canonical_bytes
sys.stdout.write(canonical_bytes(compile_source(${JSON.stringify(source)})[0]).decode())`);
      assert.equal(canonicalText(compileSource(source).package), expected, body);
    }
  });

  test("every app produces the same events over the same frames", () => {
    const dir = mkdtempSync(join(tmpdir(), "nhos-parity-"));
    try {
      for (const [index, id] of appsWith("app.nhs").entries()) {
        const csvPath = join(dir, `${id}.csv`);
        const csv = recording(17 + index, 600);
        writeFileSync(csvPath, csv);
        const pkgPath = join(APPS, id, "app.nha");
        const expected = JSON.parse(python(`import sys, json; sys.path.insert(0, "."); from pathlib import Path
from simulate import Simulator, load_frames
package = json.loads(Path(${JSON.stringify(pkgPath)}).read_text())
sim = Simulator(package, app_name="x"); sim.run(load_frames(Path(${JSON.stringify(csvPath)}), 15, 15))
print(json.dumps([[e.frame_seq, e.event, e.detail] for e in sim.events if e.event != "led"]))`));
        const sim = new Simulator(loadPackage(id)).run(parseSamplesCsv(csv, { rows: 15, cols: 15 }));
        const actual = sim.events.map((e) => [e.frameSeq, e.event, e.detail]);
        assert.ok(expected.length > 0, `${id}: the fixture never triggers the app`);
        assert.deepEqual(actual, expected, id);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
