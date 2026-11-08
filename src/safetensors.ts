/**
 * safetensors ファイル(Hugging Face のモデルの重みの形式)の先頭(見出しの JSON)だけを読み、テンソルの一覧・型・
 * パラメーター数・重みの大きさを出す。分割されたモデルの model.safetensors.index.json と config.json もあれば、
 * 組み合わせて足りないファイル・食い違いと KV キャッシュを出す。重みは読まない。ブラウザの外には何も送らない。
 *
 * 出どころ:
 *  - 形式: huggingface/safetensors の README(Format): 先頭 8 バイトが見出しの長さ N(符号なし 64 ビット・リトルエンディアン)、
 *    続く N バイトが UTF-8 の JSON。'{' で始まり、後ろを空白(0x20)で埋めてよい。値は dtype・shape・data_offsets
 *    (データ部の先頭からの位置。END は終わりの次)。"__metadata__" は文字列から文字列への対応だけ。キーの重複は不可。
 *    データ部はすき間なく埋まっていること。リトルエンディアン・行優先
 *  - 読み込みのときの検査: safetensors/src/tensor.rs(v0.8.0)の read_metadata と Metadata::validate
 *    - 8 バイトに満たない → "header too small"、N > 100,000,000 → "header too large"、8 + N がファイルより長い → "invalid header length"
 *    - UTF-8 でない → "invalid UTF-8 in header"、JSON・型が合わない → "invalid JSON in header"(serde_json)
 *    - テンソルを data_offsets の順に並べ、先頭が前の終わりと一致しない・終わり < 先頭 → "invalid offset for tensor"
 *    - 要素数 × 型のビット数が 8 の倍数でない → MisalignedSlice、バイト数が終わり − 先頭と違う → "invalid shape, data type, or offset"
 *    - 8 + N + 最後のテンソルの終わり がファイルの大きさと違う → "incomplete metadata, file not fully covered"
 *    - 型(Dtype)は 22 種。大文字小文字を区別する
 *  - 公式の Python パッケージ safetensors 0.8.0 に壊れたファイルを読ませた結果(2026-11-09、scripts/fixtures/safetensors/official-0.8.0.json):
 *    仕様では不可でも公式が受け付けるもの: 先頭の空白・空白以外の空白文字での埋め・同じテンソル名の重複(後のほうが残る)・
 *    tensor の知らない項目。公式が拒否するもの: NUL での埋め、__metadata__ の重複、tensor の項目の重複、2.0 のような小数
 *  - huggingface_hub の constants.py: SAFETENSORS_MAX_HEADER_LENGTH = 25,000,000(Hub で見出しを読むときの上限)、
 *    分割ファイルの名前は model{suffix}.safetensors、suffix は "-%05d-of-%05d"(serialization/_base.py)、
 *    index の metadata.total_size はテンソルのバイト数の合計(同じ記憶域を共有するテンソルは1回)
 *  - transformers の modeling_utils.py: index は {"metadata": {"total_parameters", "total_size"}, "weight_map": {テンソル名: ファイル名}}
 *  - パラメーター数: huggingface_hub の utils/_safetensors.py と同じく、全テンソルの shape の積の合計(型ごと)
 *  - KV キャッシュ = 2 × num_hidden_layers × num_key_value_heads × head_dim × 2 バイト(f16)× 文脈の長さ
 *    (GGUF Metadata Viewer・Ollama Model Info Reader と同じ式)。head_dim が無ければ hidden_size ÷ num_attention_heads
 *
 * 2026-11-09 に Hugging Face の Qwen/Qwen2.5-7B-Instruct(a09a354)の 4 ファイルの見出しと index.json、
 * Qwen/Qwen2.5-0.5B-Instruct(7ae5576)の見出しを Range で取り、Hub の API の safetensors.parameters
 * (7,615,616,512 と 494,032,768)・ファイルの大きさ・total_size と一致することを確かめた(scripts/check-safetensors.ts)。
 */

export const ST_SPEC_URL = "https://github.com/huggingface/safetensors#format";
export const ST_METADATA_DOC_URL = "https://huggingface.co/docs/safetensors/metadata_parsing";
export const ST_IMPORT_DOC_URL = "https://docs.ollama.com/import";
export const ST_VERIFIED_ON = "2026-11-09";

