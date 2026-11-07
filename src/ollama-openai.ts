/**
 * Ollama の /api/chat と、OpenAI 互換の /v1/chat/completions のあいだで、要求と応答を書き換える。
 *
 * 書き換え方は Ollama 自身の変換に合わせる(ollama/ollama v0.40.14 の openai/openai.go と middleware/openai.go):
 *  - OpenAI の要求 → Ollama の要求: FromChatRequest をそのまま写した。Ollama の /v1/chat/completions は、受け取った本文を
 *    この関数で /api/chat の要求に直してから処理する
 *  - Ollama の応答 → OpenAI の応答: ToChatCompletion(stream しない応答)
 *  - Ollama の要求 → OpenAI の要求: Ollama に逆向きの関数は無いので、FromChatRequest の逆をたどる。
 *    OpenAI 互換 API に項目が無いもの(num_ctx・top_k など)は書き出さずに一覧にする
 * 受け付ける項目は公式の対応表(docs.ollama.com/api/openai-compatibility)とソースの ChatCompletionRequest の json 名。
 * それ以外の項目を Ollama は読まずに捨てる(gin の ShouldBindJSON は知らない項目を無視する)。
 *
 * 2026-11-06 に Ollama 0.40.11 の qwen2.5:7b で、_debug_render_only を付けて両方の入口に送り、
 * 組み上がるプロンプト(_debug_info.rendered_template)が同じになることを確かめた(scripts/check-ollama-openai.ts)。
 * 0.40.11 と 0.40.14 の openai.go の違いは、temperature・top_p などを省いたときの扱いと、空の content 配列だけ。
 */

export const OLLAMA_OPENAI_VERIFIED_ON = "2026-11-06";
export const OLLAMA_OPENAI_DOC_URL = "https://docs.ollama.com/api/openai-compatibility";
export const OLLAMA_SOURCE_VERSION = "v0.40.14";

export type Mode = "auto" | "openaiRequest" | "ollamaRequest" | "ollamaResponse";
export type Kind = Exclude<Mode, "auto">;

export type ProblemCode =
  | "inputEmpty"
  | "inputJson"
  | "inputNotObject"
  | "kindUnknown"
  | "openaiResponse"
  | "streamResponse"
  | "messagesMissing"
  | "modelMissing"
  | "contentType"
  | "partType"
  | "imageRemote"
  | "imageInvalid"
  | "audioInvalid"
  | "toolArgsNotString"
  | "toolArgsJson"
  | "toolArgsObject"
  | "fieldType"
  | "formatInvalid"
  | "thinkUnknown"
  | "ignoredFields"
  | "noEquivalent"
  | "maxCompletionTokens"
  | "stopNonString"
  | "schemaMissing"
  | "thinkTrue"
  | "imagesSplit"
  | "emptyParts"
  | "createdAtMissing";

export type Problem = { code: ProblemCode; severity: "error" | "warn"; index?: number; detail?: string };

/** 書き換えの対応表の1行。from・to は項目の名前(訳さない)。to が null なら書き出していない。 */
export type MapRow = { from: string; to: string | null; note?: "default" | "renamed" | "split" | "dropped" };

export type ConvertResult = {
  problems: Problem[];
  kind: Kind | null;
  detected: boolean;
  /** 書き出したもの。エラーのときは null。 */
  output: Record<string, unknown> | null;
  json: string;
  /** 要求のときだけ。 */
  curl: string;
  rows: MapRow[];
};

/** ChatCompletionRequest の json 名(v0.40.14)。これ以外は Ollama が読まない。 */
const OPENAI_REQUEST_FIELDS = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "max_tokens",
  "seed",
  "stop",
  "temperature",
  "frequency_penalty",
  "presence_penalty",
  "top_p",
  "response_format",
  "tools",
  "reasoning",
  "reasoning_effort",
  "logprobs",
  "top_logprobs",
  "_debug_render_only",
  "keep_alive",
]);

