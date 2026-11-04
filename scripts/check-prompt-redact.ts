/**
 * Prompt Redactor の検算。
 *
 * 壊れ方は2種類ある。
 *  1. 伏せ漏れ … 秘密が出力に残る。いちばん危険。画面は何事も無かったように見える
 *  2. 伏せすぎ … ふつうの文章(バージョン番号、ミリ秒のタイムスタンプ、日付)まで
 *     伏せて、プロンプトが読めなくなる。使われなくなる
 * そして伏せ字を元に戻せなければ、AIの答えを使えない。
 *
 * 確かめるのは次の点。
 *  - 公式ドキュメント・RFCにある例の値を、そのまま伏せられるか(出典は src/lib/prompt-redact.ts の冒頭)
 *  - 公式に例が無い形式は、このスクリプトで作った架空の値(実在のキーではない)
 *  - 伏せたあと、秘密の値が出力のどこにも残っていないか(擬似乱数で3000通り)
 *  - restore(redact(x)) が x と完全に一致するか(同じく)
 *  - 秘密を含まないふつうの文章が、1文字も変わらないか
 *
 * 実行: npm run check
 */
import { DETECTORS, looksLikeCard, luhn, redact, restore, type DetectorId } from "../src/prompt-redact";

let pass = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};
const eq = (label: string, got: unknown, want: unknown) => ok(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);

const ALL = new Set<DetectorId>(DETECTORS.map((d) => d.id));
const only = (...ids: DetectorId[]) => new Set<DetectorId>(ids);

// ---- 公式の例 ----
const AWS = "AKIAIOSFODNN7EXAMPLE"; // AWS IAM ドキュメントの例
const AWS2 = "AKIAI44QH8DHBEXAMPLE";
const SLACK = "xoxp-" + "111-222-333-d6bc768406e5c2e6958cfc399b438004"; // docs.slack.dev の例
const GOOGLE = "AIza" + "SyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe"; // Google Cloud ドキュメントの例
const JWT = "eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // RFC 7519 §3.1
const BEARER = "mF_9.B5f-4.1JqM"; // RFC 6750
const BASIC = "QWxhZGRpbjpvcGVuIHNlc2FtZQ=="; // RFC 7617
const VISA = "4242424242424242"; // Stripe のテストカード
// ---- 架空の値(公式に例が無い形式)----
const GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const GH_PAT = "github_pat_" + "11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ0123456789abcdefghijklmnop";
const STRIPE = "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc";
const ANTH = "sk-ant-api03-" + "AbCdEf0123456789_-AbCdEf0123456789";
const OPENAI = "sk-" + "proj-AbCdEf0123456789AbCdEf0123456789";
const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----";

function one(label: string, input: string, ids: DetectorId[], secret: string, ph: string) {
  const r = redact(input, only(...ids));
  ok(`${label}: 伏せる`, !r.output.includes(secret), r.output);
  ok(`${label}: 伏せ字`, r.output.includes(ph), r.output);
  eq(`${label}: 元に戻る`, restore(r.output, r.map), input);
}

