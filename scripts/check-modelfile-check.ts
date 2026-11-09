/**
 * Ollama Modelfile Checker(src/lib/modelfile-check.ts)の検算。
 *
 * 1) 本物の Ollama 0.40.11: scripts/fixtures/modelfile-check/ollama-0.40.11.json の 43 個の Modelfile を
 *    ollama create に渡した結果(エラーの文言・警告・作られたモデルの params・system・template・messages・license の層)。
 *    期待値はこのツールの出力ではない。
 * 2) Go の決まり(strconv の ParseInt・ParseFloat(32)・ParseBool、x/mod/semver、encoding/json の float32)を手で当てはめたもの。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { checkModelfile, commandString, float32Json, paramsJson, parseGoBool, parseGoFloat32, parseGoInt, parseModelfile, quote, semverValid } from "../src/modelfile-check";

let pass = 0;
let fail = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++;
    console.error(`NG ${name}\n  actual:   ${a?.slice(0, 500)}\n  expected: ${e?.slice(0, 500)}`);
  }
}

type Real = { code: number; error: string | null; warnings: string[]; layers?: Record<string, string[]> };
const doc = JSON.parse(readFileSync(join("scripts", "fixtures", "modelfile-check", "ollama-0.40.11.json"), "utf8")) as { qwenSystem: string; cases: Record<string, { modelfile: string; real: Real }> };
const esc = (s: string) => s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

// ---- 1) 本物の ollama create ----
{
  let n = 0;
  let ok = 0;
  for (const [name, c] of Object.entries(doc.cases)) {
    const r = checkModelfile(c.modelfile);
    // サーバーで断られたものは "400 Bad Request: " が付く
    eq(`${name} error`, r.error?.message ?? null, c.real.error?.replace(/^400 Bad Request: /, "") ?? null);
    if (!c.real.error) {
      ok++;
      const L = c.real.layers ?? {};
      eq(`${name} params`, r.params.length ? paramsJson(r.params) : null, L.params?.[0]?.trimEnd() ?? null);
      eq(`${name} system`, r.system ?? doc.qwenSystem, L.system?.[0] ?? null);
      eq(`${name} template`, r.template ?? "<inherited qwen2.5:7b template>", L.template?.[0] ?? null);
      eq(`${name} messages`, r.messages.length ? esc(JSON.stringify(r.messages)) : null, L.messages?.[0]?.trimEnd() ?? null);
      eq(`${name} licenses`, ["<inherited qwen2.5:7b license>", ...r.licenses], L.license ?? []);
      eq(
        `${name} warnings`,
        r.notes.filter((x) => x.code === "deprecatedParam").map((x) => `warning: parameter ${x.detail} is deprecated`),
        c.real.warnings,
      );
    }
    n++;
  }
  eq("real cases", [n, ok], [43, 18]);
}

// ---- 2) 読み方の細部 ----
{
  // 値は改行で終わる。引用符で始まったら閉じるまで改行をまたぐ
  eq("multiline", parseModelfile('FROM x\nSYSTEM """\na\n"""\n')[1], { name: "system", args: "\na\n", line: 2 });
  eq("trailing spaces trimmed", parseModelfile("FROM  x  \n")[0].args, "x");
  eq("CRLF counts twice", (() => {
    try {
      parseModelfile("FROM x\r\nBAD y\r\n");
    } catch (e) {
      return (e as Error).message.slice(0, 9);
    }
  })(), "(line 3):");
  eq("message", parseModelfile("FROM x\nMESSAGE user hi there\n")[1], { name: "message", args: "user: hi there", line: 2 });
  eq("parameter name kept", parseModelfile("FROM x\nPARAMETER Num_Ctx 5\n")[1].name, "Num_Ctx");
  eq("zero width dropped", parseModelfile("FROM x\nSYSTEM a\u200bb\n")[1].args, "ab");
  eq("quote", [quote("a"), quote(" a"), quote('a\n"b"'), quote("a\nb")], ["a", '" a"', '"""a\n"b""""', '"a\nb"']);
  eq("commandString", commandString({ name: "message", args: "user: hi", line: 1 }), "MESSAGE user hi");
  eq("commandString param", commandString({ name: "stop", args: "<|end|>", line: 1 }), "PARAMETER stop <|end|>");
}

// ---- 3) Go の数と版 ----
eq("ParseInt", ["5", "+5", "-5", "5.0", "0x10", "1_000", " 5", "9223372036854775807", "9223372036854775808"].map((s) => parseGoInt(s)?.toString() ?? null), ["5", "5", "-5", null, null, null, null, "9223372036854775807", null]);
eq("ParseFloat32", ["0.7", ".5", "1e3", "0x1p-2", "abc", "1e39", "inf", "1_0"].map((s) => { const v = parseGoFloat32(s); return v === null ? null : String(v); }), [String(Math.fround(0.7)), "0.5", "1000", "0.25", null, null, "Infinity", null]);
eq("ParseBool", ["1", "t", "True", "yes", "TRUE", "tRue"].map(parseGoBool), [true, true, true, null, true, null]);
eq("float32Json", [0.7, 0.1, 1.1, 0.05, 1e-7, 3, 0.30000001].map((x) => float32Json(Math.fround(x))), ["0.7", "0.1", "1.1", "0.05", "1e-7", "3", "0.3"]);
eq("semver", ["v0.14.0", "v1", "v1.2", "v1.2.3-rc.1+b5", "v01.2", "v1.2.3-01", "latest", "v1.2.3.4", "v1.2-rc"].map(semverValid), [true, true, true, true, false, false, false, false, false]);

console.log(`check-modelfile-check: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
