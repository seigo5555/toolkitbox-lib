/**
 * Go の text/template(Ollama の Modelfile の TEMPLATE が使うもの)を TypeScript に移したもの。
 * Go 1.26 の src/text/template の lex.go・parse.go・node.go・exec.go・funcs.go の動きをそのまま写した。
 * 位置(行・列)はバイト単位、エラーの文言も Go と同じ形にしてある。
 *
 * 値は reflect.Value に当たる GV で表す。型は Ollama のテンプレートに渡る型(string・int・float64・bool・
 * スライス・マップ・構造体・ポインター・interface{})だけを扱う。fmt の %v と encoding/json の出力も Go に合わせた。
 * scripts/check-ollama-template.ts で、Go 本物の text/template(Go 1.26.6)の出力と突き合わせている。
 *
 * 元のコードのライセンス(原文)は、toolkitbox-lib の THIRD_PARTY_NOTICES.md と、サイトの /licenses に載せている。
 */

// ---------------------------------------------------------------- 型と値

export type Kind = "invalid" | "bool" | "int" | "float64" | "string" | "slice" | "map" | "struct" | "ptr" | "iface";

export type JsonTag = { name: string; omitempty: boolean };
export type Field = { name: string; type: GoType; json?: JsonTag };

export type GoType = {
  /** Go の型名(%T やエラーに出るもの)。 */
  name: string;
  kind: Exclude<Kind, "invalid">;
  elem?: GoType;
  fields?: Field[];
  /** fmt.Stringer(値レシーバー)。 */
  stringer?: (v: GV) => string;
  /** json.Marshaler。詰めて HTML エスケープ済みの JSON を返す(json.Marshal がそうするので)。 */
  marshalJSON?: (v: GV) => string;
  /** テンプレートから呼べるメソッド(引数なし)。 */
  methods?: Record<string, (v: GV) => GV>;
  /** []byte のように、json で base64 になるもの。 */
  bytes?: boolean;
};

/** reflect.Value に当たるもの。 */
export class GV {
  constructor(
    readonly type: GoType | null,
    /** bool | number | string | GV[] | Map<string, GV> | GV | null */
    readonly v: unknown,
  ) {}
  get kind(): Kind {
    return this.type ? this.type.kind : "invalid";
  }
  get valid() {
    return this.type !== null;
  }
}

export const INVALID = new GV(null, null);

export const T_STRING: GoType = { name: "string", kind: "string" };
export const T_INT: GoType = { name: "int", kind: "int" };
export const T_FLOAT: GoType = { name: "float64", kind: "float64" };
export const T_BOOL: GoType = { name: "bool", kind: "bool" };
export const T_ANY: GoType = { name: "interface {}", kind: "iface" };
export const T_UINT8: GoType = { name: "uint8", kind: "int" };
export const sliceOf = (elem: GoType, name = `[]${elem.name}`): GoType => ({ name, kind: "slice", elem });
export const mapOf = (elem: GoType, name = `map[string]${elem.name}`): GoType => ({ name, kind: "map", elem });
export const ptrTo = (elem: GoType): GoType => ({ name: `*${elem.name}`, kind: "ptr", elem });
export const T_STRINGS = sliceOf(T_STRING);
export const T_ANY_SLICE = sliceOf(T_ANY);
export const T_ANY_MAP = mapOf(T_ANY);

export const str = (s: string) => new GV(T_STRING, s);
export const int = (n: number) => new GV(T_INT, n);
export const float = (n: number) => new GV(T_FLOAT, n);
export const bool = (b: boolean) => new GV(T_BOOL, b);
export const iface = (inner: GV) => new GV(T_ANY, inner.valid ? inner : null);
export const slice = (t: GoType, items: GV[] | null) => new GV(t, items);
export const map = (t: GoType, m: Map<string, GV> | null) => new GV(t, m);
export const struct = (t: GoType, fields: GV[]) => new GV(t, fields);
export const ptr = (t: GoType, to: GV | null) => new GV(t, to);

/** JSON(JSON.parse の結果)を Go の any(interface{})に。数は float64。 */
export function fromJson(x: unknown): GV {
  if (x === null || x === undefined) return new GV(T_ANY, null);
  if (typeof x === "string") return iface(str(x));
  if (typeof x === "number") return iface(float(x));
  if (typeof x === "boolean") return iface(bool(x));
  if (Array.isArray(x)) return iface(slice(T_ANY_SLICE, x.map(fromJson)));
  const m = new Map<string, GV>();
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) m.set(k, fromJson(v));
  return iface(map(T_ANY_MAP, m));
}

const isNilable = (k: Kind) => k === "slice" || k === "map" || k === "ptr" || k === "iface";
function isNilValue(v: GV) {
  if (!v.valid) return true;
  return isNilable(v.kind) && v.v === null;
}
function zeroOf(t: GoType): GV {
  switch (t.kind) {
    case "bool":
      return new GV(t, false);
    case "int":
    case "float64":
      return new GV(t, 0);
    case "string":
      return new GV(t, "");
    case "struct":
      return new GV(
        t,
        (t.fields ?? []).map((f) => zeroOf(f.type)),
      );
    default:
      return new GV(t, null);
  }
}

// ---------------------------------------------------------------- UTF-8

const enc = new TextEncoder();
const dec = new TextDecoder();
export const byteLen = (s: string) => enc.encode(s).length;

// ---------------------------------------------------------------- 字句解析(lex.go)

const enum It {
  Error,
  Bool,
  Char,
  CharConstant,
  Comment,
  Complex,
  Assign,
  Declare,
  EOF,
  Field,
  Identifier,
  LeftDelim,
  LeftParen,
  Number,
  Pipe,
  RawString,
  RightDelim,
  RightParen,
  Space,
  String,
  Text,
  Variable,
  Keyword,
  Block,
  Break,
  Continue,
  Dot,
  Define,
  Else,
  End,
  If,
  Nil,
  Range,
  Template,
  With,
}

type Item = { typ: It; pos: number; val: string; line: number };

const KEYWORDS: Record<string, It> = {
  ".": It.Dot,
  block: It.Block,
  break: It.Break,
  continue: It.Continue,
  define: It.Define,
  else: It.Else,
  end: It.End,
  if: It.If,
  range: It.Range,
  nil: It.Nil,
  template: It.Template,
  with: It.With,
};

const SPACE = " \t\r\n";
const isSpaceB = (b: number) => b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a;
const isLetter = (r: string) => /\p{L}/u.test(r);
const isDigitR = (r: string) => /\p{Nd}/u.test(r);
const isAlnum = (r: string) => r === "_" || isLetter(r) || isDigitR(r);

function quoteGo(s: string): string {
  // strconv.Quote(Go の %q)
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c === 7) out += "\\a";
    else if (c === 8) out += "\\b";
    else if (c === 12) out += "\\f";
    else if (c === 10) out += "\\n";
    else if (c === 13) out += "\\r";
    else if (c === 9) out += "\\t";
    else if (c === 11) out += "\\v";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else if (c === 0xfffd && ch !== "�") out += "\\ufffd";
    else if (!isPrintR(c)) out += c > 0xffff ? "\\U" + c.toString(16).padStart(8, "0") : "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}
function isPrintR(c: number) {
  if (c < 0x20 || c === 0x7f) return false;
  if (c >= 0x80 && c < 0xa0) return false;
  if (c === 0xad) return false;
  const ch = String.fromCodePoint(c);
  return !/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u.test(ch) && !(/\p{Zs}/u.test(ch) && c !== 0x20);
}

function itemString(i: Item): string {
  if (i.typ === It.EOF) return "EOF";
  if (i.typ === It.Error) return i.val;
  if (i.typ > It.Keyword) return `<${i.val}>`;
  if ([...i.val].length > 10) return quoteGo([...i.val].slice(0, 10).join("")) + "...";
  return quoteGo(i.val);
}

class Lexer {
  input: Uint8Array;
  pos = 0;
  start = 0;
  atEOF = false;
  parenDepth = 0;
  line = 1;
  startLine = 1;
  item: Item = { typ: It.EOF, pos: 0, val: "", line: 1 };
  insideAction = false;
  breakOK = true;
  continueOK = true;
  constructor(public text: string) {
    this.input = enc.encode(text);
  }
  s(a: number, b: number) {
    return dec.decode(this.input.subarray(a, b));
  }
  startsWith(at: number, lit: string) {
    for (let i = 0; i < lit.length; i++) if (this.input[at + i] !== lit.charCodeAt(i)) return false;
    return true;
  }
  indexOf(lit: string, from: number) {
    outer: for (let i = from; i + lit.length <= this.input.length; i++) {
      for (let j = 0; j < lit.length; j++) if (this.input[i + j] !== lit.charCodeAt(j)) continue outer;
      return i - from;
    }
    return -1;
  }
  /** 次の文字(コードポイントの文字列)。終わりなら "" 。 */
  next(): string {
    if (this.pos >= this.input.length) {
      this.atEOF = true;
      return "";
    }
    const b = this.input[this.pos];
    const w = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    const r = this.s(this.pos, this.pos + w);
    this.pos += w;
    if (r === "\n") this.line++;
    return r;
  }
  peek() {
    const r = this.next();
    this.backup();
    return r;
  }
  backup() {
    if (!this.atEOF && this.pos > 0) {
      let p = this.pos - 1;
      while (p > 0 && (this.input[p] & 0xc0) === 0x80) p--;
      if (this.input[p] === 0x0a) this.line--;
      this.pos = p;
    }
  }
  thisItem(t: It): Item {
    const i = { typ: t, pos: this.start, val: this.s(this.start, this.pos), line: this.startLine };
    this.start = this.pos;
    this.startLine = this.line;
    return i;
  }
  emit(t: It) {
    this.item = this.thisItem(t);
    return null;
  }
  emitItem(i: Item) {
    this.item = i;
    return null;
  }
  countNL(a: number, b: number) {
    let n = 0;
    for (let i = a; i < b; i++) if (this.input[i] === 0x0a) n++;
    return n;
  }
  ignore() {
    this.line += this.countNL(this.start, this.pos);
    this.start = this.pos;
    this.startLine = this.line;
  }
  accept(valid: string) {
    const r = this.next();
    if (r !== "" && valid.includes(r)) return true;
    this.backup();
    return false;
  }
  acceptRun(valid: string) {
    for (;;) {
      const r = this.next();
      if (r === "" || !valid.includes(r)) break;
    }
    this.backup();
  }
  errorf(msg: string) {
    this.item = { typ: It.Error, pos: this.start, val: msg, line: this.startLine };
    this.start = 0;
    this.pos = 0;
    this.input = new Uint8Array(0);
    return null;
  }
  nextItem(): Item {
    this.item = { typ: It.EOF, pos: this.pos, val: "EOF", line: this.startLine };
    let state: ((l: Lexer) => unknown) | null = this.insideAction ? lexInsideAction : lexText;
    while (state) state = state(this) as ((l: Lexer) => unknown) | null;
    return this.item;
  }
  hasLeftTrim(at: number) {
    return this.input.length - at >= 2 && this.input[at] === 0x2d && isSpaceB(this.input[at + 1]);
  }
  hasRightTrim(at: number) {
    return this.input.length - at >= 2 && isSpaceB(this.input[at]) && this.input[at + 1] === 0x2d;
  }
  atRightDelim(): [boolean, boolean] {
    if (this.hasRightTrim(this.pos) && this.startsWith(this.pos + 2, "}}")) return [true, true];
    if (this.startsWith(this.pos, "}}")) return [true, false];
    return [false, false];
  }
  rightTrimLength(a: number, b: number) {
    let n = 0;
    while (b - n > a && isSpaceB(this.input[b - n - 1])) n++;
    return n;
  }
  leftTrimLength(a: number) {
    let n = 0;
    while (a + n < this.input.length && isSpaceB(this.input[a + n])) n++;
    return n;
  }
  atTerminator() {
    const r = this.peek();
    if (r !== "" && SPACE.includes(r)) return true;
    if (r === "" || ".,|:)(".includes(r)) return true;
    return this.startsWith(this.pos, "}}");
  }
}

