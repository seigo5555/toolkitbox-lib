/**
 * JSON Schema 検証の検算。
 *
 * スキーマ検証は、間違えても画面は静かに「合格」や「不合格」を出すだけで、
 * 気づきにくい。そこで次の3つで確かめる。
 *  1. 語彙ごとに、合格・不合格が決まっている例を名指しで(約150件)
 *  2. 別の実装 ajv(draft-07)との突き合わせ。擬似乱数で作った**スキーマとデータの
 *     組み合わせ 6000通り**の合否が、すべて一致するか。ajv は eslint の依存として
 *     node_modules にある(このツールの依存には入れない)
 *  3. スキーマ自体の誤り(未知の型、解決できない $ref、無限ループ)を、通さず報告するか
 *
 * ajv 6 が対応するのは draft-07 まで。2020-12 で増えた prefixItems / minContains /
 * maxContains / dependentRequired / dependentSchemas は突き合わせの外で、名指しの例で確かめる。
 *
 * 実行: npm run check
 */
import { createRequire } from "node:module";
import { jsonEqual, validateAgainstSchema, type SchemaIssueCode } from "../src/json-schema";

let pass = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

const eq = (label: string, got: unknown, want: unknown) => ok(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);

type Case = [label: string, schema: unknown, data: unknown, valid: boolean];
function run(cases: Case[]) {
  for (const [label, schema, data, valid] of cases) {
    const r = validateAgainstSchema(schema, data);
    ok(label, r.ok && r.valid === valid, r.ok ? `valid=${r.valid}` : `problem ${r.problem.code}`);
  }
}
const codes = (schema: unknown, data: unknown): SchemaIssueCode[] => {
  const r = validateAgainstSchema(schema, data);
  return r.ok ? r.errors.map((e) => e.code) : [];
};

// ---- 型 ----
run([
  ["type string: 合格", { type: "string" }, "a", true],
  ["type string: 数は不合格", { type: "string" }, 1, false],
  ["type integer: 1", { type: "integer" }, 1, true],
  ["type integer: 1.0 は整数(JSONでは同じ値)", { type: "integer" }, JSON.parse("1.0"), true],
  ["type integer: 1.5", { type: "integer" }, 1.5, false],
  ["type number: 整数も number", { type: "number" }, 3, true],
  ["type null", { type: "null" }, null, true],
  ["type null: 0 は null でない", { type: "null" }, 0, false],
  ["type boolean", { type: "boolean" }, false, true],
  ["type array", { type: "array" }, [], true],
  ["type array: オブジェクトは配列でない", { type: "array" }, {}, false],
  ["type object: 配列は object でない", { type: "object" }, [], false],
  ["type object: null は object でない", { type: "object" }, null, false],
  ["type の配列", { type: ["string", "null"] }, null, true],
  ["type の配列: 外れる", { type: ["string", "null"] }, 1, false],
  ["スキーマ true", true, { any: 1 }, true],
  ["スキーマ false", false, 1, false],
  ["空のスキーマは何でも通す", {}, [1, { a: 2 }], true],
]);

// ---- enum / const(JSON としての等しさ)----
run([
  ["enum: 含まれる", { enum: ["a", 1, null] }, 1, true],
  ["enum: 含まれない", { enum: ["a", 1, null] }, "b", false],
  ["enum: オブジェクトはキー順を問わない", { enum: [{ a: 1, b: 2 }] }, { b: 2, a: 1 }, true],
  ["enum: 配列は順序を問う", { enum: [[1, 2]] }, [2, 1], false],
  ["enum: 1 と true は別", { enum: [1] }, true, false],
  ["enum: 0 と false は別", { enum: [0] }, false, false],
  ["const: 一致", { const: { x: [1, 2] } }, { x: [1, 2] }, true],
  ["const: 不一致", { const: { x: [1, 2] } }, { x: [1, 3] }, false],
  ["const null", { const: null }, null, true],
]);
ok("jsonEqual: 1 と 1.0", jsonEqual(1, JSON.parse("1.0")));
ok("jsonEqual: 入れ子", jsonEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] }) && !jsonEqual({ a: [1] }, { a: [1, 2] }));

