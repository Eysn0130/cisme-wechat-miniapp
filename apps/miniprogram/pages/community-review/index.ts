import{sectionTabValue}from'../../services/section-tabs';
import { request, requireMemberAccess } from "../../services/api";
import { pageRead,cancelPageReads } from "../../services/page-requests";
import { editorialIdentifier } from "../../services/editorial";
import { deleteEditorialComment,editorialCommentReviewQueue,reviewEditorialComment,type EditorialReviewComment,type EditorialCommentReviewState } from "../../services/editorial-comments";
import {commerceContextRevision} from "../../services/commerce-command-store";
import { currentChromeStyle } from "../../services/layout";
import { localMemberAvatar } from "../../services/member-avatar";

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
const handledElsewhere = (error: unknown) => [404, 409].includes(Number((error as { status?: number })?.status));
const reviewStatusLabel=(status:string)=>({pending:"待审核",published:"已公开",rejected:"已退回",hidden:"已隐藏"}[status]||status);
const reviewSafetyLabel=(state:string)=>({pending:"检查中",safe:"已通过",review:"需核对",risky:"未通过",error:"检查未完成"}[state]||"未完成");
const commentReviewConflict=(error:unknown)=>(error as {title?:string})?.title||"评论状态已变化，请刷新核对后再操作。";
type ReviewRow=EditorialReviewComment&{dateLabel:string;statusLabel:string;safetyLabel:string;avatar:string;initial:string};
Page({
  reviewVisible:true,editorialQueueEpoch:0,editorialReviewOwner:0,governanceEpoch:0,governanceAction:0,governanceOwner:"",
  data: { moderationSource:false,governanceTab:"reports" as "reports"|"appeals",governanceItems:[] as any[],governanceCursor:null as string|null,governanceTotal:null as number|null,governancePublicEnabled:false,candidateStateLabels:{draft:'草稿',pending_review:'待审核',published:'已公开',rejected:'已退回',hidden:'已下架',deleted:'已删除'},mediaStateLabels:{authorized:'待上传',uploaded:'已上传',scanning:'检测中',approved:'已通过',rejected:'已退回',deleting:'删除中',deleted:'已删除'},reviewDecisionLabels:{approve:'通过审核',reject:'退回修改',publish:'公开',hide:'下架',restore:'恢复'},editorialSource:false,articleId:"",queueState:"published" as EditorialCommentReviewState,queueItems:[] as ReviewRow[],queueCursor:null as string|null,queueHasMore:false,queueTabs:[{id:"published",label:"已公开"},{id:"reported",label:"被举报"},{id:"pending",label:"历史待审"},{id:"rejected",label:"已退回"},{id:"hidden",label:"已隐藏"}],chromeStyle: currentChromeStyle(), postId: "", candidate: null as Candidate | null,
    media: [] as Array<{ id: string; state: string; scanVerdict: string; src: string; position: number }>,
    loading: true, busy: false, error: "", notice: "", handled: false, permissionDenied: false },
  onLoad(query: Record<string, string | undefined>) {
    const id = String(query.id || "");const ctx=context(this);ctx.alive=true;ctx.token=getApp<IAppOption>().globalData.sessionToken;
    const articleId=String(query.articleId||"");
    this.setData({ postId: id,editorialSource:query.source==="editorial",articleId });
    if(query.source==="moderation"){this.setData({moderationSource:true});if(requireMemberAccess("/pages/community-review/index?source=moderation"))void this.loadGovernance();return;}
    if(query.source==="editorial"){
      if(articleId&&!editorialIdentifier(articleId)){this.setData({loading:false,error:"文章链接无效。"});return;}
      if(requireMemberAccess(this.editorialReviewReturnUrl()))void this.loadEditorialQueue();return;
    }
    wx.switchTab({url:"/pages/community/index"});
  },
  onShow() { this.reviewVisible=true;const ctx=context(this);if(this.data.moderationSource){if(ctx.shown)void this.loadGovernance();ctx.shown=true;return;}if(this.data.editorialSource){if(ctx.shown)void this.loadEditorialQueue();ctx.shown=true;return;}if(ctx.shown&&(!this.data.handled||ctx.token!==getApp<IAppOption>().globalData.sessionToken))void this.load();else ctx.shown=true; },
  onHide() {this.reviewVisible=false;this.clearGovernance();context(this).epoch+=1;this.editorialQueueEpoch+=1;this.editorialReviewOwner+=1;cancelPageReads(this);this.setData({busy:false});},
  onUnload() { this.reviewVisible=false;this.clearGovernance();this.editorialQueueEpoch+=1;this.editorialReviewOwner+=1;cancelPageReads(this);const ctx=context(this);ctx.alive=false;ctx.epoch+=1; },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  denyCapability(error:unknown) {
    if((error as {code?:string})?.code!=="CAPABILITY_REQUIRED")return false;
    this.setData({candidate:null,media:[],loading:false,busy:false,handled:false,notice:"",permissionDenied:true,
      error:"当前账号没有内容审核权限，请返回社区。"});
    return true;
  },
  async load() { if(this.data.moderationSource)await this.loadGovernance();else if(this.data.editorialSource)await this.loadEditorialQueue();else wx.switchTab({url:"/pages/community/index"}); },
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
    if(!token){this.setData({loading:false,error:"请先登录后查看评论管理。"});requireMemberAccess(this.editorialReviewReturnUrl());return;}
    try{
      const result=await editorialCommentReviewQueue(this,{state:this.data.queueState,cursor:more?this.data.queueCursor:null,...(this.data.articleId?{articleId:this.data.articleId}:{})});
      if(!this.currentEditorialQueue(epoch,token))return;
      const byId=new Map((more?this.data.queueItems:[]).map(item=>[item.id,item]));
      for(const item of result.items){
        const author=result.authors[item.authorId],name=author?.name||item.authorName;
        byId.set(item.id,{...item,authorName:name,avatar:await localMemberAvatar(author?.avatar,author?.avatarRevision),initial:Array.from(name)[0]||"C",dateLabel:new Date(item.createdAt).toLocaleString("zh-CN"),statusLabel:reviewStatusLabel(item.status),safetyLabel:reviewSafetyLabel(item.safetyState)});
      }
      if(!this.currentEditorialQueue(epoch,token))return;
      this.setData({queueItems:[...byId.values()],queueCursor:result.nextCursor,queueHasMore:result.hasMore,loading:false});
    }catch(error){
      if(this.currentEditorialQueue(epoch,token)){
        const denied=Number((error as {status?:number})?.status)===403;
        this.setData({loading:false,busy:false,...(denied?{queueItems:[],queueCursor:null,queueHasMore:false,permissionDenied:true}:{}),error:denied?"当前账号没有这篇文章的评论管理权限。":failure(error,"评论列表暂时无法加载，请重试。")});
      }else if(this.reviewVisible&&epoch===this.editorialQueueEpoch&&token&&getApp<IAppOption>().globalData.sessionToken===""){
        this.editorialQueueEpoch+=1;this.setData({loading:false,busy:false,queueItems:[],queueCursor:null,queueHasMore:false,error:"登录状态已失效，请重新登录后查看。"});
      }
    }
  },
  loadMoreEditorialQueue(){return this.loadEditorialQueue(true);},
  selectEditorialQueue(event:WechatMiniprogram.TouchEvent) {
    const state=sectionTabValue(event,'state');
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
  async deleteEditorial(event:WechatMiniprogram.TouchEvent) {
    if(this.data.busy||this.data.loading||!this.reviewVisible)return;
    const row=this.data.queueItems.find(item=>item.id===event.currentTarget.dataset.id);
    if(!row)return;
    const epoch=this.editorialQueueEpoch,token=getApp<IAppOption>().globalData.sessionToken,owner=++this.editorialReviewOwner;
    const current=()=>owner===this.editorialReviewOwner&&this.currentEditorialQueue(epoch,token)
      &&this.data.queueItems.some(item=>item.id===row.id&&item.version===row.version&&item.status===row.status);
    if(!current())return;
    this.setData({busy:true,error:"",notice:""});
    try{
      const answer=await wx.showModal({title:"删除这条评论？",content:row.parentId?"删除后这条回复将不再显示，处理记录会保留。":"删除后这条评论及其回复将不再显示，处理记录会保留。",confirmText:"删除",confirmColor:"#a8324a"});
      if(!answer.confirm||!current())return;
      await deleteEditorialComment(row.articleId,row.id);
      if(!current())return;
      this.setData({notice:"评论已删除。"});
      await this.loadEditorialQueue();
    }catch(error){
      if(!current())return;
      const status=Number((error as {status?:number})?.status);
      if(status===403){this.editorialQueueEpoch+=1;this.setData({busy:false,queueItems:[],queueCursor:null,queueHasMore:false,permissionDenied:true,error:"评论管理权限已变化，请返回管理中心。"});}
      else this.setData({error:failure(error,"删除结果尚未确认，请刷新核对。")});
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
  governanceIdentity(){const g=getApp<IAppOption>().globalData;return JSON.stringify([g.sessionToken,g.apiBaseUrl,commerceContextRevision(),g.cloudFunction?.env,g.cloudFunction?.name]);},
  clearGovernance(){this.governanceEpoch++;this.governanceAction++;if(this.data.moderationSource)this.setData({governanceItems:[],governanceCursor:null,governanceTotal:null,busy:false,loading:false,notice:""});},
  governanceCurrent(epoch:number,identity:string){return this.reviewVisible&&context(this).alive&&this.data.moderationSource&&epoch===this.governanceEpoch&&identity===this.governanceIdentity();},
  async loadGovernance(more=false){
    if(!this.reviewVisible||!context(this).alive||!this.data.moderationSource||this.data.busy)return;
    if(!getApp<IAppOption>().globalData.sessionToken){this.clearGovernance();requireMemberAccess("/pages/community-review/index?source=moderation");return;}
    const append=more===true;const cursor=append?this.data.governanceCursor:null;if(append&&!cursor)return;
    cancelPageReads(this);const epoch=++this.governanceEpoch,identity=this.governanceIdentity();this.governanceOwner=identity;
    this.setData({loading:true,error:"",permissionDenied:false,...(!append?{governanceItems:[],governanceCursor:null,governanceTotal:null}:{})});
    try{const page=await pageRead<{items:any[];nextCursor:string|null;matchingTotal:number}>(this,{path:`/v1/management/ugc/${this.data.governanceTab}?limit=30${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`});
      const gate=this.data.governanceTab==="appeals"?await pageRead<{publicEnabled:boolean}>(this,{path:"/v1/ugc/status",authMode:"public"}).catch(()=>({publicEnabled:false})):{publicEnabled:false};
      if(!this.governanceCurrent(epoch,identity))return;
      if(!Array.isArray(page.items)||!Number.isSafeInteger(page.matchingTotal))throw Error("INVALID_GOVERNANCE_PAGE");
      const unique=new Map((append?this.data.governanceItems:[]).map(row=>[row.id,row]));for(const row of page.items)unique.set(row.id,row);
      this.setData({governanceItems:[...unique.values()],governanceCursor:page.nextCursor,governanceTotal:page.matchingTotal,governancePublicEnabled:gate.publicEnabled===true,loading:false});
    }catch(error){if(this.governanceCurrent(epoch,identity)){const denied=Number((error as {status?:number})?.status)===403;
      this.setData({loading:false,permissionDenied:denied,error:denied?"当前账号没有社区治理权限":failure(error,"列表暂不可用，请重试"),...(denied?{governanceItems:[],governanceCursor:null,governanceTotal:null}:{})});}
    }finally{if(this.reviewVisible&&this.governanceOwner===identity&&identity!==this.governanceIdentity()){this.clearGovernance();this.setData({error:"登录状态已变化，请重新进入"});}}
  },
  selectGovernance(event:WechatMiniprogram.TouchEvent){const tab=sectionTabValue(event,'tab');if(this.data.busy||!['reports','appeals'].includes(tab)||tab===this.data.governanceTab)return;this.setData({governanceTab:tab as 'reports'|'appeals',notice:""});void this.loadGovernance();},
  moreGovernance(){void this.loadGovernance(true);},
  openGovernanceTarget(event:WechatMiniprogram.TouchEvent){const row=this.data.governanceItems.find(r=>r.id===event.currentTarget.dataset.id);if(this.governanceOwner!==this.governanceIdentity()||!row?.postId||!editorialIdentifier(row.postId))return;wx.navigateTo({url:`/pages/post/index?id=${row.postId}&source=formal`});},
  async decideGovernance(event:WechatMiniprogram.TouchEvent){
    if(this.data.busy||this.data.loading||!this.reviewVisible||this.governanceOwner!==this.governanceIdentity())return;
    const row=this.data.governanceItems.find(r=>r.id===event.currentTarget.dataset.id),decision=String(event.currentTarget.dataset.decision||""),tab=this.data.governanceTab;
    if(!row||!(tab==='reports'?['dismiss',row.targetType==='post'?'hide_post':row.targetType==='comment'?'remove_comment':'']:['restore','uphold']).includes(decision)||!decision)return;
    if(decision==='restore'&&(!this.data.governancePublicEnabled||row.postState!=='hidden'))return;
    const identity=this.governanceIdentity(),epoch=this.governanceEpoch,action=++this.governanceAction,current=()=>action===this.governanceAction&&this.governanceCurrent(epoch,identity);
    this.setData({busy:true,error:"",notice:""});
    try{const title=decision==='restore'?'恢复这篇帖子？':decision==='uphold'?'维持下架？':decision==='dismiss'?'驳回这条举报？':decision==='hide_post'?'下架被举报帖子？':'移除被举报评论？';
      const answer=await wx.showModal({title,editable:true,placeholderText:"填写核查依据（4至500字）",confirmText:"确认处理"});if(!answer.confirm||!current())return;
      const reason=(answer.content||"").trim();if(reason.length<4||reason.length>500){this.setData({error:"请填写4至500字的核查依据"});return;}
      await request({path:`/v1/management/ugc/${tab}/${row.id}/decision`,method:'POST',data:{decision,reason,expectedVersion:row.version,...(tab==='reports'&&decision!=='dismiss'?{expectedTargetVersion:row.targetVersion}:{})}});
      if(!current())return;this.setData({busy:false});wx.showToast({title:"已处理",icon:"success"});await this.loadGovernance();
    }catch(error){if(current()){
      if([401,403].includes(Number((error as {status?:number})?.status)))this.setData({governanceItems:[],governanceCursor:null,governanceTotal:0,permissionDenied:true,error:"当前账号没有举报与申诉处理权限"});
      else this.setData({error:Number((error as {status?:number})?.status)===409?"记录已变化，请刷新核对":failure(error,"结果暂未确认，请刷新核对")});
    }}
    finally{if(current())this.setData({busy:false});else if(this.reviewVisible&&identity!==this.governanceIdentity())this.clearGovernance();}
  },
  back() { wx.navigateBack({ fail: () => this.data.moderationSource?wx.redirectTo({url:"/pages/management-community/index"}):wx.switchTab({ url: "/pages/community/index" }) }); }
});
