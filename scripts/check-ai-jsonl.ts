/**
 * AI JSONL Checker の検算。
 *
 * 規則は src/lib/ai-jsonl.ts の冒頭にある公式ドキュメントから取ったもの。確かめるのは次の点。
 *  - 公式の例(OpenAI Batch の入力行、Anthropic の custom_id 付きリクエスト、ファインチューニングの
 *    messages と weight)が、指摘ゼロ
 *  - 各規則が、書かれたとおりの条件で出る。出すべきでないときに出ない(誤検出が無い)。境界(50,000、
 *    10行、64文字)の前後
 *  - 末尾の改行・CRLF・BOM・空行・整形された JSON の扱い
 *  - どんな入力でも落ちない(擬似乱数で3000通り)
 *
 * 実行: npm run check
 */
import { ANTHROPIC_CUSTOM_ID, byteLength, checkJsonl, EXAMPLES, type Finding, type Format } from "../src/ai-jsonl";

let pass = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};
const eq = (label: string, got: unknown, want: unknown) => ok(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);

const J = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n");
const codes = (text: string, f: Format) => checkJsonl(text, f).findings.map((x) => `${x.code}@${x.line}`);
const find = (text: string, f: Format, code: string): Finding | undefined => checkJsonl(text, f).findings.find((x) => x.code === code);

const oa = (over: Record<string, unknown> = {}, body: Record<string, unknown> = {}) => ({
  custom_id: "request-1",
  method: "POST",
  url: "/v1/chat/completions",
  body: { model: "m", messages: [{ role: "user", content: "hi" }], ...body },
  ...over,
});

// 1. OpenAI Batch
eq("openai batch: docs-shaped line", codes(J(oa()), "openaiBatch"), []);
eq("openai batch: two requests", codes(J(oa(), oa({ custom_id: "request-2" })), "openaiBatch"), []);
eq("openai batch: every documented endpoint", codes(J(...["/v1/responses", "/v1/chat/completions", "/v1/embeddings", "/v1/completions", "/v1/images/generations", "/v1/images/edits"].map((u, i) => ({ custom_id: "c" + i, method: "POST", url: u, body: { model: "m", input: "x" } }))), "openaiBatch"), []);
eq("openai batch: unknown endpoint", codes(J(oa({ url: "/v1/chat" })), "openaiBatch"), ["badUrl@1"]);
eq("openai batch: endpoint with trailing slash", codes(J(oa({ url: "/v1/chat/completions/" })), "openaiBatch"), ["badUrl@1"]);
eq("openai batch: missing url", codes(J({ custom_id: "a", method: "POST", body: { model: "m" } }), "openaiBatch"), ["badUrl@1"]);
eq("openai batch: url param", find(J(oa({ url: "/v1/x" })), "openaiBatch", "badUrl")?.params.value, "/v1/x");
eq("openai batch: no custom_id", codes(J(oa({ custom_id: undefined })), "openaiBatch"), ["noCustomId@1"]);
eq("openai batch: custom_id number", codes(J(oa({ custom_id: 5 })), "openaiBatch"), ["noCustomId@1"]);
eq("openai batch: custom_id empty", codes(J(oa({ custom_id: "" })), "openaiBatch"), ["noCustomId@1"]);
eq("openai batch: custom_id any characters ok", codes(J(oa({ custom_id: "a b/c:日本語" })), "openaiBatch"), []);
eq("openai batch: duplicate custom_id", codes(J(oa(), oa()), "openaiBatch"), ["duplicateCustomId@2"]);
eq("openai batch: duplicate points to first", find(J(oa(), oa({ custom_id: "z" }), oa()), "openaiBatch", "duplicateCustomId")?.params.first, "1");
eq("openai batch: body missing", codes(J(oa({ body: undefined })), "openaiBatch"), ["noBody@1"]);
eq("openai batch: body is array", codes(J(oa({ body: [] })), "openaiBatch"), ["noBody@1"]);
eq("openai batch: two models", codes(J(oa({}, { model: "a" }), oa({ custom_id: "r2" }, { model: "b" })), "openaiBatch"), ["multipleModels@0"]);
eq("openai batch: two models listed", find(J(oa({}, { model: "a" }), oa({ custom_id: "r2" }, { model: "b" })), "openaiBatch", "multipleModels")?.params.models, "a, b");
eq("openai batch: same model twice ok", codes(J(oa({}, { model: "a" }), oa({ custom_id: "r2" }, { model: "a" })), "openaiBatch"), []);
eq("openai batch: stream true", codes(J(oa({}, { stream: true })), "openaiBatch"), ["streamTrue@1"]);
eq("openai batch: stream false ok", codes(J(oa({}, { stream: false })), "openaiBatch"), []);
eq("openai batch: moderations without input", codes(J(oa({ url: "/v1/moderations" })), "openaiBatch"), ["moderationNoInput@1"]);
eq("openai batch: moderations with input", codes(J(oa({ url: "/v1/moderations" }, { input: "x" })), "openaiBatch"), []);
eq("openai batch: no records", codes("", "openaiBatch"), ["noRecords@0"]);
eq("openai batch: only blank lines", codes("\n\n", "openaiBatch"), ["noRecords@0"]);
eq("openai batch: line is an array", codes("[1]", "openaiBatch"), ["notObject@1"]);
eq("openai batch: line is a string", codes('"x"', "openaiBatch"), ["notObject@1"]);

