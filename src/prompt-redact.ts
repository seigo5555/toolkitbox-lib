/**
 * AIに貼る前に、秘密や個人情報を伏せ字にする。返ってきた答えの中の伏せ字は、
 * 手元で元に戻せる。
 *
 * **見つけられるのは、形のあるものだけ。** 文章の中の「社外秘の事業計画」のような
 * 自由な文章は見つけられない。見つからなかったことは、安全の証明にならない。
 * 画面にもそう書く。
 *
 * 検出の種類は、根拠の強さで3つに分けている。
 *  - known     … 公式ドキュメントやRFCで書式が示されているもの(接頭辞など)
 *  - heuristic … 「それらしい形」。公式に書式が示されていない、または名前から推測するもの
 *  - personal  … 個人情報・ネットワーク情報(メール、IPv4、カード番号)
 *
 * 各社のキーの書式で、公式に確認できたのは接頭辞まで(2026-10-23 に確認)。
 * 長さや文字種は公式に書かれていないものが多いので、そこは推測で、広めに取っている。
 *  - AWS: AKIA(長期)/ ASIA(一時)。IAM の「unique ID prefixes」
 *  - GitHub: ghp_ / github_pat_ / gho_ / ghu_ / ghs_ / ghr_。「About authentication to GitHub」
 *  - Slack: xoxb- / xoxp- / xapp- / xwfp-。docs.slack.dev の tokens
 *  - Stripe: sk_ / pk_ / rk_ + test / live。docs.stripe.com/keys
 *  - Anthropic: sk-ant-api…(接頭辞のみ)。OpenAI の sk- は公式に書式が無いので heuristic
 *  - 秘密鍵: RFC 7468 の PEM(BEGIN/END とラベル)。RSA/EC/OPENSSH のラベルは慣習
 *  - JWT: RFC 7519 の「ピリオドで区切った3つの base64url」。eyJ で始まるのは
 *    ヘッダーが {"+英字 で始まるときで、仕様の保証ではない
 *  - Authorization: RFC 9110 / 6750(Bearer)/ 7617(Basic)
 *  - URLの user:password@: RFC 3986。user:password の形は非推奨と明記されている
 *
 * 伏せ字は同じ値に同じ名前を割り当てる([EMAIL_1] など)ので、AIの答えの中で
 * 同じ人・同じサーバーを指していることが保たれる。
 */

/** 各社の公式ドキュメント・RFCと書式を突き合わせた日。更新したら進める。画面に出る。 */
export const VERIFIED_ON = "2026-10-23";

export type DetectorId =
  | "privateKey"
  | "awsKey"
  | "githubToken"
  | "slackToken"
  | "stripeKey"
  | "anthropicKey"
  | "jwt"
  | "apiKeyShape"
  | "authHeader"
  | "urlCredentials"
  | "secretAssignment"
  | "email"
  | "ipv4"
  | "card";

export type Kind = "known" | "heuristic" | "personal";

export type Detector = {
  id: DetectorId;
  kind: Kind;
  /** 伏せ字の名前。[NAME_1] の NAME。 */
  name: string;
  defaultOn: boolean;
  /** 優先順位。小さいほど先に採る(重なったときの取り合い)。 */
  priority: number;
};

export const DETECTORS: Detector[] = [
  { id: "privateKey", kind: "known", name: "PRIVATE_KEY", defaultOn: true, priority: 0 },
  { id: "jwt", kind: "known", name: "JWT", defaultOn: true, priority: 1 },
  { id: "urlCredentials", kind: "heuristic", name: "URL_CREDENTIALS", defaultOn: true, priority: 2 },
  { id: "authHeader", kind: "heuristic", name: "AUTH_TOKEN", defaultOn: true, priority: 3 },
  { id: "awsKey", kind: "known", name: "AWS_KEY", defaultOn: true, priority: 4 },
  { id: "githubToken", kind: "known", name: "GITHUB_TOKEN", defaultOn: true, priority: 4 },
  { id: "slackToken", kind: "known", name: "SLACK_TOKEN", defaultOn: true, priority: 4 },
  { id: "stripeKey", kind: "known", name: "STRIPE_KEY", defaultOn: true, priority: 4 },
  { id: "anthropicKey", kind: "known", name: "ANTHROPIC_KEY", defaultOn: true, priority: 4 },
  { id: "apiKeyShape", kind: "heuristic", name: "API_KEY", defaultOn: true, priority: 5 },
  { id: "secretAssignment", kind: "heuristic", name: "SECRET", defaultOn: true, priority: 6 },
  { id: "email", kind: "personal", name: "EMAIL", defaultOn: true, priority: 7 },
  { id: "card", kind: "personal", name: "CARD", defaultOn: true, priority: 7 },
  { id: "ipv4", kind: "personal", name: "IP", defaultOn: true, priority: 8 },
];

