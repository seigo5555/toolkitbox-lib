/**
 * Ollama Stream Reader の検算。
 *
 * FX_* は 2026-11-07 に手元の Ollama 0.40.11(qwen2.5:7b、temperature 0・seed 1)から curl -sN で取った本物の出力。
 * 期待値は出力を目で読んで手で足したもの(文章のつなぎ・トークン数)と、時間を電卓で割ったもの。
 * 手で作った例(考えた過程・OpenAI 式に分かれて届く引数・途中のエラー)は、ollama/ollama v0.40.15 の
 * openai/openai.go(ToStreamChunks)・server/routes.go(streamResponse)と、OpenAI のストリーミングのリファレンスの形に合わせた。
 */
import { chunkKind, parseCreatedAt, readStream, stripHttpHeaders } from "../src/ollama-stream";

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
function near(name: string, actual: number | null | undefined, expected: number, eps = 1e-9) {
  if (typeof actual === "number" && Math.abs(actual - expected) <= eps) pass++;
  else {
    fail++;
    console.error(`NG ${name}\n  actual:   ${actual}\n  expected: ${expected}`);
  }
}
const codes = (r: { problems: { code: string }[] }) => r.problems.map((p) => p.code);

// ---- 本物の出力 ----
const FX_CHAT = "{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:00.495979Z\",\"message\":{\"role\":\"assistant\",\"content\":\"Hello\"},\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:00.637513Z\",\"message\":{\"role\":\"assistant\",\"content\":\",\"},\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:00.747289Z\",\"message\":{\"role\":\"assistant\",\"content\":\" nice\"},\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:00.843543Z\",\"message\":{\"role\":\"assistant\",\"content\":\" to\"},\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:00.953352Z\",\"message\":{\"role\":\"assistant\",\"content\":\" meet\"},\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:01.065712Z\",\"message\":{\"role\":\"assistant\",\"content\":\".\"},\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:01.170976Z\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"done_reason\":\"stop\",\"total_duration\":6309914083,\"load_duration\":4923074625,\"prompt_eval_count\":35,\"prompt_eval_cached_count\":0,\"prompt_eval_duration\":545979000,\"eval_count\":7,\"eval_duration\":675823000}\n";
const FX_CHAT_TOOLS = "{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:04.151282Z\",\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"id\":\"call_8j9qt797\",\"function\":{\"index\":0,\"name\":\"get_weather\",\"arguments\":{\"city\":\"Toronto\"}}}]},\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:04.340868Z\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"done_reason\":\"stop\",\"total_duration\":3129791791,\"load_duration\":12922208,\"prompt_eval_count\":149,\"prompt_eval_cached_count\":18,\"prompt_eval_duration\":1294057000,\"eval_count\":20,\"eval_duration\":1812125000}\n";
const FX_V1 = "data: {\"id\":\"chatcmpl-683\",\"object\":\"chat.completion.chunk\",\"created\":1794036904,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hello\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-683\",\"object\":\"chat.completion.chunk\",\"created\":1794036904,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\",\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-683\",\"object\":\"chat.completion.chunk\",\"created\":1794036904,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" nice\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-683\",\"object\":\"chat.completion.chunk\",\"created\":1794036904,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" to\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-683\",\"object\":\"chat.completion.chunk\",\"created\":1794036904,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" meet\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-683\",\"object\":\"chat.completion.chunk\",\"created\":1794036904,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\".\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-683\",\"object\":\"chat.completion.chunk\",\"created\":1794036904,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
const FX_V1_USAGE = "data: {\"id\":\"chatcmpl-425\",\"object\":\"chat.completion.chunk\",\"created\":1794036905,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hello\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-425\",\"object\":\"chat.completion.chunk\",\"created\":1794036905,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\",\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-425\",\"object\":\"chat.completion.chunk\",\"created\":1794036905,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" nice\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-425\",\"object\":\"chat.completion.chunk\",\"created\":1794036905,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" to\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-425\",\"object\":\"chat.completion.chunk\",\"created\":1794036905,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" meet\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-425\",\"object\":\"chat.completion.chunk\",\"created\":1794036905,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\".\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-425\",\"object\":\"chat.completion.chunk\",\"created\":1794036905,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: {\"id\":\"chatcmpl-425\",\"object\":\"chat.completion.chunk\",\"created\":1794036905,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[],\"usage\":{\"prompt_tokens\":35,\"prompt_tokens_details\":{\"cached_tokens\":34},\"completion_tokens\":7,\"total_tokens\":42},\"timings\":{\"prompt_n\":35,\"prompt_ms\":97,\"prompt_per_token_ms\":2.7714285714285714,\"prompt_per_second\":360.82474226804123,\"predicted_n\":7,\"predicted_ms\":614,\"predicted_per_token_ms\":87.71428571428571,\"predicted_per_second\":11.400651465798045}}\n\ndata: [DONE]\n\n";
const FX_V1_TOOLS = "data: {\"id\":\"chatcmpl-528\",\"object\":\"chat.completion.chunk\",\"created\":1794036907,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"id\":\"call_xjkc0zjb\",\"index\":0,\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\\\"Toronto\\\"}\"}}]},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-528\",\"object\":\"chat.completion.chunk\",\"created\":1794036907,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: {\"id\":\"chatcmpl-528\",\"object\":\"chat.completion.chunk\",\"created\":1794036907,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[],\"usage\":{\"prompt_tokens\":149,\"prompt_tokens_details\":{\"cached_tokens\":148},\"completion_tokens\":20,\"total_tokens\":169},\"timings\":{\"prompt_n\":149,\"prompt_ms\":106,\"prompt_per_token_ms\":0.7114093959731543,\"prompt_per_second\":1405.6603773584907,\"predicted_n\":20,\"predicted_ms\":2154,\"predicted_per_token_ms\":107.7,\"predicted_per_second\":9.285051067780874}}\n\ndata: [DONE]\n\n";
const FX_CHAT_LENGTH = "{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:08.419745Z\",\"message\":{\"role\":\"assistant\",\"content\":\"Sure\"},\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:08.532079Z\",\"message\":{\"role\":\"assistant\",\"content\":\",\"},\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:08.6361Z\",\"message\":{\"role\":\"assistant\",\"content\":\" here\"},\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:08.739052Z\",\"message\":{\"role\":\"assistant\",\"content\":\"'s\"},\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:08.838691Z\",\"message\":{\"role\":\"assistant\",\"content\":\" the\"},\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:08.938049Z\",\"message\":{\"role\":\"assistant\",\"content\":\" count\"},\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:09.042486Z\",\"message\":{\"role\":\"assistant\",\"content\":\" from\"},\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:09.152788Z\",\"message\":{\"role\":\"assistant\",\"content\":\" \"},\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:09.152898Z\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"done_reason\":\"length\",\"total_duration\":1033250834,\"load_duration\":2703167,\"prompt_eval_count\":38,\"prompt_eval_cached_count\":24,\"prompt_eval_duration\":290970000,\"eval_count\":8,\"eval_duration\":733067000}\n";
const FX_GENERATE = "{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:09.39867Z\",\"response\":\"Hello\",\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:09.513364Z\",\"response\":\" there\",\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:09.622076Z\",\"response\":\"!\",\"done\":false}\n{\"model\":\"qwen2.5:7b\",\"created_at\":\"2026-11-07T07:35:09.728338Z\",\"response\":\"\",\"done\":true,\"done_reason\":\"stop\",\"context\":[151644,8948,198,2610,525,1207,16948,11,3465,553,54364,14817,13,1446,525,264,10950,17847,13,151645,198,151644,872,198,45764,15588,304,2326,4244,13,151645,198,151644,77091,198,9707,1052,0],\"total_duration\":563813625,\"load_duration\":3488875,\"prompt_eval_count\":35,\"prompt_eval_cached_count\":24,\"prompt_eval_duration\":227190000,\"eval_count\":4,\"eval_duration\":329630000}\n";
const FX_HTTP_404 = "HTTP/1.1 404 Not Found\nContent-Type: application/json; charset=utf-8\nDate: Sat, 07 Nov 2026 07:35:09 GMT\nContent-Length: 46\n\n{\"error\":\"model 'no-such-model:1b' not found\"}";
const FX_V1_404 = "HTTP/1.1 404 Not Found\nContent-Type: application/json\nDate: Sat, 07 Nov 2026 07:35:09 GMT\nContent-Length: 109\n\n{\"error\":{\"message\":\"model 'no-such-model:1b' not found\",\"type\":\"not_found_error\",\"param\":null,\"code\":null}}\n";
const FX_V1_LENGTH = "data: {\"id\":\"chatcmpl-596\",\"object\":\"chat.completion.chunk\",\"created\":1794036910,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Sure\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-596\",\"object\":\"chat.completion.chunk\",\"created\":1794036910,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\",\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-596\",\"object\":\"chat.completion.chunk\",\"created\":1794036910,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" here\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-596\",\"object\":\"chat.completion.chunk\",\"created\":1794036910,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"'s\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-596\",\"object\":\"chat.completion.chunk\",\"created\":1794036910,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" the\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-596\",\"object\":\"chat.completion.chunk\",\"created\":1794036910,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" count\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-596\",\"object\":\"chat.completion.chunk\",\"created\":1794036910,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" from\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-596\",\"object\":\"chat.completion.chunk\",\"created\":1794036910,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" \"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-596\",\"object\":\"chat.completion.chunk\",\"created\":1794036910,\"model\":\"qwen2.5:7b\",\"system_fingerprint\":\"fp_ollama\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n";

