/**
 * RAG Prompt Builder の検算。
 *
 * 期待値は手で書いた要求の本文。項目は docs.ollama.com/api/chat の ChatRequest と、ollama/ollama の api/types.go(v0.40.11)の truncate。
 * 2026-11-05 に、この組み立てで作った要求を Ollama 0.40.11 の qwen2.5:7b に送り、format の JSON・[n] の番号の両方で
 * 答えが返ること、num_ctx 1024 で既定(切る)だと先頭の system と最初の出典が消えて答えが変わること、
 * truncate: false だと 400 になることを確かめた。
 */
import {
  CITATION_SCHEMA,
  MAX_SOURCES,
  SYSTEM_BASE,
  SYSTEM_JSON,
  SYSTEM_TEXT,
  buildRagRequest,
  readSources,
  userMessage,
  type PromptInput,
} from "../src/rag-prompt";

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

const read = (t: string) => {
  const r = readSources(t);
  return r.ok ? { kind: r.kind, sources: r.sources } : { code: r.code, index: r.index };
};

// 出典の読み方
eq("文字列の配列", read('["a", "b"]'), { kind: "strings", sources: [{ text: "a", meta: "" }, { text: "b", meta: "" }] });
eq("オブジェクト: content と id・title・url", read('[{"id": 7, "title": "T", "url": "https://x", "content": "body", "distance": 0.1}]'), {
  kind: "objects",
  sources: [{ text: "body", meta: "id: 7, title: T, url: https://x" }],
});
eq("オブジェクト: text", read('[{"text": "t1"}]'), { kind: "objects", sources: [{ text: "t1", meta: "" }] });
eq("オブジェクト: chunk", read('[{"chunk": "c"}]'), { kind: "objects", sources: [{ text: "c", meta: "" }] });
eq("オブジェクト: document", read('[{"document": "d"}]'), { kind: "objects", sources: [{ text: "d", meta: "" }] });
eq("オブジェクト: page_content", read('[{"page_content": "p", "id": "doc-1"}]'), { kind: "objects", sources: [{ text: "p", meta: "id: doc-1" }] });
eq("オブジェクト: content が text より先", read('[{"text": "x", "content": "y"}]'), { kind: "objects", sources: [{ text: "y", meta: "" }] });
eq("オブジェクト: 空の id・title は添えない", read('[{"id": "", "title": "  ", "content": "z"}]'), { kind: "objects", sources: [{ text: "z", meta: "" }] });
eq("オブジェクト: 本文の欄が無い", read('[{"content": "a"}, {"body": "b"}]'), { code: "sourceNoText", index: 2 });
eq("オブジェクト: 本文が空", read('[{"content": "a"}, {"content": "  "}]'), { code: "sourceEmptyText", index: 2 });
eq("文字列: 空", read('["a", ""]'), { code: "sourceEmptyText", index: 2 });
eq("混ざった配列", read('["a", {"content": "b"}]'), { code: "sourcesShape", index: undefined });
eq("空の配列", read("[]"), { code: "sourcesShape", index: undefined });
eq("配列でない JSON", read('{"content": "a"}'), { code: "sourcesShape", index: undefined });
eq("壊れた JSON", read('["a",'), { code: "sourcesJson", index: undefined });
eq("空", read("  \n "), { code: "sourcesEmpty", index: undefined });
eq("--- で区切る", read("first\nline two\n---\nsecond\n\nstill second\n ---- \nthird"), {
  kind: "separated",
  sources: [
    { text: "first\nline two", meta: "" },
    { text: "second\n\nstill second", meta: "" },
    { text: "third", meta: "" },
  ],
});
eq("空行で区切る", read("one\ntwo\n\n\nthree\n  \nfour"), {
  kind: "paragraphs",
  sources: [
    { text: "one\ntwo", meta: "" },
    { text: "three", meta: "" },
    { text: "four", meta: "" },
  ],
});
eq("CRLF", read("a\r\n\r\nb"), { kind: "paragraphs", sources: [{ text: "a", meta: "" }, { text: "b", meta: "" }] });
eq("--- だけ", read("---\n---"), { code: "sourcesEmpty", index: undefined });
eq("上限ちょうど", (readSources(JSON.stringify(Array(MAX_SOURCES).fill("x"))) as { ok: boolean }).ok, true);
eq("上限を超える", read(JSON.stringify(Array(MAX_SOURCES + 1).fill("x"))), { code: "tooManySources", index: undefined });

