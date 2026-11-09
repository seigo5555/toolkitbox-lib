/**
 * Jinja2 のテンプレートが扱う Python の値を TypeScript で表したもの。
 * Jinja2 は Python にコンパイルされて動くので、出力や比較・演算・エラーの文言は Python(CPython 3.14)の決まりに従う。
 * ここではチャットテンプレートに出てくる型(str・int・float・bool・None・list・tuple・dict と Jinja2 の部品)を扱う。
 *
 * 値の表し方:
 *   str → string(数えるときはコードポイント単位) / int → bigint / float → number / bool → boolean / None → null
 *   list → 配列 / tuple → PyTuple / dict → PyDict / それ以外 → PyObject の子クラス
 *
 * 元のコードのライセンス(原文)は、toolkitbox-lib の THIRD_PARTY_NOTICES.md と、サイトの /licenses に載せている。
 */

// ---------------------------------------------------------------- 例外

/** Python の例外。pyType は表に出す型名(TypeError・UndefinedError など)。 */
export class PyException extends Error {
  /** テンプレートの何行目で起きたか(わかるとき)。 */
  lineno: number | null = null;
  constructor(
    readonly pyType: string,
    message: string,
  ) {
    super(message);
  }
}

export const LOOKUP_ERRORS = new Set(["IndexError", "KeyError", "LookupError"]);

export const typeError = (m: string) => new PyException("TypeError", m);
export const valueError = (m: string) => new PyException("ValueError", m);

// ---------------------------------------------------------------- 型

export type PyVal = null | boolean | bigint | number | string | PyVal[] | PyObject;
export type Kw = Map<string, PyVal>;
export const noKw = (): Kw => new Map();

/** list・dict 以外の Python のオブジェクトの共通部分。 */
export abstract class PyObject {
  abstract get typeName(): string;
  /** type(obj).__module__ */
  get typeModule(): string {
    return "builtins";
  }
  repr(): string {
    return `<${this.typeModule === "builtins" ? "" : this.typeModule + "."}${this.typeName} object at 0x0>`;
  }
  str(): string {
    return this.repr();
  }
  truthy(): boolean {
    const n = this.len();
    return n === null ? true : n > 0;
  }
  /** __len__ が無ければ null。 */
  len(): number | null {
    return null;
  }
  /** __iter__ が無ければ null。 */
  iter(): Iterator<PyVal> | null {
    return null;
  }
  /** 属性。無ければ NOATTR。 */
  getAttr(name: string): PyVal | typeof NOATTR {
    void name;
    return NOATTR;
  }
  /** obj[key]。無いときは KeyError・IndexError・TypeError を投げる。 */
  getItem(key: PyVal): PyVal {
    void key;
    throw typeError(`'${this.typeName}' object is not subscriptable`);
  }
  /** 呼び出せないなら null。 */
  get callable(): ((args: PyVal[], kw: Kw) => PyVal) | null {
    return null;
  }
  /** __eq__。既定は同じものかどうか。 */
  eq(other: PyVal): boolean {
    return this === other;
  }
  /** __contains__ が無ければ null(そのときは __iter__ で探す)。 */
  contains(x: PyVal): boolean | null {
    void x;
    return null;
  }
  /** isinstance(obj, str) になるもの(Markup)。 */
  get isStr(): boolean {
    return false;
  }
}

export const NOATTR: unique symbol = Symbol("noattr");

export class PyTuple extends PyObject {
  constructor(
    readonly items: PyVal[],
    /** namedtuple の名前つき項目(groupby の grouper・list)。 */
    readonly names: string[] | null = null,
  ) {
    super();
  }
  get typeName() {
    return "tuple";
  }
  repr() {
    return reprTuple(this.items);
  }
  len() {
    return this.items.length;
  }
  iter() {
    return this.items[Symbol.iterator]();
  }
  getAttr(name: string) {
    if (this.names) {
      const i = this.names.indexOf(name);
      if (i >= 0) return this.items[i];
    }
    return seqMethod(this, name);
  }
  getItem(key: PyVal) {
    return seqIndex(this.items, key, "tuple");
  }
  eq(o: PyVal): boolean {
    return o instanceof PyTuple && seqEq(this.items, o.items);
  }
  contains(x: PyVal) {
    return this.items.some((y) => pyEq(x, y));
  }
}

/** dict。キーは Python の hash の決まり(1 == 1.0 == True)で同じものとみなす。 */
export class PyDict extends PyObject {
  private m = new Map<string, [PyVal, PyVal]>();
  constructor(entries?: Iterable<[PyVal, PyVal]>) {
    super();
    if (entries) for (const [k, v] of entries) this.set(k, v);
  }
  get typeName() {
    return "dict";
  }
  get size() {
    return this.m.size;
  }
  has(k: PyVal) {
    return this.m.has(hashKey(k));
  }
  get(k: PyVal): PyVal | undefined {
    return this.m.get(hashKey(k))?.[1];
  }
  set(k: PyVal, v: PyVal) {
    const h = hashKey(k);
    const cur = this.m.get(h);
    // Python は先に入ったキーの形を残す({1: 'a', True: 'b'} → {1: 'b'})
    if (cur) cur[1] = v;
    else this.m.set(h, [k, v]);
  }
  delete(k: PyVal) {
    this.m.delete(hashKey(k));
  }
  keys(): PyVal[] {
    return [...this.m.values()].map((e) => e[0]);
  }
  values(): PyVal[] {
    return [...this.m.values()].map((e) => e[1]);
  }
  entries(): [PyVal, PyVal][] {
    return [...this.m.values()].map((e) => [e[0], e[1]]);
  }
  copy(): PyDict {
    return new PyDict(this.entries());
  }
  repr() {
    return reprDict(this);
  }
  len() {
    return this.m.size;
  }
  iter() {
    return this.keys()[Symbol.iterator]();
  }
  getAttr(name: string) {
    return dictMethod(this, name);
  }
  getItem(key: PyVal) {
    const v = this.get(key);
    if (v === undefined) throw new PyException("KeyError", repr(key));
    return v;
  }
  eq(o: PyVal): boolean {
    if (!(o instanceof PyDict) || o.size !== this.size) return false;
    for (const [k, v] of this.entries()) {
      const w = o.get(k);
      if (w === undefined || !pyEq(v, w)) return false;
    }
    return true;
  }
  contains(x: PyVal) {
    return this.has(x);
  }
}

/** markupsafe.Markup(str の子クラス)。 */
export class Markup extends PyObject {
  constructor(readonly s: string) {
    super();
  }
  get typeName() {
    return "Markup";
  }
  get typeModule() {
    return "markupsafe";
  }
  get isStr() {
    return true;
  }
  repr() {
    return `Markup(${reprStr(this.s)})`;
  }
  str() {
    return this.s;
  }
  truthy() {
    return this.s.length > 0;
  }
  len() {
    return cpLen(this.s);
  }
  iter() {
    return cps(this.s)[Symbol.iterator]();
  }
  getAttr(name: string) {
    return strMethod(this, name);
  }
  getItem(key: PyVal) {
    return new Markup(strIndex(this.s, key) as string);
  }
  eq(o: PyVal) {
    return pyEq(this.s, o);
  }
  contains(x: PyVal) {
    return strContains(this.s, x);
  }
}

export const MISSING: unique symbol = Symbol("missing");

/** jinja2.runtime.Undefined。 */
export class Undefined extends PyObject {
  constructor(
    readonly hint: string | null = null,
    readonly obj: PyVal | typeof MISSING = MISSING,
    readonly name: PyVal | null = null,
    readonly exc: string = "UndefinedError",
  ) {
    super();
  }
  get typeName() {
    return "Undefined";
  }
  get typeModule() {
    return "jinja2.runtime";
  }
  get message(): string {
    if (this.hint) return this.hint;
    if (this.obj === MISSING) return `${repr(this.name)} is undefined`;
    if (typeof this.name !== "string") return `${objectTypeRepr(this.obj)} has no element ${repr(this.name)}`;
    return `${reprStr(objectTypeRepr(this.obj))} has no attribute ${repr(this.name)}`;
  }
  fail(): never {
    throw new PyException(this.exc, this.message);
  }
  repr() {
    return "Undefined";
  }
  str() {
    return "";
  }
  truthy() {
    return false;
  }
  len() {
    return 0;
  }
  iter() {
    return [][Symbol.iterator]();
  }
  getAttr(name: string): PyVal | typeof NOATTR {
    if (name.startsWith("__") && name.endsWith("__")) return NOATTR;
    return this.fail();
  }
  getItem(): PyVal {
    return this.fail();
  }
  get callable() {
    return () => this.fail();
  }
  eq(o: PyVal) {
    return o instanceof Undefined;
  }
}

export class PyRange extends PyObject {
  constructor(
    readonly start: bigint,
    readonly stop: bigint,
    readonly step: bigint,
  ) {
    super();
  }
  get typeName() {
    return "range";
  }
  repr() {
    return this.step === 1n ? `range(${this.start}, ${this.stop})` : `range(${this.start}, ${this.stop}, ${this.step})`;
  }
  get length(): bigint {
    const { start, stop, step } = this;
    if (step > 0n) return stop > start ? (stop - start + step - 1n) / step : 0n;
    return start > stop ? (start - stop - step - 1n) / -step : 0n;
  }
  len() {
    return Number(this.length);
  }
  at(i: bigint) {
    return this.start + i * this.step;
  }
  iter() {
    const n = this.length;
    let i = 0n;
    return {
      next: (): IteratorResult<PyVal> => (i < n ? { value: this.at(i++), done: false } : { value: undefined, done: true }),
    };
  }
  getAttr(name: string) {
    if (name === "start") return this.start;
    if (name === "stop") return this.stop;
    if (name === "step") return this.step;
    return seqMethod(this, name);
  }
  getItem(key: PyVal) {
    const n = this.length;
    let i = indexArg(key, "range");
    if (i < 0n) i += n;
    if (i < 0n || i >= n) throw new PyException("IndexError", "range object index out of range");
    return this.at(i);
  }
  eq(o: PyVal) {
    if (!(o instanceof PyRange)) return false;
    const a = this.length;
    if (a !== o.length) return false;
    if (a === 0n) return true;
    if (this.start !== o.start) return false;
    return a === 1n || this.step === o.step;
  }
  contains(x: PyVal) {
    for (const v of iterate(this)) if (pyEq(v, x)) return true;
    return false;
  }
}

/** 生成器・イテレーター(一度しか回せない)。 */
export class PyIter extends PyObject {
  constructor(
    readonly label: string,
    readonly it: Iterator<PyVal>,
    readonly type = "generator",
  ) {
    super();
  }
  get typeName() {
    return this.type;
  }
  repr() {
    return `<${this.label} at 0x0>`;
  }
  truthy() {
    return true;
  }
  iter() {
    return this.it;
  }
}

/** dict.keys()・values()・items() が返すもの。 */
export class DictView extends PyObject {
  constructor(
    readonly kind: "keys" | "values" | "items",
    readonly d: PyDict,
  ) {
    super();
  }
  get typeName() {
    return `dict_${this.kind}`;
  }
  list(): PyVal[] {
    if (this.kind === "keys") return this.d.keys();
    if (this.kind === "values") return this.d.values();
    return this.d.entries().map(([k, v]) => new PyTuple([k, v]));
  }
  repr() {
    return `dict_${this.kind}(${reprList(this.list())})`;
  }
  len() {
    return this.d.size;
  }
  iter() {
    return this.list()[Symbol.iterator]();
  }
  getAttr(name: string): PyVal | typeof NOATTR {
    if (name === "mapping") return this.d;
    return NOATTR;
  }
  eq(o: PyVal): boolean {
    if (this.kind === "values") return this === o;
    return o instanceof DictView && o.kind === this.kind && setEq(this.list(), o.list());
  }
  contains(x: PyVal) {
    if (this.kind === "keys") return this.d.has(x);
    return this.list().some((y) => pyEq(x, y));
  }
}

/** 呼び出せるもの(組み込み関数・メソッド)。 */
export class PyFunc extends PyObject {
  constructor(
    readonly name: string,
    readonly fn: (args: PyVal[], kw: Kw) => PyVal,
    readonly reprText: string,
    readonly type = "builtin_function_or_method",
    /** sandbox が「安全でない」とするもの(list.append など)。 */
    readonly unsafe = false,
  ) {
    super();
  }
  get typeName() {
    return this.type;
  }
  repr() {
    return this.reprText;
  }
  get callable() {
    return this.fn;
  }
  getAttr(name: string): PyVal | typeof NOATTR {
    if (name === "__name__") return this.name;
    return NOATTR;
  }
}

/** complex(負の数の小数乗の結果を出すためだけに使う)。 */
export class PyComplex extends PyObject {
  constructor(
    readonly re: number,
    readonly im: number,
  ) {
    super();
  }
  get typeName() {
    return "complex";
  }
  repr() {
    const r = (x: number) => {
      const s = floatRepr(x);
      return s.endsWith(".0") ? s.slice(0, -2) : s;
    };
    const im = (this.im >= 0 || Number.isNaN(this.im) || Object.is(this.im, 0) ? "+" : "") + r(this.im);
    if (this.re === 0 && !Object.is(this.re, -0)) return `${r(this.im)}j`;
    return `(${r(this.re)}${im}j)`;
  }
  truthy() {
    return this.re !== 0 || this.im !== 0;
  }
  eq(o: PyVal) {
    if (o instanceof PyComplex) return o.re === this.re && o.im === this.im;
    return this.im === 0 && isNumber(o) && pyEq(this.re, o);
  }
}

// ---------------------------------------------------------------- 型の判定

export const isStrLike = (v: PyVal): v is string | Markup => typeof v === "string" || v instanceof Markup;
export const strOf = (v: string | Markup) => (typeof v === "string" ? v : v.s);
export const isInt = (v: PyVal): v is bigint | boolean => typeof v === "bigint" || typeof v === "boolean";
export const isNumber = (v: PyVal): v is bigint | boolean | number => isInt(v) || typeof v === "number";
export const isList = (v: PyVal): v is PyVal[] => Array.isArray(v);
export const toBig = (v: bigint | boolean) => (typeof v === "boolean" ? (v ? 1n : 0n) : v);

