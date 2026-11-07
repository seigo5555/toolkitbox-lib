/**
 * Ollama のストリーミング応答(細切れで届く応答)を読み、文章・考えた過程・ツール呼び出しをつなぎ直して、速度を出す。
 *
 * 読めるもの:
 *  - /api/chat と /api/generate: 1行に1つの JSON(application/x-ndjson)。最後の行が done: true で、
 *    そこにだけ時間とトークン数が付く(docs.ollama.com/api/streaming と /api/usage)
 *  - /v1/chat/completions(stream: true): server-sent events。「data: {…}」の行が並び、最後が「data: [DONE]」。
 *    書き出し方は ollama/ollama v0.40.15 の middleware/openai.go(ChatWriter.writeResponse)と openai/openai.go
 *    (ToStreamChunks・FinishChunk・ToUsage・ToTimings)。v0.40.11 からこの部分は変わっていない
 *  - stream: false の応答や、curl -i で付いた HTTP の見出し、エラーの本文も受け付けて、そうだと知らせる
 *
 * 事実の出どころ:
 *  - 時間はナノ秒。prompt_eval_duration は「キャッシュに無かった分の」プロンプトの処理時間(docs.ollama.com/api/usage)。
 *    だからプロンプトの処理速度は (prompt_eval_count − prompt_eval_cached_count) ÷ prompt_eval_duration で出す
 *  - /v1 の timings.prompt_per_second は prompt_n(キャッシュ分も含む)× 1000 ÷ prompt_ms(ToTimings)。
 *    キャッシュが効いていると実際より速く見える。prompt_ms・predicted_ms はミリ秒に切り捨てた整数
 *  - usage は stream_options.include_usage を付けたときだけ、choices が空の最後の塊に付く(ChatWriter と、
 *    OpenAI のリファレンス developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)
 *  - OpenAI 形式のツール呼び出しは index ごとに arguments の文字列が分かれて届くことがある(同じリファレンスで index だけが必須)。
 *    Ollama は1つの塊に全部入れて送る
 *  - エラーは、何も送る前なら HTTP の状態コード付きの JSON、送り始めた後なら {"error": "…"} の行で止まる(server/routes.go の streamResponse)
 *
 * 2026-11-07 に手元の Ollama 0.40.11 と qwen2.5:7b で、上の3つの入口から本物の出力を取って確かめた(scripts/check-ollama-stream.ts)。
 * ツールを呼んだときは、呼び出しの中身が文章として流れてこないのに eval_count には数えられる(1塊で eval_count 20)。
 */

export const OLLAMA_STREAM_VERIFIED_ON = "2026-11-07";
export const OLLAMA_STREAM_DOC_URL = "https://docs.ollama.com/api/streaming";
export const OLLAMA_STREAM_SOURCE_VERSION = "v0.40.15";

export type StreamKind = "ollamaChat" | "ollamaGenerate" | "openaiChat";

export type ProblemCode =
  | "inputEmpty"
  | "lineJson"
  | "lineNotObject"
  | "lineUnknown"
  | "mixedKinds"
  | "eventStream"
  | "serverError"
  | "httpStatus"
  | "notStreamed"
  | "noDone"
  | "noDoneMarker"
  | "noFinishReason"
  | "afterDone"
  | "doneLength"
  | "doneOther"
  | "noUsage"
  | "argsNotJson"
  | "toolNoName"
  | "idChanged"
  | "modelChanged"
  | "otherChoices"
  | "emptyOutput"
  | "promptPerSecondCached";

export type Severity = "error" | "warn" | "info";
/** index は入力の行番号(1から)。 */
export type Problem = { code: ProblemCode; severity: Severity; index?: number; detail?: string };

export type ToolCallOut = {
  index: number;
  id: string;
  name: string;
  /** 引数を JSON として読めたもの。読めなければ null。 */
  args: unknown;
  /** 届いた引数そのまま(/api/chat はオブジェクトを JSON にしたもの)。 */
  argsText: string;
  argsValid: boolean;
};

