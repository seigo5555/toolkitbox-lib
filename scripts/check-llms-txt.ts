/**
 * llms.txt 生成・検査の検算。
 *
 * 自作の生成器を自作のパーサだけで確かめても意味が無いので、次の2つを足す。
 *   - llmstxt.org に載っている仕様の例を、そのまま読ませる
 *   - 生成物を「生成→読み直し→元と一致するか」で往復させる
 * 2026-10-15 に、公式の Python 実装(pip の llms-txt、parse_llms_file)にも生成物を
 * 読ませて確かめた。その時、リンク名に \[ \] があると行ごと落ちると分かり、
 * [ ] は丸括弧に置き換える方式にした。
 *
 * 実行: npx tsx scripts/check-llms-txt.ts
 */

import {
  EXAMPLE_DOC,
  OPTIONAL_HEADING,
  buildLlmsTxt,
  checkLlmsTxt,
  discoverySnippets,
  encodeUrl,
  cleanTitle,
  parseLinkLines,
  titleFromUrl,
  type IssueCode,
  type LlmsDoc,
} from "../src/llms-txt";

let pass = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};
const codes = (text: string): IssueCode[] => checkLlmsTxt(text).issues.map((i) => i.code);
const has = (text: string, code: IssueCode) => codes(text).includes(code);

// ---- 仕様の例(llmstxt.org の mock example) ----
{
  const mock = `# Title

> Optional description goes here

Optional details go here

## Section name

- [Link title](https://link_url): Optional link details

## Optional

- [Link title](https://link_url)
`;
  const r = checkLlmsTxt(mock);
  ok("仕様の例: 問題が無い", r.issues.filter((i) => i.level !== "info").length === 0, JSON.stringify(r.issues));
  ok("仕様の例: タイトル", r.parsed.title === "Title");
  ok("仕様の例: 要約", r.parsed.summary === "Optional description goes here");
  ok("仕様の例: 節が2つ", r.parsed.sections.length === 2);
  ok("仕様の例: リンクの補足", r.parsed.sections[0].links[0].note === "Optional link details");
  ok("仕様の例: Optional の見出し", r.parsed.sections[1].heading === OPTIONAL_HEADING);
}

// ---- 仕様の FastHTML の例(要約・箇条書きの前書き・複数節) ----
{
  const fasthtml = `# FastHTML

> FastHTML is a python library which brings together Starlette, Uvicorn, HTMX, and fastcore's \`FT\` "FastTags" into a library for creating server-rendered hypermedia applications.

Important notes:

- Although parts of its API are inspired by FastAPI, it is *not* compatible with FastAPI syntax and is not targeted at creating API services
- FastHTML is compatible with JS-native web components and any vanilla JS library, but not with React, Vue, or Svelte.

## Docs

- [FastHTML quick start](https://fastht.ml/docs/tutorials/quickstart_for_web_devs.html.md): A brief overview of many FastHTML features
- [HTMX reference](https://github.com/bigskysoftware/htmx/blob/master/www/content/reference.md): Brief description of all HTMX attributes, CSS classes, headers, events, extensions, js lib methods, and config options

## Examples

- [Todo list application](https://github.com/AnswerDotAI/fasthtml/blob/main/examples/adv_app.py): Detailed walk-thru of a complete CRUD app in FastHTML showing idiomatic use of FastHTML and HTMX patterns.

## Optional

- [Starlette full documentation](https://gist.githubusercontent.com/jph00/809e4a4808d4510be0e3dc9565e9cbd3/raw/9b717589ca44cedc8aaf00b2b8cacef922964c0f/starlette-sml.md): A subset of the Starlette documentation useful for FastHTML development.
`;
  const r = checkLlmsTxt(fasthtml);
  ok("FastHTML の例: 問題が無い", r.issues.filter((i) => i.level !== "info").length === 0, JSON.stringify(r.issues));
  ok("FastHTML の例: 節が3つ", r.parsed.sections.length === 3);
  ok("FastHTML の例: リンクが4つ", r.linkCount === 4, String(r.linkCount));
  ok(
    "FastHTML の例: 前書きの箇条書きをリンクと誤読しない",
    !has(fasthtml, "bad-item") && !has(fasthtml, "section-text"),
  );
}

