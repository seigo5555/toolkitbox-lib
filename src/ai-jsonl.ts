/**
 * AI API に渡す JSONL(OpenAI Batch の入力、Anthropic Message Batches のリクエスト、
 * OpenAI のチャットのファインチューニング用データ)の誤りを調べる。LLM は呼ばない。
 * ブラウザの中だけで完結する。
 *
 * **ここに書く規則は、公式ドキュメントに書かれていることだけ。** 確認元と日付は `SOURCES` と
 * `VERIFIED_ON`。規則を足し引きするときは、公式の文面を確かめて `VERIFIED_ON` を更新する。
 *  - OpenAI Batch: custom_id は必須で重複不可、url は決まったエンドポイントだけ、1ファイルは1モデルだけ、
 *    stream=true は拒否、/v1/moderations は body.input が必要、1バッチ50,000件・入力ファイル200MB、
 *    /v1/embeddings は全リクエストの入力が合計50,000まで
 *  - Anthropic Message Batches: custom_id は ^[a-zA-Z0-9_-]{1,64}$ で重複不可、params にメッセージのパラメータ、
 *    stream:true・speed・fallbacks・max_tokens:0 はバリデーションエラー、1バッチ100,000件または256MB
 *    (API は JSONL ファイルではなく requests の配列を受け取る。1行を配列の1要素として扱う)
 *  - OpenAI のファインチューニング: 1行に完結した JSON、messages 配列、10行以上、weight は 0 か 1 で
 *    assistant のメッセージに付ける
 *
 * 公式に書かれていないことは断定しない。モデル名・パラメータの中身・トークン数・ネットワークは調べられない
 * ので、画面に「調べていない」と出す。
 */

export const VERIFIED_ON = "2026-10-23";

export type Format = "openaiBatch" | "anthropicBatch" | "openaiFineTune";
export const FORMATS: Format[] = ["openaiBatch", "anthropicBatch", "openaiFineTune"];

export const SOURCES: Record<Format, string> = {
  openaiBatch: "https://developers.openai.com/api/docs/guides/batch",
  anthropicBatch: "https://platform.claude.com/docs/en/build-with-claude/batch-processing",
  openaiFineTune: "https://developers.openai.com/api/docs/guides/supervised-fine-tuning",
};

export const LIMITS = {
  openaiBatch: { requests: 50000, bytes: 200 * 1024 * 1024, embeddingInputs: 50000 },
  anthropicBatch: { requests: 100000, bytes: 256 * 1024 * 1024 },
  openaiFineTune: { minLines: 10 },
} as const;

/** OpenAI Batch が受け付けると書かれているエンドポイント。 */
export const OPENAI_BATCH_ENDPOINTS = [
  "/v1/responses",
  "/v1/chat/completions",
  "/v1/embeddings",
  "/v1/completions",
  "/v1/moderations",
  "/v1/images/generations",
  "/v1/images/edits",
] as const;

export const ANTHROPIC_CUSTOM_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/** Anthropic の Message Batches で、含めるとバリデーションエラーになると書かれているパラメータ。 */
export const ANTHROPIC_BATCH_REJECTED = ["stream", "speed", "fallbacks", "max_tokens"] as const;

export type Severity = "error" | "warn" | "info";

export type FindingCode =
  | "bom"
  | "emptyLine"
  | "notJson"
  | "notObject"
  | "prettyPrinted"
  | "noRecords"
  | "limitRequests"
  | "limitSize"
  | "noCustomId"
  | "badCustomId"
  | "duplicateCustomId"
  | "badUrl"
  | "noBody"
  | "multipleModels"
  | "streamTrue"
  | "moderationNoInput"
  | "limitEmbeddings"
  | "noParams"
  | "rejectedParam"
  | "minLines"
  | "noMessages"
  | "messageNotObject"
  | "noRole"
  | "badWeight"
  | "weightNotAssistant"
  | "noAssistant"
  | "noContent"
  | "arrayForm";

export const FINDING_CODES: FindingCode[] = [
  "bom",
  "emptyLine",
  "notJson",
  "notObject",
  "prettyPrinted",
  "noRecords",
  "limitRequests",
  "limitSize",
  "noCustomId",
  "badCustomId",
  "duplicateCustomId",
  "badUrl",
  "noBody",
  "multipleModels",
  "streamTrue",
  "moderationNoInput",
  "limitEmbeddings",
  "noParams",
  "rejectedParam",
  "minLines",
  "noMessages",
  "messageNotObject",
  "noRole",
  "badWeight",
  "weightNotAssistant",
  "noAssistant",
  "noContent",
  "arrayForm",
];

