/**
 * Embedding Similarity Calculator の検算。
 *
 * 期待値(長さ・コサイン類似度・内積・距離)は、自作の実装と別に Python の math.fsum で計算した値を定数で持つ
 * (2026-11-04、scratchpad の gen_sim.py)。読める形は Ollama の公式ドキュメントにある応答の形
 * (/api/embed の embeddings、OpenAI 互換 /v1/embeddings の data[].embedding)。
 * 2026-11-04 に手元の Ollama 0.40.11(all-minilm)の実際の応答も貼り、384次元・長さ1と読め、コサイン類似度が Python の計算と一致した。
 */
import { analyze, labelsFor } from "../src/embedding-similarity";

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
function near(name: string, actual: number | null | undefined, expected: number, tol = 1e-9) {
  if (typeof actual === "number" && Math.abs(actual - expected) <= tol) pass++;
  else {
    fail++;
    console.error(`NG ${name}\n  actual:   ${actual}\n  expected: ${expected}`);
  }
}

const EXPECTED = {"small": {"vectors": [[1, 2, 3], [4, 5, 6], [-1, 0, 1], [3, 2, 1]], "norms": [3.7416573867739413, 8.774964387392123, 1.4142135623730951, 3.7416573867739413], "matrix": [[1.0, 0.9746318461970762, 0.3779644730092272, 0.7142857142857143], [0.9746318461970762, 0.9999999999999998, 0.16116459280507603, 0.8528028654224418], [0.3779644730092272, 0.16116459280507603, 0.9999999999999998, -0.3779644730092272], [0.7142857142857143, 0.8528028654224418, -0.3779644730092272, 1.0]], "dots": [[14.0, 32.0, 2.0, 10.0], [32.0, 77.0, 2.0, 28.0], [2.0, 2.0, 2.0, -2.0], [10.0, 28.0, -2.0, 14.0]], "dists": [[0.0, 5.196152422706632, 3.4641016151377544, 2.8284271247461903], [5.196152422706632, 0.0, 8.660254037844387, 5.916079783099616], [3.4641016151377544, 8.660254037844387, 0.0, 4.47213595499958], [2.8284271247461903, 5.916079783099616, 4.47213595499958, 0.0]]}, "unit8": {"vectors": [[-0.08324498, -0.09989121, -0.06431026, 0.40555548, -0.07371129, -0.86506263, 0.19198953, -0.15444828], [-0.11619571, 0.06206396, 0.12441079, 0.62316256, 0.35167224, 0.0591839, -0.39542, -0.54341874], [0.11579011, 0.61625737, 0.0195803, -0.04997595, 0.24995485, -0.68322104, -0.1467821, 0.23048886], [0.37268677, -0.10267809, 0.16069737, 0.10591413, 0.33382343, -0.47501844, 0.2424759, -0.64625473], [-0.74137773, -0.1717346, -0.25915088, 0.24788912, 0.18797031, -0.34496706, 0.23978167, -0.28359784]], "norms": [0.9999999981751614, 1.0000000003982392, 0.9999999976906676, 1.000000002621418, 0.999999999921728], "matrix": [[1.0000000000000002, 0.17909276174078187, 0.4161003883146856, 0.5445318126018917, 0.5704689507860315], [0.17909276174078187, 1.0000000000000002, -0.02365897328938079, 0.38090709353410057, 0.3027057920960004], [0.4161003883146856, -0.02365897328938079, 1.0, 0.20116839595909244, -0.027028623913837466], [0.5445318126018917, 0.38090709353410057, 0.20116839595909244, 1.0000000000000002, 0.19397413437954322], [0.5704689507860315, 0.3027057920960004, -0.027028623913837466, 0.19397413437954322, 1.0]], "dots": [[0.9999999963503229, 0.17909276148528824, 0.4161003865944554, 0.5445318130356543, 0.570468949700366], [0.17909276148528824, 1.0000000007964787, -0.023658973244166288, 0.3809070946843094, 0.3027057921928563], [0.4161003865944554, -0.023658973244166288, 0.9999999953813352, 0.20116839602187417, -0.027028623849303803], [0.5445318130356543, 0.3809070946843094, 0.20116839602187417, 1.0000000052428362, 0.19397413487284776], [0.570468949700366, 0.3027057921928563, -0.027028623849303803, 0.19397413487284776, 0.9999999998434559]], "dists": [[0.0, 1.2813330847895192, 1.0806475922069818, 0.9544298693575397, 0.9268560280825964], [1.2813330847895192, 0.0, 1.430845184730391, 1.1127379820383125, 1.1809269309547572], [1.0806475922069818, 1.430845184730391, 0.0, 1.2639870286440533, 1.4331982566705133], [0.9544298693575397, 1.1127379820383125, 1.2639870286440533, 0.0, 1.2696659936143033], [0.9268560280825964, 1.1809269309547572, 1.4331982566705133, 1.2696659936143033, 0.0]]}} as const;

