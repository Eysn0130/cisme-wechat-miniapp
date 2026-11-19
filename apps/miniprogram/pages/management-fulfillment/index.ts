import { authorityProjection, hasCapability, type AuthorityProjection } from "../../services/authority";
import { downloadPrivateMedia, request } from "../../services/api";
import { beijingDateParts } from "../../services/business-time";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { currentChromeStyle, shouldReduceMotion } from "../../services/layout";
import { clientOperationKey } from "../../services/orders";
import { cancelPageReads, pageRead } from "../../services/page-requests";

type Scope = { token: string; revision: number };
type Parcel = { carrierCode: string; carrierName: string; trackingNumber: string; shippedAt: string };
type Member = { memberNickname: string | null; memberCardNumber: string | null };
type Order = Member & {
  id: string; orderNumber: string; items: string; paidAt: string; shippedAt: string | null;
  logisticsState: string; carrierName: string | null; wechatSyncState: string | null; receiptConfirmedAt: string | null;
};
type OrderCard = Order & { memberLabel: string; dateLabel: string; stateLabel: string; syncLabel: string };
type Entry = Member & {
  line: number; orderId: string | null; orderNumber: string; parcel?: Parcel; detail?: string; code?: string;
  state: "ready" | "issue" | "registered"; expectedOrderVersion?: number;
  wechatSyncState?: string | null; logisticsMessageState?: string | null;
};
type Outcome = {
  orderId: string; status: "accepted" | "rejected"; code?: string; shipment?: { wechatSyncState: string };
};
type Batch = {
  key: string; entries: Array<Entry & { orderId: string; parcel: Parcel; expectedOrderVersion: number }>;
  offset: number; results: Map<string, Outcome>; uncertain: boolean;
};
type Review = { entries: Entry[]; skippedRows: number };
type RowState = "ready" | "issue" | "registered" | "pending";
type ReviewFilter = "all" | RowState;
type EntryCard = Entry & { rowState: RowState; label: string; memberLabel: string; dateLabel: string; note: string; syncLabel: string; messageLabel: string };
type View = "list" | "paste" | "review" | "sending" | "results";
type Problem = { status?: number; title?: string; code?: string; errMsg?: string };

const stages = [{ id: "awaiting_dispatch", label: "待发货" }, { id: "dispatched", label: "已发货" }];
const stateLabels: Record<string,string> = { awaiting_dispatch:"待发货", shipped:"已发货", delivered:"快递已签收", exception:"物流异常" };
const syncLabels: Record<string,string> = { prepared:"等待微信同步", dispatching:"正在提交微信", verifying:"微信核对中", synced:"微信已同步", manual_review:"微信同步需核对" };
const messageLabels: Record<string,string> = { queued:"物流消息待登记", retry:"物流消息待重试", dispatching:"物流消息核对中", registered:"物流消息已登记", unknown:"物流消息核对中", review:"物流消息需核对", cancelled:"物流消息已停止" };
const issues: Record<string,string> = {
  ORDER_ALREADY_SHIPPED: "订单已有物流，请打开订单核对",
  SHIPMENT_EXISTING_CONFLICT: "清单的运单或交寄时间与已登记的信息不同",
  SHIPMENT_IMPORT_ORDER_NOT_FOUND: "未找到订单，请核对完整订单号",
  SHIPMENT_PAID_ORDER_REQUIRED: "订单未确认支付",
  VERSION_CONFLICT: "订单已变更，请重新核对后提交",
  SHIPMENT_REFUND_REVIEW_REQUIRED: "有退款待处理，请先核对订单",
  SHIPMENT_AFTERSALE_REVIEW_REQUIRED: "有售后待处理，请先核对订单",
  SHIPMENT_TIME_INVALID: "交寄时间须在支付后且不能晚于当前时间",
  SHIPMENT_ADDRESS_REQUIRED: "订单缺少收货信息",
  SHIPMENT_LINES_REQUIRED: "订单缺少商品明细",
  SHIPPING_PROPOSAL_CONFLICT: "已有微信发货记录，请打开订单核对",
  SHIPPING_PAYMENT_BINDING_REQUIRED: "订单与微信支付记录待核对",
  WECHAT_SHIPPING_BINDING_INVALID: "订单与微信支付记录待核对",
  SHIPPING_FINANCIAL_REVIEW_REQUIRED: "订单的支付或退款状态待核对"
};
const uncertainCodes = new Set(["TRANSACTION_OUTCOME_UNKNOWN", "SHIPMENT_REVIEW_REQUIRED"]);
const previewPath = "/v1/management/shipments/import-xlsx/preview";
const exportLimit = 500;
const chunkSize = 10;
const cardPageSize = 24;

