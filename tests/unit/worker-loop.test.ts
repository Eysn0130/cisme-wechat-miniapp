import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorkerLoop } from "../../services/worker/src/loop";
afterEach(() => vi.useRealTimers());
describe("background worker lifetime", () => {
  it("does not overlap long jobs and drains the current job on shutdown", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const worker = startWorkerLoop(run, vi.fn());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    let stopped = false;
    const shutdown = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await shutdown;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports a failed tick and continues processing subsequent jobs", async () => {
    vi.useFakeTimers();
    const error = new Error("temporary database failure");
    const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const onError = vi.fn();
    const worker = startWorkerLoop(run, onError);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(onError).toHaveBeenCalledWith(error);
    expect(run).toHaveBeenCalledTimes(2);
    await worker.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("drains a full batch immediately before returning to the idle interval", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const worker = startWorkerLoop(run, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);
    await worker.stop();
  });
});
