/**
 * AI API に渡す「ツール(関数)の定義」が、各社の公式の資料に書かれた形・規則に合うかを調べる。
 * LLM は呼ばない。ブラウザの中だけで完結する。
 *
 * **ここに書く規則は、公式の資料に書かれていることだけ。** 確認元と日付は `SOURCES` と `VERIFIED_ON`。
 * 規則を足し引きするときは、公式の文面を確かめて `VERIFIED_ON` を更新する。
 *  - OpenAI: 公式の OpenAPI 仕様(github.com/openai/openai-openapi)。Chat Completions は
 *    {type:"function", function:{name, description, parameters, strict}}、name は a-z A-Z 0-9 _ - で64文字まで、
 *    tools は128個まで。Responses は type/name/description/parameters/strict が1段(入れ子なし)。
 *    strict: true のときは、parameters に structured outputs と同じ制限(関数呼び出しのガイド)
 *  - Anthropic: ツール定義のガイド(platform.claude.com の define-tools)。name は ^[a-zA-Z0-9_-]{1,128}$、
 *    input_schema は JSON Schema のオブジェクト、input_examples は input_schema に合わないと 400
 *  - Gemini: Gemini API の公式の Discovery 文書(generativelanguage.googleapis.com, v1beta)。
 *    FunctionDeclaration の name は a-z A-Z 0-9 _ : . - で128文字まで、description は必須、
 *    parameters と parametersJsonSchema は同時に指定しない(response と responseJsonSchema も同じ)
 *
 * 公式に書かれていないことは断定しない。strict の細部(Anthropic)、モデルごとの対応、実際の呼び出しは
 * 調べられないので、画面に「調べていない」と出す。
 */
import { validateAgainstSchema } from "./json-schema";
import { checkStructuredOutput } from "./structured-output";

export const VERIFIED_ON = "2026-10-23";

export type Vendor = "openaiChat" | "openaiResponses" | "anthropic" | "gemini";
export type SourceId = "openai" | "anthropic" | "gemini";

export const SOURCES: Record<SourceId, string> = {
  openai: "https://developers.openai.com/api/docs/guides/function-calling",
  anthropic: "https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools",
  gemini: "https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta",
};

export const NAME_RULES = {
  openai: { re: /^[a-zA-Z0-9_-]{1,64}$/, max: 64 },
  anthropic: { re: /^[a-zA-Z0-9_-]{1,128}$/, max: 128 },
  gemini: { re: /^[a-zA-Z0-9_:.-]{1,128}$/, max: 128 },
} as const;

/** OpenAI の Chat Completions で、tools に入れられると書かれている関数の最大数。 */
export const OPENAI_CHAT_MAX_TOOLS = 128;
/** OpenAI のガイドが「ソフトな目安」として挙げている数。 */
export const OPENAI_SOFT_TOOLS = 20;

export type Severity = "error" | "warn" | "info";

export type FindingCode =
  | "notObject"
  | "noTools"
  | "unknownShape"
  | "notChecked"
  | "mixedFormats"
  | "noName"
  | "badName"
  | "nameNotPortable"
  | "duplicateName"
  | "noDescription"
  | "descriptionRequired"
  | "shortDescription"
  | "badType"
  | "noFunction"
  | "badParameters"
  | "schemaNotObject"
  | "bothSchemas"
  | "bothResponses"
  | "strictDefaults"
  | "strictSchema"
  | "exampleInvalid"
  | "examplesNotArray"
  | "paramNoDescription"
  | "tooManyTools"
  | "manyTools"
  | "declarationsNotArray";

export const FINDING_CODES: FindingCode[] = [
  "notObject",
  "noTools",
  "unknownShape",
  "notChecked",
  "mixedFormats",
  "noName",
  "badName",
  "nameNotPortable",
  "duplicateName",
  "noDescription",
  "descriptionRequired",
  "shortDescription",
  "badType",
  "noFunction",
  "badParameters",
  "schemaNotObject",
  "bothSchemas",
  "bothResponses",
  "strictDefaults",
  "strictSchema",
  "exampleInvalid",
  "examplesNotArray",
  "paramNoDescription",
  "tooManyTools",
  "manyTools",
  "declarationsNotArray",
];

