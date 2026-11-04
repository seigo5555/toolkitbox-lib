/**
 * Ollama の /api/chat に送る要求(JSON の本文と curl のコマンド)を組み立てる。
 *
 * 項目は公式の API リファレンス(docs.ollama.com/api/chat の ChatRequest)にあるものだけ:
 * model・messages(必須)、tools、format("json" か JSON Schema)、options、stream(既定 true)、think、keep_alive。
 * options は ModelOptions に名前のあるもの(seed・temperature・top_k・top_p・min_p・stop・num_ctx・num_predict)。
 * think は true / false / モデルが決める名前(/api/show の thinking.values と同じ文字)。数は受け付けない。
 * keep_alive は "5m" のような文字か、秒の数(FAQ)。
 *
 * curl の形は FAQ の例(`curl http://localhost:11434/api/generate -d '{…}'`)に合わせる。
 */

export const OLLAMA_API_VERIFIED_ON = "2026-11-03";
export const OLLAMA_CHAT_DOC_URL = "https://docs.ollama.com/api/chat";
export const DEFAULT_BASE = "http://localhost:11434";

export type OptionType = "int" | "posInt" | "float";
/** ModelOptions の順。 */
export const OPTIONS: { name: string; type: OptionType }[] = [
  { name: "temperature", type: "float" },
  { name: "seed", type: "int" },
  { name: "num_ctx", type: "posInt" },
  { name: "num_predict", type: "int" },
  { name: "top_k", type: "posInt" },
  { name: "top_p", type: "float" },
  { name: "min_p", type: "float" },
];

export type FormatMode = "none" | "json" | "schema";
/** "" は送らない(モデルの既定)。"level" は levelText をそのまま送る。 */
export type ThinkMode = "" | "true" | "false" | "level";

export type ApiInput = {
  base: string;
  model: string;
  system: string;
  user: string;
  stream: boolean;
  think: ThinkMode;
  thinkLevel: string;
  format: FormatMode;
  schema: string;
  tools: string;
  options: Record<string, string>;
  /** 1行に1つ。 */
  stop: string;
  keepAlive: string;
  /** ベーシック認証の利用者名。入れると curl に -u を付ける(パスワードは curl が尋ねる)。 */
  authUser: string;
};

export type ProblemCode =
  | "modelMissing"
  | "userMissing"
  | "baseFormat"
  | "schemaJson"
  | "schemaNotObject"
  | "toolsJson"
  | "toolsNotArray"
  | "toolShape"
  | "notInteger"
  | "notPositive"
  | "notNumber"
  | "levelMissing"
  | "levelNumber"
  | "keepAliveFormat"
  | "authUserChars";

export type Problem = { code: ProblemCode; field: string; severity: "error" | "warn" };

const INT = /^-?\d+$/;
const POS = /^[1-9]\d*$/;
const FLOAT = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const DURATION = /^-?(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;
const BASE = /^https?:\/\/[A-Za-z0-9.\-[\]:]+(\/[^\s'"]*)?$/;

function parse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function buildRequest(input: ApiInput): { body: Record<string, unknown>; json: string; problems: Problem[] } {
  const problems: Problem[] = [];
  const p = (code: ProblemCode, field: string, severity: "error" | "warn" = "error") => problems.push({ code, field, severity });

  const model = input.model.trim();
  if (!model) p("modelMissing", "model");
  if (!input.user.trim()) p("userMissing", "user");
  if (input.base.trim() && !BASE.test(input.base.trim())) p("baseFormat", "base");

  const messages: { role: string; content: string }[] = [];
  if (input.system.trim()) messages.push({ role: "system", content: input.system });
  messages.push({ role: "user", content: input.user });

  const body: Record<string, unknown> = { model, messages };

  if (input.tools.trim()) {
    const r = parse(input.tools);
    if (!r.ok) p("toolsJson", "tools");
    else if (!Array.isArray(r.value)) p("toolsNotArray", "tools");
    else {
      const bad = r.value.some(
        (t) => !isObj(t) || t.type !== "function" || !isObj(t.function) || typeof t.function.name !== "string" || !isObj(t.function.parameters),
      );
      if (bad) p("toolShape", "tools");
      body.tools = r.value;
    }
  }

  if (input.format === "json") body.format = "json";
  if (input.format === "schema") {
    const r = parse(input.schema);
    if (!r.ok) p("schemaJson", "schema");
    else if (!isObj(r.value)) p("schemaNotObject", "schema");
    else body.format = r.value;
  }

  const options: Record<string, unknown> = {};
  for (const o of OPTIONS) {
    const v = (input.options[o.name] ?? "").trim();
    if (!v) continue;
    if (o.type === "float") {
      if (!FLOAT.test(v)) p("notNumber", o.name);
      else options[o.name] = Number(v);
    } else if (!INT.test(v)) p("notInteger", o.name);
    else if (o.type === "posInt" && !POS.test(v)) p("notPositive", o.name);
    else options[o.name] = Number(v);
  }
  const stops = input.stop.split(/\r?\n/).filter((s) => s !== "");
  if (stops.length) options.stop = stops;
  if (Object.keys(options).length) body.options = options;

  if (!input.stream) body.stream = false;

  if (input.think === "true") body.think = true;
  if (input.think === "false") body.think = false;
  if (input.think === "level") {
    const lv = input.thinkLevel.trim();
    if (!lv) p("levelMissing", "thinkLevel");
    else if (FLOAT.test(lv)) p("levelNumber", "thinkLevel");
    else body.think = lv;
  }

  const ka = input.keepAlive.trim();
  if (ka) {
    if (INT.test(ka)) body.keep_alive = Number(ka);
    else {
      if (!DURATION.test(ka)) p("keepAliveFormat", "keepAlive", "warn");
      body.keep_alive = ka;
    }
  }

  if (input.authUser.trim() && !/^[A-Za-z0-9._@-]+$/.test(input.authUser.trim())) p("authUserChars", "authUser");

  return { body, json: JSON.stringify(body, null, 2), problems };
}

/** シェルの '…' の中に入れる(' は '\'' にする)。 */
export function singleQuote(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function baseUrl(input: ApiInput) {
  return (input.base.trim() || DEFAULT_BASE).replace(/\/+$/, "");
}

function authPart(input: ApiInput) {
  const u = input.authUser.trim();
  return u && /^[A-Za-z0-9._@-]+$/.test(u) ? ` -u ${u}` : "";
}

export function curlCommand(input: ApiInput, json: string) {
  return `curl${authPart(input)} ${baseUrl(input)}/api/chat -d ${singleQuote(json)}`;
}

/** think を使うときに、モデルが受け付ける値を見るコマンド(thinking のページの案内)。 */
export function showCommand(input: ApiInput) {
  const model = input.model.trim() || "MODEL";
  return `curl${authPart(input)} ${baseUrl(input)}/api/show -d ${singleQuote(JSON.stringify({ model }))}`;
}
