import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({token:'member-A',request:vi.fn(),club:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,requireMemberAccess:()=>Boolean(m.token),retainMemberSnapshot:()=>true}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>0}));
vi.mock('../../apps/miniprogram/services/points-feedback',()=>({confirmCreditOwner:vi.fn()}));
vi.mock('../../apps/miniprogram/services/orders',()=>({clientOperationKey:()=> 'synthetic-suggestion-key',memberAddresses:async()=>({addresses:[]})}));
vi.mock('../../apps/miniprogram/services/points-gift-recovery',()=>({pendingPointsGift:()=>null,preparePointsGift:vi.fn(),dispatchPointsGift:vi.fn(),inspectPointsGift:vi.fn()}));
vi.mock('../../apps/miniprogram/services/catalog',()=>({nativeCatalogImage:(s:string)=>s}));
vi.mock('../../apps/miniprogram/services/points',()=>({readMyPoints:async()=>({projection:{available:100},expiring:{earliestAt:null}}),readPointsClub:m.club,readPointsGifts:async()=>({items:[]}),readMyRedemptions:async()=>({items:[],nextCursor:null}),redemptionLabels:{}}));
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const club={memberId:owner,policy:{version:'synthetic',rules:{}},tasks:[]};
let page:any;
const later=()=>{let resolve!:(v:any)=>void;const promise=new Promise(a=>{resolve=a;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
beforeEach(async()=>{vi.resetModules();vi.clearAllMocks();m.token='member-A';m.request.mockResolvedValue({items:[]});m.club.mockResolvedValue(club);vi.stubGlobal('getApp',()=>({globalData:{sessionToken:m.token}}));vi.stubGlobal('wx',{showToast:vi.fn(),switchTab:vi.fn(),navigateTo:vi.fn()});vi.stubGlobal('Page',(def:any)=>{page={...def,data:structuredClone(def.data),setData(p:any){Object.assign(this.data,p);}};});await import('../../apps/miniprogram/pages/points/index');page.onLoad({guide:'1'});page.onShow();await flush();});
afterEach(()=>vi.unstubAllGlobals());
it('unlocks after a hidden submission and retries only the original key and exact frozen body',async()=>{
 const delayed=later();m.request.mockImplementation((o:any)=>o.method==='POST'?delayed.promise:Promise.resolve({items:[]}));const body='希望在礼品领取订单里增加按快递状态查找的功能，方便及时查看。';page.setData({suggestionOpen:true,suggestionBody:body});const first=page.submitSuggestion();expect(page.data.suggestionBusy).toBe(true);const command=m.request.mock.calls.find(([o])=>o.method==='POST')![0];page.onHide();page.onShow();await flush();expect(page.data).toMatchObject({suggestionBusy:false,suggestionKey:command.idempotencyKey,suggestionPendingBody:body});page.closeSuggestion();expect(page.data.suggestionOpen).toBe(false);delayed.resolve({id:'synthetic'});await first;expect(page.data.suggestionKey).toBe(command.idempotencyKey);
 m.request.mockResolvedValue({items:[]});await page.submitSuggestion();const posts=m.request.mock.calls.filter(([o])=>o.method==='POST').map(([o])=>({key:o.idempotencyKey,body:o.data}));expect(posts).toEqual([{key:command.idempotencyKey,body:{body}},{key:command.idempotencyKey,body:{body}}]);expect(page.data.suggestionKey).toBe('');
});
it('discards the old member draft and pending key on account change while ignoring its late response',async()=>{
 const delayed=later();m.request.mockImplementation((o:any)=>o.method==='POST'?delayed.promise:Promise.resolve({items:[]}));page.setData({suggestionOpen:true,suggestionBody:'这是原会员提交的具体功能建议，请在切换账号时正确清除私人内容。'});const old=page.submitSuggestion();m.token='member-B';page.onShow();await flush();expect(page.data).toMatchObject({suggestionBusy:false,suggestionKey:'',suggestionBody:'',suggestionPendingBody:'',suggestionOpen:false});delayed.resolve({id:'old-member-only'});await old;expect(page.data.suggestionBody).toBe('');
});
it('rechecks a pending award instead of navigating to complete its task again',async()=>{page.setData({taskRows:[{id:'questionnaire',state:'pending',destination:'questionnaire'}],loading:false});page.load=vi.fn();page.openTask({currentTarget:{dataset:{id:'questionnaire'}}});expect(page.load).toHaveBeenCalledOnce();expect(wx.switchTab).not.toHaveBeenCalled();});
it('shows confirmed task completion, repeatable progress, and pending reward feedback',async()=>{
 m.club.mockResolvedValueOnce({...club,tasks:[
  {id:'daily',state:'limit',bucket:'2026-11-18',count:1,limit:1},
  {id:'experience',state:'limit',bucket:'2026-11',count:1,limit:1},
  {id:'questionnaire',state:'completed',bucket:'',count:1,limit:1},
  {id:'comment',state:'available',bucket:'2026-11-18',count:1,limit:3},
  {id:'invite',state:'available',bucket:'',count:2,limit:0},
  {id:'note',state:'pending',bucket:'2026-11-18',count:0,limit:1}
 ]});
 await page.load();
 expect(page.data.taskRows.map((t:any)=>[t.statusLabel,t.actionLabel,t.complete])).toEqual([
  ['今日任务完成','查看明细',true],['本月任务完成','查看明细',true],['任务完成','查看明细',true],
  ['已完成 1 / 3','继续完成',false],['已完成 2 次','继续邀请',true],['积分核对中','核对积分',false]
 ]);
 await page.openTask({currentTarget:{dataset:{id:'daily'}}});
 expect(page.data.section).toBe('ledger');expect(wx.switchTab).not.toHaveBeenCalled();
});
it('refreshes task status only for a confirmed positive credit belonging to the current member',()=>{
 page.load=vi.fn();
 page.refreshAfterCredit({detail:{owner:'another-member',amount:10}});
 page.refreshAfterCredit({detail:{owner,amount:0}});
 expect(page.load).not.toHaveBeenCalled();
 page.refreshAfterCredit({detail:{owner,amount:10}});
 expect(page.load).toHaveBeenCalledOnce();
});
