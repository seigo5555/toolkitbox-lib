/**
 * Ollama の前に置く nginx の server ブロックを組み立てる。
 *
 * 中身は2つの公式の資料から:
 *  - Ollama の FAQ(docs.ollama.com/faq)の例: `proxy_pass http://localhost:11434;` と `proxy_set_header Host localhost:11434;`
 *  - nginx のドキュメント(nginx.org/en/docs/): listen … ssl、ssl_certificate(_key)、auth_basic(_user_file)、
 *    allow / deny、client_max_body_size、proxy_http_version、proxy_buffering、proxy_read_timeout、return
 * 指令の組み合わせ方は当サイトのもの(公式の1つの例ではない)なので、画面で `nginx -t` を勧める。
 *
 * 値は nginx の設定の1語として書く。空白・`;`・`{`・`}`・`#`・引用符・`\`・`$` は、語の区切りや変数として
 * 読まれるので受け付けない(realm だけは `"` で囲んで書くので、空白は通す)。
 */

export const OLLAMA_NGINX_VERIFIED_ON = "2026-11-03";
export const NGINX_DOCS_URL = "https://nginx.org/en/docs/http/ngx_http_proxy_module.html";
export const OLLAMA_FAQ_PROXY_URL = "https://docs.ollama.com/faq";

export type NginxInput = {
  serverName: string;
  https: boolean;
  cert: string;
  key: string;
  /** 80番で受けた要求を https へ回す server を足す。 */
  redirect: boolean;
  auth: boolean;
  realm: string;
  userFile: string;
  /** 1行に1つ(アドレスか CIDR)。空なら allow / deny を書かない。 */
  allow: string;
  /** 例: http://localhost:11434 */
  upstream: string;
  stream: boolean;
  /** 秒。空なら書かない(nginx の既定は 60s)。 */
  readTimeout: string;
  /** 例: 20m。空なら書かない(nginx の既定は 1m)。 */
  maxBody: string;
};

export type ProblemCode =
  | "serverNameMissing"
  | "badWord"
  | "notAbsolute"
  | "certMissing"
  | "badAddress"
  | "upstreamFormat"
  | "timeoutFormat"
  | "sizeFormat"
  | "realmChars"
  | "noProtection"
  | "authWithoutHttps";

export type Problem = { code: ProblemCode; field: string; severity: "error" | "warn" };

/** nginx の1語として書けない文字。 */
const BAD_WORD = /[\s;{}#"'\\$]/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/([12]?\d|3[0-2]))?$/;
const IPV6 = /^[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(\/(12[0-8]|1[01]\d|[1-9]?\d))?$/;
const UPSTREAM = /^https?:\/\/[A-Za-z0-9.\-[\]:]+(\/[^\s;{}#"'\\$]*)?$/;
const TIMEOUT = /^[1-9]\d*$/;
/** nginx の大きさ: 数に k / m / g(大文字も可)。0 は検査をしない、の意味。 */
const SIZE = /^\d+[kKmMgG]?$/;

export const DEFAULT_UPSTREAM = "http://localhost:11434";

/**
 * Host は FAQ の例のまま localhost:11434 にする。Ollama は知らない名前の Host を 403 で断る
 * (2026-11-03 に 0.40.11 で、ollama.example.com は 403、localhost:9999 は 200 を確認)。
 * 宛先のポートが違っても、名前が localhost なら通る。
 */
export const HOST_HEADER = "localhost:11434";

export function buildNginx(input: NginxInput): { text: string; problems: Problem[] } {
  const problems: Problem[] = [];
  const p = (code: ProblemCode, field: string, severity: "error" | "warn" = "error") => problems.push({ code, field, severity });

  const names = input.serverName.trim().split(/\s+/).filter(Boolean);
  if (!names.length) p("serverNameMissing", "serverName");
  for (const n of names) if (BAD_WORD.test(n)) p("badWord", "serverName");

  const word = (field: keyof NginxInput, v: string, abs = true) => {
    if (BAD_WORD.test(v)) p("badWord", field);
    else if (abs && !v.startsWith("/")) p("notAbsolute", field);
  };

  const cert = input.cert.trim();
  const key = input.key.trim();
  if (input.https) {
    if (!cert) p("certMissing", "cert");
    else word("cert", cert);
    if (!key) p("certMissing", "key");
    else word("key", key);
  }

  const userFile = input.userFile.trim();
  const realm = input.realm.trim() || "ollama";
  if (input.auth) {
    if (!userFile) p("notAbsolute", "userFile");
    else word("userFile", userFile);
    if (/["\\$]/.test(realm)) p("realmChars", "realm");
  }

  const addrs = input.allow.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const a of addrs) if (!IPV4.test(a) && !IPV6.test(a)) p("badAddress", "allow");

  const upstream = input.upstream.trim() || DEFAULT_UPSTREAM;
  if (!UPSTREAM.test(upstream)) p("upstreamFormat", "upstream");

  const timeout = input.readTimeout.trim();
  if (timeout && !TIMEOUT.test(timeout)) p("timeoutFormat", "readTimeout");
  const maxBody = input.maxBody.trim();
  if (maxBody && !SIZE.test(maxBody)) p("sizeFormat", "maxBody");

  if (!input.auth && !addrs.length) p("noProtection", "auth", "warn");
  if (input.auth && !input.https) p("authWithoutHttps", "https", "warn");

  const name = names.join(" ") || "ollama.example.com";
  const out: string[] = [];
  if (input.https && input.redirect) {
    out.push("server {", "    listen 80;", `    server_name ${name};`, "    return 301 https://$host$request_uri;", "}", "");
  }
  out.push("server {");
  if (input.https) out.push("    listen 443 ssl;");
  else out.push("    listen 80;");
  out.push(`    server_name ${name};`);
  if (input.https) out.push("", `    ssl_certificate ${cert || "/etc/ssl/ollama.crt"};`, `    ssl_certificate_key ${key || "/etc/ssl/ollama.key"};`);
  if (addrs.length) out.push("", ...addrs.map((a) => `    allow ${a};`), "    deny all;");
  if (input.auth) out.push("", `    auth_basic "${realm}";`, `    auth_basic_user_file ${userFile || "/etc/nginx/ollama.htpasswd"};`);
  if (maxBody) out.push("", `    client_max_body_size ${maxBody};`);
  out.push(
    "",
    "    location / {",
    `        proxy_pass ${upstream};`,
    `        proxy_set_header Host ${HOST_HEADER};`,
    "        proxy_http_version 1.1;",
  );
  if (input.stream) out.push("        proxy_buffering off;");
  if (timeout) out.push(`        proxy_read_timeout ${timeout}s;`);
  out.push("    }", "}");
  return { text: out.join("\n") + "\n", problems };
}

/** パスワードの作成(当サイトの補い。nginx のドキュメントは htpasswd の名前だけを挙げる)と、設定の検査・読み直し。 */
export function nginxCommands(input: NginxInput, user: string) {
  const cmds: string[] = [];
  const file = input.userFile.trim() || "/etc/nginx/ollama.htpasswd";
  const u = user.trim() || "alice";
  if (input.auth) cmds.push(`sudo htpasswd -c ${file} ${/^[A-Za-z0-9._-]+$/.test(u) ? u : "alice"}`);
  cmds.push("sudo nginx -t", "sudo nginx -s reload");
  return cmds;
}
