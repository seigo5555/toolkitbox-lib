/**
 * RAG Citation Checker の検算。
 *
 * 期待値は手で数えたもの。応答の形は docs.ollama.com/api/chat の ChatResponse・ChatStreamEvent と、
 * OpenAI 互換の choices[0].message.content。done_reason の "length" は ollama/ollama の llm/server.go(v0.40.11)。
 * 2026-11-05 に Ollama 0.40.11 の qwen2.5:7b の実際の応答(JSON の答え・[n] の答え・num_predict 5 で切れた答え)を通して確かめた。
 */
import { checkCitations, normalize, quoteStatus, splitSentences, unwrapAnswer } from "../src/rag-citations";

let pass = 0;
let fail = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++;
    console.error(`NG ${name}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

const SOURCES = JSON.stringify([
  "pgvector supports PostgreSQL 13 and later.",
  "With HNSW, hnsw.ef_search is 40 by default, so a query returns at most 40 rows unless you raise it.",
  "IVFFlat has no operator class for L1 distance.",
  "Each vector takes 4 times its dimensions plus 8 bytes.",
]);
const answer = (a: unknown) => JSON.stringify(a);
const ollama = (content: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ model: "qwen2.5:7b", message: { role: "assistant", content }, done: true, done_reason: "stop", prompt_eval_count: 242, ...extra });
const codes = (a: string, s = SOURCES) => checkCitations(s, a).problems.map((p) => p.code);

// 引用の照合
eq("そのまま", quoteStatus("40 by default", "is 40 by default, so"), "exact");
eq("空白の違い", quoteStatus("40  by\ndefault", "is 40 by default"), "normalized");
eq("大文字小文字", quoteStatus("WITH HNSW", "With HNSW, x"), "normalized");
eq("全角", quoteStatus("ＨＮＳＷ", "With HNSW"), "normalized");
eq("曲がった引用符", quoteStatus("“x” and it’s", '"x" and it\'s'), "normalized");
eq("言い換え", quoteStatus("forty rows", "40 rows"), "notFound");
eq("空", quoteStatus("  ", "abc"), "empty");
eq("ならし", normalize("  A  B\n\tC  "), "a b c");

// 文に分ける
eq("文", splitSentences("One [1]. Two? Three! Four"), ["One [1].", "Two?", "Three!", "Four"]);
eq("番号が句点の後", splitSentences("One. [1] Two. [2][3]"), ["One. [1]", "Two. [2][3]"]);
eq("小数では切らない", splitSentences("It is 0.931 here [1]. Next"), ["It is 0.931 here [1].", "Next"]);
eq("日本語", splitSentences("一つ目です[1]。二つ目です。三つ目"), ["一つ目です[1]。", "二つ目です。", "三つ目"]);
eq("改行", splitSentences("- a [1]\n- b\n\nc"), ["- a [1]", "- b", "c"]);

// 応答の外側
eq("Ollama", unwrapAnswer(ollama("hi")), { kind: "ollama", content: "hi", doneReason: "stop", promptEvalCount: 242 });
eq(
  "OpenAI 互換",
  unwrapAnswer(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "length" }], usage: { prompt_tokens: 9 } })),
  { kind: "openai", content: "x", doneReason: "length", promptEvalCount: 9 },
);
const stream = [
  { message: { role: "assistant", content: "No" }, done: false },
  { message: { role: "assistant", content: ", you cannot [3]." }, done: false },
  { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 228 },
]
  .map((o) => JSON.stringify(o))
  .join("\n");
eq("stream", unwrapAnswer(stream), { kind: "ollamaStream", content: "No, you cannot [3].", doneReason: "stop", promptEvalCount: 228 });
eq("本文そのもの", unwrapAnswer("plain [1]"), { kind: "plain", content: "plain [1]", doneReason: null, promptEvalCount: null });
eq("JSON の本文そのもの", (unwrapAnswer('{"answer":"a","citations":[]}') as { kind: string }).kind, "plain");
eq("壊れた JSON", unwrapAnswer('{"message": '), { error: "answerJson" });

// JSON の答え(2026-11-05 の qwen2.5:7b の答え)
const real = ollama(
  answer({
    answer: "Your HNSW query returns only 40 rows because the default value for hnsw.ef_search is 40.",
    citations: [{ source: 2, quote: "With HNSW, hnsw.ef_search is 40 by default, so a query returns at most 40 rows unless you raise it." }],
  }),
);
const r1 = checkCitations(SOURCES, real);
eq("実際の答え: 問題なし", r1.problems, []);
eq("実際の答え: 形", [r1.answerKind, r1.mode, r1.sourcesKind, r1.sourceCount, r1.promptEvalCount], ["ollama", "json", "strings", 4, 242]);
eq("実際の答え: 引用", r1.citations.map((c) => [c.source, c.status]), [[2, "exact"]]);
eq("実際の答え: 使われない出典", r1.unused, [1, 3, 4]);

// 計算を間違えても、引用が合っていれば通る(中身の正しさは見ない)
const wrongMath = checkCitations(
  SOURCES,
  answer({ answer: "A 384-dimension vector needs 1552 bytes of storage.", citations: [{ source: 4, quote: "Each vector takes 4 times its dimensions plus 8 bytes." }] }),
);
eq("計算違いは見えない", [wrongMath.problems, wrongMath.answerKind, wrongMath.citations[0].status], [[], "plain", "exact"]);

const many = checkCitations(
  SOURCES,
  answer({
    answer: "x",
    citations: [
      { source: 3, quote: "no operator class for L1" },
      { source: 1, quote: "PostgreSQL  13\nand later" },
      { source: 5, quote: "made up" },
      { source: 2, quote: "forty rows" },
      { source: 1, quote: "" },
      { source: "2", quote: "x" },
      { source: 1.5, quote: "x" },
      { source: 4 },
      "bad",
    ],
  }),
);
eq("いろいろ: 引用", many.citations.map((c) => [c.source, c.status]), [
  [3, "exact"],
  [1, "normalized"],
  [5, "outOfRange"],
  [2, "notFound"],
  [1, "empty"],
  [4, "empty"],
]);
eq("いろいろ: 問題", many.problems, [
  { code: "outOfRange", severity: "error", detail: "5" },
  { code: "quoteNotFound", severity: "error", index: 4, detail: "2" },
  { code: "quoteEmpty", severity: "warn", index: 5 },
  { code: "citationShape", severity: "error", index: 6 },
  { code: "citationShape", severity: "error", index: 7 },
  { code: "quoteEmpty", severity: "warn", index: 8 },
  { code: "citationShape", severity: "error", index: 9 },
]);
eq("いろいろ: 使われない出典(範囲外・見つからないものも数える)", many.unused, []);
eq("出典なしの答え", codes(answer({ answer: "I do not know.", citations: [] })), ["noCitations"]);
eq("答えが空", codes(answer({ answer: " ", citations: [{ source: 1, quote: "pgvector" }] })), ["answerEmpty"]);
eq("citations が配列でない", codes(answer({ answer: "a", citations: "1" })), ["citationShape"]);

// [n] の答え
const t1 = checkCitations(SOURCES, ollama("You cannot use L1 with IVFFlat [3]. It needs PostgreSQL 13 [1, 2]. Use halfvec for more [9]. This is extra."));
eq("[n]: 形", [t1.mode, t1.markers], ["text", [3, 1, 2, 9]]);
eq("[n]: 問題", t1.problems, [{ code: "outOfRange", severity: "error", detail: "9" }]);
eq("[n]: 番号の無い文", t1.uncited, ["This is extra."]);
eq("[n]: 使われない出典", t1.unused, [4]);
eq("[n]: 読点の区切り", checkCitations(SOURCES, "a [1、4]").markers, [1, 4]);
eq("[n]: 同じ範囲外は1回", codes("a [7]. b [7]."), ["outOfRange"]);
eq("[n]: 番号なし", codes(ollama("Use psycopg.")), ["noCitations"]);
eq("[n]: 番号なしなら文の一覧は出さない", checkCitations(SOURCES, "Use psycopg.").uncited, []);
eq("[n]: [0] は範囲外", codes("x [0]"), ["outOfRange"]);
eq("[n]: 角かっこの語は番号でない", checkCitations(SOURCES, "see [note] and [1]").markers, [1]);

// 切れた答え(num_predict 5 の実際の応答)
eq("切れた答え", codes(ollama("Pgvector is an extension", { done_reason: "length" })), ["cutOff", "noCitations"]);

// 入力の問題
eq("答えが空", codes("  "), ["answerEmpty"]);
eq("答えの JSON が壊れている", codes('{"message": {'), ["answerJson"]);
eq("出典が空", codes(ollama("a [1]"), ""), ["sourcesEmpty"]);
eq("出典が壊れていても答えの形は見る", checkCitations("[1,", ollama("a", { done_reason: "length" })).problems.map((p) => p.code), ["sourcesJson", "cutOff"]);
eq("出典: オブジェクト", checkCitations('[{"id":1,"content":"alpha beta"}]', answer({ answer: "a", citations: [{ source: 1, quote: "beta" }] })).citations[0].status, "exact");
eq("出典: 区切り", checkCitations("alpha\n---\nbeta gamma", "x [2]").unused, [1]);

console.log(`check-rag-citations: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
