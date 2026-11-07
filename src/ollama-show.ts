/**
 * Ollama のモデル情報(/api/show の応答、または ollama show・ollama show --verbose の出力)を読み、
 * 大きさ・文脈の長さ・層と注意ヘッド・できること(capabilities)・既定の設定・ライセンスをまとめ、
 * KV キャッシュの大きさを文脈の長さごとに出す。
 *
 * 出どころ:
 *  - 応答の形: docs.ollama.com/api-reference/show-model-details(ShowResponse・Thinking)
 *  - capabilities の名前: ollama/ollama v0.40.15 の types/model/capability.go(completion・tools・insert・vision・
 *    embedding・thinking・image・audio・decision・speech)。どの要求で要るかは server/routes.go と server/images.go
 *  - ollama show の表の並び: cmd/cmd.go の showInfo
 *  - KV キャッシュ = 2(K と V)× 層 × KV ヘッド × ヘッドの次元 × 2 バイト(f16)× 文脈の長さ。
 *    2026-11-07 に Ollama 0.40.11 のログ(llama_kv_cache: size)で確かめた: qwen2.5:7b は 4096 で 224 MiB、
 *    8192 で 448 MiB、qwen2.5:0.5b は 4096 で 48 MiB、32768 で 384 MiB。
 *    ヘッドの次元は attention.key_length / value_length があればそれ、なければ embedding_length ÷ head_count。
 *    sliding window や KV を共有する層があるモデルは、実際はこれより小さい(ここでは計算しない)
 *  - KV キャッシュの型: 既定は f16。q8_0 は約 1/2、q4_0 は約 1/4(docs.ollama.com/faq)
 *
 * 2026-11-07 に手元の Ollama 0.40.11 の qwen2.5:7b で、/api/show・ollama show・ollama show --verbose の本物の出力を
 * 読ませて確かめた(scripts/check-ollama-show.ts)。
 */

export const OLLAMA_SHOW_VERIFIED_ON = "2026-11-07";
export const OLLAMA_SHOW_DOC_URL = "https://docs.ollama.com/api-reference/show-model-details";
export const OLLAMA_SHOW_SOURCE_VERSION = "v0.40.15";

export type ShowInput = "json" | "cli" | "cliVerbose";

export type ProblemCode =
  | "inputEmpty"
  | "inputUnknown"
  | "jsonInvalid"
  | "notShowResponse"
  | "errorResponse"
  | "kvMissing"
  | "kvApprox"
  | "headDimDerived"
  | "numCtxParam"
  | "unknownCapability";

export type Severity = "error" | "warn" | "info";
export type Problem = { code: ProblemCode; severity: Severity; detail?: string };

/** types/model/capability.go の名前(v0.40.15)。 */
export const KNOWN_CAPABILITIES = ["completion", "tools", "insert", "vision", "embedding", "thinking", "image", "audio", "decision", "speech"] as const;
export type Capability = (typeof KNOWN_CAPABILITIES)[number];

export type KvRow = { ctx: number; mib: number; note: "default4k" | "param" | "max" | null };

export type ShowResult = {
  problems: Problem[];
  input: ShowInput | null;
  arch: string;
  name: string;
  parameterCount: number | null;
  parameterSize: string;
  quantization: string;
  family: string;
  format: string;
  contextLength: number | null;
  embeddingLength: number | null;
  blockCount: number | null;
  headCount: number | null;
  headCountKv: number | null;
  headDim: number | null;
  slidingWindow: number | null;
  sharedKvLayers: number | null;
  expertCount: number | null;
  expertUsed: number | null;
  capabilities: string[];
  thinking: { values: unknown[]; default: unknown } | null;
  parameters: [string, string][];
  system: string;
  templateSource: string;
  renderer: string;
  parser: string;
  license: string;
  licenseId: string;
  licenseLink: string;
  modifiedAt: string;
  /** f16 の KV キャッシュ 1 トークンぶん(バイト)。 */
  kvBytesPerToken: number | null;
  kvRows: KvRow[];
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?[\d.]+(?:e[+-]?\d+)?$/i.test(v.trim())) return Number(v);
  return null;
};

