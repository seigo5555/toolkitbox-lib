/**
 * AI の構造化出力(Structured Outputs)に渡す JSON Schema が、各社の公式ドキュメントに書かれた
 * 制限に当たらないかを調べる。LLM は呼ばない。ブラウザの中だけで完結する。
 *
 * **ここに書く規則は、各社の公式ドキュメントに書かれていることだけ。** 確認元と日付は
 * `SOURCES` と `VERIFIED_ON`。規則を足し引きするときは、公式の文面を確かめて `VERIFIED_ON` を更新する。
 *
 * 結果は3段階に分ける。
 *  - error:    公式が「使えない」「こうしなければならない」と書いている(OpenAI は strict: true のとき)
 *  - ignored:  公式が「受け付けるが強制しない(API が取り除く)」と書いている
 *  - unlisted: そのベンダーの「対応するキーワード」の一覧に載っていない。通るかどうかは公式に書かれていない
 *
 * 公式に書かれていないことは断定しない。数えかたが曖昧な上限(OpenAI のネスト10段など)は
 * 調べず、画面に「調べていない」と出す。
 */

export const VERIFIED_ON = "2026-10-23";

export type Vendor = "openai" | "anthropic" | "gemini";
export const VENDORS: Vendor[] = ["openai", "anthropic", "gemini"];

export const SOURCES: Record<Vendor, string> = {
  openai: "https://developers.openai.com/api/docs/guides/structured-outputs",
  anthropic: "https://platform.claude.com/docs/en/build-with-claude/structured-outputs",
  gemini: "https://ai.google.dev/gemini-api/docs/structured-output",
};

export type Severity = "error" | "ignored" | "unlisted";

export type FindingCode =
  | "rootNotObject"
  | "rootAnyOf"
  | "needAllRequired"
  | "needAdditionalFalse"
  | "unsupported"
  | "minItemsLimit"
  | "recursive"
  | "externalRef"
  | "allOfRef"
  | "enumComplex"
  | "patternFeature"
  | "ignored"
  | "unlisted"
  | "formatUnlisted"
  | "limitProps"
  | "limitEnum"
  | "limitChars";

export const FINDING_CODES: FindingCode[] = [
  "rootNotObject",
  "rootAnyOf",
  "needAllRequired",
  "needAdditionalFalse",
  "unsupported",
  "minItemsLimit",
  "recursive",
  "externalRef",
  "allOfRef",
  "enumComplex",
  "patternFeature",
  "ignored",
  "unlisted",
  "formatUnlisted",
  "limitProps",
  "limitEnum",
  "limitChars",
];

export type Finding = {
  vendor: Vendor;
  severity: Severity;
  code: FindingCode;
  /** スキーマ中の位置(JSON Pointer 風。ルートは空文字)。 */
  at: string;
  params: Record<string, string>;
};

export type CheckResult = { ok: true; findings: Finding[] } | { ok: false; reason: "notObject" | "tooDeep" };

/** 公式のキーワード表。 */
export const RULES = {
  openai: {
    /** 「Unsupported keywords」に載っているもの。 */
    unsupported: ["allOf", "not", "dependentRequired", "dependentSchemas", "if", "then", "else"],
    /** 「対応するプロパティ」の一覧に載っていないもの。 */
    unlisted: [
      "oneOf", "minLength", "maxLength", "uniqueItems", "minProperties", "maxProperties", "contains",
      "minContains", "maxContains", "prefixItems", "patternProperties", "propertyNames",
      "unevaluatedProperties", "unevaluatedItems", "$dynamicRef", "additionalItems",
    ],
    formats: ["date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid"],
    maxProperties: 5000,
    maxEnumValues: 1000,
    maxChars: 120000,
  },
  anthropic: {
    /** 「Not supported」に載っているもの(数値の制約・文字列の長さ・maxItems)。 */
    unsupported: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems"],
    unlisted: [
      "oneOf", "not", "if", "then", "else", "patternProperties", "propertyNames", "dependentRequired", "dependentSchemas",
      "uniqueItems", "contains", "minContains", "maxContains", "minProperties", "maxProperties", "prefixItems",
      "unevaluatedProperties", "unevaluatedItems", "$dynamicRef", "additionalItems",
    ],
    formats: ["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"],
  },
  gemini: {
    /** 「強制されない。API が取り除く」と書かれているもの。 */
    ignored: ["minLength", "maxLength", "minProperties", "maxProperties", "uniqueItems", "contains", "minContains", "maxContains"],
    /** 型ごとのキーワード一覧に載っていないもの。 */
    unlisted: [
      "pattern", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "oneOf", "allOf", "not", "if", "then", "else", "const",
      "patternProperties", "propertyNames", "dependentRequired", "dependentSchemas", "unevaluatedProperties",
      "unevaluatedItems", "$dynamicRef", "additionalItems",
    ],
  },
} as const;

