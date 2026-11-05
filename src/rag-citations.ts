/**
 * RAG の答えに付いた出典を、渡した出典と突き合わせる。
 *
 * 出典は rag-prompt.ts の readSources と同じ読み方・同じ番号(1 から)。
 * 答えの読み方:
 *  - Ollama の /api/chat の応答(message.content)。stream の NDJSON(1行に1つの JSON)はつなげる
 *  - OpenAI 互換の応答(choices[0].message.content)
 *  - それ以外は、答えの本文そのもの
 * 本文が {"answer": …, "citations": [{"source": n, "quote": "…"}]}(RAG Prompt Builder の形)なら、
 * 番号が範囲内か・引用が出典にそのまま有るかを見る。そうでなければ文中の [n] を拾う。
 *
 * 見られるのは「番号と引用が出典と合っているか」だけ。答えの中身が正しいかは分からない
 * (2026-11-05 の試験で、出典の式を正しく引用しながら計算を間違えた答えがあった)。
 */

import { readSources, type RagSource, type SourcesKind, type SourcesProblem } from "./rag-prompt";

export type AnswerKind = "ollama" | "ollamaStream" | "openai" | "plain";
export type Mode = "json" | "text";
export type QuoteStatus = "exact" | "normalized" | "notFound" | "empty";

export type CitationResult = { source: number; quote: string; status: QuoteStatus | "outOfRange" };

export type ProblemCode =
  | SourcesProblem
  | "answerEmpty"
  | "answerJson"
  | "citationShape"
  | "outOfRange"
  | "noCitations"
  | "quoteNotFound"
  | "quoteEmpty"
  | "cutOff";

export type Problem = { code: ProblemCode; severity: "error" | "warn"; index?: number; detail?: string };

export type CheckResult = {
  problems: Problem[];
  sourcesKind: SourcesKind | null;
  sourceCount: number;
  answerKind: AnswerKind | null;
  mode: Mode | null;
  answer: string;
  citations: CitationResult[];
  /** 文中の [n] で拾った番号(text のとき)。 */
  markers: number[];
  /** 番号の付いていない文(text のとき)。 */
  uncited: string[];
  /** どこからも引かれていない出典の番号。 */
  unused: number[];
  promptEvalCount: number | null;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

type Unwrapped = { kind: AnswerKind; content: string; doneReason: string | null; promptEvalCount: number | null } | { error: "answerJson" };

/** 応答の外側をはがして本文を取り出す。 */
export function unwrapAnswer(text: string): Unwrapped {
  const t = text.trim();
  if (t.startsWith("{")) {
    const v = tryJson(t);
    if (isObj(v)) {
      const m = v.message;
      if (isObj(m) && typeof m.content === "string")
        return {
          kind: "ollama",
          content: m.content,
          doneReason: typeof v.done_reason === "string" ? v.done_reason : null,
          promptEvalCount: typeof v.prompt_eval_count === "number" ? v.prompt_eval_count : null,
        };
      const c = Array.isArray(v.choices) ? v.choices[0] : undefined;
      if (isObj(c) && isObj(c.message) && typeof c.message.content === "string") {
        const usage = isObj(v.usage) && typeof v.usage.prompt_tokens === "number" ? v.usage.prompt_tokens : null;
        return { kind: "openai", content: c.message.content, doneReason: typeof c.finish_reason === "string" ? c.finish_reason : null, promptEvalCount: usage };
      }
      return { kind: "plain", content: t, doneReason: null, promptEvalCount: null };
    }
    if (v === undefined) {
      // 1行に1つの JSON(stream: true の応答)
      const lines = t.split(/\r?\n/).filter((l) => l.trim() !== "");
      const parsed = lines.map((l) => tryJson(l));
      if (lines.length > 1 && parsed.every((p) => isObj(p) && isObj(p.message) && typeof p.message.content === "string")) {
        const objs = parsed as { message: { content: string }; done_reason?: unknown; prompt_eval_count?: unknown }[];
        const last = objs[objs.length - 1];
        return {
          kind: "ollamaStream",
          content: objs.map((o) => o.message.content).join(""),
          doneReason: typeof last.done_reason === "string" ? last.done_reason : null,
          promptEvalCount: typeof last.prompt_eval_count === "number" ? last.prompt_eval_count : null,
        };
      }
      return { error: "answerJson" };
    }
  }
  return { kind: "plain", content: text, doneReason: null, promptEvalCount: null };
}

/** 空白をまとめ、全角半角・大文字小文字・引用符の違いをならす。 */
export function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function quoteStatus(quote: string, source: string): QuoteStatus {
  if (!quote.trim()) return "empty";
  if (source.includes(quote)) return "exact";
  if (normalize(source).includes(normalize(quote))) return "normalized";
  return "notFound";
}

const MARKER = /\[(\d+(?:\s*[,，、]\s*\d+)*)\]/g;

/** 文に分ける(. ! ? の後の空白、。!? 、改行で)。文の頭にある番号は前の文に戻す。 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    const parts = line.split(/(?<=[.!?])\s+|(?<=[。！？])/);
    for (const raw of parts) {
      let p = raw.trim();
      // 文の頭にある番号は前の文のもの(「…です。 [1] 次の文」)
      const lead = out.length ? /^((?:\[\d+(?:\s*[,，、]\s*\d+)*\]\s*)+[.。]?)\s*/.exec(p) : null;
      if (lead) {
        out[out.length - 1] += ` ${lead[1].trim()}`;
        p = p.slice(lead[0].length);
      }
      if (p) out.push(p);
    }
  }
  return out;
}

