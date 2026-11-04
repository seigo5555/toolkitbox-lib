/**
 * Ollama API Request Builder の検算。
 *
 * 期待値は、2026-11-03 に手元の Ollama 0.40.11(qwen2.5:7b)へ、生成した curl をそのまま sh で流した結果に合わせている
 * (自作の実装を自作の検証で確かめるだけにしないため)。
 *  - 下の SCHEMA の curl は、format の JSON Schema どおりの答え(name・capital・languages)を返した。system の中の ' もそのまま届いた
 *  - tools を付けた要求は、message.tool_calls に get_weather({"city":"Toronto"}) を返した
 *  - format "json"、stream を省いた要求(1語ずつ届く)、options.stop、keep_alive の数と文字も、すべてエラー無し
 *  - think false は通り、think true は「"qwen2.5:7b" does not support thinking」で断られた(考えないモデル)
 *  - /api/show の curl は capabilities を返した
 */
import { buildRequest, curlCommand, showCommand, singleQuote, type ApiInput } from "../src/ollama-api-request";

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

const base: ApiInput = {
  base: "",
  model: "qwen2.5:7b",
  system: "",
  user: "Hi",
  stream: true,
  think: "",
  thinkLevel: "",
  format: "none",
  schema: "",
  tools: "",
  options: {},
  stop: "",
  keepAlive: "",
  authUser: "",
};
const build = (o: Partial<ApiInput>) => buildRequest({ ...base, ...o });
const codes = (o: Partial<ApiInput>) => build(o).problems.map((p) => `${p.code}:${p.field}`);

// 最小: model と messages だけ(stream は既定の true なので書かない)
eq("minimal", build({}).body, { model: "qwen2.5:7b", messages: [{ role: "user", content: "Hi" }] });
eq("minimal curl", curlCommand({ ...base }, '{"a":1}'), `curl http://localhost:11434/api/chat -d '{"a":1}'`);

// Ollama に流して通った SCHEMA の要求
const SCHEMA: Partial<ApiInput> = {
  system: "Reply with data only. It's a test.",
  user: "Tell me about Canada.",
  stream: false,
  format: "schema",
  schema:
    '{"type":"object","properties":{"name":{"type":"string"},"capital":{"type":"string"},"languages":{"type":"array","items":{"type":"string"}}},"required":["name","capital","languages"]}',
  options: { temperature: "0", seed: "42", num_ctx: "4096", num_predict: "200" },
  keepAlive: "0",
};
const s = build(SCHEMA);
eq("schema body keys", Object.keys(s.body), ["model", "messages", "format", "options", "stream", "keep_alive"]);
eq("schema options are numbers", s.body.options, { temperature: 0, seed: 42, num_ctx: 4096, num_predict: 200 });
eq("schema keep_alive number", s.body.keep_alive, 0);
eq("schema no problems", s.problems, []);
eq("quote escaped", curlCommand({ ...base, ...SCHEMA }, s.json).includes(`It'\\''s a test.`), true);

// tools
const TOOLS =
  '[{"type":"function","function":{"name":"get_weather","description":"Get the current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]';
eq("tools ok", codes({ tools: TOOLS }), []);
eq("tools kept", (build({ tools: TOOLS }).body.tools as unknown[]).length, 1);
eq("tools bad json", codes({ tools: "[{" }), ["toolsJson:tools"]);
eq("tools not array", codes({ tools: '{"type":"function"}' }), ["toolsNotArray:tools"]);
eq("tools missing parameters", codes({ tools: '[{"type":"function","function":{"name":"x"}}]' }), ["toolShape:tools"]);
eq("tools wrong type", codes({ tools: '[{"type":"tool","function":{"name":"x","parameters":{}}}]' }), ["toolShape:tools"]);

// format
eq("format json", build({ format: "json" }).body.format, "json");
eq("schema bad json", codes({ format: "schema", schema: "{" }), ["schemaJson:schema"]);
eq("schema array", codes({ format: "schema", schema: "[]" }), ["schemaNotObject:schema"]);
eq("schema text ignored when none", build({ format: "none", schema: "{" }).body.format, undefined);

// options
eq("stop lines", build({ stop: "\n\nEND\n" }).body.options, { stop: ["END"] });
eq("stop keeps spaces", build({ stop: " a " }).body.options, { stop: [" a "] });
eq("float bad", codes({ options: { temperature: "warm" } }), ["notNumber:temperature"]);
eq("int bad", codes({ options: { seed: "1.5" } }), ["notInteger:seed"]);
eq("num_ctx zero", codes({ options: { num_ctx: "0" } }), ["notPositive:num_ctx"]);
eq("num_predict negative ok", codes({ options: { num_predict: "-1" } }), []);

// stream
eq("stream false written", build({ stream: false }).body.stream, false);
eq("stream true omitted", "stream" in build({ stream: true }).body, false);

// think
eq("think true", build({ think: "true" }).body.think, true);
eq("think false", build({ think: "false" }).body.think, false);
eq("think level", build({ think: "level", thinkLevel: "low" }).body.think, "low");
eq("think level missing", codes({ think: "level", thinkLevel: " " }), ["levelMissing:thinkLevel"]);
eq("think level number", codes({ think: "level", thinkLevel: "2" }), ["levelNumber:thinkLevel"]);
eq("think unset", "think" in build({}).body, false);

// keep_alive(FAQ: "10m"・"24h"・3600・-1・"-1m"・0)
eq("keep -1", build({ keepAlive: "-1" }).body.keep_alive, -1);
eq("keep 10m", build({ keepAlive: "10m" }).body.keep_alive, "10m");
eq("keep -1m", codes({ keepAlive: "-1m" }), []);
eq("keep bad", codes({ keepAlive: "forever" }), ["keepAliveFormat:keepAlive"]);

// 必須と宛先
eq("model missing", codes({ model: " " }), ["modelMissing:model"]);
eq("user missing", codes({ user: " " }), ["userMissing:user"]);
eq("system added first", build({ system: "Be brief." }).body.messages, [
  { role: "system", content: "Be brief." },
  { role: "user", content: "Hi" },
]);
eq("base ok", codes({ base: "https://ollama.example.com" }), []);
eq("base bad", codes({ base: "ollama.example.com" }), ["baseFormat:base"]);
eq("base trailing slash", curlCommand({ ...base, base: "https://ollama.example.com/" }, "{}"), `curl https://ollama.example.com/api/chat -d '{}'`);

// ベーシック認証(nginx の前段)
eq("auth user", curlCommand({ ...base, authUser: "alice", base: "https://ollama.example.com" }, "{}"), `curl -u alice https://ollama.example.com/api/chat -d '{}'`);
eq("auth user bad", codes({ authUser: "a b" }), ["authUserChars:authUser"]);
eq("auth user bad not used", curlCommand({ ...base, authUser: "a;b" }, "{}"), `curl http://localhost:11434/api/chat -d '{}'`);

// /api/show
eq("show", showCommand({ ...base }), `curl http://localhost:11434/api/show -d '{"model":"qwen2.5:7b"}'`);
eq("single quote", singleQuote("a'b"), `'a'\\''b'`);

console.log(`check-ollama-api-request: ${pass} checks passed`);
if (fail) {
  console.error(`${fail} failed`);
  process.exit(1);
}
