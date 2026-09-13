import { request, requireMemberAccess } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";

type Candidate = { id: string; authorId: string; state: string; revision: number; publishedRevision: number | null; version: number; title: string; body: string;
  aiUsage: string; rightsConfirmed: boolean; publicConsentConfirmed: boolean; moderationState: string;
  media: Array<{ id: string; state: string; scanVerdict: string | null; scanProvider: string | null; position: number }>;
  lastAction: { decision: string; reason: string } | null };
const failure = (error: unknown) => (error as { title?: string })?.title || "审核操作未完成，请刷新核对。";
type ReviewContext = { epoch: number; token: string; alive: boolean; shown: boolean };
type ReviewIntent = { epoch: number; token: string; postId: string; revision: number; version: number };
const contexts = new WeakMap<object, ReviewContext>();
function context(page: object): ReviewContext {
  let value = contexts.get(page);
  if (!value) { value = { epoch: 0, token: "", alive: true, shown: false }; contexts.set(page, value); }
  return value;
}
function captureIntent(page: { data: { postId: string; candidate: Candidate | null } }): ReviewIntent | null {
  const candidate = page.data.candidate, ctx = context(page);
  if (!candidate || !ctx.alive || !ctx.token || ctx.token !== getApp<IAppOption>().globalData.sessionToken) return null;
  return { epoch: ctx.epoch, token: ctx.token, postId: page.data.postId, revision: candidate.revision, version: candidate.version };
}
function sameIntent(page: { data: { postId: string; candidate: Candidate | null } }, intent: ReviewIntent): boolean {
  const ctx = context(page), candidate = page.data.candidate;
  return ctx.alive && ctx.epoch === intent.epoch && ctx.token === intent.token &&
    getApp<IAppOption>().globalData.sessionToken === intent.token && page.data.postId === intent.postId &&
    candidate?.id === intent.postId && candidate.revision === intent.revision && candidate.version === intent.version;
}
const handledElsewhere = (error: unknown) => [404, 409].includes(Number((error as { status?: number })?.status));
Page({
  data: { chromeStyle: currentChromeStyle(), postId: "", candidate: null as Candidate | null,
    media: [] as Array<{ id: string; state: string; scanVerdict: string; src: string; position: number }>,
    loading: true, busy: false, error: "", notice: "", handled: false },
  onLoad(query: Record<string, string | undefined>) {
    const id = String(query.id || "");const ctx=context(this);ctx.alive=true;ctx.token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({ postId: id });
    if (!requireMemberAccess(`/pages/community-review/index?id=${encodeURIComponent(id)}`)) return;
    if (id) void this.load();else this.setData({ loading: false, error: "内容编号缺失。" });
  },
  onShow() { const ctx=context(this);if(ctx.shown&&(!this.data.handled||ctx.token!==getApp<IAppOption>().globalData.sessionToken))void this.load();else ctx.shown=true; },
  onUnload() { const ctx=context(this);ctx.alive=false;ctx.epoch+=1; },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  async load() {
    if (!this.data.postId) return;
    const ctx=context(this),epoch=++ctx.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    ctx.token=token;
    this.setData({ candidate:null,media:[],loading:true,busy:false,error:"",handled:false });
    if(!token){this.setData({loading:false,error:"请先确认身份后重新进入审核。"});requireMemberAccess();return;}
    try {
      const candidate = await request<Candidate>({ path: `/v1/management/ugc/posts/${this.data.postId}` });
      const media = await Promise.all(candidate.media.map(async item => {
        try {
          const preview = await request<{ url: string }>({ path: `/v1/management/ugc/media/${item.id}/preview-url` });
          return { ...item, scanVerdict: item.scanVerdict || "pending", src: preview.url };
        } catch { return { ...item, scanVerdict: item.scanVerdict || "pending", src: "" }; }
      }));
      if (ctx.alive && epoch === ctx.epoch && token === getApp<IAppOption>().globalData.sessionToken)
        this.setData({ candidate, media, loading: false });
    } catch (error) { if (ctx.alive && epoch === ctx.epoch && token === getApp<IAppOption>().globalData.sessionToken)
      this.setData({ candidate:null,media:[],loading:false,
        error:handledElsewhere(error)?"":failure(error),handled:handledElsewhere(error),
        notice:handledElsewhere(error)?"这篇内容已不在待审队列，可能已撤回或被其他审核员处理。":"" }); }
  },
  preview(event: WechatMiniprogram.TouchEvent) {
    const src = String(event.currentTarget.dataset.src || ""), urls = this.data.media.map(item => item.src).filter(Boolean);
    if (src && urls.length) wx.previewImage({ current: src, urls });
  },
  async reviewMedia(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || !this.data.candidate) return;
    const intent=captureIntent(this);if(!intent)return;
    const id = String(event.currentTarget.dataset.id || ""), decision = String(event.currentTarget.dataset.decision || "");
    const media = this.data.media.find(item => item.id === id);
    if (!media || !["approve", "reject"].includes(decision) || decision === "approve" && media.scanVerdict !== "safe") return;
    const reason = await wx.showModal({ title: decision === "approve" ? "通过图片审核" : "退回这张图片",
      editable: true, placeholderText: "填写至少 4 字的审核依据", confirmText: "确认" });
    if (!reason.confirm||!sameIntent(this,intent)) return;
    const why=(reason.content||"").trim();
    if(why.length<4){this.setData({error:"请填写至少 4 字的审核依据。"});return;}
    this.setData({ busy: true, error: "" });
    try {
      if(!sameIntent(this,intent))return;
      await request({ path: `/v1/management/ugc/media/${id}/review`, method: "POST", data: {
        decision, reason: why, ruleVersion: "UGC-R1" } });
      if(!sameIntent(this,intent))return;
      this.setData({notice:decision==="approve"?"图片审核已通过。":"图片已退回作者。"});
      await this.load();
    } catch (error) { if(sameIntent(this,intent))this.setData({error:handledElsewhere(error)?"":failure(error),
      notice:handledElsewhere(error)?"图片状态已变化，请返回待审队列核对。":""}); }
    finally { if(sameIntent(this,intent))this.setData({busy:false}); }
  },
  async reviewPost(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || !this.data.candidate || this.data.candidate.moderationState !== "pending") return;
    const intent=captureIntent(this);if(!intent)return;
    const decision = String(event.currentTarget.dataset.decision || "");
    if (!["approve", "reject"].includes(decision)) return;
    const reason = await wx.showModal({ title: decision === "approve" ? "通过内容审核" : "退回作者修改",
      editable: true, placeholderText: "填写已核对的事实与审核依据", confirmText: "提交" });
    if (!reason.confirm||!sameIntent(this,intent)) return;
    const why=(reason.content||"").trim();
    if(why.length<4){this.setData({error:"请填写至少 4 字的审核依据。"});return;}
    this.setData({ busy: true, error: "" });
    try {
      if(!sameIntent(this,intent))return;
      const result=await request<{decision:string;version:number}>({ path: `/v1/management/ugc/posts/${intent.postId}/review`, method: "POST", data: {
        decision, reason: why, ruleVersion: "UGC-R1", expectedVersion: intent.version } });
      if(!sameIntent(this,intent))return;
      if(result.decision==="reject")this.setData({candidate:null,media:[],busy:false,handled:true,notice:"已退回作者修改。"});
      else {this.setData({notice:"内容审核已通过，等待另一名审核员复核公开。"});await this.load();}
    } catch (error) { if(sameIntent(this,intent))this.setData({error:handledElsewhere(error)?"":failure(error),
      candidate:handledElsewhere(error)?null:this.data.candidate,media:handledElsewhere(error)?[]:this.data.media,
      handled:handledElsewhere(error),notice:handledElsewhere(error)?"内容已被他人处理或作者撤回，请返回待审队列核对。":""}); }
    finally { if(sameIntent(this,intent))this.setData({ busy: false }); }
  },
  async publish() {
    if (this.data.busy || !this.data.candidate || this.data.candidate.moderationState !== "approved") return;
    const intent=captureIntent(this);if(!intent)return;
    const answer = await wx.showModal({ title: "复核并公开？", content: "确认内容、图片和公开许可与已审核版本一致。需由另一名审核员完成。", confirmText: "公开" });
    if (!answer.confirm||!sameIntent(this,intent)) return;
    this.setData({ busy: true, error: "" });
    try {
      if(!sameIntent(this,intent))return;
      const result=await request<{state:string;version:number}>({ path: `/v1/management/ugc/posts/${intent.postId}/publish`, method: "POST",
        data: { expectedVersion: intent.version } });
      if(!sameIntent(this,intent))return;
      if(result.state==="published")this.setData({candidate:null,media:[],busy:false,handled:true,notice:"已公开这篇护理故事。"});
    } catch (error) { if(sameIntent(this,intent))this.setData({error:handledElsewhere(error)?"":failure(error),
      candidate:handledElsewhere(error)?null:this.data.candidate,media:handledElsewhere(error)?[]:this.data.media,
      handled:handledElsewhere(error),notice:handledElsewhere(error)?"内容已被他人处理或作者撤回，请返回待审队列核对。":""}); }
    finally { if(sameIntent(this,intent))this.setData({ busy: false }); }
  },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/community/index" }) }); }
});