function lexText(l: Lexer) {
  const x = l.indexOf("{{", l.pos);
  if (x >= 0) {
    if (x > 0) {
      l.pos += x;
      let trim = 0;
      if (l.hasLeftTrim(l.pos + 2)) trim = l.rightTrimLength(l.start, l.pos);
      l.pos -= trim;
      l.line += l.countNL(l.start, l.pos);
      const i = l.thisItem(It.Text);
      l.pos += trim;
      l.ignore();
      if (i.val.length > 0) return l.emitItem(i);
    }
    return lexLeftDelim;
  }
  l.pos = l.input.length;
  if (l.pos > l.start) {
    l.line += l.countNL(l.start, l.pos);
    return l.emit(It.Text);
  }
  return l.emit(It.EOF);
}

function lexLeftDelim(l: Lexer) {
  l.pos += 2;
  const trim = l.hasLeftTrim(l.pos);
  const after = trim ? 2 : 0;
  if (l.startsWith(l.pos + after, "/*")) {
    l.pos += after;
    l.ignore();
    return lexComment;
  }
  const i = l.thisItem(It.LeftDelim);
  l.insideAction = true;
  l.pos += after;
  l.ignore();
  l.parenDepth = 0;
  return l.emitItem(i);
}

function lexComment(l: Lexer) {
  l.pos += 2;
  const x = l.indexOf("*/", l.pos);
  if (x < 0) return l.errorf("unclosed comment");
  l.pos += x + 2;
  const [delim, trim] = l.atRightDelim();
  if (!delim) return l.errorf("comment ends before closing delimiter");
  l.line += l.countNL(l.start, l.pos);
  l.thisItem(It.Comment);
  if (trim) l.pos += 2;
  l.pos += 2;
  if (trim) l.pos += l.leftTrimLength(l.pos);
  l.ignore();
  return lexText;
}

function lexRightDelim(l: Lexer) {
  const [, trim] = l.atRightDelim();
  if (trim) {
    l.pos += 2;
    l.ignore();
  }
  l.pos += 2;
  const i = l.thisItem(It.RightDelim);
  if (trim) {
    l.pos += l.leftTrimLength(l.pos);
    l.ignore();
  }
  l.insideAction = false;
  return l.emitItem(i);
}

function lexInsideAction(l: Lexer): unknown {
  const [delim] = l.atRightDelim();
  if (delim) {
    if (l.parenDepth === 0) return lexRightDelim;
    return l.errorf("unclosed left paren");
  }
  const r = l.next();
  if (r === "") return l.errorf("unclosed action");
  if (SPACE.includes(r)) {
    l.backup();
    return lexSpace;
  }
  if (r === "=") return l.emit(It.Assign);
  if (r === ":") {
    if (l.next() !== "=") return l.errorf("expected :=");
    return l.emit(It.Declare);
  }
  if (r === "|") return l.emit(It.Pipe);
  if (r === '"') return lexQuote;
  if (r === "`") return lexRawQuote;
  if (r === "$") return lexVariable;
  if (r === "'") return lexChar;
  if (r === ".") {
    if (l.pos < l.input.length) {
      const c = l.input[l.pos];
      if (c < 0x30 || c > 0x39) return lexField;
    }
    l.backup();
    return lexNumber;
  }
  if (r === "+" || r === "-" || (r >= "0" && r <= "9")) {
    l.backup();
    return lexNumber;
  }
  if (isAlnum(r)) {
    l.backup();
    return lexIdentifier;
  }
  if (r === "(") {
    l.parenDepth++;
    return l.emit(It.LeftParen);
  }
  if (r === ")") {
    l.parenDepth--;
    if (l.parenDepth < 0) return l.errorf("unexpected right paren");
    return l.emit(It.RightParen);
  }
  const c = r.codePointAt(0)!;
  if (c <= 0x7f && c >= 0x20 && c !== 0x7f) return l.emit(It.Char);
  return l.errorf(`unrecognized character in action: ${fmtU(c)}`);
}

function fmtU(c: number) {
  // %#U
  const hex = "U+" + c.toString(16).toUpperCase().padStart(4, "0");
  return isPrintR(c) ? `${hex} '${String.fromCodePoint(c)}'` : hex;
}

function lexSpace(l: Lexer) {
  let n = 0;
  for (;;) {
    const r = l.peek();
    if (r === "" || !SPACE.includes(r)) break;
    l.next();
    n++;
  }
  if (l.hasRightTrim(l.pos - 1) && l.startsWith(l.pos - 1 + 2, "}}")) {
    l.backup();
    if (n === 1) return lexRightDelim;
  }
  return l.emit(It.Space);
}

function lexIdentifier(l: Lexer) {
  for (;;) {
    const r = l.next();
    if (r !== "" && isAlnum(r)) continue;
    l.backup();
    const word = l.s(l.start, l.pos);
    if (!l.atTerminator()) return l.errorf(`bad character ${fmtU(r.codePointAt(0) ?? -1)}`);
    const k = KEYWORDS[word];
    if (k !== undefined && k > It.Keyword) {
      if ((k === It.Break && !l.breakOK) || (k === It.Continue && !l.continueOK)) return l.emit(It.Identifier);
      return l.emit(k);
    }
    if (word[0] === ".") return l.emit(It.Field);
    if (word === "true" || word === "false") return l.emit(It.Bool);
    return l.emit(It.Identifier);
  }
}

function lexField(l: Lexer) {
  return lexFieldOrVariable(l, It.Field);
}
function lexVariable(l: Lexer) {
  if (l.atTerminator()) return l.emit(It.Variable);
  return lexFieldOrVariable(l, It.Variable);
}
function lexFieldOrVariable(l: Lexer, typ: It) {
  if (l.atTerminator()) return l.emit(typ === It.Variable ? It.Variable : It.Dot);
  let r = "";
  for (;;) {
    r = l.next();
    if (r === "" || !isAlnum(r)) {
      l.backup();
      break;
    }
  }
  if (!l.atTerminator()) return l.errorf(`bad character ${fmtU(r === "" ? -1 : r.codePointAt(0)!)}`);
  return l.emit(typ);
}

function lexChar(l: Lexer) {
  for (;;) {
    const r = l.next();
    if (r === "\\") {
      const r2 = l.next();
      if (r2 !== "" && r2 !== "\n") continue;
      return l.errorf("unterminated character constant");
    }
    if (r === "" || r === "\n") return l.errorf("unterminated character constant");
    if (r === "'") break;
  }
  return l.emit(It.CharConstant);
}

function lexNumber(l: Lexer) {
  if (!scanNumber(l)) return l.errorf(`bad number syntax: ${quoteGo(l.s(l.start, l.pos))}`);
  const sign = l.peek();
  if (sign === "+" || sign === "-") {
    if (!scanNumber(l) || l.input[l.pos - 1] !== 0x69) return l.errorf(`bad number syntax: ${quoteGo(l.s(l.start, l.pos))}`);
    return l.emit(It.Complex);
  }
  return l.emit(It.Number);
}
function scanNumber(l: Lexer) {
  l.accept("+-");
  let digits = "0123456789_";
  if (l.accept("0")) {
    if (l.accept("xX")) digits = "0123456789abcdefABCDEF_";
    else if (l.accept("oO")) digits = "01234567_";
    else if (l.accept("bB")) digits = "01_";
  }
  l.acceptRun(digits);
  if (l.accept(".")) l.acceptRun(digits);
  if (digits.length === 11 && l.accept("eE")) {
    l.accept("+-");
    l.acceptRun("0123456789_");
  }
  if (digits.length === 23 && l.accept("pP")) {
    l.accept("+-");
    l.acceptRun("0123456789_");
  }
  l.accept("i");
  const p = l.peek();
  if (p !== "" && isAlnum(p)) {
    l.next();
    return false;
  }
  return true;
}
function lexQuote(l: Lexer) {
  for (;;) {
    const r = l.next();
    if (r === "\\") {
      const r2 = l.next();
      if (r2 !== "" && r2 !== "\n") continue;
      return l.errorf("unterminated quoted string");
    }
    if (r === "" || r === "\n") return l.errorf("unterminated quoted string");
    if (r === '"') break;
  }
  return l.emit(It.String);
}
function lexRawQuote(l: Lexer) {
  for (;;) {
    const r = l.next();
    if (r === "") return l.errorf("unterminated raw quoted string");
    if (r === "`") break;
  }
  return l.emit(It.RawString);
}

