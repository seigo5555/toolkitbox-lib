/**
 * Ollama Template Tester(src/lib/go-template.ts・src/lib/ollama-template.ts)の検算。
 * 期待値はどれもこのツールの出力ではない(scripts/fixtures/ollama-template/cases.json):
 *
 * 1) Go 本物: Ollama v0.40.15 の template/template.go を写した小さなプログラムを Go 1.26.6 の text/template で動かした出力 243 件
 *    (組み込みテンプレート 20 種・qwen2.5:7b のテンプレート・テンプレートの文法と関数・構文エラー・昔の形・suffix)。
 *    そのプログラムは Ollama 自身の template/testdata(組み込み 20 種 × 3 = 60 ファイル)と一致することを確かめてある。
 * 2) 本物の Ollama 0.40.11: /api/generate に template を渡し _debug_render_only: true で返った文字列 330 件
 *    (qwen2.5:7b。think: true は qwen2.5 が thinking に対応していないので断られる)。
 * 3) 本物の Ollama 0.40.11: TEMPLATE を変えたモデル6つと qwen2.5:7b そのものに /api/chat を送った結果 49 件
 *    (複数の system・同じ役割の連続・ツール呼び出しと結果・画像・think)。TEMPLATE が使われず GGUF の
 *    チャットテンプレートが選ばれるモデルの見分けも含む。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { gShortest, jsonFloat, jsonQuote } from "../src/go-template";
import {
  ExecError,
  RefusedError,
  TemplateError,
  chatTemplateCapabilities,
  executeTemplate,
  goTemplateCapabilities,
  inferThinkingTags,
  parseTemplate,
  renderChat,
  renderGenerate,
  selectTemplate,
  type ApiMessage,
  type ApiTool,
  type ChatRequest,
} from "../src/ollama-template";

let pass = 0;
let fail = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++;
    console.error(`NG ${name}\n  actual:   ${a?.slice(0, 600)}\n  expected: ${e?.slice(0, 600)}`);
  }
}

const DIR = join("scripts", "fixtures", "ollama-template");
type Res = { out?: string; err?: string; parse?: string; flow?: string; vars?: string[] };
const doc = JSON.parse(readFileSync(join(DIR, "cases.json"), "utf8")) as {
  qwenSystem: string;
  templates: Record<string, string>;
  inputs: Record<string, unknown>;
  cases: { id: string; t: string; m: string; prompt?: string; suffix?: string; tools?: string; think?: boolean | string; go: Res }[];
  generate: { id: string; variant: { prompt: string; system?: string; think?: boolean }; real: { out?: string; err?: string } }[];
  chatModels: Record<string, string>;
  chat: { model: number; req: number; predicted: string; real: { out?: string; err?: string } }[];
};
const jinja = readFileSync(join(DIR, "qwen2.5-gguf-chat-template.jinja"), "utf8");
const norm = (x: string | undefined) => x?.replace(/0x[0-9a-f]{6,}/g, "0xADDR");
// テストの日付は固定(Go 側の currentDate も 2026-11-09)
const NOW = new Date(2026, 10, 9, 12);

// ---- 1) Go 本物との突き合わせ ----
{
  let n = 0;
  for (const c of doc.cases) {
    const got: Res = {};
    try {
      const t = parseTemplate(doc.templates[c.t], NOW);
      got.vars = t.vars;
      try {
        const r = executeTemplate(t, {
          messages: (doc.inputs[c.m] as ApiMessage[]).map((m) => ({ ...m, content: m.content ?? "" })),
          tools: c.tools ? (doc.inputs[c.tools] as ApiTool[]) : null,
          prompt: c.prompt,
          suffix: c.suffix,
          think: c.think ?? null,
        });
        got.out = norm(r.output);
        got.flow = r.flow;
      } catch (e) {
        if (!(e instanceof ExecError)) throw e;
        got.err = e.message;
      }
    } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      got.parse = e.message;
      delete got.vars;
    }
    const want: Res = { ...c.go };
    if (want.err || want.parse) {
      delete want.flow;
      if (want.parse) delete want.vars;
    }
    if (got.err) delete got.flow;
    // Go は失敗しても vars を返す(Parse は通っている)
    eq(`go ${c.id}`, { out: got.out, err: got.err, parse: got.parse, flow: got.flow, vars: want.parse ? undefined : got.vars }, { out: want.out, err: want.err, parse: want.parse, flow: want.flow, vars: want.parse ? undefined : want.vars });
    n++;
  }
  eq("go cases", n, 243);
}

// ---- 2) 本物の Ollama: /api/generate(template を渡す) ----
{
  const byId = new Map(doc.cases.map((c) => [c.id, c]));
  let n = 0;
  let refused = 0;
  for (const g of doc.generate) {
    const c = byId.get(g.id)!;
    let mine: { out?: string; err?: string };
    // Ollama は think を、テンプレートを読む前に断る
    if (g.variant.think) {
      refused++;
      mine = { err: '"qwen2.5:7b" does not support thinking' };
    } else try {
      const t = parseTemplate(doc.templates[c.t], NOW);
      try {
        mine = { out: renderGenerate(t, { prompt: g.variant.prompt, system: g.variant.system, think: g.variant.think ?? null }, { system: doc.qwenSystem, thinking: false }).output };
      } catch (e) {
        if (e instanceof RefusedError) {
          refused++;
          mine = { err: `"qwen2.5:7b" ${e.message}` };
        } else mine = { err: (e as Error).message };
      }
    } catch (e) {
      mine = { err: (e as Error).message };
    }
    // currentDate は実行した日の日付になる(このテストでは 2026-11-09 に固定)
    eq(`ollama generate ${g.id} ${JSON.stringify(g.variant)}`, { out: norm(mine.out), err: mine.err }, { out: g.real.out, err: g.real.err });
    n++;
  }
  eq("ollama generate cases", [n, refused], [330, 110]);
}

// ---- 3) 本物の Ollama: /api/chat ----
const TOOLS: ApiTool[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get <weather> & more",
      parameters: { type: "object", properties: { city: { type: "string", description: "City" }, days: { type: ["integer", "null"] }, unit: { type: "string", enum: ["c", "f"] } }, required: ["city"] },
    },
  },
];
const REQS: ChatRequest[] = [
  { messages: [{ role: "user", content: "hi" }] },
  {
    messages: [
      { role: "System", content: "custom sys" },
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "assistant", content: "c" },
      { role: "user", content: "d" },
    ],
  },
  {
    messages: [
      { role: "user", content: "weather?" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_9", function: { index: 0, name: "get_weather", arguments: { city: "Tokyo", days: 3, x: 1.5, html: "<b>" } } }] },
      { role: "tool", content: '{"t":20}', tool_name: "get_weather", tool_call_id: "call_9" },
      { role: "tool", content: "more" },
      { role: "assistant", content: "ok", thinking: "hmm" },
      { role: "user", content: "thanks" },
    ],
    tools: TOOLS,
  },
  {
    messages: [
      { role: "user", content: "see [img] and this", images: ["iVBORw0KGgo="] },
      { role: "assistant", content: "x" },
      { role: "user", content: "two", images: ["iVBORw0KGgo=", "iVBORw0KGgo="] },
    ],
  },
  { messages: [{ role: "user", content: "hi" }], think: false },
  { messages: [{ role: "user", content: "hi" }], think: true },
  { messages: [{ role: "user", content: "hi" }], think: "high" },
];
{
  let goSel = 0;
  let ggufSel = 0;
  for (const c of doc.chat) {
    const t = parseTemplate(doc.templates[doc.chatModels[String(c.model)]], NOW);
    const sel = selectTemplate(t, jinja);
    eq(`chat ${c.model} selection`, sel.selected, c.predicted);
    if (sel.selected === "gguf_chat_template") {
      ggufSel++;
      continue;
    }
    goSel++;
    let mine: { out?: string; err?: string };
    try {
      mine = { out: renderChat(t, REQS[c.req], { system: doc.qwenSystem }).output };
    } catch (e) {
      if (!(e instanceof RefusedError)) throw e;
      mine = { err: e.message };
    }
    if (c.real.out !== undefined) eq(`chat ${c.model} req ${c.req}`, mine, { out: c.real.out });
    else eq(`chat ${c.model} req ${c.req} refused`, !!mine.err && c.real.err!.endsWith(mine.err), true);
  }
  eq("chat cases", [goSel, ggufSel], [35, 14]);
  // GGUF が選ばれたモデル(TEMPLATE がツールに触れない)では、Ollama は同じ役割をつながない(Jinja のまま)
  const m1 = doc.chat.find((c) => c.model === 1 && c.req === 1)!;
  eq("gguf selected: user turns not merged", m1.real.out!.includes("<|im_start|>user\na<|im_end|>\n<|im_start|>user\nb"), true);
}

// ---- どちらのテンプレートか・機能(Ollama 0.40.11 の /api/show の capabilities と同じ) ----
{
  const caps = (i: number) => goTemplateCapabilities(parseTemplate(doc.templates[doc.chatModels[String(i)]], NOW));
  // /api/show の capabilities(completion を除く): 1・2 は GGUF のテンプレートが選ばれ [tools]
  eq("caps model 3", caps(3).sort(), ["thinking", "tools"]);
  eq("caps model 5", caps(5).sort(), ["insert", "tools"]);
  eq("caps model 6", caps(6), ["thinking"]);
  eq("caps model 7", caps(7), ["thinking"]);
  eq("caps qwen2.5", caps(0), ["tools"]);
  eq("chat template caps qwen2.5", chatTemplateCapabilities(jinja), ["tools"]);
  eq("thinking tags model 6", inferThinkingTags(parseTemplate(doc.templates[doc.chatModels["6"]], NOW)), ["<think>", "</think>"]);
  eq("thinking tags model 3", inferThinkingTags(parseTemplate(doc.templates[doc.chatModels["3"]], NOW)), ["(t:", ")"]);
  const sel = (i: number) => selectTemplate(parseTemplate(doc.templates[doc.chatModels[String(i)]], NOW), jinja);
  eq("select 1 (no tools in TEMPLATE)", [sel(1).selected, sel(1).reason], ["gguf_chat_template", "chatMoreCaps"]);
  eq("select 2 (tools without round trip)", [sel(2).selected, sel(2).reason], ["gguf_chat_template", "chatRoundTrip"]);
  eq("select 3", sel(3).selected, "go_template");
  eq("select qwen2.5", sel(0).selected, "go_template");
  eq("select without chat template", selectTemplate(parseTemplate("{{ .Prompt }}", NOW), "").reason, "noChatTemplate");
  const mistralIds = "{% for m in messages %}{{ m.tool_calls }}[CALL_ID]{{ tool_call.id }}{% endfor %}tools";
  const goTools = parseTemplate('{{ range .Messages }}{{ .ToolCalls }}{{ if eq .Role "tool" }}{{ end }}{{ end }}{{ .Tools }}', NOW);
  eq("select call ids", selectTemplate(goTools, mistralIds).reason, "chatCallIds");
  eq("select go round trip wins", selectTemplate(goTools, "tools <think></think>").reason, "goRoundTrip");
  eq("select chat round trip and more caps", selectTemplate(goTools, "tools tool_calls tool_response <think></think>").reason, "chatMoreCaps");
  eq("chat thinking caps", chatTemplateCapabilities("{{ content.split('</think>') }}"), ["thinking"]);
  eq("chat thinking caps reasoning_content", chatTemplateCapabilities("content.split('</think>') reasoning_content"), []);
}

// ---- think と ツールの断り(routes.go) ----
{
  const t6 = parseTemplate(doc.templates[doc.chatModels["6"]], NOW);
  const t5 = parseTemplate(doc.templates[doc.chatModels["5"]], NOW);
  eq("think unset on thinking template -> true", renderChat(t6, { messages: [{ role: "user", content: "x" }] }).think, true);
  let r = "";
  try {
    renderChat(t5, { messages: [{ role: "user", content: "x" }], think: "low" });
  } catch (e) {
    r = (e as Error).message;
  }
  eq("think on non-thinking template refused", r, "does not support thinking");
  r = "";
  try {
    renderChat(t6, { messages: [{ role: "user", content: "x" }], tools: TOOLS });
  } catch (e) {
    r = (e as Error).message;
  }
  eq("tools on non-tools template refused", r, "does not support tools");
  // GGUF のチャットテンプレートが使われるときは、断るかどうかもそちらの機能で決まる(モデル 1・2 は tools 付きでも断られなかった)
  eq("gguf caps decide refusal", renderChat(t6, { messages: [{ role: "user", content: "x" }], tools: TOOLS }, {}, chatTemplateCapabilities(jinja)).output.length > 0, true);
  eq("real: gguf-selected model 1 accepted tools", doc.chat.find((c) => c.model === 1 && c.req === 2)!.real.out !== undefined, true);
  eq("empty tools are fine", renderChat(t6, { messages: [{ role: "user", content: "x" }], tools: [] }).output.length > 0, true);
}

// ---- fmt と json の数(Go の strconv・encoding/json の規則) ----
eq("gShortest", [1, 20, 1.5, 123456, 1234567, 0.0001, 0.00001, 1e21, -0, 100000].map(gShortest), ["1", "20", "1.5", "123456", "1.234567e+06", "0.0001", "1e-05", "1e+21", "-0", "100000"]);
eq("jsonFloat", [1, 1.5, 1e21, 1e-7, 1000000, -0].map(jsonFloat), ["1", "1.5", "1e+21", "1e-7", "1000000", "-0"]);
eq("jsonQuote", jsonQuote("<a>& \b\f\x01\"\\"), '"\\u003ca\\u003e\\u0026\\u2028\\b\\f\\u0001\\"\\\\"');

console.log(`check-ollama-template: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