export const SEVERITY: Record<FindingCode, Severity> = {
  notObject: "error",
  noTools: "error",
  unknownShape: "error",
  notChecked: "info",
  mixedFormats: "warn",
  noName: "error",
  badName: "error",
  nameNotPortable: "info",
  duplicateName: "warn",
  noDescription: "warn",
  descriptionRequired: "error",
  shortDescription: "info",
  badType: "error",
  noFunction: "error",
  badParameters: "error",
  schemaNotObject: "warn",
  bothSchemas: "error",
  bothResponses: "error",
  strictDefaults: "info",
  strictSchema: "error",
  exampleInvalid: "error",
  examplesNotArray: "error",
  paramNoDescription: "info",
  tooManyTools: "error",
  manyTools: "info",
  declarationsNotArray: "error",
};

export type Finding = {
  severity: Severity;
  code: FindingCode;
  /** ツールの名前(無ければ「#番号」)。全体への指摘は空文字。 */
  tool: string;
  params: Record<string, string>;
};

export type ToolInfo = { label: string; vendor: Vendor | "other" };

export type CheckResult =
  | { ok: true; tools: ToolInfo[]; findings: Finding[] }
  | { ok: false; reason: "notJson" };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Anthropic が提供するツール(日付つきの type など)。このツールでは調べない。 */
const ANTHROPIC_PROVIDED = /^(?:[a-z_]+_\d{8}|mcp_toolset|tool_search_tool_(?:regex|bm25)|computer_toolset_\d{8}|browser_toolset_\d{8})$/;

/** 文の数(ピリオド・感嘆符・疑問符・句点で区切る)。 */
export function sentenceCount(s: string): number {
  return s
    .split(/(?:[.!?]+(?=\s|$))|[。！？]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0).length;
}

function detect(t: Obj): Vendor | "other" | null {
  if (typeof t.type === "string" && t.type !== "function") {
    if (ANTHROPIC_PROVIDED.test(t.type)) return "other";
    return has(t, "input_schema") ? "anthropic" : null;
  }
  if (t.type === "function") return isObj(t.function) || (has(t, "function") && !has(t, "name")) ? "openaiChat" : "openaiResponses";
  if (has(t, "input_schema")) return "anthropic";
  if (has(t, "parametersJsonSchema") || has(t, "parameters") || (has(t, "name") && has(t, "description"))) return "gemini";
  return null;
}

function portability(name: string): string[] {
  const rejecting: string[] = [];
  if (!NAME_RULES.openai.re.test(name)) rejecting.push("OpenAI");
  if (!NAME_RULES.anthropic.re.test(name)) rejecting.push("Anthropic");
  if (!NAME_RULES.gemini.re.test(name)) rejecting.push("Gemini");
  return rejecting;
}

function paramNames(schema: unknown): string[] {
  if (!isObj(schema) || !isObj(schema.properties)) return [];
  return Object.entries(schema.properties)
    .filter(([, v]) => isObj(v) && !(typeof v.description === "string" && v.description.trim() !== ""))
    .map(([k]) => k);
}

type Ctx = { out: Finding[] };

function push(ctx: Ctx, code: FindingCode, tool: string, params: Record<string, string> = {}) {
  ctx.out.push({ severity: SEVERITY[code], code, tool, params });
}

function checkName(ctx: Ctx, label: string, name: unknown, rule: "openai" | "anthropic" | "gemini"): string | null {
  if (typeof name !== "string" || name === "") {
    push(ctx, "noName", label);
    return null;
  }
  if (!NAME_RULES[rule].re.test(name)) push(ctx, "badName", label, { name, max: String(NAME_RULES[rule].max) });
  else {
    const no = portability(name);
    if (no.length > 0) push(ctx, "nameNotPortable", label, { name, vendors: no.join(", ") });
  }
  return name;
}

function checkDescription(ctx: Ctx, label: string, d: unknown, required: boolean) {
  if (typeof d !== "string" || d.trim() === "") {
    push(ctx, required ? "descriptionRequired" : "noDescription", label);
    return;
  }
  const n = sentenceCount(d);
  if (n < 3) push(ctx, "shortDescription", label, { n: String(n) });
}

