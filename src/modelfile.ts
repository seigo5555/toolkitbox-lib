/**
 * Ollama の Modelfile を組み立てる。
 *
 * 命令と PARAMETER の一覧は公式の Modelfile Reference(docs.ollama.com/modelfile)に載っているものだけ。
 * ADAPTER や DRAFT などはソース(parser/parser.go)には残っているがドキュメントに無いので出さない。
 *
 * 値の囲み方は parser.go の ParseFile に合わせている。値は**改行の位置で**、そこまでの中身が
 * 囲みとして閉じていれば終わる(`"""` で始まれば `"""` で終わるまで、`"` で始まれば `"` で終わるまで)。
 * そのため、文章の中に `"""` があると、そこで値が切れてしまう。エスケープの仕組みは無い。
 */

import { CAPABILITIES, semverValid } from "./modelfile-rules";

export const MODELFILE_VERIFIED_ON = "2026-11-09";

/** CAPABILITY に書ける値(ollama create が受け付けるもの。Ollama v0.40.15 の cmd.go。並びもそれに合わせた)。 */
export { CAPABILITIES };
export const MODELFILE_DOC_URL = "https://docs.ollama.com/modelfile";

export type ParamType = "int" | "float";

/** ドキュメントの「Valid Parameters and Values」の表の順。stop は文字列なので別に扱う。 */
export const PARAMS: { name: string; type: ParamType; def: string }[] = [
  { name: "num_ctx", type: "int", def: "2048" },
  { name: "repeat_last_n", type: "int", def: "64" },
  { name: "repeat_penalty", type: "float", def: "1.0" },
  { name: "temperature", type: "float", def: "0.8" },
  { name: "seed", type: "int", def: "0" },
  { name: "num_predict", type: "int", def: "-1" },
  // 既定値は「別のドラフトモデルなら4」で、1つの数ではないので空にしておく。
  { name: "draft_num_predict", type: "int", def: "" },
  { name: "top_k", type: "int", def: "40" },
  { name: "top_p", type: "float", def: "0.9" },
  { name: "min_p", type: "float", def: "0.0" },
];

export type Role = "system" | "user" | "assistant";
export const ROLES: Role[] = ["system", "user", "assistant"];

export type ModelfileInput = {
  from: string;
  system: string;
  /** 名前 → 入力された値。空なら書かない。 */
  params: Record<string, string>;
  /** 1行に1つ。空行は無視する。 */
  stops: string;
  messages: { role: Role; text: string }[];
  template: string;
  requires: string;
  /** CAPABILITY に書く値(CAPABILITIES の中から)。1つにつき1行。 */
  capabilities: string[];
  license: string;
};

export type ProblemCode = "fromMissing" | "fromMultiline" | "tripleQuote" | "notInteger" | "notNumber" | "requiresFormat";

/** field は入力欄の名前(from / system / template / license / message / stop / requires)か、PARAMETER の名前。 */
export type Problem = { code: ProblemCode; field: string; severity: "error" | "warn" };

const INT = /^-?\d+$/;
const FLOAT = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

const block = (s: string) => `"""${s}"""`;

/** 1行で前後に空白が無く、引用符で始まらなければそのまま。そうでなければ `"""` で囲む。 */
function messageValue(s: string) {
  if (!/[\r\n]/.test(s) && s === s.trim() && !s.startsWith('"')) return s;
  return block(s);
}

export function buildModelfile(input: ModelfileInput): { text: string; problems: Problem[] } {
  const problems: Problem[] = [];
  const lines: string[] = [];
  const from = input.from.trim();

  if (!from) problems.push({ code: "fromMissing", field: "from", severity: "error" });
  else if (/[\r\n]/.test(from)) problems.push({ code: "fromMultiline", field: "from", severity: "error" });
  lines.push(`FROM ${from}`);

  const blockField = (field: string, keyword: string, value: string) => {
    if (!value.trim()) return;
    if (value.includes('"""')) problems.push({ code: "tripleQuote", field, severity: "error" });
    lines.push(`${keyword} ${block(value)}`);
  };

  const paramLines: string[] = [];
  for (const p of PARAMS) {
    const v = (input.params[p.name] ?? "").trim();
    if (!v) continue;
    if (p.type === "int" && !INT.test(v)) problems.push({ code: "notInteger", field: p.name, severity: "error" });
    if (p.type === "float" && !FLOAT.test(v)) problems.push({ code: "notNumber", field: p.name, severity: "error" });
    paramLines.push(`PARAMETER ${p.name} ${v}`);
  }
  for (const s of input.stops.split(/\r?\n/)) {
    if (!s) continue;
    // `"` で囲めば、前後の空白も残る。中に `"` があっても、行の最後の `"` までが値になる。
    paramLines.push(`PARAMETER stop "${s}"`);
  }
  if (paramLines.length) lines.push("", ...paramLines);

  const sysStart = lines.length;
  blockField("system", "SYSTEM", input.system);
  if (lines.length > sysStart) lines.splice(sysStart, 0, "");

  const msgs = input.messages.filter((m) => m.text.trim());
  if (msgs.length) {
    lines.push("");
    for (const m of msgs) {
      if (m.text.includes('"""')) problems.push({ code: "tripleQuote", field: "message", severity: "error" });
      lines.push(`MESSAGE ${m.role} ${messageValue(m.text)}`);
    }
  }

  const tplStart = lines.length;
  blockField("template", "TEMPLATE", input.template);
  if (lines.length > tplStart) lines.splice(tplStart, 0, "");

  const req = input.requires.trim();
  if (req) {
    // ollama create と同じ確かめ方(先頭に v が無ければ足して、golang.org/x/mod/semver で)。通らないと
    // 「requires must be a valid semver (e.g. 0.14.0)」で止まる。
    if (/\s/.test(req) || !semverValid(req.startsWith("v") ? req : "v" + req)) problems.push({ code: "requiresFormat", field: "requires", severity: "error" });
    lines.push("", `REQUIRES ${req}`);
  }

  // CAPABILITY は1行に1つ。くり返して書けば複数足せる(Modelfile Reference)。
  const caps = CAPABILITIES.filter((c) => input.capabilities.includes(c));
  if (caps.length) lines.push("", ...caps.map((c) => `CAPABILITY ${c}`));

  const licStart = lines.length;
  blockField("license", "LICENSE", input.license);
  if (lines.length > licStart) lines.splice(licStart, 0, "");

  return { text: lines.join("\n") + "\n", problems };
}

/** `ollama create` に渡すモデル名。ドキュメントの例(choose-a-model-name)に合わせ、空なら仮の名前を出す。 */
export function createCommands(name: string, file = "./Modelfile") {
  const n = name.trim() || "my-model";
  return [`ollama create ${n} -f ${file}`, `ollama run ${n}`];
}
