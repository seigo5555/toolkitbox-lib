/**
 * GGUF ファイル(llama.cpp・Ollama が使うモデルの形式)の先頭を読み、メタデータとテンソルの一覧から
 * モデルの形・量子化・トークナイザー・チャットテンプレート・KV キャッシュをまとめる。
 * ファイルの本体(重み)は読まない。ブラウザの外には何も送らない。
 *
 * 出どころ:
 *  - 形式: ggml-org/ggml の docs/gguf.md(GGUF v3。ヘッダー・値の型・general.alignment の既定 32・命名規則と正規表現)
 *  - 読み込みのときの検査: ggml-org/llama.cpp の ggml/src/gguf.cpp(gguf_init_from_file_impl)
 *    - version 0 は不正、(version & 0xFFFF) == 0 はエンディアンの食い違い、v1 は非対応、3 より新しいものは非対応
 *    - キーとテンソル名の重複は不可、general.alignment は uint32 で 2 の累乗
 *    - テンソルは 4 次元まで、型は既知のもの、1 行の要素数はブロックの大きさの倍数
 *    - 各テンソルの offset は、前のテンソルまでの大きさ(alignment に切り上げ)の合計と一致すること
 *    - データ部はテンソル情報の後ろを alignment に切り上げた位置から
 *  - ファイルの大きさ: src/llama-model-loader.h はテンソルの終わりがファイルに収まらないと
 *    "model is corrupted or incomplete" で止まる
 *  - 型ごとのブロックの大きさとバイト数: llama.cpp の gguf-py/gguf/constants.py(GGML_QUANT_SIZES)
 *  - general.file_type の名前: 同じく LlamaFileType(include/llama.h の llama_ftype と同じ値)
 *  - キーの名前(tokenizer.*・split.*・adapter.*・{arch}.attention.* など): 同じく Keys
 *  - 分割ファイル: split.no は 0 から数える。ファイル名は "-%05d-of-%05d.gguf" で split.no + 1(src/llama.cpp の llama_split_path)
 *  - Ollama への取り込み: docs.ollama.com/import(FROM /path/to/file.gguf、分割は FROM /path/to/model-*.gguf。
 *    取り込みのときに量子化はしない)
 *  - KV キャッシュ = 2(K と V)× 層 × KV ヘッド × ヘッドの次元 × 2 バイト(f16)× 文脈の長さ(Ollama Model Info Reader と同じ式。
 *    2026-11-07 に Ollama 0.40.11 のログで qwen2.5:7b 4096 = 224 MiB を確かめた)。head_count_kv が層ごとの配列なら層ごとに足す
 *
 * 2026-11-08 に手元の qwen2.5:7b の本物のファイル(Ollama の blob、4.36 GiB)を読み、Ollama 0.40.11 の
 * /api/show(verbose)が返すメタデータ・テンソル 339 個の名前・型・形と一致することを確かめた(scripts/check-gguf.ts)。
 */

export const GGUF_SPEC_URL = "https://github.com/ggml-org/ggml/blob/master/docs/gguf.md";
export const GGUF_IMPORT_DOC_URL = "https://docs.ollama.com/import";
export const GGUF_VERIFIED_ON = "2026-11-08";

export type GgufProblemCode =
  | "notGguf"
  | "safetensors"
  | "badVersion"
  | "bigEndian"
  | "versionV1"
  | "versionTooNew"
  | "headerTruncated"
  | "badValueType"
  | "badString"
  | "duplicateKey"
  | "alignmentType"
  | "badAlignment"
  | "tooManyDims"
  | "duplicateTensor"
  | "unknownTensorType"
  | "rowNotBlock"
  | "offsetMismatch"
  | "fileTruncated"
  | "splitPart"
  | "adapterFile"
  | "projectorFile"
  | "imatrixFile"
  | "fileTypeUnset"
  | "noChatTemplate"
  | "kvMissing"
  | "kvApprox"
  | "kvPerLayer"
  | "headDimDerived";

export type Severity = "error" | "warn" | "info";
export type GgufProblem = { code: GgufProblemCode; severity: Severity; detail?: string };

