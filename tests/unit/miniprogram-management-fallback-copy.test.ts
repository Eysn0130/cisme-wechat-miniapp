import {readFileSync} from 'node:fs';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const requestMock=vi.hoisted(()=>vi.fn());
vi.mock('../../apps/miniprogram/services/api',()=>({
 request:requestMock,retainMemberSnapshot:()=>true,
 downloadPrivateMedia:()=>({promise:Promise.resolve('/synthetic-image'),abort:vi.fn()})
}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));

type Definition=Record<string,any>&{data:Record<string,any>};
let definition:Definition,session:string;
const supportAuthority={version:1,managementAvailable:true,capabilities:['support.read']};
const memberAuthority={version:1,managementAvailable:true,capabilities:['member.profile.read']};
const noAuthority={version:1,managementAvailable:false,capabilities:[]};
const emptyMembers={items:[],summary:{all:0,members:0,ordinary:0},matchingTotal:0,loadedCount:0,nextCursor:null};
const readyThread={conversation:{id:'synthetic-chat',status:'waiting_human',version:1},messages:[],latestCursor:0,assignedToMe:false};
function deferred<T=any>(){let resolve!:(value:T)=>void,reject!:(reason?:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function mount(overrides:Record<string,any>={},fields:Record<string,any>={}){
 return{...definition,data:{...structuredClone(definition.data),...overrides},...fields,
  setData(patch:Record<string,any>,callback?:()=>void){Object.assign(this.data,patch);callback?.();}}as any;
}
async function chat(overrides:Record<string,any>={}){
 await import('../../apps/miniprogram/pages/management-support-chat/index');
 const page=mount({id:'synthetic-chat',...overrides});
 page.startPolling=vi.fn();page.measureActions=vi.fn();return page;
}
async function members(overrides:Record<string,any>={}){
 await import('../../apps/miniprogram/pages/management-members/index');
 return mount(overrides,{lastToken:session,lastRevision:0});
}
function supportRead(path:string){
 if(path==='/v1/me/authority')return Promise.resolve(supportAuthority);
 if(path==='/v1/management/support/ai/status')return Promise.resolve({providerAvailable:false});
 if(path==='/v1/management/support/conversations/synthetic-chat/messages')return Promise.resolve(readyThread);
 return Promise.reject(new Error('unexpected request'));
}

beforeEach(()=>{
 vi.resetModules();requestMock.mockReset();session='synthetic-operator';
 requestMock.mockRejectedValue(new Error('unexpected request'));
 (globalThis as any).Page=(page:Definition)=>{definition=page;};
 (globalThis as any).getApp=()=>({globalData:{sessionToken:session}});
 (globalThis as any).wx={nextTick:(callback:()=>void)=>callback(),navigateTo:vi.fn(),navigateBack:vi.fn(),switchTab:vi.fn()};
});

describe('management fallback states describe verified facts',()=>{
 it('clears the loading header and previous name when support permission is denied',async()=>{
  requestMock.mockResolvedValue(noAuthority);
  const page=await chat({memberDisplayName:'previous private name',statusLabel:'正在加载',messages:[{id:'private'}],canReply:true});
  await page.onShow();
  expect(page.data).toMatchObject({loading:false,statusLabel:'',statusTone:'neutral',memberDisplayName:'CISME 会员',messages:[],canReply:false,visible:false});
  expect(page.data.error).toContain('没有客服访问权限');
  expect(requestMock.mock.calls.map(([o])=>o.path)).toEqual(['/v1/me/authority']);
 });
 it('ends a failed authority read without a false loading label, then retries the actual reads',async()=>{
  requestMock.mockRejectedValueOnce(new Error('offline'));
  const page=await chat();await page.onShow();
  expect(page.data).toMatchObject({loading:false,statusLabel:'',conversation:null});
  expect(page.data.error).toContain('请重试');
  requestMock.mockImplementation(({path}:{path:string})=>supportRead(path));
  await page.retry();
  expect(page.data).toMatchObject({loading:false,statusLabel:'等待接管',error:'',conversation:readyThread.conversation});
  expect(requestMock.mock.calls.filter(([o])=>o.path==='/v1/me/authority')).toHaveLength(2);
 });
 it('does not claim to load a missing conversation',async()=>{
  requestMock.mockImplementation(({path}:{path:string})=>supportRead(path));
  const page=await chat({id:''});await page.onShow();
  expect(page.data).toMatchObject({loading:false,statusLabel:'',conversation:null});
  expect(page.data.error).toContain('未找到这次会话');
  expect(requestMock.mock.calls.some(([o])=>o.path.includes('/conversations/'))).toBe(false);
 });
 it('shows loading only during a pending retry and restores the real conversation status',async()=>{
  let failed=true;const pending=deferred();
  requestMock.mockImplementation(({path}:{path:string})=>path.includes('/messages')?(failed?Promise.reject(new Error('offline')):pending.promise):supportRead(path));
  const page=await chat();await page.onShow();
  expect(page.data).toMatchObject({loading:false,statusLabel:''});expect(page.data.error).toContain('重试');
  failed=false;const retry=page.retry();await vi.waitFor(()=>expect(requestMock.mock.calls.filter(([o])=>o.path.includes('/messages'))).toHaveLength(2));
  expect(page.data).toMatchObject({loading:true,statusLabel:'正在加载',error:''});
  pending.resolve(readyThread);await retry;
  expect(page.data).toMatchObject({loading:false,statusLabel:'等待接管',error:''});
 });
 it('does not apply a late failed thread read after the page hides',async()=>{
  const pending=deferred();requestMock.mockImplementation(({path}:{path:string})=>path.includes('/messages')?pending.promise:supportRead(path));
  const page=await chat();const loading=page.onShow();await vi.waitFor(()=>expect(requestMock.mock.calls.some(([o])=>o.path.includes('/messages'))).toBe(true));
  page.onHide();const state={loading:page.data.loading,statusLabel:page.data.statusLabel,error:page.data.error};
  pending.reject(new Error('late offline'));await loading;
  expect(page.data).toMatchObject(state);expect(page.data.visible).toBe(false);
 });
 it('ignores an older failed epoch after a fresh show has loaded the conversation',async()=>{
  const pending=deferred();let reads=0;
  requestMock.mockImplementation(({path}:{path:string})=>path.includes('/messages')&&++reads===1?pending.promise:supportRead(path));
  const page=await chat();const old=page.onShow();await vi.waitFor(()=>expect(reads).toBe(1));
  await page.onShow();expect(page.data.statusLabel).toBe('等待接管');
  pending.reject(new Error('old epoch failure'));await old;
  expect(page.data).toMatchObject({loading:false,statusLabel:'等待接管',error:''});
 });
 it('renders the status dot only when a status label exists',()=>{
  const template=readFileSync(new URL('../../apps/miniprogram/pages/management-support-chat/index.wxml',import.meta.url),'utf8');
  expect(template).toMatch(/<view\s+wx:if="\{\{statusLabel\}\}"\s+class="operator-status/);
 });
 it('keeps unverified member totals hidden through the authority check',async()=>{
  const pending=deferred();requestMock.mockReturnValue(pending.promise);
  const page=await members({membersLoaded:true,summary:{all:99,members:99,ordinary:0}});
  const loading=page.load();
  expect(page.data).toMatchObject({loading:true,membersLoaded:false});
  pending.resolve(noAuthority);await loading;
  expect(page.data).toMatchObject({loading:false,membersLoaded:false,items:[]});
  expect(page.data.error).toContain('会员管理权限');
  expect(requestMock.mock.calls.map(([o])=>o.path)).toEqual(['/v1/me/authority']);
 });
 it('does not turn an authority network failure into a zero-member result',async()=>{
  requestMock.mockRejectedValue(new Error('offline'));const page=await members();await page.load();
  expect(page.data).toMatchObject({loading:false,membersLoaded:false});expect(page.data.error).toContain('权限');
 });
 it('displays a genuine successful zero-member summary and empty result',async()=>{
  requestMock.mockImplementation(({path}:{path:string})=>Promise.resolve(path==='/v1/me/authority'?memberAuthority:emptyMembers));
  const page=await members();await page.load();
  expect(page.data).toMatchObject({loading:false,membersLoaded:true,error:'',summary:{all:0,members:0,ordinary:0},items:[],matchingTotal:0,loadedCount:0});
 });
 it('hides the previous summary if the authorized data read fails, and recovers on retry',async()=>{
  let failed=true;
  requestMock.mockImplementation(({path}:{path:string})=>path==='/v1/me/authority'?Promise.resolve(memberAuthority):failed?Promise.reject(new Error('offline')):Promise.resolve({...emptyMembers,summary:{all:7,members:2,ordinary:5}}));
  const page=await members({membersLoaded:true,summary:{all:99,members:99,ordinary:0}});await page.load();
  expect(page.data).toMatchObject({loading:false,membersLoaded:false});expect(page.data.error).toContain('暂未加载');
  failed=false;await page.load();
  expect(page.data).toMatchObject({loading:false,membersLoaded:true,error:'',summary:{all:7,members:2,ordinary:5}});
 });
 it('resets a loaded summary synchronously on return before new authority arrives',async()=>{
  const pending=deferred();requestMock.mockReturnValue(pending.promise);
  const page=await members({membersLoaded:true,summary:{all:99,members:1,ordinary:98}});page.onShow();
  expect(page.data).toMatchObject({loading:true,membersLoaded:false});
  pending.resolve(noAuthority);await vi.waitFor(()=>expect(page.data.loading).toBe(false));
  expect(page.data.membersLoaded).toBe(false);
 });
 it('rejects member data that returns after hide without marking the summary as loaded',async()=>{
  const pending=deferred();requestMock.mockImplementation(({path}:{path:string})=>path==='/v1/me/authority'?Promise.resolve(memberAuthority):pending.promise);
  const page=await members();const loading=page.load();await vi.waitFor(()=>expect(requestMock.mock.calls).toHaveLength(2));
  page.onHide();pending.resolve({...emptyMembers,summary:{all:77,members:77,ordinary:0}});await loading;
  expect(page.data.membersLoaded).toBe(false);expect(page.data.summary.all).toBe(0);
 });
 it('rejects a previous account response instead of confirming its summary',async()=>{
  const pending=deferred();requestMock.mockImplementation(({path}:{path:string})=>path==='/v1/me/authority'?Promise.resolve(memberAuthority):pending.promise);
  const page=await members();const loading=page.load();await vi.waitFor(()=>expect(requestMock.mock.calls).toHaveLength(2));
  session='synthetic-other-operator';pending.resolve({...emptyMembers,summary:{all:77,members:77,ordinary:0}});await loading;
  expect(page.data.membersLoaded).toBe(false);expect(page.data.summary.all).toBe(0);
 });
 it('does not replace a new search summary with a late previous search result',async()=>{
  const pending=deferred();let reads=0;
  requestMock.mockImplementation(({path}:{path:string})=>path==='/v1/me/authority'?Promise.resolve(memberAuthority):++reads===1?pending.promise:Promise.resolve({...emptyMembers,summary:{all:3,members:1,ordinary:2}}));
  const page=await members({q:'old'});const old=page.load();await vi.waitFor(()=>expect(reads).toBe(1));
  page.setData({q:'new'});await page.load();pending.resolve({...emptyMembers,summary:{all:99,members:99,ordinary:0}});await old;
  expect(page.data).toMatchObject({membersLoaded:true,appliedQuery:'new',summary:{all:3,members:1,ordinary:2}});
 });
 it('wires summary visibility to a completed successful read',()=>{
  const template=readFileSync(new URL('../../apps/miniprogram/pages/management-members/index.wxml',import.meta.url),'utf8');
  expect(template).toMatch(/<view\s+wx:if="\{\{membersLoaded && !loading && !error\}\}"\s+class="members-summary"/);
 });
});
