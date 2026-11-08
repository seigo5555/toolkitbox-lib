/**
 * Safetensors Metadata Viewer(src/lib/safetensors.ts)の検算。
 *
 * 1) 本物の見出し: scripts/fixtures/safetensors/ の Qwen2.5-7B-Instruct(4 ファイル+index+config)と
 *    Qwen2.5-0.5B-Instruct。2026-11-09 に Hugging Face から Range で取った見出しのバイトそのもの。期待値は sources.json
 *    (Hub の API が返したパラメーター数と、ファイルの大きさ)と index.json の total_size で、このツールの出力ではない。
 * 2) 公式の実装との突き合わせ: official-0.8.0.json の 52 通りのファイル。公式の Python パッケージ safetensors 0.8.0 が
 *    受け付けたか・拒否したか(とその理由)に、このツールの判定が合うか。
 * 3) 例(safetensors-example.ts)が本物とバイト単位で同じか。
 * 4) 組み合わせ(index・config・足りないファイル)と KV キャッシュ: 期待値は手で計算した。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EXAMPLE_CONFIG, buildExampleFiles, buildExampleIndex } from "../src/safetensors-example";
import { DTYPE_BITS, StNeedMore, combine, parseShardName, readHeaderText, readJson, readSafetensors, type StConfig, type StFile, type StIndex } from "../src/safetensors";

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

const DIR = join("scripts", "fixtures", "safetensors");
const sources = JSON.parse(readFileSync(join(DIR, "sources.json"), "utf8"));

function withLen(header: Uint8Array, data = new Uint8Array(0)) {
  const out = new Uint8Array(8 + header.length + data.length);
  new DataView(out.buffer).setBigUint64(0, BigInt(header.length), true);
  out.set(header, 8);
  out.set(data, 8 + header.length);
  return out;
}
const enc = (s: string) => new TextEncoder().encode(s);
const asIndex = (text: string, name = "model.safetensors.index.json") => {
  const j = readJson(text, name);
  if (j.kind !== "index") throw new Error(`not index: ${j.kind}`);
  return j.index;
};
const asConfig = (text: string, name = "config.json") => {
  const j = readJson(text, name);
  if (j.kind !== "config") throw new Error(`not config: ${j.kind}`);
  return j.config;
};

// ---- 1) 本物: Qwen2.5-7B-Instruct ----
{
  const src = sources["qwen2.5-7b-instruct"];
  const dir = join(DIR, "qwen2.5-7b-instruct");
  const files: StFile[] = [];
  for (let i = 1; i <= 4; i++) {
    const name = `model-0000${i}-of-00004.safetensors`;
    const h = readFileSync(join(dir, `model-0000${i}-of-00004.header.json`));
    const buf = withLen(h);
    const r = readSafetensors(buf, src.fileSize[name], name);
    eq(`7B ${name} ok`, r.ok, true);
    eq(`7B ${name} problems`, codes(r), []);
    eq(`7B ${name} expectedSize = file size`, r.expectedSize, src.fileSize[name]);
    eq(`7B ${name} metadata`, r.metadata, [["format", "pt"]]);
    eq(`7B ${name} shard`, r.shard, { base: "model", part: i, total: 4 });
    // 見出しが足りなければもっと読むよう求める
    let need = -1;
    try {
      readSafetensors(buf.subarray(0, 100), src.fileSize[name], name);
    } catch (e) {
      if (e instanceof StNeedMore) need = e.need;
    }
    eq(`7B ${name} need more`, need, 8 + h.length);
    files.push(r);
  }
  eq(
    "7B tensors per file",
    files.map((f) => f.tensors.length),
    [82, 97, 97, 63],
  );
  const index = asIndex(readFileSync(join(dir, "model.safetensors.index.json"), "utf8"));
  const config = asConfig(readFileSync(join(dir, "config.json"), "utf8"));
  const set = combine(files, index, config);
  eq("7B params = Hub API", set.params, src.total);
  eq("7B params by dtype = Hub API", Object.fromEntries(set.byDtype.map((d) => [d.dtype, d.params])), src.parameters);
  eq("7B bytes = index total_size", set.bytes, index.totalSize);
  eq("7B total_size", index.totalSize, 15231233024);
  eq("7B problems", codes(set), ["totalSizeMatches", "headDimDerived"]);
  eq("7B layers from names", set.layers, 28);
  eq(
    "7B index files",
    index.files.map((f) => [f.file, f.tensors]),
    [
      ["model-00004-of-00004.safetensors", 63],
      ["model-00001-of-00004.safetensors", 82],
      ["model-00002-of-00004.safetensors", 97],
      ["model-00003-of-00004.safetensors", 97],
    ],
  );
  // KV: 2 × 28 × 4 × 128 × 2 = 57,344 バイト/トークン → 4096 で 224 MiB(Ollama 0.40.11 のログと同じ)
  eq("7B kv per token", config.kvBytesPerToken, 57344);
  eq("7B headDim derived", [config.headDim, config.headDimDerived], [128, true]);
  eq("7B kv approx (use_sliding_window false)", config.kvApprox, false);
  eq(
    "7B kv 4096",
    set.kvRows.find((r) => r.ctx === 4096),
    { ctx: 4096, mib: 224, note: "default4k" },
  );
  eq("7B kv max", set.kvRows.at(-1), { ctx: 32768, mib: 1792, note: "max" });
  eq(
    "7B config",
    [config.architecture, config.modelType, config.dtype, config.contextLength, config.layers, config.heads, config.kvHeads, config.vocab, config.tieEmbeddings],
    ["Qwen2ForCausalLM", "qwen2", "bfloat16", 32768, 28, 28, 4, 152064, false],
  );

  // ファイルが 2 つだけ
  const two = combine([files[0], files[2]], index, config);
  eq("7B two files: missing", two.missingFiles, ["model-00004-of-00004.safetensors", "model-00002-of-00004.safetensors"]);
  eq("7B two files: problems", codes(two), ["indexFilesMissing", "headDimDerived"]);
  // index だけ
  const only = combine([], index, config);
  eq("7B index only: no missing list", [only.missingFiles, codes(only)], [[], ["headDimDerived"]]);
  // index が無くても名前から足りない部分が分かる
  const noIdx = combine([files[0], files[3]], null, null);
  eq("7B no index: shardMissing", noIdx.problems, [{ code: "shardMissing", severity: "info", detail: "model-00002-of-00004.safetensors, model-00003-of-00004.safetensors" }]);
  // index の total_size が合わない
  const bad = asIndex(readFileSync(join(dir, "model.safetensors.index.json"), "utf8").replace("15231233024", "15231233026"));
  eq("7B total_size mismatch", combine(files, bad, null).problems, [{ code: "totalSizeMismatch", severity: "warn", detail: "15231233026 / 15231233024" }]);
  // テンソルが index と違うファイルにある
  const moved = asIndex(
    readFileSync(join(dir, "model.safetensors.index.json"), "utf8").replace('"lm_head.weight": "model-00004-of-00004.safetensors"', '"lm_head.weight": "model-00001-of-00004.safetensors"'),
  );
  const mv = combine(files, moved, null);
  eq(
    "7B moved tensor",
    mv.problems.map((p) => [p.code, p.file, p.detail]),
    [
      ["tensorMissing", "model-00001-of-00004.safetensors", "lm_head.weight"],
      ["tensorNotInIndex", "model-00004-of-00004.safetensors", "lm_head.weight"],
      ["totalSizeMatches", undefined, "15231233024"],
    ],
  );
  // 貼り付けた見出し(ファイル名なし)は最初のテンソルから index のファイルを当てる
  const pasted = readHeaderText(readFileSync(join(dir, "model-00003-of-00004.header.json"), "utf8"));
  eq("7B pasted header ok", [pasted.ok, pasted.fileSize, pasted.expectedSize, pasted.tensors.length], [true, null, null, 97]);
  eq("7B pasted header matched to index", codes(combine([pasted], index, null)), ["indexFilesMissing"]);
  eq("7B pasted header missing list", combine([pasted], index, null).missingFiles, ["model-00004-of-00004.safetensors", "model-00001-of-00004.safetensors", "model-00002-of-00004.safetensors"]);

  // 3) 例が本物と同じ
  const ex = buildExampleFiles();
  for (let i = 0; i < 4; i++) {
    const real = withLen(readFileSync(join(dir, `model-0000${i + 1}-of-00004.header.json`)));
    eq(`example file ${i + 1} bytes`, Buffer.from(ex[i].header).equals(Buffer.from(real)), true);
    eq(`example file ${i + 1} size`, ex[i].size, src.fileSize[ex[i].name]);
  }
  eq("example index = real", buildExampleIndex() === readFileSync(join(dir, "model.safetensors.index.json"), "utf8"), true);
  eq("example config = real", EXAMPLE_CONFIG === readFileSync(join(dir, "config.json"), "utf8"), true);
}

// ---- 1) 本物: Qwen2.5-0.5B-Instruct(1 ファイル、出力層を埋め込みと共有) ----
{
  const src = sources["qwen2.5-0.5b-instruct"];
  const dir = join(DIR, "qwen2.5-0.5b-instruct");
  const h = readFileSync(join(dir, "model.header.json"));
  const r = readSafetensors(withLen(h), src.fileSize["model.safetensors"], "model.safetensors");
  eq("0.5B ok", [r.ok, codes(r)], [true, []]);
  eq("0.5B params = Hub API", r.params, src.total);
  eq("0.5B expectedSize", r.expectedSize, src.fileSize["model.safetensors"]);
  eq("0.5B tensors", [r.tensors.length, r.layers, r.shard], [290, 24, null]);
  eq("0.5B bpw", ((r.dataBytes * 8) / r.params).toFixed(2), "16.00");
  const config = asConfig(readFileSync(join(dir, "config.json"), "utf8"));
  const set = combine([r], null, config);
  eq("0.5B tied embeddings", codes(set), ["tiedEmbeddings", "headDimDerived"]);
  // 2 × 24 × 2 × 64 × 2 = 12,288 → 4096 で 48 MiB(Ollama 0.40.11 のログと同じ)
  eq("0.5B kv 4096", set.kvRows.find((x) => x.ctx === 4096)?.mib, 48);
  // 途中で切れたファイル
  const cut = readSafetensors(withLen(h), src.fileSize["model.safetensors"] - 10, "model.safetensors");
  eq("0.5B truncated", cut.problems, [{ code: "fileTruncated", severity: "error", detail: "10" }]);
  const part = readSafetensors(withLen(h), 1048576, "model.safetensors", { partial: true });
  eq("0.5B partial", [part.ok, part.problems], [true, [{ code: "partialFile", severity: "info", detail: String(src.fileSize["model.safetensors"]) }]]);
  const long = readSafetensors(withLen(h), src.fileSize["model.safetensors"] + 3, "model.safetensors");
  eq("0.5B too long", long.problems, [{ code: "fileTooLong", severity: "error", detail: "3" }]);
}

// ---- 2) 公式の safetensors 0.8.0 との突き合わせ ----
{
  const off = JSON.parse(readFileSync(join(DIR, "official-0.8.0.json"), "utf8")).cases as Record<string, { b64: string; official: "ok" | "err"; message: string | null }>;
  // 公式のメッセージ → このツールの理由
  const reason = (m: string): string[] => {
    if (m.includes("header too small")) return ["tooSmall"];
    if (m.includes("header too large")) return ["headerTooLarge"];
    if (m.includes("invalid header length")) return ["headerBeyondFile"];
    if (m.includes("invalid UTF-8")) return ["badUtf8"];
    if (m.includes("invalid offset")) return ["invalidOffset"];
    if (m.includes("incomplete metadata")) return ["fileTruncated", "fileTooLong"];
    if (m.includes("byte boundary")) return ["misaligned"];
    if (m.includes("invalid shape, data type, or offset")) return ["sizeMismatch"];
    if (m.includes("unknown variant") || m.includes("expected string or map")) return ["unknownDtype"];
    if (m.includes("duplicate field")) return ["duplicateField"];
    if (m.includes("missing field")) return ["missingField"];
    if (m.includes("expected struct TensorInfo")) return ["tensorNotObject"];
    if (m.includes("expected struct HashMetadata")) return ["notObject"];
    if (m.includes("expected a string") && m.includes("column 2")) return ["metadataNotStrings"];
    if (m.includes("expected usize") || m.includes("expected a sequence")) return ["badShape", "badOffsets"];
    if (m.includes("expected 2 elements")) return ["badOffsets"];
    return ["badJson"];
  };
  let n = 0;
  for (const [name, c] of Object.entries(off)) {
    const buf = new Uint8Array(Buffer.from(c.b64, "base64"));
    const r = readSafetensors(buf, buf.length, `${name}.safetensors`);
    eq(`official ${name}: ok/err`, r.ok ? "ok" : "err", c.official);
    if (c.official === "err") {
      const want = reason(c.message!);
      const got = r.problems.filter((p) => p.severity === "error").map((p) => p.code);
      eq(
        `official ${name}: reason ${want.join("|")}`,
        got.some((g) => want.includes(g)),
        true,
      );
    }
    n++;
  }
  eq("official cases", n, 52);
}

// ---- 手で組み立てた見出し(仕様にあって公式が受け付けるもの) ----
{
  const T = (dt: string, shape: number[], a: number, b: number) => ({ dtype: dt, shape, data_offsets: [a, b] });
  const mk = (h: object | string, data = 0) => {
    const b = withLen(enc(typeof h === "string" ? h : JSON.stringify(h)), new Uint8Array(data));
    return readSafetensors(b, b.length, "x.safetensors");
  };
  // 型ごとの合計とパラメーター数(I64 も数える。huggingface_hub と同じ)
  const r = mk({ __metadata__: { format: "pt" }, w: T("F16", [3, 5], 0, 30), pos: T("I64", [1, 4], 30, 62), s: T("F64", [], 62, 70) }, 70);
  eq(
    "hand params",
    [r.ok, r.params, r.byDtype.map((d) => [d.dtype, d.count, d.params, d.bytes])],
    [
      true,
      20,
      [
        ["I64", 1, 4, 32],
        ["F16", 1, 15, 30],
        ["F64", 1, 1, 8],
      ],
    ],
  );
  // 空のテンソル(大きさ 0)と F4(2 要素で 1 バイト)、F6(4 要素で 3 バイト)
  eq("hand empty+f4+f6", codes(mk({ e: T("F32", [0, 7], 0, 0), f4: T("F4", [6], 0, 3), f6: T("F6_E3M2", [8], 3, 9) }, 9)), []);
  eq("hand f4 odd", codes(mk({ f4: T("F4", [5], 0, 3) }, 3)), ["misaligned"]);
  // 重複(同じ値)は公式は読めるが、仕様では不可
  eq("hand dup", mk('{"a":{"dtype":"U8","shape":[1],"data_offsets":[0,1]},"a":{"dtype":"U8","shape":[1],"data_offsets":[0,1]}}', 1).problems, [
    { code: "duplicateTensor", severity: "warn", detail: "a" },
  ]);
  eq("hand leading/trailing", codes(mk(' {"a":{"dtype":"U8","shape":[1],"data_offsets":[0,1]}}\n', 1)), ["notStartBrace", "paddingNotSpace"]);
  eq("hand extra field", mk('{"a":{"dtype":"U8","shape":[1],"data_offsets":[0,1],"x":true}}', 1).problems, [{ code: "extraField", severity: "info", detail: "a.x" }]);
  eq("hand no tensors", codes(mk({ __metadata__: { a: "b" } })), ["noTensors"]);
  eq("gguf not also flagged as not in index", codes(combine([readSafetensors(enc("GGUF\x03\0\0\0\0\0\0\0"), 12, "m.gguf")], asIndex('{"weight_map":{"a":"model.safetensors"}}'), null)), ["indexFilesMissing"]);
  eq("hand gguf", codes(readSafetensors(enc("GGUF\x03\0\0\0\0\0\0\0"), 12, "m.gguf")), ["gguf"]);
  eq("hand zip", codes(readSafetensors(enc("PK\x03\x04\0\0\0\0\0\0"), 10, "pytorch_model.bin")), ["zip"]);
  // 見出しが 25,000,000 バイトを超える(公式は読めるが huggingface_hub は Hub で読まない)
  {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, 25_000_008n, true);
    let need = 0;
    try {
      readSafetensors(b, 30_000_000, "big.safetensors");
    } catch (e) {
      if (e instanceof StNeedMore) need = e.need;
    }
    eq("hand big header needs more", need, 25_000_016);
  }
  eq("dtype count", Object.keys(DTYPE_BITS).length, 22);
}

// ---- config.json のいろいろ ----
{
  const cfg = (o: object) => asConfig(JSON.stringify(o));
  // head_dim がある(Qwen3 など)
  const q3 = cfg({
    architectures: ["Qwen3ForCausalLM"],
    model_type: "qwen3",
    num_hidden_layers: 36,
    num_attention_heads: 32,
    num_key_value_heads: 8,
    hidden_size: 2560,
    head_dim: 128,
    max_position_embeddings: 40960,
  });
  eq("cfg head_dim given", [q3.headDim, q3.headDimDerived, q3.kvBytesPerToken], [128, false, 2 * 36 * 8 * 128 * 2]);
  // sliding_window が効いている(use_sliding_window が無く、文脈より短い)
  eq(
    "cfg sliding",
    cfg({ model_type: "mistral", num_hidden_layers: 32, num_attention_heads: 32, num_key_value_heads: 8, hidden_size: 4096, sliding_window: 4096, max_position_embeddings: 32768 }).kvApprox,
    true,
  );
  eq(
    "cfg sliding null",
    cfg({ model_type: "mistral", num_hidden_layers: 32, num_attention_heads: 32, num_key_value_heads: 8, hidden_size: 4096, sliding_window: null, max_position_embeddings: 32768 }).kvApprox,
    false,
  );
  eq("cfg layer_types", cfg({ model_type: "x", num_hidden_layers: 2, num_attention_heads: 2, hidden_size: 8, layer_types: ["sliding_attention", "full_attention"] }).kvApprox, true);
  eq("cfg mla", cfg({ model_type: "deepseek_v3", num_hidden_layers: 2, num_attention_heads: 2, hidden_size: 8, kv_lora_rank: 512 }).kvApprox, true);
  // KV ヘッドが無ければ注意ヘッドと同じ
  eq("cfg no kv heads", cfg({ model_type: "x", num_hidden_layers: 2, num_attention_heads: 4, hidden_size: 64 }).kvBytesPerToken, 2 * 2 * 4 * 16 * 2);
  // 画像と組み合わせたモデルは text_config
  const mm = cfg({
    architectures: ["Gemma3ForConditionalGeneration"],
    model_type: "gemma3",
    text_config: { num_hidden_layers: 34, num_attention_heads: 8, num_key_value_heads: 4, head_dim: 256, hidden_size: 2560, max_position_embeddings: 131072 },
  });
  eq("cfg text_config", [mm.architecture, mm.layers, mm.kvHeads, mm.headDim, mm.contextLength], ["Gemma3ForConditionalGeneration", 34, 4, 256, 131072]);
  const none = cfg({ model_type: "x" });
  eq("cfg kv missing", codes(combine([], null, none)), ["kvMissing"]);
  eq("cfg dtype differs", codes(combine([mkF16()], null, cfg({ model_type: "x", torch_dtype: "bfloat16" }))).includes("dtypeDiffers"), true);
}
function mkF16(): StFile {
  const b = withLen(enc('{"w":{"dtype":"F16","shape":[2],"data_offsets":[0,4]}}'), new Uint8Array(4));
  return readSafetensors(b, b.length, "model.safetensors");
}

// ---- JSON の見分け ----
{
  eq("json kind index", readJson('{"metadata":{},"weight_map":{}}').kind, "index");
  eq("json kind config", readJson('{"model_type":"llama"}').kind, "config");
  eq("json kind header", readJson('{"a":{"dtype":"U8","shape":[1],"data_offsets":[0,1]}}').kind, "header");
  eq("json kind header bad", readJson('{"a":{"dtype":"U8","shape":[1],"data_offsets":[0,1]},}').kind, "header");
  eq("json kind unknown", readJson('{"foo":1}').kind, "unknown");
  eq("json kind not json", readJson("hello").kind, "unknown");
  const idx: StIndex = asIndex('{"metadata":{"total_size":10,"total_parameters":5,"format":"pt"},"weight_map":{"a":"m-00001-of-00002.safetensors","b":"m-00002-of-00002.safetensors"}}');
  eq("index fields", [idx.totalSize, idx.totalParameters, idx.otherMetadata, idx.files.length], [10, 5, [["format", "pt"]], 2]);
  eq("index bad", codes(asIndex('{"weight_map":{"a":1}}')), ["badIndex"]);
  const c: StConfig = asConfig('{"architectures":["LlamaForCausalLM"],"model_type":"llama","dtype":"bfloat16"}');
  eq("config dtype key", c.dtype, "bfloat16");
}

// ---- ファイル名 ----
eq("shard name", parseShardName("model-00002-of-00004.safetensors"), { base: "model", part: 2, total: 4 });
eq("shard variant", parseShardName("model.fp16-00001-of-00002.safetensors"), { base: "model.fp16", part: 1, total: 2 });
eq("not shard", parseShardName("model.safetensors"), null);

console.log(`check-safetensors: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
