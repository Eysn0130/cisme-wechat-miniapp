import { request, requireMemberAccess } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";

type Candidate = { id: string; authorId: string; state: string; revision: number; publishedRevision: number | null; version: number; title: string; body: string;
  aiUsage: string; rightsConfirmed: boolean; publicConsentConfirmed: boolean; moderationState: string;
  media: Array<{ id: string; state: string; scanVerdict: string | null; scanProvider: string | null; position: number }>;
  lastAction: { decision: string; reason: string } | null };
const failure = (error: unknown) => (error as { title?: string })?.title || "审核操作未完成，请刷新核对。";
Page({
  data: { chromeStyle: currentChromeStyle(), postId: "", candidate: null as Candidate | null,
    media: [] as Array<{ id: string; state: string; scanVerdict: string; src: string; position: number }>,
    loading: true, busy: false, error: "", notice: "", epoch: 0 },
  onLoad(query: Record<string, string | undefined>) {
    const id = String(query.id || "");this.setData({ postId: id });
    if (!requireMemberAccess(`/pages/community-review/index?id=${encodeURIComponent(id)}`)) return;
    if (id) void this.load();else this.setData({ loading: false, error: "内容编号缺失。" });
  },
  onShow() { if (this.data.candidate) void this.load(); },
  onUnload() { this.data.epoch += 1; },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  async load() {
    if (!this.data.postId) return;
    const epoch = ++this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ loading: !this.data.candidate, error: "" });
    try {
      const candidate = await request<Candidate>({ path: `/v1/management/ugc/posts/${this.data.postId}` });
      const media = await Promise.all(candidate.media.map(async item => {
        try {
          const preview = await request<{ url: string }>({ path: `/v1/management/ugc/media/${item.id}/preview-url` });
          return { ...item, scanVerdict: item.scanVerdict || "pending", src: preview.url };
        } catch { return { ...item, scanVerdict: item.scanVerdict || "pending", src: "" }; }
      }));
      if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken)
        this.setData({ candidate, media, loading: false });
    } catch (error) { if (epoch === this.data.epoch) this.setData({ loading: false, error: failure(error) }); }
  },
  preview(event: WechatMiniprogram.TouchEvent) {
    const src = String(event.currentTarget.dataset.src || ""), urls = this.data.media.map(item => item.src).filter(Boolean);
    if (src && urls.length) wx.previewImage({ current: src, urls });
  },
  async reviewMedia(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || !this.data.candidate) return;
    const id = String(event.currentTarget.dataset.id || ""), decision = String(event.currentTarget.dataset.decision || "");
    const media = this.data.media.find(item => item.id === id);
    if (!media || !["approve", "reject"].includes(decision) || decision === "approve" && media.scanVerdict !== "safe") return;
    const reason = await wx.showModal({ title: decision === "approve" ? "通过图片审核" : "退回这张图片",
      editable: true, placeholderText: "填写至少 4 字的审核依据", confirmText: "确认" });
    if (!reason.confirm) return;
    const why=(reason.content||"").trim();
    if(why.length<4){this.setData({error:"请填写至少 4 字的审核依据。"});return;}
    this.setData({ busy: true, error: "" });
    try {
      await request({ path: `/v1/management/ugc/media/${id}/review`, method: "POST", data: {
        decision, reason: why, ruleVersion: "UGC-R1" } });
      await this.load();
    } catch (error) { this.setData({ error: failure(error) }); }
    finally { this.setData({ busy: false }); }
  },
  async reviewPost(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || !this.data.candidate || this.data.candidate.moderationState !== "pending") return;
    const decision = String(event.currentTarget.dataset.decision || "");
    if (!["approve", "reject"].includes(decision)) return;
    const reason = await wx.showModal({ title: decision === "approve" ? "通过内容审核" : "退回作者修改",
      editable: true, placeholderText: "填写已核对的事实与审核依据", confirmText: "提交" });
    if (!reason.confirm) return;
    const why=(reason.content||"").trim();
    if(why.length<4){this.setData({error:"请填写至少 4 字的审核依据。"});return;}
    this.setData({ busy: true, error: "" });
    try {
      await request({ path: `/v1/management/ugc/posts/${this.data.postId}/review`, method: "POST", data: {
        decision, reason: why, ruleVersion: "UGC-R1", expectedVersion: this.data.candidate.version } });
      await this.load();
    } catch (error) { this.setData({ error: failure(error) }); }
    finally { this.setData({ busy: false }); }
  },
  async publish() {
    if (this.data.busy || !this.data.candidate || this.data.candidate.moderationState !== "approved") return;
    const answer = await wx.showModal({ title: "复核并公开？", content: "确认内容、图片和公开许可与已审核版本一致。需由另一名审核员完成。", confirmText: "公开" });
    if (!answer.confirm) return;
    this.setData({ busy: true, error: "" });
    try {
      await request({ path: `/v1/management/ugc/posts/${this.data.postId}/publish`, method: "POST",
        data: { expectedVersion: this.data.candidate.version } });
      this.setData({ notice: "已公开这篇护理故事。" }); await this.load();
    } catch (error) { this.setData({ error: failure(error) }); }
    finally { this.setData({ busy: false }); }
  },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/community/index" }) }); }
});