export function typeName(v: PyVal): string {
  if (v === null) return "NoneType";
  switch (typeof v) {
    case "boolean":
      return "bool";
    case "bigint":
      return "int";
    case "number":
      return "float";
    case "string":
      return "str";
  }
  if (Array.isArray(v)) return "list";
  return v.typeName;
}

/** jinja2.utils.object_type_repr */
export function objectTypeRepr(v: PyVal | typeof MISSING): string {
  if (v === null) return "None";
  if (v === MISSING) return "missing object";
  if (v instanceof PyObject && v.typeModule !== "builtins") return `${v.typeModule}.${v.typeName} object`;
  return `${typeName(v)} object`;
}

// ---------------------------------------------------------------- 文字列(コードポイント)

export const cps = (s: string): string[] => Array.from(s);
export function cpLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) i++;
    }
    n++;
  }
  return n;
}

/** str.isspace() が真になる文字(re の \s と同じ)。 */
export const PY_WS = "\t\n\x0b\x0c\r\x1c\x1d\x1e\x1f \x85\xa0                　";
export const PY_WS_CLASS = "[\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const isWs = (c: string) => PY_WS.includes(c);
/** str.splitlines() が区切る文字。 */
const LINE_BREAKS = "\n\x0b\x0c\r\x1c\x1d\x1e\x85  ";

function cpCompare(a: string, b: string): number {
  // Python の str の大小はコードポイント順(JS の < は UTF-16 単位なので違うことがある)
  const x = cps(a);
  const y = cps(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i].codePointAt(0)! - y[i].codePointAt(0)!;
  }
  return x.length - y.length;
}

// ---------------------------------------------------------------- 数

const F64 = new DataView(new ArrayBuffer(8));

/** |x| = digits × 10^-scale を正確に出す(double の値そのもの)。 */
function exactDecimal(x: number): { digits: bigint; scale: number } {
  F64.setFloat64(0, Math.abs(x));
  const hi = F64.getUint32(0);
  const lo = F64.getUint32(4);
  const e = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e2: number;
  if (e === 0) e2 = -1074;
  else {
    m |= 1n << 52n;
    e2 = e - 1075;
  }
  if (e2 >= 0) return { digits: m << BigInt(e2), scale: 0 };
  return { digits: m * 5n ** BigInt(-e2), scale: -e2 };
}

/** digits × 10^-scale を小数点以下 n 桁に丸めた整数(× 10^n)。偶数への丸め。 */
function roundScaled(digits: bigint, scale: number, n: number): bigint {
  if (n >= scale) return digits * 10n ** BigInt(n - scale);
  const p = 10n ** BigInt(scale - n);
  let q = digits / p;
  const r2 = (digits % p) * 2n;
  if (r2 > p || (r2 === p && q % 2n === 1n)) q += 1n;
  return q;
}

/** 10 進の指数(x = d.ddd × 10^E の E)。x ≠ 0。 */
function decExp(digits: bigint, scale: number) {
  return digits.toString().length - 1 - scale;
}

/** repr(float) */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const [mant, ex] = Math.abs(x).toExponential().split("e");
  const digits = mant.replace(".", "");
  const e = Number(ex);
  if (e >= -4 && e < 16) {
    let s: string;
    if (e >= digits.length - 1) s = digits + "0".repeat(e - digits.length + 1) + ".0";
    else if (e >= 0) s = digits.slice(0, e + 1) + "." + digits.slice(e + 1);
    else s = "0." + "0".repeat(-e - 1) + digits;
    return sign + s;
  }
  const m = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
  return `${sign}${m}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
}

/** format(x, '.{prec}f') の数字部分(符号なし)。 */
function fixedDigits(x: number, prec: number): string {
  const { digits, scale } = exactDecimal(x);
  const q = roundScaled(digits, scale, prec).toString().padStart(prec + 1, "0");
  return prec ? q.slice(0, q.length - prec) + "." + q.slice(q.length - prec) : q;
}

/** format(x, '.{prec}e') の仮数と指数(符号なし)。 */
function expParts(x: number, prec: number): { mant: string; exp: number } {
  if (x === 0) return { mant: prec ? "0." + "0".repeat(prec) : "0", exp: 0 };
  const { digits, scale } = exactDecimal(x);
  let E = decExp(digits, scale);
  let q = roundScaled(digits, scale, prec - E).toString();
  if (q.length > prec + 1) {
    E += 1;
    q = roundScaled(digits, scale, prec - E).toString();
  }
  return { mant: prec ? q[0] + "." + q.slice(1) : q, exp: E };
}
const expStr = (e: number, upper = false) => `${upper ? "E" : "e"}${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;

/** 'g' 形式(alt は '#'、noType は型を書かないとき)。 */
function gFormat(x: number, prec: number, alt: boolean, upper: boolean, noType: boolean): string {
  if (prec === 0) prec = 1;
  if (x === 0) {
    const z = noType ? "0.0" : alt ? "0." + "0".repeat(prec - 1) : "0";
    return z;
  }
  const { exp } = expParts(x, prec - 1);
  let s: string;
  if (exp >= -4 && exp < prec) {
    s = fixedDigits(x, prec - 1 - exp);
    if (!alt && s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, noType ? ".0" : "");
    else if (noType && !s.includes(".")) s += ".0";
  } else {
    const p = expParts(x, prec - 1);
    let m = p.mant;
    if (!alt && m.includes(".")) m = m.replace(/0+$/, "").replace(/\.$/, "");
    s = m + expStr(p.exp, upper);
  }
  return s;
}

/** round(x, n)(float)。正確な値を偶数への丸めで。 */
export function roundFloat(x: number, n: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  if (n > 330) return x;
  const { digits, scale } = exactDecimal(x);
  const q = roundScaled(digits, scale, n);
  const s = n >= 0 ? `${q}e-${n}` : `${q}e${-n}`;
  const v = Number(s);
  return x < 0 ? -v : v;
}

export function roundInt(x: bigint, n: number): bigint {
  if (n >= 0) return x;
  const p = 10n ** BigInt(-n);
  const neg = x < 0n;
  const a = neg ? -x : x;
  let q = a / p;
  const r2 = (a % p) * 2n;
  if (r2 > p || (r2 === p && q % 2n === 1n)) q += 1n;
  const v = q * p;
  return neg ? -v : v;
}

/** int(str, base) */
export function parsePyInt(s: string, base = 10): bigint | null {
  let t = s.trim().replace(new RegExp(`^${PY_WS_CLASS}+|${PY_WS_CLASS}+$`, "gu"), "");
  let neg = false;
  if (t.startsWith("+") || t.startsWith("-")) {
    neg = t[0] === "-";
    t = t.slice(1);
  }
  const pre = t.slice(0, 2).toLowerCase();
  const prefixes: Record<string, number> = { "0x": 16, "0o": 8, "0b": 2 };
  if (base === 0) {
    if (prefixes[pre]) {
      base = prefixes[pre];
      t = t.slice(2);
      if (t.startsWith("_")) t = t.slice(1);
    } else {
      base = 10;
      if (/^0+[_0]*[1-9]/.test(t)) return null;
    }
  } else if (prefixes[pre] === base) {
    t = t.slice(2);
    if (t.startsWith("_")) t = t.slice(1);
  }
  if (base < 2 || base > 36) throw valueError("int() base must be >= 2 and <= 36, or 0");
  if (!t || t.startsWith("_") || t.endsWith("_") || t.includes("__")) return null;
  t = t.replace(/_/g, "");
  let v = 0n;
  const B = BigInt(base);
  for (const ch of t) {
    const d = parseInt(ch, 36);
    if (Number.isNaN(d) || d >= base) {
      // 全角数字などの Unicode の数字
      const u = /\p{Nd}/u.test(ch) ? unicodeDigit(ch) : -1;
      if (u < 0 || u >= base) return null;
      v = v * B + BigInt(u);
      continue;
    }
    v = v * B + BigInt(d);
  }
  return neg ? -v : v;
}
function unicodeDigit(ch: string): number {
  const c = ch.codePointAt(0)!;
  // Nd の文字は 10 個ずつ並んでいるので、0 を探す
  for (let z = c; z > c - 10; z--) {
    const s = String.fromCodePoint(z);
    if (!/\p{Nd}/u.test(s)) return c - z - 1;
  }
  return (c - 0) % 10;
}

/** float(str) */
export function parsePyFloat(s: string): number | null {
  const t = s.replace(new RegExp(`^${PY_WS_CLASS}+|${PY_WS_CLASS}+$`, "gu"), "");
  const m = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
  if (m) return m[2].toLowerCase() === "nan" ? NaN : m[1] === "-" ? -Infinity : Infinity;
  if (!/^[+-]?(\d(_?\d)*(\.(\d(_?\d)*)?)?|\.\d(_?\d)*)([eE][+-]?\d(_?\d)*)?$/.test(t)) return null;
  return Number(t.replace(/_/g, ""));
}

// ---------------------------------------------------------------- repr と str

export function reprStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else if (c >= 0x7f && !isPrintable(ch)) {
      if (c <= 0xff) out += "\\x" + c.toString(16).padStart(2, "0");
      else if (c <= 0xffff) out += "\\u" + c.toString(16).padStart(4, "0");
      else out += "\\U" + c.toString(16).padStart(8, "0");
    } else out += ch;
  }
  return out + quote;
}

const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
function isPrintable(ch: string) {
  return ch === " " || !NON_PRINTABLE.test(ch);
}

export const reprList = (a: PyVal[]) => `[${a.map(repr).join(", ")}]`;
export const reprTuple = (a: PyVal[]) => (a.length === 1 ? `(${repr(a[0])},)` : `(${a.map(repr).join(", ")})`);
export const reprDict = (d: PyDict) => `{${d.entries().map(([k, v]) => `${repr(k)}: ${repr(v)}`).join(", ")}}`;

export function repr(v: PyVal): string {
  if (v === null) return "None";
  switch (typeof v) {
    case "boolean":
      return v ? "True" : "False";
    case "bigint":
      return v.toString();
    case "number":
      return floatRepr(v);
    case "string":
      return reprStr(v);
  }
  if (Array.isArray(v)) return reprList(v);
  return v.repr();
}

/** str(v) */
export function pyStr(v: PyVal): string {
  if (typeof v === "string") return v;
  if (v instanceof PyObject) return v.str();
  return repr(v);
}

// ---------------------------------------------------------------- 真偽・長さ・反復

export function truthy(v: PyVal): boolean {
  if (v === null) return false;
  switch (typeof v) {
    case "boolean":
      return v;
    case "bigint":
      return v !== 0n;
    case "number":
      return v !== 0 && !Number.isNaN(v) ? true : Number.isNaN(v);
    case "string":
      return v.length > 0;
  }
  if (Array.isArray(v)) return v.length > 0;
  return v.truthy();
}

export function pyLen(v: PyVal): number {
  if (typeof v === "string") return cpLen(v);
  if (Array.isArray(v)) return v.length;
  if (v instanceof PyObject) {
    const n = v.len();
    if (n !== null) return n;
  }
  throw typeError(`object of type '${typeName(v)}' has no len()`);
}

export function tryIter(v: PyVal): Iterator<PyVal> | null {
  if (typeof v === "string") return cps(v)[Symbol.iterator]();
  if (Array.isArray(v)) return v[Symbol.iterator]();
  if (v instanceof PyObject) return v.iter();
  return null;
}

export function iterOf(v: PyVal): Iterator<PyVal> {
  const it = tryIter(v);
  if (!it) throw typeError(`'${typeName(v)}' object is not iterable`);
  return it;
}

export function* iterate(v: PyVal): Generator<PyVal> {
  const it = iterOf(v);
  for (;;) {
    const r = it.next();
    if (r.done) return;
    yield r.value;
  }
}

export const toList = (v: PyVal): PyVal[] => (Array.isArray(v) ? v.slice() : [...iterate(v)]);

// ---------------------------------------------------------------- hash と比較

export function hashKey(k: PyVal, what = "a dict key"): string {
  if (k === null) return "N";
  switch (typeof k) {
    case "boolean":
      return k ? "i1" : "i0";
    case "bigint":
      return "i" + k.toString();
    case "number":
      if (Number.isInteger(k)) return "i" + BigInt(k).toString();
      return "f" + floatRepr(k);
    case "string":
      return "s" + k;
  }
  if (k instanceof Markup) return "s" + k.s;
  if (k instanceof PyTuple) return "t(" + k.items.map((x) => hashKey(x, what)).join(",") + ")";
  if (Array.isArray(k) || k instanceof PyDict || k instanceof Namespaceish || k instanceof DictView) throw typeError(`cannot use '${typeName(k)}' as ${what} (unhashable type: '${typeName(k)}')`);
  if (k instanceof Undefined) return "U";
  return "o" + objectId(k);
}

/** 名前空間(Jinja2 の Namespace)。hash できないことだけここで使う。 */
export abstract class Namespaceish extends PyObject {}

const ids = new WeakMap<object, number>();
let nextId = 1;
export function objectId(o: object): number {
  let i = ids.get(o);
  if (i === undefined) {
    i = nextId++;
    ids.set(o, i);
  }
  return i;
}

function seqEq(a: PyVal[], b: PyVal[]) {
  return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
}
function setEq(a: PyVal[], b: PyVal[]) {
  return a.length === b.length && a.every((x) => b.some((y) => pyEq(x, y)));
}

export function pyEq(a: PyVal, b: PyVal): boolean {
  if (isNumber(a) && isNumber(b)) return numCmp(a, b) === 0;
  if (isStrLike(a) && isStrLike(b)) return strOf(a) === strOf(b);
  if (a === null || b === null) return a === b;
  if (Array.isArray(a)) return Array.isArray(b) && seqEq(a, b);
  if (a instanceof PyObject) return a.eq(b);
  if (b instanceof PyObject) return b.eq(a);
  return false;
}

