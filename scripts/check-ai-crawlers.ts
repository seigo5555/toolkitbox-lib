/**
 * AIクローラー用 robots.txt 生成の検算。
 *
 * 生成した文字列を、既存の robots.txt テスター(RFC 9309 準拠)に**実際に読ませて**
 * 「ブロックしたつもりのものが本当にブロックされるか」「関係ないものを巻き込んで
 * いないか」を確かめる。自作の生成器を自作の期待値で確かめても意味が無いので、
 * 別の実装(パーサ)を通す。
 *
 * 実行: npx tsx scripts/check-ai-crawlers.ts
 */
import {
  AI_BOTS,
  PURPOSES,
  VERIFIED_ON,
  appendBlock,
  cleanAgent,
  cleanPath,
  generateBlock,
  orderedSelection,
  presetSelection,
} from "../src/ai-crawlers";
import { isAllowed, parseRobots } from "../src/robots-txt";

let pass = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

// ---- データの形 ----
{
  const tokens = AI_BOTS.map((b) => b.token.toLowerCase());
  ok("User-agent 名に重複が無い", new Set(tokens).size === tokens.length);
  ok("VERIFIED_ON が ISO 日付", /^\d{4}-\d{2}-\d{2}$/.test(VERIFIED_ON), VERIFIED_ON);
  for (const b of AI_BOTS) {
    ok(`${b.token}: 名前に空白・コロンが無い`, cleanAgent(b.token) === b.token);
    ok(`${b.token}: 出典が https`, b.source.startsWith("https://"), b.source);
    ok(`${b.token}: 運営者が入っている`, b.operator.length > 0);
  }
  for (const p of PURPOSES) {
    ok(`性質 ${p} のボットが1つ以上ある`, AI_BOTS.some((b) => b.purpose === p));
  }
  // 利用者操作型は「robots.txt が効かないことがある」と公式が言っているものに限る。
  const partial = AI_BOTS.filter((b) => b.honors === "partial").map((b) => b.token).sort();
  ok(
    "適用されないことがあると公式が書いているのは user 型だけ",
    AI_BOTS.filter((b) => b.honors === "partial").every((b) => b.purpose === "user"),
    partial.join(","),
  );
  // 「公式に記載なし」は、公式ページを2回見ても従うかが書かれていなかったものだけ(2026-10-30 時点で OAI-AdsBot のみ)。
  const unstated = AI_BOTS.filter((b) => b.honors === "unstated").map((b) => b.token);
  ok("robots.txt への対応が未記載なのは OAI-AdsBot と meta-externalads だけ", unstated.join(",") === "OAI-AdsBot,meta-externalads", unstated.join(","));
  ok("学習のみのプリセットに OAI-AdsBot は入らない", !presetSelection("training").has("OAI-AdsBot"));
}

// ---- プリセット ----
{
  const training = presetSelection("training");
  ok("学習のみ: 学習用だけ入る", AI_BOTS.every((b) => training.has(b.token) === (b.purpose === "training")));
  ok("学習のみ: GPTBot と ClaudeBot が入る", training.has("GPTBot") && training.has("ClaudeBot"));
  ok("学習のみ: 検索用は入らない", !training.has("OAI-SearchBot") && !training.has("PerplexityBot"));
  ok("すべて: 全ボットが入る", presetSelection("all").size === AI_BOTS.length);
  ok("なし: 空", presetSelection("none").size === 0);
}

// ---- 生成 → 既存パーサで判定 ----
{
  const sel = presetSelection("training");
  const block = generateBlock(orderedSelection(sel, []), "/");
  const robots = parseRobots(block);
  ok("生成物に警告が無い", robots.warnings.length === 0, JSON.stringify(robots.warnings));

  for (const b of AI_BOTS) {
    const d = isAllowed(robots, b.token, "/blog/post");
    ok(`${b.token}: 学習のみ生成で ${b.purpose === "training" ? "拒否" : "許可"}`, d.allowed === (b.purpose !== "training"));
  }
  ok("無関係な Googlebot は巻き込まない", isAllowed(robots, "Googlebot", "/").allowed);
  ok("無関係な Bingbot は巻き込まない", isAllowed(robots, "bingbot", "/x").allowed);
  // 1つの群にまとまっている(群は1つ、User-agent は選んだ数)
  ok("群は1つにまとまる", robots.groups.length === 1, String(robots.groups.length));
  ok("群の User-agent 数が選択数と一致", robots.groups[0].agents.length === sel.size);
}

// ---- パス指定 ----
{
  const block = generateBlock(["GPTBot"], cleanPath("/members/"));
  const r = parseRobots(block);
  ok("パス指定: 配下は拒否", !isAllowed(r, "GPTBot", "/members/a").allowed);
  ok("パス指定: 他は許可", isAllowed(r, "GPTBot", "/blog/").allowed);
  ok("cleanPath: 空は /", cleanPath("") === "/");
  ok("cleanPath: 先頭 / を補う", cleanPath("members") === "/members");
  ok("cleanPath: 空白以降は捨てる(行を増やさせない)", cleanPath("/a b\nDisallow: /") === "/a");
}

// ---- 入力の安全 ----
{
  ok("cleanAgent: 空は null", cleanAgent("  ") === null);
  ok("cleanAgent: 空白を含むものは null", cleanAgent("My Bot") === null);
  ok("cleanAgent: 改行で別フィールドを足せない", cleanAgent("Bot\nAllow: /") === null);
  ok("cleanAgent: コロンは null", cleanAgent("Bot:x") === null);
  ok("cleanAgent: コメントは null", cleanAgent("Bot#x") === null);
  ok("cleanAgent: 普通の名前は通す", cleanAgent(" MyBot ") === "MyBot");
}

// ---- 重複の除去 ----
{
  const block = generateBlock(["GPTBot", "gptbot", "ClaudeBot"], "/");
  ok("大文字小文字違いの重複を1つにする", (block.match(/User-agent:/g) ?? []).length === 2, block);
  ok("空の選択は空文字", generateBlock([], "/") === "");
}

// ---- 既存への追記 ----
{
  const existing = "User-agent: *\nDisallow: /admin/\n\nSitemap: https://example.com/sitemap.xml\n";
  const merged = appendBlock(existing, generateBlock(["GPTBot"], "/"));
  const r = parseRobots(merged);
  ok("追記: 既存の * の規則が残る", !isAllowed(r, "SomeBot", "/admin/x").allowed);
  ok("追記: 既存で許可していたものは許可のまま", isAllowed(r, "SomeBot", "/blog").allowed);
  ok("追記: GPTBot は拒否", !isAllowed(r, "GPTBot", "/blog").allowed);
  ok("追記: Sitemap が残る", r.sitemaps.length === 1);
  ok("追記: 空行は1つだけ挟まる", !/\n\n\n/.test(merged));
  ok("追記: 既存が空ならそのまま", appendBlock("", "User-agent: X\nDisallow: /\n") === "User-agent: X\nDisallow: /\n");
  ok("追記: 生成が空なら既存のまま", appendBlock(existing, "") === existing);
}

// ---- 選択順は一覧の並び ----
{
  const a = orderedSelection(new Set(["ClaudeBot", "GPTBot"]), ["Zed"]);
  ok("一覧の並びで出る(操作順に依らない)", a.join(",") === "GPTBot,ClaudeBot,Zed", a.join(","));
}

if (failures.length) {
  console.error(`NG ${failures.length}件 / OK ${pass}件`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`AIクローラー robots.txt 生成: ${pass}件 すべて通過`);
