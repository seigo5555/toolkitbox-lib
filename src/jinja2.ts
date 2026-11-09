/**
 * Jinja2 3.1.6 を TypeScript に移したもの(Hugging Face transformers のチャットテンプレートが使う設定)。
 * lexer.py・parser.py・nodes.py・idtracking.py・compiler.py・runtime.py・sandbox.py・filters.py・tests.py の動きを写した。
 * Jinja2 はテンプレートを Python のコードにしてから動かすので、変数の見える範囲(フレーム)の決め方は compiler.py と
 * idtracking.py をそのまま移し、出来た Python のコードと同じ動きをする関数の組にして動かす。
 *
 * 設定は transformers の _compile_jinja_template と同じ:
 *   ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True, extensions=[AssistantTracker, loopcontrols])
 *   tojson・raise_exception・strftime_now・dict・namespace を差し替え。
 *
 * 元のコードのライセンス(原文)は、toolkitbox-lib の THIRD_PARTY_NOTICES.md と、サイトの /licenses に載せている。
 */
import {
  MISSING,
  NOATTR,
  LOOKUP_ERRORS,
  DictView,
  Markup,
  Namespaceish,
  PY_WS_CLASS,
  PyDict,
  PyException,
  PyFunc,
  PyIter,
  PyObject,
  PyRange,
  PyTuple,
  Undefined,
  bindArgs,
  cpLen,
  cps,
  escape,
  escapeHtml,
  formatHooks,
  getAttrRaw,
  getItemRaw,
  hashKey,
  isInt,
  isIdentifier,
  isNumber,
  isStrLike,
  iterOf,
  iterate,
  jsonDumps,
  objectId,
  orderCmp,
  parsePyFloat,
  parsePyInt,
  percentFormat,
  pformat,
  pyAdd,
  pyCapitalize,
  pyCompare,
  pyEq,
  pyFloorDiv,
  pyIn,
  pyIsLower,
  pyIsUpper,
  pyLen,
  pyMod,
  pyMul,
  pyNeg,
  pyPos,
  pyPow,
  pyReplace,
  pySlice,
  pyStr,
  pySub,
  pyTrueDiv,
  repr,
  reprStr,
  roundFloat,
  roundInt,
  splitlines,
  strOf,
  striptags,
  textwrap,
  toBig,
  toList,
  truthy,
  tryIter,
  typeError,
  typeName,
  urlQuote,
  urlize,
  valueError,
  type Kw,
  type ParamSpec,
  type PyVal,
} from "./py-value";

// ---------------------------------------------------------------- 例外

const syntaxError = (msg: string, lineno: number, type = "TemplateSyntaxError") => {
  const e = new PyException(type, msg);
  e.lineno = lineno;
  return e;
};

// ---------------------------------------------------------------- 字句解析(lexer.py)

type Token = { lineno: number; type: string; value: PyVal };

const OPERATORS: Record<string, string> = {
  "+": "add",
  "-": "sub",
  "/": "div",
  "//": "floordiv",
  "*": "mul",
  "%": "mod",
  "**": "pow",
  "~": "tilde",
  "[": "lbracket",
  "]": "rbracket",
  "(": "lparen",
  ")": "rparen",
  "{": "lbrace",
  "}": "rbrace",
  "==": "eq",
  "!=": "ne",
  ">": "gt",
  ">=": "gteq",
  "<": "lt",
  "<=": "lteq",
  "=": "assign",
  ".": "dot",
  ":": "colon",
  "|": "pipe",
  ",": "comma",
  ";": "semicolon",
};
const REVERSE_OPERATORS: Record<string, string> = Object.fromEntries(Object.entries(OPERATORS).map(([k, v]) => [v, k]));

function describeTokenType(type: string): string {
  if (type in REVERSE_OPERATORS) return REVERSE_OPERATORS[type];
  const d: Record<string, string> = {
    comment_begin: "begin of comment",
    comment_end: "end of comment",
    comment: "comment",
    linecomment: "comment",
    block_begin: "begin of statement block",
    block_end: "end of statement block",
    variable_begin: "begin of print statement",
    variable_end: "end of print statement",
    linestatement_begin: "begin of line statement",
    linestatement_end: "end of line statement",
    data: "template data / text",
    eof: "end of template",
  };
  return d[type] ?? type;
}
const describeToken = (t: Token) => (t.type === "name" ? (t.value as string) : describeTokenType(t.type));
function describeTokenExpr(expr: string): string {
  if (expr.includes(":")) {
    const [type, value] = [expr.slice(0, expr.indexOf(":")), expr.slice(expr.indexOf(":") + 1)];
    if (type === "name") return value;
    return describeTokenType(type);
  }
  return describeTokenType(expr);
}
function tokenTest(t: Token, expr: string): boolean {
  if (t.type === expr) return true;
  if (expr.includes(":")) {
    const i = expr.indexOf(":");
    return expr.slice(0, i) === t.type && expr.slice(i + 1) === t.value;
  }
  return false;
}

const WS = PY_WS_CLASS;
const D = "\\p{Nd}";
const RE_WHITESPACE = new RegExp(`${WS}+`, "uy");
const RE_FLOAT = new RegExp(`(?<!\\.)(${D}+_)*${D}+((\\.(${D}+_)*${D}+)?[eE][+\\-]?(${D}+_)*${D}+|\\.(${D}+_)*${D}+)`, "uy");
const RE_INTEGER = new RegExp(`(0[bB](_?[0-1])+|0[oO](_?[0-7])+|0[xX](_?[0-9a-fA-F\\p{Nd}])+|[1-9](_?${D})*|0(_?0)*)`, "uy");
const RE_NAME = /[\p{L}\p{N}_\p{Mn}\p{Mc}\p{Pc}\u00b7\u0387\u1369-\u1371\u19da\u2118\u212e\u309b\u309c]+/uy;
const RE_STRING = /('([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)")/suy;
const RE_OPERATOR = /(\/\/|\*\*|==|!=|>=|<=|\+|-|\/|\*|%|~|\[|\]|\(|\)|\{|\}|>|<|=|\.|:|\||,|;)/y;
const RE_ROOT = new RegExp(
  `(.*?)(?:(?<raw_begin>\\{%(-|\\+|)${WS}*raw${WS}*(?:-%\\}${WS}*|%\\}))|(?<variable_begin>\\{\\{(-|\\+|))|(?<comment_begin>\\{#(-|\\+|))|(?<block_begin>\\{%(-|\\+|)))`,
  "suy",
);
const RE_ROOT_REST = /.+/suy;
const RE_COMMENT_END = new RegExp(`(.*?)((?:\\+#\\}|-#\\}${WS}*|#\\}\\n?))`, "suy");
const RE_BLOCK_END = new RegExp(`(?:\\+%\\}|-%\\}${WS}*|%\\}\\n?)`, "uy");
const RE_VARIABLE_END = new RegExp(`-\\}\\}${WS}*|\\}\\}`, "uy");
const RE_RAW_END = new RegExp(`(.*?)((?:\\{%(-|\\+|))${WS}*endraw${WS}*(?:\\+%\\}|-%\\}${WS}*|%\\}\\n?))`, "suy");
const RE_WS_FULL = new RegExp(`^${WS}+$`, "u");

/** str.rstrip()(既定の空白) */
const rstripPy = (s: string) => s.replace(new RegExp(`${WS}+$`, "u"), "");

/** Python の 'unicode-escape' の復号(先に非 ASCII を \x・\u・\U にしてから)。 */
function decodeStringLiteral(raw: string): string {
  let s = "";
  for (const ch of raw) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) s += ch;
    else if (c <= 0xff) s += "\\x" + c.toString(16).padStart(2, "0");
    else if (c <= 0xffff) s += "\\u" + c.toString(16).padStart(4, "0");
    else s += "\\U" + c.toString(16).padStart(8, "0");
  }
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    if (i + 1 >= s.length) throw new PyException("ValueError", "\\ at end of string");
    const e = s[++i];
    const simple: Record<string, string> = { "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\x0b", "\n": "" };
    if (e in simple) out += simple[e];
    else if (/[0-7]/.test(e)) {
      let o = e;
      while (o.length < 3 && /[0-7]/.test(s[i + 1] ?? "")) o += s[++i];
      out += String.fromCodePoint(parseInt(o, 8));
    } else if (e === "x" || e === "u" || e === "U") {
      const n = e === "x" ? 2 : e === "u" ? 4 : 8;
      const h = s.slice(i + 1, i + 1 + n);
      if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(h)) throw new PyException("ValueError", `truncated \\${e === "x" ? "xXX" : e === "u" ? "uXXXX" : "UXXXXXXXX"} escape`);
      const cp = parseInt(h, 16);
      if (cp > 0x10ffff) throw new PyException("ValueError", "illegal Unicode character");
      out += cp >= 0xd800 && cp < 0xe000 ? String.fromCharCode(cp) : String.fromCodePoint(cp);
      i += n;
    } else if (e === "N") throw new PyException("ValueError", "malformed \\N character escape");
    else out += "\\" + e;
  }
  return out;
}

function* tokenize(source: string): Generator<Token> {
  // 改行をそろえ、末尾の改行を 1 つ落とす(keep_trailing_newline=False)
  const lines = source.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  source = lines.join("\n");
  let pos = 0;
  let lineno = 1;
  const stack = ["root"];
  const balancing: string[] = [];
  let newlinesStripped = 0;
  let lineStarting = true;
  const cpPos = (p: number) => cpLen(source.slice(0, p));
  // wrap(): 値を変換する(読み飛ばすものは null)
  const conv = (lineno: number, type: string, value: string): Token | null => {
    if (["comment_begin", "comment", "comment_end", "whitespace", "linecomment_begin", "linecomment_end", "linecomment", "raw_begin", "raw_end"].includes(type)) return null;
    if (type === "data") return { lineno, type, value };
    if (type === "name") {
      if (!isIdentifier(value)) throw syntaxError("Invalid character in identifier", lineno);
      return { lineno, type, value };
    }
    if (type === "string") {
      try {
        return { lineno, type, value: decodeStringLiteral(value.slice(1, -1)) };
      } catch (e) {
        throw syntaxError((e as Error).message.split(":").pop()!.trim(), lineno);
      }
    }
    if (type === "integer") return { lineno, type, value: parsePyInt(value.replace(/_/g, ""), 0) ?? 0n };
    if (type === "float") return { lineno, type, value: Number(value.replace(/_/g, "")) };
    if (type === "operator") return { lineno, type: OPERATORS[value], value };
    return { lineno, type, value };
  };
  const tagRules: [RegExp, string][] = [
    [RE_WHITESPACE, "whitespace"],
    [RE_FLOAT, "float"],
    [RE_INTEGER, "integer"],
    [RE_NAME, "name"],
    [RE_STRING, "string"],
    [RE_OPERATOR, "operator"],
  ];
  const at = (re: RegExp) => {
    re.lastIndex = pos;
    return re.exec(source);
  };
  for (;;) {
    const state = stack[stack.length - 1];
    if (pos >= source.length && state === "root") return;
    let m: RegExpExecArray | null;
    if (state === "root") {
      m = at(RE_ROOT);
      if (m) {
        let text = m[1];
        const g = m.groups!;
        const key = (["raw_begin", "variable_begin", "comment_begin", "block_begin"] as const).find((k) => g[k] !== undefined)!;
        const sign = [m[3], m[5], m[7], m[9]].find((x) => x !== undefined)!;
        if (sign === "-") {
          const stripped = rstripPy(text);
          newlinesStripped = (text.slice(stripped.length).match(/\n/g) ?? []).length;
          text = stripped;
        } else if (sign !== "+" && key !== "variable_begin") {
          const lpos = text.lastIndexOf("\n") + 1;
          if (lpos > 0 || lineStarting) {
            if (RE_WS_FULL.test(text.slice(lpos))) text = text.slice(0, lpos);
          }
        }
        if (text) { const t = conv(lineno, "data", text); if (t) yield t; }
        lineno += (text.match(/\n/g) ?? []).length + newlinesStripped;
        newlinesStripped = 0;
        { const t = conv(lineno, key, g[key]!); if (t) yield t; }
        lineno += (g[key]!.match(/\n/g) ?? []).length;
        lineStarting = m[0].endsWith("\n");
        pos = m.index + m[0].length;
        stack.push(key);
        continue;
      }
      m = at(RE_ROOT_REST);
      if (m) {
        { const t = conv(lineno, "data", m[0]); if (t) yield t; }
        lineno += (m[0].match(/\n/g) ?? []).length;
        lineStarting = m[0].endsWith("\n");
        pos += m[0].length;
        continue;
      }
      return;
    }
    if (state === "comment_begin") {
      m = at(RE_COMMENT_END);
      if (!m) throw syntaxError("Missing end of comment tag", lineno);
      lineno += (m[1].match(/\n/g) ?? []).length + newlinesStripped;
      newlinesStripped = 0;
      lineno += (m[2].match(/\n/g) ?? []).length;
      lineStarting = m[0].endsWith("\n");
      pos += m[0].length;
      stack.pop();
      continue;
    }
    if (state === "raw_begin") {
      m = at(RE_RAW_END);
      if (!m) throw syntaxError("Missing end of raw directive", lineno);
      let text = m[1];
      const sign = m[3];
      if (sign === "-") {
        const stripped = rstripPy(text);
        newlinesStripped = (text.slice(stripped.length).match(/\n/g) ?? []).length;
        text = stripped;
      } else if (sign !== "+") {
        const lpos = text.lastIndexOf("\n") + 1;
        if (lpos > 0 || lineStarting) {
          if (RE_WS_FULL.test(text.slice(lpos))) text = text.slice(0, lpos);
        }
      }
      if (text) { const t = conv(lineno, "data", text); if (t) yield t; }
      lineno += (text.match(/\n/g) ?? []).length + newlinesStripped;
      newlinesStripped = 0;
      lineno += (m[2].match(/\n/g) ?? []).length;
      lineStarting = m[0].endsWith("\n");
      pos += m[0].length;
      stack.pop();
      continue;
    }
    // block_begin / variable_begin
    const endRe = state === "block_begin" ? RE_BLOCK_END : RE_VARIABLE_END;
    const endType = state === "block_begin" ? "block_end" : "variable_end";
    let matched = false;
    if (!balancing.length) {
      m = at(endRe);
      if (m) {
        { const t = conv(lineno, endType, m[0]); if (t) yield t; }
        lineno += (m[0].match(/\n/g) ?? []).length;
        lineStarting = m[0].endsWith("\n");
        pos += m[0].length;
        stack.pop();
        continue;
      }
    }
    for (const [re, type] of tagRules) {
      m = at(re);
      if (!m) continue;
      const data = m[0];
      if (type === "operator") {
        if (data === "{") balancing.push("}");
        else if (data === "(") balancing.push(")");
        else if (data === "[") balancing.push("]");
        else if (data === "}" || data === ")" || data === "]") {
          if (!balancing.length) throw syntaxError(`unexpected '${data}'`, lineno);
          const exp = balancing.pop()!;
          if (exp !== data) throw syntaxError(`unexpected '${data}', expected '${exp}'`, lineno);
        }
      }
      if (data || type !== "whitespace") { const t = conv(lineno, type, data); if (t) yield t; }
      lineno += (data.match(/\n/g) ?? []).length;
      lineStarting = data.endsWith("\n");
      pos += data.length;
      matched = true;
      break;
    }
    if (matched) continue;
    if (pos >= source.length) return;
    throw syntaxError(`unexpected char ${reprStr(cps(source.slice(pos))[0])} at ${cpPos(pos)}`, lineno);
  }
}

/** lexer.TokenStream(字句解析は必要になったときに進む)。 */
class TokenStream {
  private pushed: Token[] = [];
  current: Token = { lineno: 1, type: "initial", value: "" };
  constructor(private gen: Generator<Token>) {
    this.next();
  }
  next(): Token {
    const rv = this.current;
    if (this.pushed.length) this.current = this.pushed.shift()!;
    else if (this.current.type !== "eof") {
      const r = this.gen.next();
      this.current = r.done ? { lineno: this.current.lineno, type: "eof", value: "" } : r.value;
    }
    return rv;
  }
  look(): Token {
    const old = this.next();
    const result = this.current;
    this.pushed.push(result);
    this.current = old;
    return result;
  }
  skip(n = 1) {
    for (let k = 0; k < n; k++) this.next();
  }
  nextIf(expr: string): Token | null {
    return tokenTest(this.current, expr) ? this.next() : null;
  }
  skipIf(expr: string) {
    return this.nextIf(expr) !== null;
  }
  get eos() {
    return !this.pushed.length && this.current.type === "eof";
  }
  expect(expr: string): Token {
    if (!tokenTest(this.current, expr)) {
      const e = describeTokenExpr(expr);
      if (this.current.type === "eof") throw syntaxError(`unexpected end of template, expected ${reprStr(e)}.`, this.current.lineno);
      throw syntaxError(`expected token ${reprStr(e)}, got ${reprStr(describeToken(this.current))}`, this.current.lineno);
    }
    return this.next();
  }
}

// ---------------------------------------------------------------- 構文木(nodes.py)

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Node = { type: string; lineno: number; [k: string]: any };

/** fields の順(iter_child_nodes の順になる)。 */
const FIELDS: Record<string, string[]> = {
  Template: ["body"],
  Output: ["nodes"],
  Extends: ["template"],
  For: ["target", "iter", "body", "else_", "test", "recursive"],
  If: ["test", "body", "elif_", "else_"],
  Macro: ["name", "args", "defaults", "body"],
  CallBlock: ["call", "args", "defaults", "body"],
  FilterBlock: ["body", "filter"],
  With: ["targets", "values", "body"],
  Block: ["name", "body", "scoped", "required"],
  Include: ["template", "with_context", "ignore_missing"],
  Import: ["template", "target", "with_context"],
  FromImport: ["template", "names", "with_context"],
  ExprStmt: ["node"],
  Assign: ["target", "node"],
  AssignBlock: ["target", "filter", "body"],
  Name: ["name", "ctx"],
  NSRef: ["name", "attr"],
  Const: ["value"],
  TemplateData: ["data"],
  Tuple: ["items", "ctx"],
  List: ["items"],
  Dict: ["items"],
  Pair: ["key", "value"],
  Keyword: ["key", "value"],
  CondExpr: ["test", "expr1", "expr2"],
  Filter: ["node", "name", "args", "kwargs", "dyn_args", "dyn_kwargs"],
  Test: ["node", "name", "args", "kwargs", "dyn_args", "dyn_kwargs"],
  Call: ["node", "args", "kwargs", "dyn_args", "dyn_kwargs"],
  Getitem: ["node", "arg", "ctx"],
  Getattr: ["node", "attr", "ctx"],
  Slice: ["start", "stop", "step"],
  Concat: ["nodes"],
  Compare: ["expr", "ops"],
  Operand: ["op", "expr"],
  Add: ["left", "right"],
  Sub: ["left", "right"],
  Mul: ["left", "right"],
  Div: ["left", "right"],
  FloorDiv: ["left", "right"],
  Mod: ["left", "right"],
  Pow: ["left", "right"],
  And: ["left", "right"],
  Or: ["left", "right"],
  Not: ["node"],
  Neg: ["node"],
  Pos: ["node"],
  ExtensionAttribute: ["identifier", "name"],
  Continue: [],
  Break: [],
  Scope: ["body"],
  ScopedEvalContextModifier: ["options", "body"],
};

const mk = (type: string, lineno: number, f: Record<string, any> = {}): Node => ({ type, lineno, ...f });
const isNode = (x: unknown): x is Node => typeof x === "object" && x !== null && typeof (x as Node).type === "string" && typeof (x as Node).lineno === "number";

function* iterChildNodes(n: Node, opts: { exclude?: string[]; only?: string[] } = {}): Generator<Node> {
  for (const f of FIELDS[n.type] ?? []) {
    if (opts.exclude?.includes(f)) continue;
    if (opts.only && !opts.only.includes(f)) continue;
    const v = n[f];
    if (isNode(v)) yield v;
    else if (Array.isArray(v)) for (const x of v) if (isNode(x)) yield x;
  }
}

function* findAll(n: Node, type: string): Generator<Node> {
  for (const c of iterChildNodes(n)) {
    if (c.type === type) yield c;
    yield* findAll(c, type);
  }
}

function setCtx(n: Node, ctx: string) {
  const todo = [n];
  while (todo.length) {
    const x = todo.shift()!;
    if ("ctx" in x) x.ctx = ctx;
    todo.push(...iterChildNodes(x));
  }
}

function canAssign(n: Node): boolean {
  if (n.type === "Name") return !["true", "false", "none", "True", "False", "None"].includes(n.name);
  if (n.type === "Tuple") return n.items.every(canAssign);
  return n.type === "NSRef";
}

// ---------------------------------------------------------------- 構文解析(parser.py)

