/**
 * Ollama の Modelfile の TEMPLATE(Go のテンプレート)に、/api/chat や /api/generate の要求を流して、
 * モデルに渡る文字列(プロンプト)を組み立てる。ブラウザの外には何も送らない。
 *
 * 出どころ(ollama/ollama v0.40.15。v0.40.11 と同じ):
 *  - template/template.go: Parse(.Messages も .Response も使わないテンプレートの末尾に {{ .Response }} を足す)、
 *    Vars/Identifiers、Execute の3つの流れ(Prompt と Suffix がある / .Messages を使う / 昔の形で1往復ずつ実行)、
 *    collate(同じ役割の続くメッセージを "\n\n" でつなぐ。tool は除く。system はすべて "\n\n" でつないで .System に)、
 *    テンプレートに渡す型(templateMessage・templateToolCall・templateTool…)、関数 json・currentDate・yesterdayDate・toTypeScriptType
 *  - server/prompt.go: chatPrompt(画像は [img-N] を内容の先頭に。"[img]" があればそこを置き換える)
 *  - server/routes.go: /api/chat はモデルの SYSTEM を、最初のメッセージが system でなければ先頭に足す。
 *    /api/generate は system(または SYSTEM)+ prompt の2つのメッセージ、suffix があれば Prompt と Suffix だけ
 *  - server/images.go: TEMPLATE と GGUF の tokenizer.chat_template のどちらを使うか(shouldPreferChatTemplate)。
 *    ログの "template selection ... selected=" に出る
 *  - thinking/template.go: InferTags(.Messages の range の中の .Thinking の周りの文字から thinking のタグを推す)、
 *    TemplateSupportsThinking
 *  - api/types.go: ToolProperty・PropertyType・ThinkValue(true は ThinkLevel "medium")
 *
 * 手元の Ollama 0.40.11 で、_debug_render_only: true を付けた要求の rendered_template と突き合わせている(scripts/check-ollama-template.ts)。
 */

import {
  ExecError,
  GV,
  INVALID,
  T_ANY,
  T_ANY_MAP,
  T_BOOL,
  T_INT,
  T_STRING,
  T_STRINGS,
  TemplateError,
  bool,
  compile,
  execute,
  fromJson,
  int,
  iface,
  jsonQuote,
  map,
  marshal,
  mapOf,
  ptr,
  ptrTo,
  slice,
  sliceOf,
  str,
  struct,
  type BranchNode,
  type GoType,
  type ListNode,
  type Node,
  type Template,
  type UserFunc,
} from "./go-template";

export const TEMPLATE_DOC_URL = "https://docs.ollama.com/template";
export const OLLAMA_SOURCE_VERSION = "v0.40.15";
export const TEMPLATE_VERIFIED_ON = "2026-11-09";

// ---------------------------------------------------------------- Ollama の型

const T_IMAGE: GoType = { name: "api.ImageData", kind: "slice", elem: { name: "uint8", kind: "int" }, bytes: true };

const orderedJson = (entries: [string, string][]) => "{" + entries.map(([k, v]) => jsonQuote(k) + ":" + v).join(",") + "}";

const T_PROPERTY_TYPE: GoType = {
  name: "api.PropertyType",
  kind: "slice",
  elem: T_STRING,
  stringer: (v) => {
    const xs = ((v.v as GV[] | null) ?? []).map((x) => x.v as string);
    return xs.length === 0 ? "" : xs.length === 1 ? xs[0] : `[${xs.join(" ")}]`;
  },
  marshalJSON: (v) => {
    const xs = ((v.v as GV[] | null) ?? []).map((x) => x.v as string);
    if (xs.length === 1) return jsonQuote(xs[0]);
    return v.v === null ? "null" : "[" + xs.map(jsonQuote).join(",") + "]";
  },
};

