import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({request:vi.fn(),upload:vi.fn(),edit:vi.fn(),capabilities:vi.fn(),token:'member-a',revision:1}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,uploadAuthorized:m.upload,resumeAuthentication:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>m.revision}));
vi.mock('../../apps/miniprogram/services/ugc-image-edit',()=>({editUgcLocalImage:m.edit,ugcImageEditCapabilities:m.capabilities}));
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',post='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const first='11111111-1111-4111-8111-111111111111',middle='22222222-2222-4222-8222-222222222222',last='33333333-3333-4333-8333-333333333333';
const replacement='44444444-4444-4444-8444-444444444444',otherPost='55555555-5555-4555-8555-555555555555';
let definition:any,wxMock:any,storage:Map<string,unknown>,pages:any[],randomSeed:number;
let intents:typeof import('../../apps/miniprogram/services/community-compose-intent');
let backups:typeof import('../../apps/miniprogram/services/ugc-local-backup');
const flush=async()=>{for(let index=0;index<80;index++)await Promise.resolve();};
const deferred=()=>{let resolve!:(value:any)=>void,reject!:(value:any)=>void;return {promise:new Promise<any>((yes,no)=>{resolve=yes;reject=no;}),resolve,reject};};
const draft=(patch:Record<string,unknown>={})=>({id:post,ownerId:owner,state:'draft',version:1,revision:1,title:'',body:'',
  rightsConfirmed:false,publicConsentConfirmed:false,publicVersionActive:false,media:[],...patch});
const image=(id:string)=>({id,localPath:`/synthetic/${id}.jpg`,previewUrl:`preview-${id}`,size:100,state:'uploaded',progress:100,error:''});
const event=(id:string)=>({currentTarget:{dataset:{id}}});
const recoveryEvent=(page:any)=>({currentTarget:{dataset:{key:page.data.imageEditRecoveryKey}}});
async function failedSingleEdit(page:any){
  await page.openPhotoEditorForImage(event(middle));m.upload.mockRejectedValueOnce({title:'修改图片上传暂未成功'});
  await page.photoEditorConfirmed({detail:{contextKey:page.data.photoEditorContext,files:[{path:'/synthetic/pending-single.jpg',size:120}]}});
  expect(page.pendingImageEdit).not.toBeNull();return page.pendingImageEdit;
}
function instance(patch:Record<string,unknown>={}){
  const page={...definition,data:{...structuredClone(definition.data),...patch},readRevision:m.revision,lastSessionToken:m.token,
    setData(value:Record<string,unknown>){Object.assign(this.data,value);}};pages.push(page);return page;
}
function editor(patch:Record<string,unknown>={}){
  const page=instance({postId:post,ownerId:owner,version:1,loading:false,draftsEnabled:true,publicGateEnabled:false,...patch});
  page.mediaVisible=true;return page;
}
function defaultRequest({path,method}:any):Promise<any>{
  if(path==='/v1/ugc/status')return Promise.resolve({publicEnabled:false,draftsEnabled:true});
  if(path==='/v1/me/ugc/posts'&&method==='POST')return Promise.resolve(draft());
  if(path.endsWith('/authorize'))return Promise.resolve({mediaId:replacement,url:'synthetic-upload',method:'PUT',fields:{}});
  if(path.endsWith('/complete'))return Promise.resolve({id:replacement,state:'uploaded'});
  if(path.endsWith('/preview-url'))return Promise.resolve({url:'synthetic-preview'});
  if(method==='DELETE')return Promise.resolve({id:post,state:'deleted',version:2});
  return Promise.resolve({items:[],matchingTotal:0,nextCursor:null});
}
const selectedIntent=()=>intents.createComposeMediaIntent({source:'album',files:[{path:'/synthetic/selected.jpg',size:120}]},
  {sessionToken:m.token,revision:m.revision});
beforeEach(async()=>{
  vi.resetModules();m.request.mockReset().mockImplementation(defaultRequest);m.upload.mockReset().mockResolvedValue(undefined);
  m.edit.mockReset();m.capabilities.mockReset().mockReturnValue({edit:true,crop:true});m.token='member-a';m.revision=1;
  storage=new Map();pages=[];randomSeed=0;
  const fs={readFile:vi.fn(({filePath,success}:any)=>success({data:new Uint8Array(filePath.endsWith('.png')?[137,80,78,71,13,10,26,10]:[255,216,255]).buffer})),
    getFileInfo:vi.fn(({success}:any)=>success({size:120}))};
  wxMock={getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:unknown)=>storage.set(key,structuredClone(value)),
    removeStorageSync:(key:string)=>storage.delete(key),enableAlertBeforeUnload:vi.fn(),disableAlertBeforeUnload:vi.fn(),hideKeyboard:vi.fn(),
    showModal:vi.fn(),showActionSheet:vi.fn(),navigateBack:vi.fn(),switchTab:vi.fn(),navigateTo:vi.fn(),previewImage:vi.fn(),nextTick:vi.fn(),
    requirePrivacyAuthorize:vi.fn(),chooseMedia:vi.fn(),openSetting:vi.fn(),downloadFile:vi.fn(),getFileSystemManager:()=>fs,
    getRandomValues:({length,success}:any)=>success({randomValues:new Uint8Array(length).fill(++randomSeed).buffer})};
  Object.assign(globalThis,{wx:wxMock,getApp:()=>({globalData:{sessionToken:m.token}}),Page:(value:any)=>{definition=value;}});
  intents=await import('../../apps/miniprogram/services/community-compose-intent');
  backups=await import('../../apps/miniprogram/services/ugc-local-backup');
  await import('../../apps/miniprogram/pages/community-compose/index');
});
afterEach(()=>{for(const page of pages){page.cancelMediaDrag();if(page.backupTimer)clearTimeout(page.backupTimer);}vi.useRealTimers();});

