import { defaultMemberAvatar, prepareFeedAuthors } from "../../services/member-avatar";
import { clearAuthenticationRedirectSuppression, request } from "../../services/api";
import { editorialStory } from "../../services/editorial";
import { currentChromeStyle, motionDuration } from "../../services/layout";
import { prepareShareLink, registerIncomingShare } from "../../services/share";

import { commentThreads, emptyCommunity, prepareCommentAuthors, type CommunityView } from "../../services/community";

Page({
  data: { following: false, followBusy: false, followError: "", authorId: "", socialEnabled: false, socialLoading: false, socialError: "", socialBusy: false, social: emptyCommunity, threads: [] as ReturnType<typeof commentThreads>, expandedThreads: [] as string[], draft: "", draftOperation: "", replyToId: "", replyToName: "", composerFocused: false, keyboardHeight: 0, chromeStyle: currentChromeStyle(), id: "", item: null as any, media: [] as string[], mediaIndex: 0, galleryHeight: 1000, shareId: "", loading: true, loadAttempt: 0, pageAlive: true, leaving: false, errorKind: "none" as "none" | "missing" | "load", errorTitle: "", error: "" },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onLoad(query: Record<string, string | undefined>) {
    const id = query.id ?? "";
    this.setData({ id, pageAlive: true });
    void registerIncomingShare(query.share_id, "post", id);
    wx.hideShareMenu();
  },
  onShow() { this.setData({ pageAlive: true, leaving: false }); void this.load(); },
  onHide() { this.data.loadAttempt += 1; this.setData({ composerFocused: false, keyboardHeight: 0 }); },
  onUnload() { this.data.pageAlive = false; this.data.loadAttempt += 1; },
  async load() {
    const attempt = this.data.loadAttempt + 1;
    wx.hideShareMenu();
    this.setData({ loadAttempt: attempt, socialEnabled: false, socialBusy: false, socialLoading: false, social: emptyCommunity, threads: [], following: false, followError: "", item: null, media: [], mediaIndex: 0, shareId: "", loading: true, errorKind: "none", errorTitle: "", error: "" });
    try {
      const editorial = editorialStory(this.data.id);
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
      this.setData({ authorId: reviewed?.author_id || "", item: reviewed ? { ...reviewed, image: "", avatar: reviewed.avatar || defaultMemberAvatar, author: reviewed.author || "CISME 会员", publishedLabel: "经审用户投稿", provenanceLabel: "人工审核通过 · 有效用途许可" } : null, loading: false, errorKind: reviewed ? "none" : "missing", errorTitle: reviewed ? "" : "这篇护理故事不可用", error: reviewed ? "" : "内容已撤回、展示许可已失效，或链接不存在。请安全返回品牌精选社区。" });
      if (reviewed) {
        void this.loadSocial();
        wx.showShareMenu({ menus: ["shareAppMessage"] });
        void this.prepareShare(attempt);
      }
    }
    catch (error) {
      if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ item: null, shareId: "", loading: false, errorKind: "load", errorTitle: "护理故事暂时未同步", error: "请检查网络后重试。加载失败不会被误显示为内容已撤回。" });
    }
  },
  async loadFollow() {
    const attempt = this.data.loadAttempt;
    this.setData({ following: false, followError: "" });
    if (!this.data.socialEnabled || !getApp<IAppOption>().globalData.sessionToken) return;
    try {
      const follows = await request<string[]>({ path: "/v1/me/follows", authMode: "optional" });
      if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ following: follows.includes(this.data.authorId) });
    } catch { if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ followError: "关注状态暂未同步" }); }
  },
  async toggleFollow() {
    if (!this.data.socialEnabled || this.data.followBusy || !this.data.authorId || this.data.leaving) return;
    clearAuthenticationRedirectSuppression();
    const attempt = this.data.loadAttempt;
    this.setData({ followBusy: true, followError: "" });
    try {
      const result = await request<{following:boolean}>({ path: `/v1/me/follows/${encodeURIComponent(this.data.authorId)}`, method: "PUT", data: { active: !this.data.following } });
      if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ following: result.following });
    } catch (error) { if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ followError: (error as {title?:string}).title || "关注未保存，请重试" }); }
    finally { if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ followBusy: false }); }
  },
  async loadSocial() {
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
      if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ socialError: "交流暂时未同步，点击重试" });
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
      const social = await prepareCommentAuthors(await request<CommunityView>({ path: `/v1/community/${encodeURIComponent(this.data.id)}${path}`, method, data, idempotencyKey: operationId }));
      if (!this.data.pageAlive || attempt !== this.data.loadAttempt) return false;
      this.setData({ social, threads: commentThreads(social.comments, this.data.expandedThreads) });
      return true;
    } catch (error) {
      if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ socialError: (error as { title?: string }).title || "暂未保存，请重试；已输入的内容仍保留" });
      return false;
    } finally {
      if (this.data.pageAlive && attempt === this.data.loadAttempt) this.setData({ socialBusy: false });
    }
  },
  toggleLike() { void this.mutateSocial("/reaction", "PUT", { kind: "like", active: !this.data.social.liked }); },
  toggleSave() { void this.mutateSocial("/reaction", "PUT", { kind: "save", active: !this.data.social.saved }); },
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
      wx.previewImage({ current: urls[selected], urls, fail: () => wx.showToast({ title: "图片暂时无法打开，请重试", icon: "none" }) });
    } catch {
      if (this.data.pageAlive && this.data.loadAttempt === attempt) wx.showToast({ title: "图片暂时无法打开，请重试", icon: "none" });
    }
  },
  async prepareShare(loadAttempt?: number) {
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
  onShareAppMessage() { return { title: this.data.item?.title ?? "CISME 护理故事", path: `/pages/post/index?id=${encodeURIComponent(this.data.id)}${this.data.shareId ? `&share_id=${this.data.shareId}` : ""}` }; }
});
