/**
 * Content-Security-Policy の読み解き。
 *
 * CSPは書けたつもりでも効いていないことが多い。よくあるのは3つ。
 *
 *  1. script-src に 'unsafe-inline' が入っていて、XSS対策としては働いていない
 *  2. default-src を書いたので全部守られたつもりでいるが、**frame-ancestors・
 *     base-uri・form-action は default-src を引き継がない**。書かなければ
 *     「制限なし」のままになる
 *  3. object-src を書いておらず、古いプラグイン経由の実行を止められていない
 *
 * どれも書式としては正しいので、構文チェックでは見つからない。
 * 意味の側から指摘する。
 */

export type Directive = { name: string; values: string[] };

export type DirectiveMeta = {
  /** default-src を引き継ぐか。引き継がないものは、書き忘れると無制限になる。 */
  fallsBack: boolean;
  /** 置き換え先。非推奨のものだけ入る。 */
  deprecatedBy?: string;
};

export const DIRECTIVES: Record<string, DirectiveMeta> = {
  "default-src": { fallsBack: false },
  "script-src": { fallsBack: true },
  "script-src-elem": { fallsBack: true },
  "script-src-attr": { fallsBack: true },
  "style-src": { fallsBack: true },
  "style-src-elem": { fallsBack: true },
  "style-src-attr": { fallsBack: true },
  "img-src": { fallsBack: true },
  "font-src": { fallsBack: true },
  "connect-src": { fallsBack: true },
  "media-src": { fallsBack: true },
  "object-src": { fallsBack: true },
  "frame-src": { fallsBack: true },
  "worker-src": { fallsBack: true },
  "manifest-src": { fallsBack: true },
  "child-src": { fallsBack: true, deprecatedBy: "frame-src / worker-src" },
  // ここから下は default-src を引き継がない。書かなければ制限が無い。
  "frame-ancestors": { fallsBack: false },
  "form-action": { fallsBack: false },
  "base-uri": { fallsBack: false },
  sandbox: { fallsBack: false },
  "upgrade-insecure-requests": { fallsBack: false },
  "block-all-mixed-content": { fallsBack: false, deprecatedBy: "upgrade-insecure-requests" },
  "report-to": { fallsBack: false },
  "report-uri": { fallsBack: false, deprecatedBy: "report-to" },
  "require-trusted-types-for": { fallsBack: false },
  "trusted-types": { fallsBack: false },
};

/** ヘッダーの値を指令ごとに分ける。改行や余分な空白は無視する。 */
export function parseCsp(input: string): Directive[] {
  // "Content-Security-Policy:" が付いたまま貼られることが多いので落とす。
  const body = input.replace(/^\s*content-security-policy(-report-only)?\s*:/i, "");
  return body
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const [name, ...values] = part.split(/\s+/);
      return { name: name.toLowerCase(), values };
    });
}

export type IssueLevel = "danger" | "warning" | "info";

export type IssueCode =
  | "unsafe-inline-script"
  | "unsafe-eval"
  | "wildcard-script"
  | "data-in-script"
  | "http-source"
  | "no-default-src"
  | "no-object-src"
  | "no-base-uri"
  | "no-frame-ancestors"
  | "strict-dynamic-without-nonce"
  | "unsafe-inline-ignored"
  | "no-fallback"
  | "deprecated"
  | "unknown-directive";

export type Issue = { code: IssueCode; level: IssueLevel; directive?: string; detail?: string };

const hasNonceOrHash = (values: string[]) =>
  values.some((v) => /^'(nonce-|sha(256|384|512)-)/i.test(v));

/** 書式ではなく意味の側から問題を挙げる。 */
export function analyzeCsp(directives: Directive[]): Issue[] {
  const issues: Issue[] = [];
  const byName = new Map(directives.map((d) => [d.name, d.values]));
  const scriptValues = byName.get("script-src") ?? byName.get("script-src-elem") ?? byName.get("default-src") ?? [];

  for (const { name, values } of directives) {
    const meta = DIRECTIVES[name];
    if (!meta) {
      issues.push({ code: "unknown-directive", level: "warning", directive: name });
      continue;
    }
    if (meta.deprecatedBy) {
      issues.push({ code: "deprecated", level: "warning", directive: name, detail: meta.deprecatedBy });
    }

    const isScript = name.startsWith("script-src") || name === "default-src";
    for (const value of values) {
      const v = value.toLowerCase();
      if (v === "'unsafe-inline'" && isScript) {
        // nonce や hash があると、今のブラウザは 'unsafe-inline' を無視する。
        issues.push(
          hasNonceOrHash(values)
            ? { code: "unsafe-inline-ignored", level: "info", directive: name }
            : { code: "unsafe-inline-script", level: "danger", directive: name },
        );
      }
      if (v === "'unsafe-eval'") issues.push({ code: "unsafe-eval", level: "warning", directive: name });
      if (v === "*" && isScript) issues.push({ code: "wildcard-script", level: "danger", directive: name });
      if (v === "data:" && isScript) issues.push({ code: "data-in-script", level: "danger", directive: name });
      if (/^http:\/\//i.test(v)) issues.push({ code: "http-source", level: "warning", directive: name, detail: value });
    }

    if (values.some((v) => v.toLowerCase() === "'strict-dynamic'") && !hasNonceOrHash(values)) {
      issues.push({ code: "strict-dynamic-without-nonce", level: "danger", directive: name });
    }
  }

  if (!byName.has("default-src")) issues.push({ code: "no-default-src", level: "warning" });
  if (!byName.has("object-src") && !byName.has("default-src")) {
    issues.push({ code: "no-object-src", level: "warning" });
  }
  // ここが肝。default-src があっても、これらは引き継がれない。
  if (!byName.has("base-uri")) issues.push({ code: "no-base-uri", level: "warning" });
  if (!byName.has("frame-ancestors")) issues.push({ code: "no-frame-ancestors", level: "warning" });

  void scriptValues;
  return issues;
}

/** 書いていないが、書いておくと守りが増える指令。 */
export function missingRecommended(directives: Directive[]): string[] {
  const names = new Set(directives.map((d) => d.name));
  return ["default-src", "object-src", "base-uri", "frame-ancestors", "form-action"].filter((n) => !names.has(n));
}

/** よく使う出発点。ここから足し引きするのが早い。 */
export const STARTER_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");
