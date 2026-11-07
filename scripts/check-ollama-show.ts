/**
 * Ollama Model Info Reader の検算。
 *
 * scripts/fixtures/ollama-show/ の出力:
 *  - api-show-qwen2.5-7b.json・cli-qwen2.5-7b.txt・cli-verbose-qwen2.5-7b.txt: 2026-11-07 に手元の Ollama 0.40.11 で取った本物
 *    (curl /api/show、ollama show、ollama show --verbose。ホームのパスだけ /Users/you に置き換えた)
 *  - docs-example-gemma4.json: docs.ollama.com/api-reference/show-model-details の応答例を JSON に書き写したもの
 * KV キャッシュの期待値は、同じ日に Ollama 0.40.11 のログ(llama_kv_cache: size)に出た値。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EXAMPLE_API, EXAMPLE_CLI, EXAMPLE_DOCS } from "../src/ollama-show-examples";
import { KNOWN_CAPABILITIES, kvMib, parseCli, parseParameters, readShow } from "../src/ollama-show";

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
const codes = (r: { problems: { code: string }[] }) => r.problems.map((p) => p.code);
// リポジトリの一番上から実行する(npm run check)。
const fx = (name: string) => readFileSync(join("scripts", "fixtures", "ollama-show", name), "utf8");

// ---- /api/show(本物) ----
{
  const r = readShow(fx("api-show-qwen2.5-7b.json"));
  eq("api input", r.input, "json");
  eq("api model", [r.arch, r.name, r.parameterCount, r.parameterSize, r.quantization, r.family, r.format], [
    "qwen2",
    "Qwen2.5 7B Instruct",
    7615616512,
    "7.6B",
    "Q4_K_M",
    "qwen2",
    "gguf",
  ]);
  eq("api shape", [r.contextLength, r.embeddingLength, r.blockCount, r.headCount, r.headCountKv, r.headDim], [32768, 3584, 28, 28, 4, 128]);
  eq("api caps", r.capabilities, ["completion", "tools"]);
  eq("api thinking", r.thinking, null);
  eq("api params", r.parameters, []);
  eq("api system", r.system, "You are Qwen, created by Alibaba Cloud. You are a helpful assistant.");
  eq("api template", r.templateSource, "go_template");
  eq("api license", [r.licenseId, r.licenseLink, r.license.trim().split("\n")[0]], [
    "apache-2.0",
    "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct/blob/main/LICENSE",
    "Apache License",
  ]);
  // 2 × 28 層 × 4 × 128 × 2 バイト = 57,344 バイト/トークン
  eq("api kv per token", r.kvBytesPerToken, 2 * 28 * 4 * 128 * 2);
  // ログ: 4096 で 224 MiB、8192 で 448 MiB
  eq("api kv rows", r.kvRows.map((x) => [x.ctx, x.mib, x.note]), [
    [2048, 112, null],
    [4096, 224, "default4k"],
    [8192, 448, null],
    [16384, 896, null],
    [32768, 1792, "max"],
  ]);
  eq("api problems", codes(r), ["headDimDerived"]);
}

// ---- ollama show / --verbose(本物) ----
{
  const c = readShow(fx("cli-qwen2.5-7b.txt"));
  eq("cli input", c.input, "cli");
  eq("cli model", [c.arch, c.parameterSize, c.contextLength, c.embeddingLength, c.quantization, c.templateSource], ["qwen2", "7.6B", 32768, 3584, "Q4_K_M", "go_template"]);
  eq("cli caps", c.capabilities, ["completion", "tools"]);
  eq("cli system", c.system, "You are Qwen, created by Alibaba Cloud. You are a helpful assistant.");
  eq("cli license", c.license.split("\n"), ["Apache License", "Version 2.0, January 2004", "..."]);
  eq("cli kv missing", [codes(c), c.kvRows.length], [["kvMissing"], 0]);
  const v = readShow(fx("cli-verbose-qwen2.5-7b.txt"));
  eq("verbose input", v.input, "cliVerbose");
  eq("verbose same as api", [v.name, v.parameterCount, v.blockCount, v.headCountKv, v.headDim, v.kvBytesPerToken], ["Qwen2.5 7B Instruct", 7615616512, 28, 4, 128, 57344]);
  eq("verbose kv rows", v.kvRows.map((x) => x.mib), [112, 224, 448, 896, 1792]);
}

// ---- 公式ドキュメントの例(gemma4: 考える・画像・sliding window・KV の共有・num_ctx) ----
{
  const r = readShow(fx("docs-example-gemma4.json"));
  eq("docs caps", r.capabilities, ["completion", "thinking", "vision"]);
  eq("docs thinking", r.thinking, { values: [false, true], default: true });
  eq("docs params", r.parameters, [
    ["temperature", "0.7"],
    ["num_ctx", "2048"],
  ]);
  eq("docs shape", [r.blockCount, r.headCountKv, r.headDim, r.slidingWindow, r.sharedKvLayers, r.contextLength], [42, 2, 512, 512, 18, 131072]);
  // key_length 512 をそのまま使う(embedding_length ÷ head_count = 320 ではない)
  eq("docs kv per token", r.kvBytesPerToken, 42 * (2 * 512 + 2 * 512) * 2);
  eq("docs problems", codes(r), ["kvApprox", "numCtxParam"]);
  eq("docs rows notes", r.kvRows.map((x) => [x.ctx, x.note]), [
    [2048, "param"],
    [4096, "default4k"],
    [8192, null],
    [16384, null],
    [32768, null],
    [65536, null],
    [131072, "max"],
  ]);
}

// ---- 手で作った例 ----
// qwen2.5:0.5b の形(config.json: 24 層・KV ヘッド 2・896 ÷ 14 = 64)。ログ: 4096 で 48 MiB、32768 で 384 MiB
{
  const r = readShow(
    JSON.stringify({
      details: { parameter_size: "494.03M", quantization_level: "Q4_K_M" },
      capabilities: ["completion", "tools"],
      model_info: {
        "general.architecture": "qwen2",
        "qwen2.block_count": 24,
        "qwen2.attention.head_count": 14,
        "qwen2.attention.head_count_kv": 2,
        "qwen2.embedding_length": 896,
        "qwen2.context_length": 32768,
      },
    }),
  );
  eq("0.5b kv", r.kvRows.filter((x) => x.ctx === 4096 || x.ctx === 32768).map((x) => x.mib), [48, 384]);
  eq("0.5b headDim", r.headDim, 64);
}

// value_length が key_length と違う・KV ヘッドの数が無い(head_count を使う)・MoE・知らない capability
{
  const r = readShow(
    JSON.stringify({
      capabilities: ["completion", "teleport"],
      model_info: {
        "general.architecture": "x",
        "x.block_count": 2,
        "x.attention.head_count": 4,
        "x.attention.key_length": 192,
        "x.attention.value_length": 128,
        "x.embedding_length": 1024,
        "x.expert_count": 8,
        "x.expert_used_count": 2,
      },
    }),
  );
  eq("kv k≠v", r.kvBytesPerToken, 2 * (4 * 192 + 4 * 128) * 2);
  eq("kv heads fallback", r.headCountKv, 4);
  eq("moe", [r.expertCount, r.expertUsed], [8, 2]);
  eq("no ctx → rows up to 262144", r.kvRows.map((x) => x.ctx).at(-1), 262144);
  eq("unknown cap", r.problems.map((p) => [p.code, p.detail]), [["unknownCapability", "teleport"]]);
}

// 画面の例は、元の出力と同じ結果になる(license などの長い文字列を除く)
{
  const strip = (r: ReturnType<typeof readShow>) => ({ ...r, license: "", system: r.system });
  eq("example api", strip(readShow(EXAMPLE_API)), strip(readShow(fx("api-show-qwen2.5-7b.json"))));
  eq("example cli", readShow(EXAMPLE_CLI), readShow(fx("cli-qwen2.5-7b.txt")));
  eq("example docs", readShow(EXAMPLE_DOCS), readShow(fx("docs-example-gemma4.json")));
}

// 入力の不備・ほかの応答
{
  eq("empty", codes(readShow("  ")), ["inputEmpty"]);
  eq("json invalid", codes(readShow("{ nope")), ["jsonInvalid"]);
  eq("error response", readShow('{"error":"model \'x\' not found"}').problems, [{ code: "errorResponse", severity: "error", detail: "model 'x' not found" }]);
  eq("tags pasted", codes(readShow('{"models":[{"name":"qwen2.5:7b"}]}')), ["notShowResponse"]);
  eq("text unknown", codes(readShow("hello world")), ["inputUnknown"]);
}

// 部品
{
  eq("parseParameters", parseParameters('stop "<|im_end|>"\nstop "<|endoftext|>"\nnum_ctx 8192\n\n temperature   0.2 '), [
    ["stop", '"<|im_end|>"'],
    ["stop", '"<|endoftext|>"'],
    ["num_ctx", "8192"],
    ["temperature", "0.2"],
  ]);
  const c = parseCli("  Model\n    architecture        llama    \n    context length      131072\n\n  Parameters\n    stop    \"<|eot_id|>\"\n\n  Capabilities\n    completion\n    vision\n");
  eq("parseCli", [c?.model, c?.parameters, c?.capabilities], [{ architecture: "llama", "context length": "131072" }, [["stop", '"<|eot_id|>"']], ["completion", "vision"]]);
  eq("parseCli none", parseCli("just text"), null);
  eq("kvMib", kvMib(57344, 4096), 224);
  eq("capabilities", KNOWN_CAPABILITIES.length, 10);
}

console.log(`check-ollama-show: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
