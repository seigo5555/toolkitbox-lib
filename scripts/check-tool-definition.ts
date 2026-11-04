/**
 * Tool Definition Checker の検算。
 *
 * 規則は src/lib/tool-definition.ts の冒頭にある公式の資料から取ったもの。確かめるのは次の点。
 *  - 公式の例の形(Anthropic の get_stock_price、OpenAI の strict な関数、Gemini の関数宣言)が、指摘ゼロ
 *  - 名前の規則(OpenAI は64、Anthropic と Gemini は128、Gemini だけ : と . が使える)の境界の前後
 *  - 各規則が、書かれたとおりの条件で出る。出すべきでないときに出ない(誤検出が無い)
 *  - 形の見分け(Chat Completions の入れ子、Responses の1段、Anthropic、Gemini)と、貼り方4通り
 *  - input_examples が input_schema に合うか(json-schema の検査を使う)
 *  - どんな入力でも落ちない(擬似乱数で3000通り)
 *
 * 実行: npm run check
 */
import { checkToolDefinitions, EXAMPLE_TOOLS, sentenceCount, type Finding } from "../src/tool-definition";

let pass = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};
const eq = (label: string, got: unknown, want: unknown) => ok(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);

function run(v: unknown): { tools: { label: string; vendor: string }[]; findings: Finding[] } {
  const r = checkToolDefinitions(typeof v === "string" ? v : JSON.stringify(v));
  if (!r.ok) throw new Error("not ok");
  return r;
}
const codes = (v: unknown) => run(v).findings.map((f) => `${f.code}${f.tool ? "@" + f.tool : ""}`).sort();

const LONG = "Retrieves a value. It takes one argument. It returns the latest result.";
const STRICT_PARAMS = { type: "object", properties: { location: { type: "string", description: "City" }, unit: { type: ["string", "null"], description: "Unit" } }, required: ["location", "unit"], additionalProperties: false };
const anth = (over: Record<string, unknown> = {}) => ({ name: "get_stock_price", description: LONG, input_schema: { type: "object", properties: { ticker: { type: "string", description: "Symbol" } }, required: ["ticker"] }, ...over });
const oaiR = (over: Record<string, unknown> = {}) => ({ type: "function", name: "get_weather", description: LONG, parameters: STRICT_PARAMS, strict: true, ...over });
const oaiC = (fn: Record<string, unknown> = {}) => ({ type: "function", function: { name: "get_weather", description: LONG, parameters: STRICT_PARAMS, strict: true, ...fn } });
const gem = (over: Record<string, unknown> = {}) => ({ name: "get_weather", description: LONG, parameters: { type: "object", properties: { location: { type: "string", description: "City" } } }, ...over });

// 1. 公式の例の形
eq("anthropic: docs-style good description", codes({
  name: "get_stock_price",
  description: "Retrieves the current stock price for a given ticker symbol. The ticker symbol must be a valid symbol for a publicly traded company on a major US stock exchange like NYSE or NASDAQ. The tool will return the latest trade price in USD. It should be used when the user asks about the current or most recent price of a specific stock. It will not provide any other information about the stock or company.",
  input_schema: { type: "object", properties: { ticker: { type: "string", description: "The stock ticker symbol, e.g. AAPL for Apple Inc." } }, required: ["ticker"] },
}), []);
eq("anthropic: docs get_weather has only the short-description note", codes({
  name: "get_weather",
  description: "Get the current weather in a given location",
  input_schema: { type: "object", properties: { location: { type: "string", description: "The city and state, e.g. San Francisco, CA" }, unit: { type: "string", enum: ["celsius", "fahrenheit"], description: "The unit of temperature, either 'celsius' or 'fahrenheit'" } }, required: ["location"] },
}), ["shortDescription@get_weather"]);
eq("openai responses: flat strict function", codes(oaiR()), []);
eq("openai chat: nested strict function", codes(oaiC()), []);
eq("gemini: declaration", codes(gem()), []);
eq("gemini: functionDeclarations wrapper", codes({ functionDeclarations: [gem()] }), []);

