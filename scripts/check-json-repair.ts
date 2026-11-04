/**
 * LLM JSON Repair の検算。
 *
 * このツールは「壊れたJSONを直す」ので、危険なのは次の2つ。
 *  1. 直したつもりで値を変えてしまう(文字列の中の ", ]" を構造と取り違える、
 *     大きな整数の精度を落とす、など)
 *  2. 正しいJSONに余計な手を入れる
 * そこで、
 *  - 正しいJSONは、どんな整形でも値が変わらず、直しの件数が0であること
 *    (JSON.stringify という別の実装との突き合わせ。擬似乱数で2000通り)
 *  - 壊し方を決めて壊したものが、元の値に戻ること(同じく擬似乱数)
 *  - よくある壊れ方を、名指しで1つずつ
 * を確かめる。
 *
 * 実行: npm run check
 */
import { repairJson, type Indent, type RepairCode } from "../src/json-repair";

let pass = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

type R = ReturnType<typeof repairJson>;
const codes = (r: R) => (r.ok ? r.repairs.map((x) => x.code).sort() : []);
const value = (r: R) => (r.ok ? JSON.parse(r.json) : undefined);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 入力を直して、期待する値・直しの種類になるか。 */
function expectFix(label: string, input: string, want: unknown, wantCodes: RepairCode[]) {
  const r = repairJson(input);
  ok(`${label}: 直る`, r.ok, r.ok ? "" : JSON.stringify(r.error));
  if (!r.ok) return;
  ok(`${label}: 値`, same(value(r), want), r.json.replace(/\s+/g, " "));
  ok(`${label}: 直しの種類`, same(codes(r), [...wantCodes].sort()), codes(r).join(","));
}

// ---- 正しいJSONは手を入れない ----
for (const src of ['{"a":1}', "[1,2,3]", '{"a":{"b":[true,false,null]},"c":"x"}', "[]", "{}", '[{"k":"v, ]"}]']) {
  const r = repairJson(src);
  ok(`正しいJSONは変えない ${src}`, r.ok && r.unchanged && same(value(r), JSON.parse(src)));
}

// ---- コードフェンスと前後の文章 ----
expectFix("フェンス", '```json\n{"a":1}\n```', { a: 1 }, ["fence"]);
expectFix("言語名なしのフェンス", '```\n[1,2]\n```', [1, 2], ["fence"]);
expectFix("前後の文章", 'Here is the result:\n{"a":1}\nHope this helps!', { a: 1 }, ["prose"]);
expectFix("フェンスと前後の文章", 'Sure!\n```json\n{"a":1}\n```\nLet me know.', { a: 1 }, ["fence", "prose"]);
expectFix("フェンスの外の説明の { は読まない", 'Use {braces} like so:\n```json\n{"ok":true}\n```', { ok: true }, ["fence", "prose"]);
expectFix("閉じていないフェンス", '```json\n{"a":1}', { a: 1 }, ["fence"]);

// ---- JSONではない書き方 ----
expectFix("末尾のカンマ(オブジェクト)", '{"a":1,"b":2,}', { a: 1, b: 2 }, ["trailingComma"]);
expectFix("末尾のカンマ(配列)", "[1,2,3,]", [1, 2, 3], ["trailingComma"]);
expectFix("入れ子の末尾のカンマ", '{"a":[1,2,],"b":{"c":1,},}', { a: [1, 2], b: { c: 1 } }, ["trailingComma"]);
expectFix("行コメント", '{\n  // name\n  "a": 1\n}', { a: 1 }, ["comments"]);
expectFix("ブロックコメント", '{"a": /* one */ 1}', { a: 1 }, ["comments"]);
expectFix("文字列の中の // はコメントではない", '{"url":"https://example.com/a//b"}', { url: "https://example.com/a//b" }, []);
expectFix("シングルクォート", "{'a':'b'}", { a: "b" }, ["singleQuotes"]);
expectFix("シングルクォートの中のダブルクォート", `{'a':'say "hi"'}`, { a: 'say "hi"' }, ["singleQuotes"]);
expectFix("シングルクォートの \\'", "{'a':'it\\'s'}", { a: "it's" }, ["singleQuotes", "badEscape"]);
expectFix("曲がった引用符", "{“a”: “b”}", { a: "b" }, ["curlyQuotes"]);
expectFix("引用符なしのキー", "{a:1, b_2:2}", { a: 1, b_2: 2 }, ["unquotedKey"]);
expectFix("Pythonのリテラル", "{'a': True, 'b': False, 'c': None}", { a: true, b: false, c: null }, ["pythonLiteral", "singleQuotes"]);
expectFix("undefined", '{"a": undefined}', { a: null }, ["undefinedToNull"]);
expectFix("NaN と Infinity", '[NaN, Infinity, -Infinity]', [null, null, null], ["nonFinite"]);
expectFix("カンマ抜け(改行区切りのオブジェクト)", '{\n "a": 1\n "b": 2\n}', { a: 1, b: 2 }, ["missingComma"]);
expectFix("カンマ抜け(配列)", '[\n "a"\n "b"\n]', ["a", "b"], ["missingComma"]);
expectFix("文字列中の生の改行", '{"a":"line1\nline2"}', { a: "line1\nline2" }, ["controlChar"]);
expectFix("文字列中の生のタブ", '{"a":"x\ty"}', { a: "x\ty" }, ["controlChar"]);
expectFix("不正なエスケープ", '{"a":"\\q"}', { a: "q" }, ["badEscape"]);