// ---- 数値 ----
run([
  ["minimum: 境界を含む", { minimum: 5 }, 5, true],
  ["minimum: 下回る", { minimum: 5 }, 4.99, false],
  ["maximum: 境界を含む", { maximum: 5 }, 5, true],
  ["maximum: 上回る", { maximum: 5 }, 5.01, false],
  ["exclusiveMinimum: 境界は不合格", { exclusiveMinimum: 5 }, 5, false],
  ["exclusiveMinimum: 超える", { exclusiveMinimum: 5 }, 5.1, true],
  ["exclusiveMaximum: 境界は不合格", { exclusiveMaximum: 5 }, 5, false],
  ["multipleOf: 割り切れる", { multipleOf: 3 }, 12, true],
  ["multipleOf: 割り切れない", { multipleOf: 3 }, 13, false],
  ["multipleOf: 0.1 の倍数(0.3 は誤差があっても通す)", { multipleOf: 0.1 }, 0.3, true],
  ["multipleOf: 0.01 の倍数 19.99", { multipleOf: 0.01 }, 19.99, true],
  ["multipleOf: 0.01 の倍数 19.995", { multipleOf: 0.01 }, 19.995, false],
  ["数値の語彙は文字列に効かない", { minimum: 5 }, "a", true],
]);

// ---- 文字列 ----
run([
  ["minLength: 足りる", { minLength: 2 }, "ab", true],
  ["minLength: 足りない", { minLength: 2 }, "a", false],
  ["maxLength: 超える", { maxLength: 2 }, "abc", false],
  ["minLength は文字数(絵文字1つ=1文字)", { minLength: 2 }, "😀", false],
  ["maxLength は文字数(絵文字2つ=2文字)", { maxLength: 2 }, "😀😀", true],
  ["maxLength: 日本語", { maxLength: 3 }, "あいう", true],
  ["pattern: 部分一致(アンカーなし)", { pattern: "b" }, "abc", true],
  ["pattern: アンカーあり", { pattern: "^b" }, "abc", false],
  ["pattern: 文字クラス", { pattern: "^[a-c]+$" }, "abca", true],
  ["pattern は文字列以外に効かない", { pattern: "^x$" }, 5, true],
]);

// ---- 配列 ----
run([
  ["items: 全要素が合う", { items: { type: "integer" } }, [1, 2, 3], true],
  ["items: 1つ外れる", { items: { type: "integer" } }, [1, "x", 3], false],
  ["items: false は空配列だけ", { items: false }, [], true],
  ["items: false に要素", { items: false }, [1], false],
  ["tuple(items の配列形): 合う", { items: [{ type: "string" }, { type: "integer" }] }, ["a", 1], true],
  ["tuple: 外れる", { items: [{ type: "string" }, { type: "integer" }] }, ["a", "b"], false],
  ["tuple: 余りは自由", { items: [{ type: "string" }] }, ["a", 1, null], true],
  ["tuple + additionalItems: false", { items: [{ type: "string" }], additionalItems: false }, ["a", 1], false],
  ["prefixItems: 合う", { prefixItems: [{ type: "string" }, { type: "integer" }] }, ["a", 1], true],
  ["prefixItems: 外れる", { prefixItems: [{ type: "string" }, { type: "integer" }] }, [1, 1], false],
  ["prefixItems + items(残り)", { prefixItems: [{ type: "string" }], items: { type: "integer" } }, ["a", 1, 2], true],
  ["prefixItems + items: 残りが外れる", { prefixItems: [{ type: "string" }], items: { type: "integer" } }, ["a", 1, "x"], false],
  ["prefixItems + items: false", { prefixItems: [{ type: "string" }], items: false }, ["a", 1], false],
  ["minItems", { minItems: 2 }, [1], false],
  ["maxItems", { maxItems: 1 }, [1, 2], false],
  ["uniqueItems: 重複なし", { uniqueItems: true }, [1, "1", true], true],
  ["uniqueItems: 重複", { uniqueItems: true }, [1, 2, 1], false],
  ["uniqueItems: オブジェクトの重複(キー順を問わない)", { uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }], false],
  ["contains: ある", { contains: { type: "string" } }, [1, "a"], true],
  ["contains: ない", { contains: { type: "string" } }, [1, 2], false],
  ["contains: 空配列は不合格", { contains: true }, [], false],
  ["minContains: 足りる", { contains: { const: 1 }, minContains: 2 }, [1, 1, 2], true],
  ["minContains: 足りない", { contains: { const: 1 }, minContains: 2 }, [1, 2], false],
  ["minContains: 0 なら contains が無くても通る", { contains: { const: 1 }, minContains: 0 }, [2], true],
  ["maxContains: 超える", { contains: { const: 1 }, maxContains: 1 }, [1, 1], false],
]);

