/**
 * llms.txt の組み立てと検査。
 *
 * 形式は llmstxt.org の提案(v2・2026-08-10 更新)に従う:
 *   1. # 見出し(H1)— 唯一の必須項目
 *   2. > 要約(引用ブロック)
 *   3. 見出しを含まない本文(段落・リストなど)
 *   4. ## 見出しで区切られた「ファイルリスト」。各行は `- [名前](URL)` に、
 *      任意で `: 補足` が続く
 *
 * 「Optional」節は慣習として残るが、v2 では機械的な意味を持たない(読み飛ばしの
 * 指示ではなくなった)。ここでは「後回しでよい資料」の置き場として最後に出す。
 *
 * 検査(checkLlmsTxt)は生成物を読み直すのにも、貼り付けられた既存ファイルを
 * 読むのにも同じものを使う。
 */

export const LLMS_TXT_CHECKED_ON = "2026-10-15";
export const LLMS_TXT_SPEC_URL = "https://llmstxt.org/";

export type LlmsLink = { title: string; url: string; note: string };
export type LlmsSection = { heading: string; links: LlmsLink[]; optional?: boolean };
export type LlmsDoc = { title: string; summary: string; details: string; sections: LlmsSection[] };

export const OPTIONAL_HEADING = "Optional";

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * リンク名の [ ] は丸括弧に置き換える。バックスラッシュで逃がせば Markdown としては
 * 正しいが、公式の Python 実装(llms-txt)の正規表現は `\\]` を読めず、行ごと落ちる。
 * 読む側の実装に合わせ、逃がさずに置き換える。
 */
export function cleanTitle(s: string): string {
  return oneLine(s).replace(/\[/g, "(").replace(/\]/g, ")");
}

/** URL の空白と丸括弧は、Markdown のリンクを途中で終わらせるのでパーセントに直す。 */
export function encodeUrl(u: string): string {
  return u.trim().replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** タイトルの無い URL から、仮の名前を作る(利用者が直す前提)。 */
export function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    const last = segs[segs.length - 1];
    if (!last) return u.hostname;
    let name = last;
    try {
      name = decodeURIComponent(last);
    } catch {
      /* そのまま */
    }
    name = name.replace(/\.(html?|md|php|aspx?)$/i, "").replace(/[-_]+/g, " ").trim();
    if (!name) return u.hostname;
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return url;
  }
}

const isHttpUrl = (s: string) => /^https?:\/\/\S+$/i.test(s);

/**
 * リンクの入力欄を読む。1行1リンク。次の書き方を受け付ける。
 *   https://example.com/a
 *   タイトル | https://example.com/a | 補足
 *   https://example.com/a | タイトル | 補足
 *   [タイトル](https://example.com/a): 補足   (Markdown のリストの "- " は付いていてよい)
 * sitemap.xml をそのまま貼った場合は <loc> を拾う。
 */
export function parseLinkLines(text: string): { links: LlmsLink[]; skipped: string[] } {
  const links: LlmsLink[] = [];
  const skipped: string[] = [];

  if (/<loc>/i.test(text)) {
    for (const m of text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      const url = m[1].replace(/&amp;/g, "&");
      links.push({ title: titleFromUrl(url), url, note: "" });
    }
    return { links, skipped };
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();
    if (!line) continue;

    const md = /^\[((?:\\.|[^\]\\])*)\]\(\s*([^)\s]+)\s*\)\s*(?::\s*(.*))?$/.exec(line);
    if (md) {
      links.push({ title: md[1].replace(/\\([\\[\]])/g, "$1"), url: md[2], note: oneLine(md[3] ?? "") });
      continue;
    }

    const parts = line.split("|").map((p) => p.trim());
    if (isHttpUrl(parts[0])) {
      links.push({ title: parts[1] || titleFromUrl(parts[0]), url: parts[0], note: parts.slice(2).join(" | ") });
    } else if (parts.length >= 2 && parts[1]) {
      links.push({ title: parts[0], url: parts[1], note: parts.slice(2).join(" | ") });
    } else {
      skipped.push(line);
    }
  }
  return { links, skipped };
}

