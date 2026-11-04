/**
 * IPv6アドレスの展開・短縮と分類。
 *
 * 同じアドレスに何通りもの書き方があるのがIPv6の面倒なところで、
 * 2001:0db8:0000:0000:0000:ff00:0042:8329 と 2001:db8::ff00:42:8329 は同じものを指す。
 * 設定ファイルとログで書き方が違うだけで「別のアドレスだ」と誤解する。
 *
 * 短縮の書き方は RFC 5952 が1つに定めている。要点は3つ。
 *   - 0が2つ以上続くところだけを :: にする(1つだけの 0 は縮めない)
 *   - 続く長さが同じなら左側を縮める
 *   - 16進は小文字、先頭の0は書かない
 * この規則どおりに出すので、2つのアドレスを見比べるときの基準にできる。
 */

export type Ipv6 = {
  /** 16ビットずつ8つ。 */
  groups: number[];
  /** /64 のような接頭辞長。無ければ null。 */
  prefix: number | null;
  /** fe80::1%eth0 の eth0 の部分。無ければ null。 */
  zone: string | null;
};

const HEX = /^[0-9a-fA-F]{1,4}$/;

/** 末尾がIPv4表記(::ffff:192.0.2.1)なら、16ビット2つに直す。 */
function parseEmbeddedIpv4(part: string): number[] | null {
  const octets = part.split(".");
  if (octets.length !== 4) return null;
  const values: number[] = [];
  for (const o of octets) {
    if (!/^\d{1,3}$/.test(o)) return null;
    const n = Number(o);
    if (n > 255) return null;
    values.push(n);
  }
  return [(values[0] << 8) | values[1], (values[2] << 8) | values[3]];
}

/**
 * どの書き方でも受ける。[::1]:8080 のような角括弧付き、/64 の接頭辞、
 * %eth0 のゾーンも剥がして解釈する。ログやURLからそのまま貼れるようにするため。
 */
export function parseIpv6(input: string): Ipv6 | null {
  let text = input.trim();
  if (text === "") return null;

  // URLの形 [2001:db8::1]:443 から中身を取り出す。
  const bracket = text.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) text = bracket[1];

  let prefix: number | null = null;
  const slash = text.indexOf("/");
  if (slash >= 0) {
    const raw = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(raw)) return null;
    prefix = Number(raw);
    if (prefix > 128) return null;
    text = text.slice(0, slash);
  }

  let zone: string | null = null;
  const percent = text.indexOf("%");
  if (percent >= 0) {
    zone = text.slice(percent + 1);
    // "fe80::1%" のように % だけ残っているのは、貼り付けが途中で切れた形。
    // 黙って通すと、切れていることに気付けない。
    if (zone === "") return null;
    text = text.slice(0, percent);
  }

  const doubleColon = text.indexOf("::");
  if (doubleColon !== text.lastIndexOf("::")) return null; // :: は1回だけ

  const expandSide = (side: string): number[] | null => {
    if (side === "") return [];
    const parts = side.split(":");
    const groups: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.includes(".")) {
        // IPv4表記は末尾にしか置けない。
        if (i !== parts.length - 1) return null;
        const embedded = parseEmbeddedIpv4(part);
        if (!embedded) return null;
        groups.push(...embedded);
        continue;
      }
      if (!HEX.test(part)) return null;
      groups.push(parseInt(part, 16));
    }
    return groups;
  };

  let groups: number[];
  if (doubleColon >= 0) {
    const head = expandSide(text.slice(0, doubleColon));
    const tail = expandSide(text.slice(doubleColon + 2));
    if (!head || !tail) return null;
    const missing = 8 - head.length - tail.length;
    // :: は「1つ以上の0の並び」を表す。埋める余地が無ければ誤り。
    if (missing < 1) return null;
    groups = [...head, ...new Array(missing).fill(0), ...tail];
  } else {
    const all = expandSide(text);
    if (!all || all.length !== 8) return null;
    groups = all;
  }

  return { groups, prefix, zone };
}

/** 省略なしの表記。すべて4桁で揃える。 */
export function expand(groups: number[]): string {
  return groups.map((g) => g.toString(16).padStart(4, "0")).join(":");
}

/**
 * RFC 5952 の短縮表記。
 * 0が2つ以上続く最長の並びを1箇所だけ :: にする。同じ長さなら左を優先。
 */
export function compress(groups: number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === 0) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const length = i - start;
      // 「より長いとき」だけ更新する。同点なら先に見つけた左側が残る。
      if (length > bestLength) {
        bestStart = start;
        bestLength = length;
      }
      start = -1;
    }
  }

  const hex = groups.map((g) => g.toString(16));
  if (bestLength < 2) return hex.join(":");

  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

export type Ipv6Kind =
  | "unspecified"
  | "loopback"
  | "ipv4-mapped"
  | "nat64"
  | "discard"
  | "documentation"
  | "6to4"
  | "unique-local"
  | "link-local"
  | "multicast"
  | "global"
  | "reserved";

/** 先頭のビットを見て用途を決める。上から順に、狭い範囲から判定する。 */
export function classifyIpv6(groups: number[]): Ipv6Kind {
  const isZero = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  const [g0, g1, g2, g3, g4, g5] = groups;

  if (isZero(0, 8)) return "unspecified";
  if (isZero(0, 7) && g0 === 0 && groups[7] === 1) return "loopback";
  if (isZero(0, 5) && g5 === 0xffff) return "ipv4-mapped";
  if (g0 === 0x0064 && g1 === 0xff9b && isZero(2, 6)) return "nat64";
  if (g0 === 0x0100 && isZero(1, 4)) return "discard";
  if (g0 === 0x2001 && g1 === 0x0db8) return "documentation";
  if (g0 === 0x2002) return "6to4";
  if ((g0 & 0xfe00) === 0xfc00) return "unique-local"; // fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
  if ((g0 & 0xff00) === 0xff00) return "multicast"; // ff00::/8
  if ((g0 & 0xe000) === 0x2000) return "global"; // 2000::/3
  void g2; void g3; void g4;
  return "reserved";
}

/** ::ffff:192.0.2.1 のように末尾にIPv4が入っている場合、その点区切り表記。 */
export function embeddedIpv4(groups: number[]): string | null {
  if (classifyIpv6(groups) !== "ipv4-mapped") return null;
  const [a, b] = [groups[6], groups[7]];
  return [a >> 8, a & 255, b >> 8, b & 255].join(".");
}

/** 逆引きに使う ip6.arpa の名前。1文字ずつ逆から並べる。 */
export function reverseDnsName(groups: number[]): string {
  const nibbles = expand(groups).replace(/:/g, "").split("").reverse();
  return `${nibbles.join(".")}.ip6.arpa`;
}

/** 接頭辞に含まれる最初と最後のアドレス。 */
export function prefixRange(groups: number[], prefix: number): { first: number[]; last: number[] } {
  const first = [...groups];
  const last = [...groups];
  for (let i = 0; i < 8; i++) {
    const bitsBefore = i * 16;
    if (prefix >= bitsBefore + 16) continue; // この16ビットは全部固定
    if (prefix <= bitsBefore) {
      first[i] = 0;
      last[i] = 0xffff;
      continue;
    }
    const hostBits = bitsBefore + 16 - prefix;
    const mask = (0xffff << hostBits) & 0xffff;
    first[i] = groups[i] & mask;
    last[i] = (groups[i] & mask) | (0xffff >> (16 - hostBits));
  }
  return { first, last };
}