// 2. 形の見分け
eq("kinds", run([anth(), oaiR({ name: "b" }), oaiC({ name: "c" }), gem({ name: "d" })]).tools.map((t) => t.vendor), ["anthropic", "openaiResponses", "openaiChat", "gemini"]);
eq("single object", run(anth()).tools.length, 1);
eq("array", run([anth(), anth({ name: "b" })]).tools.length, 2);
eq("{ tools: [...] } request body", run({ model: "m", tools: [oaiR()] }).tools.length, 1);
eq("gemini request body", run({ tools: [{ functionDeclarations: [gem(), gem({ name: "b" })] }] }).tools.map((t) => t.label), ["get_weather", "b"]);
eq("empty array", codes([]), ["noTools"]);
eq("empty tools", codes({ tools: [] }), ["noTools"]);
eq("top-level string", codes('"x"'), ["notObject"]);
eq("top-level number", codes("5"), ["notObject"]);
eq("array with a string", codes(["x"]), ["notObject@#1"]);
eq("invalid json", checkToolDefinitions("{").ok, false);
eq("unknown shape (name only)", codes({ name: "x" }), ["unknownShape@x"]);
eq("unknown shape (empty object)", codes({}), ["unknownShape@#1"]);
eq("unknown type without input_schema", codes({ type: "weird", name: "x" }), ["unknownShape@x"]);
eq("type other + input_schema is anthropic", run({ type: "custom", name: "x", description: LONG, input_schema: { type: "object", properties: {} } }).tools[0].vendor, "anthropic");
eq("anthropic-provided tool is not checked", codes({ type: "web_search_20260209", name: "web_search" }), ["notChecked@web_search"]);
eq("mcp_toolset is not checked", codes({ type: "mcp_toolset", mcp_server_name: "x" }), ["notChecked@#1"]);
eq("undated tool search alias is not checked", codes({ type: "tool_search_tool_regex", name: "x" }), ["notChecked@x"]);
eq("mixed formats", codes([anth(), oaiR()]), ["mixedFormats"]);
eq("same format is not mixed", codes([oaiR(), oaiR({ name: "b" })]), []);
eq("openai chat + responses are two vendors", codes([oaiR(), oaiC({ name: "b" })]), ["mixedFormats"]);

// 3. 名前
{
  const n = (name: unknown, mk: (name: unknown) => unknown) => codes(mk(name));
  const ar = (name: unknown) => oaiR({ name });
  eq("openai: 64 chars ok", n("a".repeat(64), ar), []);
  eq("openai: 65 chars", n("a".repeat(65), ar).filter((x) => x.startsWith("badName")).length, 1);
  eq("openai: dash and underscore ok", n("get-weather_2", ar), []);
  eq("openai: space", n("get weather", ar), ["badName@get weather"]);
  eq("openai: dot is not allowed", n("a.b", ar), ["badName@a.b"]);
  eq("openai: colon is not allowed", n("a:b", ar), ["badName@a:b"]);
  eq("openai: empty name", codes(oaiR({ name: "" })), ["noName@#1"]);
  eq("openai: missing name", codes(oaiR({ name: undefined })), ["noName@#1"]);
  eq("openai: name is a number", codes(oaiR({ name: 5 })), ["noName@#1"]);
  eq("openai: unicode name", n("天気", ar), ["badName@天気"]);
  eq("openai chat: 65 chars", codes(oaiC({ name: "a".repeat(65) })).filter((x) => x.startsWith("badName")).length, 1);
  const an = (name: unknown) => anth({ name });
  eq("anthropic: 128 chars ok (not portable to OpenAI)", n("a".repeat(128), an).map((x) => x.split("@")[0]), ["nameNotPortable"]);
  eq("anthropic: 129 chars", n("a".repeat(129), an).filter((x) => x.startsWith("badName")).length, 1);
  eq("anthropic: 65..128 is fine for anthropic but not portable", run(an("a".repeat(100))).findings.map((f) => `${f.code}:${f.params.vendors}`), ["nameNotPortable:OpenAI"]);
  eq("anthropic: dot", n("a.b", an), ["badName@a.b"]);
  const ge = (name: unknown) => gem({ name });
  eq("gemini: 128 chars ok", run(ge("a".repeat(128))).findings.filter((f) => f.code === "badName").length, 0);
  eq("gemini: 129 chars", run(ge("a".repeat(129))).findings.filter((f) => f.code === "badName").length, 1);
  eq("gemini: dot ok but not portable", run(ge("lookup.user")).findings.map((f) => `${f.code}:${f.params.vendors}`), ["nameNotPortable:OpenAI, Anthropic"]);
  eq("gemini: colon ok but not portable", run(ge("ns:tool")).findings.map((f) => `${f.code}:${f.params.vendors}`), ["nameNotPortable:OpenAI, Anthropic"]);
  eq("gemini: space", run(ge("a b")).findings.filter((f) => f.code === "badName").length, 1);
  eq("portable name has no note", codes(ge("get_weather")), []);
  eq("duplicate names", codes([anth(), anth()]), ["duplicateName@get_stock_price"]);
  eq("duplicate names reported once for three", codes([anth(), anth(), anth()]), ["duplicateName@get_stock_price"]);
  eq("different names are fine", codes([anth(), anth({ name: "b" })]), []);
  eq("duplicate across gemini declarations", codes({ functionDeclarations: [gem(), gem()] }), ["duplicateName@get_weather"]);
}

