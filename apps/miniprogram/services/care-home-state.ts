export interface CareHomeRecord { milestone: string; completedAt: string }
export interface CareHomeCycle {
  phase: string;
  startedOn?: string | null;
  timezone?: string;
  scheduleOffsetDays?: number;
  due?: string | null;
  next?: string | null;
  completed?: string[];
  records?: CareHomeRecord[];
}

export type CareHomeScheduleState = "waiting" | "planned" | "paused" | "terminated" | "completed" | "due_today" | "overdue" | "completed_today" | "not_due";
export interface CareHomeScheduleView { state: CareHomeScheduleState; schedule: string; completedToday: boolean; nextDueOn: string | null }

const milestoneOffsets: Record<string, number> = { D1: 0, D7: 6, D14: 13, D28: 27 };

function localDate(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const indexed = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${indexed.year}-${indexed.month}-${indexed.day}`;
}

function dueOn(cycle: CareHomeCycle, milestone: string | null | undefined): string | null {
  if (!cycle.startedOn || !milestone || milestoneOffsets[milestone] === undefined) return null;
  const start = new Date(`${cycle.startedOn}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime())) return null;
  start.setUTCDate(start.getUTCDate() + milestoneOffsets[milestone]! + (Number.isInteger(cycle.scheduleOffsetDays) ? Number(cycle.scheduleOffsetDays) : 0));
  return start.toISOString().slice(0, 10);
}

function shortDate(date: string): string {
  const [, month = "", day = ""] = date.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

export function careHomeSchedule(cycle: CareHomeCycle | null, now = new Date()): CareHomeScheduleView {
  if (!cycle) return { state: "waiting", schedule: "日常护理", completedToday: false, nextDueOn: null };
  if (cycle.phase === "planned") return { state: "planned", schedule: "待你确认开始", completedToday: false, nextDueOn: null };
  if (cycle.phase === "paused") return { state: "paused", schedule: "护理周期已暂停", completedToday: false, nextDueOn: dueOn(cycle, cycle.next) };
  if (cycle.phase === "terminated") return { state: "terminated", schedule: "护理周期已终止", completedToday: false, nextDueOn: null };
  if (cycle.phase === "completed") return { state: "completed", schedule: "D28 · 周期完成", completedToday: false, nextDueOn: null };

  const timezone = cycle.timezone || "Asia/Shanghai";
  const today = localDate(now, timezone);
  const completedToday = (cycle.records ?? []).some((record) => Number.isFinite(Date.parse(record.completedAt)) && localDate(new Date(record.completedAt), timezone) === today);
  const dueMilestone = cycle.due ?? null;
  if (dueMilestone) {
    const date = dueOn(cycle, dueMilestone);
    const overdue = Boolean(date && date < today);
    return { state: overdue ? "overdue" : "due_today", schedule: `${dueMilestone} · ${overdue ? "待补做" : "今日护理"}`, completedToday, nextDueOn: date };
  }
  if (completedToday) return { state: "completed_today", schedule: "今天的护理已记录", completedToday: true, nextDueOn: dueOn(cycle, cycle.next) };
  const nextDate = dueOn(cycle, cycle.next);
  return {
    state: "not_due",
    schedule: cycle.next ? `下一节点 ${cycle.next}${nextDate ? ` · ${shortDate(nextDate)}` : ""}` : "今天没有待完成节点",
    completedToday: false,
    nextDueOn: nextDate
  };
}
