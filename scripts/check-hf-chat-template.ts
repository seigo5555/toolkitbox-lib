/**
 * HF Chat Template Tester(src/lib/jinja2.ts・py-value.ts・hf-chat-template.ts)の検算。
 *
 * 期待値はすべて本物の Python で出したもの(このツールの出力ではない):
 *   transformers 5.22.2 の _compile_jinja_template(Jinja2 3.1.6・ImmutableSandboxedEnvironment)で描画した結果と、
 *   render_jinja_template(apply_chat_template の中身)で公開モデルのチャットテンプレートを描画した結果。
 * fixtures は scripts/fixtures/hf-chat-template/ にある(作り方は sources.json)。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { applyChatTemplate, selectTemplate } from "../src/hf-chat-template";
import { Template } from "../src/jinja2";
import { PyDict, PyException, jsonLoads, type PyVal } from "../src/py-value";

let pass = 0;
let fail = 0;
const only = process.argv[2];
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++;
    console.error(`NG ${name}\n  actual:   ${a?.slice(0, 700)}\n  expected: ${e?.slice(0, 700)}`);
  }
}

const dir = join("scripts", "fixtures", "hf-chat-template");
const get = (d: PyVal, k: string): PyVal | undefined => (d instanceof PyDict ? d.get(k) : undefined);
const NOW = new Date(2026, 10, 9, 12, 0, 0);

type Out = { out: string; gen?: number[][] } | { vars: string[] } | { error: string; message: string; line: number | null };

function run(c: PyDict, templates: PyDict | null, sharedCtx: PyVal | undefined): Out {
  const ref = get(c, "templateRef");
  const template = (typeof ref === "string" && templates ? templates.get(ref) : get(c, "template")) as string;
  const chat = get(c, "chat");
  const mode = get(c, "mode");
  try {
    if (mode === "vars") return { vars: new Template(template).undeclared };
    if (mode === "select") {
      const t = get(c, "templates") as PyDict;
      const name = get(c, "case");
      const tools = get(c, "tools");
      return { out: selectTemplate(new Map(t.entries().map(([k, v]) => [k as string, v as string])), tools !== null && tools !== undefined, typeof name === "string" ? name : null).template };
    }
    if (chat instanceof PyDict) {
      const kw = get(chat, "kwargs");
      const r = applyChatTemplate({
        template,
        messages: get(chat, "messages")!,
        tools: get(chat, "tools") ?? null,
        documents: get(chat, "documents") ?? null,
        addGenerationPrompt: get(chat, "add_generation_prompt") === true,
        continueFinalMessage: (get(chat, "continue_final_message") as boolean | string | undefined) ?? false,
        kwargs: kw instanceof PyDict ? new Map(kw.entries().map(([k, v]) => [k as string, v])) : new Map(),
        now: NOW,
      });
      if (get(c, "gen") === true) return { out: r.output, gen: r.generation };
      return { out: r.output };
    }
    const ctx = get(c, "ctx") ?? sharedCtx;
    const vars = new Map<string, PyVal>(ctx instanceof PyDict ? ctx.entries().map(([k, v]) => [k as string, v]) : []);
    return { out: new Template(template).render(vars, NOW).output };
  } catch (e) {
    if (e instanceof PyException) return { error: e.pyType, message: e.message, line: e.lineno };
    return { error: "JS", message: String((e as Error)?.stack ?? e), line: null };
  }
}

const files = process.env.HF_FIXTURES ? process.env.HF_FIXTURES.split(",") : readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "sources.json").sort().map((f) => join(dir, f));
for (const file of files) {
  const doc = jsonLoads(readFileSync(file, "utf8"));
  const templates = doc instanceof PyDict ? ((doc.get("templates") as PyDict) ?? null) : null;
  const sharedCtx = doc instanceof PyDict ? doc.get("ctx") : undefined;
  const cases = (doc instanceof PyDict ? doc.get("cases") : doc) as PyVal[];
  for (const c of cases as PyDict[]) {
    const name = `${file}:${get(c, "name")}`;
    if (only && !name.includes(only)) continue;
    const exp = get(c, "expected") as PyDict;
    const got = run(c, templates, sharedCtx);
    if (exp.has("vars")) eq(name, got, { vars: exp.get("vars") });
    else if (exp.has("gen")) eq(name, got, { out: exp.get("out"), gen: (exp.get("gen") as bigint[][]).map((x) => x.map(Number)) });
    else if (exp.has("out")) eq(name, got, { out: exp.get("out") });
    else {
      const e = { error: exp.get("error"), message: exp.get("message"), line: exp.get("line") === null ? null : Number(exp.get("line")) };
      // Python の SyntaxError(break が for の外)は生成コードの行番号が入るので、文言の頭だけ比べる
      if (e.error === "SyntaxError" && "error" in got) eq(name, [got.error, got.message], [e.error, (e.message as string).replace(/ \(<template>, line \d+\)$/, "")]);
      else eq(name, got, e);
    }
  }
}

console.log(`check-hf-chat-template: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