function access(a: AuthorityProjection) {
  return a.version === 1 && a.managementAvailable && hasCapability(a, "commerce.fulfillment.manage");
}
function dateLabel(instant: string) {
  const civil = beijingDateParts(instant);
  return civil.date ? `${civil.date.replace(/-/g, "/")} ${civil.time}` : "";
}
function memberLabel(row: Member) {
  return row.memberNickname?.trim() || (row.memberCardNumber ? "会员" : "昵称未留存");
}
function makeOrderCard(row: Order): OrderCard {
  return {
    ...row, memberLabel:memberLabel(row),
    dateLabel:dateLabel(row.shippedAt || row.paidAt),
    stateLabel: row.receiptConfirmedAt && row.logisticsState !== "exception" ? "已收货" : stateLabels[row.logisticsState] || "待核对",
    syncLabel:syncLabels[row.wechatSyncState || ""] || ""
  };
}
function makeEntryCard(row: Entry, batch: Batch | null): EntryCard {
  const answer = row.orderId ? batch?.results.get(row.orderId) : undefined;
  const registered = row.state === "registered" || answer?.status === "accepted";
  const pending = !registered && !!batch && row.state === "ready"
    && (!answer || uncertainCodes.has(answer.code || ""));
  const rowState = registered ? "registered" : pending ? "pending" : answer?.status === "rejected" ? "issue" : row.state;
  const note = rowState === "issue" ? row.detail || issues[row.code || answer?.code || ""] || "请打开订单核对后再提交" : "";
  return {
    ...row, rowState, note, memberLabel:row.orderId ? memberLabel(row) : "",
    label:({ready:"可登记",registered:"已登记",issue:batch && answer ? "登记未完成" : "待处理",
      pending:batch?.uncertain&&batch.entries.slice(batch.offset,batch.offset+chunkSize).some(candidate=>candidate.orderId===row.orderId)?"待核对":"未提交"})[rowState],
    dateLabel:row.parcel ? dateLabel(row.parcel.shippedAt) : "",
    syncLabel:registered ? syncLabels[row.wechatSyncState || answer?.shipment?.wechatSyncState || ""] || "" : "",
    messageLabel:registered ? messageLabels[row.logisticsMessageState || ""] || "" : ""
  };
}