// ToolPropertiesMap は順番を保つ(json もその順)。中身は非公開なのでテンプレートからは Len と ToMap だけ
const T_PROPS_MAP_STRUCT: GoType = { name: "api.ToolPropertiesMap", kind: "struct", fields: [{ name: "om", type: T_ANY }] };
const T_TOOL_PROPERTY: GoType = { name: "api.ToolProperty", kind: "struct", fields: [] };
const T_PROPS_MAP_PTR: GoType = {
  name: "*api.ToolPropertiesMap",
  kind: "ptr",
  elem: T_PROPS_MAP_STRUCT,
  marshalJSON: (v) => {
    if (v.v === null) return "null";
    const entries = (((v.v as GV).v as GV[])[0].v as unknown as [string, GV][]) ?? [];
    return orderedJson(entries.map(([k, x]) => [k, marshal(x)]));
  },
  methods: {
    Len: (v) => int(v.v === null ? 0 : ((((v.v as GV).v as GV[])[0].v as unknown as [string, GV][]) ?? []).length),
    ToMap: (v) => {
      if (v.v === null) return map(mapOf(T_TOOL_PROPERTY), null);
      const entries = (((v.v as GV).v as GV[])[0].v as unknown as [string, GV][]) ?? [];
      return map(mapOf(T_TOOL_PROPERTY), new Map(entries));
    },
  },
};
T_TOOL_PROPERTY.fields = [
  { name: "AnyOf", type: sliceOf(T_TOOL_PROPERTY), json: { name: "anyOf", omitempty: true } },
  { name: "Type", type: T_PROPERTY_TYPE, json: { name: "type", omitempty: true } },
  { name: "Items", type: T_ANY, json: { name: "items", omitempty: true } },
  { name: "Description", type: T_STRING, json: { name: "description", omitempty: true } },
  { name: "Enum", type: sliceOf(T_ANY), json: { name: "enum", omitempty: true } },
  { name: "Properties", type: T_PROPS_MAP_PTR, json: { name: "properties", omitempty: true } },
  { name: "Required", type: T_STRINGS, json: { name: "required", omitempty: true } },
];
T_TOOL_PROPERTY.methods = { ToTypeScriptType: (v) => str(toTypeScriptType(v)) };

const T_PROPERTIES: GoType = {
  name: "template.templateProperties",
  kind: "map",
  elem: T_TOOL_PROPERTY,
  stringer: (v) => (v.v === null ? "{}" : marshal(map(mapOf(T_TOOL_PROPERTY), v.v as Map<string, GV>))),
};
const T_PARAMS: GoType = {
  name: "template.templateToolFunctionParameters",
  kind: "struct",
  fields: [
    { name: "Type", type: T_STRING, json: { name: "type", omitempty: false } },
    { name: "Defs", type: T_ANY, json: { name: "$defs", omitempty: true } },
    { name: "Items", type: T_ANY, json: { name: "items", omitempty: true } },
    { name: "Required", type: T_STRINGS, json: { name: "required", omitempty: true } },
    { name: "Properties", type: T_PROPERTIES, json: { name: "properties", omitempty: false } },
  ],
};
const T_FUNCTION: GoType = {
  name: "template.templateToolFunction",
  kind: "struct",
  fields: [
    { name: "Name", type: T_STRING, json: { name: "name", omitempty: false } },
    { name: "Description", type: T_STRING, json: { name: "description", omitempty: false } },
    { name: "Parameters", type: T_PARAMS, json: { name: "parameters", omitempty: false } },
  ],
};
const T_TOOL: GoType = {
  name: "template.templateTool",
  kind: "struct",
  fields: [
    { name: "Type", type: T_STRING, json: { name: "type", omitempty: false } },
    { name: "Items", type: T_ANY, json: { name: "items", omitempty: true } },
    { name: "Function", type: T_FUNCTION, json: { name: "function", omitempty: false } },
  ],
  stringer: (v) => marshal(new GV({ ...T_TOOL, stringer: undefined }, v.v)),
};
const T_TOOLS: GoType = {
  name: "template.templateTools",
  kind: "slice",
  elem: T_TOOL,
  stringer: (v) => marshal(new GV({ ...T_TOOLS, stringer: undefined }, v.v)),
};
const T_ARGS: GoType = {
  name: "template.templateArgs",
  kind: "map",
  elem: T_ANY,
  stringer: (v) => (v.v === null ? "{}" : marshal(map(T_ANY_MAP, v.v as Map<string, GV>))),
};
const T_CALL_FUNCTION: GoType = {
  name: "template.templateToolCallFunction",
  kind: "struct",
  fields: [
    { name: "Index", type: T_INT },
    { name: "Name", type: T_STRING },
    { name: "Arguments", type: T_ARGS },
  ],
};
const T_CALL: GoType = {
  name: "template.templateToolCall",
  kind: "struct",
  fields: [
    { name: "ID", type: T_STRING },
    { name: "Function", type: T_CALL_FUNCTION },
  ],
};
const T_MESSAGE: GoType = {
  name: "template.templateMessage",
  kind: "struct",
  fields: [
    { name: "Role", type: T_STRING },
    { name: "Content", type: T_STRING },
    { name: "Thinking", type: T_STRING },
    { name: "Images", type: sliceOf(T_IMAGE, "[]api.ImageData") },
    { name: "ToolCalls", type: sliceOf(T_CALL) },
    { name: "ToolName", type: T_STRING },
    { name: "ToolCallID", type: T_STRING },
  ],
};
const T_MESSAGE_PTR = ptrTo(T_MESSAGE);
const T_MESSAGES = sliceOf(T_MESSAGE_PTR);

