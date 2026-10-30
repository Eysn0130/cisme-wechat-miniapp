import { describe, expect, it } from "vitest";
import { advanceCalendarCoverage, recordsCalendar, calendarMidnightDelay, type CalendarCoverage, type CalendarPageFacts } from "../../apps/miniprogram/services/records-calendar";

const row = (careDay: string) => ({ careDay });
function page(serverDay: string, days: string[], nextCursor: string | null = null): CalendarPageFacts {
  return { serverDay, items: days.map(row), hasMore: nextCursor !== null, nextCursor,
    totalCount: days.length, today: days.includes(serverDay) ? { id: "synthetic-today", version: 1 } : null };
}
function view(coverage: CalendarCoverage, days: string[], selectedDay = "", extra = {}) {
  return recordsCalendar({ records: days.map(row), careDay: item => item.careDay, coverage, selectedDay, stale: false, loading: false, error: "", ...extra });
}
describe("Records calendar authoritative dates and coverage", () => {
  it.each([
    ["2026-11-02", "2026-11-02", "2026-11-08"],
    ["2026-11-01", "2026-10-26", "2026-11-01"],
    ["2027-01-01", "2026-12-28", "2027-01-03"]
  ])("uses UTC date arithmetic for server day%s regardless of local timezone", (serverDay, monday, sunday) => {
    const state = advanceCalendarCoverage(null, page(serverDay, []), null)!;
    const calendar = view(state, []);
    expect(calendar.calendarDays[0]!.iso).toBe(monday); expect(calendar.calendarDays[6]!.iso).toBe(sunday);
    expect(calendar.calendarDays.find(day => day.isToday)?.iso).toBe(serverDay);
  });
  it("keeps cross-year week labels unambiguous", () => {
    const calendar = view(advanceCalendarCoverage(null, page("2027-01-01", []), null)!, []);
    expect(calendar.calendarWeekLabel).toBe("2026年12月28日—2027年1月3日");
  });
  it("does not turn an unfinished prefix into seven unrecorded days", () => {
    const p = page("2026-10-30", ["2026-10-30"], "a");
    const calendar = view(advanceCalendarCoverage(null, p, null)!, ["2026-10-30"]);
    expect(calendar.calendarDays[0]).toMatchObject({ covered: false, recorded: null, disabled: true });
    expect(calendar.calendarDays[4]).toMatchObject({ covered: true, recorded: true, disabled: false });
    expect(calendar.calendarDays[5]).toMatchObject({ future: true, recorded: null, disabled: true });
    expect(calendar.calendarCoverageReady).toBe(false);
  });
  it("today null is a positive absence fact from the same head read", () => {
    const p = page("2026-10-30", ["2026-10-29"], "a");
    const calendar = view(advanceCalendarCoverage(null, p, null)!, ["2026-10-29"]);
    expect(calendar.calendarDays[4]).toMatchObject({ covered: true, recorded: false, disabled: false });
  });
  it("only a contiguous same-day chain can extend the coverage frontier", () => {
    const head = { ...page("2026-10-30", ["2026-10-30"], "a"), totalCount: 3 };
    const first = advanceCalendarCoverage(null, head, null)!;
    const second = { ...page("2026-10-30", ["2026-10-28"], "b"), totalCount: 3, today: head.today };
    const state = advanceCalendarCoverage(first, second, "a")!;
    expect(view(state, ["2026-10-30", "2026-10-28"]).calendarDays[1]!.covered).toBe(false);
    const last = { ...page("2026-10-30", ["2026-10-26"]), totalCount: 3, today: head.today };
    const full = advanceCalendarCoverage(state, last, "b")!;
    expect(view(full, ["2026-10-30", "2026-10-28", "2026-10-26"]).calendarCoverageReady).toBe(true);
    expect(() => advanceCalendarCoverage(first, last, "foreign")).toThrow();
  });
  it("rejects a multi-page cursor loop and restarts for server-day or snapshot changes", () => {
    const head = { ...page("2026-10-30", ["2026-10-30"], "a"), totalCount: 3 };
    const one = advanceCalendarCoverage(null, head, null)!;
    const two = advanceCalendarCoverage(one, { ...head, items: [row("2026-10-29")], nextCursor: "b" }, "a")!;
    expect(() => advanceCalendarCoverage(two, { ...head, items: [row("2026-10-28")] }, "b")).toThrow();
    expect(advanceCalendarCoverage(one, { ...head, serverDay: "2026-10-31" }, "a")).toBeNull();
    expect(advanceCalendarCoverage(one, { ...head, totalCount: 4 }, "a")).toBeNull();
    expect(advanceCalendarCoverage(one, { ...head, today: { id: "synthetic-today", version: 2 } }, "a")).toBeNull();
  });
  it("filters known dates without mutating canonical records and clears an outside-week selection", () => {
    const coverage = advanceCalendarCoverage(null, page("2026-10-30", ["2026-10-30", "2026-10-28"]), null)!;
    const selected = view(coverage, ["2026-10-30", "2026-10-28"], "2026-10-28");
    expect(selected.calendarVisibleRecords).toEqual([row("2026-10-28")]); expect(selected.calendarSelectionLabel).toBe("10月28日");
    expect(view(coverage, [], "2026-10-27").calendarSelectedEmpty).toBe(true);
    expect(view(coverage, [], "2026-10-27", { stale: true }).calendarSelectedEmpty).toBe(false);
    expect(view(coverage, [], "2026-10-27", { loading: true }).calendarSelectedEmpty).toBe(false);
    expect(view(coverage, [], "2026-10-27", { error: "synthetic failed read" }).calendarSelectedEmpty).toBe(false);
    expect(view(coverage, [], "2026-10-25").calendarSelectedDay).toBe("");
    expect(view(coverage, [], "2026-10-31").calendarSelectedDay).toBe("");
  });
  it("has no fake initial week and only schedules a refresh within the confirmed Shanghai day", () => {
    const initial = recordsCalendar({ records: [], careDay: () => undefined, coverage: null, selectedDay: "", stale: false, loading: true, error: "" });
    expect(initial.calendarDays).toEqual([]); expect(initial.calendarCoverageReady).toBe(false);
    expect(calendarMidnightDelay("2026-10-30", Date.parse("2026-10-30T15:59:59Z"))).toBe(1000);
    expect(calendarMidnightDelay("2026-10-30", Date.parse("2026-10-30T16:00:00Z"))).toBeNull();
    expect(calendarMidnightDelay("2026-10-30", Date.parse("2026-10-29T15:59:59Z"))).toBeNull();
  });
});
