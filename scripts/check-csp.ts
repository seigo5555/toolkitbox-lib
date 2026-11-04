/**
 * CSPの読み解きの検算。
 *
 * CSPは書式として正しくても効いていないことがある。構文チェックでは
 * 見つからないので、意味の側の判定が正しいかを確かめておく。
 * とくに **frame-ancestors / base-uri / form-action は default-src を
 * 引き継がない** という点は、間違えると「守れているつもり」を作ってしまう。
 *
 * 実行: npm run check
 */
import { parseCsp, analyzeCsp, missingRecommended, DIRECTIVES, STARTER_POLICY, type IssueCode } from "../src/csp";

let bad = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) bad++;
  console.log((ok ? "OK " : "NG ") + label.padEnd(48) + g + (ok ? "" : `   期待: ${w}`));
};
const codes = (policy: string) => analyzeCsp(parseCsp(policy)).map((i) => i.code).sort();
const has = (policy: string, code: IssueCode) => codes(policy).includes(code);

// 読み取り
eq("指令に分ける", parseCsp("default-src 'self'; script-src 'self' https://a.example"),
   [{ name: "default-src", values: ["'self'"] }, { name: "script-src", values: ["'self'", "https://a.example"] }]);
eq("ヘッダー名が付いていても読む", parseCsp("Content-Security-Policy: default-src 'self'")[0].name, "default-src");
eq("改行と余分な空白", parseCsp("default-src 'self';\n  script-src  'self' ").length, 2);
eq("空", parseCsp(""), []);

// 危険なもの
eq("unsafe-inline を危険と見る", has("script-src 'unsafe-inline'", "unsafe-inline-script"), true);
eq("  nonce があれば無視されると伝える", has("script-src 'nonce-abc123' 'unsafe-inline'", "unsafe-inline-ignored"), true);
eq("  そのとき危険とは言わない", has("script-src 'nonce-abc123' 'unsafe-inline'", "unsafe-inline-script"), false);
eq("unsafe-eval", has("script-src 'unsafe-eval'", "unsafe-eval"), true);
eq("script-src の *", has("script-src *", "wildcard-script"), true);
eq("  img-src の * は指摘しない", has("img-src *", "wildcard-script"), false);
eq("script-src の data:", has("script-src data:", "data-in-script"), true);
eq("  img-src の data: は指摘しない", has("img-src data:", "data-in-script"), false);
eq("http:// のソース", has("script-src http://a.example", "http-source"), true);
eq("strict-dynamic に nonce が無い", has("script-src 'strict-dynamic'", "strict-dynamic-without-nonce"), true);
eq("  nonce があれば指摘しない", has("script-src 'strict-dynamic' 'nonce-abc'", "strict-dynamic-without-nonce"), false);

// default-src を引き継がないもの
eq("frame-ancestors は引き継がない", DIRECTIVES["frame-ancestors"].fallsBack, false);
eq("base-uri は引き継がない", DIRECTIVES["base-uri"].fallsBack, false);
eq("form-action は引き継がない", DIRECTIVES["form-action"].fallsBack, false);
eq("script-src は引き継ぐ", DIRECTIVES["script-src"].fallsBack, true);
eq("default-src があっても base-uri を促す", has("default-src 'self'", "no-base-uri"), true);
eq("default-src があっても frame-ancestors を促す", has("default-src 'self'", "no-frame-ancestors"), true);
eq("  書いてあれば促さない", has("default-src 'self'; base-uri 'none'; frame-ancestors 'none'", "no-base-uri"), false);

// 非推奨・不明
eq("report-uri は非推奨", has("report-uri /x", "deprecated"), true);
eq("child-src は非推奨", has("child-src 'self'", "deprecated"), true);
eq("知らない指令", has("scrpit-src 'self'", "unknown-directive"), true);

// 足りない指令
eq("足りない指令を挙げる", missingRecommended(parseCsp("script-src 'self'")),
   ["default-src", "object-src", "base-uri", "frame-ancestors", "form-action"]);

// 出発点として出すものが自分の判定で通ること
const starterIssues = analyzeCsp(parseCsp(STARTER_POLICY));
eq("出発点の方針に危険が無い", starterIssues.filter((i) => i.level === "danger").length, 0);
eq("  警告も無い", starterIssues.filter((i) => i.level === "warning").map((i) => i.code), []);
console.log("   出発点:", STARTER_POLICY);

console.log(bad === 0 ? "全て一致" : `失敗 ${bad} 件`);
if (bad > 0) process.exitCode = 1;
