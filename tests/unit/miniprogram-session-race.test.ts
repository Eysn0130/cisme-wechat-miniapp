import { beforeEach, describe, expect, it, vi } from "vitest";

let state: { globalData: { apiBaseUrl: string; sessionToken: string; privacyRightsToken?: string } };
let wxMock: { request: ReturnType<typeof vi.fn>; navigateTo: ReturnType<typeof vi.fn>; setStorageSync: ReturnType<typeof vi.fn>; removeStorageSync: ReturnType<typeof vi.fn> };
let taskAbort: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  state = { globalData: { apiBaseUrl: "https://example.test", sessionToken: "old-session" } };
  taskAbort = vi.fn();
  wxMock = { request: vi.fn(() => ({ abort: taskAbort })), navigateTo: vi.fn(), setStorageSync: vi.fn(), removeStorageSync: vi.fn() };
  Object.assign(globalThis, { wx: wxMock, getApp: () => state, getCurrentPages: () => [{ route: "pages/records/index" }] });
});

it('keeps closed-account rights separate from member routes and rejects a stale rights response',async()=>{
  const api=await vi.importActual<any>('../../apps/miniprogram/services/api');
  api.setPrivacyRightsToken('rights-a');
  expect(state.globalData.sessionToken).toBe('');
  const rights=api.request({path:'/v1/me/privacy-requests?page=1'});
  const member=api.request({path:'/v1/me',authMode:'optional'});
  expect(wxMock.request.mock.calls[0]![0].header.Authorization).toBe('Bearer rights-a');
  expect(wxMock.request.mock.calls[1]![0].header.Authorization).toBe('');
  wxMock.request.mock.calls[1]![0].success({statusCode:200,data:{guest:true}});
  await expect(member).resolves.toEqual({guest:true});
  api.setPrivacyRightsToken('rights-b');
  const current=api.request({path:'/v1/me/privacy-requests?page=1'});
  expect(wxMock.request).toHaveBeenCalledTimes(3);
  expect(wxMock.request.mock.calls[2]![0].header.Authorization).toBe('Bearer rights-b');
  wxMock.request.mock.calls[0]![0].success({statusCode:200,data:{items:[{id:'old-account'}]}});
  await expect(rights).rejects.toMatchObject({code:'REQUEST_SESSION_CHANGED'});
  wxMock.request.mock.calls[2]![0].success({statusCode:200,data:{items:[{id:'current-account'}]}});
  await expect(current).resolves.toEqual({items:[{id:'current-account'}]});
});