// /api/chat
{
  const r = readStream(FX_CHAT);
  eq("chat kind", r.kind, "ollamaChat");
  eq("chat problems", codes(r), []);
  eq("chat content", r.content, "Hello, nice to meet.");
  eq("chat finish", r.finish, "stop");
  eq("chat streamed", r.streamed, true);
  eq("chat model", r.model, "qwen2.5:7b");
  eq("chat message", r.message, { role: "assistant", content: "Hello, nice to meet." });
  const s = r.stats!;
  eq("chat chunks", s.chunks, 7);
  eq("chat evalCount", s.evalCount, 7);
  near("chat evalSec", s.evalSec, 0.675823);
  near("chat genTps", s.genTps, 7 / 0.675823);
  eq("chat prompt", [s.promptCount, s.promptCached], [35, 0]);
  near("chat promptTps", s.promptTps, 35 / 0.545979);
  near("chat loadSec", s.loadSec, 4.923074625);
  near("chat totalSec", s.totalSec, 6.309914083);
  // 07:35:00.495979 → 07:35:01.170976(ミリ秒に切り捨てて 1170 − 495)
  near("chat spanSec", s.spanSec, 0.675);
  eq("chat reportedPromptTps", s.reportedPromptTps, null);
}

// /api/chat でツールを呼んだ: 呼び出しは1塊、文章は空、eval_count は 20
{
  const r = readStream(FX_CHAT_TOOLS);
  eq("chatTools problems", codes(r), []);
  eq("chatTools content", r.content, "");
  eq("chatTools calls", r.toolCalls, [
    { index: 0, id: "call_8j9qt797", name: "get_weather", args: { city: "Toronto" }, argsText: '{"city":"Toronto"}', argsValid: true },
  ]);
  eq("chatTools finish", r.finish, "stop");
  eq("chatTools counts", [r.stats!.chunks, r.stats!.evalCount], [2, 20]);
  near("chatTools promptTps", r.stats!.promptTps, (149 - 18) / 1.294057);
  eq("chatTools message", r.message, {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "call_8j9qt797", function: { index: 0, name: "get_weather", arguments: { city: "Toronto" } } }],
  });
}