function toTypeScriptType(v: GV): string {
  const f = v.v as GV[];
  const anyOf = (f[0].v as GV[] | null) ?? [];
  if (anyOf.length) return anyOf.map(toTypeScriptType).join(" | ");
  const types = ((f[1].v as GV[] | null) ?? []).map((x) => x.v as string);
  const m = (t: string) => ({ string: "string", number: "number", integer: "number", boolean: "boolean", array: "any[]", object: "Record<string, any>", null: "null" })[t] ?? "any";
  if (types.length === 0) return "any";
  return types.map(m).join(" | ");
}

// ---------------------------------------------------------------- 要求(JSON)から Go の値へ

export type ApiToolCall = { id?: string; function: { index?: number; name: string; arguments?: Record<string, unknown> } };
export type ApiMessage = { role: string; content?: string; thinking?: string; images?: unknown[]; tool_calls?: ApiToolCall[]; tool_name?: string; tool_call_id?: string };
export type ApiTool = { type?: string; items?: unknown; function?: { name?: string; description?: string; parameters?: Record<string, unknown> } };

function toolProperty(x: unknown): GV {
  const o = x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
  const typ = o.type === undefined ? null : Array.isArray(o.type) ? (o.type as unknown[]).map((t) => str(String(t))) : [str(String(o.type))];
  return struct(T_TOOL_PROPERTY, [
    slice(sliceOf(T_TOOL_PROPERTY), Array.isArray(o.anyOf) ? (o.anyOf as unknown[]).map(toolProperty) : null),
    slice(T_PROPERTY_TYPE, typ),
    o.items === undefined ? new GV(T_ANY, null) : fromJson(o.items),
    str(typeof o.description === "string" ? o.description : ""),
    slice(sliceOf(T_ANY), Array.isArray(o.enum) ? (o.enum as unknown[]).map(fromJson) : null),
    propertiesMap(o.properties),
    slice(T_STRINGS, Array.isArray(o.required) ? (o.required as unknown[]).map((r) => str(String(r))) : null),
  ]);
}
function propertiesMap(x: unknown): GV {
  if (!x || typeof x !== "object" || Array.isArray(x)) return ptr(T_PROPS_MAP_PTR, null);
  const entries = Object.entries(x as Record<string, unknown>).map(([k, v]) => [k, toolProperty(v)] as [string, GV]);
  return ptr(T_PROPS_MAP_PTR, struct(T_PROPS_MAP_STRUCT, [new GV(T_ANY, entries as unknown as GV)]));
}