/** 数の大小(NaN は比べられない → NaN を返す)。 */
function numCmp(a: bigint | boolean | number, b: bigint | boolean | number): number {
  const x = typeof a === "boolean" ? (a ? 1n : 0n) : a;
  const y = typeof b === "boolean" ? (b ? 1n : 0n) : b;
  if (typeof x === "number" && Number.isNaN(x)) return NaN;
  if (typeof y === "number" && Number.isNaN(y)) return NaN;
  if (typeof x === "bigint" && typeof y === "bigint") return x < y ? -1 : x > y ? 1 : 0;
  // bigint と number は JS でも数学的に正しく比べられる
  return x < y ? -1 : x > y ? 1 : 0;
}

const OP_SYMBOL: Record<string, string> = { lt: "<", lteq: "<=", gt: ">", gteq: ">=" };

/** a < b などの順序比較。比べられなければ TypeError。 */
export function pyCompare(op: "lt" | "lteq" | "gt" | "gteq", a: PyVal, b: PyVal): boolean {
  if (a instanceof Undefined) a.fail();
  if (b instanceof Undefined) b.fail();
  const test = (c: number) => (Number.isNaN(c) ? false : op === "lt" ? c < 0 : op === "lteq" ? c <= 0 : op === "gt" ? c > 0 : c >= 0);
  if (isNumber(a) && isNumber(b)) return test(numCmp(a, b));
  if (isStrLike(a) && isStrLike(b)) return test(cpCompare(strOf(a), strOf(b)));
  const p = Array.isArray(a) && Array.isArray(b) ? [a, b] : a instanceof PyTuple && b instanceof PyTuple ? [a.items, b.items] : null;
  if (p) {
    // list・tuple は最初に == でない要素を同じ演算子で比べる
    const [x, y] = p;
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) if (!pyEq(x[i], y[i])) return pyCompare(op, x[i], y[i]);
    return test(x.length - y.length);
  }
  throw typeError(`'${OP_SYMBOL[op]}' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
}

/** 大小の結果。比べられなければ null。 */
export function orderCmp(a: PyVal, b: PyVal): number | null {
  if (isNumber(a) && isNumber(b)) return numCmp(a, b);
  if (isStrLike(a) && isStrLike(b)) return cpCompare(strOf(a), strOf(b));
  const sa = Array.isArray(a) ? a : null;
  const sb = Array.isArray(b) ? b : null;
  const ta = a instanceof PyTuple ? a.items : null;
  const tb = b instanceof PyTuple ? b.items : null;
  const x = sa && sb ? [sa, sb] : ta && tb ? [ta, tb] : null;
  if (x) {
    const [p, q] = x;
    const n = Math.min(p.length, q.length);
    for (let i = 0; i < n; i++) {
      if (!pyEq(p[i], q[i])) {
        const c = orderCmp(p[i], q[i]);
        if (c === null) throw typeError(`'<' not supported between instances of '${typeName(p[i])}' and '${typeName(q[i])}'`);
        return c;
      }
    }
    return p.length - q.length;
  }
  return null;
}

// ---------------------------------------------------------------- 演算

function unsupported(op: string, a: PyVal, b: PyVal): never {
  throw typeError(`unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`);
}

function checkUndef(...vs: PyVal[]) {
  for (const v of vs) if (v instanceof Undefined) v.fail();
}

const toF = (v: bigint | boolean | number) => {
  if (typeof v === "number") return v;
  const f = Number(toBig(v));
  if (!Number.isFinite(f)) throw new PyException("OverflowError", "int too large to convert to float");
  return f;
};

function overflowCheck(x: number) {
  return x;
}

export function pyAdd(a: PyVal, b: PyVal): PyVal {
  checkUndef(a, b);
  if (isInt(a) && isInt(b)) return toBig(a) + toBig(b);
  if (isNumber(a) && isNumber(b)) return toF(a) + toF(b);
  if (a instanceof Markup) {
    if (isStrLike(b)) return new Markup(a.s + (b instanceof Markup ? b.s : escapeHtml(b)));
    return unsupportedConcat(a, b);
  }
  if (typeof a === "string") {
    if (b instanceof Markup) return new Markup(escapeHtml(a) + b.s);
    if (typeof b === "string") return a + b;
    throw typeError(`can only concatenate str (not "${typeName(b)}") to str`);
  }
  if (Array.isArray(a)) {
    if (Array.isArray(b)) return [...a, ...b];
    throw typeError(`can only concatenate list (not "${typeName(b)}") to list`);
  }
  if (a instanceof PyTuple) {
    if (b instanceof PyTuple) return new PyTuple([...a.items, ...b.items]);
    throw typeError(`can only concatenate tuple (not "${typeName(b)}") to tuple`);
  }
  return unsupported("+", a, b);
}
function unsupportedConcat(a: PyVal, b: PyVal): never {
  return unsupported("+", a, b);
}

export function pySub(a: PyVal, b: PyVal): PyVal {
  checkUndef(a, b);
  if (isInt(a) && isInt(b)) return toBig(a) - toBig(b);
  if (isNumber(a) && isNumber(b)) return toF(a) - toF(b);
  return unsupported("-", a, b);
}

function repeatCount(n: bigint | boolean, len: number): number {
  const c = toBig(n);
  if (c > 9223372036854775807n || c < -9223372036854775808n) throw new PyException("OverflowError", "cannot fit 'int' into an index-sized integer");
  if (c > 0n && len > 0 && c * BigInt(len) > 100_000_000n) throw new PyException("MemoryError", "");
  return c < 0n ? 0 : Number(c);
}

export function pyMul(a: PyVal, b: PyVal): PyVal {
  checkUndef(a, b);
  if (isInt(a) && isInt(b)) return toBig(a) * toBig(b);
  if (isNumber(a) && isNumber(b)) return toF(a) * toF(b);
  const seq = (s: PyVal, n: PyVal): PyVal | undefined => {
    if (!isInt(n)) return undefined;
    if (!(isStrLike(s) || Array.isArray(s) || s instanceof PyTuple)) return undefined;
    const c = repeatCount(n, isStrLike(s) ? strOf(s).length : Array.isArray(s) ? s.length : (s as PyTuple).items.length);
    if (typeof s === "string") return s.repeat(c);
    if (s instanceof Markup) return new Markup(s.s.repeat(c));
    if (Array.isArray(s)) return Array.from({ length: c }, () => s).flat(1) as PyVal[];
    if (s instanceof PyTuple) return new PyTuple(Array.from({ length: c }, () => s.items).flat(1) as PyVal[]);
    return undefined;
  };
  const isSeq = (s: PyVal) => isStrLike(s) || Array.isArray(s) || s instanceof PyTuple;
  const r = seq(a, b) ?? seq(b, a);
  if (r !== undefined) return r;
  // sequence_repeat: 左が列なら右の型、右だけが列なら左の型を言う
  if (isSeq(a)) throw typeError(`can't multiply sequence by non-int of type '${typeName(b)}'`);
  if (isSeq(b)) throw typeError(`can't multiply sequence by non-int of type '${typeName(a)}'`);
  return unsupported("*", a, b);
}

export function pyTrueDiv(a: PyVal, b: PyVal): PyVal {
  checkUndef(a, b);
  if (isNumber(a) && isNumber(b)) {
    if (isInt(a) && isInt(b)) {
      const x = toBig(a);
      const y = toBig(b);
      if (y === 0n) throw new PyException("ZeroDivisionError", "division by zero");
      return intTrueDiv(x, y);
    }
    const y = toF(b);
    if (y === 0) throw new PyException("ZeroDivisionError", "division by zero");
    return toF(a) / y;
  }
  return unsupported("/", a, b);
}

/** int / int を正しく丸めた float にする。 */
function intTrueDiv(x: bigint, y: bigint): number {
  const lim = 1n << 53n;
  const ax = x < 0n ? -x : x;
  const ay = y < 0n ? -y : y;
  const neg = x < 0n !== y < 0n;
  if (ax <= lim && ay <= lim) return Number(x) / Number(y);
  if (ax === 0n) return neg ? -0 : 0;
  // 商が 64 ビット以上になるようにずらして割り、余りは最下位ビットに残す(丸めの誤りを防ぐ)
  const bl = (v: bigint) => v.toString(2).length;
  const k = Math.max(0, bl(ay) - bl(ax) + 66);
  const num = ax << BigInt(k);
  let q = num / ay;
  if (num % ay !== 0n) q |= 1n;
  const half = Math.floor(k / 2);
  let v = Number(q) * 2 ** -half * 2 ** -(k - half);
  if (!Number.isFinite(v)) throw new PyException("OverflowError", "integer division result too large for a float");
  if (neg) v = -v;
  return v;
}

function floatDivmod(vx: number, wx: number): [number, number] {
  // CPython の float_divmod
  let mod = vx % wx;
  let div = (vx - mod) / wx;
  if (mod) {
    if (wx < 0 !== mod < 0) {
      mod += wx;
      div -= 1;
    }
  } else mod = wx < 0 || Object.is(wx, -0) ? -0 : 0;
  let floordiv: number;
  if (div) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1;
  } else {
    const q = vx / wx;
    floordiv = q < 0 || Object.is(q, -0) ? -0 : 0;
  }
  return [floordiv, mod];
}

function bigFloorDiv(x: bigint, y: bigint): bigint {
  const q = x / y;
  return (x % y !== 0n && x < 0n !== y < 0n) ? q - 1n : q;
}

export function pyFloorDiv(a: PyVal, b: PyVal): PyVal {
  checkUndef(a, b);
  if (isInt(a) && isInt(b)) {
    const y = toBig(b);
    if (y === 0n) throw new PyException("ZeroDivisionError", "division by zero");
    return bigFloorDiv(toBig(a), y);
  }
  if (isNumber(a) && isNumber(b)) {
    const y = toF(b);
    if (y === 0) throw new PyException("ZeroDivisionError", "division by zero");
    return floatDivmod(toF(a), y)[0];
  }
  return unsupported("//", a, b);
}

export function pyMod(a: PyVal, b: PyVal): PyVal {
  if (isStrLike(a)) return percentFormat(a, b);
  checkUndef(a, b);
  if (isInt(a) && isInt(b)) {
    const y = toBig(b);
    if (y === 0n) throw new PyException("ZeroDivisionError", "division by zero");
    const x = toBig(a);
    const r = x % y;
    return r !== 0n && r < 0n !== y < 0n ? r + y : r;
  }
  if (isNumber(a) && isNumber(b)) {
    const y = toF(b);
    if (y === 0) throw new PyException("ZeroDivisionError", "division by zero");
    return floatDivmod(toF(a), y)[1];
  }
  return unsupported("%", a, b);
}

export function pyPow(a: PyVal, b: PyVal): PyVal {
  checkUndef(a, b);
  if (isInt(a) && isInt(b)) {
    const x = toBig(a);
    const y = toBig(b);
    if (y >= 0n) {
      if (y > 100000n && x !== 0n && x !== 1n && x !== -1n) throw new PyException("MemoryError", "");
      return x ** y;
    }
    if (x === 0n) throw new PyException("ZeroDivisionError", "zero to a negative power");
    return Number(x) ** Number(y);
  }
  if (isNumber(a) && isNumber(b)) {
    const x = toF(a);
    const y = toF(b);
    if (x === 0 && y < 0) throw new PyException("ZeroDivisionError", "zero to a negative power");
    if (x < 0 && !Number.isInteger(y) && Number.isFinite(y)) {
      // CPython の _Py_c_pow(虚部 0 の複素数として計算する)
      const len = Math.abs(x) ** y;
      const phase = Math.atan2(0, x) * y;
      return new PyComplex(len * Math.cos(phase), len * Math.sin(phase));
    }
    const r = x ** y;
    if (!Number.isFinite(r) && Number.isFinite(x) && Number.isFinite(y)) throw new PyException("OverflowError", "(34, 'Result too large')");
    return overflowCheck(r);
  }
  throw typeError(`unsupported operand type(s) for ** or pow(): '${typeName(a)}' and '${typeName(b)}'`);
}

export function pyNeg(a: PyVal): PyVal {
  checkUndef(a);
  if (isInt(a)) return -toBig(a);
  if (typeof a === "number") return -a;
  throw typeError(`bad operand type for unary -: '${typeName(a)}'`);
}

export function pyPos(a: PyVal): PyVal {
  checkUndef(a);
  if (isInt(a)) return toBig(a);
  if (typeof a === "number") return a;
  throw typeError(`bad operand type for unary +: '${typeName(a)}'`);
}

/** x in seq */
export function pyIn(x: PyVal, seq: PyVal): boolean {
  if (isStrLike(seq)) return strContains(strOf(seq), x);
  if (Array.isArray(seq)) return seq.some((y) => pyEq(x, y));
  if (seq instanceof PyObject) {
    const c = seq.contains(x);
    if (c !== null) return c;
    const it = seq.iter();
    if (it) {
      for (;;) {
        const r = it.next();
        if (r.done) return false;
        if (pyEq(x, r.value)) return true;
      }
    }
  }
  throw typeError(`argument of type '${typeName(seq)}' is not a container or iterable`);
}

function strContains(s: string, x: PyVal): boolean {
  if (!isStrLike(x)) throw typeError(`'in <string>' requires string as left operand, not ${typeName(x)}`);
  return s.includes(strOf(x));
}

// ---------------------------------------------------------------- 添え字と切り出し

function indexArg(key: PyVal, what: string): bigint {
  if (isInt(key)) return toBig(key);
  throw typeError(`${what} indices must be integers or slices, not ${typeName(key)}`);
}