const MAX_DEPTH = 200;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** スキーマを持つ位置(キーワード → 入れ子の種類)。 */
const MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;
const SLOTS = ["items", "additionalItems", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems"] as const;
const LISTS = ["prefixItems", "allOf", "anyOf", "oneOf"] as const;

const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

type Node = { schema: Obj; at: string };

/** 部分スキーマを(参照をたどらずに)すべて集める。 */
function collect(root: unknown, skipDefs = false): Node[] | "tooDeep" {
  const out: Node[] = [];
  let tooDeep = false;
  const walk = (s: unknown, at: string, depth: number) => {
    if (!isObj(s)) return;
    if (depth > MAX_DEPTH) {
      tooDeep = true;
      return;
    }
    out.push({ schema: s, at });
    for (const k of MAPS) {
      if (skipDefs && (k === "$defs" || k === "definitions")) continue;
      const m = s[k];
      if (isObj(m)) for (const [name, sub] of Object.entries(m)) walk(sub, `${at}/${k}/${esc(name)}`, depth + 1);
    }
    for (const k of SLOTS) {
      const v = s[k];
      if (isObj(v)) walk(v, `${at}/${k}`, depth + 1);
      else if (Array.isArray(v) && k === "items") v.forEach((x, i) => walk(x, `${at}/${k}/${i}`, depth + 1));
    }
    for (const k of LISTS) {
      const v = s[k];
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}/${k}/${i}`, depth + 1));
    }
  };
  walk(root, "", 0);
  return tooDeep ? "tooDeep" : out;
}

function resolveLocal(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (isObj(cur)) cur = cur[key];
    else return undefined;
  }
  return cur;
}

const typesOf = (s: Obj): string[] => (typeof s.type === "string" ? [s.type] : Array.isArray(s.type) ? s.type.filter((t): t is string => typeof t === "string") : []);
const isObjectSchema = (s: Obj) => typesOf(s).includes("object") || isObj(s.properties);

/** 正規表現の中に、Anthropic が対応しないと書いている構文があるか。 */
export function unsupportedPatternFeatures(src: string): string[] {
  const found = new Set<string>();
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1] ?? "";
      if (!inClass) {
        if (/[1-9]/.test(n) || (n === "k" && src[i + 2] === "<")) found.add("\\1  \\k<name>");
        else if (n === "b" || n === "B") found.add("\\b  \\B");
      }
      i++;
    } else if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "(" && src[i + 1] === "?") {
      if (src[i + 2] === "=" || src[i + 2] === "!") found.add("(?=  (?!");
      else if (src[i + 2] === "<" && (src[i + 3] === "=" || src[i + 3] === "!")) found.add("(?<=  (?<!");
    }
  }
  return [...found];
}

function refsIn(nodes: Node[]): { ref: string; at: string }[] {
  const out: { ref: string; at: string }[] = [];
  for (const n of nodes) if (typeof n.schema.$ref === "string") out.push({ ref: n.schema.$ref, at: `${n.at}/$ref` });
  return out;
}

/** $ref の循環があるか(ルートから到達できるもの)。見つけた最初の参照を返す。 */
function findCycle(root: unknown): { ref: string; at: string } | null {
  // 各部分スキーマ(参照先になり得る)について、その中に含まれる $ref を求める。
  const own = new Map<unknown, { ref: string; at: string }[]>();
  const subtree = (s: Obj): { ref: string; at: string }[] => {
    const cached = own.get(s);
    if (cached) return cached;
    const inner = collect(s, true);
    const res = inner === "tooDeep" ? [] : refsIn(inner);
    own.set(s, res);
    return res;
  };
  const state = new Map<unknown, 1 | 2>(); // 1: 探索中, 2: 済み
  let hit: { ref: string; at: string } | null = null;
  const visit = (s: unknown) => {
    if (hit || !isObj(s)) return;
    const st = state.get(s);
    if (st === 2) return;
    state.set(s, 1);
    for (const r of subtree(s)) {
      const target = resolveLocal(root, r.ref);
      if (!isObj(target)) continue;
      if (state.get(target) === 1) {
        hit = r;
        return;
      }
      visit(target);
      if (hit) return;
    }
    state.set(s, 2);
  };
  visit(root);
  return hit;
}

function add(out: Finding[], vendor: Vendor, severity: Severity, code: FindingCode, at: string, params: Record<string, string> = {}) {
  out.push({ vendor, severity, code, at, params });
}

const has = (s: Obj, k: string) => Object.prototype.hasOwnProperty.call(s, k);

export function checkStructuredOutput(schema: unknown): CheckResult {
  if (!isObj(schema)) return { ok: false, reason: "notObject" };
  const nodes = collect(schema);
  if (nodes === "tooDeep") return { ok: false, reason: "tooDeep" };
  const out: Finding[] = [];

  // --- OpenAI(strict: true) ---
  {
    const R = RULES.openai;
    if (!isObjectSchema(schema)) add(out, "openai", "error", "rootNotObject", "");
    if (Array.isArray(schema.anyOf)) add(out, "openai", "error", "rootAnyOf", "");
    let props = 0;
    let enums = 0;
    let chars = 0;
    for (const { schema: s, at } of nodes) {
      if (isObjectSchema(s)) {
        if (s.additionalProperties !== false) add(out, "openai", "error", "needAdditionalFalse", at);
        const names = isObj(s.properties) ? Object.keys(s.properties) : [];
        const req = Array.isArray(s.required) ? s.required : [];
        const missing = names.filter((n) => !req.includes(n));
        if (missing.length > 0) {
          const shown = missing.slice(0, 5).join(", ") + (missing.length > 5 ? ", …" : "");
          add(out, "openai", "error", "needAllRequired", at, { names: shown });
        }
        props += names.length;
        for (const n of names) chars += n.length;
      }
      for (const k of R.unsupported) if (has(s, k)) add(out, "openai", "error", "unsupported", `${at}/${k}`, { keyword: k });
      for (const k of R.unlisted) if (has(s, k)) add(out, "openai", "unlisted", "unlisted", `${at}/${k}`, { keyword: k });
      if (typeof s.format === "string" && !(R.formats as readonly string[]).includes(s.format)) {
        add(out, "openai", "unlisted", "formatUnlisted", `${at}/format`, { value: s.format });
      }
      if (Array.isArray(s.enum)) {
        enums += s.enum.length;
        for (const v of s.enum) if (typeof v === "string") chars += v.length;
      }
      if (typeof s.const === "string") chars += s.const.length;
    }
    for (const n of Object.keys(isObj(schema.$defs) ? schema.$defs : {})) chars += n.length;
    for (const n of Object.keys(isObj(schema.definitions) ? schema.definitions : {})) chars += n.length;
    if (props > R.maxProperties) add(out, "openai", "error", "limitProps", "", { n: String(props), max: String(R.maxProperties) });
    if (enums > R.maxEnumValues) add(out, "openai", "error", "limitEnum", "", { n: String(enums), max: String(R.maxEnumValues) });
    if (chars > R.maxChars) add(out, "openai", "error", "limitChars", "", { n: String(chars), max: String(R.maxChars) });
  }

  // --- Anthropic ---
  {
    const R = RULES.anthropic;
    for (const { schema: s, at } of nodes) {
      if (isObjectSchema(s) && s.additionalProperties !== false) add(out, "anthropic", "error", "needAdditionalFalse", at);
      for (const k of R.unsupported) if (has(s, k)) add(out, "anthropic", "error", "unsupported", `${at}/${k}`, { keyword: k });
      for (const k of R.unlisted) if (has(s, k)) add(out, "anthropic", "unlisted", "unlisted", `${at}/${k}`, { keyword: k });
      if (typeof s.minItems === "number" && s.minItems > 1) add(out, "anthropic", "error", "minItemsLimit", `${at}/minItems`, { value: String(s.minItems) });
      if (Array.isArray(s.allOf) && s.allOf.some((x) => isObj(x) && typeof x.$ref === "string")) add(out, "anthropic", "error", "allOfRef", `${at}/allOf`);
      if (typeof s.format === "string" && !(R.formats as readonly string[]).includes(s.format)) {
        add(out, "anthropic", "unlisted", "formatUnlisted", `${at}/format`, { value: s.format });
      }
      if (Array.isArray(s.enum) && s.enum.some((v) => typeof v === "object" && v !== null)) add(out, "anthropic", "error", "enumComplex", `${at}/enum`);
      if (typeof s.pattern === "string") {
        const feats = unsupportedPatternFeatures(s.pattern);
        if (feats.length > 0) add(out, "anthropic", "error", "patternFeature", `${at}/pattern`, { feature: feats.join(" , ") });
      }
      if (typeof s.$ref === "string" && !s.$ref.startsWith("#")) add(out, "anthropic", "error", "externalRef", `${at}/$ref`, { ref: s.$ref });
    }
    const cyc = findCycle(schema);
    if (cyc) add(out, "anthropic", "error", "recursive", cyc.at, { ref: cyc.ref });
  }

  // --- Gemini ---
  {
    const R = RULES.gemini;
    for (const { schema: s, at } of nodes) {
      for (const k of R.ignored) if (has(s, k)) add(out, "gemini", "ignored", "ignored", `${at}/${k}`, { keyword: k });
      for (const k of R.unlisted) if (has(s, k)) add(out, "gemini", "unlisted", "unlisted", `${at}/${k}`, { keyword: k });
    }
  }

  return { ok: true, findings: out };
}

export const EXAMPLE_SCHEMA = `{
  "type": "object",
  "properties": {
    "name": { "type": "string", "minLength": 1, "maxLength": 80 },
    "age": { "type": "integer", "minimum": 0, "maximum": 150 },
    "email": { "type": "string", "format": "email" },
    "tags": { "type": "array", "items": { "type": "string" }, "uniqueItems": true, "maxItems": 5 }
  },
  "required": ["name", "email"]
}`;