// ---------------------------------------------------------------- 構文木(node.go)

export type Node =
  | { t: "list"; pos: number; nodes: Node[] }
  | { t: "text"; pos: number; text: string }
  | { t: "action"; pos: number; line: number; pipe: PipeNode }
  | BranchNode
  | { t: "template"; pos: number; line: number; name: string; pipe: PipeNode | null }
  | { t: "break" | "continue"; pos: number; line: number }
  | PipeNode
  | CommandNode
  | { t: "field"; pos: number; ident: string[] }
  | { t: "variable"; pos: number; ident: string[] }
  | { t: "identifier"; pos: number; ident: string }
  | { t: "chain"; pos: number; node: Node; field: string[] }
  | { t: "dot"; pos: number }
  | { t: "nil"; pos: number }
  | { t: "bool"; pos: number; val: boolean }
  | NumberNode
  | { t: "string"; pos: number; quoted: string; text: string }
  | { t: "end" | "else"; pos: number; line: number };

export type BranchNode = { t: "if" | "range" | "with"; pos: number; line: number; pipe: PipeNode; list: ListNode; elseList: ListNode | null };
export type ListNode = { t: "list"; pos: number; nodes: Node[] };
export type PipeNode = { t: "pipe"; pos: number; line: number; isAssign: boolean; decl: { t: "variable"; pos: number; ident: string[] }[]; cmds: CommandNode[] };
export type CommandNode = { t: "command"; pos: number; args: Node[] };
export type NumberNode = {
  t: "number";
  pos: number;
  isInt: boolean;
  isUint: boolean;
  isFloat: boolean;
  isComplex: boolean;
  int: number;
  float: number;
  text: string;
};

export function nodeString(n: Node): string {
  switch (n.t) {
    case "list":
      return n.nodes.map(nodeString).join("");
    case "text":
      return n.text;
    case "action":
      return `{{${nodeString(n.pipe)}}}`;
    case "if":
    case "range":
    case "with":
      return `{{${n.t} ${nodeString(n.pipe)}}}${nodeString(n.list)}${n.elseList ? `{{else}}${nodeString(n.elseList)}` : ""}{{end}}`;
    case "template":
      return `{{template ${quoteGo(n.name)}${n.pipe ? " " + nodeString(n.pipe) : ""}}}`;
    case "break":
      return "{{break}}";
    case "continue":
      return "{{continue}}";
    case "pipe": {
      let s = "";
      if (n.decl.length) s += n.decl.map((d) => d.ident.join(".")).join(", ") + (n.isAssign ? " = " : " := ");
      return s + n.cmds.map(nodeString).join(" | ");
    }
    case "command":
      return n.args.map((a) => (a.t === "pipe" ? `(${nodeString(a)})` : nodeString(a))).join(" ");
    case "field":
      return n.ident.map((i) => "." + i).join("");
    case "variable":
      return n.ident.join(".");
    case "identifier":
      return n.ident;
    case "chain":
      return (n.node.t === "pipe" ? `(${nodeString(n.node)})` : nodeString(n.node)) + n.field.map((f) => "." + f).join("");
    case "dot":
      return ".";
    case "nil":
      return "nil";
    case "bool":
      return n.val ? "true" : "false";
    case "number":
      return n.text;
    case "string":
      return n.quoted;
    case "end":
      return "{{end}}";
    case "else":
      return "{{else}}";
  }
}

// ---------------------------------------------------------------- 構文解析(parse.go)

export class TemplateError extends Error {}

/** strconv.Unquote(テンプレートの文字列)。 */
function unquote(q: string): string {
  if (q[0] === "`") {
    if (q.includes("\r")) return q.slice(1, -1).replace(/\r/g, "");
    return q.slice(1, -1);
  }
  const quote = q[0];
  const body = q.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === quote) throw new Error("invalid syntax");
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = body[++i];
    const simple: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"' };
    if (e in simple) {
      if ((e === "'" && quote !== "'") || (e === '"' && quote !== '"')) throw new Error("invalid syntax");
      out += simple[e];
    } else if (e === "x") {
      const h = body.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(h)) throw new Error("invalid syntax");
      out += String.fromCharCode(parseInt(h, 16));
      i += 2;
    } else if (e === "u" || e === "U") {
      const n = e === "u" ? 4 : 8;
      const h = body.slice(i + 1, i + 1 + n);
      if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(h)) throw new Error("invalid syntax");
      const cp = parseInt(h, 16);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp < 0xe000)) throw new Error("invalid syntax");
      out += String.fromCodePoint(cp);
      i += n;
    } else if (e >= "0" && e <= "7") {
      const o = body.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(o)) throw new Error("invalid syntax");
      const v = parseInt(o, 8);
      if (v > 255) throw new Error("invalid syntax");
      out += String.fromCharCode(v);
      i += 2;
    } else throw new Error("invalid syntax");
  }
  if (quote === "'" && [...out].length !== 1) throw new Error("invalid syntax");
  return out;
}

function parseNumber(pos: number, text: string, typ: It): NumberNode {
  const n: NumberNode = { t: "number", pos, isInt: false, isUint: false, isFloat: false, isComplex: false, int: 0, float: 0, text };
  if (typ === It.CharConstant) {
    const r = unquote(text).codePointAt(0)!;
    n.int = r;
    n.isInt = true;
    n.isUint = true;
    n.float = r;
    n.isFloat = true;
    return n;
  }
  if (typ === It.Complex || text.endsWith("i")) throw new TemplateError(`complex numbers are not supported: ${quoteGo(text)}`);
  // strconv.ParseUint / ParseInt(基数 0)
  const parseIntBase0 = (s: string, signed: boolean): bigint | null => {
    let neg = false;
    let body = s;
    if (signed && (body[0] === "+" || body[0] === "-")) {
      neg = body[0] === "-";
      body = body.slice(1);
    }
    let base = 10;
    let digits = body;
    if (/^0[xX]/.test(body)) {
      base = 16;
      digits = body.slice(2);
    } else if (/^0[oO]/.test(body)) {
      base = 8;
      digits = body.slice(2);
    } else if (/^0[bB]/.test(body)) {
      base = 2;
      digits = body.slice(2);
    } else if (/^0\d/.test(body) || /^0_/.test(body)) {
      base = 8;
      digits = body.slice(1);
    }
    // 下線は基数の接頭辞の後か数字の間だけ
    const prefixed = base !== 10;
    if (digits.includes("_")) {
      const ok = (prefixed ? /^_?[0-9a-fA-F]+(_[0-9a-fA-F]+)*$/ : /^[0-9]+(_[0-9]+)*$/).test(digits);
      if (!ok) return null;
    }
    const d = digits.replace(/_/g, "");
    if (d === "") return null;
    const re = base === 16 ? /^[0-9a-fA-F]+$/ : base === 8 ? /^[0-7]+$/ : base === 2 ? /^[01]+$/ : /^[0-9]+$/;
    if (!re.test(d)) return null;
    let v = 0n;
    for (const ch of d) v = v * BigInt(base) + BigInt(parseInt(ch, 16));
    return neg ? -v : v;
  };
  const u = parseIntBase0(text, false);
  if (u !== null && u < 2n ** 64n) {
    n.isUint = true;
    n.int = Number(u);
  }
  const i = parseIntBase0(text, true);
  if (i !== null && i >= -(2n ** 63n) && i < 2n ** 63n) {
    n.isInt = true;
    n.int = Number(i);
    if (i === 0n) n.isUint = true;
  }
  if (n.isInt || n.isUint) {
    n.isFloat = true;
    n.float = n.int;
  } else {
    const clean = text.replace(/_/g, "");
    const f = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(clean) ? Number(clean) : NaN;
    if (!Number.isNaN(f)) {
      if (!/[.eEpP]/.test(text)) throw new TemplateError(`integer overflow: ${quoteGo(text)}`);
      n.isFloat = true;
      n.float = f;
      if (Number.isInteger(f) && Math.abs(f) < 2 ** 63) {
        n.isInt = true;
        n.int = f;
        if (f >= 0) n.isUint = true;
      }
    }
  }
  if (!n.isInt && !n.isUint && !n.isFloat) throw new TemplateError(`illegal number syntax: ${quoteGo(text)}`);
  return n;
}

export type Parsed = { root: ListNode; defs: Map<string, ListNode>; text: string };

class Parser {
  lex: Lexer;
  token: Item[] = [null!, null!, null!];
  peekCount = 0;
  vars: string[] = ["$"];
  rangeDepth = 0;
  actionLine = 0;
  stackDepth = 0;
  defs = new Map<string, ListNode>();
  constructor(
    public text: string,
    public funcs: Set<string>,
  ) {
    this.lex = new Lexer(text);
    this.lex.breakOK = !funcs.has("break");
    this.lex.continueOK = !funcs.has("continue");
  }
  errorf(msg: string): never {
    throw new TemplateError(`template: :${this.token[0]?.line ?? 1}: ${msg}`);
  }
  next(): Item {
    if (this.peekCount > 0) this.peekCount--;
    else this.token[0] = this.lex.nextItem();
    return this.token[this.peekCount];
  }
  backup() {
    this.peekCount++;
  }
  backup2(t1: Item) {
    this.token[1] = t1;
    this.peekCount = 2;
  }
  backup3(t2: Item, t1: Item) {
    this.token[1] = t1;
    this.token[2] = t2;
    this.peekCount = 3;
  }
  peek(): Item {
    if (this.peekCount > 0) return this.token[this.peekCount - 1];
    this.peekCount = 1;
    this.token[0] = this.lex.nextItem();
    return this.token[0];
  }
  nextNonSpace(): Item {
    let t: Item;
    do t = this.next();
    while (t.typ === It.Space);
    return t;
  }
  peekNonSpace(): Item {
    const t = this.nextNonSpace();
    this.backup();
    return t;
  }
  expect(typ: It, ctx: string) {
    const t = this.nextNonSpace();
    if (t.typ !== typ) this.unexpected(t, ctx);
    return t;
  }
  unexpected(t: Item, ctx: string): never {
    if (t.typ === It.Error) {
      let extra = "";
      if (this.actionLine !== 0 && this.actionLine !== t.line) {
        extra = ` in action started at :${this.actionLine}`;
        if (t.val.endsWith(" action")) extra = extra.slice(" in action".length);
      }
      this.errorf(`${t.val}${extra}`);
    }
    this.errorf(`unexpected ${itemString(t)} in ${ctx}`);
  }