// 4. 説明
eq("sentenceCount", [sentenceCount(""), sentenceCount("One."), sentenceCount("One. Two."), sentenceCount("One. Two! Three?"), sentenceCount("v1.2 is fine. Yes"), sentenceCount("日本語です。二つ目です。三つ目です。")], [0, 1, 2, 3, 2, 3]);
eq("openai: missing description is a warning", codes(oaiR({ description: undefined })), ["noDescription@get_weather"]);
eq("openai: null description", codes(oaiR({ description: null })), ["noDescription@get_weather"]);
eq("openai: blank description", codes(oaiR({ description: "  " })), ["noDescription@get_weather"]);
eq("openai: short description note", run(oaiR({ description: "Gets weather." })).findings.map((f) => `${f.code}:${f.params.n}`), ["shortDescription:1"]);
eq("openai: three sentences ok", codes(oaiR({ description: "One. Two. Three." })), []);
eq("anthropic: missing description", codes(anth({ description: undefined })), ["noDescription@get_stock_price"]);
eq("gemini: description is required", codes(gem({ description: undefined })), ["descriptionRequired@get_weather"]);
eq("gemini: empty description is required", codes(gem({ description: "" })), ["descriptionRequired@get_weather"]);
eq("gemini: description required is an error", run(gem({ description: undefined })).findings[0].severity, "error");
eq("openai chat: description inside function", codes(oaiC({ description: undefined })), ["noDescription@get_weather"]);

// 5. パラメータ
eq("openai: parameters omitted is fine", codes(oaiR({ parameters: undefined, strict: false })), []);
eq("openai: parameters null is fine", codes(oaiR({ parameters: null, strict: false })), []);
eq("openai: parameters is a string", codes(oaiR({ parameters: "x", strict: false })), ["badParameters@get_weather"]);
eq("anthropic: input_schema is a string", codes(anth({ input_schema: "x" })), ["badParameters@get_stock_price"]);
eq("anthropic: input_schema type array", codes(anth({ input_schema: { type: "array", items: {} } })), ["schemaNotObject@get_stock_price"]);
eq("anthropic: input_schema without type or properties", codes(anth({ input_schema: {} })), ["schemaNotObject@get_stock_price"]);
eq("anthropic: input_schema with properties only", codes(anth({ input_schema: { properties: { a: { type: "string", description: "d" } } } })), []);
eq("parameter without description", run(anth({ input_schema: { type: "object", properties: { a: { type: "string" }, b: { type: "string", description: "x" }, c: {} } } })).findings.map((f) => f.params.names), ["a, c"]);
eq("parameter with blank description", run(anth({ input_schema: { type: "object", properties: { a: { type: "string", description: " " } } } })).findings.map((f) => f.params.names), ["a"]);
eq("many parameters without description are cut", run(anth({ input_schema: { type: "object", properties: Object.fromEntries(Array.from({ length: 8 }, (_, i) => ["p" + i, { type: "string" }])) } })).findings[0].params.names, "p0, p1, p2, p3, p4, p5, …");
eq("gemini: parameters and parametersJsonSchema", codes(gem({ parametersJsonSchema: { type: "object", properties: {} } })), ["bothSchemas@get_weather"]);
eq("gemini: parametersJsonSchema alone", codes(gem({ parameters: undefined, parametersJsonSchema: { type: "object", properties: { a: { type: "string", description: "d" } } } })), []);
eq("gemini: response and responseJsonSchema", codes(gem({ response: { type: "object" }, responseJsonSchema: { type: "object" } })), ["bothResponses@get_weather"]);
eq("gemini: response alone", codes(gem({ response: { type: "object" } })), []);
eq("gemini: parametersJsonSchema not an object type", codes(gem({ parameters: undefined, parametersJsonSchema: { type: "string" } })), ["schemaNotObject@get_weather"]);
eq("gemini: functionDeclarations not an array", codes({ functionDeclarations: {} }), ["declarationsNotArray@#1"]);