export type StreamStats = {
  /** 中身のある塊の数(/v1 は data: の行。[DONE] は数えない)。 */
  chunks: number;
  evalCount: number | null;
  evalSec: number | null;
  /** 生成の速さ(トークン/秒)。 */
  genTps: number | null;
  promptCount: number | null;
  promptCached: number | null;
  promptSec: number | null;
  /** キャッシュに無かった分だけで割ったプロンプトの処理速度。 */
  promptTps: number | null;
  /** /v1 の timings.prompt_per_second(キャッシュ分も含めて割った値)。 */
  reportedPromptTps: number | null;
  loadSec: number | null;
  totalSec: number | null;
  /** 最初の塊から最後の塊までの created_at の差(Ollama の形だけ)。 */
  spanSec: number | null;
};

export type ReadResult = {
  problems: Problem[];
  kind: StreamKind | null;
  streamed: boolean;
  model: string;
  content: string;
  thinking: string;
  toolCalls: ToolCallOut[];
  /** done_reason か finish_reason。 */
  finish: string | null;
  stats: StreamStats | null;
  /** 次の要求の messages に足す assistant のメッセージ(/api/generate では null)。 */
  message: Record<string, unknown> | null;
  messageJson: string;
};

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const snippet = (s: string) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);

/** 時間(ナノ秒)を秒に。 */
const nsToSec = (v: unknown) => {
  const n = num(v);
  return n === null ? null : n / 1e9;
};

const rate = (count: number | null, sec: number | null) => (count !== null && sec !== null && sec > 0 && count >= 0 ? count / sec : null);

/** created_at(RFC 3339、小数はナノ秒まで)をミリ秒に。小数第3位より下は捨てる。 */
export function parseCreatedAt(s: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? "").padEnd(3, "0").slice(0, 3);
  const t = Date.parse(`${m[1]}.${frac}${m[3]}`);
  return Number.isNaN(t) ? null : t;
}

/** 1つの JSON の塊がどの形か。エラーの本文は "error"。 */
export function chunkKind(o: Obj): StreamKind | "error" | "openaiWhole" | null {
  if ("error" in o && !("choices" in o) && !("message" in o)) return "error";
  if (Array.isArray(o.choices)) {
    if (o.object === "chat.completion") return "openaiWhole";
    return "openaiChat";
  }
  if (typeof o.response === "string") return "ollamaGenerate";
  if (isObj(o.message) || typeof o.done === "boolean") return "ollamaChat";
  return null;
}

function errorMessage(o: Obj): string {
  const e = o.error;
  if (typeof e === "string") return e;
  if (isObj(e) && typeof e.message === "string") return e.message;
  return JSON.stringify(e);
}

type Line = { no: number; text: string };

/** curl -i の見出しを外す。状態コードがあれば返す。 */
export function stripHttpHeaders(lines: Line[]): { lines: Line[]; status: number | null } {
  const first = lines.find((l) => l.text.trim() !== "");
  if (!first || !/^HTTP\/[\d.]+ \d{3}/.test(first.text.trim())) return { lines, status: null };
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(first.text.trim())![1]);
  const start = lines.indexOf(first);
  let end = start;
  while (end < lines.length && lines[end].text.trim() !== "") end++;
  return { lines: lines.slice(end + 1), status };
}

class Acc {
  problems: Problem[] = [];
  seen = new Set<ProblemCode>();
  kind: StreamKind | null = null;
  model = "";
  content = "";
  thinking = "";
  ndjsonCalls: ToolCallOut[] = [];
  sseCalls = new Map<number, { id: string; name: string; args: string }>();
  finish: string | null = null;
  chunks = 0;

  add(code: ProblemCode, severity: Severity, index?: number, detail?: string, once = true) {
    if (once && this.seen.has(code)) return;
    this.seen.add(code);
    this.problems.push({ code, severity, index, detail });
  }

