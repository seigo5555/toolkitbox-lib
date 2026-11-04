/**
 * LLM が返した「ほぼJSON」を、正しいJSONに直す。
 *
 * JSON の文法は RFC 8259 / ECMA-404。コメント、末尾のカンマ、シングルクォート、
 * キーの引用符なし、NaN / Infinity、Python の True / None は、どれも JSON ではない。
 * モデルはこれらを混ぜて返しがちで、JSON.parse が落ちる。
 *
 * 方針:
 *  1. **意味が一意に決まる直しだけ**を行う。何をどう直したかを、種類ごとの件数で返す
 *  2. **情報が失われうる直し**(途中で切れた出力を閉じる、NaN を null にする)は
 *     lossy として別に知らせる。利用者が「欠けているかもしれない」と気づけるように
 *  3. 直せない入力は、無理に推測せず、位置つきの失敗として返す
 *  4. 数値は元の文字列のまま扱う。JS の number に通すと 12345678901234567890 のような
 *     大きな整数の精度が落ちるため
 *
 * 正規表現で置換せず、字句を1つずつ読む再帰下降で作った。
 * 文字列の中身(たとえば "a, ]" )を、構造の一部と取り違えないため。
 */

export type RepairCode =
  | "fence"
  | "prose"
  | "comments"
  | "trailingComma"
  | "missingComma"
  | "singleQuotes"
  | "curlyQuotes"
  | "unquotedKey"
  | "pythonLiteral"
  | "undefinedToNull"
  | "controlChar"
  | "badEscape"
  | "numberFormat"
  | "nonFinite"
  | "truncated";

/** この種類の直しは、元の入力にあった情報を失う、または推測を含む。 */
export const LOSSY: ReadonlySet<RepairCode> = new Set<RepairCode>(["nonFinite", "truncated", "undefinedToNull"]);

export type Repair = { code: RepairCode; count: number };

export type RepairError = { message: ErrorCode; position: number };
export type ErrorCode =
  | "empty"
  | "noJson"
  | "unexpectedChar"
  | "unexpectedEnd"
  | "expectedColon"
  | "badKey"
  | "badValue"
  | "tooDeep"
  | "placeholder";

export type RepairResult =
  | { ok: true; json: string; repairs: Repair[]; lossy: boolean; unchanged: boolean }
  | { ok: false; error: RepairError };

export type Indent = 0 | 2 | 4 | "tab";

type Node =
  | { t: "obj"; entries: [string, Node][] }
  | { t: "arr"; items: Node[] }
  | { t: "str"; v: string }
  | { t: "num"; raw: string }
  | { t: "lit"; v: "true" | "false" | "null" };

class Fail extends Error {
  constructor(public code: ErrorCode, public pos: number) {
    super(code);
  }
}

const MAX_DEPTH = 200;
const WS = /[ \t\n\r ﻿]/;
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$-]/;

function closingQuote(open: string): string {
  return open === "“" ? "”" : open;
}

class Parser {
  pos = 0;
  repairs = new Map<RepairCode, number>();
  constructor(private s: string, start: number) {
    this.pos = start;
  }

  note(code: RepairCode) {
    this.repairs.set(code, (this.repairs.get(code) ?? 0) + 1);
  }

  atEnd() {
    return this.pos >= this.s.length;
  }

  /** 空白とコメントを読み飛ばす。 */
  skip() {
    for (;;) {
      while (this.pos < this.s.length && WS.test(this.s[this.pos])) this.pos++;
      if (this.s.startsWith("//", this.pos)) {
        const nl = this.s.indexOf("\n", this.pos);
        this.pos = nl === -1 ? this.s.length : nl + 1;
        this.note("comments");
        continue;
      }
      if (this.s.startsWith("/*", this.pos)) {
        const end = this.s.indexOf("*/", this.pos + 2);
        this.pos = end === -1 ? this.s.length : end + 2;
        this.note("comments");
        continue;
      }
      return;
    }
  }

  value(depth: number): Node {
    if (depth > MAX_DEPTH) throw new Fail("tooDeep", this.pos);
    this.skip();
    if (this.atEnd()) throw new Fail("unexpectedEnd", this.pos);
    const c = this.s[this.pos];
    if (c === "{") return this.object(depth);
    if (c === "[") return this.array(depth);
    if (c === '"' || c === "'" || c === "“") return { t: "str", v: this.string() };
    if (c === "-" || c === "+" || c === "." || (c >= "0" && c <= "9")) return this.number();
    if (IDENT_START.test(c)) return this.word();
    if (c === "." && this.s.startsWith("...", this.pos)) throw new Fail("placeholder", this.pos);
    throw new Fail("unexpectedChar", this.pos);
  }