// 2. OpenAI Batch の上限
{
  const row = (i: number) => `{"custom_id":"c${i}","method":"POST","url":"/v1/completions","body":{"model":"m"}}`;
  const n = (k: number) => Array.from({ length: k }, (_, i) => row(i)).join("\n");
  eq("openai batch: 50000 requests ok", checkJsonl(n(50000), "openaiBatch").findings.filter((f) => f.code === "limitRequests").length, 0);
  eq("openai batch: 50001 requests", checkJsonl(n(50001), "openaiBatch").findings.filter((f) => f.code === "limitRequests").length, 1);
  const emb = (id: string, input: unknown) => ({ custom_id: id, method: "POST", url: "/v1/embeddings", body: { model: "m", input } });
  eq("embeddings: array counts each input", codes(J(emb("a", ["x", "y", "z"])), "openaiBatch"), []);
  const big = Array.from({ length: 50000 }, () => "x");
  eq("embeddings: exactly 50000 ok", codes(J(emb("a", big)), "openaiBatch"), []);
  eq("embeddings: 50001 across requests", codes(J(emb("a", big), emb("b", "x")), "openaiBatch"), ["limitEmbeddings@0"]);
  eq("embeddings: token-id array is one input", codes(J(emb("a", [1, 2, 3])), "openaiBatch"), []);
  eq("embeddings: array of token arrays", codes(J(emb("a", [[1, 2], [3]])), "openaiBatch"), []);
  eq("embeddings: other endpoints are not counted", codes(J({ custom_id: "a", method: "POST", url: "/v1/completions", body: { model: "m", input: big.concat(big) } }), "openaiBatch"), []);
}

