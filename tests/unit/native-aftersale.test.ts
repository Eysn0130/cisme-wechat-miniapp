import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({request:vi.fn(),authority:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,requireMemberAccess:()=>true,
 historicalCommerceToken:()=>token,historicalCommerceClosed:()=>false,requireHistoricalCommerceAccess:()=>Boolean(token)}));
vi.mock('../../apps/miniprogram/services/authority',()=>({authorityProjection:m.authority}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>0}));
let def:any,token:string;
const record={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',orderId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',kind:'refund_only',state:'requested',version:1,amountCents:10000,reason:'合成原因',lines:[],resolved:false,refund:null};
beforeEach(()=>{vi.resetModules();vi.useFakeTimers();token='synthetic';m.request.mockReset().mockResolvedValue({items:[record],nextCursor:null});m.authority.mockReset().mockResolvedValue({version:1,managementAvailable:true,capabilities:['commerce.aftersale.review']});(globalThis as any).Page=(p:any)=>def=p;(globalThis as any).getApp=()=>({globalData:{sessionToken:token}});(globalThis as any).wx={showModal:vi.fn((o:any)=>o.success({confirm:true})),navigateBack:vi.fn(),navigateTo:vi.fn(),redirectTo:vi.fn()};});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
async function page(management=false){await import('../../apps/miniprogram/pages/aftersale/index');const p={...def,data:structuredClone(def.data),setData(p:any){Object.assign(this.data,p);}};p.onLoad({mode:management?'management':'',orderId:record.orderId});await p.onShow();return p;}
it('uses only server capabilities for management and keeps customer reads owner-scoped',async()=>{const p=await page();expect(p.data.coreReady).toBe(true);expect(m.authority).not.toHaveBeenCalled();expect(m.request.mock.calls[0]![0].path).toContain('/v1/me/aftersales?');const q=await page(true);expect(q.data.coreReady).toBe(true);expect(m.request.mock.calls.at(-1)![0].path).toContain('/v1/management/aftersales?');});
it('does not confuse returned stock, channel acceptance and verified refund success',async()=>{const p=await page(true);expect(p.normalize({...record,state:'refund_pending',refund:{submissionState:'accepted'},resolved:false}).label).toBe('退款处理中');expect(p.normalize({...record,resolved:true}).label).toBe('已退款');expect(p.selectActions({...record,state:'return_received',kind:'return_refund'})).toEqual([]);p.data.capabilities=['commerce.return.inspect'];expect(p.selectActions({...record,state:'return_received'})).toEqual([{action:'inspect_return',label:'记录质检结果'}]);});
it('uses the same key/payload after uncertainty and blocks duplicate submission',async()=>{const p=await page();p.selection=record.id;p.data.selected=record;p.data.available=[{action:'cancel',label:'撤回申请'}];p.data.note='原始合成说明';let reject!:(e:any)=>void;m.request.mockImplementationOnce(()=>new Promise((_,r)=>reject=r));const event={currentTarget:{dataset:{action:'cancel'}}};const write=p.submit(event);await Promise.resolve();await p.submit(event);reject({status:504});await write;const original=structuredClone(p.pending);p.data.note='不能替换原请求';m.request.mockResolvedValueOnce(record).mockResolvedValueOnce({items:[record],nextCursor:null}).mockResolvedValueOnce(record);await p.submit(event);const writes=m.request.mock.calls.map(([x])=>x).filter(x=>x.method==='POST');expect(writes).toHaveLength(2);for(const w of writes){expect(w.idempotencyKey).toBe(original.key);expect(w.data.note).toBe('原始合成说明');}});
it('clears private data and ignores late responses on hide',async()=>{const p=await page();let resolve!:(e:any)=>void;m.request.mockImplementationOnce(()=>new Promise(r=>resolve=r));p.data.note='合成私密说明';const load=p.load();p.onHide();resolve({items:[record],nextCursor:null});await load;expect(p.data.items).toEqual([]);expect(p.data.note).toBe('');expect(p.data.coreReady).toBe(false);});
it('requires fresh facts and explicit reconciliation after an interrupted request',async()=>{const p=await page();p.selection=record.id;p.data.selected=record;p.data.available=[{action:'cancel',label:'撤回申请'}];p.data.note='合成未确认操作';m.request.mockRejectedValueOnce({status:504});const event={currentTarget:{dataset:{action:'cancel'}}};await p.submit(event);await p.reconcile();expect(p.pending).not.toBeNull();expect(p.data.notice).toContain('刷新');p.onHide();expect(p.pending).toBeNull();expect(p.data.needsReconcile).toBe(true);await p.onShow();p.data.note='新的申请';await p.submit(event);expect(m.request.mock.calls.filter(([x])=>x.method==='POST')).toHaveLength(1);await p.reconcile();expect(p.data.needsReconcile).toBe(false);expect(p.data.note).toBe('');});
it('revocation and session change erase case contacts and pending text',async()=>{const p=await page(true);p.data.selected={...record,returnDestination:{phone:'synthetic'}};p.data.note='private';m.authority.mockResolvedValueOnce({version:1,managementAvailable:false,capabilities:[]});await p.recheck();expect(p.data.selected).toBeNull();expect(p.data.note).toBe('');expect(p.data.coreReady).toBe(false);const q=await page();token='changed';await q.recheck();expect(q.data.items).toEqual([]);expect(q.data.coreReady).toBe(false);});
it('does not write after a modal returns to a different account',async()=>{const p=await page();p.selection=record.id;p.data.selected=record;p.data.available=[{action:'cancel',label:'撤回申请'}];p.data.note='合成审批说明';(globalThis as any).wx.showModal=(o:any)=>{token='another';o.success({confirm:true});};await p.submit({currentTarget:{dataset:{action:'cancel'}}});expect(m.request.mock.calls.some(([x])=>x.method==='POST')).toBe(false);});
it('offers remaining-item application only after the current case closes',async()=>{
 const p=await page();(globalThis as any).getCurrentPages=()=>[{route:'pages/order-detail/index',data:{id:record.orderId}},{route:'pages/aftersale/index'}];
 expect(p.data.hasOpenCase).toBe(true);p.chooseOrderItems();expect((globalThis as any).wx.navigateBack).not.toHaveBeenCalled();
 m.request.mockResolvedValueOnce({items:[{...record,state:'cancelled'}],nextCursor:null});await p.load();
 expect(p.data.hasOpenCase).toBe(false);p.chooseOrderItems();expect((globalThis as any).wx.navigateBack).toHaveBeenCalledWith(expect.objectContaining({delta:1}));
 await p.submit({currentTarget:{dataset:{action:'request'}}});expect(m.request.mock.calls.some(([x])=>x.method==='POST')).toBe(false);
});
it('keeps the active-case guard when paging older cases',async()=>{
 m.request.mockResolvedValueOnce({items:[record],nextCursor:'older'});
 const p=await page();expect(p.data.hasOpenCase).toBe(true);
 m.request.mockResolvedValueOnce({items:[{...record,id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',state:'cancelled'}],nextCursor:null});
 await p.load(true);expect(p.data.hasOpenCase).toBe(true);
 p.chooseOrderItems();expect((globalThis as any).wx.redirectTo).not.toHaveBeenCalled();
});
it('opens this order in support and refreshes customer case progress without clearing a draft',async()=>{
 const p=await page();p.selection=record.id;p.data.selected={...record,supportConversationId:'conversation'};p.data.note='我的运单说明';
 p.openChat();expect((globalThis as any).wx.navigateTo).toHaveBeenCalledWith({url:`/pages/support/index?orderId=${record.orderId}`});
 m.request.mockResolvedValueOnce({...record,state:'awaiting_instruction',supportConversationId:'conversation'});
 await p.recheck();expect(p.data.selected.label).toBe('待客服发送退货指引');expect(p.data.note).toBe('我的运单说明');
});
it('registers the version actually used for an old valid return address and clears it on exit',async()=>{
 const p=await page();p.selection=record.id;
 const old={version:1,recipientName:'旧收件人',phone:'13800000000',region:'上海市',address:'合成旧地址',freightPayer:'merchant',instructions:''};
 const latest={...old,version:2,address:'合成新地址'};
 const detail={...record,kind:'return_refund',state:'awaiting_return',version:6,returnDestination:latest,returnInstructionHistory:[latest,old]};
 m.request.mockResolvedValueOnce({items:[detail],nextCursor:null}).mockResolvedValueOnce(detail);
 await p.load();expect(p.data.shipmentInstruction.version).toBe(2);
 p.chooseShipmentInstruction({detail:{value:'1'}});expect(p.data.shipmentInstruction.version).toBe(1);
 p.data.note='已按旧址寄出';p.data.carrier='合成物流';p.data.tracking='SYNTHETIC123456';
 m.request.mockResolvedValueOnce({...detail,state:'return_in_transit',version:7});
 await p.submit({currentTarget:{dataset:{action:'ship_return'}}});
 const write=m.request.mock.calls.map(([input])=>input).find(input=>input.method==='POST');
 expect(write.data).toMatchObject({action:'ship_return',instructionVersion:1,carrier:'合成物流',tracking:'SYNTHETIC123456'});
 p.onHide();expect(p.data.shipmentInstruction).toBeNull();
});
