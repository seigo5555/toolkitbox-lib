/**
 * MCP の設定ファイル(`.mcp.json` / `claude_desktop_config.json`)の誤りを調べる。LLM は呼ばない。
 * ブラウザの中だけで完結する。
 *
 * **ここに書く規則は、公式ドキュメントに書かれていることだけ。** 確認元と日付は `SOURCES` と
 * `VERIFIED_ON`。規則を足し引きするときは、公式の文面を確かめて `VERIFIED_ON` を更新する。
 *  - Claude Code(code.claude.com/docs/en/mcp): mcpServers、type の値、url だけで type が無い項目、
 *    ${VAR} の展開、予約された名前、名前に使える文字、${CLAUDE_PROJECT_DIR} の既定値
 *  - MCP 公式(modelcontextprotocol.io の connect-local-servers): Claude Desktop の設定、絶対パス
 *  - VS Code(code.visualstudio.com): トップのキーが servers で、mcpServers とは別の形式
 *
 * 公式に書かれていないことは断定しない。サーバーが実際に起動できるか(コマンドの有無、
 * ネットワーク)は調べられないので、画面に「調べていない」と出す。
 */
import { redact, type DetectorId } from "./prompt-redact";

export const VERIFIED_ON = "2026-10-23";

export const SOURCES = {
  claudeCode: "https://code.claude.com/docs/en/mcp",
  mcp: "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
  vscode: "https://code.visualstudio.com/docs/copilot/customization/mcp-servers",
} as const;

export type Severity = "error" | "warn" | "info";

export type FindingCode =
  | "notObject"
  | "noMcpServers"
  | "serversKey"
  | "mcpServersNotObject"
  | "noServers"
  | "duplicateName"
  | "entryNotObject"
  | "urlNoType"
  | "sdkType"
  | "unknownType"
  | "sseDeprecated"
  | "noCommand"
  | "noUrl"
  | "notString"
  | "argsNotArray"
  | "envNotObject"
  | "headersNotObject"
  | "badName"
  | "reservedName"
  | "relativePath"
  | "unsetVar"
  | "credentialVar"
  | "projectDirNoDefault"
  | "secretInline";

export const FINDING_CODES: FindingCode[] = [
  "notObject",
  "noMcpServers",
  "serversKey",
  "mcpServersNotObject",
  "noServers",
  "duplicateName",
  "entryNotObject",
  "urlNoType",
  "sdkType",
  "unknownType",
  "sseDeprecated",
  "noCommand",
  "noUrl",
  "notString",
  "argsNotArray",
  "envNotObject",
  "headersNotObject",
  "badName",
  "reservedName",
  "relativePath",
  "unsetVar",
  "credentialVar",
  "projectDirNoDefault",
  "secretInline",
];

export const SEVERITY: Record<FindingCode, Severity> = {
  notObject: "error",
  noMcpServers: "error",
  serversKey: "error",
  mcpServersNotObject: "error",
  noServers: "warn",
  duplicateName: "warn",
  entryNotObject: "error",
  urlNoType: "error",
  sdkType: "error",
  unknownType: "warn",
  sseDeprecated: "info",
  noCommand: "error",
  noUrl: "warn",
  notString: "error",
  argsNotArray: "error",
  envNotObject: "error",
  headersNotObject: "error",
  badName: "warn",
  reservedName: "error",
  relativePath: "warn",
  unsetVar: "info",
  credentialVar: "error",
  projectDirNoDefault: "warn",
  secretInline: "warn",
};

export type Finding = {
  severity: Severity;
  code: FindingCode;
  /** サーバー名。ファイル全体への指摘は空文字。 */
  server: string;
  params: Record<string, string>;
};

export type ServerKind = "stdio" | "http" | "sse" | "ws" | "skipped";

export type ServerInfo = { name: string; kind: ServerKind };

export type CheckResult = { ok: true; servers: ServerInfo[]; findings: Finding[] } | { ok: false; reason: "notJson" };

/** Claude Code が type に受け付けると書いている値。 */
export const TYPE_VALUES = ["stdio", "http", "streamable-http", "sse", "ws"] as const;

/** 予約されている名前(「including」と書かれているので、これで全部とは限らない)。 */
export const RESERVED_NAMES = ["workspace", "claude-in-chrome", "computer-use", "Claude Preview", "Claude Browser"] as const;

