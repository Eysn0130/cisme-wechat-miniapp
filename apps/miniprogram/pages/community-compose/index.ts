import { pageRead, cancelPageReads } from "../../services/page-requests";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { request, resumeAuthentication, uploadAuthorized } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";
import { clearUgcBackup, readUgcBackup, writeUgcBackup, type UgcLocalBackup } from "../../services/ugc-local-backup";
import { consumeComposeMediaIntent, type ComposeMediaIntentPayload } from "../../services/community-compose-intent";
import { editUgcLocalImage, ugcImageEditCapabilities } from "../../services/ugc-image-edit";
import { hasTextCardContent, normalizeTextCardTemplate, normalizeTextCardText, textCardGraphemes, type TextCardTemplate } from "../../services/ugc-text-card-layout";

type MediaItem = { id: string; localPath: string; previewUrl: string; size: number; state: "uploading" | "uploaded" | "failed"; progress: number; error: string };
type Draft = { id: string; ownerId:string; state: string; version: number; title: string; body: string;
  revision?:number;publishedRevision?:number|null;moderationState?:string;revisionState?:string;
  publicVersionActive: boolean; media: Array<{ id: string; state: string }>;
  reviewNote:string|null;reviewedAt:string|null;hiddenReason:string|null;hiddenAt:string|null;
  hiddenPublished:{title:string;body:string}|null;appeal:{id:string;state:string;reason:string;decisionReason:string|null}|null };
