/**
 * robots.txt の判定の検算。
 *
 * 期待値は RFC 9309 と、Googleが公開している robots.txt の仕様書に載っている
 * 例をそのまま使う。**思い込みで書かない。** ここを間違えると
 * 「ブロックしたつもりが素通り」「公開したつもりが除外」になり、
 * どちらも本人には見えない形で起きる。
 */
import { isAllowed, matchPattern, parseRobots, selectGroup } from "../src/robots-txt";
import { ROBOTS_REASONS, ROBOTS_WARNINGS, reasonText, warningText } from "../src/robots-txt-messages";
import { LOCALES } from "../src/locales";

let pass = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

// ---- パターン照合(Googleの仕様書の例) ----
const patternCases: [string, string, boolean][] = [
  ["/fish", "/fish", true],
  ["/fish", "/fish.html", true],
  ["/fish", "/fish/salmon.htm", true],
  ["/fish", "/fishheads", true],
  ["/fish", "/fishheads/yummy.html", true],
  ["/fish", "/fish.php?id=anything", true],
  ["/fish", "/Fish.asp", false], // 大文字小文字は区別する
  ["/fish", "/catfish", false],
  ["/fish", "/?id=fish", false],
  ["/fish", "/desert/fish", false],

  ["/fish*", "/fish", true],
  ["/fish*", "/fishheads", true],
  ["/fish*", "/catfish", false],

  ["/fish/", "/fish/", true],
  ["/fish/", "/fish/?id=anything", true],
  ["/fish/", "/fish/salmon.htm", true],
  ["/fish/", "/fish", false],
  ["/fish/", "/fish.html", false],
  ["/fish/", "/animals/fish/", false],

  ["/*.php", "/index.php", true],
  ["/*.php", "/filename.php", true],
  ["/*.php", "/folder/filename.php", true],
  ["/*.php", "/folder/filename.php?parameters", true],
  ["/*.php", "/filename.php5", true],
  ["/*.php", "/", false],
  ["/*.php", "/windows.PHP", false],

  ["/*.php$", "/filename.php", true],
  ["/*.php$", "/folder/filename.php", true],
  ["/*.php$", "/filename.php?parameters", false],
  ["/*.php$", "/filename.php5", false],
  ["/*.php$", "/windows.PHP", false],

  ["/fish*.php", "/fish.php", true],
  ["/fish*.php", "/fishheads/catfish.php?parameters", true],
  ["/fish*.php", "/Fish.PHP", false],

  ["/", "/", true],
  ["/", "/anything", true],
  ["/$", "/", true],
  ["/$", "/page", false],
  ["", "/anything", false], // 空 = 規則なし
];
for (const [pattern, path, want] of patternCases) {
  const got = matchPattern(pattern, path);
  ok(`match(${JSON.stringify(pattern)}, ${JSON.stringify(path)}) = ${want}`, got === want, `実際は ${got}`);
}

// ---- 最長一致と同長時のAllow優先(RFC 9309 §2.2.2) ----
const precedence: [string, string, boolean, string][] = [
  ["Allow: /p\nDisallow: /", "/page", true, "/p のほうが長い"],
  ["Allow: /folder\nDisallow: /folder", "/folder/page", true, "同じ長さなら Allow"],
  ["Allow: /page\nDisallow: /*.htm", "/page.htm", false, "/*.htm のほうが長い"],
  ["Allow: /$\nDisallow: /", "/", true, "/$ のほうが長い"],
  ["Allow: /$\nDisallow: /", "/page", false, "/$ は /page に当たらない"],
  // **書いた順は関係ない。** 逆順でも同じ結果でなければならない。
  ["Disallow: /\nAllow: /p", "/page", true, "順序を入れ替えても /p が勝つ"],
  ["Disallow: /*.htm\nAllow: /page", "/page.htm", false, "順序を入れ替えても /*.htm が勝つ"],
];
for (const [rules, path, want, why] of precedence) {
  const r = parseRobots(`User-agent: *\n${rules}`);
  const d = isAllowed(r, "Googlebot", path);
  ok(`優先順位: ${why} → ${path} は ${want ? "許可" : "拒否"}`, d.allowed === want, d.reason);
}

// ---- 空の Disallow ----
{
  const r = parseRobots("User-agent: *\nDisallow:");
  ok("Disallow: が空なら全部許可", isAllowed(r, "Googlebot", "/anything").allowed === true);
  const r2 = parseRobots("User-agent: *\nDisallow: /");
  ok("Disallow: / は全部拒否", isAllowed(r2, "Googlebot", "/anything").allowed === false);
}

