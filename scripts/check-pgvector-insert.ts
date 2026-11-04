/**
 * Embeddings to pgvector INSERT の検算。
 *
 * 期待値は手で書いた SQL。文字列の ' は '' にする(PostgreSQL の文書 4.1.2.1)。ベクトルは pgvector の書き方 '[1,2,3]'。
 * 2026-11-04 に、Ollama 0.40.11 の all-minilm で作った実際の応答(5本、' を含む文あり)からこの変換で INSERT を作り、
 * pgvector 0.8.7(PostgreSQL 16)の vector(384) と halfvec(384) の表に流して、文がそのまま入ること・
 * 次元 384・長さ 1・検索の順位とコサイン類似度が Embedding Similarity Calculator の値と一致することを確かめた。
 */
import { buildInsert, sqlString, vectorLiteral, type InsertInput } from "../src/pgvector-insert";

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

const base: InsertInput = {
  texts: JSON.stringify({ model: "all-minilm", input: ["first", "it's second"], truncate: false }),
  response: JSON.stringify({ model: "all-minilm", embeddings: [[0.6, 0.8], [1, 0]] }),
  table: "documents",
  textColumn: "content",
  vectorColumn: "embedding",
  dims: "",
};
const run = (i: Partial<InsertInput>) => buildInsert({ ...base, ...i });
const codes = (i: Partial<InsertInput>) => run(i).problems.map((p) => p.code);

eq("文字列: ' を '' に", sqlString("it's"), "'it''s'");
eq("文字列: \\ はそのまま", sqlString("C:\\path"), "'C:\\path'");
eq("文字列: 改行はそのまま", sqlString("a\nb"), "'a\nb'");
eq("ベクトル", vectorLiteral([0.6, -0.8, 1e-7]), "'[0.6,-0.8,1e-7]'");

const d = run({});
eq("既定: 問題なし", d.problems, []);
eq("既定: 読めた形", [d.textsKind, d.source, d.rows, d.dims], ["body", "ollama", 2, 2]);
eq(
  "既定: SQL",
  d.sql,
  "BEGIN;\n\nINSERT INTO documents (content, embedding) VALUES\n  ('first', '[0.6,0.8]'),\n  ('it''s second', '[1,0]');\n\nCOMMIT;",
);

// 文章の読み方
eq("文字列の配列", [run({ texts: '["a","b"]' }).textsKind, run({ texts: '["a","b"]' }).rows], ["array", 2]);
eq("1行に1つ(空行は飛ばす)", [run({ texts: "a\n\n  \nb\r\n" }).textsKind, run({ texts: "a\n\n  \nb\r\n" }).rows], ["lines", 2]);
eq("1行に1つ: 行の中身はそのまま", run({ texts: "  a\nb" }).sql.includes("('  a', '[0.6,0.8]')"), true);
eq("input が1つの文字列", codes({ texts: '{"model":"m","input":"one"}' }), ["countMismatch"]);
eq("input が1つの文字列(ベクトル1本)", run({ texts: '{"model":"m","input":"one"}', response: '{"embeddings":[[1,0]]}' }).rows, 1);

// OpenAI 互換の応答(index の順に並べ直す)
const oa = run({ response: JSON.stringify({ data: [{ index: 1, embedding: [1, 0] }, { index: 0, embedding: [0.6, 0.8] }] }) });
eq("OpenAI 互換: 形", oa.source, "openai");
eq("OpenAI 互換: index の順", oa.sql.includes("('first', '[0.6,0.8]')") && oa.sql.includes("('it''s second', '[1,0]')"), true);

// 列の名前と次元
eq("列の名前", run({ table: "chunks", textColumn: "body", vectorColumn: "vec" }).sql.includes("INSERT INTO chunks (body, vec) VALUES"), true);
eq("次元が合う", codes({ dims: "2" }), []);
eq("次元が合わない", run({ dims: "384" }).problems, [{ code: "dimsColumn", severity: "error", detail: "2" }]);
eq("次元の入力が不正", [codes({ dims: "abc" }), codes({ dims: "0" }), codes({ dims: "16001" }), codes({ dims: " 2 " })], [["dimsInput"], ["dimsInput"], ["dimsInput"], []]);