/** url と headers の中で、設定されていても空として読まれると書かれている変数(例として挙げられたもの)。 */
export const EMPTY_IN_REMOTE = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "HTTPS_PROXY", "NPM_TOKEN"] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** `${NAME}` と `${NAME:-default}` を取り出す。default が付いているか分かるようにする。 */
export function variablesIn(s: string): { name: string; hasDefault: boolean }[] {
  const out: { name: string; hasDefault: boolean }[] = [];
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push({ name: m[1], hasDefault: m[2] !== undefined });
  return out;
}

/** 同じオブジェクトの中で、同じキーが2回出るものを探す(JSON.parse は後のほうだけを残す)。 */
export function duplicateKeys(text: string): { path: string[]; key: string }[] {
  const dups: { path: string[]; key: string }[] = [];
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\r\n".includes(text[i])) i++;
  };
  const str = (): string => {
    let out = "";
    i++; // 開きの "
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") {
        const n = text[i + 1];
        if (n === "u") {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[n] ?? n;
        i += 2;
        continue;
      }
      out += text[i++];
    }
    i++; // 閉じの "
    return out;
  };
  const value = (path: string[]) => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const seen = new Set<string>();
      ws();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        ws();
        const k = str();
        if (seen.has(k)) dups.push({ path, key: k });
        seen.add(k);
        ws();
        i++; // :
        value([...path, k]);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        i++; // }
        return;
      }
    } else if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        value(path);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        i++; // ]
        return;
      }
    } else if (c === '"') {
      str();
    } else {
      while (i < text.length && !",]} \t\r\n".includes(text[i])) i++;
    }
  };
  try {
    value([]);
  } catch {
    return [];
  }
  return dups;
}

const SECRET_DETECTORS: ReadonlySet<DetectorId> = new Set<DetectorId>([
  "privateKey",
  "awsKey",
  "githubToken",
  "slackToken",
  "stripeKey",
  "anthropicKey",
  "jwt",
  "apiKeyShape",
  "authHeader",
  "urlCredentials",
  "secretAssignment",
]);

/** 値に秘密らしい文字列が直に書かれているか。${VAR} で参照しているものは対象外。 */
function looksSecret(text: string): boolean {
  if (text.includes("${")) return false;
  return redact(text, SECRET_DETECTORS).findings.length > 0;
}

/** 秘密を渡す引数の名前。単語の区切りで見る(--keyboard や --key-file は対象外)。 */
const SECRET_FLAG = /^--?(?:[A-Za-z0-9]+[-_])*(?:key|token|secret|password|passwd|apikey)$/i;

function push(out: Finding[], code: FindingCode, server: string, params: Record<string, string> = {}) {
  out.push({ severity: SEVERITY[code], code, server, params });
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function checkStringMap(out: Finding[], server: string, field: "env" | "headers", v: unknown): Record<string, string> {
  const code: FindingCode = field === "env" ? "envNotObject" : "headersNotObject";
  if (!isObj(v)) {
    push(out, code, server);
    return {};
  }
  const res: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") push(out, "notString", server, { field: `${field}.${k}` });
    else res[k] = val;
  }
  return res;
}