  object(depth: number): Node {
    this.pos++; // {
    const entries: [string, Node][] = [];
    for (;;) {
      this.skip();
      if (this.atEnd()) {
        this.note("truncated");
        return { t: "obj", entries };
      }
      const c = this.s[this.pos];
      if (c === "}") {
        this.pos++;
        return { t: "obj", entries };
      }
      if (this.s.startsWith("...", this.pos)) throw new Fail("placeholder", this.pos);

      // キー
      let key: string;
      if (c === '"' || c === "'" || c === "“") {
        key = this.string();
      } else if (IDENT_START.test(c) || (c >= "0" && c <= "9")) {
        const start = this.pos;
        while (this.pos < this.s.length && IDENT_PART.test(this.s[this.pos])) this.pos++;
        key = this.s.slice(start, this.pos);
        this.note("unquotedKey");
      } else {
        throw new Fail("badKey", this.pos);
      }

      this.skip();
      if (this.atEnd()) {
        // キーだけで切れている。値が無いので、そのキーは捨てる。
        this.note("truncated");
        return { t: "obj", entries };
      }
      if (this.s[this.pos] !== ":") throw new Fail("expectedColon", this.pos);
      this.pos++;
      this.skip();
      if (this.atEnd()) {
        this.note("truncated");
        return { t: "obj", entries };
      }
      entries.push([key, this.value(depth + 1)]);

      // 区切り
      this.skip();
      if (this.atEnd()) {
        this.note("truncated");
        return { t: "obj", entries };
      }
      const d = this.s[this.pos];
      if (d === ",") {
        this.pos++;
        this.skip();
        if (this.s[this.pos] === "}") this.note("trailingComma");
        continue;
      }
      if (d === "}") continue;
      // カンマ抜け: 次がキーに見えるなら、改行で区切られた項目として受ける。
      if (d === '"' || d === "'" || d === "“" || IDENT_START.test(d)) {
        this.note("missingComma");
        continue;
      }
      throw new Fail("unexpectedChar", this.pos);
    }
  }

  array(depth: number): Node {
    this.pos++; // [
    const items: Node[] = [];
    for (;;) {
      this.skip();
      if (this.atEnd()) {
        this.note("truncated");
        return { t: "arr", items };
      }
      if (this.s[this.pos] === "]") {
        this.pos++;
        return { t: "arr", items };
      }
      if (this.s.startsWith("...", this.pos)) throw new Fail("placeholder", this.pos);
      items.push(this.value(depth + 1));

      this.skip();
      if (this.atEnd()) {
        this.note("truncated");
        return { t: "arr", items };
      }
      const d = this.s[this.pos];
      if (d === ",") {
        this.pos++;
        this.skip();
        if (this.s[this.pos] === "]") this.note("trailingComma");
        continue;
      }
      if (d === "]") continue;
      // カンマ抜け: 次が値の始まりに見えるときだけ受ける。
      if (d === "{" || d === "[" || d === '"' || d === "'" || d === "“" || d === "-" || (d >= "0" && d <= "9") || IDENT_START.test(d)) {
        this.note("missingComma");
        continue;
      }
      throw new Fail("unexpectedChar", this.pos);
    }
  }

  string(): string {
    const open = this.s[this.pos];
    const close = closingQuote(open);
    if (open === "'") this.note("singleQuotes");
    if (open === "“") this.note("curlyQuotes");
    this.pos++;
    let out = "";
    for (;;) {
      if (this.atEnd()) {
        this.note("truncated");
        return out;
      }
      const c = this.s[this.pos];
      if (c === close) {
        this.pos++;
        return out;
      }
      if (c === "\\") {
        const n = this.s[this.pos + 1];
        if (n === undefined) {
          this.pos++;
          continue;
        }
        this.pos += 2;
        switch (n) {
          case "n": out += "\n"; break;
          case "t": out += "\t"; break;
          case "r": out += "\r"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "/": out += "/"; break;
          case "\\": out += "\\"; break;
          case '"': out += '"'; break;
          case "u": {
            const hex = this.s.slice(this.pos, this.pos + 4);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              out += String.fromCharCode(parseInt(hex, 16));
              this.pos += 4;
            } else {
              out += "u";
              this.note("badEscape");
            }
            break;
          }
          default:
            // \' など、JSON には無いエスケープ。文字そのものとして読む。
            out += n;
            this.note("badEscape");
        }
        continue;
      }
      if (c < " ") {
        // 文字列中の生の改行・タブ。JSON では \n \t と書かなければならない。
        out += c;
        this.note("controlChar");
        this.pos++;
        continue;
      }
      out += c;
      this.pos++;
    }
  }

  number(): Node {
    const m = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(this.s.slice(this.pos, this.pos + 400));
    if (!m) {
      // -Infinity
      if (/^[+-]Infinity/.test(this.s.slice(this.pos, this.pos + 9))) {
        this.pos += 9;
        this.note("nonFinite");
        return { t: "lit", v: "null" };
      }
      throw new Fail("badValue", this.pos);
    }
    this.pos += m[0].length;
    const raw = m[0];
    const norm = normalizeNumber(raw);
    if (norm !== raw) this.note("numberFormat");
    return { t: "num", raw: norm };
  }

  word(): Node {
    const start = this.pos;
    while (this.pos < this.s.length && /[A-Za-z0-9_$]/.test(this.s[this.pos])) this.pos++;
    const w = this.s.slice(start, this.pos);
    switch (w) {
      case "true": case "false": case "null":
        return { t: "lit", v: w };
      case "True": return this.py("true");
      case "False": return this.py("false");
      case "None": return this.py("null");
      case "undefined":
        this.note("undefinedToNull");
        return { t: "lit", v: "null" };
      case "NaN": case "Infinity":
        this.note("nonFinite");
        return { t: "lit", v: "null" };
      default:
        this.pos = start;
        throw new Fail("badValue", start);
    }
  }

  private py(v: "true" | "false" | "null"): Node {
    this.note("pythonLiteral");
    return { t: "lit", v };
  }
}

