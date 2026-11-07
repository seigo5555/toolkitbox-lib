/**
 * Ollama Log Reader の検算。
 *
 * scripts/fixtures/ollama-log/ は 2026-11-07 に取った本物のログ(ホームのパスだけ /Users/you に置き換えた):
 *  - linux-cpu-qwen2.5-0.5b.log: Docker の ollama/ollama:0.40.11(Linux・GPU なし・メモリ 1.9 GiB)。qwen2.5:0.5b で
 *    普通の要求、num_ctx 256 に 633 トークン(切られる)、同じく truncate:false(400)、num_ctx 65536(32768 に下がる)、無いモデル(404)
 *  - linux-cpu-qwen2.5-7b-oom.log: 同じ環境で qwen2.5:7b。重みがメモリに入らず、読み込み中に signal: killed で落ちて 500
 *  - macos-metal-qwen2.5-7b.log: macOS(Apple M1)の Ollama 0.40.11。qwen2.5:7b を GPU に 29/29 層
 * 期待値はログを目で読んで書き写したもの。手で作った例(journalctl の頭・一部だけ GPU・ほかの警告)は、
 * ollama/ollama v0.40.15 のソースにあるメッセージと、llama.cpp(b12111)の書く行の形に合わせた。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EXAMPLE_LINUX, EXAMPLE_LINUX_OOM, EXAMPLE_MAC } from "../src/ollama-log-examples";
import { bufferTotals, goDurationToSec, parseAttrs, parseTime, readLog, stripPrefix, toMib } from "../src/ollama-log";

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
function near(name: string, actual: number | null | undefined, expected: number, eps = 1e-6) {
  if (typeof actual === "number" && Math.abs(actual - expected) <= eps) pass++;
  else {
    fail++;
    console.error(`NG ${name}\n  actual:   ${actual}\n  expected: ${expected}`);
  }
}
const codes = (r: { problems: { code: string }[] }) => r.problems.map((p) => p.code);
// リポジトリの一番上から実行する(npm run check)。
const fx = (name: string) => readFileSync(join("scripts", "fixtures", "ollama-log", `${name}.log`), "utf8");

// ---- Linux・GPU なし・qwen2.5:0.5b ----
{
  const r = readLog(fx("linux-cpu-qwen2.5-0.5b"));
  eq("linux server", [r.server.version, r.server.listen, r.server.defaultCtx], ["0.40.11", "[::]:11434", 4096]);
  eq("linux gpus", r.server.gpus, [{ library: "cpu", name: "cpu", total: "1.9 GiB", available: "1.9 GiB" }]);
  eq("linux env", r.server.env, [
    ["OLLAMA_HOST", "http://0.0.0.0:11434"],
    ["OLLAMA_CONTEXT_LENGTH", "0"],
    ["OLLAMA_NUM_PARALLEL", "1"],
    ["OLLAMA_MAX_LOADED_MODELS", "0"],
    ["OLLAMA_KEEP_ALIVE", "5m0s"],
    ["OLLAMA_FLASH_ATTENTION", "false"],
  ]);
  eq("linux loads", r.loads.length, 3);
  eq("linux load ctx", r.loads.map((l) => l.ctx), [4096, 256, 32768]);
  const l0 = r.loads[0];
  eq("linux load0", [l0.model, l0.name, l0.fileType, l0.fileSize, l0.ctxTrain, l0.parallel, l0.offloaded, l0.startSec, l0.failed], [
    "sha256-c5396e06af29",
    "Qwen2.5 0.5B Instruct",
    "Q4_K - Medium",
    "373.71 MiB (6.35 BPW)",
    32768,
    1,
    null,
    1.27,
    null,
  ]);
  eq("linux load0 buffers", l0.buffers, [
    { device: "CPU", kind: "model", mib: 303.34 },
    { device: "CPU_REPACK", kind: "model", mib: 208.3 },
    { device: "CPU", kind: "kv", mib: 48 },
    { device: "CPU", kind: "compute", mib: 41.27 },
  ]);
  near("linux load0 totals", bufferTotals(l0).total, 303.34 + 208.3 + 48 + 41.27);
  eq("linux kv by ctx", r.loads.map((l) => l.kvMib), [48, 3, 384]);
  eq("linux kvType", l0.kvType, "f16");
  near("linux sys total", l0.sysTotalMib, 1.9 * 1024);
  near("linux swap free", l0.swapFreeMib, 777);
  eq("linux requests", r.requests.map((q) => [q.status, q.method, q.path]), [
    [200, "GET", "/api/version"],
    [200, "POST", "/api/pull"],
    [200, "GET", "/api/tags"],
    [200, "POST", "/api/chat"],
    [200, "POST", "/api/chat"],
    [400, "POST", "/api/chat"],
    [200, "POST", "/api/chat"],
    [404, "POST", "/api/chat"],
  ]);
  near("linux request sec", r.requests[1].seconds, 17.49);
  eq("linux timings", r.timings.map((t) => [t.promptTokens, t.promptTps, t.evalTokens, t.evalTps]), [
    [35, 217.47, 7, 59.89],
    [130, 227.33, 11, 94.82],
    [30, 202.69, 5, 62.73],
  ]);
  eq("linux problems", codes(r), ["ctxBelowTrain", "ctxBelowTrain", "truncated", "contextExceeded", "terminatedReload", "ctxTooLarge", "httpErrors"]);
  const tr = r.problems.find((p) => p.code === "truncated")!;
  eq("linux truncated", tr.values, { prompt: "633", new: "130", limit: "130", keep: "4" });
  // limit = num_ctx − max((num_ctx − keep) / 2, 1) = 256 − 126
  eq("linux truncated formula", 256 - Math.max(Math.floor((256 - 4) / 2), 1), 130);
  eq("linux exceeded", r.problems.find((p) => p.code === "contextExceeded")!.values, { prompt: "633", ctx: "256" });
  eq("linux tooLarge", r.problems.find((p) => p.code === "ctxTooLarge")!.values, { requested: "65536", train: "32768" });
  eq("linux http", r.problems.find((p) => p.code === "httpErrors")!.detail, "400 POST /api/chat, 404 POST /api/chat");
  eq("linux http severity", r.problems.find((p) => p.code === "httpErrors")!.severity, "warn");
  eq("linux prefix", r.prefix, "none");
}

// ---- Linux・GPU なし・qwen2.5:7b が入らない ----
{
  const r = readLog(fx("linux-cpu-qwen2.5-7b-oom"));
  eq("oom problems", codes(r), ["buffersExceedMemory", "loadFailed", "httpErrors"]);
  eq("oom values", r.problems[0].values, { buffers: "4460", total: "1946" });
  eq("oom detail", r.problems[1].detail, "llama-server process has terminated: signal: killed");
  eq("oom load", [r.loads[0].failed, r.loads[0].startSec, r.loads[0].kvMib], ["llama-server process has terminated: signal: killed", null, null]);
  eq("oom request", [r.requests[2].status, r.requests[2].seconds], [500, 80]);
  eq("oom http severity", r.problems[2].severity, "error");
}

// ---- macOS・Metal・qwen2.5:7b ----
{
  const r = readLog(fx("macos-metal-qwen2.5-7b"));
  eq("mac problems", codes(r), ["ctxBelowTrain"]);
  const l = r.loads[0];
  eq("mac offload", [l.offloaded, l.layersTotal], [29, 29]);
  eq("mac gpu", l.gpuAvailable, ["Metal 11.3 GiB"]);
  eq("mac buffers", l.buffers.map((b) => `${b.device} ${b.kind} ${b.mib}`), ["CPU model 292.36", "MTL0 model 4168.09", "MTL0 kv 224", "MTL0 compute 143.01", "CPU compute 32.02"]);
  eq("mac kv", [l.kvMib, l.kvType, l.ctx], [224, "f16", 4096]);
  // 2 × 28 層 × 4 × 128 × 2 バイト × 4096 = 224 MiB(メモリ見積もりと同じ式)
  eq("mac kv formula", (2 * 28 * 4 * 128 * 2 * 4096) / 1048576, 224);
  eq("mac start", l.startSec, 4.84);
  eq("mac timings", r.timings.map((t) => [t.promptTokens, t.evalTokens, t.evalTps]), [
    [35, 7, 8.88],
    [131, 20, 10.48],
    [1, 7, 9.96],
  ]);
  // llama.cpp は最初のトークンを数えない: 6 ÷ 0.67582 秒 = 8.88
  near("mac eval rate n-1", (7 - 1) / 0.67582, 8.878, 1e-3);
  eq("mac requests", r.requests.map((q) => [q.status, q.seconds, q.path]), [
    [200, 6.31, "/api/chat"],
    [200, 3.13, "/api/chat"],
    [200, 0.7197, "/v1/chat/completions"],
  ]);
  eq("mac server empty", [r.server.version, r.server.gpus.length], ["", 0]);
}

// ---- 手で作った例 ----
const T = (t: string, level: string, msg: string, rest = "") => `time=2026-11-07T08:00:${t}.000Z level=${level} source=x.go:1 msg="${msg}"${rest ? " " + rest : ""}`;

// journalctl の頭が付いたログ
{
  const lines = fx("linux-cpu-qwen2.5-7b-oom")
    .split("\n")
    .map((l) => (l ? `Nov 07 08:12:09 vps ollama[1234]: ${l}` : l))
    .join("\n");
  const r = readLog(lines);
  eq("journal prefix", r.prefix, "journal");
  eq("journal same", codes(r), ["buffersExceedMemory", "loadFailed", "httpErrors"]);
  const iso = readLog(`2026-11-07T08:12:09+0000 vps ollama[1234]: ${T("01", "INFO", "Listening on 127.0.0.1:11434 (version 0.40.15)")}`);
  eq("journal iso", [iso.prefix, iso.server.version], ["journalIso", "0.40.15"]);
  const dk = readLog(`2026-11-07T08:12:09.123456789Z ${T("01", "INFO", "Listening on [::]:11434 (version 0.40.15)")}`);
  eq("docker ts", [dk.prefix, dk.server.listen], ["docker", "[::]:11434"]);
}

// 一部だけ GPU・GPU があるのに 0 層・ほかの警告
{
  const gpu = T("00", "INFO", "inference compute", 'id=GPU-1 library=CUDA name=CUDA0 description="NVIDIA GeForce RTX 3060" total="12.0 GiB" available="11.5 GiB"');
  const start = (c: number) => T("01", "INFO", "starting llama-server", `cmd="/usr/lib/ollama/llama-server --model /m/blobs/sha256-aaaaaaaaaaaabbbb --port 1 -c ${c} -np 2"`);
  const r = readLog(
    [
      gpu,
      start(8192),
      "load_tensors: offloaded 20/49 layers to GPU",
      "load_tensors:        CUDA0 model buffer size =  5000.00 MiB",
      "load_tensors:          CPU model buffer size =  4000.00 MiB",
      start(8192),
      "load_tensors: offloaded 0/49 layers to GPU",
      T("05", "WARN", "deprecated option provided", "option=typical_p"),
      T("06", "WARN", "the context field is deprecated and will be removed in a future version of Ollama"),
      T("07", "WARN", "runtime OOM detected; expiring loaded models to clear memory before next request", 'model=x error="out of memory"'),
      T("08", "WARN", "llama-server load failed; reducing automatic context and retrying once", "model=x old_num_ctx=32768 effective_num_ctx=32768 new_num_ctx=16384"),
      T("09", "WARN", "llama-server load failed; evicting all other models and retrying once", "model=x"),
      T("10", "WARN", "NVIDIA driver too old", 'device="NVIDIA GeForce GTX 1080" compute=6.1 driver=535 required_driver="570 or newer"'),
      T("11", "WARN", "client connection closed before llama-server finished loading, aborting load"),
      T("12", "ERROR", "llama-server terminated", 'error="exit status 2" exit=2'),
      T("20", "WARN", "something new", 'error="boom"'),
      "[GIN] 2026/11/07 - 08:00:21 | 500 |  1m20.5s |       10.0.0.2 | POST     \"/api/generate\"",
    ].join("\n"),
  );
  eq("hand problems", codes(r), [
    "partialOffload",
    "noOffload",
    "deprecatedOption",
    "contextDeprecated",
    "runtimeOom",
    "loadRetryCtx",
    "loadRetryEvict",
    "driverOld",
    "clientClosed",
    "terminated",
    "otherWarn",
    "httpErrors",
  ]);
  eq("hand partial", r.problems[0].values, { n: "20", total: "49" });
  eq("hand retry", r.problems[5].values, { old: "32768", new: "16384" });
  eq("hand terminated", r.problems[9].detail, "exit status 2");
  eq("hand driver", r.problems[7].detail, "NVIDIA GeForce GTX 1080, driver 535, required 570 or newer");
  eq("hand deprecated", r.problems[2].detail, "typical_p");
  eq("hand other", r.problems[10].detail, "something new: boom");
  eq("hand parallel", r.loads.map((l) => [l.ctx, l.parallel, l.model]), [
    [8192, 2, "sha256-aaaaaaaaaaaa"],
    [8192, 2, "sha256-aaaaaaaaaaaa"],
  ]);
  eq("hand gpu", r.server.gpus[0], { library: "CUDA", name: "NVIDIA GeForce RTX 3060", total: "12.0 GiB", available: "11.5 GiB" });
  eq("hand buffersExceed not on gpu", codes(r).includes("buffersExceedMemory"), false);
  near("hand gin 1m20.5s", r.requests[0].seconds, 80.5);
}

// 「terminated」のあと2秒を過ぎて読み込み直し → 読み込み直しとは見ない
{
  const r = readLog(
    [
      T("00", "ERROR", "llama-server terminated", 'error="signal: killed" exit=unknown'),
      'time=2026-11-07T08:00:05.000Z level=INFO source=x.go:1 msg="starting llama-server" cmd="llama-server --model /m/x.gguf -c 4096 -np 1"',
    ].join("\n"),
  );
  eq("late reload", codes(r), ["terminated"]);
  eq("late model name", r.loads[0].model, "x.gguf");
  const q = readLog(
    [
      T("00", "ERROR", "llama-server terminated", 'error="signal: killed" exit=unknown'),
      'time=2026-11-07T08:00:01.500Z level=INFO source=x.go:1 msg="starting llama-server" cmd="llama-server --model /m/x.gguf -c 4096 -np 1"',
    ].join("\n"),
  );
  eq("quick reload", codes(q), ["terminatedReload"]);
}

// 画面の例(本物のログの抜粋)は、元のログと同じものを拾う
{
  const same = (name: string, ex: string, file: string) => {
    const a = readLog(ex);
    const b = readLog(fx(file));
    eq(`example ${name} problems`, codes(a), codes(b));
    eq(`example ${name} loads`, a.loads.map((l) => ({ ...l, line: 0 })), b.loads.map((l) => ({ ...l, line: 0 })));
    eq(`example ${name} requests`, a.requests.map((q) => ({ ...q, line: 0 })), b.requests.map((q) => ({ ...q, line: 0 })));
    eq(`example ${name} timings`, a.timings.map((t) => ({ ...t, line: 0 })), b.timings.map((t) => ({ ...t, line: 0 })));
    eq(`example ${name} server`, a.server, b.server);
  };
  same("linux", EXAMPLE_LINUX, "linux-cpu-qwen2.5-0.5b");
  same("oom", EXAMPLE_LINUX_OOM, "linux-cpu-qwen2.5-7b-oom");
  same("mac", EXAMPLE_MAC, "macos-metal-qwen2.5-7b");
}

// 入力の不備
{
  eq("empty", codes(readLog(" \n")), ["inputEmpty"]);
  eq("unknown", codes(readLog("hello\nworld")), ["nothingRecognized"]);
  eq("bom", readLog("﻿" + T("00", "INFO", "Listening on 127.0.0.1:11434 (version 0.40.11)")).server.version, "0.40.11");
  eq("crlf", readLog(T("00", "INFO", "Listening on 127.0.0.1:11434 (version 0.40.11)") + "\r\n").recognized, 1);
}

// 部品
{
  eq("parseAttrs", parseAttrs(' a=1 b="x y" c="q\\"uote" d= e=last'), { a: "1", b: "x y", c: 'q"uote', d: "", e: "last" });
  eq("toMib", [toMib("16.0 GiB"), toMib("1002.3 MiB"), toMib("0 B"), toMib("512 KiB"), toMib("abc")], [16384, 1002.3, 0, 0.5, null]);
  eq("goDuration", [goDurationToSec("1m20s"), goDurationToSec("6.31s"), goDurationToSec("1h2m3s"), goDurationToSec("x")], [80, 6.31, 3723, null]);
  near("goDuration ms", goDurationToSec("16.01ms"), 0.01601, 1e-12);
  near("goDuration µs", goDurationToSec("624.209µs"), 0.000624209, 1e-12);
  eq("stripPrefix none", stripPrefix("time=x").prefix, "none");
  eq("stripPrefix journal", stripPrefix("Nov  7 08:12:09 vps ollama[1]: [GIN] x"), { text: "[GIN] x", prefix: "journal" });
  eq("parseTime", parseTime("2026-11-07T16:34:54.918+09:00"), Date.UTC(2026, 10, 7, 7, 34, 54, 918));
  eq("parseTime ns", parseTime("2026-11-07T08:32:10.185260214Z"), Date.UTC(2026, 10, 7, 8, 32, 10, 185));
}

console.log(`check-ollama-log: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
