#!/usr/bin/env node
// @ts-check
/**
 * nhos -- the NHOS App Library command line.
 *
 *   node sdk/bin/nhos.mjs compile  [app.nhs ...] [--write] [--cells N]
 *   node sdk/bin/nhos.mjs validate [app.nha ...] [--cells N]
 *   node sdk/bin/nhos.mjs simulate <app.nha|app.nhs> <samples.csv> [--rows R --cols C]
 *                                  [--events out.events.csv] [--compare recorded.events.csv] [--budget]
 *                                  [--press ms,ms,...]
 *   node sdk/bin/nhos.mjs build-index [--check]
 *   node sdk/bin/nhos.mjs check-versions [--base origin/main]
 *
 * With no paths, compile and validate cover every app under apps/.
 * Everything here is file handling; the logic is in ../lib and is the same
 * code the Desktop's SDK page runs in the browser.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CompileError,
  DEFAULT_CELL_COUNT,
  MAX_EXT_LEDS,
  OLED_COLS,
  OPS,
  PackageError,
  Simulator,
  canonicalBytes,
  canonicalText,
  compareEvents,
  compileSource,
  formatEventsCsv,
  graphCostUs,
  parseEventsCsv,
  parseSamplesCsv,
  validatePackage,
} from "../lib/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APPS = join(ROOT, "apps");
const RAW_BASE = "https://raw.githubusercontent.com/wenzi7777/NHOS-App-Library/main";
const LOCALES = ["en", "ja", "zh-CN"];

/**
 * @param {string[]} argv
 * @param {Record<string, "flag"|"value">} spec
 */
function parseArgs(argv, spec) {
  /** @type {Record<string, string|boolean>} */
  const options = {};
  /** @type {string[]} */
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const kind = spec[name];
      if (!kind) throw new UsageError(`unknown option ${arg}`);
      if (kind === "flag") {
        options[name] = true;
      } else {
        const value = argv[i + 1];
        if (value === undefined) throw new UsageError(`${arg} needs a value`);
        options[name] = value;
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

class UsageError extends Error {}

/** @param {string|boolean|undefined} value */
function intOption(value) {
  if (value === undefined || typeof value === "boolean") return undefined;
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number <= 0) throw new UsageError(`expected a positive integer, got ${value}`);
  return number;
}

/** @param {string} name the file every matching app directory must contain */
function appFiles(name) {
  if (!existsSync(APPS)) return [];
  return readdirSync(APPS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(APPS, entry.name, name)))
    .map((entry) => join(APPS, entry.name, name))
    .sort();
}

/** @param {string} path shown relative to where the command was run */
const shown = (path) => relative(process.cwd(), path) || path;

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Compile a source file and validate the result, as a build must.
 * @param {string} path
 * @param {{cellCount?: number}} [options]
 */
function compileFile(path, options = {}) {
  const { package: pkg, report } = compileSource(readFileSync(path, "utf8"), options);
  validatePackage(pkg, canonicalBytes(pkg), options);
  return { pkg, report };
}

// --- compile ----------------------------------------------------------------

/** @param {string[]} argv */
function cmdCompile(argv) {
  const { options, positional } = parseArgs(argv, { write: "flag", cells: "value" });
  const cellCount = intOption(options.cells);
  const paths = positional.length ? positional : appFiles("app.nhs");
  let failed = 0;
  for (const path of paths) {
    let result;
    try {
      result = compileFile(path, { cellCount });
    } catch (error) {
      if (!(error instanceof CompileError || error instanceof PackageError)) throw error;
      const where = error instanceof CompileError && error.line ? `:${error.line}${error.col ? `:${error.col}` : ""}` : "";
      console.log(`FAIL ${shown(path)}${where}: ${error instanceof CompileError ? error.reason : error.message}`);
      failed += 1;
      continue;
    }
    const { pkg, report } = result;
    if (options.write) writeFileSync(join(dirname(path), "app.nha"), canonicalBytes(pkg));
    console.log(`  ok ${shown(path)}: ${report.nodes} nodes (${report.reused} shared), ~${report.estimatedUs}us, `
      + `${report.memoryBytes}B ring, needs ${report.minOs}`);
    for (const note of report.notes) console.log(`     note: line ${note.line}: ${note.message}`);
  }
  return failed ? 1 : 0;
}

// --- validate ---------------------------------------------------------------