function seqIndex(a: PyVal[], key: PyVal, what: string): PyVal {
  let i = indexArg(key, what);
  if (i < 0n) i += BigInt(a.length);
  if (i < 0n || i >= BigInt(a.length)) throw new PyException("IndexError", `${what} index out of range`);
  return a[Number(i)];
}

function strIndex(s: string, key: PyVal): string {
  const a = cps(s);
  let i = indexArg(key, "string");
  if (i < 0n) i += BigInt(a.length);
  if (i < 0n || i >= BigInt(a.length)) throw new PyException("IndexError", "string index out of range");
  return a[Number(i)];
}

/** obj[key](Python そのもの。sandbox の getitem はこれを呼ぶ)。 */
export function getItemRaw(obj: PyVal, key: PyVal): PyVal {
  if (typeof obj === "string") return strIndex(obj, key);
  if (Array.isArray(obj)) return seqIndex(obj, key, "list");
  if (obj instanceof PyObject) return obj.getItem(key);
  throw typeError(`'${typeName(obj)}' object is not subscriptable`);
}

/** slice の位置を Python の決まりで出す。 */
function sliceIndices(len: number, start: PyVal, stop: PyVal, step: PyVal): [number, number, number] {
  const arg = (v: PyVal): bigint | null => {
    if (v === null) return null;
    if (isInt(v)) return toBig(v);
    throw typeError("slice indices must be integers or None or have an __index__ method");
  };
  const st = arg(step) ?? 1n;
  if (st === 0n) throw valueError("slice step cannot be zero");
  const n = BigInt(len);
  const clamp = (v: bigint | null, def: bigint, lo: bigint, hi: bigint) => {
    if (v === null) return def;
    let x = v < 0n ? v + n : v;
    if (x < lo) x = lo;
    if (x > hi) x = hi;
    return x;
  };
  if (st > 0n) return [Number(clamp(arg(start), 0n, 0n, n)), Number(clamp(arg(stop), n, 0n, n)), Number(st)];
  return [Number(clamp(arg(start), n - 1n, -1n, n - 1n)), Number(clamp(arg(stop), -1n, -1n, n - 1n)), Number(st)];
}

function sliceArray<T>(a: T[], start: PyVal, stop: PyVal, step: PyVal): T[] {
  const [b, e, s] = sliceIndices(a.length, start, stop, step);
  const out: T[] = [];
  if (s > 0) for (let i = b; i < e; i += s) out.push(a[i]);
  else for (let i = b; i > e; i += s) out.push(a[i]);
  return out;
}

/** obj[start:stop:step] */
export function pySlice(obj: PyVal, start: PyVal, stop: PyVal, step: PyVal): PyVal {
  if (obj instanceof Undefined) obj.fail();
  if (typeof obj === "string") return sliceArray(cps(obj), start, stop, step).join("");
  if (obj instanceof Markup) return new Markup(sliceArray(cps(obj.s), start, stop, step).join(""));
  if (Array.isArray(obj)) return sliceArray(obj, start, stop, step);
  if (obj instanceof PyTuple) return new PyTuple(sliceArray(obj.items, start, stop, step));
  if (obj instanceof PyRange) {
    const [b, e, s] = sliceIndices(obj.len(), start, stop, step);
    const st = obj.step * BigInt(s);
    return new PyRange(obj.at(BigInt(b)), obj.at(BigInt(e)), st);
  }
  if (obj instanceof PyDict) throw new PyException("KeyError", `slice(${repr(start)}, ${repr(stop)}, ${repr(step)})`);
  throw typeError(`'${typeName(obj)}' object is not subscriptable`);
}

// ---------------------------------------------------------------- 関数呼び出しの引数

export type ParamSpec = {
  /** 位置引数とキーワード引数の名前(順番どおり)。 */
  params: string[];
  /** 後ろからの既定値。 */
  defaults?: PyVal[];
  varargs?: boolean;
  varkw?: boolean;
  /** キーワード専用引数と既定値。 */
  kwonly?: [string, PyVal | typeof MISSING][];
};

/** Python の def の引数の割り当て。エラーの文言も CPython に合わせた。 */
export function bindArgs(fname: string, spec: ParamSpec, args: PyVal[], kw: Kw): { v: Map<string, PyVal>; rest: PyVal[]; restKw: Kw } {
  const { params, defaults = [], varargs, varkw, kwonly = [] } = spec;
  const v = new Map<string, PyVal>();
  const nPos = params.length;
  if (args.length > nPos && !varargs) {
    const nReq = nPos - defaults.length;
    const takes = nReq === nPos ? `${nPos} positional argument${nPos === 1 ? "" : "s"}` : `from ${nReq} to ${nPos} positional arguments`;
    const kwGiven = [...kw.keys()].filter((k) => params.includes(k)).length;
    const was = args.length === 1 && !kwGiven ? "was" : "were";
    const given = kwGiven ? `${args.length} positional arguments (and ${kwGiven} keyword-only argument${kwGiven === 1 ? "" : "s"})` : `${args.length}`;
    throw typeError(`${fname}() takes ${takes} but ${given} ${was} given`);
  }
  for (let i = 0; i < Math.min(args.length, nPos); i++) v.set(params[i], args[i]);
  const rest = varargs ? args.slice(nPos) : [];
  const restKw: Kw = new Map();
  for (const [k, val] of kw) {
    if (params.includes(k)) {
      if (v.has(k)) throw typeError(`${fname}() got multiple values for argument '${k}'`);
      v.set(k, val);
    } else if (kwonly.some(([n]) => n === k)) v.set(k, val);
    else if (varkw) restKw.set(k, val);
    else throw typeError(`${fname}() got an unexpected keyword argument '${k}'`);
  }
  const missing: string[] = [];
  params.forEach((p, i) => {
    if (v.has(p)) return;
    const di = i - (nPos - defaults.length);
    if (di >= 0) v.set(p, defaults[di]);
    else missing.push(p);
  });
  if (missing.length) {
    const names = missing.map((m) => `'${m}'`);
    const list = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
    throw typeError(`${fname}() missing ${missing.length} required positional argument${missing.length === 1 ? "" : "s"}: ${list}`);
  }
  const kwMissing: string[] = [];
  for (const [n, d] of kwonly) {
    if (v.has(n)) continue;
    if (d === MISSING) kwMissing.push(n);
    else v.set(n, d);
  }
  if (kwMissing.length) throw typeError(`${fname}() missing ${kwMissing.length} required keyword-only argument${kwMissing.length === 1 ? "" : "s"}: ${kwMissing.map((m) => `'${m}'`).join(" and ")}`);
  return { v, rest, restKw };
}

/** C で書かれた組み込みのメソッド向けの簡単な割り当て(位置引数だけ)。 */
function cArgs(name: string, args: PyVal[], kw: Kw, min: number, max: number): PyVal[] {
  if (kw.size) throw typeError(`${name}() takes no keyword arguments`);
  if (args.length < min || args.length > max) {
    if (min === max) throw typeError(`${name}() takes exactly ${min === 1 ? "one argument" : `${min} arguments`} (${args.length} given)`);
    if (args.length < min) throw typeError(`${name} expected at least ${min} argument${min === 1 ? "" : "s"}, got ${args.length}`);
    throw typeError(`${name} expected at most ${max} argument${max === 1 ? "" : "s"}, got ${args.length}`);
  }
  return args;
}

const method = (self: PyVal, owner: string, name: string, fn: (args: PyVal[], kw: Kw) => PyVal, unsafe = false) =>
  new PyFunc(name, fn, `<built-in method ${name} of ${owner} object at 0x0>`, "builtin_function_or_method", unsafe);

// ---------------------------------------------------------------- list・tuple・dict のメソッド

const LIST_MUTATING = new Set(["append", "clear", "pop", "reverse", "insert", "sort", "extend", "remove"]);
const LIST_METHODS = new Set(["append", "clear", "copy", "count", "extend", "index", "insert", "pop", "remove", "reverse", "sort"]);
const DICT_MUTATING = new Set(["clear", "pop", "popitem", "setdefault", "update"]);
const DICT_METHODS = new Set(["clear", "copy", "fromkeys", "get", "items", "keys", "pop", "popitem", "setdefault", "update", "values"]);

function seqMethodImpl(items: PyVal[], name: string, owner: string): PyVal | typeof NOATTR {
  if (name === "count") return method(items, owner, name, (a, k) => BigInt(items.filter((x) => pyEq(x, cArgs("count", a, k, 1, 1)[0])).length));
  if (name === "index")
    return method(items, owner, name, (a, k) => {
      const [x, start = null, stop = null] = cArgs("index", a, k, 1, 3);
      const [b, e] = sliceIndices(items.length, start, stop, null);
      for (let i = b; i < e; i++) if (pyEq(items[i], x)) return BigInt(i);
      throw valueError(`${owner}.index(x): x not in ${owner}`);
    });
  return NOATTR;
}

function seqMethod(self: PyTuple | PyRange, name: string): PyVal | typeof NOATTR {
  if (self instanceof PyTuple) return seqMethodImpl(self.items, name, "tuple");
  if (name === "count") return seqMethodImpl(toList(self), name, "range");
  if (name === "index")
    return method(self, "range", name, (a, k) => {
      const [x] = cArgs("index", a, k, 1, 1);
      const items = toList(self);
      const i = items.findIndex((y) => pyEq(y, x));
      if (i >= 0) return BigInt(i);
      if (typeof x === "bigint") throw valueError(`${repr(x)} is not in range`);
      throw valueError("sequence.index(x): x not in sequence");
    });
  return NOATTR;
}

export function listMethod(l: PyVal[], name: string): PyVal | typeof NOATTR {
  if (!LIST_METHODS.has(name)) return NOATTR;
  if (name === "copy") return method(l, "list", name, (a, k) => (cArgs("copy", a, k, 0, 0), l.slice()));
  const r = seqMethodImpl(l, name, "list");
  if (r !== NOATTR) return r;
  // 変更するメソッドは sandbox が止める(呼ばれる前に)
  return method(l, "list", name, () => {
    throw typeError("unreachable");
  }, LIST_MUTATING.has(name));
}

function dictMethod(d: PyDict, name: string): PyVal | typeof NOATTR {
  if (!DICT_METHODS.has(name)) return NOATTR;
  const m = (fn: (args: PyVal[], kw: Kw) => PyVal) => method(d, "dict", name, fn, DICT_MUTATING.has(name));
  switch (name) {
    case "get":
      return m((a, k) => {
        const [key, def = null] = cArgs("get", a, k, 1, 2);
        const v = d.get(key);
        return v === undefined ? def : v;
      });
    case "keys":
    case "values":
    case "items":
      return m((a, k) => (cArgs(name, a, k, 0, 0), new DictView(name, d)));
    case "copy":
      return m((a, k) => (cArgs("copy", a, k, 0, 0), d.copy()));
    case "fromkeys":
      return m((a, k) => {
        const [it, val = null] = cArgs("fromkeys", a, k, 1, 2);
        return new PyDict([...iterate(it)].map((x) => [x, val]));
      });
  }
  return m(() => {
    throw typeError("unreachable");
  });
}

// ---------------------------------------------------------------- str のメソッド

function strArg(v: PyVal, what = "must be str or None"): string | null {
  if (v === null) return null;
  if (isStrLike(v)) return strOf(v);
  throw typeError(`${what}, not ${typeName(v)}`);
}

function stripChars(s: string, chars: string | null, left: boolean, right: boolean): string {
  const a = cps(s);
  const set = chars === null ? null : new Set(cps(chars));
  const strip = (c: string) => (set ? set.has(c) : isWs(c));
  let b = 0;
  let e = a.length;
  if (left) while (b < e && strip(a[b])) b++;
  if (right) while (e > b && strip(a[e - 1])) e--;
  return a.slice(b, e).join("");
}

function splitWs(s: string, maxsplit: number, fromRight: boolean): string[] {
  const a = cps(s);
  const out: string[] = [];
  if (!fromRight) {
    let i = 0;
    while (i < a.length) {
      while (i < a.length && isWs(a[i])) i++;
      if (i >= a.length) break;
      if (maxsplit >= 0 && out.length === maxsplit) {
        let rest = a.slice(i).join("");
        rest = stripChars(rest, null, false, true);
        out.push(rest);
        return out;
      }
      let j = i;
      while (j < a.length && !isWs(a[j])) j++;
      out.push(a.slice(i, j).join(""));
      i = j;
    }
    return out;
  }
  let i = a.length;
  while (i > 0) {
    while (i > 0 && isWs(a[i - 1])) i--;
    if (i <= 0) break;
    if (maxsplit >= 0 && out.length === maxsplit) {
      out.unshift(stripChars(a.slice(0, i).join(""), null, true, false));
      return out;
    }
    let j = i;
    while (j > 0 && !isWs(a[j - 1])) j--;
    out.unshift(a.slice(j, i).join(""));
    i = j;
  }
  return out;
}

function splitSep(s: string, sep: string, maxsplit: number, fromRight: boolean): string[] {
  if (!sep) throw valueError("empty separator");
  const parts = s.split(sep);
  if (maxsplit < 0 || parts.length - 1 <= maxsplit) return parts;
  if (!fromRight) return [...parts.slice(0, maxsplit), parts.slice(maxsplit).join(sep)];
  return [parts.slice(0, parts.length - maxsplit).join(sep), ...parts.slice(parts.length - maxsplit)];
}

export function splitlines(s: string, keepends: boolean): string[] {
  const out: string[] = [];
  const a = cps(s);
  let start = 0;
  let i = 0;
  while (i < a.length) {
    const c = a[i];
    if (LINE_BREAKS.includes(c)) {
      let end = i + 1;
      if (c === "\r" && a[i + 1] === "\n") end = i + 2;
      out.push(a.slice(start, keepends ? end : i).join(""));
      start = i = end;
    } else i++;
  }
  if (start < a.length) out.push(a.slice(start).join(""));
  return out;
}