/** safetensors/src/tensor.rs の Dtype と、1 要素のビット数。 */
export const DTYPE_BITS: Record<string, number> = {
  BOOL: 8,
  F4: 4,
  F6_E2M3: 6,
  F6_E3M2: 6,
  U8: 8,
  I8: 8,
  F8_E5M2: 8,
  F8_E4M3: 8,
  F8_E8M0: 8,
  F8_E4M3FNUZ: 8,
  F8_E5M2FNUZ: 8,
  I16: 16,
  U16: 16,
  F16: 16,
  BF16: 16,
  I32: 32,
  U32: 32,
  F32: 32,
  C64: 64,
  F64: 64,
  I64: 64,
  U64: 64,
};

export const MAX_HEADER = 100_000_000;
export const HUB_MAX_HEADER = 25_000_000;

export type Severity = "error" | "warn" | "info";
export type StProblemCode =
  // 1 ファイル
  | "tooSmall"
  | "gguf"
  | "zip"
  | "headerTooLarge"
  | "headerBeyondFile"
  | "hubHeaderLimit"
  | "badUtf8"
  | "badJson"
  | "notObject"
  | "notStartBrace"
  | "paddingNotSpace"
  | "duplicateTensor"
  | "duplicateField"
  | "metadataNotStrings"
  | "tensorNotObject"
  | "missingField"
  | "extraField"
  | "unknownDtype"
  | "badShape"
  | "badOffsets"
  | "invalidOffset"
  | "misaligned"
  | "sizeMismatch"
  | "overflow"
  | "fileTruncated"
  | "fileTooLong"
  | "noTensors"
  | "partialFile"
  // 組み合わせ
  | "badIndex"
  | "unknownJson"
  | "shardMissing"
  | "indexFilesMissing"
  | "fileNotInIndex"
  | "tensorNotInIndex"
  | "tensorMissing"
  | "tensorAcrossFiles"
  | "totalSizeMismatch"
  | "totalSizeMatches"
  | "totalParamsDiffer"
  | "tiedEmbeddings"
  | "dtypeDiffers"
  | "kvApprox"
  | "headDimDerived"
  | "kvMissing";
export type StProblem = {
  code: StProblemCode;
  severity: Severity;
  detail?: string;
  file?: string;
};

export type StTensor = {
  name: string;
  dtype: string;
  shape: number[];
  begin: number;
  end: number;
  params: number;
  bytes: number;
};
export type DtypeSummary = {
  dtype: string;
  count: number;
  params: number;
  bytes: number;
};
export type ShardName = { base: string; part: number; total: number };

export type StFile = {
  fileName: string;
  /** null は貼り付けた見出しの JSON(ファイルの大きさが分からない)。 */
  fileSize: number | null;
  headerLen: number | null;
  metadata: [string, string][] | null;
  /** data_offsets の順。 */
  tensors: StTensor[];
  byDtype: DtypeSummary[];
  params: number;
  /** データ部の大きさ(最後のテンソルの終わり)。 */
  dataBytes: number;
  /** 8 + N + データ部。見出しだけを貼ったときは null。 */
  expectedSize: number | null;
  shard: ShardName | null;
  /** テンソル名の layers.N から数えた層の数。 */
  layers: number | null;
  problems: StProblem[];
  /** 公式の実装が受け付ける(error が無い)。 */
  ok: boolean;
  /** ファイルの先頭だけを保存したもの(Range で取ったなど)。大きさの検査は飛ばす。 */
  partial: boolean;
};

export class StNeedMore extends Error {
  constructor(public need: number) {
    super(`need ${need} bytes`);
  }
}

// ---- JSON(serde_json と同じく厳密に読む。数の字面と重複キーを残す) ----

type JNum = { k: "num"; raw: string };
type JObj = { k: "obj"; entries: [string, JVal][] };
type JArr = { k: "arr"; items: JVal[] };
type JVal = JNum | JObj | JArr | { k: "str"; v: string } | { k: "bool"; v: boolean } | { k: "null" };

class JsonError extends Error {}