it('consumes one authorized selection, creates once, and uploads only after the current photo editor confirms Next',async()=>{
  const intent=await selectedIntent(),page=instance();page.onLoad({new:'1',intent});page.onShow();await flush();
  expect(m.request.mock.calls.filter(([options])=>options.path==='/v1/me/ugc/posts'&&options.method==='POST')).toHaveLength(1);
  expect(m.request.mock.calls.some(([options])=>options.path.endsWith('/authorize'))).toBe(false);expect(m.upload).not.toHaveBeenCalled();
  expect(page.data).toMatchObject({photoEditorVisible:true,files:[],photoEditorFiles:[{path:'/synthetic/selected.jpg',size:120}]});
  expect(page.photoEditorOpenContext).toMatchObject({postId:post,ownerId:owner,origin:'entry'});expect(page.pendingInitialMedia).not.toBeNull();
  const files=[{path:'/synthetic/edited-before-next.jpg',size:140}],contextKey=page.data.photoEditorContext;
  page.photoEditorChanged({detail:{contextKey,files}});expect(m.upload).not.toHaveBeenCalled();
  await page.photoEditorConfirmed({detail:{contextKey,files}});await flush();
  expect(m.request.mock.calls.filter(([options])=>options.path.endsWith('/authorize'))).toHaveLength(1);
  expect(m.upload).toHaveBeenCalledOnce();expect(page.data.files).toEqual([expect.objectContaining({id:replacement,state:'uploaded'})]);
  expect(m.upload).toHaveBeenCalledWith('/synthetic/edited-before-next.jpg',expect.anything(),expect.anything());
  expect(page.data.photoEditorVisible).toBe(false);expect(page.photoEditorOpenContext).toBeNull();
  expect(page.pendingInitialMedia).toBeNull();expect(wxMock.requirePrivacyAuthorize).not.toHaveBeenCalled();expect(wxMock.chooseMedia).not.toHaveBeenCalled();
  m.request.mockClear();const replay=instance();replay.onLoad({new:'1',intent});replay.onShow();await flush();
  expect(replay.data.error).toContain('本次选择已失效');expect(m.request.mock.calls.some(([options])=>options.method==='POST')).toBe(false);
});
it('cancels the initial photo stage by cleaning only its exact fresh empty draft before returning',async()=>{
  const intent=await selectedIntent(),page=instance();page.onLoad({new:'1',intent});page.onShow();await flush();
  const backup={ownerId:owner,postId:post,baseVersion:1,title:'',body:'',rightsConfirmed:false,publicConsentConfirmed:false,mediaIds:[],savedAt:Date.now()};
  backups.writeUgcBackup(backup);backups.writeUgcBackup({...backup,baseVersion:2});backups.writeUgcBackup({...backup,postId:otherPost});
  const deletion=deferred();m.request.mockClear();m.request.mockImplementation((options:any)=>options.method==='DELETE'?deletion.promise:defaultRequest(options));
  const cancelling=page.photoEditorCancelled({detail:{contextKey:page.data.photoEditorContext}});await flush();
  expect(m.request).toHaveBeenCalledExactlyOnceWith({path:`/v1/me/ugc/posts/${post}`,method:'DELETE',data:{expectedVersion:1}});
  expect(m.upload).not.toHaveBeenCalled();expect(wxMock.navigateBack).not.toHaveBeenCalled();
  deletion.resolve({id:post,state:'deleted',version:2});await cancelling;
  expect(wxMock.navigateBack).toHaveBeenCalledOnce();expect(page.pendingInitialMedia).toBeNull();expect(page.createdHerePostId).toBe('');
  expect(page.data.photoEditorVisible).toBe(false);expect(backups.readUgcBackup(owner,post,1)).toBeNull();
  expect(backups.readUgcBackup(owner,post,2)).not.toBeNull();expect(backups.readUgcBackup(owner,otherPost,1)).not.toBeNull();
});
it('preserves the same photo overlay and scope across its native editor hide/show',async()=>{
  const intent=await selectedIntent(),page=instance();page.onLoad({new:'1',intent});page.onShow();await flush();
  const contextKey=page.data.photoEditorContext,scope=page.photoEditorOpenContext;
  page.photoEditorNativeBegin({detail:{contextKey}});expect(page.nativeMedia).toBe('edit');
  page.photoEditorNativeEnd({detail:{contextKey:`${contextKey}-old`}});expect(page.nativeMedia).toBe('edit');page.onHide();
  expect(page.mediaVisible).toBe(false);expect(page.data.photoEditorVisible).toBe(true);expect(page.photoEditorOpenContext).toBe(scope);
  expect(page.pendingInitialMedia.files).toEqual([{path:'/synthetic/selected.jpg',size:120}]);
  page.photoEditorNativeEnd({detail:{contextKey}});expect(page.nativeMedia).toBe('');page.onShow();await flush();
  expect(page.data).toMatchObject({photoEditorVisible:true,photoEditorContext:contextKey});expect(page.photoEditorOpenContext).toBe(scope);
  expect(m.upload).not.toHaveBeenCalled();expect(m.request.mock.calls.some(([options])=>options.path.endsWith('/authorize'))).toBe(false);
});
it('restores pending local photos under a new scope after a genuine background return',async()=>{
  const intent=await selectedIntent(),page=instance();page.onLoad({new:'1',intent});page.onShow();await flush();
  const oldKey=page.data.photoEditorContext,files=[{path:'/synthetic/current-local-edit.jpg',size:160}];
  page.photoEditorChanged({detail:{contextKey:oldKey,files}});page.onHide();
  expect(page.data.photoEditorVisible).toBe(false);expect(page.photoEditorOpenContext).toBeNull();expect(page.pendingInitialMedia.files).toEqual(files);
  page.onShow();await flush();const contextKey=page.data.photoEditorContext;
  expect(contextKey).not.toBe(oldKey);expect(page.data).toMatchObject({photoEditorVisible:true,photoEditorFiles:files});expect(m.upload).not.toHaveBeenCalled();
  await page.photoEditorConfirmed({detail:{contextKey:oldKey,files:[{path:'/synthetic/stale.jpg',size:100}]}});
  expect(page.data.photoEditorVisible).toBe(true);expect(m.upload).not.toHaveBeenCalled();
  await page.photoEditorConfirmed({detail:{contextKey,files}});expect(m.upload).toHaveBeenCalledOnce();
  expect(m.upload).toHaveBeenCalledWith('/synthetic/current-local-edit.jpg',expect.anything(),expect.anything());
});
it.each(['context','account','epoch','post','owner','revision','unload'])('does not change, import, or delete a photo batch across a wrong %s scope',async boundary=>{
  const intent=await selectedIntent(),page=instance();page.onLoad({new:'1',intent});page.onShow();await flush();
  const initialKey=page.data.photoEditorContext;
  if(boundary==='account'){m.token='member-b';page.onShow();await flush();}
  else if(boundary==='epoch')page.data.epoch+=1;
  else if(boundary==='post')page.data.postId=otherPost;
  else if(boundary==='owner')page.data.ownerId=otherPost;
  else if(boundary==='revision')m.revision+=1;
  else if(boundary==='unload')page.onUnload();
  const contextKey=boundary==='context'?`${initialKey}-stale`:initialKey;
  const pendingBefore=structuredClone(page.pendingInitialMedia);m.request.mockClear();
  const detail={contextKey,files:[{path:'/synthetic/wrong-scope.jpg',size:100}]};
  page.photoEditorChanged({detail});page.photoEditorNativeBegin({detail});await page.photoEditorConfirmed({detail});await page.photoEditorCancelled({detail});
  expect(page.pendingInitialMedia).toEqual(pendingBefore);expect(m.upload).not.toHaveBeenCalled();
  expect(m.request.mock.calls.some(([options])=>options.method)).toBe(false);expect(wxMock.navigateBack).not.toHaveBeenCalled();
});
it('cancels an added photo batch without leaving or altering an existing draft',async()=>{
  const existing=[image(first)],page=editor({body:'已有稿件正文',files:existing});
  wxMock.requirePrivacyAuthorize.mockImplementation(({success}:any)=>success());wxMock.chooseMedia.mockResolvedValue({tempFiles:[{tempFilePath:'/synthetic/additional.jpg',size:120}]});
  await page.chooseImages('album');expect(page.photoEditorOpenContext.origin).toBe('editor');
  expect(m.upload).not.toHaveBeenCalled();await page.photoEditorCancelled({detail:{contextKey:page.data.photoEditorContext}});
  expect(page.data).toMatchObject({photoEditorVisible:false,body:'已有稿件正文',files:existing});expect(page.pendingInitialMedia).toBeNull();
  expect(wxMock.navigateBack).not.toHaveBeenCalled();expect(m.request.mock.calls.some(([options])=>options.method)).toBe(false);
});
it.each(['missing','wrong_account','expired'])('makes no POST for a %s selection intent',async scenario=>{
  let intent='invalid-intent';if(scenario!=='missing')intent=await selectedIntent();
  if(scenario==='wrong_account')m.token='member-b';
  const clock=scenario==='expired'?vi.spyOn(Date,'now').mockReturnValue(Date.now()+120001):null;
  try{const page=instance();page.onLoad({new:'1',intent});page.onShow();await flush();
    expect(page.data.error).toContain('本次选择已失效');expect(m.request.mock.calls.some(([options])=>options.method==='POST')).toBe(false);
    expect(m.upload).not.toHaveBeenCalled();
  }finally{clock?.mockRestore();}
});
it.each(['account','unload'])('drops selected media when %s changes while draft creation is pending',async boundary=>{
  const creation=deferred(),intent=await selectedIntent();
  m.request.mockImplementation((options:any)=>options.path==='/v1/me/ugc/posts'&&options.method==='POST'?creation.promise:defaultRequest(options));
  const page=instance();page.onLoad({new:'1',intent});page.onShow();await flush();
  if(boundary==='account'){m.token='member-b';page.onShow();}else page.onUnload();
  creation.resolve(draft());await flush();expect(m.upload).not.toHaveBeenCalled();
  expect(m.request.mock.calls.some(([options])=>options.path.endsWith('/authorize'))).toBe(false);expect(page.pendingInitialMedia).toBeNull();
});
it.each(['account','unload'])('does not authorize an image after %s changes during its local read',async boundary=>{
  const read=deferred();wxMock.getFileSystemManager().readFile.mockImplementation(({success}:any)=>{void read.promise.then(success);});
  const page=editor(),importing=page.importLocalImages([{path:'/synthetic/selected.jpg',size:120}]);
  if(boundary==='account'){m.token='member-b';page.onShow();}else page.onUnload();
  read.resolve({data:new Uint8Array([255,216,255]).buffer});await importing;
  expect(m.request.mock.calls.some(([options])=>options.path.endsWith('/authorize'))).toBe(false);expect(m.upload).not.toHaveBeenCalled();
});

it.each([{status:'cancel'},{status:'unsupported',message:'此设备不可编辑'},{status:'error',code:'NATIVE_ERROR',message:'原生编辑失败'}])
  ('keeps the original asset when native editing returns $status',async result=>{
    const files=[image(first),image(middle),image(last)],page=editor({files});m.edit.mockResolvedValue(result);
    await page.editSelectedImage(middle,'edit');expect(page.data.files).toEqual(files);
    expect(m.request.mock.calls.some(([options])=>options.method)).toBe(false);expect(m.upload).not.toHaveBeenCalled();
    expect(page.data).toMatchObject({uploadBusy:false,imageEditingId:'',dirty:false});
  });
