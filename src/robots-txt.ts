/**
 * robots.txt の解釈と、URLが取得を許されるかの判定。
 *
 * 規則は RFC 9309 (Robots Exclusion Protocol, 2022年に標準化) に従う。
 * 仕様が公開されているので、思い込みではなく条文どおりに作れる。
 *
 * 間違えやすいのは次の4点。ここを外すと「ブロックしたつもりが素通り」
 * あるいは「公開したつもりが除外」になり、どちらも気づきにくい。
 *
 *  1. **最長一致が勝つ。** 書いた順ではない。Allow と Disallow が両方
 *     当たったときは、パターンが長いほうを採る
 *  2. **同じ長さなら Allow が勝つ**(RFC 9309 §2.2.2)
 *  3. **User-agent は最も限定的な一群だけを見る。** 自分の名前の群が
 *     あれば、* の群は一切参照しない(継ぎ足しではない)
 *  4. **Disallow: が空なら「すべて許可」。** Disallow: / とは正反対
 */

export type Rule = { type: "allow" | "disallow"; pattern: string; line: number };
export type Group = { agents: string[]; rules: Rule[]; line: number };

export type Robots = {
  groups: Group[];
  sitemaps: string[];
  /** 解釈できなかった行。書き間違いの発見に使う。文は robots-txt-messages.ts に14言語で持つ。 */
  warnings: { line: number; text: string; code: RobotsWarningCode; field?: string }[];
};

export type RobotsWarningCode = "notFieldValue" | "emptyUserAgent" | "beforeUserAgent" | "noindex" | "extension" | "unknownField";

/** 1行を「フィールド名: 値」に割る。値の側に : が来ても壊さない。 */
function splitLine(raw: string): { field: string; value: string } | null {
  const withoutComment = raw.replace(/#.*$/, "");
  const i = withoutComment.indexOf(":");
  if (i === -1) return null;
  return {
    field: withoutComment.slice(0, i).trim().toLowerCase(),
    value: withoutComment.slice(i + 1).trim(),
  };
}

export function parseRobots(text: string): Robots {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  const warnings: Robots["warnings"] = [];

  let current: Group | null = null;
  // User-agent が連続している間は同じ群に足す。間に規則が挟まると新しい群。
  let acceptingAgents = false;

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const parsed = splitLine(raw);
    if (!parsed || !parsed.field) {
      warnings.push({ line, text: trimmed, code: "notFieldValue" });
      return;
    }
    const { field, value } = parsed;

    if (field === "user-agent") {
      if (!value) {
        warnings.push({ line, text: trimmed, code: "emptyUserAgent" });
        return;
      }
      if (current && acceptingAgents) {
        current.agents.push(value);
      } else {
        current = { agents: [value], rules: [], line };
        groups.push(current);
        acceptingAgents = true;
      }
      return;
    }

    if (field === "allow" || field === "disallow") {
      if (!current) {
        warnings.push({ line, text: trimmed, code: "beforeUserAgent" });
        return;
      }
      acceptingAgents = false;
      current.rules.push({ type: field, pattern: value, line });
      return;
    }

    if (field === "sitemap") {
      // sitemap は群に属さない。ファイルのどこに書いても全体に効く。
      if (value) sitemaps.push(value);
      return;
    }

    if (field === "crawl-delay" || field === "host" || field === "clean-param" || field === "noindex") {
      warnings.push(field === "noindex" ? { line, text: trimmed, code: "noindex" } : { line, text: trimmed, code: "extension", field });
      return;
    }

    warnings.push({ line, text: trimmed, code: "unknownField", field });
  });

  return { groups, sitemaps, warnings };
}

/**
 * どの群が使われるか。**最も限定的な一致を1つだけ選ぶ。**
 * 自分の名前の群があれば * の群は見ない。継ぎ足しではないので、
 * 「* に書いたから全員に効く」は誤り。
 */
export function selectGroup(robots: Robots, userAgent: string): Group | null {
  const ua = userAgent.trim().toLowerCase();
  let best: Group | null = null;
  let bestLength = -1;

  for (const group of robots.groups) {
    for (const agent of group.agents) {
      const a = agent.trim().toLowerCase();
      if (a === "*") {
        if (bestLength < 0) {
          best = group;
          bestLength = 0;
        }
        continue;
      }
      // 製品トークンの前方一致。"Googlebot-Image" は "Googlebot" にも当たる。
      if (ua.startsWith(a) && a.length > bestLength) {
        best = group;
        bestLength = a.length;
      }
    }
  }
  return best;
}

/**
 * パターンが path に当たるか。
 * `*` は任意の並び、`$` は末尾固定。それ以外の文字はそのまま比較する。
 */
export function matchPattern(pattern: string, path: string): boolean {
  if (pattern === "") return false; // 空の Disallow は「規則なし」= 当たらない
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const parts = body.split("*");
  let pos = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "") {
      if (i === parts.length - 1 && anchored) return pos <= path.length;
      continue;
    }
    if (i === 0) {
      // 先頭は必ずその位置から始まる(パターンは常にパスの先頭に錨を打つ)
      if (!path.startsWith(part)) return false;
      pos = part.length;
      continue;
    }
    const found = path.indexOf(part, pos);
    if (found === -1) return false;
    pos = found + part.length;
  }

  if (anchored) {
    const last = parts[parts.length - 1];
    // 最後の断片が末尾で終わっていなければならない
    return last === "" ? true : path.endsWith(last);
  }
  return true;
}

export type Decision = {
  allowed: boolean;
  /** 判断の決め手になった規則。無ければ「規則が無いので許可」。 */
  rule: Rule | null;
  group: Group | null;
  /** 判断の理由。文は robots-txt-messages.ts に14言語で持つ。 */
  reason: DecisionReason;
};

export type DecisionReason = "noGroup" | "noMatch" | "allowMatch" | "disallowMatch";

/**
 * 取得が許されるかを判定する。
 *
 * **最長一致が勝ち、同じ長さなら Allow が勝つ**(RFC 9309 §2.2.2)。
 * 書いた順は関係ない。ここを順番だと思い込んでいると、意図と逆になる。
 */
export function isAllowed(robots: Robots, userAgent: string, path: string): Decision {
  const group = selectGroup(robots, userAgent);
  if (!group) {
    return { allowed: true, rule: null, group: null, reason: "noGroup" };
  }

  let winner: Rule | null = null;
  for (const rule of group.rules) {
    if (!matchPattern(rule.pattern, path)) continue;
    if (!winner) {
      winner = rule;
      continue;
    }
    if (rule.pattern.length > winner.pattern.length) {
      winner = rule;
    } else if (rule.pattern.length === winner.pattern.length && rule.type === "allow" && winner.type === "disallow") {
      // 同じ長さなら Allow を採る
      winner = rule;
    }
  }

  if (!winner) {
    return {
      allowed: true,
      rule: null,
      group,
      reason: "noMatch",
    };
  }

  return {
    allowed: winner.type === "allow",
    rule: winner,
    group,
    reason: winner.type === "allow" ? "allowMatch" : "disallowMatch",
  };
}

/** よく使うクローラー。選ぶだけで試せるようにしておく。 */
export const COMMON_AGENTS = [
  "Googlebot",
  "Googlebot-Image",
  "Bingbot",
  "GPTBot",
  "ClaudeBot",
  "PerplexityBot",
  "facebookexternalhit",
  "Twitterbot",
  "*",
];
