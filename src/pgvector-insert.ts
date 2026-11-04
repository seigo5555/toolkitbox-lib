/**
 * Ollama の /api/embed の応答(か OpenAI 互換 /v1/embeddings の応答)と、埋め込んだ文章を組にして、
 * pgvector の表に入れる INSERT 文にする。
 *
 * 文章の読み方: /api/embed に送った JSON(`{"model": …, "input": [ … ]}`。RAG Text Chunker の出力そのまま)、
 * 文字列の JSON 配列、どちらでもなければ1行に1つ(空行は飛ばす)。
 * ベクトルの読み方は embedding-similarity.ts と同じ(readVectors)。応答は入力と同じ順(ollama/ollama の server/routes.go)。
 *
 * SQL の書き方:
 *  - 文字列は '…' で囲み、中の ' は '' にする(PostgreSQL の文書 4.1.2.1)。standard_conforming_strings の既定は on(9.1 から)なので、\ はそのまま
 *  - 文字コード 0(NUL)は text に入らない(PostgreSQL の文書 8.3)ので、エラーにする
 *  - ベクトルは pgvector の書き方 '[1,2,3]'。要素は有限の数だけ(NaN・Infinity は不可)。列が vector(n) なら次元が n と違うと入らない
 * 2026-11-04 に pgvector 0.8.7(PostgreSQL 16)と Ollama 0.40.11 の all-minilm で、出した INSERT を流して確かめた。
 */

import { readVectors, type SourceKind } from "./embedding-similarity";
import { MAX_DIMS, isPlainIdentifier } from "./pgvector-sql";

export const INSERT_VERIFIED_ON = "2026-11-04";
/** 一度に変換する行数の上限(出力が大きくなりすぎて画面が固まるのを防ぐ)。 */
export const MAX_ROWS = 1000;
/** 1つの INSERT 文に入れる行数。 */
export const ROWS_PER_STATEMENT = 100;

export type TextsKind = "body" | "array" | "lines";

export type InsertInput = {
  texts: string;
  response: string;
  table: string;
  textColumn: string;
  vectorColumn: string;
  /** 列の次元(vector(n) の n)。空なら確かめない。 */
  dims: string;
};

export type ProblemCode =
  | "textsEmpty"
  | "textsJson"
  | "textsShape"
  | "textNul"
  | "responseEmpty"
  | "responseJson"
  | "responseShape"
  | "base64"
  | "notNumber"
  | "emptyVector"
  | "dimMismatch"
  | "tooMany"
  | "countMismatch"
  | "dimsInput"
  | "dimsColumn"
  | "table"
  | "textColumn"
  | "vectorColumn"
  | "sameColumn";

export type Problem = { code: ProblemCode; severity: "error"; index?: number; detail?: string };

export type InsertResult = {
  problems: Problem[];
  textsKind: TextsKind | null;
  source: SourceKind | null;
  rows: number;
  dims: number;
  sql: string;
};

function readTexts(text: string): { kind: TextsKind; texts: string[] } | ProblemCode {
  const t = text.trim();
  if (!t) return "textsEmpty";
  if (t.startsWith("{") || t.startsWith("[")) {
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      return "textsJson";
    }
    if (Array.isArray(v)) return v.every((x) => typeof x === "string") ? { kind: "array", texts: v as string[] } : "textsShape";
    const input = v && typeof v === "object" ? (v as { input?: unknown }).input : undefined;
    if (typeof input === "string") return { kind: "body", texts: [input] };
    if (Array.isArray(input) && input.every((x) => typeof x === "string")) return { kind: "body", texts: input as string[] };
    return "textsShape";
  }
  return { kind: "lines", texts: text.split(/\r?\n/).filter((l) => l.trim() !== "") };
}

/** SQL の文字列定数にする。' を '' に。 */
export function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** pgvector の書き方のベクトル '[1,2,3]'。 */
export function vectorLiteral(v: number[]): string {
  return `'[${v.map((x) => String(x)).join(",")}]'`;
}

