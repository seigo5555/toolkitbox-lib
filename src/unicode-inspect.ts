/**
 * 文字列を1文字ずつ分解して、何が入っているかを見せる。
 *
 * 「見た目は同じなのに一致しない」の原因は、たいてい目に見えない。
 * このツールは**見えないものを見えるようにする**ことを目的にしている。
 *
 * 実務で当たるのは主に次の4つ。
 *
 *  1. **ゼロ幅文字・BOM。** コピーしたときに紛れ込む。幅が無いので画面では
 *     何も起きないが、比較には効く
 *  2. **正規化の違い。** 「が」は1文字でも2文字でも表せる(NFC / NFD)。
 *     macOSのファイル名はNFDになりやすく、Windowsから来た文字列と一致しない
 *  3. **紛らわしい文字。** キリル文字の「а」とラテン文字の「a」は見分けが
 *     つかない。パスワードやドメイン名で問題になる
 *  4. **サロゲートペアと結合。** 絵文字は1文字に見えて中身は複数
 */

export type CharInfo = {
  /** 人が見て1文字と数える単位(書記素クラスタ)。 */
  grapheme: string;
  /** その中に入っているコードポイント。 */
  codePoints: {
    hex: string;
    dec: number;
    /** UTF-16 でいくつ分か。JavaScript の .length に効く。 */
    utf16Units: number;
    /** UTF-8 で何バイトか。 */
    utf8Bytes: number;
    /** 見えない文字なら Unicode の正式名(英語のまま。どの言語でも同じ名前で検索できる)。 */
    name: string | null;
    /** 正式名に添える短い説明。文は unicode-inspect-messages.ts に14言語で持つ。 */
    gloss: GlossCode | null;
    /** 見えない文字以外は、おおまかな範囲の名前。 */
    block: BlockCode | null;
    invisible: boolean;
  }[];
};

export type GlossCode = "tab" | "lf" | "cr" | "nbsp" | "softHyphen" | "zwsp" | "zwj" | "rlo" | "ideographicSpace" | "replacement";

export type BlockCode =
  | "control"
  | "ascii"
  | "latin1"
  | "latinExtA"
  | "combining"
  | "greek"
  | "cyrillic"
  | "hebrew"
  | "arabic"
  | "hiragana"
  | "katakana"
  | "cjkExtA"
  | "cjk"
  | "hangul"
  | "privateUse"
  | "variationSelector"
  | "halfFullwidth"
  | "emoji"
  | "regionalIndicator"
  | "cjkExtB"
  | "other";

/** 幅を持たない、または見た目に出ない文字。混入すると厄介なもの。 */
const INVISIBLE: Record<number, { name: string; gloss?: GlossCode }> = {
  0x0009: { name: "TAB", gloss: "tab" },
  0x000a: { name: "LF", gloss: "lf" },
  0x000d: { name: "CR", gloss: "cr" },
  0x00a0: { name: "NO-BREAK SPACE", gloss: "nbsp" },
  0x00ad: { name: "SOFT HYPHEN", gloss: "softHyphen" },
  0x180e: { name: "MONGOLIAN VOWEL SEPARATOR" },
  0x200b: { name: "ZERO WIDTH SPACE", gloss: "zwsp" },
  0x200c: { name: "ZERO WIDTH NON-JOINER" },
  0x200d: { name: "ZERO WIDTH JOINER", gloss: "zwj" },
  0x200e: { name: "LEFT-TO-RIGHT MARK" },
  0x200f: { name: "RIGHT-TO-LEFT MARK" },
  0x2028: { name: "LINE SEPARATOR" },
  0x2029: { name: "PARAGRAPH SEPARATOR" },
  0x202a: { name: "LEFT-TO-RIGHT EMBEDDING" },
  0x202b: { name: "RIGHT-TO-LEFT EMBEDDING" },
  0x202c: { name: "POP DIRECTIONAL FORMATTING" },
  0x202d: { name: "LEFT-TO-RIGHT OVERRIDE" },
  0x202e: { name: "RIGHT-TO-LEFT OVERRIDE", gloss: "rlo" },
  0x2060: { name: "WORD JOINER" },
  0x3000: { name: "IDEOGRAPHIC SPACE", gloss: "ideographicSpace" },
  0xfeff: { name: "ZERO WIDTH NO-BREAK SPACE / BOM" },
  0xfffc: { name: "OBJECT REPLACEMENT CHARACTER" },
  0xfffd: { name: "REPLACEMENT CHARACTER", gloss: "replacement" },
};

/** よく出る範囲だけ、おおまかな名前を付ける。全部の名前表は持たない(重すぎる)。 */
function blockOf(cp: number): BlockCode {
  if (cp < 0x20 || cp === 0x7f) return "control";
  if (cp <= 0x7e) return "ascii";
  if (cp <= 0xff) return "latin1";
  if (cp <= 0x17f) return "latinExtA";
  if (cp >= 0x300 && cp <= 0x36f) return "combining";
  if (cp >= 0x370 && cp <= 0x3ff) return "greek";
  if (cp >= 0x400 && cp <= 0x4ff) return "cyrillic";
  if (cp >= 0x590 && cp <= 0x5ff) return "hebrew";
  if (cp >= 0x600 && cp <= 0x6ff) return "arabic";
  if (cp >= 0x3040 && cp <= 0x309f) return "hiragana";
  if (cp >= 0x30a0 && cp <= 0x30ff) return "katakana";
  if (cp >= 0x3400 && cp <= 0x4dbf) return "cjkExtA";
  if (cp >= 0x4e00 && cp <= 0x9fff) return "cjk";
  if (cp >= 0xac00 && cp <= 0xd7af) return "hangul";
  if (cp >= 0xe000 && cp <= 0xf8ff) return "privateUse";
  if (cp >= 0xfe00 && cp <= 0xfe0f) return "variationSelector";
  if (cp >= 0xff00 && cp <= 0xffef) return "halfFullwidth";
  if (cp >= 0x1f300 && cp <= 0x1faff) return "emoji";
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return "regionalIndicator";
  if (cp >= 0x20000) return "cjkExtB";
  return "other";
}

