import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn(), token: "session-a", member: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", base: "https://synthetic.invalid" }));
vi.mock("../../apps/miniprogram/services/api", () => ({ request: mocks.request }));
import { executeCommerceCommand, retryCommerceCommand, readCommerceRecovery, acknowledgeCommerceCommand, type RecoveryScope } from "../../apps/miniprogram/services/commerce-command-recovery";
import { readCommerceCommands, redactCommerceCommandPayloads, invalidateCommerceRecoveryContext, type CommerceCommandKind, type CommandPayload } from "../../apps/miniprogram/services/commerce-command-store";
const memberA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", memberB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const object = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", recordId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const kinds: CommerceCommandKind[] = ["refund", "settlement", "credit", "credit-cancel", "cancel", "cancel-verified"];
const payload = (kind: CommerceCommandKind): CommandPayload => kind === "credit" ? { amountCents: 123, confirmed: true, taxPolicyVersion: "isolated-synthetic-zero-withholding-v1" } :
  kind === "credit-cancel" ? {} : kind.startsWith("cancel") ? { expectedVersion: 2, reason: "合成取消理由" } : { amountCents: 123, reason: "合成申请依据" };
const input = (kind: CommerceCommandKind, key = `synthetic-${kind}-one`) => ({ kind, key, ...(["credit", "settlement"].includes(kind) ? {} : {objectId: object}), payload: payload(kind) });
const scope = (kind: CommerceCommandKind): RecoveryScope => ["credit", "credit-cancel", "settlement"].includes(kind) ? { group: "commission" } : { group: "order", objectId: object };
function facts(kind: CommerceCommandKind) { return ["cancel", "cancel-verified", "credit-cancel"].includes(kind) ? { id: object, state: "cancelled", status: "cancelled" } :
  { id: recordId, state: kind === "credit" ? "available" : "requested", amountCents: 123, ...(kind === "refund" ? { orderId: object } : {}) }; }