/** str.find の位置(コードポイント)。 */
function findCp(s: string, sub: string, start: PyVal, end: PyVal, fromRight: boolean): number {
  const a = cps(s);
  const [b, e] = sliceIndices(a.length, start, end, null);
  if (e - b < cpLen(sub) && !(sub === "" && b <= a.length)) return -1;
  const seg = a.slice(b, Math.max(b, e)).join("");
  const r = fromRight ? seg.lastIndexOf(sub) : seg.indexOf(sub);
  if (r < 0) return -1;
  return b + cpLen(seg.slice(0, r));
}

const CASED = /[\p{Lu}\p{Ll}\p{Lt}]/u;
const UPPERISH = /[\p{Uppercase}\p{Lt}]/u;
const LOWER = /\p{Lowercase}/u;

export function pyTitle(s: string): string {
  let out = "";
  let prevCased = false;
  for (const ch of s) {
    if (CASED.test(ch) || LOWER.test(ch) || UPPERISH.test(ch)) {
      out += prevCased ? ch.toLowerCase() : titleChar(ch);
      prevCased = true;
    } else {
      out += ch;
      prevCased = false;
    }
  }
  return out;
}
function titleChar(ch: string): string {
  const special: Record<string, string> = { ǆ: "ǅ", Ǆ: "ǅ", ǅ: "ǅ", ǉ: "ǈ", Ǉ: "ǈ", ǈ: "ǈ", ǌ: "ǋ", Ǌ: "ǋ", ǋ: "ǋ", ǳ: "ǲ", Ǳ: "ǲ", ǲ: "ǲ", ß: "Ss" };
  return special[ch] ?? ch.toUpperCase();
}
export function pyCapitalize(s: string): string {
  const a = cps(s);
  if (!a.length) return "";
  return titleChar(a[0]) + a.slice(1).join("").toLowerCase();
}
function pySwapcase(s: string): string {
  let out = "";
  for (const ch of s) out += UPPERISH.test(ch) ? ch.toLowerCase() : LOWER.test(ch) ? ch.toUpperCase() : ch;
  return out;
}
export function pyIsLower(s: string) {
  let cased = false;
  for (const ch of s) {
    if (UPPERISH.test(ch)) return false;
    if (LOWER.test(ch)) cased = true;
  }
  return cased;
}
export function pyIsUpper(s: string) {
  let cased = false;
  for (const ch of s) {
    if (LOWER.test(ch) || /\p{Lt}/u.test(ch)) return false;
    if (UPPERISH.test(ch)) cased = true;
  }
  return cased;
}
function pyIsTitle(s: string) {
  let cased = false;
  let prevCased = false;
  for (const ch of s) {
    if (UPPERISH.test(ch)) {
      if (prevCased) return false;
      prevCased = cased = true;
    } else if (LOWER.test(ch)) {
      if (!prevCased) return false;
      prevCased = cased = true;
    } else prevCased = false;
  }
  return cased;
}

const allCp = (s: string, re: RegExp) => s.length > 0 && cps(s).every((c) => re.test(c));
const IS_ALPHA = /\p{L}/u;
const IS_DECIMAL = /\p{Nd}/u;
const IS_DIGIT = /[\p{Nd}²³¹⁰⁴-⁹₀-₉①-⑨⑴-⑼⒈-⒐⓪⓵-⓽⓿❶-❾➀-➈➊-➒፩-፱᧚\u{10a40}-\u{10a43}\u{1f100}-\u{1f10a}]/u;
const IS_NUMERIC = /[\p{N}〇㐅㒃㠪㭍一七万三九二五亖亿什仟仨伍佰億兆兩八六十千-卅卌叁-叄四壱壹幺廾-廿弌-弎弐拾捌柒漆玖百肆萬貮貳贰阡陆陌陸零參拾兩零六陸什\u{20001}\u{20064}\u{200e2}\u{20121}\u{2092a}\u{20983}\u{2098c}\u{2099c}\u{20aea}\u{20afd}\u{20b19}\u{22390}\u{22998}\u{23b1b}\u{2626d}\u{2f890}]/u;

function pyJust(s: string, width: PyVal, fill: PyVal, how: "l" | "r" | "c", name: string): string {
  if (!isInt(width)) throw typeError(`'${typeName(width)}' object cannot be interpreted as an integer`);
  let f = " ";
  if (fill !== undefined && fill !== null) {
    if (!isStrLike(fill) || cpLen(strOf(fill)) !== 1) throw typeError(`${name}() argument 2 must be a unicode character, not ${typeName(fill)}`);
    f = strOf(fill);
  }
  const w = Number(toBig(width));
  const n = cpLen(s);
  if (w <= n) return s;
  const pad = w - n;
  if (how === "l") return s + f.repeat(pad);
  if (how === "r") return f.repeat(pad) + s;
  // CPython の center: 左 = pad/2 + (pad & width & 1)
  const left = Math.floor(pad / 2) + (pad & w & 1);
  return f.repeat(left) + s + f.repeat(pad - left);
}

const STR_METHODS = new Set(
  "capitalize casefold center count encode endswith expandtabs find format format_map index isalnum isalpha isascii isdecimal isdigit isidentifier islower isnumeric isprintable isspace istitle isupper join ljust lower lstrip maketrans partition removeprefix removesuffix replace rfind rindex rjust rpartition rsplit rstrip split splitlines startswith strip swapcase title translate upper zfill".split(" "),
);
const MARKUP_EXTRA = new Set(["escape", "unescape", "striptags"]);

/** str(と Markup)のメソッド。Markup のときは結果も Markup にして引数をエスケープする。 */
export function strMethod(self: string | Markup, name: string): PyVal | typeof NOATTR {
  const isM = self instanceof Markup;
  if (!STR_METHODS.has(name) && !(isM && MARKUP_EXTRA.has(name))) return NOATTR;
  const s = strOf(self);
  const owner = isM ? "Markup" : "str";
  const wrap = (v: PyVal): PyVal => (isM && typeof v === "string" ? new Markup(v) : isM && Array.isArray(v) ? v.map(wrap) : isM && v instanceof PyTuple ? new PyTuple(v.items.map(wrap)) : v);
  const esc = (v: PyVal): PyVal => (isM && typeof v === "string" ? escapeHtml(v) : v);
  const m = (fn: (a: PyVal[], k: Kw) => PyVal, wrapResult = true) => method(self, owner, name, (a, k) => (wrapResult ? wrap(fn(a, k)) : fn(a, k)));
  const intArg = (v: PyVal, what: string) => {
    if (!isInt(v)) throw typeError(`'${typeName(v)}' object cannot be interpreted as an integer`);
    void what;
    return Number(toBig(v));
  };
  switch (name) {
    case "upper":
      return m((a, k) => (cArgs(name, a, k, 0, 0), s.toUpperCase()));
    case "lower":
      return m((a, k) => (cArgs(name, a, k, 0, 0), s.toLowerCase()));
    case "casefold":
      return m((a, k) => (cArgs(name, a, k, 0, 0), s.toLowerCase().replace(/ß/g, "ss")));
    case "title":
      return m((a, k) => (cArgs(name, a, k, 0, 0), pyTitle(s)));
    case "capitalize":
      return m((a, k) => (cArgs(name, a, k, 0, 0), pyCapitalize(s)));
    case "swapcase":
      return m((a, k) => (cArgs(name, a, k, 0, 0), pySwapcase(s)));
    case "strip":
    case "lstrip":
    case "rstrip":
      return m((a, k) => {
        const [c = null] = cArgs(name, a, k, 0, 1);
        const cv = esc(c);
        if (cv !== null && !isStrLike(cv)) throw typeError(`${name} arg must be None or str`);
        return stripChars(s, cv === null ? null : strOf(cv), name !== "rstrip", name !== "lstrip");
      });
    case "split":
    case "rsplit":
      return m((a, k) => {
        const { v } = bindArgs(name, { params: ["sep", "maxsplit"], defaults: [null, -1n] }, a, k);
        const sep = strArg(esc(v.get("sep")!));
        const ms = intArg(v.get("maxsplit")!, "maxsplit");
        return sep === null ? splitWs(s, ms, name === "rsplit") : splitSep(s, sep, ms, name === "rsplit");
      });
    case "splitlines":
      return m((a, k) => {
        const { v } = bindArgs(name, { params: ["keepends"], defaults: [false] }, a, k);
        return splitlines(s, truthy(v.get("keepends")!));
      });
    case "startswith":
    case "endswith":
      return m((a, k) => {
        const [pre, start = null, end = null] = cArgs(name, a, k, 1, 3);
        const a2 = cps(s);
        const [b, e] = sliceIndices(a2.length, start, end, null);
        const seg = a2.slice(b, Math.max(b, e)).join("");
        const test = (p: PyVal) => {
          if (!isStrLike(p)) throw typeError(`${name} first arg must be str or a tuple of str, not ${typeName(p)}`);
          if (b > a2.length) return false;
          return name === "startswith" ? seg.startsWith(strOf(p)) : seg.endsWith(strOf(p));
        };
        if (pre instanceof PyTuple) return pre.items.some(test);
        return test(pre);
      }, false);
    case "replace":
      return m((a, k) => {
        const { v } = bindArgs(name, { params: ["old", "new", "count"], defaults: [-1n] }, a, k);
        const old = strArg(esc(v.get("old")!), "replace() argument 1 must be str")!;
        const nw = strArg(esc(v.get("new")!), "replace() argument 2 must be str")!;
        return pyReplace(s, old, nw, intArg(v.get("count")!, "count"));
      });
    case "find":
    case "rfind":
    case "index":
    case "rindex":
      return m((a, k) => {
        const [sub, start = null, end = null] = cArgs(name, a, k, 1, 3);
        const r = findCp(s, strArg(sub, `${name}() argument 1 must be str`)!, start, end, name.startsWith("r"));
        if (r < 0 && name.endsWith("index")) throw valueError("substring not found");
        return BigInt(r);
      }, false);
    case "count":
      return m((a, k) => {
        const [sub, start = null, end = null] = cArgs(name, a, k, 1, 3);
        const t = strArg(sub, "count() argument 1 must be str")!;
        const a2 = cps(s);
        const [b, e] = sliceIndices(a2.length, start, end, null);
        const seg = a2.slice(b, Math.max(b, e)).join("");
        if (t === "") return BigInt(b > a2.length ? 0 : cpLen(seg) + 1);
        return BigInt(seg.split(t).length - 1);
      }, false);
    case "join":
      return m((a, k) => {
        const [it] = cArgs(name, a, k, 1, 1);
        const parts = [...iterate(it)].map((x, i) => {
          if (!isStrLike(x)) throw typeError(`sequence item ${i}: expected str instance, ${typeName(x)} found`);
          return isM && typeof x === "string" ? escapeHtml(x) : strOf(x);
        });
        return parts.join(s);
      });
    case "center":
    case "ljust":
    case "rjust":
      return m((a, k) => {
        const [w, f] = cArgs(name, a, k, 1, 2);
        return pyJust(s, w, f, name === "ljust" ? "l" : name === "rjust" ? "r" : "c", name);
      });
    case "zfill":
      return m((a, k) => {
        const [w] = cArgs(name, a, k, 1, 1);
        const n = intArg(w, "width");
        const a2 = cps(s);
        if (n <= a2.length) return s;
        const pad = "0".repeat(n - a2.length);
        if (a2[0] === "+" || a2[0] === "-") return a2[0] + pad + a2.slice(1).join("");
        return pad + s;
      });
    case "partition":
    case "rpartition":
      return m((a, k) => {
        const [sep] = cArgs(name, a, k, 1, 1);
        const t = strArg(esc(sep), "must be str")!;
        if (!t) throw valueError("empty separator");
        const i = name === "partition" ? s.indexOf(t) : s.lastIndexOf(t);
        if (i < 0) return new PyTuple(name === "partition" ? [s, "", ""] : ["", "", s]);
        return new PyTuple([s.slice(0, i), t, s.slice(i + t.length)]);
      });
    case "removeprefix":
    case "removesuffix":
      return m((a, k) => {
        const [p] = cArgs(name, a, k, 1, 1);
        const t = strArg(p, `${name}() argument must be str`)!;
        if (name === "removeprefix") return t && s.startsWith(t) ? s.slice(t.length) : s;
        return t && s.endsWith(t) ? s.slice(0, s.length - t.length) : s;
      });
    case "expandtabs":
      return m((a, k) => {
        const { v } = bindArgs(name, { params: ["tabsize"], defaults: [8n] }, a, k);
        const ts = intArg(v.get("tabsize")!, "tabsize");
        let out = "";
        let col = 0;
        for (const ch of s) {
          if (ch === "\t") {
            if (ts > 0) {
              const n = ts - (col % ts);
              out += " ".repeat(n);
              col += n;
            }
          } else {
            out += ch;
            col = ch === "\n" || ch === "\r" ? 0 : col + 1;
          }
        }
        return out;
      });
    case "isalpha":
      return m((a, k) => (cArgs(name, a, k, 0, 0), allCp(s, IS_ALPHA)), false);
    case "isdecimal":
      return m((a, k) => (cArgs(name, a, k, 0, 0), allCp(s, IS_DECIMAL)), false);
    case "isdigit":
      return m((a, k) => (cArgs(name, a, k, 0, 0), allCp(s, IS_DIGIT)), false);
    case "isnumeric":
      return m((a, k) => (cArgs(name, a, k, 0, 0), allCp(s, IS_NUMERIC)), false);
    case "isalnum":
      return m((a, k) => (cArgs(name, a, k, 0, 0), s.length > 0 && cps(s).every((c) => IS_ALPHA.test(c) || IS_NUMERIC.test(c))), false);
    case "isspace":
      return m((a, k) => (cArgs(name, a, k, 0, 0), s.length > 0 && cps(s).every(isWs)), false);
    case "isascii":
      return m((a, k) => (cArgs(name, a, k, 0, 0), /^[\x00-\x7f]*$/.test(s)), false);
    case "islower":
      return m((a, k) => (cArgs(name, a, k, 0, 0), pyIsLower(s)), false);
    case "isupper":
      return m((a, k) => (cArgs(name, a, k, 0, 0), pyIsUpper(s)), false);
    case "istitle":
      return m((a, k) => (cArgs(name, a, k, 0, 0), pyIsTitle(s)), false);
    case "isidentifier":
      return m((a, k) => (cArgs(name, a, k, 0, 0), isIdentifier(s)), false);
    case "isprintable":
      return m((a, k) => (cArgs(name, a, k, 0, 0), cps(s).every(isPrintable)), false);
    case "format":
      return new PyFunc(
        "format",
        (a, k) => wrap(strFormat(s, a, k, isM)),
        `<function ${isM ? "Markup" : "str"}.format at 0x0>`,
        "function",
      );
    case "format_map":
      return new PyFunc(
        "format_map",
        (a, k) => {
          if (k.size) throw typeError("format_map() takes no keyword arguments");
          if (a.length !== 1) throw typeError(`format_map() takes exactly one argument (${a.length} given)`);
          const d = a[0];
          return wrap(strFormat(s, [], d instanceof PyDict ? new Map(d.entries().map(([x, y]) => [pyStr(x), y])) : new Map(), isM));
        },
        `<function ${isM ? "Markup" : "str"}.format_map at 0x0>`,
        "function",
      );
    case "escape":
      return m((a, k) => {
        const [x] = cArgs(name, a, k, 1, 1);
        return escape(x);
      }, false);
    case "unescape":
      return m((a, k) => (cArgs(name, a, k, 0, 0), unescapeHtml(s)), false);
    case "striptags":
      return m((a, k) => (cArgs(name, a, k, 0, 0), striptags(s)), false);
  }
  return method(self, owner, name, () => {
    throw new PyException("NotImplementedError", `str.${name}() is not supported in this tool`);
  });
}