// 3. Anthropic Message Batches
const an = (over: Record<string, unknown> = {}, params: Record<string, unknown> = {}) => ({
  custom_id: "my-first-request",
  params: { model: "m", max_tokens: 1024, messages: [{ role: "user", content: "Hello" }], ...params },
  ...over,
});
eq("anthropic: docs-shaped line", codes(J(an()), "anthropicBatch"), []);
eq("anthropic: two requests", codes(J(an(), an({ custom_id: "my-second-request" })), "anthropicBatch"), []);
eq("anthropic: custom_id regex", ANTHROPIC_CUSTOM_ID.source, "^[a-zA-Z0-9_-]{1,64}$");
eq("anthropic: custom_id with space", codes(J(an({ custom_id: "my request" })), "anthropicBatch"), ["badCustomId@1"]);
eq("anthropic: custom_id with dot", codes(J(an({ custom_id: "a.b" })), "anthropicBatch"), ["badCustomId@1"]);
eq("anthropic: custom_id 64 chars ok", codes(J(an({ custom_id: "a".repeat(64) })), "anthropicBatch"), []);
eq("anthropic: custom_id 65 chars", codes(J(an({ custom_id: "a".repeat(65) })), "anthropicBatch"), ["badCustomId@1"]);
eq("anthropic: custom_id empty", codes(J(an({ custom_id: "" })), "anthropicBatch"), ["badCustomId@1"]);
eq("anthropic: custom_id with newline char", codes(J(an({ custom_id: "a\nb" })), "anthropicBatch"), ["badCustomId@1"]);
eq("anthropic: custom_id missing", codes(J(an({ custom_id: undefined })), "anthropicBatch"), ["badCustomId@1"]);
eq("anthropic: duplicate custom_id", codes(J(an(), an()), "anthropicBatch"), ["duplicateCustomId@2"]);
eq("anthropic: custom_id is case-sensitive", codes(J(an({ custom_id: "A" }), an({ custom_id: "a" })), "anthropicBatch"), []);
eq("anthropic: params missing", codes(J(an({ params: undefined })), "anthropicBatch"), ["noParams@1"]);
eq("anthropic: params array", codes(J(an({ params: [] })), "anthropicBatch"), ["noParams@1"]);
eq("anthropic: stream true", codes(J(an({}, { stream: true })), "anthropicBatch"), ["rejectedParam@1"]);
eq("anthropic: stream false ok", codes(J(an({}, { stream: false })), "anthropicBatch"), []);
eq("anthropic: speed", find(J(an({}, { speed: "fast" })), "anthropicBatch", "rejectedParam")?.params.name, "speed");
eq("anthropic: fallbacks", find(J(an({}, { fallbacks: [] })), "anthropicBatch", "rejectedParam")?.params.name, "fallbacks");
eq("anthropic: max_tokens 0", find(J(an({}, { max_tokens: 0 })), "anthropicBatch", "rejectedParam")?.params.name, "max_tokens: 0");
eq("anthropic: max_tokens 1 ok", codes(J(an({}, { max_tokens: 1 })), "anthropicBatch"), []);
eq("anthropic: several rejected params", codes(J(an({}, { stream: true, speed: "x", fallbacks: [], max_tokens: 0 })), "anthropicBatch"), ["rejectedParam@1", "rejectedParam@1", "rejectedParam@1", "rejectedParam@1"]);
{
  const arr = JSON.stringify({ requests: [an(), an({ custom_id: "two" })] });
  eq("anthropic: { requests: [...] } form", codes(arr, "anthropicBatch"), ["arrayForm@0"]);
  eq("anthropic: bare array form", codes(JSON.stringify([an(), an({ custom_id: "two" })]), "anthropicBatch"), ["arrayForm@0"]);
  eq("anthropic: array form counts records", checkJsonl(JSON.stringify([an(), an({ custom_id: "two" })]), "anthropicBatch").records, 2);
  eq("anthropic: array form reports by item", codes(JSON.stringify([an(), an({ custom_id: "bad id" })]), "anthropicBatch"), ["badCustomId@2", "arrayForm@0"].sort((a, b) => (a.startsWith("arrayForm") ? 1 : -1)));
  eq("anthropic: pretty-printed array is accepted", codes(JSON.stringify([an()], null, 2), "anthropicBatch"), ["arrayForm@0"]);
  eq("anthropic: object without requests falls back to lines", codes('{"custom_id":"a","params":{}}', "anthropicBatch"), []);
  eq("openai batch: array form is not special", codes(JSON.stringify([oa()]), "openaiBatch"), ["notObject@1"]);
}
{
  const row = (i: number) => `{"custom_id":"c${i}","params":{"model":"m","max_tokens":1}}`;
  const n = (k: number) => Array.from({ length: k }, (_, i) => row(i)).join("\n");
  eq("anthropic: 100000 ok", checkJsonl(n(100000), "anthropicBatch").findings.filter((f) => f.code === "limitRequests").length, 0);
  eq("anthropic: 100001", checkJsonl(n(100001), "anthropicBatch").findings.filter((f) => f.code === "limitRequests").length, 1);
}

