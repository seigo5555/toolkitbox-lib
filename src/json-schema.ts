/**
 * JSON Schema(Draft 2020-12 の主要な部分)で、JSONデータを検証する。
 *
 * AIの構造化出力では、スキーマに沿ったJSONが返る。返ってきたものが本当にスキーマに
 * 合っているか、スキーマ自体が意図どおりか、を手元で確かめるためのもの。
 *
 * 対応する語彙:
 *  - 型と値: type, enum, const
 *  - 数値: minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf
 *  - 文字列: minLength, maxLength(文字数はコードポイント), pattern(ECMA-262, 非アンカー。Unicode モードで読む)
 *  - 配列: items, prefixItems(draft-07 の items の配列形も受ける), minItems, maxItems,
 *          uniqueItems, contains, minContains, maxContains
 *  - オブジェクト: properties, patternProperties, additionalProperties, required,
 *          minProperties, maxProperties, propertyNames, dependentRequired,
 *          dependentSchemas(draft-07 の dependencies も受ける)
 *  - 合成: allOf, anyOf, oneOf, not, if / then / else
 *  - 参照: $ref(同じ文書の中 "#"、"#/$defs/…"、"#/definitions/…")、$defs
 *  - true / false のスキーマ
 *
 * **format は検証しない**(仕様上、既定では注釈で、検証は任意)。使われていれば
 * 「検証していない」と知らせる。unevaluatedProperties / unevaluatedItems / $dynamicRef /
 * 外部の $ref も、検証せず、その旨を知らせる。黙って通すと「通った=合っている」と誤解させるため。
 *
 * 検算は ajv(別実装)との突き合わせ。ajv 6 は draft-07 なので、共通する語彙の範囲で
 * 擬似乱数のスキーマとデータ数千通りの合否を比べる。
 */

export type SchemaIssueCode =
  | "type"
  | "enum"
  | "const"
  | "minimum"
  | "maximum"
  | "exclusiveMinimum"
  | "exclusiveMaximum"
  | "multipleOf"
  | "minLength"
  | "maxLength"
  | "pattern"
  | "minItems"
  | "maxItems"
  | "uniqueItems"
  | "contains"
  | "minContains"
  | "maxContains"
  | "required"
  | "additionalProperties"
  | "minProperties"
  | "maxProperties"
  | "propertyNames"
  | "dependentRequired"
  | "anyOf"
  | "oneOf"
  | "oneOfMultiple"
  | "not"
  | "falseSchema";

export type SchemaError = {
  /** データの中の位置(JSON Pointer)。ルートは ""。 */
  path: string;
  /** スキーマの中の位置(JSON Pointer)。 */
  schemaPath: string;
  code: SchemaIssueCode;
  /** メッセージに差し込む値。 */
  params: Record<string, string>;
};

export type SchemaProblemCode =
  | "notSchema"
  | "unknownType"
  | "badKeyword"
  | "badPattern"
  | "unresolvedRef"
  | "externalRef"
  | "refLoop"
  | "tooDeep";

export type SchemaProblem = { code: SchemaProblemCode; schemaPath: string; detail: string };

export type Skipped = "format" | "unevaluatedProperties" | "unevaluatedItems" | "dynamicRef" | "contentMediaType";

export type ValidateResult =
  | { ok: true; valid: boolean; errors: SchemaError[]; skipped: Skipped[] }
  | { ok: false; problem: SchemaProblem };

const TYPES = ["null", "boolean", "object", "array", "number", "string", "integer"] as const;
type JsonType = (typeof TYPES)[number];

const MAX_DEPTH = 200;
const MAX_ERRORS = 200;

