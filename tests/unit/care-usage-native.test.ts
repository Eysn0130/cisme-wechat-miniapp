import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({token:'owner-a',request:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,requireMemberAccess:()=>Boolean(m.token),retainMemberSnapshot:()=>true}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',shouldReduceMotion:()=>true}));
vi.mock('../../apps/miniprogram/services/member-identity',()=>({memberIdentity:()=>null}));
vi.mock('../../apps/miniprogram/services/share',()=>({registerIncomingShare:vi.fn()}));
let page:any, usage:any, care:any, day:string, posts:any[], write:(o:any)=>any, coreFails:boolean;
const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
function deferred(){let resolve!:(v:any)=>void,reject!:(v:any)=>void;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};}
const overview=()=>({serverDay:day,today:usage,enabled:true,streak:usage?1:0});
function accepted(o:any){usage={id:'use-a',operationId:o.idempotencyKey,products:[...o.data.products],note:o.data.note.trim(),version:(usage?.version??0)+1};return{recordId:usage.id,operationId:o.idempotencyKey,replayed:false,careDay:o.data.serverDay};}
const select=(id='essence')=>page.toggleCareProduct({currentTarget:{dataset:{id}}});
async function open(){await import('../../apps/miniprogram/pages/home/index');await page.load();await flush();await page.primaryAction();}
beforeEach(()=>{
 vi.resetModules();vi.clearAllMocks();m.token='owner-a';usage=null;care=null;day='2026-11-10';posts=[];coreFails=false;write=accepted;
 m.request.mockImplementation(async(o:any)=>{
  if(o.method&&o.method!=='GET'){posts.push(structuredClone(o));return write(o);}
  if(o.path==='/v1/bootstrap/home'){if(coreFails)throw{status:503};return{member:{id:m.token,display_name:'合成会员'},care,businessVersion:care?.version??0};}
  if(o.path==='/v1/me/points/club')return overview();
  if(o.path==='/v1/me/support/summary')return{unreadCount:0};
  throw new Error('Unexpected synthetic route');
 });
 (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token}});
 (globalThis as any).wx={showToast:vi.fn(),showModal:vi.fn(async()=>({confirm:true})),enableAlertBeforeUnload:vi.fn(),disableAlertBeforeUnload:vi.fn(),nextTick:(f:()=>void)=>f(),navigateTo:vi.fn()};
 (globalThis as any).Page=(d:any)=>{page={...d,data:structuredClone(d.data),setData(p:any,done?:()=>void){Object.assign(this.data,p);done?.();}};};
});
afterEach(()=>page?.stopDaypartClock?.());
it('records essence alone from the primary Care sheet without inventing four steps or a cycle',async()=>{
 await open();expect(page.data.sessionStage).toBe('usage');select();await page.continueCareUsage();
 expect(posts).toHaveLength(1);expect(posts[0]).toMatchObject({path:'/v1/me/points/checkin',data:{products:['essence'],note:'',serverDay:day}});
 expect(page.data.sessionCompletedCodes).toEqual([]);expect(page.data.care).toBeNull();expect(page.data.sessionMounted).toBe(false);expect(page.data.view.signalTitle).toBe('今天的护理已记录');
 expect(page.data.view.action).toBe('调整今日护理记录');
});
it('requires a product, supports all three, and submits one immutable note and selection',async()=>{
 await open();await page.continueCareUsage();expect(posts).toEqual([]);select('net_run');select('net_xie');select();
 page.careNoteInput({detail:{value:'今天使用后头皮感觉非常清爽舒适'}});await page.continueCareUsage();expect(posts[0].data.products).toEqual(['net_run','net_xie','essence']);expect(posts[0].data.note).toContain('清爽舒适');
});
it('adjusts the existing day with the observed version and retains a newer snapshot after an old receipt',async()=>{
 usage={id:'use-a',operationId:'before-operation',products:['net_run'],note:'原有感受',version:3};await open();select();
 write=o=>{usage={...usage,products:['net_xie'],note:'另页更新',version:5,operationId:'later-operation'};return{recordId:'use-a',operationId:o.idempotencyKey,replayed:true,careDay:day};};
 await page.continueCareUsage();expect(posts[0].data.expectedVersion).toBe(3);expect(posts[0].data.products).toEqual(['net_run','essence']);expect(page.data.usageToday).toMatchObject({version:5,note:'另页更新'});
});
it('freezes repeated taps and edits while saving',async()=>{
 const held=deferred();write=()=>held.promise;await open();select();const saving=page.continueCareUsage();await flush();select('net_run');page.careNoteInput({detail:{value:'late'}});await page.continueCareUsage();
 expect(posts).toHaveLength(1);expect(page.data.sessionProducts).toEqual(['essence']);expect(page.data.sessionNote).toBe('');held.resolve({recordId:'use-a',operationId:posts[0].idempotencyKey,replayed:false,careDay:day});await saving;
});
it('confirms a lost response only when the fresh usage fact carries the same operation and content',async()=>{
 write=o=>{accepted(o);throw{status:503};};await open();select();await page.continueCareUsage();expect(posts).toHaveLength(1);expect(page.data.mutationState).toBe('confirmed');expect(page.data.sessionMounted).toBe(false);
});
it('holds an unknown result and explicitly replays the exact original command after a later edit',async()=>{
 write=()=>{throw{status:503};};await open();select();await page.continueCareUsage();expect(page.data.mutationState).toBe('unknown');
 usage={id:'use-a',operationId:'another-operation',products:['net_xie'],note:'另页感受',version:2};await page.load(true);await page.continueCareUsage();expect(posts).toHaveLength(1);
 write=o=>({recordId:'use-a',operationId:o.idempotencyKey,replayed:true,careDay:o.data.serverDay});await page.retryCareMutation();expect(posts[1]).toEqual(posts[0]);expect(page.data.usageToday.note).toBe('另页感受');expect(page.data.sessionMounted).toBe(false);
});
it('does not accept a receipt for a different command',async()=>{
 write=()=>({recordId:'use-a',operationId:'wrong-operation',replayed:false,careDay:day});await open();select();await page.continueCareUsage();expect(page.data.mutationState).toBe('unknown');expect(wx.showToast).not.toHaveBeenCalled();
});
it('keeps an acknowledged save successful if the independent home refresh fails',async()=>{
 write=o=>{const r=accepted(o);coreFails=true;return r;};await open();select();await page.continueCareUsage();expect(page.data).toMatchObject({mutationState:'confirmed',sessionMounted:false});expect(posts).toHaveLength(1);
});
it('does not rewrite the submitted date or replay after a definitive midnight conflict',async()=>{
 write=()=>{day='2026-11-11';throw{status:409,code:'POINTS_DAY_CHANGED'};};await open();select();await page.continueCareUsage();expect(posts[0].data.serverDay).toBe('2026-11-10');expect(page.data.error).toContain('日期已更新');await page.retryCareMutation();expect(posts).toHaveLength(1);
});
it.each(['hide','account'])('ignores a late acknowledgement after %s and preserves only owner-bound recovery',async(change)=>{
 const held=deferred();write=()=>held.promise;await open();select();const saving=page.continueCareUsage();await flush();page.onHide();if(change==='account')m.token='owner-b';page.onShow();await flush();
 held.resolve({recordId:'use-a',operationId:posts[0].idempotencyKey,replayed:false,careDay:day});await saving;expect(wx.showToast).not.toHaveBeenCalled();
 if(change==='account'){await page.retryCareMutation();expect(posts).toHaveLength(1);expect(page.data.sessionMounted).toBe(false);}else expect(page.data.mutationState).toBe('unknown');
});
it.each(['paused','completed','terminated'])('allows ordinary product use with a %s cycle',async(phase)=>{
 care={id:'cycle-a',version:2,phase,due:null,next:null,completed:[],records:[],timezone:'Asia/Shanghai'};await open();expect(page.data.sessionStage).toBe('usage');select();await page.continueCareUsage();expect(posts[0].path).toBe('/v1/me/points/checkin');
});
it('requires all ordered steps and assessment on due cycles and atomically submits their product use',async()=>{
 care={id:'cycle-a',version:2,phase:'active',startedOn:day,due:'D1',next:'D1',completed:[],records:[],timezone:'Asia/Shanghai',scheduleOffsetDays:0};await open();select('net_run');await page.continueCareUsage();expect(posts).toEqual([]);expect(page.data.sessionStage).toBe('steps');
 for(let i=0;i<3;i++)page.advanceCareStep();await page.submitCareSession();expect(posts).toEqual([]);page.advanceCareStep();await page.submitCareSession();expect(posts).toEqual([]);
 page.selectAssessment({currentTarget:{dataset:{value:'comfortable'}}});write=()=>({});await page.submitCareSession();expect(posts).toHaveLength(1);expect(posts[0]).toMatchObject({path:'/v1/care-cycles/cycle-a/milestones/D1/complete-with-usage',data:{stepCodes:['00','01','02','03'],selfAssessment:'comfortable',dailyUsage:{products:['net_run'],serverDay:day}}});
});
it('does not mistake an unrelated completed cycle for confirmation of an unrecorded bundled usage command',async()=>{
 care={id:'cycle-a',version:2,phase:'active',startedOn:day,due:'D1',next:'D1',completed:[],records:[],timezone:'Asia/Shanghai',scheduleOffsetDays:0};await open();select();await page.continueCareUsage();for(let i=0;i<4;i++)page.advanceCareStep();page.selectAssessment({currentTarget:{dataset:{value:'comfortable'}}});
 write=()=>{care={...care,version:3,due:null,next:'D7',completed:['D1'],records:[{milestone:'D1',completedAt:'2026-11-10T10:00:00Z',stepCodes:['00','01','02','03'],selfAssessment:'comfortable'}]};throw{status:503};};
 await page.submitCareSession();expect(page.data.mutationState).toBe('unknown');expect(page.data.sessionMounted).toBe(true);
});