  setKind(k: StreamKind, no: number) {
    if (this.kind === null) this.kind = k;
    else if (this.kind !== k) this.add("mixedKinds", "error", no);
  }

  setModel(m: unknown, no: number) {
    const s = str(m);
    if (!s) return;
    if (!this.model) this.model = s;
    else if (this.model !== s) this.add("modelChanged", "warn", no, s);
  }
}

function ollamaToolCalls(calls: unknown, acc: Acc, no: number) {
  if (!Array.isArray(calls)) return;
  for (const c of calls) {
    if (!isObj(c)) continue;
    const f = isObj(c.function) ? c.function : {};
    const name = str(f.name);
    const argsText = f.arguments === undefined ? "{}" : JSON.stringify(f.arguments);
    if (!name) acc.add("toolNoName", "error", no);
    acc.ndjsonCalls.push({
      index: num(f.index) ?? acc.ndjsonCalls.length,
      id: str(c.id),
      name,
      args: f.arguments === undefined ? {} : f.arguments,
      argsText,
      argsValid: true,
    });
  }
}

function readOllama(lines: Line[], acc: Acc): { final: Obj | null; firstAt: number | null; lastAt: number | null } {
  let final: Obj | null = null;
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  for (const l of lines) {
    const t = l.text.trim();
    if (!t) continue;
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      acc.add("lineJson", "error", l.no, snippet(t), false);
      continue;
    }
    if (!isObj(v)) {
      acc.add("lineNotObject", "error", l.no);
      continue;
    }
    const k = chunkKind(v);
    if (k === "error") {
      acc.add("serverError", "error", l.no, errorMessage(v));
      continue;
    }
    if (k !== "ollamaChat" && k !== "ollamaGenerate") {
      acc.add("lineUnknown", "error", l.no, snippet(t), false);
      continue;
    }
    acc.setKind(k, l.no);
    if (final) acc.add("afterDone", "warn", l.no);
    acc.chunks++;
    acc.setModel(v.model, l.no);
    const at = parseCreatedAt(str(v.created_at));
    if (at !== null) {
      if (firstAt === null) firstAt = at;
      lastAt = at;
    }
    if (k === "ollamaChat") {
      const m = isObj(v.message) ? v.message : {};
      acc.content += str(m.content);
      acc.thinking += str(m.thinking);
      ollamaToolCalls(m.tool_calls, acc, l.no);
    } else {
      acc.content += str(v.response);
      acc.thinking += str(v.thinking);
      ollamaToolCalls(v.tool_calls, acc, l.no);
    }
    if (v.done === true && !final) {
      final = v;
      acc.finish = typeof v.done_reason === "string" && v.done_reason ? v.done_reason : null;
    }
  }
  return { final, firstAt, lastAt };
}

