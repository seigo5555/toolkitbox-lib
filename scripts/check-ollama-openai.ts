/**
 * Ollama OpenAI Converter の検算。
 *
 * 期待値は ollama/ollama v0.40.14 の openai/openai.go(FromChatRequest・ToChatCompletion)を手でたどったもの。
 * 2026-11-06 に手元の Ollama 0.40.11(qwen2.5:7b)で次を確かめた:
 *  - OpenAI の要求を /v1/chat/completions に、書き換えた要求を /api/chat に、どちらも _debug_render_only を付けて送り、
 *    組み上がるプロンプト(_debug_info.rendered_template)が同じ: 普通の会話・content の配列・ツールの往復(tool_call_id から名前を引く)
 *  - 逆向き(Ollama の要求 → OpenAI の要求)も同じ: 普通の会話(num_ctx は書き出せない)・ツールの往復(tool_name → name)
 *  - 違ったのは「content が空の配列 + tool_calls」だけ。0.40.11 ではツール呼び出しが1つ前のメッセージに付いてしまい、
 *    v0.40.14 で直った(openai.go の差分)。ここでは v0.40.14 の形を期待値にしている
 *  - 応答: 同じ要求を両方に送り、/api/chat の応答を書き換えたものと /v1 の実際の応答が、id・created・cached_tokens
 *    (呼ぶたびに変わる)以外で一致した。下の FX_* がそのときの実際の応答
 */
import {
  convert,
  detectKind,
  effortToThink,
  goJson,
  isStdBase64,
  ollamaResponseToOpenai,
  ollamaToOpenai,
  openaiToOllama,
  unixSeconds,
} from "../src/ollama-openai";

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

const M = "qwen2.5:7b";
const codes = (r: { problems: { code: string }[] }) => r.problems.map((p) => p.code);
const o2o = (req: Record<string, unknown>) => openaiToOllama(req);
const r2o = (req: Record<string, unknown>) => ollamaToOpenai(req);
const tools = [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];

// 見分け
eq("見分け: OpenAI の応答", detectKind({ choices: [] }), "openaiResponse");
eq("見分け: Ollama の応答", detectKind({ model: M, message: { role: "assistant", content: "x" }, done: true }), "ollamaResponse");
eq("見分け: max_tokens", detectKind({ model: M, messages: [], max_tokens: 5 }), "openaiRequest");
eq("見分け: options", detectKind({ model: M, messages: [], options: {} }), "ollamaRequest");
eq("見分け: content の配列", detectKind({ messages: [{ role: "user", content: [] }] }), "openaiRequest");
eq("見分け: images", detectKind({ messages: [{ role: "user", content: "x", images: [] }] }), "ollamaRequest");
eq("見分け: 引数が文字", detectKind({ messages: [{ role: "assistant", tool_calls: [{ function: { name: "f", arguments: "{}" } }] }] }), "openaiRequest");
eq("見分け: 引数がオブジェクト", detectKind({ messages: [{ role: "assistant", tool_calls: [{ function: { name: "f", arguments: {} } }] }] }), "ollamaRequest");
eq("見分け: どちらとも言えない", detectKind({ model: M, messages: [{ role: "user", content: "hi" }] }), null);
eq("auto で決められない", codes(convert(JSON.stringify({ model: M, messages: [{ role: "user", content: "hi" }] }), "auto")), ["kindUnknown"]);
eq("auto: OpenAI の応答は断る", codes(convert('{"choices":[]}', "auto")), ["openaiResponse"]);
eq("入力が空", codes(convert(" ", "auto")), ["inputEmpty"]);
eq("JSON でない", codes(convert("{", "auto")), ["inputJson"]);
eq("配列", codes(convert("[]", "auto")), ["inputNotObject"]);