/** gguf_metadata_value_type の順。 */
export const VALUE_TYPES = ["uint8", "int8", "uint16", "int16", "uint32", "int32", "float32", "bool", "string", "array", "uint64", "int64", "float64"] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

export type Scalar = number | string | boolean;
export type MetaEntry = {
  key: string;
  type: ValueType;
  /** 配列のときの中身の型。 */
  itemType?: ValueType;
  /** 配列の要素数。 */
  length?: number;
  /** スカラーはその値。配列は先頭から(長い配列は一部だけ。partial で分かる)。入れ子の配列は null。 */
  value: Scalar | (Scalar | null)[];
  partial?: boolean;
};

/** ggml_type: 名前・ブロックあたりの要素数・ブロックのバイト数(constants.py の GGML_QUANT_SIZES)。 */
const QK_K = 256;
export const GGML_TYPES: Record<number, [string, number, number]> = {
  0: ["F32", 1, 4],
  1: ["F16", 1, 2],
  2: ["Q4_0", 32, 2 + 16],
  3: ["Q4_1", 32, 2 + 2 + 16],
  6: ["Q5_0", 32, 2 + 4 + 16],
  7: ["Q5_1", 32, 2 + 2 + 4 + 16],
  8: ["Q8_0", 32, 2 + 32],
  9: ["Q8_1", 32, 2 + 2 + 32],
  10: ["Q2_K", 256, 2 + 2 + QK_K / 16 + QK_K / 4],
  11: ["Q3_K", 256, 2 + QK_K / 4 + QK_K / 8 + 12],
  12: ["Q4_K", 256, 2 + 2 + QK_K / 2 + 12],
  13: ["Q5_K", 256, 2 + 2 + QK_K / 2 + QK_K / 8 + 12],
  14: ["Q6_K", 256, 2 + QK_K / 2 + QK_K / 4 + QK_K / 16],
  15: ["Q8_K", 256, 4 + QK_K + QK_K / 8],
  16: ["IQ2_XXS", 256, 2 + QK_K / 4],
  17: ["IQ2_XS", 256, 2 + QK_K / 4 + QK_K / 32],
  18: ["IQ3_XXS", 256, 2 + QK_K / 4 + QK_K / 8],
  19: ["IQ1_S", 256, 2 + QK_K / 8 + QK_K / 16],
  20: ["IQ4_NL", 32, 2 + 16],
  21: ["IQ3_S", 256, 2 + QK_K / 4 + QK_K / 8 + QK_K / 32 + 4],
  22: ["IQ2_S", 256, 2 + QK_K / 4 + QK_K / 16],
  23: ["IQ4_XS", 256, 2 + 2 + QK_K / 2 + QK_K / 64],
  24: ["I8", 1, 1],
  25: ["I16", 1, 2],
  26: ["I32", 1, 4],
  27: ["I64", 1, 8],
  28: ["F64", 1, 8],
  29: ["IQ1_M", 256, QK_K / 8 + QK_K / 16 + QK_K / 32],
  30: ["BF16", 1, 2],
  34: ["TQ1_0", 256, 2 + 4 * 13],
  35: ["TQ2_0", 256, 2 + 64],
  39: ["MXFP4", 32, 1 + 16],
  40: ["NVFP4", 64, 4 + 32],
  41: ["Q1_0", 128, 2 + 16],
  42: ["Q2_0", 64, 2 + 16],
  43: ["F8_E4M3", 1, 1],
};

/** general.file_type(LlamaFileType)。名前の MOSTLY_ は外してある。 */
export const FILE_TYPES: Record<number, string> = {
  0: "ALL_F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  4: "Q4_1_SOME_F16",
  7: "Q8_0",
  8: "Q5_0",
  9: "Q5_1",
  10: "Q2_K",
  11: "Q3_K_S",
  12: "Q3_K_M",
  13: "Q3_K_L",
  14: "Q4_K_S",
  15: "Q4_K_M",
  16: "Q5_K_S",
  17: "Q5_K_M",
  18: "Q6_K",
  19: "IQ2_XXS",
  20: "IQ2_XS",
  21: "Q2_K_S",
  22: "IQ3_XS",
  23: "IQ3_XXS",
  24: "IQ1_S",
  25: "IQ4_NL",
  26: "IQ3_S",
  27: "IQ3_M",
  28: "IQ2_S",
  29: "IQ2_M",
  30: "IQ4_XS",
  31: "IQ1_M",
  32: "BF16",
  36: "TQ1_0",
  37: "TQ2_0",
  38: "MXFP4_MOE",
  39: "NVFP4",
  40: "Q1_0",
  41: "Q2_0",
  42: "F8_E4M3",
};

