import { request } from "../../services/api";
import { editorialStory } from "../../services/editorial";
import { currentChromeStyle } from "../../services/layout";
import { prepareShareLink, registerIncomingShare } from "../../services/share";

Page({
  data: { chromeStyle: currentChromeStyle(), id: "", item: null as any, shareId: "", loading: true, loadAttempt: 0, pageAlive: true, leaving: false, errorKind: "none" as "none" | "missing" | "load", errorTitle: "", error: "" },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onLoad(query: Record<string, string | undefined>) {
    const id = query.id ?? "";
    this.setData({ id, pageAlive: true });
    void registerIncomingShare(query.share_id, "post", id);
    wx.hideShareMenu();
  },
  onShow() { this.setData({ pageAlive: true, leaving: false }); void this.load(); },
  onHide() { this.data.loadAttempt += 1; },
  onUnload() { this.data.pageAlive = false; this.data.loadAttempt += 1; },
  async load() {
    const attempt = this.data.loadAttempt + 1;
    wx.hideShareMenu();
    this.setData({ loadAttempt: attempt, item: null, shareId: "", loading: true, errorKind: "none", errorTitle: "", error: "" });
    try {
      const editorial = editorialStory(this.data.id);
      if (editorial) {
        if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return;
        this.setData({ item: editorial, loading: false, errorKind: "none", errorTitle: "", error: "" });
        wx.showShareMenu({ menus: ["shareAppMessage"] });
        void this.prepareShare(attempt);
        return;
      }
      const feed = await request<any[]>({ path: "/v1/feed", authMode: "public" });
      if (!this.data.pageAlive || this.data.loadAttempt !== attempt) return;
      // The feed exposes an object key, not an authorized media URL or avatar.
      // Never attribute bundled brand imagery or a local portrait to a submission.
      const reviewed = feed.find((item: any) => item.id === this.data.id) ?? null;
      this.setData({ item: reviewed ? { ...reviewed, image: "", avatar: "", author: "CISME 会员", publishedLabel: "经审用户投稿", provenanceLabel: "人工审核通过 · 有效用途许可" } : null, loading: false, errorKind: reviewed ? "none" : "missing", errorTitle: reviewed ? "" : "这篇护理故事不可用", error: reviewed ? "" : "内容已撤回、展示许可已失效，或链接不存在。请安全返回品牌精选社区。" });
      if (reviewed) {
        wx.showShareMenu({ menus: ["shareAppMessage"] });
        void this.prepareShare(attempt);
      }
    }
    catch (error) {
      if (this.data.pageAlive && this.data.loadAttempt === attempt) this.setData({ item: null, shareId: "", loading: false, errorKind: "load", errorTitle: "护理故事暂时未同步", error: "请检查网络后重试。加载失败不会被误显示为内容已撤回。" });
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
