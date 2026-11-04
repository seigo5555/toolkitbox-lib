/**
 * QRコードの生成。JIS X 0510 / ISO/IEC 18004 に沿った自前実装。
 *
 * 外部ライブラリを使わないのはこのサイトの方針(CDNを読まない・入力を外に出さない)
 * のためだが、QRは仕様が公開されており、必要なのは
 *   1. データをビット列にする
 *   2. リード・ソロモン符号で誤り訂正語を作る
 *   3. 決められた順路でマス目に置く
 *   4. 8通りのマスクを試して見やすいものを選ぶ
 * の4つだけなので、素直に書ける。
 *
 * 文字の入れ方はバイトモード(UTF-8)に絞った。数字だけ・英大文字だけの入力には
 * もっと詰められるモードがあるが、モードを増やすと「どのモードで作ったか」で
 * 結果が変わる。何を入れても同じ手順で作れるほうが、道具としては読みやすい。
 */

export type EcLevel = "L" | "M" | "Q" | "H";

const EC_LEVELS: EcLevel[] = ["L", "M", "Q", "H"];

/** 形式情報のビット列で使う並び。誤り訂正レベルの2ビット表現。 */
const EC_FORMAT_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

/**
 * 1ブロックあたりの誤り訂正語数。型番1〜40 × 4レベル。
 * 規格の表そのもので、計算では求まらない。
 */