// ---- 検査が拾うべきもの ----
{
  ok("H1 が無い", has("> only a summary\n\n## Docs\n- [a](https://a.example/)", "no-h1"));
  ok("空の入力", has("", "no-h1"));
  ok("空白だけの入力", has("  \n\n", "no-h1"));
  ok("H1 が無いのは error", checkLlmsTxt("hello").issues.some((i) => i.code === "no-h1" && i.level === "error"));
  ok("H1 だけでも有効(仕様上 H1 のみ必須)", !checkLlmsTxt("# Site\n").issues.some((i) => i.level === "error"));
  ok("要約が無いと知らせる", has("# Site\n\n## Docs\n- [a](https://a.example/)", "no-summary"));
  ok("節が無いと知らせる", has("# Site\n\n> s\n", "no-sections"));
  ok("H3 は仕様に無い", has("# Site\n\n> s\n\n## Docs\n\n### Sub\n\n- [a](https://a.example/)", "heading-level"));
  ok("本文中の見出しは仕様に無い", has("# Site\n\n> s\n\n# Another\n\n## Docs\n- [a](https://a.example/)", "heading-level"));
  ok("空の節", has("# Site\n\n> s\n\n## Docs\n\n## More\n- [a](https://a.example/)", "empty-section"));
  ok("リンクになっていない項目", has("# Site\n\n> s\n\n## Docs\n- just text\n", "bad-item"));
  ok("節の中の地の文", has("# Site\n\n> s\n\n## Docs\n\nSome paragraph.\n- [a](https://a.example/)", "section-text"));
  ok("相対URL", has("# Site\n\n> s\n\n## Docs\n- [a](/docs/a.md)", "relative-url"));
  ok("相対URLは info", checkLlmsTxt("# S\n\n> s\n\n## D\n- [a](/x.md)").issues[0].level === "info");
  ok("http 以外のスキーム", has("# S\n\n> s\n\n## D\n- [a](ftp://example.com/a)", "non-http-url"));
  ok("URLの形が壊れている", has("# S\n\n> s\n\n## D\n- [a](https://)", "bad-url") || has("# S\n\n> s\n\n## D\n- [a](https://)", "bad-item"));
  ok("名前が空", has("# S\n\n> s\n\n## D\n- [](https://a.example/)", "empty-title"));
  ok("URLの重複", has("# S\n\n> s\n\n## D\n- [a](https://a.example/x)\n- [b](https://a.example/x#top)", "duplicate-url"));
  ok("BOM があっても読める", !has("﻿# Site\n\n> s\n", "no-h1"));
  ok("CRLF でも読める", checkLlmsTxt("# S\r\n\r\n> s\r\n\r\n## D\r\n- [a](https://a.example/)\r\n").linkCount === 1);
  ok("コードフェンス内の # は見出しにしない", !has("# S\n\n> s\n\n```\n# not a heading\n## nor this\n```\n\n## D\n- [a](https://a.example/)", "heading-level"));
  ok(
    "コードフェンス内の ## を節にしない",
    checkLlmsTxt("# S\n\n> s\n\n```\n## fake\n```\n\n## D\n- [a](https://a.example/)").parsed.sections.length === 1,
  );
  ok("番号付きリストも項目として読む", checkLlmsTxt("# S\n\n> s\n\n## D\n1. [a](https://a.example/)\n").linkCount === 1);
  ok("* の箇条書きも読む", checkLlmsTxt("# S\n\n> s\n\n## D\n* [a](https://a.example/)\n").linkCount === 1);
  ok("リンクにタイトル文字列が付いていても読む", checkLlmsTxt('# S\n\n> s\n\n## D\n- [a](https://a.example/ "tip"): note\n').linkCount === 1);
}