const STATEMENT_KEYWORDS = new Set(["for", "if", "block", "extends", "print", "macro", "include", "from", "import", "set", "with", "autoescape"]);
const COMPARE_OPERATORS = new Set(["eq", "ne", "lt", "lteq", "gt", "gteq"]);
const MATH_NODES: Record<string, string> = { add: "Add", sub: "Sub", mul: "Mul", div: "Div", floordiv: "FloorDiv", mod: "Mod" };
const EXTENSION_TAGS = new Set(["break", "continue", "generation"]);

class Parser {
  stream: TokenStream;
  tagStack: string[] = [];
  endTokenStack: string[][] = [];
  constructor(source: string) {
    this.stream = new TokenStream(tokenize(source));
  }
  fail(msg: string, lineno?: number, type = "TemplateSyntaxError"): never {
    throw syntaxError(msg, lineno ?? this.stream.current.lineno, type);
  }
  failUtEof(name: string | null, endTokenStack: string[][], lineno: number): never {
    const expected = new Set<string>();
    for (const exprs of endTokenStack) for (const e of exprs) expected.add(describeTokenExpr(e));
    const currently = endTokenStack.length ? endTokenStack[endTokenStack.length - 1].map((e) => reprStr(describeTokenExpr(e))).join(" or ") : null;
    const message = [name === null ? "Unexpected end of template." : `Encountered unknown tag ${reprStr(name)}.`];
    if (currently) {
      if (name !== null && expected.has(name)) message.push(`You probably made a nesting mistake. Jinja is expecting this tag, but currently looking for ${currently}.`);
      else message.push(`Jinja was looking for the following tags: ${currently}.`);
    }
    if (this.tagStack.length) message.push(`The innermost block that needs to be closed is ${reprStr(this.tagStack[this.tagStack.length - 1])}.`);
    this.fail(message.join(" "), lineno);
  }
  failEof(endTokens: string[] | null, lineno?: number): never {
    const stack = [...this.endTokenStack];
    if (endTokens) stack.push(endTokens);
    this.failUtEof(null, stack, lineno ?? this.stream.current.lineno);
  }
  isTupleEnd(extra?: string[]) {
    const t = this.stream.current.type;
    if (t === "variable_end" || t === "block_end" || t === "rparen") return true;
    if (extra) return extra.some((e) => tokenTest(this.stream.current, e));
    return false;
  }
  parseStatement(): Node | Node[] {
    const token = this.stream.current;
    if (token.type !== "name") this.fail("tag name expected", token.lineno);
    this.tagStack.push(token.value as string);
    let pop = true;
    try {
      const v = token.value as string;
      if (STATEMENT_KEYWORDS.has(v)) return (this as any)[`parse_${v}`]();
      if (v === "call") return this.parseCallBlock();
      if (v === "filter") return this.parseFilterBlock();
      if (EXTENSION_TAGS.has(v)) return this.parseExtension(v);
      this.tagStack.pop();
      pop = false;
      return this.failUtEof(v, this.endTokenStack, token.lineno);
    } finally {
      if (pop) this.tagStack.pop();
    }
  }
  parseExtension(tag: string): Node {
    const token = this.stream.next();
    if (tag === "break") return mk("Break", token.lineno);
    if (tag === "continue") return mk("Continue", token.lineno);
    // transformers の AssistantTracker: {% generation %}…{% endgeneration %} を CallBlock にする
    const body = this.parseStatements(["name:endgeneration"], true);
    const call = mk("Call", token.lineno, { node: mk("ExtensionAttribute", token.lineno, { identifier: "AssistantTracker", name: "_generation_support" }), args: [], kwargs: [], dyn_args: null, dyn_kwargs: null });
    return mk("CallBlock", token.lineno, { call, args: [], defaults: [], body });
  }
  parseStatements(endTokens: string[], dropNeedle = false): Node[] {
    this.stream.skipIf("colon");
    this.stream.expect("block_end");
    const result = this.subparse(endTokens);
    if (this.stream.current.type === "eof") this.failEof(endTokens);
    if (dropNeedle) this.stream.next();
    return result;
  }
  parse_set(): Node {
    const lineno = this.stream.next().lineno;
    const target = this.parseAssignTarget({ withNamespace: true });
    if (this.stream.skipIf("assign")) return mk("Assign", lineno, { target, node: this.parseTuple() });
    const filter = this.parseFilter(null);
    const body = this.parseStatements(["name:endset"], true);
    return mk("AssignBlock", lineno, { target, filter, body });
  }
  parse_for(): Node {
    const lineno = this.stream.expect("name:for").lineno;
    const target = this.parseAssignTarget({ extraEndRules: ["name:in"] });
    this.stream.expect("name:in");
    const iter = this.parseTuple({ withCondexpr: false, extraEndRules: ["name:recursive"] });
    let test: Node | null = null;
    if (this.stream.skipIf("name:if")) test = this.parseExpression();
    const recursive = this.stream.skipIf("name:recursive");
    const body = this.parseStatements(["name:endfor", "name:else"]);
    let else_: Node[];
    if (this.stream.next().value === "endfor") else_ = [];
    else else_ = this.parseStatements(["name:endfor"], true);
    return mk("For", lineno, { target, iter, body, else_, test, recursive });
  }
  parse_if(): Node {
    const result = mk("If", this.stream.expect("name:if").lineno);
    let node = result;
    for (;;) {
      node.test = this.parseTuple({ withCondexpr: false });
      node.body = this.parseStatements(["name:elif", "name:else", "name:endif"]);
      node.elif_ = [];
      node.else_ = [];
      const token = this.stream.next();
      if (tokenTest(token, "name:elif")) {
        node = mk("If", this.stream.current.lineno);
        result.elif_.push(node);
        continue;
      } else if (tokenTest(token, "name:else")) result.else_ = this.parseStatements(["name:endif"], true);
      break;
    }
    return result;
  }
  parse_with(): Node {
    const node = mk("With", this.stream.next().lineno);
    const targets: Node[] = [];
    const values: Node[] = [];
    while (this.stream.current.type !== "block_end") {
      if (targets.length) this.stream.expect("comma");
      const target = this.parseAssignTarget();
      setCtx(target, "param");
      targets.push(target);
      this.stream.expect("assign");
      values.push(this.parseExpression());
    }
    node.targets = targets;
    node.values = values;
    node.body = this.parseStatements(["name:endwith"], true);
    return node;
  }
  parse_autoescape(): Node {
    const node = mk("ScopedEvalContextModifier", this.stream.next().lineno);
    node.options = [mk("Keyword", node.lineno, { key: "autoescape", value: this.parseExpression() })];
    node.body = this.parseStatements(["name:endautoescape"], true);
    return mk("Scope", node.lineno, { body: [node] });
  }
  parse_block(): Node {
    const node = mk("Block", this.stream.next().lineno);
    node.name = this.stream.expect("name").value;
    node.scoped = this.stream.skipIf("name:scoped");
    node.required = this.stream.skipIf("name:required");
    if (this.stream.current.type === "sub") this.fail("Block names in Jinja have to be valid Python identifiers and may not contain hyphens, use an underscore instead.");
    node.body = this.parseStatements(["name:endblock"], true);
    if (node.required) {
      for (const b of node.body) {
        if (b.type !== "Output" || b.nodes.some((o: Node) => o.type !== "TemplateData" || !/^\s+$/u.test(o.data))) this.fail("Required blocks can only contain comments or whitespace");
      }
    }
    this.stream.skipIf("name:" + node.name);
    return node;
  }
  parse_extends(): Node {
    const node = mk("Extends", this.stream.next().lineno);
    node.template = this.parseExpression();
    return node;
  }
  parseImportContext(node: Node, def: boolean): Node {
    if ((tokenTest(this.stream.current, "name:with") || tokenTest(this.stream.current, "name:without")) && tokenTest(this.stream.look(), "name:context")) {
      node.with_context = this.stream.next().value === "with";
      this.stream.skip();
    } else node.with_context = def;
    return node;
  }
  parse_include(): Node {
    const node = mk("Include", this.stream.next().lineno);
    node.template = this.parseExpression();
    if (tokenTest(this.stream.current, "name:ignore") && tokenTest(this.stream.look(), "name:missing")) {
      node.ignore_missing = true;
      this.stream.skip(2);
    } else node.ignore_missing = false;
    return this.parseImportContext(node, true);
  }
  parse_import(): Node {
    const node = mk("Import", this.stream.next().lineno);
    node.template = this.parseExpression();
    this.stream.expect("name:as");
    node.target = this.parseAssignTarget({ nameOnly: true }).name;
    return this.parseImportContext(node, false);
  }
  parse_from(): Node {
    const node = mk("FromImport", this.stream.next().lineno);
    node.template = this.parseExpression();
    this.stream.expect("name:import");
    node.names = [];
    const parseContext = () => {
      if (["with", "without"].includes(this.stream.current.value as string) && tokenTest(this.stream.look(), "name:context")) {
        node.with_context = this.stream.next().value === "with";
        this.stream.skip();
        return true;
      }
      return false;
    };
    for (;;) {
      if (node.names.length) this.stream.expect("comma");
      if (this.stream.current.type === "name") {
        if (parseContext()) break;
        const target = this.parseAssignTarget({ nameOnly: true });
        if (target.name.startsWith("_")) this.fail("names starting with an underline can not be imported", target.lineno, "TemplateAssertionError");
        if (this.stream.skipIf("name:as")) node.names.push([target.name, this.parseAssignTarget({ nameOnly: true }).name]);
        else node.names.push(target.name);
        if (parseContext() || (this.stream.current.type as string) !== "comma") break;
      } else this.stream.expect("name");
    }
    if (node.with_context === undefined) node.with_context = false;
    return node;
  }
  parseSignature(node: Node) {
    const args: Node[] = (node.args = []);
    const defaults: Node[] = (node.defaults = []);
    this.stream.expect("lparen");
    while (this.stream.current.type !== "rparen") {
      if (args.length) this.stream.expect("comma");
      const arg = this.parseAssignTarget({ nameOnly: true });
      setCtx(arg, "param");
      if (this.stream.skipIf("assign")) defaults.push(this.parseExpression());
      else if (defaults.length) this.fail("non-default argument follows default argument");
      args.push(arg);
    }
    this.stream.expect("rparen");
  }
  parseCallBlock(): Node {
    const node = mk("CallBlock", this.stream.next().lineno);
    if (this.stream.current.type === "lparen") this.parseSignature(node);
    else {
      node.args = [];
      node.defaults = [];
    }
    const call = this.parseExpression();
    if (call.type !== "Call") this.fail("expected call", node.lineno);
    node.call = call;
    node.body = this.parseStatements(["name:endcall"], true);
    return node;
  }
  parseFilterBlock(): Node {
    const node = mk("FilterBlock", this.stream.next().lineno);
    node.filter = this.parseFilter(null, true);
    node.body = this.parseStatements(["name:endfilter"], true);
    return node;
  }
  parse_macro(): Node {
    const node = mk("Macro", this.stream.next().lineno);
    node.name = this.parseAssignTarget({ nameOnly: true }).name;
    this.parseSignature(node);
    node.body = this.parseStatements(["name:endmacro"], true);
    return node;
  }
  parse_print(): Node {
    const node = mk("Output", this.stream.next().lineno, { nodes: [] });
    while (this.stream.current.type !== "block_end") {
      if (node.nodes.length) this.stream.expect("comma");
      node.nodes.push(this.parseExpression());
    }
    return node;
  }
  parseAssignTarget(o: { withTuple?: boolean; nameOnly?: boolean; extraEndRules?: string[]; withNamespace?: boolean } = {}): Node {
    const { withTuple = true, nameOnly = false, extraEndRules, withNamespace = false } = o;
    let target: Node;
    if (nameOnly) {
      const token = this.stream.expect("name");
      target = mk("Name", token.lineno, { name: token.value, ctx: "store" });
    } else {
      if (withTuple) target = this.parseTuple({ simplified: true, extraEndRules, withNamespace });
      else target = this.parsePrimary(withNamespace);
      setCtx(target, "store");
    }
    if (!canAssign(target)) this.fail(`can't assign to ${reprStr(target.type.toLowerCase())}`, target.lineno);
    return target;
  }
  parseExpression(withCondexpr = true): Node {
    return withCondexpr ? this.parseCondexpr() : this.parseOr();
  }
  parseCondexpr(): Node {
    let lineno = this.stream.current.lineno;
    let expr1 = this.parseOr();
    while (this.stream.skipIf("name:if")) {
      const expr2 = this.parseOr();
      const expr3 = this.stream.skipIf("name:else") ? this.parseCondexpr() : null;
      expr1 = mk("CondExpr", lineno, { test: expr2, expr1, expr2: expr3 });
      lineno = this.stream.current.lineno;
    }
    return expr1;
  }
  parseOr(): Node {
    let lineno = this.stream.current.lineno;
    let left = this.parseAnd();
    while (this.stream.skipIf("name:or")) {
      left = mk("Or", lineno, { left, right: this.parseAnd() });
      lineno = this.stream.current.lineno;
    }
    return left;
  }
  parseAnd(): Node {
    let lineno = this.stream.current.lineno;
    let left = this.parseNot();
    while (this.stream.skipIf("name:and")) {
      left = mk("And", lineno, { left, right: this.parseNot() });
      lineno = this.stream.current.lineno;
    }
    return left;
  }
  parseNot(): Node {
    if (tokenTest(this.stream.current, "name:not")) {
      const lineno = this.stream.next().lineno;
      return mk("Not", lineno, { node: this.parseNot() });
    }
    return this.parseCompare();
  }
  parseCompare(): Node {
    let lineno = this.stream.current.lineno;
    const expr = this.parseMath1();
    const ops: Node[] = [];
    for (;;) {
      const t = this.stream.current.type;
      if (COMPARE_OPERATORS.has(t)) {
        this.stream.next();
        ops.push(mk("Operand", lineno, { op: t, expr: this.parseMath1() }));
      } else if (this.stream.skipIf("name:in")) ops.push(mk("Operand", lineno, { op: "in", expr: this.parseMath1() }));
      else if (tokenTest(this.stream.current, "name:not") && tokenTest(this.stream.look(), "name:in")) {
        this.stream.skip(2);
        ops.push(mk("Operand", lineno, { op: "notin", expr: this.parseMath1() }));
      } else break;
      lineno = this.stream.current.lineno;
    }
    if (!ops.length) return expr;
    return mk("Compare", lineno, { expr, ops });
  }
  parseMath1(): Node {
    let lineno = this.stream.current.lineno;
    let left = this.parseConcat();
    while (["add", "sub"].includes(this.stream.current.type)) {
      const cls = MATH_NODES[this.stream.current.type];
      this.stream.next();
      left = mk(cls, lineno, { left, right: this.parseConcat() });
      lineno = this.stream.current.lineno;
    }
    return left;
  }
  parseConcat(): Node {
    const lineno = this.stream.current.lineno;
    const args = [this.parseMath2()];
    while (this.stream.current.type === "tilde") {
      this.stream.next();
      args.push(this.parseMath2());
    }
    if (args.length === 1) return args[0];
    return mk("Concat", lineno, { nodes: args });
  }
  parseMath2(): Node {
    let lineno = this.stream.current.lineno;
    let left = this.parsePow();
    while (["mul", "div", "floordiv", "mod"].includes(this.stream.current.type)) {
      const cls = MATH_NODES[this.stream.current.type];
      this.stream.next();
      left = mk(cls, lineno, { left, right: this.parsePow() });
      lineno = this.stream.current.lineno;
    }
    return left;
  }
  parsePow(): Node {
    let lineno = this.stream.current.lineno;
    let left = this.parseUnary();
    while (this.stream.current.type === "pow") {
      this.stream.next();
      left = mk("Pow", lineno, { left, right: this.parseUnary() });
      lineno = this.stream.current.lineno;
    }
    return left;
  }
  parseUnary(withFilter = true): Node {
    const t = this.stream.current.type;
    const lineno = this.stream.current.lineno;
    let node: Node;
    if (t === "sub") {
      this.stream.next();
      node = mk("Neg", lineno, { node: this.parseUnary(false) });
    } else if (t === "add") {
      this.stream.next();
      node = mk("Pos", lineno, { node: this.parseUnary(false) });
    } else node = this.parsePrimary();
    node = this.parsePostfix(node);
    if (withFilter) node = this.parseFilterExpr(node);
    return node;
  }
  parsePrimary(withNamespace = false): Node {
    const token = this.stream.current;
    if (token.type === "name") {
      this.stream.next();
      const v = token.value as string;
      if (["true", "false", "True", "False"].includes(v)) return mk("Const", token.lineno, { value: v === "true" || v === "True" });
      if (v === "none" || v === "None") return mk("Const", token.lineno, { value: null });
      if (withNamespace && this.stream.current.type === "dot") {
        this.stream.next();
        const attr = this.stream.expect("name");
        return mk("NSRef", token.lineno, { name: v, attr: attr.value });
      }
      return mk("Name", token.lineno, { name: v, ctx: "load" });
    }
    if (token.type === "string") {
      this.stream.next();
      let buf = token.value as string;
      while (this.stream.current.type === "string") buf += this.stream.next().value as string;
      return mk("Const", token.lineno, { value: buf });
    }
    if (token.type === "integer" || token.type === "float") {
      this.stream.next();
      return mk("Const", token.lineno, { value: token.value });
    }
    if (token.type === "lparen") {
      this.stream.next();
      const node = this.parseTuple({ explicitParentheses: true });
      this.stream.expect("rparen");
      return node;
    }
    if (token.type === "lbracket") return this.parseList();
    if (token.type === "lbrace") return this.parseDict();
    this.fail(`unexpected ${reprStr(describeToken(token))}`, token.lineno);
  }
  parseTuple(o: { simplified?: boolean; withCondexpr?: boolean; extraEndRules?: string[]; explicitParentheses?: boolean; withNamespace?: boolean } = {}): Node {
    const { simplified = false, withCondexpr = true, extraEndRules, explicitParentheses = false, withNamespace = false } = o;
    let lineno = this.stream.current.lineno;
    const parse = simplified ? () => this.parsePrimary(withNamespace) : () => this.parseExpression(withCondexpr);
    const args: Node[] = [];
    let isTuple = false;
    for (;;) {
      if (args.length) this.stream.expect("comma");
      if (this.isTupleEnd(extraEndRules)) break;
      args.push(parse());
      if (this.stream.current.type === "comma") isTuple = true;
      else break;
      lineno = this.stream.current.lineno;
    }
    if (!isTuple) {
      if (args.length) return args[0];
      if (!explicitParentheses) this.fail(`Expected an expression, got ${reprStr(describeToken(this.stream.current))}`);
    }
    return mk("Tuple", lineno, { items: args, ctx: "load" });
  }
  parseList(): Node {
    const token = this.stream.expect("lbracket");
    const items: Node[] = [];
    while (this.stream.current.type !== "rbracket") {
      if (items.length) this.stream.expect("comma");
      if (this.stream.current.type === "rbracket") break;
      items.push(this.parseExpression());
    }
    this.stream.expect("rbracket");
    return mk("List", token.lineno, { items });
  }
  parseDict(): Node {
    const token = this.stream.expect("lbrace");
    const items: Node[] = [];
    while (this.stream.current.type !== "rbrace") {
      if (items.length) this.stream.expect("comma");
      if (this.stream.current.type === "rbrace") break;
      const key = this.parseExpression();
      this.stream.expect("colon");
      const value = this.parseExpression();
      items.push(mk("Pair", key.lineno, { key, value }));
    }
    this.stream.expect("rbrace");
    return mk("Dict", token.lineno, { items });
  }
  parsePostfix(node: Node): Node {
    for (;;) {
      const t = this.stream.current.type;
      if (t === "dot" || t === "lbracket") node = this.parseSubscript(node);
      else if (t === "lparen") node = this.parseCall(node);
      else break;
    }
    return node;
  }
  parseFilterExpr(node: Node): Node {
    for (;;) {
      const t = this.stream.current.type;
      if (t === "pipe") node = this.parseFilter(node)!;
      else if (t === "name" && this.stream.current.value === "is") node = this.parseTest(node);
      else if (t === "lparen") node = this.parseCall(node);
      else break;
    }
    return node;
  }
  parseSubscript(node: Node): Node {
    const token = this.stream.next();
    if (token.type === "dot") {
      const attr = this.stream.current;
      this.stream.next();
      if (attr.type === "name") return mk("Getattr", token.lineno, { node, attr: attr.value, ctx: "load" });
      if (attr.type !== "integer") this.fail("expected name or number", attr.lineno);
      return mk("Getitem", token.lineno, { node, arg: mk("Const", attr.lineno, { value: attr.value }), ctx: "load" });
    }
    if (token.type === "lbracket") {
      const args: Node[] = [];
      while (this.stream.current.type !== "rbracket") {
        if (args.length) this.stream.expect("comma");
        args.push(this.parseSubscribed());
      }
      this.stream.expect("rbracket");
      const arg = args.length === 1 ? args[0] : mk("Tuple", token.lineno, { items: args, ctx: "load" });
      return mk("Getitem", token.lineno, { node, arg, ctx: "load" });
    }
    this.fail("expected subscript expression", token.lineno);
  }
  parseSubscribed(): Node {
    const lineno = this.stream.current.lineno;
    let args: (Node | null)[];
    if (this.stream.current.type === "colon") {
      this.stream.next();
      args = [null];
    } else {
      const node = this.parseExpression();
      if (this.stream.current.type !== "colon") return node;
      this.stream.next();
      args = [node];
    }
    if (this.stream.current.type === "colon") args.push(null);
    else if (!["rbracket", "comma"].includes(this.stream.current.type)) args.push(this.parseExpression());
    else args.push(null);
    if (this.stream.current.type === "colon") {
      this.stream.next();
      if (!["rbracket", "comma"].includes(this.stream.current.type)) args.push(this.parseExpression());
      else args.push(null);
    } else args.push(null);
    return mk("Slice", lineno, { start: args[0], stop: args[1], step: args[2] });
  }
  parseCallArgs(): { args: Node[]; kwargs: Node[]; dyn_args: Node | null; dyn_kwargs: Node | null } {
    const token = this.stream.expect("lparen");
    const args: Node[] = [];
    const kwargs: Node[] = [];
    let dynArgs: Node | null = null;
    let dynKwargs: Node | null = null;
    let requireComma = false;
    const ensure = (e: boolean) => {
      if (!e) this.fail("invalid syntax for function call expression", token.lineno);
    };
    while (this.stream.current.type !== "rparen") {
      if (requireComma) {
        this.stream.expect("comma");
        if (this.stream.current.type === "rparen") break;
      }
      if (this.stream.current.type === "mul") {
        ensure(dynArgs === null && dynKwargs === null);
        this.stream.next();
        dynArgs = this.parseExpression();
      } else if (this.stream.current.type === "pow") {
        ensure(dynKwargs === null);
        this.stream.next();
        dynKwargs = this.parseExpression();
      } else if (this.stream.current.type === "name" && this.stream.look().type === "assign") {
        ensure(dynKwargs === null);
        const key = this.stream.current.value;
        this.stream.skip(2);
        const value = this.parseExpression();
        kwargs.push(mk("Keyword", value.lineno, { key, value }));
      } else {
        ensure(dynArgs === null && dynKwargs === null && !kwargs.length);
        args.push(this.parseExpression());
      }
      requireComma = true;
    }
    this.stream.expect("rparen");
    return { args, kwargs, dyn_args: dynArgs, dyn_kwargs: dynKwargs };
  }
  parseCall(node: Node): Node {
    const token = this.stream.current;
    return mk("Call", token.lineno, { node, ...this.parseCallArgs() });
  }
  parseFilter(node: Node | null, startInline = false): Node | null {
    while (this.stream.current.type === "pipe" || startInline) {
      if (!startInline) this.stream.next();
      const token = this.stream.expect("name");
      let name = token.value as string;
      while (this.stream.current.type === "dot") {
        this.stream.next();
        name += "." + this.stream.expect("name").value;
      }
      const c = this.stream.current.type === "lparen" ? this.parseCallArgs() : { args: [], kwargs: [], dyn_args: null, dyn_kwargs: null };
      node = mk("Filter", token.lineno, { node, name, ...c });
      startInline = false;
    }
    return node;
  }
  parseTest(node: Node): Node {
    const token = this.stream.next();
    let negated = false;
    if (tokenTest(this.stream.current, "name:not")) {
      this.stream.next();
      negated = true;
    }
    let name = this.stream.expect("name").value as string;
    while (this.stream.current.type === "dot") {
      this.stream.next();
      name += "." + this.stream.expect("name").value;
    }
    let c: { args: Node[]; kwargs: Node[]; dyn_args: Node | null; dyn_kwargs: Node | null } = { args: [], kwargs: [], dyn_args: null, dyn_kwargs: null };
    if (this.stream.current.type === "lparen") c = this.parseCallArgs();
    else if (
      ["name", "string", "integer", "float", "lparen", "lbracket", "lbrace"].includes(this.stream.current.type) &&
      !["name:else", "name:or", "name:and"].some((e) => tokenTest(this.stream.current, e))
    ) {
      if (tokenTest(this.stream.current, "name:is")) this.fail("You cannot chain multiple tests with is");
      let arg = this.parsePrimary();
      arg = this.parsePostfix(arg);
      c.args = [arg];
    }
    let n = mk("Test", token.lineno, { node, name, ...c });
    if (negated) n = mk("Not", token.lineno, { node: n });
    return n;
  }
  subparse(endTokens: string[] | null = null): Node[] {
    const body: Node[] = [];
    const dataBuffer: Node[] = [];
    if (endTokens) this.endTokenStack.push(endTokens);
    const flush = () => {
      if (dataBuffer.length) {
        body.push(mk("Output", dataBuffer[0].lineno, { nodes: dataBuffer.slice() }));
        dataBuffer.length = 0;
      }
    };
    try {
      while (!this.stream.eos) {
        const token = this.stream.current;
        if (token.type === "data") {
          if (token.value) dataBuffer.push(mk("TemplateData", token.lineno, { data: token.value }));
          this.stream.next();
        } else if (token.type === "variable_begin") {
          this.stream.next();
          dataBuffer.push(this.parseTuple({ withCondexpr: true }));
          this.stream.expect("variable_end");
        } else if (token.type === "block_begin") {
          flush();
          this.stream.next();
          if (endTokens && endTokens.some((e) => tokenTest(this.stream.current, e))) return body;
          const rv = this.parseStatement();
          if (Array.isArray(rv)) body.push(...rv);
          else body.push(rv);
          this.stream.expect("block_end");
        } else throw new Error("internal parsing error");
      }
      flush();
    } finally {
      if (endTokens) this.endTokenStack.pop();
    }
    return body;
  }
  parse(): Node {
    return mk("Template", 1, { body: this.subparse() });
  }
}

