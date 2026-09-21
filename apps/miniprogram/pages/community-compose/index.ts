import { pageRead, cancelPageReads } from "../../services/page-requests";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { request, resumeAuthentication, uploadAuthorized } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";
import { clearUgcBackup, readUgcBackup, writeUgcBackup, type UgcLocalBackup } from "../../services/ugc-local-backup";

type MediaItem = { id: string; localPath: string; previewUrl: string; size: number; state: "uploading" | "uploaded" | "failed"; progress: number; error: string };
type Draft = { id: string; ownerId:string; state: string; version: number; title: string; body: string; aiUsage: string;
  rightsConfirmed: boolean; publicConsentConfirmed: boolean; publicVersionActive: boolean; media: Array<{ id: string; state: string }>;
  reviewNote:string|null;reviewedAt:string|null;hiddenReason:string|null;hiddenAt:string|null;
  hiddenPublished:{title:string;body:string}|null;appeal:{id:string;state:string;reason:string;decisionReason:string|null}|null };
const operationKey = () => `ugc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const stateLabel = (state: string) => ({ draft: "草稿", pending_review: "审核中", rejected: "待修改", published: "已发布", hidden: "已下架" }[state] || state);
const message = (error: unknown, fallback: string) => (error as { title?: string })?.title || fallback;

async function mimeOf(path: string): Promise<string> {
  const bytes = await new Promise<Uint8Array>((resolve, reject) => wx.getFileSystemManager().readFile({
    filePath: path, position: 0, length: 12,
    success: result => resolve(new Uint8Array(result.data as ArrayBuffer)), fail: reject
  }));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])) return "image/png";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  throw new Error("仅支持 JPG、PNG 或 WEBP 图片");
}

Page({
  readRevision:commerceContextRevision(),resumeReads:false,gateRead:0,
  lastSessionToken: "",
  shown:false,
  mediaVisible:false,
  mediaEpoch:0,
  mediaAbort:null as (() => void)|null,
  backupTimer: null as ReturnType<typeof setTimeout>|null,
  data: { chromeStyle: currentChromeStyle(), postId: "", ownerId:"", state: "draft", publicVersionActive: false, version: 0, title: "", body: "", aiUsage: "none",
    aiOptions: ["未使用 AI", "AI 辅助", "AI 生成", "尚不明确"], aiIndex: 0, rightsConfirmed: false, publicConsentConfirmed: false,
    files: [] as MediaItem[],sorting:false,drafts: [] as Array<{ id: string; title: string; status: string; state:string;version:number;imageCount: number }>,
    listMode: false, busy: false,operation:"idle", uploadBusy: false, loading: true, error: "", notice: "", dirty: false, epoch: 0, createKey: operationKey(),
    reviewNote:"",reviewedLabel:"",hiddenReason:"",hiddenPublished:null as {title:string;body:string}|null,
    appeal:null as Draft["appeal"],publicGateEnabled:false,
    listTotal:0,listCursor:null as string|null,listLoadingMore:false,listMoreError:"",
    requestedDraftId: "", requestedNew: false },
  onLoad(query: Record<string, string | undefined>) {
    this.lastSessionToken=getApp<IAppOption>().globalData.sessionToken;
    void this.refreshPublicGate();
    this.setData({ listMode: !query.id && query.new !== "1", requestedDraftId: query.id || "", requestedNew: query.new === "1" });
    if (!getApp<IAppOption>().globalData.sessionToken) {
      this.setData({ loading: false, error: "登录后可写自己的护理故事。" });
      resumeAuthentication(query.id ? `/pages/community-compose/index?id=${encodeURIComponent(query.id)}` :
        query.new === "1" ? "/pages/community-compose/index?new=1" : "/pages/community-compose/index");
      return;
    }
    if (query.id) void this.loadDraft(query.id);
    else if (query.new === "1") void this.createDraft();
    else void this.loadList();
  },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onShow() {
    this.mediaVisible=true;
    const revision=commerceContextRevision();
    const token=getApp<IAppOption>().globalData.sessionToken;
    void this.refreshPublicGate();
    if(token===this.lastSessionToken&&revision===this.readRevision){
      if(this.resumeReads){this.resumeReads=false;if(this.data.listMode)void this.loadList();else if((this.data.postId||this.data.requestedDraftId)&&!this.data.dirty)void this.loadDraft(this.data.postId||this.data.requestedDraftId);}
      if(this.shown&&this.data.state==="hidden"&&this.data.postId)void this.loadDraft(this.data.postId);
      this.shown=true;return;}
    this.shown=true;
    const priorPostId=this.data.postId;
    const wasGuest=!this.lastSessionToken;
    this.lastSessionToken=token;this.readRevision=revision;
    this.mediaEpoch+=1;
    this.mediaAbort?.();
    this.mediaAbort=null;
    this.data.epoch+=1;
    this.setData({postId:"",ownerId:"",files:[],drafts:[],listTotal:0,listCursor:null,listLoadingMore:false,listMoreError:"",
      title:"",body:"",notice:"",error:"",busy:false,uploadBusy:false,dirty:false,loading:true});
    if(!token){this.setData({loading:false,error:"登录后可写自己的护理故事。"});return;}
    if(wasGuest&&this.data.requestedDraftId)void this.loadDraft(this.data.requestedDraftId);
    else if(wasGuest&&this.data.requestedNew)void this.createDraft();
    else if(priorPostId)void this.loadDraft(priorPostId);
    else void this.loadList();
  },
  async refreshPublicGate(){
    const attempt=++this.gateRead,revision=commerceContextRevision();
    try{const status=await pageRead<{publicEnabled:boolean}>(this,{path:"/v1/ugc/status",authMode:"public"});
      if(this.mediaVisible&&attempt===this.gateRead&&revision===commerceContextRevision())this.setData({publicGateEnabled:status.publicEnabled===true});}
    catch{if(this.mediaVisible&&attempt===this.gateRead&&revision===commerceContextRevision())this.setData({publicGateEnabled:false});}
  },
  onHide(){
    this.resumeReads=this.data.loading||this.data.listLoadingMore;cancelPageReads(this);
    this.mediaVisible=false;
    this.mediaEpoch+=1;
    this.mediaAbort?.();
    this.mediaAbort=null;
    if(this.data.uploadBusy) this.setData({uploadBusy:false,
      files:this.data.files.map(file=>file.state==="uploading"?{...file,state:"failed" as const,error:"页面离开时上传已中断，可点重试继续。"}:file),
      error:"图片操作已中断；文字草稿仍保留。返回后可重试图片。"});
    this.flushLocalBackup();
  },
  onUnload() { cancelPageReads(this); this.flushLocalBackup();this.mediaVisible=false;this.mediaEpoch+=1;this.mediaAbort?.();this.mediaAbort=null;this.data.epoch += 1; },
  queueLocalBackup(){
    if(this.backupTimer)clearTimeout(this.backupTimer);
    this.backupTimer=setTimeout(()=>{this.backupTimer=null;this.flushLocalBackup();},400);
  },
  flushLocalBackup(){
    if(this.backupTimer){clearTimeout(this.backupTimer);this.backupTimer=null;}
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(!this.data.dirty||!this.data.postId||!this.data.ownerId||!token||token!==this.lastSessionToken)return;
    const backup:UgcLocalBackup={ownerId:this.data.ownerId,postId:this.data.postId,baseVersion:this.data.version,
      title:this.data.title,body:this.data.body,aiUsage:this.data.aiUsage,rightsConfirmed:this.data.rightsConfirmed,
      publicConsentConfirmed:this.data.publicConsentConfirmed,
      mediaIds:this.data.files.filter(file=>file.state==="uploaded"&&!file.id.startsWith("local-")).map(file=>file.id),savedAt:Date.now()};
    try{writeUgcBackup(backup);}catch{this.setData({notice:"本机暂时无法保存未提交的修改，请先点“保存草稿”。"});}
  },
  async loadList() {
    const epoch = ++this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ listMode: true, loading: true, error: "",drafts:[],listTotal:0,listCursor:null,listLoadingMore:false,listMoreError:"" });
    try {
      const result = await pageRead<{ items: Array<{ id: string; title: string; state: string;version:number; imageCount: number }>;matchingTotal:number;nextCursor:string|null }>(this,{ path: "/v1/me/ugc/posts?limit=30" });
      if (!this.mediaVisible || epoch !== this.data.epoch || (token !== getApp<IAppOption>().globalData.sessionToken||this.readRevision!==commerceContextRevision())) return;
      this.setData({ drafts: result.items.map(item => ({ ...item, status: stateLabel(item.state) })),
        listTotal:result.matchingTotal,listCursor:result.nextCursor,loading: false });
    } catch (error) { if (this.mediaVisible && epoch === this.data.epoch) this.setData({ loading: false, error: message(error, "我的内容暂时无法加载，请重试。") }); }
  },
  onReachBottom(){if(this.data.listMode)void this.loadMoreList();},
  async loadMoreList(){
    const cursor=this.data.listCursor;if(!this.data.listMode||!cursor||this.data.listLoadingMore||this.data.loading)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({listLoadingMore:true,listMoreError:""});
    try{const page=await pageRead<{items:Array<{id:string;title:string;state:string;version:number;imageCount:number}>;matchingTotal:number;nextCursor:string|null}>(this,{
      path:`/v1/me/ugc/posts?limit=30&cursor=${encodeURIComponent(cursor)}`});
      if(!this.mediaVisible||epoch!==this.data.epoch||(token!==getApp<IAppOption>().globalData.sessionToken||this.readRevision!==commerceContextRevision())||cursor!==this.data.listCursor)return;
      const seen=new Set(this.data.drafts.map(item=>item.id));
      this.setData({drafts:[...this.data.drafts,...page.items.filter(item=>!seen.has(item.id)).map(item=>({...item,status:stateLabel(item.state)}))],
        listTotal:page.matchingTotal,listCursor:page.nextCursor,listLoadingMore:false});
    }catch(error){if(this.mediaVisible&&epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision())
      this.setData({listLoadingMore:false,listMoreError:message(error,"更多内容暂未加载，请重试。")});}
  },
  async createDraft() {
    if (this.data.busy) return;
    const epoch = ++this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ busy: true,operation:"creating", loading: true, error: "", listMode: false });
    try {
      const draft = await request<Draft>({ path: "/v1/me/ugc/posts", method: "POST", idempotencyKey: this.data.createKey, data: {} });
      if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision()) this.applyDraft(draft);
    } catch (error) { if (epoch === this.data.epoch) this.setData({ error: message(error, "新建草稿失败，请重试。"), loading: false }); }
    finally { if (epoch === this.data.epoch) this.setData({ busy: false,operation:"idle" }); }
  },
  startNew() { this.setData({ createKey: operationKey() }); void this.createDraft(); },
  async loadDraft(id: string) {
    const epoch = ++this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ listMode: false, requestedDraftId:id, postId:"", files:[],title:"",body:"",loading: true, error: "" });
    try {
      const draft = await pageRead<Draft>(this,{ path: `/v1/me/ugc/posts/${id}` });
      if (this.mediaVisible && epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision()) this.applyDraft(draft);
    } catch (error) { if (this.mediaVisible && epoch === this.data.epoch) this.setData({ loading: false, error: message(error, "草稿暂时无法加载，请重试。") }); }
  },
  applyDraft(draft: Draft) {
    const options = ["none", "assisted", "generated", "unknown"];
    const token=getApp<IAppOption>().globalData.sessionToken;
    const backup=["draft","rejected","published"].includes(draft.state)?readUgcBackup(draft.ownerId,draft.id,draft.version):null;
    const mediaIds=backup?.mediaIds??draft.media.map(media=>media.id);
    const aiUsage=backup?.aiUsage??draft.aiUsage;
    this.setData({ postId: draft.id,ownerId:draft.ownerId, state: draft.state, publicVersionActive: draft.publicVersionActive, version: draft.version,
      reviewNote:draft.reviewNote??"",reviewedLabel:draft.reviewedAt?new Date(draft.reviewedAt).toLocaleDateString("zh-CN"):"",
      hiddenReason:draft.hiddenReason??"",hiddenPublished:draft.hiddenPublished??null,appeal:draft.appeal??null,
      title: backup?.title??draft.title, body: backup?.body??draft.body,
      aiUsage, aiIndex: Math.max(0, options.indexOf(aiUsage)), rightsConfirmed: backup?.rightsConfirmed??draft.rightsConfirmed,
      publicConsentConfirmed: backup?.publicConsentConfirmed??draft.publicConsentConfirmed,
      files: mediaIds.map(id => ({ id, localPath: "", previewUrl: "", size: 0, state: "uploaded" as const, progress: 100, error: "" })),sorting:false,
      loading: false, error: "", dirty: Boolean(backup), notice: backup?"已恢复本机未提交的修改；图片若未显示，请确认后保存草稿。":
        draft.state === "rejected" ? "审核已退回。修改后可以再次提交。" : "" });
    void this.loadMediaPreviews(mediaIds,this.data.epoch,token,draft.id);
  },
  async submitAppeal(){
    if(this.data.state!=="hidden"||this.data.appeal||this.data.busy||!this.data.postId)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,
      postId=this.data.postId,version=this.data.version;
    const current=()=>epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision()&&
      this.data.postId===postId&&this.data.version===version&&this.data.state==="hidden"&&!this.data.appeal;
    const answer=await wx.showModal({title:"申请复核下架内容",editable:true,
      placeholderText:"说明你希望复核的事实（至少4字）",confirmText:"提交申诉"});
    if(!answer.confirm||!current())return;
    const appealReason=(answer.content||"").trim();
    if(appealReason.length<4){this.setData({error:"请填写至少4字的申诉理由。"});return;}
    this.setData({busy:true,operation:"appealing",error:""});
    try{if(!current())return;
      await request({path:`/v1/me/ugc/posts/${postId}/appeals`,method:"POST",
        data:{reason:appealReason,expectedVersion:version}});
      if(current()){this.setData({busy:false,operation:"idle",notice:"申诉已提交，等待复核。"});void this.loadDraft(postId);}
    }catch(error){if(current())this.setData({error:message(error,"申诉结果暂未确认，请刷新内容核对。")});}
    finally{if(current())this.setData({busy:false,operation:"idle"});}
  },
  async loadMediaPreviews(ids: string[], epoch: number, token: string,postId:string) {
    await Promise.all(ids.map(async id => {
      try {
        const preview = await pageRead<{ url: string }>(this,{ path: `/v1/me/ugc/posts/${postId}/media/${id}/preview-url` });
        if (this.mediaVisible && epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision())
          this.updateMedia(id, { previewUrl: preview.url });
      } catch { if(this.mediaVisible&&epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision())
        this.updateMedia(id,{error:"图片预览已失效，点此重试。"}); }
    }));
  },
  retryPreview(event:WechatMiniprogram.TouchEvent){const id=String(event.currentTarget.dataset.id||"");
    if(!id||!this.data.postId)return;
    this.updateMedia(id,{error:""});void this.loadMediaPreviews([id],this.data.epoch,getApp<IAppOption>().globalData.sessionToken,this.data.postId);
  },
  previewFailed(event:WechatMiniprogram.TouchEvent){const id=String(event.currentTarget.dataset.id||"");
    if(id)this.updateMedia(id,{localPath:"",previewUrl:"",error:"图片预览已失效，点此重试。"});
  },
  previewImage(event:WechatMiniprogram.TouchEvent){const id=String(event.currentTarget.dataset.id||"");
    const file=this.data.files.find(item=>item.id===id),current=file?.localPath||file?.previewUrl;
    const urls=this.data.files.map(item=>item.localPath||item.previewUrl).filter(Boolean);
    if(current&&urls.length)wx.previewImage({current,urls});
    else if(file?.state==="uploaded")this.retryPreview(event);
  },
  openDraft(event: WechatMiniprogram.TouchEvent) { const id = String(event.currentTarget.dataset.id || ""); if (id) void this.loadDraft(id); },
  async deleteListDraft(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id||""),item=this.data.drafts.find(row=>row.id===id);
    if(!item||!["draft","rejected"].includes(item.state)||this.data.busy)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    const current=()=>epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision()&&
      this.data.drafts.some(row=>row.id===id&&row.version===item.version);
    const decision=await wx.showModal({title:"删除这篇未公开内容？",content:"服务器上的草稿会删除，无法在小程序内恢复。",confirmText:"删除",confirmColor:"#8c354e"});
    if(!decision.confirm||!current())return;
    this.setData({busy:true,error:""});
    try{if(!current())return;
      await request({path:`/v1/me/ugc/posts/${id}`,method:"DELETE",data:{expectedVersion:item.version}});
      if(current()){this.setData({busy:false});void this.loadList();}}
    catch(error){if(current())this.setData({error:message(error,"删除结果暂未确认，请刷新核对。")});}
    finally{if(current())this.setData({busy:false});}
  },
  retryLoad(){if(this.data.requestedDraftId)void this.loadDraft(this.data.requestedDraftId);
    else if(this.data.requestedNew)void this.createDraft();else void this.loadList();},
  editTitle(event: WechatMiniprogram.Input) { this.setData({ title: event.detail.value, dirty: true, notice: "" });this.queueLocalBackup(); },
  editBody(event: WechatMiniprogram.Input) { this.setData({ body: event.detail.value, dirty: true, notice: "" });this.queueLocalBackup(); },
  changeAi(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.detail.value) || 0;
    this.setData({ aiIndex: index, aiUsage: ["none", "assisted", "generated", "unknown"][index] || "none", dirty: true });this.queueLocalBackup();
  },
  changeRights(event: WechatMiniprogram.SwitchChange) { this.setData({ rightsConfirmed: event.detail.value, dirty: true });this.queueLocalBackup(); },
  changeConsent(event: WechatMiniprogram.SwitchChange) { this.setData({ publicConsentConfirmed: event.detail.value, dirty: true });this.queueLocalBackup(); },
  updateMedia(id: string, patch: Partial<MediaItem>) {
    this.setData({ files: this.data.files.map(file => file.id === id ? { ...file, ...patch } : file) });
  },
  async uploadImage(id: string, path: string, size: number, epoch: number, token: string, mediaEpoch: number) {
    const postId=this.data.postId;
    const current=()=>this.mediaVisible&&mediaEpoch===this.mediaEpoch&&epoch===this.data.epoch&&
      token===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision()&&postId===this.data.postId;
    try {
      const mimeType = await mimeOf(path);
      if(!current())return;
      const authorization = await request<{ mediaId: string; url: string; method: "POST" | "PUT"; fields: Record<string, string> }>({
        path: `/v1/me/ugc/posts/${postId}/media/authorize`, method: "POST", data: { mimeType, maxBytes: size } });
      if (!current()) return;
      this.updateMedia(id, { id: authorization.mediaId }); id = authorization.mediaId;
      await uploadAuthorized(path, authorization, { registerAbort: abort=>{if(current())this.mediaAbort=abort;else abort();},onProgress: progress => {
        if(current())
          this.updateMedia(id,{progress});
      } });
      if(!current())return;
      await request({ path: `/v1/me/ugc/posts/${postId}/media/${id}/complete`, method: "POST", data: {} });
      if(current()){
        this.updateMedia(id, { state: "uploaded", progress: 100, error: "" });
        this.setData({dirty:true});this.queueLocalBackup();
        void this.loadMediaPreviews([id],epoch,token,postId);
      }
    } catch (error) {
      if(current())
        this.updateMedia(id, { state: "failed", error: message(error, "上传失败，可点重试继续。") });
    } finally {if(current())this.mediaAbort=null;}
  },
  async chooseImages() {
    if (!this.data.postId || this.data.uploadBusy || this.data.busy || this.data.files.length >= 9) return;
    const epoch = this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    const mediaEpoch=++this.mediaEpoch;
    const current=()=>this.mediaVisible&&mediaEpoch===this.mediaEpoch&&epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision();
    this.setData({uploadBusy:true,error:""});
    try {
      await new Promise<void>((resolve,reject)=>wx.requirePrivacyAuthorize({success:()=>resolve(),fail:reject}));
      if(!current())return;
      const chosen = await wx.chooseMedia({ count: 9 - this.data.files.length, mediaType: ["image"],
        sourceType: ["album", "camera"], sizeType: ["compressed", "original"] });
      if(!current())return;
      for (const source of chosen.tempFiles) {
        if(!current())return;
        if (source.size < 1 || source.size > 10 * 1024 * 1024) { this.setData({ error: "单张图片需小于 10MB，请重新选择。" }); continue; }
        const localPath = source.tempFilePath;
        try { await mimeOf(localPath); } catch { if(current())this.setData({ error: "仅支持 JPG、PNG 或 WEBP 图片。" }); continue; }
        if(!current())return;
        const mediaId = `local-${operationKey()}`;
        this.setData({ files: [...this.data.files, { id: mediaId, localPath, previewUrl: "", size: source.size,
          state: "uploading" as const, progress: 0, error: "" }] });
        await this.uploadImage(mediaId,localPath,source.size,epoch,token,mediaEpoch);
      }
    } catch (error) { if(current()&&!/cancel/i.test((error as { errMsg?: string })?.errMsg || "")) this.setData({ error: "未能选择图片，请检查微信隐私授权或相册权限后重试；文字草稿仍保留。" }); }
    finally { if(current()) this.setData({ uploadBusy: false }); }
  },
  async retryImage(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id || "");
    const item = this.data.files.find(file => file.id === id);
    if (!item || item.state !== "failed" || !item.localPath || this.data.uploadBusy || this.data.busy) return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,mediaEpoch=++this.mediaEpoch;
    const current=()=>this.mediaVisible&&mediaEpoch===this.mediaEpoch&&epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision();
    this.setData({ uploadBusy:true,error:"" });
    try {
      await new Promise<void>((resolve,reject)=>wx.requirePrivacyAuthorize({success:()=>resolve(),fail:reject}));
      if(!current())return;
      this.updateMedia(id,{state:"uploading",progress:0,error:""});
      await this.uploadImage(id,item.localPath,item.size,epoch,token,mediaEpoch);
    }catch(error){if(current()&&!/cancel/i.test((error as {errMsg?:string})?.errMsg||""))this.updateMedia(id,{state:"failed",error:"需要完成微信隐私授权后才能重试图片；文字草稿仍保留。"});}
    finally { if(current())this.setData({uploadBusy:false}); }
  },
  removeImage(event: WechatMiniprogram.TouchEvent) {
    if(this.data.busy||this.data.uploadBusy)return;
    const id = String(event.currentTarget.dataset.id || "");
    const files=this.data.files.filter(file => file.id !== id);
    this.setData({ files,sorting:files.length>1&&this.data.sorting, dirty: true });this.queueLocalBackup();
  },
  toggleSorting(){if(this.data.busy||this.data.uploadBusy||this.data.files.length<2)return;
    this.setData({sorting:!this.data.sorting});},
  moveImage(event: WechatMiniprogram.TouchEvent) {
    if(this.data.busy||this.data.uploadBusy)return;
    const id = String(event.currentTarget.dataset.id || ""), direction = Number(event.currentTarget.dataset.direction);
    const items = [...this.data.files], index = items.findIndex(item => item.id === id), next = index + direction;
    if (index < 0 || next < 0 || next >= items.length) return;
    [items[index], items[next]] = [items[next]!, items[index]!];
    this.setData({ files: items, dirty: true });this.queueLocalBackup();
  },
  async saveDraft(): Promise<Draft | null> {
    if (!this.data.postId || this.data.busy || this.data.uploadBusy) return null;
    if (this.data.files.some(item => item.state !== "uploaded")) { this.setData({ error: "有图片还没上传完成，请移除失败图片或稍后重试。" }); return null; }
    const epoch = this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    const postId=this.data.postId,baseVersion=this.data.version,ownerId=this.data.ownerId;
    this.setData({ busy: true,operation:"saving", error: "", notice: "" });
    try {
      const draft = await request<Draft>({ path: `/v1/me/ugc/posts/${postId}/draft`, method: "PUT", data: {
        title: this.data.title, body: this.data.body, mediaIds: this.data.files.map(item => item.id), aiUsage: this.data.aiUsage,
        rightsConfirmed: this.data.rightsConfirmed, publicConsentConfirmed: this.data.publicConsentConfirmed, expectedVersion: baseVersion } });
      if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision()&&postId===this.data.postId){
        this.setData({ version: draft.version, state: draft.state, publicVersionActive: draft.publicVersionActive, dirty: false, notice: "草稿已保存。" });
        clearUgcBackup(ownerId,postId,baseVersion);
      }
      return draft;
    } catch (error) { if (epoch === this.data.epoch) this.setData({ error: message(error, "草稿未保存，请重试。") }); return null; }
    finally { if (epoch === this.data.epoch) this.setData({ busy: false,operation:"idle" }); }
  },
  async submit() {
    if (this.data.busy || this.data.uploadBusy || !this.data.postId) return;
    if(!this.data.publicGateEnabled){this.setData({error:"公开投稿暂未开放；你仍可保存私人草稿。"});return;}
    if (!this.data.body.trim() && !this.data.files.length) { this.setData({ error: "请写一点内容，或添加至少一张图片。" }); return; }
    if (!this.data.rightsConfirmed || !this.data.publicConsentConfirmed) { this.setData({ error: "请先确认内容权利和公开展示范围。" }); return; }
    const draft = await this.saveDraft(); if (!draft) return;
    const epoch = this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ busy: true,operation:"submitting", error: "", notice: "" });
    try {
      const sent = await request<Draft>({ path: `/v1/me/ugc/posts/${draft.id}/submit`, method: "POST", data: { expectedVersion: draft.version } });
      if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision())
        this.setData({ state: sent.state, publicVersionActive: sent.publicVersionActive, version: sent.version,
          notice: sent.publicVersionActive ? "新版已提交审核。通过前，公开页面仍显示上一版。" : "已提交审核。通过并完成发布复核后，其他人才能看到。" });
    } catch (error) { if (epoch === this.data.epoch) this.setData({ error: message(error, "提交未完成。草稿已保存，可稍后重试。") }); }
    finally { if (epoch === this.data.epoch) this.setData({ busy: false,operation:"idle" }); }
  },
  async back() {
    if(this.data.busy||this.data.uploadBusy)return;
    if (this.data.dirty && this.data.postId) {
      const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
      const options=await wx.showActionSheet({itemList:["保存草稿后离开","继续编辑","不保存本机修改并离开"]}).catch(()=>null);
      if(!options||epoch!==this.data.epoch||(token!==getApp<IAppOption>().globalData.sessionToken||this.readRevision!==commerceContextRevision()))return;
      if(options.tapIndex===1)return;
      if(options.tapIndex===0){if(!await this.saveDraft())return;}
      else if(options.tapIndex===2){clearUgcBackup(this.data.ownerId,this.data.postId,this.data.version);this.setData({dirty:false});}
      else return;
    }
    wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/community/index" }) });
  }
});