function numbersIn(s: string): number[] {
  const nums: number[] = [];
  for (const m of s.matchAll(MARKER)) for (const n of m[1].split(/\s*[,，、]\s*/)) nums.push(Number(n));
  return nums;
}

export function checkCitations(sourcesText: string, answerText: string): CheckResult {
  const problems: Problem[] = [];
  const result: CheckResult = {
    problems,
    sourcesKind: null,
    sourceCount: 0,
    answerKind: null,
    mode: null,
    answer: "",
    citations: [],
    markers: [],
    uncited: [],
    unused: [],
    promptEvalCount: null,
  };

  const read = readSources(sourcesText);
  let sources: RagSource[] = [];
  if (!read.ok) problems.push({ code: read.code, severity: "error", index: read.index });
  else {
    sources = read.sources;
    result.sourcesKind = read.kind;
    result.sourceCount = sources.length;
  }

  if (!answerText.trim()) {
    problems.push({ code: "answerEmpty", severity: "error" });
    return result;
  }
  const un = unwrapAnswer(answerText);
  if ("error" in un) {
    problems.push({ code: "answerJson", severity: "error" });
    return result;
  }
  result.answerKind = un.kind;
  result.promptEvalCount = un.promptEvalCount;
  if (un.doneReason === "length") problems.push({ code: "cutOff", severity: "warn" });
  if (!read.ok) return result;

  const n = sources.length;
  const used = new Set<number>();
  const inner = un.content.trim().startsWith("{") ? tryJson(un.content.trim()) : undefined;

  if (isObj(inner) && typeof inner.answer === "string" && "citations" in inner) {
    result.mode = "json";
    result.answer = inner.answer;
    if (!inner.answer.trim()) problems.push({ code: "answerEmpty", severity: "error" });
    const cites = inner.citations;
    if (!Array.isArray(cites)) problems.push({ code: "citationShape", severity: "error" });
    else {
      cites.forEach((c, i) => {
        if (!isObj(c) || typeof c.source !== "number" || !Number.isInteger(c.source) || (c.quote !== undefined && typeof c.quote !== "string")) {
          problems.push({ code: "citationShape", severity: "error", index: i + 1 });
          return;
        }
        const quote = typeof c.quote === "string" ? c.quote : "";
        if (c.source < 1 || c.source > n) {
          result.citations.push({ source: c.source, quote, status: "outOfRange" });
          problems.push({ code: "outOfRange", severity: "error", detail: String(c.source) });
          return;
        }
        used.add(c.source);
        const status = quoteStatus(quote, sources[c.source - 1].text);
        result.citations.push({ source: c.source, quote, status });
        if (status === "notFound") problems.push({ code: "quoteNotFound", severity: "error", index: i + 1, detail: String(c.source) });
        if (status === "empty") problems.push({ code: "quoteEmpty", severity: "warn", index: i + 1 });
      });
      if (cites.length === 0) problems.push({ code: "noCitations", severity: "warn" });
    }
  } else {
    result.mode = "text";
    result.answer = un.content;
    if (!un.content.trim()) problems.push({ code: "answerEmpty", severity: "error" });
    result.markers = numbersIn(un.content);
    const bad = [...new Set(result.markers.filter((m) => m < 1 || m > n))];
    for (const b of bad) problems.push({ code: "outOfRange", severity: "error", detail: String(b) });
    for (const m of result.markers) if (m >= 1 && m <= n) used.add(m);
    if (un.content.trim() && result.markers.length === 0) problems.push({ code: "noCitations", severity: "warn" });
    else result.uncited = splitSentences(un.content).filter((s) => numbersIn(s).length === 0);
  }

  for (let i = 1; i <= n; i++) if (!used.has(i)) result.unused.push(i);
  return result;
}