// 6. strict
eq("openai strict: additionalProperties missing", codes(oaiR({ parameters: { ...STRICT_PARAMS, additionalProperties: undefined } })), ["strictSchema@get_weather"]);
eq("openai strict: optional property", codes(oaiR({ parameters: { ...STRICT_PARAMS, required: ["location"] } })), ["strictSchema@get_weather"]);
eq("openai strict: unsupported keyword", codes(oaiR({ parameters: { ...STRICT_PARAMS, allOf: [{}] } })), ["strictSchema@get_weather"]);
eq("openai strict: counts problems", run(oaiR({ parameters: { type: "object", properties: { a: { type: "string", description: "d" } } } })).findings.find((f) => f.code === "strictSchema")?.params.n, "2");
eq("openai strict: first problem location", run(oaiR({ parameters: { type: "object", properties: { a: { type: "object", description: "d", properties: { b: { type: "string", description: "d" } }, required: ["b"] } }, required: ["a"], additionalProperties: false } })).findings.find((f) => f.code === "strictSchema")?.params.at, "/properties/a");
eq("openai strict: unlisted keywords are not errors", codes(oaiR({ parameters: { ...STRICT_PARAMS, properties: { location: { type: "string", description: "C", minLength: 1 }, unit: { type: ["string", "null"], description: "U" } } } })), []);
eq("openai strict: no parameters still needs additionalProperties", codes(oaiR({ parameters: undefined })), ["strictSchema@get_weather"]);
eq("openai not strict: no schema check", codes(oaiR({ strict: false, parameters: { type: "object", properties: { a: { type: "string", description: "d" } } } })), []);
eq("openai chat strict check", codes(oaiC({ parameters: { type: "object", properties: { a: { type: "string", description: "d" } } } })), ["strictSchema@get_weather"]);
eq("responses: strict unset is an info", run(oaiR({ strict: undefined })).findings.map((f) => `${f.code}:${f.params.api}`), ["strictDefaults:Responses"]);
eq("chat: strict unset is an info", run(oaiC({ strict: undefined })).findings.map((f) => `${f.code}:${f.params.api}`), ["strictDefaults:Chat Completions"]);
eq("chat: strict null is an info", codes(oaiC({ strict: null })), ["strictDefaults@get_weather"]);
eq("chat: strict false is quiet", codes(oaiC({ strict: false })), []);
eq("anthropic strict is not checked", codes(anth({ strict: true })), []);

// 7. OpenAI Chat Completions の形
eq("chat: type is not function", codes({ type: "retrieval", function: { name: "x", description: LONG } }).includes("badType@x"), false);
eq("chat: missing function object", codes({ type: "function", function: "x" }), ["noFunction@#1"]);
eq("chat: function without name", codes(oaiC({ name: undefined })), ["noName@#1"]);
eq("chat: label uses the function name", run(oaiC()).tools[0].label, "get_weather");

// 8. 数
{
  const many = (k: number, mk: (i: number) => unknown) => Array.from({ length: k }, (_, i) => mk(i));
  eq("chat: 128 tools ok", run(many(128, (i) => oaiC({ name: "t" + i }))).findings.filter((f) => f.code === "tooManyTools").length, 0);
  eq("chat: 129 tools", run(many(129, (i) => oaiC({ name: "t" + i }))).findings.filter((f) => f.code === "tooManyTools").length, 1);
  eq("tooManyTools params", run(many(129, (i) => oaiC({ name: "t" + i }))).findings.find((f) => f.code === "tooManyTools")?.params, { n: "129", max: "128" });
  eq("responses: 129 tools is not an error", run(many(129, (i) => oaiR({ name: "t" + i }))).findings.filter((f) => f.code === "tooManyTools").length, 0);
  eq("openai: 20 tools no note", run(many(20, (i) => oaiR({ name: "t" + i }))).findings.filter((f) => f.code === "manyTools").length, 0);
  eq("openai: 21 tools soft note", run(many(21, (i) => oaiR({ name: "t" + i }))).findings.filter((f) => f.code === "manyTools").length, 1);
  eq("anthropic: 200 tools no count note", run(many(200, (i) => anth({ name: "t" + i }))).findings.filter((f) => f.code === "manyTools" || f.code === "tooManyTools").length, 0);
  eq("gemini: 200 declarations no count note", run({ functionDeclarations: many(200, (i) => gem({ name: "t" + i })) }).findings.filter((f) => f.code === "manyTools" || f.code === "tooManyTools").length, 0);
}