export function parseTemplate(source: string): Node {
  return new Parser(source).parse();
}

// ---------------------------------------------------------------- 変数の範囲(idtracking.py)

type Load = ["param" | "resolve" | "alias" | "undefined", string | null];

class Symbols {
  level: number;
  refs = new Map<string, string>();
  loads = new Map<string, Load>();
  stores = new Set<string>();
  constructor(
    public parent: Symbols | null = null,
    level?: number,
  ) {
    this.level = level ?? (parent ? parent.level + 1 : 0);
  }
  analyzeNode(node: Node, kw: { forBranch?: string } = {}) {
    rootVisit(this, node, kw.forBranch ?? "body");
  }
  defineRef(name: string, load?: Load): string {
    const ident = `l_${this.level}_${name}`;
    this.refs.set(name, ident);
    if (load) this.loads.set(ident, load);
    return ident;
  }
  findLoad(target: string): Load | null {
    if (this.loads.has(target)) return this.loads.get(target)!;
    return this.parent ? this.parent.findLoad(target) : null;
  }
  findRef(name: string): string | null {
    if (this.refs.has(name)) return this.refs.get(name)!;
    return this.parent ? this.parent.findRef(name) : null;
  }
  ref(name: string): string {
    const rv = this.findRef(name);
    if (rv === null) throw new Error(`Tried to resolve a name to a reference that was unknown to the frame (${reprStr(name)})`);
    return rv;
  }
  copy(): Symbols {
    const rv = new Symbols(this.parent, this.level);
    rv.refs = new Map(this.refs);
    rv.loads = new Map(this.loads);
    rv.stores = new Set(this.stores);
    return rv;
  }
  store(name: string) {
    this.stores.add(name);
    if (!this.refs.has(name)) {
      if (this.parent) {
        const outer = this.parent.findRef(name);
        if (outer !== null) {
          this.defineRef(name, ["alias", outer]);
          return;
        }
      }
      this.defineRef(name, ["undefined", null]);
    }
  }
  declareParameter(name: string): string {
    this.stores.add(name);
    return this.defineRef(name, ["param", null]);
  }
  load(name: string) {
    if (this.findRef(name) === null) this.defineRef(name, ["resolve", name]);
  }
  branchUpdate(branches: Symbols[]) {
    const stores = new Set<string>();
    for (const b of branches) for (const s of b.stores) stores.add(s);
    for (const s of this.stores) stores.delete(s);
    for (const b of branches) {
      for (const [k, v] of b.refs) this.refs.set(k, v);
      for (const [k, v] of b.loads) this.loads.set(k, v);
      for (const s of b.stores) this.stores.add(s);
    }
    for (const name of stores) {
      const target = this.findRef(name)!;
      if (this.parent) {
        const outer = this.parent.findRef(name);
        if (outer !== null) {
          this.loads.set(target, ["alias", outer]);
          continue;
        }
      }
      this.loads.set(target, ["resolve", name]);
    }
  }
}

/** RootVisitor */
function rootVisit(sym: Symbols, node: Node, forBranch: string) {
  const v = new FrameSymbolVisitor(sym);
  switch (node.type) {
    case "Template":
    case "Block":
    case "Macro":
    case "FilterBlock":
    case "Scope":
    case "If":
    case "ScopedEvalContextModifier":
      for (const c of iterChildNodes(node)) v.visit(c);
      return;
    case "AssignBlock":
      for (const c of node.body) v.visit(c);
      return;
    case "CallBlock":
      for (const c of iterChildNodes(node, { exclude: ["call"] })) v.visit(c);
      return;
    case "For": {
      let branch: Node[];
      if (forBranch === "body") {
        v.visit(node.target, { storeAsParam: true });
        branch = node.body;
      } else if (forBranch === "else") branch = node.else_;
      else {
        v.visit(node.target, { storeAsParam: true });
        if (node.test) v.visit(node.test);
        return;
      }
      for (const item of branch) v.visit(item);
      return;
    }
    case "With":
      for (const t of node.targets) v.visit(t);
      for (const c of node.body) v.visit(c);
      return;
  }
  throw new Error(`Cannot find symbols for ${reprStr(node.type)}`);
}

class FrameSymbolVisitor {
  constructor(public symbols: Symbols) {}
  visit(node: Node, kw: { storeAsParam?: boolean } = {}) {
    switch (node.type) {
      case "Name":
        if (kw.storeAsParam || node.ctx === "param") this.symbols.declareParameter(node.name);
        else if (node.ctx === "store") this.symbols.store(node.name);
        else if (node.ctx === "load") this.symbols.load(node.name);
        return;
      case "NSRef":
        this.symbols.load(node.name);
        return;
      case "If": {
        this.visit(node.test, kw);
        const original = this.symbols;
        const inner = (nodes: Node[]) => {
          const rv = (this.symbols = original.copy());
          for (const n of nodes) this.visit(n, kw);
          this.symbols = original;
          return rv;
        };
        const b = inner(node.body);
        const e = inner(node.elif_);
        const el = inner(node.else_ ?? []);
        this.symbols.branchUpdate([b, e, el]);
        return;
      }
      case "Macro":
        this.symbols.store(node.name);
        return;
      case "Import":
        this.generic(node, kw);
        this.symbols.store(node.target);
        return;
      case "FromImport":
        this.generic(node, kw);
        for (const n of node.names) this.symbols.store(Array.isArray(n) ? n[1] : n);
        return;
      case "Assign":
        this.visit(node.node, kw);
        this.visit(node.target, kw);
        return;
      case "For":
        this.visit(node.iter, kw);
        return;
      case "CallBlock":
        this.visit(node.call, kw);
        return;
      case "FilterBlock":
        this.visit(node.filter, kw);
        return;
      case "With":
        for (const t of node.values) this.visit(t);
        return;
      case "AssignBlock":
        this.visit(node.target, kw);
        return;
      case "Scope":
      case "Block":
        return;
    }
    this.generic(node, kw);
  }
  generic(node: Node, kw: { storeAsParam?: boolean }) {
    for (const c of iterChildNodes(node)) this.visit(c, kw);
  }
}

/** compiler.find_undeclared */
function findUndeclared(nodes: Iterable<Node>, names: string[]): Set<string> {
  const want = new Set(names);
  const undeclared = new Set<string>();
  const exit = {};
  const visit = (n: Node) => {
    if (n.type === "Name") {
      if (n.ctx === "load" && want.has(n.name)) {
        undeclared.add(n.name);
        if (undeclared.size === want.size && [...want].every((x) => undeclared.has(x))) throw exit;
      } else want.delete(n.name);
      return;
    }
    if (n.type === "Block") return;
    for (const c of iterChildNodes(n)) visit(c);
  };
  try {
    for (const n of nodes) visit(n);
  } catch (e) {
    if (e !== exit) throw e;
  }
  return undeclared;
}

/** a, b = value(Python の展開)。 */
function unpack(v: PyVal, n: number): PyVal[] {
  if (!tryIter(v)) throw typeError(`cannot unpack non-iterable ${typeName(v)} object`);
  const items = toList(v);
  // list・tuple のときだけ「got N」が付く
  if (items.length > n) throw valueError(`too many values to unpack (expected ${n}${Array.isArray(v) || v instanceof PyTuple ? `, got ${items.length}` : ""})`);
  if (items.length < n) throw valueError(`not enough values to unpack (expected ${n}, got ${items.length})`);
  return items;
}

// ---------------------------------------------------------------- 実行時(runtime.py)

/**
 * テンプレートの関数(マクロ・recursive のループ)を 1 段呼ぶ。
 * エラーの行は一番内側の関数のものにし、ふつうに戻ったら呼んだ側の行に戻す。
 */
function withFrame<T>(rt: Run, f: () => T): T {
  const saved = rt.line;
  if (++rt.depth > 180) {
    rt.depth--;
    throw new PyException("RecursionError", "maximum recursion depth exceeded");
  }
  try {
    const rv = f();
    rt.line = saved;
    return rv;
  } catch (e) {
    if (e instanceof PyException && e.lineno === null) e.lineno = rt.line;
    throw e;
  } finally {
    rt.depth--;
  }
}

/** Python の関数 1 回分のローカル変数。入れ子の関数(マクロ)は外側を読める。 */
class Fn {
  vars = new Map<string, PyVal | typeof MISSING>();
  constructor(readonly parent: Fn | null) {}
  get(id: string): PyVal | typeof MISSING {
    const v = this.vars.get(id);
    if (v !== undefined) return v;
    return this.parent ? this.parent.get(id) : MISSING;
  }
  set(id: string, v: PyVal | typeof MISSING) {
    this.vars.set(id, v);
  }
}

type EvalCtx = { autoescape: boolean };

class Context {
  vars = new Map<string, PyVal>();
  exported = new Set<string>();
  blocks = new Map<string, BlockFn[]>();
  evalCtx: EvalCtx = { autoescape: false };
  constructor(
    readonly env: Environment,
    readonly parent: Map<string, PyVal>,
  ) {}
  resolveOrMissing(key: string): PyVal | typeof MISSING {
    if (this.vars.has(key)) return this.vars.get(key)!;
    if (this.parent.has(key)) return this.parent.get(key)!;
    return MISSING;
  }
  resolve(key: string): PyVal {
    const rv = this.resolveOrMissing(key);
    return rv === MISSING ? new Undefined(null, MISSING, key) : rv;
  }
}

type BlockFn = (ctx: Context, rt: Run) => string[];

/** 描画 1 回分の状態。 */
class Run {
  line = 1;
  depth = 0;
  /** {% generation %} の位置(transformers の return_assistant_tokens_mask)。 */
  generation: [number, number][] = [];
  rootOut: string[] | null = null;
  constructor(
    readonly ctx: Context,
    readonly now: Date,
  ) {}
}

class BreakSignal {}
class ContinueSignal {}
const BREAK = new BreakSignal();
const CONTINUE = new ContinueSignal();

export class LoopContext extends PyObject {
  index0 = -1;
  private length_: number | null = null;
  private after: PyVal | typeof MISSING = MISSING;
  private current: PyVal | typeof MISSING = MISSING;
  private before: PyVal | typeof MISSING = MISSING;
  private lastChanged: PyVal[] | typeof MISSING = MISSING;
  private iterator: Iterator<PyVal>;
  constructor(
    private iterable: PyVal,
    readonly recurse: ((it: PyVal, depth: number) => string) | null,
    readonly depth0: number,
  ) {
    super();
    this.iterator = iterOf(iterable);
  }
  get typeName() {
    return "LoopContext";
  }
  get typeModule() {
    return "jinja2.runtime";
  }
  get length(): number {
    if (this.length_ !== null) return this.length_;
    try {
      this.length_ = pyLen(this.iterable);
    } catch (e) {
      if (!(e instanceof PyException && e.pyType === "TypeError")) throw e;
      const rest: PyVal[] = [];
      for (;;) {
        const r = this.iterator.next();
        if (r.done) break;
        rest.push(r.value);
      }
      this.iterator = rest[Symbol.iterator]();
      this.length_ = rest.length + this.index0 + 1 + (this.after !== MISSING ? 1 : 0);
    }
    return this.length_;
  }
  private peek(): PyVal | typeof MISSING {
    if (this.after !== MISSING) return this.after;
    const r = this.iterator.next();
    this.after = r.done ? MISSING : r.value;
    return this.after;
  }
  next(): PyVal | typeof MISSING {
    let rv: PyVal;
    if (this.after !== MISSING) {
      rv = this.after;
      this.after = MISSING;
    } else {
      const r = this.iterator.next();
      if (r.done) return MISSING;
      rv = r.value;
    }
    this.index0++;
    this.before = this.current;
    this.current = rv;
    return rv;
  }
  repr() {
    return `<LoopContext ${this.index0 + 1}/${this.length}>`;
  }
  len() {
    return this.length;
  }
  getAttr(name: string): PyVal | typeof NOATTR {
    switch (name) {
      case "index0":
        return BigInt(this.index0);
      case "index":
        return BigInt(this.index0 + 1);
      case "revindex0":
        return BigInt(this.length - (this.index0 + 1));
      case "revindex":
        return BigInt(this.length - this.index0);
      case "first":
        return this.index0 === 0;
      case "last":
        return this.peek() === MISSING;
      case "length":
        return BigInt(this.length);
      case "depth":
        return BigInt(this.depth0 + 1);
      case "depth0":
        return BigInt(this.depth0);
      case "previtem":
        return this.index0 === 0 ? new Undefined("there is no previous item") : (this.before as PyVal);
      case "nextitem": {
        const rv = this.peek();
        return rv === MISSING ? new Undefined("there is no next item") : rv;
      }
      case "cycle":
        return new PyFunc("cycle", (args, kw) => {
          if (kw.size) throw typeError("LoopContext.cycle() got an unexpected keyword argument '" + [...kw.keys()][0] + "'");
          if (!args.length) throw typeError("no items for cycling given");
          return args[this.index0 % args.length];
        }, "<bound method LoopContext.cycle of " + this.repr() + ">", "method");
      case "changed":
        return new PyFunc("changed", (args, kw) => {
          if (kw.size) throw typeError("LoopContext.changed() got an unexpected keyword argument '" + [...kw.keys()][0] + "'");
          if (this.lastChanged === MISSING || !pyEq(new PyTuple(this.lastChanged), new PyTuple(args))) {
            this.lastChanged = args;
            return true;
          }
          return false;
        }, "<bound method LoopContext.changed of " + this.repr() + ">", "method");
    }
    return NOATTR;
  }
  get callable() {
    return (args: PyVal[], kw: Kw): PyVal => {
      const { v } = bindArgs("LoopContext.__call__", { params: ["iterable"] }, args, kw);
      if (!this.recurse) throw typeError("The loop must have the 'recursive' marker to be called recursively.");
      return this.recurse(v.get("iterable")!, this.depth0 + 1);
    };
  }
}