/** api.ChatRequest の json 名(v0.40.14)。 */
const OLLAMA_REQUEST_FIELDS = new Set([
  "model",
  "messages",
  "stream",
  "format",
  "keep_alive",
  "tools",
  "options",
  "think",
  "truncate",
  "shift",
  "_debug_render_only",
  "logprobs",
  "top_logprobs",
  "runner",
]);

/** OpenAI 互換 API の項目が無い ChatRequest の項目。 */
const OLLAMA_ONLY_FIELDS = ["truncate", "shift", "runner"];

/** options のうち、OpenAI 互換の項目があるもの(FromChatRequest の逆)。 */
const OPTION_TO_OPENAI: Record<string, string> = {
  num_predict: "max_tokens",
  temperature: "temperature",
  seed: "seed",
  frequency_penalty: "frequency_penalty",
  presence_penalty: "presence_penalty",
  top_p: "top_p",
  stop: "stop",
};

/** OpenAI 側の項目 → options の名前(FromChatRequest の options の組み立て順)。 */
const OPENAI_TO_OPTION: [string, string, "int" | "number"][] = [
  ["max_tokens", "num_predict", "int"],
  ["temperature", "temperature", "number"],
  ["seed", "seed", "int"],
  ["frequency_penalty", "frequency_penalty", "number"],
  ["presence_penalty", "presence_penalty", "number"],
  ["top_p", "top_p", "number"],
];

const IMAGE_PREFIXES = ["data:image/jpeg;base64,", "data:image/jpg;base64,", "data:image/png;base64,", "data:image/webp;base64,"];
const BASE = "http://localhost:11434";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Go の base64.StdEncoding が受け付ける形(パディングあり)。 */
export function isStdBase64(s: string) {
  return s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);
}

/**
 * Go の json.Marshal と同じく、< > & と U+2028・U+2029 を \u で書く
 * (ToToolCalls が引数を文字列にするときの形。読み直せば同じ値)。
 */
export function goJson(v: unknown) {
  return JSON.stringify(v)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

/** 貼られた JSON がどれかを見分ける。決められないときは null。 */
export function detectKind(v: Obj): Kind | "openaiResponse" | null {
  if (Array.isArray(v.choices)) return "openaiResponse";
  if (isObj(v.message) && ("done" in v || "created_at" in v)) return "ollamaResponse";
  if (!Array.isArray(v.messages)) return null;
  const openaiOnly = ["max_tokens", "max_completion_tokens", "response_format", "reasoning_effort", "reasoning", "stream_options", "tool_choice", "n", "user", "logit_bias", "temperature", "top_p", "seed", "stop", "frequency_penalty", "presence_penalty"];
  const ollamaOnly = ["options", "format", "think", "truncate", "shift"];
  if (ollamaOnly.some((k) => k in v)) return "ollamaRequest";
  if (openaiOnly.some((k) => k in v)) return "openaiRequest";
  for (const m of v.messages) {
    if (!isObj(m)) continue;
    if (Array.isArray(m.content) || "reasoning" in m) return "openaiRequest";
    if ("images" in m || "thinking" in m || "tool_name" in m) return "ollamaRequest";
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const args = isObj(tc) && isObj(tc.function) ? tc.function.arguments : undefined;
        if (typeof args === "string") return "openaiRequest";
        if (isObj(args)) return "ollamaRequest";
      }
    }
  }
  return null;
}

