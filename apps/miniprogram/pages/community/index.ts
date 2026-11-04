import { projectFeedCards, feedColumnPatch } from "../../services/feed-projection";
import { measurementClock, recordClientMetric } from "../../services/performance-metrics";
import { pageRead, cancelPageReads } from "../../services/page-requests";
import { defaultMemberAvatar, localMemberAvatar, prepareFeedAuthors, prepareFeedPage } from "../../services/member-avatar";
import { request, resumeAuthentication } from "../../services/api";
import { editorialStoriesForRuntime, editorialMediaSrc, publishedEditorialArticles, expiredEditorialRead, type PublishedEditorialCard } from "../../services/editorial";
import { editorialPublisherAvatar } from "../../services/editorial-publisher";
import { currentChromeStyle } from "../../services/layout";
import { memberIdentity } from "../../services/member-identity";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { readFollowingFeed } from "../../services/following-feed";
import { createComposeMediaIntent,discardComposeMediaIntent,revokeComposeMediaIntents,type ComposeMediaIntentPayload } from "../../services/community-compose-intent";

type PublisherOwner={token:string;revision:number;epoch:number};
const publisherRouteCurrent=()=>{try{const pages=getCurrentPages();return !pages.length||pages[pages.length-1]?.route==="pages/community/index";}catch{return false;}};
const mediaPermissionFailure=(error:unknown)=>/(deny|denied|auth|permission|scope)/i.test(String((error as {errMsg?:string;code?:string})?.errMsg||(error as {code?:string})?.code||""));
async function validatePublisherFiles(files:Array<{tempFilePath:string;size:number}>,source:"album"|"camera"){
  if(!files.length||files.length>(source==="camera"?1:9))throw {title:"请选择有效图片后继续。"};
  const selected:ComposeMediaIntentPayload["files"]=[];
  for(const file of files){
    if(!Number.isSafeInteger(file.size)||file.size<1||file.size>10*1024*1024)throw {title:"单张图片需小于10MB，请重新选择。"};
    let bytes:Uint8Array;
    try{bytes=await new Promise<Uint8Array>((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:file.tempFilePath,position:0,length:12,
      success:value=>resolve(new Uint8Array(value.data as ArrayBuffer)),fail:reject}));}
    catch{throw {title:"图片暂时无法读取，请重新选择。"};}
    const jpeg=bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;
    const png=bytes.length>=8&&bytes.slice(0,8).every((value,index)=>value===[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a][index]);
    const webp=String.fromCharCode(...bytes.slice(0,4))==="RIFF"&&String.fromCharCode(...bytes.slice(8,12))==="WEBP";
    if(!jpeg&&!png&&!webp)throw {title:"仅支持JPG、PNG或WEBP图片，请重新选择。"};
    selected.push({path:file.tempFilePath,size:file.size});
  }
  return selected;
}

const feedModels = new WeakMap<object, { feed: any[]; following: any[]; editorial: PublishedEditorialCard[]; followingReady: boolean; followingOwner: string }>();
const communityReadOwner = () => {
  const context = getApp<IAppOption>().globalData;
  return JSON.stringify([context.sessionToken, commerceContextRevision(), context.apiBaseUrl, context.cloudFunction?.env, context.cloudFunction?.name]);
};
const initialEditorialStories = editorialStoriesForRuntime();
function feedModel(page: object) {
  let model = feedModels.get(page);
  if (!model) { model = { feed: [], following: [], editorial: [], followingReady: false, followingOwner: "" }; feedModels.set(page, model); }
  return model;
}
const chromeHideTravel = 24;
const chromeRevealTravel = 8;
const chromeRecoveryMs = 180;
let chromeRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let lastScrollTop = 0;
let scrollPrimed = false;
let scrollDirection: -1 | 0 | 1 = 0;
let scrollTravel = 0;

