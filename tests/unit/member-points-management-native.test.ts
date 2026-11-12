import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {clubRulesV1} from '../../services/api/src/pointsLedger';
const m=vi.hoisted(()=>({token:'member-a',retain:true,request:vi.fn(),authority:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,requireMemberAccess:()=>Boolean(m.token),retainMemberSnapshot:()=>m.retain}));
vi.mock('../../apps/miniprogram/services/authority',()=>({authorityProjection:m.authority,hasCapability:(p:any,c:string)=>p.capabilities.includes(c)}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/orders',()=>({clientOperationKey:()=> 'synthetic-management-operation'}));
let page:any,definition:any;
const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
const result=()=>({offers:[{productId:'product',productVersion:2,name:'护理产品',label:'规格',shoppingPointsMultiplier:3,publicationStatus:'published'}],reconciliation:[],policies:[{version:'club-fixture',state:'active',starts_at:'2026-11-10T00:00:00Z',rules:clubRulesV1}],defaultRules:clubRulesV1});
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();m.token='member-a';m.retain=true;
 vi.stubGlobal('getApp',()=>({globalData:{get sessionToken(){return m.token;}}}));vi.stubGlobal('wx',{navigateBack:vi.fn(),redirectTo:vi.fn(),showModal:vi.fn()});
 vi.stubGlobal('Page',(p:any)=>{definition=p;});m.authority.mockResolvedValue({version:1,capabilities:['commerce.product.manage'],managementAvailable:true});m.request.mockResolvedValue(result());
 await import('../../apps/miniprogram/pages/management-points/index');page={...definition,data:structuredClone(definition.data),setData(v:any){Object.assign(this.data,v);}};
});
afterEach(()=>vi.unstubAllGlobals());
it('opens only currently granted sections and presents operator states with explicit Beijing time',async()=>{
 page.onShow();await flush();expect(page.data).toMatchObject({canProduct:true,canPolicy:false,canFulfill:false,canFeature:false});
 expect(page.data.offers[0].publicationLabel).toBe('已上架');expect(page.data.policies[0]).toMatchObject({stateLabel:'生效版本',startsLabel:'2026-11-10 08:00（北京时间）'});
});
it('recovers from a write interrupted by hide and prevents the old account response from changing a new account view',async()=>{
 page.onShow();await flush();let resolve!:(r:unknown)=>void;const pending=new Promise(r=>resolve=r);const read=m.request.getMockImplementation();
 m.request.mockImplementation((o:any)=>o.method==='PUT'?pending:read?read(o):Promise.resolve(result()));
 const write=page.command('/v1/management/points/products/product/multiplier',{expectedVersion:2,multiplier:1,reason:'合成原账号提交依据'},'PUT');await flush();expect(page.data.busy).toBe(true);
 page.setData({featureReason:'上一账号内部依据',postId:'old-post'});page.onHide();m.token='member-b';m.retain=false;page.onShow();await flush();
 expect(page.data).toMatchObject({busy:false,featureReason:'',postId:'',notice:''});resolve({version:3});await write;await flush();expect(page.data.notice).toBe('');expect(page.token).toBe('member-b');
});
it('clears retained operator data when the session is lost without issuing an authority read',async()=>{
 page.onShow();await flush();m.authority.mockClear();m.token='';m.retain=false;page.onShow();await flush();expect(page.data.authority).toBeNull();expect(page.data.offers).toEqual([]);expect(m.authority).not.toHaveBeenCalled();
});
it('retries an unknown fulfillment result with the original key and exact payload, blocking a different command',async()=>{
 page.onShow();await flush();let writes=0;
 m.request.mockImplementation(async(o:any)=>{if(o.method){writes++;if(writes===1)throw {status:504};return {version:3};}return result();});
 const path='/v1/management/points/redemptions/gift/ship',input={expectedVersion:2,carrierName:'合成快递',trackingNumber:'QA12345678',reason:'合成真实交寄核对'};
 await page.command(path,input);expect(page.data.commandPending).toBe(true);expect(page.data.busy).toBe(false);
 await page.command(path,{...input,trackingNumber:'QA87654321'});expect(writes).toBe(1);
 page.retryCommand();await flush();
 const requests=m.request.mock.calls.map(([o])=>o).filter(o=>o.method);
 expect(requests).toHaveLength(2);expect(requests[1]).toMatchObject({path,idempotencyKey:requests[0].idempotencyKey,data:input});
 expect(page.pendingCommand).toBeNull();expect(page.data.commandPending).toBe(false);
});
it('keeps an unknown command on same-account hide, clears it on a different account and revokes private data on 403',async()=>{
 page.onShow();await flush();m.request.mockRejectedValue({status:504});await page.command('/synthetic',{reason:'合成操作依据'});
 const key=page.pendingCommand.key;page.onHide();m.request.mockResolvedValue(result());page.onShow();await flush();expect(page.pendingCommand.key).toBe(key);
 page.onHide();m.token='member-b';page.onShow();await flush();expect(page.pendingCommand).toBeNull();expect(page.data.commandPending).toBe(false);
 m.request.mockRejectedValue({status:403,title:'权限已撤销'});await page.command('/synthetic',{reason:'合成新操作依据'});
 expect(page.pendingCommand).toBeNull();expect(page.data).toMatchObject({authority:null,items:[],offers:[],policies:[],canProduct:false});
});
it('does not hide an active write behind a concurrent refresh',async()=>{
 page.onShow();await flush();let finish!:(v:any)=>void;m.request.mockImplementation((o:any)=>o.method?new Promise(r=>finish=r):Promise.resolve(result()));
 const work=page.command('/synthetic',{reason:'合成刷新竞争'});const epoch=page.epoch;await page.load();expect(page.epoch).toBe(epoch);expect(page.data.busy).toBe(true);finish({});await work;expect(page.data.busy).toBe(false);
});
