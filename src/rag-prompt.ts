/**
 * 検索で見つけた文章(RAG の出典)と質問から、Ollama の /api/chat に送る要求を組み立てる。
 *
 * 出典の読み方(readSources。RAG Citation Checker も同じ番号の振り方を使う):
 *  - 文字列の JSON 配列
 *  - オブジェクトの JSON 配列(psql の json_agg の出力など)。本文は TEXT_FIELDS の最初にある文字列。id・title・url があれば見出しに添える
 *  - それ以外の文章: `---` だけの行で区切る。その行が無ければ空行で区切る
 * 番号は 1 から。
 *
 * 要求の形は docs.ollama.com/api/chat の ChatRequest にある項目だけ(model・messages・format・options・stream)と、
 * truncate。truncate は API のページに載っていないが、ollama/ollama の api/types.go(v0.40.11)の ChatRequest にあり、
 * false にすると文脈長を超えたときに黙って切らずにエラーを返す。2026-11-05 に Ollama 0.40.11 で、
 * 既定(切る)では先頭の system と最初の出典が消えて答えが変わり、false では 400 になることを確かめた。
 * 構造化出力のページの助言に合わせて、format に渡す JSON Schema を指示文にも書き、temperature 0 を選べるようにする。
 */

import { singleQuote } from "./ollama-api-request";

export const RAG_VERIFIED_ON = "2026-11-05";
export const OLLAMA_CHAT_DOC_URL = "https://docs.ollama.com/api/chat";
export const MAX_SOURCES = 50;
export const TEXT_FIELDS = ["content", "text", "chunk", "document", "page_content"] as const;

export type SourcesKind = "strings" | "objects" | "separated" | "paragraphs";
export type RagSource = { text: string; meta: string };

export type SourcesProblem = "sourcesEmpty" | "sourcesJson" | "sourcesShape" | "sourceNoText" | "sourceEmptyText" | "tooManySources";

/** 答えの形。format にも、指示文にもこれを書く。 */
export const CITATION_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    citations: {
      type: "array",
      items: {
        type: "object",
        properties: { source: { type: "integer" }, quote: { type: "string" } },
        required: ["source", "quote"],
      },
    },
  },
  required: ["answer", "citations"],
};

export const SYSTEM_BASE =
  "Answer the question using only the numbered sources in the user message. Cite the number of each source you use. " +
  "If the sources do not contain the answer, say that you do not know and cite nothing. Answer in the same language as the question.";
export const SYSTEM_JSON =
  "For each citation, give the source number and copy a short quote from that source exactly as it is written. " +
  `Return JSON that matches this schema: ${JSON.stringify(CITATION_SCHEMA)}`;
export const SYSTEM_TEXT = "Write the source numbers in square brackets after each sentence that uses them, such as [2].";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function metaOf(o: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of ["id", "title", "url"]) {
    const v = o[k];
    if ((typeof v === "string" && v.trim()) || (typeof v === "number" && Number.isFinite(v))) parts.push(`${k}: ${String(v).trim()}`);
  }
  return parts.join(", ");
}

export type ReadSources =
  | { ok: true; kind: SourcesKind; sources: RagSource[] }
  | { ok: false; code: SourcesProblem; index?: number };

