/**
 * pgvector SQL Builder の検算。
 *
 * 期待値は pgvector の公式 README(v0.8.7)とソース(hnsw.h・ivfflat.h・vector.h)の値を手で当てはめたもの。
 * 下の「既定の組み合わせ」の SQL と、距離4種 × 索引3種 × 型2種のうち作れる組み合わせは、2026-11-04 に
 * pgvector 0.8.7(Docker の pgvector/pgvector:0.8.7-pg16)で流し、all-minilm(384次元)の実際のベクトルで
 * 検索できること・索引が使われること(EXPLAIN)を確かめた。エラーにした組み合わせ(IVFFlat + L1、索引の次元の上限、
 * ef_construction < 2 * m、16,001 次元)も、同じ環境で PostgreSQL がエラーを返すことを確かめた。
 */
import { buildSql, isPlainIdentifier, suggestLists, suggestProbes, type SqlInput } from "../src/pgvector-sql";

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

const base: SqlInput = {
  table: "documents",
  dims: 384,
  type: "vector",
  distance: "cosine",
  index: "hnsw",
  m: 16,
  efConstruction: 64,
  efSearch: 40,
  rows: 10000,
  topK: 5,
};
const run = (i: Partial<SqlInput>) => buildSql({ ...base, ...i });
const codes = (i: Partial<SqlInput>) => run(i).problems.map((p) => p.code);

// 既定の組み合わせ(コサイン距離・HNSW・vector(384))
const d = run({});
eq("既定: 問題なし", d.problems, []);
eq(
  "既定: 表",
  d.setup,
  "CREATE EXTENSION IF NOT EXISTS vector;\n\nCREATE TABLE documents (\n  id bigserial PRIMARY KEY,\n  content text NOT NULL,\n  embedding vector(384) NOT NULL\n);",
);
eq("既定: 索引", d.index, "CREATE INDEX ON documents USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);");
eq(
  "既定: 検索(ef_search が既定の 40 なら SET を出さない)",
  d.search,
  "PREPARE search_documents(vector(384)) AS\n  SELECT id, content, 1 - (embedding <=> $1) AS cosine_similarity\n  FROM documents\n  ORDER BY embedding <=> $1\n  LIMIT 5;\n\n-- EXECUTE search_documents('[0.0123, -0.0456, ...]');",
);
// 容量: vector は 4 * 384 + 8 = 1,544 バイト(実機の pg_column_size も 1544)。1万行で 15,440,000 バイト
eq("既定: 1本のバイト数", d.bytesPerVector, 1544);
eq("既定: 合計", d.totalBytes, 15_440_000);
eq("既定: IVFFlat でないので lists なし", [d.lists, d.probes], [null, null]);

// halfvec: 2 * 384 + 8 = 776 バイト(実機の pg_column_size も 776)。演算子クラスは halfvec_*
const h = run({ type: "halfvec", distance: "ip" });
eq("halfvec: バイト数", h.bytesPerVector, 776);
eq("halfvec: 列", h.setup.includes("embedding halfvec(384) NOT NULL"), true);
eq("halfvec + 内積: 索引", h.index, "CREATE INDEX ON documents USING hnsw (embedding halfvec_ip_ops) WITH (m = 16, ef_construction = 64);");
eq("halfvec: PREPARE の型", h.search.startsWith("PREPARE search_documents(halfvec(384)) AS"), true);
eq("内積: 符号を戻す", h.search.includes("(embedding <#> $1) * -1 AS inner_product"), true);
eq("内積: 並べ替え", h.search.includes("ORDER BY embedding <#> $1"), true);

// 距離ごとの演算子と演算子クラス
const l2 = run({ distance: "l2" });
eq("L2: 演算子クラス", l2.index.includes("(embedding vector_l2_ops)"), true);
eq("L2: 値", l2.search.includes("embedding <-> $1 AS l2_distance"), true);
eq("L2: 並べ替え", l2.search.includes("ORDER BY embedding <-> $1"), true);
const l1 = run({ distance: "l1" });
eq("L1: 演算子クラス", l1.index.includes("(embedding vector_l1_ops)"), true);
eq("L1: 値", l1.search.includes("embedding <+> $1 AS l1_distance"), true);

// ef_search を変えたら SET を先頭に
eq("ef_search 100", run({ efSearch: 100 }).search.split("\n")[0], "SET hnsw.ef_search = 100;");

// IVFFlat: lists は 100万行までは 行数 / 1000、それより多いと sqrt(行数)。probes は sqrt(lists)
eq("lists 1万行", suggestLists(10000), 10);
eq("lists 100万行", suggestLists(1_000_000), 1000);
eq("lists 400万行 = sqrt", suggestLists(4_000_000), 2000);
eq("lists 少ない行でも1以上", suggestLists(4), 1);
eq("lists 499行は 0.499 → 1", suggestLists(499), 1);
eq("lists 1,500行は 1.5 → 2", suggestLists(1500), 2);
eq("lists 10億行 = sqrt(32768 未満)", suggestLists(1_000_000_000), 31623);
eq("probes sqrt(10) → 3", suggestProbes(10), 3);
eq("probes sqrt(1000) → 32", suggestProbes(1000), 32);
eq("probes sqrt(1) → 1", suggestProbes(1), 1);
const iv = run({ index: "ivfflat", distance: "l2", rows: 10000 });
eq("IVFFlat: 索引", iv.index, "CREATE INDEX ON documents USING ivfflat (embedding vector_l2_ops) WITH (lists = 10);");
eq("IVFFlat: probes を SET", iv.search.split("\n")[0], "SET ivfflat.probes = 3;");
eq("IVFFlat: lists/probes", [iv.lists, iv.probes], [10, 3]);
eq("IVFFlat: HNSW の値は見ない", codes({ index: "ivfflat", m: 0, efConstruction: 0, efSearch: 0 }), []);

