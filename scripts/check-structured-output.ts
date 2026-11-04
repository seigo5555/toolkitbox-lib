/**
 * Structured Output Schema Checker の検算。
 *
 * 規則は src/lib/structured-output.ts の冒頭にある各社の公式ドキュメントから取ったもの。
 * ここで確かめるのは次の点。
 *  - 公式の例にある形(additionalProperties:false と全プロパティの required)は、OpenAI/Anthropic で指摘ゼロ
 *  - 各規則が、書かれたとおりの位置で1件だけ出る(過剰に出さない)
 *  - 規則に当たらないスキーマで、何も出ない(誤検出が無い)
 *  - プロパティ名が検査語と同じ(pattern、format など)でも、キーワードと取り違えない
 *  - 循環参照は Anthropic だけ。使われていない $defs の循環は指摘しない
 *
 * 実行: npm run check
 */
import { checkStructuredOutput, EXAMPLE_SCHEMA, unsupportedPatternFeatures, type Finding, type Vendor } from "../src/structured-output";

let pass = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};
const eq = (label: string, got: unknown, want: unknown) => ok(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);

function run(schema: unknown): Finding[] {
  const r = checkStructuredOutput(schema);
  if (!r.ok) throw new Error("not ok: " + r.reason);
  return r.findings;
}
const brief = (f: Finding[], v: Vendor) => f.filter((x) => x.vendor === v).map((x) => `${x.code}@${x.at}${x.params.keyword ? `:${x.params.keyword}` : ""}`).sort();

// 1. 公式の例の形: 全プロパティが required、additionalProperties:false
const strict = {
  type: "object",
  properties: { name: { type: "string" }, age: { type: ["integer", "null"] }, kind: { enum: ["a", "b"] } },
  required: ["name", "age", "kind"],
  additionalProperties: false,
};
{
  const f = run(strict);
  eq("strict: openai none", brief(f, "openai"), []);
  eq("strict: anthropic none", brief(f, "anthropic"), []);
  eq("strict: gemini none", brief(f, "gemini"), []);
}

