/**
 * IPv6の展開・短縮の検算。
 *
 * 短縮の書き方は RFC 5952 が1つに定めているが、規則を1つ落としても
 * 「それらしいアドレス」が出てしまう。特に「同じ長さなら左を縮める」と
 * 「0が1つだけなら縮めない」は落としても気付きにくい。
 * 規格の例をそのまま置いておく。
 *
 * 実行: npm run check
 */
import { parseIpv6, expand, compress, classifyIpv6, embeddedIpv4, reverseDnsName, prefixRange } from "../src/ipv6";

let bad = 0;
const eq = (label: string, got: string, want: string) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok ? "OK " : "NG ") + label.padEnd(46) + got + (ok ? "" : `   期待: ${want}`));
};
const g = (s: string) => parseIpv6(s)!.groups;

// 展開と短縮
eq("展開", expand(g("2001:db8::ff00:42:8329")), "2001:0db8:0000:0000:0000:ff00:0042:8329");
eq("短縮", compress(g("2001:0db8:0000:0000:0000:ff00:0042:8329")), "2001:db8::ff00:42:8329");
eq("短縮(ループバック)", compress(g("0000:0000:0000:0000:0000:0000:0000:0001")), "::1");
eq("短縮(全部0)", compress(g("0000:0000:0000:0000:0000:0000:0000:0000")), "::");

// RFC 5952 の要点
eq("0が1つだけなら縮めない", compress(g("2001:db8:0:1:1:1:1:1")), "2001:db8:0:1:1:1:1:1");
eq("同じ長さなら左を縮める", compress(g("2001:db8:0:0:1:0:0:1")), "2001:db8::1:0:0:1");
eq("長いほうを縮める", compress(g("2001:0:0:1:0:0:0:1")), "2001:0:0:1::1");
eq("先頭の0は書かない", compress(g("2001:0db8:0000:0000:0000:0000:0000:0001")), "2001:db8::1");
eq("16進は小文字", compress(g("2001:DB8::AB")), "2001:db8::ab");

// 往復
for (const a of ["2001:db8::1", "fe80::1", "::", "::1", "ff02::1", "2001:db8:0:1:1:1:1:1", "2001:db8::ff00:42:8329"]) {
  eq(`往復 ${a}`, compress(g(expand(g(a)))), a);
}

// いろいろな書き方
eq("角括弧とポート", compress(g("[2001:db8::1]:8080")), "2001:db8::1");
eq("ゾーン付き", compress(g("fe80::1%eth0")), "fe80::1");
eq("  ゾーンを保つ", String(parseIpv6("fe80::1%eth0")!.zone), "eth0");
eq("接頭辞付き", String(parseIpv6("2001:db8::/32")!.prefix), "32");
eq("IPv4混在", compress(g("::ffff:192.0.2.1")), "::ffff:c000:201");
eq("  IPv4として読む", String(embeddedIpv4(g("::ffff:192.0.2.1"))), "192.0.2.1");

// 受け付けてはいけないもの
const invalid = ["", "2001:db8", "2001:db8::1::2", "2001:db8:::1", "gggg::1", "2001:db8::1/129",
                 "1:2:3:4:5:6:7:8:9", "::ffff:999.1.1.1", "2001:db8::1%", "12345::1"];
for (const s of invalid) {
  const r = parseIpv6(s);
  if (r !== null) { console.log("NG 通ってはいけない:", JSON.stringify(s), compress(r.groups)); bad++; }
}
console.log(`   不正な入力 ${invalid.length} 件はすべて弾いた`);

// 分類
const kinds: [string, string][] = [
  ["::", "unspecified"], ["::1", "loopback"], ["::ffff:192.0.2.1", "ipv4-mapped"],
  ["64:ff9b::192.0.2.1", "nat64"], ["100::1", "discard"], ["2001:db8::1", "documentation"],
  ["2002::1", "6to4"], ["fd00::1", "unique-local"], ["fc00::1", "unique-local"],
  ["fe80::1", "link-local"], ["ff02::1", "multicast"], ["2400:cb00::1", "global"], ["4000::1", "reserved"],
];
for (const [addr, kind] of kinds) eq(`分類 ${addr}`, classifyIpv6(g(addr)), kind);

// 逆引き
eq("逆引き ::1", reverseDnsName(g("::1")),
   "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa");

// 接頭辞の範囲
const r = prefixRange(g("2001:db8:abcd:1234::1"), 64);
eq("/64 の最初", compress(r.first), "2001:db8:abcd:1234::");
eq("/64 の最後", compress(r.last), "2001:db8:abcd:1234:ffff:ffff:ffff:ffff");
const r48 = prefixRange(g("2001:db8:abcd:1234::1"), 48);
eq("/48 の最初", compress(r48.first), "2001:db8:abcd::");
eq("/48 の最後", compress(r48.last), "2001:db8:abcd:ffff:ffff:ffff:ffff:ffff");
const r127 = prefixRange(g("2001:db8::1"), 127);
eq("/127 の最初", compress(r127.first), "2001:db8::");
eq("/127 の最後", compress(r127.last), "2001:db8::1");
const r0 = prefixRange(g("2001:db8::1"), 0);
eq("/0 の最初", compress(r0.first), "::");
eq("/128 は1つだけ", compress(prefixRange(g("2001:db8::1"), 128).last), "2001:db8::1");

console.log(bad === 0 ? "全て一致" : `失敗 ${bad} 件`);
if (bad > 0) process.exitCode = 1;
