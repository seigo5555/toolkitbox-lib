/**
 * Ollama nginx Config Generator の検算。
 *
 * 期待値は、2026-11-03 に実際の nginx で確かめた結果に合わせている(自作の実装を自作の検証で確かめるだけにしないため)。
 *  - 下の FULL と MIN の出力は、公式イメージ nginx:1.29(1.29.8)と Ubuntu 24.04 の nginx(1.24.0)の両方で `nginx -t` が通る。
 *    どちらの nginx.conf も http の中で /etc/nginx/conf.d/*.conf を読む。
 *  - FULL を 1.29.8 で動かし、手元の Ollama 0.40.11 につないだ結果:
 *    80番は 301 で https へ、パスワード無し・違うパスワードは 401、正しいパスワードで 200、
 *    /api/chat の答えは 81 個に分かれて約6秒かけて届いた(proxy_buffering off)、許可リストから外したアドレスは 403。
 *  - Ollama は Host が ollama.example.com だと 403、localhost:9999 だと 200(Host は FAQ の localhost:11434 に固定する理由)。
 */
import { buildNginx, nginxCommands, type NginxInput } from "../src/ollama-nginx";

let pass = 0;
let fail = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++;
    console.error(`NG ${name}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

const FULL: NginxInput = {
  serverName: "ollama.example.com",
  https: true,
  cert: "/etc/ssl/ollama.crt",
  key: "/etc/ssl/ollama.key",
  redirect: true,
  auth: true,
  realm: "ollama box",
  userFile: "/etc/nginx/ollama.htpasswd",
  allow: "127.0.0.1\n172.16.0.0/12\n::1\n2001:db8::/32",
  upstream: "http://host.docker.internal:11434",
  stream: true,
  readTimeout: "300",
  maxBody: "20m",
};
const MIN: NginxInput = {
  ...FULL,
  https: false,
  redirect: false,
  auth: false,
  allow: "",
  readTimeout: "",
  maxBody: "",
  stream: false,
  serverName: "ollama.example.com www.ollama.example.com",
};
const codes = (o: Partial<NginxInput>) => buildNginx({ ...FULL, ...o }).problems.map((p) => `${p.code}:${p.field}`);

eq(
  "full",
  buildNginx(FULL).text,
  `server {
    listen 80;
    server_name ollama.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name ollama.example.com;

    ssl_certificate /etc/ssl/ollama.crt;
    ssl_certificate_key /etc/ssl/ollama.key;

    allow 127.0.0.1;
    allow 172.16.0.0/12;
    allow ::1;
    allow 2001:db8::/32;
    deny all;

    auth_basic "ollama box";
    auth_basic_user_file /etc/nginx/ollama.htpasswd;

    client_max_body_size 20m;

    location / {
        proxy_pass http://host.docker.internal:11434;
        proxy_set_header Host localhost:11434;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
`,
);
eq("full no problems", codes({}), []);
eq(
  "min",
  buildNginx(MIN).text,
  `server {
    listen 80;
    server_name ollama.example.com www.ollama.example.com;

    location / {
        proxy_pass http://host.docker.internal:11434;
        proxy_set_header Host localhost:11434;
        proxy_http_version 1.1;
    }
}
`,
);
eq("min warns open", buildNginx(MIN).problems.map((p) => p.code), ["noProtection"]);

// 既定の宛先は FAQ の例と同じ
eq("default upstream", buildNginx({ ...MIN, upstream: " " }).text.includes("proxy_pass http://localhost:11434;"), true);
// redirect は https のときだけ
eq("redirect needs https", buildNginx({ ...MIN, redirect: true }).text.includes("return 301"), false);

// 入力の検査
eq("server name missing", codes({ serverName: " " }), ["serverNameMissing:serverName"]);
eq("server name semicolon", codes({ serverName: "a.example.com;" }), ["badWord:serverName"]);
eq("cert missing", codes({ cert: "" }), ["certMissing:cert"]);
eq("key relative", codes({ key: "ollama.key" }), ["notAbsolute:key"]);
eq("cert with space", codes({ cert: "/etc/ssl/my cert.crt" }), ["badWord:cert"]);
eq("cert not checked without https", codes({ https: false, cert: "", auth: false, allow: "10.0.0.1" }), []);
eq("user file dollar", codes({ userFile: "/etc/nginx/$x" }), ["badWord:userFile"]);
eq("realm quote", codes({ realm: 'a"b' }), ["realmChars:realm"]);
eq("realm empty becomes ollama", buildNginx({ ...FULL, realm: " " }).text.includes('auth_basic "ollama";'), true);
for (const a of ["10.0.0.1", "10.0.0.0/8", "192.168.1.0/24", "::1", "2001:db8::/32", "fe80::1"]) eq(`addr ok ${a}`, codes({ allow: a }), []);
for (const a of ["10.0.0.256", "10.0.0.0/33", "example.com", "all", "2001:db8::/129"]) eq(`addr bad ${a}`, codes({ allow: a }), ["badAddress:allow"]);
eq("upstream https ok", codes({ upstream: "https://10.0.0.5:11434" }), []);
eq("upstream no scheme", codes({ upstream: "localhost:11434" }), ["upstreamFormat:upstream"]);
eq("upstream semicolon", codes({ upstream: "http://localhost:11434;" }), ["upstreamFormat:upstream"]);
for (const t of ["0", "1.5", "5m", "-1"]) eq(`timeout bad ${t}`, codes({ readTimeout: t }), ["timeoutFormat:readTimeout"]);
for (const s of ["0", "512k", "20m", "1G"]) eq(`size ok ${s}`, codes({ maxBody: s }), []);
for (const s of ["20 MB", "1.5m", "m"]) eq(`size bad ${s}`, codes({ maxBody: s }), ["sizeFormat:maxBody"]);
eq("auth without https", codes({ https: false, redirect: false }), ["authWithoutHttps:https"]);
eq("allow only is protection", codes({ auth: false }), []);

// コマンド
eq("commands auth", nginxCommands(FULL, "bob"), ["sudo htpasswd -c /etc/nginx/ollama.htpasswd bob", "sudo nginx -t", "sudo nginx -s reload"]);
eq("commands unsafe user", nginxCommands(FULL, "a b")[0], "sudo htpasswd -c /etc/nginx/ollama.htpasswd alice");
eq("commands no auth", nginxCommands(MIN, "bob"), ["sudo nginx -t", "sudo nginx -s reload"]);

console.log(`check-ollama-nginx: ${pass} checks passed`);
if (fail) {
  console.error(`${fail} failed`);
  process.exit(1);
}
