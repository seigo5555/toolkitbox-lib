/**
 * cron式を解析して、次に動く日時を求める。
 *
 * 既存の Cron Generator は式を「言葉で説明する」ツールだが、実務で本当に知りたいのは
 * 「で、次はいつ動くのか」であることが多い。ここはその計算を担う。
 *
 * 実装で気をつけている点:
 *
 * 1. 日(3番目)と曜日(5番目)を両方指定したとき、cronは AND ではなく OR で判定する。
 *    "0 0 1 * MON" は「毎月1日」と「毎週月曜」の両方で動く。ここを AND にすると
 *    実際の動作とずれる。多くの人が誤解する箇所なので、UIでも注記を出す。
 *
 * 2. 曜日は 0 と 7 のどちらも日曜。
 *
 * 3. 存在しない日付(2月30日など)を指定すると永久に一致しない。
 *    無限ループを避けるため探索範囲に上限を設ける。
 */

export type CronField = "minute" | "hour" | "day" | "month" | "weekday";

export type CronParseIssue =
  | { code: "field-count"; count: number }
  | { code: "out-of-range"; field: CronField; token: string; min: number; max: number }
  | { code: "bad-range"; field: CronField; token: string }
  | { code: "bad-step"; field: CronField; token: string }
  | { code: "bad-token"; field: CronField; token: string };

export type CronSchedule = {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  /** 日・曜日が「*」以外で絞り込まれているか。OR判定の要否に使う。 */
  dayRestricted: boolean;
  weekdayRestricted: boolean;
};

export type CronParseResult =
  | { ok: true; schedule: CronSchedule }
  | { ok: false; issue: CronParseIssue };

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const RANGES: Record<CronField, { min: number; max: number; names?: string[] }> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  day: { min: 1, max: 31 },
  month: { min: 1, max: 12, names: MONTH_NAMES },
  weekday: { min: 0, max: 6, names: WEEKDAY_NAMES },
};

/** "MON" や "3" を数値へ。範囲外・未知の名前は null。 */
function toNumber(raw: string, field: CronField): number | null {
  const spec = RANGES[field];
  const lower = raw.toLowerCase();

  if (spec.names) {
    const idx = spec.names.indexOf(lower);
    if (idx !== -1) return field === "month" ? idx + 1 : idx;
  }
  if (!/^\d+$/.test(raw)) return null;

  const n = Number(raw);
  // 曜日の7は日曜(0)の別表記。
  if (field === "weekday" && n === 7) return 0;
  return n >= spec.min && n <= spec.max ? n : null;
}

function parseField(raw: string, field: CronField): Set<number> | CronParseIssue {
  const spec = RANGES[field];
  const values = new Set<number>();

  for (const part of raw.split(",")) {
    if (part === "") return { code: "bad-token", field, token: raw };

    // "*/5" や "10-30/5" のステップ指定。
    let step = 1;
    let body = part;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      body = part.slice(0, slash);
      const stepRaw = part.slice(slash + 1);
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) === 0) {
        return { code: "bad-step", field, token: part };
      }
      step = Number(stepRaw);
    }

    let from: number;
    let to: number;

    if (body === "*") {
      from = spec.min;
      to = spec.max;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-");
      const start = toNumber(a, field);
      const end = toNumber(b, field);
      if (start === null || end === null) {
        return { code: "out-of-range", field, token: body, min: spec.min, max: spec.max };
      }
      if (start > end) return { code: "bad-range", field, token: body };
      from = start;
      to = end;
    } else {
      const one = toNumber(body, field);
      if (one === null) {
        return /^\d+$/.test(body) || RANGES[field].names
          ? { code: "out-of-range", field, token: body, min: spec.min, max: spec.max }
          : { code: "bad-token", field, token: body };
      }
      from = one;
      // ステップ付きの単独値("5/10")は、その値から上限までを刻む。
      to = slash === -1 ? one : spec.max;
    }

    for (let v = from; v <= to; v += step) values.add(v);
  }

  return values;
}

export function parseCron(expr: string): CronParseResult {
  const parts = expr.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return { ok: false, issue: { code: "field-count", count: parts.length } };

  const order: CronField[] = ["minute", "hour", "day", "month", "weekday"];
  const sets: Partial<Record<CronField, Set<number>>> = {};

  for (let i = 0; i < 5; i++) {
    const result = parseField(parts[i], order[i]);
    if (result instanceof Set) sets[order[i]] = result;
    else return { ok: false, issue: result };
  }

  return {
    ok: true,
    schedule: {
      minute: sets.minute!,
      hour: sets.hour!,
      day: sets.day!,
      month: sets.month!,
      weekday: sets.weekday!,
      // 「絞り込まれている」= フィールドに * を含まない(crontab(5))。
      // "*/2" は * を含むので絞り込みとは数えない。以前は "*" だけを見ていて、
      // 日に "*/2"・曜日に "1" と書くと OR になり、AND の実際の cron と食い違っていた。
      dayRestricted: !parts[2].includes("*"),
      weekdayRestricted: !parts[4].includes("*"),
    },
  };
}

/** ローカル時刻とUTCで同じコードを使うための読み書き。 */
type Clock = {
  year: (d: Date) => number;
  month: (d: Date) => number;
  date: (d: Date) => number;
  hours: (d: Date) => number;
  minutes: (d: Date) => number;
  weekday: (d: Date) => number;
  make: (y: number, mo: number, d: number, h: number, mi: number) => Date;
};