/** parameters の文字列("stop \"<|im_end|>\"" が1行ずつ)を [名前, 値] に。 */
export function parseParameters(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+(.*?)\s*$/.exec(line);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

/** ollama show の出力(表)を読む。セクションは2文字下げの見出し、行は4文字下げで「名前  値」(2つ以上の空白で区切る)。 */
export function parseCli(text: string): { model: Record<string, string>; metadata: Record<string, string>; capabilities: string[]; parameters: [string, string][]; system: string; license: string } | null {
  const model: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  const capabilities: string[] = [];
  const parameters: [string, string][] = [];
  const system: string[] = [];
  const license: string[] = [];
  let section = "";
  let seen = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const h = /^ {2}(\S.*)$/.exec(line);
    if (h && !/^ {3}/.test(line)) {
      section = h[1].trim();
      if (["Model", "Capabilities", "Parameters", "System", "License", "Metadata", "Tensors", "Projector"].includes(section)) seen = true;
      continue;
    }
    const body = line.replace(/^\s+/, "");
    if (section === "Model" || section === "Metadata") {
      const m = /^(.+?)\s{2,}(.+)$/.exec(body);
      if (m) (section === "Model" ? model : metadata)[m[1]] = m[2].trim();
    } else if (section === "Capabilities") capabilities.push(body.trim());
    else if (section === "Parameters") {
      const m = /^(\S+)\s+(.*)$/.exec(body);
      if (m) parameters.push([m[1], m[2].trim()]);
    } else if (section === "System") system.push(body);
    else if (section === "License") license.push(body);
  }
  if (!seen) return null;
  return { model, metadata, capabilities, parameters, system: system.join("\n"), license: license.join("\n") };
}

const CONTEXTS = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];

export function kvMib(bytesPerToken: number, ctx: number) {
  return (bytesPerToken * ctx) / 1048576;
}

