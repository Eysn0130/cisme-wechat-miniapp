import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({request:vi.fn(),token:'synthetic-a'}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:mocks.request,requireMemberAccess:()=>true,
  retainMemberSnapshot:()=>true,resumeAuthentication:vi.fn(),uploadAuthorized:vi.fn(),downloadPrivateMedia:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/authority',()=>({authorityProjection:async()=>({capabilities:['member.profile.read','support.read']}),
  hasCapability:(projection:any,capability:string)=>projection.capabilities.includes(capability),requireCapability:async()=>({capabilities:['support.read']})}));
import { commerceContextRevision, invalidateCommerceRecoveryContext } from '../../apps/miniprogram/services/commerce-command-store';
let definition:any;
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
beforeEach(()=>{
  mocks.request.mockReset();mocks.token='synthetic-a';invalidateCommerceRecoveryContext();
  (globalThis as any).Page=(value:any)=>{definition=value;};
  (globalThis as any).getApp=()=>({globalData:{sessionToken:mocks.token,apiBaseUrl:'https://synthetic.invalid'}});
  (globalThis as any).wx={nextTick:vi.fn(),getStorageSync:vi.fn(),setStorageSync:vi.fn(),showToast:vi.fn()};
});
const pages=['community-author','community-post','community-compose','management-members','support','management-support-chat'] as const;
it.each(pages)('%s owns and cancels its GETs and discards late payloads after hide',async name=>{
  await import(`../../apps/miniprogram/pages/${name}/index.ts`);
  const pending:Array<{resolve:(value:any)=>void;path:string}>=[],abort=vi.fn();
  mocks.request.mockImplementation(options=>{
    if(options.method)return Promise.resolve({});
    options.registerAbort?.(()=>abort());
    return new Promise(resolve=>pending.push({resolve,path:options.path}));
  });
  const page={...definition,data:{...structuredClone(definition.data),authorId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    postId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',pageAlive:true,alive:true,visible:true},
    readRevision:commerceContextRevision(),lastRevision:commerceContextRevision(),mediaVisible:true,
    setData(patch:any){Object.assign(this.data,patch);},publishPresence:vi.fn(),schedulePoll:vi.fn(),stopPolling:vi.fn(),
    clearPresenceTimer:vi.fn(),abortDownloads:vi.fn(),abortTransientWork:vi.fn(),flushLocalBackup:vi.fn()};
  const result=name==='community-compose'?page.loadList():page.load();await flush();
  expect(pending.length).toBeGreaterThan(0);page.onHide();expect(abort).toHaveBeenCalledTimes(pending.length);
  const snapshot=JSON.stringify({items:page.data.items,post:page.data.post,drafts:page.data.drafts,messages:page.data.messages});
  for(const request of pending)request.resolve({id:'late',items:[{id:'late',title:'late'}],messages:[{id:'late'}],media:[],author:'late',nextCursor:null});
  await result;
  expect(JSON.stringify({items:page.data.items,post:page.data.post,drafts:page.data.drafts,messages:page.data.messages})).toBe(snapshot);
});

it.each(['community-post','community-compose'])('%s resumes an interrupted initial read without inventing a write',async name=>{
  vi.resetModules();await import(`../../apps/miniprogram/pages/${name}/index.ts`);
  const page={...definition,data:{...structuredClone(definition.data),loading:true,postId:name==='community-post'?'fixture-id':'',requestedDraftId:'fixture-id'},
    lastSessionToken:mocks.token,setData(patch:any){Object.assign(this.data,patch);},
    flushLocalBackup:vi.fn(),refreshPublicGate:vi.fn(),load:vi.fn(),loadDraft:vi.fn()};
  page.onHide();page.onShow();
  if(name==='community-post')expect(page.load).toHaveBeenCalledTimes(1);
  else expect(page.loadDraft).toHaveBeenCalledWith('fixture-id');
  expect(mocks.request).not.toHaveBeenCalled();
});