/** JSON の数値の書き方に直す。値は変えない。 */
function normalizeNumber(raw: string): string {
  let s = raw;
  let sign = "";
  if (s[0] === "+" || s[0] === "-") {
    sign = s[0] === "-" ? "-" : "";
    s = s.slice(1);
  }
  if (/^0[xX]/.test(s)) return sign + BigInt(s).toString();
  if (s.startsWith(".")) s = "0" + s;
  s = s.replace(/\.(?=$|[eE])/, "");
  // 先頭の0(007 → 7)。0 と 0.5 は残す。
  s = s.replace(/^0+(?=\d)/, "");
  return sign + s;
}

function serialize(n: Node, indent: Indent, depth: number): string {
  const unit = indent === "tab" ? "\t" : indent === 0 ? "" : " ".repeat(indent);
  const nl = indent === 0 ? "" : "\n";
  const pad = (d: number) => (indent === 0 ? "" : unit.repeat(d));
  switch (n.t) {
    case "str": return JSON.stringify(n.v);
    case "num": return n.raw;
    case "lit": return n.v;
    case "arr": {
      if (n.items.length === 0) return "[]";
      const inner = n.items.map((x) => pad(depth + 1) + serialize(x, indent, depth + 1));
      return "[" + nl + inner.join("," + nl) + nl + pad(depth) + "]";
    }
    case "obj": {
      if (n.entries.length === 0) return "{}";
      // 同じキーが重複したら、JSON.parse と同じく後のものを採る(位置は最初の出現)。
      const seen = new Map<string, Node>();
      for (const [k, v] of n.entries) seen.set(k, v);
      const sep = indent === 0 ? ":" : ": ";
      const inner = [...seen].map(([k, v]) => pad(depth + 1) + JSON.stringify(k) + sep + serialize(v, indent, depth + 1));
      return "{" + nl + inner.join("," + nl) + nl + pad(depth) + "}";
    }
  }
}

/** コードフェンス(```json … ```)の中身と、フェンスの外の文章を取り出す。なければ null。 */
function fenceContent(text: string): { body: string; offset: number; outside: string } | null {
  const re = /```[A-Za-z0-9_-]*[ \t]*\r?\n?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const from = m.index + m[0].length;
    const end = text.indexOf("```", from);
    const body = end === -1 ? text.slice(from) : text.slice(from, end);
    if (/[{[]/.test(body)) {
      const outside = text.slice(0, m.index) + (end === -1 ? "" : text.slice(end + 3));
      return { body, offset: from, outside };
    }
  }
  return null;
}

export function repairJson(input: string, indent: Indent = 2): RepairResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: { message: "empty", position: 0 } };

  const repairs = new Map<RepairCode, number>();
  const add = (c: RepairCode, n = 1) => repairs.set(c, (repairs.get(c) ?? 0) + n);

  let text = input;
  let base = 0;
  const fence = text.includes("```") ? fenceContent(text) : null;
  if (fence) {
    text = fence.body;
    base = fence.offset;
    add("fence");
    if (fence.outside.trim() !== "") add("prose"); // フェンスの外の説明文
  }

  // 最初の { か [ から読む。手前の文章は捨てる。
  const first = text.search(/[{[]/);
  if (first === -1) return { ok: false, error: { message: "noJson", position: 0 } };
  if (text.slice(0, first).trim() !== "") add("prose");

  const p = new Parser(text, first);
  let node: Node;
  try {
    node = p.value(0);
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: { message: e.code, position: base + e.pos } };
    throw e;
  }
  // 値の後ろに残った文章(「以上です」など)。
  p.skip();
  if (!p.atEnd() && text.slice(p.pos).trim() !== "" && !repairs.has("prose")) add("prose");

  for (const [k, v] of p.repairs) add(k, v);

  const json = serialize(node, indent, 0);
  // 自分の出力が本当にJSONであることを確かめる。ここで落ちたら実装のバグ。
  JSON.parse(json);

  const list: Repair[] = [...repairs].map(([code, count]) => ({ code, count }));
  const lossy = list.some((r) => LOSSY.has(r.code));
  return { ok: true, json, repairs: list, lossy, unchanged: list.length === 0 };
}
