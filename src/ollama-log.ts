/**
 * Ollama のサーバーログを読み、モデルの読み込み(メモリの内訳・GPU に載った層・文脈の長さ)、要求、速度、
 * 警告とエラーを拾って説明する。
 *
 * ログの形は版ごとに変わる(docs.ollama.com/troubleshooting に「varies from release to release」とある)。
 * ここで読む行は、ollama/ollama v0.40.15 のソースにある slog のメッセージ(llm/llama_server.go・llm/server.go・
 * server/sched.go・server/routes.go)と、Ollama が中で動かす llama.cpp(b12111)の llama-server が書く行。
 * 2026-11-07 に次の本物のログで確かめた(scripts/check-ollama-log.ts):
 *  - macOS(Apple M1・Metal)の Ollama 0.40.11。qwen2.5:7b を GPU に 29/29 層
 *  - Linux(Docker の ollama/ollama:0.40.11、GPU なし、メモリ 1.9 GiB)。qwen2.5:0.5b は普通に動き、
 *    num_ctx 256 で 633 トークンの入力が 130 に切られ、truncate:false では 400、num_ctx 65536 は 32768 に下げられた。
 *    qwen2.5:7b は重み(CPU 293.63 + CPU_REPACK 4166.82 MiB)がメモリに入らず、読み込み中に signal: killed で落ちて 500
 *
 * 知っておくこと(ソースで確かめたもの):
 *  - 入力が文脈に入りきらないと、Ollama は先頭の num_keep 個を残して、文脈の約半分まで削る
 *    (limit = num_ctx − max((num_ctx − keep) / 2, 1)。llama_server.go の contextShiftPromptLimit)。
 *  - num_ctx が学習時の長さ(n_ctx_train)より大きいと、警告を出して n_ctx_train に下げる(llm/server.go)。
 *  - 「llama-server terminated」は、llama-server がエラーを報告したあとでプロセスが終わったときに出る。
 *    すぐ後に「starting llama-server」が続けば、Ollama が別の設定(num_ctx など)で読み込み直すために止めたもの。
 *  - llama.cpp の print_timing の生成速度は、最初のトークンを数えない(n_gen − 1 で割る。server-common.h の n_gen_steps)。
 *    Ollama の eval_count ÷ eval_duration とは少し違う値になる。
 */

export const OLLAMA_LOG_VERIFIED_ON = "2026-11-07";
export const OLLAMA_LOG_DOC_URL = "https://docs.ollama.com/troubleshooting";
export const OLLAMA_LOG_SOURCE_VERSION = "v0.40.15";

export type LogPrefix = "none" | "journal" | "journalIso" | "docker";

export type ProblemCode =
  | "inputEmpty"
  | "nothingRecognized"
  | "truncated"
  | "contextExceeded"
  | "ctxTooLarge"
  | "loadFailed"
  | "loadRetryCtx"
  | "loadRetryEvict"
  | "runtimeOom"
  | "terminatedReload"
  | "terminated"
  | "processGone"
  | "clientClosed"
  | "buffersExceedMemory"
  | "partialOffload"
  | "noOffload"
  | "httpErrors"
  | "deprecatedOption"
  | "contextDeprecated"
  | "driverOld"
  | "otherWarn"
  | "ctxBelowTrain";

export type Severity = "error" | "warn" | "info";
/** index は入力の行番号(1から)。values は文言に差し込む値。 */
export type Problem = { code: ProblemCode; severity: Severity; index?: number; detail?: string; values?: Record<string, string> };

export type Buffer = { device: string; kind: "model" | "kv" | "compute"; mib: number };

export type Load = {
  line: number;
  time: string;
  /** モデルのファイル(sha256 の先頭12文字、なければファイル名)。 */
  model: string;
  /** GGUF の general.name。 */
  name: string;
  ctx: number | null;
  parallel: number | null;
  fileType: string;
  fileSize: string;
  ctxTrain: number | null;
  offloaded: number | null;
  layersTotal: number | null;
  buffers: Buffer[];
  kvMib: number | null;
  kvType: string;
  sysTotalMib: number | null;
  sysFreeMib: number | null;
  swapFreeMib: number | null;
  gpuAvailable: string[];
  startSec: number | null;
  failed: string | null;
};

export type Request = { line: number; time: string; status: number; seconds: number | null; client: string; method: string; path: string };

