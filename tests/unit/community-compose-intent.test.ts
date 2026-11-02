import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
let api:typeof import("../../apps/miniprogram/services/community-compose-intent"),wxMock:any,nonce:number;
const scope={sessionToken:"synthetic-session-a",revision:3};
const payload={source:"album" as const,files:[{path:"/synthetic/image.jpg",size:100}]};
beforeEach(async()=>{vi.resetModules();vi.useFakeTimers();vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));nonce=0;
  wxMock={getRandomValues:vi.fn(({length,success}:any)=>success({randomValues:new Uint8Array(length).fill(++nonce).buffer})),getStorageSync:vi.fn(),setStorageSync:vi.fn(),removeStorageSync:vi.fn()};
  (globalThis as any).wx=wxMock;api=await import("../../apps/miniprogram/services/community-compose-intent");});
afterEach(()=>vi.useRealTimers());
describe("single-use native compose media intents",()=>{
  it("uses secure random bytes and delivers copied local metadata once without storage",async()=>{
    const original=structuredClone(payload),id=await api.createComposeMediaIntent(original,scope);original.files[0]!.path="/mutated.jpg";
    expect(id).toMatch(/^mi_[0-9a-f]{48}$/);expect(id).not.toContain(scope.sessionToken);expect(wxMock.getRandomValues).toHaveBeenCalledWith(expect.objectContaining({length:24}));
    expect(api.consumeComposeMediaIntent(id,scope)).toEqual(payload);expect(api.consumeComposeMediaIntent(id,scope)).toBeNull();
    expect(wxMock.getStorageSync).not.toHaveBeenCalled();expect(wxMock.setStorageSync).not.toHaveBeenCalled();expect(wxMock.removeStorageSync).not.toHaveBeenCalled();
  });
  it.each([{sessionToken:"synthetic-session-b",revision:3},{sessionToken:scope.sessionToken,revision:4}])("rejects and consumes a mismatched account or environment scope %j",async other=>{
    const id=await api.createComposeMediaIntent(payload,scope);expect(api.consumeComposeMediaIntent(id,other)).toBeNull();expect(api.consumeComposeMediaIntent(id,scope)).toBeNull();
  });
  it("expires after two minutes and rejects a backwards clock",async()=>{
    const id=await api.createComposeMediaIntent(payload,scope);vi.advanceTimersByTime(120_000);expect(api.consumeComposeMediaIntent(id,scope)).toBeNull();
    const second=await api.createComposeMediaIntent(payload,scope);vi.setSystemTime(Date.now()-1);expect(api.consumeComposeMediaIntent(second,scope)).toBeNull();
  });
  it("revokes a superseded selection and supports exact navigation-failure discard",async()=>{
    const first=await api.createComposeMediaIntent(payload,scope),second=await api.createComposeMediaIntent({...payload,source:"camera"},scope);
    expect(api.consumeComposeMediaIntent(first,scope)).toBeNull();api.discardComposeMediaIntent(second);expect(api.consumeComposeMediaIntent(second,scope)).toBeNull();
  });
  it("does not repopulate memory from a secure-random callback after cancellation",async()=>{
    let complete!:(value:any)=>void;wxMock.getRandomValues.mockImplementation(({success}:any)=>{complete=success;});
    const creating=api.createComposeMediaIntent(payload,scope);api.revokeComposeMediaIntents();complete({randomValues:new Uint8Array(24).fill(8).buffer});
    await expect(creating).rejects.toMatchObject({code:"COMPOSE_MEDIA_INTENT_UNAVAILABLE"});expect(api.consumeComposeMediaIntent("mi_"+"08".repeat(24),scope)).toBeNull();
  });
  it("binds the original payload and scope before awaiting secure random",async()=>{
    let complete!:(value:any)=>void;wxMock.getRandomValues.mockImplementation(({success}:any)=>{complete=success;});
    const selected=structuredClone(payload),owner={...scope},creating=api.createComposeMediaIntent(selected,owner);
    selected.files[0]!.path="/changed.jpg";owner.sessionToken="changed-session";owner.revision=9;
    complete({randomValues:new Uint8Array(24).fill(7).buffer});const id=await creating;expect(api.consumeComposeMediaIntent(id,scope)).toEqual(payload);
  });
  it("has no weak-random fallback when secure random is unavailable",async()=>{
    wxMock.getRandomValues=undefined;await expect(api.createComposeMediaIntent(payload,scope)).rejects.toMatchObject({code:"COMPOSE_MEDIA_INTENT_UNAVAILABLE"});
  });
  it.each([{source:"album",files:[{path:"https://foreign.invalid/image.jpg",size:100}]},{source:"camera",files:[...payload.files,...payload.files]},
    {source:"album",files:[{path:"/synthetic/image.jpg",size:10*1024*1024+1}]}])("rejects invalid local media metadata",async value=>{
    await expect(api.createComposeMediaIntent(value as any,scope)).rejects.toMatchObject({code:"COMPOSE_MEDIA_INTENT_UNAVAILABLE"});expect(wxMock.getRandomValues).not.toHaveBeenCalled();
  });
});