const LOCAL: Clock = {
  year: (d) => d.getFullYear(),
  month: (d) => d.getMonth() + 1,
  date: (d) => d.getDate(),
  hours: (d) => d.getHours(),
  minutes: (d) => d.getMinutes(),
  weekday: (d) => d.getDay(),
  make: (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0),
};

const UTC: Clock = {
  year: (d) => d.getUTCFullYear(),
  month: (d) => d.getUTCMonth() + 1,
  date: (d) => d.getUTCDate(),
  hours: (d) => d.getUTCHours(),
  minutes: (d) => d.getUTCMinutes(),
  weekday: (d) => d.getUTCDay(),
  make: (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h, mi, 0, 0)),
};

/**
 * 日付が一致するか。
 * 日と曜日の両方が絞り込まれている(どちらも * を含まない)場合は OR。それ以外は両方の条件を満たす日(AND)。
 */
function dateMatches(s: CronSchedule, day: number, weekday: number): boolean {
  if (s.dayRestricted && s.weekdayRestricted) {
    return s.day.has(day) || s.weekday.has(weekday);
  }
  // 片方が * を含むなら、日と曜日の**両方**が合う日だけ。"*" は全日を含むので、
  // 実質は絞り込んだほうだけが効く。"*/2" のように * を含みつつ日を間引く指定は、
  // 絞り込みとは数えないが、間引いた結果は effective に効く(AND)。
  return s.day.has(day) && s.weekday.has(weekday);
}

/**
 * 探索の上限。2月30日のように永久に来ない指定でも必ず止まるようにする。
 * 10年にしているのは、2月29日(4年ごと)でも複数件返せるようにするため。
 * 一致しない月・日はまとめて飛ばすので、この範囲を走査しても一瞬で終わる。
 */
const MAX_YEARS_AHEAD = 10;

/**
 * 走査の打ち切り。**これは安全装置で、通常は遠く手前で終わる。**
 * 一致しない月・日はまとめて飛ばすので、10年先まで一度も一致しない指定
 * (2月30日など)でも実際は4千回ほどで終わる。
 * 万一また進まなくなったとき、固まる代わりに空で返らせるために置いている。
 */
const MAX_STEPS = 1_000_000;

/**
 * from より後で、次に一致する日時を count 件返す。
 * 一致しない月・日はまとめて読み飛ばすので、稀な条件でも実用的な速さで返る。
 */
export function nextRuns(schedule: CronSchedule, from: Date, count: number, useUtc = false): Date[] {
  const c = useUtc ? UTC : LOCAL;
  const results: Date[] = [];
  const limitYear = c.year(from) + MAX_YEARS_AHEAD;

  // 秒以下を切り捨てて次の分から探す(fromちょうどは含めない)。
  let cursor = c.make(c.year(from), c.month(from), c.date(from), c.hours(from), c.minutes(from));
  cursor = new Date(cursor.getTime() + 60_000);

  let steps = 0;
  while (results.length < count) {
    if (++steps > MAX_STEPS) break;
    const year = c.year(cursor);
    if (year > limitYear) break;

    // 読み飛ばしたあと、必ず前に進んでいることを確かめるための基準。
    // **進まなくなるとタブごと固まって操作できなくなる。** 下の3つは進むように
    // 直してあるが、時差の規則は国の都合で変わる(0時ちょうどに切り替える国も
    // 実在した)ので、毎回確かめて最低でも1分は進める。
    const before = cursor.getTime();
    const skipTo = (d: Date) => {
      cursor = d.getTime() > before ? d : new Date(before + 60_000);
    };

    if (!schedule.month.has(c.month(cursor))) {
      // 月ごと読み飛ばす。翌月1日0時0分へ。
      const nextMonth = c.month(cursor) + 1;
      skipTo(nextMonth > 12 ? c.make(year + 1, 1, 1, 0, 0) : c.make(year, nextMonth, 1, 0, 0));
      continue;
    }

    if (!dateMatches(schedule, c.date(cursor), c.weekday(cursor))) {
      // 日ごと読み飛ばす。翌日0時0分へ。
      // **「24時間足す」ではなく「日付に1足す」。** 夏時間が終わる日は25時間
      // あるので、24時間足しても同じ日の23時にしかならない。そこから0時に
      // 丸め直すと出発点に戻り、永久に進まなくなる。
      skipTo(c.make(c.year(cursor), c.month(cursor), c.date(cursor) + 1, 0, 0));
      continue;
    }

    if (!schedule.hour.has(c.hours(cursor))) {
      // 時ごと読み飛ばす。こちらも「1時間足す」ではなく「時に1足す」。
      // 繰り返される1時間(02:00夏時間→02:00標準時)では、1時間足しても
      // 同じ「2時」のままで進まない。
      skipTo(c.make(c.year(cursor), c.month(cursor), c.date(cursor), c.hours(cursor) + 1, 0));
      continue;
    }

    if (schedule.minute.has(c.minutes(cursor))) {
      results.push(new Date(cursor.getTime()));
    }
    cursor = new Date(cursor.getTime() + 60_000);
  }

  return results;
}

/** 次の実行までの残り時間。UIで「あと2時間30分」と出すため。 */
export function timeUntil(target: Date, now: Date): { days: number; hours: number; minutes: number } {
  const diff = Math.max(0, target.getTime() - now.getTime());
  const minutes = Math.floor(diff / 60_000);
  return {
    days: Math.floor(minutes / (60 * 24)),
    hours: Math.floor((minutes % (60 * 24)) / 60),
    minutes: minutes % 60,
  };
}
