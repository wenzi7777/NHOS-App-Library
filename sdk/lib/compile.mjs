// @ts-check
/**
 * Compile a .nhs source into a .nha package.
 *
 * Hand-writing the node array means hand-doing three compiler jobs:
 * topological ordering (a node may only reference earlier ones, so inserting
 * an intermediate value renumbers every `in`), common-subexpression
 * elimination (12 nodes is a brutal budget, and a value used twice would
 * otherwise cost two of them), and cost estimation (otherwise you find out by
 * uploading).
 *
 * So the device format stays dumb and verifiable, and the ergonomics live
 * here -- the same split as assembly and a compiler.
 *
 * Grammar
 * -------
 *     app <id> { name "..."  version 1.2.0  author me  summary "..." }
 *     region <name> = rows <a>..<b>, cols <c>..<d>
 *     signal <name> = <expr>
 *     event  <name> when <expr> <cmp> <number> [hyst <number>] [for <n>ms]
 *     emit   <name> value <expr> on rise(<event>)
 *     led    <colour> when <event>
 *     show   <row> "<label>" <expr> [digits <n>]
 *     bar    <row> "<label>" <expr> range <lo>..<hi>
 *     gate (<expr> <cmp> <number> ...) { signal/event/emit/led/show/bar ... }
 */

import {
  DEFAULT_CELL_COUNT,
  FEATURE_FIELDS,
  LED_COLOURS,
  MAX_DEBOUNCE_MS,
  MAX_EVENT_NAME,
  MAX_NODES,
  MAX_OLED_DIGITS,
  MAX_OLED_LABEL,
  MAX_REGION_INDEX,
  OLED_LABEL_RE,
  OLED_ROWS,
  graphCostUs,
  graphMemoryBytes,
  minOsFor,
  windowFloats,
} from "./opset.mjs";

/** An error at a place in the source. `line`/`col` are 1-based; either may be null. */
export class CompileError extends Error {
  /**
   * @param {string} reason
   * @param {number|null} [line]
   * @param {number|null} [col]
   * @param {number|null} [endCol]
   */
  constructor(reason, line = null, col = null, endCol = null) {
    super(line ? `line ${line}: ${reason}` : reason);
    this.name = "CompileError";
    this.reason = reason;
    this.line = line;
    this.col = col;
    this.endCol = endCol;
  }
}

// --- lexer -----------------------------------------------------------------

/**
 * @typedef {object} Token
 * @property {string} kind space|comment|string|semver|number|range|name|op|eof
 * @property {string} text
 * @property {number} line 1-based
 * @property {number} col 1-based column of the first character
 * @property {number} endCol 1-based column just past the last character
 */

const TOKEN_RE = new RegExp([
  String.raw`(?<space>\s+)`,
  String.raw`(?<comment>#[^\n]*)`,
  String.raw`(?<string>"(?:[^"\\]|\\.)*")`,
  String.raw`(?<semver>\d+\.\d+\.\d+)`,
  String.raw`(?<number>\d+\.\d+|\d+)`,
  String.raw`(?<range>\.\.)`,
  String.raw`(?<name>[A-Za-z_][A-Za-z0-9_.\-]*)`,
  String.raw`(?<op><=|>=|[{}(),=+\-*/%<>])`,
].join("|"), "y");

const TOKEN_KINDS = ["space", "comment", "string", "semver", "number", "range", "name", "op"];

/**
 * @param {string} source
 * @returns {Token[]}
 */
export function tokenize(source) {
  /** @type {Token[]} */
  const tokens = [];
  let line = 1;
  let lineStart = 0;
  let pos = 0;
  while (pos < source.length) {
    TOKEN_RE.lastIndex = pos;
    const match = TOKEN_RE.exec(source);
    const col = pos - lineStart + 1;
    if (!match || !match.groups) {
      throw new CompileError(`unexpected character ${JSON.stringify(source[pos])}`, line, col, col + 1);
    }
    const groups = match.groups;
    const kind = TOKEN_KINDS.find((name) => groups[name] !== undefined) ?? "op";
    const text = match[0];
    if (kind !== "space" && kind !== "comment") {
      tokens.push({ kind, text, line, col, endCol: col + text.length });
    }
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === "\n") {
        line += 1;
        lineStart = pos + i + 1;
      }
    }
    pos += text.length;
  }
  const col = pos - lineStart + 1;
  tokens.push({ kind: "eof", text: "", line, col, endCol: col });
  return tokens;
}