export type Finding = {
  id: DetectorId;
  /** 伏せた範囲(元の文字列の中の位置)。 */
  start: number;
  end: number;
  value: string;
  placeholder: string;
};

export type RedactResult = {
  output: string;
  findings: Finding[];
  /** 伏せ字 → 元の値。ブラウザのメモリの中だけに置く。 */
  map: Record<string, string>;
  counts: Partial<Record<DetectorId, number>>;
};

type Candidate = { id: DetectorId; start: number; end: number; priority: number };

/** 値の範囲だけを伏せたいもの(キー名や見出しは残す)のため、グループ位置を取る。 */
function addAll(
  out: Candidate[],
  id: DetectorId,
  priority: number,
  text: string,
  re: RegExp,
  range?: (m: RegExpExecArray) => [number, number] | null,
) {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    const r = range ? range(m) : [m.index, m.index + m[0].length];
    if (r) out.push({ id, start: r[0], end: r[1], priority });
  }
}

/** Luhn(ISO/IEC 7812 のチェックディジット)。 */
export function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * カード番号らしいか。13〜19桁・Luhn に通る・主要ブランドの先頭桁で始まる。
 * 先頭桁を見るのは、13桁のミリ秒のタイムスタンプなどが、偶然 Luhn に通る(約10%)
 * のを巻き込まないため。
 */
export function looksLikeCard(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  if (!/^[3-6]/.test(digits)) return false;
  return luhn(digits);
}

/**
 * カード番号らしい並びを探す。数字の塊を、空白かハイフン1つでつないだ列として読み、
 * 連続する塊の組み合わせのうち、looksLikeCard に通る**最長**のものを採る。
 * 「12 4242 4242 4242 4242」のように、手前の別の数字がつながっていても、カード番号の
 * 部分だけを見つけるため。
 */
function findCards(text: string): [number, number][] {
  const found: [number, number][] = [];
  // 数字の塊(区切り: 空白またはハイフン1つ)の連なり。
  const run = /\d+(?:[ -]\d+)*/g;
  let m: RegExpExecArray | null;
  while ((m = run.exec(text))) {
    const base = m.index;
    // 連なりの外側に数字・ハイフンが続くもの(例: 日付 2026-10-23 の一部)も、
    // 組み合わせの探索で自然に除かれる(桁数と先頭桁と Luhn に通らない)。
    const groups: { start: number; end: number; digits: string }[] = [];
    const g = /\d+/g;
    let gm: RegExpExecArray | null;
    while ((gm = g.exec(m[0]))) groups.push({ start: base + gm.index, end: base + gm.index + gm[0].length, digits: gm[0] });
    if (groups.length > 40) continue; // 長すぎる列は対象にしない(計算量の上限)
    let i = 0;
    while (i < groups.length) {
      let bestJ = -1;
      let digits = "";
      for (let j = i; j < groups.length; j++) {
        digits += groups[j].digits;
        if (digits.length > 19) break;
        if (looksLikeCard(digits)) bestJ = j;
      }
      if (bestJ >= 0) {
        found.push([groups[i].start, groups[bestJ].end]);
        i = bestJ + 1;
      } else {
        i++;
      }
    }
  }
  return found;
}

const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";