// /v1/chat/completions(usage なし)
{
  const r = readStream(FX_V1);
  eq("v1 kind", r.kind, "openaiChat");
  eq("v1 problems", codes(r), ["noUsage"]);
  eq("v1 content", r.content, "Hello, nice to meet.");
  eq("v1 finish", r.finish, "stop");
  eq("v1 chunks", r.stats!.chunks, 7);
  eq("v1 stats empty", [r.stats!.evalCount, r.stats!.genTps, r.stats!.promptTps], [null, null, null]);
  eq("v1 message", r.message, { role: "assistant", content: "Hello, nice to meet." });
}

// /v1/chat/completions(include_usage)
{
  const r = readStream(FX_V1_USAGE);
  eq("v1usage problems", codes(r), ["promptPerSecondCached"]);
  const s = r.stats!;
  eq("v1usage chunks", s.chunks, 8);
  eq("v1usage tokens", [s.evalCount, s.promptCount, s.promptCached], [7, 35, 34]);
  near("v1usage evalSec", s.evalSec, 0.614);
  near("v1usage genTps", s.genTps, 7 / 0.614);
  near("v1usage genTps = Ollama", s.genTps, 11.400651465798045, 1e-9);
  near("v1usage promptTps", s.promptTps, 1 / 0.097);
  eq("v1usage reported", s.reportedPromptTps, 360.82474226804123);
  eq("v1usage load", [s.loadSec, s.totalSec, s.spanSec], [null, null, null]);
}

