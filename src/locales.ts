/**
 * 対応言語の唯一の定義。
 *
 * 以前は同じ Locale 型が11ファイルに個別に書かれていた。言語を足すたびに全部を
 * 直す必要があり、1つ忘れても気づけない状態だったのでここへ集約した。
 * ここに言語を足すと、翻訳が未記入のファイルが型エラーとして洗い出される。
 */

/**
 * name はその言語の話者自身が読む表記にしてある。言語切替は「今読めない言語」の
 * 画面で使うことがあるため、訳語ではなく母語表記でないと目的の言語を探せない。
 */
/**
 * ogLocale は og:locale 用の language_TERRITORY 表記。SNSはこの形式しか受け付けない。
 * ポルトガル語は話者数の多いブラジルを既定にしている。
 */
export const LOCALES = [
  { code: "ja", htmlLang: "ja", label: "JA", name: "日本語", ogLocale: "ja_JP" },
  { code: "en", htmlLang: "en", label: "EN", name: "English", ogLocale: "en_US" },
  { code: "es", htmlLang: "es", label: "ES", name: "Español", ogLocale: "es_ES" },
  { code: "pt", htmlLang: "pt", label: "PT", name: "Português", ogLocale: "pt_BR" },
  { code: "fr", htmlLang: "fr", label: "FR", name: "Français", ogLocale: "fr_FR" },
  { code: "de", htmlLang: "de", label: "DE", name: "Deutsch", ogLocale: "de_DE" },
  { code: "it", htmlLang: "it", label: "IT", name: "Italiano", ogLocale: "it_IT" },
  { code: "pl", htmlLang: "pl", label: "PL", name: "Polski", ogLocale: "pl_PL" },
  { code: "ru", htmlLang: "ru", label: "RU", name: "Русский", ogLocale: "ru_RU" },
  { code: "tr", htmlLang: "tr", label: "TR", name: "Türkçe", ogLocale: "tr_TR" },
  { code: "vi", htmlLang: "vi", label: "VI", name: "Tiếng Việt", ogLocale: "vi_VN" },
  { code: "id", htmlLang: "id", label: "ID", name: "Bahasa Indonesia", ogLocale: "id_ID" },
  { code: "ko", htmlLang: "ko", label: "KO", name: "한국어", ogLocale: "ko_KR" },
  { code: "zh-tw", htmlLang: "zh-TW", label: "ZH", name: "繁體中文", ogLocale: "zh_TW" },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

export const LOCALE_CODES: Locale[] = LOCALES.map((l) => l.code);

/** 日本語は接頭辞なしで配信しているため、パスの作り方だけ他と異なる。 */
export function localeHome(locale: Locale): string {
  return locale === "ja" ? "/" : `/${locale}`;
}

/** ロケール接頭辞を付けたパスを作る。suffix は "/" か "/tools/xxx" の形。 */
export function localePath(locale: Locale, suffix: string): string {
  const prefix = locale === "ja" ? "" : `/${locale}`;
  if (suffix === "/") return prefix || "/";
  return `${prefix}${suffix}`;
}

/**
 * パスから言語の接頭辞を外して「共通部分」を取り出す。
 * ("/en/tools/json-formatter" -> "/tools/json-formatter")
 *
 * これを別の言語の接頭辞に付け替えると、同じページのまま言語だけ移れる。
 * 全言語で同じslug構成であることが前提。言語切替と言語提案バナーの両方が使う。
 */
export function stripLocalePrefix(pathname: string, locale: Locale): string {
  const prefix = localeHome(locale);
  if (prefix === "/") return pathname;
  if (pathname === prefix) return "/";
  if (pathname.startsWith(prefix + "/")) return pathname.slice(prefix.length);
  return "/";
}