// 2. OpenAI の規則
{
  const f = run({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"] });
  eq("openai: missing required + additionalProperties", brief(f, "openai"), ["needAdditionalFalse@", "needAllRequired@"]);
  eq("openai: names param", f.find((x) => x.code === "needAllRequired")?.params.names, "b");
  eq("anthropic: only additionalProperties", brief(f, "anthropic"), ["needAdditionalFalse@"]);
}
{
  eq("openai: additionalProperties true", brief(run({ type: "object", properties: {}, additionalProperties: true }), "openai"), ["needAdditionalFalse@"]);
  eq("openai: root is array", brief(run({ type: "array", items: { type: "string" } }), "openai"), ["rootNotObject@"]);
  eq("openai: root anyOf", brief(run({ anyOf: [{ type: "object", properties: {}, additionalProperties: false }, { type: "null" }] }), "openai").filter((x) => x.startsWith("root")), ["rootAnyOf@", "rootNotObject@"].sort());
  const f = run({ ...strict, allOf: [{}], not: {}, if: {}, then: {}, else: {}, dependentRequired: {}, dependentSchemas: {} });
  eq("openai: unsupported keywords", brief(f, "openai"), ["unsupported@/allOf:allOf", "unsupported@/dependentRequired:dependentRequired", "unsupported@/dependentSchemas:dependentSchemas", "unsupported@/else:else", "unsupported@/if:if", "unsupported@/not:not", "unsupported@/then:then"]);
  eq("openai: unlisted + format", brief(run({ ...strict, properties: { name: { type: "string", minLength: 1, format: "uri" } } }), "openai"), ["formatUnlisted@/properties/name/format", "unlisted@/properties/name/minLength:minLength"]);
  eq("openai: supported keywords are clean", brief(run({ ...strict, properties: { name: { type: "string", pattern: "^a", format: "email" }, n: { type: "number", minimum: 0, exclusiveMaximum: 9, multipleOf: 2 }, l: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 } }, required: ["name", "n", "l"] }), "openai"), []);
}

// 3. OpenAI の上限
{
  const props: Record<string, unknown> = {};
  for (let i = 0; i < 5001; i++) props["p" + i] = { type: "string" };
  const f = run({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });
  eq("openai: 5001 properties", brief(f, "openai").filter((x) => x.startsWith("limit")), ["limitProps@"]);
  const f2 = run({ type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false, $defs: {} });
  eq("openai: 5000 ok", brief(f2, "openai"), []);
  const props2: Record<string, unknown> = {};
  for (let i = 0; i < 5000; i++) props2["p" + i] = { type: "string" };
  eq("openai: exactly 5000 ok", brief(run({ type: "object", properties: props2, required: Object.keys(props2), additionalProperties: false }), "openai").filter((x) => x.startsWith("limitProps")), []);
  const vals = Array.from({ length: 1001 }, (_, i) => "v" + i);
  eq("openai: 1001 enum values", brief(run({ type: "object", properties: { e: { enum: vals } }, required: ["e"], additionalProperties: false }), "openai"), ["limitEnum@"]);
  eq("openai: 1000 enum values ok", brief(run({ type: "object", properties: { e: { enum: vals.slice(0, 1000) } }, required: ["e"], additionalProperties: false }), "openai"), []);
  eq("openai: long names", brief(run({ type: "object", properties: { ["x".repeat(120001)]: { type: "string" } }, required: ["x".repeat(120001)], additionalProperties: false }), "openai"), ["limitChars@"]);
}

// 4. Anthropic の規則
{
  const f = run({ ...strict, properties: { n: { type: "integer", minimum: 0, maximum: 9, multipleOf: 1 }, s: { type: "string", minLength: 1, maxLength: 2 }, a: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 3 } }, required: ["n", "s", "a"] });
  eq("anthropic: unsupported + minItems", brief(f, "anthropic"), [
    "minItemsLimit@/properties/a/minItems",
    "unsupported@/properties/a/maxItems:maxItems",
    "unsupported@/properties/n/maximum:maximum",
    "unsupported@/properties/n/minimum:minimum",
    "unsupported@/properties/n/multipleOf:multipleOf",
    "unsupported@/properties/s/maxLength:maxLength",
    "unsupported@/properties/s/minLength:minLength",
  ]);
  eq("anthropic: minItems 0 and 1 ok", brief(run({ ...strict, properties: { a: { type: "array", items: { type: "string" }, minItems: 1 }, b: { type: "array", items: { type: "string" }, minItems: 0 } }, required: ["a", "b"] }), "anthropic"), []);
  eq("anthropic: formats", brief(run({ ...strict, properties: { u: { type: "string", format: "uri" }, p: { type: "string", format: "regex" } }, required: ["u", "p"] }), "anthropic"), ["formatUnlisted@/properties/p/format"]);
  eq("anthropic: complex enum", brief(run({ ...strict, properties: { e: { enum: [{ a: 1 }] } }, required: ["e"] }), "anthropic"), ["enumComplex@/properties/e/enum"]);
  eq("anthropic: enum primitives ok", brief(run({ ...strict, properties: { e: { enum: ["a", 1, true, null] } }, required: ["e"] }), "anthropic"), []);
  eq("anthropic: allOf with $ref", brief(run({ ...strict, $defs: { d: { type: "string" } }, properties: { x: { allOf: [{ $ref: "#/$defs/d" }] } }, required: ["x"] }), "anthropic"), ["allOfRef@/properties/x/allOf"]);
  eq("anthropic: allOf without $ref ok", brief(run({ ...strict, properties: { x: { allOf: [{ type: "string" }] } }, required: ["x"] }), "anthropic"), []);
  eq("anthropic: external ref", brief(run({ ...strict, properties: { x: { $ref: "https://example.com/s.json" } }, required: ["x"] }), "anthropic"), ["externalRef@/properties/x/$ref"]);
  eq("anthropic: local ref ok", brief(run({ ...strict, $defs: { d: { type: "string" } }, properties: { x: { $ref: "#/$defs/d" } }, required: ["x"] }), "anthropic"), []);
  eq("anthropic: unlisted", brief(run({ ...strict, properties: { x: { oneOf: [{ type: "string" }] }, y: { type: "array", items: { type: "string" }, uniqueItems: true } }, required: ["x", "y"] }), "anthropic"), ["unlisted@/properties/x/oneOf:oneOf", "unlisted@/properties/y/uniqueItems:uniqueItems"]);
}