// OpenAI → Ollama
eq("普通の会話", o2o({ model: M, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }] }).output, {
  model: M,
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hi" },
  ],
  stream: false,
});
const opts = o2o({ model: M, messages: [{ role: "user", content: "x" }], stop: "END", max_tokens: 64, temperature: 0, seed: 7, top_p: 0.9, frequency_penalty: 0.1, presence_penalty: 0.2, stream: true });
eq("options の組み立て", opts.output, {
  model: M,
  messages: [{ role: "user", content: "x" }],
  stream: true,
  options: { stop: ["END"], num_predict: 64, temperature: 0, seed: 7, frequency_penalty: 0.1, presence_penalty: 0.2, top_p: 0.9 },
});
eq("options の対応", opts.rows.map((r) => [r.from, r.to]).slice(0, 3), [
  ["stop", "options.stop"],
  ["max_tokens", "options.num_predict"],
  ["temperature", "options.temperature"],
]);
eq("stop の配列(文字以外は捨てる)", (o2o({ model: M, messages: [{ role: "user", content: "x" }], stop: ["a", 1, "b"] }).output as { options: unknown }).options, { stop: ["a", "b"] });
eq("stop の配列(文字以外)の注意", codes(o2o({ model: M, messages: [{ role: "user", content: "x" }], stop: ["a", 1] })), ["stopNonString"]);
eq("json_object", (o2o({ model: M, messages: [{ role: "user", content: "x" }], response_format: { type: " JSON_OBJECT " } }).output as { format: unknown }).format, "json");
const schema = { type: "object", properties: { a: { type: "string" } } };
eq("json_schema", (o2o({ model: M, messages: [{ role: "user", content: "x" }], response_format: { type: "json_schema", json_schema: { name: "x", schema } } }).output as { format: unknown }).format, schema);
eq("json_schema の schema が無い", codes(o2o({ model: M, messages: [{ role: "user", content: "x" }], response_format: { type: "json_schema", json_schema: { name: "x" } } })), ["schemaMissing"]);
eq("text は何もしない", "format" in (o2o({ model: M, messages: [{ role: "user", content: "x" }], response_format: { type: "text" } }).output ?? {}), false);
eq("effort: none", effortToThink("none"), { think: false, known: true });
eq("effort: minimal → low", effortToThink("minimal"), { think: "low", known: true });
eq("effort: xhigh → max", effortToThink("xhigh"), { think: "max", known: true });
eq("effort: ultra → max", effortToThink("ultra"), { think: "max", known: true });
eq("effort: high", effortToThink("high"), { think: "high", known: true });
eq("effort: モデルが決める名前", effortToThink("deep"), { think: "deep", known: false });
eq("effort: 空", effortToThink(""), null);
eq("reasoning が先", (o2o({ model: M, messages: [{ role: "user", content: "x" }], reasoning: { effort: "low" }, reasoning_effort: "high" }).output as { think: unknown }).think, "low");
eq("reasoning に effort が無いと reasoning_effort は見ない", "think" in (o2o({ model: M, messages: [{ role: "user", content: "x" }], reasoning: {}, reasoning_effort: "high" }).output ?? {}), false);
eq("知らない effort の注意", codes(o2o({ model: M, messages: [{ role: "user", content: "x" }], reasoning_effort: "deep" })), ["thinkUnknown"]);
eq(
  "読まれない項目",
  o2o({ model: M, messages: [{ role: "user", content: "x" }], tool_choice: "auto", n: 2, max_completion_tokens: 10 }).problems,
  [
    { code: "maxCompletionTokens", severity: "warn" },
    { code: "ignoredFields", severity: "warn", detail: "tool_choice, n, max_completion_tokens" },
  ],
);
eq("stream_options", codes(o2o({ model: M, messages: [{ role: "user", content: "x" }], stream_options: { include_usage: true } })), ["noEquivalent"]);
eq("keep_alive・logprobs はそのまま", o2o({ model: M, messages: [{ role: "user", content: "x" }], keep_alive: "10m", logprobs: true, top_logprobs: 3 }).output, {
  model: M,
  messages: [{ role: "user", content: "x" }],
  stream: false,
  keep_alive: "10m",
  logprobs: true,
  top_logprobs: 3,
});
eq("型の違い: temperature が文字", codes(o2o({ model: M, messages: [{ role: "user", content: "x" }], temperature: "0" })), ["fieldType"]);
eq("型の違い: max_tokens が小数", codes(o2o({ model: M, messages: [{ role: "user", content: "x" }], max_tokens: 1.5 })), ["fieldType"]);
eq("型の違い: stream が文字", codes(o2o({ model: M, messages: [{ role: "user", content: "x" }], stream: "true" })), ["fieldType"]);
eq("messages が空", codes(o2o({ model: M, messages: [] })), ["messagesMissing"]);
eq("model が無い", codes(o2o({ messages: [{ role: "user", content: "x" }] })), ["modelMissing"]);