it('keeps the original asset after a new-file upload failure',async()=>{
  const files=[image(first),image(middle),image(last)],page=editor({files});
  m.edit.mockResolvedValue({status:'success',tempFilePath:'/synthetic/edited.jpg',operation:'edit'});m.upload.mockRejectedValue({title:'合成网络故障'});
  await page.editSelectedImage(middle,'edit');expect(page.data.files).toEqual(files);expect(page.data.error).toBe('合成网络故障');
  expect(m.request.mock.calls.some(([options])=>options.path.endsWith('/complete'))).toBe(false);
});
it('replaces the edited asset at its original position only after the new asset completion receipt',async()=>{
  const completion=deferred(),files=[image(first),image(middle),image(last)],page=editor({files});
  m.edit.mockResolvedValue({status:'success',tempFilePath:'/synthetic/edited.jpg',operation:'edit'});
  m.request.mockImplementation((options:any)=>options.path.endsWith('/complete')?completion.promise:defaultRequest(options));
  const editing=page.editSelectedImage(middle,'edit');await flush();
  expect(m.upload).toHaveBeenCalledWith('/synthetic/edited.jpg',expect.objectContaining({mediaId:replacement}),expect.any(Object));
  expect(page.data.files).toEqual(files);expect(page.data.dirty).toBe(false);
  expect(m.request.mock.calls.find(([options])=>options.path.endsWith('/authorize'))?.[0].data).toEqual({mimeType:'image/jpeg',maxBytes:120});
  completion.resolve({id:replacement,state:'uploaded'});await editing;await flush();
  expect(page.data.files.map((file:any)=>file.id)).toEqual([first,replacement,last]);
  expect(page.data.files[1]).toMatchObject({localPath:'/synthetic/edited.jpg',size:120,state:'uploaded'});expect(page.data.dirty).toBe(true);
  page.flushLocalBackup();expect(backups.readUgcBackup(owner,post,1)?.mediaIds).toEqual([first,replacement,last]);
});
it('opens one existing image without uploading and replaces only that slot after the current single editor confirms',async()=>{
  const files=[image(first),image(middle),image(last)],page=editor({files}),completion=deferred();
  await page.openPhotoEditorForImage(event(middle));
  expect(page.photoEditorOpenContext).toMatchObject({origin:'single',targetId:middle,basePath:`/synthetic/${middle}.jpg`,postId:post,ownerId:owner});
  expect(page.data).toMatchObject({photoEditorVisible:true,photoEditorAdditional:false,files,dirty:false});
  expect(m.upload).not.toHaveBeenCalled();expect(m.request.mock.calls.some(([options])=>options.method)).toBe(false);
  const contextKey=page.data.photoEditorContext,edited=[{path:'/synthetic/single-edited.jpg',size:120}];
  m.request.mockImplementation((options:any)=>options.path.endsWith('/complete')?completion.promise:defaultRequest(options));
  page.photoEditorChanged({detail:{contextKey,files:edited}});
  const confirming=page.photoEditorConfirmed({detail:{contextKey,files:edited}});await flush();
  expect(m.upload).toHaveBeenCalledExactlyOnceWith('/synthetic/single-edited.jpg',expect.objectContaining({mediaId:replacement}),expect.any(Object));
  expect(m.edit).not.toHaveBeenCalled();expect(page.data.files).toEqual(files);expect(page.data.dirty).toBe(false);
  completion.resolve({id:replacement,state:'uploaded'});await confirming;await flush();page.flushLocalBackup();
  expect(page.data.files.map((file:any)=>file.id)).toEqual([first,replacement,last]);expect(page.data.files).toHaveLength(3);
  expect(page.data.files[1]).toMatchObject({id:replacement,localPath:'/synthetic/single-edited.jpg',state:'uploaded'});
  expect(backups.readUgcBackup(owner,post,1)?.mediaIds).toEqual([first,replacement,last]);
});
it('does not reupload an unchanged single-image path or open the native image editor again',async()=>{
  const files=[image(first),image(middle),image(last)],page=editor({files});await page.openPhotoEditorForImage(event(middle));
  await page.photoEditorConfirmed({detail:{contextKey:page.data.photoEditorContext,files:page.data.photoEditorFiles}});
  expect(page.data).toMatchObject({files,dirty:false,photoEditorVisible:false,uploadBusy:false});
  expect(m.upload).not.toHaveBeenCalled();expect(m.edit).not.toHaveBeenCalled();expect(m.request.mock.calls.some(([options])=>options.method)).toBe(false);
});
it('cancels a single-image edit without touching the original asset, position, or draft navigation',async()=>{
  const files=[image(first),image(middle),image(last)],page=editor({files});await page.openPhotoEditorForImage(event(middle));
  const contextKey=page.data.photoEditorContext;page.photoEditorChanged({detail:{contextKey,files:[{path:'/synthetic/unused-edit.jpg',size:120}]}});
  await page.photoEditorCancelled({detail:{contextKey}});
  expect(page.data).toMatchObject({files,dirty:false,photoEditorVisible:false});expect(page.pendingInitialMedia).toBeNull();
  expect(m.upload).not.toHaveBeenCalled();expect(m.request.mock.calls.some(([options])=>options.method)).toBe(false);expect(wxMock.navigateBack).not.toHaveBeenCalled();
});
it.each(['context','account','epoch','post','owner','revision','unload'])('rejects a single-image confirmation across an old %s scope',async boundary=>{
  const files=[image(first),image(middle),image(last)],page=editor({files});await page.openPhotoEditorForImage(event(middle));
  const key=page.data.photoEditorContext;
  if(boundary==='context'){page.onHide();page.onShow();await flush();expect(page.data.photoEditorContext).not.toBe(key);}
  else if(boundary==='account'){m.token='member-b';page.onShow();await flush();}
  else if(boundary==='epoch')page.data.epoch+=1;
  else if(boundary==='post')page.data.postId=otherPost;
  else if(boundary==='owner')page.data.ownerId=otherPost;
  else if(boundary==='revision')m.revision+=1;
  else page.onUnload();
  const retained=structuredClone(page.data.files);m.request.mockClear();
  await page.photoEditorConfirmed({detail:{contextKey:key,files:[{path:'/synthetic/stale-single.jpg',size:120}]}});
  expect(page.data.files).toEqual(retained);expect(m.upload).not.toHaveBeenCalled();expect(m.edit).not.toHaveBeenCalled();
  expect(m.request.mock.calls.some(([options])=>options.method)).toBe(false);
});
it.each(['authorize','upload','complete'])('keeps the original single-image asset when its replacement fails at %s',async stage=>{
  const files=[image(first),image(middle),image(last)],page=editor({files});await page.openPhotoEditorForImage(event(middle));
  if(stage==='upload')m.upload.mockRejectedValue({title:'本次替换失败'});
  else m.request.mockImplementation((options:any)=>options.path.endsWith(`/${stage}`)?Promise.reject({title:'本次替换失败'}):defaultRequest(options));
  await page.photoEditorConfirmed({detail:{contextKey:page.data.photoEditorContext,files:[{path:'/synthetic/replacement-failed.jpg',size:120}]}});
  expect(page.data).toMatchObject({files,dirty:false,photoEditorVisible:false,uploadBusy:false,imageEditingId:'',error:'本次替换失败'});
  expect(page.data.imageEditRecovery).toBe(true);expect(page.pendingImageEdit).toMatchObject({targetId:middle,path:'/synthetic/replacement-failed.jpg',postId:post,ownerId:owner,version:1});
  expect(m.edit).not.toHaveBeenCalled();expect(page.data.files.map((file:any)=>file.id)).toEqual([first,middle,last]);
});
it('retries the retained edited file with a fresh authorization and swaps the original slot only after completion',async()=>{
  const files=[image(first),image(middle),image(last)],page=editor({files}),completion=deferred();let authorized=0;
  const retried='66666666-6666-4666-8666-666666666666';
  m.request.mockImplementation((options:any)=>options.path.endsWith('/authorize')?Promise.resolve({mediaId:++authorized===1?replacement:retried,url:'synthetic-upload',method:'PUT',fields:{}}):
    options.path.endsWith('/complete')?completion.promise:defaultRequest(options));
  const candidate=await failedSingleEdit(page);expect(page.data.files).toEqual(files);
  const retrying=page.retryPendingImageEdit(recoveryEvent(page));await flush();
  expect(authorized).toBe(2);expect(m.upload).toHaveBeenLastCalledWith('/synthetic/pending-single.jpg',expect.objectContaining({mediaId:retried}),expect.anything());
  expect(page.data.files).toEqual(files);expect(page.pendingImageEdit).toBe(candidate);
  completion.resolve({id:retried,state:'uploaded'});await retrying;page.flushLocalBackup();
  expect(page.data.files.map((item:any)=>item.id)).toEqual([first,retried,last]);expect(page.data.files).toHaveLength(3);
  expect(page.pendingImageEdit).toBeNull();expect(page.data).toMatchObject({imageEditRecovery:false,imageEditRecoveryKey:'',dirty:true,uploadBusy:false});
  expect(backups.readUgcBackup(owner,post,1)?.mediaIds).toEqual([first,retried,last]);
});
it('requires handling the image candidate before saving, submitting, or navigating to its public version',async()=>{
  const files=[image(first),image(middle),image(last)],page=editor({files,publicGateEnabled:true,publicVersionActive:true});await failedSingleEdit(page);m.request.mockClear();
  await page.saveDraft();await page.submit();page.openPublishedPost();
  expect(m.request).not.toHaveBeenCalled();expect(wxMock.navigateTo).not.toHaveBeenCalled();expect(page.data.files).toEqual(files);
  expect(page.data.error).toContain('先重试使用修改后的图片');expect(page.pendingImageEdit).not.toBeNull();
});
it('explicitly discards only the pending modification and permits saving the retained original assets',async()=>{
  const files=[image(first),image(middle),image(last)],page=editor({files});await failedSingleEdit(page);await page.saveDraft();
  page.discardPendingImageEdit(recoveryEvent(page));expect(page.pendingImageEdit).toBeNull();
  expect(page.data).toMatchObject({files,dirty:false,imageEditRecovery:false,imageEditRecoveryKey:'',error:''});
  m.request.mockClear();m.request.mockImplementation((options:any)=>options.method==='PUT'?Promise.resolve(draft({version:2,media:files.map(item=>({id:item.id,state:'uploaded'}))})):defaultRequest(options));
  await page.saveDraft();expect(m.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({method:'PUT',data:expect.objectContaining({mediaIds:[first,middle,last]})}));
});
it('requires explicit abandonment of the image candidate before a normal page exit',async()=>{
  const files=[image(first),image(middle),image(last)],page=editor({files});const candidate=await failedSingleEdit(page);m.request.mockClear();
  wxMock.showModal.mockResolvedValueOnce({confirm:false});await page.back();
  expect(page.pendingImageEdit).toBe(candidate);expect(wxMock.navigateBack).not.toHaveBeenCalled();
  wxMock.showModal.mockResolvedValueOnce({confirm:true});await page.back();
  expect(wxMock.showModal).toHaveBeenLastCalledWith(expect.objectContaining({title:'放弃本次图片修改？',content:expect.stringContaining('原图仍保留')}));
  expect(page.pendingImageEdit).toBeNull();expect(wxMock.navigateBack).toHaveBeenCalledOnce();expect(page.data.files).toEqual(files);expect(m.request).not.toHaveBeenCalled();
});
it('ignores a wrong candidate key for both retry and discard',async()=>{
  const page=editor({files:[image(first),image(middle),image(last)]}),candidate=await failedSingleEdit(page);m.request.mockClear();m.upload.mockClear();
  const stale={currentTarget:{dataset:{key:`${candidate.key}-old`}}};await page.retryPendingImageEdit(stale);page.discardPendingImageEdit(stale);
  expect(page.pendingImageEdit).toBe(candidate);expect(m.request).not.toHaveBeenCalled();expect(m.upload).not.toHaveBeenCalled();
});
it.each(['account','epoch','post','owner','revision','version','missing_target'])('rejects a pending image retry after its %s scope expires',async boundary=>{
  const page=editor({files:[image(first),image(middle),image(last)]});await failedSingleEdit(page);const retry=recoveryEvent(page);
  if(boundary==='account')m.token='member-b';else if(boundary==='epoch')page.data.epoch+=1;else if(boundary==='post')page.data.postId=otherPost;
  else if(boundary==='owner')page.data.ownerId=otherPost;else if(boundary==='revision')m.revision+=1;else if(boundary==='version')page.data.version+=1;
  else page.data.files=page.data.files.filter((item:any)=>item.id!==middle);
  const retained=structuredClone(page.data.files);m.request.mockClear();m.upload.mockClear();await page.retryPendingImageEdit(retry);
  expect(m.request).not.toHaveBeenCalled();expect(m.upload).not.toHaveBeenCalled();expect(page.data.files).toEqual(retained);
  expect(page.pendingImageEdit).toBeNull();expect(page.data).toMatchObject({imageEditRecovery:false,error:'本次图片修改已失效，请重新编辑原图。'});
});
it.each(['account','unload','load','apply','remove_target'])('clears the local image candidate on %s without replacing the original asset',async boundary=>{
  const page=editor({files:[image(first),image(middle),image(last)]});await failedSingleEdit(page);m.request.mockClear();m.upload.mockClear();
  if(boundary==='account'){m.token='member-b';page.onShow();await flush();}
  else if(boundary==='unload')page.onUnload();
  else if(boundary==='load'){m.request.mockResolvedValue(draft());await page.loadDraft(post);}
  else if(boundary==='apply')page.applyDraft(draft());
  else page.removeImage(event(middle));
  expect(page.pendingImageEdit).toBeNull();expect(page.data.files.some((item:any)=>item.localPath==='/synthetic/pending-single.jpg')).toBe(false);
  if(boundary!=='unload')expect(page.data).toMatchObject({imageEditRecovery:false,imageEditRecoveryKey:''});
  expect(m.upload).not.toHaveBeenCalled();expect(m.request.mock.calls.some(([options])=>options.method)).toBe(false);
});
it('retains the new file as a candidate when backgrounding interrupts the replacement upload',async()=>{
  const upload=deferred(),files=[image(first),image(middle),image(last)],page=editor({files});await page.openPhotoEditorForImage(event(middle));m.upload.mockReturnValueOnce(upload.promise);
  const confirming=page.photoEditorConfirmed({detail:{contextKey:page.data.photoEditorContext,files:[{path:'/synthetic/interrupted-edit.jpg',size:120}]}});await flush();
  expect(page.pendingImageEdit).toMatchObject({path:'/synthetic/interrupted-edit.jpg',targetId:middle});page.onHide();upload.reject({title:'合成后台中断'});await confirming;
  expect(page.data).toMatchObject({files,imageEditRecovery:true,uploadBusy:false,dirty:false});page.onShow();await flush();
  await page.retryPendingImageEdit(recoveryEvent(page));expect(page.pendingImageEdit).toBeNull();expect(page.data.files.map((item:any)=>item.id)).toEqual([first,replacement,last]);
});
it.each([
  ['upload','state'],['upload','version'],['upload','owner'],
  ['complete','state'],['complete','version'],['complete','owner']
])('rejects the late single-image replacement when %s is pending and %s changes',async(stage,boundary)=>{
  const pending=deferred(),files=[image(first),image(middle),image(last)],page=editor({files});await page.openPhotoEditorForImage(event(middle));
  if(stage==='upload')m.upload.mockReturnValueOnce(pending.promise);
  else m.request.mockImplementation((options:any)=>options.path.endsWith('/complete')?pending.promise:defaultRequest(options));
  const confirming=page.photoEditorConfirmed({detail:{contextKey:page.data.photoEditorContext,files:[{path:'/synthetic/late-candidate.jpg',size:120}]}});await flush();
  expect(page.pendingImageEdit).toMatchObject({targetId:middle,ownerId:owner,version:1});
  if(stage==='complete')expect(m.request.mock.calls.some(([options])=>options.path.endsWith('/complete'))).toBe(true);
  if(boundary==='state')page.data.state='pending_review';else if(boundary==='version')page.data.version+=1;else page.data.ownerId=otherPost;
  pending.resolve(stage==='complete'?{id:replacement,state:'uploaded'}:undefined);await confirming;
  expect(page.data).toMatchObject({files,dirty:false,uploadBusy:false,imageEditingId:'',imageEditRecovery:false,imageEditRecoveryKey:''});
  expect(page.pendingImageEdit).toBeNull();expect(page.data.files.map((file:any)=>file.id)).toEqual([first,middle,last]);
  if(stage==='upload')expect(m.request.mock.calls.some(([options])=>options.path.endsWith('/complete'))).toBe(false);
});
it('opens a downloaded original in the single editor without uploading it merely for viewing',async()=>{
  const files=[image(first),{...image(middle),localPath:''},image(last)],page=editor({files});
  const abort=vi.fn();wxMock.downloadFile.mockImplementation(({success}:any)=>{success({statusCode:200,tempFilePath:'/synthetic/downloaded-original.jpg'});return {abort};});
  await page.openPhotoEditorForImage(event(middle));
  expect(wxMock.downloadFile).toHaveBeenCalledWith(expect.objectContaining({url:'synthetic-preview'}));
  expect(page.photoEditorOpenContext).toMatchObject({origin:'single',targetId:middle,basePath:'/synthetic/downloaded-original.jpg'});
  expect(page.data.photoEditorFiles).toEqual([{path:'/synthetic/downloaded-original.jpg',size:120}]);expect(page.data.files).toEqual(files);
  await page.photoEditorConfirmed({detail:{contextKey:page.data.photoEditorContext,files:page.data.photoEditorFiles}});
  expect(m.upload).not.toHaveBeenCalled();expect(page.data).toMatchObject({files,dirty:false,photoEditorVisible:false});
});
it.each(['account','unload','background','epoch','post','state'])('drops a downloaded single-image source when %s changes before it returns',async boundary=>{
  const files=[image(first),{...image(middle),localPath:''},image(last)],page=editor({files});let download:any;const abort=vi.fn();
  wxMock.downloadFile.mockImplementation((options:any)=>{download=options;return {abort};});
  const opening=page.openPhotoEditorForImage(event(middle));await flush();expect(download).toBeDefined();
  if(boundary==='account'){m.token='member-b';page.onShow();await flush();}
  else if(boundary==='unload')page.onUnload();
  else if(boundary==='background')page.onHide();
  else if(boundary==='epoch')page.data.epoch+=1;
  else if(boundary==='post')page.data.postId=otherPost;
  else page.data.state='pending_review';
  const retained=structuredClone(page.data.files);download.success({statusCode:200,tempFilePath:'/synthetic/late-download.jpg'});await opening;await flush();
  expect(page.data.photoEditorVisible).toBe(false);expect(page.photoEditorOpenContext).toBeNull();expect(page.data.files).toEqual(retained);
  if(boundary==='state')expect(page.data).toMatchObject({state:'pending_review',uploadBusy:false,imageEditingId:''});
  expect(m.upload).not.toHaveBeenCalled();expect(m.request.mock.calls.some(([options])=>options.path.endsWith('/authorize'))).toBe(false);
});
it('keeps the existing asset after its original download fails',async()=>{
  const files=[image(first),{...image(middle),localPath:''},image(last)],page=editor({files});
  wxMock.downloadFile.mockImplementation(({success}:any)=>{success({statusCode:403,tempFilePath:'/synthetic/not-available.jpg'});return {abort:vi.fn()};});
  await page.openPhotoEditorForImage(event(middle));
  expect(page.data).toMatchObject({files,dirty:false,photoEditorVisible:false,uploadBusy:false,imageEditingId:''});
  expect(page.data.error).toContain('原图仍保留');expect(m.upload).not.toHaveBeenCalled();
});
it('ignores a completed native edit after the page is unloaded',async()=>{
  const result=deferred(),files=[image(first)],page=editor({files});m.edit.mockReturnValue(result.promise);
  const editing=page.editSelectedImage(first,'edit');page.onUnload();result.resolve({status:'success',tempFilePath:'/synthetic/late.jpg',operation:'edit'});await editing;
  expect(page.data.files).toEqual(files);expect(m.request.mock.calls.some(([options])=>options.method)).toBe(false);expect(m.upload).not.toHaveBeenCalled();
});
it('sets the selected first image by changing the same persisted media order',async()=>{
  m.capabilities.mockReturnValue({edit:false,crop:false});wxMock.showActionSheet.mockResolvedValue({tapIndex:2});
  const page=editor({files:[image(first),image(middle),image(last)]});await page.openImageActions(event(middle));page.flushLocalBackup();
  expect(page.data.files.map((file:any)=>file.id)).toEqual([middle,first,last]);
  expect(backups.readUgcBackup(owner,post,1)?.mediaIds).toEqual([middle,first,last]);expect(m.upload).not.toHaveBeenCalled();
});