/** docs/gguf.md の命名規則の正規表現(そのまま)。 */
const NAME_RE =
  /^(?:(?<Sidecar>mmproj|mtp)-)?(?<BaseName>[A-Za-z0-9\s]*(?:(?:-(?:(?:[A-Za-z\s][A-Za-z0-9\s]*)|(?:[0-9\s]*)))*))-(?:(?<SizeLabel>(?:\d+x)?(?:\d+\.)?\d+[A-Za-z](?:-[A-Za-z]+(\d+\.)?\d+[A-Za-z]+)?)(?:-(?<FineTune>[A-Za-z0-9\s-]+))?)?-(?:(?<Version>v\d+(?:\.\d+)*))(?:-(?<Encoding>(?!LoRA|vocab)[\w_]+))?(?:-(?<Type>LoRA|vocab))?(?:-(?<Shard>\d{5}-of-\d{5}))?\.gguf$/;

export type FileNameParts = {
  sidecar: string | null;
  baseName: string | null;
  sizeLabel: string | null;
  fineTune: string | null;
  version: string;
  encoding: string | null;
  type: string | null;
  shard: string | null;
};

/** 命名規則に沿ったファイル名を分ける(docs/gguf.md の parseGGUFFilename と同じ。沿っていなければ null)。 */
export function parseFileName(name: string): FileNameParts | null {
  const m = NAME_RE.exec(name);
  if (!m?.groups) return null;
  const g = m.groups;
  return {
    sidecar: g.Sidecar ?? null,
    baseName: g.BaseName ?? null,
    sizeLabel: g.SizeLabel ?? null,
    fineTune: g.FineTune ?? null,
    version: g.Version ?? "v1.0",
    encoding: g.Encoding ?? null,
    type: g.Type ?? null,
    shard: g.Shard ?? null,
  };
}

export type Tensor = {
  name: string;
  shape: number[];
  type: number;
  typeName: string;
  elements: number;
  /** 型が分からないときは null。 */
  bytes: number | null;
  offset: number;
};

export type TypeSummary = { typeName: string; count: number; elements: number; bytes: number };
export type KvRow = { ctx: number; mib: number; note: "default4k" | "max" | null };
export type TokenRef = { id: number; text: string | null };

export type GgufResult = {
  problems: GgufProblem[];
  /** ヘッダーを最後まで読めたか。 */
  ok: boolean;
  fileSize: number;
  bigEndian: boolean;
  version: number | null;
  tensorCount: number | null;
  kvCount: number | null;
  alignment: number;
  /** ヘッダー(メタデータ+テンソル情報)の終わり。 */
  headerBytes: number | null;
  /** 重みのデータが始まる位置。 */
  dataOffset: number | null;
  /** データ部の大きさ(alignment の詰め物を含む)。 */
  dataSize: number | null;
  /** ファイルが少なくともこれだけ要る大きさ(データ部の始まり+最後のテンソルの終わり。詰め物は含まない)。 */
  expectedSize: number | null;
  metadata: MetaEntry[];
  tensors: Tensor[];
  byType: TypeSummary[];
  paramCount: number | null;
  weightBytes: number | null;
  bitsPerWeight: number | null;
  fileType: { id: number; name: string } | null;
  generalType: string;
  arch: string;
  name: string;
  sizeLabel: string;
  quantizationVersion: number | null;
  license: string;
  licenseLink: string;
  repoUrl: string;
  baseModels: string[];
  contextLength: number | null;
  embeddingLength: number | null;
  blockCount: number | null;
  feedForwardLength: number | null;
  headCount: number | null;
  /** 層ごとに違うときは配列。 */
  headCountKv: number | number[] | null;
  headDim: number | null;
  ropeFreqBase: number | null;
  ropeScaling: string;
  slidingWindow: number | null;
  expertCount: number | null;
  expertUsed: number | null;
  tokenizerModel: string;
  tokenizerPre: string;
  vocabSize: number | null;
  specialTokens: { name: "bos" | "eos" | "eot" | "pad" | "unk"; token: TokenRef }[];
  addBos: boolean | null;
  chatTemplate: string;
  otherChatTemplates: string[];
  split: { no: number; count: number; tensors: number | null } | null;
  adapterType: string;
  fileName: string;
  fileNameParts: FileNameParts | null;
  kvBytesPerToken: number | null;
  kvRows: KvRow[];
};