/** @param {string[]} argv */
function cmdValidate(argv) {
  const { options, positional } = parseArgs(argv, { cells: "value" });
  const cellCount = intOption(options.cells);
  const paths = positional.length ? positional : appFiles("app.nha");
  if (paths.length === 0) {
    console.error("no packages found");
    return 1;
  }
  let failed = 0;
  for (const path of paths) {
    try {
      // Validated as the bytes on disk, since those are what get uploaded.
      const raw = readFileSync(path);
      const report = validatePackage(JSON.parse(raw.toString("utf8")), raw, { cellCount });
      console.log(`  ok ${shown(path)}: ${report.id} v${report.version} ${report.nodes} nodes, `
        + `~${report.estimatedUs}us, ${report.size}B, needs ${report.minOs}`);
    } catch (error) {
      console.log(`FAIL ${shown(path)}: ${error instanceof PackageError ? error.code : `unreadable: ${error instanceof Error ? error.message : error}`}`);
      failed += 1;
    }
  }
  return failed ? 1 : 0;
}

// --- simulate ---------------------------------------------------------------

/** @param {string[]} argv */
function cmdSimulate(argv) {
  const { options, positional } = parseArgs(argv, {
    rows: "value", cols: "value", events: "value", compare: "value", budget: "flag", press: "value",
  });
  const [packagePath, samplesPath] = positional;
  if (!packagePath || !samplesPath) throw new UsageError("simulate needs a package (.nha or .nhs) and a samples CSV");

  const pkg = packagePath.endsWith(".nhs")
    ? compileFile(packagePath).pkg
    : JSON.parse(readFileSync(packagePath, "utf8"));
  const frames = parseSamplesCsv(readFileSync(samplesPath, "utf8"), {
    rows: intOption(options.rows), cols: intOption(options.cols),
  });
  if (frames.length === 0) {
    console.error("no frames in the sample file");
    return 1;
  }

  // A recording holds no button presses, so they are given by time: each is
  // seen by the first frame at or after it, as a real press is.
  const presses = typeof options.press === "string"
    ? options.press.split(",").map((text) => Number(text.trim())).filter(Number.isFinite).sort((a, b) => a - b)
    : [];
  const simulator = new Simulator(pkg, { appName: String(pkg.name ?? pkg.manifest?.id ?? "flow") });
  if (presses.length && !simulator.hearsButton) console.error("note: the package does not declare button, so the presses are not delivered");
  let nextPress = 0;
  for (const frame of frames) {
    while (nextPress < presses.length && presses[nextPress] <= frame.timestampMs) {
      simulator.pressButton();
      nextPress += 1;
    }
    simulator.step(frame);
  }

  if (options.budget) {
    const cells = frames[0].values.length;
    console.log(`cells: ${cells}   estimated: ${graphCostUs(pkg.nodes, cells)}us`);
    pkg.nodes.forEach((/** @type {Record<string, any>} */ node, /** @type {number} */ index) => {
      const op = OPS[String(node.op)];
      const cost = op.sweep ? op.nsPerCell * cells : op.nsFlat;
      console.log(`  [${String(index).padStart(2)}] ${String(node.op).padEnd(14)} ~${(cost / 1000).toFixed(1).padStart(6)}us`);
    });
  }

  const { rows, cols } = frames[0];
  console.log(`frames: ${frames.length} (${rows}x${cols})   events: ${simulator.events.length}   led changes: ${simulator.ledChanges.length}`);
  for (const event of simulator.events) {
    const value = event.value === null ? "" : ` value=${event.value.toFixed(3)}`;
    console.log(`  #${String(event.seq).padEnd(4)} f${String(event.frameSeq).padEnd(8)} ${event.app}.${event.event} ${event.detail}${value}`);
  }

  if (simulator.canDisplay) {
    // Bars as text: the brackets are the outline, the fill scaled to them.
    console.log(`oled after the last frame (${OLED_COLS} columns):`);
    for (const row of simulator.oledRows()) {
      if (!row) {
        console.log(`  |${" ".repeat(OLED_COLS)}|`);
      } else if (row.kind === "text") {
        console.log(`  |${row.text}|`);
      } else if (row.bar) {
        const head = row.label ? `${row.label} ` : "";
        const inner = OLED_COLS - head.length - 2;
        const filled = Math.round((row.bar.fillPx / Math.max(1, row.bar.width - 2)) * inner);
        console.log(`  |${head}[${"#".repeat(filled)}${" ".repeat(inner - filled)}]|`);
      }
    }
  }

  if (simulator.canDriveExtLed) {
    // One letter per pixel, for the largest strip: v1.0.F shows the first 3.
    const letter = (/** @type {number[]} */ [r, g, b]) => {
      if (!r && !g && !b) return ".";
      if (r && g && b) return "W";
      if (b) return "B";
      return r > g ? "R" : g > r ? "G" : "Y";
    };
    const strip = /** @type {number[][]} */ (simulator.extLeds(MAX_EXT_LEDS));
    console.log(`external leds after the last frame: [${strip.map(letter).join("")}]`);
  }

  if (typeof options.events === "string") {
    writeFileSync(options.events, formatEventsCsv(simulator.events));
    console.log(`wrote ${options.events}`);
  }
  if (typeof options.compare === "string") {
    const recorded = parseEventsCsv(readFileSync(options.compare, "utf8"));
    const names = new Set(simulator.events.map((event) => event.event));
    for (const node of pkg.nodes) if (node.event) names.add(String(node.event));
    const diff = compareEvents(simulator.events, recorded, { events: names, toleranceFrames: 1 });
    console.log(`compare: ${diff.matched.length} matched, ${diff.onlySimulated.length} only simulated, `
      + `${diff.onlyRecorded.length} only recorded`);
    for (const event of diff.onlySimulated) console.log(`  + f${event.frameSeq} ${event.event} ${event.detail}`);
    for (const event of diff.onlyRecorded) console.log(`  - f${event.frameSeq} ${event.event} ${event.detail}`);
    return diff.onlySimulated.length || diff.onlyRecorded.length ? 2 : 0;
  }
  return 0;
}