// 4. OpenAI ファインチューニング
const ft = (...messages: unknown[]) => ({ messages });
const ten = (row: unknown) => J(...Array.from({ length: 10 }, () => row));
const GOOD = ft({ role: "system", content: "s" }, { role: "user", content: "u" }, { role: "assistant", content: "a" });
eq("finetune: 10 good lines", codes(ten(GOOD), "openaiFineTune"), []);
eq("finetune: 9 lines", codes(J(...Array.from({ length: 9 }, () => GOOD)), "openaiFineTune"), ["minLines@0"]);
eq("finetune: minLines params", find(J(...Array.from({ length: 9 }, () => GOOD)), "openaiFineTune", "minLines")?.params, { n: "9", min: "10" });
eq("finetune: 11 lines ok", codes(J(...Array.from({ length: 11 }, () => GOOD)), "openaiFineTune"), []);
eq("finetune: weight 0 and 1 on assistant", codes(ten(ft({ role: "user", content: "u" }, { role: "assistant", content: "a", weight: 0 }, { role: "user", content: "u2" }, { role: "assistant", content: "a2", weight: 1 })), "openaiFineTune"), []);
eq("finetune: weight 2", codes(ten(ft({ role: "user", content: "u" }, { role: "assistant", content: "a", weight: 2 })), "openaiFineTune").slice(0, 1), ["badWeight@1"]);
eq("finetune: weight string", find(ten(ft({ role: "user", content: "u" }, { role: "assistant", content: "a", weight: "1" })), "openaiFineTune", "badWeight")?.params.at, "2");
eq("finetune: weight 0.5", codes(J(ft({ role: "assistant", content: "a", weight: 0.5 })), "openaiFineTune").includes("badWeight@1"), true);
eq("finetune: weight on user", codes(ten(ft({ role: "user", content: "u", weight: 1 }, { role: "assistant", content: "a" })), "openaiFineTune").slice(0, 1), ["weightNotAssistant@1"]);
eq("finetune: no assistant message", codes(ten(ft({ role: "user", content: "u" })), "openaiFineTune").slice(0, 1), ["noAssistant@1"]);
eq("finetune: no messages key", codes(ten({ prompt: "x" }), "openaiFineTune").slice(0, 1), ["noMessages@1"]);
eq("finetune: empty messages", codes(ten({ messages: [] }), "openaiFineTune").slice(0, 1), ["noMessages@1"]);
eq("finetune: messages is a string", codes(ten({ messages: "x" }), "openaiFineTune").slice(0, 1), ["noMessages@1"]);
eq("finetune: message is a string", codes(ten(ft("x")), "openaiFineTune").slice(0, 2), ["messageNotObject@1", "messageNotObject@2"].slice(0, 2).map((x, i) => (i === 0 ? "messageNotObject@1" : "messageNotObject@2")));
eq("finetune: no role", codes(ten(ft({ content: "x" }, { role: "assistant", content: "a" })), "openaiFineTune").slice(0, 1), ["noRole@1"]);
eq("finetune: no content", codes(ten(ft({ role: "user" }, { role: "assistant", content: "a" })), "openaiFineTune").slice(0, 1), ["noContent@1"]);
eq("finetune: tool_calls without content is fine", codes(ten(ft({ role: "user", content: "u" }, { role: "assistant", tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }] })), "openaiFineTune"), []);
eq("finetune: empty-string content is fine", codes(ten(ft({ role: "user", content: "u" }, { role: "assistant", content: "" })), "openaiFineTune"), []);
eq("finetune: extra top-level keys are fine", codes(ten({ messages: GOOD.messages, tools: [], parallel_tool_calls: false }), "openaiFineTune"), []);

// 5. 行と文字の扱い
eq("trailing newline is fine", codes(J(oa()) + "\n", "openaiBatch"), []);
eq("several trailing newlines are fine", codes(J(oa()) + "\n\n\n", "openaiBatch"), []);
eq("CRLF line endings", codes(J(oa(), oa({ custom_id: "r2" })).replace(/\n/g, "\r\n"), "openaiBatch"), []);
eq("blank line in the middle", codes(J(oa()) + "\n\n" + J(oa({ custom_id: "r2" })), "openaiBatch"), ["emptyLine@2"]);
eq("whitespace-only line in the middle", codes(J(oa()) + "\n   \n" + J(oa({ custom_id: "r2" })), "openaiBatch"), ["emptyLine@2"]);
eq("BOM", codes("﻿" + J(oa()), "openaiBatch"), ["bom@1"]);
eq("BOM does not break the first line", checkJsonl("﻿" + J(oa()), "openaiBatch").records, 1);
eq("invalid json line number", codes(J(oa()) + "\n{bad\n" + J(oa({ custom_id: "r3" })), "openaiBatch"), ["notJson@2"]);
eq("two invalid lines", codes("{a\n{b", "openaiBatch"), ["notJson@1", "notJson@2", "noRecords@0"].slice(0, 2));
eq("single-quoted json", codes("{'a': 1}", "openaiBatch"), ["notJson@1"]);
eq("trailing comma", codes('{"a": 1,}', "openaiBatch"), ["notJson@1"]);
{
  const pretty = JSON.stringify(oa(), null, 2);
  eq("pretty-printed object", codes(pretty, "openaiBatch"), ["prettyPrinted@1"]);
  eq("pretty-printed array", codes(JSON.stringify([oa(), oa()], null, 2), "openaiBatch"), ["prettyPrinted@1"]);
  eq("pretty-printed: no notJson spam", checkJsonl(pretty, "openaiBatch").findings.filter((f) => f.code === "notJson").length, 0);
  eq("pretty-printed finetune", codes(JSON.stringify(GOOD, null, 2), "openaiFineTune"), ["prettyPrinted@1"]);
  eq("one broken line is not 'pretty-printed'", codes(J(oa()) + "\n{\n" + J(oa({ custom_id: "r3" })), "openaiBatch"), ["notJson@2"]);
}
eq("byteLength counts UTF-8 bytes", byteLength("aé日😀"), 1 + 2 + 3 + 4);
eq("bytes in result", checkJsonl("日本", "openaiBatch").bytes, 6);
eq("records in result", checkJsonl(J(oa(), oa({ custom_id: "r2" })), "openaiBatch").records, 2);

