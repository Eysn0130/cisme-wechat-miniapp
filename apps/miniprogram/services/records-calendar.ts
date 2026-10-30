/** Read-only calendar facts. Dates are service Shanghai care days, never device-local dates. */
export interface CalendarRecord { careDay: string }
export interface CalendarPageFacts {
  serverDay: string; items: readonly CalendarRecord[]; hasMore: boolean; nextCursor: string | null;
  totalCount: number; today: { id: string; version: number } | null;
}
export interface CalendarCoverage {
  serverDay: string; oldestDay: string | null; exhausted: boolean; nextCursor: string | null;
  cursors: string[]; totalCount: number; todayStamp: string;
}
export interface CalendarDay {
  iso: string; label: string; day: string; recorded: boolean | null; isToday: boolean;
  future: boolean; covered: boolean; selected: boolean; statusLabel: string; disabled: boolean;
}
export class CalendarPageError extends Error { readonly code = "CALENDAR_PAGE_SEQUENCE_INVALID"; }
const dayMs = 86400000;
function timestamp(day: string): number {
  const value = Date.parse(day + "T00:00:00Z");
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== day) throw new CalendarPageError();
  return value;
}
function iso(value: number): string { return new Date(value).toISOString().slice(0, 10); }
function short(day: string, year = false): string {
  return `${year ? Number(day.slice(0, 4)) + "年" : ""}${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;
}

export function advanceCalendarCoverage(previous: CalendarCoverage | null, page: CalendarPageFacts, cursor: string | null): CalendarCoverage | null {
  timestamp(page.serverDay);
  if (page.hasMore !== (page.nextCursor !== null)) throw new CalendarPageError();
  const todayStamp = page.today ? `${page.today.id}:${page.today.version}` : "";
  if (cursor !== null) {
    if (!previous || previous.nextCursor !== cursor) throw new CalendarPageError();
    // An old keyset cursor still works after midnight; never mix that chain into a new week.
    if (previous.serverDay !== page.serverDay || previous.totalCount !== page.totalCount || previous.todayStamp !== todayStamp) return null;
    if (page.nextCursor && previous.cursors.includes(page.nextCursor)) throw new CalendarPageError();
  }
  let oldestDay = cursor === null ? null : previous!.oldestDay;
  for (const item of page.items) {
    timestamp(item.careDay);
    if (item.careDay > page.serverDay) throw new CalendarPageError();
    if (!oldestDay || item.careDay < oldestDay) oldestDay = item.careDay;
  }
  if (page.hasMore && (!page.items.length || page.nextCursor === cursor)) throw new CalendarPageError();
  return { serverDay: page.serverDay, oldestDay, exhausted: !page.hasMore, nextCursor: page.nextCursor,
    cursors: [...(cursor === null ? [] : previous!.cursors), ...(page.nextCursor ? [page.nextCursor] : [])], totalCount: page.totalCount, todayStamp };
}

export function recordsCalendar<T>(input: {
  records: readonly T[]; careDay: (record: T) => string | undefined; coverage: CalendarCoverage | null;
  selectedDay: string; stale: boolean; loading: boolean; error: string;
}) {
  const { coverage, stale, loading, error } = input;
  if (!coverage) return { calendarServerDay: "", calendarDays: [] as CalendarDay[], calendarWeekLabel: "", calendarSelectedDay: "",
    calendarSelectionLabel: "最近记录", calendarVisibleRecords: [...input.records], calendarCoverageReady: false,
    calendarStale: stale, calendarSelectedEmpty: false };
  const current = timestamp(coverage.serverDay), monday = current - ((new Date(current).getUTCDay() + 6) % 7) * dayMs;
  const recorded = new Set(input.records.map(input.careDay).filter((day): day is string => Boolean(day)));
  if (coverage.todayStamp) recorded.add(coverage.serverDay);
  const labels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const days: CalendarDay[] = labels.map((label, index) => {
    const day = iso(monday + index * dayMs), future = day > coverage.serverDay;
    const covered = !future && (recorded.has(day) || day === coverage.serverDay || coverage.exhausted
      || coverage.oldestDay !== null && day >= coverage.oldestDay);
    return { iso: day, label, day: String(Number(day.slice(8, 10))), recorded: future || !covered ? null : recorded.has(day),
      isToday: !stale && day === coverage.serverDay, future, covered, selected: false,
      statusLabel: stale ? "待更新" : future ? "尚未到这一天" : !covered ? "尚未加载" : recorded.has(day) ? "已记录" : "未记录",
      disabled: future || !covered || stale || loading || Boolean(error) };
  });
  const selected = days.find(day => day.iso === input.selectedDay && day.covered && !day.future)?.iso ?? "";
  days.forEach(day => { day.selected = day.iso === selected; });
  const visible = selected ? input.records.filter(row => input.careDay(row) === selected) : [...input.records];
  const first = days[0]!.iso, last = days[6]!.iso, crossYear = first.slice(0, 4) !== last.slice(0, 4);
  return { calendarServerDay: coverage.serverDay, calendarDays: days, calendarWeekLabel: `${short(first, crossYear)}—${short(last, crossYear)}`,
    calendarSelectedDay: selected, calendarSelectionLabel: selected ? short(selected) : "最近记录", calendarVisibleRecords: visible,
    calendarCoverageReady: !stale && !loading && !error && days.filter(day => !day.future).every(day => day.covered),
    calendarStale: stale, calendarSelectedEmpty: Boolean(selected && !stale && !loading && !error && visible.length === 0
      && !(selected === coverage.serverDay && coverage.todayStamp)) };
}

/** A device clock can trigger one server read, but cannot supply a calendar date. */
export function calendarMidnightDelay(serverDay: string, now: number): number | null {
  const start = timestamp(serverDay) - 8 * 3600000, end = start + dayMs;
  return Number.isFinite(now) && now >= start && now < end ? end - now : null;
}