// ---- User-agent の群選択 ----
{
  const src = [
    "User-agent: *",
    "Disallow: /",
    "",
    "User-agent: Googlebot",
    "Allow: /",
    "",
    "User-agent: Googlebot-Image",
    "Disallow: /private",
  ].join("\n");
  const r = parseRobots(src);
  ok("群が3つ読める", r.groups.length === 3, String(r.groups.length));
  ok("Googlebot は専用の群を使う", selectGroup(r, "Googlebot")?.agents[0] === "Googlebot");
  // **最も限定的な群だけを見る。* の群は継ぎ足されない。**
  ok("Googlebot は * の Disallow: / を引き継がない", isAllowed(r, "Googlebot", "/anything").allowed === true);
  ok("Googlebot-Image はより限定的な群を使う", selectGroup(r, "Googlebot-Image")?.agents[0] === "Googlebot-Image");
  ok("Googlebot-Image は /private が拒否", isAllowed(r, "Googlebot-Image", "/private/a.jpg").allowed === false);
  ok("Googlebot-Image は他が許可", isAllowed(r, "Googlebot-Image", "/public/a.jpg").allowed === true);
  ok("知らないクローラーは * の群", selectGroup(r, "SomeOtherBot")?.agents[0] === "*");
  ok("知らないクローラーは拒否される", isAllowed(r, "SomeOtherBot", "/").allowed === false);
}

// ---- User-agent が連続したら同じ群 ----
{
  const r = parseRobots("User-agent: A\nUser-agent: B\nDisallow: /x\n\nUser-agent: C\nDisallow: /y");
  ok("連続した User-agent は1つの群", r.groups.length === 2, String(r.groups.length));
  ok("同じ群の規則が両方に効く(A)", isAllowed(r, "A", "/x").allowed === false);
  ok("同じ群の規則が両方に効く(B)", isAllowed(r, "B", "/x").allowed === false);
  ok("別の群には効かない", isAllowed(r, "C", "/x").allowed === true);
}

// ---- sitemap と注意書き ----
{
  const r = parseRobots(
    [
      "Sitemap: https://example.com/sitemap.xml",
      "User-agent: *",
      "Disallow: /admin",
      "Crawl-delay: 10",
      "Noindex: /secret",
      "Disallow /typo",
      "Sitemap: https://example.com/news.xml",
    ].join("\n"),
  );
  ok("Sitemap を群の外でも拾う", r.sitemaps.length === 2, String(r.sitemaps.length));
  ok("Crawl-delay に注意書きが出る", r.warnings.some((w) => w.text.includes("Crawl-delay")));
  ok("Noindex は効かないと伝える", r.warnings.some((w) => w.code === "noindex"));
  ok("コロンの無い行を拾う", r.warnings.some((w) => w.text.includes("Disallow /typo")));
}

// ---- コメントと空白 ----
{
  const r = parseRobots("# コメント\nUser-agent: *   # 末尾コメント\nDisallow: /admin # ここもコメント\n");
  ok("末尾のコメントを値に混ぜない", isAllowed(r, "X", "/admin").allowed === false);
  ok("コメント行を規則にしない", r.warnings.length === 0, JSON.stringify(r.warnings));
}

// ---- 規則が無いとき ----
{
  const r = parseRobots("");
  ok("空のrobots.txtは全部許可", isAllowed(r, "Googlebot", "/anything").allowed === true);
  const r2 = parseRobots("Disallow: /admin");
  ok("User-agent が無い規則は無効", isAllowed(r2, "Googlebot", "/admin").allowed === true);
  ok("その場合に注意書きを出す", r2.warnings.some((w) => w.code === "beforeUserAgent"));
}


// ---- 文面(14言語) ----
// 以前は理由と注意書きが日本語の直書きで、どの言語のページでも日本語が出ていた。
for (const table of [ROBOTS_WARNINGS, ROBOTS_REASONS] as Record<string, Record<string, string>>[]) {
  for (const [code, byLocale] of Object.entries(table)) {
    const want = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const { code: l } of LOCALES) {
      ok(`${code}/${l} がある`, typeof byLocale[l] === "string" && byLocale[l].trim() !== "");
      ok(`${code}/${l} の差し込みが英語と同じ`, want(byLocale[l]) === want(byLocale.en));
    }
  }
}
{
  const r = parseRobots("User-agent: *\nDisallow: /admin/\nAllow: /admin/public/\nCrawl-delay: 5");
  const d = isAllowed(r, "Googlebot", "/admin/x");
  const t = reasonText(d, "en");
  ok("理由に行番号とパターンが入る", t.includes("line 2") && t.includes("/admin/"), t);
  const w = r.warnings.find((x) => x.code === "extension")!;
  ok("注意書きにフィールド名が入る", warningText(w, "de").includes("crawl-delay"), warningText(w, "de"));
}
console.log(`\n[check:robots-txt] ${pass} 件成功 / ${failures.length} 件失敗`);
if (failures.length) {
  for (const f of failures) console.error("  NG " + f);
  process.exit(1);
}
