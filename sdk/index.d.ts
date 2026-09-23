// Types for @nhos/app-sdk. The implementation is plain JavaScript in lib/;
// these declarations describe its public surface for TypeScript callers.

// --- op set ------------------------------------------------------------------

export const MAX_NODES: number;
export const LEGACY_MAX_NODES: number;
export const MIN_OS_FOR_LARGE_GRAPHS: string;
export const MAX_PACKAGE_BYTES: number;
export const MAX_EVENT_NAME: number;
export const MAX_WINDOW: number;
export const WINDOW_POOL: number;
export const DEFAULT_BUDGET_US: number;
export const GOVERNOR_CEILING_PERMILLE: number;
export const MAX_SLOTS: number;
export const MAX_DEBOUNCE_MS: number;
export const MAX_REGION_INDEX: number;
export const MAX_APP_ID: number;
export const APP_ID_RE: RegExp;
export const RESERVED_APP_IDS: ReadonlySet<string>;
export const DEFAULT_CELL_COUNT: number;
export const CELL_OP_NS_PER_CELL: number;
export const SCALAR_OP_NS: number;
export const FEATURES_NS_PER_CELL: number;
export const PRESSURE_ACTIVE_THRESHOLD: number;
export const PRESSURE_FULL_SCALE: number;
export const CAPABILITIES: Readonly<Record<string, number>>;
export const FEATURE_FIELDS: readonly string[];
export const LED_COLOURS: Readonly<Record<string, readonly [number, number, number]>>;
export const FLOAT_FIELDS: readonly string[];
export const OLED_ROWS: number;
export const OLED_COLS: number;
export const OLED_ROW_PX: number;
export const OLED_WIDTH_PX: number;
export const MAX_OLED_LABEL: number;
export const MAX_OLED_DIGITS: number;
export const MAX_PENDING_PRESSES: number;
export const OLED_LABEL_RE: RegExp;

export interface OpSpec {
  readonly name: string;
  /** how many earlier nodes this op consumes */
  readonly inputs: number;
  /** true when the op sweeps the whole matrix (cost scales with cell count) */
  readonly sweep: boolean;
  readonly nsPerCell: number;
  readonly nsFlat: number;
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly windowKey: string | null;
  /** introduced in this OS version */
  readonly since: string;
  readonly boolean: boolean;
  /** one line for a reference table */
  readonly summary: string;
}

export const OPS: Readonly<Record<string, OpSpec>>;
export const V1_0_OPS: ReadonlySet<string>;
export function opSpec(name: unknown): OpSpec;
export function nodeCostNs(node: { op?: unknown }, cellCount: number): number;
export function graphCostUs(nodes: ReadonlyArray<{ op?: unknown }>, cellCount: number): number;
export function graphMemoryBytes(nodes: ReadonlyArray<Record<string, unknown>>): number;
export function windowFloats(nodes: ReadonlyArray<Record<string, unknown>>): number;
export function appShareUs(fps: number, runningApps: number): number;
export function minOsFor(nodes: ReadonlyArray<{ op?: unknown }>): string;
export function capabilitiesMask(names: readonly string[]): number;
export function compareVersions(a: string, b: string): number;

export namespace readoutset {
  const ALLOWED_SOURCES: ReadonlySet<string>;
  const SECTION_KINDS: ReadonlySet<string>;
  const FORMATS: ReadonlySet<string>;
  const MAX_SOURCES: number;
  const MAX_SECTIONS: number;
  const MAX_COLUMNS: number;
  const MAX_STATS: number;
  const MIN_REFRESH_MS: number;
  const MAX_REFRESH_MS: number;
}

// --- packages ------------------------------------------------------------------

export interface FlowNode {
  op: string;
  in?: number | number[];
  [field: string]: unknown;
}

export interface Manifest {
  id: string;
  name: string;
  version: string;
  author: string;
  summary: string;
  category?: string;
  icon?: string;
  min_os?: string;
  capabilities?: string[];
  budget_us?: number;
  [field: string]: unknown;
}

