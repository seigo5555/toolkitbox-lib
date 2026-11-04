/**
 * MCP Config Checker の検算。
 *
 * 規則は src/lib/mcp-config.ts の冒頭にある公式ドキュメントから取ったもの。確かめるのは次の点。
 *  - 公式のドキュメントにある設定例(Claude Desktop の filesystem、Claude Code の http・${VAR})が、指摘ゼロ
 *  - 各規則が、書かれたとおりの条件で1件だけ出る。出すべきでないときに出ない(誤検出が無い)
 *  - 同じ名前が2回あるとき、JSON.parse は後のほうだけを残すので、テキストを読んで見つけられる
 *  - ${VAR} の既定値の有無、秘密の直書きの検出(${VAR} で参照しているものは出さない)
 *  - どんな入力でも落ちない(擬似乱数で3000通り)
 *
 * 実行: npm run check
 */
import { checkMcpConfig, duplicateKeys, EXAMPLE_CONFIG, variablesIn, type Finding } from "../src/mcp-config";

let pass = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};
const eq = (label: string, got: unknown, want: unknown) => ok(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);

function run(cfg: unknown): { servers: { name: string; kind: string }[]; findings: Finding[] } {
  const r = checkMcpConfig(typeof cfg === "string" ? cfg : JSON.stringify(cfg));
  if (!r.ok) throw new Error("not ok");
  return r;
}
const codes = (cfg: unknown) => run(cfg).findings.map((f) => `${f.code}${f.server ? "@" + f.server : ""}`).sort();
const srv = (entry: unknown, name = "s") => ({ mcpServers: { [name]: entry } });

