import {beforeEach,expect,it,vi} from 'vitest';

const api=vi.hoisted(()=>({request:vi.fn(),downloadPrivateMedia:vi.fn()}));
const context=vi.hoisted(()=>({revision:0}));
vi.mock('../../apps/miniprogram/services/api',()=>({
 request:api.request,downloadPrivateMedia:api.downloadPrivateMedia,
 resumeAuthentication:vi.fn(),setSessionToken:vi.fn()
}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/orders',()=>({clientOperationKey:()=> 'synthetic-operation'}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>context.revision}));

let definition:any,app:any,wx:any;
const selection={requestId:'copy-101',partCount:101,partNumber:57,manifestPageNumber:2,manifestPageCount:2,exportId:'export-101'};
const record=(available=true)=>({id:'copy-101',kind:'access',message:'本人资料副本',status:'completed',version:3,
 replyHistory:[],execution:{scope:'member_portable_copy_v1',downloadAvailable:available,partCount:101}});
const manifest={schema:'cisme.member.portable.part-manifest.v1',requestId:'copy-101',exportId:'export-101',partCount:101,pageNumber:1,pageCount:2};
const firstPage={items:[{id:'recent',kind:'access',message:'近期请求',status:'received',replyHistory:[],execution:null}],nextCursor:'older'};
const event=(id='copy-101')=>({currentTarget:{dataset:{id}}});
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
async function page(){
 await import('../../apps/miniprogram/pages/privacy-rights/index');
 const view={...definition,data:structuredClone(definition.data),setData(patch:any){Object.assign(this.data,patch);}};
 view.identityToken='owner';view.data.authenticated=true;view.data.records=[record()];view.data.recordToken='owner';
 view.data.visibleParts={...selection};return view;
}
beforeEach(()=>{
 vi.resetModules();api.request.mockReset();api.downloadPrivateMedia.mockReset();
 context.revision=0;
 app={globalData:{sessionToken:'owner',privacyRightsToken:''}};
 wx={env:{USER_DATA_PATH:'/private'},getFileSystemManager:vi.fn(()=>({unlink:vi.fn()})),shareFileMessage:vi.fn(),
  showModal:vi.fn((options:any)=>options.success({confirm:true}))};
 vi.stubGlobal('getApp',()=>app);vi.stubGlobal('Page',(value:any)=>{definition=value;});vi.stubGlobal('wx',wx);
 api.request.mockImplementation(({path,method}:any)=>{
  if(method==='POST')return Promise.resolve({});
  if(path==='/v1/legal')return Promise.resolve({documents:[]});
  if(path==='/v1/me/privacy-requests?page=1')return Promise.resolve(firstPage);
  if(path==='/v1/me/privacy-requests?page=1&cursor=older')return Promise.resolve({items:[record()],nextCursor:null});
  if(path==='/v1/me/privacy-requests/copy-101/export/manifest-pages/1')return Promise.resolve(manifest);
  throw new Error(`Unexpected read: ${path}`);
 });
});

it('resumes a 101-part copy after WeChat hides the page during sharing and refreshes its later-page row',async()=>{
 const view=await page(),abort=vi.fn();
 view.data.records[0]={...view.data.records[0],message:'旧申请正文',responseSummary:'旧处理结论',
  replyHistory:[{version:4,actor:'operator',body:'旧处理回复'}],status:'responded',waitingOn:'member'};
 api.downloadPrivateMedia.mockReturnValue({promise:Promise.resolve('/private/part-57'),abort});
 wx.shareFileMessage.mockImplementation((options:any)=>{view.onHide();options.success();options.complete?.();});
 await view.sendPart();expect(view.data.visibleParts).toBeNull();expect(abort).toHaveBeenCalled();
 view.onShow();await vi.waitFor(()=>expect(view.data.visibleParts).toMatchObject(selection));
 expect(view.data.records.map((row:any)=>row.id)).toEqual(['recent','copy-101']);
 const placeholder=view.data.records[1];
 expect(placeholder).toMatchObject({resumePlaceholder:true,statusLabel:'记录详情待加载',replyHistory:[]});
 expect(JSON.stringify(placeholder)).not.toMatch(/旧申请正文|旧处理结论|旧处理回复/);
 expect(view.data.notice).toContain('继续获取');
 expect(api.request).toHaveBeenCalledWith({path:'/v1/me/privacy-requests/copy-101/export/manifest-pages/1'});
 api.request.mockImplementation(({path}:any)=>{
  if(path==='/v1/me/privacy-requests?page=1&cursor=older')return Promise.resolve({items:[
   {id:'middle',kind:'other',message:'稍早请求',status:'received',replyHistory:[],execution:null},record()],nextCursor:null});
  throw new Error(`Unexpected read: ${path}`);
 });
 await view.loadMore();
 expect(view.data.records.filter((row:any)=>row.id==='copy-101')).toHaveLength(1);
 expect(view.data.records.map((row:any)=>row.id)).toEqual(['recent','middle','copy-101']);
 expect(view.data.records[2]).toMatchObject({message:'本人资料副本',statusLabel:'已完成'});
 expect(view.data.records[2].resumePlaceholder).toBeUndefined();
 expect(view.data.visibleParts).toMatchObject({partNumber:57,manifestPageNumber:2});
});

it('does not show a resume row when the refreshed list has no older page for the request',async()=>{
 const view=await page();view.onHide();
 api.request.mockImplementation(({path}:any)=>{
  if(path==='/v1/legal')return Promise.resolve({documents:[]});
  if(path==='/v1/me/privacy-requests?page=1')return Promise.resolve({...firstPage,nextCursor:null});
  if(path==='/v1/me/privacy-requests/copy-101/export/manifest-pages/1')return Promise.resolve(manifest);
  throw new Error(`Unexpected read: ${path}`);
 });
 view.onShow();await vi.waitFor(()=>expect(view.hiddenParts).toBeNull());
 expect(view.data.visibleParts).toBeNull();
 expect(view.data.records.map((row:any)=>row.id)).toEqual(['recent']);
 expect(view.data.notice).toContain('未找到');
});

it('removes the resume item if the final later page does not contain its request',async()=>{
 const view=await page();view.onHide();view.onShow();
 await vi.waitFor(()=>expect(view.data.visibleParts).toMatchObject(selection));
 api.request.mockImplementation(({path}:any)=>{
  if(path==='/v1/me/privacy-requests?page=1&cursor=older')return Promise.resolve({items:[
   {id:'middle',kind:'other',message:'稍早请求',status:'received',replyHistory:[],execution:null}],nextCursor:null});
  throw new Error(`Unexpected read: ${path}`);
 });
 await view.loadMore();
 expect(view.data.records.map((row:any)=>row.id)).toEqual(['recent','middle']);
 expect(view.data.visibleParts).toBeNull();
 expect(view.data.notice).toContain('未找到');
});

it('never restores another account’s selection or reads its export',async()=>{
 const view=await page();view.onHide();app.globalData.sessionToken='other';
 view.onShow();await flush();
 expect(view.data.visibleParts).toBeNull();expect(view.hiddenParts).toBeNull();
 expect(view.data.records.map((row:any)=>row.id)).toEqual(['recent']);
 expect(api.request.mock.calls.some(([options])=>options.path?.endsWith('/copy-101/export/manifest-pages/1'))).toBe(false);
});

it('does not restore an A-to-B-to-A session even when the final token string matches',async()=>{
 const view=await page();view.onHide();context.revision+=2;
 view.onShow();await flush();
 expect(view.data.visibleParts).toBeNull();expect(view.hiddenParts).toBeNull();
 expect(api.request.mock.calls.some(([options])=>options.path?.endsWith('/copy-101/export/manifest-pages/1'))).toBe(false);
});

it.each([401,403])('clears the saved position when the request list denies access with %i',async(status)=>{
 const view=await page();view.onHide();
 api.request.mockImplementation(({path}:any)=>path==='/v1/legal'?Promise.resolve({documents:[]}):Promise.reject({status}));
 view.onShow();await flush();
 expect(view.data.records).toEqual([]);expect(view.data.visibleParts).toBeNull();expect(view.hiddenParts).toBeNull();
});

it('drops an expired or revoked position before presenting controls',async()=>{
 const view=await page();view.onHide();
 api.request.mockImplementation(({path}:any)=>{
  if(path==='/v1/legal')return Promise.resolve({documents:[]});
  if(path==='/v1/me/privacy-requests?page=1')return Promise.resolve({items:[record(false)],nextCursor:null});
  throw new Error(`Unexpected read: ${path}`);
 });
 view.onShow();await flush();
 expect(view.data.visibleParts).toBeNull();expect(view.hiddenParts).toBeNull();
 expect(api.request.mock.calls.some(([options])=>options.path?.endsWith('/copy-101/export/manifest-pages/1'))).toBe(false);
});

it('drops a later-page position when the export itself has expired',async()=>{
 const view=await page();view.onHide();
 api.request.mockImplementation(({path}:any)=>{
  if(path==='/v1/legal')return Promise.resolve({documents:[]});
  if(path==='/v1/me/privacy-requests?page=1')return Promise.resolve(firstPage);
  if(path==='/v1/me/privacy-requests/copy-101/export/manifest-pages/1')return Promise.reject({status:404});
  throw new Error(`Unexpected read: ${path}`);
 });
 view.onShow();await vi.waitFor(()=>expect(view.hiddenParts).toBeNull());
 expect(view.data.visibleParts).toBeNull();expect(view.data.records.map((row:any)=>row.id)).toEqual(['recent']);
});

it('does not reuse an old position after the export is regenerated',async()=>{
 const view=await page();view.onHide();
 api.request.mockImplementation(({path}:any)=>{
  if(path==='/v1/legal')return Promise.resolve({documents:[]});
  if(path==='/v1/me/privacy-requests?page=1')return Promise.resolve(firstPage);
  if(path==='/v1/me/privacy-requests/copy-101/export/manifest-pages/1')return Promise.resolve({...manifest,exportId:'new-export'});
  throw new Error(`Unexpected read: ${path}`);
 });
 view.onShow();await vi.waitFor(()=>expect(view.hiddenParts).toBeNull());
 expect(view.data.visibleParts).toBeNull();expect(view.data.notice).toContain('最新清单');
});

it('clears a resumed older copy when its refreshed page reports revocation',async()=>{
 const view=await page();view.onHide();view.onShow();
 await vi.waitFor(()=>expect(view.data.visibleParts).toMatchObject(selection));
 api.request.mockImplementation(({path}:any)=>{
  if(path==='/v1/me/privacy-requests?page=1&cursor=older')return Promise.resolve({items:[record(false)],nextCursor:null});
  throw new Error(`Unexpected read: ${path}`);
 });
 await view.loadMore();
 expect(view.data.visibleParts).toBeNull();expect(view.data.records.find((row:any)=>row.id==='copy-101').execution.downloadAvailable).toBe(false);
});

it('removes active controls immediately after a confirmed revocation',async()=>{
 const view=await page();
 api.request.mockImplementation(({path,method}:any)=>{
  if(method==='POST'&&path.endsWith('/export-revoke'))return Promise.resolve({});
  if(path==='/v1/me/privacy-requests?page=1')return Promise.resolve({items:[record(false)],nextCursor:null});
  throw new Error(`Unexpected read: ${path}`);
 });
 await view.revokeExport(event());
 expect(view.data.visibleParts).toBeNull();expect(view.hiddenParts).toBeNull();
 expect(view.data.records[0].execution.downloadAvailable).toBe(false);
});

it('hides the selected copy while an uncertain revocation is reconciled',async()=>{
 const view=await page();api.request.mockRejectedValue({status:504});
 await view.revokeExport(event());
 expect(view.data.visibleParts).toBeNull();expect(view.data.error).toContain('刷新记录');
});

it('does not revive a stale export result after an account change',async()=>{
 const view=await page();view.onHide();let resolve!:(value:any)=>void;
 api.request.mockImplementation(({path}:any)=>{
  if(path==='/v1/legal')return Promise.resolve({documents:[]});
  if(path==='/v1/me/privacy-requests?page=1')return Promise.resolve(firstPage);
  if(path==='/v1/me/privacy-requests/copy-101/export/manifest-pages/1')return new Promise(done=>{resolve=done;});
  throw new Error(`Unexpected read: ${path}`);
 });
 view.onShow();await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));
 app.globalData.sessionToken='other';view.onHide();view.onShow();
 resolve(manifest);await flush();
 expect(view.data.visibleParts).toBeNull();expect(view.hiddenParts).toBeNull();
});
