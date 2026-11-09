/**
 * Ollama の Modelfile を、ollama create と同じ順で読んで確かめる。ブラウザの外には何も送らない。
 *
 * 出どころ(ollama/ollama v0.40.15。v0.40.11 と同じ):
 *  - parser/parser.go: ParseFile(1文字ずつ読む状態機械)、Command.String、quote/unquote、CreateRequest、
 *    deprecatedParameters、エラーの文言("(line N): ..."・"unexpected EOF"・"no FROM line")
 *  - cmd/cmd.go の CreateHandler: ADAPTER があると "LoRA adapters are no longer supported"、
 *    PARAMETER typical_p があると断る(CreateRequest より前)
 *  - api/types.go: FormatParams と Options・Runner(PARAMETER の名前と型。int は ParseInt、float は ParseFloat の 32 ビット、
 *    *bool・*int、stop は文字列の並び)
 *  - types/model/capability.go: CAPABILITY に書ける 10 種
 *  - golang.org/x/mod/semver: REQUIRES の版の形(先頭の v は足して確かめる)
 *  - create/manifest.go: TEMPLATE を template.Parse で読み、失敗すると "template error: ..."
 *  - docs.ollama.com/modelfile: 命令と PARAMETER の表
 *
 * 手元の Ollama 0.40.11 の ollama create と ollama show --modelfile で確かめている(scripts/check-modelfile-check.ts)。
 */

import { parseTemplate, type OllamaTemplate } from "./ollama-template";
import { TemplateError } from "./go-template";
import { CAPABILITIES, semverValid } from "./modelfile-rules";

export const MODELFILE_DOC_URL = "https://docs.ollama.com/modelfile";
export const MODELFILE_CHECK_VERIFIED_ON = "2026-11-09";

export type Command = { name: string; args: string; line: number };

export const COMMANDS = ["from", "license", "template", "system", "adapter", "draft", "renderer", "parser", "parameter", "message", "requires", "capability"];
export { CAPABILITIES, semverValid } from "./modelfile-rules";
export const DEPRECATED_PARAMS = ["penalize_newline", "low_vram", "f16_kv", "logits_all", "vocab_only", "use_mlock", "mirostat", "mirostat_tau", "mirostat_eta"];

export type ParamKind = "int" | "float32" | "bool" | "string[]" | "*int" | "*bool";
/** api.Options と api.Runner の json の名前と型(FormatParams が見るもの)。 */
export const PARAM_KINDS: Record<string, ParamKind> = {
  num_ctx: "int",
  num_batch: "int",
  num_gpu: "int",
  main_gpu: "*int",
  use_mmap: "*bool",
  num_thread: "int",
  draft_num_predict: "int",
  num_keep: "int",
  seed: "int",
  num_predict: "int",
  top_k: "int",
  top_p: "float32",
  min_p: "float32",
  typical_p: "float32",
  repeat_last_n: "int",
  temperature: "float32",
  repeat_penalty: "float32",
  presence_penalty: "float32",
  frequency_penalty: "float32",
  stop: "string[]",
};
/** docs.ollama.com/modelfile の表にある名前。 */
export const DOCUMENTED_PARAMS = ["num_ctx", "repeat_last_n", "repeat_penalty", "temperature", "seed", "stop", "num_predict", "draft_num_predict", "top_k", "top_p", "min_p"];

// ---------------------------------------------------------------- ParseFile

export class ModelfileError extends Error {
  constructor(
    message: string,
    public line: number | null,
    public stage: "parse" | "client" | "server",
  ) {
    super(message);
  }
}

const enum S {
  Nil,
  Name,
  Value,
  Parameter,
  Message,
  Comment,
}

const isAlpha = (r: string) => /^[a-zA-Z]$/.test(r);
const isNumber = (r: string) => /^[0-9]$/.test(r);
const isSpace = (r: string) => r === " " || r === "\t";
const isNewline = (r: string) => r === "\r" || r === "\n";
/** strconv.IsPrint: 文字・記号・数字・句読点と ASCII の空白だけ。 */
const isPrint = (r: string) => r === " " || /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u.test(r);