// 1. 公式の設定例
eq("desktop filesystem example (macOS)", codes({ mcpServers: { filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/username/Desktop", "/Users/username/Downloads"] } } }), []);
eq("desktop filesystem example (Windows)", codes({ mcpServers: { filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\username\\Desktop"] } } }), []);
eq("claude code http example", codes({ mcpServers: { "shared-server": { type: "http", url: "https://example.com/mcp" } } }), []);
eq("claude code ${VAR:-default} url + Bearer ${API_KEY}", codes({ mcpServers: { api: { type: "http", url: "${API_BASE_URL:-https://api.example.com}/mcp", headers: { Authorization: "Bearer ${API_KEY}" } } } }), ["unsetVar@api"]);
eq("claude code stdio with env ${DB_URL}", codes(srv({ type: "stdio", command: "/path/to/weather-cli", args: ["--verbose"], env: { CACHE_DIR: "/tmp", DB_URL: "${DB_URL}" } })), ["unsetVar@s"]);
{
  const r = run({ mcpServers: { a: { command: "x" }, b: { type: "http", url: "https://e.com" }, c: { type: "sse", url: "https://e.com" }, d: { type: "ws", url: "wss://e.com" }, e: { type: "streamable-http", url: "https://e.com" } } });
  eq("kinds", r.servers.map((s) => `${s.name}:${s.kind}`), ["a:stdio", "b:http", "c:sse", "d:ws", "e:http"]);
  eq("only sse info", r.findings.map((f) => `${f.code}@${f.server}`), ["sseDeprecated@c"]);
}

// 2. 全体の形
eq("invalid json", checkMcpConfig("{").ok, false);
eq("array top-level", codes([]), ["notObject"]);
eq("string top-level", codes('"x"'), ["notObject"]);
eq("null top-level", codes("null"), ["notObject"]);
eq("no mcpServers", codes({ foo: 1 }), ["noMcpServers"]);
eq("VS Code servers key", codes({ servers: { a: { command: "x" } } }), ["serversKey"]);
eq("mcpServers wins over servers", codes({ mcpServers: { a: { command: "x" } }, servers: {} }), []);
eq("mcpServers is an array", codes({ mcpServers: [] }), ["mcpServersNotObject"]);
eq("mcpServers is a string", codes({ mcpServers: "x" }), ["mcpServersNotObject"]);
eq("empty mcpServers", codes({ mcpServers: {} }), ["noServers"]);
eq("entry is a string", codes(srv("x")), ["entryNotObject@s"]);
eq("entry is null", codes(srv(null)), ["entryNotObject@s"]);
eq("entry is an array", codes(srv([])), ["entryNotObject@s"]);

// 3. type
eq("url without type", codes(srv({ url: "https://e.com" })), ["urlNoType@s"]);
eq("url without type is skipped", run(srv({ url: "https://e.com" })).servers[0].kind, "skipped");
eq("url and command without type = stdio", codes(srv({ url: "https://e.com", command: "x" })), []);
eq("type sdk", codes(srv({ type: "sdk", name: "x" })), ["sdkType@s"]);
eq("unknown type string", codes(srv({ type: "grpc", url: "https://e.com" })), ["unknownType@s"]);
eq("unknown type value param", run(srv({ type: "grpc", url: "https://e.com" })).findings[0].params.value, "grpc");
eq("type is a number", run(srv({ type: 5, command: "x" })).findings.map((f) => f.code), ["unknownType"]);
eq("type is case-sensitive", codes(srv({ type: "HTTP", url: "https://e.com" })), ["unknownType@s"]);

// 4. stdio
eq("no command", codes(srv({ args: [] })), ["noCommand@s"]);
eq("empty command", codes(srv({ command: "  " })), ["noCommand@s"]);
eq("command is a number", codes(srv({ command: 5 })), ["notString@s"]);
eq("args not an array", codes(srv({ command: "x", args: "a b" })), ["argsNotArray@s"]);
eq("args with a number", codes(srv({ command: "x", args: ["a", 5] })), ["argsNotArray@s"]);
eq("env is an array", codes(srv({ command: "x", env: [] })), ["envNotObject@s"]);
eq("env value is a number", codes(srv({ command: "x", env: { A: 1 } })), ["notString@s"]);
eq("env value param", run(srv({ command: "x", env: { A: 1 } })).findings[0].params.field, "env.A");
eq("relative command", codes(srv({ command: "./server" })), ["relativePath@s"]);
eq("relative arg ./", codes(srv({ command: "node", args: ["./server.js"] })), ["relativePath@s"]);
eq("relative arg ../", codes(srv({ command: "node", args: ["../server.js"] })), ["relativePath@s"]);
eq("relative arg .\\", codes(srv({ command: "node", args: [".\\server.js"] })), ["relativePath@s"]);
eq("npm scope arg is not a path", codes(srv({ command: "npx", args: ["@scope/pkg", "-y", "pkg/sub", "..."] })), []);
eq("absolute arg is fine", codes(srv({ command: "node", args: ["/opt/server.js"] })), []);
eq("hidden dir name is not relative", codes(srv({ command: "node", args: [".env", ".config/x"] })), []);

// 5. http / sse / ws
eq("http without url", codes(srv({ type: "http" })), ["noUrl@s"]);
eq("http empty url", codes(srv({ type: "http", url: "" })), ["noUrl@s"]);
eq("http url is a number", codes(srv({ type: "http", url: 5 })), ["notString@s"]);
eq("headers is a string", codes(srv({ type: "http", url: "https://e.com", headers: "x" })), ["headersNotObject@s"]);
eq("headers value number", codes(srv({ type: "http", url: "https://e.com", headers: { A: 1 } })), ["notString@s"]);
eq("http ignores command checks", codes(srv({ type: "http", url: "https://e.com", args: "x" })), []);
eq("http with extra documented fields", codes(srv({ type: "http", url: "https://e.com", timeout: 600000, alwaysLoad: true, oauth: { clientId: "x" } })), []);

// 6. 名前
eq("bad name (space)", codes(srv({ command: "x" }, "my server")), ["badName@my server"]);
eq("bad name (dot)", codes(srv({ command: "x" }, "my.server")), ["badName@my.server"]);
eq("good name chars", codes(srv({ command: "x" }, "My_server-2")), []);
eq("reserved workspace", codes(srv({ command: "x" }, "workspace")), ["reservedName@workspace"]);
eq("reserved claude-in-chrome", codes(srv({ command: "x" }, "claude-in-chrome")), ["reservedName@claude-in-chrome"]);
eq("reserved computer-use", codes(srv({ command: "x" }, "computer-use")), ["reservedName@computer-use"]);
eq("reserved Claude Browser (also bad name)", codes(srv({ command: "x" }, "Claude Browser")), ["badName@Claude Browser", "reservedName@Claude Browser"]);
eq("reserved is exact match", codes(srv({ command: "x" }, "Workspace")), []);
eq("empty name", run(srv({ command: "x" }, "")).findings.map((f) => `${f.code}:${f.params.name}`), ["badName:"]);

// 7. 変数
eq("variablesIn", variablesIn("a ${A} b ${B:-x} ${C:-} ${1BAD} $D ${E"), [{ name: "A", hasDefault: false }, { name: "B", hasDefault: true }, { name: "C", hasDefault: true }]);
eq("unset var in args", run(srv({ command: "x", args: ["${TOKEN}"] })).findings.map((f) => `${f.code}:${f.params.names}`), ["unsetVar:TOKEN"]);
eq("var with default is not listed", codes(srv({ command: "x", args: ["${TOKEN:-abc}"] })), []);
eq("same var, one use has a default", codes(srv({ command: "x", args: ["${T}", "${T:-a}"] })), []);
eq("two unset vars are listed once", run(srv({ command: "x", env: { A: "${X}", B: "${X} ${Y}" } })).findings.map((f) => f.params.names), ["X, Y"]);
eq("CLAUDE_PROJECT_DIR without default", codes(srv({ command: "x", args: ["${CLAUDE_PROJECT_DIR}/a"] })), ["projectDirNoDefault@s"]);
eq("CLAUDE_PROJECT_DIR with default", codes(srv({ command: "x", args: ["${CLAUDE_PROJECT_DIR:-.}/a"] })), []);
eq("credential var in url", codes(srv({ type: "http", url: "https://e.com/?k=${ANTHROPIC_API_KEY}" })), ["credentialVar@s", "unsetVar@s"]);
eq("credential var in header", codes(srv({ type: "http", url: "https://e.com", headers: { Authorization: "Bearer ${NPM_TOKEN}" } })), ["credentialVar@s", "unsetVar@s"]);
eq("credential var in env is fine", codes(srv({ command: "x", env: { K: "${ANTHROPIC_API_KEY}" } })), ["unsetVar@s"]);
eq("HTTPS_PROXY in url", run(srv({ type: "http", url: "${HTTPS_PROXY}/x" })).findings.some((f) => f.code === "credentialVar"), true);
eq("AWS_BEARER_TOKEN_BEDROCK in header", run(srv({ type: "http", url: "https://e.com", headers: { Authorization: "Bearer ${AWS_BEARER_TOKEN_BEDROCK}" } })).findings.some((f) => f.code === "credentialVar"), true);
eq("ANTHROPIC_BASE_URL is not flagged", codes(srv({ type: "http", url: "${ANTHROPIC_BASE_URL}/mcp" })), ["unsetVar@s"]);
eq("API_KEY is not flagged", codes(srv({ type: "http", url: "https://e.com", headers: { "x-key": "${API_KEY}" } })), ["unsetVar@s"]);
eq("credential var with default still flagged", run(srv({ type: "http", url: "${NPM_TOKEN:-x}" })).findings.some((f) => f.code === "credentialVar"), true);

// 8. 秘密の直書き
eq("--api-key abc123 (docs example)", codes(srv({ command: "x", args: ["--api-key", "abc123"] })), ["secretInline@s"]);
eq("--api-key with ${VAR}", codes(srv({ command: "x", args: ["--api-key", "${K}"] })), ["unsetVar@s"]);
eq("--token followed by a flag", codes(srv({ command: "x", args: ["--token", "--verbose"] })), []);
eq("--keyboard is not a secret flag", codes(srv({ command: "x", args: ["--keyboard", "us"] })), []);
eq("--key-file is not a secret flag", codes(srv({ command: "x", args: ["--key-file", "/etc/k.pem"] })), []);
eq("--api-key-file is not a secret flag", codes(srv({ command: "x", args: ["--api-key-file", "k.txt"] })), []);
eq("--access_token is a secret flag", codes(srv({ command: "x", args: ["--access_token", "abc123"] })), ["secretInline@s"]);
eq("-k is not matched", codes(srv({ command: "x", args: ["-k", "abc123"] })), []);
eq("--apikey is a secret flag", codes(srv({ command: "x", args: ["--apikey", "abc123"] })), ["secretInline@s"]);
eq("github token in env", codes(srv({ command: "x", env: { GITHUB_TOKEN: "ghp_" + "16C7e42F292c6912E7710c838347Ae178B4a" } })), ["secretInline@s"]);
eq("secret field name", run(srv({ command: "x", env: { GITHUB_TOKEN: "ghp_" + "16C7e42F292c6912E7710c838347Ae178B4a" } })).findings[0].params.field, "env.GITHUB_TOKEN");
eq("env password by name", codes(srv({ command: "x", env: { DB_PASSWORD: "hunter2hunter2" } })), ["secretInline@s"]);
eq("env non-secret", codes(srv({ command: "x", env: { LOG_LEVEL: "debug", PORT: "3000", MODE: "production" } })), []);
eq("bearer in header", codes(srv({ type: "http", url: "https://e.com", headers: { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" } })), ["secretInline@s"]);
eq("bearer with ${VAR} in header", codes(srv({ type: "http", url: "https://e.com", headers: { Authorization: "Bearer ${API_KEY}" } })), ["unsetVar@s"]);
eq("stripe doc example key in header", codes(srv({ type: "http", url: "https://e.com", headers: { "x-api-key": "sk_test_" + "4eC39HqLyjWDarjtT1zdp7dc" } })), ["secretInline@s"]);
eq("password in arg url", codes(srv({ command: "x", args: ["postgres://admin:s3cretPass99@db.example.com/app"] })), ["secretInline@s"]);
eq("plain url arg is fine", codes(srv({ command: "x", args: ["https://example.com/mcp"] })), []);

// 9. 同じ名前が2回
eq("duplicateKeys simple", duplicateKeys('{"a":1,"a":2}'), [{ path: [], key: "a" }]);
eq("duplicateKeys nested path", duplicateKeys('{"m":{"x":{},"x":{}}}'), [{ path: ["m"], key: "x" }]);
eq("duplicateKeys none", duplicateKeys('{"a":{"b":1},"c":{"b":2}}'), []);
eq("duplicateKeys in arrays are separate objects", duplicateKeys('{"a":[{"b":1},{"b":2}]}'), []);
eq("duplicateKeys escaped key", duplicateKeys('{"a\\u0062":1,"ab":2}'), [{ path: [], key: "ab" }]);
eq("duplicateKeys string with braces", duplicateKeys('{"a":"{\\"x\\":1,\\"x\\":2}","b":1}'), []);
eq("duplicate server name", codes('{"mcpServers":{"s":{"command":"a"},"s":{"command":"b"}}}'), ["duplicateName@s"]);
eq("same name in different places is fine", codes('{"mcpServers":{"s":{"command":"a","env":{"x":"1"}},"t":{"command":"b","env":{"x":"1"}}}}'), []);
eq("duplicate inside env is not a server name", codes('{"mcpServers":{"s":{"command":"a","env":{"x":"1","x":"2"}}}}'), []);

// 10. 並び順と例
{
  const f = run(srv({ type: "sse", url: "" }, "my server")).findings.map((x) => x.severity);
  const rank = { error: 0, warn: 1, info: 2 } as const;
  eq("sorted by severity", f, [...f].sort((a, b) => rank[a] - rank[b]));
  const ex = run(EXAMPLE_CONFIG);
  ok("example config parses and has findings", ex.findings.length >= 4, String(ex.findings.length));
  eq("example finds the duplicate name", ex.findings.some((x) => x.code === "duplicateName"), true);
  eq("example finds the secret", ex.findings.some((x) => x.code === "secretInline"), true);
  eq("example finds the relative path", ex.findings.some((x) => x.code === "relativePath"), true);
}

// 11. 擬似乱数: どんな入力でも落ちない・同じ入力は同じ結果
{
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const val = (d: number): unknown => {
    if (d > 3 || rnd() < 0.3) return pick<unknown>(["x", "", "${A}", "${B:-c}", "./p", "--api-key", "ghp_" + "16C7e42F292c6912E7710c838347Ae178B4a", 5, true, null, "http", "sse", "sdk"]);
    if (rnd() < 0.3) return Array.from({ length: Math.floor(rnd() * 3) }, () => val(d + 1));
    const o: Record<string, unknown> = {};
    const n = Math.floor(rnd() * 5);
    for (let i = 0; i < n; i++) o[pick(["type", "command", "args", "env", "url", "headers", "mcpServers", "servers", "name", "my server", "workspace"])] = val(d + 1);
    return o;
  };
  let bad = 0;
  for (let i = 0; i < 3000; i++) {
    const text = JSON.stringify(rnd() < 0.5 ? { mcpServers: { a: val(0), b: val(0) } } : val(0));
    try {
      const a = JSON.stringify(checkMcpConfig(text));
      const b = JSON.stringify(checkMcpConfig(text));
      if (a !== b) bad++;
    } catch {
      bad++;
    }
  }
  eq("3000 random configs: no crash, deterministic", bad, 0);
  eq("garbage text", checkMcpConfig("not json at all").ok, false);
  eq("empty text", checkMcpConfig("").ok, false);
}

if (failures.length > 0) {
  console.error(`check-mcp-config: ${failures.length} failure(s), ${pass} passed`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`check-mcp-config: ${pass} checks passed`);