function readSse(lines: Line[], acc: Acc): { usage: Obj | null; timings: Obj | null; doneMarker: boolean } {
  let usage: Obj | null = null;
  let timings: Obj | null = null;
  let doneMarker = false;
  let id = "";
  for (const l of lines) {
    const raw = l.text.replace(/\r$/, "");
    if (raw.trim() === "") continue;
    if (raw.startsWith(":")) continue;
    if (raw.startsWith("event:")) {
      acc.add("eventStream", "error", l.no, raw.slice(6).trim());
      continue;
    }
    if (raw.startsWith("id:") || raw.startsWith("retry:")) continue;
    let payload: string;
    if (raw.startsWith("data:")) {
      payload = raw.slice(5);
      if (payload.startsWith(" ")) payload = payload.slice(1);
    } else {
      // data: の付かない行。エラーの本文(HTTP の状態が 200 以外のとき)ならそう知らせる。
      try {
        const v = JSON.parse(raw);
        if (isObj(v) && chunkKind(v) === "error") {
          acc.add("serverError", "error", l.no, errorMessage(v));
          continue;
        }
      } catch {
        /* 下で知らせる */
      }
      acc.add("lineUnknown", "error", l.no, snippet(raw.trim()), false);
      continue;
    }
    if (payload.trim() === "[DONE]") {
      doneMarker = true;
      continue;
    }
    let v: unknown;
    try {
      v = JSON.parse(payload);
    } catch {
      acc.add("lineJson", "error", l.no, snippet(payload.trim()), false);
      continue;
    }
    if (!isObj(v)) {
      acc.add("lineNotObject", "error", l.no);
      continue;
    }
    const k = chunkKind(v);
    if (k === "error") {
      acc.add("serverError", "error", l.no, errorMessage(v));
      continue;
    }
    if (k !== "openaiChat") {
      acc.add("lineUnknown", "error", l.no, snippet(payload.trim()), false);
      continue;
    }
    acc.setKind("openaiChat", l.no);
    if (doneMarker) acc.add("afterDone", "warn", l.no);
    acc.chunks++;
    acc.setModel(v.model, l.no);
    const cid = str(v.id);
    if (cid) {
      if (!id) id = cid;
      else if (id !== cid) acc.add("idChanged", "warn", l.no, cid);
    }
    if (isObj(v.usage)) usage = v.usage;
    if (isObj(v.timings)) timings = v.timings;
    for (const ch of v.choices as unknown[]) {
      if (!isObj(ch)) continue;
      const ci = num(ch.index) ?? 0;
      if (ci !== 0) {
        acc.add("otherChoices", "warn", l.no);
        continue;
      }
      const d = isObj(ch.delta) ? ch.delta : {};
      acc.content += str(d.content);
      acc.thinking += str(d.reasoning);
      if (Array.isArray(d.tool_calls)) {
        d.tool_calls.forEach((tc, pos) => {
          if (!isObj(tc)) return;
          const i = num(tc.index) ?? pos;
          const slot = acc.sseCalls.get(i) ?? { id: "", name: "", args: "" };
          if (typeof tc.id === "string" && tc.id && !slot.id) slot.id = tc.id;
          const f = isObj(tc.function) ? tc.function : {};
          if (typeof f.name === "string" && f.name && !slot.name) slot.name = f.name;
          if (typeof f.arguments === "string") slot.args += f.arguments;
          acc.sseCalls.set(i, slot);
        });
      }
      if (typeof ch.finish_reason === "string" && ch.finish_reason) acc.finish = ch.finish_reason;
    }
  }
  return { usage, timings, doneMarker };
}

function sseToolCalls(acc: Acc): ToolCallOut[] {
  return [...acc.sseCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, s]) => {
      let args: unknown = null;
      let argsValid = true;
      if (s.args.trim() === "") args = {};
      else {
        try {
          args = JSON.parse(s.args);
        } catch {
          argsValid = false;
          acc.add("argsNotJson", "error", undefined, s.name || `#${index}`, false);
        }
      }
      if (!s.name) acc.add("toolNoName", "error");
      return { index, id: s.id, name: s.name, args, argsText: s.args, argsValid };
    });
}

function ollamaStats(final: Obj | null, chunks: number, firstAt: number | null, lastAt: number | null): StreamStats {
  const f = final ?? {};
  const evalCount = num(f.eval_count);
  const evalSec = nsToSec(f.eval_duration);
  const promptCount = num(f.prompt_eval_count);
  const promptCached = num(f.prompt_eval_cached_count);
  const promptSec = nsToSec(f.prompt_eval_duration);
  const uncached = promptCount === null ? null : promptCount - (promptCached ?? 0);
  return {
    chunks,
    evalCount,
    evalSec,
    genTps: rate(evalCount, evalSec),
    promptCount,
    promptCached,
    promptSec,
    promptTps: rate(uncached, promptSec),
    reportedPromptTps: null,
    loadSec: nsToSec(f.load_duration),
    totalSec: nsToSec(f.total_duration),
    spanSec: firstAt !== null && lastAt !== null && chunks > 1 ? (lastAt - firstAt) / 1000 : null,
  };
}