function convertTools(tools: ApiTool[] | null): GV {
  if (tools === null) return slice(T_TOOLS, null);
  return slice(
    T_TOOLS,
    tools.map((t) => {
      const fn = t.function ?? {};
      const p = fn.parameters ?? {};
      const props = p.properties && typeof p.properties === "object" && !Array.isArray(p.properties) ? Object.entries(p.properties as Record<string, unknown>) : null;
      return struct(T_TOOL, [
        str(typeof t.type === "string" ? t.type : ""),
        t.items === undefined ? new GV(T_ANY, null) : fromJson(t.items),
        struct(T_FUNCTION, [
          str(typeof fn.name === "string" ? fn.name : ""),
          str(typeof fn.description === "string" ? fn.description : ""),
          struct(T_PARAMS, [
            str(typeof p.type === "string" ? p.type : ""),
            p.$defs === undefined ? new GV(T_ANY, null) : fromJson(p.$defs),
            p.items === undefined ? new GV(T_ANY, null) : fromJson(p.items),
            slice(T_STRINGS, Array.isArray(p.required) ? (p.required as unknown[]).map((r) => str(String(r))) : null),
            map(T_PROPERTIES, props ? new Map(props.map(([k, v]) => [k, toolProperty(v)])) : null),
          ]),
        ]),
      ]);
    }),
  );
}

function convertMessages(msgs: Msg[]): GV {
  if (msgs.length === 0) return slice(T_MESSAGES, null);
  return slice(
    T_MESSAGES,
    msgs.map((m) => {
      const calls = (m.tool_calls ?? []).map((tc) =>
        struct(T_CALL, [
          str(tc.id ?? ""),
          struct(T_CALL_FUNCTION, [
            int(tc.function?.index ?? 0),
            str(tc.function?.name ?? ""),
            tc.function?.arguments && typeof tc.function.arguments === "object"
              ? map(T_ARGS, new Map(Object.entries(tc.function.arguments).map(([k, v]) => [k, fromJson(v)])))
              : map(T_ARGS, new Map()),
          ]),
        ]),
      );
      const images = (m.images ?? []).map(() => slice(T_IMAGE, []));
      return ptr(
        T_MESSAGE_PTR,
        struct(T_MESSAGE, [
          str(m.role),
          str(m.content ?? ""),
          str(m.thinking ?? ""),
          slice(sliceOf(T_IMAGE, "[]api.ImageData"), images.length ? images : null),
          slice(sliceOf(T_CALL), calls.length ? calls : null),
          str(m.tool_name ?? ""),
          str(m.tool_call_id ?? ""),
        ]),
      );
    }),
  );
}

type Msg = ApiMessage & { content: string };

// ---------------------------------------------------------------- テンプレート(template.go)

const fixedDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function ollamaFuncs(now: Date): Record<string, UserFunc> {
  const yesterday = new Date(now.getTime() - 86400000);
  return {
    json: {
      variadic: false,
      nIn: 1,
      argTypes: ["any"],
      fn: ([v]) => {
        try {
          return str(marshal(v));
        } catch {
          return str("");
        }
      },
    },
    currentDate: { variadic: true, nIn: 1, argTypes: ["string"], fn: () => str(fixedDate(now)) },
    yesterdayDate: { variadic: true, nIn: 1, argTypes: ["string"], fn: () => str(fixedDate(yesterday)) },
    toTypeScriptType: {
      variadic: false,
      nIn: 1,
      argTypes: ["any"],
      fn: ([v]) => {
        let x = v;
        if (x.valid && x.kind === "iface") x = x.v === null ? INVALID : (x.v as GV);
        if (x.valid && x.type === T_TOOL_PROPERTY) return str(toTypeScriptType(x));
        return str("any");
      },
    },
  };
}

export type OllamaTemplate = { tmpl: Template; raw: string; vars: string[]; appendedResponse: boolean };

