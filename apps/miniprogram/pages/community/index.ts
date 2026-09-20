import { projectFeedCards, feedColumnPatch } from "../../services/feed-projection";
import { measurementClock, recordClientMetric } from "../../services/performance-metrics";
import { pageRead, cancelPageReads } from "../../services/page-requests";
import { defaultMemberAvatar, localMemberAvatar, prepareFeedAuthors, prepareFeedPage } from "../../services/member-avatar";
import { request, resumeAuthentication } from "../../services/api";
import { editorialStories } from "../../services/editorial";
import { currentChromeStyle } from "../../services/layout";
import { memberIdentity } from "../../services/member-identity";
import { consumerTaskEntries } from "../../services/task-entry";

const feedModels = new WeakMap<object, { feed: any[]; following: any[] }>();
function feedModel(page: object) {
  let model = feedModels.get(page);
  if (!model) { model = { feed: [], following: [] }; feedModels.set(page, model); }
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
  data: { mode: "featured", ugcFeedEnabled: false, socialPreviewEnabled: false, canReview: false, signedIn: false, follows: [] as string[], reviewQueue: [] as any[], publicationQueue: [] as any[], profileReviewQueue: [] as any[], formalReviewQueue: [] as any[], formalReportQueue:[] as any[],reportNextCursor:null as string|null,reportTotal:0,reportLoadingMore:false,formalAppealQueue:[] as any[],appealNextCursor:null as string|null,appealTotal:0,appealLoadingMore:false,reviewActorId:"",reviewBusy: false, teamError: "", reviewNotice:"",formalNextCursor: null as string|null, followingNextCursor:null as string|null, formalLoadingMore:false, moreError:"", searchInput:"", appliedSearch:"", displayFeedCount: editorialStories.length, feedColumns: projectFeedCards(editorialStories), hero: editorialStories[0], tasks: [] as any[], tasksLoading: false, tasksError: "", feedAttempt: 0, tasksAttempt: 0, chromeStyle: currentChromeStyle(), chromeHidden: false, loading: true, navigating: false, error: "" },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onShow() {
    this.resetChromeMotion();
    this.setData({ navigating: false, chromeHidden: false, signedIn: Boolean(getApp<IAppOption>().globalData.sessionToken) });
    const tab = this.getTabBar?.();
    if (tab) tab.setData({ active: 2, externalBusy: false });
    tab?.syncActive?.(2);
    tab?.setPresentation?.("community-scroll", false);
    tab?.enterCommunityFab?.();
    void this.load();
  },
  onHide() {
    cancelPageReads(this);
    this.data.feedAttempt += 1;
    this.data.tasksAttempt += 1;
    this.resetChromeMotion();
    const tab = this.getTabBar?.();
    tab?.setPresentation?.("community-scroll", false);
    tab?.leaveCommunityFab?.();
    this.setData({ chromeHidden: false, canReview: false, reviewQueue: [], publicationQueue: [], profileReviewQueue: [], formalReviewQueue: [],formalReportQueue:[],reportNextCursor:null,reportTotal:0,formalAppealQueue:[],appealNextCursor:null,appealTotal:0,reviewActorId:"",reviewNotice:"" });
  },
  onUnload() {
    cancelPageReads(this); feedModels.delete(this);
    this.data.feedAttempt += 1;
    this.data.tasksAttempt += 1;
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
    if (this.data.navigating) return;
    if (!getApp<IAppOption>().globalData.sessionToken) { resumeAuthentication("/pages/community/index"); return; }
    this.setData({ navigating: true });
    wx.navigateTo({ url: "/pages/community-compose/index?new=1", fail: () => { this.setData({ navigating: false }); wx.showToast({ title: "创作页暂时无法打开", icon: "none" }); } });
  },
  openMyPosts() {
    if (this.data.navigating) return;
    if (!getApp<IAppOption>().globalData.sessionToken) { resumeAuthentication("/pages/community/index"); return; }
    this.setData({ navigating: true });
    wx.navigateTo({ url: "/pages/community-compose/index", fail: () => { this.setData({ navigating: false }); wx.showToast({ title: "我的内容暂时无法打开", icon: "none" }); } });
  },
  onSearchInput(event:{detail:{value:string}}){this.setData({searchInput:event.detail.value});},
  submitSearch(){
    const next=this.data.searchInput.trim();
    if(this.data.loading)return;
    this.setData({appliedSearch:next,mode:"recommend"});
    void this.load();
  },
  clearSearch(){
    this.setData({searchInput:"",appliedSearch:"",mode:"recommend"});
    void this.load();
  },
  async onReachBottom(){
    if(this.data.mode==="review"){if(this.data.reportNextCursor)await this.loadMoreReports();else await this.loadMoreAppeals();return;}
    const mode=this.data.mode,cursor=mode==="following"?this.data.followingNextCursor:this.data.formalNextCursor,
      attempt=this.data.feedAttempt;
    if(!cursor||this.data.formalLoadingMore||this.data.loading||!["recommend","following"].includes(mode)||!this.data.ugcFeedEnabled)return;
    const token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({formalLoadingMore:true,moreError:""});
    try{
      const q=mode==="recommend"&&this.data.appliedSearch?`&q=${encodeURIComponent(this.data.appliedSearch)}`:"";
      const following=mode==="following"?"&following=1":"";
      const page=await pageRead<{items:any[];nextCursor:string|null}>(this, {path:`/v1/ugc/posts?limit=30&cursor=${encodeURIComponent(cursor)}${q}${following}`,
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
  async selectMode(event: WechatMiniprogram.TouchEvent) {
    const mode = String(event.currentTarget.dataset.mode);
    if (!["featured", "recommend", "following", "review"].includes(mode) || (mode === "review" && !this.data.canReview)) return;
    if (mode === "recommend" && !this.data.ugcFeedEnabled && !this.data.socialPreviewEnabled) return;
    if (mode === "following" && !this.data.socialPreviewEnabled && !this.data.ugcFeedEnabled) return;
    if ((mode === "following" || mode === "review") && !getApp<IAppOption>().globalData.sessionToken) { resumeAuthentication(); return; }
    if (this.data.loading) return;
    cancelPageReads(this);
    this.data.feedAttempt += 1; // A → B → A must not revive an older pagination result.
    this.setData({ mode, formalLoadingMore:false, moreError:"" });
    if (mode === "review") await this.loadReview();
    else if (mode === "following") await this.loadFollowing();
    else this.renderFeed();
  },
  renderFeed() {
    const processingStarted = measurementClock();
    const model = feedModel(this);
    const reviewed = (this.data.mode === "following" ? model.following : model.feed).map((item: any) => item.kind === "formal"
      ? { ...item, avatar: item.avatar || defaultMemberAvatar, author: item.author || "CISME 会员", engagementLabel: `${item.likeCount || 0} 赞` }
      : { ...item, kind: "ugc", image: item.image || "", avatar: item.avatar || defaultMemberAvatar, author: item.author || "CISME 会员", engagementLabel: "" });
    const featured = editorialStories.map(item => ({ ...item, author_id: "brand:cisme" }));
    let items = this.data.mode === "featured" ? featured : this.data.mode === "recommend" ? reviewed : reviewed.concat(featured);
    if (this.data.mode === "following") items = items.filter(item => item.kind==="formal"||this.data.follows.includes(item.author_id));
    const patch = feedColumnPatch(this.data.feedColumns, projectFeedCards(items));
    if (items.length !== this.data.displayFeedCount) patch.displayFeedCount = items.length;
    recordClientMetric({ action: "feed", stage: "data_processing", durationMs: measurementClock() - processingStarted });
    if (Object.keys(patch).length) {
      const bridgeStarted = measurementClock(), attempt = this.data.feedAttempt;
      this.setData(patch, () => { if (attempt === this.data.feedAttempt) recordClientMetric({ action: "feed", stage: "set_data", durationMs: measurementClock() - bridgeStarted }); });
    }
  },
  async loadFollowing() {
    const attempt = this.data.feedAttempt;
    const token = getApp<IAppOption>().globalData.sessionToken;
    feedModel(this).following = [];
    this.setData({ followingNextCursor:null,loading: true, error: "" });
    this.renderFeed();
    try {
      const [formalOutcome,previewOutcome]=await Promise.all([
        this.data.ugcFeedEnabled?request<{items:any[];nextCursor:string|null}>({path:"/v1/ugc/posts?following=1&limit=30"})
          .then(page=>({page}),error=>({error})):Promise.resolve({page:{items:[],nextCursor:null}}),
        this.data.socialPreviewEnabled?request<{items:any[];authors?:Record<string,any>}>({path:"/v1/me/following/page?limit=30"})
          .then(page=>({page}),error=>({error})):Promise.resolve({page:{items:[]}})
      ]);
      if (attempt !== this.data.feedAttempt || token !== getApp<IAppOption>().globalData.sessionToken||this.data.mode!=="following") return;
      if("error" in formalOutcome&&"error" in previewOutcome)throw formalOutcome.error;
      const origin=getApp<IAppOption>().globalData.apiBaseUrl.replace(/\/$/,"");
      const formal="page" in formalOutcome?formalOutcome.page.items.map(item=>({...item,kind:"formal",author_id:item.authorId,
        image:item.coverId&&origin?`${origin}/v1/ugc/media/${item.coverId}?variant=thumbnail`:""})):[];
      const preview="page" in previewOutcome?await prepareFeedPage(previewOutcome.page):[];
      if(attempt!==this.data.feedAttempt||token!==getApp<IAppOption>().globalData.sessionToken||this.data.mode!=="following")return;
      feedModel(this).following = [...formal, ...preview];
      this.setData({followingNextCursor:"page" in formalOutcome?formalOutcome.page.nextCursor:null});
      this.renderFeed();
    } catch { if (attempt === this.data.feedAttempt && token === getApp<IAppOption>().globalData.sessionToken) this.setData({ error: "关注内容未同步，请重试。" }); }
    finally { if (attempt === this.data.feedAttempt && token === getApp<IAppOption>().globalData.sessionToken) this.setData({loading:false}); }
  },
  async loadReview() {
    if (!this.data.canReview) return;
    const token = getApp<IAppOption>().globalData.sessionToken;
    const attempt = this.data.feedAttempt;
    this.setData({ reviewQueue: [], publicationQueue: [], profileReviewQueue: [], formalReviewQueue: [],formalReportQueue:[],reportNextCursor:null,reportTotal:0,formalAppealQueue:[],appealNextCursor:null,appealTotal:0,reviewActorId:memberIdentity()?.id||"", teamError: "", reviewBusy: true });
    try {
      const [reviewQueue, publicationQueue, profiles, formal,reports,appeals] = await Promise.all([request<any[]>({ path: "/v1/team/reviews" }), request<any[]>({ path: "/v1/team/publications" }), request<any[]>({ path: "/v1/team/member-profiles" }), request<{items:any[]}>({path:"/v1/management/ugc/review-queue"}),request<{items:any[];nextCursor:string|null;matchingTotal:number}>({path:"/v1/management/ugc/reports?limit=30"}),request<{items:any[];nextCursor:string|null;matchingTotal:number}>({path:"/v1/management/ugc/appeals?limit=30"})]);
      const profileReviewQueue=await Promise.all(profiles.map(async row=>{const {avatar_data_url,...safe}=row;return {...safe,avatar:await localMemberAvatar(avatar_data_url,row.avatar_revision)};}));
      if (attempt !== this.data.feedAttempt || token !== getApp<IAppOption>().globalData.sessionToken) return;
      this.setData({ reviewQueue, publicationQueue, profileReviewQueue, formalReviewQueue: formal.items,
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
      fail:()=>{this.setData({navigating:false});wx.showToast({title:"对象当前不可见，请核对举报摘要",icon:"none"});}});
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
  openFormalReview(event: WechatMiniprogram.TouchEvent) {
    if (this.data.navigating || !this.data.canReview) return;
    const id = String(event.currentTarget.dataset.id || ""); if (!id) return;
    this.setData({ navigating: true });
    wx.navigateTo({ url: `/pages/community-review/index?id=${encodeURIComponent(id)}`,
      fail: () => { this.setData({ navigating: false }); wx.showToast({ title: "审核页暂时无法打开", icon: "none" }); } });
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
  async reviewSubmission(event: WechatMiniprogram.TouchEvent) {
    if (this.data.reviewBusy || !this.data.canReview) return;
    const item = this.data.reviewQueue.find(item => item.id === event.currentTarget.dataset.id);
    if (!item) return;
    const decision = String(event.currentTarget.dataset.decision);
    if (!["approve", "request_changes", "reject"].includes(decision)) return;
    const token = getApp<IAppOption>().globalData.sessionToken;
    const attempt = this.data.feedAttempt;
    this.setData({ reviewBusy: true, teamError: "" });
    try {
      const result = await wx.showModal({ title: decision === "approve" ? "确认投稿审核通过" : "填写审核意见", editable: true, placeholderText: "请填写已核实的事实与审核理由", confirmText: "提交审核" });
      if (!result.confirm || token !== getApp<IAppOption>().globalData.sessionToken || attempt !== this.data.feedAttempt) return;
      const reason = result.content?.trim() || "";
      if (reason.length < 4) { this.setData({ teamError: "请输入至少 4 个字的审核依据" }); return; }
      await request({ path: `/v1/team/submissions/${item.id}/review`, method: "POST", idempotencyKey: `native-review-${item.id}-${item.version}-${decision}`, data: { decision, reasonCode: reason, evidence: { note: reason }, expectedVersion: item.version } });
      if (token === getApp<IAppOption>().globalData.sessionToken && attempt === this.data.feedAttempt) await this.loadReview();
    } catch (error) { if (token === getApp<IAppOption>().globalData.sessionToken && attempt === this.data.feedAttempt) this.setData({ teamError: (error as {title?:string}).title || "审核未确认，请刷新核对后重试" }); }
    finally { if (token === getApp<IAppOption>().globalData.sessionToken && attempt === this.data.feedAttempt) this.setData({ reviewBusy: false }); }
  },
  copyPostUrl(event: WechatMiniprogram.TouchEvent) { const url = String(event.currentTarget.dataset.url || ""); if (url) wx.setClipboardData({ data: url }); },
  async publishSubmission(event: WechatMiniprogram.TouchEvent) {
    if (this.data.reviewBusy || !this.data.canReview) return;
    const item = this.data.publicationQueue.find(item => item.id === event.currentTarget.dataset.id);
    if (!item || !item.publication_enabled || item.visible || item.publication_queued) return;
    const token = getApp<IAppOption>().globalData.sessionToken;
    const attempt = this.data.feedAttempt;
    const current = () => token === getApp<IAppOption>().globalData.sessionToken && attempt === this.data.feedAttempt;
    this.setData({ reviewBusy: true, teamError: "" });
    try {
      const title = await wx.showModal({ title: "推荐流标题", editable: true, placeholderText: "输入审核后的标题（最多 60 字）" });
      if (!title.confirm || !current()) return;
      const excerpt = await wx.showModal({ title: "推荐流摘要", editable: true, placeholderText: "输入审核后的摘要（最多 240 字）" });
      if (!excerpt.confirm || !current()) return;
      const reason = await wx.showModal({ title: "发布复核依据", editable: true, placeholderText: "确认内容与公开展示许可后填写依据" });
      if (!reason.confirm || !current()) return;
      const ai = await wx.showActionSheet({ itemList: ["无 AI 使用", "AI 辅助", "AI 生成", "尚不明确"] });
      if (!current()) return;
      await request({ path: `/v1/team/submissions/${item.id}/publish`, method: "POST", idempotencyKey: `native-publish-${item.id}-${Date.now()}`, data: { title: title.content || "", excerpt: excerpt.content || "", aiUsage: ["none","assisted","generated","unknown"][ai.tapIndex], reasonCode: reason.content || "", evidence: { note: reason.content || "" } } });
      if (current()) await this.loadReview();
    } catch (error) { if (current() && !/cancel/i.test((error as {errMsg?:string}).errMsg || "")) this.setData({ teamError: (error as {title?:string}).title || "发布未确认，请刷新核对后重试" }); }
    finally { if (current()) this.setData({ reviewBusy: false }); }
  },
  async load() {
    cancelPageReads(this);
    const session = getApp<IAppOption>().globalData.sessionToken;
    feedModel(this).following = [];
    const attempt = this.data.feedAttempt + 1;
    const privateMode=this.data.mode==="following"||this.data.mode==="review";
    this.setData({ feedAttempt: attempt, loading: true, formalNextCursor:null, followingNextCursor:null,
      follows:[],canReview:false,reviewQueue:[],publicationQueue:[],profileReviewQueue:[],formalReviewQueue:[],
      formalLoadingMore:false, moreError:"", reviewBusy: false, teamError: "", error: "",
      ...(privateMode?{feedColumns:[[],[]] as [any[],any[]],displayFeedCount:0}:{}) });
    const tasksPromise = this.loadTasks();
    const capabilityPromise = Promise.all([request<{ communityPreviewEnabled?: boolean }>({ path: "/v1/capabilities", authMode: "public" }),
      request<{ publicEnabled?: boolean }>({ path: "/v1/ugc/status", authMode: "public" })])
      .then(([health,ugc]) => ({ ugcFeedEnabled: ugc.publicEnabled === true, socialPreviewEnabled: health.communityPreviewEnabled === true }))
      .catch(() => ({ ugcFeedEnabled: false, socialPreviewEnabled: false }));
    const feedPromise = request<{items:any[];authors?:Record<string,any>}>({ path: "/v1/feed/page?limit=30", authMode: "public" }).then(feed => ({ feed }), error => ({ error }));
    const formalQuery=this.data.appliedSearch?`&q=${encodeURIComponent(this.data.appliedSearch)}`:"";
    const formalPromise = request<{items:any[];nextCursor:string|null}>({ path: `/v1/ugc/posts?limit=30${formalQuery}`, authMode: getApp<IAppOption>().globalData.sessionToken ? "optional" : "public" })
      .then(feed => ({ feed }), error => ({ error }));
    this.setData({ canReview: false, follows: [], reviewQueue: [], publicationQueue: [], profileReviewQueue: [], formalReviewQueue: [] });
    const capabilities = await capabilityPromise;
    if (this.data.feedAttempt !== attempt || session !== getApp<IAppOption>().globalData.sessionToken) return;
    const availableMode = this.data.mode === "recommend" && !capabilities.ugcFeedEnabled && !capabilities.socialPreviewEnabled
      || this.data.mode === "following" && !capabilities.socialPreviewEnabled && !capabilities.ugcFeedEnabled
      ? "featured"
      : this.data.mode;
    this.setData({ ...capabilities, mode: availableMode });
    const token = getApp<IAppOption>().globalData.sessionToken;
    if (token) {
      try {
        const [access, follows] = await Promise.all([
          request<{canReview:boolean}>({ path: "/v1/me/community-access", authMode: "optional" }),
          capabilities.socialPreviewEnabled ? request<string[]>({ path: "/v1/me/follows", authMode: "optional" }) : Promise.resolve([])
        ]);
        if (this.data.feedAttempt !== attempt || token !== getApp<IAppOption>().globalData.sessionToken) return;
        this.setData({ canReview: access.canReview === true, follows, mode: this.data.mode === "review" && !access.canReview ? "featured" : this.data.mode });
      } catch { if (this.data.feedAttempt === attempt && token === getApp<IAppOption>().globalData.sessionToken) this.setData({ canReview: false, mode: "featured" }); }
    } else this.setData({ mode: "featured" });
    try {
      const [outcome,formalOutcome] = await Promise.all([feedPromise,formalPromise]);
      if ("error" in outcome && "error" in formalOutcome) throw outcome.error;
      const preview = !this.data.appliedSearch && "feed" in outcome ? await prepareFeedPage(outcome.feed) : [];
      const origin = getApp<IAppOption>().globalData.apiBaseUrl.replace(/\/$/, "");
      const formal = "feed" in formalOutcome ? formalOutcome.feed.items.map(item => ({ ...item, kind: "formal", author_id: item.authorId,
        image: item.coverId && origin ? `${origin}/v1/ugc/media/${item.coverId}?variant=thumbnail` : "" })) : [];
      const feed = [...formal, ...preview];
      if (this.data.feedAttempt !== attempt || session !== getApp<IAppOption>().globalData.sessionToken) return;
      // Post covers still require their own authorized media path; author
      // identities come only from the server public-profile allowlist.
      feedModel(this).feed = feed;
      this.setData({ formalNextCursor:"feed" in formalOutcome?formalOutcome.feed.nextCursor:null, error: "" });
      this.renderFeed();
      if (this.data.mode === "review") await this.loadReview();
      else if (this.data.mode === "following") await this.loadFollowing();
    } catch (error) {
      if (this.data.feedAttempt === attempt && session === getApp<IAppOption>().globalData.sessionToken) { feedModel(this).feed = []; this.setData({ error: "社区内容暂时无法加载，请重试；精选护理故事仍可浏览。" }); this.renderFeed(); }
    } finally {
      if (this.data.feedAttempt === attempt && session === getApp<IAppOption>().globalData.sessionToken) this.setData({ loading: false });
      await tasksPromise;
    }
  },
  async loadTasks() {
    if (!getApp<IAppOption>().globalData.sessionToken) {
      this.data.tasksAttempt += 1;
      this.setData({ tasks: [], tasksLoading: false, tasksError: "" });
      return;
    }
    const token = getApp<IAppOption>().globalData.sessionToken;
    const attempt = this.data.tasksAttempt + 1;
    this.setData({ tasksAttempt: attempt, tasks: [], tasksLoading: true, tasksError: "" });
    try {
      const taskHistory = await request<any[]>({ path: "/v1/me/tasks", authMode: "optional" });
      if (this.data.tasksAttempt !== attempt || token !== getApp<IAppOption>().globalData.sessionToken) return;
      const tasks = consumerTaskEntries(taskHistory);
      this.setData({ tasks, tasksError: "" });
    } catch (error) {
      if (this.data.tasksAttempt === attempt && token === getApp<IAppOption>().globalData.sessionToken) this.setData({ tasks: [], tasksError: "活动暂未加载，请重试" });
    } finally {
      if (this.data.tasksAttempt === attempt && token === getApp<IAppOption>().globalData.sessionToken) this.setData({ tasksLoading: false });
    }
  },
  openPost(event: WechatMiniprogram.TouchEvent) {
    if (this.data.navigating) return;
    const id = String(event.currentTarget.dataset.id ?? "");
    if (!id) { wx.showToast({ title: "内容编号缺失，请刷新后重试", icon: "none" }); return; }
    this.setData({ navigating: true });
    const tab = this.getTabBar?.(); if (tab) tab.setData({ externalBusy: true });
    const item = this.data.feedColumns.flat().find((entry: any) => entry.id === id);
    const route = item?.kind === "formal" ? "/pages/community-post/index" : "/pages/post/index";
    wx.navigateTo({ url: `${route}?id=${encodeURIComponent(id)}`, fail: () => { this.setData({ navigating: false }); const currentTab = this.getTabBar?.(); if (currentTab) currentTab.setData({ externalBusy: false }); wx.showToast({ title: "护理故事暂时无法打开", icon: "none" }); } });
  },
  openInvite(event: WechatMiniprogram.TouchEvent) {
    if (this.data.tasksLoading || this.data.navigating) return;
    const id = String(event.currentTarget.dataset.id ?? "");
    const task = this.data.tasks.find((entry) => entry.id === id);
    if (!task) {
      this.setData({ tasksError: "邀请状态已更新，正在重新核验。" });
      wx.showToast({ title: "邀请状态已更新，请重试", icon: "none" });
      void this.loadTasks();
      return;
    }
    this.setData({ navigating: true });
    const tab = this.getTabBar?.(); if (tab) tab.setData({ externalBusy: true });
    wx.navigateTo({ url: `/pages/task/index?id=${task.id}`, fail: () => { this.setData({ navigating: false }); const currentTab = this.getTabBar?.(); if (currentTab) currentTab.setData({ externalBusy: false }); wx.showToast({ title: "投稿与邀请暂时无法打开", icon: "none" }); } });
  }
});