class Problem extends Error {
  constructor(public p: SchemaProblem) {
    super(p.code);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function typeOf(v: unknown): Exclude<JsonType, "integer"> {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "boolean": return "boolean";
    case "number": return "number";
    case "string": return "string";
    default: return "object";
  }
}

function matchesType(v: unknown, t: JsonType): boolean {
  if (t === "integer") return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
  return typeOf(v) === t;
}

/** JSON としての等しさ(オブジェクトのキー順は問わない。数は値で比べる)。 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
/** 文字数はコードポイントで数える(JSON Schema の minLength / maxLength)。 */
const codePoints = (s: string) => [...s].length;

/** JSON Pointer を、文書の中の値に解決する。 */
function resolvePointer(root: unknown, ptr: string): unknown {
  if (ptr === "") return root;
  if (!ptr.startsWith("/")) throw new Error("bad pointer");
  let cur: unknown = root;
  for (const raw of ptr.slice(1).split("/")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= cur.length) throw new Error("missing");
      cur = cur[Number(key)];
    } else if (isObj(cur) && Object.prototype.hasOwnProperty.call(cur, key)) {
      cur = cur[key];
    } else {
      throw new Error("missing");
    }
  }
  return cur;
}

type Ctx = {
  root: unknown;
  skipped: Set<Skipped>;
  regex: Map<string, RegExp>;
  /** 再帰の検出用: スキーマの位置 + データの位置 の組。 */
  stack: Set<string>;
};

type Sink = SchemaError[] | null;

function pattern(ctx: Ctx, src: string, schemaPath: string): RegExp {
  let re = ctx.regex.get(src);
  if (!re) {
    // Unicode モード(u)で読む。`.` や文字クラスが、絵文字を1文字として数える。
    // u では不正になる古い書き方(\- など)は、u 無しで読み直す。どちらでも不正なら誤り。
    try {
      re = new RegExp(src, "u");
    } catch {
      try {
        re = new RegExp(src);
      } catch {
        throw new Problem({ code: "badPattern", schemaPath, detail: src });
      }
    }
    ctx.regex.set(src, re);
  }
  return re;
}

