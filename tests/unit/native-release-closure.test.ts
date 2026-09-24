import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../apps/miniprogram/services/api', () => ({
  request, resumeAuthentication: vi.fn(), setSessionToken: vi.fn(),
  clearAuthenticationRedirectSuppression: vi.fn(), requireMemberAccess: () => true,
  retainMemberSnapshot: () => true
}));
vi.mock('../../apps/miniprogram/services/layout', () => ({currentChromeStyle: () => ''}));
vi.mock('../../apps/miniprogram/services/orders', () => ({
  clientOperationKey: (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2)}`,
  myOrders: vi.fn()
}));
let definition: any;
let state: any;
let wx: any;
function page(overrides: Record<string, unknown> = {}) {
  return {...definition, data: {...definition.data, authenticated: true, alive: true, ...overrides},
    setData(patch: Record<string, unknown>) {Object.assign(this.data, patch);}};
}
function deferred<T>() {let resolve!: (value:T)=>void; const promise=new Promise<T>(done=>{resolve=done;}); return {promise,resolve};}
const event=(id:string)=>({currentTarget:{dataset:{id}}});
beforeEach(()=>{
  vi.resetModules(); request.mockReset(); state={globalData:{sessionToken:'owner'}};
  wx={showModal:vi.fn((options:any)=>options.success({confirm:true})),
    env:{USER_DATA_PATH:'/private'},getFileSystemManager:vi.fn(),shareFileMessage:vi.fn()};
  vi.stubGlobal('Page',(value:any)=>{definition=value;});vi.stubGlobal('getApp',()=>state);vi.stubGlobal('wx',wx);
});

it('does not let reading an old copy take ownership from a pending privacy submission',async()=>{
  await import('../../apps/miniprogram/pages/privacy-rights/index');
  const view=page({message:'获取我的资料',records:[{id:'copy',execution:{scope:'member_profile_only',downloadAvailable:true}}]});
  const write=deferred<any>();
  request.mockImplementation(({method}:any)=>method==='POST'?write.promise:Promise.resolve({items:[],nextCursor:null}));
  const pending=view.submit(); expect(view.data.busy).toBe(true);
  await view.viewExport(event('copy'));
  expect(request).toHaveBeenCalledTimes(1);
  write.resolve({status:'approved'});await pending;
  expect(view.data.busy).toBe(false);expect(view.data.notice).toContain('已受理');
});

it('serializes export retries with a member reply without discarding its acknowledgement',async()=>{
  await import('../../apps/miniprogram/pages/privacy-rights/index');
  const view=page({replyFor:'reply',replyDraft:'补充的本人说明',records:[
    {id:'reply',status:'responded',waitingOn:'member',version:3},
    {id:'retry',status:'failed',execution:{scope:'member_portable_copy_v1'}}]});
  const write=deferred<any>();request.mockImplementation(({method}:any)=>method==='POST'?write.promise:Promise.resolve({items:[],nextCursor:null}));
  const pending=view.sendReply();expect(view.data.replyBusy).toBe(true);
  // Baseline awaited a second POST and changed operationAttempt. Do not await
  // it until the shared promise is resolved, so the regression cannot hang.
  const retry=view.retryExport(event('retry'));
  expect(request).toHaveBeenCalledTimes(1);
  write.resolve({});await Promise.all([pending,retry]);expect(view.data.replyBusy).toBe(false);
});

it('retains the current owner records during refresh and on a recoverable network failure',async()=>{
  await import('../../apps/miniprogram/pages/privacy-rights/index');
  const view=page({records:[{id:'existing'}],recordToken:'owner'});
  const read=deferred<any>();request.mockReturnValueOnce(read.promise);
  const pending=view.load();expect(view.data.records).toEqual([{id:'existing'}]);
  read.resolve({items:[{id:'updated',kind:'access',status:'approved'}],nextCursor:null});await pending;
  request.mockRejectedValueOnce(new Error('offline'));await view.load();
  expect(view.data.records[0].id).toBe('updated');expect(view.data.error).not.toBe('');
});

it('does not equate paid with unfulfilled or expose unknown order codes',async()=>{
  await import('../../apps/miniprogram/pages/orders/index');
  const view=page();
  const rows=view.normalize(['paid','new_unrecognized'].map(status=>({status,totalCents:1,createdAt:'2026-09-23T00:00:00Z',lines:[]})));
  expect(rows[0].statusLabel).toBe('已付款');expect(rows[1].statusLabel).toBe('状态更新中');
});

it('does not publish a fixed payment-closed claim on browsing and order pages',()=>{
  for(const name of ['shop','orders']){
    const text=readFileSync(`apps/miniprogram/pages/${name}/index.wxml`,'utf8');
    expect(text).not.toMatch(/微信支付尚未开放|正式支付尚未开放|交易尚未开放|已完成资质确认/);
  }
});

it('clears retained private records if an outstanding refresh returns after an identity change',async()=>{
  await import('../../apps/miniprogram/pages/privacy-rights/index');
  const view=page({records:[{id:'private-owner-record'}],recordToken:'owner'});
  const read=deferred<any>();request.mockReturnValueOnce(read.promise);
  const pending=view.load();state.globalData.sessionToken='other';
  read.resolve({items:[{id:'private-owner-record'}],nextCursor:null});await pending;
  expect(view.data.records).toEqual([]);expect(view.data.loading).toBe(false);
});

it('does not retain private records after an explicit access denial',async()=>{
  await import('../../apps/miniprogram/pages/privacy-rights/index');
  const view=page({records:[{id:'private-owner-record'}],recordToken:'owner'});
  request.mockRejectedValueOnce({status:403});await view.load();expect(view.data.records).toEqual([]);
});

it('a late export write cannot unlink the newer export after a hide and return',async()=>{
  await import('../../apps/miniprogram/pages/privacy-rights/index');
  const rows=[{id:'copy-a',execution:{scope:'member_portable_copy_v1',downloadAvailable:true}},
    {id:'copy-b',execution:{scope:'member_portable_copy_v1',downloadAvailable:true}}];
  const view=page({records:rows});
  const writes:any[]=[],shares:any[]=[],unlink=vi.fn();
  wx.getFileSystemManager.mockReturnValue({writeFile:(options:any)=>writes.push(options),unlink});
  wx.shareFileMessage.mockImplementation((options:any)=>shares.push(options));
  request.mockResolvedValue({schema:'cisme.member.portable.v1',sections:{account:{id:'owner'}}});
  const first=view.viewExport(event('copy-a'));await Promise.resolve();await Promise.resolve();
  view.onHide();view.setData({alive:true,records:rows});
  const second=view.viewExport(event('copy-b'));await Promise.resolve();await Promise.resolve();
  expect(writes).toHaveLength(2);expect(writes[0].filePath).not.toBe(writes[1].filePath);
  writes[1].success();await Promise.resolve();await Promise.resolve();
  writes[0].success();await first;
  expect(unlink).toHaveBeenCalledWith(expect.objectContaining({filePath:writes[0].filePath}));
  expect(unlink).not.toHaveBeenCalledWith(expect.objectContaining({filePath:writes[1].filePath}));
  shares[0].success();shares[0].complete();await second;
});

it('removes only abandoned private-copy files on page creation',async()=>{
  await import('../../apps/miniprogram/pages/privacy-rights/index');
  const unlink=vi.fn();wx.getFileSystemManager.mockReturnValue({unlink,readdir:(options:any)=>options.success({files:[
    'cisme-private-data-copy-old-123.json','other-order.json','cisme-private-data-copy-not-a-file.txt']})});
  page().onLoad();
  expect(unlink).toHaveBeenCalledWith(expect.objectContaining({filePath:'/private/cisme-private-data-copy-old-123.json'}));
  expect(unlink).not.toHaveBeenCalledWith(expect.objectContaining({filePath:'/private/other-order.json'}));
});
