/**
 * RAG Text Chunker の検算。
 *
 * 期待値は手で区切った結果(下のコメントに数え方)と、実装に依らない性質:
 *  - 重なりなしで区切った結果をつなぐと、元の文章に戻る
 *  - どのチャンクも上限の文字数以下
 *  - 各チャンクは、元の文章の start 文字目からの同じ長さの部分と一致する
 *  - 重なりありのとき、次のチャンクの頭は前のチャンクの末尾と同じ(重なりの文字数以下)
 * /api/embed の JSON は docs.ollama.com/api/embed の形(model・input の配列・truncate)。
 */
import { buildChunks, chunkText, singleQuote, type ChunkInput } from "../src/text-chunk";

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

const cps = (s: string) => Array.from(s);
const sliceCp = (s: string, start: number, n: number) => cps(s).slice(start, start + n).join("");

function invariants(name: string, text: string, size: number, overlap: number) {
  const chunks = chunkText(text, size, overlap);
  eq(`${name}: 上限以下`, chunks.every((c) => c.chars <= size), true);
  eq(`${name}: 文字数`, chunks.every((c) => cps(c.text).length === c.chars), true);
  eq(`${name}: 元の位置と一致`, chunks.every((c) => sliceCp(text, c.start, c.chars) === c.text), true);
  if (overlap === 0) eq(`${name}: つなぐと元に戻る`, chunks.map((c) => c.text).join(""), text);
  else {
    let ok = true;
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = chunks[i - 1].start + chunks[i - 1].chars;
      const ov = prevEnd - chunks[i].start;
      if (ov < 0 || ov > overlap) ok = false;
    }
    eq(`${name}: 重なりは0以上・上限以下`, ok, true);
    const last = chunks[chunks.length - 1];
    eq(`${name}: 最後まで届く`, last.start + last.chars, cps(text).length);
  }
  return chunks;
}

// 段落: 18 + 24 + 6 文字。上限30なら [1段落目] と [2段落目+3段落目(=30)]。
{
  const t = "First paragraph.\n\nSecond paragraph here.\n\nThird.";
  const c = chunkText(t, 30, 0);
  eq("段落で区切る", c.map((x) => x.text), ["First paragraph.\n\n", "Second paragraph here.\n\nThird."]);
  eq("段落: 位置", c.map((x) => [x.start, x.chars]), [[0, 18], [18, 30]]);
  // 重なり20: 1段落目(18)を残すと 18+24 > 30 なので残さない
  eq("段落: 重なりは上限に入る分だけ", chunkText(t, 30, 20).map((x) => x.text), ["First paragraph.\n\n", "Second paragraph here.\n\nThird."]);
}

// 区切りが無い文字列は文字で切る: 250文字・上限100 → 100, 100, 50。重なり10 → 開始 0, 90, 180(最後は70文字)。
{
  const t = "x".repeat(250);
  eq("文字で切る", chunkText(t, 100, 0).map((x) => [x.start, x.chars]), [[0, 100], [100, 100], [200, 50]]);
  eq("文字で切る+重なり", chunkText(t, 100, 10).map((x) => [x.start, x.chars]), [[0, 100], [90, 100], [180, 70]]);
}