one("AWS アクセスキーID", `key=${AWS} and ${AWS2}`.replace("key=", "id: "), ["awsKey"], AWS, "[AWS_KEY_1]");
one("Slack トークン", `token ${SLACK}`, ["slackToken"], SLACK, "[SLACK_TOKEN_1]");
one("JWT(RFC 7519 の例)", `jwt: ${JWT}`, ["jwt"], JWT, "[JWT_1]");
one("GitHub ghp_", `use ${GH} here`, ["githubToken"], GH, "[GITHUB_TOKEN_1]");
one("GitHub github_pat_", `use ${GH_PAT} here`, ["githubToken"], GH_PAT, "[GITHUB_TOKEN_1]");
one("Stripe sk_live_", `${STRIPE}`, ["stripeKey"], STRIPE, "[STRIPE_KEY_1]");
one("Anthropic sk-ant-api", `${ANTH}`, ["anthropicKey"], ANTH, "[ANTHROPIC_KEY_1]");
one("OpenAI の形(推測)", `${OPENAI}`, ["apiKeyShape"], OPENAI, "[API_KEY_1]");
one("Google API キー(例)", `key=${GOOGLE}`, ["apiKeyShape"], GOOGLE, "[API_KEY_1]");
one("秘密鍵(PEM)", `before\n${PEM}\nafter`, ["privateKey"], "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "[PRIVATE_KEY_1]");
{
  const r = redact(`-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA`, only("privateKey"));
  ok("END の無い(途中で切れた)秘密鍵も文末まで伏せる", !r.output.includes("b3BlbnNzaC1r"), r.output);
}
one("Authorization: Bearer(RFC 6750 の例)", `Authorization: Bearer ${BEARER}`, ["authHeader"], BEARER, "[AUTH_TOKEN_1]");
one("Authorization: Basic(RFC 7617 の例)", `Authorization: Basic ${BASIC}`, ["authHeader"], BASIC, "[AUTH_TOKEN_1]");
{
  const r = redact(`Authorization: Bearer ${BEARER}`, only("authHeader"));
  ok("Authorization の見出しは残す", r.output.startsWith("Authorization: Bearer "), r.output);
}
one("URLの user:password@", "postgres://admin:s3cretPass99@db.example.com:5432/app", ["urlCredentials"], "s3cretPass99", "[URL_CREDENTIALS_1]");
{
  const r = redact("postgres://admin:s3cretPass99@db.example.com:5432/app", only("urlCredentials"));
  ok("URLのホストとパスは残す", r.output.includes("@db.example.com:5432/app") && r.output.startsWith("postgres://"), r.output);
  const none = redact("https://example.com/path?a=b@c", only("urlCredentials"));
  ok("認証情報の無いURLは触らない", none.output === "https://example.com/path?a=b@c");
}
one("代入(password = ...)", 'password = "hunter2hunter2"', ["secretAssignment"], "hunter2hunter2", "[SECRET_1]");
one("代入(API_KEY=...)", "export API_KEY=abc123def456ghi", ["secretAssignment"], "abc123def456ghi", "[SECRET_1]");
one("代入(JSON の \"token\": \"...\")", '{"access_token": "zzzTOPSECRETzzz"}', ["secretAssignment"], "zzzTOPSECRETzzz", "[SECRET_1]");
{
  const r = redact("api_key = true\ntoken_count = 12345\nsecret: null", only("secretAssignment"));
  ok("真偽値・短い数・null は伏せない", r.output === "api_key = true\ntoken_count = 12345\nsecret: null", r.output);
}
{
  // 全部を有効にしたとき、Authorization の Bearer(認証方式の名前)は残り、資格情報だけが伏せられる。
  const r = redact(`curl -H "Authorization: Bearer ${BEARER}" https://example.com`, ALL);
  ok("Bearer の語は残し、資格情報だけ伏せる", r.output.includes("Authorization: Bearer [AUTH_TOKEN_1]") && !r.output.includes(BEARER), r.output);
}
one("メール", "mail ada.lovelace+test@example.co.uk now", ["email"], "ada.lovelace+test@example.co.uk", "[EMAIL_1]");
one("IPv4", "server 203.0.113.20 and 10.0.0.1", ["ipv4"], "203.0.113.20", "[IP_1]");
{
  const r = redact("ver 1.2.3, 256.1.1.1, 1.2.3.4.5, 999.999.999.999", only("ipv4"));
  ok("バージョン番号・範囲外の数は IP と見なさない", r.output === "ver 1.2.3, 256.1.1.1, 1.2.3.4.5, 999.999.999.999", r.output);
}

// ---- カード番号 ----
ok("Luhn: 4242424242424242 は通る", luhn(VISA));
ok("Luhn: 4242424242424241 は通らない", !luhn("4242424242424241"));
one("カード(Stripe のテスト番号)", `card ${VISA}`, ["card"], VISA, "[CARD_1]");
one("カード(空白区切り)", "card 4242 4242 4242 4242 end", ["card"], "4242 4242 4242 4242", "[CARD_1]");
one("カード(ハイフン区切り)", "card 4242-4242-4242-4242 end", ["card"], "4242-4242-4242-4242", "[CARD_1]");
{
  const r = redact("card 4242424242424241", only("card"));
  ok("Luhn に通らない数字は伏せない", r.output === "card 4242424242424241");
  // 13桁のミリ秒タイムスタンプは偶然 Luhn に通ることがある。先頭桁で除く。
  let falsePos = 0;
  for (let t = 1792713600000; t < 1792713600000 + 5000; t++) if (looksLikeCard(String(t))) falsePos++;
  ok(`ミリ秒のタイムスタンプ 5000個を、カードと見なさない(誤検出 ${falsePos})`, falsePos === 0);
  ok("先頭が 1 や 2 の数はカードと見なさない", !looksLikeCard("1234567812345670") && !looksLikeCard("2234567812345678"));
}

// ---- 同じ値には同じ伏せ字、重なりの扱い ----
{
  const r = redact("a@x.com wrote to b@x.com, then a@x.com again", only("email"));
  eq("同じ値は同じ伏せ字、違う値は別の番号", r.output, "[EMAIL_1] wrote to [EMAIL_2], then [EMAIL_1] again");
  eq("見つけた件数", r.counts.email, 3);
  eq("伏せ字の対応表", r.map, { "[EMAIL_1]": "a@x.com", "[EMAIL_2]": "b@x.com" });
}
{
  const r = redact(`postgres://u:${GH}@h/db`, ALL);
  ok("重なったら1か所だけ伏せる(二重に伏せない)", !r.output.includes(GH) && !/\[[A-Z_]+_\d+\]\S*\[[A-Z_]+_\d+\]/.test(r.output.replace("postgres://", "")), r.output);
  eq("重なっても元に戻る", restore(r.output, r.map), `postgres://u:${GH}@h/db`);
}
{
  // 元の文章に [EMAIL_1] がすでにある。区別できないと元に戻したとき壊れる。
  const input = "keep [EMAIL_1] as is, mail a@x.com";
  const r = redact(input, only("email"));
  ok("元の文章にある [EMAIL_1] と取り違えない", r.output.includes("[EMAIL_2]") && r.output.includes("[EMAIL_1] as is"), r.output);
  eq("元の文章に伏せ字がある場合も、元に戻る", restore(r.output, r.map), input);
}
eq("restore: 知らない伏せ字はそのまま", restore("[EMAIL_9] and [EMAIL_1]", { "[EMAIL_1]": "a@x.com" }), "[EMAIL_9] and a@x.com");
eq("restore: 元の値に $& を含んでも展開しない", restore("[SECRET_1]", { "[SECRET_1]": "a$&b$1" }), "a$&b$1");
eq("restore: 対応表が空なら何もしない", restore("[EMAIL_1]", {}), "[EMAIL_1]");
{
  const r = redact("a@x.com", new Set());
  ok("何も選ばなければ何も伏せない", r.output === "a@x.com" && r.findings.length === 0);
}

// ---- 伏せすぎない: ふつうの文章は1文字も変えない ----
const PLAIN = [
  "Please explain why this function returns undefined when the list is empty.",
  "Version 1.2.3 released on 2026-10-23 at 10:15:32 +0900; build 4821.",
  "timestamp 1792713600000 and 1792713600 and 0x1F and 3.14159",
  "UUID 550e8400-e29b-41d4-a716-446655440000 and sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "https://example.com/path/to/page?query=1#section and /usr/local/bin/node",
  "const token_count = 42; // how many tokens; password policy: 12 characters minimum",
  "日本語の文章です。電話は使いません。2026年10月23日。",
  "a.b@c is not an email; user@localhost neither; 100% sure; 5 + 3 = 8",
  "function sk(x) { return x.ghp ? 1 : 0 } // sk-short AKIA short xoxb-1",
  "ISO 8601: 2026-10-23T09:00:00+09:00, IPv6 2001:db8::1, MAC 00:1A:2B:3C:4D:5E",
  "author = jonathan; authority: statement; authentication: required; Authorization header explained",
];
for (const p of PLAIN) {
  const r = redact(p, ALL);
  ok(`ふつうの文章は変えない: ${p.slice(0, 40)}`, r.output === p && r.findings.length === 0, r.output);
}

// ---- 擬似乱数での突き合わせ ----
let seed = 20261023;
const rnd = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const rs = (n: number, chars = alnum) => Array.from({ length: n }, () => chars[Math.floor(rnd() * chars.length)]).join("");

/** 秘密を1つ作る。{ text: 文章に入れる形, secret: 出力に残ってはいけない部分 } */
function makeSecret(): { text: string; secret: string } {
  const kind = Math.floor(rnd() * 12);
  switch (kind) {
    case 0: { const s = "AKIA" + rs(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"); return { text: s, secret: s }; }
    case 1: { const s = "ghp_" + rs(36); return { text: s, secret: s }; }
    case 2: { const s = "github_pat_" + rs(50) ; return { text: s, secret: s }; }
    case 3: { const s = `xoxb-${rs(11, "0123456789")}-${rs(12, "0123456789")}-${rs(24)}`; return { text: s, secret: s }; }
    case 4: { const s = `${pick(["sk", "pk", "rk"])}_${pick(["live", "test"])}_${rs(24)}`; return { text: s, secret: s }; }
    case 5: { const s = "sk-ant-api03-" + rs(40, alnum + "_-"); return { text: s, secret: s }; }
    case 6: { const h = Buffer.from('{"alg":"HS256"}').toString("base64url"); const s = `${h}.${Buffer.from(JSON.stringify({ n: rs(8) })).toString("base64url")}.${rs(43, alnum + "_-")}`; return { text: s, secret: s }; }
    case 7: { const v = rs(10 + Math.floor(rnd() * 10)); return { text: `${pick(["password", "API_KEY", "client_secret", "auth_token"])} = "${v}"`, secret: v }; }
    case 8: { const v = rs(8 + Math.floor(rnd() * 8)); return { text: `postgres://${rs(5, "abcdefghij")}:${v}@db.example.com/app`, secret: v }; }
    case 9: { const e = `${rs(6, "abcdefghij")}.${rs(4, "klmnopqrst")}@${rs(6, "abcdefghij")}.example.com`; return { text: e, secret: e }; }
    case 10: { const ip = `${1 + Math.floor(rnd() * 223)}.${Math.floor(rnd() * 256)}.${Math.floor(rnd() * 256)}.${Math.floor(rnd() * 256)}`; return { text: ip, secret: ip }; }
    default: { const c = pick([VISA, "5555555555554444", "378282246310005", "6011111111111117"]); return { text: c, secret: c }; }
  }
}
const FILLER = ["Please review this:", "the server said", "then run", "error at line 12 —", "日本語のメモ", "```\n", "\n", "  ", "version 2.4.1", "count=12", "—", ","];

let leak = 0;
let roundTrip = 0;
for (let i = 0; i < 3000; i++) {
  const parts: string[] = [];
  const secrets: string[] = [];
  for (let n = 1 + Math.floor(rnd() * 5); n > 0; n--) {
    parts.push(pick(FILLER));
    if (rnd() < 0.7) {
      const s = makeSecret();
      parts.push(s.text);
      secrets.push(s.secret);
    }
  }
  parts.push(pick(FILLER));
  const text = parts.join(" ");
  const r = redact(text, ALL);
  const leaked = secrets.filter((s) => r.output.includes(s));
  if (leaked.length) {
    leak++;
    if (leak <= 3) failures.push(`乱数: 伏せ漏れ ${JSON.stringify(leaked[0])} in ${JSON.stringify(text.slice(0, 100))}`);
  }
  if (restore(r.output, r.map) !== text) {
    roundTrip++;
    if (roundTrip <= 3) failures.push(`乱数: 元に戻らない ${JSON.stringify(text.slice(0, 100))}`);
  }
}
ok(`乱数 3000通り: 秘密が出力に残らない(失敗 ${leak})`, leak === 0);
ok(`乱数 3000通り: restore(redact(x)) が x と一致(失敗 ${roundTrip})`, roundTrip === 0);

console.log(`\n[check:prompt-redact] ${pass} 件成功 / ${failures.length} 件失敗`);
if (failures.length) {
  for (const f of failures) console.error("  NG " + f);
  process.exit(1);
}
