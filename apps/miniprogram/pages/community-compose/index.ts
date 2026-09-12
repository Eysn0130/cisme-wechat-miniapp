import { request, resumeAuthentication, uploadAuthorized } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";

type MediaItem = { id: string; localPath: string; previewUrl: string; size: number; state: "uploading" | "uploaded" | "failed"; progress: number; error: string };
type Draft = { id: string; state: string; version: number; title: string; body: string; aiUsage: string;
  rightsConfirmed: boolean; publicConsentConfirmed: boolean; publicVersionActive: boolean; media: Array<{ id: string; state: string }> };
const operationKey = () => `ugc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const localBackupKey="cisme.ugcComposerBackup.v1";
type LocalBackup={ownerSession:string;postId:string;baseVersion:number;title:string;body:string;aiUsage:string;
  rightsConfirmed:boolean;publicConsentConfirmed:boolean;mediaIds:string[];savedAt:number};
function readLocalBackup(token:string,postId:string,version:number):LocalBackup|null{
  try{const value=wx.getStorageSync<LocalBackup|null>(localBackupKey);
    if(value?.ownerSession===token&&value.postId===postId&&value.baseVersion===version&&
      Date.now()-value.savedAt<7*24*60*60_000)return value;
  }catch{/* Server draft remains authoritative when local storage is unavailable. */}
  return null;
}
function clearLocalBackup(token:string,postId:string){
  try{const value=wx.getStorageSync<LocalBackup|null>(localBackupKey);
    if(value?.ownerSession===token&&value.postId===postId)wx.removeStorageSync(localBackupKey);
  }catch{/* No local backup to clear. */}
}
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
  lastSessionToken: "",
  backupTimer: null as ReturnType<typeof setTimeout>|null,
  data: { chromeStyle: currentChromeStyle(), postId: "", state: "draft", publicVersionActive: false, version: 0, title: "", body: "", aiUsage: "none",
    aiOptions: ["未使用 AI", "AI 辅助", "AI 生成", "尚不明确"], aiIndex: 0, rightsConfirmed: false, publicConsentConfirmed: false,
    files: [] as MediaItem[], drafts: [] as Array<{ id: string; title: string; status: string; imageCount: number }>,
    listMode: false, busy: false, uploadBusy: false, loading: true, error: "", notice: "", dirty: false, epoch: 0, createKey: operationKey(),
    requestedDraftId: "", requestedNew: false },
  onLoad(query: Record<string, string | undefined>) {
    this.lastSessionToken=getApp<IAppOption>().globalData.sessionToken;
    this.setData({ listMode: !query.id && query.new !== "1", requestedDraftId: query.id || "", requestedNew: query.new === "1" });
    if (!getApp<IAppOption>().globalData.sessionToken) {
      this.setData({ loading: false, error: "登录后可写自己的护理故事。" });
      resumeAuthentication(query.id ? `/pages/community-compose/index?id=${encodeURIComponent(query.id)}` : "/pages/community-compose/index");
      return;
    }
    if (query.id) void this.loadDraft(query.id);
    else if (query.new === "1") void this.createDraft();
    else void this.loadList();
  },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onShow() {
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(token===this.lastSessionToken)return;
    const wasGuest=!this.lastSessionToken;
    if(this.lastSessionToken&&this.data.postId)clearLocalBackup(this.lastSessionToken,this.data.postId);
    this.lastSessionToken=token;
    this.data.epoch+=1;
    this.setData({postId:"",files:[],drafts:[],title:"",body:"",notice:"",error:"",busy:false,uploadBusy:false,dirty:false,loading:true});
    if(!token){this.setData({loading:false,error:"登录后可写自己的护理故事。"});return;}
    if(wasGuest&&this.data.requestedDraftId)void this.loadDraft(this.data.requestedDraftId);
    else if(wasGuest&&this.data.requestedNew)void this.createDraft();
    else void this.loadList();
  },
  onHide(){this.flushLocalBackup();},
  onUnload() { this.flushLocalBackup();this.data.epoch += 1; },
  queueLocalBackup(){
    if(this.backupTimer)clearTimeout(this.backupTimer);
    this.backupTimer=setTimeout(()=>{this.backupTimer=null;this.flushLocalBackup();},400);
  },
  flushLocalBackup(){
    if(this.backupTimer){clearTimeout(this.backupTimer);this.backupTimer=null;}
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(!this.data.dirty||!this.data.postId||!token||token!==this.lastSessionToken)return;
    const backup:LocalBackup={ownerSession:token,postId:this.data.postId,baseVersion:this.data.version,
      title:this.data.title,body:this.data.body,aiUsage:this.data.aiUsage,rightsConfirmed:this.data.rightsConfirmed,
      publicConsentConfirmed:this.data.publicConsentConfirmed,
      mediaIds:this.data.files.filter(file=>file.state==="uploaded"&&!file.id.startsWith("local-")).map(file=>file.id),savedAt:Date.now()};
    try{wx.setStorageSync(localBackupKey,backup);}catch{this.setData({notice:"本机暂时无法保存未提交的修改，请先点“保存草稿”。"});}
  },
  async loadList() {
    const epoch = ++this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ listMode: true, loading: true, error: "" });
    try {
      const result = await request<{ items: Array<{ id: string; title: string; state: string; imageCount: number }> }>({ path: "/v1/me/ugc/posts" });
      if (epoch !== this.data.epoch || token !== getApp<IAppOption>().globalData.sessionToken) return;
      this.setData({ drafts: result.items.map(item => ({ ...item, status: stateLabel(item.state) })), loading: false });
    } catch (error) { if (epoch === this.data.epoch) this.setData({ loading: false, error: message(error, "我的内容暂时无法加载，请重试。") }); }
  },
  async createDraft() {
    if (this.data.busy) return;
    const epoch = ++this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ busy: true, loading: true, error: "", listMode: false });
    try {
      const draft = await request<Draft>({ path: "/v1/me/ugc/posts", method: "POST", idempotencyKey: this.data.createKey, data: {} });
      if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken) this.applyDraft(draft);
    } catch (error) { if (epoch === this.data.epoch) this.setData({ error: message(error, "新建草稿失败，请重试。"), loading: false }); }
    finally { if (epoch === this.data.epoch) this.setData({ busy: false }); }
  },
  startNew() { this.setData({ createKey: operationKey() }); void this.createDraft(); },
  async loadDraft(id: string) {
    const epoch = ++this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ listMode: false, requestedDraftId:id, postId:"", files:[],title:"",body:"",loading: true, error: "" });
    try {
      const draft = await request<Draft>({ path: `/v1/me/ugc/posts/${id}` });
      if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken) this.applyDraft(draft);
    } catch (error) { if (epoch === this.data.epoch) this.setData({ loading: false, error: message(error, "草稿暂时无法加载，请重试。") }); }
  },
  applyDraft(draft: Draft) {
    const options = ["none", "assisted", "generated", "unknown"];
    const token=getApp<IAppOption>().globalData.sessionToken;
    const backup=["draft","rejected","published"].includes(draft.state)?readLocalBackup(token,draft.id,draft.version):null;
    const mediaIds=backup?.mediaIds??draft.media.map(media=>media.id);
    const aiUsage=backup?.aiUsage??draft.aiUsage;
    this.setData({ postId: draft.id, state: draft.state, publicVersionActive: draft.publicVersionActive, version: draft.version,
      title: backup?.title??draft.title, body: backup?.body??draft.body,
      aiUsage, aiIndex: Math.max(0, options.indexOf(aiUsage)), rightsConfirmed: backup?.rightsConfirmed??draft.rightsConfirmed,
      publicConsentConfirmed: backup?.publicConsentConfirmed??draft.publicConsentConfirmed,
      files: mediaIds.map(id => ({ id, localPath: "", previewUrl: "", size: 0, state: "uploaded" as const, progress: 100, error: "" })),
      loading: false, error: "", dirty: Boolean(backup), notice: backup?"已恢复本机未提交的修改；图片若未显示，请确认后保存草稿。":
        draft.state === "rejected" ? "审核已退回。修改后可以再次提交。" : "" });
    void this.loadMediaPreviews(mediaIds,this.data.epoch,token);
  },
  async loadMediaPreviews(ids: string[], epoch: number, token: string) {
    await Promise.all(ids.map(async id => {
      try {
        const preview = await request<{ url: string }>({ path: `/v1/me/ugc/media/${id}/preview-url` });
        if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken)
          this.updateMedia(id, { previewUrl: preview.url });
      } catch { /* The per-image placeholder remains honest if preview expires or fails. */ }
    }));
  },
  openDraft(event: WechatMiniprogram.TouchEvent) { const id = String(event.currentTarget.dataset.id || ""); if (id) void this.loadDraft(id); },
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
  async uploadImage(id: string, path: string, size: number, epoch: number, token: string) {
    const postId=this.data.postId;
    try {
      const mimeType = await mimeOf(path);
      if(epoch!==this.data.epoch||token!==getApp<IAppOption>().globalData.sessionToken||postId!==this.data.postId)return;
      const authorization = await request<{ mediaId: string; url: string; method: "POST" | "PUT"; fields: Record<string, string> }>({
        path: `/v1/me/ugc/posts/${postId}/media/authorize`, method: "POST", data: { mimeType, maxBytes: size } });
      if (epoch !== this.data.epoch || token !== getApp<IAppOption>().globalData.sessionToken||postId!==this.data.postId) return;
      this.updateMedia(id, { id: authorization.mediaId }); id = authorization.mediaId;
      await uploadAuthorized(path, authorization, { onProgress: progress => {
        if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&postId===this.data.postId)
          this.updateMedia(id,{progress});
      } });
      if(epoch!==this.data.epoch||token!==getApp<IAppOption>().globalData.sessionToken||postId!==this.data.postId)return;
      await request({ path: `/v1/me/ugc/posts/${postId}/media/${id}/complete`, method: "POST", data: {} });
      if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken&&postId===this.data.postId){
        this.updateMedia(id, { state: "uploaded", progress: 100, error: "" });
        this.setData({dirty:true});this.queueLocalBackup();
      }
    } catch (error) {
      if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken&&postId===this.data.postId)
        this.updateMedia(id, { state: "failed", error: message(error, "上传失败，可点重试继续。") });
    }
  },
  async chooseImages() {
    if (!this.data.postId || this.data.uploadBusy || this.data.busy || this.data.files.length >= 9) return;
    const epoch = this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    try {
      const chosen = await wx.chooseMedia({ count: 9 - this.data.files.length, mediaType: ["image"],
        sourceType: ["album", "camera"], sizeType: ["compressed", "original"] });
      if (epoch !== this.data.epoch || token !== getApp<IAppOption>().globalData.sessionToken) return;
      this.setData({ uploadBusy: true, error: "" });
      for (const source of chosen.tempFiles) {
        if (epoch !== this.data.epoch || token !== getApp<IAppOption>().globalData.sessionToken) return;
        if (source.size < 1 || source.size > 10 * 1024 * 1024) { this.setData({ error: "单张图片需小于 10MB，请重新选择。" }); continue; }
        const localPath = source.tempFilePath;
        try { await mimeOf(localPath); } catch { this.setData({ error: "仅支持 JPG、PNG 或 WEBP 图片。" }); continue; }
        const mediaId = `local-${operationKey()}`;
        this.setData({ files: [...this.data.files, { id: mediaId, localPath, previewUrl: "", size: source.size,
          state: "uploading" as const, progress: 0, error: "" }] });
        await this.uploadImage(mediaId,localPath,source.size,epoch,token);
      }
    } catch (error) { if (epoch===this.data.epoch&&!/cancel/i.test((error as { errMsg?: string })?.errMsg || "")) this.setData({ error: "无法选择图片，请检查权限后重试。" }); }
    finally { if (epoch === this.data.epoch) this.setData({ uploadBusy: false }); }
  },
  async retryImage(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id || "");
    const item = this.data.files.find(file => file.id === id);
    if (!item || item.state !== "failed" || !item.localPath || this.data.uploadBusy || this.data.busy) return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({ uploadBusy:true,error:"" });
    this.updateMedia(id,{state:"uploading",progress:0,error:""});
    try { await this.uploadImage(id,item.localPath,item.size,epoch,token); }
    finally { if(epoch===this.data.epoch)this.setData({uploadBusy:false}); }
  },
  removeImage(event: WechatMiniprogram.TouchEvent) {
    if(this.data.busy||this.data.uploadBusy)return;
    const id = String(event.currentTarget.dataset.id || "");
    this.setData({ files: this.data.files.filter(file => file.id !== id), dirty: true });this.queueLocalBackup();
  },
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
    const postId=this.data.postId;
    this.setData({ busy: true, error: "", notice: "" });
    try {
      const draft = await request<Draft>({ path: `/v1/me/ugc/posts/${postId}/draft`, method: "PUT", data: {
        title: this.data.title, body: this.data.body, mediaIds: this.data.files.map(item => item.id), aiUsage: this.data.aiUsage,
        rightsConfirmed: this.data.rightsConfirmed, publicConsentConfirmed: this.data.publicConsentConfirmed, expectedVersion: this.data.version } });
      if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken&&postId===this.data.postId){
        this.setData({ version: draft.version, state: draft.state, publicVersionActive: draft.publicVersionActive, dirty: false, notice: "草稿已保存。" });
        clearLocalBackup(token,postId);
      }
      return draft;
    } catch (error) { if (epoch === this.data.epoch) this.setData({ error: message(error, "草稿未保存，请重试。") }); return null; }
    finally { if (epoch === this.data.epoch) this.setData({ busy: false }); }
  },
  async submit() {
    if (this.data.busy || this.data.uploadBusy || !this.data.postId) return;
    if (!this.data.body.trim() && !this.data.files.length) { this.setData({ error: "请写一点内容，或添加至少一张图片。" }); return; }
    if (!this.data.rightsConfirmed || !this.data.publicConsentConfirmed) { this.setData({ error: "请先确认内容权利和公开展示范围。" }); return; }
    const draft = await this.saveDraft(); if (!draft) return;
    const epoch = this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ busy: true, error: "", notice: "" });
    try {
      const sent = await request<Draft>({ path: `/v1/me/ugc/posts/${draft.id}/submit`, method: "POST", data: { expectedVersion: draft.version } });
      if (epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken)
        this.setData({ state: sent.state, publicVersionActive: sent.publicVersionActive, version: sent.version,
          notice: sent.publicVersionActive ? "新版已提交审核。通过前，公开页面仍显示上一版。" : "已提交审核。通过并完成发布复核后，其他人才能看到。" });
    } catch (error) { if (epoch === this.data.epoch) this.setData({ error: message(error, "提交未完成。草稿已保存，可稍后重试。") }); }
    finally { if (epoch === this.data.epoch) this.setData({ busy: false }); }
  },
  async back() {
    if(this.data.busy||this.data.uploadBusy)return;
    if (this.data.dirty && this.data.postId) {
      const decision = await wx.showModal({ title: "保存刚才的修改？", content: "保存后可以从“我的内容”继续编辑。", confirmText: "保存草稿", cancelText: "继续编辑" });
      if (!decision.confirm) return;
      if (!await this.saveDraft()) return;
    }
    wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/community/index" }) });
  }
});