// /v1 でツールを呼んだ
{
  const r = readStream(FX_V1_TOOLS);
  eq("v1tools problems", codes(r), ["promptPerSecondCached"]);
  eq("v1tools finish", r.finish, "tool_calls");
  eq("v1tools calls", r.toolCalls, [
    { index: 0, id: "call_xjkc0zjb", name: "get_weather", args: { city: "Toronto" }, argsText: '{"city":"Toronto"}', argsValid: true },
  ]);
  eq("v1tools message", r.message, {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "call_xjkc0zjb", type: "function", function: { name: "get_weather", arguments: '{"city":"Toronto"}' } }],
  });
  eq("v1tools tokens", [r.stats!.evalCount, r.stats!.promptCount, r.stats!.promptCached], [20, 149, 148]);
}

// num_predict / max_tokens で打ち切り
{
  const r = readStream(FX_CHAT_LENGTH);
  eq("chatLength problems", codes(r), ["doneLength"]);
  eq("chatLength finish", r.finish, "length");
  eq("chatLength evalCount", r.stats!.evalCount, 8);
  const v = readStream(FX_V1_LENGTH);
  eq("v1Length problems", codes(v), ["noUsage", "doneLength"]);
  eq("v1Length same text", v.content, r.content);
}

// /api/generate
{
  const r = readStream(FX_GENERATE);
  eq("generate kind", r.kind, "ollamaGenerate");
  eq("generate problems", codes(r), []);
  eq("generate content", r.content, "Hello there!");
  eq("generate message", [r.message, r.messageJson], [null, ""]);
  eq("generate evalCount", r.stats!.evalCount, 4);
}

// エラー(curl -i の見出し付き)
{
  const r = readStream(FX_HTTP_404);
  eq("404 problems", codes(r), ["httpStatus", "serverError"]);
  eq("404 detail", r.problems.map((p) => p.detail), ["404", "model 'no-such-model:1b' not found"]);
  eq("404 kind", r.kind, null);
  const v = readStream(FX_V1_404);
  eq("v1 404 problems", codes(v), ["httpStatus", "serverError"]);
  eq("v1 404 detail", v.problems[1].detail, "model 'no-such-model:1b' not found");
  // 見出しを外した本文だけ
  eq("404 body only", codes(readStream('{"error":"model \'x\' not found"}')), ["serverError"]);
}

// ---- 途中で切れた ----
{
  const cut = FX_CHAT.trimEnd().split("\n").slice(0, -1).join("\n");
  const r = readStream(cut);
  eq("cut chat problems", codes(r), ["noDone"]);
  eq("cut chat content", r.content, "Hello, nice to meet.");
  eq("cut chat stats", [r.stats!.evalCount, r.stats!.chunks], [null, 6]);
  const v = readStream(FX_V1_USAGE.replace("data: [DONE]", ""));
  eq("cut v1 problems", codes(v), ["noDoneMarker", "promptPerSecondCached"]);
  const v2 = readStream(FX_V1.split("\n").slice(0, 6).join("\n"));
  eq("cut v1 early", codes(v2), ["noDoneMarker", "noFinishReason", "noUsage"]);
  eq("cut v1 early text", v2.content, "Hello, nice");
}

// 送り始めた後のエラー(routes.go の streamResponse は {"error": …} の行を書いて止める)
{
  const lines = FX_CHAT.trimEnd().split("\n").slice(0, 3);
  const r = readStream([...lines, '{"error":"example error"}'].join("\n"));
  eq("midError problems", codes(r), ["serverError", "noDone"]);
  eq("midError line", r.problems[0].index, 4);
  eq("midError text", r.content, "Hello, nice");
}

// ---- 手で作った例 ----
const L = (o: unknown) => JSON.stringify(o);
const T0 = "2026-11-07T07:00:00.000000Z";