/** Identifiers(template.go)。.Messages や $.Tools のような名前を集める。 */
function identifiers(n: Node | null): string[] {
  if (!n) return [];
  switch (n.t) {
    case "list":
      return n.nodes.flatMap(identifiers);
    case "template":
      if (!n.pipe) throw new Error("undefined template specified");
      return identifiers(n.pipe);
    case "action":
      return identifiers(n.pipe);
    case "if":
    case "range":
    case "with":
      return [...identifiers(n.pipe), ...identifiers(n.list), ...(n.elseList ? identifiers(n.elseList) : [])];
    case "pipe":
      return n.cmds.flatMap((c) => c.args.flatMap(identifiers));
    case "field":
    case "variable":
      return n.ident;
  }
  return [];
}

export function parseTemplate(raw: string, now = new Date()): OllamaTemplate {
  const tmpl = compile(raw, ollamaFuncs(now));
  const all = [tmpl.root, ...tmpl.defs.values()];
  let names: string[];
  try {
    names = all.flatMap((r) => r.nodes.flatMap(identifiers));
  } catch (e) {
    throw new TemplateError((e as Error).message);
  }
  const vars = [...new Set(names.map((x) => x.toLowerCase()))].sort();
  let appendedResponse = false;
  if (!vars.includes("messages") && !vars.includes("response")) {
    const pos = new TextEncoder().encode(raw).length;
    tmpl.root.nodes.push({ t: "action", pos, line: 0, pipe: { t: "pipe", pos, line: 0, isAssign: false, decl: [], cmds: [{ t: "command", pos, args: [{ t: "field", pos, ident: ["Response"] }] }] } });
    appendedResponse = true;
    vars.push("response");
    vars.sort();
  }
  return { tmpl, raw, vars, appendedResponse };
}

export type Think = null | boolean | string;
export type Values = { messages: Msg[]; tools: ApiTool[] | null; prompt?: string; suffix?: string; think: Think };
export type Flow = "suffix" | "messages" | "legacy";

function thinkFields(think: Think): [string, GV][] {
  const b = think === null || think === false ? false : true;
  const level = think === null ? "" : typeof think === "string" ? think : think ? "medium" : "";
  return [
    ["Think", bool(b)],
    ["ThinkLevel", str(level)],
    ["IsThinkSet", bool(think !== null)],
  ];
}
const root = (entries: [string, GV][]) => map(T_ANY_MAP, new Map(entries.map(([k, v]) => [k, iface(v)])));

function collate(msgs: Msg[]): [string, Msg[]] {
  const system: string[] = [];
  const out: Msg[] = [];
  for (const m of msgs) {
    if (m.role === "system") system.push(m.content);
    const last = out[out.length - 1];
    if (last && last.role === m.role && m.role !== "tool") last.content += "\n\n" + m.content;
    else out.push({ ...m });
  }
  return [system.join("\n\n"), out];
}

/** template.Execute。 */
export function executeTemplate(t: OllamaTemplate, v: Values): { output: string; flow: Flow } {
  const [system, messages] = collate(v.messages);
  const think = thinkFields(v.think);
  if (v.prompt && v.suffix) {
    return { output: execute(t.tmpl, root([["Prompt", str(v.prompt)], ["Suffix", str(v.suffix)], ["Response", str("")], ...think])), flow: "suffix" };
  }
  if (t.vars.includes("messages")) {
    return {
      output: execute(t.tmpl, root([["System", str(system)], ["Messages", convertMessages(messages)], ["Tools", convertTools(v.tools)], ["Response", str("")], ...think])),
      flow: "messages",
    };
  }
  // 昔の形: system/user/assistant を1往復ずつ実行し、最後は {{ .Response }} から後ろを消して実行する
  let out = "";
  let sys = "";
  let prompt = "";
  let response = "";
  const run = () => {
    out += execute(t.tmpl, root([["System", str(sys)], ["Prompt", str(prompt)], ["Response", str(response)], ...think]));
    sys = "";
    prompt = "";
    response = "";
  };
  for (const m of messages) {
    if (m.role === "system") {
      if (prompt !== "" || response !== "") run();
      sys = m.content;
    } else if (m.role === "user") {
      if (response !== "") run();
      prompt = m.content;
    } else if (m.role === "assistant") response = m.content;
  }
  const cut = cutAfterResponse(t.tmpl.root);
  // Go は消した木を関数も missingkey=zero も無い新しいテンプレートで実行する
  out += execute({ ...t.tmpl, root: cut, funcs: {} }, root([["System", str(sys)], ["Prompt", str(prompt)], ["Response", str(response)], ...think]), cut, { missingKeyZero: false });
  return { output: out, flow: "legacy" };
}