export function checkMcpConfig(text: string): CheckResult {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { ok: false, reason: "notJson" };
  }
  const out: Finding[] = [];
  const servers: ServerInfo[] = [];
  if (!isObj(root)) {
    push(out, "notObject", "");
    return { ok: true, servers, findings: out };
  }

  if (!has(root, "mcpServers")) {
    if (has(root, "servers")) push(out, "serversKey", "");
    else push(out, "noMcpServers", "");
    return { ok: true, servers, findings: out };
  }
  const list = root.mcpServers;
  if (!isObj(list)) {
    push(out, "mcpServersNotObject", "");
    return { ok: true, servers, findings: out };
  }
  const names = Object.keys(list);
  if (names.length === 0) push(out, "noServers", "");

  for (const d of duplicateKeys(text)) {
    if (d.path.length === 1 && d.path[0] === "mcpServers") push(out, "duplicateName", d.key, { name: d.key });
  }

  for (const name of names) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) push(out, "badName", name, { name });
    if ((RESERVED_NAMES as readonly string[]).includes(name)) push(out, "reservedName", name, { name });

    const entry = list[name];
    if (!isObj(entry)) {
      push(out, "entryNotObject", name);
      continue;
    }

    // --- 種類(type)を決める ---
    const t = entry.type;
    let kind: ServerKind;
    if (t === undefined) {
      if (typeof entry.url === "string" && !has(entry, "command")) {
        push(out, "urlNoType", name);
        servers.push({ name, kind: "skipped" });
        continue;
      }
      kind = "stdio";
    } else if (t === "stdio") kind = "stdio";
    else if (t === "http" || t === "streamable-http") kind = "http";
    else if (t === "sse") {
      kind = "sse";
      push(out, "sseDeprecated", name);
    } else if (t === "ws") kind = "ws";
    else if (t === "sdk") {
      push(out, "sdkType", name);
      servers.push({ name, kind: "skipped" });
      continue;
    } else {
      push(out, "unknownType", name, { value: typeof t === "string" ? t : JSON.stringify(t) });
      kind = typeof entry.url === "string" ? "http" : "stdio";
    }
    servers.push({ name, kind });

    const vars = new Map<string, boolean>(); // name -> 既定値あり
    const noteVars = (s: string, field: string) => {
      for (const v of variablesIn(s)) {
        vars.set(v.name, (vars.get(v.name) ?? false) || v.hasDefault);
        if (v.name === "CLAUDE_PROJECT_DIR" && !v.hasDefault) push(out, "projectDirNoDefault", name);
        const remote = field === "url" || field.startsWith("headers.");
        if (remote && (EMPTY_IN_REMOTE as readonly string[]).includes(v.name)) push(out, "credentialVar", name, { name: v.name, field });
      }
    };

    if (kind === "stdio") {
      // --- command / args / env ---
      if (typeof entry.command !== "string" || entry.command.trim() === "") {
        if (has(entry, "command") && typeof entry.command !== "string") push(out, "notString", name, { field: "command" });
        else push(out, "noCommand", name);
      } else {
        noteVars(entry.command, "command");
        if (/^\.\.?[\\/]/.test(entry.command)) push(out, "relativePath", name, { value: entry.command });
      }
      if (has(entry, "args")) {
        if (!isStringArray(entry.args)) push(out, "argsNotArray", name);
        else {
          entry.args.forEach((a, idx) => {
            noteVars(a, "args");
            if (/^\.\.?[\\/]/.test(a)) push(out, "relativePath", name, { value: a });
            const flag = idx > 0 ? (entry.args as string[])[idx - 1] : "";
            if (SECRET_FLAG.test(flag) && !a.includes("${") && !a.startsWith("-")) push(out, "secretInline", name, { field: `args[${idx}]` });
            else if (looksSecret(a)) push(out, "secretInline", name, { field: `args[${idx}]` });
          });
        }
      }
      if (has(entry, "env")) {
        const env = checkStringMap(out, name, "env", entry.env);
        for (const [k, v] of Object.entries(env)) {
          noteVars(v, `env.${k}`);
          if (looksSecret(`${k}=${v}`)) push(out, "secretInline", name, { field: `env.${k}` });
        }
      }
    } else {
      // --- url / headers(http, sse, ws) ---
      if (typeof entry.url !== "string") {
        if (has(entry, "url")) push(out, "notString", name, { field: "url" });
        else push(out, "noUrl", name);
      } else if (entry.url.trim() === "") push(out, "noUrl", name);
      else noteVars(entry.url, "url");
      if (has(entry, "headers")) {
        const headers = checkStringMap(out, name, "headers", entry.headers);
        for (const [k, v] of Object.entries(headers)) {
          noteVars(v, `headers.${k}`);
          if (looksSecret(`${k}: ${v}`)) push(out, "secretInline", name, { field: `headers.${k}` });
        }
      }
    }

    const unset = [...vars.entries()].filter(([n, def]) => !def && n !== "CLAUDE_PROJECT_DIR").map(([n]) => n);
    if (unset.length > 0) push(out, "unsetVar", name, { names: unset.join(", ") });
  }

  const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  out.sort((a, b) => order[a.severity] - order[b.severity]);
  return { ok: true, servers, findings: out };
}

export const EXAMPLE_CONFIG = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./docs"]
    },
    "weather": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer \${API_KEY}" }
    },
    "search": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "headers": { "x-api-key": "sk_test_${"4eC39HqLyjWDarjtT1zdp7dc"}" }
    },
    "search": {
      "command": "node",
      "args": ["server.js", "--api-key", "abc123"],
      "env": { "DB_URL": "\${DB_URL}" }
    }
  }
}`;
