/**
 * Modelfile の決まりのうち、Modelfile Generator と Modelfile Checker の両方が使う小さいもの。
 * (modelfile-check.ts は Go のテンプレートの移植を読み込むので、Generator からはこちらだけを読む。)
 */

/** CAPABILITY に書ける値(Ollama v0.40.15 の cmd.go。手元の Ollama 0.40.11 の ollama create でも確かめた)。 */
export const CAPABILITIES = ["completion", "tools", "insert", "vision", "embedding", "thinking", "image", "audio", "decision", "speech"];

/** golang.org/x/mod/semver の IsValid。 */
export function semverValid(v: string): boolean {
  if (!v.startsWith("v")) return false;
  const num = (s: string): [string, string] | null => {
    const m = /^(0|[1-9][0-9]*)/.exec(s);
    if (!m) return null;
    if (/^0[0-9]/.test(s)) return null;
    return [m[1], s.slice(m[1].length)];
  };
  let r = num(v.slice(1));
  if (!r) return false;
  let rest = r[1];
  if (rest === "") return true;
  if (rest[0] !== ".") return false;
  r = num(rest.slice(1));
  if (!r) return false;
  rest = r[1];
  if (rest === "") return true;
  if (rest[0] !== ".") return false;
  r = num(rest.slice(1));
  if (!r) return false;
  rest = r[1];
  const ident = /^[0-9A-Za-z-]+$/;
  const badNum = (x: string) => /^[0-9]+$/.test(x) && x.length > 1 && x[0] === "0";
  if (rest.startsWith("-")) {
    const end = rest.indexOf("+") >= 0 ? rest.indexOf("+") : rest.length;
    const parts = rest.slice(1, end).split(".");
    if (parts.some((p) => p === "" || !ident.test(p) || badNum(p))) return false;
    rest = rest.slice(end);
  }
  if (rest.startsWith("+")) {
    const parts = rest.slice(1).split(".");
    if (parts.some((p) => p === "" || !ident.test(p))) return false;
    rest = "";
  }
  return rest === "";
}
