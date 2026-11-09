/**
 * Modelfile Generator の検算。
 *
 * 期待値は、2026-10-30 に手元の Ollama 0.40.11 で `ollama create` → `ollama show --modelfile` を通して
 * 確かめた結果に合わせている(自作の実装を自作の検証で確かめるだけにしないため)。
 *  - SYSTEM の `"""` 囲みは、中の `"`・行末の `"`・字下げをそのまま残す
 *  - stop の `"` 囲みは、前後の空白と中の `"` を残す
 *  - MESSAGE は、前後に空白がある値・`"` で始まる値・複数行の値を `"""` で囲めば崩れない
 *  - num_ctx 1.5 は「invalid int value」、temperature abc は「invalid float value」で失敗する
 *  - top_p 1e-1・.5、seed -1 は通る
 *  - 文章の中の `"""` が行末に来ると値がそこで切れ、次の行が命令として読まれて失敗する
 */
import { buildModelfile, createCommands, type ModelfileInput } from "../src/modelfile";

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

const base: ModelfileInput = { from: "qwen2.5:7b", system: "", params: {}, stops: "", messages: [], template: "", requires: "", capabilities: [], license: "" };
const build = (o: Partial<ModelfileInput>) => buildModelfile({ ...base, ...o });
const codes = (o: Partial<ModelfileInput>) => build(o).problems.map((p) => `${p.code}:${p.field}`);

// 最小
eq("minimal", build({}).text, "FROM qwen2.5:7b\n");
eq("minimal no problems", codes({}), []);
eq("from trimmed", build({ from: "  llama3.2  " }).text, "FROM llama3.2\n");
eq("from missing", codes({ from: " " }), ["fromMissing:from"]);
eq("from multiline", codes({ from: "a\nb" }), ["fromMultiline:from"]);
eq("gguf path kept", build({ from: "./model-*.gguf" }).text, "FROM ./model-*.gguf\n");

// PARAMETER はドキュメントの表の順で並ぶ
eq(
  "params order",
  build({ params: { temperature: "0.3", num_ctx: "8192", seed: "-1", top_p: ".5" } }).text,
  "FROM qwen2.5:7b\n\nPARAMETER num_ctx 8192\nPARAMETER temperature 0.3\nPARAMETER seed -1\nPARAMETER top_p .5\n",
);
eq("empty param skipped", build({ params: { temperature: "  " } }).text, "FROM qwen2.5:7b\n");
eq("int rejects decimal", codes({ params: { num_ctx: "1.5" } }), ["notInteger:num_ctx"]);
eq("int rejects text", codes({ params: { top_k: "forty" } }), ["notInteger:top_k"]);
eq("int accepts negative", codes({ params: { num_predict: "-1", repeat_last_n: "-1" } }), []);
eq("float rejects text", codes({ params: { temperature: "abc" } }), ["notNumber:temperature"]);
eq("float accepts exponent", codes({ params: { top_p: "1e-1", min_p: "0.05", repeat_penalty: "1" } }), []);
eq("float rejects comma", codes({ params: { temperature: "0,7" } }), ["notNumber:temperature"]);

// stop
eq(
  "stops",
  build({ stops: '<|im_end|>\n  spaced stop  \n\nsay "hi"' }).text,
  'FROM qwen2.5:7b\n\nPARAMETER stop "<|im_end|>"\nPARAMETER stop "  spaced stop  "\nPARAMETER stop "say "hi""\n',
);
eq("stops crlf", build({ stops: "a\r\nb" }).text, 'FROM qwen2.5:7b\n\nPARAMETER stop "a"\nPARAMETER stop "b"\n');

// SYSTEM
eq(
  "system block",
  build({ system: 'You are "helpful".\nLine two ends with a quote"\n  indented line' }).text,
  'FROM qwen2.5:7b\n\nSYSTEM """You are "helpful".\nLine two ends with a quote"\n  indented line"""\n',
);
eq("system blank skipped", build({ system: " \n " }).text, "FROM qwen2.5:7b\n");
eq("system triple quote", codes({ system: 'say """\nhi' }), ["tripleQuote:system"]);

