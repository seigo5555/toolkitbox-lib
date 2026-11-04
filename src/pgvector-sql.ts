/**
 * PostgreSQL の拡張 pgvector で埋め込み(embedding)を保存・検索する SQL を組み立てる。
 *
 * 決まりはすべて pgvector の公式 README(v0.8.7)とソースから:
 *  - CREATE EXTENSION vector はデータベースごとに1回。列は vector(n) か halfvec(n)。どちらも 16,000 次元まで
 *  - 距離の演算子: <-> L2 距離、<#> 内積の符号を反転した値、<=> コサイン距離、<+> L1 距離。コサイン類似度は 1 - コサイン距離
 *  - 索引は使う距離ごとに演算子クラス(vector_cosine_ops など。halfvec は halfvec_cosine_ops など)を選ぶ
 *  - HNSW: m 16(2〜100)、ef_construction 64(4〜1000、2 * m 以上)、検索時の hnsw.ef_search 40(1〜1000)。索引は vector 2,000 次元・halfvec 4,000 次元まで
 *  - IVFFlat: L1 距離の演算子クラスは無い。lists の目安は 100万行までは 行数 / 1000、それより多いと sqrt(行数)(1〜32768)。
 *    検索時の ivfflat.probes(既定 1)の目安は sqrt(lists)。データを入れてから索引を作る
 *  - 1本の容量: vector は 4 * 次元 + 8 バイト、halfvec は 2 * 次元 + 8 バイト
 *  - 索引が使われるのは ORDER BY が距離の演算子そのもの(式でない)で昇順、かつ LIMIT があるとき。
 *    HNSW の結果は hnsw.ef_search の数までなので、LIMIT がそれより大きいと注意を出す
 * 表の名前は引用符なしで書ける小文字の名前だけ受け付ける(PostgreSQL は 63 バイトまで。予約語は使えない)。
 * 2026-11-04 に pgvector 0.8.7(PostgreSQL 16)で、出した SQL を流して確かめた。
 */

export const PGVECTOR_VERIFIED_ON = "2026-11-04";
export const PGVECTOR_VERSION = "0.8.7";
export const PGVECTOR_README_URL = "https://github.com/pgvector/pgvector/blob/v0.8.7/README.md";

export type Distance = "cosine" | "l2" | "ip" | "l1";
export type VecType = "vector" | "halfvec";
export type IndexKind = "hnsw" | "ivfflat" | "none";

export const DISTANCES: Distance[] = ["cosine", "l2", "ip", "l1"];
export const VEC_TYPES: VecType[] = ["vector", "halfvec"];
export const INDEX_KINDS: IndexKind[] = ["hnsw", "ivfflat", "none"];

export const MAX_DIMS = 16000;
export const INDEX_MAX_DIMS: Record<VecType, number> = { vector: 2000, halfvec: 4000 };
export const HNSW = { m: 16, mMin: 2, mMax: 100, efc: 64, efcMin: 4, efcMax: 1000, efSearch: 40, efSearchMin: 1, efSearchMax: 1000 };
export const IVFFLAT = { listsMin: 1, listsMax: 32768, probes: 1 };
export const ROWS_MAX = 1_000_000_000;
export const TOP_K_MAX = 1000;

const OPERATOR: Record<Distance, string> = { cosine: "<=>", l2: "<->", ip: "<#>", l1: "<+>" };
const OPS_SUFFIX: Record<Distance, string> = { cosine: "cosine_ops", l2: "l2_ops", ip: "ip_ops", l1: "l1_ops" };

/**
 * PostgreSQL の予約語(kwlist.h の RESERVED_KEYWORD と TYPE_FUNC_NAME_KEYWORD。16 と 18 で同じ 101 語)。
 * これらは引用符なしでは表の名前にできない。
 */
const RESERVED = new Set(
  (
    "all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column " +
    "concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp " +
    "current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having " +
    "ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not " +
    "notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar " +
    "some symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when where window with"
  ).split(" "),
);

/** 引用符なしで使える名前か(小文字・数字・_、先頭は数字以外、63文字まで、予約語でない)。 */
export function isPlainIdentifier(name: string): boolean {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(name) && !RESERVED.has(name);
}

export type SqlInput = {
  table: string;
  dims: number;
  type: VecType;
  distance: Distance;
  index: IndexKind;
  m: number;
  efConstruction: number;
  efSearch: number;
  /** 入れる予定の行数。IVFFlat の lists の目安と、容量の見積もりに使う。 */
  rows: number;
  topK: number;
};

export type ProblemCode =
  | "table"
  | "dims"
  | "indexDims"
  | "ivfflatL1"
  | "m"
  | "efConstruction"
  | "efcVsM"
  | "efSearch"
  | "rows"
  | "topK"
  | "limitOverEfSearch";

export type Problem = { code: ProblemCode; severity: "error" | "warn" };