// 9. input_examples
eq("examples: valid", codes(anth({ input_examples: [{ ticker: "AAPL" }, { ticker: "MSFT" }] })), []);
eq("examples: wrong type", codes(anth({ input_examples: [{ ticker: 5 }] })), ["exampleInvalid@get_stock_price"]);
eq("examples: missing required", codes(anth({ input_examples: [{}] })), ["exampleInvalid@get_stock_price"]);
eq("examples: position", run(anth({ input_examples: [{ ticker: "A" }, { ticker: 1 }] })).findings[0].params, { at: "2", n: "1" });
eq("examples: two bad ones", codes(anth({ input_examples: [{ ticker: 1 }, { ticker: 2 }] })).length, 2);
eq("examples: not an array", codes(anth({ input_examples: {} })), ["examplesNotArray@get_stock_price"]);
eq("examples: empty array is fine", codes(anth({ input_examples: [] })), []);
eq("examples: broken schema is skipped", codes(anth({ input_schema: { type: "object", properties: { a: { type: "nope" } } }, input_examples: [{ a: 1 }] })).filter((x) => x.startsWith("exampleInvalid")), []);
eq("examples: non-object schema is skipped", codes(anth({ input_schema: "x", input_examples: [{}] })), ["badParameters@get_stock_price"]);
eq("examples: enum", codes(anth({ input_schema: { type: "object", properties: { u: { type: "string", enum: ["c", "f"], description: "d" } } }, input_examples: [{ u: "k" }] })), ["exampleInvalid@get_stock_price"]);

// 10. 例と並び順
{
  const r = run(EXAMPLE_TOOLS);
  ok("example has findings of every severity", ["error", "warn", "info"].every((s) => r.findings.some((f) => f.severity === s)));
  eq("example has three tools", r.tools.length, 3);
  eq("example flags the bad name", r.findings.some((f) => f.code === "badName" && f.tool === "get weather"), true);
  eq("example flags the invalid example", r.findings.some((f) => f.code === "exampleInvalid"), true);
  eq("example flags strict problems", r.findings.some((f) => f.code === "strictSchema"), true);
  eq("example flags both schemas", r.findings.some((f) => f.code === "bothSchemas"), true);
  eq("example flags missing gemini description", r.findings.some((f) => f.code === "descriptionRequired"), true);
  eq("example flags mixed formats", r.findings.some((f) => f.code === "mixedFormats"), true);
  const rank = { error: 0, warn: 1, info: 2 } as const;
  eq("sorted by severity", r.findings.map((f) => f.severity), [...r.findings.map((f) => f.severity)].sort((a, b) => rank[a] - rank[b]));
}

// 11. 擬似乱数: どんな入力でも落ちない・同じ入力は同じ結果
{
  let seed = 31337;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const val = (d: number): unknown => {
    if (d > 3 || rnd() < 0.3) return pick<unknown>(["x", "", "get_weather", "a b", 0, 1, true, null, "function", "object", "string", "web_search_20260209", "mcp_toolset"]);
    if (rnd() < 0.3) return Array.from({ length: Math.floor(rnd() * 3) }, () => val(d + 1));
    const o: Record<string, unknown> = {};
    const n = Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) o[pick(["name", "description", "type", "function", "parameters", "parametersJsonSchema", "input_schema", "input_examples", "strict", "properties", "required", "additionalProperties", "functionDeclarations", "tools", "response", "responseJsonSchema"])] = val(d + 1);
    return o;
  };
  let bad = 0;
  for (let i = 0; i < 3000; i++) {
    const text = JSON.stringify(val(0)) ?? "null";
    try {
      const a = JSON.stringify(checkToolDefinitions(text));
      const b = JSON.stringify(checkToolDefinitions(text));
      if (a !== b) bad++;
    } catch {
      bad++;
    }
  }
  eq("3000 random inputs: no crash, deterministic", bad, 0);
}

if (failures.length > 0) {
  console.error(`check-tool-definition: ${failures.length} failure(s), ${pass} passed`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`check-tool-definition: ${pass} checks passed`);