function unquote(s: string): [string, boolean] {
  if (s.length >= 3 && s.slice(0, 3) === '"""') {
    if (s.length >= 6 && s.slice(-3) === '"""') return [s.slice(3, -3), true];
    return ["", false];
  }
  if (s.length >= 1 && s[0] === '"') {
    if (s.length >= 2 && s[s.length - 1] === '"') return [s.slice(1, -1), true];
    return ["", false];
  }
  return [s, true];
}
/** Go の strings.TrimSpace(Unicode の空白)。 */
const trimSpace = (s: string) => s.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, "");

export function quote(s: string): string {
  if (s.includes("\n") || s.startsWith(" ") || s.endsWith(" ")) {
    if (s.includes('"')) return `"""${s}"""`;
    return `"${s}"`;
  }
  return s;
}

const ERR_COMMAND = 'command must be one of "from", "license", "template", "system", "adapter", "draft", "renderer", "parser", "parameter", "message", "requires", or "capability"';
const ERR_ROLE = 'message role must be one of "system", "user", or "assistant"';

/** parser.ParseFile。失敗すると ModelfileError(Ollama と同じ文言)。 */
export function parseModelfile(text: string): Command[] {
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  let cmd = { name: "", args: "", line: 1 };
  let curr = S.Nil;
  let line = 1;
  let b = "";
  let role = "";
  let startLine = 1;
  const out: Command[] = [];
  const perr = (msg: string): never => {
    throw new ModelfileError(`(line ${line}): ${msg}`, line, "parse");
  };
  const step = (r: string, cs: S): [S, string] | "eof" | "command" => {
    switch (cs) {
      case S.Nil:
        if (r === "#") return [S.Comment, ""];
        if (isSpace(r) || isNewline(r)) return [S.Nil, ""];
        return [S.Name, r];
      case S.Name:
        if (isAlpha(r)) return [S.Name, r];
        if (isSpace(r)) return [S.Value, ""];
        return "command";
      case S.Value:
        if (isNewline(r) || isSpace(r)) return [S.Nil, r];
        return [S.Value, r];
      case S.Parameter:
        if (isAlpha(r) || isNumber(r) || r === "_") return [S.Parameter, r];
        if (isSpace(r)) return [S.Value, ""];
        return "eof";
      case S.Message:
        if (isAlpha(r)) return [S.Message, r];
        if (isSpace(r)) return [S.Value, ""];
        return "eof";
      case S.Comment:
        if (isNewline(r)) return [S.Nil, ""];
        return [S.Comment, ""];
    }
  };
  for (const r0 of text) {
    if (isNewline(r0)) line++;
    const st = step(r0, curr);
    if (st === "eof") throw new ModelfileError(`unexpected EOF: ${b}`, line, "parse");
    if (st === "command") perr(ERR_COMMAND);
    const [nextState, r] = st as [S, string];
    let next = nextState;
    if (next !== curr) {
      switch (curr) {
        case S.Name: {
          if (!COMMANDS.includes(b.toLowerCase())) perr(ERR_COMMAND);
          const s = b.toLowerCase();
          if (s === "from") cmd.name = "model";
          else if (s === "parameter") next = S.Parameter;
          else if (s === "message") {
            next = S.Message;
            cmd.name = s;
          } else cmd.name = s;
          break;
        }
        case S.Parameter:
          cmd.name = b;
          break;
        case S.Message:
          if (!["system", "user", "assistant"].includes(b)) perr(ERR_ROLE);
          role = b;
          break;
        case S.Value: {
          const [s, ok] = unquote(trimSpace(b));
          if (!ok || isSpace(r0)) {
            b += r0;
            continue;
          }
          const args = role !== "" ? `${role}: ${s}` : s;
          role = "";
          out.push({ name: cmd.name, args, line: startLine });
          cmd = { name: "", args: "", line };
          break;
        }
      }
      if (next === S.Name && curr === S.Nil) startLine = line;
      b = "";
      curr = next;
    }
    if (r !== "" && isPrint(r)) b += r;
  }
  switch (curr) {
    case S.Comment:
    case S.Nil:
      break;
    case S.Value: {
      const [s, ok] = unquote(trimSpace(b));
      if (!ok) throw new ModelfileError("unexpected EOF", null, "parse");
      out.push({ name: cmd.name, args: role !== "" ? `${role}: ${s}` : s, line: startLine });
      break;
    }
    default:
      throw new ModelfileError("unexpected EOF", null, "parse");
  }
  if (!out.some((c) => c.name === "model")) throw new ModelfileError("no FROM line", null, "parse");
  return out;
}