  parse(): Parsed {
    const root: ListNode = { t: "list", pos: this.peek().pos, nodes: [] };
    while (this.peek().typ !== It.EOF) {
      if (this.peek().typ === It.LeftDelim) {
        const delim = this.next();
        if (this.nextNonSpace().typ === It.Define) {
          this.parseDefinition();
          continue;
        }
        this.backup2(delim);
      }
      const n = this.textOrAction();
      if (n.t === "end" || n.t === "else") this.errorf(`unexpected ${nodeString(n)}`);
      root.nodes.push(n);
    }
    return { root, defs: this.defs, text: this.text };
  }
  parseDefinition() {
    const ctx = "define clause";
    const tok = this.nextNonSpace();
    if (tok.typ !== It.String && tok.typ !== It.RawString) this.unexpected(tok, ctx);
    let name: string;
    try {
      name = unquote(tok.val);
    } catch (e) {
      this.errorf((e as Error).message);
    }
    this.expect(It.RightDelim, ctx);
    const saveVars = this.vars;
    this.vars = ["$"];
    const [list, end] = this.itemList();
    this.vars = saveVars;
    if (end.t !== "end") this.errorf(`unexpected ${nodeString(end)} in ${ctx}`);
    this.addDef(name!, list);
  }
  addDef(name: string, list: ListNode) {
    const old = this.defs.get(name);
    if (!old || isEmptyTree(old)) {
      this.defs.set(name, list);
      return;
    }
    if (!isEmptyTree(list)) this.errorf(`template: multiple definition of template ${quoteGo(name)}`);
  }
  itemList(): [ListNode, Node] {
    const list: ListNode = { t: "list", pos: this.peekNonSpace().pos, nodes: [] };
    while (this.peekNonSpace().typ !== It.EOF) {
      const n = this.textOrAction();
      if (n.t === "end" || n.t === "else") return [list, n];
      list.nodes.push(n);
    }
    this.errorf("unexpected EOF");
  }
  textOrAction(): Node {
    const tok = this.nextNonSpace();
    if (tok.typ === It.Text) return { t: "text", pos: tok.pos, text: tok.val };
    if (tok.typ === It.LeftDelim) {
      this.actionLine = tok.line;
      try {
        return this.action();
      } finally {
        this.actionLine = 0;
      }
    }
    this.unexpected(tok, "input");
  }
  action(): Node {
    const tok = this.nextNonSpace();
    switch (tok.typ) {
      case It.Block:
        return this.blockControl();
      case It.Break:
      case It.Continue: {
        const word = tok.typ === It.Break ? "break" : "continue";
        const t2 = this.nextNonSpace();
        if (t2.typ !== It.RightDelim) this.unexpected(t2, `{{${word}}}`);
        if (this.rangeDepth === 0) this.errorf(`{{${word}}} outside {{range}}`);
        return { t: word, pos: tok.pos, line: tok.line };
      }
      case It.Else:
        return this.elseControl();
      case It.End:
        return { t: "end", pos: this.expect(It.RightDelim, "end").pos, line: tok.line };
      case It.If:
        return this.control("if");
      case It.Range:
        return this.control("range");
      case It.Template:
        return this.templateControl();
      case It.With:
        return this.control("with");
    }
    this.backup();
    const t = this.peek();
    return { t: "action", pos: t.pos, line: t.line, pipe: this.pipeline("command", It.RightDelim) };
  }
  pipeline(ctx: string, end: It): PipeNode {
    const tok = this.peekNonSpace();
    const pipe: PipeNode = { t: "pipe", pos: tok.pos, line: tok.line, isAssign: false, decl: [], cmds: [] };
    decls: for (;;) {
      const v = this.peekNonSpace();
      if (v.typ !== It.Variable) break;
      this.next();
      const after = this.peek();
      const next = this.peekNonSpace();
      if (next.typ === It.Assign || next.typ === It.Declare) {
        pipe.isAssign = next.typ === It.Assign;
        this.nextNonSpace();
        pipe.decl.push({ t: "variable", pos: v.pos, ident: v.val.split(".") });
        this.vars.push(v.val);
      } else if (next.typ === It.Char && next.val === ",") {
        this.nextNonSpace();
        pipe.decl.push({ t: "variable", pos: v.pos, ident: v.val.split(".") });
        this.vars.push(v.val);
        if (ctx === "range" && pipe.decl.length < 2) {
          const p = this.peekNonSpace().typ;
          if (p === It.Variable || p === It.RightDelim || p === It.RightParen) continue decls;
          this.errorf("range can only initialize variables");
        }
        this.errorf(`too many declarations in ${ctx}`);
      } else if (after.typ === It.Space) this.backup3(v, after);
      else this.backup2(v);
      break;
    }
    for (;;) {
      const t = this.nextNonSpace();
      if (t.typ === end) {
        this.checkPipeline(pipe, ctx);
        return pipe;
      }
      switch (t.typ) {
        case It.Bool:
        case It.CharConstant:
        case It.Complex:
        case It.Dot:
        case It.Field:
        case It.Identifier:
        case It.Number:
        case It.Nil:
        case It.RawString:
        case It.String:
        case It.Variable:
        case It.LeftParen:
          this.backup();
          pipe.cmds.push(this.command());
          break;
        default:
          this.unexpected(t, ctx);
      }
    }
  }
  checkPipeline(pipe: PipeNode, ctx: string) {
    if (pipe.cmds.length === 0) this.errorf(`missing value for ${ctx}`);
    pipe.cmds.slice(1).forEach((c, i) => {
      const k = c.args[0].t;
      if (k === "bool" || k === "dot" || k === "nil" || k === "number" || k === "string") this.errorf(`non executable command in pipeline stage ${i + 2}`);
    });
  }
  control(ctx: "if" | "range" | "with"): Node {
    const mark = this.vars.length;
    try {
      const pipe = this.pipeline(ctx, It.RightDelim);
      if (ctx === "range") this.rangeDepth++;
      const [list, firstNext] = this.itemList();
      let next = firstNext;
      if (ctx === "range") this.rangeDepth--;
      let elseList: ListNode | null = null;
      if (next.t === "else") {
        if (ctx === "if" && this.peek().typ === It.If) {
          this.next();
          elseList = { t: "list", pos: next.pos, nodes: [this.control("if")] };
        } else if (ctx === "with" && this.peek().typ === It.With) {
          this.next();
          elseList = { t: "list", pos: next.pos, nodes: [this.control("with")] };
        } else {
          [elseList, next] = this.itemList();
          if (next.t !== "end") this.errorf(`expected end; found ${nodeString(next)}`);
        }
      }
      return { t: ctx, pos: pipe.pos, line: pipe.line, pipe, list, elseList };
    } finally {
      this.vars.length = mark;
    }
  }
  elseControl(): Node {
    const p = this.peekNonSpace();
    if (p.typ === It.If || p.typ === It.With) return { t: "else", pos: p.pos, line: p.line };
    const t = this.expect(It.RightDelim, "else");
    return { t: "else", pos: t.pos, line: t.line };
  }
  templateName(tok: Item, ctx: string): string {
    if (tok.typ === It.String || tok.typ === It.RawString) {
      try {
        return unquote(tok.val);
      } catch (e) {
        this.errorf((e as Error).message);
      }
    }
    this.unexpected(tok, ctx);
  }
  blockControl(): Node {
    const ctx = "block clause";
    const tok = this.nextNonSpace();
    const name = this.templateName(tok, ctx);
    const pipe = this.pipeline(ctx, It.RightDelim);
    const saveVars = this.vars;
    const saveDepth = this.rangeDepth;
    this.vars = ["$"];
    this.rangeDepth = 0;
    const [list, end] = this.itemList();
    this.vars = saveVars;
    this.rangeDepth = saveDepth;
    if (end.t !== "end") this.errorf(`unexpected ${nodeString(end)} in ${ctx}`);
    this.addDef(name, list);
    return { t: "template", pos: tok.pos, line: tok.line, name, pipe };
  }
  templateControl(): Node {
    const ctx = "template clause";
    const tok = this.nextNonSpace();
    const name = this.templateName(tok, ctx);
    let pipe: PipeNode | null = null;
    if (this.nextNonSpace().typ !== It.RightDelim) {
      this.backup();
      pipe = this.pipeline(ctx, It.RightDelim);
    }
    return { t: "template", pos: tok.pos, line: tok.line, name, pipe };
  }
  command(): CommandNode {
    const cmd: CommandNode = { t: "command", pos: this.peekNonSpace().pos, args: [] };
    for (;;) {
      this.peekNonSpace();
      const op = this.operand();
      if (op) cmd.args.push(op);
      const t = this.next();
      if (t.typ === It.Space) continue;
      if (t.typ === It.RightDelim || t.typ === It.RightParen) this.backup();
      else if (t.typ !== It.Pipe) this.unexpected(t, "operand");
      break;
    }
    if (cmd.args.length === 0) this.errorf("empty command");
    return cmd;
  }
  operand(): Node | null {
    let node = this.term();
    if (!node) return null;
    if (this.peek().typ === It.Field) {
      const chain = { t: "chain" as const, pos: this.peek().pos, node, field: [] as string[] };
      while (this.peek().typ === It.Field) chain.field.push(...this.next().val.slice(1).split("."));
      switch (node.t) {
        case "field":
          node = { t: "field", pos: chain.pos, ident: [...node.ident, ...chain.field] };
          break;
        case "variable":
          node = { t: "variable", pos: chain.pos, ident: [...node.ident, ...chain.field] };
          break;
        case "bool":
        case "string":
        case "number":
        case "nil":
        case "dot":
          this.errorf(`unexpected . after term ${quoteGo(nodeString(node))}`);
          break;
        default:
          node = chain;
      }
    }
    return node;
  }
  term(): Node | null {
    const tok = this.nextNonSpace();
    switch (tok.typ) {
      case It.Identifier:
        if (!this.funcs.has(tok.val)) this.errorf(`function ${quoteGo(tok.val)} not defined`);
        return { t: "identifier", pos: tok.pos, ident: tok.val };
      case It.Dot:
        return { t: "dot", pos: tok.pos };
      case It.Nil:
        return { t: "nil", pos: tok.pos };
      case It.Variable: {
        const ident = tok.val.split(".");
        if (!this.vars.includes(ident[0])) this.errorf(`undefined variable ${quoteGo(ident[0])}`);
        return { t: "variable", pos: tok.pos, ident };
      }
      case It.Field:
        return { t: "field", pos: tok.pos, ident: tok.val.slice(1).split(".") };
      case It.Bool:
        return { t: "bool", pos: tok.pos, val: tok.val === "true" };
      case It.CharConstant:
      case It.Complex:
      case It.Number:
        try {
          return parseNumber(tok.pos, tok.val, tok.typ);
        } catch (e) {
          this.errorf((e as Error).message);
        }
        break;
      // falls through (unreachable)
      case It.LeftParen: {
        if (this.stackDepth >= 10000) this.errorf("max expression depth exceeded");
        this.stackDepth++;
        try {
          return this.pipeline("parenthesized pipeline", It.RightParen);
        } finally {
          this.stackDepth--;
        }
      }
      case It.String:
      case It.RawString:
        try {
          return { t: "string", pos: tok.pos, quoted: tok.val, text: unquote(tok.val) };
        } catch (e) {
          this.errorf((e as Error).message);
        }
    }
    this.backup();
    return null;
  }
}