export function isIdentifier(s: string) {
  return /^[\p{XID_Start}_][\p{XID_Continue}]*$/u.test(s.normalize("NFKC"));
}

export function pyReplace(s: string, old: string, nw: string, count: number): string {
  if (count === 0) return s;
  if (old === "") {
    const a = cps(s);
    const out: string[] = [];
    let n = 0;
    for (let i = 0; i <= a.length; i++) {
      if (count < 0 || n < count) {
        out.push(nw);
        n++;
      }
      if (i < a.length) out.push(a[i]);
    }
    return out.join("");
  }
  const parts = s.split(old);
  if (count < 0 || count >= parts.length - 1) return parts.join(nw);
  return parts.slice(0, count + 1).join(nw) + old + parts.slice(count + 1).join(old);
}

// ---------------------------------------------------------------- 数のメソッド

export function numberAttr(v: bigint | boolean | number, name: string): PyVal | typeof NOATTR {
  const owner = typeName(v);
  if (typeof v === "number") {
    if (name === "real") return v;
    if (name === "imag") return 0;
    if (name === "is_integer") return method(v, owner, name, (a, k) => (cArgs(name, a, k, 0, 0), Number.isInteger(v)));
    if (name === "conjugate") return method(v, owner, name, (a, k) => (cArgs(name, a, k, 0, 0), v));
    return NOATTR;
  }
  const b = toBig(v);
  if (name === "real" || name === "numerator") return b;
  if (name === "imag") return 0n;
  if (name === "denominator") return 1n;
  if (name === "bit_length") return method(v, owner, name, (a, k) => (cArgs(name, a, k, 0, 0), BigInt(b === 0n ? 0 : (b < 0n ? -b : b).toString(2).length)));
  if (name === "conjugate") return method(v, owner, name, (a, k) => (cArgs(name, a, k, 0, 0), b));
  if (name === "is_integer") return method(v, owner, name, (a, k) => (cArgs(name, a, k, 0, 0), true));
  return NOATTR;
}

/** Python の getattr(obj, name)(sandbox の確認の前)。 */
export function getAttrRaw(obj: PyVal, name: string): PyVal | typeof NOATTR {
  if (typeof obj === "string") return strMethod(obj, name);
  if (Array.isArray(obj)) return listMethod(obj, name);
  if (isNumber(obj)) return numberAttr(obj, name);
  if (obj instanceof PyObject) return obj.getAttr(name);
  return NOATTR;
}

// ---------------------------------------------------------------- HTML

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/>/g, "&gt;").replace(/</g, "&lt;").replace(/'/g, "&#39;").replace(/"/g, "&#34;");
}

/** markupsafe.escape */
export function escape(v: PyVal): Markup {
  if (v instanceof Markup) return v;
  return new Markup(escapeHtml(pyStr(v)));
}

export function unescapeHtml(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, g: string) => {
    if (g[0] === "#") {
      const n = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return n > 0x10ffff ? m : String.fromCodePoint(n);
    }
    return named[g] ?? m;
  });
}

/** Markup.striptags */
export function striptags(s: string): string {
  // markupsafe 3: コメントを消し、タグを消し、空白を詰めてから unescape する
  let v = s.replace(/<!--.*?-->/gs, "");
  v = v.replace(/<.*?>/gs, "");
  v = v.split(new RegExp(`${PY_WS_CLASS}+`, "u")).filter(Boolean).join(" ");
  return unescapeHtml(v);
}

// ---------------------------------------------------------------- str.format

type FormatSpec = { fill: string; align: string; sign: string; z: boolean; alt: boolean; zero: boolean; width: number; grouping: string; precision: number | null; type: string };

/** 書式指定を読む(CPython の parse_internal_render_format_spec)。defType は型を書かないときの既定。 */
function parseSpec(spec: string, defType: string, objType: string): FormatSpec {
  const m = /^(?:(.)?([<>=^]))?([+\- ])?(z)?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?(.)?$/su.exec(spec);
  if (!m || (m[10] !== undefined && !/^[bcdeEfFgGnosxX%]$/.test(m[10]) && !(m[10] && cpLen(m[10]) === 1))) throw valueError(`Invalid format specifier '${spec}' for object of type '${objType}'`);
  const zero = !!m[6];
  const sp: FormatSpec = {
    fill: m[1] ?? (zero && !m[2] ? "0" : " "),
    align: m[2] ?? (zero && !m[2] ? "=" : ""),
    sign: m[3] ?? "",
    z: !!m[4],
    alt: !!m[5],
    zero,
    width: m[7] ? Number(m[7]) : 0,
    grouping: m[8] ?? "",
    precision: m[9] !== undefined ? Number(m[9]) : null,
    type: m[10] ?? defType,
  };
  if (sp.grouping) {
    const t = sp.type;
    const ok = ["d", "e", "f", "g", "E", "G", "%", "F", ""].includes(t) || (sp.grouping === "_" && ["b", "o", "x", "X"].includes(t));
    if (!ok) throw valueError(`Cannot specify '${sp.grouping}' with '${t}'.`);
  }
  return sp;
}

function groupDigits(intPart: string, sep: string, every = 3): string {
  if (!sep) return intPart;
  const out: string[] = [];
  for (let i = intPart.length; i > 0; i -= every) out.unshift(intPart.slice(Math.max(0, i - every), i));
  return out.join(sep);
}

/** 符号・前置き・整数部・残りを、詰め物と区切りを入れて並べる(CPython の fill_number)。 */
function layoutNumber(sign: string, prefix: string, digits: string, rest: string, sp: FormatSpec, every: number): string {
  let grouped = digits;
  if (sp.grouping) {
    if (sp.fill === "0" && sp.align === "=" && sp.width) {
      // 0 で詰めるときは、詰めた 0 にも区切りが入る
      const minWidth = sp.width - cpLen(sign) - cpLen(prefix) - cpLen(rest);
      let d = digits.length;
      while (d + Math.floor((d - 1) / every) < minWidth) d++;
      grouped = groupDigits(digits.padStart(d, "0"), sp.grouping, every);
    } else grouped = groupDigits(digits, sp.grouping, every);
  }
  const content = prefix + grouped + rest;
  const align = sp.align || ">";
  const pad = Math.max(0, sp.width - cpLen(sign + content));
  if (!pad) return sign + content;
  if (align === "=") return sign + prefix + sp.fill.repeat(pad) + grouped + rest;
  if (align === "<") return sign + content + sp.fill.repeat(pad);
  if (align === "^") {
    const l = Math.floor(pad / 2);
    return sp.fill.repeat(l) + sign + content + sp.fill.repeat(pad - l);
  }
  return sp.fill.repeat(pad) + sign + content;
}

const signOf = (neg: boolean, sp: FormatSpec) => (neg ? "-" : sp.sign === "+" ? "+" : sp.sign === " " ? " " : "");

/** format(value, spec) */
export function formatValue(v: PyVal, spec: string): string {
  if (v instanceof Undefined) return spec ? v.fail() : "";
  if (isStrLike(v)) {
    const sp = parseSpec(spec, "s", "str");
    if (sp.type !== "s") throw valueError(`Unknown format code '${sp.type}' for object of type 'str'`);
    if (sp.sign) throw valueError("Sign not allowed in string format specifier");
    if (sp.z) throw valueError("Negative zero coercion (z) not allowed in format specifier");
    if (sp.alt) throw valueError("Alternate form (#) not allowed in string format specifier");
    if (sp.align === "=") throw valueError("'=' alignment not allowed in string format specifier");
    let s = strOf(v);
    if (sp.precision !== null) s = cps(s).slice(0, sp.precision).join("");
    const pad = Math.max(0, sp.width - cpLen(s));
    const align = sp.align || "<";
    if (align === "<") return s + sp.fill.repeat(pad);
    if (align === ">") return sp.fill.repeat(pad) + s;
    const l = Math.floor(pad / 2);
    return sp.fill.repeat(l) + s + sp.fill.repeat(pad - l);
  }
  if (isInt(v) && !(typeof v === "boolean" && spec === "")) {
    const tn = typeName(v);
    const sp = parseSpec(spec, "d", tn);
    const t = sp.type;
    if ("eEfFgG%".includes(t)) return formatValue(Number(toBig(v)), spec);
    if (!"bcdoxXn".includes(t)) throw valueError(`Unknown format code '${t}' for object of type '${tn}'`);
    if (sp.precision !== null) throw valueError("Precision not allowed in integer format specifier");
    if (sp.z) throw valueError("Negative zero coercion (z) not allowed in integer format specifier");
    const n = toBig(v);
    if (t === "c") {
      if (sp.sign) throw valueError("Sign not allowed with integer format specifier 'c'");
      if (sp.alt) throw valueError("Alternate form (#) not allowed with integer format specifier 'c'");
      if (n < 0n || n > 0x10ffffn) throw new PyException("OverflowError", "%c arg not in range(0x110000)");
      return layoutNumber("", "", String.fromCodePoint(Number(n)), "", { ...sp, grouping: "" }, 3);
    }
    const neg = n < 0n;
    const a = neg ? -n : n;
    const base = t === "b" ? 2 : t === "o" ? 8 : t === "x" || t === "X" ? 16 : 10;
    let digits = a.toString(base);
    let prefix = sp.alt && base !== 10 ? (base === 2 ? "0b" : base === 8 ? "0o" : "0x") : "";
    if (t === "X") {
      digits = digits.toUpperCase();
      prefix = prefix.toUpperCase();
    }
    return layoutNumber(signOf(neg, sp), prefix, digits, "", sp, base === 10 ? 3 : 4);
  }
  if (typeof v === "number" || typeof v === "boolean") {
    const x = typeof v === "boolean" ? (v ? 1 : 0) : v;
    const sp = parseSpec(spec, "", "float");
    const t = sp.type;
    if (!["e", "E", "f", "F", "g", "G", "n", "%", ""].includes(t)) throw valueError(`Unknown format code '${t}' for object of type 'float'`);
    const neg = x < 0 || Object.is(x, -0);
    let a = Math.abs(x);
    let body: string;
    const prec = sp.precision ?? 6;
    if (!Number.isFinite(a)) {
      body = Number.isNaN(a) ? "nan" : "inf";
      if (t === "E" || t === "F" || t === "G") body = body.toUpperCase();
      if (t === "%") body += "%";
      return layoutNumber(Number.isNaN(x) ? signOf(false, sp) : signOf(neg, sp), "", "", body, { ...sp, grouping: "" }, 3);
    }
    switch (t) {
      case "f":
      case "F":
        body = fixedDigits(a, prec) + (sp.alt && prec === 0 ? "." : "");
        break;
      case "e":
      case "E": {
        const p = expParts(a, prec);
        body = p.mant + (sp.alt && prec === 0 ? "." : "") + expStr(p.exp, t === "E");
        break;
      }
      case "%":
        a = a * 100;
        body = fixedDigits(a, prec) + (sp.alt && prec === 0 ? "." : "") + "%";
        break;
      case "g":
      case "G":
      case "n":
        body = gFormat(a, prec, sp.alt, t === "G", false);
        break;
      default:
        body = sp.precision === null ? floatRepr(a) : gFormat(a, sp.precision, sp.alt, false, true);
    }
    let isNeg = neg;
    if (sp.z && !/[1-9]/.test(body.replace(/[eE][+-]\d+$/, ""))) isNeg = false;
    const m = /^(\d*)(.*)$/s.exec(body)!;
    return layoutNumber(signOf(isNeg, sp), "", m[1], m[2], sp, 3);
  }
  if (v instanceof PyComplex && spec === "") return v.repr();
  if (spec === "") return pyStr(v);
  throw typeError(`unsupported format string passed to ${typeName(v)}.__format__`);
}

/** 環境(sandbox)の getattr・getitem を外から差し込む(str.format の {0.x} {0[k]} で使う)。 */
export const formatHooks: { getattr: (o: PyVal, n: string) => PyVal; getitem: (o: PyVal, k: PyVal) => PyVal } = {
  getattr: (o, n) => {
    const r = getAttrRaw(o, n);
    if (r === NOATTR) throw new PyException("AttributeError", `'${typeName(o)}' object has no attribute '${n}'`);
    return r;
  },
  getitem: getItemRaw,
};

