/**
 * 埋め込み(embedding)のベクトルどうしを比べる。コサイン類似度・内積・ユークリッド距離と、各ベクトルの長さ(L2ノルム)。
 *
 * 読める形は、Ollama の公式ドキュメントにある応答の形だけ:
 *  - /api/embed の応答 `{"embeddings": [[…], […]]}`(docs.ollama.com/api/embed)
 *  - OpenAI 互換の /v1/embeddings の応答 `{"data": [{"embedding": […], "index": 0}, …]}`(docs.ollama.com/api/openai-compatibility)
 *  - ベクトルの配列 `[[…], […]]`、ベクトル1本 `[…]`
 *
 * Ollama の embeddings のページは「/api/embed は L2 正規化した(長さ1の)ベクトルを返す」「多くの意味検索にはコサイン類似度を」
 * 「索引と検索で同じ埋め込みモデルを使う」と書いている。長さ1なら、コサイン類似度と内積は同じ値になる。
 */

export const EMBEDDING_VERIFIED_ON = "2026-11-04";
export const OLLAMA_EMBEDDINGS_URL = "https://docs.ollama.com/capabilities/embeddings";
export const OLLAMA_EMBED_API_URL = "https://docs.ollama.com/api/embed";

/** 長さが 1 から、どれだけずれていたら「正規化されていない」とみなすか(float32 の丸めを見込む)。 */
export const NORM_TOLERANCE = 1e-3;
/** 一度に比べるベクトルの上限(行列の表が読めなくなるのと、画面が固まるのを防ぐ)。 */
export const MAX_VECTORS = 50;

export type SourceKind = "ollama" | "openai" | "array" | "single";

export type ProblemCode =
  | "empty"
  | "json"
  | "shape"
  | "base64"
  | "notNumber"
  | "emptyVector"
  | "tooMany"
  | "dimMismatch"
  | "zeroVector"
  | "single";

export type Problem = { code: ProblemCode; severity: "error" | "warn"; index?: number; dims?: string };

export type VectorInfo = { index: number; dims: number; norm: number; normalized: boolean };

export type Pair = { index: number; cosine: number | null; dot: number; distance: number };

export type SimilarityResult = {
  source: SourceKind | null;
  vectors: VectorInfo[];
  problems: Problem[];
  /** 比べられるとき(2本以上・次元がそろう・エラーなし)だけ。queryIndex との比較を、コサイン類似度の高い順に。 */
  ranking: Pair[];
  /** コサイン類似度の表(行と列はベクトルの番号)。ゼロベクトルの行・列は null。 */
  matrix: (number | null)[][];
  allNormalized: boolean;
};

/** 応答の JSON からベクトルの配列を取り出す(中身の数値はまだ見ない)。pgvector-insert.ts も使う。 */
export function readVectors(text: string): { source: SourceKind; raw: unknown[] } | Problem {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { code: "json", severity: "error" };
  }
  if (Array.isArray(v)) {
    if (v.length > 0 && v.every((x) => !Array.isArray(x) && typeof x !== "object")) return { source: "single", raw: [v] };
    return { source: "array", raw: v };
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.embeddings)) return { source: "ollama", raw: o.embeddings };
    if (Array.isArray(o.data)) {
      const items = o.data as unknown[];
      if (items.some((d) => !d || typeof d !== "object" || !("embedding" in (d as object)))) return { code: "shape", severity: "error" };
      // index があればその順に(応答の data は index を持つ)。
      const sorted = [...items].sort((a, b) => {
        const ia = (a as { index?: unknown }).index;
        const ib = (b as { index?: unknown }).index;
        return typeof ia === "number" && typeof ib === "number" ? ia - ib : 0;
      });
      return { source: "openai", raw: sorted.map((d) => (d as { embedding: unknown }).embedding) };
    }
  }
  return { code: "shape", severity: "error" };
}

export function analyze(text: string, queryIndex = 0): SimilarityResult {
  const empty: SimilarityResult = { source: null, vectors: [], problems: [], ranking: [], matrix: [], allNormalized: false };
  if (!text.trim()) return { ...empty, problems: [{ code: "empty", severity: "error" }] };

  const read = readVectors(text);
  if ("code" in read) return { ...empty, problems: [read] };

  const problems: Problem[] = [];
  if (read.raw.length > MAX_VECTORS) return { ...empty, source: read.source, problems: [{ code: "tooMany", severity: "error" }] };

  const vecs: number[][] = [];
  read.raw.forEach((r, i) => {
    if (typeof r === "string") {
      problems.push({ code: "base64", severity: "error", index: i });
      return;
    }
    if (!Array.isArray(r) || r.some((x) => typeof x !== "number" || !Number.isFinite(x))) {
      problems.push({ code: "notNumber", severity: "error", index: i });
      return;
    }
    if (r.length === 0) {
      problems.push({ code: "emptyVector", severity: "error", index: i });
      return;
    }
    vecs[i] = r as number[];
  });
  if (problems.length) return { ...empty, source: read.source, problems };
  if (vecs.length === 0) return { ...empty, source: read.source, problems: [{ code: "emptyVector", severity: "error" }] };

  const vectors: VectorInfo[] = vecs.map((v, index) => {
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return { index, dims: v.length, norm, normalized: Math.abs(norm - 1) <= NORM_TOLERANCE };
  });
  const allNormalized = vectors.every((v) => v.normalized);

  const dims = [...new Set(vectors.map((v) => v.dims))];
  if (dims.length > 1) {
    problems.push({ code: "dimMismatch", severity: "error", dims: dims.join(", ") });
    return { ...empty, source: read.source, vectors, problems, allNormalized };
  }
  vectors.forEach((v) => {
    if (v.norm === 0) problems.push({ code: "zeroVector", severity: "warn", index: v.index });
  });
  if (vecs.length === 1) {
    problems.push({ code: "single", severity: "warn" });
    return { ...empty, source: read.source, vectors, problems, allNormalized };
  }

  const cos = (a: number, b: number): number | null => {
    if (vectors[a].norm === 0 || vectors[b].norm === 0) return null;
    return dot(vecs[a], vecs[b]) / (vectors[a].norm * vectors[b].norm);
  };
  const matrix = vecs.map((_, a) => vecs.map((__, b) => cos(a, b)));

  const q = Math.min(Math.max(0, Math.trunc(queryIndex)), vecs.length - 1);
  const ranking: Pair[] = vecs
    .map((v, index) => ({ index, cosine: matrix[q][index], dot: dot(vecs[q], v), distance: distance(vecs[q], v) }))
    .filter((p) => p.index !== q)
    .sort((a, b) => (b.cosine ?? -Infinity) - (a.cosine ?? -Infinity) || a.index - b.index);

  return { source: read.source, vectors, problems, ranking, matrix, allNormalized };
}

function dot(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function distance(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

/** 1行に1つの見出し(入力した文など)。足りない分は「#番号」にする。 */
export function labelsFor(text: string, count: number): string[] {
  const lines = text.split(/\r?\n/);
  return Array.from({ length: count }, (_, i) => lines[i]?.trim() || `#${i}`);
}