it('backs up current text-card input and passes an accepted exported card to the existing image importer',async()=>{
  const page=editor({body:'原始正文'});page.openTextCard();const contextKey=page.data.textCardContext;
  page.textCardChanged({detail:{contextKey,text:'卡片里的最新正文'}});page.flushLocalBackup();
  expect(backups.readUgcBackup(owner,post,1)).toMatchObject({body:'原始正文',textCardText:'卡片里的最新正文'});
  const importing=vi.fn().mockResolvedValue(undefined);page.importLocalImages=importing;
  await page.confirmTextCard({detail:{contextKey,text:'已确认的文字卡片',tempFilePath:'/synthetic/card.png',size:120}});page.flushLocalBackup();
  expect(importing).toHaveBeenCalledWith([{path:'/synthetic/card.png',size:120}]);
  expect(page.data).toMatchObject({body:'原始正文',textCardText:'已确认的文字卡片',dirty:true,textCardVisible:false});
  expect(backups.readUgcBackup(owner,post,1)).toMatchObject({body:'原始正文',textCardText:'已确认的文字卡片'});
});
it.each(['old_context','account','epoch','post','unload'])('rejects text-card changes and exports owned by an %s boundary',async boundary=>{
  const page=editor({body:'当前真实正文'});page.openTextCard();const oldKey=page.data.textCardContext;
  if(boundary==='old_context'){page.cancelTextCard({detail:{contextKey:oldKey}});page.openTextCard();}
  else if(boundary==='account')m.token='member-b';
  else if(boundary==='epoch')page.data.epoch+=1;
  else if(boundary==='post')page.data.postId=otherPost;
  else page.onUnload();
  page.importLocalImages=vi.fn().mockResolvedValue(undefined);const before=page.data.body;
  page.textCardChanged({detail:{contextKey:oldKey,text:'不应写入的新正文'}});
  await page.confirmTextCard({detail:{contextKey:oldKey,text:'不应导入的旧卡片',tempFilePath:'/synthetic/old-card.png',size:120}});
  expect(page.data.body).toBe(before);expect(page.importLocalImages).not.toHaveBeenCalled();
});