/** deleteNode(template.go): 最初の .Response より後ろの節を消した木。 */
function cutAfterResponse(rootList: ListNode): ListNode {
  let cut = false;
  const fn = (n: Node) => {
    if (n.t === "field" && n.ident.includes("Response")) {
      cut = true;
      return false;
    }
    return cut;
  };
  const walk = (n: Node): Node | null => {
    if (fn(n)) return null;
    switch (n.t) {
      case "list":
        return { ...n, nodes: n.nodes.map(walk).filter((x): x is Node => x !== null) };
      case "if":
      case "with":
      case "range": {
        const b = n as BranchNode;
        if (fn(b)) return null;
        const list = walk(b.list) as ListNode;
        const elseList = b.elseList ? (walk(b.elseList) as ListNode) : null;
        return { ...b, list, elseList };
      }
      case "action": {
        const p = walk(n.pipe);
        if (!p) return null;
        return { ...n, pipe: p as typeof n.pipe };
      }
      case "pipe": {
        const cmds = [];
        for (const c of n.cmds) {
          const args = c.args.map(walk).filter((x): x is Node => x !== null);
          if (args.length === 0) return null;
          cmds.push({ ...c, args });
        }
        if (cmds.length === 0) return null;
        return { ...n, cmds };
      }
    }
    return n;
  };
  return walk(rootList) as ListNode;
}

// ---------------------------------------------------------------- 要求ごとの組み立て(routes.go・prompt.go)

export type ChatRequest = { messages: ApiMessage[]; tools?: ApiTool[] | null; think?: Think };
export type ModelInfo = { system?: string; messages?: ApiMessage[] };

function imageTags(msgs: Msg[]): Msg[] {
  let id = 0;
  return msgs.map((m) => {
    if (!m.images?.length) return m;
    let prefix = "";
    let content = m.content;
    for (let i = 0; i < m.images.length; i++) {
      const tag = `[img-${id++}]`;
      if (!content.includes("[img]")) prefix += tag;
      else content = content.replace("[img]", tag);
    }
    return { ...m, content: prefix + content };
  });
}
const norm = (m: ApiMessage): Msg => ({ ...m, role: String(m.role ?? "").toLowerCase(), content: m.content ?? "" });

/** Ollama が要求を断る理由(routes.go: ツールを渡したのにテンプレートが tools に対応していない・think が true なのに thinking に対応していない)。 */
export class RefusedError extends Error {
  constructor(public capability: "tools" | "thinking") {
    super(`does not support ${capability}`);
  }
}

/** routes.go: thinking に対応したテンプレートで think を指定しないと true になる。対応していないのに true(や段階)なら断る。 */
export function resolveThink(t: OllamaTemplate, think: Think | undefined, capsOverride?: Capability[]): Think {
  const caps = capsOverride ?? goTemplateCapabilities(t);
  const v = think === undefined ? null : think;
  if (caps.includes("thinking")) return v === null ? true : v;
  if (v !== null && v !== false) throw new RefusedError("thinking");
  return v;
}

/** /api/chat(Go のテンプレートが選ばれたとき)。capsOverride は、断るかどうかを別のテンプレート(GGUF のチャットテンプレート)の機能で決めるとき。 */
export function renderChat(t: OllamaTemplate, req: ChatRequest, model: ModelInfo = {}, capsOverride?: Capability[]) {
  const reqMsgs = req.messages.map(norm);
  if (reqMsgs.length === 0) return { output: "", flow: "messages" as Flow, messages: [] as Msg[], think: null as Think };
  const caps = capsOverride ?? goTemplateCapabilities(t);
  const think = resolveThink(t, req.think, caps);
  if (req.tools?.length && !caps.includes("tools")) throw new RefusedError("tools");
  let msgs = [...(model.messages ?? []).map(norm), ...reqMsgs];
  if (reqMsgs[0].role !== "system" && model.system) msgs = [{ role: "system", content: model.system }, ...msgs];
  msgs = imageTags(msgs);
  const r = executeTemplate(t, { messages: msgs, tools: req.tools ?? null, think });
  return { ...r, messages: msgs, think };
}

