/**
 * GGUF Metadata Viewer(src/lib/gguf.ts)の検算。
 *
 * 1) 本物のファイル: 手元に Ollama の qwen2.5:7b があれば(~/.ollama/models/blobs/ の blob、または環境変数 GGUF_REAL)、
 *    その先頭を読み、scripts/fixtures/gguf/qwen2.5-7b-ollama.json と比べる。この JSON は 2026-11-08 に
 *    Ollama 0.40.11 の /api/show(verbose: true)が返したもの(メタデータ・テンソル 339 個の名前・型・形・パラメーター数)と
 *    ファイルの大きさで、このツールの出力ではない。無ければこの部分は飛ばす。
 * 2) 手で組み立てた GGUF: 期待値は docs/gguf.md と llama.cpp の gguf.cpp の決まりから手で計算した。
 * 3) ファイル名: docs/gguf.md にある parseGGUFFilename のテスト 7 件をそのまま。
 */
import { existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { EXAMPLE_FILE_NAME, buildExample } from "../src/gguf-example";
import { FILE_TYPES, GGML_TYPES, GgufNeedMore, VALUE_TYPES, formatValue, parseFileName, readGguf, type GgufResult, type ValueType } from "../src/gguf";

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
const codes = (r: GgufResult) => r.problems.map((p) => p.code);

// ---- 小さな GGUF を組み立てる ----
type V = { t: ValueType; v: unknown; item?: ValueType };
class W {
  parts: Uint8Array[] = [];
  constructor(private le = true) {}
  raw(b: number[] | Uint8Array) {
    this.parts.push(Uint8Array.from(b));
    return this;
  }
  u32(n: number) {
    const b = new DataView(new ArrayBuffer(4));
    b.setUint32(0, n, this.le);
    return this.raw(new Uint8Array(b.buffer));
  }
  u64(n: number | bigint) {
    const b = new DataView(new ArrayBuffer(8));
    b.setBigUint64(0, BigInt(n), this.le);
    return this.raw(new Uint8Array(b.buffer));
  }
  str(s: string) {
    const e = new TextEncoder().encode(s);
    return this.u64(e.length).raw(e);
  }
  val(t: ValueType, v: unknown, item?: ValueType): this {
    const dv = new DataView(new ArrayBuffer(8));
    const put = (n: number, f: (o: number) => void) => {
      f(0);
      this.raw(new Uint8Array(dv.buffer.slice(0, n)));
    };
    switch (t) {
      case "uint8":
        return this.raw([v as number]);
      case "int8":
        put(1, () => dv.setInt8(0, v as number));
        return this;
      case "uint16":
        put(2, () => dv.setUint16(0, v as number, this.le));
        return this;
      case "int16":
        put(2, () => dv.setInt16(0, v as number, this.le));
        return this;
      case "uint32":
        return this.u32(v as number);
      case "int32":
        put(4, () => dv.setInt32(0, v as number, this.le));
        return this;
      case "float32":
        put(4, () => dv.setFloat32(0, v as number, this.le));
        return this;
      case "bool":
        return this.raw([v ? 1 : 0]);
      case "string":
        return this.str(v as string);
      case "uint64":
        return this.u64(v as number | bigint);
      case "int64":
        put(8, () => dv.setBigInt64(0, BigInt(v as number), this.le));
        return this;
      case "float64":
        put(8, () => dv.setFloat64(0, v as number, this.le));
        return this;
      case "array": {
        const arr = v as unknown[];
        this.u32(VALUE_TYPES.indexOf(item!)).u64(arr.length);
        for (const x of arr) {
          if (item === "array") {
            const [it, inner] = x as [ValueType, unknown[]];
            this.val("array", inner, it);
          } else this.val(item!, x);
        }
        return this;
      }
    }
  }
  kv(key: string, x: V) {
    this.str(key).u32(VALUE_TYPES.indexOf(x.t));
    return this.val(x.t, x.v, x.item);
  }
  tensor(name: string, shape: number[], type: number, offset: number) {
    this.str(name).u32(shape.length);
    for (const d of shape) this.u64(d);
    return this.u32(type).u64(offset);
  }
  get length() {
    return this.parts.reduce((s, p) => s + p.length, 0);
  }
  bytes() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

type Spec = {
  version?: number;
  le?: boolean;
  kvs: [string, V][];
  tensors?: [string, number[], number, number][];
  /** 書いた見出しに対してこれだけのファイルの大きさにする(既定はちょうど)。 */
  sizeDelta?: number;
};
/** 見出しを組み立て、ファイルの大きさ(重みのぶんを足した値)と一緒に返す。重みのバイト列そのものは要らない(読まないため)。 */
function build(s: Spec): { bytes: Uint8Array; size: number; header: number } {
  const w = new W(s.le ?? true);
  w.raw([0x47, 0x47, 0x55, 0x46]).u32(s.version ?? 3).u64(s.tensors?.length ?? 0).u64(s.kvs.length);
  for (const [k, v] of s.kvs) w.kv(k, v);
  for (const t of s.tensors ?? []) w.tensor(...t);
  const header = w.length;
  return { bytes: w.bytes(), size: header + (s.sizeDelta ?? 0), header };
}
const S = (v: string): V => ({ t: "string", v });
const U32 = (v: number): V => ({ t: "uint32", v });
const U64 = (v: number | bigint): V => ({ t: "uint64", v });
const F32 = (v: number): V => ({ t: "float32", v });

// ---- 1) 本物のファイル ----
{
  const fx = JSON.parse(readFileSync(join("scripts", "fixtures", "gguf", "qwen2.5-7b-ollama.json"), "utf8")) as {
    fileSize: number;
    model_info: Record<string, unknown>;
    tensors: { name: string; type: string; shape: number[] }[];
  };
  const blob = process.env.GGUF_REAL ?? join(homedir(), ".ollama", "models", "blobs", "sha256-2bada8a7450677000f678be90653b85d364de7db25eb5ea54136ada5f3933730");
  if (existsSync(blob)) {
    const fd = openSync(blob, "r");
    const size = fstatSync(fd).size;
    // ブラウザと同じく、足りなければ長くして読み直す
    let n = 1 << 20;
    let reads = 0;
    let r: GgufResult;
    for (;;) {
      const b = Buffer.alloc(Math.min(n, size));
      readSync(fd, b, 0, b.length, 0);
      reads++;
      try {
        r = readGguf(new Uint8Array(b.buffer, b.byteOffset, b.length), size, "sha256-2bada8a7450677000f678be90653b85d364de7db25eb5ea54136ada5f3933730");
        break;
      } catch (e) {
        if (!(e instanceof GgufNeedMore)) throw e;
        n = Math.max(Math.ceil(e.need * 1.5), n * 2);
      }
    }
    eq("real size", size, fx.fileSize);
    eq("real reads > 1(トークンの一覧で 1 MiB を超える)", reads > 1, true);
    eq("real ok", [r.ok, r.version, r.alignment, r.bigEndian], [true, 3, 32, false]);
    // Ollama の model_info に無いのは general.name と tokenizer.chat_template だけ(Ollama が外す)
    eq(
      "real keys not in ollama",
      r.metadata.map((e) => e.key).filter((k) => !(k in fx.model_info)),
      ["general.name", "tokenizer.chat_template"],
    );
    let metaNg = 0;
    for (const [k, v] of Object.entries(fx.model_info)) {
      if (k === "general.parameter_count") continue; // Ollama が数えて足すもの
      const e = r.metadata.find((x) => x.key === k);
      if (!e) metaNg++;
      else if (typeof v === "number" && typeof e.value === "number") {
        if (Math.abs(e.value - v) > Math.abs(v) * 1e-6) metaNg++;
      } else if (typeof v === "object" && v !== null && "length" in v) {
        if (e.length !== (v as { length: number }).length) metaNg++;
      } else if (v !== null && e.value !== v) metaNg++;
    }
    eq("real metadata = ollama", metaNg, 0);
    eq("real tensor count", r.tensors.length, fx.tensors.length);
    eq(
      "real tensors = ollama(名前・型・形)",
      r.tensors.filter((t, i) => t.name !== fx.tensors[i].name || t.typeName !== fx.tensors[i].type || JSON.stringify(t.shape) !== JSON.stringify(fx.tensors[i].shape)).length,
      0,
    );
    eq("real params = ollama", r.paramCount, fx.model_info["general.parameter_count"]);
    // データ部の終わりがファイルの終わりとちょうど一致する
    eq("real expected size", [r.expectedSize, r.dataOffset! % 32, codes(r)], [size, 0, ["headDimDerived"]]);
    eq("real file type", r.fileType, { id: 15, name: "Q4_K_M" });
    eq("real by type", r.byType.map((t) => [t.typeName, t.count]), [
      ["Q4_K", 169],
      ["Q6_K", 29],
      ["F32", 141],
    ]);
    eq("real bpw", r.bitsPerWeight!.toFixed(2), "4.91");
    eq("real name", [r.name, r.arch, r.sizeLabel, r.license, r.baseModels], ["Qwen2.5 7B Instruct", "qwen2", "7B", "apache-2.0", ["Qwen / Qwen2.5 7B — https://huggingface.co/Qwen/Qwen2.5-7B"]]);
    eq("real tokenizer", [r.tokenizerModel, r.tokenizerPre, r.vocabSize, r.addBos], ["gpt2", "qwen2", 152064, false]);
    eq("real special", r.specialTokens.map((s) => [s.name, s.token.id, s.token.text]), [
      ["bos", 151643, "<|endoftext|>"],
      ["eos", 151645, "<|im_end|>"],
      ["pad", 151643, "<|endoftext|>"],
    ]);
    eq("real template", [r.chatTemplate.startsWith("{%- if tools %}"), r.chatTemplate.includes("<|im_start|>")], [true, true]);
    // Ollama 0.40.11 のログ: num_ctx 4096 で 224 MiB、8192 で 448 MiB
    eq("real kv", r.kvRows.map((x) => [x.ctx, x.mib, x.note]), [
      [2048, 112, null],
      [4096, 224, "default4k"],
      [8192, 448, null],
      [16384, 896, null],
      [32768, 1792, "max"],
    ]);
  } else console.log("check-gguf: 手元に qwen2.5:7b の blob が無いので、本物のファイルとの比較は飛ばした");
}

// ---- 2) 手で組み立てた GGUF ----
// 基本: F32 [4](16 バイト → 32 に切り上げ)と Q4_0 [64, 2](64 × 2 ÷ 32 × 18 = 72 バイト)
const base: Spec = {
  kvs: [
    ["general.architecture", S("llama")],
    ["general.name", S("Tiny")],
    ["llama.block_count", U32(2)],
    ["llama.embedding_length", U32(64)],
    ["llama.attention.head_count", U32(4)],
    ["llama.attention.head_count_kv", U32(2)],
    ["llama.context_length", U32(8192)],
  ],
  tensors: [
    ["a.weight", [4], 0, 0],
    ["b.weight", [64, 2], 2, 32],
  ],
};
{
  const { bytes, header } = build(base);
  const dataOffset = Math.ceil(header / 32) * 32;
  const size = dataOffset + 32 + 96;
  const r = readGguf(bytes, size);
  // 最後のテンソルは 32 + 72 = 104 バイト目で終わる(詰め物は数えない)
  eq("tiny ok", [r.ok, r.headerBytes, r.dataOffset, r.dataSize, r.expectedSize, codes(r).includes("fileTruncated")], [true, header, dataOffset, 128, dataOffset + 104, false]);
  eq("tiny tensors", r.tensors.map((t) => [t.typeName, t.elements, t.bytes]), [
    ["F32", 4, 16],
    ["Q4_0", 128, 72],
  ]);
  eq("tiny params", [r.paramCount, r.weightBytes, r.bitsPerWeight], [132, 88, (88 * 8) / 132]);
  // 2 層 × (2 ヘッド × 16 + 2 × 16) × 2 バイト = 256 バイト/トークン。64 ÷ 4 = 16 は推定
  eq("tiny kv", [r.headDim, r.kvBytesPerToken, r.kvRows.map((x) => x.ctx)], [16, 256, [2048, 4096, 8192]]);
  eq("tiny problems", codes(r), ["fileTypeUnset", "headDimDerived"]);
  // 最後の詰め物が無いファイルは読める。そこから 1 バイト足りない → 途中で切れたファイル
  eq("no trailing padding", codes(readGguf(bytes, dataOffset + 104)).includes("fileTruncated"), false);
  const t = readGguf(bytes, dataOffset + 103);
  eq("truncated file", t.problems.filter((p) => p.code === "fileTruncated"), [{ code: "fileTruncated", severity: "error", detail: "1" }]);
  // 先頭しか渡さない → もっと要る
  let need = 0;
  try {
    readGguf(bytes.subarray(0, 40), size);
  } catch (e) {
    if (e instanceof GgufNeedMore) need = e.need;
  }
  eq("need more", need > 40 && need <= header, true);
  // ファイル全体がそこで終わっている → 見出しが途中で切れている
  eq("header truncated", codes(readGguf(bytes.subarray(0, 40), 40)), ["headerTruncated"]);
}
// テンソルが 1 つも無い(語彙だけのファイルなど)→ 詰め物も無い
{
  const { bytes, header } = build({ kvs: [["general.architecture", S("llama")]] });
  const r = readGguf(bytes, header);
  eq("no tensors", [r.ok, r.dataOffset, r.expectedSize, r.paramCount], [true, header, header, null]);
}
// offset が詰めた位置と違う(llama.cpp は読まない)
{
  const { bytes, header } = build({ ...base, tensors: [base.tensors![0], ["b.weight", [64, 2], 2, 16]] });
  const r = readGguf(bytes, header + 1000);
  eq("offset mismatch", r.problems.find((p) => p.code === "offsetMismatch"), { code: "offsetMismatch", severity: "error", detail: "b.weight: 16 ≠ 32" });
}
// alignment 64
{
  const { bytes, header } = build({ ...base, kvs: [...base.kvs, ["general.alignment", U32(64)]], tensors: [base.tensors![0], ["b.weight", [64, 2], 2, 64]] });
  const r = readGguf(bytes, Math.ceil(header / 64) * 64 + 64 + 128);
  eq("alignment 64", [r.alignment, r.dataOffset! % 64, r.dataSize, codes(r).includes("fileTruncated")], [64, 0, 192, false]);
}
// ビッグエンディアン(llama.cpp が言う「version が大きすぎる」ファイル)
{
  const { bytes, header } = build({ ...base, le: false, tensors: [] });
  const r = readGguf(bytes, header);
  eq("big endian", [r.bigEndian, r.version, r.blockCount, r.contextLength, codes(r)[0]], [true, 3, 2, 8192, "bigEndian"]);
}
// 版
{
  eq("v0", codes(readGguf(build({ ...base, version: 0 }).bytes, 1000)), ["badVersion"]);
  eq("v1", codes(readGguf(build({ ...base, version: 1 }).bytes, 1000)), ["versionV1"]);
  eq("v4", readGguf(build({ ...base, version: 4 }).bytes, 1000).problems, [{ code: "versionTooNew", severity: "error", detail: "4" }]);
  const v2 = build({ ...base, version: 2, tensors: [] });
  eq("v2 reads", [readGguf(v2.bytes, v2.header).ok, readGguf(v2.bytes, v2.header).version], [true, 2]);
}
// 読めないもの
{
  const err = (s: Spec) => {
    const b = build(s);
    return readGguf(b.bytes, b.size + 10000).problems.filter((p) => p.severity === "error");
  };
  eq("dup key", err({ kvs: [...base.kvs, ["llama.block_count", U32(3)]] }), [{ code: "duplicateKey", severity: "error", detail: "llama.block_count" }]);
  eq("alignment type", err({ kvs: [...base.kvs, ["general.alignment", U64(32)]] }), [{ code: "alignmentType", severity: "error", detail: "uint64" }]);
  eq("alignment 48", err({ kvs: [...base.kvs, ["general.alignment", U32(48)]] }), [{ code: "badAlignment", severity: "error", detail: "48" }]);
  eq("5 dims", err({ kvs: base.kvs, tensors: [["x", [1, 1, 1, 1, 1], 0, 0]] }), [{ code: "tooManyDims", severity: "error", detail: "x: 5" }]);
  eq("dup tensor", err({ kvs: base.kvs, tensors: [base.tensors![0], ["a.weight", [4], 0, 32]] }), [{ code: "duplicateTensor", severity: "error", detail: "a.weight" }]);
  // 4 は Q4_2(取り除かれた型)
  eq("removed type", err({ kvs: base.kvs, tensors: [["x", [32], 4, 0]] }), [{ code: "unknownTensorType", severity: "error", detail: "x: 4" }]);
  eq("row not block", err({ kvs: base.kvs, tensors: [["x", [30], 2, 0]] }), [{ code: "rowNotBlock", severity: "error", detail: "x: 30 / Q4_0 (32)" }]);
  const bad = new W().raw([0x47, 0x47, 0x55, 0x46]).u32(3).u64(0).u64(1).str("k").u32(13).bytes();
  eq("bad value type", readGguf(bad, bad.length).problems, [{ code: "badValueType", severity: "error", detail: "13" }]);
}
// GGUF ではないもの
{
  // safetensors: 8 バイトの長さ(LE)+ "{"
  const st = new W().u64(2).raw([0x7b, 0x7d]).bytes();
  eq("safetensors", codes(readGguf(st, st.length)), ["safetensors"]);
  eq("not gguf", readGguf(new TextEncoder().encode("PK\u0003\u0004zip"), 7).problems, [{ code: "notGguf", severity: "error", detail: "50 4b 03 04" }]);
  eq("empty", codes(readGguf(new Uint8Array(0), 0)), ["notGguf"]);
}
// 値の型・配列
{
  const big = 2n ** 60n;
  const tokens = ["<s>", "</s>", "a", "b", "c", "d", "e", "f", "g", "h"];
  const { bytes, header } = build({
    kvs: [
      ["general.architecture", S("llama")],
      ["u8", { t: "uint8", v: 255 }],
      ["i8", { t: "int8", v: -1 }],
      ["u16", { t: "uint16", v: 65535 }],
      ["i16", { t: "int16", v: -2 }],
      ["i32", { t: "int32", v: -3 }],
      ["f32", F32(0.5)],
      ["b", { t: "bool", v: true }],
      ["u64big", U64(big)],
      ["i64", { t: "int64", v: -5 }],
      ["f64", { t: "float64", v: 0.1 }],
      ["nested", { t: "array", item: "array", v: [["uint8", [1, 2]], ["string", ["x"]]] }],
      ["long", { t: "array", item: "uint32", v: Array.from({ length: 2000 }, (_, i) => i) }],
      ["longstr", { t: "array", item: "string", v: Array.from({ length: 1500 }, (_, i) => `s${i}`) }],
      ["tokenizer.ggml.tokens", { t: "array", item: "string", v: tokens }],
      ["tokenizer.ggml.bos_token_id", U32(0)],
      ["tokenizer.ggml.eos_token_id", U32(1)],
      ["tokenizer.ggml.unknown_token_id", U32(99)],
      ["tokenizer.ggml.model", S("llama")],
    ],
  });
  const r = readGguf(bytes, header);
  const v = (k: string) => r.metadata.find((e) => e.key === k)!;
  eq("scalars", ["u8", "i8", "u16", "i16", "i32", "f32", "b", "u64big", "i64", "f64"].map((k) => v(k).value), [255, -1, 65535, -2, -3, 0.5, true, big.toString(), -5, 0.1]);
  eq("nested", [v("nested").itemType, v("nested").length, v("nested").value], ["array", 2, [null, null]]);
  eq("long array", [v("long").length, (v("long").value as number[]).length, v("long").partial, (v("long").value as number[])[1023]], [2000, 1024, true, 1023]);
  eq("long string array", [v("longstr").length, (v("longstr").value as string[]).length, v("longstr").partial], [1500, 1024, true]);
  eq("specials", r.specialTokens.map((s) => [s.name, s.token.text]), [
    ["bos", "<s>"],
    ["eos", "</s>"],
    ["unk", null],
  ]);
  eq("no chat template", [r.vocabSize, codes(r).includes("noChatTemplate")], [10, true]);
  eq("formatValue", [formatValue(v("f32")), formatValue(v("long")), formatValue({ key: "x", type: "string", value: "y".repeat(5) }, 3), formatValue(v("nested"))], [
    "0.5",
    "[0, 1, 2, 3, 4, 5, 6, 7, …]",
    '"yyy…"',
    "[[…], […]]",
  ]);
}
// KV: 層ごとの head_count_kv・key_length と value_length・sliding window
{
  const { bytes, header } = build({
    kvs: [
      ["general.architecture", S("x")],
      ["x.block_count", U32(3)],
      ["x.attention.head_count", U32(8)],
      ["x.attention.head_count_kv", { t: "array", item: "int32", v: [2, 0, 4] }],
      ["x.attention.key_length", U32(128)],
      ["x.attention.value_length", U32(64)],
      ["x.attention.sliding_window", U32(512)],
      ["x.context_length", U32(4096)],
    ],
  });
  const r = readGguf(bytes, header);
  // (2 + 0 + 4) × (128 + 64) × 2 バイト = 2304
  eq("kv per layer", [r.headCountKv, r.kvBytesPerToken, r.kvRows.map((x) => x.note)], [[2, 0, 4], 2304, [null, "max"]]);
  eq("kv per layer problems", codes(r), ["kvPerLayer", "kvApprox"]);
}
// 分割・アダプター・プロジェクター・imatrix
{
  const one = (kvs: [string, V][]) => {
    const b = build({ kvs });
    return readGguf(b.bytes, b.header);
  };
  const sp = one([...base.kvs, ["split.no", { t: "uint16", v: 1 }], ["split.count", { t: "uint16", v: 3 }], ["split.tensors.count", { t: "int32", v: 700 }]]);
  eq("split", [sp.split, sp.problems.find((p) => p.code === "splitPart")?.detail], [{ no: 1, count: 3, tensors: 700 }, "2/3"]);
  const ad = one([["general.architecture", S("llama")], ["general.type", S("adapter")], ["adapter.type", S("lora")], ["adapter.lora.alpha", F32(16)]]);
  eq("adapter", [codes(ad), ad.kvRows.length], [["adapterFile"], 0]);
  const cl = one([["general.architecture", S("clip")], ["clip.projector_type", S("mlp")]]);
  eq("projector", [codes(cl), cl.kvRows.length], [["projectorFile"], 0]);
  const im = one([["general.type", S("imatrix")], ["imatrix.chunk_count", U32(10)]]);
  eq("imatrix", codes(im), ["imatrixFile"]);
  const mamba = one([["general.architecture", S("mamba")], ["mamba.block_count", U32(2)], ["mamba.ssm.state_size", U32(16)]]);
  eq("ssm no heads", codes(mamba), ["kvMissing"]);
  const ft = one([...base.kvs, ["general.file_type", U32(15)]]);
  eq("file type", [ft.fileType, codes(ft).includes("fileTypeUnset")], [{ id: 15, name: "Q4_K_M" }, false]);
  const rope = one([...base.kvs, ["llama.rope.scaling.type", S("yarn")], ["llama.rope.scaling.factor", F32(4)], ["llama.rope.scaling.original_context_length", U32(32768)]]);
  eq("rope scaling", rope.ropeScaling, "yarn ×4 (32768)");
}

// ---- 画面の例(本物の値から組み立て直したもの)----
{
  const fx = JSON.parse(readFileSync(join("scripts", "fixtures", "gguf", "qwen2.5-7b-ollama.json"), "utf8")) as {
    model_info: Record<string, unknown>;
    tensors: { name: string; type: string; shape: number[] }[];
  };
  const ex = buildExample();
  const r = readGguf(ex.bytes, ex.size, EXAMPLE_FILE_NAME);
  eq("example ok", [r.ok, r.expectedSize, r.tensors.length], [true, ex.size, 339]);
  eq(
    "example tensors = ollama",
    r.tensors.filter((t, i) => t.name !== fx.tensors[i].name || t.typeName !== fx.tensors[i].type || JSON.stringify(t.shape) !== JSON.stringify(fx.tensors[i].shape)).length,
    0,
  );
  eq("example params = ollama", r.paramCount, fx.model_info["general.parameter_count"]);
  eq("example shape", [r.name, r.fileType?.name, r.contextLength, r.blockCount, r.headCountKv, r.headDim, r.kvRows.find((x) => x.ctx === 4096)?.mib], [
    "Qwen2.5 7B Instruct",
    "Q4_K_M",
    32768,
    28,
    4,
    128,
    224,
  ]);
  // 本物との違い: トークンの一覧とチャットテンプレートを入れていない
  eq("example omits", [r.vocabSize, r.specialTokens.map((s) => s.token.text), r.chatTemplate, codes(r)], [null, [null, null, null], "", ["headDimDerived"]]);
}

// ---- 3) ファイル名(docs/gguf.md のテスト) ----
{
  const cases: [string, unknown][] = [
    ["Mixtral-8x7B-v0.1-KQ2.gguf", { sidecar: null, baseName: "Mixtral", sizeLabel: "8x7B", fineTune: null, version: "v0.1", encoding: "KQ2", type: null, shard: null }],
    ["Grok-100B-v1.0-Q4_0-00003-of-00009.gguf", { sidecar: null, baseName: "Grok", sizeLabel: "100B", fineTune: null, version: "v1.0", encoding: "Q4_0", type: null, shard: "00003-of-00009" }],
    ["Hermes-2-Pro-Llama-3-8B-v1.0-F16.gguf", { sidecar: null, baseName: "Hermes-2-Pro-Llama-3", sizeLabel: "8B", fineTune: null, version: "v1.0", encoding: "F16", type: null, shard: null }],
    ["Phi-3-mini-3.8B-ContextLength4k-instruct-v1.0.gguf", { sidecar: null, baseName: "Phi-3-mini", sizeLabel: "3.8B-ContextLength4k", fineTune: "instruct", version: "v1.0", encoding: null, type: null, shard: null }],
    ["mtp-Qwen3-27B-v1.0-Q4_K_M.gguf", { sidecar: "mtp", baseName: "Qwen3", sizeLabel: "27B", fineTune: null, version: "v1.0", encoding: "Q4_K_M", type: null, shard: null }],
    ["mmproj-Qwen2-VL-7B-v1.0-F16.gguf", { sidecar: "mmproj", baseName: "Qwen2-VL", sizeLabel: "7B", fineTune: null, version: "v1.0", encoding: "F16", type: null, shard: null }],
    ["not-a-known-arrangement.gguf", null],
  ];
  for (const [name, want] of cases) eq(`filename ${name}`, parseFileName(name), want);
}

// ---- 表 ----
{
  // constants.py: Q4_K は 256 要素で 144 バイト、Q6_K は 210、Q8_0 は 32 要素で 34、IQ1_M は 56
  eq("type sizes", [GGML_TYPES[12][2], GGML_TYPES[14][2], GGML_TYPES[8][2], GGML_TYPES[29][2], GGML_TYPES[23][2]], [144, 210, 34, 56, 136]);
  eq("type count", Object.keys(GGML_TYPES).length, 36);
  eq("file types", [FILE_TYPES[15], FILE_TYPES[32], FILE_TYPES[38], Object.keys(FILE_TYPES).length], ["Q4_K_M", "BF16", "MXFP4_MOE", 38]);
}

console.log(`check-gguf: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
