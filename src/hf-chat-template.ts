/**
 * Hugging Face transformers の apply_chat_template(tokenize=False)と同じ文字列を作る。
 * transformers 5.22.2 の tokenization_utils_base.py(apply_chat_template・get_chat_template)と
 * utils/chat_template_utils.py(render_jinja_template・_alias_reasoning_fields・continue_final_message の処理)を写した。
 * テンプレートは jinja2.ts(Jinja2 3.1.6 の移植)で動かす。すべてブラウザの中だけで動き、どこにも送らない。
 *
 * 元のコードのライセンス(原文)は、toolkitbox-lib の THIRD_PARTY_NOTICES.md と、サイトの /licenses に載せている。
 */
import { Template, templateLiterals } from "./jinja2";
import { PyDict, PyException, PyTuple, cpLen, jsonLoads, pyEq, repr, type PyVal } from "./py-value";

export const TRANSFORMERS_VERSION = "5.22.2";
export const JINJA2_VERSION = "3.1.6";

/** tokenizer の special_tokens_map に入る名前(SPECIAL_TOKENS_ATTRIBUTES)。 */
export const SPECIAL_TOKEN_NAMES = ["bos_token", "eos_token", "unk_token", "sep_token", "pad_token", "cls_token", "mask_token"] as const;

const REASONING_FIELDS = ["reasoning_content", "thinking", "reasoning"];
const CONTINUE_TAG = "CONTINUE_FINAL_MESSAGE_TAG ";

export type ChatRequest = {
  template: string;
  messages: PyVal;
  tools?: PyVal;
  documents?: PyVal;
  addGenerationPrompt?: boolean;
  /** false・true・"reasoning_content" などのフィールド名。 */
  continueFinalMessage?: boolean | string;
  /** テンプレートに渡すほかの値(enable_thinking など)。special_tokens_map より後に入る。 */
  kwargs?: Map<string, PyVal>;
  specialTokens?: Map<string, string>;
  now?: Date;
};

export type ChatResult = {
  output: string;
  /** {% generation %} の範囲(コードポイントの位置)。 */
  generation: [number, number][];
};

/** _alias_reasoning_fields */
function aliasReasoning(chat: PyVal[]): PyVal[] {
  return chat.map((m) => {
    if (!(m instanceof PyDict)) return m;
    let reasoning: PyVal | undefined;
    for (const key of REASONING_FIELDS) {
      const v = m.get(key);
      if (v !== undefined && v !== null) {
        reasoning = v;
        break;
      }
    }
    if (reasoning === undefined) return m;
    // {"thinking": reasoning, **message, "reasoning_content": reasoning}
    const out = new PyDict([["thinking", reasoning]]);
    for (const [k, v] of m.entries()) out.set(k, v);
    out.set("reasoning_content", reasoning);
    return out;
  });
}

/** 入れ子の値を写す(_plain_template_data は JSON の値ならそのまま新しく作る)。 */
function plain(v: PyVal): PyVal {
  if (v instanceof PyDict) return new PyDict(v.entries().map(([k, x]) => [plain(k), plain(x)]));
  if (Array.isArray(v)) return v.map(plain);
  if (v instanceof PyTuple) return new PyTuple(v.items.map(plain));
  return v;
}

const err = (type: string, msg: string) => new PyException(type, msg);