export function readShow(text: string): ShowResult {
  const problems: Problem[] = [];
  const r: ShowResult = {
    problems,
    input: null,
    arch: "",
    name: "",
    parameterCount: null,
    parameterSize: "",
    quantization: "",
    family: "",
    format: "",
    contextLength: null,
    embeddingLength: null,
    blockCount: null,
    headCount: null,
    headCountKv: null,
    headDim: null,
    slidingWindow: null,
    sharedKvLayers: null,
    expertCount: null,
    expertUsed: null,
    capabilities: [],
    thinking: null,
    parameters: [],
    system: "",
    templateSource: "",
    renderer: "",
    parser: "",
    license: "",
    licenseId: "",
    licenseLink: "",
    modifiedAt: "",
    kvBytesPerToken: null,
    kvRows: [],
  };
  const src = text.replace(/^﻿/, "");
  if (!src.trim()) {
    problems.push({ code: "inputEmpty", severity: "error" });
    return r;
  }

  let info: Record<string, unknown> = {};
  const t = src.trim();
  if (t.startsWith("{")) {
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      problems.push({ code: "jsonInvalid", severity: "error" });
      return r;
    }
    if (!isObj(v)) {
      problems.push({ code: "jsonInvalid", severity: "error" });
      return r;
    }
    if ("error" in v && !("model_info" in v)) {
      problems.push({ code: "errorResponse", severity: "error", detail: str(v.error) || JSON.stringify(v.error) });
      return r;
    }
    if (!isObj(v.model_info) && !isObj(v.details) && !Array.isArray(v.capabilities)) {
      problems.push({ code: "notShowResponse", severity: "error" });
      return r;
    }
    r.input = "json";
    info = isObj(v.model_info) ? v.model_info : {};
    const d = isObj(v.details) ? v.details : {};
    r.parameterSize = str(d.parameter_size);
    r.quantization = str(d.quantization_level);
    r.family = str(d.family);
    r.format = str(d.format);
    r.capabilities = Array.isArray(v.capabilities) ? v.capabilities.filter((c): c is string => typeof c === "string") : [];
    if (isObj(v.thinking) && Array.isArray(v.thinking.values)) r.thinking = { values: v.thinking.values, default: v.thinking.default };
    r.parameters = typeof v.parameters === "string" ? parseParameters(v.parameters) : [];
    r.system = str(v.system);
    r.templateSource = str(v.template_source);
    r.renderer = str(v.renderer);
    r.parser = str(v.parser);
    r.license = str(v.license);
    r.modifiedAt = str(v.modified_at);
  } else {
    const c = parseCli(src);
    if (!c) {
      problems.push({ code: "inputUnknown", severity: "error" });
      return r;
    }
    r.input = Object.keys(c.metadata).length > 0 ? "cliVerbose" : "cli";
    info = c.metadata;
    r.arch = c.model["architecture"] ?? "";
    r.parameterSize = c.model["parameters"] ?? "";
    r.quantization = c.model["quantization"] ?? "";
    r.contextLength = num(c.model["context length"]);
    r.embeddingLength = num(c.model["embedding length"]);
    r.templateSource = c.model["template source"] ?? "";
    r.renderer = c.model["renderer"] ?? "";
    r.parser = c.model["parser"] ?? "";
    r.capabilities = c.capabilities;
    r.parameters = c.parameters;
    r.system = c.system;
    r.license = c.license;
  }

  // model_info(GGUF のメタデータ)。キーは "<architecture>.<名前>"。
  const arch = str(info["general.architecture"]) || r.arch;
  r.arch = arch;
  const k = (name: string) => num(info[`${arch}.${name}`]);
  r.parameterCount = num(info["general.parameter_count"]);
  const basename = str(info["general.basename"]);
  const sizeLabel = str(info["general.size_label"]);
  const finetune = str(info["general.finetune"]);
  r.name = str(info["general.name"]) || [basename, sizeLabel, finetune].filter(Boolean).join(" ");
  r.licenseId = str(info["general.license"]);
  r.licenseLink = str(info["general.license.link"]);
  r.contextLength = k("context_length") ?? r.contextLength;
  r.embeddingLength = k("embedding_length") ?? r.embeddingLength;
  r.blockCount = k("block_count");
  r.headCount = k("attention.head_count");
  r.headCountKv = k("attention.head_count_kv") ?? r.headCount;
  r.slidingWindow = k("attention.sliding_window");
  r.sharedKvLayers = k("attention.shared_kv_layers");
  r.expertCount = k("expert_count");
  r.expertUsed = k("expert_used_count");
  const keyLen = k("attention.key_length");
  const valLen = k("attention.value_length");
  let derived = false;
  if (keyLen !== null) r.headDim = keyLen;
  else if (r.embeddingLength !== null && r.headCount) {
    r.headDim = r.embeddingLength / r.headCount;
    derived = true;
  }

  for (const c of r.capabilities)
    if (!(KNOWN_CAPABILITIES as readonly string[]).includes(c)) problems.push({ code: "unknownCapability", severity: "info", detail: c });

  // KV キャッシュ(f16)。
  if (r.blockCount !== null && r.headCountKv !== null && r.headDim !== null) {
    const kDim = r.headCountKv * r.headDim;
    const vDim = r.headCountKv * (valLen ?? r.headDim);
    r.kvBytesPerToken = r.blockCount * (kDim + vDim) * 2;
    if (derived) problems.push({ code: "headDimDerived", severity: "info", detail: String(r.headDim) });
    if (r.slidingWindow || r.sharedKvLayers) problems.push({ code: "kvApprox", severity: "warn" });
    const numCtx = r.parameters.find(([n]) => n === "num_ctx");
    const paramCtx = numCtx ? num(numCtx[1]) : null;
    if (paramCtx !== null) problems.push({ code: "numCtxParam", severity: "info", detail: String(paramCtx) });
    const max = r.contextLength;
    const set = new Set(CONTEXTS.filter((c) => max === null || c <= max));
    if (max !== null) set.add(max);
    if (paramCtx !== null) set.add(paramCtx);
    r.kvRows = [...set]
      .sort((a, b) => a - b)
      .map((ctx) => ({
        ctx,
        mib: kvMib(r.kvBytesPerToken!, ctx),
        note: ctx === paramCtx ? "param" : ctx === max ? "max" : ctx === 4096 ? "default4k" : null,
      }));
  } else problems.push({ code: "kvMissing", severity: "info" });

  return r;
}