// 利用者の文
eq(
  "利用者の文",
  userMessage([{ text: " A \n", meta: "id: 1" }, { text: "B", meta: "" }], " Why? "),
  "Sources:\n\n[1] (id: 1)\nA\n\n[2]\nB\n\nQuestion: Why?",
);

// 要求
const base: PromptInput = {
  question: "Why only 40 rows?",
  sources: '["S1", "S2"]',
  model: "qwen2.5:7b",
  json: true,
  temperature0: true,
  numCtx: "",
  noTruncate: true,
};
const run = (i: Partial<PromptInput>) => buildRagRequest({ ...base, ...i });
const body = (i: Partial<PromptInput>) => JSON.parse(run(i).json);
const codes = (i: Partial<PromptInput>) => run(i).problems.map((p) => p.code);

const userText = "Sources:\n\n[1]\nS1\n\n[2]\nS2\n\nQuestion: Why only 40 rows?";
eq("既定: 問題なし", run({}).problems, []);
eq("既定: 本文", body({}), {
  model: "qwen2.5:7b",
  messages: [
    { role: "system", content: `${SYSTEM_BASE} ${SYSTEM_JSON}` },
    { role: "user", content: userText },
  ],
  stream: false,
  format: CITATION_SCHEMA,
  options: { temperature: 0 },
  truncate: false,
});
eq("既定: 数", [run({}).count, run({}).kind], [2, "strings"]);
eq("JSON の指示に型が入る", SYSTEM_JSON.endsWith(JSON.stringify(CITATION_SCHEMA)), true);
eq("文章で答える: format なし・[n] の指示", body({ json: false }).format, undefined);
eq("文章で答える: system", body({ json: false }).messages[0].content, `${SYSTEM_BASE} ${SYSTEM_TEXT}`);
eq("temperature を付けない・num_ctx も無い → options なし", body({ temperature0: false }).options, undefined);
eq("num_ctx", body({ numCtx: " 8192 " }).options, { temperature: 0, num_ctx: 8192 });
eq("num_ctx だけ", body({ temperature0: false, numCtx: "4096" }).options, { num_ctx: 4096 });
eq("truncate を付けない", body({ noTruncate: false }).truncate, undefined);
eq("項目の順", Object.keys(body({ numCtx: "4096" })), ["model", "messages", "stream", "format", "options", "truncate"]);
eq("model の前後の空白", body({ model: "  llama3.2  " }).model, "llama3.2");

eq("質問が空", codes({ question: "  " }), ["questionEmpty"]);
eq("model が空", codes({ model: "" }), ["modelMissing"]);
eq("num_ctx: 0", codes({ numCtx: "0" }), ["numCtx"]);
eq("num_ctx: 小数", codes({ numCtx: "4096.5" }), ["numCtx"]);
eq("num_ctx: 負", codes({ numCtx: "-1" }), ["numCtx"]);
eq("num_ctx: 文字", codes({ numCtx: "8k" }), ["numCtx"]);
eq("num_ctx: 大きすぎ", codes({ numCtx: "100000000" }), ["numCtx"]);
eq("num_ctx: 8桁は可", codes({ numCtx: "99999999" }), []);
eq("出典の問題も出す", run({ sources: '["a",' }).problems, [{ code: "sourcesJson" }]);
eq("出典の番号付きの問題", run({ sources: '[{"content":"a"},{"x":1}]' }).problems, [{ code: "sourceNoText", index: 2 }]);
eq("問題が重なる", codes({ question: "", model: "", sources: "" }), ["questionEmpty", "modelMissing", "sourcesEmpty"]);
eq("問題があれば出力しない", [run({ question: "" }).json, run({ question: "" }).curl], ["", ""]);

// curl
eq("curl の形", run({}).curl.startsWith("curl http://localhost:11434/api/chat -d '{\n"), true);
eq("curl: ' を '\\'' に", run({ question: "What's this?" }).curl.includes(`What'\\''s this?`), true);
eq("curl: 本文と一致", run({}).curl, `curl http://localhost:11434/api/chat -d '${run({}).json}'`);

// 出典の本文の中の改行・引用符は JSON の中でそのまま
eq("改行と引用符", body({ sources: '["line1\\nline2 \\"q\\""]' }).messages[1].content, 'Sources:\n\n[1]\nline1\nline2 "q"\n\nQuestion: Why only 40 rows?');

console.log(`check-rag-prompt: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