export type Timing = {
  line: number;
  promptMs: number;
  promptTokens: number;
  promptTps: number;
  evalMs: number | null;
  evalTokens: number | null;
  evalTps: number | null;
};

export type ServerInfo = {
  version: string;
  listen: string;
  gpus: { library: string; name: string; total: string; available: string }[];
  defaultCtx: number | null;
  /** 主な環境変数(値の入っているものだけ)。 */
  env: [string, string][];
};

export type LogResult = {
  problems: Problem[];
  prefix: LogPrefix;
  lines: number;
  recognized: number;
  server: ServerInfo;
  loads: Load[];
  requests: Request[];
  timings: Timing[];
};

/** 表に出す環境変数(docs.ollama.com/faq に説明のあるもの)。 */
export const ENV_KEYS = [
  "OLLAMA_HOST",
  "OLLAMA_CONTEXT_LENGTH",
  "OLLAMA_NUM_PARALLEL",
  "OLLAMA_MAX_LOADED_MODELS",
  "OLLAMA_KEEP_ALIVE",
  "OLLAMA_FLASH_ATTENTION",
  "OLLAMA_KV_CACHE_TYPE",
];

const PREFIXES: [LogPrefix, RegExp][] = [
  // journalctl(既定の short): "Nov 07 08:32:11 host ollama[1234]: "
  ["journal", /^[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \S+ [^\s[\]]+\[\d+\]: /],
  // journalctl -o short-iso: "2026-11-07T08:32:11+0000 host ollama[1234]: "
  ["journalIso", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2}) \S+ [^\s[\]]+\[\d+\]: /],
  // docker logs --timestamps: "2026-11-07T08:32:11.123456789Z "
  ["docker", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /],
];

/** 行の頭に付いた journalctl や docker の時刻を外す。 */
export function stripPrefix(line: string): { text: string; prefix: LogPrefix } {
  for (const [name, re] of PREFIXES) {
    const m = re.exec(line);
    if (m) return { text: line.slice(m[0].length), prefix: name };
  }
  return { text: line, prefix: "none" };
}

/** Go の slog(テキスト)の key=value を読む。値は "…"(\" と \\ を含む)か、空白までの文字列。 */
export function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w.]*)=("(?:[^"\\]|\\.)*"|\S*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    let v = m[2];
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    }
    if (!(m[1] in out)) out[m[1]] = v;
  }
  return out;
}

/** "16.0 GiB" "1002.3 MiB" "0 B" "512 KiB" を MiB に。 */
export function toMib(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const f: Record<string, number> = { B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024, TiB: 1048576, KB: 1e3 / 1048576, MB: 1e6 / 1048576, GB: 1e9 / 1048576, TB: 1e12 / 1048576 };
  return n * f[m[2]];
}

/** Go の time.Duration の文字列("1m20s" "6.31s" "624.209µs" "16.01ms")を秒に。 */
export function goDurationToSec(s: string): number | null {
  const t = s.trim();
  if (!/^(?:[\d.]+(?:h|m|s|ms|µs|μs|us|ns))+$/.test(t)) return null;
  const unit: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 1e-3, "µs": 1e-6, "μs": 1e-6, us: 1e-6, ns: 1e-9 };
  let sec = 0;
  for (const m of t.matchAll(/([\d.]+)(h|ms|m|s|µs|μs|us|ns)/g)) sec += Number(m[1]) * unit[m[2]];
  return sec;
}