it('discards only a truly empty draft created on this page at version one when the user leaves',async()=>{
  const page=instance();page.onLoad({new:'1'});page.onShow();await flush();expect(page.createdHerePostId).toBe(post);
  const backup={ownerId:owner,postId:post,baseVersion:1,title:'',body:'',rightsConfirmed:false,publicConsentConfirmed:false,mediaIds:[],savedAt:Date.now()};
  backups.writeUgcBackup(backup);backups.writeUgcBackup({...backup,baseVersion:2});backups.writeUgcBackup({...backup,postId:otherPost});
  m.request.mockClear();expect(await page.confirmLeave()).toBe(true);
  expect(m.request).toHaveBeenCalledWith({path:`/v1/me/ugc/posts/${post}`,method:'DELETE',data:{expectedVersion:1}});
  expect(backups.readUgcBackup(owner,post,1)).toBeNull();expect(backups.readUgcBackup(owner,post,2)).not.toBeNull();
  expect(backups.readUgcBackup(owner,otherPost,1)).not.toBeNull();
});
it.each(['existing','other_post','newer_version'])('does not automatically delete a clean empty %s draft',async scope=>{
  const page=editor({title:'',body:'',files:[],dirty:false,version:scope==='newer_version'?2:1});
  page.createdHerePostId=scope==='existing'?'':scope==='other_post'?otherPost:post;
  expect(await page.confirmLeave()).toBe(true);expect(m.request).not.toHaveBeenCalled();
});
it('keeps an empty new draft when an unknown delete cannot be confirmed for the exact owner',async()=>{
  const page=editor({body:'',dirty:false});page.createdHerePostId=post;
  m.request.mockImplementation(async({method}:any)=>{if(method==='DELETE')throw {code:'NETWORK_TIMEOUT'};return draft({ownerId:otherPost,state:'deleted'});});
  expect(await page.confirmLeave()).toBe(false);expect(page.createdHerePostId).toBe(post);expect(page.data.error).toContain('处理结果待确认');
  expect(m.request.mock.calls.filter(([options])=>options.method==='DELETE')).toHaveLength(1);
});
it('preserves input arriving while its exact empty-draft deletion is awaiting a receipt',async()=>{
  const deletion=deferred(),page=editor({title:'',body:'',files:[],dirty:false});page.createdHerePostId=post;
  m.request.mockImplementation((options:any)=>options.method==='DELETE'?deletion.promise:defaultRequest(options));
  const leaving=page.confirmLeave();await flush();expect(page.data.busy).toBe(true);
  page.editBody({detail:{value:'删除回执到来前输入的真实感受'}});page.flushLocalBackup();
  deletion.resolve({id:post,state:'deleted',version:2});expect(await leaving).toBe(false);
  expect(page.data).toMatchObject({state:'deleted',body:'删除回执到来前输入的真实感受',dirty:true,busy:false,publicVersionActive:false});
  expect(backups.readUgcBackup(owner,post,1)?.body).toBe('删除回执到来前输入的真实感受');
  expect(m.request.mock.calls.filter(([options])=>options.method==='DELETE')).toHaveLength(1);
});
it('routes the add-content camera action to one camera-only photo and exposes settings after a permission refusal',async()=>{
  const page=editor({body:'相机拒绝时仍保留的正文'});wxMock.showActionSheet.mockResolvedValue({tapIndex:1});
  wxMock.requirePrivacyAuthorize.mockImplementation(({success}:any)=>success());
  wxMock.chooseMedia.mockRejectedValue({errMsg:'chooseMedia:fail auth deny'});
  await page.addContent();
  expect(wxMock.showActionSheet).toHaveBeenCalledWith({itemList:['从相册选择','相机','写文字']});
  expect(wxMock.chooseMedia).toHaveBeenCalledWith(expect.objectContaining({count:1,mediaType:['image'],sourceType:['camera']}));
  expect(page.data).toMatchObject({body:'相机拒绝时仍保留的正文',mediaRecovery:'settings',lastMediaSource:'camera',uploadBusy:false});
  expect(wxMock.openSetting).not.toHaveBeenCalled();expect(m.upload).not.toHaveBeenCalled();
  expect(m.request.mock.calls.some(([options])=>options.method)).toBe(false);
});
it('returns from explicit settings without reopening the chooser until the user requests a retry',async()=>{
  const settings=deferred(),page=editor({mediaRecovery:'settings',lastMediaSource:'camera'});
  wxMock.openSetting.mockImplementation(({success,fail}:any)=>{void settings.promise.then(success,fail);});
  wxMock.requirePrivacyAuthorize.mockImplementation(({success}:any)=>success());wxMock.chooseMedia.mockResolvedValue({tempFiles:[]});
  const opening=page.openComposerMediaSettings();page.onHide();settings.resolve({authSetting:{'scope.camera':true}});await flush();
  expect(wxMock.chooseMedia).not.toHaveBeenCalled();expect(page.data.uploadBusy).toBe(true);
  page.onShow();await opening;await flush();
  expect(page.data).toMatchObject({mediaRecovery:'retry',uploadBusy:false});expect(wxMock.chooseMedia).not.toHaveBeenCalled();
  await page.retryChoosingMedia();expect(wxMock.chooseMedia).toHaveBeenCalledOnce();
  expect(wxMock.chooseMedia).toHaveBeenCalledWith(expect.objectContaining({count:1,sourceType:['camera']}));
});
it('retains the album choice across the native privacy hide/show and never opens the chooser in the background',async()=>{
  const privacy=deferred(),page=editor();
  wxMock.requirePrivacyAuthorize.mockImplementation(({success,fail}:any)=>{void privacy.promise.then(success,fail);});
  wxMock.chooseMedia.mockResolvedValue({tempFiles:[{tempFilePath:'/synthetic/after-privacy.jpg',size:120}]});
  const choosing=page.chooseImages('album');page.onHide();privacy.resolve({});await flush();
  expect(wxMock.chooseMedia).not.toHaveBeenCalled();expect(m.upload).not.toHaveBeenCalled();
  expect(page.nativeMedia).toBe('privacy');page.onShow();await choosing;await flush();
  expect(wxMock.requirePrivacyAuthorize).toHaveBeenCalledOnce();expect(wxMock.chooseMedia).toHaveBeenCalledOnce();
  expect(wxMock.chooseMedia).toHaveBeenCalledWith(expect.objectContaining({sourceType:['album'],count:9}));
  expect(m.upload).not.toHaveBeenCalled();expect(page.data).toMatchObject({photoEditorVisible:true,photoEditorFiles:[{path:'/synthetic/after-privacy.jpg',size:120}]});
  await page.photoEditorConfirmed({detail:{contextKey:page.data.photoEditorContext,files:page.data.photoEditorFiles}});
  expect(m.upload).toHaveBeenCalledOnce();expect(page.data.files).toEqual([expect.objectContaining({id:replacement,localPath:'/synthetic/after-privacy.jpg',state:'uploaded'})]);
  expect(page.data.uploadBusy).toBe(false);
});
it('ignores an old write-body event and preserves current card text before an explicit body replacement and next-tick focus',async()=>{
  const page=editor({body:'原始正文'});page.openTextCard();const oldKey=page.data.textCardContext;
  page.cancelTextCard({detail:{contextKey:oldKey}});page.openTextCard();const currentKey=page.data.textCardContext;
  page.textCardChanged({detail:{contextKey:currentKey,text:'文字卡片中尚未导出的最新正文'}});
  page.cancelTextCard({detail:{contextKey:oldKey,mode:'body'}});
  expect(page.data).toMatchObject({textCardVisible:true,bodyFocused:false});expect(wxMock.nextTick).not.toHaveBeenCalled();
  wxMock.showModal.mockResolvedValue({confirm:true});
  page.cancelTextCard({detail:{contextKey:currentKey,mode:'body'}});
  await flush();
  expect(page.data).toMatchObject({textCardVisible:false,body:'文字卡片中尚未导出的最新正文',dirty:true,bodyFocused:false});
  expect(wxMock.nextTick).toHaveBeenCalledOnce();wxMock.nextTick.mock.calls[0][0]();expect(page.data.bodyFocused).toBe(true);
  page.flushLocalBackup();expect(backups.readUgcBackup(owner,post,1)?.body).toBe('文字卡片中尚未导出的最新正文');
  expect(m.upload).not.toHaveBeenCalled();expect(m.request.mock.calls.some(([options])=>options.method)).toBe(false);
});
it('returns from an empty initial text-card entry without creating or deleting a server draft',async()=>{
  const page=instance();page.onLoad({new:'1',entry:'text'});page.onShow();await flush();
  expect(page.textCardOpenContext).toMatchObject({origin:'entry',postId:'',ownerId:'',version:0});
  expect(page.data.textCardVisible).toBe(true);const contextKey=page.data.textCardContext;
  m.request.mockClear();page.cancelTextCard({detail:{contextKey}});await flush();
  expect(m.request.mock.calls.some(([options])=>options.method)).toBe(false);
  expect(wxMock.navigateBack).toHaveBeenCalledOnce();expect(wxMock.showActionSheet).not.toHaveBeenCalled();
  expect(page.createdHerePostId).toBe('');expect(page.data.textCardVisible).toBe(false);
});
it('reopens a local initial text entry on continue-editing without claiming a server-scoped backup',async()=>{
  const page=instance();page.onLoad({new:'1',entry:'text'});page.onShow();await flush();const firstKey=page.data.textCardContext;
  page.textCardChanged({detail:{contextKey:firstKey,text:'尚未导出的护理备忘',template:'memo'}});page.flushLocalBackup();
  wxMock.showActionSheet.mockResolvedValue({tapIndex:1});m.request.mockClear();
  page.cancelTextCard({detail:{contextKey:firstKey}});await flush();
  expect(page.data).toMatchObject({textCardVisible:true,textCardText:'尚未导出的护理备忘',textCardTemplate:'memo',body:'',dirty:true,postId:'',ownerId:'',version:0});
  expect(page.data.textCardContext).not.toBe(firstKey);expect(page.textCardOpenContext.origin).toBe('entry');
  expect(m.request.mock.calls.some(([options])=>options.method)).toBe(false);expect(wxMock.navigateBack).not.toHaveBeenCalled();
  expect(storage.size).toBe(0);expect(backups.readUgcBackup(owner,post,1)).toBeNull();
});
it('explicitly discards a new unsaved image-and-text draft instead of leaving an empty saved row',async()=>{
  const page=instance();page.onLoad({new:'1'});page.onShow();await flush();
  page.editBody({detail:{value:'明确放弃本轮未保存的图文'}});page.setData({files:[image(first)]});page.flushLocalBackup();
  const retained=backups.readUgcBackup(owner,post,1)!;backups.writeUgcBackup({...retained,postId:otherPost});
  const deletion=deferred();m.request.mockClear();m.request.mockImplementation((options:any)=>options.method==='DELETE'?deletion.promise:defaultRequest(options));
  wxMock.showActionSheet.mockResolvedValue({tapIndex:2});const leaving=page.back();await flush();
  expect(m.request).toHaveBeenCalledExactlyOnceWith({path:`/v1/me/ugc/posts/${post}`,method:'DELETE',data:{expectedVersion:1}});
  expect(wxMock.navigateBack).not.toHaveBeenCalled();expect(backups.readUgcBackup(owner,post,1)).not.toBeNull();
  deletion.resolve({id:post,state:'deleted',version:2});await leaving;
  expect(wxMock.navigateBack).toHaveBeenCalledOnce();expect(page.createdHerePostId).toBe('');expect(page.data.dirty).toBe(false);
  expect(backups.readUgcBackup(owner,post,1)).toBeNull();expect(backups.readUgcBackup(owner,otherPost,1)?.body).toBe('明确放弃本轮未保存的图文');
});

