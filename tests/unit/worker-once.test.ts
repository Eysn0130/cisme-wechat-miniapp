import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  end: vi.fn(), ensureReady: vi.fn(), cycle: vi.fn(),
}));
vi.mock("@cisme/config", async (original) => ({ ...await original<typeof import('@cisme/config')>(), loadConfig: () => ({ databaseUrl: "test", ugcGoLiveGate: false }) }));
vi.mock("../../services/api/src/db.js", () => ({ createPool: () => ({ end: fake.end }) }));
vi.mock("../../services/api/src/storage.js", () => ({ createObjectStorage: () => ({ ensureReady: fake.ensureReady }) }));
vi.mock("../../services/worker/src/jobs.js", () => ({ runWorkerCycle: fake.cycle }));
import { runOnce } from "../../services/worker/src/once.js";
beforeEach(() => { vi.resetAllMocks(); });
afterEach(()=>vi.unstubAllEnvs());
it('does not initialize storage or execute scheduled work during migration maintenance',async()=>{
  vi.stubEnv('CISME_MIGRATION_READ_ONLY','true');
  await expect(runOnce()).resolves.toEqual({maintenance:true,workExecuted:false});
  expect(fake.ensureReady).not.toHaveBeenCalled();expect(fake.cycle).not.toHaveBeenCalled();expect(fake.end).not.toHaveBeenCalled();
});
it('rejects a malformed migration fence before any scheduled side effect',async()=>{
  vi.stubEnv('CISME_MIGRATION_READ_ONLY','1');
  await expect(runOnce()).rejects.toThrow('CONFIG_INVALID:CISME_MIGRATION_READ_ONLY');
  expect(fake.ensureReady).not.toHaveBeenCalled();expect(fake.cycle).not.toHaveBeenCalled();
});
it("waits for the scheduled work before closing connections", async () => {
  let finish!: (value: { published: number; cleaned: number }) => void;
  fake.cycle.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const pending = runOnce();
  await vi.waitFor(() => expect(fake.cycle).toHaveBeenCalledOnce());
  expect(fake.end).not.toHaveBeenCalled();
  finish({ published: 1, cleaned: 2 });
  await expect(pending).resolves.toEqual({ published: 1, cleaned: 2 });
  expect(fake.end).toHaveBeenCalledOnce();
});
it.each(["storage", "cycle"])("releases connections and preserves a %s failure", async (stage) => {
  const error = new Error("scheduled work failed");
  (stage === "storage" ? fake.ensureReady : fake.cycle).mockRejectedValueOnce(error);
  await expect(runOnce()).rejects.toBe(error);
  expect(fake.end).toHaveBeenCalledOnce();
  if (stage === "storage") expect(fake.cycle).not.toHaveBeenCalled();
});
