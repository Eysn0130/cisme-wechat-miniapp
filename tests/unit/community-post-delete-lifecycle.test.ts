import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({request:vi.fn(),token:'member-a'}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,resumeAuthentication:vi.fn(),beginLegalRenewal:vi.fn(),clearAuthenticationRedirectSuppression:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',motionDuration:()=>0}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>1}));
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',postId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let definition:any,wxMock:any;
const deferred=()=>{let resolve!:(value:any)=>void;return {promise:new Promise<any>(yes=>{resolve=yes;}),resolve};};
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function page(){return {...definition,presentationKey:JSON.stringify([m.token,'',1,'https://synthetic.invalid',undefined,undefined,`formal:${postId}`]),
  data:{...structuredClone(definition.data),id:postId,formalSource:true,editorialSource:true,item:{id:postId,authorId:owner,version:3,isMine:true},loadAttempt:2,loading:false},
  setData(patch:Record<string,unknown>){Object.assign(this.data,patch);}};}
beforeEach(async()=>{
  vi.resetModules();m.request.mockReset();m.token='member-a';
  wxMock={showModal:vi.fn().mockResolvedValue({confirm:true}),navigateBack:vi.fn(),switchTab:vi.fn()};
  Object.assign(globalThis,{wx:wxMock,getApp:()=>({globalData:{sessionToken:m.token,privacyRightsToken:'',apiBaseUrl:'https://synthetic.invalid'}}),Page:(value:any)=>{definition=value;}});
  await import('../../apps/miniprogram/pages/post/index');
});
it('confirms a committed deletion after its response is lost with one own-record read and no second delete',async()=>{
  m.request.mockImplementation(async({method,path}:any)=>{
    if(method==='DELETE')throw {code:'NETWORK_TIMEOUT'};
    expect(path).toBe(`/v1/me/ugc/posts/${postId}`);return {id:postId,ownerId:owner,state:'deleted',version:4};
  });
  const instance=page();await instance.deleteOwn();
  expect(m.request.mock.calls.map(([options])=>options.method??'GET')).toEqual(['DELETE','GET']);
  expect(wxMock.navigateBack).toHaveBeenCalledOnce();expect(instance.data.ownerBusy).toBe(false);
});
it.each(['read_failed','still_published','different_owner'])('keeps %s deletion results explicitly unconfirmed without resending',async condition=>{
  m.request.mockImplementation(async({method}:any)=>{
    if(method==='DELETE')throw {status:503,code:'TRANSACTION_OUTCOME_UNKNOWN'};
    if(condition==='read_failed')throw {code:'NETWORK_TIMEOUT'};
    return {id:postId,ownerId:condition==='different_owner'?'other-member':owner,state:condition==='still_published'?'published':'deleted'};
  });
  const instance=page();await instance.deleteOwn();
  expect(m.request.mock.calls.map(([options])=>options.method??'GET')).toEqual(['DELETE','GET']);
  expect(instance.data.ownerError).toContain('删除结果待确认');expect(instance.data.ownerError).not.toContain('未完成');
  expect(instance.data.ownerBusy).toBe(false);expect(wxMock.navigateBack).not.toHaveBeenCalled();
});
it.each(['account','epoch'])('drops a late deletion confirmation after its %s changes',async changed=>{
  const read=deferred();m.request.mockImplementation(({method}:any)=>method==='DELETE'?Promise.reject({code:'NETWORK_TIMEOUT'}):read.promise);
  const instance=page(),pending=instance.deleteOwn();await flush();
  expect(m.request).toHaveBeenCalledTimes(2);
  if(changed==='account')m.token='member-b';else instance.data.loadAttempt+=1;
  const before=JSON.stringify(instance.data);read.resolve({id:postId,ownerId:owner,state:'deleted'});await pending;
  expect(wxMock.navigateBack).not.toHaveBeenCalled();expect(JSON.stringify(instance.data)).toBe(before);
});
it('preserves a definite forbidden response without making a recovery read',async()=>{
  m.request.mockRejectedValue({status:403,title:'当前账号不可删除'});
  const instance=page();await instance.deleteOwn();
  expect(m.request).toHaveBeenCalledOnce();expect(instance.data.ownerError).toBe('当前账号不可删除');
  expect(instance.data.ownerBusy).toBe(false);expect(wxMock.navigateBack).not.toHaveBeenCalled();
});

it('allows only one delete confirmation and unlocks without a write when cancelled',async()=>{
 const confirmation=deferred();wxMock.showModal.mockReturnValue(confirmation.promise);
 const instance=page(),first=instance.deleteOwn();await instance.deleteOwn();
 expect(wxMock.showModal).toHaveBeenCalledOnce();expect(instance.data.ownerBusy).toBe(true);
 confirmation.resolve({confirm:false});await first;expect(instance.data.ownerBusy).toBe(false);expect(m.request).not.toHaveBeenCalled();
});