/** 読んだぶんでは足りないとき、何バイト目まで要るかを伝える。 */
export class GgufNeedMore extends Error {
  constructor(public readonly need: number) {
    super(`need ${need} bytes`);
  }
}
class Stop extends Error {
  constructor(
    public readonly code: GgufProblemCode,
    public readonly detail?: string,
  ) {
    super(code);
  }
}

/** 長い配列は先頭からこの数だけ持つ(トークンの一覧は全部持つ)。 */
const ARRAY_KEEP = 1024;
const KEEP_ALL = new Set(["tokenizer.ggml.tokens"]);
const FIXED_SIZE: Partial<Record<ValueType, number>> = { uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4, bool: 1, uint64: 8, int64: 8, float64: 8 };

class Reader {
  pos = 0;
  private dv: DataView;
  private dec = new TextDecoder("utf-8");
  constructor(
    private buf: Uint8Array,
    private fileSize: number,
    private le: boolean,
  ) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private need(n: number) {
    const end = this.pos + n;
    if (end <= this.buf.length) return;
    if (this.buf.length < this.fileSize) throw new GgufNeedMore(end);
    throw new Stop("headerTruncated");
  }
  u8() {
    this.need(1);
    return this.dv.getUint8(this.pos++);
  }
  u32() {
    this.need(4);
    const v = this.dv.getUint32(this.pos, this.le);
    this.pos += 4;
    return v;
  }
  /** 64 ビット。2^53 を超えたら文字列で返す。 */
  u64(): number | string {
    this.need(8);
    const v = this.dv.getBigUint64(this.pos, this.le);
    this.pos += 8;
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  }
  /** 個数・長さ。ファイルより大きいものは壊れているとみなす。 */
  count(): number {
    const v = this.u64();
    if (typeof v === "string" || v > this.fileSize) throw new Stop("badString", String(v));
    return v;
  }
  str(): string {
    const len = this.count();
    this.need(len);
    const s = this.dec.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  skip(n: number) {
    this.need(n);
    this.pos += n;
  }
  scalar(t: ValueType): Scalar {
    const p = this.pos;
    switch (t) {
      case "uint8":
        this.need(1);
        this.pos += 1;
        return this.dv.getUint8(p);
      case "int8":
        this.need(1);
        this.pos += 1;
        return this.dv.getInt8(p);
      case "uint16":
        this.need(2);
        this.pos += 2;
        return this.dv.getUint16(p, this.le);
      case "int16":
        this.need(2);
        this.pos += 2;
        return this.dv.getInt16(p, this.le);
      case "uint32":
        return this.u32();
      case "int32":
        this.need(4);
        this.pos += 4;
        return this.dv.getInt32(p, this.le);
      case "float32":
        this.need(4);
        this.pos += 4;
        return this.dv.getFloat32(p, this.le);
      case "bool":
        this.need(1);
        this.pos += 1;
        return this.dv.getUint8(p) !== 0;
      case "string":
        return this.str();
      case "uint64":
        return this.u64();
      case "int64": {
        this.need(8);
        this.pos += 8;
        const v = this.dv.getBigInt64(p, this.le);
        return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString();
      }
      case "float64":
        this.need(8);
        this.pos += 8;
        return this.dv.getFloat64(p, this.le);
      default:
        throw new Stop("badValueType", t);
    }
  }
  valueType(): ValueType {
    const n = this.u32();
    const t = VALUE_TYPES[n];
    if (!t) throw new Stop("badValueType", String(n));
    return t;
  }
  /** 配列を読む。keep 個まで値を持ち、残りは読み飛ばす。 */
  array(keep: number): { itemType: ValueType; length: number; value: (Scalar | null)[]; partial: boolean } {
    const itemType = this.valueType();
    const length = this.count();
    const value: (Scalar | null)[] = [];
    if (itemType === "array") {
      for (let i = 0; i < length; i++) {
        this.array(0);
        if (i < keep) value.push(null);
      }
    } else if (FIXED_SIZE[itemType] !== undefined) {
      const n = Math.min(length, keep);
      for (let i = 0; i < n; i++) value.push(this.scalar(itemType));
      this.skip((length - n) * FIXED_SIZE[itemType]!);
    } else {
      for (let i = 0; i < length; i++) {
        if (i < keep) value.push(this.scalar(itemType));
        else this.skip(this.count());
      }
    }
    return { itemType, length, value, partial: value.length < length };
  }
}

const ALIGN = (x: number, a: number) => x + ((a - (x % a)) % a);
const CONTEXTS = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];