// 5. パターンの構文
{
  eq("pattern: plain", unsupportedPatternFeatures("^[a-z]+\\d{2,3}$"), []);
  eq("pattern: backreference", unsupportedPatternFeatures("(a)\\1"), ["\\1  \\k<name>"]);
  eq("pattern: named backreference", unsupportedPatternFeatures("(?<x>a)\\k<x>"), ["\\1  \\k<name>"]);
  eq("pattern: lookahead", unsupportedPatternFeatures("a(?=b)"), ["(?=  (?!"]);
  eq("pattern: neg lookahead", unsupportedPatternFeatures("a(?!b)"), ["(?=  (?!"]);
  eq("pattern: lookbehind", unsupportedPatternFeatures("(?<=a)b"), ["(?<=  (?<!"]);
  eq("pattern: word boundary", unsupportedPatternFeatures("\\bfoo\\b"), ["\\b  \\B"]);
  eq("pattern: inside class is not syntax", unsupportedPatternFeatures("[\\b(?=]+"), []);
  eq("pattern: escaped backslash then b", unsupportedPatternFeatures("\\\\b"), []);
  eq("pattern: named group alone ok", unsupportedPatternFeatures("(?<x>a)"), []);
  eq("pattern: non-capturing ok", unsupportedPatternFeatures("(?:ab)+"), []);
  eq("anthropic: pattern finding", brief(run({ ...strict, properties: { x: { type: "string", pattern: "\\bx" } }, required: ["x"] }), "anthropic"), ["patternFeature@/properties/x/pattern"]);
}

// 6. 再帰
{
  const tree = { type: "object", properties: { v: { type: "string" }, kids: { type: "array", items: { $ref: "#" } } }, required: ["v", "kids"], additionalProperties: false };
  eq("recursion root: anthropic", brief(run(tree), "anthropic"), ["recursive@/properties/kids/items/$ref"]);
  eq("recursion root: openai ok", brief(run(tree), "openai"), []);
  const viaDefs = { type: "object", properties: { n: { $ref: "#/$defs/node" } }, required: ["n"], additionalProperties: false, $defs: { node: { type: "object", properties: { next: { anyOf: [{ $ref: "#/$defs/node" }, { type: "null" }] } }, required: ["next"], additionalProperties: false } } };
  eq("recursion defs: anthropic", brief(run(viaDefs), "anthropic").filter((x) => x.startsWith("recursive")).length, 1);
  const unused = { ...strict, $defs: { loop: { type: "object", properties: { x: { $ref: "#/$defs/loop" } }, required: ["x"], additionalProperties: false } } };
  eq("recursion: unused def is fine", brief(run(unused), "anthropic"), []);
  const mutual = { type: "object", properties: { a: { $ref: "#/$defs/A" } }, required: ["a"], additionalProperties: false, $defs: { A: { type: "object", properties: { b: { $ref: "#/$defs/B" } }, required: ["b"], additionalProperties: false }, B: { type: "object", properties: { a: { $ref: "#/$defs/A" } }, required: ["a"], additionalProperties: false } } };
  eq("recursion: mutual", brief(run(mutual), "anthropic").filter((x) => x.startsWith("recursive")).length, 1);
  const shared = { type: "object", properties: { a: { $ref: "#/$defs/s" }, b: { $ref: "#/$defs/s" } }, required: ["a", "b"], additionalProperties: false, $defs: { s: { type: "string" } } };
  eq("recursion: shared def is not a cycle", brief(run(shared), "anthropic"), []);
  eq("dangling ref does not crash", Array.isArray(run({ ...strict, properties: { x: { $ref: "#/$defs/nope" } }, required: ["x"] })), true);
}

// 7. Gemini
{
  const f = run({ type: "object", properties: { s: { type: "string", minLength: 1, maxLength: 3, pattern: "^a", format: "date" }, a: { type: "array", items: { type: "string" }, uniqueItems: true, minItems: 1, maxItems: 2 }, n: { type: "number", minimum: 0, multipleOf: 2 } }, required: ["s", "a", "n"], minProperties: 1, additionalProperties: false });
  eq("gemini", brief(f, "gemini"), [
    "ignored@/minProperties:minProperties",
    "ignored@/properties/a/uniqueItems:uniqueItems",
    "ignored@/properties/s/maxLength:maxLength",
    "ignored@/properties/s/minLength:minLength",
    "unlisted@/properties/n/multipleOf:multipleOf",
    "unlisted@/properties/s/pattern:pattern",
  ]);
  ok("gemini severities", f.filter((x) => x.vendor === "gemini").every((x) => (x.code === "ignored" ? x.severity === "ignored" : x.severity === "unlisted")));
}

