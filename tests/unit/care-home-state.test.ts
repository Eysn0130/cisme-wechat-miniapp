import { describe, expect, it } from "vitest";
import { careHomeSchedule } from "../../apps/miniprogram/services/care-home-state";

const cycle = { phase: "active", startedOn: "2026-09-01", timezone: "Asia/Shanghai", scheduleOffsetDays: 0, due: null, next: "D7", completed: ["D1"], records: [{ milestone: "D1", completedAt: "2026-09-01T01:00:00.000Z" }] };

describe("home care facts", () => {
  it("does not claim today was completed on a non-milestone day", () => {
    expect(careHomeSchedule(cycle, new Date("2026-09-04T04:00:00.000Z"))).toMatchObject({ state: "not_due", schedule: "下一节点 D7 · 9月7日", completedToday: false });
  });

  it("distinguishes an actual completion today", () => {
    const completedToday = { ...cycle, records: [{ milestone: "D1", completedAt: "2026-09-04T03:00:00.000Z" }] };
    expect(careHomeSchedule(completedToday, new Date("2026-09-04T04:00:00.000Z"))).toMatchObject({ state: "completed_today", completedToday: true });
  });

  it("uses the cycle timezone across midnight", () => {
    const nearMidnight = { ...cycle, next: "D7", startedOn: "2026-09-01", records: [{ milestone: "D1", completedAt: "2026-09-03T16:30:00.000Z" }] };
    expect(careHomeSchedule(nearMidnight, new Date("2026-09-03T17:00:00.000Z"))).toMatchObject({ state: "completed_today", completedToday: true });
  });

  it("preserves due, overdue, paused, and completed facts", () => {
    expect(careHomeSchedule({ ...cycle, due: "D7" }, new Date("2026-09-07T04:00:00.000Z")).state).toBe("due_today");
    expect(careHomeSchedule({ ...cycle, due: "D7" }, new Date("2026-09-08T04:00:00.000Z")).state).toBe("overdue");
    expect(careHomeSchedule({ ...cycle, phase: "paused" }, new Date("2026-09-08T04:00:00.000Z")).state).toBe("paused");
    expect(careHomeSchedule({ ...cycle, phase: "completed", next: null }, new Date("2026-10-01T04:00:00.000Z")).state).toBe("completed");
  });
});