export function kvMib(bytesPerToken: number, ctx: number) {
  return (bytesPerToken * ctx) / 1048576;
}

function emptyResult(fileSize: number, fileName: string): GgufResult {
  return {
    problems: [],
    ok: false,
    fileSize,
    bigEndian: false,
    version: null,
    tensorCount: null,
    kvCount: null,
    alignment: 32,
    headerBytes: null,
    dataOffset: null,
    dataSize: null,
    expectedSize: null,
    metadata: [],
    tensors: [],
    byType: [],
    paramCount: null,
    weightBytes: null,
    bitsPerWeight: null,
    fileType: null,
    generalType: "",
    arch: "",
    name: "",
    sizeLabel: "",
    quantizationVersion: null,
    license: "",
    licenseLink: "",
    repoUrl: "",
    baseModels: [],
    contextLength: null,
    embeddingLength: null,
    blockCount: null,
    feedForwardLength: null,
    headCount: null,
    headCountKv: null,
    headDim: null,
    ropeFreqBase: null,
    ropeScaling: "",
    slidingWindow: null,
    expertCount: null,
    expertUsed: null,
    tokenizerModel: "",
    tokenizerPre: "",
    vocabSize: null,
    specialTokens: [],
    addBos: null,
    chatTemplate: "",
    otherChatTemplates: [],
    split: null,
    adapterType: "",
    fileName,
    fileNameParts: fileName ? parseFileName(fileName) : null,
    kvBytesPerToken: null,
    kvRows: [],
  };
}

/**
 * GGUF の先頭 buf(ファイル全体の大きさは fileSize)を読む。
 * buf が足りなければ GgufNeedMore を投げる(呼ぶ側はもっと長く読んでやり直す)。
 */