function linkLine(l: LlmsLink): string {
  const base = `- [${cleanTitle(l.title)}](${encodeUrl(l.url)})`;
  const note = oneLine(l.note);
  return note ? `${base}: ${note}` : base;
}

/** 名前もURLも空のリンクは出さない。 */
const usable = (l: LlmsLink) => oneLine(l.title) !== "" && l.url.trim() !== "";

export function buildLlmsTxt(doc: LlmsDoc): string {
  const out: string[] = [];
  const title = oneLine(doc.title);
  if (!title) return "";

  out.push(`# ${title}`);

  const summary = doc.summary
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (summary.length) out.push(summary.map((s) => `> ${s}`).join("\n"));

  const details = doc.details.replace(/\r\n/g, "\n").trim();
  if (details) out.push(details);

  const normal = doc.sections.filter((s) => !s.optional);
  const optional = doc.sections.filter((s) => s.optional);

  for (const s of normal) {
    const links = s.links.filter(usable);
    if (links.length === 0) continue;
    out.push(`## ${oneLine(s.heading) || "Links"}\n\n${links.map(linkLine).join("\n")}`);
  }

  const optLinks = optional.flatMap((s) => s.links.filter(usable));
  if (optLinks.length) out.push(`## ${OPTIONAL_HEADING}\n\n${optLinks.map(linkLine).join("\n")}`);

  return out.join("\n\n") + "\n";
}

// ---- 検査 ----

export type IssueCode =
  | "no-h1"
  | "heading-level"
  | "no-summary"
  | "no-sections"
  | "empty-section"
  | "bad-item"
  | "section-text"
  | "bad-url"
  | "relative-url"
  | "non-http-url"
  | "empty-title"
  | "duplicate-url";

export type IssueLevel = "error" | "warn" | "info";

export type Issue = { code: IssueCode; level: IssueLevel; line: number; detail: string };

const LEVEL: Record<IssueCode, IssueLevel> = {
  "no-h1": "error",
  "bad-url": "error",
  "heading-level": "warn",
  "empty-section": "warn",
  "bad-item": "warn",
  "non-http-url": "warn",
  "empty-title": "warn",
  "duplicate-url": "info",
  "no-summary": "info",
  "no-sections": "info",
  "section-text": "info",
  "relative-url": "info",
};

export type ParsedLlms = {
  title: string;
  summary: string;
  sections: { heading: string; line: number; links: (LlmsLink & { line: number })[] }[];
};

export type CheckResult = {
  parsed: ParsedLlms;
  issues: Issue[];
  linkCount: number;
};

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/;
const LINK_ITEM = /^\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)\s*(?::\s*(.*))?$/;