export interface FlowPackage {
  nhapp: 1;
  kind: "flow";
  name: string;
  manifest: Manifest;
  nodes: FlowNode[];
}

export interface ReadoutPackage {
  nhapp: 1;
  kind: "readout";
  manifest: Manifest;
  readout: Record<string, unknown>;
}

export type Package = FlowPackage | ReadoutPackage;

export function pythonFloatRepr(value: number): string;
export function canonicalText(doc: unknown): string;
export function canonicalBytes(doc: unknown): Uint8Array;

// --- compiler ------------------------------------------------------------------

export class CompileError extends Error {
  readonly reason: string;
  /** 1-based; null when the error applies to the whole program */
  readonly line: number | null;
  readonly col: number | null;
  readonly endCol: number | null;
}

export interface Token {
  kind: "string" | "semver" | "number" | "range" | "name" | "op" | "eof";
  text: string;
  line: number;
  col: number;
  endCol: number;
}

export function tokenize(source: string): Token[];

export const LANGUAGE: {
  readonly statements: readonly string[];
  readonly keywords: readonly string[];
  readonly headerFields: readonly string[];
  readonly functions: readonly string[];
  readonly featureFields: readonly string[];
  readonly colours: readonly string[];
};

export interface Region {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
  line: number;
}

export interface Note {
  message: string;
  line: number;
  col: number;
}

export interface CompileReport {
  nodes: number;
  /** nodes saved by sharing identical subexpressions */
  reused: number;
  /** worst-case cost per frame at `cellCount` */
  estimatedUs: number;
  cellCount: number;
  memoryBytes: number;
  windowFloats: number;
  minOs: string;
  notes: Note[];
  /** most expensive first */
  breakdown: { index: number; op: string; us: number }[];
  /** source line that produced each node */
  nodeLines: number[];
  regions: Record<string, Region>;
  /** signal name -> node index */
  signals: Record<string, number>;
  /** event name -> boolean node index */
  events: Record<string, number>;
}

export function compileSource(source: string, options?: { cellCount?: number }): { package: FlowPackage; report: CompileReport };

// --- validator -----------------------------------------------------------------

export class PackageError extends Error {
  /** `reason:detail`, using the firmware's own spelling where one exists */
  readonly code: string;
  /** index of the offending node, when there is one */
  readonly node: number | null;
}

export interface ValidateOptions {
  /** cells on the target board (default 225, the largest) */
  cellCount?: number;
}

export interface PackageReport {
  kind: "flow" | "readout";
  id: string;
  version: string;
  /** canonical bytes */
  size: number;
  nodes: number;
  estimatedUs: number;
  memoryBytes: number;
  minOs: string;
  budgetUs?: number;
  cellCount?: number;
  windowFloats?: number;
  sources?: number;
  sections?: number;
  refreshMs?: number;
}

export function validateManifest(manifest: Record<string, unknown>): void;
export function validateGraph(nodes: unknown, manifest: Record<string, unknown>, options?: ValidateOptions): {
  nodes: number;
  estimatedUs: number;
  budgetUs: number;
  cellCount: number;
  memoryBytes: number;
  windowFloats: number;
  minOs: string;
};
export function validateReadout(readout: unknown): { sources: number; sections: number; refreshMs: number };
export function validatePackage(doc: unknown, raw?: Uint8Array | null, options?: ValidateOptions): PackageReport;

// --- simulator -----------------------------------------------------------------

export interface Frame {
  /** frame sequence number (the device's frame_seq) */
  seq: number;
  timestampMs: number;
  /** row-major cell values */
  values: ArrayLike<number>;
  rows: number;
  cols: number;
}

export interface SimEvent {
  seq: number;
  frameSeq: number;
  timestampMs: number;
  app: string;
  event: string;
  /** rise/fall, or the formatted value for emit_value */
  detail: string;
  value: number | null;
}

export interface LedChange {
  frameSeq: number;
  timestampMs: number;
  colour: string;
  rgb: readonly [number, number, number];
  node: number;
}