export function readGguf(buf: Uint8Array, fileSize: number, fileName = ""): GgufResult {
  const r = emptyResult(fileSize, fileName);
  const p = r.problems;
  if (buf.length < 4) {
    if (buf.length < fileSize) throw new GgufNeedMore(4);
    p.push({ code: "notGguf", severity: "error", detail: "" });
    return r;
  }
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (magic !== "GGUF") {
    // safetensors: 先頭 8 バイトがヘッダーの長さ(リトルエンディアン)、続いて JSON
    if (buf.length >= 9 && buf[8] === 0x7b && buf[6] === 0 && buf[7] === 0) p.push({ code: "safetensors", severity: "error" });
    else p.push({ code: "notGguf", severity: "error", detail: [...buf.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ") });
    return r;
  }
  if (buf.length < 8) {
    if (buf.length < fileSize) throw new GgufNeedMore(8);
    p.push({ code: "headerTruncated", severity: "error" });
    return r;
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let le = true;
  let version = dv.getUint32(4, true);
  if (version !== 0 && (version & 0xffff) === 0) {
    // llama.cpp は「エンディアンが合っていない」として読まない。ビッグエンディアンで読み直す
    le = false;
    version = dv.getUint32(4, false);
    r.bigEndian = true;
    p.push({ code: "bigEndian", severity: "warn" });
  }
  r.version = version;
  if (version === 0) {
    p.push({ code: "badVersion", severity: "error", detail: "0" });
    return r;
  }
  if (version === 1) {
    p.push({ code: "versionV1", severity: "error" });
    return r;
  }
  if (version > 3) {
    p.push({ code: "versionTooNew", severity: "error", detail: String(version) });
    return r;
  }

  const rd = new Reader(buf, fileSize, le);
  rd.pos = 8;
  try {
    r.tensorCount = rd.count();
    r.kvCount = rd.count();

    // メタデータ
    const seen = new Set<string>();
    const meta: Record<string, MetaEntry> = {};
    for (let i = 0; i < r.kvCount; i++) {
      const key = rd.str();
      const type = rd.valueType();
      let e: MetaEntry;
      if (type === "array") {
        const keep = KEEP_ALL.has(key) ? Number.MAX_SAFE_INTEGER : ARRAY_KEEP;
        const a = rd.array(keep);
        e = { key, type, itemType: a.itemType, length: a.length, value: a.value, partial: a.partial };
      } else e = { key, type, value: rd.scalar(type) };
      if (seen.has(key)) throw new Stop("duplicateKey", key);
      seen.add(key);
      r.metadata.push(e);
      meta[key] = e;
    }

    const al = meta["general.alignment"];
    if (al) {
      if (al.type !== "uint32") throw new Stop("alignmentType", al.type);
      const a = al.value as number;
      if (a === 0 || (a & (a - 1)) !== 0) throw new Stop("badAlignment", String(a));
      r.alignment = a;
    }

    // テンソル情報
    const names = new Set<string>();
    for (let i = 0; i < r.tensorCount; i++) {
      const name = rd.str();
      const nd = rd.u32();
      if (nd > 4) throw new Stop("tooManyDims", `${name}: ${nd}`);
      const shape: number[] = [];
      for (let j = 0; j < nd; j++) {
        const d = rd.u64();
        if (typeof d === "string") throw new Stop("badString", `${name}: ${d}`);
        shape.push(d);
      }
      const type = rd.u32();
      const off = rd.u64();
      if (names.has(name)) throw new Stop("duplicateTensor", name);
      names.add(name);
      const elements = shape.reduce((a, b) => a * b, 1);
      const t = GGML_TYPES[type];
      if (!t) throw new Stop("unknownTensorType", `${name}: ${type}`);
      if ((shape[0] ?? 1) % t[1] !== 0) throw new Stop("rowNotBlock", `${name}: ${shape[0]} / ${t[0]} (${t[1]})`);
      r.tensors.push({ name, shape, type, typeName: t[0], elements, bytes: (elements / t[1]) * t[2], offset: typeof off === "string" ? Number(off) : off });
    }
    r.headerBytes = rd.pos;
  } catch (e) {
    if (e instanceof Stop) {
      p.push({ code: e.code, severity: "error", ...(e.detail !== undefined ? { detail: e.detail } : {}) });
      return r;
    }
    throw e;
  }
  r.ok = true;

  // データ部(テンソルが無いときは詰め物も無い)
  r.dataOffset = r.tensors.length > 0 ? ALIGN(r.headerBytes, r.alignment) : r.headerBytes;
  let size = 0;
  for (const t of r.tensors) {
    if (t.offset !== size) {
      p.push({ code: "offsetMismatch", severity: "error", detail: `${t.name}: ${t.offset} ≠ ${size}` });
      break;
    }
    size += ALIGN(t.bytes!, r.alignment);
  }
  r.dataSize = size;
  // llama.cpp(src/llama-model-loader.h)は、各テンソルの終わり(詰め物は含まない)がファイルに収まらないと
  // "data is not within the file bounds, model is corrupted or incomplete" で止まる。同じ基準で見る
  const end = r.tensors.reduce((m, t) => Math.max(m, t.offset + (t.bytes ?? 0)), 0);
  r.expectedSize = r.dataOffset + end;
  if (fileSize < r.expectedSize) p.push({ code: "fileTruncated", severity: "error", detail: String(r.expectedSize - fileSize) });

  summarize(r);
  return r;
}

function summarize(r: GgufResult) {
  const p = r.problems;
  const m = new Map(r.metadata.map((e) => [e.key, e]));
  const s = (k: string) => {
    const v = m.get(k)?.value;
    return typeof v === "string" ? v : "";
  };
  const n = (k: string) => {
    const v = m.get(k)?.value;
    return typeof v === "number" ? v : null;
  };
  const b = (k: string) => {
    const v = m.get(k)?.value;
    return typeof v === "boolean" ? v : null;
  };

  // 重み
  const byType = new Map<string, TypeSummary>();
  let params = 0;
  let bytes = 0;
  for (const t of r.tensors) {
    params += t.elements;
    bytes += t.bytes ?? 0;
    const x = byType.get(t.typeName) ?? { typeName: t.typeName, count: 0, elements: 0, bytes: 0 };
    x.count++;
    x.elements += t.elements;
    x.bytes += t.bytes ?? 0;
    byType.set(t.typeName, x);
  }
  r.byType = [...byType.values()].sort((a, c) => c.bytes - a.bytes);
  if (r.tensors.length) {
    r.paramCount = params;
    r.weightBytes = bytes;
    r.bitsPerWeight = (bytes * 8) / params;
  }

  // general.*
  r.generalType = s("general.type");
  r.arch = s("general.architecture");
  r.sizeLabel = s("general.size_label");
  r.name = s("general.name") || [s("general.basename"), r.sizeLabel, s("general.finetune")].filter(Boolean).join(" ");
  r.quantizationVersion = n("general.quantization_version");
  r.license = s("general.license");
  r.licenseLink = s("general.license.link");
  r.repoUrl = s("general.repo_url");
  const baseCount = n("general.base_model.count") ?? 0;
  for (let i = 0; i < baseCount; i++) {
    const name = s(`general.base_model.${i}.name`);
    const org = s(`general.base_model.${i}.organization`);
    const repo = s(`general.base_model.${i}.repo_url`);
    const label = [org, name].filter(Boolean).join(" / ");
    if (label || repo) r.baseModels.push([label, repo].filter(Boolean).join(" — "));
  }
  const ft = n("general.file_type");
  if (ft !== null) r.fileType = { id: ft, name: FILE_TYPES[ft] ?? String(ft) };
  else if (r.tensors.length && r.generalType !== "adapter") p.push({ code: "fileTypeUnset", severity: "info" });

  // 種類
  if (r.generalType === "adapter") {
    r.adapterType = s("adapter.type");
    p.push({ code: "adapterFile", severity: "info", detail: r.adapterType });
  } else if (r.generalType === "imatrix") p.push({ code: "imatrixFile", severity: "info" });
  else if (r.arch === "clip" || r.generalType === "mmproj") p.push({ code: "projectorFile", severity: "info" });

  // 分割
  const sc = n("split.count");
  if (sc !== null && sc > 1) {
    r.split = { no: n("split.no") ?? 0, count: sc, tensors: n("split.tensors.count") };
    p.push({ code: "splitPart", severity: "info", detail: `${r.split.no + 1}/${sc}` });
  }

  // 形
  const a = r.arch;
  const k = (name: string) => n(`${a}.${name}`);
  r.contextLength = k("context_length");
  r.embeddingLength = k("embedding_length");
  r.blockCount = k("block_count");
  r.feedForwardLength = k("feed_forward_length");
  r.headCount = k("attention.head_count");
  const kvE = m.get(`${a}.attention.head_count_kv`);
  if (kvE && Array.isArray(kvE.value) && !kvE.partial && kvE.value.every((x) => typeof x === "number")) r.headCountKv = kvE.value as number[];
  else r.headCountKv = k("attention.head_count_kv") ?? r.headCount;
  r.ropeFreqBase = k("rope.freq_base");
  const scType = s(`${a}.rope.scaling.type`);
  const scFactor = k("rope.scaling.factor");
  const scOrig = k("rope.scaling.original_context_length");
  r.ropeScaling = scType && scType !== "none" ? [scType, scFactor !== null ? `×${scFactor}` : "", scOrig !== null ? `(${scOrig})` : ""].filter(Boolean).join(" ") : "";
  r.slidingWindow = k("attention.sliding_window");
  r.expertCount = k("expert_count");
  r.expertUsed = k("expert_used_count");

  // トークナイザー
  r.tokenizerModel = s("tokenizer.ggml.model");
  r.tokenizerPre = s("tokenizer.ggml.pre");
  const tokens = m.get("tokenizer.ggml.tokens");
  r.vocabSize = tokens?.length ?? k("vocab_size");
  const tokenText = (id: number): string | null => {
    const v = Array.isArray(tokens?.value) ? tokens.value[id] : undefined;
    return typeof v === "string" ? v : null;
  };
  const specials: [GgufResult["specialTokens"][number]["name"], string][] = [
    ["bos", "tokenizer.ggml.bos_token_id"],
    ["eos", "tokenizer.ggml.eos_token_id"],
    ["eot", "tokenizer.ggml.eot_token_id"],
    ["pad", "tokenizer.ggml.padding_token_id"],
    ["unk", "tokenizer.ggml.unknown_token_id"],
  ];
  for (const [name, key] of specials) {
    const id = n(key);
    if (id !== null) r.specialTokens.push({ name, token: { id, text: tokenText(id) } });
  }
  r.addBos = b("tokenizer.ggml.add_bos_token");
  r.chatTemplate = s("tokenizer.chat_template");
  r.otherChatTemplates = r.metadata.filter((e) => e.key.startsWith("tokenizer.chat_template.")).map((e) => e.key.slice("tokenizer.chat_template.".length));
  const isModel = !r.generalType || r.generalType === "model";
  if (isModel && r.arch !== "clip" && tokens && !r.chatTemplate) p.push({ code: "noChatTemplate", severity: "info" });

  // KV キャッシュ(f16)
  const keyLen = k("attention.key_length");
  const valLen = k("attention.value_length");
  let derived = false;
  if (keyLen !== null) r.headDim = keyLen;
  else if (r.embeddingLength !== null && r.headCount) {
    r.headDim = r.embeddingLength / r.headCount;
    derived = true;
  }
  if (!isModel || r.arch === "clip") return;
  if (r.blockCount !== null && r.headCountKv !== null && r.headDim !== null) {
    const kd = r.headDim;
    const vd = valLen ?? r.headDim;
    const perLayer = Array.isArray(r.headCountKv) ? r.headCountKv : Array<number>(r.blockCount).fill(r.headCountKv);
    r.kvBytesPerToken = perLayer.slice(0, r.blockCount).reduce((sum, h) => sum + h * (kd + vd) * 2, 0);
    if (Array.isArray(r.headCountKv)) p.push({ code: "kvPerLayer", severity: "info" });
    if (derived) p.push({ code: "headDimDerived", severity: "info", detail: String(r.headDim) });
    const hasSsm = r.metadata.some((e) => e.key.startsWith(`${a}.ssm.`));
    if (r.slidingWindow || k("attention.shared_kv_layers") || k("attention.kv_lora_rank") !== null || hasSsm) p.push({ code: "kvApprox", severity: "warn" });
    const max = r.contextLength;
    const set = new Set(CONTEXTS.filter((c) => max === null || c <= max));
    if (max !== null) set.add(max);
    r.kvRows = [...set]
      .sort((x, y) => x - y)
      .map((ctx) => ({ ctx, mib: kvMib(r.kvBytesPerToken!, ctx), note: ctx === max ? "max" : ctx === 4096 ? "default4k" : null }));
  } else p.push({ code: "kvMissing", severity: "info" });
}

/** 値を画面に出す形に(長い文字列は切る)。 */
export function formatValue(e: MetaEntry, maxLen = 160): string {
  const one = (v: Scalar | null) => {
    if (v === null) return "[…]";
    if (typeof v === "string") return JSON.stringify(v.length > maxLen ? `${v.slice(0, maxLen)}…` : v);
    if (typeof v === "number" && !Number.isInteger(v)) return String(Number(v.toPrecision(7)));
    return String(v);
  };
  if (Array.isArray(e.value)) {
    const head = e.value.slice(0, 8).map(one).join(", ");
    return `[${head}${(e.length ?? 0) > 8 ? ", …" : ""}]`;
  }
  return one(e.value);
}