function isEmptyTree(n: Node): boolean {
  if (n.t === "list") return n.nodes.every(isEmptyTree);
  if (n.t === "text") return n.text.trim() === "";
  return false;
}

export const BUILTINS = ["and", "call", "html", "index", "slice", "js", "len", "not", "or", "print", "printf", "println", "urlquery", "eq", "ge", "gt", "le", "lt", "ne"];

export type Func = (args: GV[]) => GV;

export function parse(text: string, funcNames: Iterable<string>): Parsed {
  const p = new Parser(text, new Set([...BUILTINS, ...funcNames]));
  const r = p.parse();
  // 定義だけのファイルでも、本体は空のリストとして持つ
  return r;
}

// ---------------------------------------------------------------- fmt と json

/** strconv.FormatFloat(f, 'g', -1, 64)(fmt の %v)。 */
export function gShortest(f: number): string {
  if (Number.isNaN(f)) return "NaN";
  if (f === Infinity) return "+Inf";
  if (f === -Infinity) return "-Inf";
  if (f === 0) return Object.is(f, -0) ? "-0" : "0";
  const e = f.toExponential();
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(e)!;
  const sign = m[1];
  const digits = m[2] + (m[3] ?? "");
  const exp = Number(m[4]);
  // 最短表現では、%e にするかどうかを精度 6 で決める(strconv の ftoa.go)
  if (exp < -4 || exp >= 6) {
    const mant = m[2] + (m[3] ? "." + m[3] : "");
    const ae = Math.abs(exp);
    return `${sign}${mant}e${exp < 0 ? "-" : "+"}${ae < 10 ? "0" + ae : ae}`;
  }
  // 小数で書く
  if (exp >= 0) {
    const intPart = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
    const frac = digits.slice(exp + 1);
    return sign + intPart + (frac ? "." + frac : "");
  }
  return sign + "0." + "0".repeat(-exp - 1) + digits;
}

/** encoding/json の文字列(HTML の < > & もエスケープ)。 */
export function jsonQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c === 10) out += "\\n";
    else if (c === 13) out += "\\r";
    else if (c === 9) out += "\\t";
    else if (c === 8) out += "\\b";
    else if (c === 12) out += "\\f";
    else if (c < 0x20) out += "\\u00" + c.toString(16).padStart(2, "0");
    else if (ch === "<") out += "\\u003c";
    else if (ch === ">") out += "\\u003e";
    else if (ch === "&") out += "\\u0026";
    else if (c === 0x2028) out += "\\u2028";
    else if (c === 0x2029) out += "\\u2029";
    else if (c >= 0xd800 && c <= 0xdfff) out += "\\ufffd";
    else out += ch;
  }
  return out + '"';
}

/** encoding/json の float64(Go は 1e-6 未満と 1e21 以上で指数。JavaScript の String と同じ境目と形になる)。 */
export function jsonFloat(f: number): string | null {
  if (!Number.isFinite(f)) return null;
  if (Object.is(f, -0)) return "-0";
  return String(f);
}

export class JsonError extends Error {}

/** json.Marshal と同じ形の文字列。 */
export function marshal(v: GV): string {
  if (!v.valid) return "null";
  const t = v.type!;
  if (t.marshalJSON) return t.marshalJSON(v);
  switch (t.kind) {
    case "bool":
      return v.v ? "true" : "false";
    case "int":
      return String(v.v);
    case "float64": {
      const s = jsonFloat(v.v as number);
      if (s === null) throw new JsonError(`json: unsupported value: ${gShortest(v.v as number)}`);
      return s;
    }
    case "string":
      return jsonQuote(v.v as string);
    case "iface":
      return v.v === null ? "null" : marshal(v.v as GV);
    case "ptr":
      return v.v === null ? "null" : marshal(v.v as GV);
    case "slice": {
      if (v.v === null) return "null";
      const items = v.v as GV[];
      if (t.bytes) return jsonQuote(base64(items.map((x) => x.v as number)));
      return "[" + items.map(marshal).join(",") + "]";
    }
    case "map": {
      if (v.v === null) return "null";
      const m = v.v as Map<string, GV>;
      const keys = [...m.keys()].sort(cmpStr);
      return "{" + keys.map((k) => jsonQuote(k) + ":" + marshal(m.get(k)!)).join(",") + "}";
    }
    case "struct": {
      const parts: string[] = [];
      (t.fields ?? []).forEach((f, i) => {
        const fv = (v.v as GV[])[i];
        const tag = f.json ?? { name: f.name, omitempty: false };
        if (tag.name === "-") return;
        if (tag.omitempty && isEmptyValue(fv)) return;
        parts.push(jsonQuote(tag.name) + ":" + marshal(fv));
      });
      return "{" + parts.join(",") + "}";
    }
  }
}

function isEmptyValue(v: GV): boolean {
  if (!v.valid) return true;
  switch (v.kind) {
    case "bool":
      return v.v === false;
    case "int":
    case "float64":
      return v.v === 0;
    case "string":
      return v.v === "";
    case "slice":
      return v.v === null || (v.v as GV[]).length === 0;
    case "map":
      return v.v === null || (v.v as Map<string, GV>).size === 0;
    case "ptr":
    case "iface":
      return v.v === null;
  }
  return false;
}

function base64(bytes: number[]) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const cmpStr = (a: string, b: string) => {
  // Go の文字列比較はバイト順
  const x = enc.encode(a);
  const y = enc.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};

/** fmt の %v。depth は fmt の printValue の深さ(0 が一番外)。 */
export function fmtV(v: GV, depth = 0): string {
  if (!v.valid) return depth === 0 ? "<nil>" : "<nil>";
  const t = v.type!;
  if (t.stringer && !(t.kind === "ptr" && v.v === null && depth > 0)) return t.stringer(v);
  switch (t.kind) {
    case "bool":
      return v.v ? "true" : "false";
    case "int":
      return String(v.v);
    case "float64":
      return gShortest(v.v as number);
    case "string":
      return v.v as string;
    case "iface":
      return v.v === null ? "<nil>" : fmtV(v.v as GV, depth);
    case "ptr":
      if (v.v === null) return "<nil>";
      if (depth === 0) return "&" + fmtV(v.v as GV, depth + 1);
      return "0xc000010000";
    case "slice":
      return "[" + ((v.v as GV[] | null) ?? []).map((x) => fmtV(x, depth + 1)).join(" ") + "]";
    case "map": {
      const m = (v.v as Map<string, GV> | null) ?? new Map();
      return "map[" + [...m.keys()].sort(cmpStr).map((k) => `${k}:${fmtV(m.get(k)!, depth + 1)}`).join(" ") + "]";
    }
    case "struct":
      return "{" + (v.v as GV[]).map((x) => fmtV(x, depth + 1)).join(" ") + "}";
  }
}

/** fmt.Sprint。 */
export function sprint(args: GV[]): string {
  args = args.map(unIface);
  let out = "";
  args.forEach((a, i) => {
    const isStr = (x: GV) => x.valid && x.kind === "string";
    if (i > 0 && !isStr(a) && !isStr(args[i - 1])) out += " ";
    out += fmtV(a, 0);
  });
  return out;
}
export function sprintln(args: GV[]): string {
  return args.map(unIface).map((a) => fmtV(a, 0)).join(" ") + "\n";
}

const typeName = (v: GV) => (v.valid ? v.type!.name : "<nil>");