export class Macro extends PyObject {
  constructor(
    readonly name: string | null,
    readonly args: string[],
    readonly catchKwargs: boolean,
    readonly catchVarargs: boolean,
    readonly caller: boolean,
    readonly invoke: (args: (PyVal | typeof MISSING)[], rt: Run) => string,
    readonly rtRef: { rt: Run },
  ) {
    super();
  }
  get typeName() {
    return "Macro";
  }
  get typeModule() {
    return "jinja2.runtime";
  }
  repr() {
    return `<Macro ${this.name === null ? "anonymous" : reprStr(this.name)}>`;
  }
  getAttr(name: string): PyVal | typeof NOATTR {
    switch (name) {
      case "name":
        return this.name;
      case "arguments":
        return new PyTuple(this.args.slice());
      case "catch_kwargs":
        return this.catchKwargs;
      case "catch_varargs":
        return this.catchVarargs;
      case "caller":
        return this.caller;
    }
    return NOATTR;
  }
  get callable() {
    return (argsIn: PyVal[], kwIn: Kw): PyVal => {
      const rt = this.rtRef.rt;
      const kwargs = new Map(kwIn);
      const n = this.args.length;
      const args: (PyVal | typeof MISSING)[] = argsIn.slice(0, n);
      let foundCaller = false;
      if (args.length !== n) {
        for (const name of this.args.slice(args.length)) {
          let value: PyVal | typeof MISSING = MISSING;
          if (kwargs.has(name)) {
            value = kwargs.get(name)!;
            kwargs.delete(name);
          }
          if (name === "caller") foundCaller = true;
          args.push(value);
        }
      } else foundCaller = this.args.includes("caller");
      if (this.caller && !foundCaller) {
        let caller: PyVal = kwargs.has("caller") ? kwargs.get("caller")! : null;
        kwargs.delete("caller");
        if (caller === null) caller = new Undefined("No caller defined", MISSING, "caller");
        args.push(caller);
      }
      if (this.catchKwargs) args.push(new PyDict([...kwargs].map(([k, v]) => [k, v])));
      else if (kwargs.size) {
        if (kwargs.has("caller")) throw typeError(`macro ${reprStr(this.name ?? "None")} was invoked with two values for the special caller argument. This is most likely a bug.`);
        throw typeError(`macro ${reprStr(this.name ?? "None")} takes no keyword argument ${reprStr([...kwargs.keys()][0])}`);
      }
      if (this.catchVarargs) args.push(new PyTuple(argsIn.slice(n)));
      else if (argsIn.length > n) throw typeError(`macro ${reprStr(this.name ?? "None")} takes not more than ${n} argument(s)`);
      return withFrame(rt, () => {
        const rv = this.invoke(args, rt);
        return rt.ctx.evalCtx.autoescape ? new Markup(rv) : rv;
      });
    };
  }
}

/** transformers の TemplateNamespace(jinja2.utils.Namespace の子クラス)。 */
export class Namespace extends Namespaceish {
  attrs = new PyDict();
  get typeName() {
    return "TemplateNamespace";
  }
  get typeModule() {
    return "transformers.utils.chat_template_utils";
  }
  repr() {
    return `<Namespace ${this.attrs.repr()}>`;
  }
  getAttr(name: string): PyVal | typeof NOATTR {
    const v = this.attrs.get(name);
    return v === undefined ? NOATTR : v;
  }
  setItem(name: PyVal, value: PyVal) {
    checkNsName(name);
    this.attrs.set(name, value);
  }
  truthy() {
    return true;
  }
}
function checkNsName(name: PyVal) {
  if (typeof name === "string" && name.startsWith("_"))
    throw new PyException("SecurityError", `Chat templates cannot store underscore-prefixed attributes on a namespace, but got ${reprStr(name)}. Please rename the attribute.`);
}

class Cycler extends PyObject {
  pos = 0;
  constructor(readonly items: PyVal[]) {
    super();
    if (!items.length) throw new PyException("RuntimeError", "at least one item has to be provided");
  }
  get typeName() {
    return "Cycler";
  }
  get typeModule() {
    return "jinja2.utils";
  }
  getAttr(name: string): PyVal | typeof NOATTR {
    if (name === "items") return new PyTuple(this.items.slice());
    if (name === "pos") return BigInt(this.pos);
    if (name === "current") return this.items[this.pos];
    if (name === "next")
      return new PyFunc("next", () => {
        const rv = this.items[this.pos];
        this.pos = (this.pos + 1) % this.items.length;
        return rv;
      }, `<bound method Cycler.next of ${this.repr()}>`, "method");
    if (name === "reset")
      return new PyFunc("reset", () => {
        this.pos = 0;
        return null;
      }, `<bound method Cycler.reset of ${this.repr()}>`, "method");
    return NOATTR;
  }
}

class Joiner extends PyObject {
  used = false;
  constructor(readonly sep: string) {
    super();
  }
  get typeName() {
    return "Joiner";
  }
  get typeModule() {
    return "jinja2.utils";
  }
  getAttr(name: string): PyVal | typeof NOATTR {
    if (name === "sep") return this.sep;
    if (name === "used") return this.used;
    return NOATTR;
  }
  get callable() {
    return (): PyVal => {
      if (!this.used) {
        this.used = true;
        return "";
      }
      return this.sep;
    };
  }
}

/** 型(クラス)を表すもの(namespace・cycler・joiner)。 */
class PyClass extends PyObject {
  constructor(
    readonly qualname: string,
    readonly make: (args: PyVal[], kw: Kw) => PyVal,
  ) {
    super();
  }
  get typeName() {
    return "type";
  }
  repr() {
    return `<class '${this.qualname}'>`;
  }
  get callable() {
    return this.make;
  }
}

/** transformers の TemplateDict(dict(...) と dict.fromkeys(...) だけ使える)。 */
class TemplateDict extends PyObject {
  get typeName() {
    return "TemplateDict";
  }
  get typeModule() {
    return "transformers.utils.chat_template_utils";
  }
  repr() {
    return "<transformers.utils.chat_template_utils._cached_compile_jinja_template.<locals>.TemplateDict object at 0x0>";
  }
  get callable() {
    return (args: PyVal[], kw: Kw) => pyDictCtor(args, kw);
  }
  getAttr(name: string): PyVal | typeof NOATTR {
    if (name === "fromkeys")
      return new PyFunc("fromkeys", (args, kw) => {
        if (kw.size) throw typeError("dict.fromkeys() takes no keyword arguments");
        if (args.length < 1 || args.length > 2) throw typeError(`fromkeys expected at least 1 argument, got ${args.length}`);
        const val = args[1] ?? null;
        return new PyDict([...iterate(args[0])].map((k) => [k, val]));
      }, "<bound method _cached_compile_jinja_template.<locals>.TemplateDict.fromkeys of " + this.repr() + ">", "method");
    return NOATTR;
  }
}

function pyDictCtor(args: PyVal[], kw: Kw): PyDict {
  if (args.length > 1) throw typeError(`dict expected at most 1 argument, got ${args.length}`);
  const d = new PyDict();
  if (args.length) {
    const src = args[0];
    if (src instanceof PyDict) for (const [k, v] of src.entries()) d.set(k, v);
    else if (src instanceof Namespace) throw typeError("'TemplateNamespace' object is not iterable");
    else {
      let i = 0;
      for (const item of iterate(src)) {
        const it = tryIter(item);
        if (!it) throw typeError("object is not iterable");
        const pair = toList(item);
        if (pair.length !== 2) throw valueError(`dictionary update sequence element #${i} has length ${pair.length}; 2 is required`);
        d.set(pair[0], pair[1]);
        i++;
      }
    }
  }
  for (const [k, v] of kw) d.set(k, v);
  return d;
}

class TemplateReference extends PyObject {
  constructor(readonly ctx: Context) {
    super();
  }
  get typeName() {
    return "TemplateReference";
  }
  get typeModule() {
    return "jinja2.runtime";
  }
  repr() {
    return "<TemplateReference None>";
  }
  getItem(key: PyVal): PyVal {
    const blocks = typeof key === "string" ? this.ctx.blocks.get(key) : undefined;
    if (!blocks) throw new PyException("KeyError", repr(key));
    const fn = blocks[0];
    return new PyFunc(String(key), () => fn(this.ctx, curRun!).join(""), `<BlockReference ${reprStr(String(key))}>`, "BlockReference");
  }
}

// ---------------------------------------------------------------- sandbox(sandbox.py)

const UNSAFE = (obj: PyVal, attr: string) =>
  new Undefined(`access to attribute ${reprStr(attr)} of ${reprStr(typeName(obj))} object is unsafe.`, obj, attr, "SecurityError");

function isSafeAttribute(attr: string, value: PyVal): boolean {
  if (attr.startsWith("_")) return false;
  if (value instanceof PyFunc && value.unsafe) return false;
  return true;
}

/** SandboxedEnvironment.getattr */
export function sbGetattr(obj: PyVal, attr: string): PyVal {
  if (attr.startsWith("__") && attr.endsWith("__")) return UNSAFE(obj, attr);
  const v = getAttrRaw(obj, attr);
  if (v === NOATTR) {
    try {
      return getItemRaw(obj, attr);
    } catch (e) {
      if (!(e instanceof PyException && (e.pyType === "TypeError" || LOOKUP_ERRORS.has(e.pyType)))) throw e;
    }
    return new Undefined(null, obj, attr);
  }
  if (isSafeAttribute(attr, v)) return v;
  return UNSAFE(obj, attr);
}

/** SandboxedEnvironment.getitem */
export function sbGetitem(obj: PyVal, arg: PyVal): PyVal {
  try {
    return getItemRaw(obj, arg);
  } catch (e) {
    if (!(e instanceof PyException && (e.pyType === "TypeError" || LOOKUP_ERRORS.has(e.pyType)))) throw e;
    if (typeof arg === "string" || arg instanceof Markup) {
      const attr = strOf(arg);
      if (attr.startsWith("__") && attr.endsWith("__")) return UNSAFE(obj, attr);
      const v = getAttrRaw(obj, attr);
      if (v !== NOATTR) return isSafeAttribute(attr, v) ? v : UNSAFE(obj, attr);
    }
  }
  return new Undefined(null, obj, arg);
}

formatHooks.getattr = (o, n) => sbGetattr(o, n);
formatHooks.getitem = (o, k) => sbGetitem(o, k);

function callValue(fn: PyVal, args: PyVal[], kw: Kw): PyVal {
  if (fn instanceof PyObject) {
    const c = fn.callable;
    if (c) return c(args, kw);
  }
  throw typeError(`'${typeName(fn)}' object is not callable`);
}

// ---------------------------------------------------------------- フィルター(filters.py)

type FilterDef = { qual: string; spec: ParamSpec | "c1"; fn: (v: Map<string, PyVal>, rest: PyVal[], restKw: Kw, rt: Run) => PyVal };

const ignoreCase = (v: PyVal): PyVal => (typeof v === "string" ? v.toLowerCase() : v instanceof Markup ? new Markup(v.s.toLowerCase()) : v);

function prepareAttributeParts(attr: PyVal): PyVal[] {
  if (attr === null) return [];
  if (typeof attr === "string") return attr.split(".").map((x) => (/^\d+$/.test(x) && x !== "" ? BigInt(x) : x));
  return [attr];
}

function makeAttrgetter(attribute: PyVal, post: ((v: PyVal) => PyVal) | null = null, def: PyVal = null) {
  const parts = prepareAttributeParts(attribute);
  return (item: PyVal): PyVal => {
    for (const p of parts) {
      item = sbGetitem(item, p);
      if (def !== null && item instanceof Undefined) item = def;
    }
    return post ? post(item) : item;
  };
}

function makeMultiAttrgetter(attribute: PyVal, post: ((v: PyVal) => PyVal) | null) {
  const split: PyVal[] = typeof attribute === "string" ? attribute.split(",") : [attribute];
  const parts = split.map(prepareAttributeParts);
  return (item: PyVal): PyVal => {
    return parts.map((ps) => {
      let x = item;
      for (const p of ps) x = sbGetitem(x, p);
      return post ? post(x) : x;
    });
  };
}

/** sorted(items, key) の並べ替え(安定・< だけで比べる)。 */
/**
 * sorted(items, key=key, reverse=reverse)。CPython 3.14 の list.sort と同じ順で < を呼ぶ
 * (64 件未満は count_run + binarysort。比べられないときのエラーの文言まで同じになる)。
 */
function pySorted(items: PyVal[], key: (v: PyVal) => PyVal, reverse: boolean): PyVal[] {
  const keys = items.map(key);
  const a = keys.map((_, i) => i);
  if (reverse) a.reverse();
  const n = a.length;
  const lt = (i: number, j: number) => pyCompare("lt", keys[i], keys[j]);
  const rev = (from: number, to: number) => {
    for (let i = from, j = to - 1; i < j; i++, j--) [a[i], a[j]] = [a[j], a[i]];
  };
  if (n >= 2 && n < 64) {
    // count_run
    let r = 1;
    for (r = 1; r < n; r++) if (lt(a[r], a[r - 1])) break;
    if (r < n) {
      let done = false;
      if (r > 1) {
        if (lt(a[0], a[r - 1])) done = true;
        else rev(0, r);
      }
      if (!done) {
        r++;
        let neq = 0;
        const reverseLastNeq = () => {
          if (neq) {
            neq++;
            rev(r - neq, r);
            neq = 0;
          }
        };
        for (; r < n; r++) {
          if (lt(a[r], a[r - 1])) reverseLastNeq();
          else if (lt(a[r - 1], a[r])) break;
          else neq++;
        }
        reverseLastNeq();
        rev(0, r);
        for (; r < n; r++) if (lt(a[r], a[r - 1])) break;
      }
    }
    // binarysort
    for (let ok = r || 1; ok < n; ok++) {
      let L = 0;
      let R = ok;
      const pivot = a[ok];
      do {
        const M = (L + R) >> 1;
        if (lt(pivot, a[M])) R = M;
        else L = M + 1;
      } while (L < R);
      for (let M = ok; M > L; M--) a[M] = a[M - 1];
      a[L] = pivot;
    }
  } else if (n >= 64) {
    const sorted = mergeSort(a, (x, y) => (lt(y, x) ? 1 : lt(x, y) ? -1 : 0));
    a.splice(0, n, ...sorted);
  }
  if (reverse) a.reverse();
  return a.map((i) => items[i]);
}
function mergeSort<T>(a: T[], cmp: (x: T, y: T) => number): T[] {
  if (a.length <= 1) return a.slice();
  const mid = a.length >> 1;
  const l = mergeSort(a.slice(0, mid), cmp);
  const r = mergeSort(a.slice(mid), cmp);
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < l.length && j < r.length) {
    if (cmp(r[j], l[i]) < 0) out.push(r[j++]);
    else out.push(l[i++]);
  }
  return out.concat(l.slice(i), r.slice(j));
}

function softStr(v: PyVal): PyVal {
  return isStrLike(v) ? v : pyStr(v);
}

const gen = (label: string, g: () => Generator<PyVal>) => new PyIter(`generator object ${label}`, g());

function pyInt(v: PyVal, base: PyVal | null): bigint {
  if (isStrLike(v)) {
    const b = base === null ? 10 : Number(toBig(base as bigint));
    const r = parsePyInt(strOf(v), b);
    if (r === null) throw valueError(`invalid literal for int() with base ${b}: ${repr(v)}`);
    return r;
  }
  if (base !== null && !(isInt(base) && toBig(base) === 10n)) throw typeError("int() can't convert non-string with explicit base");
  if (isInt(v)) return toBig(v);
  if (typeof v === "number") {
    if (Number.isNaN(v)) throw valueError("cannot convert float NaN to integer");
    if (!Number.isFinite(v)) throw new PyException("OverflowError", "cannot convert float infinity to integer");
    return BigInt(Math.trunc(v));
  }
  if (v instanceof Undefined) v.fail();
  throw typeError(`int() argument must be a string, a bytes-like object or a real number, not '${typeName(v)}'`);
}

function pyFloat(v: PyVal): number {
  if (isStrLike(v)) {
    const r = parsePyFloat(strOf(v));
    if (r === null) throw valueError(`could not convert string to float: ${repr(v)}`);
    return r;
  }
  if (isInt(v)) return Number(toBig(v));
  if (typeof v === "number") return v;
  if (v instanceof Undefined) v.fail();
  throw typeError(`float() argument must be a string or a real number, not '${typeName(v)}'`);
}

function selectOrReject(rt: Run, value: PyVal, args: PyVal[], kw: Kw, mod: (x: boolean) => boolean, lookupAttr: boolean, label: string) {
  return gen(label, function* () {
    if (!truthy(value)) return;
    let transfunc = (x: PyVal) => x;
    let off = 0;
    if (lookupAttr) {
      if (!args.length) throw new PyException("FilterArgumentError", "Missing parameter for attribute name");
      transfunc = makeAttrgetter(args[0]);
      off = 1;
    }
    let func: (x: PyVal) => boolean;
    if (args.length > off) {
      const name = args[off];
      const rest = args.slice(1 + off);
      func = (item) => truthy(callTest(rt, name, item, rest, kw));
    } else func = truthy;
    for (const item of iterate(value)) if (mod(func(transfunc(item)))) yield item;
  });
}

function prepareMap(rt: Run, args: PyVal[], kw: Kw) {
  if (!args.length && kw.has("attribute")) {
    const k = new Map(kw);
    const attribute = k.get("attribute")!;
    k.delete("attribute");
    const def = k.has("default") ? k.get("default")! : null;
    k.delete("default");
    if (k.size) throw new PyException("FilterArgumentError", `Unexpected keyword argument ${reprStr([...k.keys()][0])}`);
    return makeAttrgetter(attribute, null, def);
  }
  if (!args.length) throw new PyException("FilterArgumentError", "map requires a filter argument");
  const name = args[0];
  const rest = args.slice(1);
  return (item: PyVal) => callFilter(rt, name, item, rest, kw);
}

const P = (params: string[], defaults: PyVal[] = [], extra: Partial<ParamSpec> = {}): ParamSpec => ({ params, defaults, ...extra });

