import { request, requireMemberAccess } from "../../services/api";
import { cancelPageReads } from "../../services/page-requests";
import { editorialIdentifier } from "../../services/editorial";
import { editorialCommentReviewQueue,reviewEditorialComment,type EditorialReviewComment,type EditorialCommentReviewState } from "../../services/editorial-comments";
import { currentChromeStyle } from "../../services/layout";

type Candidate = { id: string; authorId: string; state: string; revision: number; publishedRevision: number | null; version: number; title: string; body: string;
  aiUsage: string; rightsConfirmed: boolean; publicConsentConfirmed: boolean; moderationState: string;
  media: Array<{ id: string; state: string; scanVerdict: string | null; scanProvider: string | null; position: number }>;
  lastAction: { decision: string; reason: string } | null };
const failure = (error: unknown, fallback = "审核结果尚未确认，请刷新核对。") => (error as { title?: string })?.title || fallback;
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
const reviewStatusLabel=(status:string)=>({pending:"待审核",published:"已公开",rejected:"已退回",hidden:"已隐藏"}[status]||status);
const reviewSafetyLabel=(state:string)=>({pending:"检查中",safe:"已通过",review:"需核对",risky:"未通过",error:"检查未完成"}[state]||"未完成");
const commentReviewConflict=(error:unknown)=>(error as {title?:string})?.title||"评论状态已变化，请刷新核对后再操作。";
type ReviewRow=EditorialReviewComment&{dateLabel:string;statusLabel:string;safetyLabel:string};
Page({
  reviewVisible:true,editorialQueueEpoch:0,editorialReviewOwner:0,
  data: { candidateStateLabels:{draft:'草稿',pending_review:'待审核',published:'已公开',rejected:'已退回',hidden:'已下架',deleted:'已删除'},mediaStateLabels:{authorized:'待上传',uploaded:'已上传',scanning:'检测中',approved:'已通过',rejected:'已退回',deleting:'删除中',deleted:'已删除'},reviewDecisionLabels:{approve:'通过审核',reject:'退回修改',publish:'公开',hide:'下架',restore:'恢复'},editorialSource:false,articleId:"",queueState:"pending" as EditorialCommentReviewState,queueItems:[] as ReviewRow[],queueCursor:null as string|null,queueHasMore:false,queueTabs:[{id:"pending",label:"待审核"},{id:"reported",label:"被举报"},{id:"published",label:"已公开"},{id:"rejected",label:"已退回"},{id:"hidden",label:"已隐藏"}],chromeStyle: currentChromeStyle(), postId: "", candidate: null as Candidate | null,
    media: [] as Array<{ id: string; state: string; scanVerdict: string; src: string; position: number }>,
    loading: true, busy: false, error: "", notice: "", handled: false, permissionDenied: false },
  onLoad(query: Record<string, string | undefined>) {
    const id = String(query.id || "");const ctx=context(this);ctx.alive=true;ctx.token=getApp<IAppOption>().globalData.sessionToken;
    const articleId=String(query.articleId||"");
    this.setData({ postId: id,editorialSource:query.source==="editorial",articleId });
    if(query.source==="editorial"){
      if(articleId&&!editorialIdentifier(articleId)){this.setData({loading:false,error:"文章链接无效。"});return;}
      if(requireMemberAccess(this.editorialReviewReturnUrl()))void this.loadEditorialQueue();return;
    }
    if (!requireMemberAccess(`/pages/community-review/index?id=${encodeURIComponent(id)}`)) return;
    if (id) void this.load();else this.setData({ loading: false, error: "内容编号缺失。" });
  },
  onShow() { this.reviewVisible=true;const ctx=context(this);if(this.data.editorialSource){if(ctx.shown)void this.loadEditorialQueue();ctx.shown=true;return;}if(ctx.shown&&(!this.data.handled||ctx.token!==getApp<IAppOption>().globalData.sessionToken))void this.load();else ctx.shown=true; },
  onHide() {this.reviewVisible=false;context(this).epoch+=1;this.editorialQueueEpoch+=1;this.editorialReviewOwner+=1;cancelPageReads(this);this.setData({busy:false});},
  onUnload() { this.reviewVisible=false;this.editorialQueueEpoch+=1;this.editorialReviewOwner+=1;cancelPageReads(this);const ctx=context(this);ctx.alive=false;ctx.epoch+=1; },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  denyCapability(error:unknown) {
    if((error as {code?:string})?.code!=="CAPABILITY_REQUIRED")return false;
    this.setData({candidate:null,media:[],loading:false,busy:false,handled:false,notice:"",permissionDenied:true,
      error:"当前账号没有内容审核权限，请返回社区。"});
    return true;
  },
  async load() {
    if(this.data.editorialSource){await this.loadEditorialQueue();return;}
    if (!this.data.postId) return;
    const ctx=context(this),epoch=++ctx.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    ctx.token=token;
    this.setData({ candidate:null,media:[],loading:true,busy:false,error:"",handled:false,permissionDenied:false });
    if(!token){this.setData({loading:false,error:"请先确认身份后重新进入审核。"});requireMemberAccess();return;}
    try {
      const candidate = await request<Candidate>({ path: `/v1/management/ugc/posts/${this.data.postId}` });
      const media = await Promise.all(candidate.media.map(async item => {
        try {
          const preview = await request<{ url: string }>({ path: `/v1/management/ugc/media/${item.id}/preview-url` });
          return { ...item, scanVerdict: item.scanVerdict || "pending", src: preview.url };
        } catch (error) {
          if((error as {code?:string})?.code==="CAPABILITY_REQUIRED")throw error;
          return { ...item, scanVerdict: item.scanVerdict || "pending", src: "" };
        }
      }));
      if (ctx.alive && epoch === ctx.epoch && token === getApp<IAppOption>().globalData.sessionToken)
        this.setData({ candidate, media, loading: false });
    } catch (error) { if (ctx.alive && epoch === ctx.epoch && token === getApp<IAppOption>().globalData.sessionToken && !this.denyCapability(error))
      this.setData({ candidate:null,media:[],loading:false,
        error:handledElsewhere(error)?"":failure(error,"待审内容暂时无法加载，请重试。"),handled:handledElsewhere(error),
        notice:handledElsewhere(error)?"这篇内容已不在待审队列，可能已撤回或被其他审核员处理。":"" }); }
  },
  editorialReviewReturnUrl() {return `/pages/community-review/index?source=editorial${this.data.articleId?`&articleId=${encodeURIComponent(this.data.articleId)}`:""}`;},
  currentEditorialQueue(epoch:number,token:string) {
    return this.reviewVisible&&context(this).alive&&this.data.editorialSource&&epoch===this.editorialQueueEpoch
      &&Boolean(token)&&token===getApp<IAppOption>().globalData.sessionToken;
  },
  async loadEditorialQueue(append=false) {
    if(!this.reviewVisible||!context(this).alive)return;
    if(this.data.articleId&&!editorialIdentifier(this.data.articleId)){this.setData({loading:false,error:"文章链接无效。"});return;}
    const more=append===true;
    if(more&&(!this.data.queueHasMore||!this.data.queueCursor||this.data.loading||this.data.busy))return;
    const epoch=++this.editorialQueueEpoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.editorialReviewOwner+=1;context(this).token=token;
    this.setData({loading:true,busy:false,error:"",permissionDenied:false,...(!more?{queueItems:[],queueCursor:null,queueHasMore:false}: {})});
    if(!token){this.setData({loading:false,error:"请先登录后查看评论审核。"});requireMemberAccess(this.editorialReviewReturnUrl());return;}
    try{
      const result=await editorialCommentReviewQueue(this,{state:this.data.queueState,cursor:more?this.data.queueCursor:null,...(this.data.articleId?{articleId:this.data.articleId}:{})});
      if(!this.currentEditorialQueue(epoch,token))return;
      const byId=new Map((more?this.data.queueItems:[]).map(item=>[item.id,item]));
      for(const item of result.items)byId.set(item.id,{...item,dateLabel:new Date(item.createdAt).toLocaleString("zh-CN"),statusLabel:reviewStatusLabel(item.status),safetyLabel:reviewSafetyLabel(item.safetyState)});
      this.setData({queueItems:[...byId.values()],queueCursor:result.nextCursor,queueHasMore:result.hasMore,loading:false});
    }catch(error){
      if(this.currentEditorialQueue(epoch,token)){
        const denied=Number((error as {status?:number})?.status)===403;
        this.setData({loading:false,busy:false,...(denied?{queueItems:[],queueCursor:null,queueHasMore:false,permissionDenied:true}:{}),error:denied?"当前账号没有这篇文章的评论管理权限。":failure(error,"评论审核列表暂时无法加载，请重试。")});
      }else if(this.reviewVisible&&epoch===this.editorialQueueEpoch&&token&&getApp<IAppOption>().globalData.sessionToken===""){
        this.editorialQueueEpoch+=1;this.setData({loading:false,busy:false,queueItems:[],queueCursor:null,queueHasMore:false,error:"登录状态已失效，请重新登录后查看。"});
      }
    }
  },
  loadMoreEditorialQueue(){return this.loadEditorialQueue(true);},
  selectEditorialQueue(event:WechatMiniprogram.TouchEvent) {
    const state=String(event.currentTarget.dataset.state||"");
    if(!["pending","published","rejected","hidden","reported"].includes(state)||state===this.data.queueState)return;
    this.setData({queueState:state as EditorialCommentReviewState,notice:""});void this.loadEditorialQueue();
  },
  async reviewEditorial(event:WechatMiniprogram.TouchEvent) {
    if(this.data.busy||this.data.loading||!this.reviewVisible)return;
    const row=this.data.queueItems.find(item=>item.id===event.currentTarget.dataset.id);
    const decision=String(event.currentTarget.dataset.decision||"");
    if(!row||!(["approve","reject","hide"] as string[]).includes(decision))return;
    if(decision==="hide"?row.status!=="published":row.status!=="pending")return;
    if(decision==="approve"&&row.safetyState!=="safe"){this.setData({error:"安全检查尚未通过，请稍后刷新核对。"});return;}
    const epoch=this.editorialQueueEpoch,token=getApp<IAppOption>().globalData.sessionToken,owner=++this.editorialReviewOwner;
    if(!this.currentEditorialQueue(epoch,token))return;
    const current=()=>owner===this.editorialReviewOwner&&this.currentEditorialQueue(epoch,token)
      &&this.data.queueItems.some(item=>item.id===row.id&&item.version===row.version&&item.status===row.status);
    this.setData({busy:true,error:"",notice:""});
    try{
      const answer=await wx.showModal({title:decision==="approve"?"通过这条评论？":decision==="reject"?"退回这条评论？":"隐藏这条评论？",editable:true,placeholderText:"填写处理依据（4 至 500 字）",confirmText:"确认处理"});
      if(!answer.confirm||!current())return;
      const reason=(answer.content||"").trim();
      if(Array.from(reason).length<4||Array.from(reason).length>500){this.setData({error:"请填写 4 至 500 字的处理依据。"});return;}
      await reviewEditorialComment(row.id,{decision:decision as "approve"|"reject"|"hide",reason,expectedVersion:row.version});
      if(!current())return;
      this.setData({notice:decision==="approve"?"评论已通过审核。":decision==="reject"?"评论已退回。":"评论已隐藏。"});
      await this.loadEditorialQueue();
    }catch(error){
      if(!current())return;
      const status=Number((error as {status?:number})?.status);
      if(status===403){this.editorialQueueEpoch+=1;this.setData({busy:false,queueItems:[],queueCursor:null,queueHasMore:false,permissionDenied:true,error:"评论管理权限已变化，请返回文章。"});}
      else this.setData({error:status===409?commentReviewConflict(error):failure(error)});
    }finally{if(current())this.setData({busy:false});}
  },
  openEditorialArticle(event:WechatMiniprogram.TouchEvent) {
    const id=String(event.currentTarget.dataset.articleId||"");if(!this.reviewVisible||!editorialIdentifier(id))return;
    wx.navigateTo({url:`/pages/post/index?id=${encodeURIComponent(id)}&source=editorial`,fail:()=>{if(this.reviewVisible)wx.showToast({title:"文章暂时无法打开",icon:"none"});}});
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
    } catch (error) { if(sameIntent(this,intent)&&!this.denyCapability(error))this.setData({error:handledElsewhere(error)?"":failure(error),
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
    } catch (error) { if(sameIntent(this,intent)&&!this.denyCapability(error))this.setData({error:handledElsewhere(error)?"":failure(error),
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
    } catch (error) { if(sameIntent(this,intent)&&!this.denyCapability(error))this.setData({error:handledElsewhere(error)?"":failure(error),
      candidate:handledElsewhere(error)?null:this.data.candidate,media:handledElsewhere(error)?[]:this.data.media,
      handled:handledElsewhere(error),notice:handledElsewhere(error)?"内容已被他人处理或作者撤回，请返回待审队列核对。":""}); }
    finally { if(sameIntent(this,intent))this.setData({ busy: false }); }
  },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/community/index" }) }); }
});