/** fmt.Sprintf(よく使う動詞だけ)。 */
export function sprintf(format: string, args: GV[]): string {
  let out = "";
  let ai = 0;
  const bad = (verb: string, a: GV) => (a.valid ? `%!${verb}(${typeName(a)}=${fmtV(a)})` : `%!${verb}(<nil>)`);
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c !== "%") {
      out += c;
      continue;
    }
    let j = i + 1;
    let flags = "";
    while (j < format.length && "+-# 0".includes(format[j])) flags += format[j++];
    let width = "";
    while (j < format.length && /\d/.test(format[j])) width += format[j++];
    let prec: string | null = null;
    if (format[j] === ".") {
      j++;
      prec = "";
      while (j < format.length && /\d/.test(format[j])) prec += format[j++];
    }
    const verb = format[j];
    i = j;
    if (verb === undefined) {
      out += "%!(NOVERB)";
      break;
    }
    if (verb === "%") {
      out += "%";
      continue;
    }
    if (ai >= args.length) {
      out += `%!${verb}(MISSING)`;
      continue;
    }
    let a = args[ai++];
    if (a.valid && a.kind === "iface") a = a.v === null ? INVALID : (a.v as GV);
    let s: string;
    const k = a.valid ? a.kind : "invalid";
    switch (verb) {
      case "v":
        s = a.valid ? fmtV(a) : "<nil>";
        break;
      case "s":
        s = k === "string" ? (a.v as string) : a.valid && a.type!.stringer ? a.type!.stringer(a) : k === "slice" || k === "struct" || k === "map" ? fmtV(a) : bad("s", a);
        if (prec !== null && k === "string") s = [...s].slice(0, Number(prec || 0)).join("");
        break;
      case "q":
        s = k === "string" ? quoteGo(a.v as string) : k === "int" ? `'${String.fromCodePoint(a.v as number)}'` : bad("q", a);
        break;
      case "d":
        s = k === "int" ? String(a.v) : bad("d", a);
        break;
      case "t":
        s = k === "bool" ? String(a.v) : bad("t", a);
        break;
      case "f":
      case "F":
        s = k === "float64" || k === "int" ? (k === "int" ? bad(verb, a) : (a.v as number).toFixed(prec === null ? 6 : Number(prec || 0))) : bad(verb, a);
        break;
      case "e":
        s = k === "float64" ? goExp((a.v as number).toExponential(prec === null ? 6 : Number(prec || 0))) : bad("e", a);
        break;
      case "g":
        s = k === "float64" ? gShortest(a.v as number) : bad("g", a);
        break;
      case "x":
      case "X":
        s = k === "int" ? (a.v as number).toString(16) : k === "string" ? [...enc.encode(a.v as string)].map((b) => b.toString(16).padStart(2, "0")).join("") : bad(verb, a);
        if (verb === "X") s = s.toUpperCase();
        break;
      case "c":
        s = k === "int" ? String.fromCodePoint(a.v as number) : bad("c", a);
        break;
      case "T":
        s = typeName(a);
        break;
      default:
        s = bad(verb, a);
    }
    if (width) {
      const w = Number(width);
      const len = [...s].length;
      if (len < w) s = flags.includes("-") ? s + " ".repeat(w - len) : (flags.includes("0") && /^[-\d]/.test(s) ? "0" : " ").repeat(w - len) + s;
    }
    out += s;
  }
  if (ai < args.length) out += "%!(EXTRA " + args.slice(ai).map((a) => `${typeName(a.valid && a.kind === "iface" && a.v ? (a.v as GV) : a)}=${fmtV(a)}`).join(", ") + ")";
  return out;
}
const goExp = (s: string) => s.replace(/e([+-])(\d)$/, "e$10$2");

// ---------------------------------------------------------------- 実行(exec.go・funcs.go)

class Break {}
class Continue {}

export class ExecError extends Error {}

type Frame = { name: string; value: GV };

const MISSING = new GV({ name: "missing", kind: "struct", fields: [] }, []);
const isMissing = (v: GV) => v === MISSING;

/** indirectInterface。 */
function unIface(v: GV): GV {
  if (v.valid && v.kind === "iface") return v.v === null ? INVALID : (v.v as GV);
  return v;
}
/** indirect: ポインターと interface をたどる。 */
function indirect(v: GV): [GV, boolean] {
  while (v.valid && (v.kind === "ptr" || v.kind === "iface")) {
    if (v.v === null) return [v, true];
    v = v.v as GV;
  }
  return [v, false];
}
function lenOf(v: GV): number {
  if (v.kind === "string") return byteLen(v.v as string);
  if (v.kind === "slice") return ((v.v as GV[] | null) ?? []).length;
  if (v.kind === "map") return ((v.v as Map<string, GV> | null) ?? new Map()).size;
  return 0;
}
export function isTrue(v: GV): boolean {
  if (!v.valid) return false;
  switch (v.kind) {
    case "slice":
    case "map":
    case "string":
      return lenOf(v) > 0;
    case "bool":
      return v.v as boolean;
    case "ptr":
    case "iface":
      return v.v !== null;
    case "int":
    case "float64":
      return (v.v as number) !== 0;
    case "struct":
      return true;
  }
  return false;
}

type Builtin = { variadic: boolean; nIn: number; argTypes: ("value" | "any" | "string")[]; fn: (args: GV[]) => GV };

const valueErr = (m: string) => {
  throw new FuncError(m);
};
class FuncError extends Error {}

function basicKind(v: GV): "bool" | "int" | "float" | "string" | "invalid" {
  if (!v.valid) return "invalid";
  if (v.kind === "bool") return "bool";
  if (v.kind === "int") return "int";
  if (v.kind === "float64") return "float";
  if (v.kind === "string") return "string";
  return "invalid";
}

function eqFn(args: GV[]): GV {
  const a1 = unIface(args[0]);
  const rest = args.slice(1);
  if (rest.length === 0) valueErr("missing argument for comparison");
  const k1 = basicKind(a1);
  for (let arg of rest) {
    arg = unIface(arg);
    const k2 = basicKind(arg);
    let truth = false;
    if (k1 !== k2) {
      if (a1.valid && arg.valid) valueErr(`incompatible types for comparison: ${a1.type!.name} and ${arg.type!.name}`);
    } else if (k1 === "invalid") {
      if (!(a1.kind === arg.kind || !a1.valid || !arg.valid)) valueErr(`non-comparable types ${fmtV(a1)}: ${typeName(a1)}, ${typeName(arg)}: ${fmtV(arg)}`);
      if (isNilValue(a1) || isNilValue(arg)) truth = isNilValue(arg) === isNilValue(a1);
      else if (arg.kind === "slice" || arg.kind === "map") valueErr(`non-comparable type ${fmtV(arg)}: ${typeName(arg)}`);
      else truth = a1 === arg || (a1.kind === "ptr" && a1.v === arg.v);
    } else truth = a1.v === arg.v;
    if (truth) return bool(true);
  }
  return bool(false);
}
function ltFn(a1: GV, a2: GV): boolean {
  a1 = unIface(a1);
  const k1 = basicKind(a1);
  if (k1 === "invalid") valueErr("invalid type for comparison");
  a2 = unIface(a2);
  const k2 = basicKind(a2);
  if (k2 === "invalid") valueErr("invalid type for comparison");
  if (k1 !== k2) valueErr(`incompatible types for comparison: ${a1.type!.name} and ${a2.type!.name}`);
  if (k1 === "bool") valueErr("invalid type for comparison");
  if (k1 === "string") return cmpStr(a1.v as string, a2.v as string) < 0;
  return (a1.v as number) < (a2.v as number);
}

function indexArg(idx: GV, cap: number): number {
  if (!idx.valid) valueErr("cannot index slice/array with nil");
  if (idx.kind !== "int") valueErr(`cannot index slice/array with type ${idx.type!.name}`);
  const x = idx.v as number;
  if (x < 0 || x > cap) valueErr(`index out of range: ${x}`);
  return x;
}