function openaiStats(usage: Obj | null, timings: Obj | null, chunks: number): StreamStats {
  const u = usage ?? {};
  const t = timings ?? {};
  const details = isObj(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
  const evalCount = num(u.completion_tokens) ?? num(t.predicted_n);
  const promptCount = num(u.prompt_tokens) ?? num(t.prompt_n);
  const promptCached = num(details.cached_tokens);
  const evalMs = num(t.predicted_ms);
  const promptMs = num(t.prompt_ms);
  const evalSec = evalMs === null ? null : evalMs / 1000;
  const promptSec = promptMs === null ? null : promptMs / 1000;
  const predictedN = num(t.predicted_n) ?? evalCount;
  const promptN = num(t.prompt_n) ?? promptCount;
  return {
    chunks,
    evalCount,
    evalSec,
    genTps: rate(predictedN, evalSec),
    promptCount,
    promptCached,
    promptSec,
    promptTps: rate(promptN === null ? null : promptN - (promptCached ?? 0), promptSec),
    reportedPromptTps: num(t.prompt_per_second),
    loadSec: null,
    totalSec: null,
    spanSec: null,
  };
}

function buildMessage(kind: StreamKind | null, acc: Acc, calls: ToolCallOut[]): Record<string, unknown> | null {
  if (kind === "ollamaChat") {
    const m: Obj = { role: "assistant", content: acc.content };
    if (acc.thinking) m.thinking = acc.thinking;
    if (calls.length)
      m.tool_calls = calls.map((c) => {
        const out: Obj = {};
        if (c.id) out.id = c.id;
        out.function = { index: c.index, name: c.name, arguments: c.args ?? {} };
        return out;
      });
    return m;
  }
  if (kind === "openaiChat") {
    const m: Obj = { role: "assistant", content: acc.content };
    // reasoning は Ollama の項目。Ollama は要求の reasoning を thinking として読み戻す(openai.go の FromChatRequest)。
    if (acc.thinking) m.reasoning = acc.thinking;
    if (calls.length)
      m.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.argsText } }));
    return m;
  }
  return null;
}

/** stream: false の応答1つ(Ollama か OpenAI の形)を読む。 */
function readWhole(v: Obj, k: ReturnType<typeof chunkKind>, acc: Acc): ReadResult | null {
  if (k === "openaiWhole") {
    const ch = (v.choices as unknown[]).find((c) => isObj(c) && (num(c.index) ?? 0) === 0);
    const m = isObj(ch) && isObj(ch.message) ? ch.message : {};
    acc.kind = "openaiChat";
    acc.setModel(v.model, 1);
    acc.chunks = 1;
    acc.content = str(m.content);
    acc.thinking = str(m.reasoning);
    if (Array.isArray(m.tool_calls))
      m.tool_calls.forEach((tc, pos) => {
        if (!isObj(tc)) return;
        const f = isObj(tc.function) ? tc.function : {};
        acc.sseCalls.set(num(tc.index) ?? pos, { id: str(tc.id), name: str(f.name), args: str(f.arguments) });
      });
    if (isObj(ch) && typeof ch.finish_reason === "string") acc.finish = ch.finish_reason;
    acc.add("notStreamed", "info");
    const calls = sseToolCalls(acc);
    const stats = openaiStats(isObj(v.usage) ? v.usage : null, isObj(v.timings) ? v.timings : null, 1);
    return finish(acc, calls, stats, true, false);
  }
  return null;
}