const FILTERS: Record<string, FilterDef> = {
  abs: {
    qual: "abs",
    spec: "c1",
    fn: (v) => {
      const x = v.get("x")!;
      if (isInt(x)) {
        const b = toBig(x);
        return b < 0n ? -b : b;
      }
      if (typeof x === "number") return Math.abs(x);
      throw typeError(`bad operand type for abs(): '${typeName(x)}'`);
    },
  },
  attr: {
    qual: "do_attr",
    spec: P(["environment", "obj", "name"]),
    fn: (v) => {
      const obj = v.get("obj")!;
      const name = v.get("name")!;
      if (!isStrLike(name)) throw typeError("attribute name must be string, not '" + typeName(name) + "'");
      const n = strOf(name);
      if (getAttrRaw(obj, n) === NOATTR && !(obj instanceof Undefined)) return new Undefined(null, obj, n);
      return sbGetattr(obj, n);
    },
  },
  batch: {
    qual: "do_batch",
    spec: P(["value", "linecount", "fill_with"], [null]),
    fn: (v) =>
      gen("do_batch", function* () {
        const lc = v.get("linecount")!;
        const fill = v.get("fill_with")!;
        let tmp: PyVal[] = [];
        for (const item of iterate(v.get("value")!)) {
          if (pyEq(BigInt(tmp.length), lc)) {
            yield tmp;
            tmp = [];
          }
          tmp.push(item);
        }
        if (tmp.length) {
          if (fill !== null && pyCompare("lt", BigInt(tmp.length), lc)) {
            const n = Number(toBig(pySub(lc, BigInt(tmp.length)) as bigint));
            for (let k = 0; k < n; k++) tmp.push(fill);
          }
          yield tmp;
        }
      }),
  },
  capitalize: { qual: "do_capitalize", spec: P(["s"]), fn: (v) => pyCapitalize(strOf(softStr(v.get("s")!) as string)) },
  center: {
    qual: "do_center",
    spec: P(["value", "width"], [80n]),
    fn: (v) => callValue(sbGetattr(softStr(v.get("value")!), "center"), [v.get("width")!], new Map()),
  },
  count: { qual: "len", spec: "c1", fn: (v) => BigInt(pyLen(v.get("x")!)) },
  d: { qual: "do_default", spec: P(["value", "default_value", "boolean"], ["", false]), fn: (v) => doDefault(v) },
  default: { qual: "do_default", spec: P(["value", "default_value", "boolean"], ["", false]), fn: (v) => doDefault(v) },
  dictsort: {
    qual: "do_dictsort",
    spec: P(["value", "case_sensitive", "by", "reverse"], [false, "key", false]),
    fn: (v) => {
      const by = v.get("by")!;
      let pos: number;
      if (pyEq(by, "key")) pos = 0;
      else if (pyEq(by, "value")) pos = 1;
      else throw new PyException("FilterArgumentError", 'You can only sort by either "key" or "value"');
      const value = v.get("value")!;
      const items = callValue(sbGetattrRaw(value, "items"), [], new Map());
      const cs = truthy(v.get("case_sensitive")!);
      return pySorted(toList(items), (item) => {
        const x = (item as PyTuple).items[pos];
        return cs ? x : ignoreCase(x);
      }, truthy(v.get("reverse")!));
    },
  },
  e: { qual: "escape", spec: "c1", fn: (v) => escape(v.get("x")!) },
  escape: { qual: "escape", spec: "c1", fn: (v) => escape(v.get("x")!) },
  filesizeformat: {
    qual: "do_filesizeformat",
    spec: P(["value", "binary"], [false]),
    fn: (v) => {
      const bytes = pyFloat(v.get("value")!);
      const binary = truthy(v.get("binary")!);
      const base = binary ? 1024 : 1000;
      const prefixes = binary ? ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"] : ["kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
      if (bytes === 1) return "1 Byte";
      if (bytes < base) return `${pyInt(bytes, null)} Bytes`;
      let unit = 0;
      for (let i = 0; i < prefixes.length; i++) {
        unit = base ** (i + 2);
        if (bytes < unit) return `${fmtF1((base * bytes) / unit)} ${prefixes[i]}`;
      }
      return `${fmtF1((base * bytes) / unit)} ${prefixes[prefixes.length - 1]}`;
    },
  },
  first: {
    qual: "sync_do_first",
    spec: P(["environment", "seq"]),
    fn: (v) => {
      const r = iterOf(v.get("seq")!).next();
      return r.done ? new Undefined("No first item, sequence was empty.") : r.value;
    },
  },
  float: { qual: "do_float", spec: P(["value", "default"], [0]), fn: (v) => tryConv(() => pyFloat(v.get("value")!), v.get("default")!) },
  forceescape: { qual: "do_forceescape", spec: P(["value"]), fn: (v) => escape(pyStr(v.get("value")!)) },
  format: {
    qual: "do_format",
    spec: P(["value"], [], { varargs: true, varkw: true }),
    fn: (v, rest, restKw) => {
      if (rest.length && restKw.size) throw new PyException("FilterArgumentError", "can't handle positional and keyword arguments at the same time");
      const value = softStr(v.get("value")!) as string | Markup;
      return percentFormat(value, restKw.size ? new PyDict([...restKw]) : new PyTuple(rest));
    },
  },
  groupby: {
    qual: "sync_do_groupby",
    spec: P(["environment", "value", "attribute", "default", "case_sensitive"], [null, false]),
    fn: (v) => {
      const cs = truthy(v.get("case_sensitive")!);
      const expr = makeAttrgetter(v.get("attribute")!, cs ? null : ignoreCase, v.get("default")!);
      const sorted = pySorted(toList(v.get("value")!), expr, false);
      const out: PyTuple[] = [];
      for (const item of sorted) {
        const k = expr(item);
        const last = out[out.length - 1];
        if (last && pyEq(last.items[0], k)) (last.items[1] as PyVal[]).push(item);
        else out.push(new PyTuple([k, [item]], ["grouper", "list"]));
      }
      if (!cs) {
        const outExpr = makeAttrgetter(v.get("attribute")!, null, v.get("default")!);
        return out.map((g) => new PyTuple([outExpr((g.items[1] as PyVal[])[0]), g.items[1]], ["grouper", "list"]));
      }
      return out;
    },
  },
  indent: {
    qual: "do_indent",
    spec: P(["s", "width", "first", "blank"], [4n, false, false]),
    fn: (v) => {
      const width = v.get("width")!;
      const s = v.get("s")!;
      let indention: string;
      if (isStrLike(width)) indention = strOf(width);
      else indention = pyMul(" ", width) as string;
      const isM = s instanceof Markup;
      if (!isStrLike(s)) {
        // s += "\n"(list は文字ごとに足されてから splitlines で止まる)
        if (Array.isArray(s)) throw new PyException("AttributeError", "'list' object has no attribute 'splitlines'");
        try {
          pyAdd(s, "\n");
        } catch (e) {
          if (e instanceof PyException && e.pyType === "TypeError") throw typeError(e.message.replace("for +:", "for +=:"));
          throw e;
        }
        throw new PyException("AttributeError", `'${typeName(s)}' object has no attribute 'splitlines'`);
      }
      const str = strOf(s) + "\n";
      let rv: string;
      if (truthy(v.get("blank")!)) rv = splitlines(str, false).join("\n" + indention);
      else {
        const lines = splitlines(str, false);
        rv = lines.shift() ?? "";
        if (lines.length) rv += "\n" + lines.map((l) => (l ? indention + l : l)).join("\n");
      }
      if (truthy(v.get("first")!)) rv = indention + rv;
      return isM ? new Markup(rv) : rv;
    },
  },
  int: {
    qual: "do_int",
    spec: P(["value", "default", "base"], [0n, 10n]),
    fn: (v) => {
      const value = v.get("value")!;
      try {
        return isStrLike(value) ? pyInt(value, v.get("base")!) : pyInt(value, null);
      } catch (e) {
        if (!(e instanceof PyException && (e.pyType === "TypeError" || e.pyType === "ValueError"))) throw e;
        try {
          return pyInt(pyFloat(value), null);
        } catch (e2) {
          if (!(e2 instanceof PyException && ["TypeError", "ValueError", "OverflowError"].includes(e2.pyType))) throw e2;
          return v.get("default")!;
        }
      }
    },
  },
  items: {
    qual: "do_items",
    spec: P(["value"]),
    fn: (v) =>
      gen("do_items", function* () {
        const value = v.get("value")!;
        if (value instanceof Undefined) return;
        if (!(value instanceof PyDict)) throw typeError("Can only get item pairs from a mapping.");
        for (const [k, x] of value.entries()) yield new PyTuple([k, x]);
      }),
  },
  join: {
    qual: "sync_do_join",
    spec: P(["eval_ctx", "value", "d", "attribute"], ["", null]),
    fn: (v, _r, _k, rt) => {
      let items = [...iterate(v.get("value")!)];
      const attribute = v.get("attribute")!;
      if (attribute !== null) items = items.map(makeAttrgetter(attribute));
      const d = v.get("d")!;
      if (!rt.ctx.evalCtx.autoescape) return pyStr(d) + "" === "" ? items.map(pyStr).join("") : items.map(pyStr).join(pyStr(d));
      if (!(d instanceof Markup)) {
        const doEscape = items.some((x) => x instanceof Markup);
        const parts = items.map((x) => (x instanceof Markup ? x.s : doEscape ? escapeHtml(pyStr(x)) : pyStr(x)));
        return doEscape ? new Markup(parts.join(escapeHtml(pyStr(d)))) : parts.join(pyStr(d));
      }
      return new Markup(items.map((x) => (x instanceof Markup ? x.s : escapeHtml(pyStr(x)))).join(d.s));
    },
  },
  last: {
    qual: "do_last",
    spec: P(["environment", "seq"]),
    fn: (v) => {
      const items = reversedOf(v.get("seq")!, true);
      const r = iterOf(items).next();
      return r.done ? new Undefined("No last item, sequence was empty.") : r.value;
    },
  },
  length: { qual: "len", spec: "c1", fn: (v) => BigInt(pyLen(v.get("x")!)) },
  list: { qual: "sync_do_list", spec: P(["value"]), fn: (v) => toList(v.get("value")!) },
  lower: { qual: "do_lower", spec: P(["s"]), fn: (v) => strCall(softStr(v.get("s")!), "lower") },
  map: {
    qual: "sync_do_map",
    spec: P(["context", "value"], [], { varargs: true, varkw: true }),
    fn: (v, rest, restKw, rt) =>
      gen("sync_do_map", function* () {
        const value = v.get("value")!;
        if (!truthy(value)) return;
        const func = prepareMap(rt, rest, restKw);
        for (const item of iterate(value)) yield func(item);
      }),
  },
  max: {
    qual: "do_max",
    spec: P(["environment", "value", "case_sensitive", "attribute"], [false, null]),
    fn: (v) => minMax(v, 1),
  },
  min: {
    qual: "do_min",
    spec: P(["environment", "value", "case_sensitive", "attribute"], [false, null]),
    fn: (v) => minMax(v, -1),
  },
  pprint: { qual: "do_pprint", spec: P(["value"]), fn: (v) => pformat(v.get("value")!) },
  random: {
    qual: "do_random",
    spec: P(["context", "seq"]),
    fn: (v) => {
      const seq = v.get("seq")!;
      const n = pyLen(seq);
      if (!n) return new Undefined("No random item, sequence was empty.");
      return sbGetitemRaw(seq, BigInt(Math.floor(Math.random() * n)));
    },
  },
  reject: {
    qual: "sync_do_reject",
    spec: P(["context", "value"], [], { varargs: true, varkw: true }),
    fn: (v, rest, restKw, rt) => selectOrReject(rt, v.get("value")!, rest, restKw, (x) => !x, false, "select_or_reject"),
  },
  rejectattr: {
    qual: "sync_do_rejectattr",
    spec: P(["context", "value"], [], { varargs: true, varkw: true }),
    fn: (v, rest, restKw, rt) => selectOrReject(rt, v.get("value")!, rest, restKw, (x) => !x, true, "select_or_reject"),
  },
  replace: {
    qual: "do_replace",
    spec: P(["eval_ctx", "s", "old", "new", "count"], [null]),
    fn: (v, _r, _k, rt) => {
      let count = v.get("count")!;
      if (count === null) count = -1n;
      const s = v.get("s")!;
      const old = v.get("old")!;
      const nw = v.get("new")!;
      if (!rt.ctx.evalCtx.autoescape) {
        if (!isInt(count)) throw typeError(`'${typeName(count)}' object cannot be interpreted as an integer`);
        return pyReplace(pyStr(s), pyStr(old), pyStr(nw), Number(toBig(count)));
      }
      const sv = old instanceof Markup || (nw instanceof Markup && !(s instanceof Markup)) ? escape(s) : softStr(s);
      return callValue(sbGetattr(sv, "replace"), [softStr(old), softStr(nw), count], new Map());
    },
  },
  reverse: {
    qual: "do_reverse",
    spec: P(["value"]),
    fn: (v) => {
      const value = v.get("value")!;
      if (isStrLike(value)) return pySlice(value, null, null, -1n);
      return reversedOf(value, false);
    },
  },
  round: {
    qual: "do_round",
    spec: P(["value", "precision", "method"], [0n, "common"]),
    fn: (v) => {
      const method = v.get("method")!;
      if (!["common", "ceil", "floor"].some((m) => pyEq(m, method))) throw new PyException("FilterArgumentError", "method must be common, ceil or floor");
      const value = v.get("value")!;
      const prec = v.get("precision")!;
      if (!isInt(prec)) throw typeError(`'${typeName(prec)}' object cannot be interpreted as an integer`);
      const p = Number(toBig(prec));
      if (pyEq(method, "common")) {
        if (isInt(value)) return roundInt(toBig(value), p);
        if (typeof value === "number") return roundFloat(value, p);
        throw typeError(`type ${typeName(value)} doesn't define __round__ method`);
      }
      const scaled = pyMul(value, pyPow(10n, prec));
      const f = typeof scaled === "number" ? scaled : Number(toBig(scaled as bigint));
      if (typeof scaled !== "number" && !isInt(scaled)) throw typeError("must be real number, not " + typeName(scaled));
      const r = BigInt(pyEq(method, "ceil") ? Math.ceil(f) : Math.floor(f));
      return pyTrueDiv(r, pyPow(10n, prec));
    },
  },
  safe: { qual: "do_mark_safe", spec: P(["value"]), fn: (v) => (v.get("value") instanceof Markup ? v.get("value")! : new Markup(pyStr(v.get("value")!))) },
  select: {
    qual: "sync_do_select",
    spec: P(["context", "value"], [], { varargs: true, varkw: true }),
    fn: (v, rest, restKw, rt) => selectOrReject(rt, v.get("value")!, rest, restKw, (x) => x, false, "select_or_reject"),
  },
  selectattr: {
    qual: "sync_do_selectattr",
    spec: P(["context", "value"], [], { varargs: true, varkw: true }),
    fn: (v, rest, restKw, rt) => selectOrReject(rt, v.get("value")!, rest, restKw, (x) => x, true, "select_or_reject"),
  },
  slice: {
    qual: "sync_do_slice",
    spec: P(["value", "slices", "fill_with"], [null]),
    fn: (v) =>
      gen("sync_do_slice", function* () {
        const seq = toList(v.get("value")!);
        const slicesV = v.get("slices")!;
        if (!isInt(slicesV)) throw typeError(`unsupported operand type(s) for //: 'int' and '${typeName(slicesV)}'`);
        const slices = Number(toBig(slicesV));
        if (slices === 0) throw new PyException("ZeroDivisionError", "integer division or modulo by zero");
        const fill = v.get("fill_with")!;
        const length = seq.length;
        const per = Math.floor(length / slices);
        const extra = ((length % slices) + slices) % slices;
        let offset = 0;
        for (let n = 0; n < slices; n++) {
          const start = offset + n * per;
          if (n < extra) offset += 1;
          const end = offset + (n + 1) * per;
          const tmp = seq.slice(start, end);
          if (fill !== null && n >= extra) tmp.push(fill);
          yield tmp;
        }
      }),
  },
  sort: {
    qual: "do_sort",
    spec: P(["environment", "value", "reverse", "case_sensitive", "attribute"], [false, false, null]),
    fn: (v) => {
      const key = makeMultiAttrgetter(v.get("attribute")!, truthy(v.get("case_sensitive")!) ? null : ignoreCase);
      return pySorted(toList(v.get("value")!), key, truthy(v.get("reverse")!));
    },
  },
  string: { qual: "soft_str", spec: P(["s"]), fn: (v) => softStr(v.get("s")!) },
  striptags: { qual: "do_striptags", spec: P(["value"]), fn: (v) => new Markup(striptags(pyStr(v.get("value")!))).s },
  sum: {
    qual: "sync_do_sum",
    spec: P(["environment", "iterable", "attribute", "start"], [null, 0n]),
    fn: (v) => {
      let items = [...iterate(v.get("iterable")!)];
      const attribute = v.get("attribute")!;
      if (attribute !== null) items = items.map(makeAttrgetter(attribute));
      let acc: PyVal = v.get("start")!;
      if (isStrLike(acc)) throw typeError("sum() can't sum strings [use ''.join(seq) instead]");
      for (const x of items) acc = pyAdd(acc, x);
      return acc;
    },
  },
  title: {
    qual: "do_title",
    spec: P(["s"]),
    fn: (v) => {
      const s = pyStr(softStr(v.get("s")!));
      return s
        .split(new RegExp(`([-${PY_WS_CLASS.slice(1, -1)}({\\[<]+)`, "u"))
        .filter((x) => x)
        .map((item) => {
          const a = cps(item);
          return a[0].toUpperCase() + a.slice(1).join("").toLowerCase();
        })
        .join("");
    },
  },
  trim: {
    qual: "do_trim",
    spec: P(["value", "chars"], [null]),
    fn: (v) => callValue(sbGetattr(softStr(v.get("value")!), "strip"), [v.get("chars")!], new Map()),
  },
  truncate: {
    qual: "do_truncate",
    spec: P(["env", "s", "length", "killwords", "end", "leeway"], [255n, false, "...", null]),
    fn: (v) => {
      const s = v.get("s")!;
      const end = v.get("end")!;
      const length = v.get("length")!;
      let leeway = v.get("leeway")!;
      if (leeway === null) leeway = 5n;
      const endLen = BigInt(pyLen(end));
      if (!pyCompare("gteq", length, endLen)) throw new PyException("AssertionError", `expected length >= ${endLen}, got ${pyStr(length)}`);
      if (!pyCompare("gteq", leeway, 0n)) throw new PyException("AssertionError", `expected leeway >= 0, got ${pyStr(leeway)}`);
      if (pyCompare("lteq", BigInt(pyLen(s)), pyAdd(length, leeway))) return s;
      const cut = pySlice(s, null, pySub(length, endLen), null);
      if (truthy(v.get("killwords")!)) return pyAdd(cut, end);
      const parts = toList(callValue(sbGetattr(cut, "rsplit"), [" ", 1n], new Map()));
      return pyAdd(parts[0], end);
    },
  },
  unique: {
    qual: "sync_do_unique",
    spec: P(["environment", "value", "case_sensitive", "attribute"], [false, null]),
    fn: (v) =>
      gen("sync_do_unique", function* () {
        const getter = makeAttrgetter(v.get("attribute")!, truthy(v.get("case_sensitive")!) ? null : ignoreCase);
        const seen = new PyDict();
        for (const item of iterate(v.get("value")!)) {
          const key = getter(item);
          hashKey(key, "a set element");
          if (!seen.has(key)) {
            seen.set(key, null);
            yield item;
          }
        }
      }),
  },
  upper: { qual: "do_upper", spec: P(["s"]), fn: (v) => strCall(softStr(v.get("s")!), "upper") },
  urlencode: {
    qual: "do_urlencode",
    spec: P(["value"]),
    fn: (v) => {
      const value = v.get("value")!;
      if (isStrLike(value) || tryIter(value) === null) return urlQuote(value, false);
      const items = value instanceof PyDict ? value.entries().map(([a, b]) => new PyTuple([a, b])) : toList(value);
      return items
        .map((it) => {
          const [k, x] = unpack(it, 2);
          return `${urlQuote(k, true)}=${urlQuote(x, true)}`;
        })
        .join("&");
    },
  },
  urlize: {
    qual: "do_urlize",
    spec: P(["eval_ctx", "value", "trim_url_limit", "nofollow", "target", "rel", "extra_schemes"], [null, false, null, null, null]),
    fn: (v, _r, _k, rt) => {
      const relParts = new Set(pyStr(v.get("rel") ?? "").split(/\s+/).filter(Boolean));
      if (v.get("rel") === null) relParts.clear();
      if (truthy(v.get("nofollow")!)) relParts.add("nofollow");
      relParts.add("noopener");
      const rel = [...relParts].sort().join(" ") || null;
      const target = v.get("target")!;
      const extra = v.get("extra_schemes")!;
      const schemes = extra === null ? [] : toList(extra).map(pyStr);
      for (const sc of schemes) if (!/^[\p{L}\p{N}_.+-]{2,}:(\/){0,2}$/u.test(sc)) throw new PyException("FilterArgumentError", `${reprStr(sc)} is not a valid URI scheme prefix.`);
      const trim = v.get("trim_url_limit")!;
      const rv = urlize(pyStr(v.get("value")!), trim === null ? null : Number(toBig(trim as bigint)), rel, target === null ? null : pyStr(target), schemes);
      return rt.ctx.evalCtx.autoescape ? new Markup(rv) : rv;
    },
  },
  wordcount: { qual: "do_wordcount", spec: P(["s"]), fn: (v) => BigInt((pyStr(softStr(v.get("s")!)).match(/[\p{L}\p{N}_]+/gu) ?? []).length) },
  wordwrap: {
    qual: "do_wordwrap",
    spec: P(["environment", "s", "width", "break_long_words", "wrapstring", "break_on_hyphens"], [79n, true, null, true]),
    fn: (v) => {
      const ws = v.get("wrapstring") === null ? "\n" : pyStr(v.get("wrapstring")!);
      const s = v.get("s")!;
      if (s instanceof Undefined) s.fail();
      if (!isStrLike(s)) throw new PyException("AttributeError", `'${typeName(s)}' object has no attribute 'splitlines'`);
      const width = Number(toBig(v.get("width") as bigint));
      return splitlines(strOf(s), false)
        .map((line) => textwrap(line, width, truthy(v.get("break_long_words")!), truthy(v.get("break_on_hyphens")!)).join(ws))
        .join(ws);
    },
  },
  xmlattr: {
    qual: "do_xmlattr",
    spec: P(["eval_ctx", "d", "autospace"], [true]),
    fn: (v, _r, _k, rt) => {
      const d = v.get("d")!;
      const items: string[] = [];
      for (const it of toList(callValue(sbGetattrRaw(d, "items"), [], new Map()))) {
        const [key, value] = unpack(it, 2);
        if (value === null || value instanceof Undefined) continue;
        if (/[\s/>=]/.test(pyStr(key))) throw valueError(`Invalid character in attribute name: ${repr(key)}`);
        items.push(`${escape(key).s}="${escape(value).s}"`);
      }
      let rv = items.join(" ");
      if (truthy(v.get("autospace")!) && rv) rv = " " + rv;
      return rt.ctx.evalCtx.autoescape ? new Markup(rv) : rv;
    },
  },
  // transformers の上書き(HTML の文字をエスケープしない json.dumps)
  tojson: {
    qual: "_cached_compile_jinja_template.<locals>.tojson",
    spec: P(["x", "ensure_ascii", "indent", "separators", "sort_keys"], [false, null, null, false]),
    fn: (v) => {
      const indent = v.get("indent")!;
      let ind: string | null = null;
      if (indent !== null) {
        if (isStrLike(indent)) ind = strOf(indent);
        else if (isInt(indent)) ind = " ".repeat(Math.max(0, Number(toBig(indent))));
        else throw typeError(`can't multiply sequence by non-int of type '${typeName(indent)}'`);
      }
      let itemSep = ind === null ? ", " : ",";
      let keySep = ": ";
      const seps = v.get("separators")!;
      if (seps !== null) {
        const s = toList(seps);
        if (s.length !== 2) throw valueError(`${s.length > 2 ? "too many" : "not enough"} values to unpack (expected 2, got ${s.length})`);
        itemSep = pyStr(s[0]);
        keySep = pyStr(s[1]);
      }
      return jsonDumps(v.get("x")!, { ensureAscii: truthy(v.get("ensure_ascii")!), indent: ind, itemSep, keySep, sortKeys: truthy(v.get("sort_keys")!) });
    },
  },
};