// 6. 並び順と例
{
  const rank = { error: 0, warn: 1, info: 2 } as const;
  const f = checkJsonl("\n" + J(oa()) + "\n\n{bad\n" + J(oa({ stream: true })), "openaiBatch").findings;
  const sorted = [...f].sort((a, b) => rank[a.severity] - rank[b.severity] || a.line - b.line);
  eq("findings are sorted by severity then line", f, sorted);
  for (const fmt of ["openaiBatch", "anthropicBatch", "openaiFineTune"] as Format[]) {
    const r = checkJsonl(EXAMPLES[fmt], fmt);
    ok(`example for ${fmt} has findings`, r.findings.length >= 3, String(r.findings.length));
    ok(`example for ${fmt} has errors`, r.findings.some((x) => x.severity === "error"));
  }
  eq("openai example finds the duplicate id", checkJsonl(EXAMPLES.openaiBatch, "openaiBatch").findings.some((x) => x.code === "duplicateCustomId"), true);
  eq("openai example finds two models", checkJsonl(EXAMPLES.openaiBatch, "openaiBatch").findings.some((x) => x.code === "multipleModels"), true);
  eq("anthropic example finds a bad id", checkJsonl(EXAMPLES.anthropicBatch, "anthropicBatch").findings.some((x) => x.code === "badCustomId"), true);
  eq("finetune example finds a weight error", checkJsonl(EXAMPLES.openaiFineTune, "openaiFineTune").findings.some((x) => x.code === "badWeight"), true);
}

// 7. 擬似乱数: どんな入力でも落ちない・同じ入力は同じ結果
{
  let seed = 777;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const val = (d: number): unknown => {
    if (d > 3 || rnd() < 0.3) return pick<unknown>(["x", "", 0, 1, 2, true, false, null, "/v1/chat/completions", "/v1/embeddings", "/v1/moderations", "m", "a b"]);
    if (rnd() < 0.3) return Array.from({ length: Math.floor(rnd() * 4) }, () => val(d + 1));
    const o: Record<string, unknown> = {};
    const n = Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) o[pick(["custom_id", "method", "url", "body", "params", "messages", "role", "content", "weight", "model", "stream", "speed", "input", "max_tokens", "tool_calls"])] = val(d + 1);
    return o;
  };
  const formats: Format[] = ["openaiBatch", "anthropicBatch", "openaiFineTune"];
  let bad = 0;
  for (let i = 0; i < 3000; i++) {
    const rows = Array.from({ length: Math.floor(rnd() * 5) }, () => (rnd() < 0.1 ? pick(["{bad", "", "  ", "[", "]"]) : JSON.stringify(val(0))));
    let text = rows.join(rnd() < 0.5 ? "\n" : "\r\n");
    if (rnd() < 0.1) text = "﻿" + text;
    if (rnd() < 0.2) text = rnd() < 0.5 ? JSON.stringify(val(0)) : JSON.stringify({ requests: [val(0), val(0)] }, null, rnd() < 0.5 ? 2 : 0);
    const fmt = pick(formats);
    try {
      const a = JSON.stringify(checkJsonl(text, fmt));
      const b = JSON.stringify(checkJsonl(text, fmt));
      if (a !== b) bad++;
    } catch {
      bad++;
    }
  }
  eq("3000 random inputs: no crash, deterministic", bad, 0);
}

if (failures.length > 0) {
  console.error(`check-ai-jsonl: ${failures.length} failure(s), ${pass} passed`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`check-ai-jsonl: ${pass} checks passed`);