function collect(text: string, enabled: ReadonlySet<DetectorId>): Candidate[] {
  const out: Candidate[] = [];
  const on = (id: DetectorId) => enabled.has(id);
  const prio = (id: DetectorId) => DETECTORS.find((d) => d.id === id)!.priority;

  if (on("privateKey")) {
    // BEGIN 〜 END。END が無い(途中で切れた貼り付け)ときは、文末まで伏せる。
    addAll(out, "privateKey", prio("privateKey"), text, /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g);
  }
  if (on("jwt")) {
    addAll(out, "jwt", prio("jwt"), text, /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g);
  }
  if (on("urlCredentials")) {
    // scheme://user:password@host — user:password の部分を伏せる。
    addAll(out, "urlCredentials", prio("urlCredentials"), text, /\b[a-z][a-z0-9+.-]*:\/\/([^\s:@/]+:[^\s@/]+)@/gi, (m) => {
      const s = m.index + m[0].indexOf(m[1]);
      return [s, s + m[1].length];
    });
  }
  if (on("authHeader")) {
    // Authorization: Bearer xxx / Basic xxx — 資格情報の部分だけを伏せる。
    addAll(out, "authHeader", prio("authHeader"), text, /\bAuthorization\s*:\s*(?:Bearer|Basic|Token)\s+([A-Za-z0-9\-._~+/]+=*)/gi, (m) => {
      const s = m.index + m[0].length - m[1].length;
      return [s, s + m[1].length];
    });
  }
  if (on("awsKey")) addAll(out, "awsKey", prio("awsKey"), text, /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g);
  if (on("githubToken")) {
    addAll(out, "githubToken", prio("githubToken"), text, /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g);
  }
  if (on("slackToken")) addAll(out, "slackToken", prio("slackToken"), text, /\b(?:xoxb|xoxp|xapp|xwfp)-[A-Za-z0-9-]{10,}/g);
  if (on("stripeKey")) addAll(out, "stripeKey", prio("stripeKey"), text, /\b[spr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g);
  if (on("anthropicKey")) addAll(out, "anthropicKey", prio("anthropicKey"), text, /\bsk-ant-api[0-9]*-[A-Za-z0-9_-]{20,}/g);
  if (on("apiKeyShape")) {
    addAll(out, "apiKeyShape", prio("apiKeyShape"), text, /\bsk-[A-Za-z0-9_-]{20,}|\bAIza[0-9A-Za-z_-]{35}\b/g);
  }
  if (on("secretAssignment")) {
    // password = "...", API_KEY=..., "token": "..." のように、名前が秘密らしい代入。値だけを伏せる。
    // 名前に "auth" だけを含むものは対象にしない("Authorization: Bearer …" の Bearer や "author = …" を伏せてしまうため)。
    addAll(
      out,
      "secretAssignment",
      prio("secretAssignment"),
      text,
      /\b[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passwd|password|passphrase|pwd)[A-Za-z0-9_.-]*["']?\s*[:=]\s*(["']?)([^\s"',;)}\]]{6,})\1/gi,
      (m) => {
        const valueStart = m.index + m[0].length - m[1].length - m[2].length;
        // 既に伏せ字になっているもの([EMAIL_1] など)や、真偽値・数だけ・null は伏せない。
        if (/^\[[A-Z_]+_\d+\]$/.test(m[2]) || /^(?:true|false|null|none|undefined)$/i.test(m[2]) || /^\d{1,6}$/.test(m[2])) return null;
        return [valueStart, valueStart + m[2].length];
      },
    );
  }
  if (on("email")) addAll(out, "email", prio("email"), text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g);
  if (on("card")) {
    for (const r of findCards(text)) out.push({ id: "card", start: r[0], end: r[1], priority: prio("card") });
  }
  if (on("ipv4")) {
    addAll(out, "ipv4", prio("ipv4"), text, new RegExp(`(?<![\\w.])${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}(?![\\w.]*\\w)`, "g"));
  }
  return out;
}

/** 重なったものを、優先順位 → 長さ → 位置の順で1つに絞る。 */
function resolve(cands: Candidate[]): Candidate[] {
  const sorted = [...cands].sort((a, b) => a.priority - b.priority || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const taken: Candidate[] = [];
  for (const c of sorted) {
    if (taken.some((t) => c.start < t.end && t.start < c.end)) continue;
    taken.push(c);
  }
  return taken.sort((a, b) => a.start - b.start);
}

export function redact(text: string, enabled: ReadonlySet<DetectorId>): RedactResult {
  const picked = resolve(collect(text, enabled));
  const map: Record<string, string> = {};
  const byValue = new Map<string, string>(); // `${name}\u0000${value}` -> placeholder
  const counters = new Map<string, number>();
  const findings: Finding[] = [];
  const counts: Partial<Record<DetectorId, number>> = {};
  let out = "";
  let last = 0;

  for (const c of picked) {
    const det = DETECTORS.find((d) => d.id === c.id)!;
    const value = text.slice(c.start, c.end);
    const key = `${det.name}\u0000${value}`;
    let ph = byValue.get(key);
    if (!ph) {
      // 元の文章に、同じ見た目の伏せ字が既にあると、元に戻すときに区別できない。避ける。
      let n = counters.get(det.name) ?? 0;
      do {
        n++;
        ph = `[${det.name}_${n}]`;
      } while (text.includes(ph));
      counters.set(det.name, n);
      byValue.set(key, ph);
      map[ph] = value;
    }
    findings.push({ id: c.id, start: c.start, end: c.end, value, placeholder: ph });
    counts[c.id] = (counts[c.id] ?? 0) + 1;
    out += text.slice(last, c.start) + ph;
    last = c.end;
  }
  out += text.slice(last);
  return { output: out, findings, map, counts };
}

/** AIの答えの中の伏せ字を、元の値に戻す。知らない伏せ字はそのまま。 */
export function restore(text: string, map: Record<string, string>): string {
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  if (keys.length === 0) return text;
  const re = new RegExp(keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return text.replace(re, (k) => map[k]);
}

/** 画面の「例を入れる」で使う文章。値はすべて文書用・テスト用の架空のもの。 */
export const EXAMPLE_TEXT = `Please review this deploy script and tell me why the login fails.

export DATABASE_URL=postgres://admin:s3cretPass99@db.internal.example.com:5432/app
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
export SLACK_TOKEN=xoxp-${"111-222-333-d6bc768406e5c2e6958cfc399b438004"}

curl -H "Authorization: Bearer mF_9.B5f-4.1JqM" https://203.0.113.20/api/me
Contact: ada@example.com, test card 4242 4242 4242 4242

password = "hunter2hunter2"
`;