function dragGeometry(page:any,options:{lefts?:number[];scrollLeft?:number;viewportWidth?:number;scrollWidth?:number;deferred?:boolean}={}){
  const lefts=options.lefts??[22,123,230],scrollLeft=options.scrollLeft??0;
  const results=[{left:22,top:140,width:options.viewportWidth??346,height:110},
    {scrollLeft,scrollWidth:options.scrollWidth??400},lefts.map(left=>({left,top:152,width:86,height:86}))];
  let deliver:(()=>void)|undefined;
  const query:any={select:()=>query,selectAll:()=>query,boundingClientRect:()=>query,fields:()=>query,
    exec:(callback:(value:any[])=>void)=>{deliver=()=>callback(results);if(!options.deferred)deliver();}};
  wxMock.createSelectorQuery=vi.fn(()=>query);page.mediaScrollPosition=scrollLeft;
  return ()=>deliver?.();
}
const dragTouch=(id:string,x:number,y=180,pointer=7)=>({currentTarget:{dataset:{id}},touches:[{identifier:pointer,clientX:x,clientY:y,pageX:x,pageY:y}],changedTouches:[]});
const dragEnd=(id:string,x:number,y=180)=>({...dragTouch(id,x,y),touches:[],changedTouches:[{identifier:7,clientX:x,clientY:y,pageX:x,pageY:y}]});
function beginDrag(page:any,id=first,x=42){const touch=dragTouch(id,x);page.startMediaTouch(touch);page.longPressMedia(touch);}