export const SEVERITY: Record<FindingCode, Severity> = {
  bom: "error",
  emptyLine: "warn",
  notJson: "error",
  notObject: "error",
  prettyPrinted: "error",
  noRecords: "error",
  limitRequests: "error",
  limitSize: "error",
  noCustomId: "error",
  badCustomId: "error",
  duplicateCustomId: "error",
  badUrl: "error",
  noBody: "error",
  multipleModels: "error",
  streamTrue: "error",
  moderationNoInput: "error",
  limitEmbeddings: "error",
  noParams: "error",
  rejectedParam: "error",
  minLines: "error",
  noMessages: "error",
  messageNotObject: "error",
  noRole: "error",
  badWeight: "error",
  weightNotAssistant: "warn",
  noAssistant: "warn",
  noContent: "warn",
  arrayForm: "info",
};

export type Finding = {
  severity: Severity;
  code: FindingCode;
  /** 1始まりの行(配列の形のときは要素の番号)。ファイル全体への指摘は 0。 */
  line: number;
  params: Record<string, string>;
};

export type CheckResult = {
  records: number;
  bytes: number;
  findings: Finding[];
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** 文字列の UTF-8 でのバイト数。 */
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

type Rec = { line: number; value: unknown };

function parseRecords(text: string, format: Format, out: Finding[]): Rec[] {
  const push = (code: FindingCode, line: number, params: Record<string, string> = {}) => out.push({ severity: SEVERITY[code], code, line, params });
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) {
    push("bom", 1);
    src = src.slice(1);
  }

  // Anthropic: requests の配列そのもの(または { "requests": [...] })を貼ってもよい。
  if (format === "anthropicBatch") {
    const t = src.trim();
    if (t.startsWith("[") || t.startsWith("{")) {
      try {
        const v = JSON.parse(t);
        const arr = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.requests) ? v.requests : null;
        if (arr) {
          push("arrayForm", 0);
          return arr.map((value, i) => ({ line: i + 1, value }));
        }
      } catch {
        // 1行ずつ読む形に進む
      }
    }
  }

  const lines = src.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const recs: Rec[] = [];
  let bad = 0;
  lines.forEach((raw, i) => {
    const n = i + 1;
    if (raw.trim() === "") {
      push("emptyLine", n);
      return;
    }
    try {
      recs.push({ line: n, value: JSON.parse(raw) });
    } catch {
      bad++;
      push("notJson", n);
    }
  });

  // 整形された(複数行の)JSON を貼った。ほとんどの行が JSON として読めず、先頭が { か [ だけの行。
  const first = lines.find((l) => l.trim() !== "");
  if (bad >= 2 && bad > recs.length && first !== undefined && /^\s*[{[]\s*$/.test(first)) {
    for (let k = out.length - 1; k >= 0; k--) if (out[k].code === "notJson") out.splice(k, 1);
    push("prettyPrinted", 1);
  }
  return recs;
}

function checkOpenAiBatch(recs: Rec[], out: Finding[]) {
  const push = (code: FindingCode, line: number, params: Record<string, string> = {}) => out.push({ severity: SEVERITY[code], code, line, params });
  const seen = new Map<string, number>();
  const models = new Map<string, number>();
  let embeddingInputs = 0;
  for (const { line, value } of recs) {
    if (!isObj(value)) {
      push("notObject", line);
      continue;
    }
    const id = value.custom_id;
    if (typeof id !== "string" || id === "") push("noCustomId", line);
    else if (seen.has(id)) push("duplicateCustomId", line, { id, first: String(seen.get(id)) });
    else seen.set(id, line);

    const url = value.url;
    if (typeof url !== "string" || !(OPENAI_BATCH_ENDPOINTS as readonly string[]).includes(url)) {
      push("badUrl", line, { value: typeof url === "string" ? url : "" });
    }
    const body = value.body;
    if (!isObj(body)) {
      push("noBody", line);
      continue;
    }
    if (typeof body.model === "string" && !models.has(body.model)) models.set(body.model, line);
    if (body.stream === true) push("streamTrue", line);
    if (url === "/v1/moderations" && !("input" in body)) push("moderationNoInput", line);
    if (url === "/v1/embeddings") {
      const inp = body.input;
      embeddingInputs += Array.isArray(inp) ? (inp.length > 0 && Array.isArray(inp[0]) ? inp.length : inp.length > 0 && typeof inp[0] === "number" ? 1 : inp.length) : inp === undefined ? 0 : 1;
    }
  }
  if (models.size > 1) push("multipleModels", 0, { models: [...models.keys()].join(", ") });
  if (embeddingInputs > LIMITS.openaiBatch.embeddingInputs) push("limitEmbeddings", 0, { n: String(embeddingInputs), max: String(LIMITS.openaiBatch.embeddingInputs) });
}

function checkAnthropicBatch(recs: Rec[], out: Finding[]) {
  const push = (code: FindingCode, line: number, params: Record<string, string> = {}) => out.push({ severity: SEVERITY[code], code, line, params });
  const seen = new Map<string, number>();
  for (const { line, value } of recs) {
    if (!isObj(value)) {
      push("notObject", line);
      continue;
    }
    const id = value.custom_id;
    if (typeof id !== "string" || !ANTHROPIC_CUSTOM_ID.test(id)) push("badCustomId", line);
    else if (seen.has(id)) push("duplicateCustomId", line, { id, first: String(seen.get(id)) });
    else seen.set(id, line);

    const params = value.params;
    if (!isObj(params)) {
      push("noParams", line);
      continue;
    }
    if (params.stream === true) push("rejectedParam", line, { name: "stream: true" });
    if ("speed" in params) push("rejectedParam", line, { name: "speed" });
    if ("fallbacks" in params) push("rejectedParam", line, { name: "fallbacks" });
    if (params.max_tokens === 0) push("rejectedParam", line, { name: "max_tokens: 0" });
  }
}

function checkFineTune(recs: Rec[], out: Finding[]) {
  const push = (code: FindingCode, line: number, params: Record<string, string> = {}) => out.push({ severity: SEVERITY[code], code, line, params });
  for (const { line, value } of recs) {
    if (!isObj(value)) {
      push("notObject", line);
      continue;
    }
    const messages = value.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      push("noMessages", line);
      continue;
    }
    let hasAssistant = false;
    messages.forEach((m, i) => {
      const at = String(i + 1);
      if (!isObj(m)) {
        push("messageNotObject", line, { at });
        return;
      }
      if (typeof m.role !== "string" || m.role === "") push("noRole", line, { at });
      if (m.role === "assistant") hasAssistant = true;
      if (!("content" in m) && !("tool_calls" in m) && !("function_call" in m)) push("noContent", line, { at });
      if ("weight" in m) {
        if (m.weight !== 0 && m.weight !== 1) push("badWeight", line, { at });
        else if (m.role !== "assistant") push("weightNotAssistant", line, { at });
      }
    });
    if (!hasAssistant) push("noAssistant", line);
  }
}

