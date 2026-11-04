/**
 * Ollama systemd Override Generator の検算。
 *
 * 期待値は、2026-11-03 に Ubuntu 24.04 の systemd 255(255.4-1ubuntu8.18)のコンテナで確かめた結果に合わせている
 * (自作の実装を自作の検証で確かめるだけにしないため)。
 *  - `systemctl edit ollama.service` の一時ファイルの印「### Anything between here and the comment below…」の間に貼ると、
 *    /etc/systemd/system/ollama.service.d/override.conf に保存される
 *  - `"NAME=値"` の形なら、値の空白・`$`・`'`・`;`・`*`・`=` はそのまま、`%%` は `%` としてサービスに渡る
 *  - `systemctl show ollama --property=Environment` で、渡った値を読める
 */
import { buildOverride, overrideCommands, shellWord } from "../src/ollama-systemd";

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

const codes = (i: Record<string, string>) => buildOverride(i).problems.map((p) => `${p.code}:${p.name}`);

// 何も入れなければ [Service] だけ
eq("empty", buildOverride({}).text, "[Service]\n");
eq("blank ignored", buildOverride({ OLLAMA_HOST: "  " }).text, "[Service]\n");

// FAQ の例そのもの
eq("faq example", buildOverride({ OLLAMA_HOST: "0.0.0.0:11434" }).text, '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\n');

// コンテナの systemd で往復させた入力と、そのときの override.conf
const roundTrip = {
  OLLAMA_HOST: "0.0.0.0:11434",
  OLLAMA_MODELS: "/srv/ollama models/100%",
  OLLAMA_KEEP_ALIVE: "-1m",
  OLLAMA_CONTEXT_LENGTH: "8192",
  OLLAMA_NUM_PARALLEL: "2",
  OLLAMA_MAX_LOADED_MODELS: "1",
  OLLAMA_MAX_QUEUE: "64",
  OLLAMA_FLASH_ATTENTION: "1",
  OLLAMA_KV_CACHE_TYPE: "q8_0",
  OLLAMA_ORIGINS: "chrome-extension://*,moz-extension://*,https://a.example.com",
  OLLAMA_NO_CLOUD: "x",
  HTTPS_PROXY: "https://proxy.example.com:3128/$HOME;'x'=y",
};
eq(
  "round trip text",
  buildOverride(roundTrip).text,
  [
    "[Service]",
    'Environment="OLLAMA_HOST=0.0.0.0:11434"',
    'Environment="OLLAMA_MODELS=/srv/ollama models/100%%"',
    'Environment="OLLAMA_KEEP_ALIVE=-1m"',
    'Environment="OLLAMA_CONTEXT_LENGTH=8192"',
    'Environment="OLLAMA_NUM_PARALLEL=2"',
    'Environment="OLLAMA_MAX_LOADED_MODELS=1"',
    'Environment="OLLAMA_MAX_QUEUE=64"',
    'Environment="OLLAMA_FLASH_ATTENTION=1"',
    'Environment="OLLAMA_KV_CACHE_TYPE=q8_0"',
    'Environment="OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*,https://a.example.com"',
    'Environment="OLLAMA_NO_CLOUD=1"',
    "Environment=\"HTTPS_PROXY=https://proxy.example.com:3128/$HOME;'x'=y\"",
  ].join("\n") + "\n",
);
eq("round trip only exposed", codes(roundTrip), ["exposed:OLLAMA_HOST"]);
eq("set list", buildOverride({ OLLAMA_HOST: "127.0.0.1:11434", OLLAMA_NO_CLOUD: "1" }).set, ["OLLAMA_HOST", "OLLAMA_NO_CLOUD"]);