export function readSources(text: string): ReadSources {
  const t = text.trim();
  if (!t) return { ok: false, code: "sourcesEmpty" };
  let out: { kind: SourcesKind; sources: RagSource[] };
  if (t.startsWith("[") || t.startsWith("{")) {
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      return { ok: false, code: "sourcesJson" };
    }
    if (!Array.isArray(v) || v.length === 0) return { ok: false, code: "sourcesShape" };
    if (v.every((x) => typeof x === "string")) out = { kind: "strings", sources: v.map((s: string) => ({ text: s, meta: "" })) };
    else if (v.every(isObj)) {
      const sources: RagSource[] = [];
      for (let i = 0; i < v.length; i++) {
        const o = v[i] as Record<string, unknown>;
        const field = TEXT_FIELDS.find((f) => typeof o[f] === "string");
        if (!field) return { ok: false, code: "sourceNoText", index: i + 1 };
        sources.push({ text: o[field] as string, meta: metaOf(o) });
      }
      out = { kind: "objects", sources };
    } else return { ok: false, code: "sourcesShape" };
  } else {
    const lines = text.replace(/\r\n?/g, "\n");
    const separated = /^[ \t]*-{3,}[ \t]*$/m.test(lines);
    const pieces = separated ? lines.split(/^[ \t]*-{3,}[ \t]*$/m) : lines.split(/\n[ \t]*\n/);
    out = {
      kind: separated ? "separated" : "paragraphs",
      sources: pieces.map((p) => p.trim()).filter((p) => p !== "").map((p) => ({ text: p, meta: "" })),
    };
    if (out.sources.length === 0) return { ok: false, code: "sourcesEmpty" };
  }
  const empty = out.sources.findIndex((s) => !s.text.trim());
  if (empty >= 0) return { ok: false, code: "sourceEmptyText", index: empty + 1 };
  if (out.sources.length > MAX_SOURCES) return { ok: false, code: "tooManySources" };
  return { ok: true, ...out };
}

export type PromptInput = {
  question: string;
  sources: string;
  model: string;
  /** format に CITATION_SCHEMA を渡し、答えを JSON にする。 */
  json: boolean;
  /** options.temperature を 0 にする。 */
  temperature0: boolean;
  /** options.num_ctx。空なら送らない(サーバーの既定)。 */
  numCtx: string;
  /** truncate: false を送る(入りきらないとき、黙って切らずにエラーにする)。 */
  noTruncate: boolean;
};

export type PromptProblem = SourcesProblem | "questionEmpty" | "modelMissing" | "numCtx";
export type Problem = { code: PromptProblem; index?: number };

export type PromptResult = {
  problems: Problem[];
  kind: SourcesKind | null;
  count: number;
  system: string;
  user: string;
  json: string;
  curl: string;
};

export function userMessage(sources: RagSource[], question: string): string {
  const blocks = sources.map((s, i) => `[${i + 1}]${s.meta ? ` (${s.meta})` : ""}\n${s.text.trim()}`);
  return `Sources:\n\n${blocks.join("\n\n")}\n\nQuestion: ${question.trim()}`;
}

export function buildRagRequest(input: PromptInput): PromptResult {
  const problems: Problem[] = [];
  const empty = (): PromptResult => ({ problems, kind: null, count: 0, system: "", user: "", json: "", curl: "" });

  if (!input.question.trim()) problems.push({ code: "questionEmpty" });
  const model = input.model.trim();
  if (!model) problems.push({ code: "modelMissing" });
  const ctx = input.numCtx.trim();
  if (ctx && !/^[1-9]\d{0,7}$/.test(ctx)) problems.push({ code: "numCtx" });

  const read = readSources(input.sources);
  if (!read.ok) problems.push({ code: read.code, index: read.index });
  if (problems.length || !read.ok) return empty();

  const system = `${SYSTEM_BASE} ${input.json ? SYSTEM_JSON : SYSTEM_TEXT}`;
  const user = userMessage(read.sources, input.question);
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: false,
  };
  if (input.json) body.format = CITATION_SCHEMA;
  const options: Record<string, number> = {};
  if (input.temperature0) options.temperature = 0;
  if (ctx) options.num_ctx = Number(ctx);
  if (Object.keys(options).length) body.options = options;
  if (input.noTruncate) body.truncate = false;

  const json = JSON.stringify(body, null, 2);
  return {
    problems,
    kind: read.kind,
    count: read.sources.length,
    system,
    user,
    json,
    curl: `curl http://localhost:11434/api/chat -d ${singleQuote(json)}`,
  };
}