const EC_CODEWORDS_PER_BLOCK: Record<EcLevel, number[]> = {
  L: [7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  M: [10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
  Q: [13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  H: [17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
};

/** ブロック数。型番1〜40 × 4レベル。こちらも規格の表。 */
const EC_BLOCKS: Record<EcLevel, number[]> = {
  L: [1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
  M: [1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
  Q: [1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
  H: [1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81],
};

/**
 * 誤り訂正やマスクを置く前の、データに使えるマス目の総数。
 * 型番から計算できる(位置合わせパターンの数だけ差し引く)ので表にしない。
 */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36; // 型番情報の2箇所
  }
  return result;
}

/** その型番・レベルで入れられるデータ語数(誤り訂正語を除いた分)。 */
function dataCodewords(version: number, ec: EcLevel): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    EC_CODEWORDS_PER_BLOCK[ec][version - 1] * EC_BLOCKS[ec][version - 1]
  );
}

// ---- GF(256) 上の演算。原始多項式は 0x11D。 ----

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** 誤り訂正語を作るための生成多項式。次数 = 訂正語数。 */
function generatorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** データ語の並びから誤り訂正語を作る(多項式の剰余)。 */
export function reedSolomon(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = generatorPoly(ecCount);
  const result = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[ecCount - 1] = 0;
    for (let i = 0; i < ecCount; i++) result[i] ^= gfMul(gen[i + 1], factor);
  }
  return result;
}

// ---- データのビット列化 ----

class BitWriter {
  readonly bits: number[] = [];
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

/** 文字数を表すのに使うビット数。型番によって変わる(バイトモード)。 */
function charCountBits(version: number): number {
  return version < 10 ? 8 : 16;
}

/**
 * 入力を入れられる最小の型番を選ぶ。
 * 大きいほど情報は入るが、その分マス目が細かくなって読み取りにくい。
 */
function chooseVersion(byteLength: number, ec: EcLevel): number | null {
  for (let version = 1; version <= 40; version++) {
    const capacity = dataCodewords(version, ec) * 8;
    const needed = 4 + charCountBits(version) + byteLength * 8;
    if (needed <= capacity) return version;
  }
  return null;
}

/** データ語の並びを作る。終端・パディングまで含む。 */
function buildData(bytes: Uint8Array, version: number, ec: EcLevel): Uint8Array {
  const writer = new BitWriter();
  writer.push(0b0100, 4); // バイトモード
  writer.push(bytes.length, charCountBits(version));
  for (const b of bytes) writer.push(b, 8);

  const capacity = dataCodewords(version, ec) * 8;
  // 終端パターン。残りが4ビット未満なら入る分だけでよい。
  writer.push(0, Math.min(4, capacity - writer.bits.length));
  // バイト境界に揃える
  while (writer.bits.length % 8 !== 0) writer.bits.push(0);

  const result = new Uint8Array(capacity / 8);
  for (let i = 0; i < writer.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | writer.bits[i + j];
    result[i / 8] = byte;
  }
  // 余りは 0xEC と 0x11 を交互に詰める(規格で決まっている)。
  for (let i = writer.bits.length / 8, alt = 0; i < result.length; i++, alt++) {
    result[i] = alt % 2 === 0 ? 0xec : 0x11;
  }
  return result;
}

/**
 * ブロックに分けて誤り訂正語を付け、規格の順に並べ直す。
 * ブロックをまたいで1語ずつ交互に取るのは、汚れが1箇所に固まったときに
 * 被害を複数ブロックへ散らすため。
 */
function interleave(data: Uint8Array, version: number, ec: EcLevel): Uint8Array {
  const numBlocks = EC_BLOCKS[ec][version - 1];
  const ecPerBlock = EC_CODEWORDS_PER_BLOCK[ec][version - 1];
  const shortBlockLen = Math.floor(data.length / numBlocks);
  const numLongBlocks = data.length % numBlocks;

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = shortBlockLen + (i >= numBlocks - numLongBlocks ? 1 : 0);
    const block = data.subarray(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(reedSolomon(block, ecPerBlock));
  }

  const result: number[] = [];
  for (let i = 0; i < shortBlockLen + 1; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return Uint8Array.from(result);
}

// ---- マス目への配置 ----

/** 位置合わせパターンの中心座標。型番7以上で複数になる。 */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
  const positions = [6];
  for (let pos = size - 7; positions.length < count; pos -= step) positions.unshift(pos);
  return positions;
}

type Grid = { size: number; modules: boolean[][]; reserved: boolean[][] };

function newGrid(version: number): Grid {
  const size = version * 4 + 17;
  const make = () => Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  return { size, modules: make(), reserved: make() };
}

function setModule(grid: Grid, x: number, y: number, dark: boolean): void {
  grid.modules[y][x] = dark;
  grid.reserved[y][x] = true;
}

/** 切り出しシンボル(3隅の四角)と、その周りの区切り。 */
function drawFinder(grid: Grid, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      setModule(grid, x, y, d !== 2 && d <= 3);
    }
  }
}

function drawFunctionPatterns(grid: Grid, version: number): void {
  // タイミングパターン。読み取り側がマスの間隔を測るための目盛り。
  for (let i = 0; i < grid.size; i++) {
    setModule(grid, 6, i, i % 2 === 0);
    setModule(grid, i, 6, i % 2 === 0);
  }

  drawFinder(grid, 3, 3);
  drawFinder(grid, grid.size - 4, 3);
  drawFinder(grid, 3, grid.size - 4);

  const positions = alignmentPositions(version);
  for (const y of positions) {
    for (const x of positions) {
      // 切り出しシンボルと重なる3隅には置かない。
      const corner =
        (x === 6 && y === 6) ||
        (x === 6 && y === grid.size - 7) ||
        (x === grid.size - 7 && y === 6);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setModule(grid, x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // 形式情報の置き場所を先に押さえる(中身は後で入れる)。
  //
  // 押さえる範囲を1マスでも間違えると、データの置き場所が全部ずれて読めなくなる。
  // 気をつける点が2つある。6行目・6列目はタイミングパターンなので飛ばすこと。
  // 右上と左下は8マスずつで、9マス目はデータ領域だということ。
  for (let i = 0; i <= 8; i++) {
    if (i === 6) continue;
    setModule(grid, 8, i, false);
    setModule(grid, i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    setModule(grid, grid.size - 1 - i, 8, false);
    setModule(grid, 8, grid.size - 1 - i, false);
  }
  // 常に黒いマス。規格でそう決まっている。
  setModule(grid, 8, grid.size - 8, true);

  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const x = i % 3;
      const y = Math.floor(i / 3);
      setModule(grid, grid.size - 11 + x, y, false);
      setModule(grid, y, grid.size - 11 + x, false);
    }
  }
}

/** BCH符号。形式情報と型番情報の誤り検出に使う。 */
function bch(value: number, generator: number, dataBits: number, totalBits: number): number {
  let rest = value << (totalBits - dataBits);
  for (let i = dataBits - 1; i >= 0; i--) {
    if (rest >>> (totalBits - dataBits + i) & 1) rest ^= generator << i;
  }
  return (value << (totalBits - dataBits)) | rest;
}

function drawFormatInfo(grid: Grid, ec: EcLevel, mask: number): void {
  const data = (EC_FORMAT_BITS[ec] << 3) | mask;
  const bits = bch(data, 0b10100110111, 5, 15) ^ 0b101010000010010;
  const get = (i: number) => ((bits >>> i) & 1) === 1;

  for (let i = 0; i <= 5; i++) setModule(grid, 8, i, get(i));
  setModule(grid, 8, 7, get(6));
  setModule(grid, 8, 8, get(7));
  setModule(grid, 7, 8, get(8));
  for (let i = 9; i < 15; i++) setModule(grid, 14 - i, 8, get(i));

  for (let i = 0; i < 8; i++) setModule(grid, grid.size - 1 - i, 8, get(i));
  for (let i = 8; i < 15; i++) setModule(grid, 8, grid.size - 15 + i, get(i));
  setModule(grid, 8, grid.size - 8, true);
}

function drawVersionInfo(grid: Grid, version: number): void {
  if (version < 7) return;
  const bits = bch(version, 0b1111100100101, 6, 18);
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) === 1;
    const x = i % 3;
    const y = Math.floor(i / 3);
    setModule(grid, grid.size - 11 + x, y, bit);
    setModule(grid, y, grid.size - 11 + x, bit);
  }
}

/** データを右下から蛇行させながら置く。縦2列ずつ、上下を交互に。 */
function placeData(grid: Grid, codewords: Uint8Array): void {
  let bitIndex = 0;
  for (let right = grid.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 縦のタイミングパターンは飛ばす
    for (let vert = 0; vert < grid.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? grid.size - 1 - vert : vert;
        if (grid.reserved[y][x]) continue;
        const bit =
          bitIndex < codewords.length * 8 &&
          ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
        grid.modules[y][x] = bit;
        bitIndex++;
      }
    }
  }
}