/** str.format(sandbox の SandboxedFormatter と同じ動き)。 */
export function strFormat(fmt: string, args: PyVal[], kw: Kw, markup = false): string {
  let out = "";
  let auto = 0;
  let mode: "auto" | "manual" | null = null;
  const a = fmt;
  const render = (field: string, conv: string | null, spec: string, depth: number): string => {
    // field_name: arg_name ("." attr | "[" key "]")*
    const m = /^([^.[]*)(.*)$/s.exec(field)!;
    let first = m[1];
    let obj: PyVal;
    if (first === "") {
      if (mode === "manual") throw valueError("cannot switch from manual field specification to automatic field numbering");
      mode = "auto";
      first = String(auto++);
      obj = argAt(Number(first));
    } else if (/^\d+$/.test(first)) {
      if (mode === "auto") throw valueError("cannot switch from automatic field numbering to manual field specification");
      mode = "manual";
      obj = argAt(Number(first));
    } else {
      const v = kw.get(first);
      if (v === undefined) throw new PyException("KeyError", reprStr(first));
      obj = v;
    }
    let rest = m[2];
    while (rest) {
      if (rest[0] === ".") {
        const mm = /^\.([^.[]*)/.exec(rest)!;
        if (!mm[1]) throw valueError("Empty attribute in format string");
        obj = formatHooks.getattr(obj, mm[1]);
        rest = rest.slice(mm[0].length);
      } else if (rest[0] === "[") {
        const j = rest.indexOf("]");
        if (j < 0) throw valueError("Missing ']' in format string");
        const key = rest.slice(1, j);
        if (!key) throw valueError("Empty attribute in format string");
        obj = formatHooks.getitem(obj, /^\d+$/.test(key) ? BigInt(key) : key);
        rest = rest.slice(j + 1);
        if (rest && rest[0] !== "." && rest[0] !== "[") throw valueError("Only '.' or '[' may follow ']' in format field specifier");
      } else throw valueError("Only '.' or '[' may follow ']' in format field specifier");
    }
    if (conv === "r") obj = repr(obj);
    else if (conv === "s") obj = pyStr(obj);
    else if (conv === "a") obj = asciiRepr(obj);
    else if (conv !== null) throw valueError(`Unknown conversion specifier ${conv}`);
    if (depth > 0 && spec.includes("{")) spec = parse(spec, depth - 1);
    const r = formatValue(obj, spec);
    return markup && !(obj instanceof Markup) ? escapeHtml(r) : r;
  };
  const argAt = (n: number): PyVal => {
    if (n >= args.length) throw new PyException("IndexError", "tuple index out of range");
    return args[n];
  };
  const parse = (src: string, depth: number): string => {
    let o = "";
    let j = 0;
    while (j < src.length) {
      const c = src[j];
      if (c === "{") {
        if (j + 1 >= src.length) throw valueError("Single '{' encountered in format string");
        if (src[j + 1] === "{") {
          o += "{";
          j += 2;
          continue;
        }
        // 対応する } を探す(入れ子の {} を数える)
        let k = j + 1;
        let lvl = 1;
        let inKey = false;
        while (k < src.length) {
          if (src[k] === "[") inKey = true;
          else if (src[k] === "]") inKey = false;
          else if (!inKey && src[k] === "{") lvl++;
          else if (!inKey && src[k] === "}") {
            lvl--;
            if (!lvl) break;
          }
          k++;
        }
        if (k >= src.length) throw valueError("expected '}' before end of string");
        const inner = src.slice(j + 1, k);
        const mm = /^((?:[^![:]|\[[^\]]*\])*)(?:!(.?))?(?::(.*))?$/s.exec(inner);
        if (!mm) throw valueError("expected ':' after conversion specifier");
        o += render(mm[1], mm[2] ?? null, mm[3] ?? "", depth);
        j = k + 1;
      } else if (c === "}") {
        if (src[j + 1] === "}") {
          o += "}";
          j += 2;
          continue;
        }
        throw valueError("Single '}' encountered in format string");
      } else {
        o += c;
        j++;
      }
    }
    return o;
  };
  out = parse(a, 2);
  return out;
}

export function asciiRepr(v: PyVal): string {
  return repr(v).replace(/[^\x00-\x7f]/gu, (ch) => {
    const c = ch.codePointAt(0)!;
    return c <= 0xff ? "\\x" + c.toString(16).padStart(2, "0") : c <= 0xffff ? "\\u" + c.toString(16).padStart(4, "0") : "\\U" + c.toString(16).padStart(8, "0");
  });
}

// ---------------------------------------------------------------- % 書式

/** str % args(printf 形式)。 */
export function percentFormat(fmtV: string | Markup, args: PyVal): PyVal {
  const markup = fmtV instanceof Markup;
  const fmt = strOf(fmtV);
  // PyMapping_Check: __getitem__ を持つもの(tuple と str を除く)
  const isMapping = !(args instanceof PyTuple) && !isStrLike(args) && (args instanceof PyDict || Array.isArray(args) || args instanceof PyRange || args instanceof Undefined);
  const list: PyVal[] = args instanceof PyTuple ? args.items : [args];
  let ai = 0;
  let usedMapping = false;
  const next = (): PyVal => {
    if (ai >= list.length) throw typeError("not enough arguments for format string");
    return list[ai++];
  };
  let out = "";
  const a = cps(fmt);
  let i = 0;
  while (i < a.length) {
    if (a[i] !== "%") {
      out += a[i++];
      continue;
    }
    const start = i;
    i++;
    let key: string | null = null;
    if (a[i] === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < a.length && depth) {
        if (a[j] === "(") depth++;
        else if (a[j] === ")") depth--;
        j++;
      }
      if (depth) throw valueError("incomplete format key");
      key = a.slice(i + 1, j - 1).join("");
      i = j;
    }
    let flags = "";
    while ("-+ #0".includes(a[i] ?? "x")) flags += a[i++];
    let width: number | null = null;
    if (a[i] === "*") {
      const w = next();
      if (!isInt(w)) throw typeError("* wants int");
      width = Number(toBig(w));
      if (width < 0) {
        flags += "-";
        width = -width;
      }
      i++;
    } else {
      let w = "";
      while (/\d/.test(a[i] ?? "")) w += a[i++];
      if (w) width = Number(w);
    }
    let prec: number | null = null;
    if (a[i] === ".") {
      i++;
      if (a[i] === "*") {
        const p = next();
        if (!isInt(p)) throw typeError("* wants int");
        prec = Number(toBig(p));
        i++;
      } else {
        let p = "";
        while (/\d/.test(a[i] ?? "")) p += a[i++];
        prec = p ? Number(p) : 0;
      }
    }
    while ("hlL".includes(a[i] ?? "x")) i++;
    const conv = a[i++];
    if (conv === undefined) throw valueError("incomplete format");
    if (conv === "%") {
      out += "%";
      continue;
    }
    let val: PyVal;
    if (key !== null) {
      if (!isMapping) throw typeError("format requires a mapping");
      usedMapping = true;
      val = getItemRaw(args, key);
    } else val = next();
    let body: string;
    let sign = "";
    const numeric = (): number | bigint => {
      if (isInt(val)) return toBig(val);
      if (typeof val === "number") return val;
      if ("eEfFgG".includes(conv)) throw typeError(`must be real number, not ${typeName(val)}`);
      throw typeError(`%${conv} format: a real number is required, not ${typeName(val)}`);
    };
    switch (conv) {
      case "s":
        body = pyStr(val);
        if (prec !== null) body = cps(body).slice(0, prec).join("");
        if (markup && !(val instanceof Markup)) body = escapeHtml(body);
        break;
      case "r":
        body = repr(val);
        if (prec !== null) body = cps(body).slice(0, prec).join("");
        if (markup) body = escapeHtml(body);
        break;
      case "a":
        body = asciiRepr(val);
        if (prec !== null) body = cps(body).slice(0, prec).join("");
        break;
      case "d":
      case "i":
      case "u": {
        let n = numeric();
        if (typeof n === "number") {
          if (!Number.isFinite(n)) throw new PyException(Number.isNaN(n) ? "ValueError" : "OverflowError", Number.isNaN(n) ? "cannot convert float NaN to integer" : "cannot convert float infinity to integer");
          n = BigInt(Math.trunc(n));
        }
        sign = n < 0n ? "-" : flags.includes("+") ? "+" : flags.includes(" ") ? " " : "";
        body = (n < 0n ? -n : n).toString();
        if (prec !== null) body = body.padStart(prec, "0");
        break;
      }
      case "o":
      case "x":
      case "X": {
        if (!isInt(val)) throw typeError(`%${conv} format: an integer is required, not ${typeName(val)}`);
        const n = toBig(val);
        sign = n < 0n ? "-" : flags.includes("+") ? "+" : flags.includes(" ") ? " " : "";
        body = (n < 0n ? -n : n).toString(conv === "o" ? 8 : 16);
        if (prec !== null) body = body.padStart(prec, "0");
        if (flags.includes("#")) body = (conv === "o" ? "0o" : "0x") + body;
        if (conv === "X") body = body.toUpperCase();
        break;
      }
      case "e":
      case "E":
      case "f":
      case "F":
      case "g":
      case "G": {
        const n = numeric();
        const x = typeof n === "bigint" ? Number(n) : n;
        sign = x < 0 || Object.is(x, -0) ? "-" : flags.includes("+") ? "+" : flags.includes(" ") ? " " : "";
        body = formatValue(Math.abs(x), `${flags.includes("#") ? "#" : ""}.${prec ?? 6}${conv}`);
        break;
      }
      case "c":
        if (isStrLike(val)) {
          if (cpLen(strOf(val)) !== 1) throw typeError("%c requires an int or a unicode character, not a string of length " + cpLen(strOf(val)));
          body = strOf(val);
        } else if (isInt(val)) body = String.fromCodePoint(Number(toBig(val)));
        else throw typeError(`%c requires an int or a unicode character, not ${typeName(val)}`);
        break;
      default:
        throw valueError(`unsupported format character '${conv}' (0x${conv.codePointAt(0)!.toString(16)}) at index ${cps(fmt.slice(0)).slice(0, i - 1).length}`);
    }
    void start;
    const total = cpLen(sign + body);
    if (width !== null && total < width) {
      const pad = width - total;
      if (flags.includes("-")) body = sign + body + " ".repeat(pad);
      else if (flags.includes("0") && "diouxXeEfFgG".includes(conv)) {
        const pre = /^0[oxX]/.test(body) ? body.slice(0, 2) : "";
        body = sign + pre + "0".repeat(pad) + body.slice(pre.length);
      } else body = " ".repeat(pad) + sign + body;
    } else body = sign + body;
    out += body;
  }
  if (!isMapping && ai < list.length) throw typeError("not all arguments converted during string formatting");
  void usedMapping;
  return markup ? new Markup(out) : out;
}

// ---------------------------------------------------------------- json.dumps

export type DumpsOpts = { ensureAscii: boolean; indent: string | null; itemSep: string; keySep: string; sortKeys: boolean };

function jsonStr(s: string, ascii: boolean): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else if (ascii && c > 0x7e) {
      if (c > 0xffff) {
        const v = c - 0x10000;
        out += "\\u" + (0xd800 + (v >> 10)).toString(16) + "\\u" + (0xdc00 + (v & 0x3ff)).toString(16);
      } else out += "\\u" + c.toString(16).padStart(4, "0");
    } else out += ch;
  }
  return out + '"';
}

function jsonFloat(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  return floatRepr(x);
}

/** json.dumps(Python と同じ出力)。 */
export function jsonDumps(v: PyVal, o: DumpsOpts): string {
  const enc = (x: PyVal, level: number): string => {
    if (x === null) return "null";
    if (x === true) return "true";
    if (x === false) return "false";
    if (typeof x === "bigint") return x.toString();
    if (typeof x === "number") return jsonFloat(x);
    if (isStrLike(x)) return jsonStr(strOf(x), o.ensureAscii);
    const nl = (lvl: number) => (o.indent === null ? "" : "\n" + o.indent.repeat(lvl));
    if (Array.isArray(x) || x instanceof PyTuple) {
      const items = Array.isArray(x) ? x : x.items;
      if (!items.length) return "[]";
      return "[" + nl(level + 1) + items.map((y) => enc(y, level + 1)).join(o.itemSep + nl(level + 1)) + nl(level) + "]";
    }
    if (x instanceof PyDict) {
      if (!x.size) return "{}";
      let entries = x.entries();
      if (o.sortKeys) {
        entries = entries.slice().sort((p, q) => {
          const c = orderCmp(p[0], q[0]);
          if (c === null) throw typeError(`'<' not supported between instances of '${typeName(q[0])}' and '${typeName(p[0])}'`);
          return c;
        });
      }
      const parts = entries.map(([k, val]) => {
        let ks: string;
        if (isStrLike(k)) ks = strOf(k);
        else if (typeof k === "number") ks = jsonFloat(k);
        else if (k === true) ks = "true";
        else if (k === false) ks = "false";
        else if (k === null) ks = "null";
        else if (typeof k === "bigint") ks = k.toString();
        else throw typeError(`keys must be str, int, float, bool or None, not ${typeName(k)}`);
        return jsonStr(ks, o.ensureAscii) + o.keySep + enc(val, level + 1);
      });
      return "{" + nl(level + 1) + parts.join(o.itemSep + nl(level + 1)) + nl(level) + "}";
    }
    const tn = x instanceof PyObject && (x.typeName === "TemplateNamespace" || x.typeName === "Namespace") ? x.typeName : typeName(x);
    throw typeError(`Object of type ${tn} is not JSON serializable`);
  };
  return enc(v, 0);
}

// ---------------------------------------------------------------- pprint