const fmtF1 = (x: number) => {
  // f"{x:.1f}"
  const r = roundFloat(x, 1);
  const s = r.toFixed(1);
  return s;
};

function doDefault(v: Map<string, PyVal>) {
  const value = v.get("value")!;
  if (value instanceof Undefined || (truthy(v.get("boolean")!) && !truthy(value))) return v.get("default_value")!;
  return value;
}

function tryConv(f: () => PyVal, def: PyVal): PyVal {
  try {
    return f();
  } catch (e) {
    if (e instanceof PyException && (e.pyType === "TypeError" || e.pyType === "ValueError")) return def;
    throw e;
  }
}

function minMax(v: Map<string, PyVal>, dir: 1 | -1): PyVal {
  const items = [...iterate(v.get("value")!)];
  if (!items.length) return new Undefined("No aggregated item, sequence was empty.");
  const key = makeAttrgetter(v.get("attribute")!, truthy(v.get("case_sensitive")!) ? null : ignoreCase);
  let best = items[0];
  let bk = key(best);
  for (const x of items.slice(1)) {
    const k = key(x);
    if (dir === 1 ? pyCompare("gt", k, bk) : pyCompare("lt", k, bk)) {
      best = x;
      bk = k;
    }
  }
  return best;
}

function strCall(s: PyVal, m: string): PyVal {
  return callValue(sbGetattr(s, m), [], new Map());
}

/** getattr(obj, name)(sandbox を通さない。dict.items など)。 */
function sbGetattrRaw(obj: PyVal, name: string): PyVal {
  const v = getAttrRaw(obj, name);
  if (v === NOATTR) {
    if (obj instanceof Undefined) obj.fail();
    throw new PyException("AttributeError", `'${typeName(obj)}' object has no attribute '${name}'`);
  }
  return v;
}

function sbGetitemRaw(obj: PyVal, k: PyVal): PyVal {
  return getItemRaw(obj, k);
}

/** reversed(value)。逆にできないときは list にして逆に(do_reverse)。 */
function reversedOf(value: PyVal, strict: boolean): PyVal {
  if (Array.isArray(value)) return new PyIter("list_reverseiterator object", value.slice().reverse()[Symbol.iterator](), "list_reverseiterator");
  if (value instanceof PyTuple) return new PyIter("reversed object", value.items.slice().reverse()[Symbol.iterator](), "reversed");
  if (value instanceof PyRange) return new PyIter("range_iterator object", toList(value).reverse()[Symbol.iterator](), "range_iterator");
  if (value instanceof PyDict) return new PyIter("dict_reversekeyiterator object", value.keys().reverse()[Symbol.iterator](), "dict_reversekeyiterator");
  if (isStrLike(value)) return new PyIter("reversed object", cps(strOf(value)).reverse()[Symbol.iterator](), "reversed");
  if (value instanceof Undefined) return new PyIter("reversed object", [][Symbol.iterator](), "reversed");
  if (value instanceof DictView) return new PyIter(`${value.typeName.replace("dict_", "dict_reverse").replace(/s$/, "")}iterator object`, value.list().reverse()[Symbol.iterator](), "reversed");
  if (strict) throw typeError(`'${typeName(value)}' object is not reversible`);
  try {
    return toList(value).reverse();
  } catch (e) {
    if (e instanceof PyException && e.pyType === "TypeError") throw new PyException("FilterArgumentError", "argument must be iterable");
    throw e;
  }
}

// ---------------------------------------------------------------- テスト(tests.py)

type TestDef = { qual: string; spec: ParamSpec; fn: (v: Map<string, PyVal>, rt: Run) => PyVal };

const isMapping = (v: PyVal) => v instanceof PyDict;
const isSequence = (v: PyVal) => isStrLike(v) || Array.isArray(v) || v instanceof PyTuple || v instanceof PyDict || v instanceof PyRange || v instanceof Undefined;
const isCallable = (v: PyVal) => v instanceof PyObject && v.callable !== null;

const opTest = (qual: string, f: (a: PyVal, b: PyVal) => boolean): TestDef => ({ qual, spec: P(["a", "b"]), fn: (v) => f(v.get("a")!, v.get("b")!) });

const TESTS: Record<string, TestDef> = {
  odd: { qual: "test_odd", spec: P(["value"]), fn: (v) => pyEq(pyMod(v.get("value")!, 2n), 1n) },
  even: { qual: "test_even", spec: P(["value"]), fn: (v) => pyEq(pyMod(v.get("value")!, 2n), 0n) },
  divisibleby: { qual: "test_divisibleby", spec: P(["value", "num"]), fn: (v) => pyEq(pyMod(v.get("value")!, v.get("num")!), 0n) },
  defined: { qual: "test_defined", spec: P(["value"]), fn: (v) => !(v.get("value") instanceof Undefined) },
  undefined: { qual: "test_undefined", spec: P(["value"]), fn: (v) => v.get("value") instanceof Undefined },
  filter: { qual: "test_filter", spec: P(["env", "value"]), fn: (v) => typeof v.get("value") === "string" && (v.get("value") as string) in FILTERS },
  test: { qual: "test_test", spec: P(["env", "value"]), fn: (v) => typeof v.get("value") === "string" && (v.get("value") as string) in TESTS },
  none: { qual: "test_none", spec: P(["value"]), fn: (v) => v.get("value") === null },
  boolean: { qual: "test_boolean", spec: P(["value"]), fn: (v) => typeof v.get("value") === "boolean" },
  false: { qual: "test_false", spec: P(["value"]), fn: (v) => v.get("value") === false },
  true: { qual: "test_true", spec: P(["value"]), fn: (v) => v.get("value") === true },
  integer: { qual: "test_integer", spec: P(["value"]), fn: (v) => typeof v.get("value") === "bigint" },
  float: { qual: "test_float", spec: P(["value"]), fn: (v) => typeof v.get("value") === "number" },
  lower: { qual: "test_lower", spec: P(["value"]), fn: (v) => pyIsLower(pyStr(v.get("value")!)) },
  upper: { qual: "test_upper", spec: P(["value"]), fn: (v) => pyIsUpper(pyStr(v.get("value")!)) },
  string: { qual: "test_string", spec: P(["value"]), fn: (v) => isStrLike(v.get("value")!) },
  mapping: { qual: "test_mapping", spec: P(["value"]), fn: (v) => isMapping(v.get("value")!) },
  number: { qual: "test_number", spec: P(["value"]), fn: (v) => isNumber(v.get("value")!) },
  sequence: { qual: "test_sequence", spec: P(["value"]), fn: (v) => isSequence(v.get("value")!) },
  iterable: { qual: "test_iterable", spec: P(["value"]), fn: (v) => tryIter(v.get("value")!) !== null },
  callable: { qual: "callable", spec: P(["obj"]), fn: (v) => isCallable(v.get("obj")!) },
  sameas: { qual: "test_sameas", spec: P(["value", "other"]), fn: (v) => sameAs(v.get("value")!, v.get("other")!) },
  escaped: { qual: "test_escaped", spec: P(["value"]), fn: (v) => v.get("value") instanceof Markup },
  in: { qual: "test_in", spec: P(["value", "seq"]), fn: (v) => pyIn(v.get("value")!, v.get("seq")!) },
  "==": opTest("eq", pyEq),
  eq: opTest("eq", pyEq),
  equalto: opTest("eq", pyEq),
  "!=": opTest("ne", (a, b) => !pyEq(a, b)),
  ne: opTest("ne", (a, b) => !pyEq(a, b)),
  ">": opTest("gt", (a, b) => pyCompare("gt", a, b)),
  gt: opTest("gt", (a, b) => pyCompare("gt", a, b)),
  greaterthan: opTest("gt", (a, b) => pyCompare("gt", a, b)),
  ge: opTest("ge", (a, b) => pyCompare("gteq", a, b)),
  ">=": opTest("ge", (a, b) => pyCompare("gteq", a, b)),
  "<": opTest("lt", (a, b) => pyCompare("lt", a, b)),
  lt: opTest("lt", (a, b) => pyCompare("lt", a, b)),
  lessthan: opTest("lt", (a, b) => pyCompare("lt", a, b)),
  "<=": opTest("le", (a, b) => pyCompare("lteq", a, b)),
  le: opTest("le", (a, b) => pyCompare("lteq", a, b)),
};

function sameAs(a: PyVal, b: PyVal): boolean {
  if (a === null || b === null || typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (typeof a === "bigint" && typeof b === "bigint") return a === b;
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b);
  if (typeof a === "string" && typeof b === "string") return a === b;
  return a === b;
}

export const FILTER_NAMES = Object.keys(FILTERS);
export const TEST_NAMES = Object.keys(TESTS);

function runFilterDef(def: FilterDef, name: string, args: PyVal[], kw: Kw, rt: Run): PyVal {
  if (def.spec === "c1") {
    if (kw.size) throw typeError(`${def.qual}() takes no keyword arguments`);
    if (args.length !== 1) throw typeError(`${def.qual}() takes exactly one argument (${args.length} given)`);
    return def.fn(new Map([["x", args[0]]]), [], new Map(), rt);
  }
  const { v, rest, restKw } = bindArgs(def.qual, def.spec, args, kw);
  void name;
  return def.fn(v, rest, restKw, rt);
}

/** フィルターの前に足す引数(pass_environment などで最初の引数になるもの)。 */
const passArg = (spec: ParamSpec | "c1"): PyVal[] => (spec !== "c1" && ["environment", "env", "context", "eval_ctx"].includes(spec.params[0]) ? [null] : []);

/** environment.call_filter(map などから) */
function callFilter(rt: Run, name: PyVal, value: PyVal, args: PyVal[], kw: Kw): PyVal {
  const def = typeof name === "string" ? FILTERS[name] : undefined;
  if (!def) throw new PyException("TemplateRuntimeError", `No filter named ${repr(name)}.`);
  return runFilterDef(def, name as string, [...passArg(def.spec), value, ...args], kw, rt);
}

/** environment.call_test(select などから) */
function callTest(rt: Run, name: PyVal, value: PyVal, args: PyVal[], kw: Kw): PyVal {
  const def = typeof name === "string" ? TESTS[name] : undefined;
  if (!def) throw new PyException("TemplateRuntimeError", `No test named ${repr(name)}.`);
  const pre = ["env"].includes(def.spec.params[0]) ? [null] : [];
  const { v } = bindArgs(def.qual, def.spec, [...pre, value, ...args], kw);
  return def.fn(v, rt);
}

// ---------------------------------------------------------------- グローバル

let curRun: Run | null = null;

const LOREM_WORDS =
  "a ac accumsan ad adipiscing aenean aliquam aliquet amet ante aptent arcu at auctor augue bibendum blandit class commodo condimentum congue consectetuer consequat conubia convallis cras cubilia cum curabitur curae cursus dapibus diam dictum dictumst dignissim dis dolor donec dui duis egestas eget eleifend elementum elit enim erat eros est et etiam eu euismod facilisi facilisis fames faucibus felis fermentum feugiat fringilla fusce gravida habitant habitasse hac hendrerit hymenaeos iaculis id imperdiet in inceptos integer interdum ipsum justo lacinia lacus laoreet lectus leo libero ligula litora lobortis lorem luctus maecenas magna magnis malesuada massa mattis mauris metus mi molestie mollis montes morbi mus nam nascetur natoque nec neque netus nibh nisi nisl non nonummy nostra nulla nullam nunc odio orci ornare parturient pede pellentesque penatibus per pharetra phasellus placerat platea porta porttitor posuere potenti praesent pretium primis proin pulvinar purus quam quis quisque rhoncus ridiculus risus rutrum sagittis sapien scelerisque sed sem semper senectus sit sociis sociosqu sodales sollicitudin suscipit suspendisse taciti tellus tempor tempus tincidunt torquent tortor tristique turpis ullamcorper ultrices ultricies urna ut varius vehicula vel velit venenatis vestibulum vitae vivamus viverra volutpat vulputate".split(
    " ",
  );

function lipsum(n: number, html: boolean, min: number, max: number): string {
  const rand = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));
  const result: string[] = [];
  for (let k = 0; k < n; k++) {
    let nextCap = true;
    let lastComma = 0;
    let lastStop = 0;
    let last: string | null = null;
    const p: string[] = [];
    const count = rand(min, max);
    for (let idx = 0; idx < count; idx++) {
      let word: string;
      do word = LOREM_WORDS[Math.floor(Math.random() * LOREM_WORDS.length)];
      while (word === last);
      last = word;
      if (nextCap) {
        word = pyCapitalize(word);
        nextCap = false;
      }
      if (idx - rand(3, 8) > lastComma) {
        lastComma = idx;
        lastStop += 2;
        word += ",";
      }
      if (idx - rand(10, 20) > lastStop) {
        lastComma = lastStop = idx;
        word += ".";
        nextCap = true;
      }
      p.push(word);
    }
    let s = p.join(" ");
    if (s.endsWith(",")) s = s.slice(0, -1) + ".";
    else if (!s.endsWith(".")) s += ".";
    result.push(html ? `<p>${escapeHtml(s)}</p>` : s);
  }
  return html ? result.join("\n") : result.join("\n\n");
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** datetime.now().strftime(format)(C ロケール)。 */
export function strftime(d: Date, fmt: string): string {
  const pad = (n: number, w = 2, c = "0") => String(n).padStart(w, c);
  const doy = Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / 86400000) + 1;
  const wd = d.getDay();
  const h12 = d.getHours() % 12 || 12;
  const off = -d.getTimezoneOffset();
  const isoWeek = () => {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y = t.getUTCFullYear();
    const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
    return { y, w };
  };
  const one = (c: string, flag: string): string | null => {
    const strip = (s: string) => (flag === "-" ? s.replace(/^[0 ]+(?=.)/, "") : s);
    switch (c) {
      case "a":
        return DAYS[wd].slice(0, 3);
      case "A":
        return DAYS[wd];
      case "w":
        return String(wd);
      case "u":
        return String(wd || 7);
      case "d":
        return strip(pad(d.getDate()));
      case "e":
        return strip(pad(d.getDate(), 2, " "));
      case "b":
      case "h":
        return MONTHS[d.getMonth()].slice(0, 3);
      case "B":
        return MONTHS[d.getMonth()];
      case "m":
        return strip(pad(d.getMonth() + 1));
      case "y":
        return strip(pad(d.getFullYear() % 100));
      case "Y":
        return String(d.getFullYear());
      case "C":
        return pad(Math.floor(d.getFullYear() / 100));
      case "H":
        return strip(pad(d.getHours()));
      case "I":
        return strip(pad(h12));
      case "k":
        return pad(d.getHours(), 2, " ");
      case "l":
        return pad(h12, 2, " ");
      case "p":
        return d.getHours() < 12 ? "AM" : "PM";
      case "M":
        return strip(pad(d.getMinutes()));
      case "S":
        return strip(pad(d.getSeconds()));
      case "f":
        return pad(d.getMilliseconds() * 1000, 6);
      case "z":
        return (off >= 0 ? "+" : "-") + pad(Math.floor(Math.abs(off) / 60)) + pad(Math.abs(off) % 60);
      case "Z":
        return "";
      case "j":
        return strip(pad(doy, 3));
      case "U":
        return pad(Math.floor((doy + 6 - wd) / 7));
      case "W":
        return pad(Math.floor((doy + 6 - ((wd + 6) % 7)) / 7));
      case "G":
        return String(isoWeek().y);
      case "g":
        return pad(isoWeek().y % 100);
      case "V":
        return pad(isoWeek().w);
      case "c":
        return `${DAYS[wd].slice(0, 3)} ${MONTHS[d.getMonth()].slice(0, 3)} ${pad(d.getDate(), 2, " ")} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`;
      case "x":
        return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getFullYear() % 100)}`;
      case "X":
      case "T":
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      case "D":
        return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getFullYear() % 100)}`;
      case "F":
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      case "R":
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      case "r":
        return `${pad(h12)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getHours() < 12 ? "AM" : "PM"}`;
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "s":
        return String(Math.floor(d.getTime() / 1000));
      case "%":
        return "%";
    }
    return null;
  };
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== "%") {
      out += fmt[i];
      continue;
    }
    let flag = "";
    let j = i + 1;
    if (fmt[j] === "-") {
      flag = "-";
      j++;
    }
    const r = fmt[j] === undefined ? null : one(fmt[j], flag);
    if (r === null) out += fmt.slice(i, j + 1);
    else out += r;
    i = j;
  }
  return out;
}

const fn = (name: string, f: (args: PyVal[], kw: Kw) => PyVal, reprText: string) => new PyFunc(name, f, reprText, "function");

function makeGlobals(getRun: () => Run): Map<string, PyVal> {
  const g = new Map<string, PyVal>();
  g.set(
    "range",
    fn("safe_range", (args, kw) => {
      if (kw.size) throw typeError("range() takes no keyword arguments");
      if (!args.length) throw typeError("range expected at least 1 argument, got 0");
      if (args.length > 3) throw typeError(`range expected at most 3 arguments, got ${args.length}`);
      for (const a of args) if (!isInt(a)) throw typeError(`'${typeName(a)}' object cannot be interpreted as an integer`);
      const n = args.map((a) => toBig(a as bigint));
      const [start, stop, step] = n.length === 1 ? [0n, n[0], 1n] : [n[0], n[1], n[2] ?? 1n];
      if (step === 0n) throw valueError("range() arg 3 must not be zero");
      const r = new PyRange(start, stop, step);
      if (r.length > 100000n) throw new PyException("OverflowError", "Range too big. The sandbox blocks ranges larger than MAX_RANGE (100000).");
      return r;
    }, "<function safe_range at 0x0>"),
  );
  g.set("dict", new TemplateDict());
  g.set(
    "lipsum",
    fn("generate_lorem_ipsum", (args, kw) => {
      const { v } = bindArgs("generate_lorem_ipsum", P(["n", "html", "min", "max"], [5n, true, 20n, 100n]), args, kw);
      return lipsum(Number(toBig(v.get("n") as bigint)), truthy(v.get("html")!), Number(toBig(v.get("min") as bigint)), Number(toBig(v.get("max") as bigint)));
    }, "<function generate_lorem_ipsum at 0x0>"),
  );
  g.set("cycler", new PyClass("jinja2.utils.Cycler", (args, kw) => {
    if (kw.size) throw typeError(`Cycler.__init__() got an unexpected keyword argument '${[...kw.keys()][0]}'`);
    return new Cycler(args);
  }));
  g.set("joiner", new PyClass("jinja2.utils.Joiner", (args, kw) => {
    const { v } = bindArgs("Joiner.__init__", P(["sep"], [", "]), args, kw);
    return new Joiner(pyStr(v.get("sep")!));
  }));
  g.set(
    "namespace",
    new PyClass("transformers.utils.chat_template_utils._cached_compile_jinja_template.<locals>.TemplateNamespace", (args, kw) => {
      const d = pyDictCtor(args, kw);
      const ns = new Namespace();
      for (const k of d.keys()) checkNsName(k);
      for (const [k, v] of d.entries()) ns.attrs.set(k, v);
      return ns;
    }),
  );
  g.set(
    "raise_exception",
    fn("raise_exception", (args, kw) => {
      const { v } = bindArgs("_cached_compile_jinja_template.<locals>.raise_exception", P(["message"]), args, kw);
      throw new PyException("TemplateError", pyStr(v.get("message")!));
    }, "<function _cached_compile_jinja_template.<locals>.raise_exception at 0x0>"),
  );
  g.set(
    "strftime_now",
    fn("strftime_now", (args, kw) => {
      const { v } = bindArgs("_cached_compile_jinja_template.<locals>.strftime_now", P(["format"]), args, kw);
      const f = v.get("format")!;
      if (!isStrLike(f)) throw typeError(`strftime() argument 1 must be str, not ${typeName(f)}`);
      return strftime(getRun().now, strOf(f));
    }, "<function _cached_compile_jinja_template.<locals>.strftime_now at 0x0>"),
  );
  return g;
}

export const GLOBAL_NAMES = ["range", "dict", "lipsum", "cycler", "joiner", "namespace", "raise_exception", "strftime_now"];

// ---------------------------------------------------------------- コンパイル(compiler.py)

type Expr = (f: Fn, rt: Run) => PyVal;
type Stmt = (f: Fn, rt: Run, out: string[]) => void;