export type GenerateRequest = { prompt: string; system?: string; suffix?: string; think?: Think; images?: unknown[] };

/** /api/generate(template を指定したとき、または Go のテンプレートが選ばれたとき)。
 *  think の扱いはモデルの機能で決まる(template を指定したときもモデル側の機能)ので、modelThinking で渡す。 */
export function renderGenerate(t: OllamaTemplate, req: GenerateRequest, model: ModelInfo & { thinking?: boolean } = {}) {
  let think: Think = req.think ?? null;
  if (model.thinking) think = think === null ? true : think;
  else if (think !== null && think !== false) throw new RefusedError("thinking");
  req = { ...req, think };
  if (req.suffix) return executeTemplate(t, { messages: [], tools: null, prompt: req.prompt, suffix: req.suffix, think: req.think ?? null });
  const msgs: Msg[] = [];
  if (req.system) msgs.push({ role: "system", content: req.system });
  else if (model.system) msgs.push({ role: "system", content: model.system });
  msgs.push(...(model.messages ?? []).map(norm));
  msgs.push({ role: "user", content: req.prompt, images: req.images });
  return executeTemplate(t, { messages: imageTags(msgs), tools: null, think: req.think ?? null });
}

// ---------------------------------------------------------------- どちらのテンプレートが使われるか(images.go)

export type Capability = "tools" | "insert" | "thinking";

/** InferTags(thinking/template.go)。 */
export function inferThinkingTags(t: OllamaTemplate): [string, string] {
  const ancestors: Node[] = [];
  let open = "";
  let close = "";
  const rangeUses = (r: BranchNode, field: string) => {
    let found = false;
    visit(r.pipe, (n) => {
      if (n.t === "field" && n.ident[0] === field) found = true;
      return true;
    });
    return found;
  };
  const visit = (n: Node | null, enter: (n: Node) => boolean, exit?: () => void) => {
    if (!n) return;
    if (!enter(n)) return;
    switch (n.t) {
      case "list":
        n.nodes.forEach((c) => visit(c, enter, exit));
        break;
      case "if":
      case "range":
      case "with":
        visit(n.pipe, enter, exit);
        visit(n.list, enter, exit);
        if (n.elseList) visit(n.elseList, enter, exit);
        break;
      case "action":
        visit(n.pipe, enter, exit);
        break;
      case "template":
        visit(n.pipe, enter, exit);
        break;
      case "pipe":
        n.cmds.forEach((c) => visit(c, enter, exit));
        break;
      case "command":
        n.args.forEach((a) => visit(a, enter, exit));
        break;
    }
    exit?.();
  };
  visit(
    t.tmpl.root,
    (n) => {
      ancestors.push(n);
      if (n.t === "field" && n.ident[0] === "Thinking") {
        let range: BranchNode | null = null;
        for (let i = ancestors.length - 1; i >= 0; i--) {
          const a = ancestors[i];
          if (a.t === "range") {
            range = a as BranchNode;
            break;
          }
        }
        if (!range || !rangeUses(range, "Messages")) return true;
        for (let i = ancestors.length - 1; i >= 0; i--) {
          const a = ancestors[i];
          if (a.t === "list") {
            const first = a.nodes[0];
            if (first?.t === "text") open = first.text.trim();
            const last = a.nodes[a.nodes.length - 1];
            if (last?.t === "text") close = last.text.trim();
            break;
          }
        }
      }
      return true;
    },
    () => {
      ancestors.pop();
    },
  );
  return [open, close];
}

