/**
 * QRコードの実装の検算。
 *
 * リポジトリで唯一のテストらしいテスト。QRは規格に沿って組み立てるだけで
 * 動いているように見えてしまい、1マスずれていても画面上は「それらしい絵」が
 * 出る。実際、形式情報の予約範囲を1マス多く取っていた不具合はここで見つけた。
 *
 * 確かめているのは4つ:
 *   1. 誤り訂正語が、生成多項式の根すべてで0になること(符号語の条件そのもの)
 *   2. 切り出しシンボル・タイミングパターン・常に黒いマスの位置
 *   3. 形式情報がBCH(15,5)で割り切れること
 *   4. 各レベルの容量の境目(上限は入り、上限+1は入らない)
 *
 * これに加えて、実装したときはブラウザの BarcodeDetector で実際に読み取れる
 * ことを確認している(型番2〜13・4レベル・日本語・URLの6件)。
 *
 * 実行: npm run check
 */
import { makeQr, reedSolomon, toSvg, EC_LEVELS, maxBytes } from "../src/qr";

let bad = 0;
const ok = (cond: boolean, label: string) => { if (!cond) bad++; console.log((cond ? "OK " : "NG ") + label); };

// --- GF(256) を独立に組み直して、誤り訂正語が符号語の条件を満たすか見る ---
// 正しいリード・ソロモン符号語は、生成多項式の根 α^0..α^(n-1) で必ず0になる。
// これは実装とは別の性質なので、剰余計算が合っているかの独立した確認になる。
const exp: number[] = [];
{ let x = 1; for (let i = 0; i < 255; i++) { exp.push(x); x <<= 1; if (x & 0x100) x ^= 0x11d; } }
const log = new Array(256).fill(0);
exp.forEach((v, i) => { log[v] = i; });
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : exp[(log[a] + log[b]) % 255]);

for (const ecCount of [7, 10, 17, 26, 30]) {
  const data = Uint8Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 0xff);
  const parity = reedSolomon(data, ecCount);
  const codeword = [...data, ...parity];
  let allZero = true;
  for (let r = 0; r < ecCount; r++) {
    const root = exp[r];
    let acc = 0;
    for (const c of codeword) acc = mul(acc, root) ^ c;   // ホーナー法で評価
    if (acc !== 0) allZero = false;
  }
  ok(allZero, `誤り訂正語 ${ecCount} 個: 生成多項式の根すべてで 0 になる`);
}

// --- 構造の確認 ---
const qr = makeQr("https://toolkitbox.net", "M")!;
ok(qr.size === qr.version * 4 + 17, `大きさ ${qr.size} が型番 ${qr.version} と合う`);
const finderOk = [[0, 0], [qr.size - 7, 0], [0, qr.size - 7]].every(([ox, oy]) => {
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
    const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
    if (qr.modules[oy + y][ox + x] !== (d !== 2 && d <= 3)) return false;
  }
  return true;
});
ok(finderOk, "3隅の切り出しシンボルが正しい");
let timingOk = true;
for (let i = 8; i <= qr.size - 9; i++) {
  if (qr.modules[6][i] !== (i % 2 === 0) || qr.modules[i][6] !== (i % 2 === 0)) timingOk = false;
}
ok(timingOk, "タイミングパターンが交互になっている");
ok(qr.modules[qr.size - 8][8] === true, "常に黒いマスが黒い");

// --- 形式情報が BCH の条件を満たすか(生成多項式で割り切れる) ---
let bchOk = true;
for (const ec of EC_LEVELS) {
  for (let mask = 0; mask < 8; mask++) {
    const q = makeQr("test", ec)!;
    if (q.mask !== mask) continue;
    let bits = 0;
    for (let i = 0; i <= 5; i++) bits |= (q.modules[i][8] ? 1 : 0) << i;
    bits |= (q.modules[7][8] ? 1 : 0) << 6;
    bits |= (q.modules[8][8] ? 1 : 0) << 7;
    bits |= (q.modules[8][7] ? 1 : 0) << 8;
    for (let i = 9; i < 15; i++) bits |= (q.modules[8][14 - i] ? 1 : 0) << i;
    let rest = bits ^ 0b101010000010010;
    for (let i = 14; i >= 10; i--) if ((rest >>> i) & 1) rest ^= 0b10100110111 << (i - 10);
    if (rest !== 0) bchOk = false;
  }
}
ok(bchOk, "形式情報が BCH(15,5) で割り切れる");

// --- 容量の境目 ---
for (const ec of EC_LEVELS) {
  const max = maxBytes(ec);
  ok(makeQr("a".repeat(max), ec) !== null, `${ec}: 上限 ${max} バイトは入る`);
  ok(makeQr("a".repeat(max + 1), ec) === null, `${ec}: 上限+1 は入らない`);
}

// --- 型番が上がっていくこと ---
const versions = [10, 100, 500, 1000, 2000].map((n) => makeQr("a".repeat(n), "M")?.version);
console.log("   長さ 10/100/500/1000/2000 の型番:", versions.join(" / "));
ok(versions.every((v, i) => i === 0 || (v! >= versions[i - 1]!)), "長い入力ほど型番が大きい");

// --- SVG ---
const svg = toSvg(qr);
ok(svg.startsWith("<svg") && svg.includes("viewBox") && svg.endsWith("</svg>"), "SVGが出る");

console.log(bad === 0 ? "全て一致" : `失敗 ${bad} 件`);
