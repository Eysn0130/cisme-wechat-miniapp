import {beforeEach,describe,expect,it,vi}from'vitest';
const m=vi.hoisted(()=>({request:vi.fn(),token:'synthetic-member-a',pause:vi.fn(),exit:vi.fn(),stop:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,resumeAuthentication:vi.fn(),beginLegalRenewal:vi.fn(),clearAuthenticationRedirectSuppression:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',motionDuration:()=>0}));
vi.mock('../../apps/miniprogram/services/share',()=>({prepareShareLink:vi.fn(),registerIncomingShare:vi.fn()}));
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const media=(name:string,article=id)=>({id:name.repeat(64),url:`/v1/editorial/media/${article}/${name.repeat(64)}`});
const article=()=>({id,version:3,authorId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',author:'公开作者',title:'两图原帖',body:'正文',publishedAt:'2026-10-26T09:00:00Z',media:[media('d'),media('e')],interactionsEnabled:true,liked:false,saved:false,following:false,isMine:true,likeCount:0,saveCount:0});
const delayed=()=>{let resolve!:(v:any)=>void,reject!:(v:any)=>void;const promise=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
let page:any,wxMock:any;
async function mount(){await import('../../apps/miniprogram/pages/post/index');page.onLoad({id,source:'editorial'});await page.load();return page;}
function chooseSecond(){page.onMediaChange({detail:{current:1}});page.mediaLoaded({currentTarget:{dataset:{index:0}},detail:{width:750,height:900}});expect(page.data.mediaIndex).toBe(1);expect(page.data.galleryHeight).toBe(900);}
async function resume(){page.onHide();page.onShow();await vi.waitFor(()=>expect(page.data.loading).toBe(false));}
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();m.token='synthetic-member-a';m.request.mockResolvedValue(article());
 (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token,apiBaseUrl:'https://synthetic.invalid'}});
 (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(values:any){Object.assign(this.data,structuredClone(values));}};};
 wxMock={hideShareMenu:vi.fn(),showShareMenu:vi.fn(),showToast:vi.fn(),previewImage:vi.fn(),navigateBack:vi.fn(),switchTab:vi.fn(),
  createVideoContext:vi.fn(()=>({pause:m.pause,exitFullScreen:m.exit,stop:m.stop}))};(globalThis as any).wx=wxMock;
});

describe('candidate: native image-preview return retains only a newly revalidated matching gallery',()=>{
 it('reproduces second-image preview/close/onShow and restores 2/2 plus height after the fresh GET',async()=>{
  await mount();chooseSecond();const selected=page.data.media[1];await page.previewMedia({currentTarget:{dataset:{src:selected}}});
  expect(wxMock.previewImage).toHaveBeenCalledWith(expect.objectContaining({current:selected,urls:page.data.media}));
  await resume();expect(m.request).toHaveBeenCalledTimes(2);expect(m.request.mock.calls.every(([o])=>o.path===`/v1/editorial/articles/${id}`&&o.authMode==='optional')).toBe(true);
  expect(page.data).toMatchObject({mediaIndex:1,galleryHeight:900,item:{id,version:3},loading:false,error:''});
 });
 it('also resumes the same validated article on ordinary hide/show without changing the route or share path',async()=>{
  await mount();chooseSecond();await resume();expect(page.data.mediaIndex).toBe(1);
  expect(page.onShareAppMessage().path).toBe(`/pages/post/index?id=${id}&source=editorial`);page.back();expect(wxMock.navigateBack).toHaveBeenCalledOnce();expect(wxMock.switchTab).not.toHaveBeenCalled();
 });
 it.each([undefined,{type:'tap',detail:{}}])('an explicit refresh %j cannot opt into preserving the prior index',async(event)=>{
  await mount();chooseSecond();await page.load(event);expect(page.data).toMatchObject({mediaIndex:0,galleryHeight:1000});
 });
 it('does not restore when the publication version changes despite identical images',async()=>{
  await mount();chooseSecond();m.request.mockResolvedValue({...article(),version:4});await resume();expect(page.data).toMatchObject({mediaIndex:0,galleryHeight:1000,item:{version:4}});
 });
 it.each(['reorder','replace','remove','append']as const)('does not restore an image collection change: %s',async(mode)=>{
  await mount();chooseSecond();const value=article();
  value.media=mode==='reorder'?[...value.media].reverse():mode==='replace'?[media('d'),media('f')]:mode==='remove'?[media('d')]:[...value.media,media('f')];
  m.request.mockResolvedValue(value);await resume();expect(page.data.mediaIndex).toBe(0);expect(page.data.galleryHeight).toBe(1000);
 });
 it.each([['synthetic-a','synthetic-b'],['synthetic-a',''],['','synthetic-a']])('does not carry selection across identity transition %j',async(from,to)=>{
  m.token=from;await mount();chooseSecond();m.token=to;await resume();expect(page.data.mediaIndex).toBe(0);expect(page.data.galleryHeight).toBe(1000);
 });
 it('does not restore the prior article when the route ID changes',async()=>{
  await mount();chooseSecond();page.setData({id:other});m.request.mockResolvedValue({...article(),id:other,media:[media('d',other),media('e',other)]});await resume();
  expect(page.data.item.id).toBe(other);expect(page.data.mediaIndex).toBe(0);
 });
 it.each([-1,2,1.5])('rejects an invalid saved index %s instead of clamping it onto an unrelated image',async(index)=>{
  await mount();chooseSecond();page.setData({mediaIndex:index});await resume();expect(page.data.mediaIndex).toBe(0);
 });
 it('keeps a valid second image but falls back to the normal height when the previous height is invalid',async()=>{
  await mount();chooseSecond();page.setData({galleryHeight:NaN});await resume();expect(page.data).toMatchObject({mediaIndex:1,galleryHeight:1000});
 });
 it('clears selection on a failed refresh and never revives it on an explicit retry',async()=>{
  await mount();chooseSecond();m.request.mockRejectedValue(new Error('offline'));await resume();
  expect(page.data).toMatchObject({mediaIndex:0,item:null,media:[],errorKind:'load'});expect(page.galleryRead).toBeNull();
  m.request.mockResolvedValue(article());await page.load();expect(page.data.mediaIndex).toBe(0);
 });
 it('clears a withdrawn gallery rather than keeping its old selected image',async()=>{
  await mount();chooseSecond();m.request.mockRejectedValue({status:404});await resume();expect(page.data).toMatchObject({item:null,media:[],mediaIndex:0,errorKind:'missing'});expect(page.galleryRead).toBeNull();
 });
 it('does not apply a matching but late response after the page hides again',async()=>{
  await mount();chooseSecond();const late=delayed();m.request.mockReturnValueOnce(late.promise);const load=page.load(true);page.onHide();late.resolve(article());await load;
  expect(page.data.item).toBeNull();expect(page.data.mediaIndex).toBe(0);expect(page.galleryRead).toBeNull();
 });
 it('drops a read that returns after another identity becomes current',async()=>{
  await mount();chooseSecond();const late=delayed();m.request.mockReturnValueOnce(late.promise);const load=page.load(true);m.token='synthetic-member-b';late.resolve(article());await load;
  expect(page.data.item).toBeNull();expect(page.data.mediaIndex).toBe(0);expect(page.galleryRead).toBeNull();
  m.request.mockResolvedValue(article());await resume();expect(page.data.mediaIndex).toBe(0);
 });
 it('does not let an older matching response overwrite a newer refresh version',async()=>{
  await mount();chooseSecond();const late=delayed();m.request.mockReturnValueOnce(late.promise);const first=page.load(true);
  m.request.mockResolvedValue({...article(),version:4});await page.load();late.resolve(article());await first;
  expect(page.data).toMatchObject({item:{version:4},mediaIndex:0,galleryHeight:1000});expect(page.galleryRead.version).toBe(4);
 });
 it('clears private read identity on unload and new route creation starts at image one',async()=>{
  await mount();chooseSecond();page.onUnload();expect(page.galleryRead).toBeNull();expect(page.data.pageAlive).toBe(false);
 });
 it('leaves the existing video pause/resume and event identity contract intact',async()=>{
  const value={...article(),media:[{id:'c'.repeat(64),url:media('c').url,type:'video',mimeType:'video/mp4',width:720,height:1280,durationMs:48300,posterUrl:media('d').url}]};
  m.request.mockResolvedValue(value);await mount();const event={detail:{currentTime:12.5},currentTarget:{dataset:{videoIdentity:page.data.videoEventId}}};
  page.videoTimeChanged(event);await resume();expect(page.galleryRead).toBeNull();expect(page.data.media).toEqual([]);expect(page.data.videoInitialTime).toBe(12.5);expect(m.pause).toHaveBeenCalled();expect(m.exit).toHaveBeenCalled();
 });
});