/** Command.String(Ollama が書き出すときの形)。 */
export function commandString(c: Command): string {
  switch (c.name) {
    case "model":
      return `FROM ${c.args}`;
    case "license":
    case "template":
    case "system":
    case "adapter":
    case "renderer":
    case "parser":
    case "requires":
    case "draft":
    case "capability":
      return `${c.name.toUpperCase()} ${quote(c.args)}`;
    case "message": {
      const i = c.args.indexOf(": ");
      const [role, msg] = i >= 0 ? [c.args.slice(0, i), c.args.slice(i + 2)] : [c.args, ""];
      return `MESSAGE ${role} ${quote(msg)}`;
    }
    default:
      return `PARAMETER ${c.name} ${quote(c.args)}`;
  }
}

// ---------------------------------------------------------------- 数と版(Go の strconv・x/mod/semver)

/** strconv.ParseInt(s, 10, 64)。 */
export function parseGoInt(s: string): bigint | null {
  if (!/^[+-]?[0-9]+$/.test(s)) return null;
  const v = BigInt(s);
  if (v < -(2n ** 63n) || v >= 2n ** 63n) return null;
  return v;
}

/** strconv.ParseFloat(s, 32)。範囲外は null。 */
export function parseGoFloat32(s: string): number | null {
  const lower = s.toLowerCase();
  if (/^[+-]?(inf|infinity)$/.test(lower)) return lower.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(lower)) return NaN;
  let v: number;
  const dec = /^[+-]?(\d(_?\d)*(\.(\d(_?\d)*)?)?|\.\d(_?\d)*)([eE][+-]?\d(_?\d)*)?$/;
  const hex = /^[+-]?0[xX]([0-9a-fA-F](_?[0-9a-fA-F])*(\.([0-9a-fA-F](_?[0-9a-fA-F])*)?)?|\.[0-9a-fA-F](_?[0-9a-fA-F])*)[pP][+-]?\d(_?\d)*$/;
  if (dec.test(s)) {
    if (s.includes("_")) return null; // 下線は基数の接頭辞があるときだけ
    v = Number(s);
  } else if (hex.test(s)) {
    const m = /^([+-]?)0[xX]([0-9a-fA-F_]*)(?:\.([0-9a-fA-F_]*))?[pP]([+-]?[\d_]+)$/.exec(s)!;
    const intPart = (m[2] || "0").replace(/_/g, "");
    const frac = (m[3] || "").replace(/_/g, "");
    v = (parseInt(intPart || "0", 16) + (frac ? parseInt(frac, 16) / 16 ** frac.length : 0)) * 2 ** Number(m[4].replace(/_/g, ""));
    if (m[1] === "-") v = -v;
  } else return null;
  const f = Math.fround(v);
  if (!Number.isFinite(f) && Number.isFinite(v)) return null; // 32 ビットに収まらない
  return f;
}

/** strconv.ParseBool。 */
export function parseGoBool(s: string): boolean | null {
  if (["1", "t", "T", "TRUE", "true", "True"].includes(s)) return true;
  if (["0", "f", "F", "FALSE", "false", "False"].includes(s)) return false;
  return null;
}

