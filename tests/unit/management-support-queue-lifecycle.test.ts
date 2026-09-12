import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("../../apps/miniprogram/services/api", () => ({ request: requestMock }));
vi.mock("../../apps/miniprogram/services/authority", () => ({ requireCapability: vi.fn(async () => ({ capabilities: ["support.read"] })) }));
vi.mock("../../apps/miniprogram/services/layout", () => ({ currentChromeStyle: () => "" }));

let definition: Record<string, any>;
beforeEach(() => {
  vi.resetModules();
  requestMock.mockReset();
  (globalThis as any).Page = (page: Record<string, any>) => { definition = page; };
  (globalThis as any).wx = { showToast: vi.fn() };
});

describe("management support queue lifecycle", () => {
  it("discards an older pagination response and releases its loading state after returning", async () => {
    await import("../../apps/miniprogram/pages/management-support/index");
    const page: Record<string, any> = {
      ...definition,
      data: { ...definition.data, items: [{ id: "old" }], nextCursor: "older", loading: false },
      setData(patch: Record<string, unknown>) { Object.assign(this.data, patch); },
      startPolling: vi.fn(), stopPolling: vi.fn()
    };
    let finishOld!: (value: unknown) => void;
    requestMock.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const older = page.loadMore();
    expect(page.data.loadingMore).toBe(true);

    page.onHide();
    requestMock.mockResolvedValueOnce({ items: [{ id: "fresh", memberDisplayName: "会员", updatedAt: "2026-09-12T00:00:00Z" }], nextCursor: null });
    await page.onShow();
    expect(page.data.loadingMore).toBe(false);
    expect(page.data.items.map((item: { id: string }) => item.id)).toEqual(["fresh"]);

    finishOld({ items: [{ id: "stale", memberDisplayName: "旧会员", updatedAt: "2026-09-11T00:00:00Z" }], nextCursor: null });
    await older;
    expect(page.data.items.map((item: { id: string }) => item.id)).toEqual(["fresh"]);
  });
});