export function buildInsert(input: InsertInput): InsertResult {
  const problems: Problem[] = [];
  const out = (): InsertResult => ({ problems, textsKind, source, rows: 0, dims: 0, sql: "" });
  let textsKind: TextsKind | null = null;
  let source: SourceKind | null = null;

  if (!isPlainIdentifier(input.table)) problems.push({ code: "table", severity: "error" });
  if (!isPlainIdentifier(input.textColumn)) problems.push({ code: "textColumn", severity: "error" });
  if (!isPlainIdentifier(input.vectorColumn)) problems.push({ code: "vectorColumn", severity: "error" });
  else if (input.vectorColumn === input.textColumn) problems.push({ code: "sameColumn", severity: "error" });
  let expected: number | null = null;
  if (input.dims.trim()) {
    const n = Number(input.dims.trim());
    if (Number.isInteger(n) && n >= 1 && n <= MAX_DIMS) expected = n;
    else problems.push({ code: "dimsInput", severity: "error" });
  }

  const read = readTexts(input.texts);
  let texts: string[] = [];
  if (typeof read === "string") problems.push({ code: read, severity: "error" });
  else {
    textsKind = read.kind;
    texts = read.texts;
    if (texts.length === 0) problems.push({ code: "textsEmpty", severity: "error" });
    texts.forEach((s, i) => {
      if (s.includes("\u0000")) problems.push({ code: "textNul", severity: "error", index: i });
    });
  }

  let vecs: number[][] = [];
  if (!input.response.trim()) problems.push({ code: "responseEmpty", severity: "error" });
  else {
    const r = readVectors(input.response);
    if ("code" in r) problems.push({ code: r.code === "json" ? "responseJson" : "responseShape", severity: "error" });
    else {
      source = r.source;
      const bad: Problem[] = [];
      r.raw.forEach((v, i) => {
        if (typeof v === "string") bad.push({ code: "base64", severity: "error", index: i });
        else if (!Array.isArray(v) || v.some((x) => typeof x !== "number" || !Number.isFinite(x)))
          bad.push({ code: "notNumber", severity: "error", index: i });
        else if (v.length === 0) bad.push({ code: "emptyVector", severity: "error", index: i });
      });
      if (r.raw.length === 0) bad.push({ code: "emptyVector", severity: "error" });
      problems.push(...bad);
      if (!bad.length) {
        vecs = r.raw as number[][];
        const dims = [...new Set(vecs.map((v) => v.length))];
        if (dims.length > 1) problems.push({ code: "dimMismatch", severity: "error", detail: dims.join(", ") });
        else if (expected !== null && dims[0] !== expected)
          problems.push({ code: "dimsColumn", severity: "error", detail: String(dims[0]) });
      }
    }
  }

  if (texts.length > MAX_ROWS || vecs.length > MAX_ROWS) problems.push({ code: "tooMany", severity: "error" });
  if (texts.length && vecs.length && texts.length !== vecs.length)
    problems.push({ code: "countMismatch", severity: "error", detail: `${texts.length}/${vecs.length}` });
  if (problems.length) return out();

  const head = `INSERT INTO ${input.table} (${input.textColumn}, ${input.vectorColumn}) VALUES`;
  const statements: string[] = [];
  for (let i = 0; i < texts.length; i += ROWS_PER_STATEMENT) {
    const rows = texts
      .slice(i, i + ROWS_PER_STATEMENT)
      .map((s, j) => `  (${sqlString(s)}, ${vectorLiteral(vecs[i + j])})`)
      .join(",\n");
    statements.push(`${head}\n${rows};`);
  }
  const sql = ["BEGIN;", "", ...statements.flatMap((s) => [s, ""]), "COMMIT;"].join("\n");
  return { problems, textsKind, source, rows: texts.length, dims: vecs[0].length, sql };
}