for (const [name, c] of Object.entries(EXPECTED)) {
  const vecs = c.vectors as unknown as number[][];
  const r = analyze(JSON.stringify({ embeddings: vecs }), 0);
  eq(`${name}: 読めた形`, r.source, "ollama");
  eq(`${name}: エラーなし`, r.problems.filter((p) => p.severity === "error"), []);
  c.norms.forEach((n, i) => near(`${name}: 長さ #${i}`, r.vectors[i].norm, n));
  c.matrix.forEach((row, a) => row.forEach((v, b) => near(`${name}: 類似度 ${a}-${b}`, r.matrix[a][b], v)));
  // 0番との比較(順位は類似度の高い順)
  const want = c.matrix[0].map((v, i) => ({ i, v })).filter((x) => x.i !== 0).sort((x, y) => y.v - x.v || x.i - y.i).map((x) => x.i);
  eq(`${name}: 順位`, r.ranking.map((p) => p.index), want);
  for (const p of r.ranking) {
    near(`${name}: 内積 0-${p.index}`, p.dot, c.dots[0][p.index]);
    near(`${name}: 距離 0-${p.index}`, p.distance, c.dists[0][p.index]);
  }
  // 基準を 2 番にしても同じ値
  const r2 = analyze(JSON.stringify(vecs), 2);
  eq(`${name}: 配列の形`, r2.source, "array");
  for (const p of r2.ranking) near(`${name}: 2番基準 2-${p.index}`, p.cosine, c.matrix[2][p.index]);
}

// 正規化の判定: unit8 は全部長さ1、small は違う
eq("unit8 は正規化済み", analyze(JSON.stringify({ embeddings: EXPECTED.unit8.vectors })).allNormalized, true);
eq("small は正規化されていない", analyze(JSON.stringify({ embeddings: EXPECTED.small.vectors })).allNormalized, false);
// 長さ1なら、コサイン類似度と内積は同じ
{
  const r = analyze(JSON.stringify({ embeddings: EXPECTED.unit8.vectors }));
  for (const p of r.ranking) near(`unit8: 類似度=内積 ${p.index}`, p.cosine, p.dot, 1e-8);
}

// OpenAI 互換の応答。data は index の順に並べ直す
{
  const v = EXPECTED.small.vectors as unknown as number[][];
  const body = { object: "list", data: [2, 0, 3, 1].map((i) => ({ object: "embedding", embedding: v[i], index: i })), model: "x" };
  const r = analyze(JSON.stringify(body), 0);
  eq("openai: 形", r.source, "openai");
  near("openai: index 順に並べ直す", r.matrix[0][1], EXPECTED.small.matrix[0][1]);
}
// ベクトル1本
eq("1本: 形", analyze("[0.6, 0.8]").source, "single");
eq("1本: 比べる相手がいない", analyze("[0.6, 0.8]").problems.map((p) => p.code), ["single"]);
near("1本: 長さ", analyze("[0.6, 0.8]").vectors[0].norm, 1);

// 誤り
eq("空", analyze("  ").problems.map((p) => p.code), ["empty"]);
eq("JSON でない", analyze("{embeddings: [[1]]}").problems.map((p) => p.code), ["json"]);
eq("形が違う", analyze('{"embedding": [1, 2]}').problems.map((p) => p.code), ["shape"]);
eq("data に embedding が無い", analyze('{"data": [{"x": 1}]}').problems.map((p) => p.code), ["shape"]);
eq("base64", analyze('{"data": [{"embedding": "AACAPw==", "index": 0}]}').problems.map((p) => [p.code, p.index]), [["base64", 0]]);
eq("数でない", analyze('{"embeddings": [[1, "2"], [1, 2]]}').problems.map((p) => [p.code, p.index]), [["notNumber", 0]]);
eq("空のベクトル", analyze('{"embeddings": [[1, 2], []]}').problems.map((p) => [p.code, p.index]), [["emptyVector", 1]]);
eq("次元がそろわない", analyze('{"embeddings": [[1, 2], [1, 2, 3]]}').problems.map((p) => [p.code, p.dims]), [["dimMismatch", "2, 3"]]);
{
  const r = analyze('{"embeddings": [[0, 0], [1, 0], [0, 1]]}');
  eq("ゼロベクトル: 注意", r.problems.map((p) => [p.code, p.index]), [["zeroVector", 0]]);
  eq("ゼロベクトル: 類似度は出さない", r.ranking.map((p) => p.cosine), [null, null]);
  near("ゼロベクトル: 距離は出す", r.ranking[0].distance, 1);
}
eq("51本は多すぎる", analyze(JSON.stringify({ embeddings: Array.from({ length: 51 }, () => [1, 0]) })).problems.map((p) => p.code), ["tooMany"]);
eq("空の embeddings", analyze('{"embeddings": []}').problems.map((p) => p.code), ["emptyVector"]);

// 見出し
eq("見出し", labelsFor("Why is the sky blue?\n\nThird", 4), ["Why is the sky blue?", "#1", "Third", "#3"]);

console.log(`\n[check:embedding-similarity] ${pass} 件OK / NG ${fail}件`);
if (fail) process.exit(1);
