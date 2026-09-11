import { describe, expect, it } from "vitest";
import { deriveDueMilestone, milestoneDueOn } from "@cisme/domain";

describe("care selector", () => {
  it("derives D1/D7/D14/D28 from startedOn and clock", () => {
    expect(deriveDueMilestone("2026-08-01", [], new Date("2026-08-01T12:00:00+08:00"))).toBe("D1");
    expect(deriveDueMilestone("2026-08-01", ["D1"], new Date("2026-08-07T12:00:00+08:00"))).toBe("D7");
    expect(deriveDueMilestone("2026-08-01", ["D1", "D7"], new Date("2026-08-14T12:00:00+08:00"))).toBe("D14");
    expect(deriveDueMilestone("2026-08-01", ["D1", "D7", "D14"], new Date("2026-08-28T12:00:00+08:00"))).toBe("D28");
  });

  it("does not pretend a future milestone is due", () => {
    expect(deriveDueMilestone("2026-08-01", ["D1"], new Date("2026-08-03T12:00:00+08:00"))).toBeNull();
    expect(milestoneDueOn("2026-08-01", "D28")).toBe("2026-08-28");
  });

  it("uses the cycle timezone at the UTC date boundary", () => {
    expect(deriveDueMilestone("2026-08-01", ["D1"], new Date("2026-08-06T16:30:00Z"), "Asia/Shanghai")).toBe("D7");
    expect(deriveDueMilestone("2026-08-01", ["D1"], new Date("2026-08-06T16:30:00Z"), "America/Los_Angeles")).toBeNull();
  });
});