function checkParams(ctx: Ctx, label: string, schema: unknown, field: string) {
  if (schema === undefined || schema === null) return;
  if (!isObj(schema)) {
    push(ctx, "badParameters", label, { field });
    return;
  }
  const t = schema.type;
  if (t !== undefined && t !== "object") push(ctx, "schemaNotObject", label, { field });
  else if (t === undefined && !has(schema, "properties")) push(ctx, "schemaNotObject", label, { field });
  const missing = paramNames(schema);
  if (missing.length > 0) push(ctx, "paramNoDescription", label, { names: missing.slice(0, 6).join(", ") + (missing.length > 6 ? ", …" : "") });
}

function strictCheck(ctx: Ctx, label: string, parameters: unknown) {
  const schema = isObj(parameters) ? parameters : { type: "object", properties: {} };
  const r = checkStructuredOutput(schema);
  if (!r.ok) return;
  const problems = r.findings.filter((f) => f.vendor === "openai" && f.severity === "error");
  if (problems.length > 0) push(ctx, "strictSchema", label, { n: String(problems.length), at: problems[0].at || "/" });
}

function checkOpenAiChat(ctx: Ctx, t: Obj, label: string): string | null {
  if (t.type !== "function") push(ctx, "badType", label);
  const f = t.function;
  if (!isObj(f)) {
    push(ctx, "noFunction", label);
    return null;
  }
  const name = checkName(ctx, label, f.name, "openai");
  checkDescription(ctx, label, f.description, false);
  checkParams(ctx, label, f.parameters, "parameters");
  if (f.strict === true) strictCheck(ctx, label, f.parameters);
  else if (f.strict === undefined || f.strict === null) push(ctx, "strictDefaults", label, { api: "Chat Completions" });
  return name;
}

function checkOpenAiResponses(ctx: Ctx, t: Obj, label: string): string | null {
  const name = checkName(ctx, label, t.name, "openai");
  checkDescription(ctx, label, t.description, false);
  checkParams(ctx, label, t.parameters, "parameters");
  if (t.strict === true) strictCheck(ctx, label, t.parameters);
  else if (t.strict === undefined || t.strict === null) push(ctx, "strictDefaults", label, { api: "Responses" });
  return name;
}

function checkAnthropic(ctx: Ctx, t: Obj, label: string): string | null {
  const name = checkName(ctx, label, t.name, "anthropic");
  checkDescription(ctx, label, t.description, false);
  const schema = t.input_schema;
  checkParams(ctx, label, schema, "input_schema");
  if (has(t, "input_examples")) {
    const ex = t.input_examples;
    if (!Array.isArray(ex)) push(ctx, "examplesNotArray", label);
    else if (isObj(schema)) {
      ex.forEach((e, i) => {
        const r = validateAgainstSchema(schema, e);
        if (r.ok && !r.valid) push(ctx, "exampleInvalid", label, { at: String(i + 1), n: String(r.errors.length) });
      });
    }
  }
  return name;
}

function checkGeminiDeclaration(ctx: Ctx, d: Obj, label: string): string | null {
  const name = checkName(ctx, label, d.name, "gemini");
  checkDescription(ctx, label, d.description, true);
  if (has(d, "parameters") && has(d, "parametersJsonSchema")) push(ctx, "bothSchemas", label);
  if (has(d, "response") && has(d, "responseJsonSchema")) push(ctx, "bothResponses", label);
  checkParams(ctx, label, has(d, "parametersJsonSchema") ? d.parametersJsonSchema : d.parameters, has(d, "parametersJsonSchema") ? "parametersJsonSchema" : "parameters");
  return name;
}

/** 貼られたもの(1つのツール、配列、{ tools: [...] }、{ functionDeclarations: [...] })を、ツールの並びにする。 */
function toolList(root: unknown): unknown[] | null {
  if (Array.isArray(root)) return root;
  if (isObj(root)) {
    if (Array.isArray(root.tools)) return root.tools;
    return [root];
  }
  return null;
}