/** float32 を Go の encoding/json と同じ最短の形で(32 ビットで元に戻る一番短い10進)。 */
export function float32Json(f: number): string {
  if (Object.is(f, -0)) return "-0";
  if (f === 0) return "0";
  for (let p = 1; p <= 9; p++) {
    const s = Number(f.toPrecision(p));
    if (Math.fround(s) === f) {
      const abs = Math.abs(s);
      if (abs < 1e-6 || abs >= 1e21) return s.toExponential().replace(/e([+-])(\d)$/, "e$1$2");
      return String(s);
    }
  }
  return String(f);
}


// ---------------------------------------------------------------- CreateRequest と、サーバーで断られるもの

export type ParamValue = { kind: ParamKind; json: string };
export type NoteCode =
  | "deprecatedParam"
  | "undocumentedParam"
  | "duplicate"
  | "fromPath"
  | "fromName"
  | "draftUndocumented"
  | "rendererParser"
  | "legacyTemplate"
  | "templateNoTools"
  | "messageNoContent"
  | "zeroWidthDropped";
export type Note = { code: NoteCode; detail?: string; line?: number };

export type CheckResult = {
  commands: Command[];
  /** Ollama が書き出す形(Command.String を1行ずつ)。 */
  normalized: string;
  from: string[];
  system: string | null;
  template: string | null;
  templateInfo: OllamaTemplate | null;
  licenses: string[];
  messages: { role: string; content: string }[];
  /** 作られる params の JSON(Go の encoding/json)。FROM のモデルから受け継ぐ値は入っていない。 */
  params: [string, ParamValue][];
  requires: string | null;
  capabilities: string[];
  renderer: string | null;
  parser: string | null;
  notes: Note[];
  error: ModelfileError | null;
};