export function goTemplateCapabilities(t: OllamaTemplate): Capability[] {
  const caps: Capability[] = [];
  if (t.vars.includes("tools")) caps.push("tools");
  if (t.vars.includes("suffix")) caps.push("insert");
  const [o, c] = inferThinkingTags(t);
  if (o && c) caps.push("thinking");
  return caps;
}
export function goTemplateHasToolRoundTrip(t: OllamaTemplate) {
  if (!t.vars.includes("tools") || !t.vars.includes("toolcalls")) return false;
  return t.raw.includes('eq .Role "tool"') || t.raw.includes("tool_response") || t.raw.includes("TOOL_RESULTS");
}

const chatHasTools = (c: string) => c.includes("tools") || c.includes("tool_call");
export function chatTemplateCapabilities(c: string): Capability[] {
  if (!c) return [];
  const caps: Capability[] = [];
  if (chatHasTools(c)) caps.push("tools");
  const thinking =
    (c.includes("<think>") && c.includes("</think>")) ||
    ((c.includes("content.split('</think>')") || c.includes('content.split("</think>")')) && !c.includes("reasoning_content") && !c.includes("<SPECIAL_12>"));
  if (thinking) caps.push("thinking");
  return caps;
}
export function chatTemplateHasToolRoundTrip(c: string) {
  if (!chatHasTools(c)) return false;
  const calls = c.includes("tool_calls") || c.includes("assistant_tool_call");
  return (
    calls &&
    (c.includes("tool_response") ||
      c.includes("tool_results") ||
      c.includes("role'] == 'tool'") ||
      c.includes(`role'] == "tool"`) ||
      c.includes(`role"] == 'tool'`) ||
      c.includes(`role"] == "tool"`) ||
      c.includes("message.role == 'tool'") ||
      c.includes(`message.role == "tool"`) ||
      c.includes("ipython"))
  );
}
const chatHasToolCallIDs = (c: string) => c.includes("[CALL_ID]") && c.includes("tool_call.id");

export type Selection = {
  goCaps: Capability[];
  chatCaps: Capability[];
  /** OLLAMA_GO_TEMPLATE を設定していないときに選ばれるもの。 */
  selected: "go_template" | "gguf_chat_template";
  reason: "noChatTemplate" | "chatMoreCaps" | "goRoundTrip" | "chatCallIds" | "chatRoundTrip" | "notMore";
};

/** shouldPreferChatTemplate(images.go)。RENDERER・PARSER・gpt-oss(harmony)のときは別の仕組みなのでここでは扱わない。 */
export function selectTemplate(t: OllamaTemplate, chatTemplate: string): Selection {
  const goCaps = goTemplateCapabilities(t);
  const chatCaps = chatTemplateCapabilities(chatTemplate);
  const base = { goCaps, chatCaps };
  if (!chatTemplate) return { ...base, selected: "go_template", reason: "noChatTemplate" };
  if (chatCaps.length > goCaps.length) {
    const prefer = !goTemplateHasToolRoundTrip(t) || chatTemplateHasToolRoundTrip(chatTemplate);
    return { ...base, selected: prefer ? "gguf_chat_template" : "go_template", reason: prefer ? "chatMoreCaps" : "goRoundTrip" };
  }
  const same = chatCaps.length === goCaps.length && chatCaps.every((c) => goCaps.includes(c));
  if (!same || !chatCaps.includes("tools") || !goCaps.includes("tools")) return { ...base, selected: "go_template", reason: "notMore" };
  if (chatHasToolCallIDs(chatTemplate)) return { ...base, selected: "gguf_chat_template", reason: "chatCallIds" };
  const prefer = chatTemplateHasToolRoundTrip(chatTemplate) && !goTemplateHasToolRoundTrip(t);
  return { ...base, selected: prefer ? "gguf_chat_template" : "go_template", reason: prefer ? "chatRoundTrip" : "notMore" };
}

export { ExecError, TemplateError };
export const _types = { T_MESSAGE, T_TOOL, T_TOOLS, T_ARGS, T_BOOL, T_ANY };