export function checkToolDefinitions(text: string): CheckResult {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { ok: false, reason: "notJson" };
  }
  const ctx: Ctx = { out: [] };
  const tools: ToolInfo[] = [];
  const list = toolList(root);
  if (list === null) {
    push(ctx, "notObject", "");
    return { ok: true, tools, findings: ctx.out };
  }
  if (list.length === 0) {
    push(ctx, "noTools", "");
    return { ok: true, tools, findings: ctx.out };
  }

  const names = new Map<string, number>();
  const vendors = new Set<Vendor>();
  let functionCount = 0;
  let openaiChatCount = 0;

  const note = (name: string | null, label: string) => {
    if (name === null) return;
    names.set(name, (names.get(name) ?? 0) + 1);
    if ((names.get(name) ?? 0) === 2) push(ctx, "duplicateName", label, { name });
  };

  list.forEach((item, i) => {
    const fallback = `#${i + 1}`;
    if (!isObj(item)) {
      push(ctx, "notObject", fallback);
      tools.push({ label: fallback, vendor: "other" });
      return;
    }
    // Gemini の Tool: { functionDeclarations: [...] }
    if (has(item, "functionDeclarations")) {
      const decls = item.functionDeclarations;
      if (!Array.isArray(decls)) {
        push(ctx, "declarationsNotArray", fallback);
        return;
      }
      vendors.add("gemini");
      decls.forEach((d, j) => {
        const l = `#${i + 1}.${j + 1}`;
        if (!isObj(d)) {
          push(ctx, "notObject", l);
          return;
        }
        functionCount++;
        const label = typeof d.name === "string" && d.name !== "" ? d.name : l;
        note(checkGeminiDeclaration(ctx, d, label), label);
        tools.push({ label, vendor: "gemini" });
      });
      return;
    }
    const v = detect(item);
    const label = (typeof item.name === "string" && item.name !== "" ? item.name : isObj(item.function) && typeof item.function.name === "string" && item.function.name !== "" ? item.function.name : null) ?? fallback;
    if (v === null) {
      push(ctx, "unknownShape", label);
      tools.push({ label, vendor: "other" });
      return;
    }
    if (v === "other") {
      push(ctx, "notChecked", label, { type: String(item.type) });
      tools.push({ label, vendor: "other" });
      return;
    }
    vendors.add(v);
    functionCount++;
    let n: string | null;
    if (v === "openaiChat") {
      openaiChatCount++;
      n = checkOpenAiChat(ctx, item, label);
    } else if (v === "openaiResponses") n = checkOpenAiResponses(ctx, item, label);
    else if (v === "anthropic") n = checkAnthropic(ctx, item, label);
    else n = checkGeminiDeclaration(ctx, item, label);
    note(n, label);
    tools.push({ label, vendor: v });
  });

  if (vendors.size > 1) push(ctx, "mixedFormats", "");
  if (openaiChatCount > OPENAI_CHAT_MAX_TOOLS) push(ctx, "tooManyTools", "", { n: String(openaiChatCount), max: String(OPENAI_CHAT_MAX_TOOLS) });
  if ((vendors.has("openaiChat") || vendors.has("openaiResponses")) && functionCount > OPENAI_SOFT_TOOLS && openaiChatCount <= OPENAI_CHAT_MAX_TOOLS) push(ctx, "manyTools", "", { n: String(functionCount), soft: String(OPENAI_SOFT_TOOLS) });

  const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  ctx.out.sort((a, b) => order[a.severity] - order[b.severity]);
  return { ok: true, tools, findings: ctx.out };
}

export const EXAMPLE_TOOLS = `[
  {
    "name": "get weather",
    "description": "Gets the weather.",
    "input_schema": {
      "type": "object",
      "properties": { "location": { "type": "string" }, "unit": { "type": "string", "enum": ["celsius", "fahrenheit"] } },
      "required": ["location"]
    },
    "input_examples": [{ "location": "Tokyo", "unit": "kelvin" }]
  },
  {
    "type": "function",
    "name": "search_docs",
    "description": "Search the documentation. Returns the best matching pages. Use it when the user asks how something works.",
    "parameters": {
      "type": "object",
      "properties": { "query": { "type": "string", "description": "Search words" }, "limit": { "type": "integer" } },
      "required": ["query"]
    },
    "strict": true
  },
  {
    "functionDeclarations": [
      {
        "name": "lookup.user",
        "parameters": { "type": "object", "properties": { "id": { "type": "string" } } },
        "parametersJsonSchema": { "type": "object" }
      }
    ]
  }
]`;