it('drags measured photo slots without writing or changing canonical order until one completed drop',async()=>{
  vi.useFakeTimers();const files=[image(first),image(middle),image(last)],page=editor({files});dragGeometry(page);
  const backup=vi.spyOn(page,'queueLocalBackup'),updates=vi.spyOn(page,'setData');beginDrag(page);
  expect(page.data).toMatchObject({mediaDragging:true,mediaDragId:first,mediaDragLeft:22,mediaDragTop:152});
  page.moveMediaDrag(dragTouch(first,245));page.moveMediaDrag(dragTouch(first,250));
  expect(updates.mock.calls.filter(([value])=>'mediaDragLeft' in (value as Record<string,unknown>))).toHaveLength(1);
  vi.advanceTimersByTime(16);expect(page.data.mediaDragOffsets).toEqual([0,-101,-107]);expect(page.data.mediaDragLeft).toBe(230);
  const offsetUpdates=updates.mock.calls.filter(([value])=>'mediaDragOffsets' in (value as Record<string,unknown>)).length;
  page.moveMediaDrag(dragTouch(first,252));vi.advanceTimersByTime(16);
  expect(updates.mock.calls.filter(([value])=>'mediaDragOffsets' in (value as Record<string,unknown>))).toHaveLength(offsetUpdates);
  expect(page.data.files).toEqual(files);expect(page.data.dirty).toBe(false);expect(backup).not.toHaveBeenCalled();
  page.endMediaTouch(dragEnd(first,250));expect(page.data.mediaDragDropping).toBe(true);expect(page.data.files).toEqual(files);
  await page.saveDraft();await page.submit();await page.addContent();page.removeImage(event(middle));page.editBody({detail:{value:'late keyboard input'}});
  expect(page.data.body).toBe('');expect(m.request).not.toHaveBeenCalled();expect(wxMock.showActionSheet).not.toHaveBeenCalled();
  vi.advanceTimersByTime(180);expect(page.data.files.map((file:any)=>file.id)).toEqual([middle,last,first]);expect(page.data.dirty).toBe(true);
  expect(backup).toHaveBeenCalledOnce();expect(updates.mock.calls.filter(([value])=>'files' in (value as Record<string,unknown>))).toHaveLength(1);
  expect(page.data.mediaDragging).toBe(false);expect(page.mediaDrag).toBeNull();expect(page.mediaEdgeTimer).toBeNull();
  page.flushLocalBackup();expect(backups.readUgcBackup(owner,post,1)?.mediaIds).toEqual([middle,last,first]);
  await page.openImageActions(event(first));expect(wxMock.showActionSheet).not.toHaveBeenCalled();expect(m.upload).not.toHaveBeenCalled();
});
it.each([false,true])('keeps unchanged order and previous dirty=%s on a no-op drop or touch cancellation',dirty=>{
  vi.useFakeTimers();const files=[image(first),image(middle),image(last)],page=editor({files,dirty});dragGeometry(page);
  const backup=vi.spyOn(page,'queueLocalBackup');beginDrag(page);page.endMediaTouch(dragEnd(first,42));vi.advanceTimersByTime(180);
  expect(page.data).toMatchObject({files,dirty,mediaDragging:false});expect(backup).not.toHaveBeenCalled();
  beginDrag(page);page.moveMediaDrag(dragTouch(first,250));vi.advanceTimersByTime(16);page.cancelMediaDrag();vi.runOnlyPendingTimers();
  expect(page.data).toMatchObject({files,dirty,mediaDragging:false});expect(backup).not.toHaveBeenCalled();expect(m.request).not.toHaveBeenCalled();
});
it.each(['account','revision','epoch','post','owner','version','files','busy','recovery','multiple_fingers','wrong_pointer'])('rejects a late drop across %s without persisting reordered media',boundary=>{
  vi.useFakeTimers();const files=[image(first),image(middle),image(last)],page=editor({files,dirty:true});dragGeometry(page);beginDrag(page);
  page.moveMediaDrag(dragTouch(first,250));vi.advanceTimersByTime(16);
  if(boundary==='account')m.token='member-b';else if(boundary==='revision')m.revision++;
  else if(boundary==='epoch')page.data.epoch++;else if(boundary==='post')page.data.postId=otherPost;else if(boundary==='owner')page.data.ownerId=otherPost;
  else if(boundary==='version')page.data.version++;else if(boundary==='files')page.data.files=[image(first),image(middle)];
  else if(boundary==='busy')page.data.busy=true;else if(boundary==='recovery')page.data.writeRecovery='save';
  else if(boundary==='multiple_fingers')page.guardMediaDragTouch({...dragTouch(first,250),touches:[...dragTouch(first,250).touches,...dragTouch(first,250,180,8).touches]});
  else page.moveMediaDrag(dragTouch(first,250,180,8));
  const retained=structuredClone(page.data.files);page.endMediaTouch(dragEnd(first,250));vi.runOnlyPendingTimers();
  expect(page.data).toMatchObject({files:retained,dirty:true,mediaDragging:false});expect(page.mediaDrag).toBeNull();
  expect(page.backupTimer).toBeNull();expect(m.request).not.toHaveBeenCalled();expect(m.upload).not.toHaveBeenCalled();
});
it.each(['hide','unload','resize'])('cancels a pending drop on %s, releasing all gesture timers without changing media',boundary=>{
  vi.useFakeTimers();const files=[image(first),image(middle),image(last)],page=editor({files,dirty:true});dragGeometry(page);beginDrag(page);
  page.moveMediaDrag(dragTouch(first,355));vi.advanceTimersByTime(16);page.endMediaTouch(dragEnd(first,355));
  if(boundary==='hide')page.onHide();else if(boundary==='unload')page.onUnload();else page.onResize();
  vi.runOnlyPendingTimers();expect(page.data).toMatchObject({files,dirty:true,mediaDragging:false});
  expect(page.mediaDragTimer).toBeNull();expect(page.mediaMoveTimer).toBeNull();expect(page.mediaEdgeTimer).toBeNull();expect(m.request).not.toHaveBeenCalled();
});
it('keeps ordinary swipes and delete touches out of drag, including a late geometry callback',()=>{
  const files=[image(first),image(middle),image(last)],page=editor({files});const deliver=dragGeometry(page,{deferred:true});
  page.startMediaTouch(dragTouch(first,42));page.trackMediaTouch(dragTouch(first,60));deliver();page.longPressMedia(dragTouch(first,60));
  expect(page.data.mediaDragging).toBe(false);expect(page.mediaPress).toBeNull();
  const late=dragGeometry(page,{deferred:true});page.startMediaTouch(dragTouch(first,42));page.longPressMedia(dragTouch(first,42));page.endMediaTouch(dragEnd(first,42));late();
  expect(page.data.mediaDragging).toBe(false);expect(page.mediaDrag).toBeNull();
  dragGeometry(page);page.startMediaTouch(dragTouch(first,42));page.holdMediaControl();page.removeImage(event(middle));
  expect(page.data.files.map((file:any)=>file.id)).toEqual([first,last]);expect(page.mediaPress).toBeNull();expect(wxMock.showActionSheet).not.toHaveBeenCalled();
});
it('advances a nine-photo edge drag only after real scroll feedback and drops into the visible last slot',()=>{
  vi.useFakeTimers();const files=Array.from({length:9},(_,index)=>image(`photo-${index}`)),page=editor({files});
  dragGeometry(page,{lefts:files.map((_,index)=>22+index*98),viewportWidth:346,scrollWidth:882});beginDrag(page,'photo-0',42);
  page.moveMediaDrag(dragTouch('photo-0',350));vi.advanceTimersByTime(64);
  expect(page.data.mediaScrollLeft).toBe(12);expect(page.mediaDrag.scrollLeft).toBe(0);expect(page.mediaDrag.target).toBe(3);
  page.onMediaScroll({detail:{scrollLeft:536}});vi.advanceTimersByTime(16);expect(page.mediaDrag.target).toBe(8);
  page.endMediaTouch(dragEnd('photo-0',300));expect(page.data.mediaDragLeft).toBe(270);vi.advanceTimersByTime(180);
  expect(page.data.files.map((file:any)=>file.id)).toEqual([...files.slice(1).map(file=>file.id),'photo-0']);
  expect(page.mediaEdgeTimer).toBeNull();expect(m.request).not.toHaveBeenCalled();
});
it('offers at most six real photo actions, including equivalent movement and a cancel that changes nothing',async()=>{
  const files=[image(first),image(middle),image(last),image(replacement)],page=editor({files});wxMock.showActionSheet.mockRejectedValueOnce({errMsg:'cancel'});
  await page.openImageActions(event(last));expect(page.data).toMatchObject({files,dirty:false});
  expect(wxMock.showActionSheet.mock.calls[0][0].itemList).toEqual(['预览图片','编辑图片','设为首图','向前移动','向后移动','移除图片']);
  wxMock.showActionSheet.mockResolvedValueOnce({tapIndex:3});await page.openImageActions(event(last));expect(page.data.files.map((file:any)=>file.id)).toEqual([first,last,middle,replacement]);
  wxMock.showActionSheet.mockResolvedValueOnce({tapIndex:1});await page.openImageActions(event(first));expect(page.data.photoEditorVisible).toBe(true);
  expect(m.upload).not.toHaveBeenCalled();expect(m.request.mock.calls.some(([options])=>options.method)).toBe(false);
});
it('starts at a nonzero native scroll offset without a lift jump and can drop last-to-first',()=>{
  vi.useFakeTimers();const files=[image(first),image(middle),image(last)],page=editor({files});
  dragGeometry(page,{lefts:[-128,-27,80],scrollLeft:150,scrollWidth:550});beginDrag(page,last,100);
  expect(page.data).toMatchObject({mediaDragLeft:80,mediaDragTop:152});expect(page.mediaDrag.originScroll).toBe(150);
  page.onMediaScroll({detail:{scrollLeft:0}});page.moveMediaDrag(dragTouch(last,42));vi.advanceTimersByTime(16);
  expect(page.mediaDrag.target).toBe(0);expect(page.data.mediaDragOffsets).toEqual([101,107,0]);
  page.endMediaTouch(dragEnd(last,42));expect(page.data.mediaDragLeft).toBe(22);vi.advanceTimersByTime(180);
  expect(page.data.files.map((file:any)=>file.id)).toEqual([last,first,middle]);
});
it('blocks late media taps after a cancelled lift, then permits a fresh action after the suppression interval',async()=>{
  vi.useFakeTimers();const files=[image(first),image(middle),image(last)],page=editor({files});dragGeometry(page);beginDrag(page);page.cancelMediaDrag();
  page.removeImage(event(middle));await page.addContent();await page.openPhotoEditorForImage(event(first));await page.openImageActions(event(first));
  expect(page.data).toMatchObject({files,dirty:false,photoEditorVisible:false});expect(wxMock.showActionSheet).not.toHaveBeenCalled();expect(m.request).not.toHaveBeenCalled();
  vi.advanceTimersByTime(401);page.removeImage(event(middle));expect(page.data.files.map((file:any)=>file.id)).toEqual([first,last]);
});
it.each(['missing_rect','changed_state'])('does not lift or modify media after %s during layout measurement',boundary=>{
  const files=[image(first),image(middle),image(last)],page=editor({files});
  if(boundary==='missing_rect'){
    const query:any={select:()=>query,selectAll:()=>query,boundingClientRect:()=>query,fields:()=>query,exec:(callback:(value:any[])=>void)=>callback([null,null,[]])};
    wxMock.createSelectorQuery=()=>query;page.startMediaTouch(dragTouch(first,42));page.longPressMedia(dragTouch(first,42));
  }else{
    const deliver=dragGeometry(page,{deferred:true});page.startMediaTouch(dragTouch(first,42));page.longPressMedia(dragTouch(first,42));page.data.state='hidden';deliver();
  }
  expect(page.data).toMatchObject({files,dirty:false,mediaDragging:false});expect(page.mediaDrag).toBeNull();expect(m.request).not.toHaveBeenCalled();
});
it.each(['version','signature','post','owner'])('ignores a late photo menu choice after its %s scope changes',async boundary=>{
  const files=[image(first),image(middle),image(last)],page=editor({files}),answer=deferred();wxMock.showActionSheet.mockReturnValueOnce(answer.promise);
  const opening=page.openImageActions(event(middle));
  if(boundary==='version')page.data.version++;else if(boundary==='signature')page.data.files=[image(first),{...image(middle),localPath:'/synthetic/new-source.jpg'},image(last)];
  else if(boundary==='post')page.data.postId=otherPost;else page.data.ownerId=otherPost;
  const retained=structuredClone(page.data.files);answer.resolve({tapIndex:2});await opening;
  expect(page.data).toMatchObject({files:retained,dirty:false});expect(m.request).not.toHaveBeenCalled();expect(m.upload).not.toHaveBeenCalled();
});
it.each(['changed','noop','cancel'])('keeps the saved notice truthful after a %s photo drag following a successful save',async outcome=>{
  vi.useFakeTimers();const files=[image(first),image(middle),image(last)],page=editor({files,dirty:true});
  m.request.mockImplementation((options:any)=>options.method==='PUT'?Promise.resolve(draft({version:2,media:files.map(file=>({id:file.id,state:'uploaded'}))})):defaultRequest(options));
  await page.saveDraft();expect(page.data).toMatchObject({dirty:false,notice:'草稿已保存。',version:2});m.request.mockClear();dragGeometry(page);beginDrag(page);
  if(outcome==='cancel'){page.moveMediaDrag(dragTouch(first,250));page.cancelMediaDrag();}
  else {page.endMediaTouch(dragEnd(first,outcome==='changed'?250:42));vi.advanceTimersByTime(180);}
  expect(page.data.notice).toBe(outcome==='changed'?'':'草稿已保存。');expect(page.data.dirty).toBe(outcome==='changed');
  expect(m.request).not.toHaveBeenCalled();expect(m.upload).not.toHaveBeenCalled();
});
it.each(['已恢复未提交的修改；若有图片未显示，请检查后保存草稿。','本次修改尚未保存，请点击“存草稿”。'])('retains the existing recovery notice when media changes: %s',notice=>{
  vi.useFakeTimers();const page=editor({files:[image(first),image(middle),image(last)],notice});dragGeometry(page);beginDrag(page);
  page.endMediaTouch(dragEnd(first,250));vi.advanceTimersByTime(180);
  expect(page.data).toMatchObject({dirty:true,notice});
});
