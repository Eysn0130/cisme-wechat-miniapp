import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorkerLoop } from "../../services/worker/src/loop";
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("background worker lifetime", () => {
  it("admits no new background work while migration read-only mode is active", async () => {
    vi.useFakeTimers(); vi.stubEnv('CISME_MIGRATION_READ_ONLY','true');
    const run=vi.fn().mockResolvedValue(false), onError=vi.fn();
    const worker=startWorkerLoop(run,onError);
    await vi.advanceTimersByTimeAsync(6_001);
    expect(run).not.toHaveBeenCalled();expect(onError).not.toHaveBeenCalled();
    vi.stubEnv('CISME_MIGRATION_READ_ONLY','false');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledOnce();await worker.stop();
  });
  it('drains admitted work without starting another batch after the fence closes',async()=>{
    vi.useFakeTimers();vi.stubEnv('CISME_MIGRATION_READ_ONLY','false');
    let finish!:(value:boolean)=>void;
    const run=vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
    const worker=startWorkerLoop(run,vi.fn());
    await vi.advanceTimersByTimeAsync(1);
    vi.stubEnv('CISME_MIGRATION_READ_ONLY','true');
    finish(true);await vi.advanceTimersByTimeAsync(6_000);
    expect(run).toHaveBeenCalledOnce();await worker.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports a malformed fence and admits no work',async()=>{
    vi.useFakeTimers();vi.stubEnv('CISME_MIGRATION_READ_ONLY','TRUE');
    const run=vi.fn(),onError=vi.fn(),worker=startWorkerLoop(run,onError);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(new Error('CONFIG_INVALID:CISME_MIGRATION_READ_ONLY'));
    await worker.stop();
  });
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