function fmt(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

function badKw(schemaPath: string, detail: string): never {
  throw new Problem({ code: "badKeyword", schemaPath, detail });
}

/** schema で data を検証する。失敗は sink に積む(sink が null なら真偽だけ)。 */
function check(schema: unknown, data: unknown, path: string, sp: string, ctx: Ctx, sink: Sink, depth: number): boolean {
  if (depth > MAX_DEPTH) throw new Problem({ code: "tooDeep", schemaPath: sp, detail: "" });
  if (schema === true) return true;
  if (schema === false) {
    push(sink, path, sp, "falseSchema", {});
    return false;
  }
  if (!isObj(schema)) throw new Problem({ code: "notSchema", schemaPath: sp, detail: typeOf(schema) });

  let ok = true;
  const fail = (code: SchemaIssueCode, kw: string, params: Record<string, string> = {}) => {
    ok = false;
    push(sink, path, `${sp}/${kw}`, code, params);
  };
  const s = schema;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(s, k);

  // ---- $ref(2019-09 以降は、同じ階層の他のキーも適用される)----
  if (has("$ref")) {
    const ref = s["$ref"];
    if (typeof ref !== "string") badKw(`${sp}/$ref`, "must be a string");
    if (!ref.startsWith("#")) throw new Problem({ code: "externalRef", schemaPath: `${sp}/$ref`, detail: ref });
    let target: unknown;
    try {
      target = resolvePointer(ctx.root, ref.slice(1));
    } catch {
      throw new Problem({ code: "unresolvedRef", schemaPath: `${sp}/$ref`, detail: ref });
    }
    const key = `${ref}\u0000${path}`;
    if (ctx.stack.has(key)) throw new Problem({ code: "refLoop", schemaPath: `${sp}/$ref`, detail: ref });
    ctx.stack.add(key);
    try {
      if (!check(target, data, path, ref.slice(1), ctx, sink, depth + 1)) ok = false;
    } finally {
      ctx.stack.delete(key);
    }
  }

  // ---- 型と値 ----
  if (has("type")) {
    const t = s["type"];
    const list = Array.isArray(t) ? t : [t];
    for (const x of list) if (typeof x !== "string" || !(TYPES as readonly string[]).includes(x)) throw new Problem({ code: "unknownType", schemaPath: `${sp}/type`, detail: String(x) });
    if (!(list as JsonType[]).some((x) => matchesType(data, x))) fail("type", "type", { types: (list as string[]).join(", "), actual: typeOf(data) });
  }
  if (has("enum")) {
    const e = s["enum"];
    if (!Array.isArray(e)) badKw(`${sp}/enum`, "must be an array");
    if (!e.some((x) => jsonEqual(x, data))) fail("enum", "enum", { allowed: fmt(e) });
  }
  if (has("const") && !jsonEqual(s["const"], data)) fail("const", "const", { value: fmt(s["const"]) });

  // ---- 数値 ----
  if (typeof data === "number") {
    const num = (k: string): number | null => {
      if (!has(k)) return null;
      const v = s[k];
      if (typeof v !== "number") badKw(`${sp}/${k}`, "must be a number");
      return v;
    };
    const min = num("minimum");
    if (min !== null && data < min) fail("minimum", "minimum", { limit: String(min) });
    const max = num("maximum");
    if (max !== null && data > max) fail("maximum", "maximum", { limit: String(max) });
    const emin = num("exclusiveMinimum");
    if (emin !== null && !(data > emin)) fail("exclusiveMinimum", "exclusiveMinimum", { limit: String(emin) });
    const emax = num("exclusiveMaximum");
    if (emax !== null && !(data < emax)) fail("exclusiveMaximum", "exclusiveMaximum", { limit: String(emax) });
    const mul = num("multipleOf");
    if (mul !== null) {
      if (!(mul > 0)) badKw(`${sp}/multipleOf`, "must be greater than 0");
      const q = data / mul;
      // 浮動小数点の誤差(0.3 / 0.1 など)で、割り切れるものを落とさない。
      const isMultiple = Number.isInteger(q) || Math.abs(q - Math.round(q)) < 1e-9 * Math.max(1, Math.abs(q));
      if (!isMultiple) fail("multipleOf", "multipleOf", { limit: String(mul) });
    }
  }

  // ---- 文字列 ----
  if (typeof data === "string") {
    if (has("minLength")) {
      const v = s["minLength"];
      if (typeof v !== "number") badKw(`${sp}/minLength`, "must be a number");
      if (codePoints(data) < v) fail("minLength", "minLength", { limit: String(v) });
    }
    if (has("maxLength")) {
      const v = s["maxLength"];
      if (typeof v !== "number") badKw(`${sp}/maxLength`, "must be a number");
      if (codePoints(data) > v) fail("maxLength", "maxLength", { limit: String(v) });
    }
    if (has("pattern")) {
      const v = s["pattern"];
      if (typeof v !== "string") badKw(`${sp}/pattern`, "must be a string");
      if (!pattern(ctx, v, `${sp}/pattern`).test(data)) fail("pattern", "pattern", { pattern: v });
    }
  }

  // ---- 配列 ----
  if (Array.isArray(data)) {
    const arr = data;
    if (has("minItems")) {
      const v = s["minItems"];
      if (typeof v !== "number") badKw(`${sp}/minItems`, "must be a number");
      if (arr.length < v) fail("minItems", "minItems", { limit: String(v) });
    }
    if (has("maxItems")) {
      const v = s["maxItems"];
      if (typeof v !== "number") badKw(`${sp}/maxItems`, "must be a number");
      if (arr.length > v) fail("maxItems", "maxItems", { limit: String(v) });
    }
    if (s["uniqueItems"] === true) {
      outer: for (let i = 0; i < arr.length; i++) {
        for (let j = 0; j < i; j++) {
          if (jsonEqual(arr[i], arr[j])) {
            fail("uniqueItems", "uniqueItems", { first: String(j), second: String(i) });
            break outer;
          }
        }
      }
    }
    // prefixItems(2020-12)/ items の配列形(draft-07)
    let prefix: unknown[] = [];
    if (has("prefixItems")) {
      if (!Array.isArray(s["prefixItems"])) badKw(`${sp}/prefixItems`, "must be an array");
      prefix = s["prefixItems"] as unknown[];
    } else if (Array.isArray(s["items"])) {
      prefix = s["items"] as unknown[];
    }
    for (let i = 0; i < Math.min(prefix.length, arr.length); i++) {
      if (!check(prefix[i], arr[i], `${path}/${i}`, `${sp}/${has("prefixItems") ? "prefixItems" : "items"}/${i}`, ctx, sink, depth + 1)) ok = false;
    }
    if (has("items") && !Array.isArray(s["items"])) {
      const start = has("prefixItems") ? prefix.length : 0;
      for (let i = start; i < arr.length; i++) {
        if (!check(s["items"], arr[i], `${path}/${i}`, `${sp}/items`, ctx, sink, depth + 1)) ok = false;
      }
    } else if (!has("prefixItems") && Array.isArray(s["items"]) && has("additionalItems")) {
      for (let i = prefix.length; i < arr.length; i++) {
        if (!check(s["additionalItems"], arr[i], `${path}/${i}`, `${sp}/additionalItems`, ctx, sink, depth + 1)) ok = false;
      }
    }
    if (has("contains")) {
      let matches = 0;
      for (let i = 0; i < arr.length; i++) if (check(s["contains"], arr[i], `${path}/${i}`, `${sp}/contains`, ctx, null, depth + 1)) matches++;
      const minC = has("minContains") ? Number(s["minContains"]) : 1;
      const maxC = has("maxContains") ? Number(s["maxContains"]) : Infinity;
      if (matches < minC) fail(has("minContains") ? "minContains" : "contains", has("minContains") ? "minContains" : "contains", { limit: String(minC), count: String(matches) });
      else if (matches > maxC) fail("maxContains", "maxContains", { limit: String(maxC), count: String(matches) });
    }
  }

  // ---- オブジェクト ----
  if (isObj(data)) {
    const obj = data;
    const keys = Object.keys(obj);
    if (has("required")) {
      const r = s["required"];
      if (!Array.isArray(r) || r.some((x) => typeof x !== "string")) badKw(`${sp}/required`, "must be an array of strings");
      for (const name of r as string[]) {
        if (!Object.prototype.hasOwnProperty.call(obj, name)) fail("required", "required", { property: name });
      }
    }
    if (has("minProperties")) {
      const v = s["minProperties"];
      if (typeof v !== "number") badKw(`${sp}/minProperties`, "must be a number");
      if (keys.length < v) fail("minProperties", "minProperties", { limit: String(v) });
    }
    if (has("maxProperties")) {
      const v = s["maxProperties"];
      if (typeof v !== "number") badKw(`${sp}/maxProperties`, "must be a number");
      if (keys.length > v) fail("maxProperties", "maxProperties", { limit: String(v) });
    }
    const props = has("properties") ? s["properties"] : undefined;
    if (props !== undefined && !isObj(props)) badKw(`${sp}/properties`, "must be an object");
    const patProps = has("patternProperties") ? s["patternProperties"] : undefined;
    if (patProps !== undefined && !isObj(patProps)) badKw(`${sp}/patternProperties`, "must be an object");

    for (const key of keys) {
      let matched = false;
      if (props && Object.prototype.hasOwnProperty.call(props, key)) {
        matched = true;
        if (!check(props[key], obj[key], `${path}/${esc(key)}`, `${sp}/properties/${esc(key)}`, ctx, sink, depth + 1)) ok = false;
      }
      if (patProps) {
        for (const [pat, sub] of Object.entries(patProps)) {
          if (pattern(ctx, pat, `${sp}/patternProperties/${esc(pat)}`).test(key)) {
            matched = true;
            if (!check(sub, obj[key], `${path}/${esc(key)}`, `${sp}/patternProperties/${esc(pat)}`, ctx, sink, depth + 1)) ok = false;
          }
        }
      }
      if (!matched && has("additionalProperties")) {
        const ap = s["additionalProperties"];
        if (ap === false) {
          fail("additionalProperties", "additionalProperties", { property: key });
        } else if (!check(ap, obj[key], `${path}/${esc(key)}`, `${sp}/additionalProperties`, ctx, sink, depth + 1)) {
          ok = false;
        }
      }
    }
    if (has("propertyNames")) {
      for (const key of keys) {
        if (!check(s["propertyNames"], key, `${path}/${esc(key)}`, `${sp}/propertyNames`, ctx, null, depth + 1)) fail("propertyNames", "propertyNames", { property: key });
      }
    }
    // dependentRequired / draft-07 dependencies
    const depReq = (has("dependentRequired") ? s["dependentRequired"] : undefined) as unknown;
    if (depReq !== undefined) {
      if (!isObj(depReq)) badKw(`${sp}/dependentRequired`, "must be an object");
      for (const [k, list] of Object.entries(depReq)) {
        if (!Array.isArray(list)) badKw(`${sp}/dependentRequired/${esc(k)}`, "must be an array");
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          for (const need of list as string[]) if (!Object.prototype.hasOwnProperty.call(obj, need)) fail("dependentRequired", "dependentRequired", { property: need, because: k });
        }
      }
    }
    const depSch = (has("dependentSchemas") ? s["dependentSchemas"] : undefined) as unknown;
    if (depSch !== undefined) {
      if (!isObj(depSch)) badKw(`${sp}/dependentSchemas`, "must be an object");
      for (const [k, sub] of Object.entries(depSch)) {
        if (Object.prototype.hasOwnProperty.call(obj, k) && !check(sub, data, path, `${sp}/dependentSchemas/${esc(k)}`, ctx, sink, depth + 1)) ok = false;
      }
    }
    const deps = (has("dependencies") ? s["dependencies"] : undefined) as unknown;
    if (deps !== undefined) {
      if (!isObj(deps)) badKw(`${sp}/dependencies`, "must be an object");
      for (const [k, v] of Object.entries(deps)) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        if (Array.isArray(v)) {
          for (const need of v as string[]) if (!Object.prototype.hasOwnProperty.call(obj, need)) fail("dependentRequired", "dependencies", { property: need, because: k });
        } else if (!check(v, data, path, `${sp}/dependencies/${esc(k)}`, ctx, sink, depth + 1)) {
          ok = false;
        }
      }
    }
  }

  // ---- 合成 ----
  if (has("allOf")) {
    const list = s["allOf"];
    if (!Array.isArray(list)) badKw(`${sp}/allOf`, "must be an array");
    list.forEach((sub, i) => {
      if (!check(sub, data, path, `${sp}/allOf/${i}`, ctx, sink, depth + 1)) ok = false;
    });
  }
  if (has("anyOf")) {
    const list = s["anyOf"];
    if (!Array.isArray(list)) badKw(`${sp}/anyOf`, "must be an array");
    let any = false;
    for (let i = 0; i < list.length; i++) if (check(list[i], data, path, `${sp}/anyOf/${i}`, ctx, null, depth + 1)) any = true;
    if (!any) fail("anyOf", "anyOf", { count: String(list.length) });
  }
  if (has("oneOf")) {
    const list = s["oneOf"];
    if (!Array.isArray(list)) badKw(`${sp}/oneOf`, "must be an array");
    let n = 0;
    for (let i = 0; i < list.length; i++) if (check(list[i], data, path, `${sp}/oneOf/${i}`, ctx, null, depth + 1)) n++;
    if (n === 0) fail("oneOf", "oneOf", { count: String(list.length) });
    else if (n > 1) fail("oneOfMultiple", "oneOf", { matched: String(n) });
  }
  if (has("not") && check(s["not"], data, path, `${sp}/not`, ctx, null, depth + 1)) fail("not", "not");
  if (has("if")) {
    const cond = check(s["if"], data, path, `${sp}/if`, ctx, null, depth + 1);
    if (cond && has("then")) {
      if (!check(s["then"], data, path, `${sp}/then`, ctx, sink, depth + 1)) ok = false;
    } else if (!cond && has("else")) {
      if (!check(s["else"], data, path, `${sp}/else`, ctx, sink, depth + 1)) ok = false;
    }
  }

  return ok;
}