// 索引なし
const none = run({ index: "none" });
eq("索引なし: 索引の文は空", none.index, "");
eq("索引なし: SET なし", none.search.startsWith("PREPARE"), true);
eq("索引なし: 2,001次元でも作れる", codes({ index: "none", dims: 2001 }), []);

// 上限(実機でも同じところでエラー)
eq("vector の索引は 2,000 次元まで", codes({ dims: 2000 }), []);
eq("vector の索引 2,001 次元", codes({ dims: 2001 }), ["indexDims"]);
eq("halfvec の索引は 4,000 次元まで", codes({ type: "halfvec", dims: 4000 }), []);
eq("halfvec の索引 4,001 次元", codes({ type: "halfvec", dims: 4001 }), ["indexDims"]);
eq("IVFFlat も 2,001 次元はエラー", codes({ index: "ivfflat", dims: 2001 }), ["indexDims"]);
eq("列は 16,000 次元まで", codes({ index: "none", dims: 16000 }), []);
eq("列 16,001 次元", codes({ index: "none", dims: 16001 }), ["dims"]);
eq("0 次元", codes({ dims: 0 }), ["dims"]);
eq("次元が整数でない", codes({ dims: 1.5 }), ["dims"]);
eq("IVFFlat + L1 は無い", codes({ index: "ivfflat", distance: "l1" }), ["ivfflatL1"]);
eq("HNSW + L1 はある", codes({ distance: "l1" }), []);
eq("m 2〜100", [codes({ m: 1 }), codes({ m: 2, efConstruction: 4 }), codes({ m: 100, efConstruction: 200 }), codes({ m: 101 })], [["m"], [], [], ["m"]]);
eq("ef_construction 4〜1000", [codes({ efConstruction: 3 }), codes({ m: 2, efConstruction: 4 }), codes({ efConstruction: 1000 }), codes({ efConstruction: 1001 })], [["efConstruction"], [], [], ["efConstruction"]]);
eq("ef_construction は 2 * m 以上", [codes({ m: 40, efConstruction: 79 }), codes({ m: 40, efConstruction: 80 })], [["efcVsM"], []]);
eq("ef_search 1〜1000", [codes({ efSearch: 0 }), codes({ efSearch: 1, topK: 1 }), codes({ efSearch: 1000 }), codes({ efSearch: 1001 })], [["efSearch"], [], [], ["efSearch"]]);
eq("行数", [codes({ rows: 0 }), codes({ rows: 1_000_000_001 }), codes({ rows: 2.5 })], [["rows"], ["rows"], ["rows"]]);
eq("件数", [codes({ topK: 0 }), codes({ topK: 1000, efSearch: 1000 }), codes({ topK: 1001 })], [["topK"], [], ["topK"]]);
// HNSW は hnsw.ef_search の数までしか返さない(README の Troubleshooting)
eq("LIMIT > ef_search は注意", run({ topK: 41 }).problems, [{ code: "limitOverEfSearch", severity: "warn" }]);
eq("注意でも SQL は出す", run({ topK: 41 }).search.includes("LIMIT 41;"), true);
eq("LIMIT = ef_search は問題なし", codes({ topK: 40 }), []);
eq("ef_search を上げれば問題なし", codes({ topK: 100, efSearch: 100 }), []);
eq("IVFFlat には出さない", codes({ index: "ivfflat", topK: 100 }), []);
eq("エラーのときは SQL を出さない", [run({ dims: 0 }).setup, run({ dims: 0 }).search], ["", ""]);

// 表の名前
eq("名前: 小文字", isPlainIdentifier("documents"), true);
eq("名前: _ と数字", isPlainIdentifier("_docs_2"), true);
eq("名前: 63文字まで", [isPlainIdentifier("a".repeat(63)), isPlainIdentifier("a".repeat(64))], [true, false]);
eq("名前: 大文字は不可", isPlainIdentifier("Documents"), false);
eq("名前: 先頭の数字は不可", isPlainIdentifier("1docs"), false);
eq("名前: 記号は不可", [isPlainIdentifier("my-docs"), isPlainIdentifier("public.docs"), isPlainIdentifier("")], [false, false, false]);
eq("名前: 予約語は不可", [isPlainIdentifier("user"), isPlainIdentifier("table"), isPlainIdentifier("order"), isPlainIdentifier("left")], [false, false, false, false]);
eq("名前: 予約語でない語は可", [isPlainIdentifier("items"), isPlainIdentifier("content"), isPlainIdentifier("text")], [true, true, true]);
eq("名前が不正ならエラー", codes({ table: "User" }), ["table"]);
eq("PREPARE の名前は 63 文字まで", run({ table: "a".repeat(63) }).search.split("(")[0], `PREPARE search_${"a".repeat(56)}`);

console.log(`\n[check:pgvector-sql] ${pass} 件OK / NG ${fail}件`);
if (fail) process.exit(1);