// --- node builder ----------------------------------------------------------

/** @typedef {Record<string, unknown> & {op: string}} FlowNode */

/** Emits nodes, interning identical ones so a shared value costs one slot. */
class Builder {
  constructor() {
    /** @type {FlowNode[]} */
    this.nodes = [];
    /** Source line of the statement that first produced each node. */
    /** @type {number[]} */
    this.lines = [];
    /** @type {Map<string, number>} */
    this.intern = new Map();
    this.reused = 0;
    this.line = 0;
  }

  /**
   * @param {string} op
   * @param {number[]} inputs
   * @param {Record<string, unknown>} params
   * @returns {FlowNode}
   */
  static make(op, inputs, params) {
    /** @type {FlowNode} */
    const node = { op };
    if (inputs.length === 1) node.in = inputs[0];
    else if (inputs.length > 1) node.in = [...inputs];
    Object.assign(node, params);
    return node;
  }

  /**
   * Emit without interning, for a node whose fields are patched later.
   * @param {string} op
   * @param {number[]} [inputs]
   * @param {Record<string, unknown>} [params]
   */
  emitUnique(op, inputs = [], params = {}) {
    this.nodes.push(Builder.make(op, inputs, params));
    this.lines.push(this.line);
    return this.nodes.length - 1;
  }

  /**
   * @param {string} op
   * @param {number[]} [inputs]
   * @param {Record<string, unknown>} [params]
   */
  emit(op, inputs = [], params = {}) {
    const node = Builder.make(op, inputs, params);
    const key = internKey(node);
    const existing = this.intern.get(key);
    if (existing !== undefined) {
      this.reused += 1;
      return existing;
    }
    // Inputs were emitted first, so appending here always keeps every
    // reference pointing backwards.
    this.nodes.push(node);
    this.lines.push(this.line);
    const index = this.nodes.length - 1;
    this.intern.set(key, index);
    return index;
  }
}

/** @param {Record<string, unknown>} node */
function internKey(node) {
  return JSON.stringify(Object.keys(node).sort().map((key) => [key, node[key]]));
}

// --- parser ----------------------------------------------------------------