// --- build-index ------------------------------------------------------------

/**
 * Accept a plain string or a per-locale map; always emit a full map.
 * @param {unknown} value
 * @param {string} fallback
 */
function localised(value, fallback) {
  if (value && typeof value === "object") {
    const map = /** @type {Record<string, unknown>} */ (value);
    const base = String(map.en || fallback);
    return Object.fromEntries(LOCALES.map((locale) => [locale, String(map[locale] || base)]));
  }
  const text = String(value || fallback);
  return Object.fromEntries(LOCALES.map((locale) => [locale, text]));
}

/** @param {string} appDir */
function buildEntry(appDir) {
  const readoutPath = join(appDir, "readout.json");
  // A readout has no graph to compile: the JSON IS the source, and it is what
  // a reviewer reads. Otherwise the .nhs is the artifact under review and
  // app.nha is derived from it, never hand-edited.
  const doc = existsSync(readoutPath)
    ? JSON.parse(readFileSync(readoutPath, "utf8"))
    : compileFile(join(appDir, "app.nhs")).pkg;
  const raw = canonicalBytes(doc);
  const report = validatePackage(doc, raw);
  writeFileSync(join(appDir, "app.nha"), raw);

  const manifest = doc.manifest;
  const appId = manifest.id;
  const version = manifest.version;
  if (appId !== basename(appDir)) {
    throw new Error(`${appDir}: manifest id '${appId}' does not match the directory name`);
  }

  const metaPath = join(appDir, "meta.json");
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};

  const distDir = join(ROOT, "dist", appId);
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, `${appId}-${version}.nha`), raw);
  writeFileSync(join(distDir, `${appId}-latest.nha`), raw);

  /** @type {Record<string, string>} */
  const readmeUrls = {};
  for (const locale of LOCALES) {
    const name = locale === "en" ? "README.md" : `README.${locale}.md`;
    if (existsSync(join(appDir, name))) readmeUrls[locale] = `${RAW_BASE}/apps/${appId}/${name}`;
  }

  /** @type {Record<string, unknown>} */
  const entry = {
    id: appId,
    name: localised(meta.name, manifest.name),
    summary: localised(meta.summary, manifest.summary),
    version,
    author: manifest.author,
    license: meta.license ?? "MPL-2.0",
    category: manifest.category ?? "other",
    capabilities: manifest.capabilities ?? [],
    kind: report.kind,
    min_os: report.minOs,
    nodes: report.nodes,
    estimated_us: report.estimatedUs,
    memory_bytes: report.memoryBytes,
    device_path: `apps/${appId}.nha`,
    package: {
      url: `${RAW_BASE}/dist/${appId}/${appId}-${version}.nha`,
      sha256: sha256(raw),
      size: raw.length,
    },
  };
  if (existsSync(join(appDir, "icon.svg"))) entry.icon_url = `${RAW_BASE}/apps/${appId}/icon.svg`;
  if (Object.keys(readmeUrls).length) entry.readme_url = readmeUrls;
  if (meta.homepage) entry.homepage = meta.homepage;
  return entry;
}

