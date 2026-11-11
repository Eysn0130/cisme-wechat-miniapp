import {clubRulesV1} from '../../services/api/src/pointsLedger';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({request:vi.fn(),token:'member-a',retain:true,revision:0,seq:0,addresses:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,requireMemberAccess:()=>Boolean(m.token),retainMemberSnapshot:()=>m.retain}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/orders',()=>({clientOperationKey:()=>`synthetic-operation-${++m.seq}`,memberAddresses:m.addresses}));
let definition:any,page:any,app:any;const storage=new Map<string,unknown>();
const member='11111111-1111-4111-8111-111111111111';
const wallet=()=>({projection:{available:900,frozen:5,debt:0,reserved:20,version:4},rulesEnabled:true,entries:[],totalCount:63,nextCursor:null,lifetimeEarned:925,used:0,expired:0,expiring:{points:30,earliestAt:'2026-12-01T00:00:00Z',withinDays:30},clubPolicy:null});
const club=()=>({memberId:member,enabled:true,policy:{version:'club-test-v1',rules:clubRulesV1},serverDay:'2026-11-10',checkedIn:false,streak:6,today:null,badges:[],pendingRewardSources:0,questionnaireCompleted:false,birthday:null});
const flush=async()=>{for(let i=0;i<45;i++)await Promise.resolve();};
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();storage.clear();m.token='member-a';m.retain=true;m.seq=0;
 app={globalData:{get sessionToken(){return m.token},apiBaseUrl:'https://synthetic.invalid',cloudFunction:null}};
 vi.stubGlobal('getApp',()=>app);vi.stubGlobal('wx',{getStorageSync:(k:string)=>storage.get(k)||'',setStorageSync:(k:string,v:unknown)=>storage.set(k,v),removeStorageSync:(k:string)=>storage.delete(k),showToast:vi.fn(),showModal:async()=>({confirm:true}),navigateTo:vi.fn(),switchTab:vi.fn(),navigateBack:vi.fn()});
 vi.stubGlobal('Page',(value:any)=>{definition=value});m.addresses.mockResolvedValue({addresses:[]});
 m.request.mockImplementation(async({path}:any)=>{if(path.startsWith('/v1/me/points?'))return wallet();if(path==='/v1/me/points/club')return club();if(path==='/v1/me/points/gifts')return {enabled:true,items:[]};if(path==='/v1/me/points/redemptions')return {items:[],nextCursor:null};if(path==='/v1/me/profile')return {id:member};throw Error('Unexpected synthetic route '+path);});
 await import('../../apps/miniprogram/pages/points/index');page={...definition,data:structuredClone(definition.data),setData(p:any){Object.assign(this.data,p)}};
});
afterEach(()=>vi.unstubAllGlobals());
it('renders authoritative buckets and real count, then retains them through revalidation',async()=>{
 page.onShow();await flush();expect(page.data.points).toMatchObject({totalCount:63,projection:{available:900,reserved:20}});
 const original=page.data.points;let resolve!:(v:unknown)=>void;const pending=new Promise(r=>resolve=r);m.request.mockImplementation(({path}:any)=>path.startsWith('/v1/me/points?')?pending:Promise.resolve(path.endsWith('/club')?club():{items:[],nextCursor:null}));
 page.onHide();page.onShow();await flush();expect(page.data.points).toEqual(original);resolve(wallet());await flush();expect(page.data.loading).toBe(false);
});
it('does not fabricate zero on a failed or malformed balance and still offers retry',async()=>{
 m.request.mockImplementation(async({path}:any)=>path.startsWith('/v1/me/points?')?{...wallet(),projection:{available:'broken'}}:path.endsWith('/club')?club():{items:[],nextCursor:null});page.onShow();await flush();expect(page.data.points).toBeNull();expect(page.data.error).toContain('重新查询');
});
it('clears private state on account change and ignores a response after hiding',async()=>{
 page.onShow();await flush();page.setData({giftSelected:{name:'上一位礼品'},club:club()});m.token='';m.retain=false;page.onShow();expect(page.data).toMatchObject({points:null,club:null,giftSelected:null});
 m.token='member-b';let resolve!:(v:unknown)=>void;const p=new Promise(r=>resolve=r);m.request.mockReturnValue(p);page.onShow();page.onHide();resolve(wallet());await flush();expect(page.data.points).toBeNull();
});
it('keeps daily care, birthday and onboarding editors out of the points wallet',async()=>{
 page.onShow();await flush();expect(page.openCheckin).toBeUndefined();expect(page.writeBirthday).toBeUndefined();expect(page.openCareProfile).toBeUndefined();
 const {readFileSync}=await import('node:fs');const markup=readFileSync('apps/miniprogram/pages/points/index.wxml','utf8');
 for(const removed of ['查看或补充今日记录','记录今日使用','记下生日','care-onboarding','birthdayRanges'])expect(markup).not.toContain(removed);
 expect(page.data.sections.map((s:any)=>s.label)).toEqual(['赚积分','积分明细','积分兑换']);
});
it('protects a saved redemption recovery command from a different canonical member',async()=>{
 const {preparePointsGift,dispatchPointsGift}=await import('../../apps/miniprogram/services/points-gift-recovery');
 const command=preparePointsGift(member,{skuId:'22222222-2222-4222-8222-222222222222',offerVersion:1,policyVersion:'club-test-v1',expectedPoints:900,quantity:1,addressId:'33333333-3333-4333-8333-333333333333',addressVersion:1});
 m.request.mockResolvedValue({id:'44444444-4444-4444-8444-444444444444'});await expect(dispatchPointsGift(command)).rejects.toMatchObject({title:'请回到原账号核对这笔兑换。'});expect(m.request).toHaveBeenCalledTimes(1);
 expect(JSON.stringify([...storage.values()])).not.toContain(m.token);
});
it('displays bucket transfers correctly and refuses negative or unconfirmed balances',async()=>{
 const {presentPointEntry,parsePointBalances}=await import('../../apps/miniprogram/services/points');
 const entry={id:'e1',entry_type:'unfreeze',available_delta:20,frozen_delta:-20,debt_delta:0,business_key:'legacy',occurred_at:'2026-11-10T00:00:00Z'};
 expect(presentPointEntry(entry).displayAmount).toBe('+20');
 expect(presentPointEntry({...entry,entry_type:'release',available_delta:0,frozen_delta:0,reserved_delta:-20,expired_delta:20})).toMatchObject({displayAmount:'-20',displayTitle:'订单取消，积分已到期'});
 expect(presentPointEntry({...entry,entry_type:'expire',available_delta:-20,frozen_delta:0})).toMatchObject({displayAmount:'-20'});expect(()=>parsePointBalances({available:20,frozen:0,reserved:0,debt:3,version:1})).toThrow();
});

it('makes the balance and earning rules available while optional address reads remain pending',async()=>{m.addresses.mockReturnValue(new Promise(()=>{}));page.onShow();await flush();expect(page.data.points.projection.available).toBe(900);expect(page.data.club.enabled).toBe(true);expect(page.data.addressesState).toBe('loading');});