/** @type {Record<string, string>} */
const SWEEP_FUNCS = { total: "total", peak: "peak", arg_max: "arg_max", row_centroid: "row_centroid", col_centroid: "col_centroid" };
/** @type {Record<string, string>} */
const WINDOW_FUNCS = { mean: "mean", max_hold: "max_hold", integrate: "integrate" };
/** @type {Record<string, string>} */
const UNARY_FUNCS = { abs: "abs", delta: "delta", counter: "counter" };
/** @type {Record<string, string>} */
const BINARY_FUNCS = { min: "min", max: "max" };
/** @type {Record<string, string>} */
const NULLARY_FUNCS = { budget_load: "budget_load", grace_left: "grace_left" };
/** @type {Record<string, string>} */
const ARITH_OPS = { "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "mod" };

const HEADER_STRING_FIELDS = new Set(["name", "summary"]);
const HEADER_WORD_FIELDS = new Set(["version", "author", "category", "icon"]);
/** Functions whose arguments are bare names, not expressions. */
const NAME_ARG_FUNCS = new Set(["sum", "feature"]);

/** Every name the language gives meaning to, for an editor's completion list. */
export const LANGUAGE = Object.freeze({
  statements: ["app", "region", "signal", "event", "emit", "led", "show", "bar", "gate"],
  keywords: ["rows", "cols", "when", "hyst", "for", "ms", "value", "on", "rise", "digits", "range"],
  headerFields: [...HEADER_STRING_FIELDS, ...HEADER_WORD_FIELDS],
  functions: ["sum", "total", "peak", "active", "feature", "arg_max", "row_centroid", "col_centroid",
    "mean", "max_hold", "integrate", "delta", "abs", "counter", "min", "max", "clamp", "budget_load", "grace_left",
    "button"],
  featureFields: FEATURE_FIELDS,
  colours: Object.keys(LED_COLOURS),
});

/**
 * @typedef {object} Region
 * @property {number} r0
 * @property {number} c0
 * @property {number} r1
 * @property {number} c1
 * @property {number} line
 */

/**
 * @typedef {object} Note
 * @property {string} message
 * @property {number} line
 * @property {number} col
 */

class Parser {
  /** @param {Token[]} tokens */
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
    this.builder = new Builder();
    /** @type {Map<string, Region>} */
    this.regions = new Map();
    /** @type {Map<string, number>} */
    this.signals = new Map();
    /** event name -> boolean node index */
    /** @type {Map<string, number>} */
    this.events = new Map();
    /** @type {Record<string, unknown>} */
    this.manifest = {};
    this.appId = "";
    this.graphName = "";
    /** @type {Set<string>} */
    this.capabilities = new Set();
    /** @type {Note[]} */
    this.notes = [];
    this.notedDisplay = false;
  }

  // -- token helpers --
  get tok() {
    return this.tokens[this.pos];
  }

  take() {
    const token = this.tok;
    this.pos += 1;
    return token;
  }

  /**
   * @param {string} reason
   * @param {Token} [token]
   */
  fail(reason, token = this.tok) {
    return new CompileError(reason, token.line, token.col, token.endCol);
  }

  /** @param {string} text */
  expect(text) {
    if (this.tok.text !== text) throw this.fail(`expected '${text}', found ${describe(this.tok)}`);
    return this.take();
  }

  /** @param {string} kind */
  expectKind(kind) {
    if (this.tok.kind !== kind) throw this.fail(`expected ${kind}, found ${describe(this.tok)}`);
    return this.take();
  }

  /** @param {string} text */
  accept(text) {
    if (this.tok.text === text) {
      this.take();
      return true;
    }
    return false;
  }

  /** @param {string} what */
  expectInteger(what) {
    const token = this.expectKind("number");
    if (!/^\d+$/.test(token.text)) throw this.fail(`${what} must be a whole number, found '${token.text}'`, token);
    return { value: Number.parseInt(token.text, 10), token };
  }

  // -- grammar --
  parse() {
    this.parseHeader();
    while (this.tok.kind !== "eof") {
      this.builder.line = this.tok.line;
      const keyword = this.tok.text;
      if (keyword === "region") this.parseRegion();
      else if (keyword === "signal") this.parseSignal();
      else if (keyword === "event") this.parseEvent();
      else if (keyword === "emit") this.parseEmit();
      else if (keyword === "led") this.parseLed();
      else if (keyword === "show") this.parseShow();
      else if (keyword === "bar") this.parseBar();
      else if (keyword === "gate") this.parseGate();
      else throw this.fail(`unknown statement '${keyword}'`);
    }
    return this.finish();
  }

  parseHeader() {
    this.expect("app");
    this.appId = this.expectKind("name").text;
    this.graphName = this.appId;
    this.expect("{");
    while (!this.accept("}")) {
      const keyToken = this.expectKind("name");
      const key = keyToken.text;
      if (HEADER_STRING_FIELDS.has(key)) {
        const raw = this.expectKind("string");
        try {
          this.manifest[key] = JSON.parse(raw.text);
        } catch {
          throw this.fail(`invalid string ${raw.text}`, raw);
        }
      } else if (HEADER_WORD_FIELDS.has(key)) {
        const token = this.take();
        if (token.kind === "eof") throw this.fail(`missing value for '${key}'`, token);
        this.manifest[key] = token.text.replace(/^"+|"+$/g, "");
      } else {
        throw this.fail(`unknown app field '${key}'`, keyToken);
      }
    }
    this.manifest.id = this.appId;
  }

  parseRegion() {
    const start = this.expect("region");
    const nameToken = this.expectKind("name");
    const name = nameToken.text;
    this.expect("=");
    this.expect("rows");
    const r0 = this.expectInteger("a row index").value;
    this.expect("..");
    const r1 = this.expectInteger("a row index").value;
    this.expect(",");
    this.expect("cols");
    const c0 = this.expectInteger("a column index").value;
    this.expect("..");
    const c1 = this.expectInteger("a column index").value;
    if (r0 > r1 || c0 > c1) throw this.fail(`region '${name}' has an inverted range`, nameToken);
    if (Math.max(r0, r1, c0, c1) > MAX_REGION_INDEX) {
      throw this.fail(`region '${name}' exceeds index ${MAX_REGION_INDEX}`, nameToken);
    }
    this.regions.set(name, { r0, c0, r1, c1, line: start.line });
  }

  parseSignal() {
    this.expect("signal");
    const name = this.expectKind("name").text;
    this.expect("=");
    this.signals.set(name, this.parseExpr());
  }

  /** `<expr> <cmp> <number> [hyst <n>] [for <n>ms]` -> boolean node index. */
  parseCondition() {
    const first = this.tok;
    let valueNode = this.parseExpr();
    const comparison = this.take();
    if (![">", ">=", "<", "<="].includes(comparison.text)) {
      throw this.fail(`expected a comparison, found ${describe(comparison)}`, comparison);
    }
    let limit = Number(this.expectKind("number").text);

    let hysteresis = 0;
    if (this.accept("hyst")) hysteresis = Number(this.expectKind("number").text);

    if (comparison.text === "<" || comparison.text === "<=") {
      // threshold is `input >= value`, so flip the expression instead:
      // limit - expr >= 0  <=>  expr <= limit. Costs two extra nodes and
      // pulls the graph up to v1.1.0, which the report states.
      const limitNode = this.builder.emit("const", [], { value: limit });
      valueNode = this.builder.emit("sub", [limitNode, valueNode]);
      this.notes.push({
        message: `'${comparison.text}' compiled as a subtraction (2 extra nodes)`,
        line: first.line,
        col: comparison.col,
      });
      limit = 0;
    }

    /** @type {Record<string, unknown>} */
    const params = { value: limit };
    if (hysteresis) params.hysteresis = hysteresis;
    let node = this.builder.emit("threshold", [valueNode], params);

    if (this.accept("for")) {
      const { value: ms, token: msToken } = this.expectInteger("a debounce time");
      const unit = this.expectKind("name");
      if (unit.text !== "ms") throw this.fail(`expected 'ms', found '${unit.text}'`, unit);
      if (ms > MAX_DEBOUNCE_MS) throw this.fail(`debounce time exceeds ${MAX_DEBOUNCE_MS}ms`, msToken);
      node = this.builder.emit("debounce", [node], { ms });
    }
    return node;
  }

  /**
   * `gate (<condition>) { ... }` -- skip the block when the condition is false.
   *
   * The gate node is emitted BEFORE the block, and skips the nodes that follow
   * it, because data references only ever point backwards: by the time
   * evaluation reaches a gate, anything it referenced has already run. The
   * only work a gate can actually avoid is what comes after it.
   */
  parseGate() {
    this.expect("gate");
    this.expect("(");
    const condition = this.parseCondition();
    this.expect(")");
    const gateIndex = this.builder.emitUnique("gate", [condition, condition], { span: 0 });
    this.expect("{");
    while (!this.accept("}")) {
      this.builder.line = this.tok.line;
      const keyword = this.tok.text;
      if (keyword === "signal") this.parseSignal();
      else if (keyword === "event") this.parseEvent();
      else if (keyword === "emit") this.parseEmit();
      else if (keyword === "led") this.parseLed();
      else if (keyword === "show") this.parseShow();
      else if (keyword === "bar") this.parseBar();
      else if (this.tok.kind === "eof") throw this.fail("unterminated gate block: expected '}'");
      else throw this.fail(`'${keyword}' is not allowed inside a gate`);
    }
    const span = this.builder.nodes.length - gateIndex - 1;
    if (span === 0) throw this.fail("empty gate block", this.tokens[this.pos - 1]);
    this.builder.nodes[gateIndex].span = span;
  }

  parseEvent() {
    this.expect("event");
    const nameToken = this.expectKind("name");
    const name = nameToken.text;
    if (name.length > MAX_EVENT_NAME) {
      throw this.fail(`event name '${name}' exceeds ${MAX_EVENT_NAME} characters`, nameToken);
    }
    this.expect("when");
    const condition = this.parseCondition();
    this.events.set(name, condition);
    this.builder.emit("emit", [condition], { event: name });
    this.capabilities.add("emit_event");
  }

  parseEmit() {
    this.expect("emit");
    const nameToken = this.expectKind("name");
    const name = nameToken.text;
    if (name.length > MAX_EVENT_NAME) {
      throw this.fail(`event name '${name}' exceeds ${MAX_EVENT_NAME} characters`, nameToken);
    }
    this.expect("value");
    const value = this.parseExpr();
    this.expect("on");
    this.expect("rise");
    this.expect("(");
    const eventToken = this.expectKind("name");
    this.expect(")");
    const trigger = this.events.get(eventToken.text);
    if (trigger === undefined) throw this.fail(`unknown event '${eventToken.text}'`, eventToken);
    this.builder.emit("emit_value", [trigger, value], { event: name });
    this.capabilities.add("emit_event");
  }

  parseLed() {
    this.expect("led");
    const colourToken = this.take();
    const colour = colourToken.text.replace(/^"+|"+$/g, "");
    if (!Object.hasOwn(LED_COLOURS, colour)) {
      throw this.fail(`unknown colour '${colour}' (the device has ${Object.keys(LED_COLOURS).join(", ")})`, colourToken);
    }
    this.expect("when");
    const eventToken = this.expectKind("name");
    const trigger = this.events.get(eventToken.text);
    if (trigger === undefined) throw this.fail(`unknown event '${eventToken.text}'`, eventToken);
    this.builder.emit("led", [trigger], { rgb: colour });
    this.capabilities.add("drive_led");
  }

  /** `<row> "<label>"`, the part `show` and `bar` share. */
  parseOledTarget() {
    const keyword = this.take();
    const { value: row, token: rowToken } = this.expectInteger("an OLED row");
    if (row >= OLED_ROWS) throw this.fail(`the OLED has rows 0 to ${OLED_ROWS - 1}`, rowToken);
    const labelToken = this.expectKind("string");
    /** @type {string} */
    let label;
    try {
      label = JSON.parse(labelToken.text);
    } catch {
      throw this.fail(`invalid string ${labelToken.text}`, labelToken);
    }
    if (label.length > MAX_OLED_LABEL) {
      throw this.fail(`an OLED label is at most ${MAX_OLED_LABEL} characters`, labelToken);
    }
    if (!OLED_LABEL_RE.test(label)) {
      throw this.fail("an OLED label is printable ASCII only: the panel's font draws nothing else", labelToken);
    }
    if (!this.notedDisplay) {
      this.notedDisplay = true;
      this.notes.push({
        message: "shown only while the device's OLED page is set to 'app'",
        line: keyword.line,
        col: keyword.col,
      });
    }
    this.capabilities.add("display");
    return { row, label };
  }

  parseShow() {
    const { row, label } = this.parseOledTarget();
    const value = this.parseExpr();
    /** @type {Record<string, unknown>} */
    const params = { row, label };
    if (this.accept("digits")) {
      const { value: digits, token } = this.expectInteger("a number of decimals");
      if (digits > MAX_OLED_DIGITS) throw this.fail(`at most ${MAX_OLED_DIGITS} decimals`, token);
      if (digits) params.digits = digits;
    }
    this.builder.emit("oled_text", [value], params);
  }

  parseBar() {
    const { row, label } = this.parseOledTarget();
    const value = this.parseExpr();
    this.expect("range");
    const lo = this.signedNumber();
    this.expect("..");
    const hiToken = this.tok;
    const hi = this.signedNumber();
    if (!(hi > lo)) throw this.fail("a bar's range must go from low to high", hiToken);
    this.builder.emit("oled_bar", [value], { row, label, lo, hi });
  }

  /** A literal number, optionally negative. */
  signedNumber() {
    const negative = this.accept("-");
    const value = Number(this.expectKind("number").text);
    return negative ? -value : value;
  }

  // -- expressions --
  /** @returns {number} */
  parseExpr() {
    let node = this.parseTerm();
    while (this.tok.text === "+" || this.tok.text === "-") {
      const op = ARITH_OPS[this.take().text];
      node = this.builder.emit(op, [node, this.parseTerm()]);
    }
    return node;
  }

  /** @returns {number} */
  parseTerm() {
    let node = this.parseFactor();
    while (this.tok.text === "*" || this.tok.text === "/" || this.tok.text === "%") {
      const op = ARITH_OPS[this.take().text];
      node = this.builder.emit(op, [node, this.parseFactor()]);
    }
    return node;
  }

  /** @returns {number} */
  parseFactor() {
    const token = this.tok;
    if (token.text === "(" && token.kind === "op") {
      this.take();
      const node = this.parseExpr();
      this.expect(")");
      return node;
    }
    if (token.text === "-" && token.kind === "op") {
      this.take();
      const zero = this.builder.emit("const", [], { value: 0 });
      return this.builder.emit("sub", [zero, this.parseFactor()]);
    }
    if (token.kind === "number") {
      this.take();
      return this.builder.emit("const", [], { value: Number(token.text) });
    }
    if (token.kind === "name") {
      this.take();
      if (this.tok.text === "(") return this.parseCall(token);
      const signal = this.signals.get(token.text);
      if (signal !== undefined) return signal;
      // The lexer allows '-' and '.' inside names (for author names and
      // versions), so `l-r` is one unknown name, not a subtraction.
      const hint = /[-.]/.test(token.text) ? " (put spaces around '-' to subtract)" : "";
      throw this.fail(`unknown value '${token.text}'${hint}`, token);
    }
    throw this.fail(`unexpected ${describe(token)}`, token);
  }

  /**
   * @param {string} callee
   * @returns {(Token|number)[]}
   */
  parseArgs(callee) {
    this.expect("(");
    /** @type {(Token|number)[]} */
    const args = [];
    if (this.accept(")")) return args;
    for (;;) {
      // A bare region or feature-field name is a literal argument, not an
      // expression; anything else is parsed as one. A name followed by '(' is
      // always a call: `peak` is a feature field, but `mean(peak(), 60)`
      // means the peak() sweep.
      const isCall = this.tokens[this.pos + 1].text === "(";
      if (this.tok.kind === "name" && !isCall && (
        NAME_ARG_FUNCS.has(callee)
        || this.regions.has(this.tok.text)
        || FEATURE_FIELDS.includes(this.tok.text)
      )) {
        args.push(this.take());
      } else if (this.tok.kind === "number" && [",", ")"].includes(this.tokens[this.pos + 1].text)) {
        args.push(this.take());
      } else {
        args.push(this.parseExpr());
      }
      if (!this.accept(",")) break;
    }
    this.expect(")");
    return args;
  }

  /**
   * @param {Token} nameToken
   * @returns {number}
   */
  parseCall(nameToken) {
    const name = nameToken.text;
    const args = this.parseArgs(name);
    const fail = (/** @type {string} */ reason) => this.fail(reason, nameToken);
    const arity = (/** @type {number} */ expected) => {
      if (args.length !== expected) throw fail(`${name}() takes ${expected} argument(s)`);
    };

    if (name === "sum") {
      arity(1);
      const region = args[0];
      if (typeof region === "number" || !this.regions.has(region.text)) throw fail("sum() takes a region name");
      this.capabilities.add("read_matrix");
      const { r0, c0, r1, c1 } = /** @type {Region} */ (this.regions.get(region.text));
      return this.builder.emit("region_sum", [], { r0, c0, r1, c1 });
    }

    if (Object.hasOwn(SWEEP_FUNCS, name)) {
      arity(0);
      this.capabilities.add("read_matrix");
      return this.builder.emit(SWEEP_FUNCS[name]);
    }

    if (name === "active") {
      arity(1);
      this.capabilities.add("read_matrix");
      return this.builder.emit("active_cells", [], { value: this.literal(args[0], nameToken) });
    }

    if (name === "feature") {
      arity(1);
      const token = args[0];
      if (typeof token === "number" || !FEATURE_FIELDS.includes(token.text)) {
        throw fail(`feature() takes one of ${FEATURE_FIELDS.join(", ")}`);
      }
      this.capabilities.add("read_matrix");
      const features = this.builder.emit("features");
      return this.builder.emit("feature_get", [features], { field: token.text });
    }

    if (Object.hasOwn(WINDOW_FUNCS, name)) {
      arity(2);
      const window = Math.trunc(this.literal(args[1], nameToken));
      return this.builder.emit(WINDOW_FUNCS[name], [this.node(args[0], nameToken)], { window });
    }

    if (Object.hasOwn(UNARY_FUNCS, name)) {
      arity(1);
      return this.builder.emit(UNARY_FUNCS[name], [this.node(args[0], nameToken)]);
    }

    if (Object.hasOwn(BINARY_FUNCS, name)) {
      arity(2);
      return this.builder.emit(BINARY_FUNCS[name], [this.node(args[0], nameToken), this.node(args[1], nameToken)]);
    }

    if (name === "clamp") {
      arity(3);
      return this.builder.emit("clamp", [this.node(args[0], nameToken)], {
        lo: this.literal(args[1], nameToken),
        hi: this.literal(args[2], nameToken),
      });
    }

    if (name === "button") {
      arity(0);
      this.capabilities.add("button");
      return this.builder.emit("button");
    }

    if (Object.hasOwn(NULLARY_FUNCS, name)) {
      arity(0);
      return this.builder.emit(NULLARY_FUNCS[name]);
    }

    throw fail(`unknown function '${name}'`);
  }

  /**
   * Coerce an argument to a node index, materialising a literal if needed.
   * @param {Token|number} arg
   * @param {Token} at
   */
  node(arg, at) {
    if (typeof arg !== "number") {
      if (arg.kind === "number") return this.builder.emit("const", [], { value: Number(arg.text) });
      throw this.fail(`'${arg.text}' is not a value here`, arg);
    }
    return arg;
  }

  /**
   * A parameter that the device stores on the node itself, not a wire.
   * @param {Token|number} arg
   * @param {Token} at
   */
  literal(arg, at) {
    if (typeof arg !== "number" && arg.kind === "number") return Number(arg.text);
    throw this.fail("expected a literal number", typeof arg === "number" ? at : arg);
  }

  finish() {
    if (this.builder.nodes.length === 0) throw new CompileError("empty program: no signals or events");
    // Always, not only when the graph sweeps: the frame is the graph's clock.
    // A graph without it is never woken, so one that only pages a counter
    // with the button would silently never run.
    this.capabilities.add("read_matrix");

    /** @type {Record<string, unknown>} */
    const manifest = { ...this.manifest };
    manifest.capabilities = [...this.capabilities].sort();
    if (!("name" in manifest)) manifest.name = this.appId;
    manifest.min_os = minOsFor(this.builder.nodes);
    return {
      nhapp: 1,
      kind: "flow",
      name: this.graphName,
      manifest,
      nodes: this.builder.nodes,
    };
  }
}

