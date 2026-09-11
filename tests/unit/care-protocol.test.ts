import { describe, expect, it } from "vitest";
import { careDaypart, careGreeting } from "../../apps/miniprogram/services/care-protocol";

describe("native care daypart copy", () => {
  it("uses the care-cycle timezone for morning and evening actions", () => {
    expect(careDaypart(new Date("2026-09-10T01:00:00.000Z"), "Asia/Shanghai")).toEqual({
      greeting: "早上好",
      careAction: "开始今日护理",
      isNight: false
    });
    expect(careDaypart(new Date("2026-09-10T10:00:00.000Z"), "Asia/Shanghai")).toEqual({
      greeting: "晚上好",
      careAction: "开始今晚护理",
      isNight: true
    });
  });

  it("keeps late-night care human and avoids duplicating the member suffix", () => {
    const late = careDaypart(new Date("2026-09-09T18:00:00.000Z"), "Asia/Shanghai");
    expect(late.greeting).toBe("夜深了");
    expect(late.careAction).toBe("开始今晚护理");
    expect(careGreeting("佳静 会员", late)).toBe("夜深了，佳静");
  });
});