/** マスクの式。0〜7の8通り。 */
function maskAt(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(grid: Grid, mask: number): void {
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      if (!grid.reserved[y][x] && maskAt(mask, x, y)) grid.modules[y][x] = !grid.modules[y][x];
    }
  }
}

/**
 * マスクの良し悪しを点数にする。小さいほど良い。
 * 同じ色が続く・2x2の塊・切り出しシンボルに似た並び・白黒の偏りを減点する。
 * 読み取り機が迷いにくい模様を選ぶための仕組み。
 */
function penalty(grid: Grid): number {
  const { size, modules } = grid;
  let score = 0;

  // 規則1: 同じ色が5つ以上続く
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let runColor = false;
      let runLength = 0;
      for (let j = 0; j < size; j++) {
        const color = horizontal ? modules[i][j] : modules[j][i];
        if (color === runColor) {
          runLength++;
          if (runLength === 5) score += 3;
          else if (runLength > 5) score += 1;
        } else {
          runColor = color;
          runLength = 1;
        }
      }
    }
  }

  // 規則2: 同じ色の2x2
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        score += 3;
      }
    }
  }

  // 規則3: 切り出しシンボルに似た 1:1:3:1:1 の並び
  const pattern = [true, false, true, true, true, false, true];
  const matches = (get: (k: number) => boolean, start: number): boolean =>
    pattern.every((p, k) => get(start + k) === p);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 7 <= size; j++) {
      for (const horizontal of [true, false]) {
        const get = (k: number) => (horizontal ? modules[i][k] : modules[k][i]);
        if (!matches(get, j)) continue;
        // 前後どちらかに白が4つ続いていれば減点
        const before = Array.from({ length: 4 }, (_, k) => j - 1 - k).every(
          (k) => k < 0 || !get(k),
        );
        const after = Array.from({ length: 4 }, (_, k) => j + 7 + k).every(
          (k) => k >= size || !get(k),
        );
        if (before || after) score += 40;
      }
    }
  }

  // 規則4: 白黒の偏り
  let dark = 0;
  for (const row of modules) for (const c of row) if (c) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

export type QrCode = {
  /** true が黒。[y][x] で引く。 */
  modules: boolean[][];
  size: number;
  version: number;
  ec: EcLevel;
  mask: number;
};

/**
 * QRコードを作る。入りきらなければ null。
 * マスクは8通り全部作って、点数の一番低いものを選ぶ。
 */
export function makeQr(text: string, ec: EcLevel = "M"): QrCode | null {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length, ec);
  if (version === null) return null;

  const codewords = interleave(buildData(bytes, version, ec), version, ec);

  let best: { grid: Grid; mask: number; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = newGrid(version);
    drawFunctionPatterns(grid, version);
    drawVersionInfo(grid, version);
    placeData(grid, codewords);
    applyMask(grid, mask);
    drawFormatInfo(grid, ec, mask);
    const score = penalty(grid);
    if (!best || score < best.score) best = { grid, mask, score };
  }

  return { modules: best!.grid.modules, size: best!.grid.size, version, ec, mask: best!.mask };
}

/** その誤り訂正レベルで入れられる最大バイト数。 */
export function maxBytes(ec: EcLevel): number {
  return dataCodewords(40, ec) - 3; // モード4ビット + 文字数16ビット の分
}

export { EC_LEVELS };

/** SVGにする。拡大しても粗くならないので、印刷にもそのまま使える。 */
export function toSvg(qr: QrCode, margin = 4): string {
  const size = qr.size + margin * 2;
  const path: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) path.push(`M${x + margin},${y + margin}h1v1h-1z`);
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`,
    `<rect width="${size}" height="${size}" fill="#ffffff"/>`,
    `<path d="${path.join("")}" fill="#000000"/>`,
    `</svg>`,
  ].join("");
}