function push(sink: Sink, path: string, schemaPath: string, code: SchemaIssueCode, params: Record<string, string>) {
  if (sink && sink.length < MAX_ERRORS) sink.push({ path, schemaPath, code, params });
}

/**
 * スキーマ全体の形を、データに触れる前に検査する。
 * 評価されなかった枝(別の oneOf の側、データに無いプロパティの下)に誤りがあっても、
 * 「通った」と答えないため。未知の型、配列であるべき所が文字列、不正な正規表現、
 * 0 以下の multipleOf、解決できない $ref などを、誤りとして返す。
 */
const NONNEG = ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "minContains", "maxContains"];
const NUMS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"];
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SCHEMA_SLOTS = ["additionalItems", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems"];
const SCHEMA_LISTS = ["prefixItems", "allOf", "anyOf", "oneOf"];

function checkShape(schema: unknown, sp: string, root: unknown, ctx: Ctx, depth = 0): void {
  if (depth > MAX_DEPTH) throw new Problem({ code: "tooDeep", schemaPath: sp, detail: "" });
  if (schema === true || schema === false) return;
  if (!isObj(schema)) throw new Problem({ code: "notSchema", schemaPath: sp, detail: typeOf(schema) });
  const has = (k: string) => Object.prototype.hasOwnProperty.call(schema, k);

  if (has("type")) {
    const t = schema["type"];
    for (const x of Array.isArray(t) ? t : [t]) if (typeof x !== "string" || !(TYPES as readonly string[]).includes(x)) throw new Problem({ code: "unknownType", schemaPath: `${sp}/type`, detail: String(x) });
  }
  if (has("enum") && !Array.isArray(schema["enum"])) badKw(`${sp}/enum`, "must be an array");
  if (has("required") && (!Array.isArray(schema["required"]) || (schema["required"] as unknown[]).some((x) => typeof x !== "string"))) badKw(`${sp}/required`, "must be an array of strings");
  for (const k of NONNEG) if (has(k) && !(typeof schema[k] === "number" && (schema[k] as number) >= 0)) badKw(`${sp}/${k}`, "must be a non-negative number");
  for (const k of NUMS) if (has(k) && typeof schema[k] !== "number") badKw(`${sp}/${k}`, "must be a number");
  if (has("multipleOf") && !(typeof schema["multipleOf"] === "number" && (schema["multipleOf"] as number) > 0)) badKw(`${sp}/multipleOf`, "must be greater than 0");
  if (has("uniqueItems") && typeof schema["uniqueItems"] !== "boolean") badKw(`${sp}/uniqueItems`, "must be true or false");
  if (has("pattern")) {
    if (typeof schema["pattern"] !== "string") badKw(`${sp}/pattern`, "must be a string");
    pattern(ctx, schema["pattern"] as string, `${sp}/pattern`);
  }
  if (has("$ref")) {
    const ref = schema["$ref"];
    if (typeof ref !== "string") badKw(`${sp}/$ref`, "must be a string");
    if (!(ref as string).startsWith("#")) throw new Problem({ code: "externalRef", schemaPath: `${sp}/$ref`, detail: ref as string });
    try {
      resolvePointer(root, (ref as string).slice(1));
    } catch {
      throw new Problem({ code: "unresolvedRef", schemaPath: `${sp}/$ref`, detail: ref as string });
    }
  }
  if (has("dependentRequired")) {
    const d = schema["dependentRequired"];
    if (!isObj(d) || Object.values(d).some((v) => !Array.isArray(v) || v.some((x) => typeof x !== "string"))) badKw(`${sp}/dependentRequired`, "must map names to arrays of strings");
  }
  for (const k of SCHEMA_MAPS) {
    if (!has(k)) continue;
    const m = schema[k];
    if (!isObj(m)) badKw(`${sp}/${k}`, "must be an object");
    for (const [name, v] of Object.entries(m)) checkShape(v, `${sp}/${k}/${esc(name)}`, root, ctx, depth + 1);
  }
  if (has("dependencies")) {
    const d = schema["dependencies"];
    if (!isObj(d)) badKw(`${sp}/dependencies`, "must be an object");
    for (const [name, v] of Object.entries(d)) if (!Array.isArray(v)) checkShape(v, `${sp}/dependencies/${esc(name)}`, root, ctx, depth + 1);
  }
  for (const k of SCHEMA_SLOTS) if (has(k)) checkShape(schema[k], `${sp}/${k}`, root, ctx, depth + 1);
  if (has("items")) {
    const it = schema["items"];
    if (Array.isArray(it)) it.forEach((v, i) => checkShape(v, `${sp}/items/${i}`, root, ctx, depth + 1));
    else checkShape(it, `${sp}/items`, root, ctx, depth + 1);
  }
  for (const k of SCHEMA_LISTS) {
    if (!has(k)) continue;
    const a = schema[k];
    if (!Array.isArray(a) || (k !== "prefixItems" && a.length === 0)) badKw(`${sp}/${k}`, "must be a non-empty array");
    (a as unknown[]).forEach((v, i) => checkShape(v, `${sp}/${k}/${i}`, root, ctx, depth + 1));
  }
}

/**
 * 検証しない語彙が使われているかを、スキーマ全体から探す。通ったスキーマの枝だけでなく、
 * 一度も評価されなかった枝(別の oneOf の側など)に書かれていても知らせるため。
 * enum / const / default / examples の中身は「データ」なので、中を見ない。
 * properties などの「名前 → スキーマ」の表は、名前ではなく値だけを見る(format という名前の
 * プロパティを、format キーワードと取り違えない)。
 */
function scanSkipped(schema: unknown, out: Set<Skipped>, depth = 0): void {
  if (depth > MAX_DEPTH || !isObj(schema)) return;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(schema, k);
  if (has("format")) out.add("format");
  if (has("unevaluatedProperties")) out.add("unevaluatedProperties");
  if (has("unevaluatedItems")) out.add("unevaluatedItems");
  if (has("$dynamicRef")) out.add("dynamicRef");
  if (has("contentMediaType") || has("contentEncoding")) out.add("contentMediaType");
  for (const k of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]) {
    const m = schema[k];
    if (isObj(m)) for (const v of Object.values(m)) scanSkipped(v, out, depth + 1);
  }
  for (const k of ["items", "additionalItems", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems"]) {
    scanSkipped(schema[k], out, depth + 1);
  }
  for (const k of ["prefixItems", "allOf", "anyOf", "oneOf", "items"]) {
    const a = schema[k];
    if (Array.isArray(a)) for (const v of a) scanSkipped(v, out, depth + 1);
  }
}

/** スキーマ自体の形も確かめながら、data を検証する。 */
export function validateAgainstSchema(schema: unknown, data: unknown): ValidateResult {
  const ctx: Ctx = { root: schema, skipped: new Set(), regex: new Map(), stack: new Set() };
  const errors: SchemaError[] = [];
  try {
    checkShape(schema, "", schema, ctx);
    scanSkipped(schema, ctx.skipped);
    const valid = check(schema, data, "", "", ctx, errors, 0);
    // 失敗したのに、エラーを1つも積めていない(上限など)は起きない。念のため。
    return { ok: true, valid, errors, skipped: [...ctx.skipped] };
  } catch (e) {
    if (e instanceof Problem) return { ok: false, problem: e.p };
    throw e;
  }
}
