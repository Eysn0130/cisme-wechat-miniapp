import { defaultMemberAvatar, prepareFeedAuthors } from "../../services/member-avatar";
import { clearAuthenticationRedirectSuppression, request, resumeAuthentication, beginLegalRenewal } from "../../services/api";
import { cancelPageReads } from "../../services/page-requests";
import { editorialPreviewAllowed, editorialStory, isBundledEditorialId, editorialIdentifier, editorialDisplayMedia, editorialAiLabel, type EditorialVideo, type PublishedEditorialMedia, publishedEditorialArticle, reactToEditorialArticle, followEditorialArticle, expiredEditorialRead } from "../../services/editorial";
import { readEditorialComments, createEditorialComment, setEditorialCommentLike, deleteEditorialComment, reportEditorialComment, setEditorialBlock, setEditorialCommentsPolicy, readEditorialBlocks, type EditorialReportCategory } from "../../services/editorial-comments";
import { currentChromeStyle, motionDuration } from "../../services/layout";
import { prepareShareLink, registerIncomingShare } from "../../services/share";

import { commentThreads, emptyCommunity, prepareCommentAuthors, type CommunityView, type CommunityComment } from "../../services/community";
import { readingSegments } from "./reading-segments";

type GalleryRead = { id:string; version:number; media:string[]; ownerToken:string; height:number };
type GallerySizingCache = {id:string;version:number;media:string[];ownerToken:string;layoutIdentity:string;height:number};
type PreviewIntent = {owner:number;attempt:number;ownerToken:string;id:string;version:number|undefined;media:string[];imageIdentity:string;read:GalleryRead|null};
type GalleryTouch = {identity:string;startX:number;startY:number;moved:boolean};
type ReadingRead = { id:string; version:number; ownerToken:string; mediaIdentity:string; videoIdentity:string; layoutIdentity:string; canvasHeight:number; attempt:number; scrollTop:number };
type CommentIntent = { owner:number; attempt:number; token:string; id:string; version:number };
const commentFailure=(error:unknown,fallback:string)=>(error as {title?:string})?.title||fallback;

function readingBaseLayoutIdentity():string|null {
  try{
    const width=wx.getWindowInfo().windowWidth;
    const base=wx.getAppBaseInfo();
    const fontSize=Number.isFinite(base.fontSizeSetting)&&base.fontSizeSetting>0?base.fontSizeSetting:null;
    const fontScale=Number.isFinite(base.fontSizeScaleFactor)&&base.fontSizeScaleFactor>0?base.fontSizeScaleFactor:null;
    if(!Number.isFinite(width)||width<=0||(fontSize===null&&fontScale===null))return null;
    return JSON.stringify([width,fontSize,fontScale]);
  }catch{return null;}
}

function readingLayoutIdentity(canvasHeight:number):string|null {
  const base=readingBaseLayoutIdentity();
  return base===null?null:JSON.stringify(["flow-author-comments-v1",base,canvasHeight]);
}

function imageCanvasHeight(width:number,height:number,orientation:string|undefined):number|null {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return null;
  if(orientation&&["left","left-mirrored","right","right-mirrored"].includes(orientation))[width,height]=[height,width];
  return Math.max(375,Math.min(1000,750*height/width));
}

function readingMediaIdentity(media:PublishedEditorialMedia[]):string {
  return JSON.stringify(media.map(item=>item.type==="video"
    ?["video",item.id,item.url,item.mimeType,item.width,item.height,item.durationMs,item.posterUrl]
    :["image",item.id,item.url]));
}

function readingVideoIdentity(video:EditorialVideo|null):string {
  return JSON.stringify(video?[video.src,video.poster,video.height,video.durationSeconds]:null);
}

