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
