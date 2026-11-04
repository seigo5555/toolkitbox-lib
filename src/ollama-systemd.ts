/**
 * Ollama を systemd で動かすときの、環境変数の上書き(drop-in)を組み立てる。
 *
 * 変数は Ollama の FAQ(docs.ollama.com/faq)に載っているものだけ。手順も FAQ のとおり
 * (`systemctl edit ollama.service` → `[Service]` の下に `Environment=` → daemon-reload → restart)。
 *
 * 書き方は systemd.exec(5) の Environment= に合わせる。
 *  - 値に空白や `=` があるときは代入全体を `"` で囲む → いつも `"NAME=値"` の形にする。
 *  - `$` は特別な意味を持たない(変数は展開されない)。
 *  - 指定子(`%h` など)は展開される → `%` は `%%` にする。
 *  - 囲みの中の `\` と `"` はエスケープとして読まれる(systemd.syntax(7) の Quoting)ので、入力では受け付けない。
 *    印字できない文字も、値として拒まれる。
 */

export const OLLAMA_SYSTEMD_VERIFIED_ON = "2026-11-03";
export const OLLAMA_FAQ_URL = "https://docs.ollama.com/faq";
export const SYSTEMD_EXEC_URL = "https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html";

export type VarKind = "host" | "path" | "duration" | "count" | "flag01" | "kvType" | "text" | "on";

/** FAQ の順に近い並び。def は FAQ に書かれた既定値(書かれていなければ空)。 */
export const VARS: { name: string; kind: VarKind; def: string }[] = [
  { name: "OLLAMA_HOST", kind: "host", def: "127.0.0.1:11434" },
  { name: "OLLAMA_MODELS", kind: "path", def: "/usr/share/ollama/.ollama/models" },
  { name: "OLLAMA_KEEP_ALIVE", kind: "duration", def: "5m" },
  { name: "OLLAMA_CONTEXT_LENGTH", kind: "count", def: "4096" },
  { name: "OLLAMA_NUM_PARALLEL", kind: "count", def: "1" },
  { name: "OLLAMA_MAX_LOADED_MODELS", kind: "count", def: "3" },
  { name: "OLLAMA_MAX_QUEUE", kind: "count", def: "512" },
  { name: "OLLAMA_FLASH_ATTENTION", kind: "flag01", def: "" },
  { name: "OLLAMA_KV_CACHE_TYPE", kind: "kvType", def: "f16" },
  { name: "OLLAMA_ORIGINS", kind: "text", def: "" },
  { name: "OLLAMA_NO_CLOUD", kind: "on", def: "" },
  { name: "HTTPS_PROXY", kind: "text", def: "" },
];

/** FAQ に載っている K/V キャッシュの型。 */
export const KV_TYPES = ["f16", "q8_0", "q4_0"] as const;

export type ProblemCode =
  | "badChar"
  | "notCount"
  | "notAbsolute"
  | "durationFormat"
  | "hostFormat"
  | "exposed"
  | "kvWithoutFlash"
  | "proxyCredentials";

export type Problem = { code: ProblemCode; name: string; severity: "error" | "warn" };

const COUNT = /^[1-9]\d*$/;
/** keep_alive: 秒の数(負の数も可)か、Go の時間の書き方("10m"・"24h"・"-1m"・"1h30m")。 */
const DURATION = /^-?(\d+(\.\d+)?|(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+)$/;
/** ホスト名か IPv4、または [IPv6]。後ろに :ポート。ポートだけ(":11434")は FAQ に無いので通さない。 */
const HOST = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?$/;

/** 囲みの中でエスケープとして読まれる文字と、印字できない文字。 */
const BAD = /["\\\u0000-\u001f\u007f]/;

export type SystemdInput = Record<string, string>;

export function buildOverride(input: SystemdInput): { text: string; problems: Problem[]; set: string[] } {
  const problems: Problem[] = [];
  const lines = ["[Service]"];
  const set: string[] = [];
  const val = (n: string) => (input[n] ?? "").trim();

  for (const v of VARS) {
    let value = val(v.name);
    if (!value) continue;
    if (v.kind === "on") value = "1";
    if (BAD.test(value)) {
      problems.push({ code: "badChar", name: v.name, severity: "error" });
      continue;
    }
    if (v.kind === "count" && !COUNT.test(value)) problems.push({ code: "notCount", name: v.name, severity: "error" });
    if (v.kind === "path" && !value.startsWith("/")) problems.push({ code: "notAbsolute", name: v.name, severity: "error" });
    if (v.kind === "duration" && !DURATION.test(value)) problems.push({ code: "durationFormat", name: v.name, severity: "warn" });
    if (v.kind === "host") {
      if (!HOST.test(value)) problems.push({ code: "hostFormat", name: v.name, severity: "warn" });
      else if (!LOOPBACK.test(value)) problems.push({ code: "exposed", name: v.name, severity: "warn" });
    }
    if (v.name === "HTTPS_PROXY" && /\/\/[^/]*@/.test(value)) problems.push({ code: "proxyCredentials", name: v.name, severity: "warn" });
    lines.push(`Environment="${v.name}=${value.replace(/%/g, "%%")}"`);
    set.push(v.name);
  }

  const kv = val("OLLAMA_KV_CACHE_TYPE");
  if ((kv === "q8_0" || kv === "q4_0") && val("OLLAMA_FLASH_ATTENTION") === "0") {
    problems.push({ code: "kvWithoutFlash", name: "OLLAMA_KV_CACHE_TYPE", severity: "warn" });
  }

  return { text: lines.join("\n") + "\n", problems, set };
}

/** シェルの1語として安全に渡す(英数字と /._- だけならそのまま、ほかは '…' で囲む)。 */
export function shellWord(s: string) {
  return /^[A-Za-z0-9/._-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** FAQ の手順。OLLAMA_MODELS を変えるときは、FAQ の注意どおり先に持ち主を ollama にする。 */
export function overrideCommands(input: SystemdInput) {
  const dir = (input.OLLAMA_MODELS ?? "").trim();
  const cmds: string[] = [];
  // mkdir -p は当サイトの補い(FAQ は chown だけ)。無いディレクトリに chown はできないため。
  if (dir.startsWith("/")) cmds.push(`sudo mkdir -p ${shellWord(dir)}`, `sudo chown -R ollama:ollama ${shellWord(dir)}`);
  cmds.push("sudo systemctl edit ollama.service", "sudo systemctl daemon-reload", "sudo systemctl restart ollama", "systemctl show ollama --property=Environment");
  return cmds;
}