// ---- 数値は文字列のまま扱う ----
{
  const r = repairJson('{"id": 12345678901234567890, "x": 1.50, "y": -0}');
  ok("大きな整数の精度を保つ", r.ok && r.json.includes("12345678901234567890"), r.ok ? r.json : "");
  ok("1.50 を 1.5 にしない(元の桁を保つ)", r.ok && r.json.includes("1.50"));
  ok("-0 を保つ", r.ok && r.json.includes("-0"));
}
{
  const r = repairJson('[+5, .5, 5., 007, 0x1F, -0x10, 1e3, 1E-2]');
  ok("数値の書き方を直す", r.ok && same(value(r), [5, 0.5, 5, 7, 31, -16, 1000, 0.01]), r.ok ? r.json.replace(/\s+/g, " ") : "");
  ok("数値の直しを報告", r.ok && codes(r).includes("numberFormat"));
}

// ---- 途中で切れた出力(情報が欠けうる)----
{
  const r = repairJson('{"items":[{"id":1},{"id":2},{"id":');
  // 値が無いキーは捨てるので、途中だった3つ目は空のオブジェクトとして残る(閉じるだけで、足さない)。
  ok("途中で切れた出力を閉じる", r.ok && same(value(r), { items: [{ id: 1 }, { id: 2 }, {}] }), r.ok ? r.json.replace(/\s+/g, " ") : JSON.stringify(r));
  ok("切れた出力は lossy と知らせる", r.ok && r.lossy && codes(r).includes("truncated"));
}
{
  const r = repairJson('{"a":"hello wor');
  ok("切れた文字列を閉じる", r.ok && same(value(r), { a: "hello wor" }));
  const r2 = repairJson('{"a":1,"b":');
  ok("値の無いキーは捨てる", r2.ok && same(value(r2), { a: 1 }));
  const r3 = repairJson('[1,2,');
  ok("途中で切れた配列", r3.ok && same(value(r3), [1, 2]) && r3.lossy);
}
{
  const r = repairJson('{"a":NaN}');
  ok("NaN → null は lossy", r.ok && r.lossy);
  const t = repairJson('{"a":1,}');
  ok("末尾のカンマだけの直しは lossy ではない", t.ok && !t.lossy);
}

// ---- 文字列の中身を構造と取り違えない ----
{
  const tricky = '{"a":"}, {\\"x\\": [1,2,]","b":"// not a comment","c":"/* nor this */"}';
  const r = repairJson(tricky);
  ok("文字列の中の記号を構造と読まない", r.ok && r.unchanged && same(value(r), JSON.parse(tricky)));
}

// ---- キーの扱い ----
{
  const r = repairJson('{"a":1,"a":2}');
  ok("重複キーは後のものを採る(JSON.parse と同じ)", r.ok && same(value(r), JSON.parse('{"a":1,"a":2}')));
  const p = repairJson('{"__proto__":{"x":1}}');
  ok("__proto__ キーを安全に扱う", p.ok && Object.prototype.hasOwnProperty.call(JSON.parse((p as { json: string }).json), "__proto__"));
  ok("__proto__ でプロトタイプを汚さない", ({} as { x?: number }).x === undefined);
}

// ---- 直せない入力は推測せず、位置つきで失敗させる ----
{
  const cases: [string, string, string][] = [
    ["空", "", "empty"],
    ["空白だけ", "   \n ", "empty"],
    ["JSONが無い", "I could not produce JSON for that.", "noJson"],
    ["値が無い", '{"a":}', "unexpectedChar"],
    ["コロンが無い", '{"a" 1}', "expectedColon"],
    ["キーの形が不正", "{1.5: 2}", "expectedColon"],
    ["キーが記号", "{@: 2}", "badKey"],
    ["省略記号", '{"a":[1,2,...]}', "placeholder"],
    ["裸の単語", "{\"a\": hello}", "badValue"],
  ];
  for (const [label, src, code] of cases) {
    const r = repairJson(src);
    ok(`直せない: ${label}`, !r.ok && r.error.message === code, r.ok ? "直ってしまった" : r.error.message);
  }
  const deep = "[".repeat(300) + "]".repeat(300);
  const r = repairJson(deep);
  ok("深すぎる入れ子は失敗で返す(スタックを溢れさせない)", !r.ok && r.error.message === "tooDeep");
  const pos = repairJson('{"a":1,\n"b": ?}');
  ok("失敗の位置を返す", !pos.ok && pos.error.position === 13, !pos.ok ? String(pos.error.position) : "");
}

