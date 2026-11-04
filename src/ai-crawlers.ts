/**
 * AIクローラーの一覧と、robots.txt の生成。
 *
 * ここの User-agent 名は **各社の公式ドキュメントで確認したもの**だけを載せている。
 * 確認していないもの(Bytespider など)は入れない。入れて間違えると、
 * ブロックしたつもりで素通りする。足りないものは画面の「自分で追加」で補える。
 *
 * 性質は3つに分ける。**この区別が、ブロックの意味を決める。**
 *  - training … 学習データの収集。止めても検索やAIの回答には出続ける
 *  - search   … AI検索の索引づくり。止めると回答の出典に出なくなる
 *  - user     … 利用者が頼んだときだけページを取りに来る。
 *               **robots.txt の対象外とする社が多い**(OpenAI / Perplexity / Meta)
 *  - ads      … 広告用。OAI-AdsBot は広告として出稿されたページの確認(学習にも検索にも使わないと公式が明記)、
 *               Meta-ExternalAds は「広告やビジネス関連の製品・サービスの改善など」のための巡回(Meta の説明)
 *
 * 更新するときは VERIFIED_ON を必ず進めること。画面に出る。
 */

export type Purpose = "training" | "search" | "user" | "ads";

/**
 * robots.txt への従い方。
 *  - yes     … 公式が従うと明記している
 *  - partial … 公式が「適用されないことがある」と明記している
 *  - unstated … 公式ページに従うとも従わないとも書かれていない(OAI-AdsBot は 2026-10-30、Meta-ExternalAds は 2026-11-04 に確認。
 *               Meta のページは robots.txt で止める書き方の例を載せているが、従うとは明記していない)
 */
export type Honors = "yes" | "partial" | "unstated";

export type AiBot = {
  /** robots.txt の User-agent に書く名前。大文字小文字は区別されないが公式表記に揃える。 */
  token: string;
  operator: string;
  purpose: Purpose;
  honors: Honors;
  /** 実際にクロールする実体が無い「制御用の名前」。Googleの検索クロールには影響しない。 */
  controlOnly?: boolean;
  /** 確認した公式ページ。 */
  source: string;
};

/** 公式ドキュメントと突き合わせた日(UTC)。 */
export const VERIFIED_ON = "2026-11-04";

export const AI_BOTS: AiBot[] = [
  { token: "GPTBot", operator: "OpenAI", purpose: "training", honors: "yes", source: "https://developers.openai.com/api/docs/bots" },
  { token: "OAI-SearchBot", operator: "OpenAI", purpose: "search", honors: "yes", source: "https://developers.openai.com/api/docs/bots" },
  { token: "ChatGPT-User", operator: "OpenAI", purpose: "user", honors: "partial", source: "https://developers.openai.com/api/docs/bots" },
  { token: "OAI-AdsBot", operator: "OpenAI", purpose: "ads", honors: "unstated", source: "https://developers.openai.com/api/docs/bots" },

  {
    token: "ClaudeBot",
    operator: "Anthropic",
    purpose: "training",
    honors: "yes",
    source: "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler",
  },
  {
    token: "Claude-SearchBot",
    operator: "Anthropic",
    purpose: "search",
    honors: "yes",
    source: "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler",
  },
  {
    token: "Claude-User",
    operator: "Anthropic",
    purpose: "user",
    honors: "yes",
    source: "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler",
  },

  {
    token: "Google-Extended",
    operator: "Google",
    purpose: "training",
    honors: "yes",
    controlOnly: true,
    source: "https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers",
  },

  { token: "PerplexityBot", operator: "Perplexity", purpose: "search", honors: "yes", source: "https://docs.perplexity.ai/guides/bots" },
  { token: "Perplexity-User", operator: "Perplexity", purpose: "user", honors: "partial", source: "https://docs.perplexity.ai/guides/bots" },

  { token: "Applebot-Extended", operator: "Apple", purpose: "training", honors: "yes", controlOnly: true, source: "https://support.apple.com/en-us/119829" },

  {
    token: "meta-externalagent",
    operator: "Meta",
    purpose: "training",
    honors: "yes",
    source: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers",
  },
  {
    token: "meta-webindexer",
    operator: "Meta",
    purpose: "search",
    honors: "yes",
    source: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers",
  },
  {
    token: "meta-externalads",
    operator: "Meta",
    purpose: "ads",
    honors: "unstated",
    source: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers",
  },
  {
    token: "meta-externalfetcher",
    operator: "Meta",
    purpose: "user",
    honors: "partial",
    source: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers",
  },

  { token: "CCBot", operator: "Common Crawl", purpose: "training", honors: "yes", source: "https://commoncrawl.org/ccbot" },
];

export const PURPOSES: Purpose[] = ["training", "search", "user", "ads"];

/** プリセット。「学習だけ止める」を既定にする。検索・回答の出典には残りたい人が大半だから。 */
export type Preset = "training" | "all" | "none";

export function presetSelection(preset: Preset): Set<string> {
  if (preset === "none") return new Set();
  return new Set(AI_BOTS.filter((b) => preset === "all" || b.purpose === "training").map((b) => b.token));
}

/** 画面で入力された自由記述のUser-agentを、書ける形に整える。書けないものは null。 */
export function cleanAgent(raw: string): string | null {
  const t = raw.trim();
  // 改行・コロン・空白・#を含むと、別の行や別のフィールドに化ける。
  if (!t || /[\s:#]/.test(t)) return null;
  return t;
}

/** パスの入力を robots.txt に書ける形にする。空なら "/"。 */
export function cleanPath(raw: string): string {
  const t = raw.trim().split(/\s+/)[0] ?? "";
  if (!t) return "/";
  return t.startsWith("/") ? t : "/" + t;
}

/**
 * 選ばれたUser-agentから robots.txt の断片を作る。
 * 1つの群に User-agent を並べ、規則を1回だけ書く(RFC 9309 で有効)。
 * 同じ名前を2回書かないよう、大文字小文字を無視して重複を除く。
 */
export function generateBlock(agents: string[], path: string): string {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const a of agents) {
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(a);
  }
  if (unique.length === 0) return "";
  return [...unique.map((a) => `User-agent: ${a}`), `Disallow: ${path}`].join("\n") + "\n";
}

/** 既存の robots.txt の末尾に生成分をつなぐ。空行を1つだけ挟む。 */
export function appendBlock(existing: string, block: string): string {
  if (!block) return existing;
  const base = existing.replace(/\s+$/, "");
  return base ? `${base}\n\n${block}` : block;
}

/** 選択順を一覧の並びに揃える。画面操作の順で出力が変わらないように。 */
export function orderedSelection(selected: Set<string>, extras: string[]): string[] {
  return [...AI_BOTS.filter((b) => selected.has(b.token)).map((b) => b.token), ...extras];
}
