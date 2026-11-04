/**
 * 埋め込み(embedding)の前に、長い文章を小さなかたまり(チャンク)に区切る。区切った結果を Ollama の /api/embed に
 * まとめて送る JSON と curl にする。
 *
 * 区切り方: 段落(空行)→ 行 → 文の終わり → 空白 → 文字、の順に、上限より長い部分だけを細かく割り、
 * 割った部品を上限まで詰めていく。区切り記号は前の部品の末尾に残すので、重なりなしで区切った結果を
 * つなぐと元の文章に戻る(検算はこれを見る)。長さは文字(コードポイント)で数える。
 * 重なり(overlap)は、前のチャンクの末尾の部品を、合わせて重なりの文字数を超えない分だけ次の頭に付ける。
 *
 * /api/embed の決まり(docs.ollama.com/api/embed): input は文字列か文字列の配列。truncate の既定は true で、
 * 文脈長を超えた入力は切り詰められる。false にすると、切らずにエラーを返す。
 * モデルの文脈長はトークンで決まっていて、文字数からは正確に出せない(トークナイザがモデルごとに違う)。
 */

export const CHUNK_VERIFIED_ON = "2026-11-04";
export const OLLAMA_EMBED_API_URL = "https://docs.ollama.com/api/embed";

export const MAX_INPUT_CHARS = 500_000;

/**
 * 文の終わり。後ろの閉じ括弧・空白は同じ部品に含める。「。！？」はそこで切り、「. ! ?」は後ろに空白が続くときだけ切る
 * (3.14 や example.com で切らないため)。
 */
const SENTENCE_END = /(?<=[。！？])[」』）)]*\s*|(?<=[.!?])["'”’)）]*(?:\s+|$)/u;

type Level = "paragraph" | "line" | "sentence" | "space" | "char";
const LEVELS: Level[] = ["paragraph", "line", "sentence", "space", "char"];

export type ChunkInput = {
  text: string;
  size: number;
  overlap: number;
  model: string;
  base: string;
  truncateFalse: boolean;
};

export type ProblemCode = "empty" | "tooLong" | "sizeRange" | "overlapRange" | "overlapTooBig" | "modelMissing" | "baseFormat";
export type Problem = { code: ProblemCode; severity: "error" | "warn" };

export type Chunk = { text: string; chars: number; start: number };

export type ChunkResult = { chunks: Chunk[]; problems: Problem[]; body: string; curl: string };

export const SIZE_MIN = 50;
export const SIZE_MAX = 20000;

const len = (s: string) => Array.from(s).length;

/** 区切り記号を前の部品に残して割る。 */
function splitKeep(text: string, level: Level): string[] {
  if (level === "char") return Array.from(text);
  const re = level === "paragraph" ? /(?<=\n[ \t]*\n)/ : level === "line" ? /(?<=\n)/ : level === "space" ? /(?<=[ \t]+)(?=[^ \t])/ : null;
  if (re) return text.split(re).filter((s) => s !== "");
  // 文の終わり: 記号と、その後ろの空白・閉じ括弧までを1つの部品に。
  const out: string[] = [];
  let rest = text;
  while (rest) {
    const m = SENTENCE_END.exec(rest);
    if (!m || m.index + m[0].length >= rest.length) {
      out.push(rest);
      break;
    }
    const end = m.index + m[0].length;
    if (end === 0) {
      out.push(rest);
      break;
    }
    out.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  return out;
}

/** 上限より長い部品だけを、次の段の区切りで割る。 */
function pieces(text: string, size: number, depth = 0): string[] {
  if (len(text) <= size) return [text];
  const level = LEVELS[depth];
  const parts = splitKeep(text, level);
  if (parts.length === 1 && level !== "char") return pieces(text, size, depth + 1);
  return parts.flatMap((p) => (len(p) <= size ? [p] : pieces(p, size, depth + 1)));
}

export function chunkText(text: string, size: number, overlap: number): Chunk[] {
  const parts = pieces(text, size);
  const chunks: Chunk[] = [];
  let cur: string[] = [];
  let curLen = 0;
  let curStart = 0;
  let pos = 0; // 元の文章での位置(コードポイント)

  const flush = () => {
    const t = cur.join("");
    if (t.trim()) chunks.push({ text: t, chars: curLen, start: curStart });
  };

  for (const p of parts) {
    const pl = len(p);
    if (cur.length && curLen + pl > size) {
      flush();
      // 重なり: 末尾の部品を、合わせて overlap 以下、かつ次の部品と合わせて size 以下になる分だけ残す。
      const keep: string[] = [];
      let kl = 0;
      for (let i = cur.length - 1; i >= 0; i--) {
        const l = len(cur[i]);
        if (kl + l > overlap || kl + l + pl > size) break;
        keep.unshift(cur[i]);
        kl += l;
      }
      cur = keep;
      curLen = kl;
      curStart = pos - kl;
    }
    if (!cur.length) curStart = pos;
    cur.push(p);
    curLen += pl;
    pos += pl;
  }
  if (cur.length) flush();
  return chunks;
}

/** シェルの '…' の中に入れる(' は '\'' にする)。 */
export function singleQuote(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildChunks(input: ChunkInput): ChunkResult {
  const problems: Problem[] = [];
  const size = input.size;
  const overlap = input.overlap;
  if (!input.text.trim()) problems.push({ code: "empty", severity: "error" });
  if (input.text.length > MAX_INPUT_CHARS) problems.push({ code: "tooLong", severity: "error" });
  if (!Number.isInteger(size) || size < SIZE_MIN || size > SIZE_MAX) problems.push({ code: "sizeRange", severity: "error" });
  if (!Number.isInteger(overlap) || overlap < 0) problems.push({ code: "overlapRange", severity: "error" });
  else if (Number.isInteger(size) && overlap >= size) problems.push({ code: "overlapTooBig", severity: "error" });
  if (!input.model.trim()) problems.push({ code: "modelMissing", severity: "error" });
  const base = (input.base.trim() || "http://localhost:11434").replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s'"]+$/.test(base)) problems.push({ code: "baseFormat", severity: "error" });

  if (problems.some((p) => p.severity === "error")) return { chunks: [], problems, body: "", curl: "" };

  const chunks = chunkText(input.text, size, overlap);
  const bodyObj: Record<string, unknown> = { model: input.model.trim(), input: chunks.map((c) => c.text) };
  if (input.truncateFalse) bodyObj.truncate = false;
  const body = JSON.stringify(bodyObj, null, 2);
  const curl = `curl ${base}/api/embed -d ${singleQuote(body)}`;
  return { chunks, problems, body, curl };
}