export type SqlResult = {
  problems: Problem[];
  setup: string;
  /** 索引を作る文。IVFFlat ならデータを入れた後に流す。索引なしなら空。 */
  index: string;
  search: string;
  lists: number | null;
  probes: number | null;
  bytesPerVector: number;
  totalBytes: number;
};

const isInt = (n: number) => Number.isInteger(n);
const inRange = (n: number, min: number, max: number) => isInt(n) && n >= min && n <= max;

/** IVFFlat の lists の目安(README: 100万行までは 行数 / 1000、それより多いと sqrt(行数))。 */
export function suggestLists(rows: number): number {
  const v = rows <= 1_000_000 ? Math.round(rows / 1000) : Math.round(Math.sqrt(rows));
  return Math.min(IVFFLAT.listsMax, Math.max(IVFFLAT.listsMin, v));
}

/** ivfflat.probes の目安(README: sqrt(lists))。 */
export function suggestProbes(lists: number): number {
  return Math.max(1, Math.round(Math.sqrt(lists)));
}

/** 検索で返す列: 距離ごとに、読みやすい値(コサイン類似度・内積)にして返す。 */
function scoreColumn(distance: Distance): string {
  switch (distance) {
    case "cosine":
      return "1 - (embedding <=> $1) AS cosine_similarity";
    case "l2":
      return "embedding <-> $1 AS l2_distance";
    case "ip":
      return "(embedding <#> $1) * -1 AS inner_product";
    case "l1":
      return "embedding <+> $1 AS l1_distance";
  }
}

export function buildSql(input: SqlInput): SqlResult {
  const { table, dims, type, distance, index, m, efConstruction, efSearch, rows, topK } = input;
  const problems: Problem[] = [];
  const err = (code: ProblemCode) => problems.push({ code, severity: "error" });

  if (!isPlainIdentifier(table)) err("table");
  if (!inRange(dims, 1, MAX_DIMS)) err("dims");
  else if (index !== "none" && dims > INDEX_MAX_DIMS[type]) err("indexDims");
  if (index === "ivfflat" && distance === "l1") err("ivfflatL1");
  if (index === "hnsw") {
    const mOk = inRange(m, HNSW.mMin, HNSW.mMax);
    const efcOk = inRange(efConstruction, HNSW.efcMin, HNSW.efcMax);
    if (!mOk) err("m");
    if (!efcOk) err("efConstruction");
    if (mOk && efcOk && efConstruction < 2 * m) err("efcVsM");
    if (!inRange(efSearch, HNSW.efSearchMin, HNSW.efSearchMax)) err("efSearch");
  }
  if (!inRange(rows, 1, ROWS_MAX)) err("rows");
  if (!inRange(topK, 1, TOP_K_MAX)) err("topK");
  if (index === "hnsw" && !problems.length && topK > efSearch) problems.push({ code: "limitOverEfSearch", severity: "warn" });

  const bytesPerVector = inRange(dims, 1, MAX_DIMS) ? (type === "vector" ? 4 : 2) * dims + 8 : 0;
  const totalBytes = inRange(rows, 1, ROWS_MAX) ? bytesPerVector * rows : 0;
  const lists = index === "ivfflat" && inRange(rows, 1, ROWS_MAX) ? suggestLists(rows) : null;
  const probes = lists === null ? null : suggestProbes(lists);

  if (problems.some((p) => p.severity === "error")) return { problems, setup: "", index: "", search: "", lists, probes, bytesPerVector, totalBytes };

  const col = `${type}(${dims})`;
  const setup = [
    "CREATE EXTENSION IF NOT EXISTS vector;",
    "",
    `CREATE TABLE ${table} (`,
    "  id bigserial PRIMARY KEY,",
    "  content text NOT NULL,",
    `  embedding ${col} NOT NULL`,
    ");",
  ].join("\n");

  const ops = `${type}_${OPS_SUFFIX[distance]}`;
  const indexSql =
    index === "hnsw"
      ? `CREATE INDEX ON ${table} USING hnsw (embedding ${ops}) WITH (m = ${m}, ef_construction = ${efConstruction});`
      : index === "ivfflat"
        ? `CREATE INDEX ON ${table} USING ivfflat (embedding ${ops}) WITH (lists = ${lists});`
        : "";

  const name = `search_${table}`.slice(0, 63);
  const op = OPERATOR[distance];
  const search = [
    ...(index === "hnsw" && efSearch !== HNSW.efSearch ? [`SET hnsw.ef_search = ${efSearch};`, ""] : []),
    ...(index === "ivfflat" ? [`SET ivfflat.probes = ${probes};`, ""] : []),
    `PREPARE ${name}(${col}) AS`,
    `  SELECT id, content, ${scoreColumn(distance)}`,
    `  FROM ${table}`,
    `  ORDER BY embedding ${op} $1`,
    `  LIMIT ${topK};`,
    "",
    `-- EXECUTE ${name}('[0.0123, -0.0456, ...]');`,
  ].join("\n");

  return { problems, setup, index: indexSql, search, lists, probes, bytesPerVector, totalBytes };
}