// ツールの往復(実機で同じプロンプトになった形)
const round = o2o({
  model: M,
  tools,
  messages: [
    { role: "user", content: "Weather in Toronto?" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Toronto"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "11 degrees, cloudy" },
  ],
});
eq("ツールの往復", round.output, {
  model: M,
  messages: [
    { role: "user", content: "Weather in Toronto?" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: { city: "Toronto" } } }] },
    { role: "tool", content: "11 degrees, cloudy", tool_name: "get_weather", tool_call_id: "call_1" },
  ],
  stream: false,
  tools,
});
eq(
  "name があれば tool_call_id から引かない",
  ((o2o({ model: M, messages: [{ role: "tool", name: "own", tool_call_id: "x", content: "r" }] }).output as { messages: { tool_name: string }[] }).messages[0]).tool_name,
  "own",
);
eq(
  "同じ id は後ろのもの",
  (
    o2o({
      model: M,
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "d", function: { name: "first", arguments: "{}" } }] },
        { role: "assistant", content: "", tool_calls: [{ id: "d", function: { name: "second", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "d", content: "r" },
      ],
    }).output as { messages: { tool_name?: string }[] }
  ).messages[2].tool_name,
  "second",
);
eq("引数が文字でない", codes(o2o({ model: M, messages: [{ role: "assistant", content: "", tool_calls: [{ function: { name: "f", arguments: {} } }] }] })), ["toolArgsNotString"]);
eq("引数が JSON でない", codes(o2o({ model: M, messages: [{ role: "assistant", content: "", tool_calls: [{ function: { name: "f", arguments: "{x" } }] }] })), ["toolArgsJson"]);
eq("引数がオブジェクトでない", codes(o2o({ model: M, messages: [{ role: "assistant", content: "", tool_calls: [{ function: { name: "f", arguments: "[1]" } }] }] })), ["toolArgsObject"]);
eq("content も tool_calls も無い", codes(o2o({ model: M, messages: [{ role: "assistant", content: null }] })), ["contentType"]);
eq("content が数", codes(o2o({ model: M, messages: [{ role: "user", content: 3 }] })), ["contentType"]);