// ---- 出力の整形 ----
{
  const src = '{"a":[1,{"b":2}],"c":"x"}';
  const want = JSON.parse(src);
  for (const indent of [0, 2, 4, "tab"] as Indent[]) {
    const r = repairJson(src, indent);
    ok(`整形 ${indent} で値が同じ`, r.ok && same(value(r), want));
  }
  const min = repairJson('{ "a" : [ 1 , 2 ] }', 0);
  ok("0 は最小化", min.ok && min.json === '{"a":[1,2]}', min.ok ? min.json : "");
  const two = repairJson('{"a":[1,2]}', 2);
  ok("2 は JSON.stringify(…, null, 2) と一致", two.ok && two.json === JSON.stringify({ a: [1, 2] }, null, 2));
  const four = repairJson('{"a":{"b":[]}}', 4);
  ok("4 は JSON.stringify(…, null, 4) と一致", four.ok && four.json === JSON.stringify({ a: { b: [] } }, null, 4));
  const tab = repairJson('{"a":{"b":1}}', "tab");
  ok("tab は JSON.stringify(…, null, '\\t') と一致", tab.ok && tab.json === JSON.stringify({ a: { b: 1 } }, null, "\t"));
}

// ---- 擬似乱数での突き合わせ(別実装 JSON.stringify / JSON.parse との比較)----
let seed = 20261023;
const rnd = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const STR_PARTS = ["a", "b", "key", "x y", "日本語", "😀", '"', "\\", "/", "\n", "\t", ",", "]", "}", "{", ":", "//", "/*", "'", "“", "\u0000", "é", " "];
function randStr(): string {
  let s = "";
  for (let n = Math.floor(rnd() * 5); n > 0; n--) s += pick(STR_PARTS);
  return s;
}
function randValue(depth: number): unknown {
  const r = rnd();
  if (depth <= 0 || r < 0.35) {
    return pick([() => randStr(), () => Math.floor(rnd() * 2000) - 1000, () => rnd() * 100, () => true, () => false, () => null, () => 1e21, () => 5e-7])();
  }
  if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 4) }, () => randValue(depth - 1));
  const o: Record<string, unknown> = {};
  for (let n = Math.floor(rnd() * 4); n > 0; n--) o[randStr() || "k"] = randValue(depth - 1);
  return o;
}

let cleanBad = 0;
let mutBad = 0;
let mutRepaired = 0;
for (let i = 0; i < 2000; i++) {
  const v = randValue(3);
  const ind = pick([0, 2, 4, "tab"] as Indent[]);
  const text = JSON.stringify(v, null, ind === 0 ? undefined : ind === "tab" ? "\t" : ind);
  if (typeof text !== "string" || (typeof v !== "object" || v === null)) continue; // ルートが配列・オブジェクトのものだけ
  const r = repairJson(text);
  // 1. 正しいJSONは、値が同じで、直しが0件
  if (!(r.ok && r.unchanged && same(value(r), JSON.parse(text)))) {
    cleanBad++;
    if (cleanBad <= 3) failures.push(`乱数: 正しいJSONが変わった ${text.slice(0, 80)}`);
    continue;
  }
  // 2. 壊し方: 整形済みJSONの閉じ括弧の直前に末尾カンマを足す + 前後に文章 + フェンス
  if (ind !== 0) {
    const broken = "Here you go:\n```json\n" + text.replace(/\n(\s*)([}\]])/g, ",\n$1$2") + "\n```\nDone.";
    const rb = repairJson(broken);
    mutRepaired++;
    if (!(rb.ok && same(value(rb), v))) {
      mutBad++;
      if (mutBad <= 3) failures.push(`乱数: 壊したものが元に戻らない ${broken.slice(0, 120).replace(/\n/g, "\\n")}`);
    }
  }
}
ok(`乱数 2000通り: 正しいJSONが変わらない(失敗 ${cleanBad})`, cleanBad === 0);
ok(`乱数: 末尾カンマ+フェンス+文章で壊した ${mutRepaired} 通りが元に戻る(失敗 ${mutBad})`, mutBad === 0 && mutRepaired > 500);

console.log(`\n[check:json-repair] ${pass} 件成功 / ${failures.length} 件失敗`);
if (failures.length) {
  for (const f of failures) console.error("  NG " + f);
  process.exit(1);
}