// 受け付けない文字(囲みの中でエスケープとして読まれる)
eq("double quote", codes({ OLLAMA_ORIGINS: 'a"b' }), ["badChar:OLLAMA_ORIGINS"]);
eq("backslash", codes({ OLLAMA_MODELS: "/a\\b" }), ["badChar:OLLAMA_MODELS"]);
eq("control char", codes({ OLLAMA_ORIGINS: "a\tb" }), ["badChar:OLLAMA_ORIGINS"]);
eq("bad char not written", buildOverride({ OLLAMA_ORIGINS: 'a"b' }).text, "[Service]\n");

// 数
eq("count ok", codes({ OLLAMA_NUM_PARALLEL: "4" }), []);
for (const v of ["0", "-1", "1.5", "4k", "08"]) eq(`count ${v}`, codes({ OLLAMA_NUM_PARALLEL: v }), ["notCount:OLLAMA_NUM_PARALLEL"]);

// 保存先
eq("path relative", codes({ OLLAMA_MODELS: "models" }), ["notAbsolute:OLLAMA_MODELS"]);
eq("path ok", codes({ OLLAMA_MODELS: "/data/ollama" }), []);

// keep_alive(FAQ: "10m"・"24h"・3600・-1・"-1m"・0)
for (const v of ["10m", "24h", "3600", "-1", "-1m", "0", "1h30m", "1.5h"]) eq(`keep ${v}`, codes({ OLLAMA_KEEP_ALIVE: v }), []);
for (const v of ["5 min", "forever", "10M", "m"]) eq(`keep bad ${v}`, codes({ OLLAMA_KEEP_ALIVE: v }), ["durationFormat:OLLAMA_KEEP_ALIVE"]);

// 待ち受け
for (const v of ["127.0.0.1:11434", "127.0.0.1", "localhost:11434", "[::1]:11434"]) eq(`host local ${v}`, codes({ OLLAMA_HOST: v }), []);
for (const v of ["0.0.0.0:11434", "0.0.0.0", "192.168.1.10:11434", "[::]:11434"]) eq(`host exposed ${v}`, codes({ OLLAMA_HOST: v }), ["exposed:OLLAMA_HOST"]);
for (const v of ["http://0.0.0.0:11434", ":11434", "a b"]) eq(`host format ${v}`, codes({ OLLAMA_HOST: v }), ["hostFormat:OLLAMA_HOST"]);

// K/V キャッシュの量子化と Flash Attention
eq("kv q4 with fa off", codes({ OLLAMA_KV_CACHE_TYPE: "q4_0", OLLAMA_FLASH_ATTENTION: "0" }), ["kvWithoutFlash:OLLAMA_KV_CACHE_TYPE"]);
eq("kv q8 auto fa", codes({ OLLAMA_KV_CACHE_TYPE: "q8_0" }), []);
eq("kv f16 fa off", codes({ OLLAMA_KV_CACHE_TYPE: "f16", OLLAMA_FLASH_ATTENTION: "0" }), []);

// プロキシの URL に認証情報
eq("proxy creds", codes({ HTTPS_PROXY: "https://user:pass@proxy.example.com:3128" }), ["proxyCredentials:HTTPS_PROXY"]);
eq("proxy plain", codes({ HTTPS_PROXY: "https://proxy.example.com:3128" }), []);

// コマンド
eq("commands", overrideCommands({}), [
  "sudo systemctl edit ollama.service",
  "sudo systemctl daemon-reload",
  "sudo systemctl restart ollama",
  "systemctl show ollama --property=Environment",
]);
eq("commands models", overrideCommands({ OLLAMA_MODELS: "/srv/ollama models" }).slice(0, 2), [
  "sudo mkdir -p '/srv/ollama models'",
  "sudo chown -R ollama:ollama '/srv/ollama models'",
]);
eq("commands relative models skipped", overrideCommands({ OLLAMA_MODELS: "models" }).length, 4);
eq("shell word plain", shellWord("/data/ollama"), "/data/ollama");
eq("shell word quote", shellWord("/a'b"), "'/a'\\''b'");

console.log(`check-ollama-systemd: ${pass} checks passed`);
if (fail) {
  console.error(`${fail} failed`);
  process.exit(1);
}