const strJson = (s: string) => JSON.stringify(s).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function checkModelfile(text: string): CheckResult {
  const r: CheckResult = {
    commands: [],
    normalized: "",
    from: [],
    system: null,
    template: null,
    templateInfo: null,
    licenses: [],
    messages: [],
    params: [],
    requires: null,
    capabilities: [],
    renderer: null,
    parser: null,
    notes: [],
    error: null,
  };
  if (/[\u200b-\u200f\u2060\ufeff]/.test(text.replace(/^\uFEFF/, ""))) r.notes.push({ code: "zeroWidthDropped" });
  try {
    r.commands = parseModelfile(text);
  } catch (e) {
    if (e instanceof ModelfileError) {
      r.error = e;
      return r;
    }
    throw e;
  }
  r.normalized = r.commands.map(commandString).join("\n") + "\n";
  const cmds = r.commands;
  // cmd.go: ADAPTER と typical_p は CreateRequest の前に断る
  if (cmds.some((c) => c.name === "adapter")) {
    r.error = new ModelfileError("LoRA adapters are no longer supported", cmds.find((c) => c.name === "adapter")!.line, "client");
    return r;
  }
  if (cmds.some((c) => c.name === "typical_p")) {
    r.error = new ModelfileError("typical_p is deprecated and cannot be set as a model parameter; pass it as a request option instead", cmds.find((c) => c.name === "typical_p")!.line, "client");
    return r;
  }
  // CreateRequest
  const params = new Map<string, ParamValue>();
  const stops: string[] = [];
  const seen = new Map<string, number>();
  for (const c of cmds) {
    const fail = (msg: string, stage: "client" | "server" = "client") => {
      r.error = new ModelfileError(msg, c.line, stage);
    };
    switch (c.name) {
      case "model":
        r.from.push(c.args);
        break;
      case "draft":
        r.notes.push({ code: "draftUndocumented", line: c.line });
        break;
      case "template":
        r.template = c.args;
        break;
      case "system":
        r.system = c.args;
        break;
      case "license":
        r.licenses.push(c.args);
        break;
      case "renderer":
        r.renderer = c.args;
        break;
      case "parser":
        r.parser = c.args;
        break;
      case "capability":
        if (!CAPABILITIES.includes(c.args)) {
          fail(`unknown capability: ${JSON.stringify(c.args)}`);
          return r;
        }
        r.capabilities.push(c.args);
        break;
      case "requires": {
        const v = c.args.startsWith("v") ? c.args : "v" + c.args;
        if (!semverValid(v)) {
          fail("requires must be a valid semver (e.g. 0.14.0)");
          return r;
        }
        r.requires = v.slice(1);
        break;
      }
      case "message": {
        const i = c.args.indexOf(": ");
        r.messages.push(i >= 0 ? { role: c.args.slice(0, i), content: c.args.slice(i + 2) } : { role: c.args, content: "" });
        break;
      }
      default: {
        if (DEPRECATED_PARAMS.includes(c.name)) {
          r.notes.push({ code: "deprecatedParam", detail: c.name, line: c.line });
          break;
        }
        const kind = PARAM_KINDS[c.name];
        if (!kind) {
          fail(`unknown parameter '${c.name}'`);
          return r;
        }
        const v = c.args;
        let json: string;
        if (kind === "int" || kind === "*int") {
          const n = parseGoInt(v);
          if (n === null) {
            fail(`invalid int value [${v}]`);
            return r;
          }
          json = n.toString();
        } else if (kind === "float32") {
          const f = parseGoFloat32(v);
          if (f === null) {
            fail(`invalid float value [${v}]`);
            return r;
          }
          if (!Number.isFinite(f)) {
            // ollama create は要求を JSON にするところで失敗する(encoding/json は NaN と Inf を書けない)
            fail(`json: unsupported value: ${Number.isNaN(f) ? "NaN" : f > 0 ? "+Inf" : "-Inf"}`);
            return r;
          }
          json = float32Json(f);
        } else if (kind === "*bool") {
          const bv = parseGoBool(v);
          if (bv === null) {
            fail(`invalid bool value [${v}]`);
            return r;
          }
          json = String(bv);
        } else {
          stops.push(v);
          json = "";
        }
        if (kind !== "string[]") params.set(c.name, { kind, json });
        if (!DOCUMENTED_PARAMS.includes(c.name)) r.notes.push({ code: "undocumentedParam", detail: c.name, line: c.line });
      }
    }
    if (["model", "template", "system", "renderer", "parser", "requires"].includes(c.name) || (PARAM_KINDS[c.name] && c.name !== "stop")) {
      const prev = seen.get(c.name);
      if (prev !== undefined) r.notes.push({ code: "duplicate", detail: c.name === "model" ? "FROM" : PARAM_KINDS[c.name] ? `PARAMETER ${c.name}` : c.name.toUpperCase(), line: c.line });
      seen.set(c.name, c.line);
    }
  }
  if (stops.length) params.set("stop", { kind: "string[]", json: "[" + stops.map(strJson).join(",") + "]" });
  r.params = [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  for (const f of r.from) r.notes.push({ code: /^(\.{0,2}\/|~|[A-Za-z]:\\)/.test(f) || /\.(gguf|safetensors)$/i.test(f) ? "fromPath" : "fromName", detail: f });
  if (r.renderer || r.parser) r.notes.push({ code: "rendererParser" });
  for (const m of r.messages) if (m.content === "") r.notes.push({ code: "messageNoContent", detail: m.role });

  // サーバー: TEMPLATE を読む
  if (r.template !== null && r.template !== "") {
    try {
      r.templateInfo = parseTemplate(r.template);
      if (!r.templateInfo.vars.includes("messages")) r.notes.push({ code: "legacyTemplate" });
      else if (!r.templateInfo.vars.includes("tools")) r.notes.push({ code: "templateNoTools" });
    } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      r.error = new ModelfileError(`template error: ${e.message}`, cmds.find((c) => c.name === "template")?.line ?? null, "server");
    }
  }
  return r;
}

/** params の層の JSON(キーの順は Go の map の json と同じく名前の順)。 */
export function paramsJson(params: [string, ParamValue][]): string {
  return "{" + params.map(([k, v]) => `${strJson(k)}:${v.json}`).join(",") + "}";
}