// 文の終わり: 「3.14」や「example.com」では切らず、「. 」で切る。
{
  const t = "Pi is about 3.14 in short. See example.com for more. Done.";
  eq("文: 小数とドメインで切らない", chunkText(t, 30, 0).map((x) => x.text), ["Pi is about 3.14 in short. ", "See example.com for more. ", "Done."]);
}
// 日本語の文: 「。」で切る。6 + 7 + 5 + 8 文字。上限12 → [6] [7+5] [8]。
{
  const t = "今日は晴れ。「明日は雨。」と言った。週末は未定です。";
  eq("文: 日本語", chunkText(t, 12, 0).map((x) => x.text), ["今日は晴れ。", "「明日は雨。」と言った。", "週末は未定です。"]);
}
// 閉じかぎは前の文に付ける: 「彼は「行く。」」(7) と「と言った。次。」(7)
eq("文: 閉じかぎ", chunkText("彼は「行く。」と言った。次。", 9, 0).map((x) => x.text), ["彼は「行く。」", "と言った。次。"]);
// 行: 段落が無ければ改行で
{
  const t = "line one\nline two\nline three\n";
  eq("行で区切る", chunkText(t, 18, 0).map((x) => x.text), ["line one\nline two\n", "line three\n"]);
}
// 空白: 文も改行も無い長い語の並び
{
  const t = "alpha beta gamma delta epsilon zeta eta theta";
  eq("空白で区切る", chunkText(t, 17, 0).map((x) => x.text), ["alpha beta gamma ", "delta epsilon ", "zeta eta theta"]);
  // 重なりは部品(語)単位: "epsilon "(8文字)は重なり6に入らないので持ち越さない
  eq("空白で区切る+重なり", chunkText(t, 17, 6).map((x) => x.text), ["alpha beta gamma ", "gamma delta ", "delta epsilon ", "zeta eta theta"]);
}
// 絵文字は1文字と数える(サロゲートペアを割らない)
{
  const t = "😀".repeat(5);
  eq("絵文字", chunkText(t, 2, 0).map((x) => x.text), ["😀😀", "😀😀", "😀"]);
}
// 上限より短ければ1つ
eq("短い文章", chunkText("Hello world.", 800, 100).map((x) => x.text), ["Hello world."]);
// 空白だけのチャンクは出さない
eq("末尾の空行", chunkText("a".repeat(10) + "\n\n\n\n", 10, 0).map((x) => x.text), ["aaaaaaaaaa"]);

// 性質: 長い混在の文章
{
  const para = [
    "Embeddings turn text into numeric vectors you can store in a vector database. ",
    "埋め込みは文章を数の並びに変えます。検索に使えます。",
    "Use the same embedding model for both indexing and querying!\n",
    "ベクトルの長さはモデルで決まる(多くは384〜1024)。",
  ];
  let t = "";
  for (let i = 0; i < 60; i++) t += para[i % para.length] + (i % 5 === 4 ? "\n\n" : "");
  for (const [size, overlap] of [
    [100, 0],
    [100, 20],
    [257, 0],
    [257, 64],
    [800, 100],
    [60, 59],
  ]) {
    invariants(`混在 size=${size} overlap=${overlap}`, t, size, overlap);
  }
}

// /api/embed の JSON と curl
const base: ChunkInput = { text: "It's one. Two.", size: 50, overlap: 0, model: "embeddinggemma", base: "", truncateFalse: false };
{
  const r = buildChunks(base);
  eq("JSON", JSON.parse(r.body), { model: "embeddinggemma", input: ["It's one. Two."] });
  eq("curl", r.curl, `curl http://localhost:11434/api/embed -d '{\n  "model": "embeddinggemma",\n  "input": [\n    "It'\\''s one. Two."\n  ]\n}'`);
  eq("truncate false", JSON.parse(buildChunks({ ...base, truncateFalse: true }).body).truncate, false);
  eq("末尾の / を落とす", buildChunks({ ...base, base: "https://ollama.example.com/" }).curl.startsWith("curl https://ollama.example.com/api/embed "), true);
  eq("singleQuote", singleQuote("a'b"), `'a'\\''b'`);
}
const codes = (i: Partial<ChunkInput>) => buildChunks({ ...base, ...i }).problems.map((p) => p.code);
eq("空", codes({ text: "  " }), ["empty"]);
eq("上限が小さすぎる", codes({ size: 49 }), ["sizeRange"]);
eq("上限が大きすぎる", codes({ size: 20001 }), ["sizeRange"]);
eq("上限が整数でない", codes({ size: 100.5 }), ["sizeRange"]);
eq("重なりが負", codes({ overlap: -1 }), ["overlapRange"]);
eq("重なりが上限以上", codes({ size: 100, overlap: 100 }), ["overlapTooBig"]);
eq("モデルが無い", codes({ model: " " }), ["modelMissing"]);
eq("アドレスの形", codes({ base: "localhost:11434" }), ["baseFormat"]);
eq("エラーのときは出さない", buildChunks({ ...base, model: "" }).curl, "");

console.log(`\n[check:text-chunk] ${pass} 件OK / NG ${fail}件`);
if (fail) process.exit(1);