function parseJson(s: string): { value: JVal; lead: string; trail: string } {
  let i = 0;
  const ws = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++;
  };
  const fail = (m: string): never => {
    throw new JsonError(`${m} (position ${i})`);
  };
  const str = (): string => {
    i++;
    let out = "";
    for (;;) {
      if (i >= s.length) fail("unterminated string");
      const c = s.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return out;
      }
      if (c < 0x20) fail("control character in a string");
      if (c === 0x5c) {
        const e = s[i + 1];
        i += 2;
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (e in simple) out += simple[e];
        else if (e === "u") {
          const hex = (at: number) => {
            const h = s.slice(at, at + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(h)) fail("bad \\u escape");
            return parseInt(h, 16);
          };
          const u = hex(i);
          i += 4;
          if (u >= 0xd800 && u <= 0xdbff) {
            if (s[i] !== "\\" || s[i + 1] !== "u") fail("lone surrogate");
            const lo = hex(i + 2);
            if (lo < 0xdc00 || lo > 0xdfff) fail("lone surrogate");
            i += 6;
            out += String.fromCharCode(u, lo);
          } else if (u >= 0xdc00 && u <= 0xdfff) fail("lone surrogate");
          else out += String.fromCharCode(u);
        } else fail("bad escape");
      } else {
        out += s[i];
        i++;
      }
    }
  };
  const val = (): JVal => {
    ws();
    const c = s[i];
    if (c === "{") {
      i++;
      const entries: [string, JVal][] = [];
      ws();
      if (s[i] === "}") {
        i++;
        return { k: "obj", entries };
      }
      for (;;) {
        ws();
        if (s[i] !== '"') fail("expected a key");
        const key = str();
        ws();
        if (s[i] !== ":") fail("expected ':'");
        i++;
        entries.push([key, val()]);
        ws();
        if (s[i] === ",") {
          i++;
          continue;
        }
        if (s[i] === "}") {
          i++;
          return { k: "obj", entries };
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const items: JVal[] = [];
      ws();
      if (s[i] === "]") {
        i++;
        return { k: "arr", items };
      }
      for (;;) {
        items.push(val());
        ws();
        if (s[i] === ",") {
          i++;
          continue;
        }
        if (s[i] === "]") {
          i++;
          return { k: "arr", items };
        }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return { k: "str", v: str() };
    if (s.startsWith("true", i)) {
      i += 4;
      return { k: "bool", v: true };
    }
    if (s.startsWith("false", i)) {
      i += 5;
      return { k: "bool", v: false };
    }
    if (s.startsWith("null", i)) {
      i += 4;
      return { k: "null" };
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i, i + 400));
    if (!m) fail("unexpected character");
    i += m![0].length;
    return { k: "num", raw: m![0] };
  };
  ws();
  const lead = s.slice(0, i);
  const value = val();
  const end = i;
  ws();
  if (i < s.length) fail("trailing characters");
  return { value, lead, trail: s.slice(end) };
}

/** usize として読める整数(serde_json は 2.0 や 1e3 を小数として拒む)。 */
function usize(v: JVal): number | null {
  if (v.k !== "num" || !/^(0|[1-9]\d*)$/.test(v.raw)) return null;
  const b = BigInt(v.raw);
  if (b > 18446744073709551615n) return null;
  return Number(b);
}

const describe = (v: JVal) => (v.k === "num" ? v.raw : v.k === "str" ? JSON.stringify(v.v) : v.k === "obj" ? "{…}" : v.k === "arr" ? "[…]" : v.k === "bool" ? String(v.v) : "null");

// ---- 1 ファイル ----

export function parseShardName(name: string): ShardName | null {
  const m = /^(.*)-(\d{5})-of-(\d{5})\.safetensors$/.exec(name);
  return m ? { base: m[1], part: Number(m[2]), total: Number(m[3]) } : null;
}

function empty(fileName: string, fileSize: number | null): StFile {
  return {
    fileName,
    fileSize,
    headerLen: null,
    metadata: null,
    tensors: [],
    byDtype: [],
    params: 0,
    dataBytes: 0,
    expectedSize: null,
    shard: parseShardName(fileName),
    layers: null,
    problems: [],
    ok: false,
    partial: false,
  };
}

/**
 * ファイルの先頭 buf(全体の大きさ fileSize)を読む。見出しを読み切るのに足りなければ StNeedMore を投げる。
 */
export function readSafetensors(buf: Uint8Array, fileSize: number, fileName = "", opts: { partial?: boolean } = {}): StFile {
  const r = empty(fileName, fileSize);
  r.partial = !!opts.partial;
  const p = r.problems;
  if (fileSize < 8) {
    if (buf.length < fileSize) throw new StNeedMore(fileSize);
    p.push({ code: "tooSmall", severity: "error", detail: String(fileSize) });
    return r;
  }
  if (buf.length < 8) throw new StNeedMore(8);
  if (buf[0] === 0x47 && buf[1] === 0x47 && buf[2] === 0x55 && buf[3] === 0x46) {
    p.push({ code: "gguf", severity: "error" });
    return r;
  }
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    p.push({ code: "zip", severity: "error" });
    return r;
  }
  const n64 = new DataView(buf.buffer, buf.byteOffset, 8).getBigUint64(0, true);
  if (n64 > BigInt(MAX_HEADER)) {
    p.push({
      code: "headerTooLarge",
      severity: "error",
      detail: n64.toString(),
    });
    return r;
  }
  const n = Number(n64);
  r.headerLen = n;
  if (8 + n > fileSize) {
    p.push({
      code: "headerBeyondFile",
      severity: "error",
      detail: String(8 + n),
    });
    return r;
  }
  if (buf.length < 8 + n) throw new StNeedMore(8 + n);
  return readHeaderBytes(buf.subarray(8, 8 + n), r);
}

/** 見出しの JSON を文字列で貼られたとき(ファイルの大きさは分からないので、データ部の検査は飛ばす)。 */
export function readHeaderText(text: string, fileName = ""): StFile {
  const r = empty(fileName, null);
  return readHeaderBytes(new TextEncoder().encode(text), r);
}

function readHeaderBytes(h: Uint8Array, r: StFile): StFile {
  const p = r.problems;
  const err = (code: StProblemCode, detail?: string) => p.push({ code, severity: "error", detail });
  if (r.headerLen !== null && r.headerLen > HUB_MAX_HEADER)
    p.push({
      code: "hubHeaderLimit",
      severity: "warn",
      detail: String(r.headerLen),
    });

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(h);
  } catch {
    err("badUtf8");
    return finish(r);
  }
  let parsed: ReturnType<typeof parseJson>;
  try {
    parsed = parseJson(text);
  } catch (e) {
    err("badJson", e instanceof Error ? e.message : "");
    return finish(r);
  }
  if (parsed.value.k !== "obj") {
    err("notObject");
    return finish(r);
  }
  if (parsed.lead) p.push({ code: "notStartBrace", severity: "warn" });
  if (/[^ ]/.test(parsed.trail)) p.push({ code: "paddingNotSpace", severity: "warn" });

  // 同じ名前は後のものが残る(serde の HashMap)。__metadata__ の重複は拒否される
  const map = new Map<string, JVal>();
  let metaSeen = 0;
  const dups = new Set<string>();
  for (const [k, v] of parsed.value.entries) {
    if (k === "__metadata__") metaSeen++;
    else if (map.has(k)) dups.add(k);
    map.set(k, v);
  }
  if (metaSeen > 1) err("duplicateField", "__metadata__");
  for (const d of dups) p.push({ code: "duplicateTensor", severity: "warn", detail: d });

  const meta = map.get("__metadata__");
  map.delete("__metadata__");
  if (meta && meta.k !== "null") {
    if (meta.k !== "obj" || meta.entries.some(([, v]) => v.k !== "str")) err("metadataNotStrings");
    else {
      const m = new Map<string, string>();
      for (const [k, v] of meta.entries) m.set(k, (v as { v: string }).v);
      r.metadata = [...m];
    }
  }

  const tensors: StTensor[] = [];
  let typeError = false;
  for (const [name, v] of map) {
    if (v.k !== "obj") {
      err("tensorNotObject", name);
      typeError = true;
      continue;
    }
    const seen = new Set<string>();
    const f: Record<string, JVal> = {};
    let bad = false;
    for (const [k, x] of v.entries) {
      if (seen.has(k) && (k === "dtype" || k === "shape" || k === "data_offsets")) {
        err("duplicateField", `${name}.${k}`);
        bad = true;
      }
      seen.add(k);
      if (k === "dtype" || k === "shape" || k === "data_offsets") f[k] = x;
      else
        p.push({
          code: "extraField",
          severity: "info",
          detail: `${name}.${k}`,
        });
    }
    for (const k of ["dtype", "shape", "data_offsets"]) {
      if (!(k in f)) {
        err("missingField", `${name}.${k}`);
        bad = true;
      }
    }
    if (bad) {
      typeError = true;
      continue;
    }
    const dt = f.dtype;
    if (dt.k !== "str" || !(dt.v in DTYPE_BITS)) {
      err("unknownDtype", `${name}: ${describe(dt)}`);
      bad = true;
    }
    const sh = f.shape;
    const shape = sh.k === "arr" ? sh.items.map(usize) : null;
    if (!shape || shape.some((d) => d === null)) {
      err("badShape", `${name}: ${describe(sh)}${sh.k === "arr" ? ` [${sh.items.map(describe).join(", ")}]` : ""}`);
      bad = true;
    }
    const of = f.data_offsets;
    const offs = of.k === "arr" && of.items.length === 2 ? of.items.map(usize) : null;
    if (!offs || offs.some((d) => d === null)) {
      err("badOffsets", `${name}: ${of.k === "arr" ? `[${of.items.map(describe).join(", ")}]` : describe(of)}`);
      bad = true;
    }
    if (bad) {
      typeError = true;
      continue;
    }
    const dims = shape as number[];
    const params = dims.reduce((a, d) => a * d, 1);
    tensors.push({
      name,
      dtype: (dt as { v: string }).v,
      shape: dims,
      begin: offs![0]!,
      end: offs![1]!,
      params,
      bytes: 0,
    });
  }

  // Metadata::validate と同じ順(data_offsets の順)で確かめる
  tensors.sort((a, b) => a.begin - b.begin || a.end - b.end);
  let start = 0;
  for (const t of tensors) {
    if (t.begin !== start || t.end < t.begin) err("invalidOffset", `${t.name} [${t.begin}, ${t.end}]`);
    start = t.end;
    let bits = BigInt(DTYPE_BITS[t.dtype]);
    for (const d of t.shape) if (d !== 0) bits *= BigInt(d);
    if (t.shape.includes(0)) bits = 0n;
    if (bits > 18446744073709551615n) {
      err("overflow", t.name);
      continue;
    }
    if (bits % 8n !== 0n) {
      err("misaligned", `${t.name}: ${t.dtype} × ${t.params}`);
      continue;
    }
    t.bytes = Number(bits / 8n);
    if (t.end - t.begin !== t.bytes) err("sizeMismatch", `${t.name}: ${t.dtype} [${t.shape.join(", ")}] = ${t.bytes}, data_offsets ${t.end - t.begin}`);
  }
  r.tensors = tensors;
  r.dataBytes = start;

  if (r.headerLen !== null && r.fileSize !== null && !typeError) {
    r.expectedSize = 8 + r.headerLen + start;
    if (r.partial) p.push({ code: "partialFile", severity: "info", detail: String(r.expectedSize) });
    else if (r.fileSize < r.expectedSize) err("fileTruncated", String(r.expectedSize - r.fileSize));
    else if (r.fileSize > r.expectedSize) err("fileTooLong", String(r.fileSize - r.expectedSize));
  }
  if (tensors.length === 0 && !typeError) p.push({ code: "noTensors", severity: "info" });
  return finish(r);
}