// ---- オブジェクト ----
run([
  ["required: ある", { required: ["a"] }, { a: 1 }, true],
  ["required: ない", { required: ["a"] }, { b: 1 }, false],
  ["required: 値が null でもある扱い", { required: ["a"] }, { a: null }, true],
  ["required は object 以外に効かない", { required: ["a"] }, [], true],
  ["properties: 合う", { properties: { a: { type: "integer" } } }, { a: 1 }, true],
  ["properties: 外れる", { properties: { a: { type: "integer" } } }, { a: "x" }, false],
  ["properties: 無いキーは検証しない(required ではない)", { properties: { a: { type: "integer" } } }, {}, true],
  ["additionalProperties: false", { properties: { a: true }, additionalProperties: false }, { a: 1, b: 2 }, false],
  ["additionalProperties: false で余りなし", { properties: { a: true }, additionalProperties: false }, { a: 1 }, true],
  ["additionalProperties: スキーマ", { additionalProperties: { type: "integer" } }, { x: 1, y: "z" }, false],
  ["additionalProperties は patternProperties に合うキーを除く", { patternProperties: { "^x": true }, additionalProperties: false }, { xa: 1 }, true],
  ["patternProperties: 外れる", { patternProperties: { "^n_": { type: "integer" } } }, { n_a: "x" }, false],
  ["minProperties", { minProperties: 2 }, { a: 1 }, false],
  ["maxProperties", { maxProperties: 1 }, { a: 1, b: 2 }, false],
  ["propertyNames: 合う", { propertyNames: { pattern: "^[a-z]+$" } }, { abc: 1 }, true],
  ["propertyNames: 外れる", { propertyNames: { pattern: "^[a-z]+$" } }, { ABC: 1 }, false],
  ["dependentRequired: 条件が無ければ通る", { dependentRequired: { a: ["b"] } }, { c: 1 }, true],
  ["dependentRequired: 条件があって不足", { dependentRequired: { a: ["b"] } }, { a: 1 }, false],
  ["dependentRequired: 満たす", { dependentRequired: { a: ["b"] } }, { a: 1, b: 2 }, true],
  ["dependentSchemas: 条件があって外れる", { dependentSchemas: { a: { required: ["b"] } } }, { a: 1 }, false],
  ["dependencies(draft-07): 配列", { dependencies: { a: ["b"] } }, { a: 1 }, false],
  ["dependencies(draft-07): スキーマ", { dependencies: { a: { required: ["b"] } } }, { a: 1, b: 1 }, true],
  ["__proto__ という名前のキー", { required: ["__proto__"] }, JSON.parse('{"__proto__": 1}'), true],
]);

// ---- 合成 ----
run([
  ["allOf: すべて合う", { allOf: [{ type: "integer" }, { minimum: 3 }] }, 5, true],
  ["allOf: 1つ外れる", { allOf: [{ type: "integer" }, { minimum: 3 }] }, 2, false],
  ["anyOf: どれか", { anyOf: [{ type: "string" }, { type: "integer" }] }, 3, true],
  ["anyOf: どれも外れる", { anyOf: [{ type: "string" }, { type: "integer" }] }, null, false],
  ["oneOf: ちょうど1つ", { oneOf: [{ type: "string" }, { type: "integer" }] }, 3, true],
  ["oneOf: 2つ合うと不合格", { oneOf: [{ type: "number" }, { type: "integer" }] }, 3, false],
  ["oneOf: どれも合わない", { oneOf: [{ type: "string" }, { type: "integer" }] }, null, false],
  ["not: 外れれば合格", { not: { type: "string" } }, 1, true],
  ["not: 合うと不合格", { not: { type: "string" } }, "a", false],
  ["if/then: 条件に合い then を満たす", { if: { properties: { k: { const: 1 } } }, then: { required: ["v"] } }, { k: 1, v: 1 }, true],
  ["if/then: 条件に合い then を満たさない", { if: { properties: { k: { const: 1 } } }, then: { required: ["v"] } }, { k: 1 }, false],
  ["if/else: 条件に合わず else を満たさない", { if: { properties: { k: { const: 1 } } }, else: { required: ["w"] } }, { k: 2 }, false],
  ["if のみは何も起きない", { if: false }, 1, true],
  ["then / else だけ(if なし)は無視", { then: false, else: false }, 1, true],
]);