// ---- 組み立て ----
{
  const doc: LlmsDoc = {
    title: "  My   Site ",
    summary: "line one\n\nline two",
    details: "Some details.\n\n- a\n- b",
    sections: [
      {
        heading: "Docs",
        links: [
          { title: "Guide [v2]", url: "https://example.com/a (copy).md", note: "multi\nline note" },
          { title: "", url: "https://example.com/skip", note: "" },
          { title: "NoUrl", url: "  ", note: "" },
        ],
      },
      { heading: "Empty", links: [] },
      { heading: "Later", optional: true, links: [{ title: "Old", url: "https://example.com/old", note: "" }] },
      { heading: "Also later", optional: true, links: [{ title: "Older", url: "https://example.com/older", note: "n" }] },
    ],
  };
  const text = buildLlmsTxt(doc);
  ok("題名の空白を畳む", text.startsWith("# My Site\n"));
  ok("要約は空行を詰めて > を付ける", text.includes("> line one\n> line two\n"));
  ok("空のリンクは出さない", !text.includes("skip") && !text.includes("NoUrl"));
  ok("空の節は出さない", !text.includes("## Empty"));
  ok("Optional は1つにまとめて最後", /## Optional\n\n- \[Old\][^\n]*\n- \[Older\][^\n]*\n$/.test(text), JSON.stringify(text.slice(-120)));
  ok("Optional の元の見出しは出ない", !text.includes("## Later") && !text.includes("## Also later"));
  ok("[ ] は丸括弧に置き換える(逃がさない)", text.includes("[Guide (v2)]"), text.split("\n").find((l) => l.includes("Guide")) ?? "");
  ok("URLの空白と括弧をパーセントに直す", text.includes("(https://example.com/a%20%28copy%29.md)"));
  ok("補足は1行にする", text.includes(": multi line note"));
  ok("末尾は改行1つ", text.endsWith("\n") && !text.endsWith("\n\n"));

  const back = checkLlmsTxt(text);
  ok("往復: 問題が無い", back.issues.filter((i) => i.level !== "info").length === 0, JSON.stringify(back.issues));
  ok("往復: 題名", back.parsed.title === "My Site");
  ok("往復: 丸括弧のまま読める", back.parsed.sections[0].links[0].title === "Guide (v2)");
  ok("往復: リンク数", back.linkCount === 3, String(back.linkCount));

  ok("題名が空なら何も出さない", buildLlmsTxt({ ...doc, title: "  " }) === "");
  ok("見出し空の節は Links に", buildLlmsTxt({ ...doc, sections: [{ heading: " ", links: [{ title: "a", url: "https://a.example/", note: "" }] }] }).includes("## Links"));
}

// ---- 例の文書 ----
{
  const text = buildLlmsTxt(EXAMPLE_DOC);
  const r = checkLlmsTxt(text);
  ok("例: 問題が無い", r.issues.length === 0, JSON.stringify(r.issues));
  ok("例: Optional が最後", r.parsed.sections[r.parsed.sections.length - 1].heading === OPTIONAL_HEADING);
}

// ---- リンク入力の読み取り ----
{
  const a = parseLinkLines("https://example.com/docs/get-started.html\n");
  ok("URLだけ: 名前を作る", a.links[0].title === "Get started", a.links[0].title);
  const b = parseLinkLines("Guide | https://example.com/g | the guide");
  ok("名前 | URL | 補足", b.links[0].title === "Guide" && b.links[0].url === "https://example.com/g" && b.links[0].note === "the guide");
  const c = parseLinkLines("https://example.com/g | Guide | the guide");
  ok("URL | 名前 | 補足", c.links[0].title === "Guide" && c.links[0].note === "the guide");
  const d = parseLinkLines("- [Guide](https://example.com/g): the guide");
  ok("Markdown のリンク", d.links[0].title === "Guide" && d.links[0].note === "the guide");
  const e = parseLinkLines("just words\n\nhttps://example.com/\n");
  ok("読めない行は skipped に", e.skipped.length === 1 && e.links.length === 1);
  ok("ルートURLはホスト名を名前に", e.links[0].title === "example.com", e.links[0].title);
  const f = parseLinkLines(
    `<?xml version="1.0"?><urlset><url><loc>https://example.com/a-b</loc></url><url><loc> https://example.com/c?x=1&amp;y=2 </loc></url></urlset>`,
  );
  ok("sitemap.xml の <loc> を拾う", f.links.length === 2 && f.links[1].url === "https://example.com/c?x=1&y=2", JSON.stringify(f.links));
  ok("名前の付け方: 拡張子とハイフン", titleFromUrl("https://example.com/a/api-reference.md") === "Api reference");
  ok("名前の付け方: 壊れたURLはそのまま", titleFromUrl("not a url") === "not a url");
}

// ---- 小さな部品 ----
{
  ok("cleanTitle", cleanTitle("a[b]\\c") === "a(b)\\c", cleanTitle("a[b]\\c"));
  ok("encodeUrl", encodeUrl(" https://a.example/x y(1) ") === "https://a.example/x%20y%281%29");
  const s = discoverySnippets();
  ok("公開用の <link>", s.html === '<link rel="describedby" href="/llms.txt">');
  ok("公開用の Link ヘッダー", s.header === 'Link: </llms.txt>; rel="describedby"');
  ok("パスの先頭に / を補う", discoverySnippets("docs/llms.txt").html.includes('href="/docs/llms.txt"'));
}

console.log(`${pass} 件通過 / ${failures.length} 件失敗`);
if (failures.length) {
  for (const f of failures) console.error("NG:", f);
  process.exit(1);
}
console.log("CHECK_OK");