const writes = () => mocks.request.mock.calls.map(([o]) => o).filter(o => o.method === "POST");
const deferred = <T = any>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const flush = async () => { for(let i=0;i<30;i++) await Promise.resolve(); };
let raw: unknown, recorded: boolean, response: unknown;
beforeEach(() => {
  mocks.request.mockReset(); mocks.token = "session-a"; mocks.member = memberA; mocks.base = "https://synthetic.invalid";
  raw = undefined; recorded = false; response = undefined; invalidateCommerceRecoveryContext();
  (globalThis as any).getApp = () => ({ globalData: { sessionToken: mocks.token, apiBaseUrl: mocks.base, cloudFunction: null } });
  (globalThis as any).wx = { getStorageSync: vi.fn(() => structuredClone(raw)),
    setStorageSync: vi.fn((_key: string, value: unknown) => { raw = structuredClone(value); }) };
  mocks.request.mockImplementation(async o => {
    if(o.path === "/v1/me/profile") return { id: mocks.member };
    if(o.path.includes("/command-receipts/")) {
      const kind = o.path.split("/").pop().split("?")[0] as CommerceCommandKind;
      return { version: 1, memberId: mocks.member, kind, status: recorded ? "recorded" : "not_observed", record: recorded ? facts(kind) : null };
    }
    if(o.method === "POST") { if(response !== undefined) return response; throw {code:"REQUEST_DEADLINE",title:"合成结果未知"}; }
    throw Error(`Unexpected synthetic request ${o.path}`);
  });
});
describe.each(kinds)("durable recovery service: %s", kind => {
  it("persists the send boundary before dispatch and queries before a same-payload same-key retry", async () => {
    const original = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async o => { if(o.method === "POST") expect(readCommerceCommands()[0]).toMatchObject({key: input(kind).key, dispatched: true, payload: payload(kind)}); return original(o); });
    await expect(executeCommerceCommand(input(kind), () => true)).rejects.toBeTruthy();
    await expect(executeCommerceCommand(input(kind, "synthetic-other-key"), () => true)).rejects.toBeTruthy();
    expect(writes()).toHaveLength(2); expect(writes()[0]).toMatchObject({idempotencyKey: input(kind).key, data: payload(kind)});
    expect(writes()[1]).toMatchObject({idempotencyKey: input(kind).key, data: payload(kind)});
    const calls = mocks.request.mock.calls.map(([o]) => o);
    expect(calls.findIndex(o => o.path.includes("command-receipts"))).toBeLessThan(calls.lastIndexOf(writes()[1]));
    expect(calls.filter(o => o.path.includes("command-receipts")).every(o => !o.path.includes(input(kind).key) && o.idempotencyKey === input(kind).key)).toBe(true);
  });
  it("an authoritative receipt recovers success without dispatch, including after the original client TTL", async () => {
    await expect(executeCommerceCommand(input(kind), () => true)).rejects.toBeTruthy(); recorded = true;
    const result = await executeCommerceCommand(input(kind, "synthetic-new-client-key"), () => true);
    expect(result.recovered).toBe(true); expect(writes()).toHaveLength(1); expect(readCommerceCommands()).toEqual([]);
  });
  it("an explicit recovery uses original payload and key, not current edited form values", async () => {
    await expect(executeCommerceCommand(input(kind), () => true)).rejects.toBeTruthy(); response = facts(kind);
    await retryCommerceCommand(input(kind).key, scope(kind), () => true);
    expect(writes()).toHaveLength(2); expect(writes()[1]).toMatchObject({idempotencyKey: input(kind).key, data: payload(kind)});
    expect(readCommerceCommands()).toEqual([]);
  });
  it("page reads keep completed receipts visible until explicitly acknowledged", async () => {
    await expect(executeCommerceCommand(input(kind), () => true)).rejects.toBeTruthy(); recorded = true;
    const rows = await readCommerceRecovery({}, scope(kind), () => true);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({key: input(kind).key, recorded: true, retryable: false});
    expect(readCommerceCommands()).toHaveLength(1); expect(writes()).toHaveLength(1);
    await acknowledgeCommerceCommand(input(kind).key, scope(kind), () => true);
    expect(readCommerceCommands()).toEqual([]); expect(writes()).toHaveLength(1);
  });
  it("does not dismiss not_observed or treat it as a definitive failure", async () => {
    await expect(executeCommerceCommand(input(kind), () => true)).rejects.toBeTruthy();
    await expect(acknowledgeCommerceCommand(input(kind).key, scope(kind), () => true)).rejects.toBeTruthy();
    expect(readCommerceCommands()).toHaveLength(1); expect(writes()).toHaveLength(1);
  });
  it("does not clear the original record on a successful but incomplete HTTP response", async () => {
    response = {status:"ok"}; await expect(executeCommerceCommand(input(kind), () => true)).rejects.toBeTruthy();
    expect(readCommerceCommands()).toHaveLength(1);
  });
});
it.each(["refund","settlement","credit"] as const)("does not silently replay an edited %s amount", async kind => {
  await expect(executeCommerceCommand(input(kind), () => true)).rejects.toBeTruthy();
  await expect(executeCommerceCommand({...input(kind),payload:{...payload(kind),amountCents:999}}, () => true)).rejects.toBeTruthy();
  expect(writes()).toHaveLength(1); expect(readCommerceCommands()[0]!.payload!.amountCents).toBe(123);
});
it("blocks a settlement while a credit command consuming the same assets is unresolved", async () => {
  await expect(executeCommerceCommand(input("credit"), () => true)).rejects.toBeTruthy();
  await expect(executeCommerceCommand(input("settlement"), () => true)).rejects.toBeTruthy(); expect(writes()).toHaveLength(1);
});
it.each(["read", "write", "readback"])("does not dispatch when storage %s fails", async mode => {
  const wx = (globalThis as any).wx;
  if(mode === "read") wx.getStorageSync.mockImplementation(() => {throw Error("synthetic");});
  if(mode === "write") wx.setStorageSync.mockImplementation(() => {throw Error("synthetic");});
  if(mode === "readback") wx.setStorageSync.mockImplementation(() => {});
  await expect(executeCommerceCommand(input("refund"), () => true)).rejects.toBeTruthy(); expect(writes()).toHaveLength(0);
});
it("only one dispatch is in flight across two simultaneous page instances", async () => {
  const pending = deferred(), original = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(o => o.method === "POST" ? pending.promise : original(o));
  const first = executeCommerceCommand(input("refund"), () => true); await flush();
  await expect(executeCommerceCommand(input("refund"), () => true)).rejects.toBeTruthy();
  expect(writes()).toHaveLength(1); pending.resolve(facts("refund")); await first;
});
it("a late response for A retires only A's hint and never B's same-key operation", async () => {
  const pending = deferred(), original = mocks.request.getMockImplementation()!; let n = 0;
  mocks.request.mockImplementation(o => o.method === "POST" && ++n === 1 ? pending.promise : original(o));
  const first = executeCommerceCommand(input("refund"), () => true); await flush();
  mocks.token = "session-b"; mocks.member = memberB; invalidateCommerceRecoveryContext();
  await expect(executeCommerceCommand(input("refund"), () => true)).rejects.toBeTruthy();
  pending.resolve(facts("refund")); await expect(first).rejects.toBeTruthy();
  expect(readCommerceCommands()).toHaveLength(1); expect(readCommerceCommands()[0]!.ownerId).toBe(memberB);
});
it("does not query, show or acknowledge another account's pending commands", async () => {
  await expect(executeCommerceCommand(input("refund"), () => true)).rejects.toBeTruthy();
  mocks.token = "session-b"; mocks.member = memberB; invalidateCommerceRecoveryContext();
  const before = mocks.request.mock.calls.length;
  expect(await readCommerceRecovery({}, scope("refund"), () => true)).toEqual([]);
  expect(mocks.request.mock.calls.slice(before).some(([o]) => o.path.includes("command-receipts"))).toBe(false);
  await expect(acknowledgeCommerceCommand(input("refund").key, scope("refund"), () => true)).rejects.toBeTruthy();
  expect(readCommerceCommands()[0]!.ownerId).toBe(memberA);
});
it.each(["session", "environment", "hidden", "ABA"])("does not dispatch after %s changes during the ownership read", async kind => {
  const pending = deferred(); let visible = true; mocks.request.mockReturnValue(pending.promise);
  const result = executeCommerceCommand(input("refund"), () => visible); await flush();
  if(kind === "session") mocks.token = "session-b";
  if(kind === "environment") mocks.base = "https://other-synthetic.invalid";
  if(kind === "hidden") visible = false;
  if(kind === "ABA") { mocks.token = "session-b"; invalidateCommerceRecoveryContext(); mocks.token = "session-a"; invalidateCommerceRecoveryContext(); }
  pending.resolve({id:memberA}); await expect(result).rejects.toBeTruthy(); expect(writes()).toHaveLength(0); expect(raw).toBeUndefined();
});
it("logout-redacted hints can be queried but cannot be silently reconstructed or replayed", async () => {
  await expect(executeCommerceCommand(input("refund"), () => true)).rejects.toBeTruthy(); redactCommerceCommandPayloads(); invalidateCommerceRecoveryContext();
  expect(await readCommerceRecovery({}, scope("refund"), () => true)).toMatchObject([{retryable:false,recorded:false}]);
  await expect(retryCommerceCommand(input("refund").key, scope("refund"), () => true)).rejects.toBeTruthy();
  await expect(executeCommerceCommand(input("refund"), () => true)).rejects.toBeTruthy(); expect(writes()).toHaveLength(1);
  recorded = true; await acknowledgeCommerceCommand(input("refund").key, scope("refund"), () => true); expect(readCommerceCommands()).toEqual([]);
});
it.each(["member", "kind", "object", "amount", "version", "shape"])("rejects a mismatched %s receipt without clearing or replaying", async field => {
  await expect(executeCommerceCommand(input("refund"), () => true)).rejects.toBeTruthy();
  const value:any = {version:1,memberId:memberA,kind:"refund",status:"recorded",record:facts("refund")};
  if(field === "member") value.memberId = memberB;
  if(field === "kind") value.kind = "settlement";
  if(field === "object") value.record.orderId = memberB;
  if(field === "amount") value.record.amountCents = 999;
  if(field === "version") value.version = 2;
  if(field === "shape") value.record = null;
  const original=mocks.request.getMockImplementation()!; mocks.request.mockImplementation(o => o.path.includes("command-receipts") ? Promise.resolve(value) : original(o));
  await expect(retryCommerceCommand(input("refund").key, scope("refund"), () => true)).rejects.toBeTruthy();
  expect(writes()).toHaveLength(1); expect(readCommerceCommands()).toHaveLength(1);
});