function curlFor(path: string, json: string, header: boolean) {
  const q = `'${json.replaceAll("'", `'\\''`)}'`;
  return header ? `curl ${BASE}${path} -H "Content-Type: application/json" -d ${q}` : `curl ${BASE}${path} -d ${q}`;
}

function isInt(v: unknown) {
  return typeof v === "number" && Number.isInteger(v);
}

/** reasoning_effort → think(ThinkingFromReasoningEffort。モデルの情報が無いときの形)。 */
export function effortToThink(effort: string): { think: unknown; known: boolean } | null {
  if (effort === "") return null;
  if (effort === "none") return { think: false, known: true };
  const mapped = effort === "minimal" ? "low" : effort === "xhigh" || effort === "ultra" ? "max" : effort;
  return { think: mapped, known: ["low", "medium", "high", "max"].includes(mapped) };
}

type Ctx = { problems: Problem[]; rows: MapRow[] };

/** OpenAI の tool_calls → Ollama の tool_calls(FromCompletionToolCall)。失敗したら null。 */
function toolCallsFromOpenai(list: unknown, index: number, ctx: Ctx): Obj[] | null {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    ctx.problems.push({ code: "fieldType", severity: "error", index, detail: "tool_calls" });
    return null;
  }
  const out: Obj[] = [];
  for (const tc of list) {
    const fn = isObj(tc) && isObj(tc.function) ? tc.function : {};
    const args = fn.arguments;
    if (typeof args !== "string") {
      ctx.problems.push({ code: "toolArgsNotString", severity: "error", index });
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      ctx.problems.push({ code: "toolArgsJson", severity: "error", index });
      return null;
    }
    if (!isObj(parsed)) {
      ctx.problems.push({ code: "toolArgsObject", severity: "error", index });
      return null;
    }
    const call: Obj = {};
    if (isObj(tc) && typeof tc.id === "string" && tc.id) call.id = tc.id;
    call.function = { name: typeof fn.name === "string" ? fn.name : "", arguments: parsed };
    out.push(call);
  }
  return out;
}

/** tool_call_id から関数の名前を探す(nameFromToolCallID。後ろから見て最初に合ったもの)。 */
function nameFromToolCallId(messages: unknown[], id: string) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isObj(m) || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (isObj(tc) && tc.id === id && isObj(tc.function) && typeof tc.function.name === "string") return tc.function.name;
    }
  }
  return "";
}

function decodeImageUrl(url: string, index: number, ctx: Ctx): string | null {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    ctx.problems.push({ code: "imageRemote", severity: "error", index });
    return null;
  }
  let data: string | null = null;
  if (url.startsWith("data:;base64,")) data = url.slice("data:;base64,".length);
  else {
    const p = IMAGE_PREFIXES.find((x) => url.startsWith(x));
    if (p) data = url.slice(p.length);
  }
  if (data === null || !isStdBase64(data)) {
    ctx.problems.push({ code: "imageInvalid", severity: "error", index });
    return null;
  }
  return data;
}

/** 1つのメッセージに、空でない項目だけを Ollama の Message の順で並べる。 */
function ollamaMessage(m: { role: string; content?: string; thinking?: string; images?: string[]; tool_calls?: Obj[]; tool_name?: string; tool_call_id?: string }) {
  const out: Obj = { role: m.role, content: m.content ?? "" };
  if (m.thinking) out.thinking = m.thinking;
  if (m.images && m.images.length) out.images = m.images;
  if (m.tool_calls && m.tool_calls.length) out.tool_calls = m.tool_calls;
  if (m.tool_name) out.tool_name = m.tool_name;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  return out;
}

/** OpenAI の要求 → Ollama の /api/chat の要求(FromChatRequest)。 */
export function openaiToOllama(req: Obj): { output: Obj | null; problems: Problem[]; rows: MapRow[] } {
  const ctx: Ctx = { problems: [], rows: [] };
  const { problems, rows } = ctx;

  const ignored = Object.keys(req).filter((k) => !OPENAI_REQUEST_FIELDS.has(k));
  if ("max_completion_tokens" in req) problems.push({ code: "maxCompletionTokens", severity: "warn" });
  if (ignored.length) problems.push({ code: "ignoredFields", severity: "warn", detail: ignored.join(", ") });
  for (const k of ignored) rows.push({ from: k, to: null, note: "dropped" });

  if (typeof req.model !== "string" || !req.model.trim()) problems.push({ code: "modelMissing", severity: "warn" });
  const src = req.messages;
  if (!Array.isArray(src) || src.length === 0) {
    problems.push({ code: "messagesMissing", severity: "error" });
    return { output: null, problems, rows };
  }

  const messages: Obj[] = [];
  let split = false;
  for (let i = 0; i < src.length; i++) {
    const msg = src[i];
    const n = i + 1;
    if (!isObj(msg)) {
      problems.push({ code: "contentType", severity: "error", index: n });
      continue;
    }
    const role = typeof msg.role === "string" ? msg.role : "";
    const isTool = role.toLowerCase() === "tool";
    const toolCallId = typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
    let toolName = "";
    if (isTool) {
      toolName = typeof msg.name === "string" ? msg.name : "";
      if (!toolName && toolCallId) toolName = nameFromToolCallId(src, toolCallId);
    }
    const reasoning = typeof msg.reasoning === "string" ? msg.reasoning : "";
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    let content = msg.content;
    if (Array.isArray(content) && content.length === 0 && hasToolCalls) content = "";

    if (typeof content === "string") {
      const calls = toolCallsFromOpenai(msg.tool_calls, n, ctx);
      if (calls === null) continue;
      messages.push(ollamaMessage({ role, content, thinking: reasoning, tool_calls: calls, tool_name: toolName, tool_call_id: toolCallId }));
    } else if (Array.isArray(content)) {
      const start = messages.length;
      let failed = false;
      for (const part of content) {
        if (!isObj(part)) {
          problems.push({ code: "partType", severity: "error", index: n });
          failed = true;
          break;
        }
        if (part.type === "text") {
          if (typeof part.text !== "string") {
            problems.push({ code: "partType", severity: "error", index: n });
            failed = true;
            break;
          }
          messages.push(ollamaMessage({ role, content: part.text }));
        } else if (part.type === "image_url") {
          const iu = part.image_url;
          const url = isObj(iu) ? iu.url : iu;
          if (typeof url !== "string") {
            problems.push({ code: "partType", severity: "error", index: n });
            failed = true;
            break;
          }
          const data = decodeImageUrl(url, n, ctx);
          if (data === null) {
            failed = true;
            break;
          }
          messages.push(ollamaMessage({ role, images: [data] }));
        } else if (part.type === "input_audio") {
          const audio = isObj(part.input_audio) ? part.input_audio.data : undefined;
          if (typeof audio !== "string" || !isStdBase64(audio)) {
            problems.push({ code: "audioInvalid", severity: "error", index: n });
            failed = true;
            break;
          }
          messages.push(ollamaMessage({ role, images: [audio] }));
        } else {
          problems.push({ code: "partType", severity: "error", index: n });
          failed = true;
          break;
        }
      }
      if (failed) continue;
      const parts = messages.slice(start);
      if (isTool) {
        if (parts.some((p) => Array.isArray(p.images))) {
          for (const p of parts) {
            if (toolName) p.tool_name = toolName;
            if (toolCallId) p.tool_call_id = toolCallId;
          }
        } else if (parts.length > 0 || toolName || toolCallId) {
          const text = parts.map((p) => p.content as string).join("");
          messages.splice(start, parts.length, ollamaMessage({ role, content: text, tool_name: toolName, tool_call_id: toolCallId }));
        }
      }
      if (messages.length - start > 1) split = true;
      if (messages.length === start && !hasToolCalls) problems.push({ code: "emptyParts", severity: "warn", index: n });
      if (messages.length > 0 && hasToolCalls) {
        const calls = toolCallsFromOpenai(msg.tool_calls, n, ctx);
        if (calls === null) continue;
        const last = messages[messages.length - 1];
        const merged = ollamaMessage({
          role: last.role as string,
          content: last.content as string,
          images: last.images as string[] | undefined,
          thinking: reasoning,
          tool_calls: calls,
          tool_name: toolName,
          tool_call_id: toolCallId,
        });
        messages[messages.length - 1] = merged;
      }
    } else {
      if (msg.tool_calls === undefined || msg.tool_calls === null) {
        problems.push({ code: "contentType", severity: "error", index: n });
        continue;
      }
      const calls = toolCallsFromOpenai(msg.tool_calls, n, ctx);
      if (calls === null) continue;
      messages.push(ollamaMessage({ role, thinking: reasoning, tool_calls: calls, tool_call_id: toolCallId }));
    }
  }
  if (split) problems.push({ code: "imagesSplit", severity: "warn" });

  const options: Obj = {};
  const stop = req.stop;
  if (typeof stop === "string") {
    options.stop = [stop];
    rows.push({ from: "stop", to: "options.stop", note: "renamed" });
  } else if (Array.isArray(stop)) {
    const strs = stop.filter((s): s is string => typeof s === "string");
    if (strs.length !== stop.length) problems.push({ code: "stopNonString", severity: "warn" });
    options.stop = strs.length ? strs : null;
    rows.push({ from: "stop", to: "options.stop", note: "renamed" });
  } else if (stop !== undefined && stop !== null) {
    problems.push({ code: "stopNonString", severity: "warn" });
    rows.push({ from: "stop", to: null, note: "dropped" });
  }
  for (const [from, to, type] of OPENAI_TO_OPTION) {
    const v = req[from];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || (type === "int" && !isInt(v))) {
      problems.push({ code: "fieldType", severity: "error", detail: from });
      continue;
    }
    options[to] = v;
    rows.push({ from, to: `options.${to}`, note: "renamed" });
  }

  let format: unknown;
  if (req.response_format !== undefined && req.response_format !== null) {
    const rf = req.response_format;
    if (!isObj(rf)) problems.push({ code: "fieldType", severity: "error", detail: "response_format" });
    else {
      const type = typeof rf.type === "string" ? rf.type.trim().toLowerCase() : "";
      if (type === "json_object") {
        format = "json";
        rows.push({ from: "response_format", to: "format", note: "renamed" });
      } else if (type === "json_schema") {
        const schema = isObj(rf.json_schema) ? rf.json_schema.schema : undefined;
        if (schema === undefined || schema === null) {
          problems.push({ code: "schemaMissing", severity: "warn" });
          rows.push({ from: "response_format", to: null, note: "dropped" });
        } else {
          format = schema;
          rows.push({ from: "response_format.json_schema.schema", to: "format", note: "renamed" });
        }
      } else rows.push({ from: "response_format", to: null, note: "dropped" });
    }
  }

  let think: unknown;
  // reasoning があれば effort が無くても reasoning_effort は見ない(FromChatRequest の順)。
  const effort = isObj(req.reasoning)
    ? typeof req.reasoning.effort === "string"
      ? req.reasoning.effort
      : ""
    : typeof req.reasoning_effort === "string"
      ? req.reasoning_effort
      : "";
  const t = effortToThink(effort);
  if (t) {
    think = t.think;
    if (!t.known) problems.push({ code: "thinkUnknown", severity: "warn", detail: String(t.think) });
    rows.push({ from: isObj(req.reasoning) ? "reasoning.effort" : "reasoning_effort", to: "think", note: "renamed" });
  }

  if (req.stream !== undefined && typeof req.stream !== "boolean") problems.push({ code: "fieldType", severity: "error", detail: "stream" });
  const stream = req.stream === true;
  rows.push({ from: "stream", to: "stream", note: req.stream === undefined ? "default" : undefined });
  if (isObj(req.stream_options)) {
    problems.push({ code: "noEquivalent", severity: "warn", detail: "stream_options" });
    rows.push({ from: "stream_options", to: null, note: "dropped" });
  }

  const out: Obj = { model: typeof req.model === "string" ? req.model : "", messages };
  out.stream = stream;
  if (format !== undefined) out.format = format;
  if (Object.keys(options).length) out.options = options;
  if (think !== undefined) out.think = think;
  if (Array.isArray(req.tools) && req.tools.length) out.tools = req.tools;
  if (req.keep_alive !== undefined && req.keep_alive !== null) out.keep_alive = req.keep_alive;
  if (req.logprobs === true) out.logprobs = true;
  if (isInt(req.top_logprobs) && req.top_logprobs !== 0) out.top_logprobs = req.top_logprobs;
  if (req._debug_render_only === true) out._debug_render_only = true;

  if (problems.some((p) => p.severity === "error")) return { output: null, problems, rows };
  return { output: out, problems, rows };
}

/** Ollama の要求 → OpenAI 互換の要求(FromChatRequest の逆)。 */
export function ollamaToOpenai(req: Obj): { output: Obj | null; problems: Problem[]; rows: MapRow[] } {
  const problems: Problem[] = [];
  const rows: MapRow[] = [];

  const unknown = Object.keys(req).filter((k) => !OLLAMA_REQUEST_FIELDS.has(k));
  if (unknown.length) problems.push({ code: "ignoredFields", severity: "warn", detail: unknown.join(", ") });
  for (const k of unknown) rows.push({ from: k, to: null, note: "dropped" });
  const noEq: string[] = OLLAMA_ONLY_FIELDS.filter((k) => k in req);

  if (typeof req.model !== "string" || !req.model.trim()) problems.push({ code: "modelMissing", severity: "warn" });
  const src = req.messages;
  if (!Array.isArray(src) || src.length === 0) {
    problems.push({ code: "messagesMissing", severity: "error" });
    return { output: null, problems, rows };
  }

  let hasImages = false;
  const messages: Obj[] = [];
  for (let i = 0; i < src.length; i++) {
    const m = src[i];
    const n = i + 1;
    if (!isObj(m) || (m.content !== undefined && typeof m.content !== "string")) {
      problems.push({ code: "contentType", severity: "error", index: n });
      continue;
    }
    const out: Obj = { role: typeof m.role === "string" ? m.role : "" };
    const text = typeof m.content === "string" ? m.content : "";
    const images = Array.isArray(m.images) ? m.images : [];
    if (images.length) {
      hasImages = true;
      const parts: Obj[] = [];
      if (text) parts.push({ type: "text", text });
      for (const img of images) {
        if (typeof img !== "string" || !isStdBase64(img)) {
          problems.push({ code: "imageInvalid", severity: "error", index: n });
          continue;
        }
        parts.push({ type: "image_url", image_url: { url: `data:;base64,${img}` } });
      }
      out.content = parts;
    } else out.content = text;
    if (typeof m.thinking === "string" && m.thinking) out.reasoning = m.thinking;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls: Obj[] = [];
      for (const tc of m.tool_calls) {
        const fn = isObj(tc) && isObj(tc.function) ? tc.function : null;
        if (!fn || !isObj(fn.arguments)) {
          problems.push({ code: "toolArgsObject", severity: "error", index: n });
          continue;
        }
        const call: Obj = {};
        if (isObj(tc) && typeof tc.id === "string" && tc.id) call.id = tc.id;
        call.type = "function";
        call.function = { name: typeof fn.name === "string" ? fn.name : "", arguments: JSON.stringify(fn.arguments) };
        calls.push(call);
      }
      out.tool_calls = calls;
    }
    if (typeof m.tool_name === "string" && m.tool_name) out.name = m.tool_name;
    if (typeof m.tool_call_id === "string" && m.tool_call_id) out.tool_call_id = m.tool_call_id;
    messages.push(out);
  }
  if (hasImages) problems.push({ code: "imagesSplit", severity: "warn" });

  const out: Obj = { model: typeof req.model === "string" ? req.model : "", messages };

  if (req.stream !== undefined && typeof req.stream !== "boolean") problems.push({ code: "fieldType", severity: "error", detail: "stream" });
  out.stream = req.stream !== false;
  rows.push({ from: "stream", to: "stream", note: req.stream === undefined ? "default" : undefined });

  if (req.options !== undefined && req.options !== null) {
    if (!isObj(req.options)) problems.push({ code: "fieldType", severity: "error", detail: "options" });
    else {
      for (const [k, v] of Object.entries(req.options)) {
        const to = OPTION_TO_OPENAI[k];
        if (!to) {
          noEq.push(`options.${k}`);
          continue;
        }
        if (k === "stop") {
          if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
            problems.push({ code: "fieldType", severity: "error", detail: "options.stop" });
            continue;
          }
        } else if (typeof v !== "number" || ((k === "num_predict" || k === "seed") && !isInt(v))) {
          problems.push({ code: "fieldType", severity: "error", detail: `options.${k}` });
          continue;
        }
        out[to] = v;
        rows.push({ from: `options.${k}`, to, note: "renamed" });
      }
    }
  }

  if (req.format !== undefined && req.format !== null && req.format !== "") {
    if (req.format === "json") {
      out.response_format = { type: "json_object" };
      rows.push({ from: "format", to: "response_format", note: "renamed" });
    } else if (isObj(req.format)) {
      out.response_format = { type: "json_schema", json_schema: { schema: req.format } };
      rows.push({ from: "format", to: "response_format.json_schema.schema", note: "renamed" });
    } else problems.push({ code: "formatInvalid", severity: "error" });
  }

  if (req.think !== undefined && req.think !== null) {
    if (req.think === false) {
      out.reasoning_effort = "none";
      rows.push({ from: "think", to: "reasoning_effort", note: "renamed" });
    } else if (typeof req.think === "string") {
      out.reasoning_effort = req.think;
      rows.push({ from: "think", to: "reasoning_effort", note: "renamed" });
    } else if (req.think === true) {
      problems.push({ code: "thinkTrue", severity: "warn" });
      rows.push({ from: "think", to: null, note: "dropped" });
    } else problems.push({ code: "fieldType", severity: "error", detail: "think" });
  }

  if (Array.isArray(req.tools) && req.tools.length) out.tools = req.tools;
  if (req.keep_alive !== undefined && req.keep_alive !== null) out.keep_alive = req.keep_alive;
  if (req.logprobs === true) out.logprobs = true;
  if (isInt(req.top_logprobs) && req.top_logprobs !== 0) out.top_logprobs = req.top_logprobs;
  if (req._debug_render_only === true) out._debug_render_only = true;

  if (noEq.length) {
    problems.push({ code: "noEquivalent", severity: "warn", detail: noEq.join(", ") });
    for (const k of noEq) rows.push({ from: k, to: null, note: "dropped" });
  }

  if (problems.some((p) => p.severity === "error")) return { output: null, problems, rows };
  return { output: out, problems, rows };
}

/** Go の time.Time の文字(RFC 3339、小数9桁まで)→ Unix 秒。 */
export function unixSeconds(s: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(s);
  if (!m) return null;
  const t = Date.parse(`${m[1]}${m[3]}`);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

/** Ollama の /api/chat の応答(stream しないもの)→ OpenAI 互換の応答(ToChatCompletion)。 */
export function ollamaResponseToOpenai(res: Obj): { output: Obj | null; problems: Problem[]; rows: MapRow[] } {
  const problems: Problem[] = [];
  const rows: MapRow[] = [];
  if (res.done === false) {
    problems.push({ code: "streamResponse", severity: "error" });
    return { output: null, problems, rows };
  }
  const msg = isObj(res.message) ? res.message : {};
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const toolCalls: Obj[] = [];
  for (const tc of rawCalls) {
    const fn = isObj(tc) && isObj(tc.function) ? tc.function : {};
    toolCalls.push({
      id: isObj(tc) && typeof tc.id === "string" ? tc.id : "",
      index: isInt(fn.index) ? fn.index : 0,
      type: "function",
      function: { name: typeof fn.name === "string" ? fn.name : "", arguments: goJson(fn.arguments ?? {}) },
    });
  }
  let reason = typeof res.done_reason === "string" ? res.done_reason : "";
  if (reason === "stop" && toolCalls.length > 0) reason = "tool_calls";

  let created = 0;
  const c = typeof res.created_at === "string" ? unixSeconds(res.created_at) : null;
  if (c === null) problems.push({ code: "createdAtMissing", severity: "warn" });
  else created = c;

  const message: Obj = { role: typeof msg.role === "string" ? msg.role : "", content: typeof msg.content === "string" ? msg.content : "" };
  if (typeof msg.thinking === "string" && msg.thinking) message.reasoning = msg.thinking;
  if (toolCalls.length) message.tool_calls = toolCalls;

  const choice: Obj = { index: 0, message, finish_reason: reason || null };
  if (Array.isArray(res.logprobs) && res.logprobs.length) choice.logprobs = { content: res.logprobs };

  const prompt = isInt(res.prompt_eval_count) ? (res.prompt_eval_count as number) : 0;
  const completion = isInt(res.eval_count) ? (res.eval_count as number) : 0;
  const usage: Obj = { prompt_tokens: prompt };
  if (isInt(res.prompt_eval_cached_count)) usage.prompt_tokens_details = { cached_tokens: res.prompt_eval_cached_count };
  usage.completion_tokens = completion;
  usage.total_tokens = prompt + completion;

  const out: Obj = {
    id: "chatcmpl-0",
    object: "chat.completion",
    created,
    model: typeof res.model === "string" ? res.model : "",
    system_fingerprint: "fp_ollama",
    choices: [choice],
    usage,
  };
  if (isObj(res._debug_info)) out._debug_info = res._debug_info;

  rows.push(
    { from: "created_at", to: "created", note: "renamed" },
    { from: "message", to: "choices[0].message", note: "renamed" },
    { from: "message.thinking", to: "choices[0].message.reasoning", note: "renamed" },
    { from: "done_reason", to: "choices[0].finish_reason", note: "renamed" },
    { from: "prompt_eval_count", to: "usage.prompt_tokens", note: "renamed" },
    { from: "eval_count", to: "usage.completion_tokens", note: "renamed" },
  );
  for (const k of ["total_duration", "load_duration", "prompt_eval_duration", "eval_duration"]) if (k in res) rows.push({ from: k, to: null, note: "dropped" });
  return { output: out, problems, rows };
}

/** 貼られた文字を読み、選んだ向き(auto なら見分けた向き)に書き換える。 */
export function convert(text: string, mode: Mode): ConvertResult {
  const empty = (problems: Problem[], kind: Kind | null = null, detected = false): ConvertResult => ({
    problems,
    kind,
    detected,
    output: null,
    json: "",
    curl: "",
    rows: [],
  });
  if (!text.trim()) return empty([{ code: "inputEmpty", severity: "error" }]);
  // ストリーミングの応答を丸ごと貼ったもの(/v1 の「data:」の行、または done を持つ JSON が1行ずつ)。
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const ndjson =
    lines.length > 1 &&
    lines.every((l) => {
      try {
        const o = JSON.parse(l);
        return isObj(o) && typeof o.done === "boolean";
      } catch {
        return false;
      }
    });
  if (ndjson || lines.some((l) => /^data:/.test(l.trim()))) return empty([{ code: "streamResponse", severity: "error" }]);
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return empty([{ code: "inputJson", severity: "error" }]);
  }
  if (!isObj(v)) return empty([{ code: "inputNotObject", severity: "error" }]);

  let kind: Kind;
  let detected = false;
  if (mode === "auto") {
    const d = detectKind(v);
    if (d === "openaiResponse") return empty([{ code: "openaiResponse", severity: "error" }]);
    if (d === null) return empty([{ code: "kindUnknown", severity: "error" }]);
    kind = d;
    detected = true;
  } else kind = mode;

  const r = kind === "openaiRequest" ? openaiToOllama(v) : kind === "ollamaRequest" ? ollamaToOpenai(v) : ollamaResponseToOpenai(v);
  if (!r.output) return { ...empty(r.problems, kind, detected), rows: r.rows };
  const json = JSON.stringify(r.output, null, 2);
  const compact = JSON.stringify(r.output);
  const curl = kind === "openaiRequest" ? curlFor("/api/chat", compact, false) : kind === "ollamaRequest" ? curlFor("/v1/chat/completions", compact, true) : "";
  return { problems: r.problems, kind, detected, output: r.output, json, curl, rows: r.rows };
}