/** slog の time(RFC 3339)をミリ秒に。 */
export function parseTime(s: string): number | null {
  const t = Date.parse(s.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(t) ? null : t;
}

const shortModel = (p: string) => {
  const m = /sha256-([0-9a-f]{12})/.exec(p);
  if (m) return `sha256-${m[1]}`;
  return p.split("/").pop() ?? p;
};

const flag = (cmd: string, name: string) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s+(\\S+)`).exec(cmd);
  return m ? m[1] : null;
};

const SLOG = /^time=(\S+) level=(\w+) source=(\S+) msg=("(?:[^"\\]|\\.)*"|\S+)(.*)$/;
const GIN = /^\[GIN\] (\d{4}\/\d{2}\/\d{2} - \d{2}:\d{2}:\d{2}) \|\s*(\d{3}) \|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*([A-Z]+)\s+"([^"]*)"/;

export function readLog(text: string): LogResult {
  const problems: Problem[] = [];
  const server: ServerInfo = { version: "", listen: "", gpus: [], defaultCtx: null, env: [] };
  const loads: Load[] = [];
  const requests: Request[] = [];
  const timings: Timing[] = [];
  const add = (p: Problem) => problems.push(p);

  const src = text.replace(/^﻿/, "");
  if (src.trim() === "") return { problems: [{ code: "inputEmpty", severity: "error" }], prefix: "none", lines: 0, recognized: 0, server, loads, requests, timings };

  const raw = src.split(/\r?\n/);
  let prefix: LogPrefix = "none";
  let recognized = 0;
  let cur: Load | null = null;
  let pendingTiming: Timing | null = null;
  const terminated: { line: number; at: number | null; detail: string }[] = [];

  raw.forEach((rawLine, i) => {
    const no = i + 1;
    const st = stripPrefix(rawLine);
    if (st.prefix !== "none" && prefix === "none") prefix = st.prefix;
    const line = st.text;
    if (line.trim() === "") return;

    const s = SLOG.exec(line);
    if (s) {
      recognized++;
      const [, time, level, , msgRaw, rest] = s;
      let msg = msgRaw;
      if (msg.startsWith('"')) {
        try {
          msg = JSON.parse(msg);
        } catch {
          msg = msg.slice(1, -1);
        }
      }
      const a = parseAttrs(rest);

      if (msg === "starting llama-server") {
        const cmd = a.cmd ?? "";
        const ctx = flag(cmd, "-c");
        const np = flag(cmd, "-np");
        cur = {
          line: no,
          time,
          model: shortModel(flag(cmd, "--model") ?? ""),
          name: "",
          ctx: ctx ? Number(ctx) : null,
          parallel: np ? Number(np) : null,
          fileType: "",
          fileSize: "",
          ctxTrain: null,
          offloaded: null,
          layersTotal: null,
          buffers: [],
          kvMib: null,
          kvType: "",
          sysTotalMib: null,
          sysFreeMib: null,
          swapFreeMib: null,
          gpuAvailable: [],
          startSec: null,
          failed: null,
        };
        loads.push(cur);
        return;
      }
      if (msg === "requested context size too large for model") {
        add({ code: "ctxTooLarge", severity: "warn", index: no, values: { requested: a.num_ctx ?? "", train: a.n_ctx_train ?? "" } });
      } else if (msg.startsWith("Listening on ")) {
        const m = /^Listening on (\S+) \(version ([^)]+)\)/.exec(msg);
        if (m) {
          server.listen = m[1];
          server.version = m[2];
        }
      } else if (msg === "server config") {
        const env = a.env ?? "";
        const pairs = new Map<string, string>();
        for (const m of env.matchAll(/([A-Z_][A-Z0-9_]*):(\[[^\]]*\]|\S*)/g)) pairs.set(m[1], m[2].replace(/\]$/, m[2].startsWith("[") ? "]" : ""));
        server.env = ENV_KEYS.filter((k) => (pairs.get(k) ?? "") !== "").map((k) => [k, pairs.get(k)!]);
      } else if (msg === "inference compute") {
        server.gpus.push({ library: a.library ?? "", name: a.description || a.name || "", total: a.total ?? "", available: a.available ?? "" });
      } else if (msg === "vram-based default context") {
        const n = Number(a.default_num_ctx);
        server.defaultCtx = Number.isFinite(n) ? n : null;
      } else if (msg === "system memory" && cur && cur.sysTotalMib === null) {
        cur.sysTotalMib = toMib(a.total);
        cur.sysFreeMib = toMib(a.free);
        cur.swapFreeMib = toMib(a.free_swap);
      } else if (msg === "gpu memory" && cur) {
        cur.gpuAvailable.push(`${a.library ?? ""} ${a.available ?? ""}`.trim());
      } else if (/^llama-server started in [\d.]+ seconds$/.test(msg) && cur && cur.startSec === null) {
        cur.startSec = Number(/([\d.]+) seconds/.exec(msg)![1]);
      } else if (msg === "Load failed") {
        if (cur && !cur.failed) cur.failed = a.error ?? "";
        add({ code: "loadFailed", severity: "error", index: no, detail: a.error ?? "" });
      } else if (msg === "error loading llama server") {
        add({ code: "loadFailed", severity: "error", index: no, detail: a.error ?? "" });
      } else if (msg === "truncating input prompt") {
        add({ code: "truncated", severity: "warn", index: no, values: { prompt: a.prompt ?? "", new: a.new ?? "", limit: a.limit ?? "", keep: a.keep ?? "" } });
      } else if (msg === "llama-server terminated") {
        terminated.push({ line: no, at: parseTime(time), detail: a.error ?? "" });
      } else if (msg.startsWith("llama-server load failed; reducing automatic context")) {
        add({ code: "loadRetryCtx", severity: "warn", index: no, values: { old: a.old_num_ctx ?? "", new: a.new_num_ctx ?? "" } });
      } else if (msg.startsWith("llama-server load failed; evicting all other models")) {
        add({ code: "loadRetryEvict", severity: "warn", index: no });
      } else if (msg.startsWith("runtime OOM detected")) {
        add({ code: "runtimeOom", severity: "error", index: no, detail: a.error ?? "" });
      } else if (msg === "llama-server process no longer running") {
        add({ code: "processGone", severity: "error", index: no, detail: a.string ?? "" });
      } else if (msg.startsWith("client connection closed before llama-server finished loading")) {
        add({ code: "clientClosed", severity: "warn", index: no });
      } else if (msg === "deprecated option provided") {
        add({ code: "deprecatedOption", severity: "warn", index: no, detail: a.option ?? "" });
      } else if (msg.startsWith("the context field is deprecated")) {
        add({ code: "contextDeprecated", severity: "warn", index: no });
      } else if (msg === "NVIDIA driver too old" || msg.startsWith("AMD driver is too old")) {
        // NVIDIA は device・driver・required_driver が付き、その GPU は使われない(discover/cuda_compat.go)。
        const d = msg === "NVIDIA driver too old" ? [a.device, a.driver && `driver ${a.driver}`, a.required_driver && `required ${a.required_driver}`].filter(Boolean).join(", ") : "AMD";
        add({ code: "driverOld", severity: "warn", index: no, detail: d });
      } else if (level === "WARN" || level === "ERROR") {
        add({ code: "otherWarn", severity: level === "ERROR" ? "error" : "warn", index: no, detail: msg + (a.error ? `: ${a.error}` : "") });
      }
      return;
    }

    const g = GIN.exec(line);
    if (g) {
      recognized++;
      requests.push({ line: no, time: g[1], status: Number(g[2]), seconds: goDurationToSec(g[3]), client: g[4], method: g[5], path: g[6] });
      return;
    }

    // ここから下は llama.cpp(llama-server)の行。
    let m: RegExpExecArray | null;
    if ((m = /^load_tensors: offloaded (\d+)\/(\d+) layers to GPU/.exec(line))) {
      recognized++;
      if (cur) {
        cur.offloaded = Number(m[1]);
        cur.layersTotal = Number(m[2]);
      }
    } else if ((m = /^load_tensors:\s+(\S+) model buffer size =\s*([\d.]+) MiB/.exec(line))) {
      recognized++;
      cur?.buffers.push({ device: m[1], kind: "model", mib: Number(m[2]) });
    } else if ((m = /^llama_kv_cache: size =\s*([\d.]+) MiB \(\s*(\d+) cells.*?K \((\w+)\).*?V \((\w+)\)/.exec(line))) {
      recognized++;
      if (cur && cur.kvMib === null) {
        cur.kvMib = Number(m[1]);
        cur.kvType = m[3] === m[4] ? m[3] : `K ${m[3]} / V ${m[4]}`;
      }
    } else if ((m = /^llama_kv_cache:\s+(\S+) KV buffer size =\s*([\d.]+) MiB/.exec(line))) {
      recognized++;
      cur?.buffers.push({ device: m[1], kind: "kv", mib: Number(m[2]) });
    } else if ((m = /^sched_reserve:\s+(\S+) compute buffer size =\s*([\d.]+) MiB/.exec(line))) {
      recognized++;
      cur?.buffers.push({ device: m[1], kind: "compute", mib: Number(m[2]) });
    } else if ((m = /^print_info: file type\s+=\s*(.+?)\s*$/.exec(line))) {
      recognized++;
      if (cur && !cur.fileType) cur.fileType = m[1];
    } else if ((m = /^print_info: file size\s+=\s*(.+?)\s*$/.exec(line))) {
      recognized++;
      if (cur && !cur.fileSize) cur.fileSize = m[1];
    } else if ((m = /^print_info: n_ctx_train\s+=\s*(\d+)/.exec(line))) {
      recognized++;
      if (cur && cur.ctxTrain === null) cur.ctxTrain = Number(m[1]);
    } else if ((m = /^llama_model_loader: - kv\s+\d+:\s+general\.name str\s+=\s*(.+?)\s*$/.exec(line))) {
      recognized++;
      if (cur && !cur.name) cur.name = m[1];
    } else if ((m = /^llama_context: n_ctx_seq \((\d+)\) < n_ctx_train \((\d+)\)/.exec(line))) {
      recognized++;
      // 同じ組み合わせは1度だけ知らせる。
      if (!problems.some((p) => p.code === "ctxBelowTrain" && p.values?.ctx === m![1] && p.values?.train === m![2]))
        add({ code: "ctxBelowTrain", severity: "info", index: no, values: { ctx: m[1], train: m[2] } });
    } else if ((m = /error: request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/.exec(line))) {
      recognized++;
      add({ code: "contextExceeded", severity: "error", index: no, values: { prompt: m[1], ctx: m[2] } });
    } else if ((m = /print_timing: .*prompt eval time =\s*([\d.]+) ms \/\s*(\d+) tokens \(.*?([\d.]+) tokens per second\)/.exec(line))) {
      recognized++;
      pendingTiming = { line: no, promptMs: Number(m[1]), promptTokens: Number(m[2]), promptTps: Number(m[3]), evalMs: null, evalTokens: null, evalTps: null };
      timings.push(pendingTiming);
    } else if ((m = /print_timing: .*\beval time =\s*([\d.]+) ms \/\s*(\d+) tokens \(.*?([\d.]+) tokens per second\)/.exec(line))) {
      recognized++;
      if (pendingTiming && pendingTiming.evalMs === null) {
        pendingTiming.evalMs = Number(m[1]);
        pendingTiming.evalTokens = Number(m[2]);
        pendingTiming.evalTps = Number(m[3]);
      }
    }
  });
  // 「llama-server terminated」のあと2秒以内に新しい「starting llama-server」があれば、読み込み直し。
  for (const t of terminated) {
    const next = loads.find((l) => l.line > t.line);
    const nextAt = next ? parseTime(next.time) : null;
    const reload = next !== undefined && t.at !== null && nextAt !== null && nextAt - t.at >= 0 && nextAt - t.at <= 2000;
    add(reload ? { code: "terminatedReload", severity: "info", index: t.line } : { code: "terminated", severity: "error", index: t.line, detail: t.detail });
  }

  if (recognized === 0) {
    problems.push({ code: "nothingRecognized", severity: "error" });
    return { problems, prefix, lines: raw.length, recognized, server, loads, requests, timings };
  }

  // 読み込みごとの見立て。
  const hasGpu = server.gpus.some((g) => g.library && g.library.toLowerCase() !== "cpu");
  for (const l of loads) {
    if (l.offloaded !== null && l.layersTotal !== null) {
      if (l.offloaded > 0 && l.offloaded < l.layersTotal)
        add({ code: "partialOffload", severity: "warn", index: l.line, values: { n: String(l.offloaded), total: String(l.layersTotal) } });
      else if (l.offloaded === 0 && (hasGpu || l.gpuAvailable.length > 0))
        add({ code: "noOffload", severity: "warn", index: l.line, values: { total: String(l.layersTotal) } });
    }
    const gpuless = !hasGpu && l.gpuAvailable.length === 0;
    const sum = l.buffers.reduce((t, b) => t + b.mib, 0);
    if (gpuless && l.sysTotalMib !== null && sum > l.sysTotalMib)
      add({ code: "buffersExceedMemory", severity: "error", index: l.line, values: { buffers: sum.toFixed(0), total: l.sysTotalMib.toFixed(0) } });
  }

  const bad = requests.filter((r) => r.status >= 400);
  if (bad.length)
    add({ code: "httpErrors", severity: bad.some((r) => r.status >= 500) ? "error" : "warn", detail: bad.map((r) => `${r.status} ${r.method} ${r.path}`).join(", ") });

  // 行の順に並べる(行番号の無いものは最後)。
  problems.sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));
  return { problems, prefix, lines: raw.length, recognized, server, loads, requests, timings };
}

/** 読み込みごとのメモリの合計(MiB)。種類ごと。 */
export function bufferTotals(l: Load): { model: number; kv: number; compute: number; total: number } {
  const t = { model: 0, kv: 0, compute: 0, total: 0 };
  for (const b of l.buffers) {
    t[b.kind] += b.mib;
    t.total += b.mib;
  }
  return t;
}
