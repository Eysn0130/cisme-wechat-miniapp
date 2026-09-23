import { beforeEach, expect, it, vi } from "vitest";

const requestMock=vi.hoisted(()=>vi.fn());
vi.mock("../../apps/miniprogram/services/api",()=>({request:requestMock,resumeAuthentication:vi.fn()}));
vi.mock("../../apps/miniprogram/services/authority",()=>({
  authorityProjection:vi.fn(),hasCapability:vi.fn(()=>true),requireCapability:vi.fn(async()=>({capabilities:["member.profile.read"]}))
}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>""}));

type Definition=Record<string,any>&{data:Record<string,any>};
let captured:Definition,session="actor-a";
let modal=vi.fn((..._args:unknown[]):unknown=>undefined),sheet=vi.fn((..._args:unknown[]):unknown=>undefined);
function mounted(overrides:Record<string,unknown>={}){
  const page:Record<string,any>={data:{...captured.data,...overrides},setData(patch:Record<string,unknown>){Object.assign(this.data,patch);}};
  for(const [name,value] of Object.entries(captured))if(typeof value==="function")page[name]=value;
  return page;
}
async function load(path:string){await import(path);return captured;}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
beforeEach(()=>{
  vi.resetModules();requestMock.mockReset();session="actor-a";
  modal=vi.fn((..._args:unknown[]):unknown=>undefined);sheet=vi.fn((..._args:unknown[]):unknown=>undefined);
  (globalThis as any).getApp=()=>({globalData:{sessionToken:session}});
  (globalThis as any).Page=(definition:Definition)=>{captured=definition;};
  (globalThis as any).wx={showModal:(...args:unknown[])=>modal(...args),showActionSheet:(...args:unknown[])=>sheet(...args),
    navigateBack:vi.fn(),switchTab:vi.fn(),navigateTo:vi.fn()};
});

it("does not change membership or propose a rate after the actor switches while a modal is open",async()=>{
  await load("../../apps/miniprogram/pages/management-member/index");
  const detail={member:{id:"member-1",displayName:"合成成员",version:4,expiresAt:null},
    rate:{basisPoints:2500},
    membershipPolicy:{kind:"engineering_calendar_v2",termMonths:12,rateOptions:[2000,2500,3000,3500],renewalExpiresAt:"2027-09-13T00:00:00Z",
      rateProposalSuggestedAt:"2027-09-13T01:00:00Z"}};
  const page=mounted({detail,attempt:2,alive:true,canManageRate:true,canManageMembership:true,rateBasisPoints:[2000,2500,3000,3500]});
  const first=deferred<{confirm:boolean;content:string}>();modal.mockReturnValueOnce(first.promise);
  const membership=page.changeMembership({currentTarget:{dataset:{state:"active"}}});
  session="actor-b";first.resolve({confirm:true,content:"合成资格变更依据"});await membership;
  expect(requestMock).not.toHaveBeenCalled();

  session="actor-a";page.openRateForm();
  page.data.rateForm={mode:"override",percent:"25",date:"2027-09-13",time:"09:00",reason:"合成费率依据"};
  const second=deferred<{confirm:boolean}>();modal.mockReturnValueOnce(second.promise);
  const rate=page.submitRateForm();page.data.attempt+=1;
  second.resolve({confirm:true});await rate;
  expect(requestMock).not.toHaveBeenCalled();
});

it("does not turn an unconfigured formal commercial policy into a client-side fee or membership action",async()=>{
  await load("../../apps/miniprogram/pages/management-member/index");
  const page=mounted({detail:{member:{id:"member-1",version:1},membershipPolicy:{kind:"unconfigured",termMonths:null,
    rateOptions:[],renewalExpiresAt:null,rateProposalSuggestedAt:"2027-09-13T01:00:00Z"}},
    canManageRate:true,canManageMembership:true,rateBasisPoints:[]});
  page.openRateForm();
  await page.changeMembership({currentTarget:{dataset:{state:"active"}}});
  expect(page.data.rateFormVisible).toBe(false);
  expect(page.data.actionError).toContain("资格规则暂不可用");
  expect(modal).not.toHaveBeenCalled();
  expect(requestMock).not.toHaveBeenCalled();
  await load("../../apps/miniprogram/pages/management-members/index");
  const list=mounted({canManageRate:true,globalRate:{basisPoints:null,rateOptions:[],suggestedEffectiveAt:"2027-09-13T01:00:00Z"},
    rateBasisPoints:[]});
  list.openGlobalRateForm();
  expect(list.data.globalRateFormVisible).toBe(false);
  expect(list.data.globalRateError).toContain("费率范围尚未配置");
  expect(requestMock).not.toHaveBeenCalled();
});