// content の配列
eq("文字の部品は別々のメッセージ", o2o({ model: M, messages: [{ role: "user", content: [{ type: "text", text: "Part one." }, { type: "text", text: "Part two." }] }] }).output, {
  model: M,
  messages: [
    { role: "user", content: "Part one." },
    { role: "user", content: "Part two." },
  ],
  stream: false,
});
eq("分かれる注意", codes(o2o({ model: M, messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] })), ["imagesSplit"]);
const img = o2o({ model: M, messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }] });
eq("画像", (img.output as { messages: unknown }).messages, [
  { role: "user", content: "What is this?" },
  { role: "user", content: "", images: ["iVBORw0KGgo="] },
]);
eq("画像(image_url が文字)", (o2o({ model: M, messages: [{ role: "user", content: [{ type: "image_url", image_url: "data:;base64,AAAA" }] }] }).output as { messages: unknown }).messages, [
  { role: "user", content: "", images: ["AAAA"] },
]);
eq("画像の URL は断られる", codes(o2o({ model: M, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }] })), ["imageRemote"]);
eq("gif は断られる", codes(o2o({ model: M, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/gif;base64,AAAA" } }] }] })), ["imageInvalid"]);
eq("base64 が壊れている", codes(o2o({ model: M, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] }] })), ["imageInvalid"]);
eq("音声", (o2o({ model: M, messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } }] }] }).output as { messages: unknown }).messages, [
  { role: "user", content: "", images: ["UklGRg=="] },
]);
eq("知らない部品", codes(o2o({ model: M, messages: [{ role: "user", content: [{ type: "file", file: {} }] }] })), ["partType"]);
eq("空の配列", codes(o2o({ model: M, messages: [{ role: "user", content: [] }] })), ["emptyParts"]);
eq(
  "空の配列 + tool_calls は空の文字(v0.40.14)",
  (o2o({ model: M, messages: [{ role: "user", content: "Weather?" }, { role: "assistant", content: [], tool_calls: [{ id: "c2", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }] }] }).output as { messages: unknown[] }).messages[1],
  { role: "assistant", content: "", tool_calls: [{ id: "c2", function: { name: "get_weather", arguments: { city: "Oslo" } } }] },
);
eq(
  "tool の文字の部品は1つにまとめる",
  (o2o({ model: M, messages: [{ role: "tool", tool_call_id: "c2", name: "get_weather", content: [{ type: "text", text: "3 degrees" }, { type: "text", text: ", snow" }] }] }).output as { messages: unknown }).messages,
  [{ role: "tool", content: "3 degrees, snow", tool_name: "get_weather", tool_call_id: "c2" }],
);
eq(
  "tool の部品に画像があれば分けたまま、どれにも名前",
  (o2o({ model: M, messages: [{ role: "tool", name: "shot", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:;base64,AAAA" } }] }] }).output as { messages: unknown }).messages,
  [
    { role: "tool", content: "see", tool_name: "shot" },
    { role: "tool", content: "", images: ["AAAA"], tool_name: "shot" },
  ],
);

// Ollama → OpenAI
const back = r2o({ model: M, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }], options: { num_ctx: 4096, temperature: 0, num_predict: 100, top_k: 20, stop: ["END"] }, truncate: false });
eq("逆: options", back.output, { model: M, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }], stream: true, temperature: 0, max_tokens: 100, stop: ["END"] });
eq("逆: 書き出せないもの", back.problems, [{ code: "noEquivalent", severity: "warn", detail: "truncate, options.num_ctx, options.top_k" }]);
eq("逆: stream false", (r2o({ model: M, messages: [{ role: "user", content: "x" }], stream: false }).output as { stream: unknown }).stream, false);
eq("逆: format json", (r2o({ model: M, messages: [{ role: "user", content: "x" }], format: "json" }).output as { response_format: unknown }).response_format, { type: "json_object" });
eq("逆: format スキーマ", (r2o({ model: M, messages: [{ role: "user", content: "x" }], format: schema }).output as { response_format: unknown }).response_format, { type: "json_schema", json_schema: { schema } });
eq("逆: format が変", codes(r2o({ model: M, messages: [{ role: "user", content: "x" }], format: "yaml" })), ["formatInvalid"]);
eq("逆: think false", (r2o({ model: M, messages: [{ role: "user", content: "x" }], think: false }).output as { reasoning_effort: unknown }).reasoning_effort, "none");
eq("逆: think high", (r2o({ model: M, messages: [{ role: "user", content: "x" }], think: "high" }).output as { reasoning_effort: unknown }).reasoning_effort, "high");
eq("逆: think true は書けない", codes(r2o({ model: M, messages: [{ role: "user", content: "x" }], think: true })), ["thinkTrue"]);
eq(
  "逆: ツールの往復",
  r2o({
    model: M,
    tools,
    messages: [
      { role: "user", content: "Weather in Toronto?" },
      { role: "assistant", content: "", thinking: "need tool", tool_calls: [{ function: { name: "get_weather", arguments: { city: "Toronto" } } }] },
      { role: "tool", tool_name: "get_weather", content: "11 degrees, cloudy" },
    ],
  }).output,
  {
    model: M,
    messages: [
      { role: "user", content: "Weather in Toronto?" },
      { role: "assistant", content: "", reasoning: "need tool", tool_calls: [{ type: "function", function: { name: "get_weather", arguments: '{"city":"Toronto"}' } }] },
      { role: "tool", content: "11 degrees, cloudy", name: "get_weather" },
    ],
    stream: true,
    tools,
  },
);
const backImg = r2o({ model: M, messages: [{ role: "user", content: "What is this?", images: ["iVBORw0KGgo="] }] });
eq("逆: 画像", (backImg.output as { messages: unknown }).messages, [
  { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:;base64,iVBORw0KGgo=" } }] },
]);
eq("逆: 画像の注意", codes(backImg), ["imagesSplit"]);
eq("逆: 知らない項目", codes(r2o({ model: M, messages: [{ role: "user", content: "x" }], max_tokens: 5 })), ["ignoredFields"]);
eq("逆: 引数がオブジェクトでない", codes(r2o({ model: M, messages: [{ role: "assistant", content: "", tool_calls: [{ function: { name: "f", arguments: "{}" } }] }] })), ["toolArgsObject"]);

// 応答(2026-11-06 の実際の応答)
const FX_TOOL_OLLAMA = {
  model: M,
  created_at: "2026-11-05T22:35:57.046153Z",
  message: { role: "assistant", content: "", tool_calls: [{ id: "call_iy44zhnw", function: { index: 0, name: "get_weather", arguments: { city: "Toronto" } } }] },
  done: true,
  done_reason: "stop",
  total_duration: 1642018041,
  load_duration: 2336083,
  prompt_eval_count: 153,
  prompt_eval_cached_count: 152,
  prompt_eval_duration: 100207000,
  eval_count: 20,
  eval_duration: 1536211000,
};
const FX_TOOL_V1 = {
  id: "chatcmpl-54",
  object: "chat.completion",
  created: 1793918158,
  model: M,
  system_fingerprint: "fp_ollama",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "", tool_calls: [{ id: "call_cc33o5cf", index: 0, type: "function", function: { name: "get_weather", arguments: '{"city":"Toronto"}' } }] },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 153, prompt_tokens_details: { cached_tokens: 152 }, completion_tokens: 20, total_tokens: 173 },
};
const FX_LEN_OLLAMA = {
  model: M,
  created_at: "2026-11-05T22:35:59.161586Z",
  message: { role: "assistant", content: "Sure! A" },
  done: true,
  done_reason: "length",
  total_duration: 377683167,
  load_duration: 3257042,
  prompt_eval_count: 33,
  prompt_eval_cached_count: 24,
  prompt_eval_duration: 197152000,
  eval_count: 3,
  eval_duration: 170354000,
};
const FX_LEN_V1 = {
  id: "chatcmpl-406",
  object: "chat.completion",
  created: 1793918159,
  model: M,
  system_fingerprint: "fp_ollama",
  choices: [{ index: 0, message: { role: "assistant", content: "Sure! A" }, finish_reason: "length" }],
  usage: { prompt_tokens: 33, prompt_tokens_details: { cached_tokens: 32 }, completion_tokens: 3, total_tokens: 36 },
};
/** 呼ぶたびに変わるもの(id・created・ツール呼び出しの id・cached_tokens)を除く。 */
function stable(o: unknown) {
  const x = JSON.parse(JSON.stringify(o));
  delete x.id;
  delete x.created;
  delete x.usage.prompt_tokens_details;
  for (const ch of x.choices) for (const tc of ch.message.tool_calls ?? []) delete tc.id;
  return x;
}
const t = ollamaResponseToOpenai(FX_TOOL_OLLAMA);
eq("応答: ツール呼び出し(実際の /v1 と同じ)", stable(t.output), stable(FX_TOOL_V1));
eq("応答: created", (t.output as { created: number }).created, 1793918157);
eq("応答: id は chatcmpl-0", (t.output as { id: string }).id, "chatcmpl-0");
eq("応答: cached_tokens", (t.output as { usage: unknown }).usage, { prompt_tokens: 153, prompt_tokens_details: { cached_tokens: 152 }, completion_tokens: 20, total_tokens: 173 });
const l = ollamaResponseToOpenai(FX_LEN_OLLAMA);
eq("応答: length(実際の /v1 と同じ)", stable(l.output), stable(FX_LEN_V1));
eq("応答: 落ちる項目", l.rows.filter((r) => r.to === null).map((r) => r.from), ["total_duration", "load_duration", "prompt_eval_duration", "eval_duration"]);
eq("応答: done_reason が無い", (ollamaResponseToOpenai({ model: M, created_at: "2026-11-05T22:35:59Z", message: { role: "assistant", content: "" }, done: true }).output as { choices: { finish_reason: unknown }[] }).choices[0].finish_reason, null);
eq("応答: thinking", (ollamaResponseToOpenai({ model: M, created_at: "2026-11-05T22:35:59Z", message: { role: "assistant", content: "a", thinking: "t" }, done: true, done_reason: "stop" }).output as { choices: { message: unknown }[] }).choices[0].message, {
  role: "assistant",
  content: "a",
  reasoning: "t",
});
eq("応答: stream の途中", codes(ollamaResponseToOpenai({ model: M, message: { role: "assistant", content: "a" }, done: false })), ["streamResponse"]);
// ストリームを丸ごと貼ったとき(Ollama Stream Reader へ案内する)
{
  const nd = [
    JSON.stringify({ model: M, message: { role: "assistant", content: "a" }, done: false }),
    JSON.stringify({ model: M, message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }),
  ].join("\n");
  eq("ストリーム: NDJSON", codes(convert(nd, "auto")), ["streamResponse"]);
  eq("ストリーム: SSE", codes(convert('data: {"id":"x","object":"chat.completion.chunk","choices":[]}\n\ndata: [DONE]', "auto")), ["streamResponse"]);
  eq("ストリーム: 整形した1つの JSON は対象外", convert(JSON.stringify({ model: M, messages: [{ role: "user", content: "hi" }], max_tokens: 5 }, null, 2), "auto").kind, "openaiRequest");
}
eq("応答: created_at が無い", codes(ollamaResponseToOpenai({ model: M, message: { role: "assistant", content: "a" }, done: true })), ["createdAtMissing"]);
eq("応答: 引数が無い", (ollamaResponseToOpenai({ model: M, created_at: "2026-11-05T22:35:59Z", message: { role: "assistant", content: "", tool_calls: [{ function: { name: "f" } }] }, done: true, done_reason: "stop" }).output as { choices: { message: { tool_calls: { function: { arguments: string } }[] } }[] }).choices[0].message.tool_calls[0].function.arguments, "{}");
eq("auto: 応答", convert(JSON.stringify(FX_LEN_OLLAMA), "auto").kind, "ollamaResponse");
eq("auto: 応答に curl は無い", convert(JSON.stringify(FX_LEN_OLLAMA), "auto").curl, "");