Page({
  readOwner: "",
  readVisible:true,
  followingRequested:false,
  publisherAlive:true,publisherEpoch:0,publisherOwner:null as PublisherOwner|null,
  publisherNative:"" as ""|"privacy"|"picker"|"settings",publisherReturn:null as (()=>void)|null,
  publisherIntentId:"",publisherTransferActive:false,publisherNavigationEpoch:0,
  data: { feedReady:false,publishEntryOpen:false,publishEntryBusy:false,publishEntryError:"",publishEntryRecovery:"" as ""|"privacy"|"settings",publishEntrySource:"" as ""|"album"|"camera", reportCategoryLabels:{spam:'垃圾信息',harassment:'骚扰',unsafe_advice:'不安全建议',illegal:'违法内容',intellectual_property:'知识产权',privacy:'隐私',other:'其他'},mode: "featured", ugcFeedEnabled: false, ugcDraftsEnabled: false, socialPreviewEnabled: false, canReview: false, signedIn: false, follows: [] as string[], profileReviewQueue: [] as any[], formalReportQueue:[] as any[],reportNextCursor:null as string|null,reportTotal:0,reportLoadingMore:false,formalAppealQueue:[] as any[],appealNextCursor:null as string|null,appealTotal:0,appealLoadingMore:false,reviewActorId:"",reviewBusy: false, teamError: "", reviewNotice:"",editorialNextCursor:null as string|null,formalNextCursor: null as string|null, followingNextCursor:null as string|null, formalLoadingMore:false, moreError:"", displayFeedCount: initialEditorialStories.length, feedColumns: projectFeedCards(initialEditorialStories), hero: initialEditorialStories[0] ?? null, feedAttempt: 0, chromeStyle: currentChromeStyle(), chromeHidden: false, loading: true, navigating: false, error: "" },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onShow() {
    this.readVisible=true;
    this.publisherAlive=true;
    const nativePublisherReturn=Boolean(this.publisherNative&&this.publisherOwner&&this.publisherCurrent(this.publisherOwner,false)&&this.data.publishEntryOpen);
    if(this.publisherTransferActive&&!this.publisherOwner)this.clearPublisherWork(false);
    if(this.publisherOwner&&!this.publisherCurrent(this.publisherOwner,false))this.clearPublisherWork(false);
    this.publisherReturn?.();this.publisherReturn=null;
    this.resetChromeMotion();
    const signedIn = Boolean(getApp<IAppOption>().globalData.sessionToken);
    this.setData({ navigating: false, chromeHidden: false, signedIn,
      ...(this.followingRequested ? {mode:signedIn?"following":"featured"} : {}) });
    this.followingRequested=false;
    const tab = this.getTabBar?.();
    if (tab) tab.setData({ active: 2, externalBusy: false });
    tab?.syncActive?.(2);
    tab?.setPresentation?.("community-scroll", false);
    tab?.setPresentation?.("community-publisher",this.data.publishEntryOpen);
    if(!nativePublisherReturn)tab?.setCommunityPublisherAvailable?.(false);
    void this.load(nativePublisherReturn);
  },
  onHide() {
    this.readVisible=false;
    const nativeReturn=Boolean(this.publisherNative&&this.publisherOwner&&this.publisherCurrent(this.publisherOwner,false));
    if(!nativeReturn)this.clearPublisherWork(this.publisherTransferActive);
    cancelPageReads(this);
    this.data.feedAttempt += 1;

    this.resetChromeMotion();
    const tab = this.getTabBar?.();
    tab?.setPresentation?.("community-scroll", false);
    if(!nativeReturn)tab?.setCommunityPublisherAvailable?.(false);
    this.setData({ chromeHidden: false, canReview: false, profileReviewQueue: [], formalReportQueue:[],reportNextCursor:null,reportTotal:0,formalAppealQueue:[],appealNextCursor:null,appealTotal:0,reviewActorId:"",reviewNotice:"" });
  },
  onUnload() {
    this.readVisible=false;
    this.publisherAlive=false;this.clearPublisherWork(false);
    cancelPageReads(this); feedModels.delete(this);
    this.data.feedAttempt += 1;

    this.resetChromeMotion();
  },
  resetChromeMotion() {
    if (chromeRecoveryTimer) clearTimeout(chromeRecoveryTimer);
    chromeRecoveryTimer = null;
    lastScrollTop = 0;
    scrollPrimed = false;
    scrollDirection = 0;
    scrollTravel = 0;
  },
  setCommunityChromeHidden(hidden: boolean) {
    if (this.data.chromeHidden === hidden) return;
    this.setData({ chromeHidden: hidden });
    this.getTabBar?.()?.setPresentation?.("community-scroll", hidden);
  },
  scheduleChromeRecovery() {
    if (chromeRecoveryTimer) clearTimeout(chromeRecoveryTimer);
    chromeRecoveryTimer = setTimeout(() => {
      chromeRecoveryTimer = null;
      scrollDirection = 0;
      scrollTravel = 0;
      this.setCommunityChromeHidden(false);
    }, chromeRecoveryMs);
  },
  onPageScroll(event: { scrollTop: number }) {
    const scrollTop = Math.max(0, Number(event.scrollTop) || 0);
    if (!scrollPrimed) {
      lastScrollTop = scrollTop;
      scrollPrimed = true;
      if (scrollTop <= 12) this.setCommunityChromeHidden(false);
      return;
    }
    const delta = scrollTop - lastScrollTop;
    lastScrollTop = scrollTop;
    if (scrollTop <= 12) {
      scrollDirection = 0;
      scrollTravel = 0;
      this.setCommunityChromeHidden(false);
      return;
    }
    if (this.data.chromeHidden) this.scheduleChromeRecovery();
    if (Math.abs(delta) < 1) return;
    const direction: -1 | 1 = delta > 0 ? 1 : -1;
    if (direction !== scrollDirection) {
      scrollDirection = direction;
      scrollTravel = 0;
    }
    scrollTravel += delta;
    if (!this.data.chromeHidden && direction === 1 && scrollTravel >= chromeHideTravel) {
      scrollTravel = 0;
      this.setCommunityChromeHidden(true);
      this.scheduleChromeRecovery();
    } else if (this.data.chromeHidden && direction === -1 && scrollTravel <= -chromeRevealTravel) {
      scrollTravel = 0;
      this.setCommunityChromeHidden(false);
    }
  },
  openPublisher() {
    if (this.data.navigating||this.data.publishEntryBusy||!this.readVisible||!this.data.ugcDraftsEnabled||this.data.mode==="review") return;
    if (!getApp<IAppOption>().globalData.sessionToken) { resumeAuthentication("/pages/community/index"); return; }
    if(this.data.publishEntryOpen)return;
    this.clearPublisherWork(false);
    this.publisherOwner={token:getApp<IAppOption>().globalData.sessionToken,revision:commerceContextRevision(),epoch:++this.publisherEpoch};
    this.setData({publishEntryOpen:true,publishEntryError:"",publishEntryRecovery:"",publishEntrySource:""});
    this.getTabBar?.()?.setPresentation?.("community-publisher",true);
  },
  syncPublisherEntry() {
    if(this.publisherOwner&&(!getApp<IAppOption>().globalData.sessionToken||this.data.mode==="review"))this.clearPublisherWork(false);
    this.getTabBar?.()?.setCommunityPublisherAvailable?.(
      this.readVisible && Boolean(getApp<IAppOption>().globalData.sessionToken) && this.data.ugcDraftsEnabled && this.data.mode !== "review",
      this.data.ugcFeedEnabled ? "创作护理故事" : "写仅自己可见的草稿"
    );
  },
  openMyPosts() {
    if (this.data.navigating||this.data.publishEntryBusy) return;
    if (!getApp<IAppOption>().globalData.sessionToken) { resumeAuthentication("/pages/community/index"); return; }
    this.clearPublisherWork(false);
    this.setData({ navigating: true });
    wx.navigateTo({ url: "/pages/community-compose/index", fail: () => { this.setData({ navigating: false }); wx.showToast({ title: "我的内容暂时无法打开", icon: "none" }); } });
  },
  publisherCurrent(owner:PublisherOwner,visible=true){return this.publisherAlive&&this.publisherOwner===owner&&owner.epoch===this.publisherEpoch&&
    owner.token===getApp<IAppOption>().globalData.sessionToken&&owner.revision===commerceContextRevision()&&publisherRouteCurrent()&&(!visible||this.readVisible);},
  clearPublisherWork(preserveIntent:boolean){
    this.publisherOwner=null;this.publisherEpoch+=1;this.publisherNative="";
    this.publisherReturn?.();this.publisherReturn=null;
    if(!preserveIntent){this.publisherNavigationEpoch+=1;this.publisherTransferActive=false;
      if(this.publisherIntentId)discardComposeMediaIntent(this.publisherIntentId);this.publisherIntentId="";revokeComposeMediaIntents();}
    this.setData({publishEntryOpen:false,publishEntryBusy:false,publishEntryError:"",publishEntryRecovery:"",publishEntrySource:""});
    this.getTabBar?.()?.setPresentation?.("community-publisher",false);
  },
  closePublisherEntry(){if(!this.data.ugcDraftsEnabled)this.getTabBar?.()?.setCommunityPublisherAvailable?.(false);this.clearPublisherWork(false);},
  holdPublisherEntry(){},
  async waitPublisherReturn(owner:PublisherOwner){
    while(this.publisherCurrent(owner,false)&&!this.readVisible)await new Promise<void>(resolve=>{this.publisherReturn=resolve;});
    return this.publisherCurrent(owner);
  },
  async recheckPublisherDrafts(owner:PublisherOwner){
    const status=await pageRead<{draftsEnabled?:boolean;publicEnabled?:boolean}>(this,{path:"/v1/ugc/status",authMode:"public"});
    if(!this.publisherCurrent(owner))return false;
    this.setData({ugcDraftsEnabled:status.draftsEnabled===true,ugcFeedEnabled:status.publicEnabled===true});
    if(status.draftsEnabled!==true){this.getTabBar?.()?.setCommunityPublisherAvailable?.(false);throw {title:"当前暂不能新建草稿，请稍后再试。"};}
    return true;
  },
  async choosePublisherSource(event:WechatMiniprogram.TouchEvent){
    const source=String(event.currentTarget.dataset.source||"");
    if(source==="text"){await this.openPublisherText();return;}
    if(source==="album"||source==="camera")await this.selectPublisherMedia(source);
  },
  async selectPublisherMedia(source:"album"|"camera"){
    const owner=this.publisherOwner;
    if(!owner||this.data.publishEntryBusy||this.data.navigating)return;
    if(!this.publisherCurrent(owner)){this.clearPublisherWork(false);return;}
    this.setData({publishEntryBusy:true,publishEntrySource:source,publishEntryError:"",publishEntryRecovery:""});
    let phase:"status"|"privacy"|"picker"|"files"|"handoff"="status";
    try{
      if(!await this.recheckPublisherDrafts(owner))return;
      phase="privacy";this.publisherNative="privacy";
      await new Promise<void>((resolve,reject)=>wx.requirePrivacyAuthorize({success:()=>resolve(),fail:reject}));
      if(!await this.waitPublisherReturn(owner))return;
      phase="picker";this.publisherNative="picker";
      const chosen=await wx.chooseMedia({count:source==="camera"?1:9,mediaType:["image"],sourceType:[source],sizeType:["compressed","original"]});
      if(!await this.waitPublisherReturn(owner))return;
      this.publisherNative="";
      if(!chosen.tempFiles.length)return;
      phase="files";const files=await validatePublisherFiles(chosen.tempFiles,source);
      if(!this.publisherCurrent(owner)||!await this.recheckPublisherDrafts(owner))return;
      phase="handoff";const id=await createComposeMediaIntent({source,files},{sessionToken:owner.token,revision:owner.revision});
      if(!this.publisherCurrent(owner)){discardComposeMediaIntent(id);return;}
      this.navigatePublisherComposer(owner,id);
    }catch(error){
      if(this.publisherNative&&!this.readVisible&&!await this.waitPublisherReturn(owner))return;
      if(!this.publisherCurrent(owner))return;
      if(/cancel/i.test(String((error as {errMsg?:string})?.errMsg||"")))return;
      const permission=mediaPermissionFailure(error),recovery=phase==="privacy"?"privacy":phase==="picker"&&permission?"settings":"";
      const title=phase==="privacy"?"需要先完成微信隐私授权，才能选择图片。":phase==="picker"&&permission?
        source==="camera"?"相机权限暂不可用，请前往设置允许相机后重试。":"相册权限暂不可用，请前往设置允许访问照片后重试。":
        (error as {title?:string})?.title||"图片暂时无法选择，请重试。";
      this.setData({publishEntryError:title,publishEntryRecovery:recovery});
    }finally{if(this.publisherOwner===owner){this.publisherNative="";if(!this.publisherCurrent(owner,false))this.clearPublisherWork(false);else if(this.readVisible)this.setData({publishEntryBusy:false});}}
  },
  async retryPublisherMedia(){const source=this.data.publishEntrySource;if(source==="album"||source==="camera")await this.selectPublisherMedia(source);},
  async openPublisherMediaSettings(){
    const owner=this.publisherOwner,source=this.data.publishEntrySource;
    if(!owner||!this.publisherCurrent(owner)||this.data.publishEntryBusy||this.data.publishEntryRecovery!=="settings")return;
    if(typeof wx.openSetting!=="function"){this.setData({publishEntryError:"设置暂时无法打开，请在微信设置中检查相册或相机权限。"});return;}
    this.setData({publishEntryBusy:true});this.publisherNative="settings";
    try{await new Promise<void>((resolve,reject)=>wx.openSetting({success:()=>resolve(),fail:reject}));
      if(!await this.waitPublisherReturn(owner))return;this.publisherNative="";
      if(!await this.recheckPublisherDrafts(owner))return;
      this.setData({publishEntryRecovery:"",publishEntryError:source==="camera"?"请再次选择相机，确认是否已允许拍照。":"请再次选择相册，确认是否已允许访问照片。"});
    }catch(error){if(this.publisherNative&&!this.readVisible&&!await this.waitPublisherReturn(owner))return;
      if(this.publisherCurrent(owner))this.setData({publishEntryError:(error as {title?:string})?.title||"设置暂时无法打开，请重试。"});}
    finally{if(this.publisherOwner===owner){this.publisherNative="";if(!this.publisherCurrent(owner,false))this.clearPublisherWork(false);else if(this.readVisible)this.setData({publishEntryBusy:false});}}
  },
  async openPublisherText(){
    const owner=this.publisherOwner;if(!owner||this.data.publishEntryBusy||this.data.navigating)return;
    if(!this.publisherCurrent(owner)){this.clearPublisherWork(false);return;}
    this.setData({publishEntryBusy:true,publishEntryError:"",publishEntryRecovery:"",publishEntrySource:""});
    try{if(await this.recheckPublisherDrafts(owner))this.navigatePublisherComposer(owner,"");}
    catch(error){if(this.publisherCurrent(owner))this.setData({publishEntryError:(error as {title?:string})?.title||"暂时无法确认草稿能力，请重试。"});}
    finally{if(this.publisherOwner===owner){if(!this.publisherCurrent(owner,false))this.clearPublisherWork(false);else if(this.readVisible)this.setData({publishEntryBusy:false});}}
  },
  navigatePublisherComposer(owner:PublisherOwner,intentId:string){
    if(!this.publisherCurrent(owner)){if(intentId)discardComposeMediaIntent(intentId);return;}
    const navigation=++this.publisherNavigationEpoch;this.publisherIntentId=intentId;this.publisherTransferActive=true;
    this.setData({navigating:true,publishEntryOpen:false});
    wx.navigateTo({url:intentId?`/pages/community-compose/index?new=1&intent=${encodeURIComponent(intentId)}`:"/pages/community-compose/index?new=1&entry=text",
      success:()=>{},
      fail:()=>{if(intentId)discardComposeMediaIntent(intentId);if(navigation!==this.publisherNavigationEpoch)return;
        this.publisherTransferActive=false;this.publisherIntentId="";
        if(this.publisherAlive&&this.readVisible&&publisherRouteCurrent()&&owner.token===getApp<IAppOption>().globalData.sessionToken&&owner.revision===commerceContextRevision()){
          this.clearPublisherWork(false);this.setData({navigating:false});this.openPublisher();this.setData({publishEntryError:"创作页暂时无法打开，请重新选择。"});}}});
  },
  async onReachBottom(){
    if(this.data.mode==="review"){if(this.data.reportNextCursor)await this.loadMoreReports();else await this.loadMoreAppeals();return;}
    if(this.data.mode==="featured"){await this.loadMoreEditorial();return;}
    if(this.data.mode==="following"){await this.loadMoreFollowing();return;}
    const mode=this.data.mode,cursor=mode==="following"?this.data.followingNextCursor:this.data.formalNextCursor,
      attempt=this.data.feedAttempt;
    if(!cursor||this.data.formalLoadingMore||this.data.loading||!["recommend","following"].includes(mode)||!this.data.ugcFeedEnabled)return;
    const token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({formalLoadingMore:true,moreError:""});
    try{
      const following=mode==="following"?"&following=1":"";
      const page=await pageRead<{items:any[];nextCursor:string|null}>(this, {path:`/v1/ugc/posts?limit=30&cursor=${encodeURIComponent(cursor)}${following}`,
        authMode:token?"optional":"public"});
      if(attempt!==this.data.feedAttempt||token!==getApp<IAppOption>().globalData.sessionToken||mode!==this.data.mode)return;
      const origin=getApp<IAppOption>().globalData.apiBaseUrl.replace(/\/$/,"");
      const more=page.items.map(item=>({...item,kind:"formal",author_id:item.authorId,
        image:item.coverId&&origin?`${origin}/v1/ugc/media/${item.coverId}?variant=thumbnail`:""}));
      const model = feedModel(this), key = mode === "following" ? "following" : "feed";
      const seen = new Set(model[key].map(item => item.id));
      model[key] = [...model[key], ...more.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; })];
      this.setData(mode === "following" ? {followingNextCursor:page.nextCursor} : {formalNextCursor:page.nextCursor});
      this.renderFeed();
    }catch{if(attempt===this.data.feedAttempt && token===getApp<IAppOption>().globalData.sessionToken && mode===this.data.mode)this.setData({moreError:"更多内容暂时无法加载，已显示的故事保留。"});}
    finally{if(attempt===this.data.feedAttempt && token===getApp<IAppOption>().globalData.sessionToken && mode===this.data.mode)this.setData({formalLoadingMore:false});}
  },
  async loadMoreEditorial(){
    const cursor=this.data.editorialNextCursor,attempt=this.data.feedAttempt,token=getApp<IAppOption>().globalData.sessionToken;
    if(this.data.mode!=="featured"||!cursor||this.data.loading||this.data.formalLoadingMore)return;
    this.setData({formalLoadingMore:true,moreError:""});
    try{const page=await publishedEditorialArticles(this,cursor);
      if(attempt!==this.data.feedAttempt||token!==getApp<IAppOption>().globalData.sessionToken||this.data.mode!=="featured"||cursor!==this.data.editorialNextCursor)return;
      const model=feedModel(this),seen=new Set(model.editorial.map(item=>item.id));
      model.editorial=[...model.editorial,...page.items.filter(item=>{if(seen.has(item.id))return false;seen.add(item.id);return true;})];
      this.setData({editorialNextCursor:page.nextCursor});this.renderFeed();
    }catch(error){if(this.recoverExpiredEditorialRead(attempt,token,error))return;if(attempt===this.data.feedAttempt&&token===getApp<IAppOption>().globalData.sessionToken&&this.data.mode==="featured")this.setData({moreError:"更多精选暂时无法加载，请重试。"});}
    finally{if(attempt===this.data.feedAttempt&&token===getApp<IAppOption>().globalData.sessionToken&&this.data.mode==="featured")this.setData({formalLoadingMore:false});}
  },
  async selectMode(event: WechatMiniprogram.TouchEvent) {
    const mode = String(event.currentTarget.dataset.mode);
    if (!["featured", "recommend", "following", "review"].includes(mode) || (mode === "review" && !this.data.canReview)) return;
    if (mode === "recommend" && !this.data.ugcFeedEnabled && !this.data.socialPreviewEnabled) return;
    if (mode === this.data.mode || this.data.reviewBusy || this.data.publishEntryBusy || this.data.navigating) return;
    if ((mode === "following" || mode === "review") && !getApp<IAppOption>().globalData.sessionToken) {
      this.followingRequested=mode==="following";resumeAuthentication("/pages/community/index");return;
    }
    const previousMode=this.data.mode,wasLoading=this.data.loading;
    cancelPageReads(this);
    this.data.feedAttempt += 1; // A → B → A must not revive an older pagination result.
    this.setData({ mode, loading:false,feedReady:false,formalLoadingMore:false, moreError:"",error:"" });
    this.syncPublisherEntry();
    if (mode === "review") await this.loadReview();
    else if (mode === "following") await this.loadFollowing();
    else { this.renderFeed();if(previousMode==="following"||wasLoading)await this.load(); }
  },
  renderFeed(state: WechatMiniprogram.IAnyObject = {}) {
    const processingStarted = measurementClock();
    const model = feedModel(this);
    const reviewed = (this.data.mode === "following" ? model.following : model.feed).map((item: any) => item.kind === "editorial" ? item : item.kind === "formal"
      ? { ...item, avatar: item.avatar || defaultMemberAvatar, author: item.author || "CISME 会员", engagementLabel: `${item.likeCount || 0} 赞` }
      : { ...item, kind: "ugc", image: item.image || "", avatar: item.avatar || defaultMemberAvatar, author: item.author || "CISME 会员", engagementLabel: "" });
    const featured = model.editorial.map(item => ({ ...item, kind:"editorial", author_id:item.authorId,
      image:editorialMediaSrc(item.coverUrl),avatar:editorialPublisherAvatar(item.author,defaultMemberAvatar,item.authorId),engagementLabel:`${item.likeCount} 赞` }));
    const items = this.data.mode === "featured" ? featured : reviewed;
    const patch = { ...feedColumnPatch(this.data.feedColumns, projectFeedCards(items)), ...state };
    if (items.length !== this.data.displayFeedCount) patch.displayFeedCount = items.length;
    if (!this.data.loading && !this.data.error && !this.data.feedReady) patch.feedReady = true;
    recordClientMetric({ action: "feed", stage: "data_processing", durationMs: measurementClock() - processingStarted });
    if (Object.keys(patch).length) {
      const bridgeStarted = measurementClock(), attempt = this.data.feedAttempt;
      this.setData(patch, () => { if (attempt === this.data.feedAttempt) recordClientMetric({ action: "feed", stage: "set_data", durationMs: measurementClock() - bridgeStarted }); });
    }
  },
  async loadFollowing() {
    const attempt = ++this.data.feedAttempt;
    const token = getApp<IAppOption>().globalData.sessionToken;
    const owner=communityReadOwner(),model=feedModel(this);
    if(this.readOwner!==owner){model.feed=[];model.editorial=[];}
    if(model.followingOwner!==owner){model.following=[];model.followingReady=false;}
    this.readOwner=owner;model.followingOwner=owner;
    if(!token){model.following=[];model.followingReady=false;this.setData({mode:"featured",loading:false});this.renderFeed();return;}
    const current=()=>this.readVisible&&attempt===this.data.feedAttempt&&token===getApp<IAppOption>().globalData.sessionToken&&owner===communityReadOwner()&&this.data.mode==="following";
    this.setData({feedAttempt:attempt,feedReady:model.followingReady,loading:true,error:"",moreError:""});
    this.renderFeed();
    try {
      const page=await readFollowingFeed(this);if(!current())return;
      model.following=page.items;model.followingReady=true;
      this.setData({feedReady:true,followingNextCursor:page.nextCursor});
      this.renderFeed();
    } catch(error) { if(!current()||this.recoverExpiredEditorialRead(attempt,token,error))return;if(current()){
      if([401,403].includes((error as {status?:number})?.status??0)){model.following=[];model.followingReady=false;}
      this.setData({feedReady:model.followingReady,error:"关注内容暂时无法更新，请下拉刷新或重试。"});this.renderFeed();
    }} finally { if(current())this.setData({loading:false}); }
  },
  async loadMoreFollowing(){
    const model=feedModel(this),cursor=this.data.followingNextCursor,attempt=this.data.feedAttempt,owner=communityReadOwner(),token=getApp<IAppOption>().globalData.sessionToken;
    if(!cursor||this.data.loading||this.data.formalLoadingMore||this.data.mode!=="following"||model.followingOwner!==owner)return;
    const current=()=>this.readVisible&&attempt===this.data.feedAttempt&&owner===communityReadOwner()&&this.data.mode==="following";
    this.setData({formalLoadingMore:true,moreError:""});
    try{const page=await readFollowingFeed(this,cursor);if(!current()||cursor!==this.data.followingNextCursor)return;
      const seen=new Set(model.following.map(item=>`${item.kind}:${item.id}`));
      model.following=[...model.following,...page.items.filter(item=>{const key=`${item.kind}:${item.id}`;if(seen.has(key))return false;seen.add(key);return true;})];
      this.setData({followingNextCursor:page.nextCursor});this.renderFeed();
    }catch(error){if(!current()||this.recoverExpiredEditorialRead(attempt,token,error))return;this.setData({moreError:"更多关注内容暂时无法加载，已显示的故事保留。"});}
    finally{if(current())this.setData({formalLoadingMore:false});}
  },
  async onPullDownRefresh(){
    try{if(!this.data.reviewBusy&&!this.data.publishEntryOpen&&!this.data.publishEntryBusy&&!this.data.navigating)await this.load();}finally{wx.stopPullDownRefresh();}
  },
  async loadReview() {
    if (!this.data.canReview) return;
    const token = getApp<IAppOption>().globalData.sessionToken;
    const attempt = this.data.feedAttempt;
    this.setData({ profileReviewQueue: [], formalReportQueue:[],reportNextCursor:null,reportTotal:0,formalAppealQueue:[],appealNextCursor:null,appealTotal:0,reviewActorId:memberIdentity()?.id||"", teamError: "", reviewBusy: true });
    try {
      const [profiles,reports,appeals] = await Promise.all([ request<any[]>({ path: "/v1/team/member-profiles" }),request<{items:any[];nextCursor:string|null;matchingTotal:number}>({path:"/v1/management/ugc/reports?limit=30"}),request<{items:any[];nextCursor:string|null;matchingTotal:number}>({path:"/v1/management/ugc/appeals?limit=30"})]);
      const profileReviewQueue=await Promise.all(profiles.map(async row=>{const {avatar_data_url,...safe}=row;return {...safe,avatar:await localMemberAvatar(avatar_data_url,row.avatar_revision)};}));
      if (attempt !== this.data.feedAttempt || token !== getApp<IAppOption>().globalData.sessionToken) return;
      this.setData({ profileReviewQueue,
        formalReportQueue:reports.items,reportNextCursor:reports.nextCursor,reportTotal:reports.matchingTotal,
        formalAppealQueue:appeals.items,appealNextCursor:appeals.nextCursor,appealTotal:appeals.matchingTotal });
    } catch (error) { if (attempt === this.data.feedAttempt && token === getApp<IAppOption>().globalData.sessionToken) this.setData({ teamError: (error as {title?:string}).title || "审核列表未同步，请重试" }); }
    finally { if (attempt === this.data.feedAttempt && token === getApp<IAppOption>().globalData.sessionToken) this.setData({ reviewBusy: false }); }
  },
  async loadMoreReports(){
    const cursor=this.data.reportNextCursor;
    if(this.data.mode!=="review"||!cursor||this.data.reviewBusy||this.data.reportLoadingMore)return;
    const token=getApp<IAppOption>().globalData.sessionToken,attempt=this.data.feedAttempt;
    this.setData({reportLoadingMore:true,teamError:""});
    try{const page=await request<{items:any[];nextCursor:string|null;matchingTotal:number}>({
      path:`/v1/management/ugc/reports?limit=30&cursor=${encodeURIComponent(cursor)}`});
      if(attempt!==this.data.feedAttempt||token!==getApp<IAppOption>().globalData.sessionToken||
        this.data.mode!=="review"||cursor!==this.data.reportNextCursor)return;
      const seen=new Set(this.data.formalReportQueue.map(row=>row.id));
      this.setData({formalReportQueue:[...this.data.formalReportQueue,...page.items.filter(row=>!seen.has(row.id))],
        reportNextCursor:page.nextCursor,reportTotal:page.matchingTotal});
    }catch(error){if(attempt===this.data.feedAttempt&&token===getApp<IAppOption>().globalData.sessionToken)
      this.setData({teamError:(error as {title?:string}).title||"更多举报未加载，请重试。"});}
    finally{if(attempt===this.data.feedAttempt&&token===getApp<IAppOption>().globalData.sessionToken)
      this.setData({reportLoadingMore:false});}
  },
  async loadMoreAppeals(){
    const cursor=this.data.appealNextCursor;
    if(this.data.mode!=="review"||!cursor||this.data.reviewBusy||this.data.appealLoadingMore)return;
    const token=getApp<IAppOption>().globalData.sessionToken,attempt=this.data.feedAttempt;
    this.setData({appealLoadingMore:true,teamError:""});
    try{const page=await request<{items:any[];nextCursor:string|null;matchingTotal:number}>({
      path:`/v1/management/ugc/appeals?limit=30&cursor=${encodeURIComponent(cursor)}`});
      if(attempt!==this.data.feedAttempt||token!==getApp<IAppOption>().globalData.sessionToken||
        this.data.mode!=="review"||cursor!==this.data.appealNextCursor)return;
      const seen=new Set(this.data.formalAppealQueue.map(row=>row.id));
      this.setData({formalAppealQueue:[...this.data.formalAppealQueue,...page.items.filter(row=>!seen.has(row.id))],
        appealNextCursor:page.nextCursor,appealTotal:page.matchingTotal});
    }catch(error){if(attempt===this.data.feedAttempt&&token===getApp<IAppOption>().globalData.sessionToken)
      this.setData({teamError:(error as {title?:string}).title||"更多申诉未加载，请重试。"});}
    finally{if(attempt===this.data.feedAttempt&&token===getApp<IAppOption>().globalData.sessionToken)
      this.setData({appealLoadingMore:false});}
  },
  async decideFormalAppeal(event:WechatMiniprogram.TouchEvent){
    if(this.data.reviewBusy||this.data.mode!=="review"||!this.data.canReview)return;
    const id=String(event.currentTarget.dataset.id||""),decision=String(event.currentTarget.dataset.decision||""),
      row=this.data.formalAppealQueue.find(item=>item.id===id);
    if(!row||!["restore","uphold"].includes(decision)||decision==="restore"&&
      (!this.data.ugcFeedEnabled||row.postState!=="hidden"))return;
    if(row.hiddenByMemberId===this.data.reviewActorId||row.hideReporterMemberId===this.data.reviewActorId||
      row.authorId===this.data.reviewActorId)return;
    const token=getApp<IAppOption>().globalData.sessionToken,attempt=this.data.feedAttempt,version=row.version;
    const current=()=>token===getApp<IAppOption>().globalData.sessionToken&&attempt===this.data.feedAttempt&&
      this.data.mode==="review"&&this.data.formalAppealQueue.some(item=>item.id===id&&item.version===version);
    const answer=await wx.showModal({title:decision==="restore"?"复核并恢复公开？":"维持下架决定？",editable:true,
      placeholderText:"填写核查依据（至少4字）",confirmText:"确认处理"});
    if(!answer.confirm||!current())return;
    const why=(answer.content||"").trim();if(why.length<4){this.setData({teamError:"请填写至少4字的处理依据。"});return;}
    this.setData({reviewBusy:true,teamError:""});
    try{if(!current())return;
      await request({path:`/v1/management/ugc/appeals/${id}/decision`,method:"POST",
        data:{decision,reason:why,expectedVersion:version}});
      if(!current())return;
      this.setData({reviewNotice:decision==="restore"?"内容已恢复公开，作者可查看申诉结果。":"已维持下架，作者可查看申诉结果。"});
      await this.loadReview();
    }catch(error){if(current())this.setData({teamError:(error as {status?:number}).status===409?
      "这条申诉或内容状态已变化，请刷新队列。":(error as {title?:string}).title||"申诉未处理，请重试。"});}
    finally{if(current())this.setData({reviewBusy:false});}
  },
  openReportTarget(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id||"");
    const row=this.data.formalReportQueue.find(item=>item.id===id);
    if(!row?.postId||this.data.navigating)return;
    this.setData({navigating:true});
    wx.navigateTo({url:`/pages/community-post/index?id=${encodeURIComponent(row.postId)}`,
      fail:()=>{this.setData({navigating:false});wx.showToast({title:"内容暂不可见，请查看举报摘要",icon:"none"});}});
  },
  async decideFormalReport(event:WechatMiniprogram.TouchEvent){
    if(this.data.reviewBusy||this.data.mode!=="review"||!this.data.canReview)return;
    const id=String(event.currentTarget.dataset.id||""),decision=String(event.currentTarget.dataset.decision||""),
      row=this.data.formalReportQueue.find(item=>item.id===id);
    if(!row||!(["dismiss",row.targetType==="post"?"hide_post":row.targetType==="comment"?"remove_comment":""].includes(decision)))return;
    const token=getApp<IAppOption>().globalData.sessionToken,attempt=this.data.feedAttempt,version=row.version;
    const current=()=>token===getApp<IAppOption>().globalData.sessionToken&&attempt===this.data.feedAttempt&&
      this.data.mode==="review"&&this.data.formalReportQueue.some(item=>item.id===id&&item.version===version);
    const answer=await wx.showModal({title:decision==="hide_post"?"下架被举报内容？":decision==="remove_comment"?"移除被举报评论？":"驳回这条举报？",
      editable:true,placeholderText:"填写核查依据（至少4字），决定会通知举报人",confirmText:"确认处理"});
    if(!answer.confirm||!current())return;
    const why=(answer.content||"").trim();
    if(why.length<4){this.setData({teamError:"请填写至少4字的处理依据。"});return;}
    this.setData({reviewBusy:true,teamError:""});
    try{if(!current())return;
      await request({path:`/v1/management/ugc/reports/${id}/decision`,method:"POST",
        data:{decision,reason:why,expectedVersion:version,
          ...(decision!=="dismiss"?{expectedTargetVersion:row.targetVersion}:{})}});
      if(!current())return;
      this.setData({reviewNotice:"举报已处理，结果可由举报人查看。"});
      await this.loadReview();
    }catch(error){if(current())this.setData({teamError:(error as {status?:number}).status===409?
      "这条举报已被处理，请刷新队列核对。":(error as {title?:string}).title||"举报未处理，请重试。"});}
    finally{if(current())this.setData({reviewBusy:false});}
  },
  async reviewMemberProfile(event:WechatMiniprogram.TouchEvent) {
    if(this.data.reviewBusy || !this.data.canReview)return;
    const item=this.data.profileReviewQueue.find(row=>row.member_id===event.currentTarget.dataset.id);
    const decision=String(event.currentTarget.dataset.decision);
    if(!item || !["approve","reject"].includes(decision))return;
    const token=getApp<IAppOption>().globalData.sessionToken,attempt=this.data.feedAttempt;
    this.setData({reviewBusy:true,teamError:""});
    try {
      const answer=await wx.showModal({title:decision==="approve"?"通过社区头像昵称审核":"填写资料审核意见",editable:true,placeholderText:"请填写核验依据；不能审核自己的资料",confirmText:"提交审核"});
      if(!answer.confirm || token!==getApp<IAppOption>().globalData.sessionToken || attempt!==this.data.feedAttempt)return;
      await request({path:`/v1/team/member-profiles/${item.member_id}/review`,method:"POST",data:{decision,expectedVersion:item.profile_revision,reason:answer.content || ""}});
      if(token===getApp<IAppOption>().globalData.sessionToken && attempt===this.data.feedAttempt)await this.loadReview();
    }catch(error){if(token===getApp<IAppOption>().globalData.sessionToken && attempt===this.data.feedAttempt)this.setData({teamError:(error as {title?:string}).title || "审核尚未确认，请刷新核对"});}
    finally {if(token===getApp<IAppOption>().globalData.sessionToken && attempt===this.data.feedAttempt)this.setData({reviewBusy:false});}
  },
  recoverExpiredEditorialRead(attempt:number,token:string,error:unknown){
    if(!this.readVisible||attempt!==this.data.feedAttempt||!expiredEditorialRead(error,token))return false;
    this.clearPublisherWork(false);
    this.data.feedAttempt+=1;
    const model=feedModel(this);model.feed=[];model.following=[];model.editorial=[];model.followingReady=false;model.followingOwner="";
    this.setData({signedIn:false,mode:"featured",loading:false,ugcFeedEnabled:false,ugcDraftsEnabled:false,socialPreviewEnabled:false,canReview:false,follows:[],
      profileReviewQueue:[],formalReportQueue:[],reportNextCursor:null,reportTotal:0,
      formalAppealQueue:[],appealNextCursor:null,appealTotal:0,reportLoadingMore:false,appealLoadingMore:false,reviewActorId:"",reviewNotice:"",reviewBusy:false,
      feedReady:false,editorialNextCursor:null,formalNextCursor:null,followingNextCursor:null,formalLoadingMore:false,
      moreError:"",teamError:"",error:"登录状态已失效，请重新加载社区内容。"});
    this.getTabBar?.()?.setCommunityPublisherAvailable?.(false);this.renderFeed();return true;
  },
  async load(preservePublisherMount?:unknown) {
    cancelPageReads(this);
    const preservePublisher=preservePublisherMount===true&&Boolean(this.publisherNative)&&this.data.publishEntryOpen&&this.publisherOwner!==null&&this.publisherCurrent(this.publisherOwner);
    if(!preservePublisher)this.getTabBar?.()?.setCommunityPublisherAvailable?.(false);
    const context = getApp<IAppOption>().globalData;
    const session = context.sessionToken;
    const owner = JSON.stringify([session, commerceContextRevision(), context.apiBaseUrl, context.cloudFunction?.env, context.cloudFunction?.name]);
    const sameOwner = this.readOwner === owner;
    this.readOwner = owner;
    const model = feedModel(this);
    if (!sameOwner) { model.feed = []; model.editorial = []; model.following=[];model.followingReady=false;model.followingOwner=""; }
    const attempt = this.data.feedAttempt + 1;
    const privateMode=this.data.mode==="review"||(this.data.mode==="following"&&!model.followingReady);
    const resetColumns=(!sameOwner||privateMode)&&this.data.feedColumns.some(column=>column.length>0);
    const current = () => this.readVisible && this.data.feedAttempt === attempt && owner === communityReadOwner();
    this.setData({ feedAttempt: attempt, loading: true, ugcDraftsEnabled:false, editorialNextCursor:null, formalNextCursor:null, followingNextCursor:null,
      ...(!sameOwner ? { feedReady:false,ugcFeedEnabled:false, socialPreviewEnabled:false, displayFeedCount:0 } : {}),
      follows:[],canReview:false,profileReviewQueue:[],
      formalLoadingMore:false, moreError:"", reviewBusy: false, teamError: "", error: "",
      ...(privateMode?{feedReady:false,displayFeedCount:0}:{}),
      ...(resetColumns?{feedColumns:[[],[]] as [any[],any[]]}:{}) });
    const failedRead=(error:unknown)=>{this.recoverExpiredEditorialRead(attempt,session,error);return {error};};
    // Featured content owns first paint. Ancillary capability/access reads
    // must not hold returned cards behind their network deadline.
    const editorialPromise=publishedEditorialArticles(this).then(feed=>{
      if(!Array.isArray(feed?.items))throw new Error("EDITORIAL_PAGE_INVALID");
      if(current()&&this.data.mode==="featured"){
        model.editorial=feed.items;
        this.renderFeed({feedReady:true,loading:false,editorialNextCursor:feed.nextCursor,error:""});
      }
      return {feed};
    }).catch(error=>{
      const outcome=failedRead(error);
      if(current()&&this.data.mode==="featured"){
        model.editorial=[];
        this.renderFeed({loading:false,feedReady:false,error:"精选内容暂时无法加载，请重试。"});
      }
      return outcome;
    });
    const capabilityPromise = Promise.all([pageRead<{ communityPreviewEnabled?: boolean }>(this,{ path: "/v1/capabilities", authMode: "public" }),
      pageRead<{ publicEnabled?: boolean; draftsEnabled?: boolean }>(this,{ path: "/v1/ugc/status", authMode: "public" })])
      .then(([health,ugc]) => ({ ugcFeedEnabled: ugc.publicEnabled === true, ugcDraftsEnabled: ugc.draftsEnabled === true, socialPreviewEnabled: health.communityPreviewEnabled === true }))
      .catch(error => {failedRead(error);return { ugcFeedEnabled: false, ugcDraftsEnabled: false, socialPreviewEnabled: false };});
    const feedPromise = pageRead<{items:any[];authors?:Record<string,any>}>(this,{ path: "/v1/feed/page?limit=30", authMode: "public" }).then(feed => ({ feed }), failedRead);
    const formalPromise = pageRead<{items:any[];nextCursor:string|null}>(this,{ path: "/v1/ugc/posts?limit=30", authMode: getApp<IAppOption>().globalData.sessionToken ? "optional" : "public" })
      .then(feed => ({ feed }), failedRead);
    this.setData({ canReview: false, follows: [], profileReviewQueue: [] });
    const capabilities = await capabilityPromise;
    if (!current()) return;
    const availableMode = this.data.mode === "recommend" && !capabilities.ugcFeedEnabled && !capabilities.socialPreviewEnabled
      ? "featured"
      : this.data.mode;
    this.setData({ ...capabilities, mode: availableMode });
    this.syncPublisherEntry();
    const token = getApp<IAppOption>().globalData.sessionToken;
    if (token) {
      try {
        const [access, follows] = await Promise.all([
          pageRead<{canReview:boolean}>(this,{ path: "/v1/me/community-access", authMode: "optional" }),
          capabilities.socialPreviewEnabled ? pageRead<string[]>(this,{ path: "/v1/me/follows", authMode: "optional" }) : Promise.resolve([])
        ]);
        if (!current()) return;
        this.setData({ canReview: access.canReview === true, follows, mode: this.data.mode === "review" && !access.canReview ? "featured" : this.data.mode });
        this.syncPublisherEntry();
      } catch(error) { failedRead(error);if (current()) this.setData({ canReview: false, ...(this.data.mode==="review"?{mode:"featured"}:{}) }); }
    } else this.setData({ mode: "featured" });
    try {
      const [outcome,formalOutcome,editorialOutcome] = await Promise.all([feedPromise,formalPromise,editorialPromise]);
      if(!current())return;
      if(this.data.mode==="following"){
        if("feed" in editorialOutcome)model.editorial=editorialOutcome.feed.items;
        await this.loadFollowing();return;
      }
      if(this.data.mode==="featured"&&"error" in editorialOutcome)throw editorialOutcome.error;
      if(this.data.mode==="featured"&&!capabilities.ugcFeedEnabled&&!capabilities.socialPreviewEnabled&&"feed" in editorialOutcome){
        feedModel(this).editorial=editorialOutcome.feed.items;
        this.renderFeed({feedReady:true,loading:false,editorialNextCursor:editorialOutcome.feed.nextCursor,error:""});return;
      }
      if(this.data.mode!=="featured"&&"error" in outcome&&"error" in formalOutcome)throw outcome.error;
      const preview = "feed" in outcome ? await prepareFeedPage(outcome.feed) : [];
      const origin = getApp<IAppOption>().globalData.apiBaseUrl.replace(/\/$/, "");
      const formal = "feed" in formalOutcome ? formalOutcome.feed.items.map(item => ({ ...item, kind: "formal", author_id: item.authorId,
        image: item.coverId && origin ? `${origin}/v1/ugc/media/${item.coverId}?variant=thumbnail` : "" })) : [];
      const feed = [...formal, ...preview];
      if (!current()) return;
      // Post covers still require their own authorized media path; author
      // identities come only from the server public-profile allowlist.
      feedModel(this).feed = feed;
      feedModel(this).editorial = "feed" in editorialOutcome?editorialOutcome.feed.items:[];
      this.renderFeed({ feedReady:true,loading:false,editorialNextCursor:"feed" in editorialOutcome?editorialOutcome.feed.nextCursor:null,formalNextCursor:"feed" in formalOutcome?formalOutcome.feed.nextCursor:null, error: "" });
      if (this.data.mode === "review") await this.loadReview();
    } catch (error) {
      if (current()) {
        feedModel(this).feed = [];model.editorial=[];
        this.renderFeed({feedReady:false,error:this.data.mode==="featured"?"精选内容暂时无法加载，请重试。":"社区内容暂时无法加载，请重试。"});
      }
    } finally {
      if (current()&&this.data.loading) this.setData({ loading: false });
    }
  },
  openPost(event: WechatMiniprogram.TouchEvent) {
    if (this.data.navigating) return;
    const id = String(event.currentTarget.dataset.id ?? "");
    if (!id) { wx.showToast({ title: "内容链接无效，请刷新后重试", icon: "none" }); return; }
    this.setData({ navigating: true });
    const tab = this.getTabBar?.(); if (tab) tab.setData({ externalBusy: true });
    const item = this.data.feedColumns.flat().find((entry: any) => entry.id === id);
    const route = item?.kind === "formal" ? "/pages/community-post/index" : "/pages/post/index";
    wx.navigateTo({ url: `${route}?id=${encodeURIComponent(id)}${item?.kind==="editorial"?"&source=editorial":""}`, fail: () => { this.setData({ navigating: false }); const currentTab = this.getTabBar?.(); if (currentTab) currentTab.setData({ externalBusy: false }); wx.showToast({ title: "护理故事暂时无法打开", icon: "none" }); } });
  },
});