export function checkJsonl(text: string, format: Format): CheckResult {
  const out: Finding[] = [];
  const push = (code: FindingCode, line: number, params: Record<string, string> = {}) => out.push({ severity: SEVERITY[code], code, line, params });
  const bytes = byteLength(text);
  const recs = parseRecords(text, format, out);

  if (recs.length === 0 && !out.some((f) => f.code === "prettyPrinted" || f.code === "notJson")) push("noRecords", 0);

  if (format === "openaiBatch") {
    const L = LIMITS.openaiBatch;
    if (recs.length > L.requests) push("limitRequests", 0, { n: String(recs.length), max: String(L.requests) });
    if (bytes > L.bytes) push("limitSize", 0, { mb: (bytes / 1024 / 1024).toFixed(1), max: "200" });
    checkOpenAiBatch(recs, out);
  } else if (format === "anthropicBatch") {
    const L = LIMITS.anthropicBatch;
    if (recs.length > L.requests) push("limitRequests", 0, { n: String(recs.length), max: String(L.requests) });
    if (bytes > L.bytes) push("limitSize", 0, { mb: (bytes / 1024 / 1024).toFixed(1), max: "256" });
    checkAnthropicBatch(recs, out);
  } else {
    if (recs.length > 0 && recs.length < LIMITS.openaiFineTune.minLines) push("minLines", 0, { n: String(recs.length), min: String(LIMITS.openaiFineTune.minLines) });
    checkFineTune(recs, out);
  }

  const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  out.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
  return { records: recs.length, bytes, findings: out };
}

export const EXAMPLES: Record<Format, string> = {
  openaiBatch: `{"custom_id":"req-1","method":"POST","url":"/v1/chat/completions","body":{"model":"model-a","messages":[{"role":"user","content":"Hello"}]}}
{"custom_id":"req-2","method":"POST","url":"/v1/chat/completions","body":{"model":"model-b","stream":true,"messages":[{"role":"user","content":"Hi"}]}}
{"custom_id":"req-2","method":"POST","url":"/v1/chat","body":{"model":"model-a"}}
{"custom_id":"req-4","method":"POST","url":"/v1/moderations","body":{"model":"model-a"}}`,
  anthropicBatch: `{"custom_id":"my-first-request","params":{"model":"model-a","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}}
{"custom_id":"my second request","params":{"model":"model-a","max_tokens":1024,"stream":true,"messages":[{"role":"user","content":"Hi"}]}}
{"custom_id":"my-first-request","params":{"model":"model-a","max_tokens":0,"messages":[]}}
{"custom_id":"my-fourth-request"}`,
  openaiFineTune: `{"messages":[{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"Hi"},{"role":"assistant","content":"Hello!","weight":1}]}
{"messages":[{"role":"user","content":"Hi"}]}
{"messages":[{"role":"user","content":"Hi","weight":1},{"role":"assistant","content":"Hello!","weight":2}]}
{"messages": [
{"messages":[]}`,
};