/** render_jinja_template + apply_chat_template(tokenize=False)。 */
export function applyChatTemplate(req: ChatRequest, compiled?: Template): ChatResult {
  const { template } = req;
  let conversation = req.messages;
  if (!Array.isArray(conversation) || conversation.length === 0) {
    if (Array.isArray(conversation)) throw err("ValueError", "Cannot apply chat template to an empty conversation. Provide at least one message.");
    throw err("TypeError", "messages must be a list of message dicts");
  }
  let cfm = req.continueFinalMessage ?? false;
  const agp = req.addGenerationPrompt ?? false;
  if (cfm && agp) {
    throw err(
      "ValueError",
      "continue_final_message and add_generation_prompt are not compatible. Use continue_final_message when you want the model to continue the final message, and add_generation_prompt when you want to add a header that will prompt it to start a new assistant message instead.",
    );
  }
  const tpl = compiled ?? new Template(template);

  let tools: PyVal = null;
  if (req.tools !== undefined && req.tools !== null) {
    if (!Array.isArray(req.tools)) throw err("TypeError", `'${typeof req.tools}' object is not iterable`);
    tools = req.tools.map((t) => {
      if (!(t instanceof PyDict)) throw err("ValueError", "Tools should either be a JSON schema, or a callable function with type hints and a docstring suitable for auto-conversion to a schema.");
      return plain(t);
    });
  }
  let documents: PyVal = null;
  if (req.documents !== undefined && req.documents !== null) {
    if (!Array.isArray(req.documents)) throw err("TypeError", "Documents should be a list of dicts with 'title' and 'text' keys!");
    for (const d of req.documents) if (!(d instanceof PyDict)) throw err("TypeError", "Documents should be a list of dicts with 'title' and 'text' keys!");
    documents = plain(req.documents);
  }

  let chat = (plain(conversation) as PyVal[]).slice();
  for (const m of chat) if (!(m instanceof PyDict)) throw err("TypeError", `Chat messages should be dicts, dataclasses or pydantic models, but got ${repr(m)}.`);
  chat = aliasReasoning(chat);
  conversation = chat;

  let finalMessage: PyVal = null;
  if (cfm) {
    const field = typeof cfm === "string" ? cfm : "content";
    cfm = field;
    const last = chat[chat.length - 1] as PyDict;
    const fm = last.get(field);
    if (fm === undefined || fm === null) throw err("ValueError", `continue_final_message is set but the final message has no "${field}" to continue!`);
    finalMessage = fm;
    let fields = [field];
    if (REASONING_FIELDS.includes(field)) fields = REASONING_FIELDS.filter((f) => last.get(f) !== undefined && pyEq(last.get(f)!, fm));
    if (!fields.some((f) => template.includes(f))) throw err("ValueError", `continue_final_message is set to "${field}" but this is not an accepted field in the chat_template`);
    if (Array.isArray(fm) || fm instanceof PyTuple) {
      const blocks = Array.isArray(fm) ? fm : fm.items;
      let found = false;
      for (const block of [...blocks].reverse()) {
        if (block instanceof PyDict && block.has("text")) {
          finalMessage = block.get("text")!;
          block.set("text", (block.get("text") as string) + CONTINUE_TAG);
          found = true;
          break;
        }
      }
      if (!found) throw err("ValueError", "continue_final_message is set but we could not find any text to continue in the final message!");
    } else {
      for (const f of fields) last.set(f, (last.get(f) as string) + CONTINUE_TAG);
    }
  }

  const vars = new Map<string, PyVal>();
  // template_kwargs = {**special_tokens_map, **kwargs}
  const kw = new Map<string, PyVal>();
  for (const [k, v] of req.specialTokens ?? []) kw.set(k, v);
  for (const [k, v] of req.kwargs ?? []) kw.set(k, plain(v));
  for (const name of ["messages", "tools", "documents", "add_generation_prompt"]) {
    if (kw.has(name)) throw err("TypeError", `jinja2.environment.Template.render() got multiple values for keyword argument '${name}'`);
  }
  vars.set("messages", chat);
  vars.set("tools", tools);
  vars.set("documents", documents);
  vars.set("add_generation_prompt", agp);
  for (const [k, v] of kw) vars.set(k, v);

  const r = tpl.render(vars, req.now ?? new Date());
  let out = r.output;
  if (cfm) {
    const fmText = typeof finalMessage === "string" ? finalMessage : String(finalMessage);
    const stripped = pyStrip(fmText);
    if (!out.includes(stripped) || !out.includes(pyStrip(CONTINUE_TAG))) {
      throw err(
        "ValueError",
        "continue_final_message is set but the final message does not appear in the chat after applying the chat template! This can happen if the chat template deletes portions of the final message. Please verify the chat template and final message in your chat to ensure they are compatible." +
          `Final message to continue: ${stripped}\nRendered chat:\n${out}`,
      );
    }
    const tagLoc = out.lastIndexOf(pyStrip(CONTINUE_TAG));
    if (out.slice(tagLoc, tagLoc + CONTINUE_TAG.length) === CONTINUE_TAG) out = out.slice(0, tagLoc);
    else out = out.slice(0, tagLoc).replace(/[\s\u0085]+$/u, "");
  }
  return { output: out, generation: r.generation.filter(([a]) => a <= cpLen(out)) };
}

