import { defaultMemberAvatar, localMemberAvatar, prepareFeedAuthors, prepareFeedPage } from "../../services/member-avatar";
import { request, resumeAuthentication } from "../../services/api";
import { editorialStories } from "../../services/editorial";
import { currentChromeStyle } from "../../services/layout";
import { consumerTaskEntries } from "../../services/task-entry";

const feedColumns = (items: any[]) => items.reduce<[any[], any[]]>((columns, item, index) => {
  columns[index % 2]!.push({ ...item, compactImage: index % 3 === 1 });
  return columns;
}, [[], []]);
const chromeHideTravel = 24;
const chromeRevealTravel = 8;
const chromeRecoveryMs = 180;
let chromeRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let lastScrollTop = 0;
let scrollPrimed = false;
let scrollDirection: -1 | 0 | 1 = 0;
let scrollTravel = 0;

Page({
  data: { mode: "featured", ugcFeedEnabled: false, socialPreviewEnabled: false, canReview: false, signedIn: false, follows: [] as string[], followingFeed: [] as any[], reviewQueue: [] as any[], publicationQueue: [] as any[], profileReviewQueue: [] as any[], formalReviewQueue: [] as any[], reviewBusy: false, teamError: "", feed: [] as any[], formalNextCursor: null as string|null, formalLoadingMore:false, searchInput:"", appliedSearch:"", displayFeedCount: editorialStories.length, feedColumns: feedColumns(editorialStories), hero: editorialStories[0], tasks: [] as any[], tasksLoading: false, tasksError: "", feedAttempt: 0, tasksAttempt: 0, chromeStyle: currentChromeStyle(), chromeHidden: false, loading: true, navigating: false, error: "" },
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
    this.data.feedAttempt += 1;
    this.data.tasksAttempt += 1;
    this.resetChromeMotion();
    const tab = this.getTabBar?.();
    tab?.setPresentation?.("community-scroll", false);
    tab?.leaveCommunityFab?.();
    this.setData({ chromeHidden: false, canReview: false, reviewQueue: [], publicationQueue: [], profileReviewQueue: [], formalReviewQueue: [] });
  },
  onUnload() {
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
    const cursor=this.data.formalNextCursor,attempt=this.data.feedAttempt;
    if(!cursor||this.data.formalLoadingMore||this.data.loading||this.data.mode!=="recommend"||!this.data.ugcFeedEnabled)return;
    const token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({formalLoadingMore:true});
    try{
      const q=this.data.appliedSearch?`&q=${encodeURIComponent(this.data.appliedSearch)}`:"";
      const page=await request<{items:any[];nextCursor:string|null}>({path:`/v1/ugc/posts?limit=30&cursor=${encodeURIComponent(cursor)}${q}`,
        authMode:token?"optional":"public"});
      if(attempt!==this.data.feedAttempt||token!==getApp<IAppOption>().globalData.sessionToken)return;
      const origin=getApp<IAppOption>().globalData.apiBaseUrl.replace(/\/$/,"");
      const more=page.items.map(item=>({...item,kind:"formal",author_id:item.authorId,
        image:item.coverId&&origin?`${origin}/v1/ugc/media/${item.coverId}?variant=thumbnail`:""}));
      this.setData({feed:[...this.data.feed,...more],formalNextCursor:page.nextCursor});
      this.renderFeed();
    }catch{if(attempt===this.data.feedAttempt)this.setData({error:"更多内容暂时无法加载，请重试。"});}
    finally{if(attempt===this.data.feedAttempt)this.setData({formalLoadingMore:false});}
  },
  async selectMode(event: WechatMiniprogram.TouchEvent) {
    const mode = String(event.currentTarget.dataset.mode);
    if (!["featured", "recommend", "following", "review"].includes(mode) || (mode === "review" && !this.data.canReview)) return;
    if (mode === "recommend" && !this.data.ugcFeedEnabled && !this.data.socialPreviewEnabled) return;
    if (mode === "following" && !this.data.socialPreviewEnabled) return;
    if ((mode === "following" || mode === "review") && !getApp<IAppOption>().globalData.sessionToken) { resumeAuthentication(); return; }
    this.setData({ mode });
    if (mode === "review") await this.loadReview();
    else if (mode === "following") await this.loadFollowing();
    else this.renderFeed();
  },
  renderFeed() {
    const reviewed = (this.data.mode === "following" ? this.data.followingFeed : this.data.feed).map((item: any) => item.kind === "formal"
      ? { ...item, avatar: item.avatar || defaultMemberAvatar, author: item.author || "CISME 会员", engagementLabel: `${item.likeCount || 0} 赞` }
      : { ...item, kind: "ugc", image: item.image || "", avatar: item.avatar || defaultMemberAvatar, author: item.author || "CISME 会员", engagementLabel: "" });
    const featured = editorialStories.map(item => ({ ...item, author_id: "brand:cisme" }));
    let items = this.data.mode === "featured" ? featured : this.data.mode === "recommend" ? reviewed : reviewed.concat(featured);
    if (this.data.mode === "following") items = items.filter(item => this.data.follows.includes(item.author_id));
    this.setData({ displayFeedCount: items.length, feedColumns: feedColumns(items) });
  },
  async loadFollowing() {
    const attempt = this.data.feedAttempt;
    const token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ followingFeed: [], loading: true, error: "" });
    this.renderFeed();
    try {
      const followingFeed = await prepareFeedPage(await request<{items:any[];authors?:Record<string,any>}>({ path: "/v1/me/following/page?limit=30" }));
      if (attempt !== this.data.feedAttempt || token !== getApp<IAppOption>().globalData.sessionToken) return;
      this.setData({ followingFeed }); this.renderFeed();
    } catch { if (attempt === this.data.feedAttempt && token === getApp<IAppOption>().globalData.sessionToken) this.setData({ error: "关注内容未同步，请重试。" }); }
    finally { if (attempt === this.data.feedAttempt && token === getApp<IAppOption>().globalData.sessionToken) this.setData({loading:false}); }
  },
  async loadReview() {
    if (!this.data.canReview) return;
    const token = getApp<IAppOption>().globalData.sessionToken;
    const attempt = this.data.feedAttempt;
    this.setData({ reviewQueue: [], publicationQueue: [], profileReviewQueue: [], formalReviewQueue: [], teamError: "", reviewBusy: true });
    try {
      const [reviewQueue, publicationQueue, profiles, formal] = await Promise.all([request<any[]>({ path: "/v1/team/reviews" }), request<any[]>({ path: "/v1/team/publications" }), request<any[]>({ path: "/v1/team/member-profiles" }), request<{items:any[]}>({path:"/v1/management/ugc/review-queue"})]);
      const profileReviewQueue=await Promise.all(profiles.map(async row=>{const {avatar_data_url,...safe}=row;return {...safe,avatar:await localMemberAvatar(avatar_data_url,row.avatar_revision)};}));
      if (attempt !== this.data.feedAttempt || token !== getApp<IAppOption>().globalData.sessionToken) return;
      this.setData({ reviewQueue, publicationQueue, profileReviewQueue, formalReviewQueue: formal.items });
    } catch (error) { if (attempt === this.data.feedAttempt && token === getApp<IAppOption>().globalData.sessionToken) this.setData({ teamError: (error as {title?:string}).title || "审核列表未同步，请重试" }); }
    finally { if (attempt === this.data.feedAttempt && token === getApp<IAppOption>().globalData.sessionToken) this.setData({ reviewBusy: false }); }
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
    const attempt = this.data.feedAttempt + 1;
    this.setData({ feedAttempt: attempt, loading: true, formalNextCursor:null, formalLoadingMore:false, reviewBusy: false, teamError: "", error: "" });
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
    if (this.data.feedAttempt !== attempt) return;
    const availableMode = this.data.mode === "recommend" && !capabilities.ugcFeedEnabled && !capabilities.socialPreviewEnabled
      || this.data.mode === "following" && !capabilities.socialPreviewEnabled
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
      if (this.data.feedAttempt !== attempt) return;
      // Post covers still require their own authorized media path; author
      // identities come only from the server public-profile allowlist.
      this.setData({ feed, formalNextCursor:"feed" in formalOutcome?formalOutcome.feed.nextCursor:null, error: "" });
      this.renderFeed();
      if (this.data.mode === "review") await this.loadReview();
      else if (this.data.mode === "following") await this.loadFollowing();
    } catch (error) {
      if (this.data.feedAttempt === attempt) { this.setData({ feed: [], error: "社区内容暂时无法加载，请重试；精选护理故事仍可浏览。" }); this.renderFeed(); }
    } finally {
      if (this.data.feedAttempt === attempt) this.setData({ loading: false });
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