function htmlEscape(s: string) {
  return s.replace(/[\0"'&<>]/g, (c) => ({ "\0": "�", '"': "&#34;", "'": "&#39;", "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}
function jsEscape(s: string) {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const m: Record<string, string> = { "\\": "\\\\", "'": "\\'", '"': '\\"', "<": "\\u003C", ">": "\\u003E", "&": "\\u0026", "=": "\\u003D" };
    if (m[ch]) out += m[ch];
    else if (c < 0x20) out += "\\u00" + c.toString(16).toUpperCase().padStart(2, "0");
    else if (c >= 0x80 && !isPrintR(c)) out += "\\u" + c.toString(16).toUpperCase().padStart(4, "0");
    else out += ch;
  }
  return out;
}
function queryEscape(s: string) {
  let out = "";
  for (const b of enc.encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c)) out += c;
    else if (c === " ") out += "+";
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}
function evalArgs(args: GV[]): string {
  if (args.length === 1 && args[0].valid && unIface(args[0]).kind === "string") return unIface(args[0]).v as string;
  return sprint(args.map((a) => printable(a) ?? a));
}

const BUILTIN_FUNCS: Record<string, Builtin> = {
  html: { variadic: true, nIn: 1, argTypes: ["any"], fn: (a) => str(htmlEscape(evalArgs(a))) },
  js: { variadic: true, nIn: 1, argTypes: ["any"], fn: (a) => str(jsEscape(evalArgs(a))) },
  urlquery: { variadic: true, nIn: 1, argTypes: ["any"], fn: (a) => str(queryEscape(evalArgs(a))) },
  print: { variadic: true, nIn: 1, argTypes: ["any"], fn: (a) => str(sprint(a)) },
  println: { variadic: true, nIn: 1, argTypes: ["any"], fn: (a) => str(sprintln(a)) },
  printf: {
    variadic: true,
    nIn: 2,
    argTypes: ["string", "any"],
    fn: (a) => str(sprintf(a[0].v as string, a.slice(1))),
  },
  len: {
    variadic: false,
    nIn: 1,
    argTypes: ["value"],
    fn: ([x]) => {
      const [item, isNil] = indirect(x);
      if (isNil) valueErr("len of nil pointer");
      if (!item.valid) valueErr("reflect: call of reflect.Value.Type on zero Value");
      if (item.kind === "slice" || item.kind === "map" || item.kind === "string") return int(lenOf(item));
      return valueErr(`len of type ${item.type!.name}`);
    },
  },
  not: { variadic: false, nIn: 1, argTypes: ["value"], fn: ([x]) => bool(!isTrue(unIface(x))) },
  index: {
    variadic: true,
    nIn: 2,
    argTypes: ["value", "value"],
    fn: ([x, ...idx]) => {
      let item = unIface(x);
      if (!item.valid) valueErr("index of untyped nil");
      for (let i of idx) {
        i = unIface(i);
        let isNil: boolean;
        [item, isNil] = indirect(item);
        if (isNil) valueErr("index of nil pointer");
        if (item.kind === "slice") {
          const items = (item.v as GV[] | null) ?? [];
          const n = indexArg(i, items.length);
          if (n >= items.length) valueErr("reflect: slice index out of range");
          item = items[n];
        } else if (item.kind === "string") {
          const b = enc.encode(item.v as string);
          const n = indexArg(i, b.length);
          if (n >= b.length) valueErr("reflect: string index out of range");
          item = new GV(T_UINT8, b[n]);
        } else if (item.kind === "map") {
          if (!i.valid) valueErr("value is nil; should be of type string");
          if (i.kind !== "string") valueErr(`value has type ${i.type!.name}; should be string`);
          const m = (item.v as Map<string, GV> | null) ?? new Map();
          item = m.get(i.v as string) ?? zeroOf(item.type!.elem!);
        } else valueErr(`can't index item of type ${item.type!.name}`);
      }
      return item;
    },
  },
  slice: {
    variadic: true,
    nIn: 2,
    argTypes: ["value", "value"],
    fn: ([x, ...idx]) => {
      let item = unIface(x);
      if (!item.valid) valueErr("slice of untyped nil");
      const [deref, isNil] = indirect(item);
      item = deref;
      if (isNil) valueErr("slice of nil pointer");
      if (idx.length > 3) valueErr(`too many slice indexes: ${idx.length}`);
      let cap: number;
      if (item.kind === "string") {
        if (idx.length === 3) valueErr("cannot 3-index slice a string");
        cap = byteLen(item.v as string);
      } else if (item.kind === "slice") cap = ((item.v as GV[] | null) ?? []).length;
      else return valueErr(`can't slice item of type ${item.type!.name}`);
      const ix = [0, cap, cap];
      idx.forEach((v, i) => (ix[i] = indexArg(unIface(v), cap)));
      if (ix[0] > ix[1]) valueErr(`invalid slice index: ${ix[0]} > ${ix[1]}`);
      if (idx.length === 3 && ix[1] > ix[2]) valueErr(`invalid slice index: ${ix[1]} > ${ix[2]}`);
      if (item.kind === "string") return str(dec.decode(enc.encode(item.v as string).subarray(ix[0], ix[1])));
      const items = item.v as GV[] | null;
      if (items === null) return slice(item.type!, ix[0] === 0 && ix[1] === 0 ? null : []);
      return slice(item.type!, items.slice(ix[0], ix[1]));
    },
  },
  eq: { variadic: true, nIn: 2, argTypes: ["value", "value"], fn: eqFn },
  ne: { variadic: false, nIn: 2, argTypes: ["value", "value"], fn: ([a, b]) => bool(!eqFn([a, b]).v) },
  lt: { variadic: false, nIn: 2, argTypes: ["value", "value"], fn: ([a, b]) => bool(ltFn(a, b)) },
  le: { variadic: false, nIn: 2, argTypes: ["value", "value"], fn: ([a, b]) => bool(ltFn(a, b) || (eqFn([a, b]).v as boolean)) },
  gt: { variadic: false, nIn: 2, argTypes: ["value", "value"], fn: ([a, b]) => bool(!(ltFn(a, b) || (eqFn([a, b]).v as boolean))) },
  ge: { variadic: false, nIn: 2, argTypes: ["value", "value"], fn: ([a, b]) => bool(!ltFn(a, b)) },
  and: { variadic: true, nIn: 2, argTypes: ["value"], fn: () => INVALID },
  or: { variadic: true, nIn: 2, argTypes: ["value"], fn: () => INVALID },
  call: { variadic: true, nIn: 2, argTypes: ["value"], fn: () => valueErr("call of nil") },
};

/** printableValue。null は印字できないもの。 */
function printable(v: GV): GV | null {
  if (v.valid && v.kind === "ptr") v = indirect(v)[0];
  if (!v.valid) return str("<no value>");
  return v;
}

export type UserFunc = { variadic: boolean; nIn: number; argTypes: ("any" | "string" | "value")[]; fn: (args: GV[]) => GV };

export type Template = Parsed & { funcs: Record<string, UserFunc> };

export function compile(text: string, funcs: Record<string, UserFunc> = {}): Template {
  return { ...parse(text, Object.keys(funcs)), funcs };
}

class State {
  out: string[] = [];
  vars: Frame[] = [];
  node: Node | null = null;
  depth = 0;
  /** Option("missingkey=zero")(Ollama の Parse が付ける)。 */
  missingKeyZero = true;
  constructor(
    public tmpl: Template,
    public name = "",
  ) {}

  errorf(msg: string): never {
    if (!this.node) throw new ExecError(`template: ${this.name}: ${msg}`);
    const { location, context } = this.errorContext(this.node);
    throw new ExecError(`template: ${location}: executing ${quoteGo(this.name)} at <${context}>: ${msg}`);
  }
  errorContext(n: Node) {
    const pos = n.pos;
    const bytes = enc.encode(this.tmpl.text).subarray(0, pos);
    let lastNL = -1;
    let lines = 1;
    for (let i = 0; i < bytes.length; i++)
      if (bytes[i] === 0x0a) {
        lastNL = i;
        lines++;
      }
    const col = lastNL === -1 ? pos : pos - (lastNL + 1);
    const context = nodeString(n);
    return { location: `:${lines}:${col}`, context };
  }
  at(n: Node) {
    this.node = n;
  }
  push(name: string, value: GV) {
    this.vars.push({ name, value });
  }
  mark() {
    return this.vars.length;
  }
  pop(m: number) {
    this.vars.length = m;
  }
  setVar(name: string, value: GV) {
    for (let i = this.vars.length - 1; i >= 0; i--)
      if (this.vars[i].name === name) {
        this.vars[i].value = value;
        return;
      }
    this.errorf(`undefined variable: ${name}`);
  }
  setTopVar(n: number, value: GV) {
    this.vars[this.vars.length - n].value = value;
  }
  varValue(name: string): GV {
    for (let i = this.vars.length - 1; i >= 0; i--) if (this.vars[i].name === name) return this.vars[i].value;
    return this.errorf(`undefined variable: ${name}`);
  }

  walk(dot: GV, node: Node): void {
    this.at(node);
    switch (node.t) {
      case "action": {
        const val = this.evalPipeline(dot, node.pipe);
        if (node.pipe.decl.length === 0) this.printValue(node, val);
        return;
      }
      case "break":
        throw new Break();
      case "continue":
        throw new Continue();
      case "if":
      case "with": {
        const m = this.mark();
        try {
          const val = this.evalPipeline(dot, node.pipe);
          const truth = isTrue(unIface(val));
          if (truth) this.walk(node.t === "with" ? val : dot, node.list);
          else if (node.elseList) this.walk(dot, node.elseList);
        } finally {
          this.pop(m);
        }
        return;
      }
      case "list":
        for (const n of node.nodes) this.walk(dot, n);
        return;
      case "range":
        return this.walkRange(dot, node);
      case "template":
        return this.walkTemplate(dot, node);
      case "text":
        this.out.push(node.text);
        return;
    }
    this.errorf(`unknown node: ${nodeString(node)}`);
  }

  walkRange(dot: GV, r: BranchNode) {
    this.at(r);
    const m0 = this.mark();
    try {
      const [val] = indirect(this.evalPipeline(dot, r.pipe));
      const mark = this.mark();
      const one = (index: GV, elem: GV) => {
        if (r.pipe.decl.length > 0) {
          if (r.pipe.isAssign) this.setVar(r.pipe.decl[0].ident[0], r.pipe.decl.length > 1 ? index : elem);
          else this.setTopVar(1, elem);
        }
        if (r.pipe.decl.length > 1) {
          if (r.pipe.isAssign) this.setVar(r.pipe.decl[1].ident[0], elem);
          else this.setTopVar(2, index);
        }
        try {
          this.walk(elem, r.list);
        } catch (e) {
          if (!(e instanceof Continue)) throw e;
        } finally {
          this.pop(mark);
        }
      };
      try {
        if (val.valid && val.kind === "int") {
          if (r.pipe.decl.length > 1) this.errorf(`can't use ${fmtV(val)} to iterate over more than one variable`);
          const n = val.v as number;
          if (n > 0) {
            for (let i = 0; i < n; i++) one(INVALID, int(i));
            return;
          }
        } else if (val.valid && val.kind === "slice") {
          const items = (val.v as GV[] | null) ?? [];
          if (items.length) {
            items.forEach((it, i) => one(int(i), it));
            return;
          }
        } else if (val.valid && val.kind === "map") {
          const mm = (val.v as Map<string, GV> | null) ?? new Map<string, GV>();
          if (mm.size) {
            for (const k of [...mm.keys()].sort(cmpStr)) one(str(k), mm.get(k)!);
            return;
          }
        } else if (!val.valid) {
          // nil は空と同じ
        } else this.errorf(`range can't iterate over ${fmtV(val)}`);
      } catch (e) {
        if (e instanceof Break) return;
        throw e;
      }
      if (r.elseList) this.walk(dot, r.elseList);
    } finally {
      this.pop(m0);
    }
  }

  walkTemplate(dot: GV, t: Extract<Node, { t: "template" }>) {
    this.at(t);
    const body = this.tmpl.defs.get(t.name);
    if (!body) this.errorf(`template ${quoteGo(t.name)} not defined`);
    if (this.depth >= 100000) this.errorf("exceeded maximum template depth (100000)");
    dot = t.pipe ? this.evalPipeline(dot, t.pipe) : INVALID;
    const saveVars = this.vars;
    const saveName = this.name;
    this.vars = [{ name: "$", value: dot }];
    this.name = t.name;
    this.depth++;
    try {
      this.walk(dot, body!);
    } finally {
      this.vars = saveVars;
      this.name = saveName;
      this.depth--;
    }
  }

  evalPipeline(dot: GV, pipe: PipeNode | null): GV {
    if (!pipe) return INVALID;
    this.at(pipe);
    let value = MISSING;
    for (const cmd of pipe.cmds) {
      value = this.evalCommand(dot, cmd, value);
      if (value.valid && value.kind === "iface") value = value.v === null ? INVALID : (value.v as GV);
    }
    for (const v of pipe.decl) {
      if (pipe.isAssign) this.setVar(v.ident[0], value);
      else this.push(v.ident[0], value);
    }
    return value;
  }

  notAFunction(args: Node[], final: GV) {
    if (args.length > 1 || !isMissing(final)) this.errorf(`can't give argument to non-function ${nodeString(args[0])}`);
  }

  evalCommand(dot: GV, cmd: CommandNode, final: GV): GV {
    const first = cmd.args[0];
    switch (first.t) {
      case "field":
        return this.evalFieldNode(dot, first, cmd.args, final);
      case "chain":
        return this.evalChainNode(dot, first, cmd.args, final);
      case "identifier":
        return this.evalFunction(dot, first, cmd, cmd.args, final);
      case "pipe":
        this.notAFunction(cmd.args, final);
        return this.evalPipeline(dot, first);
      case "variable":
        return this.evalVariableNode(dot, first, cmd.args, final);
    }
    this.at(first);
    this.notAFunction(cmd.args, final);
    switch (first.t) {
      case "bool":
        return bool(first.val);
      case "dot":
        return dot;
      case "nil":
        this.errorf("nil is not a command");
      // falls through
      case "number":
        return this.idealConstant(first);
      case "string":
        return str(first.text);
    }
    return this.errorf(`can't evaluate command ${quoteGo(nodeString(first))}`);
  }

  idealConstant(c: NumberNode): GV {
    this.at(c);
    if (c.isComplex) return this.errorf("complex constants are not supported");
    const isHexInt = /^0[xX]/.test(c.text) && !/[pP]/.test(c.text);
    if (c.isFloat && !isHexInt && !c.text.startsWith("'") && /[.eEpP]/.test(c.text)) return float(c.float);
    if (c.isInt) return int(c.int);
    if (c.isUint) this.errorf(`${c.text} overflows int`);
    return INVALID;
  }

  evalFieldNode(dot: GV, field: Extract<Node, { t: "field" }>, args: Node[], final: GV) {
    this.at(field);
    return this.evalFieldChain(dot, dot, field, field.ident, args, final);
  }
  evalChainNode(dot: GV, chain: Extract<Node, { t: "chain" }>, args: Node[], final: GV) {
    this.at(chain);
    if (chain.node.t === "nil") this.errorf(`indirection through explicit nil in ${nodeString(chain)}`);
    const pipe = this.evalArg(dot, null, chain.node);
    return this.evalFieldChain(dot, pipe, chain, chain.field, args, final);
  }
  evalVariableNode(dot: GV, v: Extract<Node, { t: "variable" }>, args: Node[], final: GV) {
    this.at(v);
    const value = this.varValue(v.ident[0]);
    if (v.ident.length === 1) {
      this.notAFunction(args, final);
      return value;
    }
    return this.evalFieldChain(dot, value, v, v.ident.slice(1), args, final);
  }
  evalFieldChain(dot: GV, receiver: GV, node: Node, ident: string[], args: Node[], final: GV) {
    for (let i = 0; i < ident.length - 1; i++) receiver = this.evalField(dot, ident[i], node, [], MISSING, receiver);
    return this.evalField(dot, ident[ident.length - 1], node, args, final, receiver);
  }
  evalField(_dot: GV, name: string, node: Node, args: Node[], final: GV, receiver: GV): GV {
    if (!receiver.valid) return INVALID;
    const typ = receiver.type!;
    const [recv, isNil] = indirect(receiver);
    if (recv.valid && recv.kind === "iface" && isNil) this.errorf(`nil pointer evaluating ${typ.name}.${name}`);
    // メソッド
    const mt = recv.valid && recv.type!.methods?.[name] ? recv.type! : typ.methods?.[name] ? typ : null;
    if (mt) {
      const hasArgs = args.length > 1 || !isMissing(final);
      if (hasArgs) this.errorf(`wrong number of args for ${name}: want 0 got ${args.length - 1 + (isMissing(final) ? 0 : 1)}`);
      if (isNil && typ.kind === "ptr") this.errorf(`nil pointer evaluating ${typ.name}.${name}`);
      return mt.methods![name](mt === typ ? receiver : recv);
    }
    if (mt === null && typ.stringer && name === "String") return str(typ.stringer(receiver));
    const hasArgs = args.length > 1 || !isMissing(final);
    if (recv.valid && recv.kind === "struct" && !isNil) {
      const idx = (recv.type!.fields ?? []).findIndex((f) => f.name === name);
      if (idx >= 0) {
        if (!/^\p{Lu}/u.test(name)) this.errorf(`${name} is an unexported field of struct type ${typ.name}`);
        if (hasArgs) this.errorf(`${name} has arguments but cannot be invoked as function`);
        return (recv.v as GV[])[idx];
      }
    } else if (recv.valid && recv.kind === "map") {
      if (hasArgs) this.errorf(`${name} is not a method but has arguments`);
      const m = recv.v as Map<string, GV> | null;
      const r = m?.get(name);
      if (r) return r;
      return this.missingKeyZero ? zeroOf(recv.type!.elem!) : INVALID;
    } else if (isNil && typ.kind === "ptr") {
      const et = typ.elem!;
      if (et.kind === "struct" && !(et.fields ?? []).some((f) => f.name === name)) {
        // 下の can't evaluate
      } else this.errorf(`nil pointer evaluating ${typ.name}.${name}`);
    }
    return this.errorf(`can't evaluate field ${name} in type ${typ.name}`);
  }

  evalFunction(dot: GV, node: Extract<Node, { t: "identifier" }>, cmd: Node, args: Node[], final: GV): GV {
    this.at(node);
    const name = node.ident;
    const user = this.tmpl.funcs[name];
    const fn = user ?? BUILTIN_FUNCS[name];
    if (!fn) this.errorf(`${quoteGo(name)} is not a defined function`);
    return this.evalCall(dot, fn!, !user, cmd, name, args, final);
  }

  evalCall(dot: GV, fn: Builtin | UserFunc, isBuiltin: boolean, node: Node, name: string, args: Node[], final: GV): GV {
    const a = args.slice(1);
    let numIn = a.length;
    if (!isMissing(final)) numIn++;
    let numFixed = a.length;
    if (fn.variadic) {
      numFixed = fn.nIn - 1;
      if (numIn < numFixed) this.errorf(`wrong number of args for ${name}: want at least ${fn.nIn - 1} got ${a.length}`);
    } else if (numIn !== fn.nIn) this.errorf(`wrong number of args for ${name}: want ${fn.nIn} got ${numIn}`);
    const argType = (i: number) => fn.argTypes[Math.min(i, fn.argTypes.length - 1)];
    if (isBuiltin && (name === "and" || name === "or")) {
      let v = INVALID;
      for (const arg of a) {
        v = this.evalArg(dot, "value", arg);
        if (isTrue(unIface(v)) === (name === "or")) return v;
      }
      if (!isMissing(final)) v = final;
      return v;
    }
    const argv: GV[] = [];
    let i = 0;
    for (; i < numFixed && i < a.length; i++) argv.push(this.evalArg(dot, argType(i), a[i]));
    if (fn.variadic) for (; i < a.length; i++) argv.push(this.evalArg(dot, argType(fn.nIn - 1), a[i]));
    if (!isMissing(final)) argv.push(this.validateType(final, argType(fn.variadic && numIn - 1 >= numFixed ? fn.nIn - 1 : numIn - 1)));
    if (isBuiltin && name === "call") {
      this.at(node);
      this.errorf(`error calling call: ${argv.length && argv[0].valid ? `non-function ${a[0] ? nodeString(a[0]) : fmtV(final)} of type ${argv[0].type!.name}` : "call of nil"}`);
    }
    try {
      return fn.fn(argv);
    } catch (e) {
      if (e instanceof FuncError) {
        this.at(node);
        this.errorf(`error calling ${name}: ${e.message}`);
      }
      throw e;
    }
  }

  validateType(value: GV, typ: "any" | "string" | "value" | null): GV {
    if (!value.valid) {
      if (typ === null || typ === "any" || typ === "value") return INVALID;
      this.errorf(`invalid value; expected ${typ}`);
    }
    if (typ === "string") {
      let v = value;
      if (v.kind === "iface" && v.v !== null) v = v.v as GV;
      if (v.kind === "ptr" && v.v !== null && (v.v as GV).kind === "string") v = v.v as GV;
      if (v.kind !== "string" || v.type!.name !== "string") this.errorf(`wrong type for value; expected string; got ${value.type!.name}`);
      return v;
    }
    return value;
  }

  evalArg(dot: GV, typ: "any" | "string" | "value" | null, n: Node): GV {
    this.at(n);
    switch (n.t) {
      case "dot":
        return this.validateType(dot, typ);
      case "nil":
        if (typ === "any" || typ === "value") return INVALID;
        return this.errorf(`cannot assign nil to ${typ}`);
      case "field":
        return this.validateType(this.evalFieldNode(dot, n, [n], MISSING), typ);
      case "variable":
        return this.validateType(this.evalVariableNode(dot, n, [], MISSING), typ);
      case "pipe":
        return this.validateType(this.evalPipeline(dot, n), typ);
      case "identifier":
        return this.validateType(this.evalFunction(dot, n, n, [], MISSING), typ);
      case "chain":
        return this.validateType(this.evalChainNode(dot, n, [], MISSING), typ);
    }
    if (typ === "string") {
      if (n.t === "string") return str(n.text);
      return this.errorf(`expected string; found ${nodeString(n)}`);
    }
    switch (n.t) {
      case "bool":
        return bool(n.val);
      case "number":
        return this.idealConstant(n);
      case "string":
        return str(n.text);
    }
    return this.errorf(`can't handle ${nodeString(n)} for arg of type ${typ}`);
  }

  printValue(n: Node, v: GV) {
    this.at(n);
    const p = printable(v);
    if (!p) this.errorf(`can't print ${nodeString(n)} of type ${v.type!.name}`);
    this.out.push(fmtV(p!, 0));
  }
}

/** テンプレートを実行する。失敗すると ExecError(Go と同じ文言)を投げる。 */
export function execute(tmpl: Template, data: GV, root: ListNode = tmpl.root, opts: { missingKeyZero?: boolean } = {}): string {
  const s = new State(tmpl);
  s.missingKeyZero = opts.missingKeyZero ?? true;
  s.vars = [{ name: "$", value: data }];
  try {
    s.walk(data, root);
  } catch (e) {
    if (e instanceof Break || e instanceof Continue) throw new ExecError("template: break/continue outside range");
    throw e;
  }
  return s.out.join("");
}