export function checkLlmsTxt(input: string): CheckResult {
  const lines = input.replace(/^﻿/, "").split(/\r?\n/);
  const issues: Issue[] = [];
  const add = (code: IssueCode, line: number, detail = "") => issues.push({ code, level: LEVEL[code], line, detail });

  const parsed: ParsedLlms = { title: "", summary: "", sections: [] };

  let i = 0;
  const skipBlank = () => {
    while (i < lines.length && lines[i].trim() === "") i++;
  };

  // 1. H1
  skipBlank();
  if (i >= lines.length) {
    add("no-h1", 1);
    return { parsed, issues, linkCount: 0 };
  }
  const h1 = /^#\s+(.*?)\s*#*\s*$/.exec(lines[i]);
  if (h1 && h1[1]) {
    parsed.title = h1[1];
    i++;
  } else {
    add("no-h1", i + 1, lines[i].trim().slice(0, 60));
  }

  // 2. 要約
  skipBlank();
  if (i < lines.length && /^\s*>/.test(lines[i])) {
    const buf: string[] = [];
    while (i < lines.length && /^\s*>/.test(lines[i])) {
      buf.push(lines[i].replace(/^\s*>\s?/, ""));
      i++;
    }
    parsed.summary = buf.join("\n").trim();
  } else if (parsed.title) {
    add("no-summary", i + 1);
  }

  // 3. 本文と節
  let inFence = false;
  let current: ParsedLlms["sections"][number] | null = null;
  let sawSection = false;

  for (; i < lines.length; i++) {
    const raw = lines[i];
    const n = i + 1;

    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (raw.trim() === "") continue;

    const h = HEADING.exec(raw);
    if (h) {
      const level = h[1].length;
      if (level === 2) {
        current = { heading: h[2], line: n, links: [] };
        parsed.sections.push(current);
        sawSection = true;
      } else {
        add("heading-level", n, `H${level}: ${h[2].slice(0, 40)}`);
      }
      continue;
    }

    if (!current) continue; // 前書き。自由なMarkdownでよい

    const item = LIST_ITEM.exec(raw);
    if (!item) {
      add("section-text", n, raw.trim().slice(0, 40));
      continue;
    }
    const m = LINK_ITEM.exec(item[1].trim());
    if (!m) {
      add("bad-item", n, item[1].trim().slice(0, 40));
      continue;
    }
    const url = m[2].replace(/^<|>$/g, "");
    current.links.push({
      title: m[1].replace(/\\([\\[\]])/g, "$1"),
      url,
      note: oneLine(m[3] ?? ""),
      line: n,
    });
  }

  if (!sawSection && parsed.title) add("no-sections", 1);

  // 4. 節とリンクの検査
  const seen = new Map<string, number>();
  let linkCount = 0;
  for (const s of parsed.sections) {
    if (s.links.length === 0) add("empty-section", s.line, s.heading);
    for (const l of s.links) {
      linkCount++;
      if (!oneLine(l.title)) add("empty-title", l.line, l.url);

      if (!l.url) {
        add("bad-url", l.line, "");
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(l.url)) {
        if (/^https?:\/\//i.test(l.url)) {
          try {
            new URL(l.url);
          } catch {
            add("bad-url", l.line, l.url);
          }
        } else {
          add("non-http-url", l.line, l.url);
        }
      } else {
        add("relative-url", l.line, l.url);
      }

      const key = l.url.replace(/#.*$/, "");
      if (key) {
        const first = seen.get(key);
        if (first !== undefined) add("duplicate-url", l.line, `${l.url} (L${first})`);
        else seen.set(key, l.line);
      }
    }
  }

  const rank: Record<IssueLevel, number> = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => rank[a.level] - rank[b.level] || a.line - b.line);
  return { parsed, issues, linkCount };
}

/** 画面の「例を入れる」ボタン用。言語に依らない中立な例。 */
export const EXAMPLE_DOC: LlmsDoc = {
  title: "Example Project",
  summary: "Example Project is a small library for parsing dates. This file lists the pages an AI agent should read first.",
  details: "- Supports ISO 8601 and RFC 2822\n- Not a time zone database",
  sections: [
    {
      heading: "Docs",
      links: [
        { title: "Quick start", url: "https://example.com/docs/quick-start.md", note: "Install and parse a first date" },
        { title: "API reference", url: "https://example.com/docs/api.md", note: "Every function and option" },
      ],
    },
    {
      heading: "Examples",
      links: [{ title: "Recipes", url: "https://example.com/docs/recipes.md", note: "Common tasks" }],
    },
    {
      heading: OPTIONAL_HEADING,
      optional: true,
      links: [{ title: "Changelog", url: "https://example.com/changelog.md", note: "" }],
    },
  ],
};

/** 公開方法の補助。v2 が勧める標準のリンク関係(describedby)。 */
export function discoverySnippets(path = "/llms.txt"): { html: string; header: string } {
  const p = path.startsWith("/") ? path : `/${path}`;
  return {
    html: `<link rel="describedby" href="${p}">`,
    header: `Link: <${p}>; rel="describedby"`,
  };
}