// 考えた過程(/api/chat の message.thinking)
{
  const text = [
    L({ model: "qwen3:4b", created_at: T0, message: { role: "assistant", content: "", thinking: "17×23 " }, done: false }),
    L({ model: "qwen3:4b", created_at: T0, message: { role: "assistant", content: "", thinking: "= 391" }, done: false }),
    L({ model: "qwen3:4b", created_at: T0, message: { role: "assistant", content: "391" }, done: false }),
    L({ model: "qwen3:4b", created_at: T0, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 10, eval_duration: 500000000 }),
  ].join("\n");
  const r = readStream(text);
  eq("think problems", codes(r), []);
  eq("think thinking", r.thinking, "17×23 = 391");
  eq("think message", r.message, { role: "assistant", content: "391", thinking: "17×23 = 391" });
  near("think genTps", r.stats!.genTps, 20);
  eq("think span", r.stats!.spanSec, 0);
}

// /v1 で考えた過程と文章が同じ応答に入ると、ToStreamChunks が reasoning の塊と content の塊に分ける
{
  const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen3:4b", system_fingerprint: "fp_ollama" };
  const text = [
    "data: " + L({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning: "think" }, finish_reason: null }] }),
    "",
    "data: " + L({ ...base, choices: [{ index: 0, delta: { content: "391" }, finish_reason: null }] }),
    "",
    "data: " + L({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    "",
    "data: [DONE]",
  ].join("\n");
  const r = readStream(text);
  eq("reasoning problems", codes(r), ["noUsage"]);
  eq("reasoning message", r.message, { role: "assistant", content: "391", reasoning: "think" });
}

// OpenAI 式: 引数が index ごとに分かれて届く(2つの呼び出しが交互)
{
  const base = { id: "chatcmpl-9", object: "chat.completion.chunk", created: 1, model: "gpt" };
  const d = (delta: unknown, finish: string | null = null) => "data:" + L({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
  const text = [
    d({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "get_weather", arguments: "" } }] }),
    d({ tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] }),
    d({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "get_time", arguments: '{"tz":' } }] }),
    d({ tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] }),
    d({ tool_calls: [{ index: 1, function: { arguments: '"UTC"}' } }] }),
    d({}, "tool_calls"),
    ": keep-alive comment",
    "data: [DONE]",
  ].join("\r\n");
  const r = readStream(text);
  eq("split problems", codes(r), ["noUsage"]);
  eq("split calls", r.toolCalls.map((c) => [c.index, c.id, c.name, c.args]), [
    [0, "call_a", "get_weather", { city: "Paris" }],
    [1, "call_b", "get_time", { tz: "UTC" }],
  ]);
  eq("split message args", (r.message!.tool_calls as { function: { arguments: string } }[]).map((c) => c.function.arguments), ['{"city":"Paris"}', '{"tz":"UTC"}']);
  eq("split content null", r.content, "");
}

// 引数が JSON になっていない・名前が無い
{
  const base = { id: "x", object: "chat.completion.chunk", choices: [] as unknown[] };
  const text = [
    "data: " + L({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: '{"a":' } }] }, finish_reason: "tool_calls" }] }),
    "data: " + L({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "c2", function: { arguments: "{}" } }] }, finish_reason: null }] }),
    "data: [DONE]",
  ].join("\n");
  const r = readStream(text);
  eq("badArgs problems", codes(r), ["argsNotJson", "toolNoName", "noUsage"]);
  eq("badArgs detail", r.problems[0].detail, "f");
  eq("badArgs valid", r.toolCalls.map((c) => c.argsValid), [false, true]);
}

