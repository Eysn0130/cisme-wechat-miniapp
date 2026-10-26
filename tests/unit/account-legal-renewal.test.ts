import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({request:vi.fn(),accept:vi.fn(),navigate:vi.fn(),setSession:vi.fn(),token:"existing-session",storage:new Map<string,unknown>()}));
vi.mock("../../apps/miniprogram/services/api",()=>({request:mocks.request,acceptCurrentLegalDocuments:mocks.accept,cancelAuthentication:vi.fn(),consumeAuthReturnUrl:()=>{const value=mocks.storage.get("cisme.authReturnUrl")||"/pages/community/index";mocks.storage.delete("cisme.authReturnUrl");return value;},navigateAfterAuthentication:mocks.navigate,setSessionToken:mocks.setSession,setPrivacyRightsToken:vi.fn(),suppressAuthenticationRedirectOnce:vi.fn()}));
vi.mock("../../apps/miniprogram/release-config",()=>({legalDocumentVersions:()=>null,shouldUseDevelopmentIdentity:()=>false}));
vi.mock("../../apps/miniprogram/services/member-avatar",()=>({defaultMemberAvatar:"local-avatar",localMemberAvatar:vi.fn(),prepareAvatarUpload:vi.fn()}));
vi.mock("../../apps/miniprogram/services/member-identity",()=>({publishMemberIdentity:vi.fn()}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>"",motionDuration:()=>0,shouldReduceMotion:()=>false}));
vi.mock("../../apps/miniprogram/services/share",()=>({attributePendingShare:vi.fn()}));
const source="/pages/post/index?id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&source=editorial";
const legal=(version="v2")=>({ready:true,documents:[{document_type:"terms",version},{document_type:"privacy",version}]});
const deferred=()=>{let resolve!:(v?:unknown)=>void,reject!:(v:unknown)=>void;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
let page:any,wxMock:any;
async function mount(){await import("../../apps/miniprogram/pages/account/index");page.onLoad({intent:"renew"});page.setData({serverLegalDocuments:{privacy:"v2",terms:"v2",localFixture:false},legalTextsReady:true,legalLoading:false});return page;}
beforeEach(()=>{
 vi.resetModules();mocks.request.mockReset().mockImplementation(async({path}:any)=>path==="/v1/legal"?legal():{});mocks.accept.mockReset().mockResolvedValue(undefined);mocks.navigate.mockReset().mockResolvedValue("target");mocks.setSession.mockReset();mocks.token="existing-session";mocks.storage.clear();mocks.storage.set("cisme.authReturnUrl",source);
 (globalThis as any).getApp=()=>({globalData:{sessionToken:mocks.token,apiBaseUrl:"https://synthetic.invalid"}});
 (globalThis as any).getCurrentPages=()=>[{route:"pages/account/index",options:{intent:"renew"}}];
 (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(values:any,callback?:()=>void){Object.assign(this.data,values);callback?.();}};};
 wxMock={getAccountInfoSync:()=>({miniProgram:{envVersion:"trial"}}),getDeviceInfo:()=>({platform:"ios"}),getStorageSync:(key:string)=>mocks.storage.get(key)||"",setStorageSync:vi.fn((key:string,value:unknown)=>mocks.storage.set(key,value)),removeStorageSync:(key:string)=>mocks.storage.delete(key),login:vi.fn(),switchTab:vi.fn(),redirectTo:vi.fn(),navigateBack:vi.fn(),showModal:vi.fn().mockResolvedValue({confirm:false}),showToast:vi.fn(),pageScrollTo:vi.fn(),enableAlertBeforeUnload:vi.fn(),disableAlertBeforeUnload:vi.fn()};
 (globalThis as any).wx=wxMock;
});
describe("explicit current-legal renewal with an existing session",()=>{
 it("does not bypass unchecked current documents through an existing token or destination",async()=>{
  await mount();page.data.pendingDestination="/pages/profile/index";page.onShow();await page.login();
  expect(page.data.renewalMode).toBe(true);expect(page.data.agreementAccepted).toBe(false);expect(mocks.accept).not.toHaveBeenCalled();expect(mocks.navigate).not.toHaveBeenCalled();expect(wxMock.login).not.toHaveBeenCalled();expect(mocks.token).toBe("existing-session");
 });
 it("accepts only the explicit current two versions and returns without identity, phone, avatar, or interaction writes",async()=>{
  await mount();page.setData({agreementAccepted:true});page.loadMemberIdentity=vi.fn();await page.login();
  expect(mocks.accept).toHaveBeenCalledExactlyOnceWith([{documentType:"terms",version:"v2"},{documentType:"privacy",version:"v2"}]);expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(source);
  expect(wxMock.login).not.toHaveBeenCalled();expect(mocks.setSession).not.toHaveBeenCalled();expect(page.loadMemberIdentity).not.toHaveBeenCalled();expect(mocks.request).not.toHaveBeenCalled();expect(mocks.token).toBe("existing-session");expect(page.data.renewalComplete).toBe(true);
 });
 it("returns cancellation to the source reading without changing the session or guest mode",async()=>{
  await mount();await page.browseCommunity();expect(wxMock.navigateBack).toHaveBeenCalledOnce();expect(mocks.accept).not.toHaveBeenCalled();expect(mocks.setSession).not.toHaveBeenCalled();expect(mocks.token).toBe("existing-session");expect(mocks.storage.has("cisme.guestBrowsing")).toBe(false);
 });
 it("serializes confirmation taps and retains the current checkbox during an unknown result",async()=>{
  await mount();page.data.agreementAccepted=true;const pending=deferred();mocks.accept.mockReturnValueOnce(pending.promise);
  const one=page.login();await page.login();page.toggleAgreement({detail:{value:[]}});expect(mocks.accept).toHaveBeenCalledOnce();expect(page.data.agreementAccepted).toBe(true);expect(page.data.loading).toBe(true);
  pending.reject(new Error("response lost"));await one;expect(page.data).toMatchObject({loading:false,legalAcceptanceStarted:false,renewalComplete:false});expect(page.data.error).toContain("结果尚未收到");expect(mocks.navigate).not.toHaveBeenCalled();expect(mocks.storage.get("cisme.authReturnUrl")).toBe(source);
 });
 it("reloads a newly published version and requires a fresh explicit checkbox",async()=>{
  await mount();page.data.agreementAccepted=true;mocks.accept.mockRejectedValueOnce({status:409,code:"LEGAL_VERSION_REQUIRED"});mocks.request.mockResolvedValueOnce(legal("v3"));await page.login();
  expect(page.data).toMatchObject({renewalComplete:false,agreementAccepted:false,serverLegalDocuments:{terms:"v3",privacy:"v3"}});expect(mocks.navigate).not.toHaveBeenCalled();await page.login();expect(mocks.accept).toHaveBeenCalledOnce();
  page.data.agreementAccepted=true;await page.login();expect(mocks.accept).toHaveBeenLastCalledWith([{documentType:"terms",version:"v3"},{documentType:"privacy",version:"v3"}]);expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(source);
 });
 it("keeps a confirmed source for navigation retry without accepting again or opening avatar setup",async()=>{
  await mount();page.data.agreementAccepted=true;mocks.navigate.mockResolvedValueOnce("failed");await page.login();expect(page.data.error).toContain("协议已确认");
  await page.login();expect(mocks.accept).toHaveBeenCalledOnce();expect(mocks.navigate).toHaveBeenCalledTimes(2);expect(mocks.navigate.mock.calls.every(([url])=>url===source)).toBe(true);expect(wxMock.login).not.toHaveBeenCalled();expect(page.data.loginStage).toBe("login");
 });
 it("does not navigate on an old session's late acceptance and clears consent before a different member can confirm",async()=>{
  await mount();page.data.agreementAccepted=true;const pending=deferred();mocks.accept.mockReturnValueOnce(pending.promise);const one=page.login();mocks.token="other-session";pending.resolve();await one;
  expect(mocks.navigate).not.toHaveBeenCalled();await page.login();expect(mocks.accept).toHaveBeenCalledOnce();expect(page.data.agreementAccepted).toBe(false);expect(page.data.error).toContain("账号状态已变化");
 });
 it("requires normal deliberate login if the session expired without starting it automatically",async()=>{
  await mount();mocks.token="";page.onShow();await Promise.resolve();expect(page.data.renewalMode).toBe(false);expect(mocks.accept).not.toHaveBeenCalled();expect(wxMock.login).not.toHaveBeenCalled();expect(mocks.storage.get("cisme.authReturnUrl")).toBe(source);
 });
 it("does not invoke phone or avatar callbacks in renewal mode",async()=>{
  await mount();page.data.phoneBindingEnabled=true;await page.loginWithPhone({detail:{code:"synthetic-phone-code"}});await page.chooseLoginAvatar({detail:{avatarUrl:"synthetic-avatar"}});
  expect(mocks.accept).not.toHaveBeenCalled();expect(wxMock.login).not.toHaveBeenCalled();expect(mocks.request).not.toHaveBeenCalled();
 });
 it("explains an in-flight explicit confirmation before leaving and ignores its late response",async()=>{
  await mount();page.data.agreementAccepted=true;const pending=deferred();mocks.accept.mockReturnValueOnce(pending.promise);const one=page.login();wxMock.showModal.mockResolvedValueOnce({confirm:true});await page.back();
  expect(wxMock.showModal).toHaveBeenCalledWith(expect.objectContaining({title:"协议正在确认"}));pending.resolve();await one;expect(mocks.navigate).not.toHaveBeenCalled();expect(wxMock.navigateBack).toHaveBeenCalledOnce();expect(mocks.token).toBe("existing-session");
 });
 it("does not navigate from a hidden account page when a confirmation response arrives",async()=>{
  await mount();page.data.agreementAccepted=true;const pending=deferred();mocks.accept.mockReturnValueOnce(pending.promise);const one=page.login();page.onHide();pending.resolve();await one;
  expect(mocks.navigate).not.toHaveBeenCalled();expect(page.data.renewalComplete).toBe(false);expect(mocks.storage.get("cisme.authReturnUrl")).toBe(source);expect(mocks.token).toBe("existing-session");
 });
});
