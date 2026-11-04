/**
 * cron式の「次に動く日時」の検算。
 *
 * **夏時間が終わる日は25時間ある。** ここを「24時間足す」「1時間足す」で
 * 読み飛ばしていると、足しても同じ日・同じ時のままになり、走査が前へ進まなく
 * なる。画面には何も出ず、**タブごと固まって操作できなくなる。**
 * 実際に「毎月1日」「平日9時」のようなありふれた式で、ベルリンやニューヨークの
 * 時計で10月下旬に開くと固まっていた(2026-09-12に修正)。
 *
 * 日本には夏時間が無いので、こちらで触っている限り一生気付けない類の不具合。
 * 英語・ドイツ語・フランス語など、夏時間のある地域向けに出している以上、
 * 切り替わりの前後を名指しで確かめておく。
 *
 * 実行: npm run check
 */
import { parseCron, nextRuns } from "../src/cron-schedule";

let pass = 0;
const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

/** その時間帯の時計で nextRuns を動かし、結果を "MM-DD HH:mm" の並びで返す。 */
function runsIn(tz: string, expr: string, fromIso: string, count = 3): string[] {
  process.env.TZ = tz;
  const parsed = parseCron(expr);
  if (!parsed.ok) return [`parse-error:${parsed.issue.code}`];
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return nextRuns(parsed.schedule, new Date(fromIso), count).map((d) => {
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
  });
}