export interface OledBarGeometry {
  /** left edge of the outline, in pixels */
  x0: number;
  /** outline width, reaching the right edge of the panel */
  width: number;
  /** filled pixels inside the outline, 0..width-2 */
  fillPx: number;
}

/** One OLED row as the device's "app" page draws it. */
export interface OledRow {
  kind: "text" | "bar";
  label: string;
  value: number;
  /** the node that drew it */
  node: number;
  /** the whole row, for a text row (OLED_COLS characters) */
  text?: string;
  bar?: OledBarGeometry;
}

export interface NodeValue {
  op: string;
  result: number;
  bool: boolean;
  skipped: boolean;
}

export class Simulator {
  constructor(pkg: Record<string, any>, options?: { appName?: string });
  readonly nodes: FlowNode[];
  readonly appName: string;
  readonly canEmit: boolean;
  readonly canDriveLed: boolean;
  readonly canDisplay: boolean;
  /** true when the package declares `button`, so presses reach it */
  readonly hearsButton: boolean;
  readonly events: SimEvent[];
  readonly ledChanges: LedChange[];
  /** the LED colour the graph is driving now */
  readonly led: readonly [number, number, number];
  readonly features: Record<string, number>;
  readonly frames: number;
  readonly degraded: boolean;
  readonly degradations: number;
  budgetLoad: number;
  graceLeft: number;
  /** forget all state, as a fresh load on the device would */
  reset(): void;
  /** latch budget pressure, as a Budget event does on the device */
  setBudget(load: number, graceLeft: number): void;
  /** evaluate one frame; returns the events it produced */
  step(frame: Frame): SimEvent[];
  run(frames: Iterable<Frame>): this;
  nodeValues(): NodeValue[];
  /** a short press of the action button, true for one frame, then false for one */
  pressButton(): void;
  /** the OLED rows the last frame drew, null where it drew nothing */
  oledRows(): (OledRow | null)[];
}

export function computeFeatures(frame: Frame): Record<string, number>;
export function formatOledValue(value: number, digits: number): string;
export function formatOledTextLine(label: string, value: number, digits: number): string;
export function oledBarGeometry(labelLen: number, value: number, lo: number, hi: number): OledBarGeometry;
export function simulate(pkg: Record<string, any>, frames: Iterable<Frame>, options?: { appName?: string }): Simulator;

// --- recordings ----------------------------------------------------------------

export const EVENT_COLUMNS: readonly string[];
export function parseCsvRows(text: string): string[][];
export function inferShape(count: number, rows?: number, cols?: number): { rows: number; cols: number };
export function parseSamplesCsv(text: string, shape?: { rows?: number; cols?: number }): Frame[];
export function parseEventsCsv(text: string): SimEvent[];
export function formatEventsCsv(events: readonly SimEvent[]): string;

export interface EventComparison {
  matched: { frameSeq: number; event: string; detail: string }[];
  /** fired offline, not on the device */
  onlySimulated: SimEvent[];
  /** fired on the device, not offline */
  onlyRecorded: SimEvent[];
}

export function compareEvents(
  simulated: readonly SimEvent[],
  recorded: readonly SimEvent[],
  options?: { toleranceFrames?: number; events?: ReadonlySet<string> },
): EventComparison;

// --- editor analysis -----------------------------------------------------------

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  /** 1-based, null when it applies to the whole app */
  line: number | null;
  col: number | null;
  endCol: number | null;
  /** validator code, for errors the device would report */
  code: string | null;
}

export interface Analysis {
  /** true when the package would be accepted by the device */
  ok: boolean;
  kind: "flow" | "readout";
  package: Record<string, any> | null;
  /** canonical bytes, when ok */
  bytes: Uint8Array | null;
  /** compile report (flow only) */
  report: CompileReport | null;
  validation: PackageReport | null;
  diagnostics: Diagnostic[];
}

export function analyzeFlow(source: string, options?: { cellCount?: number }): Analysis;
export function analyzeReadout(source: string): Analysis;
export function describeCode(code: string): string;