/** @param {Token} token */
function describe(token) {
  return token.kind === "eof" ? "end of file" : `'${token.text}'`;
}

// --- driver ----------------------------------------------------------------

/**
 * @typedef {object} CompileReport
 * @property {number} nodes
 * @property {number} reused nodes saved by sharing identical subexpressions
 * @property {number} estimatedUs worst-case cost per frame at `cellCount`
 * @property {number} cellCount
 * @property {number} memoryBytes ring-buffer memory
 * @property {number} windowFloats floats taken from the slot's window pool
 * @property {string} minOs
 * @property {Note[]} notes
 * @property {{index: number, op: string, us: number}[]} breakdown most expensive first
 * @property {number[]} nodeLines source line that produced each node
 * @property {Record<string, Region>} regions
 * @property {Record<string, number>} signals signal name -> node index
 * @property {Record<string, number>} events event name -> boolean node index
 */

/**
 * Compile a .nhs source. Throws CompileError on the first error.
 * @param {string} source
 * @param {{cellCount?: number}} [options]
 * @returns {{package: Record<string, any>, report: CompileReport}}
 */
export function compileSource(source, options = {}) {
  const cellCount = options.cellCount ?? DEFAULT_CELL_COUNT;
  const parser = new Parser(tokenize(source));
  const pkg = parser.parse();
  const nodes = pkg.nodes;
  const breakdown = nodes
    .map((node, index) => ({ index, op: node.op, us: graphCostUs([node], cellCount) }))
    .sort((a, b) => b.us - a.us);
  /** @type {CompileReport} */
  const report = {
    nodes: nodes.length,
    reused: parser.builder.reused,
    estimatedUs: graphCostUs(nodes, cellCount),
    cellCount,
    memoryBytes: graphMemoryBytes(nodes),
    windowFloats: windowFloats(nodes),
    minOs: /** @type {string} */ (pkg.manifest.min_os),
    notes: parser.notes,
    breakdown,
    nodeLines: parser.builder.lines,
    regions: Object.fromEntries(parser.regions),
    signals: Object.fromEntries(parser.signals),
    events: Object.fromEntries(parser.events),
  };
  if (nodes.length > MAX_NODES) {
    const contributors = breakdown.slice(0, 3).map((item) => `${item.op} (~${item.us}us)`).join(", ");
    throw new CompileError(`${nodes.length} nodes exceeds the ${MAX_NODES}-node limit. Largest contributors: ${contributors}`);
  }
  return { package: pkg, report };
}