describe("native delayed authentication responses", () => {
  it("keeps a renewed session when an old authenticated request fails", async () => {
    const api = await vi.importActual<any>("../../apps/miniprogram/services/api");
    const result = api.request({ path: "/v1/me" }).catch((error: unknown) => error);
    expect(wxMock.request.mock.calls[0]![0].timeout).toBeLessThanOrEqual(12_000);
    expect(wxMock.request.mock.calls[0]![0].timeout).toBeGreaterThan(11_900);
    api.setSessionToken("new-session");
    wxMock.request.mock.calls[0]![0].success({ statusCode: 401, data: { code: "SESSION_EXPIRED" } });
    await result;
    expect(state.globalData.sessionToken).toBe("new-session");
    expect(wxMock.navigateTo).not.toHaveBeenCalled();
  });

  it("does not invalidate a session for a public request without a bearer token", async () => {
    const api = await vi.importActual<any>("../../apps/miniprogram/services/api");
    const result = api.request({ path: "/v1/catalog", authMode: "public" }).catch((error: unknown) => error);
    expect(wxMock.request.mock.calls[0]![0].header.Authorization).toBe("");
    wxMock.request.mock.calls[0]![0].success({ statusCode: 401, data: { code: "AUTH_REQUIRED" } });
    await result;
    expect(state.globalData.sessionToken).toBe("old-session");
  });

  it("clears a rejected current session and requests authentication once", async () => {
    const api = await vi.importActual<any>("../../apps/miniprogram/services/api");
    const results = [api.request({ path: "/v1/me" }), api.request({ path: "/v1/me/consents" })].map((promise) => promise.catch((error: unknown) => error));
    for (const [request] of wxMock.request.mock.calls) request.success({ statusCode: 401, data: { code: "SESSION_EXPIRED" } });
    await Promise.all(results);
    expect(state.globalData.sessionToken).toBe("");
    expect(wxMock.navigateTo).toHaveBeenCalledTimes(1);
  });
  it("clears a revoked account session without reopening a login loop", async () => {
    const api=await vi.importActual<any>("../../apps/miniprogram/services/api");
    const result=api.request({path:"/v1/me"});
    wxMock.request.mock.calls[0]![0].success({statusCode:401,data:{code:"AUTH_REVOKED"}});
    await expect(result).rejects.toMatchObject({code:"AUTH_REVOKED"});
    expect(state.globalData.sessionToken).toBe("");
    expect(wxMock.navigateTo).not.toHaveBeenCalled();
  });
  it("keeps the operator session when a target member is unavailable", async () => {
    const api=await vi.importActual<any>("../../apps/miniprogram/services/api");
    const result=api.request({path:"/v1/management/members/target/membership",method:"POST",data:{state:"active"}});
    wxMock.request.mock.calls[0]![0].success({statusCode:409,data:{code:"MEMBER_NOT_ACTIVE"}});
    await expect(result).rejects.toMatchObject({code:"MEMBER_NOT_ACTIVE"});
    expect(state.globalData.sessionToken).toBe("old-session");
  });
});

it('rejects old successful member data after an account switch',async()=>{
 const api=await vi.importActual<any>('../../apps/miniprogram/services/api');
 const result=api.request({path:'/v1/me'}).catch((e:unknown)=>e);
 api.setSessionToken('new-member');
 wxMock.request.mock.calls[0]![0].success({statusCode:200,data:{id:'old-member'}});
 expect(await result).toMatchObject({code:'REQUEST_SESSION_CHANGED'});
});
it('sends guests to login and keeps the original destination',async()=>{
 state.globalData.sessionToken='';
 const api=await vi.importActual<any>('../../apps/miniprogram/services/api');
 expect(api.requireMemberAccess('/pages/home/index')).toBe(false);
 expect(wxMock.setStorageSync).toHaveBeenCalledWith('cisme.authReturnUrl','/pages/home/index');
 expect(wxMock.navigateTo).toHaveBeenCalledTimes(1);
 expect(wxMock.request).not.toHaveBeenCalled();
});
it('honours an explicit Account return until the member asks to authenticate again',async()=>{
 state.globalData.sessionToken='';
 const api=await vi.importActual<any>('../../apps/miniprogram/services/api');
 api.suppressAuthenticationRedirectOnce('/pages/records/index?from=tab');
 expect(api.requireMemberAccess('/pages/records/index')).toBe(false);
 expect(wxMock.navigateTo).not.toHaveBeenCalled();
 expect(wxMock.setStorageSync).not.toHaveBeenCalled();
 api.resumeAuthentication('/pages/records/index');
 expect(wxMock.setStorageSync).toHaveBeenCalledWith('cisme.authReturnUrl','/pages/records/index');
 expect(wxMock.navigateTo).toHaveBeenCalledTimes(1);
});

it('retries a standard WeChat request:fail error once for an idempotent read',async()=>{
 vi.useFakeTimers();
 try {
  const api=await vi.importActual<any>('../../apps/miniprogram/services/api');
  const result=api.request({path:'/v1/catalog',authMode:'public'});
  wxMock.request.mock.calls[0]![0].fail({errMsg:'request:fail timeout'});
  await vi.advanceTimersByTimeAsync(121);
  expect(wxMock.request).toHaveBeenCalledTimes(2);
  wxMock.request.mock.calls[1]![0].success({statusCode:200,data:{items:[]}});
  await expect(result).resolves.toEqual({items:[]});
 } finally { vi.useRealTimers(); }
});