export function utf8Length(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/** 人が数える1文字ずつに割る。Intl.Segmenter があればそれを使う。 */
export function splitGraphemes(text: string): string[] {
  const Seg = (globalThis as { Intl?: { Segmenter?: new (l?: string, o?: object) => { segment(s: string): Iterable<{ segment: string }> } } }).Intl?.Segmenter;
  if (Seg) {
    const seg = new Seg(undefined, { granularity: "grapheme" });
    return [...seg.segment(text)].map((s) => s.segment);
  }
  // 使えない環境ではコードポイント単位にする。絵文字がばらけるが落ちはしない。
  return [...text];
}

export function inspect(text: string): CharInfo[] {
  return splitGraphemes(text).map((grapheme) => ({
    grapheme,
    codePoints: [...grapheme].map((ch) => {
      const cp = ch.codePointAt(0)!;
      return {
        hex: "U+" + cp.toString(16).toUpperCase().padStart(4, "0"),
        dec: cp,
        utf16Units: ch.length,
        utf8Bytes: utf8Length(cp),
        name: INVISIBLE[cp]?.name ?? null,
        gloss: INVISIBLE[cp]?.gloss ?? null,
        block: INVISIBLE[cp] ? null : blockOf(cp),
        invisible: cp in INVISIBLE || cp < 0x20 || cp === 0x7f,
      };
    }),
  }));
}

export type Counts = {
  /** 人が数える文字数。 */
  graphemes: number;
  /** コードポイント数。 */
  codePoints: number;
  /** JavaScript の .length と同じ値。 */
  utf16Units: number;
  utf8Bytes: number;
};

export function countAll(text: string): Counts {
  const graphemes = splitGraphemes(text).length;
  const cps = [...text];
  return {
    graphemes,
    codePoints: cps.length,
    utf16Units: text.length,
    utf8Bytes: cps.reduce((n, ch) => n + utf8Length(ch.codePointAt(0)!), 0),
  };
}

export type NormalizationInfo = {
  form: "NFC" | "NFD" | "NFKC" | "NFKD";
  result: string;
  same: boolean;
  counts: Counts;
};

/**
 * 4つの正規化形をすべて出す。
 * **NFKC / NFKD は見た目を変える。** 全角英数が半角になり、㈱ が (株) になる。
 * 検索の索引作りには向くが、原文の保存には使ってはいけない。
 */
export function normalizations(text: string): NormalizationInfo[] {
  return (["NFC", "NFD", "NFKC", "NFKD"] as const).map((form) => {
    const result = text.normalize(form);
    return { form, result, same: result === text, counts: countAll(result) };
  });
}

export type WarningKind = "zero-width" | "bom" | "replacement" | "bidi" | "nbsp" | "ideographic-space" | "mixed-script" | "not-nfc";

/** 文は unicode-inspect-messages.ts に14言語で持つ。count は zero-width の個数。 */
export type Warning = { kind: WarningKind; count?: number };

/**
 * 混入していると困るものを挙げる。
 * **画面では何も起きないのに比較だけが失敗する**、という形で表れるもの。
 */
export function warningsFor(text: string): Warning[] {
  const out: Warning[] = [];
  const cps = [...text].map((c) => c.codePointAt(0)!);

  const zeroWidth = cps.filter((c) => c === 0x200b || c === 0x200c || c === 0xfeff);
  if (zeroWidth.length > 0) out.push({ kind: "zero-width", count: zeroWidth.length });
  if (cps[0] === 0xfeff) out.push({ kind: "bom" });
  if (cps.includes(0xfffd)) out.push({ kind: "replacement" });
  if (cps.some((c) => c === 0x202e || c === 0x202d || c === 0x202b || c === 0x202a)) out.push({ kind: "bidi" });
  if (cps.includes(0x00a0)) out.push({ kind: "nbsp" });
  if (cps.includes(0x3000)) out.push({ kind: "ideographic-space" });

  // 見分けのつかない文字の混在。ドメイン名やパスワードで問題になる。
  const hasLatin = /[A-Za-z]/.test(text);
  const hasCyrillic = /[Ѐ-ӿ]/.test(text);
  const hasGreek = /[Ͱ-Ͽ]/.test(text);
  if (hasLatin && (hasCyrillic || hasGreek)) out.push({ kind: "mixed-script" });

  if (text !== text.normalize("NFC")) out.push({ kind: "not-nfc" });

  return out;
}

export const SAMPLE_TEXT = "ｶﾞ が が​ A а 👨‍👩‍👧‍👦 🇯🇵 ﬁ ㈱";