// 8. プロパティ名が検査語と同じでも、キーワードと取り違えない
{
  const named = { type: "object", properties: { pattern: { type: "string" }, minimum: { type: "number" }, allOf: { type: "string" }, format: { type: "string" }, not: { type: "string" } }, required: ["pattern", "minimum", "allOf", "format", "not"], additionalProperties: false };
  const f = run(named);
  eq("property names are not keywords", [brief(f, "openai"), brief(f, "anthropic"), brief(f, "gemini")], [[], [], []]);
  const defs = { ...strict, $defs: { minLength: { type: "string" } }, properties: { x: { $ref: "#/$defs/minLength" } }, required: ["x"] };
  const g = run(defs);
  eq("$defs names are not keywords", [brief(g, "openai"), brief(g, "anthropic"), brief(g, "gemini")], [[], [], []]);
}

// 9. 入れ子の位置も調べる(items / anyOf / $defs の中)
{
  const deep = { type: "object", properties: { l: { type: "array", items: { type: "object", properties: { v: { anyOf: [{ type: "object", properties: { z: { type: "string" } }, required: [] }, { type: "null" }] } }, required: ["v"], additionalProperties: false } } }, required: ["l"], additionalProperties: false };
  eq("nested objects checked", brief(run(deep), "openai"), ["needAdditionalFalse@/properties/l/items/properties/v/anyOf/0", "needAllRequired@/properties/l/items/properties/v/anyOf/0"]);
}

// 10. 入力が不正
{
  eq("not an object", checkStructuredOutput([1]).ok, false);
  eq("null", checkStructuredOutput(null).ok, false);
  eq("string", checkStructuredOutput("x").ok, false);
  eq("true schema", checkStructuredOutput(true).ok, false);
  let deep: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 300; i++) deep = { type: "array", items: deep };
  const r = checkStructuredOutput(deep);
  eq("too deep", r.ok ? "ok" : r.reason, "tooDeep");
  eq("empty object", Array.isArray(run({})), true);
  eq("example schema produces findings", run(JSON.parse(EXAMPLE_SCHEMA)).length > 5, true);
}

// 11. 擬似乱数: どんな入力でも落ちない・同じ入力は同じ結果
{
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const KW = ["type", "properties", "required", "items", "anyOf", "oneOf", "allOf", "$ref", "$defs", "enum", "pattern", "format", "minimum", "minItems", "additionalProperties", "not", "const"];
  const gen = (d: number): unknown => {
    if (d > 4 || rnd() < 0.2) return [{}, { type: "string" }, { $ref: "#" }, { $ref: "#/$defs/a" }, "x", 5, null, true][Math.floor(rnd() * 8)];
    const o: Record<string, unknown> = {};
    const n = Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const k = KW[Math.floor(rnd() * KW.length)];
      if (k === "properties" || k === "$defs") o[k] = { a: gen(d + 1), b: gen(d + 1) };
      else if (k === "anyOf" || k === "oneOf" || k === "allOf") o[k] = [gen(d + 1), gen(d + 1)];
      else if (k === "required" || k === "enum") o[k] = ["a", rnd() < 0.5 ? { x: 1 } : 2];
      else if (k === "type") o[k] = rnd() < 0.5 ? "object" : ["string", "null"];
      else o[k] = gen(d + 1);
    }
    return o;
  };
  let crashed = 0;
  for (let i = 0; i < 3000; i++) {
    const s = gen(0);
    try {
      const a = JSON.stringify(checkStructuredOutput(s));
      const b = JSON.stringify(checkStructuredOutput(s));
      if (a !== b) crashed++;
    } catch {
      crashed++;
    }
  }
  eq("3000 random schemas: no crash, deterministic", crashed, 0);
}

if (failures.length > 0) {
  console.error(`check-structured-output: ${failures.length} failure(s), ${pass} passed`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`check-structured-output: ${pass} checks passed`);