// ---- $ref ----
run([
  ["$ref: $defs", { $defs: { n: { type: "integer" } }, properties: { a: { $ref: "#/$defs/n" } } }, { a: 1 }, true],
  ["$ref: $defs で外れる", { $defs: { n: { type: "integer" } }, properties: { a: { $ref: "#/$defs/n" } } }, { a: "x" }, false],
  ["$ref: definitions(旧い名前)", { definitions: { n: { type: "integer" } }, items: { $ref: "#/definitions/n" } }, [1, "x"], false],
  ["$ref: ルート自身(再帰)", { type: "object", properties: { next: { $ref: "#" } } }, { next: { next: {} } }, true],
  ["$ref: 再帰の深いところで外れる", { type: "object", properties: { v: { type: "integer" }, next: { $ref: "#" } } }, { v: 1, next: { v: "x" } }, false],
  ["$ref の同階層のキーも効く(2019-09 以降)", { $defs: { a: { type: "integer" } }, $ref: "#/$defs/a", minimum: 5 }, 3, false],
  ["$ref: ポインタのエスケープ(~1)", { $defs: { "a/b": { type: "string" } }, $ref: "#/$defs/a~1b" }, "x", true],
]);

// ---- 誤差の報告 ----
{
  const e = validateAgainstSchema({ properties: { a: { type: "integer" } }, required: ["b"] }, { a: "x" });
  ok("エラーに位置とキーワード", e.ok && e.errors.some((x) => x.path === "/a" && x.code === "type") && e.errors.some((x) => x.path === "" && x.code === "required" && x.params.property === "b"));
  const e2 = validateAgainstSchema({ items: { properties: { n: { minimum: 1 } } } }, [{ n: 1 }, { n: 0 }]);
  ok("入れ子のパス /1/n", e2.ok && e2.errors[0]?.path === "/1/n" && e2.errors[0]?.schemaPath === "/items/properties/n/minimum", e2.ok ? JSON.stringify(e2.errors) : "");
  const e3 = validateAgainstSchema({ properties: { "a/b": { type: "string" } } }, { "a/b": 1 });
  ok("キーに / を含むパスは ~1", e3.ok && e3.errors[0]?.path === "/a~1b", e3.ok ? e3.errors[0]?.path : "");
  eq("oneOf が複数に合う", codes({ oneOf: [{ type: "number" }, { type: "integer" }] }, 3), ["oneOfMultiple"]);
  eq("additionalProperties の報告", codes({ additionalProperties: false }, { z: 1 }), ["additionalProperties"]);
  eq("false スキーマの報告", codes({ properties: { a: false } }, { a: 1 }), ["falseSchema"]);
}

// ---- 検証しないものは、黙らず知らせる ----
{
  const r = validateAgainstSchema({ properties: { e: { type: "string", format: "email" } } }, { e: "not-an-email" });
  ok("format は検証せず、知らせる", r.ok && r.valid && r.skipped.includes("format"));
  const r2 = validateAgainstSchema({ properties: { format: { type: "string" } } }, { format: "x" });
  ok("format という名前のプロパティは format の語彙ではない", r2.ok && r2.skipped.length === 0);
  const r3 = validateAgainstSchema({ oneOf: [{ type: "string" }, { type: "object", unevaluatedProperties: false }] }, "x");
  ok("通らなかった枝の unevaluatedProperties も知らせる", r3.ok && r3.skipped.includes("unevaluatedProperties"));
  const r4 = validateAgainstSchema({ const: { format: "x" } }, { format: "x" });
  ok("const の中身(データ)は語彙と見なさない", r4.ok && r4.skipped.length === 0);
}