/** @param {string[]} argv */
function cmdBuildIndex(argv) {
  const { options } = parseArgs(argv, { check: "flag" });
  const appDirs = readdirSync(APPS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(APPS, entry.name))
    .filter((dir) => existsSync(join(dir, "app.nhs")) || existsSync(join(dir, "readout.json")))
    .sort();
  const entries = appDirs.map(buildEntry);
  const ids = entries.map((entry) => String(entry.id));
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length) throw new Error(`duplicate app ids: ${duplicates.sort().join(", ")}`);

  /** @type {Record<string, unknown>} */
  const index = {
    schema: 1,
    product: "NHOS App Library",
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    cell_count: DEFAULT_CELL_COUNT,
    apps: entries,
  };
  const target = join(ROOT, "index.json");
  const previous = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : {};
  // generated_at changes on every run; comparing without it is what makes
  // --check mean "the content drifted", not "time passed".
  const withoutTime = (/** @type {Record<string, unknown>} */ doc) => canonicalText({ ...doc, generated_at: undefined });
  if (withoutTime(previous) === withoutTime(index)) index.generated_at = previous.generated_at ?? index.generated_at;
  writeFileSync(target, `${JSON.stringify(index, null, 2)}\n`);

  console.log(`indexed ${entries.length} app(s)`);
  for (const entry of entries) {
    const pkg = /** @type {{size: number}} */ (entry.package);
    const shape = entry.kind === "flow"
      ? `${String(entry.nodes).padStart(2)} nodes  ~${String(entry.estimated_us).padStart(4)}us`
      : "     readout     ";
    console.log(`  ${String(entry.id).padEnd(12)} v${String(entry.version).padEnd(8)} ${shape}  ${String(pkg.size).padStart(5)}B  ${entry.min_os}`);
  }

  if (options.check) {
    const dirty = execFileSync("git", ["status", "--porcelain", "index.json", "dist", "apps"], { cwd: ROOT, encoding: "utf8" }).trim();
    if (dirty) {
      console.log("\nindex.json / dist / apps are out of date; run `node sdk/bin/nhos.mjs build-index` and commit:");
      console.log(dirty);
      return 1;
    }
  }
  return 0;
}

// --- check-versions ---------------------------------------------------------

/** @param {string[]} args */
function git(...args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/**
 * @param {string} ref
 * @param {string} path
 */
function versionAt(ref, path) {
  const blob = git("show", `${ref}:${path}`);
  if (!blob.trim()) return null;
  try {
    return JSON.parse(blob).manifest.version;
  } catch {
    return null; // a malformed base is not this check's problem
  }
}

/**
 * Refuse a changed package that reuses its version number: the Desktop caches
 * by `<id>-<version>.nha` and verifies the sha256 in index.json, so editing a
 * published version in place leaves devices and clients disagreeing about
 * what that version is, with no way to notice.
 * @param {string[]} argv
 */
function cmdCheckVersions(argv) {
  const { options } = parseArgs(argv, { base: "value" });
  const base = typeof options.base === "string" ? options.base : "origin/main";
  const changed = git("diff", "--name-only", `${base}...HEAD`).split("\n")
    .filter((line) => line.startsWith("apps/") && line.endsWith("/app.nha"));
  /** @type {string[]} */
  const failures = [];
  for (const path of changed) {
    const before = versionAt(base, path);
    const after = JSON.parse(readFileSync(join(ROOT, path), "utf8")).manifest.version;
    if (before === null) console.log(`  new ${path}: v${after}`);
    else if (before === after) failures.push(`${path}: still v${after}; published versions are immutable`);
    else console.log(`  bump ${path}: v${before} -> v${after}`);
  }
  if (failures.length) {
    console.error(`\n${failures.join("\n")}`);
    return 1;
  }
  if (changed.length === 0) console.log("  no package changes");
  return 0;
}

// --- main -------------------------------------------------------------------

const COMMANDS = {
  compile: cmdCompile,
  validate: cmdValidate,
  simulate: cmdSimulate,
  "build-index": cmdBuildIndex,
  "check-versions": cmdCheckVersions,
};

const USAGE = `  node sdk/bin/nhos.mjs compile  [app.nhs ...] [--write] [--cells N]
  node sdk/bin/nhos.mjs validate [app.nha ...] [--cells N]
  node sdk/bin/nhos.mjs simulate <app.nha|app.nhs> <samples.csv> [--rows R --cols C]
                                 [--events out.events.csv] [--compare recorded.events.csv] [--budget]
                                 [--press ms,ms,...]
  node sdk/bin/nhos.mjs build-index [--check]
  node sdk/bin/nhos.mjs check-versions [--base origin/main]`;

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const handler = COMMANDS[/** @type {keyof typeof COMMANDS} */ (command)];
  if (!handler) {
    console.error(`usage:\n${USAGE}`);
    return command === undefined || command === "--help" || command === "help" ? 0 : 64;
  }
  try {
    return handler(rest);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${command}: ${error.message}\n\nusage:\n${USAGE}`);
      return 64;
    }
    throw error;
  }
}

process.exitCode = main();