// 問題
eq("文章が空", codes({ texts: "  " }), ["textsEmpty"]);
eq("文章の JSON が壊れている", codes({ texts: '{"input": [' }), ["textsJson"]);
eq("文章の形が違う", [codes({ texts: '{"prompt":"a"}' }), codes({ texts: "[1,2]" })], [["textsShape"], ["textsShape"]]);
eq("文章の配列が空", codes({ texts: "[]", response: '{"embeddings":[[1]]}' }), ["textsEmpty"]);
eq("NUL は入らない", run({ texts: '["a","b\\u0000"]' }).problems, [{ code: "textNul", severity: "error", index: 1 }]);
eq("応答が空", codes({ response: "" }), ["responseEmpty"]);
eq("応答の JSON が壊れている", codes({ response: "{" }), ["responseJson"]);
eq("応答の形が違う", codes({ response: '{"vectors": []}' }), ["responseShape"]);
eq("base64", run({ response: '{"data":[{"index":0,"embedding":"AAAA"},{"index":1,"embedding":[1,0]}]}' }).problems, [
  { code: "base64", severity: "error", index: 0 },
]);
eq("数でない", run({ response: '{"embeddings":[[1,0],[1,"x"]]}' }).problems, [{ code: "notNumber", severity: "error", index: 1 }]);
eq("空のベクトル", run({ response: '{"embeddings":[[1,0],[]]}' }).problems, [{ code: "emptyVector", severity: "error", index: 1 }]);
eq("ベクトルが0本", codes({ response: '{"embeddings":[]}' }), ["emptyVector"]);
eq("次元がそろわない", run({ response: '{"embeddings":[[1,0],[1,0,0]]}' }).problems, [{ code: "dimMismatch", severity: "error", detail: "2, 3" }]);
eq("数が合わない", run({ texts: '["a","b","c"]' }).problems, [{ code: "countMismatch", severity: "error", detail: "3/2" }]);
eq("表の名前", [codes({ table: "Docs" }), codes({ table: "user" })], [["table"], ["table"]]);
eq("列の名前", [codes({ textColumn: "my col" }), codes({ vectorColumn: "order" })], [["textColumn"], ["vectorColumn"]]);
eq("同じ列", codes({ vectorColumn: "content" }), ["sameColumn"]);
eq("エラーのときは SQL を出さない", run({ table: "" }).sql, "");

// 多いとき: 100行ごとに INSERT を分ける。1,000行まで
const many = (n: number) => ({
  texts: JSON.stringify(Array.from({ length: n }, (_, i) => `t${i}`)),
  response: JSON.stringify({ embeddings: Array.from({ length: n }, () => [1, 0]) }),
});
const m250 = run(many(250));
eq("250行: INSERT は3つ", (m250.sql.match(/INSERT INTO/g) ?? []).length, 3);
eq("250行: 行の数", (m250.sql.match(/^ {2}\('t\d+', '\[1,0\]'\)[,;]$/gm) ?? []).length, 250);
eq("250行: 100行目で区切る", m250.sql.includes("('t99', '[1,0]');\n\nINSERT INTO documents (content, embedding) VALUES\n  ('t100', '[1,0]'),"), true);
eq("250行: 最後", m250.sql.endsWith("('t249', '[1,0]');\n\nCOMMIT;"), true);
eq("1,000行まで", codes(many(1000)), []);
eq("1,001行は多すぎ", codes(many(1001)), ["tooMany"]);

console.log(`\n[check:pgvector-insert] ${pass} 件OK / NG ${fail}件`);
if (fail) process.exit(1);