// 細かいもの
eq("Go と同じ書き方", goJson({ a: "<b>& " }), '{"a":"\\u003cb\\u003e\\u0026\\u2028"}');
eq("Unix 秒(小数9桁)", unixSeconds("2026-11-05T22:35:57.046153123Z"), 1793918157);
eq("Unix 秒(時差)", unixSeconds("2026-11-06T07:35:57+09:00"), 1793918157);
eq("Unix 秒(変な形)", unixSeconds("yesterday"), null);
eq("base64", [isStdBase64("AAAA"), isStdBase64("AAA"), isStdBase64("AA=="), isStdBase64("A-_A")], [true, false, true, false]);
eq(
  "curl(Ollama 行き)",
  convert(JSON.stringify({ model: M, messages: [{ role: "user", content: "it's" }], max_tokens: 5 }), "auto").curl,
  `curl http://localhost:11434/api/chat -d '{"model":"qwen2.5:7b","messages":[{"role":"user","content":"it'\\''s"}],"stream":false,"options":{"num_predict":5}}'`,
);
eq(
  "curl(OpenAI 互換行き)",
  convert(JSON.stringify({ model: M, messages: [{ role: "user", content: "x" }], options: { temperature: 0 } }), "auto").curl,
  `curl http://localhost:11434/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"qwen2.5:7b","messages":[{"role":"user","content":"x"}],"stream":true,"temperature":0}'`,
);

console.log(`check-ollama-openai: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
