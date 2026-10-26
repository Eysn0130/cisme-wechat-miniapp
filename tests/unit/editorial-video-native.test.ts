import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({request:vi.fn(),pause:vi.fn(),stop:vi.fn(),exit:vi.fn()}));
vi.mock("../../apps/miniprogram/services/api",()=>({request:mocks.request,resumeAuthentication:vi.fn(),beginLegalRenewal:vi.fn(),clearAuthenticationRedirectSuppression:vi.fn()}));
vi.mock("../../apps/miniprogram/services/page-requests",()=>({pageRead:(_page:unknown,options:unknown)=>mocks.request(options),cancelPageReads:vi.fn()}));
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>"",motionDuration:()=>0}));
vi.mock("../../apps/miniprogram/services/share",()=>({prepareShareLink:vi.fn(),registerIncomingShare:vi.fn()}));
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const videoPath=`/v1/editorial/media/${id}/${"c".repeat(64)}`;
const posterPath=`/v1/editorial/media/${id}/${"d".repeat(64)}`;
const video=()=>({id:"c".repeat(64),url:videoPath,type:"video" as const,mimeType:"video/mp4" as const,width:1080,height:1920,durationMs:69473,posterUrl:posterPath});
const article=()=>({id,version:1,authorId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",author:"品牌作者",title:"漂染后如何护理",body:"原帖正文",publishedAt:"2026-10-26T09:00:00Z",media:[video()],interactionsEnabled:true,liked:false,saved:false,following:false,isMine:true,likeCount:0,saveCount:0});
let page:any;
const event=(detail:Record<string,unknown>={})=>({detail,currentTarget:{dataset:{videoIdentity:page.data.videoEventId}}});
async function mount(){await import("../../apps/miniprogram/pages/post/index");page.onLoad({id,source:"editorial"});await page.load();}
beforeEach(()=>{
 vi.resetModules();vi.clearAllMocks();
 (globalThis as any).getApp=()=>({globalData:{sessionToken:"",apiBaseUrl:"https://synthetic.invalid"}});
 (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(updates:any){Object.assign(this.data,structuredClone(updates));}};};
 (globalThis as any).wx={hideShareMenu:vi.fn(),showShareMenu:vi.fn(),createVideoContext:vi.fn(()=>({pause:mocks.pause,stop:mocks.stop,exitFullScreen:mocks.exit}))};
});

describe("published editorial video in the native post page",()=>{
 it("plays only through the authorized media route and keeps the video out of image previews",async()=>{
  mocks.request.mockResolvedValue(article());await mount();
  expect(page.data.media).toEqual([]);
  expect(page.data.video).toEqual({src:"https://synthetic.invalid"+videoPath,poster:"https://synthetic.invalid"+posterPath,height:1000,durationSeconds:69.473});
  expect(page.data.videoInitialTime).toBe(0);expect(mocks.pause).not.toHaveBeenCalled();
 });
 it("pauses and exits full screen on hide, retains the position, and never auto-plays on return",async()=>{
  mocks.request.mockResolvedValue(article());await mount();page.videoTimeChanged(event({currentTime:12.75}));
  page.onHide();expect(mocks.pause).toHaveBeenCalledOnce();expect(mocks.exit).toHaveBeenCalledOnce();
  page.readVisible=true;await page.load();expect(page.data.videoInitialTime).toBe(12.75);
  expect((globalThis as any).wx.createVideoContext).toHaveBeenCalledWith("editorial-video",page);
  page.onUnload();expect(mocks.stop).toHaveBeenCalledOnce();
 });
 it("does not carry a position into a revised video or allow late hidden time updates",async()=>{
  mocks.request.mockResolvedValue(article());await mount();page.videoTimeChanged(event({currentTime:17}));page.onHide();
  page.videoTimeChanged(event({currentTime:40}));expect(page.videoPosition).toBe(17);
  page.readVisible=true;mocks.request.mockResolvedValue({...article(),version:2});await page.load();expect(page.data.videoInitialTime).toBe(0);
  page.videoTimeChanged(event({currentTime:Infinity}));expect(page.videoPosition).toBe(0);
 });
 it("ignores events from a removed player after reloading the same article",async()=>{
  mocks.request.mockResolvedValue(article());await mount();const old=event({currentTime:40});await page.load();
  page.videoTimeChanged(old);page.videoFailed(old);page.videoPosition=12;page.videoEnded(old);
  expect(page.data.mediaError).toBe("");expect(page.videoPosition).toBe(12);
  page.videoTimeChanged(event({currentTime:7}));expect(page.videoPosition).toBe(7);
 });
 it("shows a playback failure without claiming success and resets it on an actual fresh read",async()=>{
  mocks.request.mockResolvedValue(article());await mount();page.videoFailed(event());expect(page.data.mediaError).toBe("视频暂时无法播放，请重新加载。");
  await page.load();expect(page.data.mediaError).toBe("");
  page.videoTimeChanged(event({currentTime:68}));page.videoEnded(event());expect(page.videoPosition).toBe(0);
 });
 it.each([
  {url:"https://foreign.invalid/video.mp4"},
  {posterUrl:"https://foreign.invalid/poster.webp"},
  {mimeType:"video/unknown"},
  {durationMs:0},
  {width:-1}
 ])("fails closed for malformed video metadata %j",async(patch)=>{
  mocks.request.mockResolvedValue({...article(),media:[{...video(),...patch}]});await mount();
  expect(page.data.item).toBeNull();expect(page.data.video).toBeNull();expect(page.data.errorKind).toBe("load");
 });
 it("keeps existing image order and rejects a mixed video/image publication",async()=>{
  const {editorialDisplayMedia}=await import("../../apps/miniprogram/services/editorial");
  const images=[{id:"d".repeat(64),url:posterPath},{id:"c".repeat(64),url:videoPath}];
  expect(editorialDisplayMedia(images)).toEqual({images:images.map(item=>"https://synthetic.invalid"+item.url),video:null});
  expect(()=>editorialDisplayMedia([video(),images[0]!])).toThrow("EDITORIAL_VIDEO_INVALID");
 });
});