const eq = (label: string, got: string[], want: string[]) =>
  ok(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} 期待 ${JSON.stringify(want)}`);

// ---- 夏時間が終わる日(1日が25時間ある)を跨ぐ ----
// 欧州は 2025-10-26、米国は 2025-11-02 に戻る。
eq(
  "ベルリン 毎月1日 / 10月下旬から",
  runsIn("Europe/Berlin", "0 0 1 * *", "2025-10-20T10:00:00+02:00"),
  ["11-01 00:00", "12-01 00:00", "01-01 00:00"],
);
eq(
  "ベルリン 平日9時 / 切替の2日前から",
  runsIn("Europe/Berlin", "0 9 * * 1-5", "2025-10-24T10:00:00+02:00"),
  ["10-27 09:00", "10-28 09:00", "10-29 09:00"],
);
eq(
  "ベルリン 毎日3時 / 切替当日の0時半から",
  runsIn("Europe/Berlin", "0 3 * * *", "2025-10-26T00:30:00+02:00"),
  ["10-26 03:00", "10-27 03:00", "10-28 03:00"],
);
eq(
  "ニューヨーク 毎月1日 / 10月末から",
  runsIn("America/New_York", "0 0 1 * *", "2025-10-28T10:00:00-04:00"),
  ["11-01 00:00", "12-01 00:00", "01-01 00:00"],
);
// **2度来る時刻は2度出るのが正しい。** 02:30は夏時間で1回、標準時でもう1回動く。
eq(
  "ベルリン 毎日2時半 / 02:30は切替日に2回ある",
  runsIn("Europe/Berlin", "30 2 * * *", "2025-10-25T12:00:00+02:00"),
  ["10-26 02:30", "10-26 02:30", "10-27 02:30"],
);
// 0時ちょうどに切り替える国。「翌日0時0分へ」がその日の存在しない時刻を指す。
eq(
  "サンティアゴ 毎月1日 / 0時に切り替わる国",
  runsIn("America/Santiago", "0 0 1 * *", "2025-09-01T12:00:00-04:00"),
  ["10-01 00:00", "11-01 00:00", "12-01 00:00"],
);
// 30分ずれる時間帯でも進むこと。
eq(
  "ロードハウ島 毎日2時 / 30分だけ戻る",
  runsIn("Australia/Lord_Howe", "0 2 * * *", "2026-04-04T12:00:00+11:00"),
  ["04-05 02:00", "04-06 02:00", "04-07 02:00"],
);

// ---- 夏時間の無い時間帯(対照)----
eq(
  "東京 毎月1日",
  runsIn("Asia/Tokyo", "0 0 1 * *", "2025-10-20T10:00:00+09:00"),
  ["11-01 00:00", "12-01 00:00", "01-01 00:00"],
);
eq(
  "東京 15分おき",
  runsIn("Asia/Tokyo", "*/15 * * * *", "2025-10-20T10:00:00+09:00", 4),
  ["10-20 10:15", "10-20 10:30", "10-20 10:45", "10-20 11:00"],
);

// ---- 日と曜日は AND ではなく OR ----
{
  process.env.TZ = "Asia/Tokyo";
  const p = parseCron("0 0 1 * MON");
  ok("日と曜日の両方指定が解釈できる", p.ok);
  if (p.ok) {
    const got = nextRuns(p.schedule, new Date("2025-10-20T10:00:00+09:00"), 5);
    const days = got.map((d) => `${d.getMonth() + 1}/${d.getDate()}`);
    // 10/27(月)・11/1(土=1日)・11/3(月)… と、どちらの条件でも動く
    ok("毎月1日と毎週月曜の両方で動く(ORになっている)", days.includes("11/1") && days.includes("10/27"), days.join(","));
  }
}

// ---- * を含むフィールドは「絞り込み」と数えない(crontab(5))----
{
  process.env.TZ = "Asia/Tokyo";
  const p = parseCron("0 0 */2 * MON"); // 日に */2、曜日に MON
  ok("日に */2・曜日に MON が解釈できる", p.ok);
  if (p.ok) {
    ok("日の */2 は絞り込みに数えない", p.schedule.dayRestricted === false);
    ok("曜日の MON は絞り込み", p.schedule.weekdayRestricted === true);
    const got = nextRuns(p.schedule, new Date("2025-10-20T10:00:00+09:00"), 6);
    const bad = got.filter((d) => d.getDay() !== 1 || d.getDate() % 2 === 0);
    ok("月曜かつ奇数日のときだけ動く(AND)", got.length === 6 && bad.length === 0, got.map((d) => `${d.getMonth() + 1}/${d.getDate()}(${d.getDay()})`).join(","));
  }
  const p2 = parseCron("0 0 1 * *");
  ok("日だけ絞り込むと AND(曜日は * で全日)", p2.ok && p2.schedule.dayRestricted && !p2.schedule.weekdayRestricted);
}

// ---- 一致しない指定でも必ず止まる ----
{
  process.env.TZ = "Europe/Berlin";
  const p = parseCron("0 0 30 2 *"); // 2月30日。永久に来ない
  ok("2月30日が式として通る", p.ok);
  if (p.ok) {
    const started = Date.now();
    const got = nextRuns(p.schedule, new Date("2025-01-01T00:00:00Z"), 1);
    const ms = Date.now() - started;
    ok("2月30日は0件で返る", got.length === 0, `${got.length}件`);
    ok("2月30日でも1秒以内に返る", ms < 1000, `${ms}ms`);
  }
}

// ---- 式の読み取り ----
{
  const bad = parseCron("0 0 * *"); // 4つしかない
  ok("フィールドが5つでなければ弾く", !bad.ok && bad.issue.code === "field-count");
  const step0 = parseCron("*/0 * * * *");
  ok("ステップ0を弾く", !step0.ok && step0.issue.code === "bad-step");
  const rev = parseCron("0 0 * * 5-1");
  ok("逆向きの範囲を弾く", !rev.ok && rev.issue.code === "bad-range");
  const sun7 = parseCron("0 0 * * 7");
  ok("曜日の7を日曜として受ける", sun7.ok && sun7.schedule.weekday.has(0));
  const named = parseCron("0 0 * JAN-MAR MON-FRI");
  ok("月・曜日の名前を受ける", named.ok && named.schedule.month.has(2) && named.schedule.weekday.has(5));
}

console.log(`\n[check:cron-schedule] ${pass} 件成功 / ${failures.length} 件失敗`);
if (failures.length) {
  for (const f of failures) console.error("  NG " + f);
  process.exit(1);
}