Page({
  visible:false, disposed:false, sequence:0, scope:null as Scope|null, timer:null as ReturnType<typeof setInterval>|null,
  download:null as ReturnType<typeof downloadPrivateMedia>|null, openingDocument:false,
  entries:[] as Entry[], batch:null as Batch|null, fileName:"", skippedRows:0, rowLimit:cardPageSize,
  data:{
    chromeStyle:currentChromeStyle(), reducedMotion:false, view:"list" as View, stages, stage:"awaiting_dispatch",
    number:"", appliedNumber:"", dateOpen:false, from:"", through:"", totalCount:null as number|null,
    items:[] as OrderCard[], nextCursor:null as string|null, loading:true, loadingMore:false, coreReady:false, canOrders:false,
    busy:false, checkingFile:false, error:"", notice:"", pasteRows:"",
    fileName:"", skippedRows:0, entries:[] as EntryCard[], reviewFilter:"all" as ReviewFilter,
    readyCount:0, registeredCount:0, issueCount:0, pendingCount:0, rowCount:0, moreRows:false,
    retryBatch:false, sentCount:0, sendTotal:0, progress:0
  },
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  onShow(){
    this.visible=true;this.setData({reducedMotion:shouldReduceMotion()});
    if(this.openingDocument)this.releaseDownload();
    return this.load();
  },
  async onPullDownRefresh(){
    try{if(this.canAct()){if(this.data.view==="list")await this.load();else if(this.data.view==="results")await this.reconcileBatch();}}
    finally{wx.stopPullDownRefresh();}
  },
  onHide(){
    this.visible=false;this.sequence++;cancelPageReads(this);this.stopPolling();
    if(!this.openingDocument)this.releaseDownload();
    this.setData({coreReady:false,canOrders:false,items:[],entries:[],nextCursor:null,pasteRows:""});
  },
  onUnload(){this.onHide();this.disposed=true;this.scope=null;this.entries=[];this.batch=null;this.releaseDownload();},
  owns(scope:Scope|null):scope is Scope{
    return !!scope&&scope===this.scope&&!this.disposed&&scope.token===getApp<IAppOption>().globalData.sessionToken
      &&scope.revision===commerceContextRevision();
  },
  canAct(){return this.visible&&this.owns(this.scope)&&this.data.coreReady&&!this.data.busy&&!this.data.loading;},
  releaseDownload(){this.download?.abort();this.download=null;this.openingDocument=false;},
  stopPolling(){if(this.timer!==null)clearInterval(this.timer);this.timer=null;},
  invalidate(error="登录或权限已变化，请重新核对。"){
    this.stopPolling();this.releaseDownload();this.scope=null;this.resetReview();
    this.setData({items:[],nextCursor:null,totalCount:null,coreReady:false,canOrders:false,loadingMore:false,loading:false,busy:false,
      checkingFile:false,number:"",appliedNumber:"",from:"",through:"",dateOpen:false,view:"list",error,notice:""});
  },
  async recheck(){
    if(!this.visible||!this.data.coreReady)return;
    const scope=this.scope,seq=this.sequence;
    if(!this.owns(scope)){this.invalidate();return;}
    if(this.data.busy||this.data.loading)return;
    try{
      const authority=await authorityProjection(this);
      if(seq!==this.sequence)return;
      if(this.visible&&this.scope===scope&&(!this.owns(scope)||!access(authority)))this.invalidate("当前账号没有履约权限。");
      else if(this.visible&&this.owns(scope))this.setData({canOrders:hasCapability(authority,"commerce.order.read")});
    }catch(error){
      if(this.visible&&seq===this.sequence&&this.scope===scope&&(!this.owns(scope)||[401,403].includes((error as Problem)?.status||0)))this.invalidate();
    }
  },
  filters(){
    const {stage,appliedNumber,from,through}=this.data;
    return `state=${stage}&orderNumber=${encodeURIComponent(appliedNumber)}&from=${from}&through=${through}`;
  },
  async load(next=false){
    if(!this.visible||this.disposed)return;
    if(next&&(!this.canAct()||this.data.loadingMore||!this.data.nextCursor))return;
    if(this.scope&&!this.owns(this.scope))this.invalidate();
    const scope=this.scope??{token:getApp<IAppOption>().globalData.sessionToken,revision:commerceContextRevision()};
    this.scope=scope;
    const cursor=next?this.data.nextCursor:null, seq=++this.sequence;
    cancelPageReads(this);this.stopPolling();
    if(next)this.setData({loadingMore:true,notice:""});
    else this.setData({loading:true,error:"",coreReady:false,canOrders:false});
    try{
      const authority=await authorityProjection(this);
      if(!this.visible||seq!==this.sequence||!this.owns(scope))return;
      if(!access(authority)){this.invalidate("当前账号没有履约权限。");return;}
      if(this.data.view==="list"){
        const result=await pageRead<{items:Order[];nextCursor:string|null;totalCount:number}>(this,
          {path:`/v1/management/shipments?${this.filters()}&limit=${cardPageSize}${cursor?`&before=${encodeURIComponent(cursor)}`:""}`});
        if(!this.visible||seq!==this.sequence||!this.owns(scope))return;
        this.setData({items:(next?this.data.items:[]).concat(result.items.map(makeOrderCard)),nextCursor:result.nextCursor,
          ...(next?{}:{totalCount:result.totalCount})});
      }
      this.setData({coreReady:true,canOrders:hasCapability(authority,"commerce.order.read")});
      if(this.data.view!=="list")this.renderReview();
      this.timer=setInterval(()=>void this.recheck(),6000);
    }catch(error){
      if(!this.visible||seq!==this.sequence)return;
      if(!this.owns(scope)||[401,403].includes((error as Problem)?.status||0))this.invalidate("当前账号没有履约权限。");
      else if(next)this.setData({notice:"后续订单加载失败，请重试。"});
      else this.setData({items:[],nextCursor:null,totalCount:null,error:"订单暂时无法加载，请重试。"});
    }finally{
      if(this.visible&&seq===this.sequence){
        if(!this.owns(scope)&&this.scope===scope)this.invalidate();
        this.setData({loading:false,loadingMore:false});
      }
    }
  },
  selectStage(e:{detail:{value:string}}){
    const stage=e.detail.value;
    if(!this.canAct()||stage===this.data.stage||!stages.some(s=>s.id===stage))return;
    this.setData({stage,from:"",through:"",dateOpen:false,notice:"",items:[],totalCount:null,nextCursor:null});
    void this.load();
  },
  changeNumber(e:WechatMiniprogram.Input){this.setData({number:e.detail.value});},
  search(){
    if(!this.canAct())return;
    const number=this.data.number.trim();
    if(number&&!/^[A-Za-z0-9_*-]{1,32}$/.test(number)){this.setData({notice:"请填写完整的商品订单号。"});return;}
    this.setData({appliedNumber:number,number,notice:"",items:[],totalCount:null,nextCursor:null});void this.load();
  },
  clearNumber(){if(this.canAct()){this.setData({number:""});this.search();}},
  toggleDates(){if(this.canAct())this.setData({dateOpen:!this.data.dateOpen});},
  setDate(e:WechatMiniprogram.PickerChange){
    if(!this.canAct())return;
    const value=String(e.detail.value);
    if(e.currentTarget.dataset.field==="from")this.setData({from:value});else this.setData({through:value});
    this.reloadFilters();
  },
  clearDates(){if(this.canAct()){this.setData({from:"",through:""});this.reloadFilters();}},
  reloadFilters(){this.setData({notice:"",items:[],totalCount:null,nextCursor:null});void this.load();},
  async exportExcel(){
    const scope=this.scope,n=this.data.totalCount,filter=this.filters();
    if(!this.canAct()||!this.owns(scope)||this.data.view!=="list"||this.data.stage!=="awaiting_dispatch"||!n||n>exportLimit)return;
    this.releaseDownload();this.setData({busy:true,notice:""});
    try{
      const approved=await new Promise<boolean>(resolve=>wx.showModal({
        title:"下载待发货清单",content:"清单包含收件人、配送电话和地址，仅用于发货。此操作会记录导出人和筛选条件。",
        confirmText:"下载",success:r=>resolve(r.confirm),fail:()=>resolve(false)
      }));
      if(!approved||!this.owns(scope)||!this.visible)return;
      this.download=downloadPrivateMedia(`/v1/management/shipments/export?${filter}&limit=${exportLimit}&expectedCount=${n}`);
      const filePath=await this.download.promise;
      const authority=await authorityProjection(this);
      if(!this.owns(scope)||!this.visible)return;
      if(!access(authority)){this.invalidate("当前账号没有履约权限。");return;}
      this.openingDocument=true;
      await new Promise<void>((resolve,reject)=>wx.openDocument({filePath,fileType:"xlsx",showMenu:true,success:()=>resolve(),fail:reject}));
    }catch(error){
      this.releaseDownload();
      if(this.owns(scope)&&this.visible){
        if([401,403].includes((error as Problem)?.status||0))this.invalidate("当前账号没有履约权限。");
        else this.setData({notice:"下载失败，请刷新待发货列表后重试。"});
      }
    }finally{if(this.owns(scope))this.setData({busy:false});}
  },
  async chooseXlsx(){
    const scope=this.scope;
    if(!this.canAct()||!this.owns(scope)||this.data.retryBatch)return;
    this.setData({busy:true,notice:""});
    let filePicked=false;
    try{
      const choice=await new Promise<WechatMiniprogram.ChooseMessageFileSuccessCallbackResult>((resolve,reject)=>
        wx.chooseMessageFile({count:1,type:"file",extension:["xlsx"],success:resolve,fail:reject}));
      if(!this.owns(scope))return;
      const file=choice.tempFiles[0];
      if(!file||file.size>2*1024*1024||!file.name.toLowerCase().endsWith(".xlsx")){
        this.setData({notice:"请选择 2 MB 以内的 XLSX 清单。"});return;
      }
      filePicked=true;this.setData({checkingFile:true});
      const encoded=await new Promise<string>((resolve,reject)=>wx.getFileSystemManager().readFile({
        filePath:file.path,encoding:"base64",success:r=>typeof r.data==="string"?resolve(r.data):reject(new Error("FILE_READ_FAILED")),fail:reject
      }));
      if(!this.owns(scope))return;
      const review=await request<Review>({path:previewPath,method:"POST",data:{filename:file.name,contentBase64:encoded,review:true}});
      if(this.owns(scope))this.showReview(review,file.name);
    }catch(error){
      if(this.owns(scope)&&!String((error as Problem)?.errMsg||"").includes("cancel")){
        this.showProblem(error,filePicked?"清单未读取成功，请检查文件或重试。":"未能打开文件，请重试。");
      }
    }finally{if(this.owns(scope))this.setData({busy:false,checkingFile:false});}
  },
  showProblem(error:unknown,fallback:string){
    const problem=error as Problem;
    if([401,403].includes(problem?.status||0)){this.invalidate("当前账号没有履约权限。");return;}
    this.setData({notice:problem?.status===422&&problem.title?problem.title:fallback});
  },
  openPaste(){if(this.canAct())this.setData({view:"paste",pasteRows:"",notice:""});},
  writePaste(e:WechatMiniprogram.Input){this.setData({pasteRows:e.detail.value});},
  async previewPaste(){
    const scope=this.scope,rows=this.data.pasteRows;
    if(!this.canAct()||!this.owns(scope)||!rows.trim())return;
    this.setData({busy:true,checkingFile:true,notice:""});
    try{
      const review=await request<Review>({path:previewPath,method:"POST",data:{rows}});
      if(this.owns(scope))this.showReview(review,"粘贴的运单");
    }catch(error){if(this.owns(scope))this.showProblem(error,"核对失败，请重试。");}
    finally{if(this.owns(scope))this.setData({busy:false,checkingFile:false});}
  },
  showReview(review:Review,fileName:string){
    if(!Array.isArray(review.entries)||!review.entries.length)throw {code:"SHIPMENT_REVIEW_UNAVAILABLE"};
    this.entries=review.entries;this.batch=null;this.fileName=fileName;this.skippedRows=review.skippedRows;this.rowLimit=cardPageSize;
    this.setData({view:"review",pasteRows:"",notice:"",reviewFilter:"all"});this.renderReview();
    if(this.visible)wx.pageScrollTo({scrollTop:0,duration:0});
  },
  renderReview(){
    const entries:Entry[]=this.entries;
    const cards=entries.map(row=>makeEntryCard(row,this.batch));
    const counts={ready:0,registered:0,issue:0,pending:0};
    for(const card of cards)counts[card.rowState]++;
    const filter=this.data.reviewFilter, shown=filter==="all"?cards:cards.filter(card=>card.rowState===filter);
    this.setData({fileName:this.fileName,skippedRows:this.skippedRows,entries:this.visible?shown.slice(0,this.rowLimit):[],
      readyCount:counts.ready,registeredCount:counts.registered,issueCount:counts.issue,pendingCount:counts.pending,rowCount:cards.length,
      moreRows:shown.length>this.rowLimit,retryBatch:!!this.batch&&this.batch.offset<this.batch.entries.length});
  },
  filterReview(e:WechatMiniprogram.TouchEvent){
    if(!this.canAct())return;
    const filter=String(e.currentTarget.dataset.filter) as ReviewFilter;
    this.rowLimit=cardPageSize;this.setData({reviewFilter:this.data.reviewFilter===filter?"all":filter});this.renderReview();
  },
  moreReview(){if(this.canAct()){this.rowLimit+=cardPageSize;this.renderReview();}},
  async submit(){
    const scope=this.scope;
    if(!this.canAct()||!this.owns(scope)||this.data.view!=="review"||this.batch)return;
    const review:Entry[]=this.entries;
    const entries=review.filter((row):row is Batch["entries"][number]=>row.state==="ready"&&!!row.parcel&&!!row.orderId&&!!row.expectedOrderVersion);
    if(!entries.length)return;
    this.setData({busy:true,notice:""});
    const issuesToSkip=this.data.issueCount;
    const confirmed=await new Promise<boolean>(resolve=>wx.showModal({
      title:`登记 ${entries.length} 笔发货`,
      content:`请确认这些包裹已实际交给快递。登记后将更新订单状态。${issuesToSkip?`另有 ${issuesToSkip} 行待处理，本次跳过。`:""}`,
      confirmText:"确认登记",success:r=>resolve(r.confirm),fail:()=>resolve(false)
    }));
    if(!this.owns(scope))return;
    this.setData({busy:false});
    if(!confirmed||!this.visible)return;
    this.batch={key:clientOperationKey("shipment"),entries,offset:0,results:new Map(),uncertain:false};
    await this.sendBatch();
  },
  async sendBatch(){
    const scope=this.scope,batch:Batch|null=this.batch;
    if(!this.canAct()||!this.owns(scope)||!batch||batch.offset===batch.entries.length)return;
    this.setData({view:"sending",busy:true,notice:"",sendTotal:batch.entries.length,sentCount:batch.offset,
      progress:Math.floor(batch.offset*100/batch.entries.length),reviewFilter:"all"});
    wx.pageScrollTo({scrollTop:0,duration:0});
    try{
      while(this.visible&&this.owns(scope)&&batch.offset<batch.entries.length){
        const chunk=batch.entries.slice(batch.offset,batch.offset+chunkSize);
        const entries=chunk.map(row=>({orderId:row.orderId,...row.parcel,expectedOrderVersion:row.expectedOrderVersion,
          evidenceReference:`batch:${batch.key}`}));
        batch.uncertain=true;
        const response=await request<{results:Outcome[]}>({path:"/v1/management/shipments/batch",method:"POST",budgetMs:60_000,
          idempotencyKey:`${batch.key}-${batch.offset/chunkSize}`,data:{entries}});
        if(!this.owns(scope))return;
        if(response.results.length!==chunk.length||chunk.some((row,index)=>response.results[index]?.orderId!==row.orderId))
          throw {code:"SHIPMENT_RESULT_MISMATCH"};
        for(const item of response.results)batch.results.set(item.orderId,item);
        if(response.results.some(item=>uncertainCodes.has(item.code||"")))break;
        batch.uncertain=false;batch.offset+=chunk.length;
        this.setData({sentCount:batch.offset,progress:Math.floor(batch.offset*100/batch.entries.length)});
      }
    }catch(error){
      if(this.owns(scope)&&[401,403].includes((error as Problem)?.status||0))this.invalidate("当前账号没有履约权限。");
    }finally{
      if(this.owns(scope)){
        const paused=batch.offset<batch.entries.length;
        this.rowLimit=cardPageSize;
        this.setData({view:"results",busy:false,reviewFilter:"all",notice:paused?
          (batch.uncertain?"部分结果待核对。可先查询，也可用原批次继续。":"登记已暂停，可以继续本批。"):""});
        this.renderReview();
      }
    }
  },
  async reconcileBatch(){
    const scope=this.scope;
    if(!this.canAct()||!this.owns(scope)||this.data.view!=="results")return;
    const entries:Entry[]=this.entries;
    const rows=entries.filter(row=>row.parcel).map(({orderNumber,parcel})=>
      [orderNumber,parcel!.carrierCode,parcel!.carrierName,parcel!.trackingNumber,parcel!.shippedAt].join("\t")).join("\n");
    if(!rows)return;
    this.setData({busy:true,notice:""});
    try{
      const review=await request<Review>({path:previewPath,method:"POST",data:{rows}});
      if(!this.owns(scope))return;
      const confirmed=new Map(review.entries.map(row=>[row.orderNumber,row]));
      this.entries=entries.map(row=>{
        const remote=row.parcel&&confirmed.get(row.orderNumber);
        return remote?{...remote,line:row.line}:row;
      });
      const batch:Batch|null=this.batch;
      if(batch?.uncertain){
        const chunk=batch.entries.slice(batch.offset,batch.offset+chunkSize);
        const resolved=chunk.every(row=>{
          const result=batch.results.get(row.orderId);
          return confirmed.get(row.orderNumber)?.state==="registered"||!!result&&!uncertainCodes.has(result.code||"");
        });
        if(resolved){batch.offset+=chunk.length;batch.uncertain=false;}
      }
      this.renderReview();
      if(this.data.retryBatch)this.setData({notice:"已核对现有发货记录，可以继续本批。"});
    }catch(error){if(this.owns(scope))this.showProblem(error,"暂时无法核对发货结果，请重试。");}
    finally{if(this.owns(scope))this.setData({busy:false});}
  },
  resetReview(){
    this.batch=null;this.entries=[];this.fileName="";this.skippedRows=0;this.rowLimit=cardPageSize;
    this.setData({fileName:"",entries:[],pasteRows:"",skippedRows:0,retryBatch:false,moreRows:false,rowCount:0,reviewFilter:"all",
      readyCount:0,issueCount:0,registeredCount:0,pendingCount:0,sentCount:0,sendTotal:0,progress:0});
  },
  newBatch(){
    if(!this.canAct()||this.data.retryBatch)return;
    this.resetReview();this.setData({view:"list",notice:""});void this.load();
  },
  openOrder(e:WechatMiniprogram.TouchEvent){
    if(!this.canAct()||!this.data.canOrders)return;
    const id=String(e.currentTarget.dataset.id||"");
    if(!id||!this.data.items.some(row=>row.id===id)&&!this.data.entries.some(row=>row.orderId===id))return;
    wx.navigateTo({url:`/pages/management-order-detail/index?id=${encodeURIComponent(id)}`});
  },
  retry(){void this.load();},
  next(){void this.load(true);},
  async back(){
    if(this.data.busy)return;
    if(this.data.view==="list"){wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management/index"})});return;}
    if(this.data.retryBatch){
      const scope=this.scope;
      const leave=await new Promise<boolean>(resolve=>wx.showModal({title:"本批仍有订单待核对",
        content:"返回后可重新上传原清单查询已登记的订单。已登记的发货记录会保留。",confirmText:"返回列表",
        success:r=>resolve(r.confirm),fail:()=>resolve(false)}));
      if(!leave||!this.owns(scope))return;
    }
    this.resetReview();this.setData({view:"list",notice:""});void this.load();
  }
});