function finish(acc: Acc, calls: ToolCallOut[], stats: StreamStats | null, done: boolean, streamed: boolean): ReadResult {
  if (done) {
    if (acc.finish === "length") acc.add("doneLength", "warn");
    else if (acc.finish && acc.finish !== "stop" && acc.finish !== "tool_calls") acc.add("doneOther", "warn", undefined, acc.finish);
    if (!acc.content && !acc.thinking && calls.length === 0) acc.add("emptyOutput", "warn");
  }
  const message = acc.problems.some((p) => p.code === "mixedKinds") ? null : buildMessage(acc.kind, acc, calls);
  return {
    problems: acc.problems,
    kind: acc.kind,
    streamed,
    model: acc.model,
    content: acc.content,
    thinking: acc.thinking,
    toolCalls: calls,
    finish: acc.finish,
    stats,
    message,
    messageJson: message ? JSON.stringify(message, null, 2) : "",
  };
}

const EMPTY: Omit<ReadResult, "problems"> = {
  kind: null,
  streamed: false,
  model: "",
  content: "",
  thinking: "",
  toolCalls: [],
  finish: null,
  stats: null,
  message: null,
  messageJson: "",
};

export function readStream(text: string): ReadResult {
  const acc = new Acc();
  const src = text.replace(/^﻿/, "");
  if (src.trim() === "") return { ...EMPTY, problems: [{ code: "inputEmpty", severity: "error" }] };

  let lines: Line[] = src.split(/\r?\n/).map((t, i) => ({ no: i + 1, text: t }));
  const h = stripHttpHeaders(lines);
  lines = h.lines;
  if (h.status !== null && h.status !== 200) acc.add("httpStatus", "error", undefined, String(h.status));

  const body = lines.map((l) => l.text).join("\n").trim();
  const isSse = lines.some((l) => /^(data|event):/.test(l.text));

  // 1つの JSON(stream: false の応答・整形した応答・エラーの本文)。
  if (!isSse && body) {
    let whole: unknown;
    try {
      whole = JSON.parse(body);
    } catch {
      whole = undefined;
    }
    const multiLine = lines.filter((l) => l.text.trim() !== "").length > 1;
    if (isObj(whole) && (multiLine || chunkKind(whole) !== "ollamaChat" || whole.done === true || chunkKind(whole) === "error")) {
      const k = chunkKind(whole);
      if (k === "error") {
        acc.add("serverError", "error", undefined, errorMessage(whole));
        return { ...EMPTY, problems: acc.problems };
      }
      const r = readWhole(whole, k, acc);
      if (r) return r;
      if ((k === "ollamaChat" || k === "ollamaGenerate") && whole.done === true && multiLine) {
        // 整形された stream: false の応答。1行にして読む。
        acc.add("notStreamed", "info");
        const one = [{ no: 1, text: JSON.stringify(whole) }];
        const o = readOllama(one, acc);
        const calls = acc.ndjsonCalls;
        return finish(acc, calls, ollamaStats(o.final, acc.chunks, o.firstAt, o.lastAt), true, false);
      }
    }
  }

  if (isSse) {
    const s = readSse(lines, acc);
    const calls = sseToolCalls(acc);
    if (acc.kind === null) return { ...EMPTY, problems: acc.problems };
    if (!s.doneMarker) acc.add("noDoneMarker", "error");
    if (!acc.finish && acc.chunks > 0) acc.add("noFinishReason", "warn");
    if (!s.usage) acc.add("noUsage", "info");
    const stats = openaiStats(s.usage, s.timings, acc.chunks);
    if (stats.reportedPromptTps !== null && (stats.promptCached ?? 0) > 0) acc.add("promptPerSecondCached", "info");
    return finish(acc, calls, stats, s.doneMarker, true);
  }

  const o = readOllama(lines, acc);
  if (acc.kind === null) {
    if (acc.problems.length === 0) acc.add("lineUnknown", "error", undefined, snippet(body));
    return { ...EMPTY, problems: acc.problems };
  }
  const streamed = acc.chunks > 1;
  if (!o.final) acc.add("noDone", "error");
  else if (!streamed) acc.add("notStreamed", "info");
  return finish(acc, acc.ndjsonCalls, ollamaStats(o.final, acc.chunks, o.firstAt, o.lastAt), o.final !== null, streamed);
}
