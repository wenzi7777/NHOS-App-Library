// @ts-check
/**
 * The Desktop's recording formats.
 *
 * A recording is `<HHMMSS>.csv` with `timestamp_ms, P1..Pn, ..., frame_seq`,
 * and the app events the device reported while it ran sit beside it in
 * `<HHMMSS>.events.csv` with `seq, frame_seq, timestamp_ms, app, event, edge,
 * value`. A simulated run is written in that same sidecar shape, so a
 * simulation and the real thing can be compared row by row on frame_seq.
 *
 * The matrix shape is NOT stored in a recording -- it comes from the board
 * profile -- so a caller that knows it should pass rows/cols. Without them a
 * square cell count is read as N x N and anything else as one row, rather
 * than guessing a layout that would silently move every region.
 */

import { pythonFloatRepr } from "./canonical.mjs";

const PRESSURE_COLUMN = /^P(\d+)$/i;

export const EVENT_COLUMNS = Object.freeze(["seq", "frame_seq", "timestamp_ms", "app", "event", "edge", "value"]);

/**
 * RFC 4180 rows: quoted fields, doubled quotes, CRLF or LF.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsvRows(text) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** @param {string|undefined} value */
function toNumber(value) {
  const number = Number(value);
  return value === undefined || value === "" || !Number.isFinite(number) ? 0 : number;
}

/**
 * @param {number} count
 * @param {number|undefined} rows
 * @param {number|undefined} cols
 */
export function inferShape(count, rows, cols) {
  if (rows && cols) return { rows, cols };
  const side = Math.floor(Math.sqrt(count));
  if (side * side === count) return { rows: side, cols: side };
  return { rows: 1, cols: count };
}

/**
 * Frames from a recording CSV.
 * @param {string} text
 * @param {{rows?: number, cols?: number}} [shape]
 * @returns {import("./simulate.mjs").Frame[]}
 */
export function parseSamplesCsv(text, shape = {}) {
  const [header, ...body] = parseCsvRows(text);
  if (!header) throw new Error("no header row");
  const pressure = header
    .map((name, index) => ({ index, match: PRESSURE_COLUMN.exec(name.trim()) }))
    .filter((column) => column.match)
    .sort((a, b) => Number(a.match?.[1]) - Number(b.match?.[1]))
    .map((column) => column.index);
  if (pressure.length === 0) throw new Error("no P1..Pn columns found");
  // Recordings from before v0.9 name the column "Timestamp" (still epoch ms)
  // and have no frame_seq; they are read the same way, numbered by row.
  const tsIndex = header.indexOf("timestamp_ms") >= 0
    ? header.indexOf("timestamp_ms")
    : header.findIndex((name) => name.trim().toLowerCase() === "timestamp");
  const seqIndex = header.indexOf("frame_seq");
  const { rows, cols } = inferShape(pressure.length, shape.rows, shape.cols);

  return body.map((row, index) => ({
    seq: seqIndex >= 0 ? Math.trunc(toNumber(row[seqIndex])) : index,
    timestampMs: Math.trunc(toNumber(tsIndex >= 0 ? row[tsIndex] : undefined)),
    values: Float32Array.from(pressure, (column) => toNumber(row[column])),
    rows,
    cols,
  }));
}

/**
 * Events from an `.events.csv` sidecar (or a simulated run written as one).
 * @param {string} text
 * @returns {import("./simulate.mjs").SimEvent[]}
 */
export function parseEventsCsv(text) {
  const [header, ...body] = parseCsvRows(text);
  if (!header) return [];
  const at = Object.fromEntries(EVENT_COLUMNS.map((name) => [name, header.indexOf(name)]));
  return body.map((row) => {
    const value = at.value >= 0 ? row[at.value] : "";
    return {
      seq: Math.trunc(toNumber(row[at.seq])),
      frameSeq: Math.trunc(toNumber(row[at.frame_seq])),
      timestampMs: Math.trunc(toNumber(row[at.timestamp_ms])),
      app: row[at.app] ?? "",
      event: row[at.event] ?? "",
      detail: row[at.edge] ?? "",
      value: value === "" || value === undefined ? null : Number(value),
    };
  });
}

/** @param {string} value */
function csvField(value) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Write events in the Desktop's sidecar shape.
 * @param {readonly import("./simulate.mjs").SimEvent[]} events
 */
export function formatEventsCsv(events) {
  const lines = [EVENT_COLUMNS.join(",")];
  for (const event of events) {
    const value = event.value === null ? "" : pythonFloatRepr(Math.round(event.value * 1000) / 1000);
    lines.push([
      String(event.seq), String(event.frameSeq), String(event.timestampMs),
      csvField(event.app), csvField(event.event), csvField(event.detail), value,
    ].join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * @typedef {object} EventComparison
 * @property {{frameSeq: number, event: string, detail: string}[]} matched
 * @property {import("./simulate.mjs").SimEvent[]} onlySimulated fired offline, not on the device
 * @property {import("./simulate.mjs").SimEvent[]} onlyRecorded fired on the device, not offline
 */

/**
 * Line up simulated events against recorded ones by (frame_seq, event,
 * detail). The app name is ignored: the device records events under its slot
 * name ("flow1"), which a simulation cannot know.
 *
 * `detail` for emit_value is a formatted number, and float32 on both sides
 * should agree to three places; `toleranceFrames` allows a recorded event to
 * land a few frames off (a recording can drop frames the device evaluated).
 * @param {readonly import("./simulate.mjs").SimEvent[]} simulated
 * @param {readonly import("./simulate.mjs").SimEvent[]} recorded
 * @param {{toleranceFrames?: number, events?: ReadonlySet<string>}} [options]
 *   `events` restricts the comparison to these event names
 * @returns {EventComparison}
 */
export function compareEvents(simulated, recorded, options = {}) {
  const tolerance = options.toleranceFrames ?? 0;
  const wanted = options.events;
  const keep = (/** @type {import("./simulate.mjs").SimEvent} */ e) => !wanted || wanted.has(e.event);
  const pending = recorded.filter(keep).map((event) => ({ event, used: false }));
  /** @type {EventComparison} */
  const result = { matched: [], onlySimulated: [], onlyRecorded: [] };
  for (const sim of simulated.filter(keep)) {
    const hit = pending.find((entry) => !entry.used
      && entry.event.event === sim.event
      && entry.event.detail === sim.detail
      && Math.abs(entry.event.frameSeq - sim.frameSeq) <= tolerance);
    if (hit) {
      hit.used = true;
      result.matched.push({ frameSeq: sim.frameSeq, event: sim.event, detail: sim.detail });
    } else {
      result.onlySimulated.push(sim);
    }
  }
  result.onlyRecorded = pending.filter((entry) => !entry.used).map((entry) => entry.event);
  return result;
}