it("requires an explicit end date for a new formal membership and sends that date without an engineering term",async()=>{
  await load("../../apps/miniprogram/pages/management-member/index");
  const detail={member:{id:"member-formal",displayName:"正式成员",membershipState:"none",version:0,expiresAt:null},
    membershipPolicy:{kind:"operator_explicit",termMonths:null,rateOptions:[2000,2500,3000,3500]}};
  const page=mounted({detail,alive:true,attempt:1,canManageMembership:true,expiryMinDate:"2026-09-23"});
  await page.changeMembership({currentTarget:{dataset:{state:"active"}}});
  expect(page.data.actionError).toContain("选择资格截止日");
  expect(modal).not.toHaveBeenCalled();
  page.chooseExpiryDate({detail:{value:"2027-09-30"}});
  modal.mockResolvedValueOnce({confirm:true,content:"经营方明确授予资格"});
  requestMock.mockResolvedValue({});
  await page.changeMembership({currentTarget:{dataset:{state:"active"}}});
  const command=requestMock.mock.calls.find(([input])=>input.method==="POST")?.[0];
  expect(command?.data).toMatchObject({state:"active",expiresAt:"2027-09-30T16:00:00.000Z",expectedVersion:0});
  expect(command?.data).not.toHaveProperty("term");
});

it("does not approve a rate when the member list reloads before confirmation",async()=>{
  await load("../../apps/miniprogram/pages/management-members/index");
  const page=mounted({canApprove:true,pending:[{id:"rate-1",memberId:"member-1",displayName:"合成成员",basisPoints:2500,reason:"合成依据"}],attempt:3,alive:true});
  const answer=deferred<{confirm:boolean}>();modal.mockReturnValueOnce(answer.promise);
  const pending=page.reviewRate({currentTarget:{dataset:{id:"rate-1",decision:"active"}}});
  page.data.attempt+=1;answer.resolve({confirm:true});await pending;
  expect(requestMock).not.toHaveBeenCalled();
});

it("does not bind a referral after the account or code changes during confirmation",async()=>{
  await load("../../apps/miniprogram/pages/referral/index");
  const page=mounted();page.onLoad({code:"CM23456789AB"});
  const answer=deferred<{confirm:boolean}>();modal.mockReturnValueOnce(answer.promise);
  const pending=page.confirm();session="actor-b";page.onShow();answer.resolve({confirm:true});await pending;
  expect(requestMock).not.toHaveBeenCalled();
  expect(page.data.confirmed).toBe(false);
});

it("does not report, block, or delete an old post after an account switch",async()=>{
  await load("../../apps/miniprogram/pages/community-post/index");
  const post={id:"post-1",version:2,authorId:"author-1",isMine:false};
  const page=mounted({postId:"post-1",post,epoch:5,busy:false});
  const choice=deferred<{tapIndex:number}>();sheet.mockReturnValueOnce(choice.promise);
  const report=page.report();session="actor-b";choice.resolve({tapIndex:0});await report;
  expect(requestMock).not.toHaveBeenCalled();

  session="actor-a";const blockAnswer=deferred<{confirm:boolean}>();modal.mockReturnValueOnce(blockAnswer.promise);
  const block=page.blockAuthor();page.data.epoch+=1;blockAnswer.resolve({confirm:true});await block;
  expect(requestMock).not.toHaveBeenCalled();

  page.data.post={...post,isMine:true};const deleteAnswer=deferred<{confirm:boolean}>();modal.mockReturnValueOnce(deleteAnswer.promise);
  const removal=page.deleteOwn();session="actor-b";deleteAnswer.resolve({confirm:true});await removal;
  expect(requestMock).not.toHaveBeenCalled();
});

it("does not submit an isolated refund or cancel an old order after an account switch",async()=>{
  await load("../../apps/miniprogram/pages/order-detail/index");
  const order={id:"order-1",orderNumber:"CO-ISOLATED",status:"paid",version:3,
    totalCents:10000,totalYuan:"100.00",transactionSourceKind:"verified_commerce"};
  const page=mounted({id:order.id,order,epoch:6,pageAlive:true,isolatedPayment:true,
    refundFormVisible:true,refundAmount:"10.00",refundReason:"合成退款原因",busy:false});
  const refundAnswer=deferred<{confirm:boolean}>();modal.mockReturnValueOnce(refundAnswer.promise);
  const refund=page.submitRefund();session="actor-b";refundAnswer.resolve({confirm:true});await refund;
  expect(requestMock).not.toHaveBeenCalled();
  session="actor-a";page.data.order={...order,status:"pending_payment"};
  const cancelAnswer=deferred<{confirm:boolean}>();modal.mockReturnValueOnce(cancelAnswer.promise);
  const cancel=page.cancel();page.data.epoch+=1;cancelAnswer.resolve({confirm:true});await cancel;
  expect(requestMock).not.toHaveBeenCalled();
});