const operationKey = () => `ugc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const stateLabel = (state: string) => ({ draft: "草稿", pending_review: "审核中", awaiting_publication:"待发布复核", rejected: "待修改", published: "已发布", hidden: "已下架" }[state] || state);
const message = (error: unknown, fallback: string) => (error as { title?: string })?.title || fallback;
const imageEditPendingError="请先重试使用修改后的图片，或放弃本次图片修改。";
type DraftSnapshot={title:string;body:string;mediaIds:string[]};
type PendingWrite={kind:"save"|"submit";postId:string;ownerId:string;version:number;epoch:number;token:string;revision:number;snapshot:DraftSnapshot};
type PublishedReturn={postId:string;ownerId:string;epoch:number;token:string;revision:number};
type TextCardContext={key:string;postId:string;ownerId:string;version:number;epoch:number;token:string;revision:number;origin:"entry"|"editor";entryNonce:string};
type LocalTextEntry={nonce:string;epoch:number;token:string;revision:number;createKey:string};
type LocalTextCandidate={scope:LocalTextEntry;kind:"card"|"body"|"save";text:string;template:TextCardTemplate;file:{path:string;size:number}|null;sent:boolean;draft:Draft|null};
type TextCardImport={postId:string;ownerId:string;version:number;epoch:number;token:string;revision:number;file:{path:string;size:number}};
type PhotoEditorContext={key:string;postId:string;ownerId:string;epoch:number;token:string;revision:number;origin:"entry"|"editor"|"single";targetId:string;basePath:string};
type ImageEditCandidate={key:string;postId:string;ownerId:string;epoch:number;token:string;revision:number;version:number;targetId:string;path:string;size:number;error:string};
type MediaRect={left:number;top:number;width:number;height:number};
type MediaPress={id:string;pointer:number;startX:number;startY:number;x:number;y:number;epoch:number;postId:string;ownerId:string;version:number;token:string;revision:number;signature:string;wantsDrag:boolean;rects:MediaRect[];viewport:MediaRect|null;scrollLeft:number;scrollWidth:number};
type MediaDrag=MediaPress&{index:number;target:number;drawnTarget:number;offsetX:number;offsetY:number;originScroll:number;dropping:boolean};
const mediaSignature=(files:MediaItem[])=>files.map(file=>`${file.id}:${file.localPath}:${file.previewUrl}:${file.state}`).join("|");
const unknownWrite=(error:unknown)=>{const value=error as {status?:number;code?:string};return !value?.status||value.status>=500||value.code==="UGC_VERSION_CONFLICT"||value.code==="UGC_POST_LOCKED";};
const sameDraft=(draft:Draft,snapshot:DraftSnapshot)=>draft.title.trim()===snapshot.title.trim()&&draft.body.trim()===snapshot.body.trim()&&
  draft.media.map(item=>item.id).join(",")===snapshot.mediaIds.join(",");

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
  openingNew:false,
  mediaEpoch:0,
  mediaAbort:null as (() => void)|null,
  pageAlive:true,
  nativeMedia:"" as ""|"choose"|"preview"|"edit"|"privacy"|"settings",
  pendingInitialMedia:null as ComposeMediaIntentPayload|null,
  pendingMediaOrigin:"entry" as "entry"|"editor"|"single",
  pendingMediaTargetId:"",pendingMediaBasePath:"",
  initialTextEntry:false,
  localTextEntry:null as LocalTextEntry|null,
  pendingLocalText:null as LocalTextCandidate|null,
  pendingTextImport:null as TextCardImport|null,
  resumeTextCard:null as "entry"|"editor"|null,
  textCardInputInitialized:false,
  createdHerePostId:"",
  textCardOpenContext:null as TextCardContext|null,
  photoEditorOpenContext:null as PhotoEditorContext|null,
  pendingImageEdit:null as ImageEditCandidate|null,
  mediaReturn:null as (()=>void)|null,
  pendingWrite:null as PendingWrite|null,
  publishedReturn:null as PublishedReturn|null,
  publishedReturnAttempt:0,
  backupTimer: null as ReturnType<typeof setTimeout>|null,
  mediaPress:null as MediaPress|null,mediaDrag:null as MediaDrag|null,
  mediaDragTimer:null as ReturnType<typeof setTimeout>|null,mediaMoveTimer:null as ReturnType<typeof setTimeout>|null,mediaEdgeTimer:null as ReturnType<typeof setInterval>|null,
  mediaScrollPosition:0,mediaTapBlockedUntil:0,
  data: { chromeStyle: currentChromeStyle(), postId: "", ownerId:"", state: "draft", publicVersionActive: false, version: 0, title: "", body: "",
    textCardVisible:false,textCardContext:"",textCardText:"",textCardHandoffPath:"",textCardTemplate:"plain" as TextCardTemplate,photoEditorVisible:false,photoEditorAdditional:false,photoEditorContext:"",photoEditorFiles:[] as Array<{path:string;size:number}>,
    files: [] as MediaItem[],mediaDragging:false,mediaDragId:"",mediaDragSource:"",mediaDragLeft:0,mediaDragTop:0,mediaDragSize:0,mediaDragDropping:false,mediaDragOffsets:[] as number[],mediaScrollLeft:0,
    drafts: [] as Array<{ id: string; title: string; status: string; state:string;version:number;imageCount: number;publicVersionActive?:boolean }>,
    listMode: false, busy: false,operation:"idle", uploadBusy: false, loading: true, error: "", notice: "", dirty: false, epoch: 0, createKey: "",
    writeRecovery:"" as ""|"save"|"submit"|"conflict",recoveryBusy:false,draftsEnabled:false,keyboardVisible:false,bodyFocused:false,imageEditingId:"",imageEditRecovery:false,imageEditRecoveryKey:"",mediaRecovery:"",lastMediaSource:"album" as "album"|"camera",
    reviewNote:"",reviewedLabel:"",hiddenReason:"",hiddenPublished:null as {title:string;body:string}|null,
    appeal:null as Draft["appeal"],publicGateEnabled:false,publicGateLoaded:false,publicGateUnknown:false,
    listTotal:0,listCursor:null as string|null,listLoadingMore:false,listMoreError:"",
    draftFilter:"all",draftFilters:[{value:"all",label:"全部"},{value:"draft",label:"草稿"},{value:"pending_review",label:"审核中"},{value:"awaiting_publication",label:"待发布复核"},{value:"rejected",label:"待修改"},{value:"published",label:"已发布"},{value:"hidden",label:"已下架"}],
    requestedDraftId: "", requestedNew: false },
  onLoad(query: Record<string, string | undefined>) {
    this.pageAlive=true;
    this.readRevision=commerceContextRevision();
    this.lastSessionToken=getApp<IAppOption>().globalData.sessionToken;
    this.pendingInitialMedia=null;this.initialTextEntry=query.new==="1"&&!query.id&&query.entry==="text";
    if(query.intent){const selected=consumeComposeMediaIntent(query.intent,{sessionToken:this.lastSessionToken,revision:this.readRevision});
      this.pendingInitialMedia=query.new==="1"&&!query.id?selected:null;
      if(!this.pendingInitialMedia){this.setData({loading:false,error:"本次选择已失效，请返回社区重新选择。",requestedNew:false});return;}}
    if(query.new!=="1")void this.refreshPublicGate();
    this.setData({ createKey:operationKey(),listMode: !query.id && query.new !== "1", requestedDraftId: query.id || "", requestedNew: query.new === "1" });
    if(this.initialTextEntry&&this.lastSessionToken)this.localTextEntry={nonce:operationKey(),epoch:this.data.epoch,token:this.lastSessionToken,revision:this.readRevision,createKey:this.data.createKey};
    if (!getApp<IAppOption>().globalData.sessionToken) {
      this.setData({ loading: false, error: "登录后可写自己的护理故事。" });
      resumeAuthentication(query.id ? `/pages/community-compose/index?id=${encodeURIComponent(query.id)}` :
        query.new === "1" ? `/pages/community-compose/index?new=1${this.initialTextEntry?"&entry=text":""}` : "/pages/community-compose/index");
      return;
    }
    if (query.id) void this.loadDraft(query.id);
    else if (query.new === "1") void this.openNewIfAvailable();
    else void this.loadList();
  },
  onResize() { this.cancelMediaDrag();this.setData({ chromeStyle: currentChromeStyle() }); },
  onShow() {
    this.mediaVisible=true;
    const revision=commerceContextRevision();
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(token===this.lastSessionToken&&revision===this.readRevision){
      this.mediaReturn?.();this.mediaReturn=null;
      if(this.nativeMedia==="preview")this.nativeMedia="";
      if(!this.data.requestedNew)void this.refreshPublicGate();
      else if(token&&!this.openingNew&&!this.data.busy&&!this.data.error&&!this.pendingLocalText)void this.openNewIfAvailable();
      if(this.publishedReturn)void this.refreshAfterPublishedReturn();
      if(this.pendingWrite&&this.data.writeRecovery&&!this.data.recoveryBusy)void this.verifyWriteResult();
      if(this.pendingInitialMedia&&this.data.postId&&!this.data.busy&&!this.data.uploadBusy&&!this.data.photoEditorVisible)void this.importInitialMedia();
      if(this.pendingLocalText?.draft&&this.localTextEntryIsCurrent())void this.materializeLocalText(this.pendingLocalText);
      else if(this.pendingLocalText&&this.localTextEntryIsCurrent()&&!this.data.busy&&!this.data.error)this.setData({error:this.pendingLocalText.sent?"新建结果待确认，请重试核对同一篇草稿。":"准备已暂停，请重试继续。"});
      if(this.pendingTextImport)void this.importPendingTextCard();
      if(this.resumeTextCard&&!this.data.busy&&!this.data.uploadBusy&&!this.pendingLocalText){const origin=this.resumeTextCard;this.resumeTextCard=null;this.openTextCard(origin);}
      if(this.resumeReads){this.resumeReads=false;if(this.data.listMode)void this.loadList();else if((this.data.postId||this.data.requestedDraftId)&&!this.data.dirty)void this.loadDraft(this.data.postId||this.data.requestedDraftId);}
      if(this.shown&&this.data.state==="hidden"&&this.data.postId&&!this.data.dirty)void this.loadDraft(this.data.postId);
      const readonly=["pending_review","awaiting_publication"].includes(this.data.state);
      const previews=this.data.files.filter(item=>item.state==="uploaded"&&!item.previewUrl&&(readonly||!item.localPath)).map(item=>item.id);
      if(previews.length&&this.data.postId)void this.loadMediaPreviews(previews,this.data.epoch,token,this.data.postId);
      this.shown=true;return;}
    this.shown=true;
    const wasGuest=!this.lastSessionToken;
    const resumeInitialText=wasGuest&&this.initialTextEntry&&this.data.requestedNew;
    this.cancelMediaDrag();
    this.clearPendingImageEdit();
    this.lastSessionToken=token;this.readRevision=revision;
    this.nativeMedia="";this.mediaReturn?.();this.mediaReturn=null;this.pendingWrite=null;
    this.pendingInitialMedia=null;this.pendingMediaOrigin="entry";this.pendingMediaTargetId="";this.pendingMediaBasePath="";this.initialTextEntry=false;this.localTextEntry=null;this.pendingLocalText=null;this.pendingTextImport=null;this.resumeTextCard=null;this.textCardInputInitialized=false;this.createdHerePostId="";this.textCardOpenContext=null;this.photoEditorOpenContext=null;
    this.publishedReturn=null;this.publishedReturnAttempt+=1;
    this.mediaEpoch+=1;
    this.mediaAbort?.();
    this.mediaAbort=null;
    this.data.epoch+=1;
    this.setData({postId:"",ownerId:"",version:0,files:[],drafts:[],listTotal:0,listCursor:null,listLoadingMore:false,listMoreError:"",
      title:"",body:"",notice:"",error:"",busy:false,uploadBusy:false,dirty:false,loading:true,writeRecovery:"",recoveryBusy:false,
      createKey:operationKey(),textCardVisible:false,textCardContext:"",textCardText:"",textCardHandoffPath:"",textCardTemplate:"plain",photoEditorVisible:false,photoEditorContext:"",photoEditorFiles:[],mediaRecovery:"",imageEditingId:"",bodyFocused:false});
    if(!token){this.setData({loading:false,error:"登录后可写自己的护理故事。"});return;}
    if(resumeInitialText){this.initialTextEntry=true;this.localTextEntry={nonce:operationKey(),epoch:this.data.epoch,token,revision,createKey:this.data.createKey};}
    if(wasGuest&&this.data.requestedDraftId)void this.loadDraft(this.data.requestedDraftId);
    else if(wasGuest&&this.data.requestedNew&&!this.openingNew)void this.openNewIfAvailable();
    else void this.loadList();
  },
  async refreshPublicGate(){
    const attempt=++this.gateRead,revision=commerceContextRevision();
    this.setData({publicGateEnabled:false,draftsEnabled:false,publicGateLoaded:false,publicGateUnknown:false});
    try{const status=await pageRead<{publicEnabled:boolean;draftsEnabled?:boolean}>(this,{path:"/v1/ugc/status",authMode:"public"});
      if(this.mediaVisible&&attempt===this.gateRead&&revision===commerceContextRevision())this.setData({publicGateEnabled:status.publicEnabled===true,draftsEnabled:status.draftsEnabled===true,publicGateLoaded:true,publicGateUnknown:false});}
    catch{if(this.mediaVisible&&attempt===this.gateRead&&revision===commerceContextRevision())this.setData({publicGateEnabled:false,publicGateLoaded:true,publicGateUnknown:true});}
  },
  async openNewIfAvailable(){
    if(this.openingNew)return;
    this.openingNew=true;
    const token=getApp<IAppOption>().globalData.sessionToken,revision=commerceContextRevision(),attempt=++this.gateRead;
    let enabled=false,draftsEnabled=false,unknown=false;
    try{const status=await pageRead<{publicEnabled:boolean;draftsEnabled?:boolean}>(this,{path:"/v1/ugc/status",authMode:"public"});
      enabled=status.publicEnabled===true;draftsEnabled=status.draftsEnabled===true;
    }catch{unknown=true;}
    if(attempt===this.gateRead)this.openingNew=false;
    if(!this.mediaVisible||attempt!==this.gateRead||token!==getApp<IAppOption>().globalData.sessionToken||revision!==commerceContextRevision())return;
    this.setData({publicGateEnabled:enabled,draftsEnabled,publicGateLoaded:true,publicGateUnknown:unknown});
    if(this.localTextEntryIsCurrent()){
      this.initialTextEntry=false;this.setData({loading:false,listMode:false,error:draftsEnabled?"":unknown?"草稿能力暂未确认，输入仍保留，请稍后重试。":"当前暂不能新建草稿，输入仍保留在本页。"});
      if((draftsEnabled||this.data.dirty)&&!this.pendingLocalText)this.openTextCard("entry");return;}
    if(draftsEnabled){void this.createDraft();return;}
    // The list introduction already explains the closed public-submission state.
    this.setData({requestedNew:false,listMode:true,loading:false,notice:""});
    void this.loadList();
  },
  onHide(){
    this.cancelMediaDrag();
    if(this.textCardOpenContext&&this.textCardContextIsCurrent(this.textCardOpenContext.key,true))this.resumeTextCard=this.textCardOpenContext.origin;
    this.textCardOpenContext=null;
    const nativePhoto=this.data.photoEditorVisible&&this.nativeMedia==="edit";
    if(!nativePhoto)this.photoEditorOpenContext=null;
    this.setData({keyboardVisible:false,bodyFocused:false,textCardVisible:false,photoEditorVisible:nativePhoto});
    this.publishedReturnAttempt+=1;
    if(this.publishedReturn)this.setData({recoveryBusy:false});
    this.resumeReads=!this.nativeMedia&&!this.pendingWrite&&(this.data.loading||this.data.listLoadingMore);cancelPageReads(this);
    this.gateRead+=1;this.openingNew=false;
    this.mediaVisible=false;
    if(this.pendingWrite)this.setData({busy:false,writeRecovery:this.pendingWrite.kind});
    else if(this.data.busy&&this.data.operation!=="creating"){this.resumeReads=true;this.setData({busy:false,operation:"idle"});}
    if(this.nativeMedia){this.flushLocalBackup();return;}
    this.mediaEpoch+=1;
    this.mediaAbort?.();
    this.mediaAbort=null;
    if(this.pendingImageEdit)this.setData({imageEditingId:""});
    if(this.data.uploadBusy) this.setData({uploadBusy:false,
      files:this.data.files.map(file=>file.state==="uploading"?{...file,state:"failed" as const,error:"页面离开时上传已中断，可点重试继续。"}:file),
      error:"图片操作已中断；文字草稿仍保留。返回后可重试图片。"});
    this.flushLocalBackup();
  },
  onUnload() { this.cancelMediaDrag();cancelPageReads(this); this.flushLocalBackup();this.pendingImageEdit=null;this.pendingInitialMedia=null;this.initialTextEntry=false;this.localTextEntry=null;this.pendingLocalText=null;this.pendingTextImport=null;this.resumeTextCard=null;this.textCardOpenContext=null;this.photoEditorOpenContext=null;this.data.textCardHandoffPath="";this.pageAlive=false;this.mediaVisible=false;this.nativeMedia="";this.mediaEpoch+=1;this.mediaAbort?.();this.mediaAbort=null;this.mediaReturn?.();this.mediaReturn=null;this.publishedReturn=null;this.publishedReturnAttempt+=1;this.data.epoch += 1; },
  queueLocalBackup(){
    if(this.data.dirty&&this.data.notice==="草稿已保存。")this.setData({notice:""});
    this.syncUnloadWarning();
    if(this.backupTimer)clearTimeout(this.backupTimer);
    this.backupTimer=setTimeout(()=>{this.backupTimer=null;this.flushLocalBackup();},400);
  },
  syncUnloadWarning(){
    if(this.localTextEntry&&this.data.dirty){if(typeof wx.enableAlertBeforeUnload==="function")wx.enableAlertBeforeUnload({message:"文字仅保留在当前页面，离开前请先保存。"});return;}
    if(this.pendingImageEdit){if(typeof wx.enableAlertBeforeUnload==="function")wx.enableAlertBeforeUnload({message:"图片修改尚未应用，请先重试或放弃本次修改。"});return;}
    if(this.pendingInitialMedia){if(typeof wx.enableAlertBeforeUnload==="function")wx.enableAlertBeforeUnload({message:"照片尚未保存，请先完成图片编辑并存草稿。"});return;}
    if(this.data.dirty){if(typeof wx.enableAlertBeforeUnload==="function")wx.enableAlertBeforeUnload({message:["draft","rejected","published"].includes(this.data.state)?"本次修改尚未保存，请先保存草稿。":"修改尚未保存，请先保留需要的内容。"});}
    else if(typeof wx.disableAlertBeforeUnload==="function")wx.disableAlertBeforeUnload();
  },
  flushLocalBackup(){
    if(this.backupTimer){clearTimeout(this.backupTimer);this.backupTimer=null;}
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(!this.data.dirty)return true;
    if(!this.data.postId||!this.data.ownerId||!token||token!==this.lastSessionToken)return false;
    const backup:UgcLocalBackup={ownerId:this.data.ownerId,postId:this.data.postId,baseVersion:this.data.version,
      title:this.data.title,body:this.data.body,...(this.textCardInputInitialized?{textCardText:this.data.textCardText}:{}),textCardTemplate:this.data.textCardTemplate,
      mediaIds:this.data.files.filter(file=>file.state==="uploaded"&&!file.id.startsWith("local-")).map(file=>file.id),
      mediaItems:this.data.files.map(file=>({id:file.id,localPath:file.localPath,size:file.size,state:file.state==="uploaded"?"uploaded":"failed",error:file.state==="uploaded"?"":file.error||"图片上传已中断，可重试或重新选择。"})),savedAt:Date.now()};
    try{writeUgcBackup(backup);return true;}catch{this.setData({notice:"本次修改尚未保存，请点击“存草稿”。"});return false;}
  },
  clearLocalTextEntryScope(){
    const hadLocalCommand=Boolean(this.localTextEntry||this.pendingLocalText||this.pendingTextImport);
    this.localTextEntry=null;this.pendingLocalText=null;this.pendingTextImport=null;this.resumeTextCard=null;this.initialTextEntry=false;this.textCardOpenContext=null;this.textCardInputInitialized=false;
    this.setData({textCardVisible:false,textCardContext:"",textCardText:"",textCardHandoffPath:"",textCardTemplate:"plain",...(hadLocalCommand?{busy:false,operation:"idle"}:{})});
  },
  async loadList() {
    const epoch = ++this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    this.clearLocalTextEntryScope();
    const filter=this.data.draftFilter;
    this.setData({ listMode: true, loading: true, error: "",textCardHandoffPath:"",drafts:[],listTotal:0,listCursor:null,listLoadingMore:false,listMoreError:"" });
    try {
      const result = await pageRead<{ items: Array<{ id: string; title: string; state: string;version:number; imageCount: number;publicVersionActive?:boolean }>;matchingTotal:number;nextCursor:string|null }>(this,{ path: `/v1/me/ugc/posts?limit=30&state=${encodeURIComponent(filter)}` });
      if (!this.mediaVisible || epoch !== this.data.epoch || (token !== getApp<IAppOption>().globalData.sessionToken||this.readRevision!==commerceContextRevision())) return;
      this.setData({ drafts: result.items.map(item => ({ ...item, status: stateLabel(item.state) })),
        listTotal:result.matchingTotal,listCursor:result.nextCursor,loading: false });
    } catch (error) { if (this.mediaVisible && epoch === this.data.epoch) this.setData({ loading: false, error: message(error, "我的内容暂时无法加载，请重试。") }); }
  },
  selectDraftFilter(event:WechatMiniprogram.TouchEvent){const state=String(event.currentTarget.dataset.state||"");
    if(this.data.busy||!this.data.draftFilters.some(item=>item.value===state)||state===this.data.draftFilter)return;
    this.setData({draftFilter:state});void this.loadList();},
  onReachBottom(){if(this.data.listMode)void this.loadMoreList();},
  async loadMoreList(){
    const cursor=this.data.listCursor;if(!this.data.listMode||!cursor||this.data.listLoadingMore||this.data.loading)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({listLoadingMore:true,listMoreError:""});
    try{const page=await pageRead<{items:Array<{id:string;title:string;state:string;version:number;imageCount:number;publicVersionActive?:boolean}>;matchingTotal:number;nextCursor:string|null}>(this,{
      path:`/v1/me/ugc/posts?limit=30&state=${encodeURIComponent(this.data.draftFilter)}&cursor=${encodeURIComponent(cursor)}`});
      if(!this.mediaVisible||epoch!==this.data.epoch||(token!==getApp<IAppOption>().globalData.sessionToken||this.readRevision!==commerceContextRevision())||cursor!==this.data.listCursor)return;
      const seen=new Set(this.data.drafts.map(item=>item.id));
      this.setData({drafts:[...this.data.drafts,...page.items.filter(item=>!seen.has(item.id)).map(item=>({...item,status:stateLabel(item.state)}))],
        listTotal:page.matchingTotal,listCursor:page.nextCursor,listLoadingMore:false});
    }catch(error){if(this.mediaVisible&&epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision())
      this.setData({listLoadingMore:false,listMoreError:message(error,"更多内容暂未加载，请重试。")});}
  },
  async createDraft() {
    if (this.data.busy || !this.data.draftsEnabled || this.data.writeRecovery) return;
    if(!this.data.createKey)this.setData({createKey:operationKey()});
    const epoch = ++this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    this.setData({ requestedNew:true,busy: true,operation:"creating", loading: true, error: "", listMode: false });
    try {
      const draft = await request<Draft>({ path: "/v1/me/ugc/posts", method: "POST", idempotencyKey: this.data.createKey, data: {} });
      if (this.pageAlive&&epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision()) {this.createdHerePostId=draft.id;this.applyDraft(draft);}
    } catch (error) { if (this.pageAlive&&epoch === this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken) this.setData({ error: message(error, "新建结果暂未确认，请点重试核对同一篇草稿。"), loading: false }); }
    finally { if (this.pageAlive&&epoch === this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken) {
      this.setData({ busy: false,operation:"idle" });
      if(this.mediaVisible&&this.data.postId){if(this.pendingInitialMedia)void this.importInitialMedia();else if(this.initialTextEntry){this.initialTextEntry=false;this.openTextCard("entry");}}
    } }
  },
  startNew() { if(this.data.busy||this.data.writeRecovery)return;this.clearLocalTextEntryScope();this.setData({ createKey: operationKey(),requestedNew:true,requestedDraftId:"",textCardHandoffPath:"" }); void this.openNewIfAvailable(); },
  async loadDraft(id: string,restoreBackup=true) {
    this.cancelMediaDrag();
    this.clearPendingImageEdit();
    const epoch = ++this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    this.clearLocalTextEntryScope();
    this.setData({ listMode: false, requestedDraftId:id, postId:"", ownerId:"",files:[],title:"",body:"",textCardHandoffPath:"",dirty:false,loading: true, error: "",writeRecovery:"",recoveryBusy:false });
    try {
      const draft = await pageRead<Draft>(this,{ path: `/v1/me/ugc/posts/${id}` });
      if (this.mediaVisible && epoch === this.data.epoch && token === getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision()) this.applyDraft(draft,restoreBackup);
    } catch (error) { if (this.mediaVisible && epoch === this.data.epoch) this.setData({ loading: false, error: message(error, "草稿暂时无法加载，请重试。") }); }
  },
  applyDraft(draft: Draft,restoreBackup=true) {
    this.cancelMediaDrag();
    this.clearPendingImageEdit();
    const token=getApp<IAppOption>().globalData.sessionToken;
    const backup=restoreBackup&&["draft","rejected","published"].includes(draft.state)?readUgcBackup(draft.ownerId,draft.id,draft.version):null;
    const mediaIds=backup?.mediaIds??draft.media.map(media=>media.id);
    const restored=backup?.mediaItems;
    this.textCardInputInitialized=typeof backup?.textCardText==="string";
    this.setData({ postId: draft.id,ownerId:draft.ownerId, state: draft.state, publicVersionActive: draft.publicVersionActive, version: draft.version,
      reviewNote:draft.reviewNote??"",reviewedLabel:draft.reviewedAt?new Date(draft.reviewedAt).toLocaleDateString("zh-CN"):"",
      hiddenReason:draft.hiddenReason??"",hiddenPublished:draft.hiddenPublished??null,appeal:draft.appeal??null,
      title: backup?.title??draft.title, body: backup?.body??draft.body,
      requestedNew:false,requestedDraftId:draft.id,textCardHandoffPath:"",textCardText:typeof backup?.textCardText==="string"?backup.textCardText:"",textCardTemplate:normalizeTextCardTemplate(backup?.textCardTemplate),
      files: restored?restored.map(item=>({...item,previewUrl:"",progress:item.state==="uploaded"?100:0})):mediaIds.map(id => ({ id, localPath: "", previewUrl: "", size: 0, state: "uploaded" as const, progress: 100, error: "" })),
      loading: false, error: "",mediaRecovery:"", dirty: Boolean(backup), notice: backup?"已恢复未提交的修改；若有图片未显示，请检查后保存草稿。":
        draft.state === "rejected" ? "审核已退回。修改后可以再次提交。" : "" });
    void this.loadMediaPreviews(mediaIds,this.data.epoch,token,draft.id);
    this.syncUnloadWarning();
  },
  async submitAppeal(){
    if(this.data.state!=="hidden"||this.data.appeal||this.data.busy||!this.data.postId)return;
    if(this.data.dirty){this.setData({error:"申诉与本页修改独立。请先复制需要的文字或查看图片，重新打开后再申请申诉。"});return;}
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
          this.updateMedia(id, { previewUrl: preview.url,error:"" });
      } catch { if(this.mediaVisible&&epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision())
        this.updateMedia(id,{error:"图片预览已失效，点此重试。"}); }
    }));
  },
  retryPreview(event:WechatMiniprogram.TouchEvent){const id=String(event.currentTarget.dataset.id||"");
    if(!id||!this.data.postId)return;
    this.updateMedia(id,{error:""});void this.loadMediaPreviews([id],this.data.epoch,getApp<IAppOption>().globalData.sessionToken,this.data.postId);
  },
  previewFailed(event:WechatMiniprogram.TouchEvent){const id=String(event.currentTarget.dataset.id||"");
    if(!this.mediaVisible||!this.pageAlive)return;
    if(event.currentTarget.dataset.epoch!==undefined&&Number(event.currentTarget.dataset.epoch)!==this.data.epoch)return;
    const file=this.data.files.find(item=>item.id===id);if(!file)return;
    const readonly=["pending_review","awaiting_publication"].includes(this.data.state);
    const source=readonly?(file.previewUrl||file.localPath):(file.localPath||file.previewUrl);
    if(event.currentTarget.dataset.preview!==undefined&&event.currentTarget.dataset.preview!==source)return;
    if(file.state==="uploaded"&&source===file.localPath&&file.previewUrl){this.updateMedia(id,{localPath:"",error:""});return;}
    if(file.state==="uploaded"&&readonly&&source===file.previewUrl&&file.localPath){this.updateMedia(id,{previewUrl:"",error:"图片预览已失效，可重试获取。"});return;}
    this.updateMedia(id,file.state==="uploaded"?{localPath:"",previewUrl:"",error:"图片预览已失效，点此重试。"}:
      {localPath:"",previewUrl:"",error:"本地图片已失效，请移除后重新选择。"});
    if(file.state!=="uploaded")this.queueLocalBackup();
  },
  previewImage(event:WechatMiniprogram.TouchEvent){const id=String(event.currentTarget.dataset.id||"");
    if(this.data.busy||this.data.uploadBusy||this.data.writeRecovery)return;
    const readonly=["pending_review","awaiting_publication"].includes(this.data.state);
    const source=(file:MediaItem)=>readonly?(file.previewUrl||file.localPath):(file.localPath||file.previewUrl);
    const file=this.data.files.find(item=>item.id===id),current=file?source(file):"";
    const urls=this.data.files.map(source).filter(Boolean);
    if(current&&urls.length){this.nativeMedia="preview";wx.previewImage({current,urls,fail:()=>{this.nativeMedia="";}});}
    else if(file?.state==="uploaded")this.retryPreview(event);
  },
  openDraft(event: WechatMiniprogram.TouchEvent) { const id = String(event.currentTarget.dataset.id || ""); if (id) void this.loadDraft(id); },
  async deleteListDraft(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id||""),item=this.data.drafts.find(row=>row.id===id);
    if(!item||!["draft","rejected"].includes(item.state)||this.data.busy)return;
    if(item.publicVersionActive){this.setData({error:"这篇内容仍有已发布版本，不能按未公开草稿删除。请前往公开详情处理。"});return;}
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    const current=()=>this.pageAlive&&this.mediaVisible&&epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision()&&
      this.data.drafts.some(row=>row.id===id&&row.version===item.version);
    const decision=await wx.showModal({title:"删除这篇未公开内容？",content:"删除后无法在小程序内恢复。",confirmText:"删除",confirmColor:"#8c354e"});
    if(!decision.confirm||!current())return;
    this.setData({busy:true,error:""});
    try{if(!current())return;
      const own=await pageRead<Draft>(this,{path:`/v1/me/ugc/posts/${id}`});
      if(!current())return;
      if(own.publicVersionActive){this.setData({busy:false,error:"这篇内容仍有已发布版本，不能按未公开草稿删除。请前往公开详情处理。"});return;}
      if(own.version!==item.version||!["draft","rejected"].includes(own.state)){this.setData({busy:false,error:"内容状态已有变化，请刷新投稿列表后再操作。"});return;}
      await request({path:`/v1/me/ugc/posts/${id}`,method:"DELETE",data:{expectedVersion:item.version}});
      if(current()){clearUgcBackup(own.ownerId,id,item.version);this.setData({busy:false});void this.loadList();}}
    catch(error){if(current()){
      if(unknownWrite(error)){try{const remote=await pageRead<Draft>(this,{path:`/v1/me/ugc/posts/${id}`});
        if(!current())return;
        if(remote.state==="deleted"){clearUgcBackup(remote.ownerId,id,item.version);this.setData({busy:false,notice:"已核对，这篇未公开内容已删除。"});void this.loadList();return;}
      }catch{/* Keep the exact row until deletion can be confirmed. */}}
      this.setData({error:message(error,"删除结果暂未确认，请刷新核对。")});}}
    finally{if(current())this.setData({busy:false});}
  },
  retryLoad(){if(this.pendingLocalText)void this.materializeLocalText(this.pendingLocalText);else if(this.pendingWrite)void this.verifyWriteResult();else if(this.data.requestedDraftId)void this.loadDraft(this.data.requestedDraftId);
    else if(this.data.requestedNew)void this.openNewIfAvailable();else void this.loadList();},
  editTitle(event: WechatMiniprogram.Input) { if(this.data.mediaDragging)return;this.setData({ title: event.detail.value, dirty: true, notice: "" });this.queueLocalBackup(); },
  editBody(event: WechatMiniprogram.Input) { if(this.data.mediaDragging)return;this.setData({ body: event.detail.value, dirty: true, notice: "" });this.queueLocalBackup(); },
  onKeyboardHeightChange(event:{detail:{height:number}}){this.setData({keyboardVisible:event.detail.height>0,...(event.detail.height===0?{bodyFocused:false}:{})});},
  localTextEntryIsCurrent(entry?:LocalTextEntry|null){const scope=entry??this.localTextEntry;return Boolean(scope&&scope===this.localTextEntry&&this.pageAlive&&scope.epoch===this.data.epoch&&scope.token&&scope.token===this.lastSessionToken&&scope.token===getApp<IAppOption>().globalData.sessionToken&&scope.revision===this.readRevision&&scope.revision===commerceContextRevision()&&scope.createKey===this.data.createKey&&!this.data.postId&&!this.data.ownerId&&this.data.version===0&&this.data.requestedNew&&!this.data.listMode);},
  openTextCard(origin:"entry"|"editor"="editor"){if(this.data.textCardVisible||!this.pageAlive||!this.mediaVisible||this.lastSessionToken!==getApp<IAppOption>().globalData.sessionToken||this.readRevision!==commerceContextRevision()||(!this.data.postId&&!this.localTextEntryIsCurrent())||this.data.busy||this.data.uploadBusy||this.data.recoveryBusy||this.data.writeRecovery||this.pendingLocalText||!["draft","rejected","published"].includes(this.data.state))return;
    if(this.data.files.length>=9){this.setData({error:"最多添加9张图片，请先移除一张再制作文字卡片。"});return;}
    const text=this.textCardInputInitialized?this.data.textCardText:this.data.body;
    if(textCardGraphemes(normalizeTextCardText(text)).length>300){this.setData({error:"文字卡片最多300字，原始文字仍保留，可先精简后再制作。"});return;}
    if(typeof wx.hideKeyboard==="function")wx.hideKeyboard();
    this.textCardInputInitialized=true;
    const context={key:`card-${this.data.epoch}-${operationKey()}`,postId:this.data.postId,ownerId:this.data.ownerId,version:this.data.version,epoch:this.data.epoch,token:getApp<IAppOption>().globalData.sessionToken,revision:this.readRevision,origin,entryNonce:this.localTextEntry?.nonce||""};
    this.textCardOpenContext=context;
    this.setData({textCardVisible:true,textCardText:text,textCardContext:context.key,textCardHandoffPath:"",keyboardVisible:false});
  },
  textCardContextIsCurrent(key:string,allowBusy=false){const scope=this.textCardOpenContext;return Boolean(scope&&key===scope.key&&key===this.data.textCardContext&&this.pageAlive&&this.mediaVisible&&this.data.textCardVisible&&
    scope.postId===this.data.postId&&scope.ownerId===this.data.ownerId&&scope.version===this.data.version&&scope.epoch===this.data.epoch&&scope.token===this.lastSessionToken&&scope.token===getApp<IAppOption>().globalData.sessionToken&&scope.revision===this.readRevision&&scope.revision===commerceContextRevision()&&
    (scope.postId?Boolean(scope.ownerId):this.localTextEntryIsCurrent()&&scope.entryNonce===this.localTextEntry?.nonce)&&
    (allowBusy||!this.data.busy)&&!this.data.uploadBusy&&!this.data.recoveryBusy&&!this.data.writeRecovery&&["draft","rejected","published"].includes(this.data.state));},
  textCardChanged(event:WechatMiniprogram.CustomEvent<{text:string;contextKey:string;template?:string}>){if(!this.textCardContextIsCurrent(event.detail.contextKey))return;
    const template=normalizeTextCardTemplate(event.detail.template);
    this.setData({textCardText:event.detail.text,textCardTemplate:template,dirty:true,notice:""});this.queueLocalBackup();},
  cancelTextCard(event:WechatMiniprogram.CustomEvent<{contextKey:string;mode?:string}>){if(!this.textCardContextIsCurrent(event.detail.contextKey))return;
    const scope=this.textCardOpenContext!;this.textCardOpenContext=null;this.setData({textCardVisible:false,bodyFocused:false});
    if(event.detail.mode==="body")void this.useTextCardBody(scope);
    else if(scope.origin==="entry"){void (async()=>{if(await this.confirmLeave())wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/community/index"})});
      else if(scope.epoch===this.data.epoch&&scope.postId===this.data.postId&&scope.token===getApp<IAppOption>().globalData.sessionToken)this.openTextCard("entry");})();}
  },
  async useTextCardBody(scope:TextCardContext){
    const text=this.data.textCardText,body=this.data.body;
    const current=()=>this.pageAlive&&this.mediaVisible&&!this.data.busy&&!this.data.uploadBusy&&!this.data.writeRecovery&&!this.data.recoveryBusy&&!this.data.textCardVisible&&!this.textCardOpenContext&&this.data.textCardContext===scope.key&&scope.epoch===this.data.epoch&&scope.postId===this.data.postId&&scope.ownerId===this.data.ownerId&&scope.version===this.data.version&&scope.token===this.lastSessionToken&&scope.token===getApp<IAppOption>().globalData.sessionToken&&scope.revision===this.readRevision&&scope.revision===commerceContextRevision()&&this.data.textCardText===text&&this.data.body===body&&["draft","rejected","published"].includes(this.data.state);
    if(!current())return;
    if(text.length>5000){this.setData({error:"正文最多5000字，输入仍保留，请精简后继续。"});this.openTextCard(scope.origin);return;}
    if(this.localTextEntryIsCurrent()){const candidate=this.newLocalTextCandidate("body",null);this.pendingLocalText=candidate;await this.materializeLocalText(candidate);return;}
    if(hasTextCardContent(body)&&body!==text){const answer=await wx.showModal({title:"替换现有正文？",content:"卡片文字将替换当前正文。选择保留正文可返回继续编辑卡片。",confirmText:"替换正文",cancelText:"保留正文"}).catch(()=>null);
      if(!current())return;if(!answer?.confirm){this.openTextCard(scope.origin);return;}}
    this.setData({body:text,dirty:true,notice:""});this.queueLocalBackup();
    const focus=()=>{if(this.pageAlive&&this.mediaVisible&&!this.data.busy&&!this.data.uploadBusy&&!this.data.writeRecovery&&scope.epoch===this.data.epoch&&scope.postId===this.data.postId&&scope.ownerId===this.data.ownerId&&scope.version===this.data.version&&scope.token===getApp<IAppOption>().globalData.sessionToken&&scope.revision===commerceContextRevision())this.setData({bodyFocused:true});};
    if(typeof wx.nextTick==="function")wx.nextTick(focus);else focus();
  },
  async confirmTextCard(event:WechatMiniprogram.CustomEvent<{tempFilePath:string;size:number;text:string;template?:string;contextKey:string}>){
    const {contextKey,tempFilePath,text}=event.detail;if(!this.textCardContextIsCurrent(contextKey))return;
    const scope=this.textCardOpenContext!;this.setData({busy:true,error:""});
    try{
      if(!hasTextCardContent(text)||textCardGraphemes(normalizeTextCardText(text)).length>300||!tempFilePath||!((tempFilePath.startsWith("/")&&!tempFilePath.startsWith("//"))||tempFilePath.startsWith("wxfile://")||/^https?:\/\/tmp\//.test(tempFilePath)))throw new Error("TEXT_CARD_INVALID");
      const size=await new Promise<number>((resolve,reject)=>wx.getFileSystemManager().getFileInfo({filePath:tempFilePath,success:result=>resolve(result.size),fail:reject}));
      if(!this.textCardContextIsCurrent(contextKey,true))return;
      if(!Number.isSafeInteger(size)||size<1||size>10*1024*1024||size!==event.detail.size||await mimeOf(tempFilePath)!=="image/png")throw new Error("TEXT_CARD_FILE_INVALID");
      if(!this.textCardContextIsCurrent(contextKey,true))return;
      this.textCardOpenContext=null;this.resumeTextCard=null;
      this.setData({busy:false,textCardVisible:false,textCardText:text,textCardTemplate:normalizeTextCardTemplate(event.detail.template??this.data.textCardTemplate),dirty:true,notice:""});this.queueLocalBackup();
      if(!scope.postId){const candidate=this.newLocalTextCandidate("card",{path:tempFilePath,size});this.pendingLocalText=candidate;await this.materializeLocalText(candidate);}
      else await this.importLocalImages([{path:tempFilePath,size}]);
    }catch{if(this.textCardContextIsCurrent(contextKey,true)){
      this.textCardOpenContext=null;this.setData({busy:false,textCardVisible:false,error:"文字卡片文件暂不可用，输入仍保留，请重新生成。"});this.openTextCard(scope.origin);
      if(typeof wx.showToast==="function")wx.showToast({title:"卡片文件不可用，请重新生成",icon:"none"});}}
    finally{if(this.textCardOpenContext===scope&&this.pageAlive&&scope.epoch===this.data.epoch)this.setData({busy:false});}
  },
  newLocalTextCandidate(kind:LocalTextCandidate["kind"],file:LocalTextCandidate["file"]):LocalTextCandidate{return {scope:this.localTextEntry!,kind,text:this.data.textCardText,template:this.data.textCardTemplate,file,sent:false,draft:null};},
  async materializeLocalText(candidate:LocalTextCandidate):Promise<boolean>{
    if(this.pendingLocalText!==candidate||!this.localTextEntryIsCurrent(candidate.scope)||!this.mediaVisible||this.data.busy)return false;
    const current=()=>this.pendingLocalText===candidate&&this.localTextEntryIsCurrent(candidate.scope);
    this.setData({busy:true,operation:"creating",error:"",textCardHandoffPath:candidate.kind==="card"?candidate.file?.path||"":""});
    try{
      if(!candidate.draft){
        const status=await pageRead<{draftsEnabled?:boolean;publicEnabled?:boolean}>(this,{path:"/v1/ugc/status",authMode:"public"});
        if(!current()||!this.mediaVisible)return false;
        this.setData({draftsEnabled:status.draftsEnabled===true,publicGateEnabled:status.publicEnabled===true,publicGateLoaded:true,publicGateUnknown:false});
        if(status.draftsEnabled!==true)throw {title:"当前暂不能新建草稿，文字仍保留在本页。"};
        const previouslyUnknown=candidate.sent;candidate.sent=true;
        let created:Draft;
        try{created=await request<Draft>({path:"/v1/me/ugc/posts",method:"POST",idempotencyKey:candidate.scope.createKey,data:{}});}
        catch(error){candidate.sent=previouslyUnknown||unknownWrite(error);throw error;}
        if(!current())return false;
        if(!/^[0-9a-f-]{36}$/i.test(created.id)||!/^[0-9a-f-]{36}$/i.test(created.ownerId)||!Number.isSafeInteger(created.version)||created.version<1)throw {title:"新建结果归属尚未确认，文字仍保留，请重试核对。"};
        candidate.draft=created;
      }
      if(!current()||!this.mediaVisible)return false;
      const created=candidate.draft!,body=candidate.kind==="card"?this.data.body:candidate.text;
      this.applyDraft(created,false);this.localTextEntry=null;this.pendingLocalText=null;this.initialTextEntry=false;this.resumeTextCard=null;
      this.textCardInputInitialized=true;
      const pristine=created.state==="draft"&&created.version===1&&!created.title&&!created.body&&!created.media.length;
      this.createdHerePostId=pristine?created.id:"";
      this.setData({body:pristine?body:created.body,textCardText:candidate.text,textCardTemplate:candidate.template,dirty:true,busy:false,operation:"idle",textCardVisible:false,
        error:pristine?"":"草稿版本已有变化，文字仍保留，请核对后再继续。",writeRecovery:pristine?"":"conflict"});this.queueLocalBackup();
      if(!pristine)return false;
      if(candidate.kind==="card"&&candidate.file){this.pendingTextImport={postId:created.id,ownerId:created.ownerId,version:created.version,epoch:this.data.epoch,token:candidate.scope.token,revision:candidate.scope.revision,file:candidate.file};await this.importPendingTextCard();}
      if(candidate.kind==="save")return Boolean(await this.saveDraft());
      if(candidate.kind==="body")this.setData({bodyFocused:true});
      return true;
    }catch(error){if(current())this.setData({loading:false,error:message(error,candidate.sent?"新建结果暂未确认，文字仍保留。请重试核对同一篇草稿。":"暂时无法确认草稿能力，文字仍保留，请重试。")});return false;}
    finally{if(current())this.setData({busy:false,operation:"idle",...(!this.mediaVisible&&!candidate.sent&&!candidate.draft&&!this.data.error?{error:"准备已暂停，请重试继续。"}:{})});}
  },
  async importPendingTextCard(){const pending=this.pendingTextImport;if(!pending||!this.pageAlive||!this.mediaVisible||this.data.busy||this.data.uploadBusy)return;
    if(pending.postId!==this.data.postId||pending.ownerId!==this.data.ownerId||pending.version!==this.data.version||pending.epoch!==this.data.epoch||pending.token!==getApp<IAppOption>().globalData.sessionToken||pending.revision!==commerceContextRevision()){this.pendingTextImport=null;return;}
    this.pendingTextImport=null;await this.importLocalImages([pending.file]);
  },
  async importInitialMedia(){
    if(!this.pendingInitialMedia||!this.data.postId||!this.mediaVisible||this.data.busy||this.data.uploadBusy||this.data.photoEditorVisible)return;
    const scope={key:`photo-${this.data.epoch}-${operationKey()}`,postId:this.data.postId,ownerId:this.data.ownerId,epoch:this.data.epoch,token:getApp<IAppOption>().globalData.sessionToken,revision:this.readRevision,origin:this.pendingMediaOrigin,targetId:this.pendingMediaTargetId,basePath:this.pendingMediaBasePath};
    this.photoEditorOpenContext=scope;
    this.setData({photoEditorVisible:true,photoEditorAdditional:scope.origin==="editor",photoEditorContext:scope.key,photoEditorFiles:this.pendingInitialMedia.files.map(file=>({...file})),keyboardVisible:false});this.syncUnloadWarning();
  },
  photoEditorContextIsCurrent(key:string,visible=true){const scope=this.photoEditorOpenContext;return Boolean(scope&&scope.key===key&&key===this.data.photoEditorContext&&this.pageAlive&&(!visible||this.mediaVisible)&&this.data.photoEditorVisible&&
    scope.postId===this.data.postId&&scope.ownerId===this.data.ownerId&&scope.epoch===this.data.epoch&&scope.token===this.lastSessionToken&&scope.token===getApp<IAppOption>().globalData.sessionToken&&scope.revision===this.readRevision&&scope.revision===commerceContextRevision()&&
    !this.data.busy&&!this.data.uploadBusy&&!this.data.recoveryBusy&&!this.data.writeRecovery&&["draft","rejected","published"].includes(this.data.state));},
  photoEditorChanged(event:WechatMiniprogram.CustomEvent<{contextKey:string;files:Array<{path:string;size:number}>}>){
    if(!this.photoEditorContextIsCurrent(event.detail.contextKey)||!this.pendingInitialMedia)return;
    this.pendingInitialMedia.files=event.detail.files.map(file=>({...file}));this.setData({photoEditorFiles:this.pendingInitialMedia.files});
  },
  photoEditorNativeBegin(event:WechatMiniprogram.CustomEvent<{contextKey:string}>){if(this.photoEditorContextIsCurrent(event.detail.contextKey))this.nativeMedia="edit";},
  photoEditorNativeEnd(event:WechatMiniprogram.CustomEvent<{contextKey:string}>){if(this.photoEditorContextIsCurrent(event.detail.contextKey,false)&&this.nativeMedia==="edit")this.nativeMedia="";},
  async photoEditorConfirmed(event:WechatMiniprogram.CustomEvent<{contextKey:string;files:Array<{path:string;size:number}>}>){
    if(!this.photoEditorContextIsCurrent(event.detail.contextKey))return;
    const scope=this.photoEditorOpenContext!,files=event.detail.files.map(file=>({...file}));this.pendingInitialMedia=null;this.photoEditorOpenContext=null;this.nativeMedia="";
    this.setData({photoEditorVisible:false,photoEditorFiles:[]});
    if(scope.origin==="single"){if(files.length===1&&files[0]!.path!==scope.basePath)await this.editSelectedImage(scope.targetId,"edit",files[0]);}
    else await this.importLocalImages(files);this.syncUnloadWarning();
  },
  async photoEditorCancelled(event:WechatMiniprogram.CustomEvent<{contextKey:string}>){
    if(!this.photoEditorContextIsCurrent(event.detail.contextKey))return;
    const origin=this.photoEditorOpenContext!.origin;
    this.pendingInitialMedia=null;this.photoEditorOpenContext=null;this.nativeMedia="";this.setData({photoEditorVisible:false,photoEditorFiles:[]});this.syncUnloadWarning();
    if(origin==="entry"&&await this.confirmLeave())wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/community/index"})});
  },
  async importLocalImages(files:Array<{path:string;size:number}>){
    if(!this.data.postId||!this.mediaVisible||this.lastSessionToken!==getApp<IAppOption>().globalData.sessionToken||this.readRevision!==commerceContextRevision()||this.data.busy||this.data.uploadBusy||this.data.writeRecovery)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,mediaEpoch=++this.mediaEpoch;
    const current=()=>this.pageAlive&&this.mediaVisible&&mediaEpoch===this.mediaEpoch&&epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision();
    this.setData({uploadBusy:true,error:""});
    try{for(const source of files){if(!current())return;if(this.data.files.length>=9)break;
      if(!source.path||source.size<1||source.size>10*1024*1024){this.setData({error:"单张图片需小于10MB，请重新选择。"});continue;}
      try{await mimeOf(source.path);}catch{if(current())this.setData({error:"仅支持JPG、PNG或WEBP图片，请重新选择。"});continue;}
      if(!current())return;const id=`local-${operationKey()}`;
      this.setData({dirty:true,files:[...this.data.files,{id,localPath:source.path,previewUrl:"",size:source.size,state:"uploading",progress:0,error:""}]});this.queueLocalBackup();
      await this.uploadImage(id,source.path,source.size,epoch,token,mediaEpoch);
    }}finally{if(current())this.setData({uploadBusy:false});}
  },
  async openImageActions(event:WechatMiniprogram.TouchEvent){
    if(this.mediaTapIsBlocked()||!this.mediaCanReorder())return;
    const id=String(event.currentTarget.dataset.id||"");if(!this.data.files.some(item=>item.id===id))return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,revision=this.readRevision,
      postId=this.data.postId,ownerId=this.data.ownerId,version=this.data.version,signature=mediaSignature(this.data.files);
    const index=this.data.files.findIndex(item=>item.id===id);
    const choices=[{label:"预览图片",action:"preview"},{label:"编辑图片",action:"edit"},
      ...(index>0?[{label:"设为首图",action:"cover"}]:[]),
      ...(index>1?[{label:"向前移动",action:"previous"}]:[]),...(index<this.data.files.length-1?[{label:"向后移动",action:"next"}]:[]),{label:"移除图片",action:"remove"}];
    const answer=await wx.showActionSheet({itemList:choices.map(item=>item.label)}).catch(()=>null);
    if(!answer||this.mediaTapIsBlocked()||!this.mediaCanReorder()||epoch!==this.data.epoch||token!==getApp<IAppOption>().globalData.sessionToken||revision!==commerceContextRevision()||
      postId!==this.data.postId||ownerId!==this.data.ownerId||version!==this.data.version||signature!==mediaSignature(this.data.files))return;
    const file=this.data.files.find(item=>item.id===id);if(!file)return;
    const action=choices[answer.tapIndex]?.action;
    if(action==="preview")this.previewImage(event);
    else if(action==="cover"){this.setData({files:[file,...this.data.files.filter(item=>item.id!==id)],dirty:true});this.queueLocalBackup();}
    else if(action==="previous"||action==="next")this.moveImage({currentTarget:{dataset:{id,direction:action==="previous"?-1:1}}} as unknown as WechatMiniprogram.TouchEvent);
    else if(action==="remove")this.removeImage(event);
    else if(action==="edit")await this.openPhotoEditorForImage(event);
  },
  async openPhotoEditorForImage(event:WechatMiniprogram.TouchEvent){
    if(this.mediaTapIsBlocked())return;
    if(this.pendingImageEdit){this.setData({error:"请先重试使用修改后的图片，或放弃本次图片修改。"});return;}
    const id=String(event.currentTarget.dataset.id||""),file=this.data.files.find(item=>item.id===id);
    if(!file||!this.pageAlive||!this.mediaVisible||!["draft","rejected","published"].includes(this.data.state)||this.data.busy||this.data.uploadBusy||this.data.recoveryBusy||this.data.writeRecovery||this.data.photoEditorVisible||this.data.textCardVisible||this.lastSessionToken!==getApp<IAppOption>().globalData.sessionToken||this.readRevision!==commerceContextRevision())return;
    const epoch=this.data.epoch,token=this.lastSessionToken,revision=this.readRevision,postId=this.data.postId,mediaEpoch=++this.mediaEpoch;
    const current=()=>this.pageAlive&&this.mediaVisible&&epoch===this.data.epoch&&mediaEpoch===this.mediaEpoch&&postId===this.data.postId&&token===getApp<IAppOption>().globalData.sessionToken&&revision===commerceContextRevision()&&["draft","rejected","published"].includes(this.data.state)&&this.data.files.some(item=>item.id===id);
    this.setData({uploadBusy:true,error:"",imageEditingId:id});
    try{let path=file.localPath,size=0;
      if(path)try{size=await new Promise<number>((resolve,reject)=>wx.getFileSystemManager().getFileInfo({filePath:path,success:info=>resolve(info.size),fail:reject}));}catch{path="";}
      if(!current())return;
      if(!path){const preview=await pageRead<{url:string}>(this,{path:`/v1/me/ugc/posts/${postId}/media/${id}/preview-url`});if(!current())return;
        path=await new Promise<string>((resolve,reject)=>{const task=wx.downloadFile({url:preview.url,success:result=>result.statusCode===200?resolve(result.tempFilePath):reject(new Error("DOWNLOAD_FAILED")),fail:reject});this.mediaAbort=()=>task.abort();});
        size=await new Promise<number>((resolve,reject)=>wx.getFileSystemManager().getFileInfo({filePath:path,success:info=>resolve(info.size),fail:reject}));}
      if(!current())return;if(size<1||size>10*1024*1024)throw {title:"图片暂时无法编辑，原图仍保留。"};await mimeOf(path);if(!current())return;
      this.pendingInitialMedia={source:"album",files:[{path,size}]};this.pendingMediaOrigin="single";this.pendingMediaTargetId=id;this.pendingMediaBasePath=path;
    }catch(error){if(current())this.setData({error:message(error,"图片暂时无法读取，原图仍保留，请重试。")});}
    finally{if(this.pageAlive&&epoch===this.data.epoch&&postId===this.data.postId&&mediaEpoch===this.mediaEpoch&&token===getApp<IAppOption>().globalData.sessionToken){this.mediaAbort=null;this.setData({uploadBusy:false,imageEditingId:""});if(current()&&this.pendingInitialMedia)void this.importInitialMedia();}}
  },
  imageEditCandidateIsCurrent(candidate:ImageEditCandidate,visible=true){return this.pendingImageEdit===candidate&&this.pageAlive&&(!visible||this.mediaVisible)&&
    candidate.postId===this.data.postId&&candidate.ownerId===this.data.ownerId&&candidate.epoch===this.data.epoch&&candidate.version===this.data.version&&
    candidate.token===this.lastSessionToken&&candidate.token===getApp<IAppOption>().globalData.sessionToken&&candidate.revision===this.readRevision&&candidate.revision===commerceContextRevision()&&
    ["draft","rejected","published"].includes(this.data.state)&&this.data.files.some(file=>file.id===candidate.targetId);},
  clearPendingImageEdit(){const candidate=this.pendingImageEdit;this.pendingImageEdit=null;
    this.setData({imageEditRecovery:false,imageEditRecoveryKey:"",...(candidate&&(this.data.error===candidate.error||this.data.error===imageEditPendingError)?{error:""}:{})});},
  async retryPendingImageEdit(event:WechatMiniprogram.TouchEvent){const candidate=this.pendingImageEdit;
    if(!candidate||String(event.currentTarget.dataset.key||"")!==candidate.key||this.data.busy||this.data.uploadBusy||this.data.recoveryBusy||this.data.writeRecovery)return;
    if(!this.imageEditCandidateIsCurrent(candidate)){this.clearPendingImageEdit();this.setData({error:"本次图片修改已失效，请重新编辑原图。"});this.syncUnloadWarning();return;}
    await this.editSelectedImage(candidate.targetId,"edit",{path:candidate.path,size:candidate.size},candidate.key);},
  discardPendingImageEdit(event:WechatMiniprogram.TouchEvent){const candidate=this.pendingImageEdit;
    if(!candidate||String(event.currentTarget.dataset.key||"")!==candidate.key||!this.pageAlive||!this.mediaVisible||this.data.busy||this.data.uploadBusy||this.data.recoveryBusy)return;
    if(candidate.token!==getApp<IAppOption>().globalData.sessionToken||candidate.postId!==this.data.postId||candidate.ownerId!==this.data.ownerId||candidate.epoch!==this.data.epoch||candidate.revision!==commerceContextRevision())return;
    this.clearPendingImageEdit();this.syncUnloadWarning();},
  async editSelectedImage(id:string,mode:"edit"|"crop",editedFile?:{path:string;size:number},retryKey?:string){
    const retained=this.pendingImageEdit;
    if(retained&&(!editedFile||retryKey!==retained.key||retained.targetId!==id||retained.path!==editedFile.path||!this.imageEditCandidateIsCurrent(retained))){this.setData({error:"请先重试使用修改后的图片，或放弃本次图片修改。"});return;}
    if(retryKey&&!retained)return;
    const original=this.data.files.find(item=>item.id===id);
    if(!original||this.lastSessionToken!==getApp<IAppOption>().globalData.sessionToken||this.readRevision!==commerceContextRevision()||this.data.busy||this.data.uploadBusy||this.data.recoveryBusy||this.data.writeRecovery||!["draft","rejected","published"].includes(this.data.state))return;
    const epoch=this.data.epoch,postId=this.data.postId,ownerId=this.data.ownerId,baseVersion=this.data.version,token=getApp<IAppOption>().globalData.sessionToken,revision=this.readRevision,mediaEpoch=++this.mediaEpoch;
    let candidate=retained;
    const current=()=>this.pageAlive&&this.mediaVisible&&epoch===this.data.epoch&&postId===this.data.postId&&ownerId===this.data.ownerId&&baseVersion===this.data.version&&
      ["draft","rejected","published"].includes(this.data.state)&&mediaEpoch===this.mediaEpoch&&token===getApp<IAppOption>().globalData.sessionToken&&revision===commerceContextRevision()&&
      this.data.files.some(item=>item.id===id)&&(!candidate||this.imageEditCandidateIsCurrent(candidate));
    this.setData({uploadBusy:true,imageEditingId:id,error:""});
    try{
      if(editedFile&&!candidate){candidate={key:operationKey(),postId,ownerId,epoch,token,revision,version:baseVersion,targetId:id,path:editedFile.path,size:editedFile.size,error:""};
        this.pendingImageEdit=candidate;this.setData({imageEditRecovery:true,imageEditRecoveryKey:candidate.key});this.syncUnloadWarning();}
      let source=original.localPath;
      if(!source&&!editedFile){const preview=await pageRead<{url:string}>(this,{path:`/v1/me/ugc/posts/${postId}/media/${id}/preview-url`});if(!current())return;
        source=await new Promise<string>((resolve,reject)=>{const task=wx.downloadFile({url:preview.url,
          success:result=>result.statusCode===200?resolve(result.tempFilePath):reject(new Error("DOWNLOAD_FAILED")),fail:reject});this.mediaAbort=()=>task.abort();});
        if(!current())return;
      }
      if(!editedFile)this.nativeMedia="edit";
      const result=editedFile?{status:"success" as const,tempFilePath:editedFile.path}:await editUgcLocalImage(source,mode==="crop"?{mode:"crop",cropScale:"1:1"}:{mode:"edit"});
      if(!this.mediaVisible&&this.pageAlive&&mediaEpoch===this.mediaEpoch)await new Promise<void>(resolve=>{this.mediaReturn=resolve;});
      if(mediaEpoch===this.mediaEpoch)this.nativeMedia="";
      if(!current())return;if(result.status==="cancel")return;
      if(result.status!=="success"){this.setData({error:result.message});return;}
      if(!candidate){candidate={key:operationKey(),postId,ownerId,epoch,token,revision,version:baseVersion,targetId:id,path:result.tempFilePath,size:0,error:""};
        this.pendingImageEdit=candidate;this.setData({imageEditRecovery:true,imageEditRecoveryKey:candidate.key});this.syncUnloadWarning();}
      const size=await new Promise<number>((resolve,reject)=>wx.getFileSystemManager().getFileInfo({filePath:result.tempFilePath,success:info=>resolve(info.size),fail:reject}));
      if(!current())return;if(size<1||size>10*1024*1024)throw {title:"编辑后的图片需小于10MB，原图仍保留。"};candidate.size=size;
      const mimeType=await mimeOf(result.tempFilePath);if(!current())return;
      const authorization=await request<{mediaId:string;url:string;method:"POST"|"PUT";fields:Record<string,string>}>({path:`/v1/me/ugc/posts/${postId}/media/authorize`,method:"POST",data:{mimeType,maxBytes:size}});
      if(!current())return;
      await uploadAuthorized(result.tempFilePath,authorization,{registerAbort:abort=>{if(current())this.mediaAbort=abort;else abort();}});
      if(!current())return;
      await request({path:`/v1/me/ugc/posts/${postId}/media/${authorization.mediaId}/complete`,method:"POST",data:{}});
      if(!current())return;
      this.clearPendingImageEdit();
      this.setData({files:this.data.files.map(item=>item.id===id?{id:authorization.mediaId,localPath:result.tempFilePath,previewUrl:"",size,state:"uploaded" as const,progress:100,error:""}:item),dirty:true});
      this.queueLocalBackup();void this.loadMediaPreviews([authorization.mediaId],epoch,token,postId);
    }catch(error){if(current()){const detail=message(error,"图片编辑或上传未完成，原图仍保留，请重试。");if(candidate)candidate.error=detail;this.setData({error:detail});}}
    finally{if(mediaEpoch===this.mediaEpoch)this.nativeMedia="";
      if(candidate&&this.pendingImageEdit===candidate&&!this.imageEditCandidateIsCurrent(candidate,false))this.clearPendingImageEdit();
      if(this.pageAlive&&epoch===this.data.epoch&&postId===this.data.postId&&mediaEpoch===this.mediaEpoch&&token===getApp<IAppOption>().globalData.sessionToken){this.mediaAbort=null;this.setData({uploadBusy:false,imageEditingId:""});}}
  },
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
  async addContent(){
    if(this.mediaTapIsBlocked())return;
    if(this.lastSessionToken!==getApp<IAppOption>().globalData.sessionToken||this.readRevision!==commerceContextRevision()||this.data.busy||this.data.uploadBusy||this.data.recoveryBusy||this.data.writeRecovery)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,revision=this.readRevision;
    const answer=await wx.showActionSheet({itemList:["从相册选择","相机","写文字"]}).catch(()=>null);
    if(!answer||!this.pageAlive||!this.mediaVisible||epoch!==this.data.epoch||token!==getApp<IAppOption>().globalData.sessionToken||revision!==commerceContextRevision())return;
    if(answer.tapIndex===2)this.openTextCard();else if(answer.tapIndex===0||answer.tapIndex===1)await this.chooseImages(answer.tapIndex===0?"album":"camera");
  },
  async chooseImages(source?:"album"|"camera") {
    if(this.mediaTapIsBlocked())return;
    if (!this.data.postId || this.data.photoEditorVisible||this.data.textCardVisible||this.data.uploadBusy || this.data.busy || this.data.writeRecovery || this.data.files.length >= 9) return;
    const epoch = this.data.epoch, token = getApp<IAppOption>().globalData.sessionToken;
    const mediaEpoch=++this.mediaEpoch;
    const current=()=>this.mediaVisible&&mediaEpoch===this.mediaEpoch&&epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision();
    this.setData({uploadBusy:true,error:"",mediaRecovery:"",lastMediaSource:source||"album"});
    try {
      this.nativeMedia="privacy";
      await new Promise<void>((resolve,reject)=>wx.requirePrivacyAuthorize({success:()=>resolve(),fail:reject}));
      if(!this.mediaVisible&&this.pageAlive&&mediaEpoch===this.mediaEpoch)await new Promise<void>(resolve=>{this.mediaReturn=resolve;});
      if(!current())return;
      this.nativeMedia="choose";
      const chosen = await wx.chooseMedia({ count: source==="camera"?1:9 - this.data.files.length, mediaType: ["image"],
        sourceType: source?[source]:["album", "camera"], sizeType: ["compressed", "original"] });
      if(!this.mediaVisible&&this.pageAlive&&mediaEpoch===this.mediaEpoch)await new Promise<void>(resolve=>{this.mediaReturn=resolve;});
      if(mediaEpoch===this.mediaEpoch)this.nativeMedia="";
      if(!current())return;
      if(chosen.tempFiles.length>(source==="camera"?1:9-this.data.files.length)){this.setData({error:"所选图片数量超出本次可添加数量，请重新选择。"});return;}
      const selected:Array<{path:string;size:number}>=[];
      for (const source of chosen.tempFiles) {
        if(!current())return;
        if (source.size < 1 || source.size > 10 * 1024 * 1024) { this.setData({ error: "单张图片需小于 10MB，请重新选择。" }); return; }
        const localPath = source.tempFilePath;
        try { await mimeOf(localPath); } catch { if(current())this.setData({ error: "仅支持 JPG、PNG 或 WEBP 图片。" }); return; }
        if(!current())return;
        selected.push({path:localPath,size:source.size});
      }
      if(current()&&selected.length){this.pendingInitialMedia={source:source||"album",files:selected};this.pendingMediaOrigin="editor";}
    } catch (error) {
      if(!this.mediaVisible&&this.pageAlive&&mediaEpoch===this.mediaEpoch&&(this.nativeMedia==="choose"||this.nativeMedia==="privacy"))await new Promise<void>(resolve=>{this.mediaReturn=resolve;});
      if(current()&&!/cancel/i.test((error as { errMsg?: string })?.errMsg || "")) {
        const permission=/(deny|denied|auth|permission|scope)/i.test(String((error as {errMsg?:string})?.errMsg||""));
        this.setData({mediaRecovery:this.nativeMedia==="privacy"?"privacy":permission?"settings":"",error:this.nativeMedia==="privacy"?"需要完成微信隐私授权后才能选择照片。":source==="camera"?"相机暂不可用，请检查相机权限后重试；文字草稿仍保留。":"未能选择图片，请检查相册权限后重试；文字草稿仍保留。" });
      } }
    finally { if(mediaEpoch===this.mediaEpoch)this.nativeMedia="";if(current()) {this.setData({ uploadBusy: false });if(this.pendingInitialMedia)void this.importInitialMedia();} }
  },
  async retryChoosingMedia(){await this.chooseImages(this.data.lastMediaSource);},
  async openComposerMediaSettings(){
    if(this.data.busy||this.data.uploadBusy||this.data.recoveryBusy||this.data.writeRecovery||!this.mediaVisible)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,revision=this.readRevision,mediaEpoch=++this.mediaEpoch;
    const current=()=>this.pageAlive&&this.mediaVisible&&epoch===this.data.epoch&&mediaEpoch===this.mediaEpoch&&token===getApp<IAppOption>().globalData.sessionToken&&revision===commerceContextRevision();
    this.nativeMedia="settings";this.setData({uploadBusy:true});
    try{await new Promise<void>((resolve,reject)=>wx.openSetting({success:()=>resolve(),fail:reject}));
      if(!this.mediaVisible&&this.pageAlive&&mediaEpoch===this.mediaEpoch)await new Promise<void>(resolve=>{this.mediaReturn=resolve;});
      if(current())this.setData({mediaRecovery:"retry",error:"设置已返回，请重新选择照片。"});
    }catch{if(current())this.setData({mediaRecovery:"settings",error:"设置暂时无法打开，请稍后重试。"});}
    finally{if(mediaEpoch===this.mediaEpoch)this.nativeMedia="";if(current())this.setData({uploadBusy:false});}
  },
  async retryImage(event: WechatMiniprogram.TouchEvent) {
    if(this.mediaTapIsBlocked())return;
    const id = String(event.currentTarget.dataset.id || "");
    const item = this.data.files.find(file => file.id === id);
    if (!item || item.state !== "failed" || !item.localPath || this.data.uploadBusy || this.data.busy || this.data.writeRecovery) return;
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
  mediaTapIsBlocked(){return this.data.mediaDragging||Date.now()<this.mediaTapBlockedUntil;},
  mediaCanReorder(allowPendingEdit=false){return this.pageAlive&&this.mediaVisible&&this.lastSessionToken===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision()&&
    !!this.data.postId&&["draft","rejected","published"].includes(this.data.state)&&!this.data.busy&&!this.data.uploadBusy&&!this.data.recoveryBusy&&!this.data.writeRecovery&&(allowPendingEdit||!this.pendingImageEdit)&&!this.data.photoEditorVisible&&!this.data.textCardVisible;},
  mediaGestureIsCurrent(gesture:MediaPress){return this.mediaCanReorder()&&gesture.epoch===this.data.epoch&&gesture.postId===this.data.postId&&gesture.ownerId===this.data.ownerId&&gesture.version===this.data.version&&
    gesture.token===getApp<IAppOption>().globalData.sessionToken&&gesture.revision===commerceContextRevision()&&gesture.signature===mediaSignature(this.data.files);},
  guardMediaDragTouch(event:WechatMiniprogram.TouchEvent){if((this.mediaPress||this.mediaDrag)&&event.touches.length!==1)this.cancelMediaDrag();},
  holdMediaControl(){this.cancelMediaDrag();},
  onMediaScroll(event:WechatMiniprogram.CustomEvent<{scrollLeft:number}>){
    const left=event.detail.scrollLeft;if(!Number.isFinite(left))return;
    this.mediaScrollPosition=left;
    if(this.mediaDrag){this.mediaDrag.scrollLeft=left;if(this.mediaDrag.dropping)this.setData({mediaDragLeft:this.mediaDrag.rects[this.mediaDrag.target]!.left+this.mediaDrag.originScroll-left});else this.renderMediaDrag();}
    else if(this.mediaPress&&Math.abs(left-this.mediaPress.scrollLeft)>.5)this.mediaPress=null;
  },
  startMediaTouch(event:WechatMiniprogram.TouchEvent){
    if(this.mediaDrag||!this.mediaCanReorder()||this.data.files.length<2||event.touches.length!==1){if(event.touches.length!==1)this.cancelMediaDrag();return;}
    const touch=event.touches[0]!,id=String(event.currentTarget.dataset.id||"");
    if(!this.data.files.some(file=>file.id===id)||typeof wx.createSelectorQuery!=="function")return;
    const press:MediaPress={id,pointer:touch.identifier,startX:touch.clientX,startY:touch.clientY,x:touch.clientX,y:touch.clientY,
      epoch:this.data.epoch,postId:this.data.postId,ownerId:this.data.ownerId,version:this.data.version,token:this.lastSessionToken,revision:this.readRevision,
      signature:mediaSignature(this.data.files),wantsDrag:false,rects:[],viewport:null,scrollLeft:this.mediaScrollPosition,scrollWidth:0};
    this.mediaPress=press;
    const query=wx.createSelectorQuery();
    query.select(".composer-media-scroll").boundingClientRect();
    query.select(".composer-media-scroll").fields({scrollOffset:true,size:true});
    query.selectAll(".composer-media").boundingClientRect();
    query.exec(results=>{
      if(this.mediaPress!==press||!this.mediaGestureIsCurrent(press))return;
      const [viewport,scroll,rects]=results as [MediaRect|null,{scrollLeft?:number;scrollWidth?:number}|null,MediaRect[]|null];
      if(!viewport||![viewport.left,viewport.top,viewport.width,viewport.height].every(Number.isFinite)||!(viewport.width>0)||!rects||rects.length!==this.data.files.length||
        rects.some(rect=>![rect.left,rect.top,rect.width,rect.height].every(Number.isFinite)||!(rect.width>0))){this.mediaPress=null;return;}
      press.viewport=viewport;press.rects=rects;press.scrollLeft=scroll?.scrollLeft??this.mediaScrollPosition;
      this.mediaScrollPosition=press.scrollLeft;
      press.scrollWidth=scroll?.scrollWidth??Math.max(viewport.width,rects[rects.length-1]!.left+rects[rects.length-1]!.width-viewport.left+press.scrollLeft+12);
      if(press.wantsDrag)this.beginMediaDrag();
    });
  },
  trackMediaTouch(event:WechatMiniprogram.TouchEvent){
    if(this.mediaDrag)return;
    const press=this.mediaPress;if(!press)return;
    const touch=event.touches.find(item=>item.identifier===press.pointer);
    if(event.touches.length!==1||!touch||Math.hypot(touch.clientX-press.startX,touch.clientY-press.startY)>8){this.mediaPress=null;return;}
    press.x=touch.clientX;press.y=touch.clientY;
  },
  longPressMedia(event:WechatMiniprogram.TouchEvent){
    const press=this.mediaPress;if(!press||String(event.currentTarget.dataset.id||"")!==press.id||event.touches.length!==1||event.touches[0]?.identifier!==press.pointer)return;
    press.wantsDrag=true;this.beginMediaDrag();
  },
  beginMediaDrag(){
    const press=this.mediaPress;
    if(!press||!press.wantsDrag||!press.viewport||!press.rects.length||!this.mediaGestureIsCurrent(press))return;
    const index=this.data.files.findIndex(file=>file.id===press.id),rect=press.rects[index],file=this.data.files[index];if(!rect||!file)return;
    const drag:MediaDrag={...press,index,target:index,drawnTarget:index,offsetX:press.x-rect.left,offsetY:press.y-rect.top,originScroll:press.scrollLeft,dropping:false};
    this.mediaPress=null;this.mediaDrag=drag;this.mediaTapBlockedUntil=Date.now()+500;
    if(typeof wx.hideKeyboard==="function")wx.hideKeyboard();
    this.setData({mediaDragging:true,keyboardVisible:false,mediaDragId:drag.id,mediaDragSource:file.localPath||file.previewUrl,
      mediaDragLeft:rect.left,mediaDragTop:rect.top,mediaDragSize:rect.width,mediaDragDropping:false,mediaDragOffsets:this.data.files.map(()=>0)});
  },
  moveMediaDrag(event:WechatMiniprogram.TouchEvent){
    const drag=this.mediaDrag;if(!drag||drag.dropping)return;
    const touch=event.touches.find(item=>item.identifier===drag.pointer);
    if(String(event.currentTarget.dataset.id||"")!==drag.id||event.touches.length!==1||!touch||!this.mediaGestureIsCurrent(drag)){this.cancelMediaDrag();return;}
    drag.x=touch.clientX;drag.y=touch.clientY;this.renderMediaDrag();this.scheduleMediaEdgeScroll();
  },
  renderMediaDrag(immediate=false){
    const drag=this.mediaDrag;if(!drag||drag.dropping)return;
    if(!this.mediaGestureIsCurrent(drag)){this.cancelMediaDrag();return;}
    if(this.mediaMoveTimer){if(!immediate)return;clearTimeout(this.mediaMoveTimer);this.mediaMoveTimer=null;}
    if(!immediate){this.mediaMoveTimer=setTimeout(()=>{this.mediaMoveTimer=null;this.renderMediaDrag(true);},16);return;}
    const center=drag.x-drag.offsetX+drag.rects[drag.index]!.width/2+drag.scrollLeft;
    let target=0,distance=Infinity;
    // Rects and touch coordinates both use the viewport; add the measured scroll offset only once.
    for(let index=0;index<drag.rects.length;index++){const rect=drag.rects[index]!,distanceToSlot=Math.abs(rect.left+drag.originScroll+rect.width/2-center);
      if(distanceToSlot<distance){distance=distanceToSlot;target=index;}}
    drag.target=target;
    const patch:{mediaDragLeft:number;mediaDragTop:number;mediaDragOffsets?:number[]}={mediaDragLeft:drag.x-drag.offsetX,mediaDragTop:drag.y-drag.offsetY};
    if(target!==drag.drawnTarget){patch.mediaDragOffsets=drag.rects.map((rect,index)=>drag.index<target&&index>drag.index&&index<=target?drag.rects[index-1]!.left-rect.left:
      drag.index>target&&index>=target&&index<drag.index?drag.rects[index+1]!.left-rect.left:0);drag.drawnTarget=target;}
    this.setData(patch);
  },
  scheduleMediaEdgeScroll(){
    if(this.mediaEdgeTimer)return;
    this.mediaEdgeTimer=setInterval(()=>{
      const drag=this.mediaDrag;if(!drag||drag.dropping||!this.mediaGestureIsCurrent(drag)){this.cancelMediaDrag();return;}
      const viewport=drag.viewport!,direction=drag.x<viewport.left+28?-1:drag.x>viewport.left+viewport.width-28?1:0;
      if(!direction||drag.y<viewport.top-40||drag.y>viewport.top+viewport.height+40){if(this.mediaEdgeTimer)clearInterval(this.mediaEdgeTimer);this.mediaEdgeTimer=null;return;}
      const left=Math.max(0,Math.min(drag.scrollWidth-viewport.width,drag.scrollLeft+direction*12));
      if(left===drag.scrollLeft)return;
      // Only the native scroll event advances hit-testing; a requested offset is not a completed scroll.
      this.setData({mediaScrollLeft:left});
    },32);
  },
  endMediaTouch(event:WechatMiniprogram.TouchEvent){
    this.mediaPress=null;const drag=this.mediaDrag;if(!drag||drag.dropping)return;
    const touch=event.changedTouches.find(item=>item.identifier===drag.pointer);
    if(!touch||event.touches.length||!this.mediaGestureIsCurrent(drag)){this.cancelMediaDrag();return;}
    drag.x=touch.clientX;drag.y=touch.clientY;this.renderMediaDrag(true);
    const viewport=drag.viewport!;
    if(drag.x<viewport.left-40||drag.x>viewport.left+viewport.width+40||drag.y<viewport.top-80||drag.y>viewport.top+viewport.height+80){this.cancelMediaDrag();return;}
    if(this.mediaEdgeTimer)clearInterval(this.mediaEdgeTimer);this.mediaEdgeTimer=null;
    drag.dropping=true;const rect=drag.rects[drag.target]!;
    this.setData({mediaDragDropping:true,mediaDragLeft:rect.left+drag.originScroll-drag.scrollLeft,mediaDragTop:rect.top});
    this.mediaDragTimer=setTimeout(()=>{
      this.mediaDragTimer=null;
      if(this.mediaDrag!==drag||!this.mediaGestureIsCurrent(drag)){this.cancelMediaDrag();return;}
      const changed=drag.target!==drag.index,files=[...this.data.files];
      if(changed){const [file]=files.splice(drag.index,1);files.splice(drag.target,0,file!);}
      if(changed)this.setData({files,dirty:true,mediaDragging:false,mediaDragId:"",mediaDragSource:"",mediaDragDropping:false,mediaDragOffsets:[]});
      this.cancelMediaDrag();
      if(changed)this.queueLocalBackup();
    },180);
  },
  cancelMediaDrag(){
    if(this.mediaDragTimer)clearTimeout(this.mediaDragTimer);if(this.mediaMoveTimer)clearTimeout(this.mediaMoveTimer);if(this.mediaEdgeTimer)clearInterval(this.mediaEdgeTimer);
    this.mediaDragTimer=null;this.mediaMoveTimer=null;this.mediaEdgeTimer=null;this.mediaPress=null;
    if(this.mediaDrag)this.mediaTapBlockedUntil=Date.now()+400;
    this.mediaDrag=null;
    if(this.data.mediaDragging)this.setData({mediaDragging:false,mediaDragId:"",mediaDragSource:"",mediaDragDropping:false,mediaDragOffsets:[]});
  },
  removeImage(event: WechatMiniprogram.TouchEvent) {
    if(this.mediaTapIsBlocked()||!this.mediaCanReorder(true))return;
    const id = String(event.currentTarget.dataset.id || "");
    if(this.pendingImageEdit?.targetId===id)this.clearPendingImageEdit();
    const files=this.data.files.filter(file => file.id !== id);
    if(files.length===this.data.files.length)return;
    this.setData({ files, dirty: true });this.queueLocalBackup();
  },
  moveImage(event: WechatMiniprogram.TouchEvent) {
    if(this.data.mediaDragging||!this.mediaCanReorder())return;
    const id = String(event.currentTarget.dataset.id || ""), direction = Number(event.currentTarget.dataset.direction);
    const items = [...this.data.files], index = items.findIndex(item => item.id === id), next = index + direction;
    if ((direction!==-1&&direction!==1)||index < 0 || next < 0 || next >= items.length) return;
    [items[index], items[next]] = [items[next]!, items[index]!];
    this.setData({ files: items, dirty: true });this.queueLocalBackup();
  },
  async saveDraft(): Promise<Draft | null> {
    if(this.data.mediaDragging)return null;
    if(this.pendingImageEdit){this.setData({error:"请先重试使用修改后的图片，或放弃本次图片修改。"});return null;}
    if (!this.data.postId || this.data.busy || this.data.uploadBusy||this.data.writeRecovery||!["draft","rejected","published"].includes(this.data.state)) return null;
    if (this.data.files.some(item => item.state !== "uploaded")) { this.setData({ error: "有图片还没上传完成，请移除失败图片或稍后重试。" }); return null; }
    const pending=this.newPendingWrite("save");this.pendingWrite=pending;
    this.flushLocalBackup();
    this.setData({ busy: true,operation:"saving", error: "", notice: "" });
    try {
      const draft=await request<Draft>({path:`/v1/me/ugc/posts/${pending.postId}/draft`,method:"PUT",data:{...pending.snapshot,expectedVersion:pending.version}});
      if(!this.writeIsCurrent(pending)||!this.mediaVisible)return null;
      this.finishWrite(pending,draft);return draft;
    } catch(error){
      if(!this.writeIsCurrent(pending))return null;
      this.setData({busy:false,operation:"idle"});
      if(unknownWrite(error)){this.setData({writeRecovery:"save",error:"保存结果暂未确认，正在核对同一篇草稿。"});return this.mediaVisible?await this.verifyWriteResult():null;}
      this.pendingWrite=null;this.setData({writeRecovery:"",recoveryBusy:false,error:message(error,"草稿未保存，请重试。")});return null;
    }
  },
  newPendingWrite(kind:"save"|"submit"):PendingWrite{return {kind,postId:this.data.postId,ownerId:this.data.ownerId,version:this.data.version,
    epoch:this.data.epoch,token:getApp<IAppOption>().globalData.sessionToken,revision:this.readRevision,
    snapshot:{title:this.data.title,body:this.data.body,mediaIds:this.data.files.map(item=>item.id)}};},
  writeIsCurrent(pending:PendingWrite){return this.pageAlive&&this.pendingWrite===pending&&pending.epoch===this.data.epoch&&
    pending.token===getApp<IAppOption>().globalData.sessionToken&&pending.revision===commerceContextRevision()&&pending.postId===this.data.postId&&pending.ownerId===this.data.ownerId;},
  finishWrite(pending:PendingWrite,draft:Draft){
    if(!this.writeIsCurrent(pending))return;
    clearUgcBackup(pending.ownerId,pending.postId,pending.version);this.pendingWrite=null;
    this.setData({version:draft.version,state:draft.state,publicVersionActive:draft.publicVersionActive,dirty:false,busy:false,operation:"idle",writeRecovery:"",recoveryBusy:false,error:"",mediaRecovery:"",
      notice:pending.kind==="save"?"草稿已保存。":draft.publicVersionActive?"新版已提交审核。通过前，公开页面仍显示上一版。":"已提交审核，审核与发布复核完成后公开。"});
    this.syncUnloadWarning();
  },
  async verifyWriteResult():Promise<Draft|null>{
    const pending=this.pendingWrite;if(!pending||!this.writeIsCurrent(pending)||this.data.recoveryBusy||!this.mediaVisible)return null;
    this.setData({recoveryBusy:true});
    try{const draft=await pageRead<Draft>(this,{path:`/v1/me/ugc/posts/${pending.postId}`});
      if(!this.writeIsCurrent(pending)||!this.mediaVisible)return null;
      if(draft.id!==pending.postId||draft.ownerId!==pending.ownerId){this.setData({busy:false,operation:"idle",writeRecovery:"conflict",error:"内容归属尚未确认，请重新打开投稿核对。"});return null;}
      if(draft.state==="hidden"||draft.state==="deleted"){
        this.flushLocalBackup();this.pendingWrite=null;
        this.setData({state:draft.state,publicVersionActive:false,version:this.data.dirty?this.data.version:draft.version,
          reviewNote:draft.reviewNote??"",reviewedLabel:draft.reviewedAt?new Date(draft.reviewedAt).toLocaleDateString("zh-CN"):"",
          hiddenReason:draft.hiddenReason??"",hiddenPublished:draft.hiddenPublished??null,appeal:draft.appeal??null,
          busy:false,operation:"idle",writeRecovery:"",recoveryBusy:false,error:"",
          notice:this.data.dirty?"修改暂留本页，请先复制需要的文字或查看图片；离开后无法从投稿列表找回。":draft.state==="deleted"?"这篇内容已删除。":"这篇内容已下架，请查看处理记录。"});
        this.syncUnloadWarning();return null;
      }
      if(draft.version>pending.version&&sameDraft(draft,pending.snapshot)&&
        (pending.kind==="save"||["pending_review","awaiting_publication","published","hidden"].includes(draft.state))){this.finishWrite(pending,draft);return draft;}
      if(draft.version===pending.version&&sameDraft(draft,pending.snapshot)&&pending.kind==="submit"){
        this.setData({busy:false,operation:"idle",recoveryBusy:false,writeRecovery:"submit",error:"暂未查到提交结果。请稍后核对，也可保留输入离开；离开不会撤销已发送的操作。"});return null;}
      if(draft.version===pending.version&&pending.kind==="save"){
        this.setData({busy:false,operation:"idle",recoveryBusy:false,writeRecovery:"save",error:"暂未查到保存结果，本次输入仍保留。请稍后核对，也可保留输入离开。"});return null;}
      this.setData({busy:false,operation:"idle",writeRecovery:"conflict",error:"草稿或审核状态已有变化。本次修改仍保留，请先重新加载并核对。"});return null;
    }catch(error){if(this.writeIsCurrent(pending)&&this.mediaVisible)this.setData({busy:false,operation:"idle",error:message(error,"暂时无法核对操作结果，请稍后再试。")});return null;}
    finally{if(this.writeIsCurrent(pending))this.setData({recoveryBusy:false});}
  },
  async reloadRemoteDraft(){
    if(this.data.busy||this.data.recoveryBusy||!this.data.postId)return;
    if(this.data.state==="hidden"||this.data.state==="deleted")return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,postId=this.data.postId,revision=this.readRevision;
    if(this.pendingWrite||this.data.writeRecovery){
      if(!await this.confirmLeave())return;
      if(!this.pageAlive||!this.mediaVisible||epoch!==this.data.epoch||postId!==this.data.postId||token!==getApp<IAppOption>().globalData.sessionToken||
        revision!==this.readRevision||revision!==commerceContextRevision()||this.data.state==="hidden"||this.data.state==="deleted")return;
      this.pendingWrite=null;this.setData({writeRecovery:""});void this.loadDraft(postId);return;
    }
    if(this.data.dirty){const answer=await wx.showModal({title:"放弃修改并重新加载？",content:"本次尚未保存的修改将放弃，页面会显示服务端最新内容。取消可继续保留当前文字和图片。",confirmText:"放弃重载",cancelText:"继续保留"}).catch(()=>null);
      if(!answer?.confirm)return;}
    if(!this.pageAlive||!this.mediaVisible||epoch!==this.data.epoch||token!==getApp<IAppOption>().globalData.sessionToken)return;
    clearUgcBackup(this.data.ownerId,postId,this.data.version);this.setData({dirty:false});this.syncUnloadWarning();
    this.pendingWrite=null;void this.loadDraft(postId,false);
  },
  async submit() {
    if(this.data.mediaDragging)return;
    if(this.pendingImageEdit){this.setData({error:"请先重试使用修改后的图片，或放弃本次图片修改。"});return;}
    if (this.data.busy || this.data.uploadBusy || this.data.writeRecovery||!this.data.postId||!["draft","rejected","published"].includes(this.data.state)) return;
    if(!this.data.publicGateEnabled){this.setData({error:"投稿发布暂未开放，仍可保存仅自己可见的草稿。"});return;}
    if (!this.data.body.trim() && !this.data.files.length) { this.setData({ error: "请写一点内容，或添加至少一张图片。" }); return; }
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,postId=this.data.postId;
    const draft = await this.saveDraft(); if (!draft) return;
    if(!this.pageAlive||!this.mediaVisible||epoch!==this.data.epoch||token!==getApp<IAppOption>().globalData.sessionToken||postId!==this.data.postId||!["draft","rejected","published"].includes(this.data.state))return;
    const pending=this.newPendingWrite("submit");this.pendingWrite=pending;
    this.setData({ busy: true,operation:"submitting", error: "", notice: "" });
    try {
      const sent = await request<Draft>({ path: `/v1/me/ugc/posts/${draft.id}/submit`, method: "POST", data: { expectedVersion: draft.version } });
      if(this.writeIsCurrent(pending)&&this.mediaVisible)this.finishWrite(pending,sent);
    } catch (error) { if(!this.writeIsCurrent(pending))return;
      this.setData({busy:false,operation:"idle"});
      if(unknownWrite(error)){this.setData({writeRecovery:"submit",error:"提交结果暂未确认，正在核对审核状态。"});if(this.mediaVisible)await this.verifyWriteResult();}
      else{this.pendingWrite=null;this.setData({writeRecovery:"",recoveryBusy:false,error:message(error,"提交未完成，草稿仍保留。")});}}
  },
  async discardFreshDraft():Promise<boolean>{
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    if(this.createdHerePostId===this.data.postId&&this.data.postId&&this.data.version===1&&this.data.state==="draft"){
      const postId=this.data.postId,ownerId=this.data.ownerId,revision=this.readRevision;
      const snapshot=JSON.stringify([this.data.title,this.data.body,this.data.files]);
      const current=()=>this.pageAlive&&this.mediaVisible&&epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&revision===commerceContextRevision()&&postId===this.data.postId&&ownerId===this.data.ownerId&&this.data.version===1;
      this.setData({busy:true,error:""});let removed=false;
      try{await request({path:`/v1/me/ugc/posts/${postId}`,method:"DELETE",data:{expectedVersion:1}});removed=true;}
      catch{try{const own=await pageRead<Draft>(this,{path:`/v1/me/ugc/posts/${postId}`});removed=own.id===postId&&own.ownerId===ownerId&&own.state==="deleted";}catch{/* Unknown deletion cannot be called discarded. */}}
      if(!current())return false;
      this.setData({busy:false});
      if(!removed){this.setData({error:"空草稿处理结果待确认，请稍后重试离开。"});return false;}
      if(snapshot!==JSON.stringify([this.data.title,this.data.body,this.data.files])){this.createdHerePostId="";this.setData({state:"deleted",publicVersionActive:false,error:"本篇新草稿已删除，刚收到的本机输入仍保留，请先复制后离开。"});this.flushLocalBackup();this.syncUnloadWarning();return false;}
      this.createdHerePostId="";clearUgcBackup(ownerId,postId,1);return true;
    }
    return false;
  },
  async confirmLeave():Promise<boolean> {
    if(this.data.busy||this.data.uploadBusy||this.data.recoveryBusy)return false;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    if(this.localTextEntryIsCurrent()){
      const entry=this.localTextEntry!;
      if(this.pendingLocalText?.sent){const answer=await wx.showModal({title:"新建结果仍待核对",content:"文字仅保留在当前页面，离开后可能丢失。离开不会撤销已经发送的新建操作，可继续重试核对同一篇草稿。",confirmText:"确认离开",cancelText:"继续核对"}).catch(()=>null);
        const leaving=answer?.confirm===true&&this.mediaVisible&&this.localTextEntryIsCurrent(entry);if(leaving)this.setData({textCardHandoffPath:""});return leaving;}
      if(!hasTextCardContent(this.data.textCardText)&&!this.data.title&&!this.data.body)return true;
      const options=await wx.showActionSheet({itemList:["保存原始文字后离开","继续编辑","不保存文字，离开"]}).catch(()=>null);
      if(!options||!this.mediaVisible||!this.localTextEntryIsCurrent(entry))return false;
      if(options.tapIndex===0){if(this.data.textCardText.length>5000){this.setData({error:"正文最多5000字，输入仍保留，请精简后保存。"});return false;}
        const candidate=this.newLocalTextCandidate("save",null);this.pendingLocalText=candidate;return this.materializeLocalText(candidate);}
      if(options.tapIndex===1){this.pendingLocalText=null;this.openTextCard("entry");return false;}
      if(options.tapIndex!==2)return false;
      this.pendingLocalText=null;this.setData({dirty:false,textCardHandoffPath:""});this.syncUnloadWarning();return true;
    }
    if(this.pendingImageEdit){const candidate=this.pendingImageEdit;
      const answer=await wx.showModal({title:"放弃本次图片修改？",content:"修改后的图片尚未应用，原图仍保留。确认放弃后再离开。",confirmText:"放弃修改",cancelText:"继续处理"}).catch(()=>null);
      if(!answer?.confirm||!this.imageEditCandidateIsCurrent(candidate))return false;
      this.clearPendingImageEdit();this.syncUnloadWarning();}
    if(this.createdHerePostId===this.data.postId&&this.data.postId&&this.data.version===1&&this.data.state==="draft"&&!this.data.dirty&&!this.data.title&&!this.data.body&&!this.data.files.length)return this.discardFreshDraft();
    if(this.pendingWrite||this.data.writeRecovery){
      const confirmed=this.pendingWrite?await this.verifyWriteResult():null;
      if(!this.pageAlive||!this.mediaVisible||epoch!==this.data.epoch||token!==getApp<IAppOption>().globalData.sessionToken)return false;
      if(!confirmed&&(this.pendingWrite||this.data.writeRecovery)){
        const retained=this.flushLocalBackup();
        const answer=await wx.showModal({title:"操作结果仍待核对",content:retained?
          "当前输入已保留。离开不会撤销已经发送的操作，返回后需核对最新状态。":
          "当前输入尚未成功备份，离开可能丢失未保存修改。已经发送的操作不会撤销，返回后仍需核对最新状态。",confirmText:"确认离开",cancelText:"继续核对"}).catch(()=>null);
        return answer?.confirm===true&&this.pageAlive&&this.mediaVisible&&epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken;
      }
    }
    if(this.data.dirty&&this.data.postId&&!["draft","rejected","published"].includes(this.data.state)){
      const retained=this.flushLocalBackup();
      const noListRecovery=this.data.state==="deleted"||this.data.state==="hidden";
      const answer=await wx.showModal({title:this.data.state==="deleted"?"这篇内容已删除":this.data.state==="hidden"?"这篇内容已下架":"内容状态已有更新",content:noListRecovery?
        "修改暂留本页，请先复制需要的文字或查看图片；离开后无法从投稿列表找回本次未保存修改。已保存内容与处理记录仍按实际状态保留。":retained?
          "本机尚未保存的修改已保留。当前内容不能继续保存或提交，可以确认离开，或留在本页查看修改。":
          "当前内容不能继续保存或提交，且本机备份尚未成功。离开可能丢失未保存修改。",confirmText:"确认离开",cancelText:"继续查看"}).catch(()=>null);
      return answer?.confirm===true&&this.pageAlive&&this.mediaVisible&&epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken;
    }
    if (this.data.dirty && this.data.postId) {
      const options=await wx.showActionSheet({itemList:["保存草稿后离开","继续编辑","不保存修改，离开"]}).catch(()=>null);
      if(!options||epoch!==this.data.epoch||(token!==getApp<IAppOption>().globalData.sessionToken||this.readRevision!==commerceContextRevision()))return false;
      if(options.tapIndex===1)return false;
      if(options.tapIndex===0){if(!await this.saveDraft())return false;}
      else if(options.tapIndex===2){if(this.createdHerePostId===this.data.postId&&this.data.version===1&&this.data.state==="draft"&&!await this.discardFreshDraft())return false;
        clearUgcBackup(this.data.ownerId,this.data.postId,this.data.version);this.setData({dirty:false});this.syncUnloadWarning();}
      else return false;
    }
    return this.pageAlive&&this.mediaVisible&&epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken;
  },
  async showMyPosts(){if(await this.confirmLeave()){this.pendingWrite=null;this.setData({writeRecovery:"",requestedNew:false,requestedDraftId:"",postId:"",ownerId:"",files:[]});void this.loadList();}},
  async returnToCommunity(){if(await this.confirmLeave())wx.switchTab({url:"/pages/community/index",fail:()=>this.setData({error:"社区暂时无法打开，请重试。"})});},
  async refreshAfterPublishedReturn(){
    const context=this.publishedReturn;if(!context)return;
    const attempt=++this.publishedReturnAttempt;
    const current=()=>this.pageAlive&&this.mediaVisible&&this.publishedReturn===context&&attempt===this.publishedReturnAttempt&&
      context.epoch===this.data.epoch&&context.postId===this.data.postId&&context.ownerId===this.data.ownerId&&
      context.token===getApp<IAppOption>().globalData.sessionToken&&context.revision===commerceContextRevision();
    if(!current())return;this.setData({recoveryBusy:true});
    try{const draft=await pageRead<Draft>(this,{path:`/v1/me/ugc/posts/${context.postId}`});
      if(!current())return;
      if(draft.id!==context.postId||draft.ownerId!==context.ownerId)throw {title:"内容归属尚未确认，请重新打开投稿核对。"};
      this.publishedReturn=null;
      if(this.data.dirty){this.flushLocalBackup();this.setData({state:draft.state,publicVersionActive:draft.publicVersionActive,
        reviewNote:draft.reviewNote??"",hiddenReason:draft.hiddenReason??"",hiddenPublished:draft.hiddenPublished??null,appeal:draft.appeal??null,
        notice:draft.state==="deleted"||draft.state==="hidden"?"修改暂留本页，请先复制需要的文字或查看图片；离开后无法从投稿列表找回。":"已核对最新状态，本机尚未保存的修改仍保留。",error:""});this.syncUnloadWarning();}
      else this.applyDraft(draft,false);
      this.setData({recoveryBusy:false});
    }catch(error){if(current())this.setData({publicVersionActive:false,recoveryBusy:false,error:message(error,"暂时无法核对公开内容状态，请返回后再试。")});}
  },
  openPublishedPost(){if(!this.data.publicVersionActive||!this.data.postId||this.data.busy||this.data.uploadBusy||this.data.recoveryBusy||this.data.writeRecovery)return;
    if(this.pendingImageEdit){this.setData({error:"请先重试使用修改后的图片，或放弃本次图片修改。"});return;}
    const context:PublishedReturn={postId:this.data.postId,ownerId:this.data.ownerId,epoch:this.data.epoch,token:getApp<IAppOption>().globalData.sessionToken,revision:this.readRevision};
    this.flushLocalBackup();this.publishedReturn=context;
    wx.navigateTo({url:`/pages/community-post/index?id=${encodeURIComponent(context.postId)}`,fail:()=>{
      if(this.publishedReturn===context){this.publishedReturn=null;this.setData({error:"公开内容暂时无法打开，请重试。"});}}});},
  async back(){if(await this.confirmLeave())wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/community/index"})});}
});