Page({
  readVisible:true,
  galleryRead:null as GalleryRead|null,
  gallerySizingCache:null as GallerySizingCache|null,
  cancelGallerySizing:null as (()=>void)|null,
  galleryTouch:null as GalleryTouch|null,
  previewBusy:false,
  previewOwner:0,
  readingRead:null as ReadingRead|null,
  pendingReadingRestore:null as ReadingRead|null,
  readingScrollRevision:0,
  videoPosition:0,
  videoIdentity:"",
  blockReadEpoch:0,
  commentReadEpoch:0,
  commentActionOwner:0,
  commentDraftToken:null as string|null,
  commentDraftArticle:"",
  editorialSocialRefusal:null as string|null,
  data: { blocksOpen:false,blocksLoading:false,blocksBusy:false,blocksError:"",blocks:[] as Array<{authorId:string;name:string}>,blocksCursor:null as string|null,blocksHasMore:false,commentsLoading:false,commentsBusy:false,commentsError:"",commentsNotice:"",commentsEnabled:null as boolean|null,commentCount:null as number|null,commentsPolicyVersion:0,canModerate:false,commentHasMore:false,commentCursor:null as string|null,editorialCommentItems:[] as CommunityComment[],commentSendUnknown:false,commentAuthenticated:false,lastBlockedAuthor:"",lastBlockedName:"",aiLabel:"", editorialSource:false,following: false, followBusy: false, followError: "", authorId: "", previewRuntime: editorialPreviewAllowed(), socialEnabled: false, socialLoading: false, socialError: "", socialBusy: false, social: emptyCommunity, threads: [] as ReturnType<typeof commentThreads>, expandedThreads: [] as string[], draftLength:0,draft: "", draftOperation: "", replyToId: "", replyToName: "", composerOpen:false,composerFocused: false, keyboardHeight: 0, chromeStyle: currentChromeStyle(), id: "", item: null as any, media: [] as string[], video:null as EditorialVideo|null, videoHeightRpx:1000,videoInitialTime:0,videoEventId:"",imageEventId:"", mediaIndex: 0, mediaError:"",galleryHeight: 1000, shareId: "", loading: true, loadAttempt: 0, pageAlive: true, leaving: false, errorKind: "none" as "none" | "missing" | "load", errorTitle: "", error: "" },
  onResize() { this.cancelGallerySizing?.();this.readingRead=null;this.pendingReadingRestore=null;this.readingScrollRevision+=1;this.setData({ chromeStyle: currentChromeStyle() }); },
  onLoad(query: Record<string, string | undefined>) {
    const id = query.id ?? "";
    this.setData({ id, editorialSource:query.source==="editorial", pageAlive: true });
    if (query.source!=="editorial"&&(!isBundledEditorialId(id) || editorialPreviewAllowed())) void registerIncomingShare(query.share_id, "post", id);
    wx.hideShareMenu();
  },
  onShow() { this.readVisible=true;this.setData({ pageAlive: true, leaving: false }); void this.load(true); },
  onHide() { this.blockReadEpoch+=1;this.commentReadEpoch+=1;this.commentActionOwner+=1;this.cancelGallerySizing?.();this.invalidatePreview();this.pauseVideo();if(this.pendingReadingRestore)this.readingRead=null;this.pendingReadingRestore=null;this.readVisible=false;cancelPageReads(this);this.data.loadAttempt += 1; this.setData({ composerFocused: false, keyboardHeight: 0,commentsBusy:false,commentsLoading:false,blocksOpen:false,blocks:[],blocksLoading:false,blocksBusy:false }); },
  onUnload() { this.blockReadEpoch+=1;this.commentReadEpoch+=1;this.commentActionOwner+=1;this.cancelGallerySizing?.();this.invalidatePreview();this.gallerySizingCache=null;this.pauseVideo(true);this.galleryRead=null;this.readingRead=null;this.pendingReadingRestore=null;this.readVisible=false;cancelPageReads(this);this.data.pageAlive = false; this.data.loadAttempt += 1; },
  onPageScroll(event:WechatMiniprogram.Page.IPageScrollOption) {
    const top=event.scrollTop;
    if(!this.readVisible||!this.data.pageAlive||!Number.isFinite(top)||top<0)return;
    // Clearing the old content can emit zero before the verified content renders.
    if(this.data.loading||this.pendingReadingRestore){
      if(top===0)return;
      this.interruptReadingRestore();
    }
    const read=this.readingRead;
    if(read&&this.currentReadingRead(read))read.scrollTop=top;
  },
  interruptReadingRestore() {
    if(!this.data.loading&&!this.pendingReadingRestore)return;
    this.readingScrollRevision+=1;
    if(this.pendingReadingRestore===this.readingRead&&this.readingRead)this.readingRead.scrollTop=0;
    this.pendingReadingRestore=null;
  },
  currentReadingRead(read:ReadingRead) {
    return this.readingRead===read&&this.data.editorialSource&&this.readVisible&&this.data.pageAlive&&!this.data.leaving&&!this.data.loading
      &&read.attempt===this.data.loadAttempt&&read.ownerToken===getApp<IAppOption>().globalData.sessionToken
      &&read.id===this.data.id&&read.id===this.data.item?.id&&read.version===this.data.item?.version
      &&Array.isArray(this.data.item?.media)&&read.mediaIdentity===readingMediaIdentity(this.data.item.media)
      &&read.videoIdentity===readingVideoIdentity(this.data.video)&&read.canvasHeight===(this.data.video?this.data.videoHeightRpx:this.data.galleryHeight);
  },
  pauseVideo(stop=false) {
    if(!this.data.video)return;
    const context=wx.createVideoContext("editorial-video",this);
    if(stop)context.stop();else context.pause();
    context.exitFullScreen();
  },
  currentVideoEvent(event:WechatMiniprogram.CustomEvent){return this.readVisible&&this.data.pageAlive&&Boolean(this.data.video)&&event.currentTarget.dataset.videoIdentity===this.data.videoEventId;},
  videoTimeChanged(event:WechatMiniprogram.CustomEvent) {
    const current=Number(event.detail.currentTime);
    if(this.currentVideoEvent(event)&&this.data.video&&Number.isFinite(current)&&current>=0)this.videoPosition=Math.min(current,this.data.video.durationSeconds);
  },
  videoEnded(event:WechatMiniprogram.CustomEvent){if(this.currentVideoEvent(event))this.videoPosition=0;},
  videoFailed(event:WechatMiniprogram.CustomEvent){if(this.currentVideoEvent(event))this.setData({mediaError:"视频暂时无法播放，请重新加载。"});},
  currentEditorial(attempt:number,token:string){return this.readVisible&&this.data.pageAlive&&this.data.loadAttempt===attempt&&token===getApp<IAppOption>().globalData.sessionToken;},
  recoverExpiredEditorialRead(attempt:number,token:string,error:unknown){
    if(!this.readVisible||!this.data.pageAlive||this.data.leaving||attempt!==this.data.loadAttempt||!expiredEditorialRead(error,token))return false;
    this.data.loadAttempt+=1;
    this.cancelGallerySizing?.();this.invalidatePreview();this.readingRead=null;this.pendingReadingRestore=null;
    this.commentReadEpoch+=1;this.commentActionOwner+=1;this.blockReadEpoch+=1;
    this.syncCommentDraftOwner();
    this.setData({blocksOpen:false,blocks:[],blocksLoading:false,blocksBusy:false,commentsLoading:false,commentsBusy:false,commentsError:"",commentsNotice:"",editorialCommentItems:[],commentCount:null,commentsEnabled:null,canModerate:false,commentAuthenticated:false,loading:false,item:null,authorId:"",media:[],video:null,videoHeightRpx:1000,videoInitialTime:0,videoEventId:"",imageEventId:"",mediaIndex:0,mediaError:"",shareId:"",socialEnabled:false,socialLoading:false,socialBusy:false,
      social:emptyCommunity,threads:[],following:false,followBusy:false,followError:"",socialError:"",draft:"",replyToId:"",replyToName:"",
      errorKind:"load",errorTitle:"登录状态已失效",error:"请重新加载内容。点赞、收藏和关注前，请重新登录。"});
    wx.hideShareMenu();return true;
  },
  editorialReturnUrl(){return `/pages/post/index?id=${encodeURIComponent(this.data.id)}&source=editorial`;},
  resolveGalleryHeight(id:string,version:number,images:string[],token:string,attempt:number):Promise<number> {
    const layoutIdentity=readingBaseLayoutIdentity();
    const cache=this.gallerySizingCache;
    if(cache&&layoutIdentity!==null&&cache.layoutIdentity===layoutIdentity&&cache.id===id&&cache.version===version&&cache.ownerToken===token
      &&cache.media.length===images.length&&cache.media.every((url:string,index:number)=>url===images[index]))return Promise.resolve(cache.height);
    const src=images[0];
    if(!src||typeof wx.getImageInfo!=="function")return Promise.resolve(1000);
    return new Promise<number>(resolve=>{
      let settled=false;
      let timer:ReturnType<typeof setTimeout>|undefined;
      const finish=(height:number)=>{
        if(settled)return;
        settled=true;
        if(timer!==undefined)clearTimeout(timer);
        if(this.cancelGallerySizing===cancel)this.cancelGallerySizing=null;
        resolve(height);
      };
      // getImageInfo has no abort handle; cancellation settles this read and ignores late callbacks.
      const cancel=()=>finish(1000);
      this.cancelGallerySizing=cancel;
      timer=setTimeout(()=>finish(1000),2500);
      try{
        wx.getImageInfo({src,success:result=>{
          if(settled)return;
          const height=imageCanvasHeight(result.width,result.height,result.orientation);
          if(height===null){finish(1000);return;}
          if(layoutIdentity!==null&&layoutIdentity===readingBaseLayoutIdentity()&&this.currentEditorial(attempt,token)&&!this.data.leaving&&this.data.id===id){
            this.gallerySizingCache={id,version,ownerToken:token,media:[...images],layoutIdentity,height};
          }
          finish(height);
        },fail:()=>finish(1000)});
      }catch{finish(1000);}
    });
  },
  async load(restoreGallery = false) {
    this.blockReadEpoch+=1;this.commentReadEpoch+=1;this.commentActionOwner+=1;
    this.syncCommentDraftOwner();
    this.cancelGallerySizing?.();this.invalidatePreview();
    const previous=this.galleryRead;
    const previousReading=this.readingRead;
    const reading=restoreGallery===true&&previousReading&&this.data.editorialSource
      &&previousReading.ownerToken===getApp<IAppOption>().globalData.sessionToken
      &&previousReading.id===this.data.id&&previousReading.id===this.data.item?.id&&previousReading.version===this.data.item?.version
      &&Array.isArray(this.data.item?.media)&&previousReading.mediaIdentity===readingMediaIdentity(this.data.item.media)
      &&previousReading.videoIdentity===readingVideoIdentity(this.data.video)
      &&previousReading.layoutIdentity===readingLayoutIdentity(this.data.video?this.data.videoHeightRpx:this.data.galleryHeight)
      &&Number.isFinite(previousReading.scrollTop)&&previousReading.scrollTop>=0?{...previousReading}:null;
    const scrollRevision=this.readingScrollRevision;
    this.readingRead=null;this.pendingReadingRestore=null;
    // Resume only a same-actor gallery after a fresh, matching server read.
    // Explicit reloads (including native tap events) do not opt into resume.
    const gallery=restoreGallery===true && previous && !this.data.video
      && previous.ownerToken===getApp<IAppOption>().globalData.sessionToken
      && previous.id===this.data.id && previous.id===this.data.item?.id && previous.version===this.data.item?.version
      && previous.media.length===this.data.media.length && previous.media.every((src:string,index:number)=>src===this.data.media[index])
      && Number.isInteger(this.data.mediaIndex) && this.data.mediaIndex>=0 && this.data.mediaIndex<previous.media.length
      ? {...previous,index:this.data.mediaIndex}
      : null;
    this.galleryRead=null;
    this.pauseVideo();
    const attempt = this.data.loadAttempt + 1;
    wx.hideShareMenu();
    this.setData({ commentsLoading:false,commentsBusy:false,commentsError:"",commentsNotice:"",commentsEnabled:null,commentCount:null,commentsPolicyVersion:0,canModerate:false,commentHasMore:false,commentCursor:null,editorialCommentItems:[],aiLabel:"", loadAttempt: attempt, socialEnabled: false, socialBusy: false, socialLoading: false, social: emptyCommunity, threads: [], following: false, followBusy:false,followError: "", item: null, media: [], video:null,videoHeightRpx:1000,videoInitialTime:0,videoEventId:"",imageEventId:"", mediaIndex: 0, galleryHeight:1000, mediaError:"",shareId: "", loading: true, errorKind: "none", errorTitle: "", error: "" });
    try {
      const editorial = editorialStory(this.data.id);
      if (!editorial && isBundledEditorialId(this.data.id)) {
        if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return;
        this.setData({ loading: false, errorKind: "missing", errorTitle: "这篇护理故事暂不可见", error: "该内容尚未完成展示授权，请返回社区查看其他内容。" });
        return;
      }
      if(this.data.editorialSource){
        const token=getApp<IAppOption>().globalData.sessionToken;
        if(!editorialIdentifier(this.data.id)){this.setData({loading:false,errorKind:"missing",errorTitle:"这篇精选不可用",error:"内容链接无效，请返回社区。"});return;}
        try{const article=await publishedEditorialArticle(this.data.id,this);
          if(!this.currentEditorial(attempt,token))return;
          const display=editorialDisplayMedia(article.media);
          const videoMedia=article.media.find(media=>media.type==="video");
          const videoHeightRpx=videoMedia?.type==="video"?imageCanvasHeight(videoMedia.width,videoMedia.height,"up")??1000:1000;
          const galleryHeight=display.images.length?await this.resolveGalleryHeight(article.id,article.version,display.images,token,attempt):1000;
          if(!this.currentEditorial(attempt,token)){
            this.recoverExpiredEditorialRead(attempt,token,{code:"REQUEST_SESSION_CHANGED"});
            return;
          }
          const restored=gallery && !display.video && gallery.id===article.id && gallery.version===article.version
            && gallery.ownerToken===token && gallery.media.length===display.images.length
            && gallery.media.every((src:string,index:number)=>src===display.images[index]) ? gallery : null;
          this.galleryRead=display.video?null:{id:article.id,version:article.version,media:[...display.images],ownerToken:token,height:galleryHeight};
          const videoIdentity=`${article.id}:${article.version}:${display.video?.src||""}`;
          if(this.videoIdentity!==videoIdentity)this.videoPosition=0;
          this.videoIdentity=videoIdentity;
          const canvasHeight=display.video?videoHeightRpx:galleryHeight;
          const layoutIdentity=readingLayoutIdentity(canvasHeight);
          const nextReading:ReadingRead|null=layoutIdentity===null?null:{id:article.id,version:article.version,ownerToken:token,
            mediaIdentity:readingMediaIdentity(article.media),videoIdentity:readingVideoIdentity(display.video),layoutIdentity,canvasHeight,attempt,scrollTop:0};
          const restoreReading=Boolean(reading&&nextReading&&reading.id===nextReading.id&&reading.version===nextReading.version
            &&reading.ownerToken===nextReading.ownerToken&&reading.mediaIdentity===nextReading.mediaIdentity
            &&reading.videoIdentity===nextReading.videoIdentity&&reading.layoutIdentity===nextReading.layoutIdentity
            &&scrollRevision===this.readingScrollRevision&&reading.scrollTop>0);
          this.readingRead=nextReading;
          if(restoreReading&&nextReading&&reading){nextReading.scrollTop=reading.scrollTop;this.pendingReadingRestore=nextReading;}
          // A legal409 confirmed that no interaction was accepted. A current
          // successful read may retire that old refusal, never an unknown write.
          const clearSocialRefusal=this.editorialSocialRefusal!==null&&this.data.socialError===this.editorialSocialRefusal;
          if(clearSocialRefusal)this.editorialSocialRefusal=null;
          this.setData({...clearSocialRefusal?{socialError:""}:{},aiLabel:editorialAiLabel(article,restored?.index??0),commentsEnabled:article.commentsEnabled??null,commentCount:article.commentCount??null,commentsPolicyVersion:article.commentsPolicyVersion??0,canModerate:article.canModerate===true,authorId:article.authorId,item:{...article,kind:"editorial",avatar:defaultMemberAvatar,
            readingSegments:readingSegments(article.body),publishedLabel:new Date(article.publishedAt).toLocaleDateString("zh-CN"),engagementLabel:"精选内容"},
            media:display.images,mediaIndex:restored?.index??0,galleryHeight,video:display.video,videoHeightRpx,videoInitialTime:this.videoPosition,videoEventId:display.video?`${attempt}:${article.version}:${article.id}`:"",imageEventId:display.images.length?`${attempt}:${article.version}:${article.id}:${galleryHeight}`:"",following:article.following,
            commentAuthenticated:Boolean(token),socialEnabled:article.interactionsEnabled===true,social:{...emptyCommunity,preview:false,liked:article.liked,saved:article.saved,likeCount:article.likeCount,saveCount:article.saveCount},loading:false},()=>{
              void this.loadEditorialComments().then(()=>{
              if(!restoreReading||!nextReading)return;
              wx.nextTick(()=>{
                if(this.pendingReadingRestore!==nextReading)return;
                if(!this.currentReadingRead(nextReading)||scrollRevision!==this.readingScrollRevision||nextReading.layoutIdentity!==readingLayoutIdentity(this.data.video?this.data.videoHeightRpx:this.data.galleryHeight)){
                  nextReading.scrollTop=0;this.pendingReadingRestore=null;return;
                }
                this.pendingReadingRestore=null;
                wx.pageScrollTo({scrollTop:nextReading.scrollTop,duration:0,fail:()=>{if(this.currentReadingRead(nextReading))nextReading.scrollTop=0;}});
              });
              });
            });
          wx.showShareMenu({menus:["shareAppMessage"]});
        }catch(error){if(this.recoverExpiredEditorialRead(attempt,token,error))return;if(this.currentEditorial(attempt,token)){const missing=(error as {status?:number}).status===404;
          this.setData({loading:false,errorKind:missing?"missing":"load",errorTitle:missing?"这篇精选暂不可见":"暂时无法加载精选",error:missing?"内容已撤回或尚未发布，请返回社区。":"请检查网络后重试。"});}}
        return;
      }
      if (editorial) {
        if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return;
        this.setData({ authorId: "brand:cisme", item: editorial, media: editorial.media ?? [editorial.image], mediaIndex: 0, loading: false, errorKind: "none", errorTitle: "", error: "" });
        wx.showShareMenu({ menus: ["shareAppMessage"] });
        void this.prepareShare(attempt);
        void this.loadSocial();
        return;
      }
      const feed = await prepareFeedAuthors([await request<any>({ path: `/v1/feed/${encodeURIComponent(this.data.id)}`, authMode: "public" })]);
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return;
      // The feed exposes an object key, not an authorized media URL or avatar.
      // Never attribute bundled brand imagery or a local portrait to a submission.
      const reviewed = feed.find((item: any) => item.id === this.data.id) ?? null;
      this.setData({ authorId: reviewed?.author_id || "", item: reviewed ? { ...reviewed, image: "", avatar: reviewed.avatar || defaultMemberAvatar, author: reviewed.author || "CISME 会员", publishedLabel: "用户投稿", provenanceLabel: "经作者授权并审核后展示" } : null, loading: false, errorKind: reviewed ? "none" : "missing", errorTitle: reviewed ? "" : "这篇护理故事不可用", error: reviewed ? "" : "内容已撤回、授权已失效，或链接无效。请返回社区查看其他内容。" });
      if (reviewed) {
        void this.loadSocial();
        wx.showShareMenu({ menus: ["shareAppMessage"] });
        void this.prepareShare(attempt);
      }
    }
    catch (error) {
      if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ item: null, shareId: "", loading: false, errorKind: "load", errorTitle: "暂时无法加载故事", error: "请检查网络后重新加载。" });
    }
  },
  syncCommentDraftOwner() {
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(this.commentDraftToken!==token||this.commentDraftArticle!==this.data.id){
      this.commentDraftToken=token;this.commentDraftArticle=this.data.id;
      this.setData({draft:"",draftLength:0,draftOperation:"",replyToId:"",replyToName:"",composerOpen:false,composerFocused:false,keyboardHeight:0,commentSendUnknown:false,lastBlockedAuthor:"",lastBlockedName:""});
    }
  },
  commentIntent():CommentIntent|null {
    if(!this.data.editorialSource||!this.data.item||!this.readVisible||!this.data.pageAlive||this.data.leaving||this.data.loading)return null;
    return {owner:this.commentActionOwner,attempt:this.data.loadAttempt,token:getApp<IAppOption>().globalData.sessionToken,id:this.data.id,version:this.data.item.version};
  },
  currentCommentIntent(intent:CommentIntent):boolean {
    return this.commentActionOwner===intent.owner&&this.currentEditorial(intent.attempt,intent.token)&&!this.data.leaving&&!this.data.loading
      &&this.data.id===intent.id&&this.data.item?.id===intent.id&&this.data.item?.version===intent.version;
  },
  beginEditorialCommentAction(requireEnabled=false):CommentIntent|null {
    if(this.data.commentsBusy)return null;
    const intent=this.commentIntent();if(!intent)return null;
    if(!intent.token){resumeAuthentication(this.editorialReturnUrl());return null;}
    if(requireEnabled&&this.data.commentsEnabled!==true){this.setData({commentsError:"评论设置已变化，请刷新后再试。"});return null;}
    this.interruptReadingRestore();
    this.commentReadEpoch+=1;
    intent.owner=++this.commentActionOwner;
    this.setData({commentsBusy:true,commentsLoading:false,commentsError:"",commentsNotice:""});
    return intent;
  },
  finishEditorialCommentAction(intent:CommentIntent) { if(this.currentCommentIntent(intent))this.setData({commentsBusy:false}); },
  editorialCommentFailed(intent:CommentIntent,error:unknown,fallback:string,requiresConsent=false) {
    if(!this.currentCommentIntent(intent)){
      this.recoverExpiredEditorialRead(intent.attempt,intent.token,error);
      return;
    }
    this.setData({commentsError:commentFailure(error,fallback)});
    if(requiresConsent&&(error as {status?:number;code?:string})?.status===409&&(error as {code?:string}).code==="CURRENT_LEGAL_CONSENT_REQUIRED")beginLegalRenewal(this.editorialReturnUrl());
  },
  async loadEditorialComments(append=false) {
    const intent=this.commentIntent();if(!intent||this.data.commentsBusy)return;
    const more=append===true;
    if(more&&(!this.data.commentHasMore||!this.data.commentCursor||this.data.commentsLoading))return;
    const epoch=++this.commentReadEpoch,cursor=more?this.data.commentCursor:null;
    const current=()=>epoch===this.commentReadEpoch&&this.currentCommentIntent(intent);
    this.setData({commentsLoading:true,commentsError:""});
    try{
      const page=await readEditorialComments(intent.id,this,cursor);
      if(!current())return;
      const prepared=await prepareCommentAuthors({...emptyCommunity,preview:false,comments:page.comments,authors:page.authors});
      if(!current())return;
      const existing=more?this.data.editorialCommentItems:[];
      const byId=new Map<string,CommunityComment>(existing.map(comment=>[comment.id,comment]));
      for(const comment of prepared.comments)byId.set(comment.id,comment);
      const comments=[...byId.values()];
      this.setData({editorialCommentItems:comments,threads:commentThreads(comments,this.data.expandedThreads),commentCount:page.commentCount,
        commentsEnabled:page.commentsEnabled,commentsPolicyVersion:page.commentsPolicyVersion,canModerate:page.canModerate,
        commentHasMore:page.hasMore,commentCursor:page.nextCursor,commentAuthenticated:Boolean(intent.token),commentsLoading:false,...(!page.commentsEnabled?{composerOpen:false,composerFocused:false,keyboardHeight:0}:{})});
      if(!page.commentsEnabled)wx.hideKeyboard();
    }catch(error){
      if(this.recoverExpiredEditorialRead(intent.attempt,intent.token,error))return;
      if(current())this.setData({commentsLoading:false,commentsError:commentFailure(error,"评论暂时无法加载，请重试。")});
    }finally{if(current())this.setData({commentsLoading:false});}
  },
  loadMoreEditorialComments() { return this.loadEditorialComments(true); },
  startComment() {
    if(!this.commentIntent())return;this.interruptReadingRestore();
    if(!getApp<IAppOption>().globalData.sessionToken){resumeAuthentication(this.editorialReturnUrl());return;}
    if(this.data.commentsEnabled!==true){this.showComments();return;}
    this.syncCommentDraftOwner();this.setData({composerOpen:true,composerFocused:true});
  },
  closeComposer() { this.setData({composerOpen:false,composerFocused:false,keyboardHeight:0});wx.hideKeyboard(); },
  async sendEditorialComment() {
    const body=this.data.draft.trim();
    const length=Array.from(body).length;
    if(length<2||length>180){this.setData({commentsError:"评论请输入 2 至 180 个字。"});return;}
    const intent=this.beginEditorialCommentAction(true);if(!intent)return;
    const operation=this.data.draftOperation||`comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
    const replyToId=this.data.replyToId;
    this.setData({draftOperation:operation,commentSendUnknown:true});
    try{
      const result=await createEditorialComment(intent.id,{body,...(replyToId?{replyToId}:{})},operation);
      if(!this.currentCommentIntent(intent))return;
      const notice=result.status==="pending"?"评论已提交，审核后公开。":result.status==="published"?"评论已发布。":result.status==="deleted"?"这次提交的评论已删除，未再次发送。":result.status==="hidden"?"这次提交的评论已隐藏，可在列表核对。":"这次提交的评论未通过审核，可在列表核对。";
      this.setData({commentsNotice:notice,commentSendUnknown:false});
      if(this.data.draftOperation===operation){
        this.setData({draft:"",draftLength:0,draftOperation:"",replyToId:"",replyToName:"",composerOpen:false,composerFocused:false,keyboardHeight:0});wx.hideKeyboard();
      }
      this.finishEditorialCommentAction(intent);
      await this.loadEditorialComments();
    }catch(error){
      if(this.currentCommentIntent(intent)){
        const status=Number((error as {status?:number})?.status);
        // An unconfirmed transport result must keep the same body and key.
        this.setData({commentSendUnknown:!Number.isInteger(status)||status>=500});
      }
      this.editorialCommentFailed(intent,error,"发送结果还未确认，内容已保留。请点“核对发送”继续。",true);
    }finally{this.finishEditorialCommentAction(intent);}
  },
  async likeEditorialComment(event:WechatMiniprogram.TouchEvent) {
    const comment=this.data.editorialCommentItems.find(item=>item.id===event.currentTarget.dataset.id);
    if(comment?.status!=="published")return;
    const intent=this.beginEditorialCommentAction(true);if(!intent)return;
    try{
      const result=await setEditorialCommentLike(intent.id,comment.id,!comment.liked);
      if(!this.currentCommentIntent(intent))return;
      const comments=this.data.editorialCommentItems.map(item=>item.id===result.id?{...item,liked:result.liked,likeCount:result.likeCount}:item);
      this.setData({editorialCommentItems:comments,threads:commentThreads(comments,this.data.expandedThreads)});
    }catch(error){this.editorialCommentFailed(intent,error,"点赞结果尚未确认，请刷新评论核对。",true);}
    finally{this.finishEditorialCommentAction(intent);}
  },
  async deleteEditorialComment(event:WechatMiniprogram.TouchEvent) {
    const comment=this.data.editorialCommentItems.find(item=>item.id===event.currentTarget.dataset.id);
    if(!comment?.isMine)return;
    const intent=this.beginEditorialCommentAction();if(!intent)return;
    try{
      const answer=await wx.showModal({title:"删除这条评论？",content:"删除后将不再展示。",confirmText:"删除",confirmColor:"#d83b4e"});
      if(!answer.confirm||!this.currentCommentIntent(intent))return;
      await deleteEditorialComment(intent.id,comment.id);
      if(!this.currentCommentIntent(intent))return;
      const comments=this.data.editorialCommentItems.filter(item=>item.id!==comment.id&&item.parentId!==comment.id);
      this.setData({editorialCommentItems:comments,threads:commentThreads(comments,this.data.expandedThreads),commentCount:null,commentsNotice:"评论已删除。",
        ...(this.data.replyToId===comment.id?{replyToId:"",replyToName:"",draftOperation:""}:{})});
      this.finishEditorialCommentAction(intent);await this.loadEditorialComments();
    }catch(error){this.editorialCommentFailed(intent,error,"删除结果尚未确认，请刷新评论核对。");}
    finally{this.finishEditorialCommentAction(intent);}
  },
  async commentMore(event:WechatMiniprogram.TouchEvent) {
    const comment=this.data.editorialCommentItems.find(item=>item.id===event.currentTarget.dataset.id);
    if(!comment||comment.isMine||comment.status!=="published")return;
    const intent=this.commentIntent();if(!intent||this.data.commentsBusy)return;
    if(!intent.token){resumeAuthentication(this.editorialReturnUrl());return;}
    try{
      const answer=await wx.showActionSheet({itemList:["举报这条评论","屏蔽这位用户"]});
      if(!this.currentCommentIntent(intent))return;
      if(answer.tapIndex===0)await this.reportComment(event);else if(answer.tapIndex===1)await this.blockComment(event);
    }catch{/* Dismissing the native menu has no side effect. */}
  },
  async reportComment(event:WechatMiniprogram.TouchEvent) {
    const comment=this.data.editorialCommentItems.find(item=>item.id===event.currentTarget.dataset.id);
    if(!comment||comment.isMine||comment.status!=="published")return;
    const intent=this.beginEditorialCommentAction();if(!intent)return;
    try{
      const categories:EditorialReportCategory[]=["spam","abuse","privacy","misinformation","rights","other"];
      const answer=await wx.showActionSheet({itemList:["广告或垃圾信息","辱骂或骚扰","泄露隐私","不实信息","侵犯权利","其他"]});
      if(!this.currentCommentIntent(intent))return;
      const category=categories[answer.tapIndex];if(!category)return;
      const detail=await wx.showModal({title:"举报说明",editable:true,placeholderText:"可补充说明（最多 500 字）",confirmText:"提交举报"});
      if(!detail.confirm||!this.currentCommentIntent(intent))return;
      const description=(detail.content||"").trim();if(Array.from(description).length>500){this.setData({commentsError:"举报说明请勿超过 500 字。"});return;}
      await reportEditorialComment(intent.id,comment.id,{category,...(description?{description}:{})});
      if(this.currentCommentIntent(intent))this.setData({commentsNotice:"举报已提交，我们会核对处理。"});
    }catch(error){if((error as {errMsg?:string})?.errMsg?.includes("cancel"))return;this.editorialCommentFailed(intent,error,"举报结果尚未确认，请稍后核对。");}
    finally{this.finishEditorialCommentAction(intent);}
  },
  async blockComment(event:WechatMiniprogram.TouchEvent) {
    const comment=this.data.editorialCommentItems.find(item=>item.id===event.currentTarget.dataset.id);
    if(!comment||comment.isMine||comment.status!=="published"||!comment.authorId)return;
    const intent=this.beginEditorialCommentAction();if(!intent)return;
    try{
      const answer=await wx.showModal({title:"屏蔽这位用户？",content:"你将不再看到彼此的评论。可在屏蔽管理中解除。",confirmText:"屏蔽"});
      if(!answer.confirm||!this.currentCommentIntent(intent))return;
      await setEditorialBlock(comment.authorId,true);
      if(!this.currentCommentIntent(intent))return;
      this.setData({lastBlockedAuthor:comment.authorId,lastBlockedName:comment.authorName,editorialCommentItems:[],threads:[],commentCount:null,commentsNotice:"已屏蔽这位用户。"});
      this.finishEditorialCommentAction(intent);await this.loadEditorialComments();
    }catch(error){this.editorialCommentFailed(intent,error,"屏蔽结果尚未确认，请刷新评论核对。");}
    finally{this.finishEditorialCommentAction(intent);}
  },
  async undoEditorialBlock() {
    const authorId=this.data.lastBlockedAuthor;if(!authorId)return;
    const intent=this.beginEditorialCommentAction();if(!intent)return;
    try{
      await setEditorialBlock(authorId,false);if(!this.currentCommentIntent(intent))return;
      this.setData({lastBlockedAuthor:"",lastBlockedName:"",commentsNotice:"已解除屏蔽。"});
      this.finishEditorialCommentAction(intent);await this.loadEditorialComments();
    }catch(error){this.editorialCommentFailed(intent,error,"解除结果尚未确认，请稍后重试。");}
    finally{this.finishEditorialCommentAction(intent);}
  },
  openCommentReview() {
    if(!this.commentIntent()||!this.data.canModerate)return;
    this.setData({leaving:true});
    wx.navigateTo({url:`/pages/community-review/index?source=editorial&articleId=${encodeURIComponent(this.data.id)}`,fail:()=>{
      if(this.readVisible&&this.data.pageAlive){this.setData({leaving:false});wx.showToast({title:"审核列表暂时无法打开",icon:"none"});}
    }});
  },
  async toggleCommentsPolicy() {
    if(!this.data.canModerate||typeof this.data.commentsEnabled!=="boolean")return;
    const intent=this.beginEditorialCommentAction();if(!intent)return;
    const enabled=!this.data.commentsEnabled,expectedVersion=this.data.commentsPolicyVersion;
    try{
      const answer=await wx.showModal({title:enabled?"开启这篇文章的评论？":"关闭这篇文章的评论？",content:enabled?"新评论将先经过审核。":"已有评论仍可阅读；关闭期间不能发送或点赞评论。",confirmText:enabled?"开启":"关闭"});
      if(!answer.confirm||!this.currentCommentIntent(intent))return;
      const result=await setEditorialCommentsPolicy(intent.id,{enabled,expectedVersion});
      if(!this.currentCommentIntent(intent))return;
      this.setData({...result,composerOpen:enabled&&this.data.composerOpen,composerFocused:false,keyboardHeight:0,commentsNotice:enabled?"评论已开启。":"评论已关闭。"});
      wx.hideKeyboard();this.finishEditorialCommentAction(intent);await this.loadEditorialComments();
    }catch(error){this.editorialCommentFailed(intent,error,"评论设置尚未确认，请刷新核对。");}
    finally{this.finishEditorialCommentAction(intent);}
  },
  async openPostMore() {
    this.interruptReadingRestore();
    const intent=this.commentIntent();if(!intent||this.data.commentsBusy)return;
    const actions:Array<{label:string;run:()=>void|Promise<void>}>=[];
    if(this.data.item.sourceUrl)actions.push({label:"复制原文链接",run:()=>this.copySource()});
    if(this.data.canModerate){actions.push({label:"管理评论",run:()=>this.openCommentReview()});actions.push({label:this.data.commentsEnabled?"关闭这篇评论":"开启这篇评论",run:()=>this.toggleCommentsPolicy()});}
    actions.push({label:"屏蔽管理",run:()=>this.openEditorialBlocks()});
    try{const answer=await wx.showActionSheet({itemList:actions.map(action=>action.label)});if(this.currentCommentIntent(intent))await actions[answer.tapIndex]?.run();}catch{/* Native menu dismissed. */}
  },
  openEditorialBlocks() {
    const intent=this.commentIntent();if(!intent||this.data.commentsBusy)return;
    if(!intent.token){resumeAuthentication(this.editorialReturnUrl());return;}
    this.setData({blocksOpen:true,blocks:[],blocksCursor:null,blocksHasMore:false,blocksError:"",composerOpen:false,composerFocused:false,keyboardHeight:0});
    wx.hideKeyboard();void this.loadEditorialBlocks();
  },
  closeEditorialBlocks() {
    this.blockReadEpoch+=1;this.commentReadEpoch+=1;this.commentActionOwner+=1;
    this.setData({blocksOpen:false,blocksLoading:false,blocksBusy:false,commentsBusy:false,commentsLoading:false,blocksError:"",blocks:[],blocksCursor:null,blocksHasMore:false});
    void this.loadEditorialComments();
  },
  holdOverlay() {},
  async loadEditorialBlocks(append=false) {
    const intent=this.commentIntent();if(!intent?.token||!this.data.blocksOpen||this.data.blocksBusy)return;
    const more=append===true;if(more&&(!this.data.blocksHasMore||!this.data.blocksCursor||this.data.blocksLoading))return;
    const epoch=++this.blockReadEpoch;
    const current=()=>epoch===this.blockReadEpoch&&this.data.blocksOpen&&this.currentCommentIntent(intent);
    this.setData({blocksLoading:true,blocksError:""});
    try{
      const page=await readEditorialBlocks(this,more?this.data.blocksCursor:null);
      if(!current())return;
      const byId=new Map((more?this.data.blocks:[]).map(item=>[item.authorId,item]));
      for(const item of page.items)byId.set(item.authorId,{authorId:item.authorId,name:item.name});
      this.setData({blocks:[...byId.values()],blocksCursor:page.nextCursor,blocksHasMore:page.hasMore,blocksLoading:false});
    }catch(error){
      if(this.recoverExpiredEditorialRead(intent.attempt,intent.token,error))return;
      if(current())this.setData({blocksError:commentFailure(error,"屏蔽列表暂时无法加载，请重试。"),blocksLoading:false});
    }finally{if(current())this.setData({blocksLoading:false});}
  },
  loadMoreEditorialBlocks() {return this.loadEditorialBlocks(true);},
  async unblockEditorialAuthor(event:WechatMiniprogram.TouchEvent) {
    const authorId=String(event.currentTarget.dataset.id||"");
    if(!this.data.blocksOpen||!this.data.blocks.some(item=>item.authorId===authorId)||this.data.blocksBusy)return;
    const intent=this.beginEditorialCommentAction();if(!intent)return;
    const epoch=++this.blockReadEpoch;
    this.setData({blocksBusy:true,blocksLoading:false,blocksError:""});
    try{
      await setEditorialBlock(authorId,false);
      if(!this.currentCommentIntent(intent)||!this.data.blocksOpen||epoch!==this.blockReadEpoch)return;
      this.setData({blocks:this.data.blocks.filter(item=>item.authorId!==authorId),...(this.data.lastBlockedAuthor===authorId?{lastBlockedAuthor:"",lastBlockedName:""}:{}),commentsNotice:"已解除屏蔽。"});
      this.finishEditorialCommentAction(intent);await this.loadEditorialComments();
    }catch(error){
      if(this.currentCommentIntent(intent)&&this.data.blocksOpen&&epoch===this.blockReadEpoch)this.setData({blocksError:commentFailure(error,"解除结果尚未确认，请刷新列表核对。")});
      this.recoverExpiredEditorialRead(intent.attempt,intent.token,error);
    }finally{if(this.currentCommentIntent(intent)&&epoch===this.blockReadEpoch){this.setData({blocksBusy:false});this.finishEditorialCommentAction(intent);}}
  },
  async loadFollow() {
    const attempt = this.data.loadAttempt;
    this.setData({ following: false, followError: "" });
    if (!this.data.socialEnabled || !getApp<IAppOption>().globalData.sessionToken) return;
    try {
      const follows = await request<string[]>({ path: "/v1/me/follows", authMode: "optional" });
      if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ following: follows.includes(this.data.authorId) });
    } catch { if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ followError: "暂时无法查询关注状态" }); }
  },
  async toggleFollow() {
    if (!this.data.socialEnabled || this.data.followBusy || !this.data.authorId || this.data.leaving) return;
    if(this.data.editorialSource){
      if(this.data.item?.isMine)return;
      const token=getApp<IAppOption>().globalData.sessionToken;
      if(!token){resumeAuthentication(this.editorialReturnUrl());return;}
      const attempt=this.data.loadAttempt;
      this.interruptReadingRestore();this.setData({followBusy:true,followError:""});
      try{const result=await followEditorialArticle(this.data.id,!this.data.following);
        if(result.authorId!==this.data.authorId)throw new Error("EDITORIAL_AUTHOR_MISMATCH");
        if(this.currentEditorial(attempt,token))this.setData({following:result.following});
      }catch(error){if(this.currentEditorial(attempt,token)){
        if((error as {status?:number;code?:string}).status===409&&(error as {code?:string}).code==="CURRENT_LEGAL_CONSENT_REQUIRED")beginLegalRenewal(this.editorialReturnUrl());
        this.setData({followError:(error as {title?:string}).title||"关注结果尚未确认，请先重新加载查看。"});}}
      finally{if(this.currentEditorial(attempt,token))this.setData({followBusy:false});}
      return;
    }
    clearAuthenticationRedirectSuppression();
    const attempt = this.data.loadAttempt;
    this.setData({ followBusy: true, followError: "" });
    try {
      const result = await request<{following:boolean}>({ path: `/v1/me/follows/${encodeURIComponent(this.data.authorId)}`, method: "PUT", data: { active: !this.data.following } });
      if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ following: result.following });
    } catch (error) { if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ followError: (error as {title?:string}).title || "关注结果尚未确认，请先重新加载查看" }); }
    finally { if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ followBusy: false }); }
  },
  async loadSocial() {
    if(this.data.editorialSource){await this.loadEditorialComments();return;}
    const attempt = this.data.loadAttempt;
    this.setData({ socialLoading: true, socialError: "" });
    try {
      const health = await request<{ communityPreviewEnabled: boolean }>({ path: "/v1/capabilities", authMode: "public" });
      if (!this.data.pageAlive || attempt !== this.data.loadAttempt) return;
      this.setData({ socialEnabled: health.communityPreviewEnabled === true });
      if (!health.communityPreviewEnabled) return;
      void this.loadFollow();
      const social = await prepareCommentAuthors(await request<CommunityView>({ path: `/v1/community/${encodeURIComponent(this.data.id)}`, authMode: "optional" }));
      if (!this.data.pageAlive || attempt !== this.data.loadAttempt) return;
      this.setData({ social, threads: commentThreads(social.comments, this.data.expandedThreads) });
    } catch {
      if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ socialError: "暂时无法加载评论，点击重试" });
    } finally {
      if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ socialLoading: false });
    }
  },
  async mutateSocial(path: string, method: "POST" | "PUT" | "DELETE", data: WechatMiniprogram.IAnyObject, operationId?: string) {
    if (!this.data.pageAlive || this.data.leaving || this.data.socialBusy || !this.data.socialEnabled || this.data.socialLoading) return false;
    clearAuthenticationRedirectSuppression();
    const attempt = this.data.loadAttempt;
    this.setData({ socialBusy: true, socialError: "" });
    try {
      const social = await prepareCommentAuthors(await request<CommunityView>({ path: `/v1/community/${encodeURIComponent(this.data.id)}${path}`, method, data, ...(operationId?{idempotencyKey:operationId}:{}) }));
      if (!this.data.pageAlive || attempt !== this.data.loadAttempt) return false;
      this.setData({ social, threads: commentThreads(social.comments, this.data.expandedThreads) });
      return true;
    } catch (error) {
      if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ socialError: (error as { title?: string }).title || "保存结果尚未确认，请先重新加载查看。已输入的内容仍保留。" });
      return false;
    } finally {
      if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ socialBusy: false });
    }
  },
  async mutateEditorialReaction(kind:"like"|"save"){
    if(!this.data.editorialSource||!this.data.item||!this.data.pageAlive||this.data.leaving||!this.data.socialEnabled||this.data.socialBusy||this.data.loading)return;
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(!token){resumeAuthentication(this.editorialReturnUrl());return;}
    const attempt=this.data.loadAttempt;
    this.editorialSocialRefusal=null;
    this.interruptReadingRestore();this.setData({socialBusy:true,socialError:""});
    try{const result=await reactToEditorialArticle(this.data.id,kind,!(kind==="like"?this.data.social.liked:this.data.social.saved));
      if(this.currentEditorial(attempt,token))this.setData({social:{...this.data.social,liked:result.liked,saved:result.saved,likeCount:result.likeCount,saveCount:result.saveCount}});
    }catch(error){if(this.currentEditorial(attempt,token)){
      const consentRequired=(error as {status?:number;code?:string}).status===409&&(error as {code?:string}).code==="CURRENT_LEGAL_CONSENT_REQUIRED";
      const message=(error as {title?:string}).title||(consentRequired?"请确认当前用户协议和隐私指引后再互动。":"互动结果尚未确认，请先重新加载查看，再决定是否重试。");
      this.editorialSocialRefusal=consentRequired?message:null;
      this.setData({socialError:message});
      if(consentRequired)beginLegalRenewal(this.editorialReturnUrl());}}
    finally{if(this.currentEditorial(attempt,token))this.setData({socialBusy:false});}
  },
  toggleLike() { if(this.data.editorialSource)return this.mutateEditorialReaction("like");return this.mutateSocial("/reaction", "PUT", { kind: "like", active: !this.data.social.liked }); },
  toggleSave() { if(this.data.editorialSource)return this.mutateEditorialReaction("save");return this.mutateSocial("/reaction", "PUT", { kind: "save", active: !this.data.social.saved }); },
  openAuthor(){if(!this.data.editorialSource||!this.data.pageAlive||!editorialIdentifier(this.data.authorId)||this.data.leaving)return;this.setData({leaving:true});wx.navigateTo({url:`/pages/community-author/index?id=${encodeURIComponent(this.data.authorId)}&source=editorial`,fail:()=>{this.setData({leaving:false});wx.showToast({title:"作者资料暂时无法打开",icon:"none"});}});},
  copySource(){const url=this.data.editorialSource&&this.data.item?.sourceUrl;if(typeof url==="string"&&/^https:\/\//.test(url))wx.setClipboardData({data:url});},
  showComments() {
    if(this.data.editorialSource){
      if(!this.commentIntent())return;this.interruptReadingRestore();
      wx.pageScrollTo({selector:"#post-comments",duration:motionDuration(250)});
      if(this.data.commentsEnabled===null||this.data.commentsError)void this.loadEditorialComments();
      return;
    }
    wx.pageScrollTo({ selector: "#post-comments", duration: motionDuration(250) });
  },
  focusComment() { if(this.data.editorialSource&&!this.commentIntent())return;this.setData({ composerOpen:true,composerFocused: true }); },
  blurComment() { this.setData({ composerFocused: false, keyboardHeight: 0 }); },
  keyboardChanged(event: WechatMiniprogram.CustomEvent) { if(!this.readVisible||!this.data.pageAlive)return;this.setData({ keyboardHeight: Math.max(0, Number(event.detail.height) || 0) }); },
  inputComment(event: WechatMiniprogram.CustomEvent) { if(this.data.editorialSource&&(this.data.commentsBusy||this.data.commentSendUnknown||!this.commentIntent()))return;const value=String(event.detail.value??"");this.setData({draft:value,draftLength:Array.from(value.trim()).length,draftOperation:""}); },
  replyComment(event: WechatMiniprogram.TouchEvent) {
    const comment = (this.data.editorialSource?this.data.editorialCommentItems:this.data.social.comments).find(item => item.id === event.currentTarget.dataset.id);
    if (!comment || comment.status !== "published") return;
    if(this.data.editorialSource){if(this.data.commentsBusy||this.data.commentSendUnknown||!this.commentIntent()||this.data.commentsEnabled!==true)return;if(!getApp<IAppOption>().globalData.sessionToken){resumeAuthentication(this.editorialReturnUrl());return;}}
    this.setData({ composerOpen:true,replyToId: comment.id, replyToName: comment.authorName, draftOperation: "", composerFocused: true });
  },
  cancelReply() { if(this.data.editorialSource&&(this.data.commentsBusy||this.data.commentSendUnknown))return;this.setData({ replyToId: "", replyToName: "", draftOperation: "" }); },
  expandReplies(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id ?? "");
    const expanded = this.data.expandedThreads.includes(id) ? this.data.expandedThreads.filter(value => value !== id) : [...this.data.expandedThreads, id];
    this.setData({ expandedThreads: expanded, threads: commentThreads(this.data.editorialSource?this.data.editorialCommentItems:this.data.social.comments, expanded) });
  },
  likeComment(event: WechatMiniprogram.TouchEvent) {
    if(this.data.editorialSource)return this.likeEditorialComment(event);
    const comment = this.data.social.comments.find(item => item.id === event.currentTarget.dataset.id);
    if (comment?.status === "published") void this.mutateSocial(`/comments/${comment.id}/like`, "PUT", { active: !comment.liked });
  },
  deleteComment(event: WechatMiniprogram.TouchEvent) {
    if(this.data.editorialSource)return this.deleteEditorialComment(event);
    const comment = this.data.social.comments.find(item => item.id === event.currentTarget.dataset.id);
    if (comment?.isMine && comment.status !== "deleted") void this.mutateSocial(`/comments/${comment.id}`, "DELETE", {});
  },
  async sendComment() {
    if(this.data.editorialSource)return this.sendEditorialComment();
    const body = this.data.draft.trim();
    if (body.length < 2 || body.length > 180) { this.setData({ socialError: "评论请输入 2 至 180 个字" }); return; }
    const operation = this.data.draftOperation || `comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
    this.setData({ draftOperation: operation });
    const submitted = await this.mutateSocial("/comments", "POST", { body, ...(this.data.replyToId ? { replyToId: this.data.replyToId } : {}) }, operation);
    if (submitted) {
      if (this.data.draftOperation === operation) {
      this.setData({ draft: "", draftOperation: "", replyToId: "", replyToName: "", composerFocused: false, keyboardHeight: 0 });
      wx.hideKeyboard();
      }
      wx.showToast({ title: "已提交审核，仅本人可见", icon: "none" });
      this.showComments();
    }
  },
  currentGalleryIdentity(identity:unknown):boolean {
    const read=this.galleryRead;
    if(!this.data.editorialSource||!this.readVisible||!this.data.pageAlive||this.data.leaving||!read)return false;
    return read.id===this.data.id&&read.id===this.data.item?.id&&read.version===this.data.item?.version
      &&read.ownerToken===getApp<IAppOption>().globalData.sessionToken
      &&identity===this.data.imageEventId&&read.height===this.data.galleryHeight
      &&this.data.imageEventId===`${this.data.loadAttempt}:${read.version}:${read.id}:${read.height}`
      &&read.media.length===this.data.media.length&&read.media.every((url:string,index:number)=>url===this.data.media[index])
      &&this.data.media.length>0;
  },
  currentImageEvent(event:WechatMiniprogram.CustomEvent):boolean {
    return this.currentGalleryIdentity(event.currentTarget.dataset.imageIdentity)&&this.data.media.includes(String(event.currentTarget.dataset.src||""));
  },
  mediaFailed(event:WechatMiniprogram.CustomEvent){if(this.currentImageEvent(event))this.setData({mediaError:"图片加载失败，请重新加载。"});},
  mediaLoaded(event: WechatMiniprogram.CustomEvent) {
    if(!this.readVisible||!this.data.pageAlive||this.data.leaving||(this.data.editorialSource&&!this.currentImageEvent(event)))return;
    // Geometry is locked before publication; later/offscreen images cannot move the text.
  },
  beginGalleryTouch(event:WechatMiniprogram.TouchEvent) {
    const identity=String(event.currentTarget.dataset.imageIdentity||"");
    const touch=event.touches[0];
    if(!this.currentGalleryIdentity(identity))return;
    if(!touch){this.galleryTouch=null;return;}
    this.galleryTouch={identity,startX:touch.pageX,startY:touch.pageY,moved:event.touches.length>1};
  },
  moveGalleryTouch(event:WechatMiniprogram.TouchEvent) {
    const gesture=this.galleryTouch,touch=event.touches[0];
    if(!gesture||!touch||gesture.identity!==event.currentTarget.dataset.imageIdentity||!this.currentGalleryIdentity(gesture.identity))return;
    if(event.touches.length>1||(touch.pageX-gesture.startX)**2+(touch.pageY-gesture.startY)**2>144)gesture.moved=true;
  },
  onMediaChange(event: WechatMiniprogram.CustomEvent) {
    if(!this.readVisible||!this.data.pageAlive||this.data.leaving||(this.data.editorialSource&&!this.currentGalleryIdentity(event.currentTarget.dataset.imageIdentity)))return;
    const current=event.detail.current;
    if(typeof current!=="number"||!Number.isInteger(current)||current<0||current>=this.data.media.length||current===this.data.mediaIndex)return;
    this.setData({ mediaIndex:current,...(this.data.editorialSource&&this.data.item?{aiLabel:editorialAiLabel(this.data.item,current)}:{}) });
  },
  invalidatePreview() {this.previewOwner+=1;this.previewBusy=false;this.galleryTouch=null;},
  currentPreview(intent:PreviewIntent):boolean {
    if(this.previewOwner!==intent.owner||!this.previewBusy||!this.readVisible||!this.data.pageAlive||this.data.leaving
      ||this.data.loadAttempt!==intent.attempt||getApp<IAppOption>().globalData.sessionToken!==intent.ownerToken
      ||this.data.id!==intent.id||this.data.item?.id!==intent.id||this.data.item?.version!==intent.version
      ||this.data.media.length!==intent.media.length||!intent.media.every((url:string,index:number)=>url===this.data.media[index]))return false;
    return !this.data.editorialSource||(this.galleryRead===intent.read&&this.currentGalleryIdentity(intent.imageIdentity));
  },
  failPreview(intent:PreviewIntent) {
    const current=this.currentPreview(intent);
    if(this.previewOwner===intent.owner)this.previewBusy=false;
    if(current)wx.showToast({title:"图片暂时无法打开，请重试",icon:"none"});
  },
  async previewMedia(event: WechatMiniprogram.TouchEvent) {
    if(!this.readVisible||!this.data.pageAlive||this.data.leaving||this.previewBusy)return;
    const current = String(event.currentTarget.dataset.src ?? "");
    const selected = this.data.media.indexOf(current);
    if (selected < 0) return;
    if(this.data.editorialSource&&(!this.currentImageEvent(event)||(this.galleryTouch?.identity===this.data.imageEventId&&this.galleryTouch.moved)))return;
    this.previewBusy=true;
    const intent:PreviewIntent={owner:++this.previewOwner,attempt:this.data.loadAttempt,ownerToken:getApp<IAppOption>().globalData.sessionToken,
      id:this.data.id,version:this.data.item?.version,media:[...this.data.media],imageIdentity:this.data.imageEventId,read:this.galleryRead};
    try {
      const urls = await Promise.all(intent.media.map((src) => new Promise<string>((resolve, reject) => {
        if (!src.startsWith("/assets/")) { resolve(src); return; }
        const destination = `${wx.env.USER_DATA_PATH}/preview-${src.split("/").pop()}`;
        wx.getFileSystemManager().copyFile({ srcPath: src, destPath: destination, success: () => resolve(destination), fail: reject });
      })));
      if(!this.currentPreview(intent)){if(this.previewOwner===intent.owner)this.previewBusy=false;return;}
      const selectedUrl=urls[selected];if(!selectedUrl){this.failPreview(intent);return;}
      wx.previewImage({current:selectedUrl,urls,success:()=>{if(this.previewOwner===intent.owner)this.previewBusy=false;},fail:()=>this.failPreview(intent)});
    } catch {
      this.failPreview(intent);
    }
  },
  async prepareShare(loadAttempt?: number) {
    if(this.data.editorialSource)return;
    const attempt = loadAttempt ?? this.data.loadAttempt;
    const shareId = await prepareShareLink("post", this.data.id);
    if (this.data.pageAlive && this.data.loadAttempt === attempt && this.data.item) this.setData({ shareId });
  },
  back() {
    if (!this.data.pageAlive || this.data.leaving) return;
    this.setData({ leaving: true });
    wx.navigateBack({ fail: () => {
      if (!this.data.pageAlive) return;
      wx.switchTab({ url: "/pages/community/index", fail: () => {
        if (!this.data.pageAlive) return;
        this.setData({ leaving: false });
        wx.showToast({ title: "暂时无法返回，请重试", icon: "none" });
      } });
    } });
  },
  backToCommunity() {
    if(!this.readVisible||!this.data.pageAlive||this.data.leaving)return;
    this.setData({leaving:true});
    wx.switchTab({url:"/pages/community/index",fail:()=>{
      if(!this.readVisible||!this.data.pageAlive)return;
      this.setData({leaving:false});
      wx.showToast({title:"暂时无法返回社区，请重试",icon:"none"});
    }});
  },
  onShareAppMessage() { return this.data.item
    ? { title: this.data.item.title, path: `/pages/post/index?id=${encodeURIComponent(this.data.id)}${this.data.editorialSource?"&source=editorial":this.data.shareId ? `&share_id=${this.data.shareId}` : ""}` }
    : { title: "CISME 社区", path: "/pages/community/index" }; }
});
