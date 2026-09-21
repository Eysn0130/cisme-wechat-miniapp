import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

const driver = vi.hoisted(() => ({ channel: undefined as any, configs: [] as any[] }));
vi.mock("pg", () => ({ default: { Client: class {
  connection = driver.channel;
  constructor(config: unknown) { driver.configs.push(config); }
} } }));
import { requestPgCancellation } from "../../services/api/src/pgCancellation";

function setup(ssl: any = false, sslNegotiation = "postgres") {
  const channel = Object.assign(new EventEmitter(), {
    stream: { destroy: vi.fn() }, connect: vi.fn(), requestSsl: vi.fn(), cancel: vi.fn()
  });
  driver.channel = channel; driver.configs = [];
  const active = {};
  const target = { _getActiveQuery: vi.fn(() => active), host: "localhost", port: 55432,
    processID: 1234, secretKey: 5678, ssl, sslNegotiation } as unknown as pg.PoolClient;
  return { channel, target };
}
describe("locked pg cancellation transport", () => {
  it("sends one CancelRequest, then waits for channel closure without releasing the original lease", async () => {
    const { channel, target } = setup();
    let done = false;
    const promise = requestPgCancellation(target).then(() => { done = true; });
    channel.emit("connect"); await Promise.resolve();
    expect(channel.cancel).toHaveBeenCalledWith(1234, 5678); expect(done).toBe(false);
    channel.emit("end"); await promise;
    expect(channel.stream.destroy).toHaveBeenCalledOnce();
  });
  it("keeps CA validation and the non-enumerable mTLS key; never sends the secret before TLS", async () => {
    const ssl = Object.defineProperty({ ca: "synthetic-ca", rejectUnauthorized: true }, "key", { value: "synthetic-key" });
    const { channel, target } = setup(ssl);
    const promise = requestPgCancellation(target);
    channel.emit("connect");
    expect(channel.requestSsl).toHaveBeenCalledOnce(); expect(channel.cancel).not.toHaveBeenCalled();
    expect(driver.configs[0].ssl).toBe(ssl); expect(driver.configs[0].ssl.key).toBe("synthetic-key");
    channel.emit("sslconnect"); expect(channel.cancel).toHaveBeenCalledOnce();
    channel.emit("end"); await promise;
  });
  it("does not downgrade direct TLS or send a second SSLRequest", async () => {
    const { channel, target } = setup(true, "direct"); const promise = requestPgCancellation(target);
    channel.emit("connect"); expect(channel.requestSsl).not.toHaveBeenCalled(); expect(channel.cancel).not.toHaveBeenCalled();
    channel.emit("sslconnect"); expect(channel.cancel).toHaveBeenCalledOnce(); channel.emit("end"); await promise;
  });
  it("suppresses a late cancellation when the original query has already completed", async () => {
    const { channel, target } = setup(); const promise = requestPgCancellation(target);
    (target as any)._getActiveQuery.mockReturnValue(null);
    channel.emit("connect"); await promise; expect(channel.cancel).not.toHaveBeenCalled();
  });
  it.each(["error", "errorMessage"])("bounds %s transport failure without claiming SQL cancellation", async event => {
    const { channel, target } = setup(); const promise = requestPgCancellation(target);
    channel.emit(event, new Error("synthetic transport failure")); await promise;
    expect(channel.stream.destroy).toHaveBeenCalledOnce();
  });
  it("bounds a silent cancel channel", async () => {
    const { channel, target } = setup(); await requestPgCancellation(target, 10);
    expect(channel.stream.destroy).toHaveBeenCalledOnce();
  });
  it("does not open a transport for an idle or unsupported client", async () => {
    const { channel, target } = setup(); (target as any)._getActiveQuery.mockReturnValue(null);
    await requestPgCancellation(target); await requestPgCancellation({} as pg.PoolClient);
    expect(channel.connect).not.toHaveBeenCalled(); expect(driver.configs).toHaveLength(0);
  });
});
