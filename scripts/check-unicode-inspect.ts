/**
 * Unicode 分解の検算。
 *
 * 「人が数える文字数」と「.length」がずれるのは仕様どおりだが、
 * どちらの数え方も間違えると使い物にならない。既知の値で確かめる。
 */
import { countAll, inspect, normalizations, splitGraphemes, utf8Length, warningsFor } from "../src/unicode-inspect";
import { BLOCK_NAMES, GLOSSES, WARNING_MESSAGES, warningText } from "../src/unicode-inspect-messages";
import { LOCALES } from "../src/locales";

let pass = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

// ---- UTF-8 のバイト数 ----
const utf8: [number, number][] = [
  [0x41, 1],      // A
  [0x7f, 1],
  [0x80, 2],
  [0xe9, 2],      // é
  [0x7ff, 2],
  [0x800, 3],
  [0x3042, 3],    // あ
  [0xffff, 3],
  [0x10000, 4],
  [0x1f600, 4],   // 😀
];
for (const [cp, want] of utf8) {
  ok(`U+${cp.toString(16).toUpperCase()} は ${want} バイト`, utf8Length(cp) === want, String(utf8Length(cp)));
}

// ---- 数え方 ----
{
  const c = countAll("abc");
  ok("ASCII: 3文字/3コードポイント/3単位/3バイト", c.graphemes === 3 && c.codePoints === 3 && c.utf16Units === 3 && c.utf8Bytes === 3, JSON.stringify(c));
}
{
  const c = countAll("あいう");
  ok("ひらがな3文字は9バイト", c.graphemes === 3 && c.utf16Units === 3 && c.utf8Bytes === 9, JSON.stringify(c));
}
{
  // **サロゲートペア。** JavaScript の .length は 2 になる。
  const c = countAll("😀");
  ok("絵文字1つは .length が 2", c.utf16Units === 2, JSON.stringify(c));
  ok("絵文字1つは1文字", c.graphemes === 1, JSON.stringify(c));
  ok("絵文字1つは4バイト", c.utf8Bytes === 4, JSON.stringify(c));
}
{
  // **ZWJ結合。** 見た目は1文字だが中身は7コードポイント、.length は 11。
  const family = "👨‍👩‍👧‍👦";
  const c = countAll(family);
  ok("家族の絵文字は人が見て1文字", c.graphemes === 1, JSON.stringify(c));
  ok("中身は7コードポイント", c.codePoints === 7, String(c.codePoints));
  ok(".length は 11", c.utf16Units === 11, String(c.utf16Units));
}
{
  // 国旗は地域表示記号2つ
  const c = countAll("🇯🇵");
  ok("国旗は1文字だが2コードポイント", c.graphemes === 1 && c.codePoints === 2, JSON.stringify(c));
}
{
  // 結合文字。「が」を「か」＋濁点で書いた形
  const c = countAll("が");
  ok("結合濁点付きは1文字/2コードポイント", c.graphemes === 1 && c.codePoints === 2, JSON.stringify(c));
}

// ---- 分解 ----
{
  const info = inspect("A😀");
  ok("2つに割れる", info.length === 2, String(info.length));
  ok("Aのコードポイントが正しい", info[0].codePoints[0].hex === "U+0041", info[0].codePoints[0].hex);
  ok("絵文字のコードポイントが正しい", info[1].codePoints[0].hex === "U+1F600", info[1].codePoints[0].hex);
  ok("絵文字はUTF-16で2単位", info[1].codePoints[0].utf16Units === 2);
}
{
  const info = inspect("​");
  ok("ゼロ幅スペースを見えない文字と判定", info[0].codePoints[0].invisible === true);
  ok("正式名が出る", info[0].codePoints[0].name === "ZERO WIDTH SPACE", String(info[0].codePoints[0].name));
  ok("説明が付く", info[0].codePoints[0].gloss === "zwsp");
}
{
  const info = inspect("あ");
  ok("ひらがなと判定する", info[0].codePoints[0].block === "hiragana", String(info[0].codePoints[0].block));
  ok("見える文字は invisible ではない", info[0].codePoints[0].invisible === false);
}
{
  ok("キリル文字を見分ける", inspect("а")[0].codePoints[0].block === "cyrillic");
  ok("ラテン文字と区別する", inspect("a")[0].codePoints[0].block === "ascii");
  ok("国旗は地域表示記号", inspect("🇯🇵")[0].codePoints[0].block === "regionalIndicator");
}
{
  ok("空文字で落ちない", inspect("").length === 0);
  ok("空文字の集計も0", countAll("").graphemes === 0);
}