class Frame {
  symbols: Symbols;
  toplevel = false;
  rootlevel = false;
  loopFrame = false;
  blockFrame = false;
  softFrame = false;
  /** Python の関数の中で for の中にいるか(break・continue の確認)。 */
  inLoop = false;
  constructor(parent: Frame | null = null, level?: number) {
    this.symbols = parent ? new Symbols(parent.symbols, level) : new Symbols(null, level);
    if (parent) this.inLoop = parent.inLoop;
  }
  copy(): Frame {
    const rv = Object.create(Frame.prototype) as Frame;
    Object.assign(rv, this);
    rv.symbols = this.symbols.copy();
    return rv;
  }
  inner(isolated = false): Frame {
    if (isolated) return new Frame(null, this.symbols.level + 1);
    return new Frame(this);
  }
  soft(): Frame {
    const rv = this.copy();
    rv.rootlevel = false;
    rv.softFrame = true;
    return rv;
  }
}

function concatOut(out: string[]) {
  return out.join("");
}

const IMPOSSIBLE: unique symbol = Symbol("impossible");
/** pass_context のフィルター(as_const で畳まれない)。 */
const CONTEXT_FILTERS = new Set(["map", "select", "reject", "selectattr", "rejectattr", "random"]);

/** compiler.has_safe_repr */
function hasSafeRepr(v: PyVal): boolean {
  if (v === null || typeof v !== "object") return true;
  if (Array.isArray(v)) return v.every(hasSafeRepr);
  if (v instanceof PyTuple) return v.items.every(hasSafeRepr);
  if (v instanceof PyDict) return v.entries().every(([k, x]) => hasSafeRepr(k) && hasSafeRepr(x));
  return v instanceof Markup || v instanceof PyRange || v.typeName === "complex";
}

/** compiler.py で @optimizeconst が付いている visit_*。 */
const FOLDED_TYPES = new Set(["Add", "Sub", "Mul", "Div", "FloorDiv", "Pow", "Mod", "And", "Or", "Not", "Neg", "Pos", "Concat", "Compare", "Getattr", "Getitem", "Filter", "Test", "CondExpr", "Call"]);

/** 畳んだ定数は Python では毎回新しく作られる(repr を書き出すため)。 */
function copyConst(v: PyVal): PyVal {
  if (Array.isArray(v)) return v.map(copyConst);
  if (v instanceof PyTuple) return new PyTuple(v.items.map(copyConst), v.names);
  if (v instanceof PyDict) return new PyDict(v.entries().map(([k, x]) => [copyConst(k), copyConst(x)]));
  return v;
}

class Compiler {
  blocks = new Map<string, Node>();
  /** as_const の計算中(コンパイル時の定数畳み込み)。 */
  constMode = false;
  /**
   * 生成される Python コードで直前に記録された行(debug_info)。エラーの行番号はこれで決まるので、
   * compiler.py が writeline(…, node)・newline(node) を呼ぶ所で同じように進める。
   */
  curLine = 1;
  rec(n: number) {
    if (!this.constMode) this.curLine = n;
  }
  autoescapeDepth = 0;
  assignStack: Set<string>[] = [];
  undeclared = new Set<string>();
  hasExtends = false;

  fail(msg: string, lineno: number): never {
    throw syntaxError(msg, lineno, "TemplateAssertionError");
  }

  /** この節そのものに as_const があるか(子は見ない)。 */
  constNodeOk(n: Node): boolean {
    switch (n.type) {
      case "Name":
      case "Call":
      case "NSRef":
      case "ExtensionAttribute":
        return false;
      case "Filter":
        return !!n.node && !!FILTERS[n.name] && !CONTEXT_FILTERS.has(n.name);
      case "Test":
        return !!TESTS[n.name];
    }
    return true;
  }

  /** as_const の値(できなければ IMPOSSIBLE)。safeOnly のときは Const.from_untrusted と同じく安全な値だけ。 */
  tryConst(n: Node, safeOnly: boolean): PyVal | typeof IMPOSSIBLE {
    if (this.constMode || n.type === "Name") return IMPOSSIBLE;
    this.constMode = true;
    let e: Expr;
    try {
      e = this.visitExpr(n, new Frame());
    } catch {
      return IMPOSSIBLE;
    } finally {
      this.constMode = false;
    }
    try {
      const rt = new Run(new Context(new Environment(), new Map()), new Date());
      const prev = curRun;
      curRun = rt;
      try {
        const v = e(new Fn(null), rt);
        if (safeOnly && !hasSafeRepr(v)) return IMPOSSIBLE;
        return v;
      } finally {
        curRun = prev;
      }
    } catch {
      return IMPOSSIBLE;
    }
  }

  // enter_frame: 実行時に読み込みをする関数を返す(meta.find_undeclared_variables 用の記録もする)
  enterFrame(frame: Frame): (f: Fn, rt: Run) => void {
    const ops: [string, Load][] = [...frame.symbols.loads];
    for (const [, [action, param]] of ops) if (action === "resolve" && !GLOBAL_NAMES.includes(param!)) this.undeclared.add(param!);
    return (f, rt) => {
      for (const [target, [action, param]] of ops) {
        if (action === "resolve") f.set(target, rt.ctx.resolveOrMissing(param!));
        else if (action === "alias") f.set(target, f.get(param!));
        else if (action === "undefined") f.set(target, MISSING);
      }
    };
  }
  leaveFrame(frame: Frame, withPythonScope = false): (f: Fn) => void {
    if (withPythonScope) return () => {};
    const targets = [...frame.symbols.loads.keys()];
    return (f) => {
      for (const t of targets) f.set(t, MISSING);
    };
  }

  compileTemplate(node: Node): { root: (rt: Run) => string[]; blocks: Map<string, BlockFn> } {
    this.hasExtends = [...findAll(node, "Extends")].length > 0;
    for (const b of findAll(node, "Block")) {
      if (this.blocks.has(b.name)) this.fail(`block ${reprStr(b.name)} defined twice`, b.lineno);
      this.blocks.set(b.name, b);
    }
    const frame = new Frame();
    let selfRef: string | null = null;
    if (findUndeclared(node.body, ["self"]).has("self")) selfRef = frame.symbols.declareParameter("self");
    frame.symbols.analyzeNode(node);
    frame.toplevel = frame.rootlevel = true;
    const enter = this.enterFrame(frame);
    const body = this.blockvisit(node.body, frame);
    const blockFns = new Map<string, BlockFn>();
    for (const [name, block] of this.blocks) {
      const bf = new Frame();
      bf.blockFrame = true;
      const und = findUndeclared(block.body, ["self", "super"]);
      let sref: string | null = null;
      if (und.has("self")) sref = bf.symbols.declareParameter("self");
      if (und.has("super")) bf.symbols.declareParameter("super");
      bf.symbols.analyzeNode(block);
      const benter = this.enterFrame(bf);
      const bbody = this.blockvisit(block.body, bf);
      const superRef = und.has("super") ? bf.symbols.ref("super") : null;
      blockFns.set(name, (ctx, rt) => {
        const f = new Fn(null);
        if (sref) f.set(sref, new TemplateReference(ctx));
        if (superRef) f.set(superRef, new Undefined(`there is no parent block called ${reprStr(name)}.`, MISSING, "super"));
        benter(f, rt);
        const out: string[] = [];
        bbody(f, rt, out);
        return out;
      });
    }
    return {
      root: (rt) => {
        const f = new Fn(null);
        if (selfRef) f.set(selfRef, new TemplateReference(rt.ctx));
        enter(f, rt);
        const out: string[] = [];
        rt.rootOut = out;
        body(f, rt, out);
        return out;
      },
      blocks: blockFns,
    };
  }

  blockvisit(nodes: Node[], frame: Frame): Stmt {
    const stmts = nodes.map((n) => this.visitStmt(n, frame));
    return (f, rt, out) => {
      for (const s of stmts) s(f, rt, out);
    };
  }

  visitStmt(node: Node, frame: Frame): Stmt {
    switch (node.type) {
      case "Output":
        return this.visitOutput(node, frame);
      case "For":
        return this.visitFor(node, frame);
      case "If":
        return this.visitIf(node, frame);
      case "Assign":
        return this.visitAssign(node, frame);
      case "AssignBlock":
        return this.visitAssignBlock(node, frame);
      case "Macro":
        return this.visitMacro(node, frame);
      case "CallBlock":
        return this.visitCallBlock(node, frame);
      case "FilterBlock":
        return this.visitFilterBlock(node, frame);
      case "With":
        return this.visitWith(node, frame);
      case "Scope": {
        const sf = frame.inner();
        sf.symbols.analyzeNode(node);
        const enter = this.enterFrame(sf);
        const body = this.blockvisit(node.body, sf);
        const leave = this.leaveFrame(sf);
        return (f, rt, out) => {
          enter(f, rt);
          body(f, rt, out);
          leave(f);
        };
      }
      case "ScopedEvalContextModifier": {
        const opt = node.options[0];
        const vline = this.curLine;
        const val = this.visitExpr(opt.value, frame);
        this.autoescapeDepth++;
        const body = this.blockvisit(node.body, frame);
        this.autoescapeDepth--;
        return (f, rt, out) => {
          const saved = rt.ctx.evalCtx.autoescape;
          rt.line = vline;
          rt.ctx.evalCtx.autoescape = truthy(val(f, rt));
          try {
            body(f, rt, out);
          } finally {
            rt.ctx.evalCtx.autoescape = saved;
          }
        };
      }
      case "Break":
      case "Continue": {
        if (!frame.inLoop) throw syntaxError(`'${node.type.toLowerCase()}' ${node.type === "Break" ? "outside loop" : "not properly in loop"}`, node.lineno, "SyntaxError");
        this.rec(node.lineno);
        const sig = node.type === "Break" ? BREAK : CONTINUE;
        return () => {
          throw sig;
        };
      }
      case "Block": {
        this.rec(node.lineno);
        const name = node.name;
        const required = node.required;
        const lineno = node.lineno;
        return (f, rt, out) => {
          rt.line = lineno;
          const blocks = rt.ctx.blocks.get(name)!;
          if (required && blocks.length <= 1) throw new PyException("TemplateRuntimeError", `Required block ${reprStr(name)} not found`);
          out.push(...blocks[0](rt.ctx, rt));
        };
      }
      case "Extends":
      case "Include":
      case "Import":
      case "FromImport": {
        if (node.type === "Extends" && !frame.toplevel) this.fail("cannot use extend from a non top-level scope", node.lineno);
        this.rec(node.lineno);
        const tpl = this.visitExpr(node.template, frame);
        const lineno = node.lineno;
        return (f, rt) => {
          rt.line = lineno;
          tpl(f, rt);
          throw typeError("no loader for this environment specified");
        };
      }
      case "ExprStmt": {
        const e = this.visitExpr(node.node, frame);
        return (f, rt) => void e(f, rt);
      }
    }
    throw new Error(`unknown statement ${node.type}`);
  }

  visitOutput(node: Node, frame: Frame): Stmt {
    // 定数の式はコンパイル時に計算して文字列にする(_output_child_to_const)
    const parts: (string | { e: Expr; lineno: number })[] = node.nodes.map((c: Node) => {
      if (c.type === "TemplateData") return c.data;
      if (!this.autoescapeDepth) {
        const v = this.tryConst(c, false);
        if (v !== IMPOSSIBLE) return pyStr(v);
      }
      this.rec(c.lineno);
      return { e: this.visitExpr(c, frame), lineno: c.lineno };
    });
    return (f, rt, out) => {
      for (const p of parts) {
        if (typeof p === "string") out.push(p);
        else {
          rt.line = p.lineno;
          const v = p.e(f, rt);
          out.push(rt.ctx.evalCtx.autoescape ? escape(v).s : pyStr(v));
        }
      }
    };
  }

  /** 代入先(Name・Tuple・NSRef)。 */
  visitTarget(node: Node, frame: Frame): (f: Fn, rt: Run, value: PyVal) => void {
    if (node.type === "Name") {
      if (node.ctx === "store" && (frame.toplevel || frame.loopFrame || frame.blockFrame) && this.assignStack.length) this.assignStack[this.assignStack.length - 1].add(node.name);
      const ref = frame.symbols.ref(node.name);
      return (f, _rt, v) => f.set(ref, v);
    }
    if (node.type === "Tuple") {
      const subs = node.items.map((n: Node) => this.visitTarget(n, frame));
      return (f, rt, v) => {
        const items = unpack(v, subs.length);
        subs.forEach((s: (f: Fn, rt: Run, v: PyVal) => void, i: number) => s(f, rt, items[i]));
      };
    }
    if (node.type === "NSRef") {
      const ref = frame.symbols.ref(node.name);
      const attr = node.attr;
      return (f, _rt, v) => {
        const ns = f.get(ref);
        (ns as Namespace).setItem(attr, v);
      };
    }
    throw new Error("bad target");
  }

  popAssignTracking(frame: Frame): ((f: Fn, rt: Run) => void) | null {
    const vars = this.assignStack.pop()!;
    if ((!frame.blockFrame && !frame.loopFrame && !frame.toplevel) || !vars.size) return null;
    if (frame.loopFrame || frame.blockFrame) return null;
    const names = [...vars].sort();
    const refs = names.map((n) => frame.symbols.ref(n));
    return (f, rt) => {
      names.forEach((n, i) => {
        const v = f.get(refs[i]);
        rt.ctx.vars.set(n, v as PyVal);
        if (!n.startsWith("_")) rt.ctx.exported.add(n);
      });
    };
  }

  visitAssign(node: Node, frame: Frame): Stmt {
    this.assignStack.push(new Set());
    const nsChecks: string[] = [];
    const seen = new Set<string>();
    for (const ns of [node.target, ...findAll(node.target, "NSRef")].filter((n) => n.type === "NSRef")) {
      if (seen.has(ns.name)) continue;
      seen.add(ns.name);
      nsChecks.push(frame.symbols.ref(ns.name));
    }
    // namespace の確認は newline(node) より前に書かれる
    const nsLine = this.curLine;
    this.rec(node.lineno);
    const target = this.visitTarget(node.target, frame);
    const value = this.visitExpr(node.node, frame);
    const post = this.popAssignTracking(frame);
    const lineno = node.lineno;
    return (f, rt) => {
      rt.line = nsLine;
      for (const r of nsChecks) if (!(f.get(r) instanceof Namespace)) throw new PyException("TemplateRuntimeError", "cannot assign attribute on non-namespace object");
      rt.line = lineno;
      target(f, rt, value(f, rt));
      if (post) post(f, rt);
    };
  }

  visitAssignBlock(node: Node, frame: Frame): Stmt {
    this.assignStack.push(new Set());
    const bf = frame.inner();
    bf.symbols.analyzeNode(node);
    const enter = this.enterFrame(bf);
    const body = this.blockvisit(node.body, bf);
    this.rec(node.lineno);
    const target = this.visitTarget(node.target, frame);
    const filter = node.filter ? this.visitFilter(node.filter, bf, true) : null;
    const post = this.popAssignTracking(frame);
    const leave = this.leaveFrame(bf);
    const lineno = node.lineno;
    return (f, rt) => {
      enter(f, rt);
      const buf: string[] = [];
      body(f, rt, buf);
      rt.line = lineno;
      const content: PyVal = rt.ctx.evalCtx.autoescape ? new Markup(concatOut(buf)) : concatOut(buf);
      let v = filter ? filter(f, rt, content) : content;
      if (rt.ctx.evalCtx.autoescape && !(v instanceof Markup)) v = new Markup(pyStr(v));
      target(f, rt, v);
      if (post) post(f, rt);
      leave(f);
    };
  }

  visitIf(node: Node, frame: Frame): Stmt {
    const ifFrame = frame.soft();
    this.rec(node.lineno);
    const branches: [Expr, Stmt, number][] = [[this.visitExpr(node.test, ifFrame), this.blockvisit(node.body, ifFrame), node.lineno]];
    for (const e of node.elif_) {
      this.rec(e.lineno);
      branches.push([this.visitExpr(e.test, ifFrame), this.blockvisit(e.body, ifFrame), e.lineno]);
    }
    const els = node.else_.length ? this.blockvisit(node.else_, ifFrame) : null;
    return (f, rt, out) => {
      for (const [t, b, ln] of branches) {
        rt.line = ln;
        if (truthy(t(f, rt))) return b(f, rt, out);
      }
      if (els) els(f, rt, out);
    };
  }

  visitFor(node: Node, frame: Frame): Stmt {
    const loopFrame = frame.inner();
    loopFrame.loopFrame = true;
    loopFrame.inLoop = true;
    const testFrame = frame.inner();
    const elseFrame = frame.inner();
    const extended = node.recursive || findUndeclared(iterChildNodes(node, { only: ["body"] }), ["loop"]).has("loop") || [...findAll(node, "Block")].some((b) => b.scoped);
    let loopRef: string | null = null;
    if (extended) loopRef = loopFrame.symbols.declareParameter("loop");
    loopFrame.symbols.analyzeNode(node, { forBranch: "body" });
    if (node.else_.length) elseFrame.symbols.analyzeNode(node, { forBranch: "else" });
    let testFn: ((f: Fn, rt: Run, it: PyVal) => PyVal) | null = null;
    if (node.test) {
      testFrame.symbols.analyzeNode(node, { forBranch: "test" });
      this.rec(node.test.lineno);
      const tenter = this.enterFrame(testFrame);
      const ttarget = this.visitTarget(node.target, loopFrame);
      // 目印として loop_frame の名前を使う(Python と同じ)
      const ttest = this.visitExpr(node.test, testFrame);
      const tread = this.visitExpr(node.target, loopFrame);
      const lineno = node.test.lineno;
      testFn = (outer, rt, iterable) => {
        const tf = new Fn(outer);
        const src = iterOf(iterable);
        let started = false;
        return new PyIter("generator object fiter", {
          next: (): IteratorResult<PyVal> => {
            if (!started) {
              tenter(tf, rt);
              started = true;
            }
            for (;;) {
              const r = src.next();
              if (r.done) return { value: undefined, done: true };
              ttarget(tf, rt, r.value);
              rt.line = lineno;
              if (truthy(ttest(tf, rt))) return { value: tread(tf, rt), done: false };
            }
          },
        });
      };
    }
    for (const n of findAll(node, "Name")) {
      if (n.ctx === "store" && n.name === "loop") this.fail("Can't assign to special loop variable in for-loop target", n.lineno);
    }
    if (node.target.type === "Name" && node.target.ctx === "store" && node.target.name === "loop") this.fail("Can't assign to special loop variable in for-loop target", node.target.lineno);
    this.rec(node.lineno);
    const target = this.visitTarget(node.target, loopFrame);
    const iterExpr = this.visitExpr(node.iter, frame);
    const enter = this.enterFrame(loopFrame);
    const body = this.blockvisit(node.body, loopFrame);
    const leave = this.leaveFrame(loopFrame, node.recursive && !node.else_.length);
    let elseRun: Stmt | null = null;
    if (node.else_.length) {
      const eenter = this.enterFrame(elseFrame);
      const ebody = this.blockvisit(node.else_, elseFrame);
      const eleave = this.leaveFrame(elseFrame);
      elseRun = (f, rt, out) => {
        eenter(f, rt);
        ebody(f, rt, out);
        eleave(f);
      };
    }
    // recursive のときは最後に yield loop(…) が node の行で書かれる
    if (node.recursive) this.rec(node.lineno);
    const lineno = node.lineno;
    // 1 回分のループ(recursive のときは関数になる)
    const runLoop = (f: Fn, rt: Run, out: string[], iterable: PyVal, recurse: ((it: PyVal, depth: number) => string) | null, depth: number) => {
      rt.line = lineno;
      const src = testFn ? testFn(f, rt, iterable) : iterable;
      let indicator = true;
      if (extended) {
        f.set(loopRef!, MISSING);
        const loop = new LoopContext(src, recurse, depth);
        for (;;) {
          rt.line = lineno;
          const item = loop.next();
          rt.line = lineno;
          if (item === MISSING) break;
          target(f, rt, item);
          f.set(loopRef!, loop);
          enter(f, rt);
          try {
            body(f, rt, out);
            indicator = false;
          } catch (e) {
            if (e === BREAK) break;
            if (e === CONTINUE) continue;
            throw e;
          }
        }
      } else {
        const it = iterOf(src);
        for (;;) {
          rt.line = lineno;
          const r = it.next();
          rt.line = lineno;
          if (r.done) break;
          target(f, rt, r.value);
          enter(f, rt);
          try {
            body(f, rt, out);
            indicator = false;
          } catch (e) {
            if (e === BREAK) break;
            if (e === CONTINUE) continue;
            throw e;
          }
        }
      }
      leave(f);
      if (elseRun && indicator) elseRun(f, rt, out);
    };
    if (node.recursive) {
      return (f, rt, out) => {
        const loopFn = (iterable: PyVal, depth: number): string =>
          withFrame(rt, () => {
            const lf = new Fn(f);
            const buf: string[] = [];
            runLoop(lf, rt, buf, iterable, loopFn, depth);
            return concatOut(buf);
          });
        rt.line = lineno;
        const v = iterExpr(f, rt);
        out.push(loopFn(v, 0));
      };
    }
    return (f, rt, out) => {
      rt.line = lineno;
      runLoop(f, rt, out, iterExpr(f, rt), null, 0);
    };
  }

