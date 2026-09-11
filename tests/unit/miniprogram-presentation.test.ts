import { describe, expect, it } from "vitest";
import { formatCnyCents } from "../../apps/miniprogram/services/presentation";

describe("mini-program presentation helpers", () => {
  it("formats integer cents without losing fractional currency", () => {
    expect(formatCnyCents(19900)).toBe("199");
    expect(formatCnyCents(19950)).toBe("199.50");
    expect(formatCnyCents(19999)).toBe("199.99");
    expect(formatCnyCents(0)).toBe("0");
  });

  it("fails closed for malformed or unsafe prices", () => {
    expect(formatCnyCents(-1)).toBeNull();
    expect(formatCnyCents(1.5)).toBeNull();
    expect(formatCnyCents("not-a-price")).toBeNull();
    expect(formatCnyCents(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });
});
