import { defaultMemberAvatar, prepareFeedAuthors } from "../../services/member-avatar";
import { clearAuthenticationRedirectSuppression, request, resumeAuthentication, beginLegalRenewal } from "../../services/api";
import { cancelPageReads } from "../../services/page-requests";
import { editorialPreviewAllowed, editorialStory, isBundledEditorialId, editorialIdentifier, editorialMediaSrc, publishedEditorialArticle, reactToEditorialArticle, followEditorialArticle, expiredEditorialRead } from "../../services/editorial";
import { currentChromeStyle, motionDuration } from "../../services/layout";
import { prepareShareLink, registerIncomingShare } from "../../services/share";

import { commentThreads, emptyCommunity, prepareCommentAuthors, type CommunityView } from "../../services/community";

Page({
  readVisible:true,
  data: { editorialSource:false,following: false, followBusy: false, followError: "", authorId: "", previewRuntime: editorialPreviewAllowed(), socialEnabled: false, socialLoading: false, socialError: "", socialBusy: false, social: emptyCommunity, threads: [] as ReturnType<typeof commentThreads>, expandedThreads: [] as string[], draft: "", draftOperation: "", replyToId: "", replyToName: "", composerFocused: false, keyboardHeight: 0, chromeStyle: currentChromeStyle(), id: "", item: null as any, media: [] as string[], mediaIndex: 0, mediaError:"",galleryHeight: 1000, shareId: "", loading: true, loadAttempt: 0, pageAlive: true, leaving: false, errorKind: "none" as "none" | "missing" | "load", errorTitle: "", error: "" },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onLoad(query: Record<string, string | undefined>) {
    const id = query.id ?? "";
    this.setData({ id, editorialSource:query.source==="editorial", pageAlive: true });
    if (query.source!=="editorial"&&(!isBundledEditorialId(id) || editorialPreviewAllowed())) void registerIncomingShare(query.share_id, "post", id);
    wx.hideShareMenu();
  },
  onShow() { this.readVisible=true;this.setData({ pageAlive: true, leaving: false }); void this.load(); },
  onHide() { this.readVisible=false;cancelPageReads(this);this.data.loadAttempt += 1; this.setData({ composerFocused: false, keyboardHeight: 0 }); },
  onUnload() { this.readVisible=false;cancelPageReads(this);this.data.pageAlive = false; this.data.loadAttempt += 1; },
  currentEditorial(attempt:number,token:string){return this.readVisible&&this.data.pageAlive&&this.data.loadAttempt===attempt&&token===getApp<IAppOption>().globalData.sessionToken;},
  recoverExpiredEditorialRead(attempt:number,token:string,error:unknown){
    if(!this.readVisible||!this.data.pageAlive||this.data.leaving||attempt!==this.data.loadAttempt||!expiredEditorialRead(error,token))return false;
    this.data.loadAttempt+=1;
    this.setData({loading:false,item:null,authorId:"",media:[],mediaIndex:0,mediaError:"",shareId:"",socialEnabled:false,socialLoading:false,socialBusy:false,
      social:emptyCommunity,threads:[],following:false,followBusy:false,followError:"",socialError:"",draft:"",replyToId:"",replyToName:"",
      errorKind:"load",errorTitle:"登录状态已失效",error:"请重新加载内容。点赞、收藏和关注前，请重新登录。"});
    wx.hideShareMenu();return true;
  },
  editorialReturnUrl(){return `/pages/post/index?id=${encodeURIComponent(this.data.id)}&source=editorial`;},
  async load() {
    const attempt = this.data.loadAttempt + 1;
    wx.hideShareMenu();
    this.setData({ loadAttempt: attempt, socialEnabled: false, socialBusy: false, socialLoading: false, social: emptyCommunity, threads: [], following: false, followBusy:false,followError: "", item: null, media: [], mediaIndex: 0, mediaError:"",shareId: "", loading: true, errorKind: "none", errorTitle: "", error: "" });
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
          this.setData({authorId:article.authorId,item:{...article,kind:"editorial",avatar:defaultMemberAvatar,
            publishedLabel:new Date(article.publishedAt).toLocaleDateString("zh-CN"),engagementLabel:"精选内容"},
            media:article.media.map(item=>editorialMediaSrc(item.url)).filter(Boolean),following:article.following,
            socialEnabled:article.interactionsEnabled===true,social:{...emptyCommunity,preview:false,liked:article.liked,saved:article.saved,likeCount:article.likeCount,saveCount:article.saveCount},loading:false});
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
      this.setData({followBusy:true,followError:""});
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
    if(this.data.editorialSource){await this.load();return;}
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
    this.setData({socialBusy:true,socialError:""});
    try{const result=await reactToEditorialArticle(this.data.id,kind,!(kind==="like"?this.data.social.liked:this.data.social.saved));
      if(this.currentEditorial(attempt,token))this.setData({social:{...this.data.social,liked:result.liked,saved:result.saved,likeCount:result.likeCount,saveCount:result.saveCount}});
    }catch(error){if(this.currentEditorial(attempt,token)){
      if((error as {status?:number;code?:string}).status===409&&(error as {code?:string}).code==="CURRENT_LEGAL_CONSENT_REQUIRED")beginLegalRenewal(this.editorialReturnUrl());
      this.setData({socialError:(error as {title?:string}).title||"互动结果尚未确认，请先重新加载查看，再决定是否重试。"});}}
    finally{if(this.currentEditorial(attempt,token))this.setData({socialBusy:false});}
  },
  toggleLike() { if(this.data.editorialSource)return this.mutateEditorialReaction("like");return this.mutateSocial("/reaction", "PUT", { kind: "like", active: !this.data.social.liked }); },
  toggleSave() { if(this.data.editorialSource)return this.mutateEditorialReaction("save");return this.mutateSocial("/reaction", "PUT", { kind: "save", active: !this.data.social.saved }); },
  openAuthor(){if(!this.data.editorialSource||!this.data.pageAlive||!editorialIdentifier(this.data.authorId)||this.data.leaving)return;this.setData({leaving:true});wx.navigateTo({url:`/pages/community-author/index?id=${encodeURIComponent(this.data.authorId)}&source=editorial`,fail:()=>{this.setData({leaving:false});wx.showToast({title:"作者资料暂时无法打开",icon:"none"});}});},
  copySource(){const url=this.data.editorialSource&&this.data.item?.sourceUrl;if(typeof url==="string"&&/^https:\/\//.test(url))wx.setClipboardData({data:url});},
  showComments() { wx.pageScrollTo({ selector: "#post-comments", duration: motionDuration(250) }); },
  focusComment() { this.setData({ composerFocused: true }); },
  blurComment() { this.setData({ composerFocused: false, keyboardHeight: 0 }); },
  keyboardChanged(event: WechatMiniprogram.CustomEvent) { this.setData({ keyboardHeight: Math.max(0, Number(event.detail.height) || 0) }); },
  inputComment(event: WechatMiniprogram.CustomEvent) { this.setData({ draft: String(event.detail.value ?? ""), draftOperation: "" }); },
  replyComment(event: WechatMiniprogram.TouchEvent) {
    const comment = this.data.social.comments.find(item => item.id === event.currentTarget.dataset.id);
    if (!comment || comment.status !== "published") return;
    this.setData({ replyToId: comment.id, replyToName: comment.authorName, draftOperation: "", composerFocused: true });
  },
  cancelReply() { this.setData({ replyToId: "", replyToName: "", draftOperation: "" }); },
  expandReplies(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id ?? "");
    const expanded = this.data.expandedThreads.includes(id) ? this.data.expandedThreads.filter(value => value !== id) : [...this.data.expandedThreads, id];
    this.setData({ expandedThreads: expanded, threads: commentThreads(this.data.social.comments, expanded) });
  },
  likeComment(event: WechatMiniprogram.TouchEvent) {
    const comment = this.data.social.comments.find(item => item.id === event.currentTarget.dataset.id);
    if (comment?.status === "published") void this.mutateSocial(`/comments/${comment.id}/like`, "PUT", { active: !comment.liked });
  },
  deleteComment(event: WechatMiniprogram.TouchEvent) {
    const comment = this.data.social.comments.find(item => item.id === event.currentTarget.dataset.id);
    if (comment?.isMine && comment.status !== "deleted") void this.mutateSocial(`/comments/${comment.id}`, "DELETE", {});
  },
  async sendComment() {
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
  mediaFailed(event:WechatMiniprogram.CustomEvent){const src=String(event.currentTarget.dataset.src||"");if(this.data.editorialSource&&this.data.media.includes(src))this.setData({mediaError:"图片加载失败，请重新加载。"});},
  mediaLoaded(event: WechatMiniprogram.CustomEvent) {
    if (Number(event.currentTarget.dataset.index) !== 0) return;
    const ratio = Math.min(16 / 9, Math.max(3 / 4, Number(event.detail.width) / Math.max(1, Number(event.detail.height))));
    if (Number.isFinite(ratio)) this.setData({ galleryHeight: 750 / ratio });
  },
  onMediaChange(event: WechatMiniprogram.CustomEvent) {
    this.setData({ mediaIndex: Number(event.detail.current) || 0 });
  },
  async previewMedia(event: WechatMiniprogram.TouchEvent) {
    const current = String(event.currentTarget.dataset.src ?? "");
    const selected = this.data.media.indexOf(current);
    if (selected < 0) return;
    const attempt = this.data.loadAttempt;
    try {
      const urls = await Promise.all(this.data.media.map((src) => new Promise<string>((resolve, reject) => {
        if (!src.startsWith("/assets/")) { resolve(src); return; }
        const destination = `${wx.env.USER_DATA_PATH}/preview-${src.split("/").pop()}`;
        wx.getFileSystemManager().copyFile({ srcPath: src, destPath: destination, success: () => resolve(destination), fail: reject });
      })));
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return;
      const selectedUrl=urls[selected];if(!selectedUrl)return;
      wx.previewImage({ current: selectedUrl, urls, fail: () => wx.showToast({ title: "图片暂时无法打开，请重试", icon: "none" }) });
    } catch {
      if (this.data.pageAlive && this.data.loadAttempt === attempt) wx.showToast({ title: "图片暂时无法打开，请重试", icon: "none" });
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
  onShareAppMessage() { return this.data.item
    ? { title: this.data.item.title, path: `/pages/post/index?id=${encodeURIComponent(this.data.id)}${this.data.editorialSource?"&source=editorial":this.data.shareId ? `&share_id=${this.data.shareId}` : ""}` }
    : { title: "CISME 社区", path: "/pages/community/index" }; }
});