  /** macro_body: マクロ・call ブロックの本体を関数にする。 */
  macroBody(node: Node, frame: Frame): { make: (f: Fn, rt: Run) => Macro; frame: Frame } {
    const mf = frame.inner();
    mf.inLoop = false;
    mf.symbols.analyzeNode(node);
    const args: string[] = [];
    let explicitCaller: number | null = null;
    const skip = new Set<string>();
    node.args.forEach((a: Node, i: number) => {
      if (a.name === "caller") explicitCaller = i;
      if (a.name === "kwargs" || a.name === "varargs") skip.add(a.name);
      args.push(mf.symbols.ref(a.name));
    });
    const und = findUndeclared(node.body, ["caller", "kwargs", "varargs"]);
    let accessesCaller = false;
    let accessesKwargs = false;
    let accessesVarargs = false;
    if (und.has("caller")) {
      if (explicitCaller !== null) {
        if (node.defaults[explicitCaller - node.args.length + node.defaults.length] === undefined || explicitCaller - node.args.length + node.defaults.length < 0)
          this.fail('When defining macros or call blocks the special "caller" argument must be omitted or be given a default.', node.lineno);
      } else args.push(mf.symbols.declareParameter("caller"));
      accessesCaller = true;
    }
    if (und.has("kwargs") && !skip.has("kwargs")) {
      args.push(mf.symbols.declareParameter("kwargs"));
      accessesKwargs = true;
    }
    if (und.has("varargs") && !skip.has("varargs")) {
      args.push(mf.symbols.declareParameter("varargs"));
      accessesVarargs = true;
    }
    mf.symbols.analyzeNode(node);
    this.rec(node.lineno);
    const enter = this.enterFrame(mf);
    // 既定値(引数が無いときに本体の中で計算する)
    const defaults: (Expr | null)[] = node.args.map((_: Node, i: number) => {
      const di = i - node.args.length + node.defaults.length;
      return di >= 0 ? this.visitExpr(node.defaults[di], mf) : null;
    });
    const argNames: string[] = node.args.map((a: Node) => a.name);
    const body = this.blockvisit(node.body, mf);
    const name = node.type === "Macro" ? node.name : null;
    const lineno = node.lineno;
    const make = (outer: Fn, rt0: Run): Macro => {
      const rtRef = { rt: rt0 };
      return new Macro(
        name,
        argNames,
        accessesKwargs,
        accessesVarargs,
        accessesCaller,
        (callArgs, rt) => {
          const mfn = new Fn(outer);
          args.forEach((ref, i) => mfn.set(ref, callArgs[i] === undefined ? MISSING : callArgs[i]));
          rt.line = lineno;
          enter(mfn, rt);
          argNames.forEach((an, i) => {
            const ref = args[i];
            if (mfn.get(ref) === MISSING) {
              rt.line = lineno;
              const d = defaults[i];
              mfn.set(ref, d ? d(mfn, rt) : new Undefined(`parameter ${reprStr(an)} was not provided`, MISSING, an));
            }
          });
          const buf: string[] = [];
          body(mfn, rt, buf);
          return concatOut(buf);
        },
        rtRef,
      );
    };
    return { make, frame: mf };
  }

  visitMacro(node: Node, frame: Frame): Stmt {
    const { make } = this.macroBody(node, frame);
    const ref = frame.symbols.ref(node.name);
    const top = frame.toplevel;
    const name = node.name;
    return (f, rt) => {
      const m = make(f, rt);
      if (top) {
        if (!name.startsWith("_")) rt.ctx.exported.add(name);
        rt.ctx.vars.set(name, m);
      }
      f.set(ref, m);
    };
  }

  visitCallBlock(node: Node, frame: Frame): Stmt {
    const { make } = this.macroBody(node, frame);
    this.rec(node.lineno);
    const call = this.visitCall(node.call, frame, true);
    const lineno = node.lineno;
    return (f, rt, out) => {
      const caller = make(f, rt);
      rt.line = lineno;
      const v = call(f, rt, caller);
      out.push(rt.ctx.evalCtx.autoescape ? escape(v).s : pyStr(v));
    };
  }

  visitFilterBlock(node: Node, frame: Frame): Stmt {
    const ff = frame.inner();
    ff.symbols.analyzeNode(node);
    const enter = this.enterFrame(ff);
    const body = this.blockvisit(node.body, ff);
    this.rec(node.lineno);
    const filter = this.visitFilter(node.filter, ff, true);
    const leave = this.leaveFrame(ff);
    const lineno = node.lineno;
    return (f, rt, out) => {
      enter(f, rt);
      const buf: string[] = [];
      body(f, rt, buf);
      rt.line = lineno;
      const content: PyVal = rt.ctx.evalCtx.autoescape ? new Markup(concatOut(buf)) : concatOut(buf);
      const v = filter(f, rt, content);
      out.push(rt.ctx.evalCtx.autoescape ? escape(v).s : pyStr(v));
      leave(f);
    };
  }

  visitWith(node: Node, frame: Frame): Stmt {
    const wf = frame.inner();
    wf.symbols.analyzeNode(node);
    const enter = this.enterFrame(wf);
    // 値は newline()(行の記録なし)で書かれるので、直前に記録された行になる
    const lineno = this.curLine;
    const pairs = node.targets.map((t: Node, i: number) => [this.visitTarget(t, wf), this.visitExpr(node.values[i], frame)] as const);
    const body = this.blockvisit(node.body, wf);
    const leave = this.leaveFrame(wf);
    return (f, rt, out) => {
      enter(f, rt);
      rt.line = lineno;
      for (const [t, e] of pairs) t(f, rt, e(f, rt));
      body(f, rt, out);
      leave(f);
    };
  }

  // ------------------------------------------------ 式

  visitExpr(node: Node, frame: Frame): Expr {
    // @optimizeconst: 定数に畳める式は(安全な値なら)コンパイル時の値にする
    if (!this.constMode && FOLDED_TYPES.has(node.type)) {
      const c = this.tryConst(node, true);
      if (c !== IMPOSSIBLE) return () => copyConst(c);
    }
    if (this.constMode && !this.constNodeOk(node)) {
      // as_const が Impossible になる所(実際に評価されたときだけ失敗する。CondExpr の選ばれない側は見ない)
      return () => {
        throw new PyException("Impossible", "");
      };
    }
    switch (node.type) {
      case "Name": {
        const ref = frame.symbols.ref(node.name);
        const name = node.name;
        return (f) => {
          const v = f.get(ref);
          return v === MISSING ? new Undefined(null, MISSING, name) : v;
        };
      }
      case "Const": {
        const v = node.value;
        return () => v;
      }
      case "TemplateData": {
        const v = node.data;
        return () => v;
      }
      case "Tuple": {
        const items = node.items.map((n: Node) => this.visitExpr(n, frame));
        return (f, rt) => new PyTuple(items.map((e: Expr) => e(f, rt)));
      }
      case "List": {
        const items = node.items.map((n: Node) => this.visitExpr(n, frame));
        return (f, rt) => items.map((e: Expr) => e(f, rt));
      }
      case "Dict": {
        const items = node.items.map((p: Node) => [this.visitExpr(p.key, frame), this.visitExpr(p.value, frame)] as const);
        return (f, rt) => {
          const d = new PyDict();
          for (const [k, v] of items) {
            const kv = k(f, rt);
            const vv = v(f, rt);
            d.set(kv, vv);
          }
          return d;
        };
      }
      case "Add":
      case "Sub":
      case "Mul":
      case "Div":
      case "FloorDiv":
      case "Pow":
      case "Mod": {
        const l = this.visitExpr(node.left, frame);
        const r = this.visitExpr(node.right, frame);
        const op = { Add: pyAdd, Sub: pySub, Mul: pyMul, Div: pyTrueDiv, FloorDiv: pyFloorDiv, Pow: pyPow, Mod: pyMod }[node.type as "Add"];
        if (node.type === "Pow" && !this.constMode) {
          // 左が負の定数に畳まれると、生成コードは (-3 ** x) になり Python では -(3 ** x) になる
          const lc = this.tryConst(node.left, true);
          const neg = lc !== IMPOSSIBLE && ((typeof lc === "bigint" && lc < 0n) || (typeof lc === "number" && (lc < 0 || Object.is(lc, -0))));
          if (neg && this.tryConst(node, true) === IMPOSSIBLE) {
            const pos = pyNeg(lc as PyVal);
            return (f, rt) => pyNeg(pyPow(pos, r(f, rt)));
          }
        }
        return (f, rt) => {
          const a = l(f, rt);
          return op(a, r(f, rt));
        };
      }
      case "And": {
        const l = this.visitExpr(node.left, frame);
        const r = this.visitExpr(node.right, frame);
        if (this.constMode)
          return (f, rt) => {
            const a = l(f, rt);
            const b = r(f, rt);
            return truthy(a) ? b : a;
          };
        return (f, rt) => {
          const a = l(f, rt);
          return truthy(a) ? r(f, rt) : a;
        };
      }
      case "Or": {
        const l = this.visitExpr(node.left, frame);
        const r = this.visitExpr(node.right, frame);
        if (this.constMode)
          return (f, rt) => {
            const a = l(f, rt);
            const b = r(f, rt);
            return truthy(a) ? a : b;
          };
        return (f, rt) => {
          const a = l(f, rt);
          return truthy(a) ? a : r(f, rt);
        };
      }
      case "Not": {
        const e = this.visitExpr(node.node, frame);
        return (f, rt) => !truthy(e(f, rt));
      }
      case "Neg": {
        const e = this.visitExpr(node.node, frame);
        return (f, rt) => pyNeg(e(f, rt));
      }
      case "Pos": {
        const e = this.visitExpr(node.node, frame);
        return (f, rt) => pyPos(e(f, rt));
      }
      case "Concat": {
        const parts = node.nodes.map((n: Node) => this.visitExpr(n, frame));
        return (f, rt) => {
          const vals = parts.map((p: Expr) => p(f, rt));
          if (rt.ctx.evalCtx.autoescape && vals.some((v: PyVal) => v instanceof Markup)) return new Markup(vals.map((v: PyVal) => escape(v).s).join(""));
          return vals.map(pyStr).join("");
        };
      }
      case "Compare": {
        const first = this.visitExpr(node.expr, frame);
        const ops = node.ops.map((o: Node) => [o.op as string, this.visitExpr(o.expr, frame)] as const);
        return (f, rt) => {
          let left = first(f, rt);
          for (const [op, e] of ops) {
            const right = e(f, rt);
            let ok: boolean;
            switch (op) {
              case "eq":
                ok = pyEq(left, right);
                break;
              case "ne":
                ok = !pyEq(left, right);
                break;
              case "in":
                ok = pyIn(left, right);
                break;
              case "notin":
                ok = !pyIn(left, right);
                break;
              default:
                ok = pyCompare(op as "lt", left, right);
            }
            if (!ok) return false;
            left = right;
          }
          return true;
        };
      }
      case "Getattr": {
        const obj = this.visitExpr(node.node, frame);
        const attr = node.attr;
        return (f, rt) => sbGetattr(obj(f, rt), attr);
      }
      case "Getitem": {
        const obj = this.visitExpr(node.node, frame);
        if (node.arg.type === "Slice") {
          const s = node.arg;
          const start = s.start ? this.visitExpr(s.start, frame) : null;
          const stop = s.stop ? this.visitExpr(s.stop, frame) : null;
          const step = s.step ? this.visitExpr(s.step, frame) : null;
          // as_const(コンパイル時の定数畳み込み)では environment.getitem を通る(エラーは Undefined になる)
          const folded = this.constMode;
          return (f, rt) => {
            const o = obj(f, rt);
            const a = start ? start(f, rt) : null;
            const b = stop ? stop(f, rt) : null;
            const c = step ? step(f, rt) : null;
            if (!folded) return pySlice(o, a, b, c);
            try {
              return pySlice(o, a, b, c);
            } catch (e) {
              if (e instanceof PyException && (e.pyType === "TypeError" || LOOKUP_ERRORS.has(e.pyType))) return new Undefined(null, o, new SliceObj(a, b, c));
              throw e;
            }
          };
        }
        const arg = this.visitExpr(node.arg, frame);
        return (f, rt) => {
          const o = obj(f, rt);
          return sbGetitem(o, arg(f, rt));
        };
      }
      case "Filter": {
        const fe = this.visitFilter(node, frame, false);
        return (f, rt) => fe(f, rt, null);
      }
      case "Test":
        return this.visitTest(node, frame);
      case "CondExpr": {
        const soft = frame.soft();
        const e1 = this.visitExpr(node.expr1, soft);
        const t = this.visitExpr(node.test, soft);
        const e2 = node.expr2 ? this.visitExpr(node.expr2, soft) : null;
        const pos = `line ${node.lineno}`;
        const constMode = this.constMode;
        return (f, rt) => {
          if (truthy(t(f, rt))) return e1(f, rt);
          if (e2) return e2(f, rt);
          if (constMode) throw new PyException("Impossible", "");
          return new Undefined(`the inline if-expression on ${pos} evaluated to false and no else section was defined.`);
        };
      }
      case "Call": {
        const c = this.visitCall(node, frame, false);
        return (f, rt) => c(f, rt, null);
      }
      case "ExtensionAttribute": {
        return () =>
          new PyFunc("_generation_support", (args, kw) => {
            const caller = kw.get("caller");
            const rt = curRun!;
            const rv = callValue(caller ?? null, [], new Map());
            const s = pyStr(rv);
            if (rt.rootOut) {
              const start = cpLen(rt.rootOut.join(""));
              rt.generation.push([start, start + cpLen(s)]);
            }
            void args;
            return rv;
          }, "<bound method AssistantTracker._generation_support>", "method");
      }
      case "NSRef": {
        const ref = frame.symbols.ref(node.name);
        const attr = node.attr;
        return (f) => sbGetattr(f.get(ref) as PyVal, attr);
      }
      case "Slice":
        throw new Error("slice outside getitem");
    }
    throw new Error(`unknown expression ${node.type}`);
  }

  /** 引数(signature)。 */
  signature(node: Node, frame: Frame): (f: Fn, rt: Run) => { args: PyVal[]; kw: Kw } {
    const args = node.args.map((n: Node) => this.visitExpr(n, frame));
    const kws = node.kwargs.map((k: Node) => [k.key as string, this.visitExpr(k.value, frame)] as const);
    const seen = new Set<string>();
    for (const [k] of kws) {
      if (seen.has(k)) throw syntaxError(`keyword argument repeated: ${k}`, node.lineno, "SyntaxError");
      seen.add(k);
    }
    const dynArgs = node.dyn_args ? this.visitExpr(node.dyn_args, frame) : null;
    const dynKwargs = node.dyn_kwargs ? this.visitExpr(node.dyn_kwargs, frame) : null;
    return (f, rt) => {
      const a = args.map((e: Expr) => e(f, rt));
      const kw: Kw = new Map();
      for (const [k, e] of kws) kw.set(k, e(f, rt));
      if (dynArgs) {
        const v = dynArgs(f, rt);
        if (!tryIter(v)) throw typeError(`Value after * must be an iterable, not ${typeName(v)}`);
        a.push(...toList(v));
      }
      if (dynKwargs) {
        const v = dynKwargs(f, rt);
        if (!(v instanceof PyDict)) throw typeError(`argument after ** must be a mapping, not ${typeName(v)}`);
        for (const [k, x] of v.entries()) {
          if (!isStrLike(k)) throw typeError("keywords must be strings");
          if (kw.has(strOf(k))) throw typeError(`got multiple values for keyword argument '${strOf(k)}'`);
          kw.set(strOf(k), x);
        }
      }
      return { args: a, kw };
    };
  }

  visitCall(node: Node, frame: Frame, forwardCaller: boolean): (f: Fn, rt: Run, caller: Macro | null) => PyVal {
    const callee = this.visitExpr(node.node, frame);
    const sig = this.signature(node, frame);
    return (f, rt, caller) => {
      const fnv = callee(f, rt);
      const { args, kw } = sig(f, rt);
      if (forwardCaller) {
        if (kw.has("caller")) throw typeError("got multiple values for keyword argument 'caller'");
        kw.set("caller", caller);
      }
      if (fnv instanceof PyFunc && fnv.unsafe) throw new PyException("SecurityError", `${fnv.repr()} is not safely callable`);
      return callValue(fnv, args, kw);
    };
  }

  /** フィルター。block のときは中身(文字列)を受け取る。 */
  visitFilter(node: Node, frame: Frame, fromBlock: boolean): (f: Fn, rt: Run, content: PyVal | null) => PyVal {
    const def = FILTERS[node.name];
    if (!def && !frame.softFrame) this.fail(`No filter named ${reprStr(node.name)}.`, node.lineno);
    // {% filter a|b %} や {% set x | a | b %} では、いちばん内側のフィルターが中身(文字列)を受け取る
    const bottomsAtNull = (n: Node | null): boolean => (n === null ? true : n.type === "Filter" ? bottomsAtNull(n.node) : false);
    const inner = node.node && node.node.type === "Filter" && bottomsAtNull(node.node) ? this.visitFilter(node.node, frame, fromBlock) : null;
    const value = node.node && !inner ? this.visitExpr(node.node, frame) : null;
    const sig = this.signature(node, frame);
    const name = node.name;
    return (f, rt, content) => {
      const v = inner ? inner(f, rt, content) : value ? value(f, rt) : content!;
      if (!def) throw new PyException("TemplateRuntimeError", `No filter named ${reprStr(name)} found.`);
      const { args, kw } = sig(f, rt);
      return runFilterDef(def, name, [...passArg(def.spec), v, ...args], kw, rt);
    };
  }

  visitTest(node: Node, frame: Frame): Expr {
    const def = TESTS[node.name];
    if (!def && !frame.softFrame) this.fail(`No test named ${reprStr(node.name)}.`, node.lineno);
    const value = this.visitExpr(node.node, frame);
    const sig = this.signature(node, frame);
    const name = node.name;
    return (f, rt) => {
      if (!def) throw new PyException("TemplateRuntimeError", `No test named ${reprStr(name)} found.`);
      const v = value(f, rt);
      const { args, kw } = sig(f, rt);
      const pre = def.spec.params[0] === "env" ? [null] : [];
      const { v: bound } = bindArgs(def.qual, def.spec, [...pre, v, ...args], kw);
      return def.fn(bound, rt);
    };
  }
}

class SliceObj extends PyObject {
  constructor(
    readonly start: PyVal,
    readonly stop: PyVal,
    readonly step: PyVal,
  ) {
    super();
  }
  get typeName() {
    return "slice";
  }
  repr() {
    return `slice(${repr(this.start)}, ${repr(this.stop)}, ${repr(this.step)})`;
  }
}

// ---------------------------------------------------------------- 環境とテンプレート

export class Environment {}

export type RenderResult = { output: string; generation: [number, number][] };

export class Template {
  private root: (rt: Run) => string[];
  private blocks: Map<string, BlockFn>;
  /** jinja2.meta.find_undeclared_variables と同じもの。 */
  readonly undeclared: string[];
  readonly ast: Node;
  constructor(readonly source: string) {
    this.ast = parseTemplate(source);
    const c = new Compiler();
    const r = c.compileTemplate(this.ast);
    this.root = r.root;
    this.blocks = r.blocks;
    this.undeclared = [...c.undeclared].sort();
  }
  /** 描画する。vars は render(**kwargs) に当たる。 */
  render(vars: Map<string, PyVal>, now: Date = new Date()): RenderResult {
    const env = new Environment();
    let rt: Run | null = null;
    const globals = makeGlobals(() => rt!);
    const parent = new Map(globals);
    for (const [k, v] of vars) parent.set(k, v);
    const ctx = new Context(env, parent);
    for (const [name, b] of this.blocks) ctx.blocks.set(name, [b]);
    rt = new Run(ctx, now);
    const prev = curRun;
    curRun = rt;
    try {
      const out = this.root(rt);
      return { output: out.join(""), generation: rt.generation };
    } catch (e) {
      if (e instanceof PyException) {
        if (e.lineno === null) e.lineno = rt.line;
        throw e;
      }
      if (e instanceof RangeError) {
        const ex = new PyException("RecursionError", "maximum recursion depth exceeded");
        ex.lineno = rt.line;
        throw ex;
      }
      throw e;
    } finally {
      curRun = prev;
    }
  }
}

/** テンプレートの文字列と文字列の定数(transformers の _get_template_literal_text)。 */
export function templateLiterals(ast: Node): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => {
    if (n.type === "TemplateData") out.add(n.data);
    if (n.type === "Const" && typeof n.value === "string") out.add(n.value);
    for (const c of iterChildNodes(n)) walk(c);
  };
  walk(ast);
  return [...out];
}

export { objectId, orderCmp };