const pyStrip = (s: string) => s.replace(/^[\s\u0085\u001c-\u001f]+|[\s\u0085\u001c-\u001f]+$/gu, "");

// ---------------------------------------------------------------- tokenizer_config.json などの読み込み

export type LoadedConfig = {
  /** 名前つきのテンプレート(1 つだけなら "default")。 */
  templates: Map<string, string>;
  specialTokens: Map<string, string>;
  /** どこから読んだか。 */
  source: "tokenizer_config.json" | "chat_template.json" | "jinja" | "gguf";
};

/** AddedToken の形({"content": "<s>", ...})なら content を使う。 */
function tokenString(v: PyVal): string | null {
  if (typeof v === "string") return v;
  if (v instanceof PyDict) {
    const c = v.get("content");
    if (typeof c === "string") return c;
  }
  return null;
}

/**
 * 貼られた文字列を読む。tokenizer_config.json・chat_template.json・Jinja のテンプレートそのものを受け付ける。
 * JSON として読めて chat_template を持つときは設定ファイルとして扱う。
 */
export function loadConfig(text: string): LoadedConfig | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  let v: PyVal;
  try {
    v = jsonLoads(t);
  } catch {
    return null;
  }
  if (!(v instanceof PyDict)) return null;
  const ct = v.get("chat_template");
  const templates = new Map<string, string>();
  if (typeof ct === "string") templates.set("default", ct);
  else if (Array.isArray(ct)) {
    for (const item of ct) {
      if (item instanceof PyDict && typeof item.get("name") === "string" && typeof item.get("template") === "string") templates.set(item.get("name") as string, item.get("template") as string);
    }
  } else if (ct instanceof PyDict) {
    for (const [k, x] of ct.entries()) if (typeof k === "string" && typeof x === "string") templates.set(k, x);
  }
  const specialTokens = new Map<string, string>();
  for (const name of SPECIAL_TOKEN_NAMES) {
    const s = tokenString(v.get(name) ?? null);
    if (s !== null) specialTokens.set(name, s);
  }
  if (!templates.size && !specialTokens.size) return null;
  return { templates, specialTokens, source: v.has("added_tokens_decoder") || v.has("tokenizer_class") || specialTokens.size ? "tokenizer_config.json" : "chat_template.json" };
}

/**
 * get_chat_template: テンプレートが複数あるときの選び方。
 * 名前の指定 > tools があって "tool_use" がある > "default"。
 */
export function selectTemplate(templates: Map<string, string>, hasTools: boolean, name: string | null): { name: string; template: string } {
  if (templates.size === 1 && templates.has("default")) return { name: "default", template: templates.get("default")! };
  if (name !== null && templates.has(name)) return { name, template: templates.get(name)! };
  if (hasTools && templates.has("tool_use")) return { name: "tool_use", template: templates.get("tool_use")! };
  if (templates.has("default")) return { name: "default", template: templates.get("default")! };
  throw err(
    "ValueError",
    `This model has multiple chat templates with no default specified! Please either pass a chat template or the name of the template you wish to use to the \`chat_template\` argument. Available template names are ${repr([...templates.keys()].sort())}.`,
  );
}

/** テンプレートが読む変数(jinja2.meta.find_undeclared_variables)。 */
export function templateVariables(template: string): string[] {
  return new Template(template).undeclared;
}

export { templateLiterals };