it('backs off once for an essential 429 read without clearing identity',async()=>{
 vi.useFakeTimers();
 try {
  const api=await vi.importActual<any>('../../apps/miniprogram/services/api');
  const result=api.request({path:'/v1/me'});
  wxMock.request.mock.calls[0]![0].success({statusCode:429,data:{code:'RATE_LIMITED',retryAfterSeconds:1,title:'请稍后重试'}});
  await vi.advanceTimersByTimeAsync(999);
  expect(wxMock.request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(wxMock.request).toHaveBeenCalledTimes(2);
  wxMock.request.mock.calls[1]![0].success({statusCode:200,data:{id:'current-member'}});
  await expect(result).resolves.toEqual({id:'current-member'});
  expect(state.globalData.sessionToken).toBe('old-session');
  expect(wxMock.navigateTo).not.toHaveBeenCalled();
 } finally {vi.useRealTimers();}
});

it('never auto-retries a 429 write or an unbounded 429 read',async()=>{
 const api=await vi.importActual<any>('../../apps/miniprogram/services/api');
 const write=api.request({path:'/v1/me/orders',method:'POST',idempotencyKey:'stable-order-intent',data:{quoteId:'synthetic'}});
 wxMock.request.mock.calls[0]![0].success({statusCode:429,data:{code:'RATE_LIMITED',retryAfterSeconds:1}});
 await expect(write).rejects.toMatchObject({status:429,code:'RATE_LIMITED'});
 const read=api.request({path:'/v1/me/orders'});
 wxMock.request.mock.calls[1]![0].success({statusCode:429,data:{code:'RATE_LIMITED',retryAfterSeconds:60}});
 await expect(read).rejects.toMatchObject({status:429,code:'RATE_LIMITED'});
 expect(wxMock.request).toHaveBeenCalledTimes(2);
 expect(state.globalData.sessionToken).toBe('old-session');
});

it('cancels a queued 429 retry after identity or page changes',async()=>{
 vi.useFakeTimers();
 try {
  const api=await vi.importActual<any>('../../apps/miniprogram/services/api');
  const switched=api.request({path:'/v1/me'}).catch((error:unknown)=>error);
  wxMock.request.mock.calls[0]![0].success({statusCode:429,data:{code:'RATE_LIMITED',retryAfterSeconds:1}});
  api.setSessionToken('new-member');
  await vi.advanceTimersByTimeAsync(100);
  expect(await switched).toMatchObject({code:'REQUEST_SESSION_CHANGED'});
  expect(wxMock.request).toHaveBeenCalledTimes(1);

  const departed=api.request({path:'/v1/me'}).catch((error:unknown)=>error);
  wxMock.request.mock.calls[1]![0].success({statusCode:429,data:{code:'RATE_LIMITED',retryAfterSeconds:1}});
  Object.assign(globalThis,{getCurrentPages:()=>[{route:'pages/settings/index'}]});
  await vi.advanceTimersByTimeAsync(100);
  expect(await departed).toMatchObject({code:'REQUEST_CONTEXT_CHANGED'});
  expect(wxMock.request).toHaveBeenCalledTimes(2);
 } finally {vi.useRealTimers();}
});

it('aborts a cancelable native request and rejects a successful response from an old session',async()=>{
 const api=await vi.importActual<any>('../../apps/miniprogram/services/api');
 const aborted=api.requestCancelable({path:'/v1/me'});
 aborted.abort();
 expect(taskAbort).toHaveBeenCalledTimes(1);
 await expect(aborted.promise).rejects.toMatchObject({code:'REQUEST_ABORTED'});

 const stale=api.requestCancelable({path:'/v1/me'});
 api.setSessionToken('new-member');
 wxMock.request.mock.calls[1]![0].success({statusCode:200,data:{id:'old-member'}});
 await expect(stale.promise).rejects.toMatchObject({code:'REQUEST_SESSION_CHANGED'});
});