// ---- 正規化 ----
{
  const n = normalizations("が"); // NFC の1文字
  const nfc = n.find((x) => x.form === "NFC")!;
  const nfd = n.find((x) => x.form === "NFD")!;
  ok("NFCでは変わらない", nfc.same === true);
  ok("NFDでは2コードポイントになる", nfd.counts.codePoints === 2, String(nfd.counts.codePoints));
  ok("NFDは元と違う", nfd.same === false);
}
{
  // **NFKCは見た目を変える。** 原文の保存に使ってはいけないことを示す例。
  const n = normalizations("ﬁ");
  const nfkc = n.find((x) => x.form === "NFKC")!;
  ok("NFKCは合字をばらす", nfkc.result === "fi", nfkc.result);
}
{
  const n = normalizations("㈱");
  const nfkc = n.find((x) => x.form === "NFKC")!;
  ok("NFKCは ㈱ を (株) にする", nfkc.result === "(株)", nfkc.result);
}
{
  const n = normalizations("ＡＢ１");
  const nfkc = n.find((x) => x.form === "NFKC")!;
  ok("NFKCは全角英数を半角にする", nfkc.result === "AB1", nfkc.result);
}
{
  ok("4つの形すべてを返す", normalizations("a").length === 4);
}

// ---- 注意書き ----
const warnKinds = (t: string) => warningsFor(t).map((w) => w.kind);
ok("ゼロ幅文字を指摘", warnKinds("a​b").includes("zero-width"));
ok("BOMを指摘", warnKinds("﻿{}").includes("bom"));
ok("U+FFFD を指摘", warnKinds("a�b").includes("replacement"));
ok("表示順の制御文字を指摘", warnKinds("a‮b").includes("bidi"));
ok("改行しない空白を指摘", warnKinds("a b").includes("nbsp"));
ok("全角スペースを指摘", warnKinds("a　b").includes("ideographic-space"));
ok("ラテンとキリルの混在を指摘", warnKinds("pаypal").includes("mixed-script"));
ok("ラテンだけなら混在と言わない", !warnKinds("paypal").includes("mixed-script"));
ok("NFCでないことを指摘", warnKinds("が").includes("not-nfc"));
ok("NFCなら指摘しない", !warnKinds("が").includes("not-nfc"));
ok("普通の文字列では何も指摘しない", warningsFor("Hello, 世界").length === 0, JSON.stringify(warningsFor("Hello, 世界")));
ok("ゼロ幅文字の個数を数える", warningsFor("a\u200bb\u200bc").find((w) => w.kind === "zero-width")?.count === 2);

// ---- 文面(14言語) ----
// 以前は注意書きと範囲の名前が日本語の直書きで、どの言語のページでも日本語が出ていた。
for (const [name, table] of [["範囲の名前", BLOCK_NAMES], ["説明", GLOSSES], ["注意書き", WARNING_MESSAGES]] as const) {
  for (const [code, byLocale] of Object.entries(table as Record<string, Record<string, string>>)) {
    for (const { code: l } of LOCALES) {
      const v = byLocale[l];
      ok(`${name} ${code}/${l} がある`, typeof v === "string" && v.trim() !== "");
      if (l !== "ja" && l !== "zh-tw" && l !== "ko") ok(`${name} ${code}/${l} に日本語が混ざらない`, !/[\u3040-\u30ff\u4e00-\u9fff]/.test(v));
    }
  }
}
for (const { code: l } of LOCALES) {
  const t = warningText({ kind: "zero-width", count: 3 }, l);
  ok(`注意書きの個数が埋まる(${l})`, t.includes("3") && !t.includes("{count}"), t);
}

// ---- 書記素の分割 ----
{
  ok("結合絵文字をばらさない", splitGraphemes("👨‍👩‍👧‍👦").length === 1);
  ok("国旗をばらさない", splitGraphemes("🇯🇵🇺🇸").length === 2, String(splitGraphemes("🇯🇵🇺🇸").length));
  ok("普通の文字列を1文字ずつ割る", splitGraphemes("abc").length === 3);
}

console.log(`\n[check:unicode-inspect] ${pass} 件成功 / ${failures.length} 件失敗`);
if (failures.length) {
  for (const f of failures) console.error("  NG " + f);
  process.exit(1);
}