// MESSAGE
eq(
  "messages",
  build({
    messages: [
      { role: "user", text: "Is Toronto in Canada?" },
      { role: "assistant", text: "yes" },
      { role: "user", text: " leading space" },
      { role: "assistant", text: '"quoted" start' },
      { role: "user", text: "two\nlines" },
      { role: "assistant", text: "   " },
    ],
  }).text,
  'FROM qwen2.5:7b\n\nMESSAGE user Is Toronto in Canada?\nMESSAGE assistant yes\nMESSAGE user """ leading space"""\nMESSAGE assistant """"quoted" start"""\nMESSAGE user """two\nlines"""\n',
);
eq("message triple quote", codes({ messages: [{ role: "user", text: 'a"""b' }] }), ["tripleQuote:message"]);

// TEMPLATE / REQUIRES / LICENSE
eq(
  "template",
  build({ template: "{{ .System }}\n{{ .Prompt }}" }).text,
  'FROM qwen2.5:7b\n\nTEMPLATE """{{ .System }}\n{{ .Prompt }}"""\n',
);
eq("requires", build({ requires: "0.14.0" }).text, "FROM qwen2.5:7b\n\nREQUIRES 0.14.0\n");
// REQUIRES は ollama create と同じ確かめ方(2026-11-09、Ollama 0.40.11 で確認):
// 0.14.0・v0.14・0.14.0-rc.1・99.0.0 は通り、0.14.x・01.2.3 は「requires must be a valid semver (e.g. 0.14.0)」で止まる
eq("requires accepted forms", ["0.14.0", "v0.14", "0.14", "0.14.0-rc.1", "99.0.0", "1"].map((r) => codes({ requires: r })), [[], [], [], [], [], []]);
eq("requires rejected forms", ["0.14.x", "01.2.3", "latest", "0.14.0.1", "0.14 .0"].map((r) => codes({ requires: r })), [0, 0, 0, 0, 0].map(() => ["requiresFormat:requires"]));
eq("requires rejected is error", build({ requires: "0.14.x" }).problems[0]?.severity, "error");

// CAPABILITY は1行に1つ、ollama create が受け付ける並び(cmd.go)で出す。知らない値は出さない
eq("capability lines", build({ capabilities: ["vision", "decision"] }).text, "FROM qwen2.5:7b\n\nCAPABILITY vision\nCAPABILITY decision\n");
eq("capability unknown dropped", build({ capabilities: ["teleport"] }).text, "FROM qwen2.5:7b\n");
eq("requires then capability", build({ requires: "0.14.0", capabilities: ["tools"] }).text, "FROM qwen2.5:7b\n\nREQUIRES 0.14.0\n\nCAPABILITY tools\n");
eq("license", build({ license: "MIT License\n\nCopyright (c) test" }).text, 'FROM qwen2.5:7b\n\nLICENSE """MIT License\n\nCopyright (c) test"""\n');

// 全部入りの並び
eq(
  "full order",
  build({ params: { temperature: "1" }, stops: "x", system: "s", messages: [{ role: "user", text: "u" }], template: "t", requires: "0.14.0", license: "l" }).text,
  'FROM qwen2.5:7b\n\nPARAMETER temperature 1\nPARAMETER stop "x"\n\nSYSTEM """s"""\n\nMESSAGE user u\n\nTEMPLATE """t"""\n\nREQUIRES 0.14.0\n\nLICENSE """l"""\n',
);

// コマンド
eq("commands", createCommands("short-answers"), ["ollama create short-answers -f ./Modelfile", "ollama run short-answers"]);
eq("commands default", createCommands(" "), ["ollama create my-model -f ./Modelfile", "ollama run my-model"]);

console.log(`check-modelfile: ${pass} checks passed`);
if (fail) {
  console.error(`${fail} failed`);
  process.exit(1);
}
