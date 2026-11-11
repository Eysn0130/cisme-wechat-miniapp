import {beforeEach,afterEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({token:'member-a',request:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,requireMemberAccess:()=>Boolean(m.token),retainMemberSnapshot:()=>true,clearAuthenticationRedirectSuppression:vi.fn(),resumeAuthentication:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',motionDuration:()=>0,shouldReduceMotion:()=>true}));
let page:any;
const day='2026-11-11';
const record=(d=day)=>({id:'usage-'+d,careDay:d,products:['essence'],note:'private original',version:1,completedAt:d+'T13:00:00Z',updatedAt:d+'T13:00:00Z',rewards:{careDay:d,pointsGranted:0,pointsReversed:0,debtOffset:0,pending:true,components:[]}});
const history=(d=day)=>({serverDay:day,streak:7,items:[record(d)],totalCount:31,nextBefore:null});
const deferred=()=>{let resolve!:(v:any)=>void;const promise=new Promise(r=>{resolve=r;});return{resolve,promise};};
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();m.token='member-a';
 (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token}});
 (globalThis as any).wx={disableAlertBeforeUnload:vi.fn(),stopPullDownRefresh:vi.fn(),nextTick:(f:Function)=>f()};
 (globalThis as any).Page=(d:any)=>{page={...d,data:structuredClone(d.data),setData(p:any,done?:Function){Object.assign(this.data,p);done?.();}};};
 m.request.mockImplementation(async(o:any)=>o.path.includes('calendar')?{from:'2026-11-05',through:day,serverDay:day,recordedDays:[day]}:history());
 await import('../../apps/miniprogram/pages/records/index');page.syncSession();
});
afterEach(()=>page.stopUsageRefresh());
it('keeps total product days separate from date filtering and shows pending rather than invented reward',async()=>{
 await page.loadUsageRecords();expect(page.data.usageTotal).toBe(31);expect(page.data.usageStreak).toBe(7);
 expect(page.data.usageVisibleRows[0].rewardLabel).toBe('积分处理中');
 expect(page.data.usageDays.filter((d:any)=>d.recorded).map((d:any)=>d.day)).toEqual([day]);
 m.request.mockResolvedValue({...history(),items:[]});await page.chooseUsageDay('2026-11-04');
 expect(page.data.usageVisibleRows).toEqual([]);expect(page.data.usageTotal).toBe(31);
});
it('the last selected date wins when earlier reads arrive late',async()=>{
 await page.loadUsageRecords();const old=deferred();m.request.mockImplementation((o:any)=>o.path.endsWith('day=2026-11-10')?old.promise:Promise.resolve(history('2026-11-09')));
 const a=page.chooseUsageDay('2026-11-10');await page.chooseUsageDay('2026-11-09');old.resolve(history('2026-11-10'));await a;
 expect(page.data.usageSelectedDay).toBe('2026-11-09');expect(page.data.usageVisibleRows[0].careDay).toBe('2026-11-09');
});
it.each(['hide','account'])('does not repopulate private product records after %s',async(change)=>{
 await page.loadUsageRecords();const held=deferred();m.request.mockReturnValue(held.promise);const loading=page.chooseUsageDay('2026-11-10');
 if(change==='hide')page.onHide();else{m.token='member-b';page.syncSession();}
 held.resolve(history('2026-11-10'));await loading;expect(page.data.usageVisibleRows).toEqual([]);expect(page.data.usageDetail).toBeNull();
});
it('an authentication failure clears product facts as well as old cycle facts',async()=>{
 await page.loadUsageRecords();m.request.mockRejectedValue({status:401});await page.chooseUsageDay('2026-11-10');
 expect(page.data.accessRequired).toBe(true);expect(page.data.usageRecords).toEqual([]);expect(page.data.usageVisibleRows).toEqual([]);expect(page.data.usageServerDay).toBe('');
});
it('a fresh primary read invalidates a stale date read without leaving a loading state',async()=>{
 await page.loadUsageRecords();const old=deferred();m.request.mockReturnValueOnce(old.promise);const dateRead=page.chooseUsageDay('2026-11-10');
 page.setData({usageSelectedDay:day});m.request.mockImplementation(async(o:any)=>o.path.includes('calendar')?{from:'2026-11-05',through:day,serverDay:day,recordedDays:[day]}:history());
 await page.loadUsageRecords();old.resolve(history('2026-11-10'));await dateRead;
 expect(page.data.usageSelectedDay).toBe(day);expect(page.data.usageVisibleRows[0].careDay).toBe(day);expect(page.data.usageDateLoading).toBe(false);
});
