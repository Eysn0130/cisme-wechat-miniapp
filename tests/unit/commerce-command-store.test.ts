import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMMERCE_COMMAND_STORAGE, readCommerceCommands, putCommerceCommand, forgetCommerceCommand,
  redactCommerceCommandPayloads, normalizeCommandPayload, type StoredCommerceCommand } from "../../apps/miniprogram/services/commerce-command-store";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", order = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const record = (patch: Partial<StoredCommerceCommand> = {}): StoredCommerceCommand => ({ version: 1, ownerId: owner,
  environment: '["https://synthetic.invalid",null]', kind: "refund", objectId: order, key: "synthetic-refund-1",
  payload: { amountCents: 123, reason: "仅合成测试理由" }, createdAt: 100, dispatched: false, ...patch });
let raw: unknown;
beforeEach(() => {
  raw = undefined;
  (globalThis as any).wx = { getStorageSync: vi.fn(() => structuredClone(raw)),
    setStorageSync: vi.fn((_key: string, value: unknown) => { raw = structuredClone(value); }) };
});
describe("bounded immutable commerce command recovery storage", () => {
  it("round-trips only the normalized original payload without retaining object references", () => {
    const source = record(); putCommerceCommand(source); source.payload!.amountCents = 999;
    expect(readCommerceCommands()).toEqual([record()]);
    const read = readCommerceCommands(); read[0]!.payload!.reason = "changed";
    expect(readCommerceCommands()[0]!.payload!.reason).toBe("仅合成测试理由");
    expect((globalThis as any).wx.setStorageSync.mock.calls[0][0]).toBe(COMMERCE_COMMAND_STORAGE);
  });
  it.each(["key", "kind", "object", "amount", "reason"])("refuses replacement of an unresolved %s", field => {
    putCommerceCommand(record());
    const changed = field === "key" ? { key: "synthetic-new-key" } : field === "kind" ? { kind: "cancel" as const, payload: { expectedVersion: 1, reason: "合成理由" } } :
      field === "object" ? { objectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", kind: "settlement" as const } :
      { payload: { ...record().payload!, [field === "amount" ? "amountCents" : "reason"]: field === "amount" ? 999 : "另一合成理由" } };
    expect(() => putCommerceCommand(record(changed))).toThrow(); expect(readCommerceCommands()).toEqual([record()]);
  });
  it("allows different order slots and accounts, never deletes a different owner's same key", () => {
    putCommerceCommand(record()); const second = record({ ownerId: order }); putCommerceCommand(second);
    forgetCommerceCommand(record()); expect(readCommerceCommands()).toEqual([second]);
  });
  it("a dispatched record cannot be changed back to definitely unsent", () => {
    putCommerceCommand(record({ dispatched: true }));
    expect(() => putCommerceCommand(record())).toThrow(); expect(readCommerceCommands()[0]!.dispatched).toBe(true);
  });
  it("commission kinds share a slot so an unresolved conversion blocks a new settlement", () => {
    putCommerceCommand(record({ kind: "credit", objectId: null, payload: { amountCents: 100, confirmed: true, taxPolicyVersion: "isolated-synthetic-zero-withholding-v1" } }));
    expect(() => putCommerceCommand(record({ kind: "settlement", objectId: null, payload: { amountCents: 100, reason: "合成结算依据" } }))).toThrow();
  });
  it.each(["garbage", [], { version: 2, commands: [] }, { version: 1, commands: [{}] },
    { version: 1, commands: [record(), record()] }, { version: 1, commands: [record({ payload: { amountCents: 100, reason: " ok " } })] }])(
    "does not silently erase corrupted, unnormalized or unsupported persisted data %#", value => {
      raw = value; expect(() => readCommerceCommands()).toThrow(); expect(raw).toEqual(value);
      expect((globalThis as any).wx.setStorageSync).not.toHaveBeenCalled();
    });
  it.each(["read", "write", "silent-drop", "modified-readback"])("fails closed on storage %s failure", mode => {
    const wx = (globalThis as any).wx;
    if (mode === "read") wx.getStorageSync.mockImplementation(() => { throw Error("synthetic"); });
    if (mode === "write") wx.setStorageSync.mockImplementation(() => { throw Error("synthetic"); });
    if (mode === "silent-drop") wx.setStorageSync.mockImplementation(() => {});
    if (mode === "modified-readback") wx.setStorageSync.mockImplementation(() => { raw = { version: 1, commands: [] }; });
    expect(() => putCommerceCommand(record())).toThrow();
  });
  it("never evicts unknown operations when capacity is reached", () => {
    for (let i = 0; i < 16; i++) putCommerceCommand(record({ ownerId: `${String(i).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa` }));
    const before = structuredClone(raw); expect(() => putCommerceCommand(record())).toThrow(); expect(raw).toEqual(before);
  });
  it("retains unknown operation hints beyond a client timeout or TTL, redacts free text on logout", () => {
    putCommerceCommand(record({ createdAt: 1, dispatched: true })); redactCommerceCommandPayloads();
    const rows = readCommerceCommands(); expect(rows).toEqual([record({ createdAt: 1, dispatched: true, payload: null })]);
    expect(JSON.stringify(raw)).not.toContain("仅合成测试理由"); expect(JSON.stringify(raw)).not.toContain("amountCents");
    expect(() => putCommerceCommand(record({ dispatched: true }))).toThrow();
  });
  it.each([{ amountCents: 1.5, reason: "合成理由" }, { amountCents: Number.MAX_SAFE_INTEGER + 1, reason: "合成理由" },
    { amountCents: 100, reason: "合成理由", token: "not-a-real-token" }, { amountCents: 100, reason: "合成理由", requestPayment: {} }])(
    "rejects malformed amounts and extra sensitive fields %#", value => {
      expect(() => normalizeCommandPayload("refund", value)).toThrow();
    });
});