function safeKeyCmp(a: PyVal, b: PyVal): number {
  try {
    const c = orderCmp(a, b);
    if (c !== null) return c;
  } catch {
    // 下へ
  }
  const ta = `<class '${typeName(a)}'>`;
  const tb = `<class '${typeName(b)}'>`;
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

function sortedItems(d: PyDict): [PyVal, PyVal][] {
  return d.entries().sort((p, q) => safeKeyCmp(p[0], q[0]) || safeKeyCmp(p[1], q[1]));
}

function safeRepr(v: PyVal): string {
  if (v instanceof PyDict) {
    if (!v.size) return "{}";
    return "{" + sortedItems(v).map(([k, x]) => `${safeRepr(k)}: ${safeRepr(x)}`).join(", ") + "}";
  }
  if (Array.isArray(v)) return v.length ? "[" + v.map(safeRepr).join(", ") + "]" : "[]";
  if (v instanceof PyTuple && !v.names) {
    if (!v.items.length) return "()";
    return v.items.length === 1 ? `(${safeRepr(v.items[0])},)` : "(" + v.items.map(safeRepr).join(", ") + ")";
  }
  return repr(v);
}

/** pprint.pformat(width=80) */
export function pformat(v: PyVal): string {
  const width = 80;
  let out = "";
  const write = (s: string) => (out += s);
  const fmt = (o: PyVal, indent: number, allowance: number, level: number) => {
    const rep = safeRepr(o);
    const maxWidth = width - indent - allowance;
    if (cpLen(rep) > maxWidth) {
      if (o instanceof PyDict) {
        write("{");
        if (o.size) formatDictItems(sortedItems(o), indent, allowance + 1, level + 1);
        write("}");
        return;
      }
      if (Array.isArray(o)) {
        write("[");
        formatItems(o, indent, allowance + 1, level + 1);
        write("]");
        return;
      }
      if (o instanceof PyTuple && !o.names) {
        write("(");
        const end = o.items.length === 1 ? ",)" : ")";
        formatItems(o.items, indent, allowance + end.length, level + 1);
        write(end);
        return;
      }
      if (typeof o === "string") return pprintStr(o, indent, allowance, level + 1);
    }
    write(rep);
  };
  const formatDictItems = (items: [PyVal, PyVal][], indent: number, allowance: number, level: number) => {
    indent += 1;
    const delimnl = ",\n" + " ".repeat(indent);
    items.forEach(([k, e], i) => {
      const last = i === items.length - 1;
      const rep = safeRepr(k);
      write(rep);
      write(": ");
      fmt(e, indent + cpLen(rep) + 2, last ? allowance : 1, level);
      if (!last) write(delimnl);
    });
  };
  const formatItems = (items: PyVal[], indent: number, allowance: number, level: number) => {
    indent += 1;
    const delimnl = ",\n" + " ".repeat(indent);
    let delim = "";
    items.forEach((e, i) => {
      const last = i === items.length - 1;
      write(delim);
      delim = delimnl;
      fmt(e, indent, last ? allowance : 1, level);
    });
  };
  const pprintStr = (s: string, indent: number, allowance: number, level: number) => {
    if (!s.length) return write(repr(s));
    const chunks: string[] = [];
    const lines = splitlines(s, true);
    if (level === 1) {
      indent += 1;
      allowance += 1;
    }
    let maxWidth1 = width - indent;
    const maxWidth = maxWidth1;
    let rep = "";
    lines.forEach((line, i) => {
      rep = reprStr(line);
      if (i === lines.length - 1) maxWidth1 -= allowance;
      if (cpLen(rep) <= maxWidth1) chunks.push(rep);
      else {
        const parts = line.match(new RegExp(`[^${PY_WS_CLASS.slice(1, -1)}]*${PY_WS_CLASS}*`, "gu"))!.filter((x, j, arr) => x !== "" || j < arr.length - 1);
        let maxWidth2 = maxWidth;
        let current = "";
        parts.forEach((part, j) => {
          const cand = current + part;
          if (j === parts.length - 1 && i === lines.length - 1) maxWidth2 -= allowance;
          if (cpLen(reprStr(cand)) > maxWidth2) {
            if (current) chunks.push(reprStr(current));
            current = part;
          } else current = cand;
        });
        if (current) chunks.push(reprStr(current));
      }
    });
    if (chunks.length === 1) return write(rep);
    if (level === 1) write("(");
    chunks.forEach((c, i) => {
      if (i > 0) write("\n" + " ".repeat(indent));
      write(c);
    });
    if (level === 1) write(")");
  };
  fmt(v, 0, 0, 0);
  return out;
}

// ---------------------------------------------------------------- textwrap(wordwrap フィルター)

const TW_WS = "[\\t\\n\\x0b\\x0c\\r ]";
const TW_NWS = "[^\\t\\n\\x0b\\x0c\\r ]";
const WP = `[\\p{L}\\p{N}_!"'&.,?]`;
const LT = `[\\p{L}_]`;
const WORDSEP_RE = new RegExp(`(${TW_WS}+|(?<=${WP})-{2,}(?=[\\p{L}\\p{N}_])|${TW_NWS}+?(?:-(?:(?<=${LT}{2}-)|(?<=${LT}-${LT}-))(?=${LT}-?${LT})|(?=${TW_WS}|$)|(?<=${WP})(?=-{2,}[\\p{L}\\p{N}_])))`, "u");
const WORDSEP_SIMPLE_RE = new RegExp(`(${TW_WS}+)`);

/** textwrap.wrap(expand_tabs=False, replace_whitespace=False) */
export function textwrap(text: string, width: number, breakLongWords: boolean, breakOnHyphens: boolean): string[] {
  let chunks = (breakOnHyphens ? text.split(WORDSEP_RE) : text.split(WORDSEP_SIMPLE_RE)).filter((c) => c);
  if (width <= 0) throw valueError(`invalid width ${width} (must be > 0)`);
  const lines: string[] = [];
  chunks = chunks.reverse();
  const L = (s: string) => cpLen(s);
  while (chunks.length) {
    let cur: string[] = [];
    let curLen = 0;
    if (chunks[chunks.length - 1].trim() === "" && lines.length && /^[\t\n\x0b\x0c\r ]*$/.test(chunks[chunks.length - 1])) chunks.pop();
    while (chunks.length) {
      const l = L(chunks[chunks.length - 1]);
      if (curLen + l <= width) {
        cur.push(chunks.pop()!);
        curLen += l;
      } else break;
    }
    if (chunks.length && L(chunks[chunks.length - 1]) > width) {
      const spaceLeft = width < 1 ? 1 : width - curLen;
      if (breakLongWords && spaceLeft > 0) {
        let end = spaceLeft;
        const chunk = cps(chunks[chunks.length - 1]);
        if (breakOnHyphens && chunk.length > spaceLeft) {
          const hy = chunk.slice(0, spaceLeft).lastIndexOf("-");
          if (hy > 0 && chunk.slice(0, hy).some((c) => c !== "-")) end = hy + 1;
        }
        cur.push(chunk.slice(0, end).join(""));
        chunks[chunks.length - 1] = chunk.slice(end).join("");
      } else if (!cur.length) cur.push(chunks.pop()!);
      curLen = cur.reduce((n, c) => n + L(c), 0);
    }
    if (cur.length && /^[\t\n\x0b\x0c\r ]*$/.test(cur[cur.length - 1]) && stripChars(cur[cur.length - 1], null, true, true) === "") {
      curLen -= L(cur[cur.length - 1]);
      cur = cur.slice(0, -1);
    }
    if (cur.length) lines.push(cur.join(""));
  }
  return lines;
}

// ---------------------------------------------------------------- URL

/** urllib.parse.quote_from_bytes(UTF-8) */
export function urlQuote(v: PyVal, forQs: boolean): string {
  const s = isStrLike(v) ? strOf(v) : pyStr(v);
  const safe = forQs ? "" : "/";
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (/[A-Za-z0-9_.\-~]/.test(ch) || safe.includes(ch)) out += ch;
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return forQs ? out.replace(/%20/g, "+") : out;
}

const HTTP_RE = /^((https?:\/\/|www\.)(([\p{L}\p{N}_%-]+\.)+)?([a-z]{2,63}|xn--[\p{L}\p{N}_%]{2,59})|([\p{L}\p{N}_%-]{2,63}\.)+(com|net|int|edu|gov|org|info|mil)|(https?:\/\/)((([\d]{1,3})(\.[\d]{1,3}){3})|(\[([\da-f]{0,4}:){2}([\da-f]{0,4}:?){1,6}\])))(?::[\d]{1,5})?(?:[/?#]\S*)?$/iu;
const EMAIL_RE = /^\S+@[\p{L}\p{N}_][\p{L}\p{N}_.-]*\.[\p{L}\p{N}_]+$/u;

/** jinja2.utils.urlize */
export function urlize(text: string, trimLimit: number | null, rel: string | null, target: string | null, extraSchemes: string[] | null): string {
  const trim = (x: string) => (trimLimit !== null && cpLen(x) > trimLimit ? cps(x).slice(0, trimLimit).join("") + "..." : x);
  const words = escapeHtml(text).split(new RegExp(`(${PY_WS_CLASS}+)`, "u"));
  const relAttr = rel ? ` rel="${escapeHtml(rel)}"` : "";
  const targetAttr = target ? ` target="${escapeHtml(target)}"` : "";
  return words
    .map((word) => {
      let head = "";
      let middle = word;
      let tail = "";
      let m = /^([(<]|&lt;)+/.exec(middle);
      if (m) {
        head = m[0];
        middle = middle.slice(m[0].length);
      }
      if ([")", ">", ".", ",", "\n", "&gt;"].some((e) => middle.endsWith(e))) {
        m = /([)>.,\n]|&gt;)+$/.exec(middle);
        if (m) {
          tail = m[0];
          middle = middle.slice(0, m.index);
        }
      }
      for (const [sc, ec] of [["(", ")"], ["<", ">"], ["&lt;", "&gt;"]]) {
        const startCount = middle.split(sc).length - 1;
        if (startCount <= middle.split(ec).length - 1) continue;
        const times = Math.min(startCount, tail.split(ec).length - 1);
        for (let t = 0; t < times; t++) {
          const endIndex = tail.indexOf(ec) + ec.length;
          middle += tail.slice(0, endIndex);
          tail = tail.slice(endIndex);
        }
      }
      if (HTTP_RE.test(middle)) {
        if (middle.startsWith("https://") || middle.startsWith("http://")) middle = `<a href="${middle}"${relAttr}${targetAttr}>${trim(middle)}</a>`;
        else middle = `<a href="https://${middle}"${relAttr}${targetAttr}>${trim(middle)}</a>`;
      } else if (middle.startsWith("mailto:") && EMAIL_RE.test(middle.slice(7))) middle = `<a href="${middle}">${middle.slice(7)}</a>`;
      else if (middle.includes("@") && !middle.startsWith("www.") && !middle.startsWith("@") && !middle.includes(":") && EMAIL_RE.test(middle)) middle = `<a href="mailto:${middle}">${middle}</a>`;
      else if (extraSchemes) {
        for (const sc of extraSchemes) if (middle !== sc && middle.startsWith(sc)) middle = `<a href="${middle}"${relAttr}${targetAttr}>${middle}</a>`;
      }
      return head + middle + tail;
    })
    .join("");
}

// ---------------------------------------------------------------- JSON の読み込み(json.loads)

/** json.loads と同じ決まりで読む(整数は int、小数点・指数があれば float、キーの重複は後が勝つ)。 */
export function jsonLoads(src: string): PyVal {
  let i = 0;
  const err = (msg: string): never => {
    const before = src.slice(0, i);
    const line = before.split("\n").length;
    const col = i - before.lastIndexOf("\n");
    throw new PyException("JSONDecodeError", `${msg}: line ${line} column ${col} (char ${i})`);
  };
  const ws = () => {
    while (i < src.length && " \t\n\r".includes(src[i])) i++;
  };
  const value = (): PyVal => {
    ws();
    const c = src[i];
    if (c === "{") {
      i++;
      const d = new PyDict();
      ws();
      if (src[i] === "}") {
        i++;
        return d;
      }
      for (;;) {
        ws();
        if (src[i] !== '"') err("Expecting property name enclosed in double quotes");
        const k = str();
        ws();
        if (src[i] !== ":") err("Expecting ':' delimiter");
        i++;
        const v = value();
        d.set(k, v);
        ws();
        if (src[i] === ",") {
          i++;
          continue;
        }
        if (src[i] === "}") {
          i++;
          return d;
        }
        err("Expecting ',' delimiter");
      }
    }
    if (c === "[") {
      i++;
      const a: PyVal[] = [];
      ws();
      if (src[i] === "]") {
        i++;
        return a;
      }
      for (;;) {
        a.push(value());
        ws();
        if (src[i] === ",") {
          i++;
          continue;
        }
        if (src[i] === "]") {
          i++;
          return a;
        }
        err("Expecting ',' delimiter");
      }
    }
    if (c === '"') return str();
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 400));
    if (m && m[0] !== "-") {
      i += m[0].length;
      if (m[2] || m[3]) return Number(m[0]);
      return BigInt(m[0]);
    }
    for (const [w, v] of [["true", true], ["false", false], ["null", null], ["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity]] as [string, PyVal][]) {
      if (src.startsWith(w, i)) {
        i += w.length;
        return v;
      }
    }
    return err("Expecting value");
  };
  const str = (): string => {
    i++;
    let out = "";
    for (;;) {
      if (i >= src.length) err("Unterminated string starting at");
      const c = src[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        const e = src[i + 1];
        const map: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (e in map) {
          out += map[e];
          i += 2;
        } else if (e === "u") {
          const h = src.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) err("Invalid \\uXXXX escape");
          out += String.fromCharCode(parseInt(h, 16));
          i += 6;
        } else err("Invalid \\escape");
      } else {
        if (c.charCodeAt(0) < 0x20) err("Invalid control character at");
        out += c;
        i++;
      }
    }
  };
  const v = value();
  ws();
  if (i < src.length) err("Extra data");
  return v;
}
