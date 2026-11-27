import {beforeEach,describe,expect,it,vi} from 'vitest';
const api=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:api.request,downloadPrivateMedia:vi.fn(),resumeAuthentication:vi.fn(),setSessionToken:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>0}));
vi.mock('../../apps/miniprogram/services/orders',()=>({clientOperationKey:()=> 'synthetic-operation'}));
let definition:any,app:any;
const doc=(document_type:string)=>({document_type,title:document_type+' title',version:'v1',body:'# '+document_type+' title\n\n'+document_type+' body'});
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
async function page(kind:'legal'|'privacy-rights'){
 if(kind==='legal')await import('../../apps/miniprogram/pages/legal/index');
 else await import('../../apps/miniprogram/pages/privacy-rights/index');
 return {...definition,data:structuredClone(definition.data),setData(patch:any){Object.assign(this.data,patch);}};
}
beforeEach(()=>{
 vi.resetModules();api.request.mockReset();app={globalData:{sessionToken:'synthetic-member',privacyRightsToken:''}};
 vi.stubGlobal('Page',(value:any)=>{definition=value;});vi.stubGlobal('getApp',()=>app);
 vi.stubGlobal('wx',{pageScrollTo:vi.fn(),showModal:vi.fn((o:any)=>o.success({confirm:false})),navigateBack:vi.fn(),switchTab:vi.fn()});
});
describe('settings legal reader',()=>{
 it('makes both named documents reachable and resets the reading position when switching',async()=>{
  api.request.mockResolvedValue({ready:true,documents:[doc('privacy'),doc('terms')]});
  const p=await page('legal');p.onLoad({type:'privacy'});await flush();
  expect(p.data.documentTabs.map((v:any)=>v.id)).toEqual(['privacy','terms']);
  await p.changeDocument({detail:{value:'terms'}});await flush();
  expect(p.data.type).toBe('terms');expect(p.data.legalDoc.document_type).toBe('terms');
  expect(p.data.legalBlocks.map((v:any)=>v.text).join(' ')).toContain('terms body');
  expect(wx.pageScrollTo).toHaveBeenCalledWith({scrollTop:0,duration:0});
 });
 it('rejects an older document response after a different document was selected',async()=>{
  let finish!:(value:any)=>void;api.request.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const p=await page('legal');p.onLoad({type:'privacy'});
  api.request.mockResolvedValueOnce({ready:true,documents:[doc('terms')]});
  await p.changeDocument({detail:{value:'terms'}});
  finish({ready:true,documents:[doc('privacy')]});await flush();
  expect(p.data.legalDoc.document_type).toBe('terms');expect(p.data.loading).toBe(false);
 });
 it('only exposes optional cross-border text when published and does not substitute another document for a missing one',async()=>{
  api.request.mockResolvedValue({ready:true,documents:[doc('privacy'),doc('cross_border')]});
  const p=await page('legal');p.onLoad({type:'privacy'});await flush();
  expect(p.data.documentTabs.map((v:any)=>v.id)).toContain('cross_border');
  await p.changeDocument({detail:{value:'terms'}});
  expect(p.data.legalDoc).toBeNull();expect(p.data.error).toContain('暂不可用');
  const reads=api.request.mock.calls.length;await p.changeDocument({detail:{value:'unknown'}});
  expect(api.request.mock.calls).toHaveLength(reads);
 });
});
describe('settings personal data requests',()=>{
 it('distinguishes a failed consent read from a confirmed empty list, and permits an explicit retry',async()=>{
  const p=await page('privacy-rights');p.data.authenticated=true;p.data.message='保留的申请说明';
  api.request.mockRejectedValueOnce(Error('offline'));await p.loadConsents();
  expect(p.data.consentsReady).toBe(false);expect(p.data.consentsError).toContain('重试');
  expect(p.data.message).toBe('保留的申请说明');
  p.data.submitError='请填写申请说明。';api.request.mockResolvedValueOnce([]);await p.loadConsents();
  expect(p.data.consentsReady).toBe(true);expect(p.data.consentsError).toBe('');expect(p.data.submitError).toBe('');expect(p.data.consentGrants).toEqual([]);
 });
 it('discards a late consent result on hide and on identity change',async()=>{
  const p=await page('privacy-rights');let finish!:(value:any)=>void;
  api.request.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const read=p.loadConsents();p.onHide();finish([]);await read;
  expect(p.data.consentsReady).toBe(false);expect(p.data.consentsError).toBe('');
  p.data.alive=true;api.request.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const second=p.loadConsents();app.globalData.sessionToken='another-member';finish([]);await second;
  expect(p.data.consentsReady).toBe(false);
 });
 it('keeps drafts while clearing obsolete feedback after changing the request kind',async()=>{
  const p=await page('privacy-rights');p.data.message='未提交的说明';p.data.error='旧错误';p.data.submitError='旧表单错误';
  p.choose({detail:{value:'1'}});
  expect(p.data.message).toBe('未提交的说明');expect(p.data.error).toBe('');expect(p.data.submitError).toBe('');
 });
 it('reports missing required content at the field and never submits it',async()=>{
  const p=await page('privacy-rights');p.data.authenticated=true;await p.submit();
  expect(p.data.submitError).toContain('申请说明');expect(p.data.messageFocus).toBeUndefined();
  expect(api.request).not.toHaveBeenCalled();
 });
 it('retains the draft and actionable feedback on a failed submission',async()=>{
  const p=await page('privacy-rights');p.data.authenticated=true;p.data.message='请处理我的历史数据';
  api.request.mockRejectedValueOnce(Error('offline'));await p.submit();
  expect(p.data.message).toBe('请处理我的历史数据');expect(p.data.submitError).toContain('尚未确认');expect(p.data.busy).toBe(false);
 });
});