// 終わった後にまだ塊がある・形が混ざっている・ほかの choices・id や model が変わる
{
  const a = L({ model: "m", message: { role: "assistant", content: "a" }, done: true, done_reason: "stop" });
  const b = L({ model: "m", message: { role: "assistant", content: "b" }, done: false });
  eq("afterDone", codes(readStream([a, b].join("\n"))), ["afterDone"]);
  const g = L({ model: "m", response: "x", done: false });
  const mixed = readStream([b, g, a].join("\n"));
  eq("mixed", codes(mixed), ["mixedKinds"]);
  eq("mixed message", mixed.message, null);
  const m2 = L({ model: "other", message: { role: "assistant", content: "c" }, done: true });
  eq("modelChanged", codes(readStream([b, m2].join("\n"))), ["modelChanged"]);
  const c = (id: string, index: number, content: string) =>
    "data: " + L({ id, object: "chat.completion.chunk", choices: [{ index, delta: { content }, finish_reason: null }] });
  const r = readStream([c("a", 0, "x"), c("a", 1, "y"), c("b", 0, "z"), "data: " + L({ id: "b", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), "data: [DONE]"].join("\n"));
  eq("choices/id", codes(r), ["otherChoices", "idChanged", "noUsage"]);
  eq("choices/id content", r.content, "xz");
  eq("afterDone sse", codes(readStream(["data: [DONE]", c("a", 0, "x")].join("\n"))).includes("afterDone"), true);
}

// done_reason が stop・length 以外・中身が空
{
  const r = readStream(L({ model: "m", created_at: T0, message: { role: "assistant", content: "" }, done: true, done_reason: "load" }));
  eq("load", codes(r), ["notStreamed", "doneOther", "emptyOutput"]);
  eq("load detail", r.problems[1].detail, "load");
}

// stream: false の応答
{
  const whole = { model: "m", created_at: T0, message: { role: "assistant", content: "Hi" }, done: true, done_reason: "stop", eval_count: 2, eval_duration: 100000000 };
  const pretty = readStream(JSON.stringify(whole, null, 2));
  eq("whole pretty", [codes(pretty), pretty.content, pretty.streamed, pretty.stats!.genTps], [["notStreamed"], "Hi", false, 20]);
  const one = readStream(L(whole));
  eq("whole one line", [codes(one), one.content, one.streamed], [["notStreamed"], "Hi", false]);
  const oa = readStream(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
  );
  eq("whole openai", [codes(oa), oa.kind, oa.content, oa.stats!.evalCount, oa.streamed], [["notStreamed"], "openaiChat", "Hi", 2, false]);
}

// 入力の不備
{
  eq("empty", codes(readStream("  \n")), ["inputEmpty"]);
  const r = readStream([L({ model: "m", message: { content: "a" }, done: false }), "not json", "[1]", L({ model: "m", message: { content: "b" }, done: true })].join("\n"));
  eq("bad lines", codes(r), ["lineJson", "lineNotObject"]);
  eq("bad lines no", r.problems.map((p) => p.index), [2, 3]);
  eq("bad lines content", r.content, "ab");
  eq("unknown", codes(readStream('{"foo":1}\n{"bar":2}')), ["lineUnknown", "lineUnknown"]);
  eq("events", codes(readStream('event: response.created\ndata: {"type":"response.created"}')).slice(0, 1), ["eventStream"]);
  eq("bom", readStream("﻿" + FX_GENERATE).content, "Hello there!");
}

// 部品
{
  eq("parseCreatedAt ns", parseCreatedAt("2026-11-07T07:35:00.495979Z"), Date.UTC(2026, 10, 7, 7, 35, 0, 495));
  eq("parseCreatedAt no frac", parseCreatedAt("2026-11-07T07:35:00Z"), Date.UTC(2026, 10, 7, 7, 35, 0, 0));
  eq("parseCreatedAt offset", parseCreatedAt("2026-11-07T16:35:00.5+09:00"), Date.UTC(2026, 10, 7, 7, 35, 0, 500));
  eq("parseCreatedAt bad", parseCreatedAt("yesterday"), null);
  eq("chunkKind", [
    chunkKind({ error: "x" }),
    chunkKind({ choices: [], object: "chat.completion.chunk" }),
    chunkKind({ choices: [], object: "chat.completion" }),
    chunkKind({ response: "", done: false }),
    chunkKind({ message: {}, done: false }),
    chunkKind({ foo: 1 }),
  ], ["error", "openaiChat", "openaiWhole", "ollamaGenerate", "ollamaChat", null]);
  const h = stripHttpHeaders([{ no: 1, text: "HTTP/1.1 200 OK" }, { no: 2, text: "Content-Type: text/event-stream" }, { no: 3, text: "" }, { no: 4, text: "data: [DONE]" }]);
  eq("stripHttpHeaders", [h.status, h.lines.map((l) => l.no)], [200, [4]]);
  const ok = readStream("HTTP/1.1 200 OK\nContent-Type: application/x-ndjson\n\n" + FX_GENERATE);
  eq("200 headers", [codes(ok), ok.content, ok.problems.length], [[], "Hello there!", 0]);
}

console.log(`check-ollama-stream: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