function finish(r: StFile): StFile {
  const by = new Map<string, DtypeSummary>();
  let params = 0;
  for (const t of r.tensors) {
    const s = by.get(t.dtype) ?? {
      dtype: t.dtype,
      count: 0,
      params: 0,
      bytes: 0,
    };
    s.count++;
    s.params += t.params;
    s.bytes += t.end - t.begin;
    by.set(t.dtype, s);
    params += t.params;
  }
  r.byDtype = [...by.values()].sort((a, b) => b.bytes - a.bytes);
  r.params = params;
  r.layers = countLayers(r.tensors.map((t) => t.name));
  r.ok = !r.problems.some((x) => x.severity === "error");
  return r;
}

function countLayers(names: string[]): number | null {
  let max = -1;
  for (const n of names) {
    const m = /(?:^|\.)layers\.(\d+)\./.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max >= 0 ? max + 1 : null;
}

// ---- index.json と config.json ----

export type StIndex = {
  fileName: string;
  totalSize: number | null;
  totalParameters: number | null;
  /** metadata のほかの項目。 */
  otherMetadata: [string, string][];
  weightMap: Map<string, string>;
  /** ファイルごとのテンソルの数(index に出てくる順)。 */
  files: { file: string; tensors: number }[];
  problems: StProblem[];
};

export type StConfig = {
  fileName: string;
  architecture: string | null;
  modelType: string | null;
  dtype: string | null;
  contextLength: number | null;
  layers: number | null;
  hidden: number | null;
  heads: number | null;
  kvHeads: number | null;
  headDim: number | null;
  headDimDerived: boolean;
  vocab: number | null;
  tieEmbeddings: boolean | null;
  /** sliding window・MLA・線形注意などで、表の KV キャッシュと実際が違う。 */
  kvApprox: boolean;
  kvBytesPerToken: number | null;
  problems: StProblem[];
};

export type JsonKind = { kind: "index"; index: StIndex } | { kind: "config"; config: StConfig } | { kind: "header"; file: StFile } | { kind: "unknown"; problems: StProblem[] };

/** 貼り付けたり選んだりした JSON が index・config・見出しのどれかを見分けて読む。 */
export function readJson(text: string, fileName = ""): JsonKind {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    if (/^\s*\{/.test(text) && /"data_offsets"/.test(text)) return { kind: "header", file: readHeaderText(text, fileName) };
    return {
      kind: "unknown",
      problems: [
        {
          code: "badJson",
          severity: "error",
          detail: e instanceof Error ? e.message : "",
          file: fileName,
        },
      ],
    };
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    return {
      kind: "unknown",
      problems: [{ code: "unknownJson", severity: "error", file: fileName }],
    };
  const o = v as Record<string, unknown>;
  if ("weight_map" in o) return { kind: "index", index: readIndexObject(o, fileName) };
  if ("model_type" in o || "architectures" in o || "num_hidden_layers" in o || "text_config" in o) return { kind: "config", config: readConfigObject(o, fileName) };
  if (Object.values(o).some((x) => x && typeof x === "object" && "data_offsets" in (x as object))) return { kind: "header", file: readHeaderText(text, fileName) };
  return {
    kind: "unknown",
    problems: [{ code: "unknownJson", severity: "error", file: fileName }],
  };
}

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

function readIndexObject(o: Record<string, unknown>, fileName: string): StIndex {
  const r: StIndex = {
    fileName,
    totalSize: null,
    totalParameters: null,
    otherMetadata: [],
    weightMap: new Map(),
    files: [],
    problems: [],
  };
  const wm = o.weight_map;
  if (!wm || typeof wm !== "object" || Array.isArray(wm) || Object.values(wm).some((f) => typeof f !== "string")) {
    r.problems.push({
      code: "badIndex",
      severity: "error",
      detail: "weight_map",
      file: fileName,
    });
    return r;
  }
  const md = o.metadata;
  if (md && typeof md === "object" && !Array.isArray(md)) {
    for (const [k, x] of Object.entries(md)) {
      if (k === "total_size") r.totalSize = num(x);
      else if (k === "total_parameters") r.totalParameters = num(x);
      else r.otherMetadata.push([k, typeof x === "string" ? x : JSON.stringify(x)]);
    }
  }
  const counts = new Map<string, number>();
  for (const [t, f] of Object.entries(wm as Record<string, string>)) {
    r.weightMap.set(t, f);
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  r.files = [...counts].map(([file, tensors]) => ({ file, tensors }));
  return r;
}

function readConfigObject(o0: Record<string, unknown>, fileName: string): StConfig {
  // 画像などと組み合わせたモデルは、文章の部分の設定が text_config に入っている
  const tc = o0.text_config && typeof o0.text_config === "object" ? (o0.text_config as Record<string, unknown>) : null;
  const o = tc ? { ...o0, ...tc } : o0;
  const arch = Array.isArray(o0.architectures) && typeof o0.architectures[0] === "string" ? (o0.architectures[0] as string) : null;
  const heads = num(o.num_attention_heads);
  const hidden = num(o.hidden_size);
  let headDim = num(o.head_dim);
  let derived = false;
  if (headDim === null && hidden !== null && heads) {
    headDim = hidden / heads;
    derived = true;
  }
  const kvHeads = num(o.num_key_value_heads) ?? heads;
  const layers = num(o.num_hidden_layers);
  const sw = num(o.sliding_window);
  const ctx = num(o.max_position_embeddings);
  const layerTypes = Array.isArray(o.layer_types) ? (o.layer_types as unknown[]) : [];
  const kvApprox =
    o.use_sliding_window === true ||
    (o.use_sliding_window === undefined && sw !== null && (ctx === null || sw < ctx)) ||
    layerTypes.some((x) => x !== "full_attention") ||
    o.kv_lora_rank !== undefined;
  const dt = typeof o0.torch_dtype === "string" ? o0.torch_dtype : typeof o0.dtype === "string" ? o0.dtype : typeof o.torch_dtype === "string" ? o.torch_dtype : null;
  const r: StConfig = {
    fileName,
    architecture: arch,
    modelType: typeof o0.model_type === "string" ? o0.model_type : null,
    dtype: dt as string | null,
    contextLength: ctx,
    layers,
    hidden,
    heads,
    kvHeads,
    headDim,
    headDimDerived: derived,
    vocab: num(o.vocab_size),
    tieEmbeddings: typeof o0.tie_word_embeddings === "boolean" ? o0.tie_word_embeddings : typeof o.tie_word_embeddings === "boolean" ? o.tie_word_embeddings : null,
    kvApprox,
    kvBytesPerToken: layers !== null && kvHeads !== null && headDim !== null ? 2 * layers * kvHeads * headDim * 2 : null,
    problems: [],
  };
  return r;
}

// ---- 組み合わせ ----

export type KvRow = {
  ctx: number;
  mib: number;
  note: "default4k" | "max" | null;
};
const CONTEXTS = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];

export type StSet = {
  files: StFile[];
  index: StIndex | null;
  config: StConfig | null;
  params: number;
  bytes: number;
  byDtype: DtypeSummary[];
  layers: number | null;
  /** index に出てくるのに選ばれていないファイル。 */
  missingFiles: string[];
  kvRows: KvRow[];
  problems: StProblem[];
};

/** HF の torch_dtype の名前を safetensors の型の名前に。 */
const TORCH_DTYPE: Record<string, string> = {
  bfloat16: "BF16",
  float16: "F16",
  float32: "F32",
  float64: "F64",
  int8: "I8",
  uint8: "U8",
};

export function combine(files: StFile[], index: StIndex | null, config: StConfig | null): StSet {
  const p: StProblem[] = [];
  const by = new Map<string, DtypeSummary>();
  let params = 0;
  let bytes = 0;
  for (const f of files)
    for (const d of f.byDtype) {
      const s = by.get(d.dtype) ?? {
        dtype: d.dtype,
        count: 0,
        params: 0,
        bytes: 0,
      };
      s.count += d.count;
      s.params += d.params;
      s.bytes += d.bytes;
      by.set(d.dtype, s);
      params += d.params;
      bytes += d.bytes;
    }

  // 同じテンソルが複数のファイルに
  const where = new Map<string, string[]>();
  for (const f of files) for (const t of f.tensors) where.set(t.name, [...(where.get(t.name) ?? []), f.fileName]);
  for (const [t, fs] of where)
    if (fs.length > 1)
      p.push({
        code: "tensorAcrossFiles",
        severity: "warn",
        detail: `${t}: ${fs.join(", ")}`,
      });

  let missingFiles: string[] = [];
  if (index) {
    const given = new Set(files.map((f) => (f.fileSize === null && f.tensors.length ? (index.weightMap.get(f.tensors[0].name) ?? f.fileName) : f.fileName)));
    missingFiles = files.length ? index.files.map((x) => x.file).filter((f) => !given.has(f)) : [];
    if (missingFiles.length)
      p.push({
        code: "indexFilesMissing",
        severity: "info",
        detail: missingFiles.join(", "),
      });
    const listed = new Set(index.files.map((x) => x.file));
    for (const f of files) {
      // 貼り付けた見出しはファイル名が無いので、最初のテンソルから index のファイルを探す
      const fname = listed.has(f.fileName) ? f.fileName : f.fileSize === null && f.tensors.length ? index.weightMap.get(f.tensors[0].name) : undefined;
      if (!fname) {
        // safetensors として読めなかったファイル(GGUF など)はそちらの問題だけを出す
        if (f.headerLen !== null || f.fileSize === null) p.push({ code: "fileNotInIndex", severity: "warn", file: f.fileName });
        continue;
      }
      const names = new Set(f.tensors.map((t) => t.name));
      const extra = f.tensors.filter((t) => index.weightMap.get(t.name) !== fname).map((t) => t.name);
      const missing = [...index.weightMap].filter(([t, ff]) => ff === fname && !names.has(t)).map(([t]) => t);
      if (f.headerLen !== null || f.tensors.length) {
        if (extra.length)
          p.push({
            code: "tensorNotInIndex",
            severity: "warn",
            file: f.fileName,
            detail: list(extra),
          });
        if (missing.length)
          p.push({
            code: "tensorMissing",
            severity: "error",
            file: f.fileName,
            detail: list(missing),
          });
      }
    }
    if (files.length && !missingFiles.length && index.totalSize !== null) {
      p.push(
        index.totalSize === bytes
          ? {
              code: "totalSizeMatches",
              severity: "info",
              detail: String(bytes),
            }
          : {
              code: "totalSizeMismatch",
              severity: "warn",
              detail: `${index.totalSize} / ${bytes}`,
            },
      );
    }
    if (files.length && !missingFiles.length && index.totalParameters !== null && index.totalParameters !== params) {
      p.push({
        code: "totalParamsDiffer",
        severity: "info",
        detail: `${index.totalParameters} / ${params}`,
      });
    }
  } else {
    // index が無くても、名前の -0000k-of-0000n から足りない部分が分かる
    const groups = new Map<string, { total: number; parts: Set<number> }>();
    for (const f of files) {
      if (!f.shard) continue;
      const key = `${f.shard.base}|${f.shard.total}`;
      const g = groups.get(key) ?? {
        total: f.shard.total,
        parts: new Set<number>(),
      };
      g.parts.add(f.shard.part);
      groups.set(key, g);
    }
    for (const [key, g] of groups) {
      const base = key.split("|")[0];
      const miss: string[] = [];
      for (let k = 1; k <= g.total; k++) if (!g.parts.has(k)) miss.push(`${base}-${String(k).padStart(5, "0")}-of-${String(g.total).padStart(5, "0")}.safetensors`);
      if (miss.length) {
        missingFiles.push(...miss);
        p.push({
          code: "shardMissing",
          severity: "info",
          detail: miss.join(", "),
        });
      }
    }
  }

  const layerCounts = files.map((f) => f.layers).filter((x): x is number => x !== null);
  const layers = layerCounts.length ? Math.max(...layerCounts) : null;

  let kvRows: KvRow[] = [];
  if (config) {
    const all = new Set(files.flatMap((f) => f.tensors.map((t) => t.name)));
    if (config.tieEmbeddings && files.length && !missingFiles.length && !all.has("lm_head.weight") && [...all].some((n) => n.endsWith("embed_tokens.weight")))
      p.push({ code: "tiedEmbeddings", severity: "info" });
    const want = config.dtype ? TORCH_DTYPE[config.dtype] : undefined;
    const main = [...by.values()].sort((a, b) => b.bytes - a.bytes)[0];
    if (want && main && main.dtype !== want)
      p.push({
        code: "dtypeDiffers",
        severity: "info",
        detail: `${config.dtype} / ${main.dtype}`,
      });
    if (config.kvBytesPerToken !== null) {
      if (config.headDimDerived)
        p.push({
          code: "headDimDerived",
          severity: "info",
          detail: String(config.headDim),
        });
      if (config.kvApprox) p.push({ code: "kvApprox", severity: "warn" });
      const max = config.contextLength;
      const set = new Set(CONTEXTS.filter((c) => max === null || c <= max));
      if (max !== null) set.add(max);
      kvRows = [...set]
        .sort((x, y) => x - y)
        .map((ctx) => ({
          ctx,
          mib: (config.kvBytesPerToken! * ctx) / 1048576,
          note: ctx === max ? "max" : ctx === 4096 ? "default4k" : null,
        }));
    } else p.push({ code: "kvMissing", severity: "info" });
  }

  return {
    files,
    index,
    config,
    params,
    bytes,
    byDtype: [...by.values()].sort((a, b) => b.bytes - a.bytes),
    layers,
    missingFiles,
    kvRows,
    problems: p,
  };
}

function list(names: string[]) {
  return names.length > 5 ? `${names.slice(0, 5).join(", ")} … (${names.length})` : names.join(", ");
}