// ---- スキーマ自体の誤り ----
{
  const bad: [string, unknown, string][] = [
    ["スキーマが数", 5, "notSchema"],
    ["未知の型", { type: "str" }, "unknownType"],
    ["required が文字列", { required: "a" }, "badKeyword"],
    ["enum が配列でない", { enum: 1 }, "badKeyword"],
    ["不正な正規表現", { pattern: "(" }, "badPattern"],
    ["解決できない $ref", { $ref: "#/$defs/nope" }, "unresolvedRef"],
    ["外部の $ref", { $ref: "https://example.com/s.json" }, "externalRef"],
    ["$ref が自分自身を指して進まない", { $ref: "#" }, "refLoop"],
    ["$ref の循環", { $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" }, "refLoop"],
    ["multipleOf が 0", { multipleOf: 0 }, "badKeyword"],
  ];
  for (const [label, schema, code] of bad) {
    const r = validateAgainstSchema(schema, { x: 1 });
    ok(`スキーマの誤り: ${label}`, !r.ok && r.problem.code === code, r.ok ? "通ってしまった" : r.problem.code);
  }
  // 深い入れ子のデータでも落ちない
  let deep: unknown = 1;
  for (let i = 0; i < 150; i++) deep = { next: deep };
  const r = validateAgainstSchema({ $defs: { n: { type: "object", properties: { next: { $ref: "#/$defs/n" } } } }, $ref: "#/$defs/n" }, deep);
  ok("深い再帰でも落ちない", r.ok || r.problem.code === "tooDeep");
}

// ---- ajv(別実装)との突き合わせ ----
const require = createRequire(import.meta.url);
let Ajv: new (o: object) => { compile: (s: unknown) => (d: unknown) => boolean };
try {
  Ajv = require("ajv");
} catch {
  Ajv = null as never;
}
if (Ajv) {
  let seed = 20261024;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const chance = (p: number) => rnd() < p;

  const KEYS = ["a", "b", "c", "id", "x_1"];
  const STRS = ["", "a", "ab", "abc", "b", "xyz", "😀", "😀😀", "あい", "x_1", "abca"];
  // "." は使わない: 当方は Unicode モード(絵文字=1文字)、ajv 6 は UTF-16 の単位で数えるため結果が分かれる(どちらも仕様の範囲)。
  const PATS = ["^a", "b$", "^[a-c]+$", "x", "^[ab]{2}$"];
  const TYPES = ["null", "boolean", "object", "array", "number", "string", "integer"];

  const scalar = (): unknown => pick<() => unknown>([() => null, () => true, () => false, () => Math.floor(rnd() * 12) - 2, () => pick([0.5, 1.5, 2.5, 3, 4.25]), () => pick(STRS)])();
  const genData = (d: number): unknown => {
    const r = rnd();
    if (d <= 0 || r < 0.4) return scalar();
    if (r < 0.7) return Array.from({ length: Math.floor(rnd() * 4) }, () => genData(d - 1));
    const o: Record<string, unknown> = {};
    for (let n = Math.floor(rnd() * 4); n > 0; n--) o[pick(KEYS)] = genData(d - 1);
    return o;
  };

  const genSchema = (d: number, defs: boolean): unknown => {
    if (chance(0.04)) return chance(0.5);
    if (defs && chance(0.08)) return { $ref: "#/definitions/d" }; // $ref には兄弟のキーを付けない(draft-07 は無視するため)
    const s: Record<string, unknown> = {};
    const sub = () => (d <= 0 ? pick([true, {}, { type: pick(TYPES) }]) : genSchema(d - 1, defs));
    if (chance(0.35)) s.type = chance(0.75) ? pick(TYPES) : [pick(TYPES), pick(TYPES)];
    if (chance(0.1)) s.enum = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => genData(1));
    if (chance(0.06)) s.const = genData(1);
    if (chance(0.15)) s.minimum = Math.floor(rnd() * 8) - 1;
    if (chance(0.15)) s.maximum = Math.floor(rnd() * 8) + 1;
    if (chance(0.08)) s.exclusiveMinimum = Math.floor(rnd() * 6);
    if (chance(0.08)) s.exclusiveMaximum = Math.floor(rnd() * 8) + 1;
    if (chance(0.08)) s.multipleOf = pick([1, 2, 3, 5]);
    if (chance(0.12)) s.minLength = Math.floor(rnd() * 4);
    if (chance(0.12)) s.maxLength = Math.floor(rnd() * 4);
    if (chance(0.1)) s.pattern = pick(PATS);
    if (chance(0.2)) s.items = chance(0.7) ? sub() : Array.from({ length: 1 + Math.floor(rnd() * 2) }, sub);
    if (Array.isArray(s.items) && chance(0.5)) s.additionalItems = sub();
    if (chance(0.1)) s.minItems = Math.floor(rnd() * 3);
    if (chance(0.1)) s.maxItems = Math.floor(rnd() * 4);
    if (chance(0.08)) s.uniqueItems = chance(0.8);
    if (chance(0.08)) s.contains = sub();
    if (chance(0.3)) {
      const props: Record<string, unknown> = {};
      for (let n = 1 + Math.floor(rnd() * 3); n > 0; n--) props[pick(KEYS)] = sub();
      s.properties = props;
    }
    if (chance(0.2)) s.required = Array.from({ length: Math.floor(rnd() * 3) }, () => pick(KEYS));
    if (chance(0.15)) s.additionalProperties = chance(0.5) ? chance(0.5) : sub();
    if (chance(0.06)) s.patternProperties = { [pick(["^a", "^x", "b"])]: sub() };
    if (chance(0.06)) s.minProperties = Math.floor(rnd() * 3);
    if (chance(0.06)) s.maxProperties = Math.floor(rnd() * 4);
    if (chance(0.06)) s.propertyNames = pick<unknown>([{ pattern: "^[a-c]$" }, { maxLength: 2 }, true, false]);
    if (chance(0.05)) s.dependencies = { [pick(KEYS)]: chance(0.5) ? [pick(KEYS)] : sub() };
    if (chance(0.1)) s.allOf = Array.from({ length: 1 + Math.floor(rnd() * 2) }, sub);
    if (chance(0.1)) s.anyOf = Array.from({ length: 1 + Math.floor(rnd() * 3) }, sub);
    if (chance(0.1)) s.oneOf = Array.from({ length: 1 + Math.floor(rnd() * 3) }, sub);
    if (chance(0.06)) s.not = sub();
    if (chance(0.07)) {
      s.if = sub();
      if (chance(0.7)) s.then = sub();
      if (chance(0.5)) s.else = sub();
    }
    return s;
  };

  const ajv = new Ajv({ allErrors: false, schemaId: "auto" });
  let compared = 0;
  let mismatch = 0;
  let skippedSchemas = 0;
  for (let i = 0; i < 1500; i++) {
    const withDefs = chance(0.3);
    const body = genSchema(2, withDefs);
    const schema: unknown = withDefs && body !== true && body !== false ? { definitions: { d: genSchema(1, false) }, ...(body as object) } : body;
    // 本当に定義がある場合だけ $ref を許す(上で defs=true のときだけ作られる)
    let validateAjv: (d: unknown) => boolean;
    try {
      validateAjv = ajv.compile(schema);
    } catch {
      skippedSchemas++; // ajv が受け付けないスキーマ(例: 空の enum など)は比べない
      continue;
    }
    for (let k = 0; k < 4; k++) {
      const data = genData(3);
      const mine = validateAgainstSchema(schema, data);
      if (!mine.ok) {
        mismatch++;
        if (mismatch <= 5) failures.push(`ajv突き合わせ: 当方がスキーマを拒否 ${mine.problem.code} ${JSON.stringify(schema).slice(0, 150)}`);
        continue;
      }
      compared++;
      if (mine.valid !== validateAjv(data)) {
        mismatch++;
        if (mismatch <= 5) failures.push(`ajv突き合わせ: 合否が違う 当方=${mine.valid} ajv=${!mine.valid} schema=${JSON.stringify(schema).slice(0, 200)} data=${JSON.stringify(data).slice(0, 100)}`);
      }
    }
  }
  ok(`ajv(別実装)との突き合わせ: ${compared}通り中、合否が違うもの ${mismatch}(ajvが受け付けないスキーマ ${skippedSchemas}件は除く)`, mismatch === 0 && compared > 4000, `compared=${compared}`);
} else {
  failures.push("ajv が node_modules に無い。突き合わせができない");
}

console.log(`\n[check:json-schema] ${pass} 件成功 / ${failures.length} 件失敗`);
if (failures.length) {
  for (const f of failures) console.error("  NG " + f);
  process.exit(1);
}
