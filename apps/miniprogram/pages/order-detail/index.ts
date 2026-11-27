import {currentCreditOwner} from '../../services/points-feedback';
import { loadRecordedCommands, type RecordedGroup } from "../../services/commerce-command-discovery";
import type { CommerceCommandKind } from "../../services/commerce-command-store";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { acknowledgeCommerceCommand, executeCommerceCommand, readCommerceRecovery, retryCommerceCommand, type RecoveryView } from "../../services/commerce-command-recovery";
import { cancelPageReads, pageRead } from "../../services/page-requests";
import { cancelRuntimeRead, initialRuntimeView, runtimeActions, runtimeReadOwner, runtimeView, validateRuntime } from "../../services/commerce-runtime";
import { historicalCommerceClosed, historicalCommerceToken, request, requireHistoricalCommerceAccess } from "../../services/api";
import { centsToYuan } from "../../services/commerce";
import { aftersaleLabels } from '../../services/order-aftersale';
import { nativeCatalogImage } from "../../services/catalog";
import { clientOperationKey, myOrder, myShipment, myTracking, myLogisticsView, confirmMyReceipt, queryMyWechatReceipt, type OrderShipment, type OrderTracking, orderRuntimeStatus, type CommerceOrder, type MemberOrderAddress } from "../../services/orders";
import { beginWechatReceiptReturn, clearWechatReceiptReturn, takeWechatReceiptReturn } from "../../services/wechat-receipt-return";
import { currentChromeStyle, shouldReduceMotion } from "../../services/layout";
import { supportPollDelay } from "../../services/support-thread-state";
import { campaignEssenceCode } from "../../services/home-campaign";
import { markQualificationCompleted, qualificationOrderOwner, qualificationReturnDistance } from "../../services/sharing-qualification-purchase";
const labels:Record<string,string>={pending_payment:"待支付",cancelled:"已取消",expired:"已超时",paid:"已支付"};
const receiptLabels:Record<string,string>={unverified:"微信记录：待核对",awaiting_shipping:"微信记录：待发货",shipped:"微信记录：已发货",
  confirmed:"微信记录：已确认收货",completed:"微信记录：交易完成",refunded:"微信记录：已退款",
  settlement_pending:"微信记录：资金待结算",unknown:"微信记录：需人工核对"};
type RefundRow={id:string;orderId:string;amountCents:number;state:string;refundState:string|null;reason:string;createdAt:string;
  cashRefundCents:number|null;creditReturnCents:number|null;amountLabel?:string;stateLabel?:string;
  cashLabel?:string;creditLabel?:string};
type RefundPage={items:RefundRow[];totalCount:number;nextCursor:string|null};
const refundLabels:Record<string,string>={requested:"申请已收到",rejected:"申请未通过",approved:"退款处理中",prepared:"退款处理中",succeeded:"已退款",closed:"退款已关闭",abnormal:"退款需客服协助"};
const orderIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type SheetCaseLine={lineId:string;productName:string;skuLabel:string;quantity:number};
type SheetCase={id:string;orderId:string;state:string;kind:string;rejectionReason?:string;
  amountCents?:number;lines?:SheetCaseLine[];supportConversationId:string|null;returnDestination:any;refund:any;resolved:boolean};
type SheetAvailable={lineId:string;remainingQuantity:number;selectedQuantity:number;productName:string;skuLabel:string;image?:string};
type SheetAvailability={orderId?:string;lines:Array<{lineId:string;remainingQuantity:number}>;requiresWholeOrder?:boolean;fulfillmentState?:'shipped'|'unshipped'};
const errorTitle=(error:unknown,fallback:string)=>(error as {title?:string})?.title||fallback;
const sheetReasons=['','no_reason','quality','wrong_item','missing_item','delivery_issue','other'];
function sheetApplicationKind(fulfillment:SheetAvailability['fulfillmentState'],basis:string,kindIndex:number){
  if(basis==='no_reason')return 'return_refund';
  if(fulfillment==='unshipped'||fulfillment==='shipped'&&['missing_item','delivery_issue'].includes(basis))return 'refund_only';
  if(fulfillment==='shipped')return 'return_refund';
  return kindIndex===1?'return_refund':'refund_only';
}
function refundCents(value:string){const match=/^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(value.trim());
  return match?Number(match[1])*100+Number((match[2]??"").padEnd(2,"0")):NaN;}
function supportSheetSizes(){
  try{
    const {windowHeight,statusBarHeight}=wx.getWindowInfo();
    const available=windowHeight-Math.max(52,(statusBarHeight??0)+40);
    return {sheetHeight:windowHeight<=640?'86vh':'72vh',sheetWritingHeight:`${Math.round(Math.min(available,windowHeight*.9))}px`};
  }catch{return {sheetHeight:'72vh',sheetWritingHeight:'88vh'};}
}
Page({
  lastSessionToken:"",lastSessionRevision:-1,
  merchantOrderNumber:"",
  wechatReturn:null as 'success'|'fail'|'cancel'|null,shipmentAttempt:0,receiptQueryAttempt:0,
  launchAftersale:false,
  sheetTimer:null as ReturnType<typeof setTimeout>|null,sheetFailures:0,sheetReadEpoch:0,sheetPollInFlight:false,sheetValidationError:false,
  data:{rewardOwner:'',recordedHistoryOpen:false,fulfillmentOpen:false,recordedGroups:[] as RecordedGroup[],...initialRuntimeView(),closedRights:false,recoveryRows:[] as RecoveryView[],recoveryLoading:false,recoveryError:"",coreReady:false,visible:true,readEpoch:0,runtimeEpoch:0,refreshOnShow:false,chromeStyle:currentChromeStyle(),id:"",order:null as (CommerceOrder<MemberOrderAddress>&Record<string,unknown>)|null,
    tracking:null as (Omit<OrderTracking,"events">&{observedLabel:string;events:Array<OrderTracking["events"][number]&{timeLabel:string;key:string}>})|null,trackingLoading:false,trackingError:"",shipment:null as (OrderShipment&{stateLabel:string;shippedLabel:string;noCourier:boolean})|null,shipmentLoading:false,shipmentError:"",receiptQueryLoading:false,receiptQueryError:"",receiptKey:"",receiptVersion:0,isolatedPayment:false,paymentRecovery:false,refunds:[] as RefundRow[],refundTotal:0,refundCountLabel:"尚未读取退款记录",refundCursor:null as string|null,refundLoading:false,refundMoreLoading:false,refundError:"",
    refundFormVisible:false,refundAmount:"",refundReason:"",refundKey:"",actionStatus:"",actionError:"",
    loading:true,busy:false,navigating:false,error:"",invalidId:false,cancelKey:"",pageAlive:true,epoch:0,
    qualificationPurchase:false,qualificationMoment:false,qualificationReduced:false,
    supportSheetOpen:false,sheetLoading:false,sheetCasesReady:false,sheetLinesReady:false,sheetHasRemaining:false,sheetWholeOrder:false,
    sheetFulfillment:'' as SheetAvailability['fulfillmentState']|'',sheetApplicationLabel:'',sheetAvailable:[] as SheetAvailable[],
    sheetReapplying:false,sheetPreviousCase:null as SheetCase|null,sheetCaseLabel:"",
    sheetCaseAmount:"",sheetError:"",sheetCase:null as SheetCase|null,
    sheetKindIndex:1,sheetKindOptions:['仅退款','退货退款'],
    sheetBasisIndex:0,sheetBasisOptions:['请选择问题类型','七日无理由','商品问题','错发','漏发','物流问题','其他'],
    sheetReason:"",sheetSubmitting:false,sheetAttempt:null as {key:string;payload:Record<string,unknown>}|null,
    sheetKeyboardHeight:0,sheetHeight:'72vh',sheetWritingHeight:'88vh',sheetProgressHeight:'300px'},
  qualificationKey:'',
  qualificationAttempt:0,
  checkingQualification:false,
  qualificationTimer:null as ReturnType<typeof setTimeout>|null,
  paymentFollowupTimer:null as ReturnType<typeof setTimeout>|null,
  paymentFollowupPending:false,
  onResize(){this.setData({chromeStyle:currentChromeStyle(),...supportSheetSizes()});},onLoad(query:Record<string,string|undefined>){const id=query.id??"";
    this.qualificationKey=query.sharingQualification??'';
    this.merchantOrderNumber=query.outTradeNo??query.merchant_trade_no??"";
    this.launchAftersale=query.aftersale==='1';
    const merchantPresent=query.outTradeNo!==undefined||query.merchant_trade_no!==undefined;
    const merchantEntry=Boolean(this.merchantOrderNumber)&&/^CM[0-9]{8}[A-Z0-9]{12}$/.test(this.merchantOrderNumber)&&query.id===undefined
      &&!(query.outTradeNo&&query.merchant_trade_no&&query.outTradeNo!==query.merchant_trade_no);
    this.setData({id:merchantEntry?'':id,invalidId:!merchantEntry&&(!orderIdPattern.test(id)||merchantPresent),...supportSheetSizes()});},
  onShow(){this.setData({rewardOwner:currentCreditOwner()});this.data.pageAlive=true;this.data.visible=true;this.setData({navigating:false,closedRights:historicalCommerceClosed()});this.syncSession();
    if(!requireHistoricalCommerceAccess())return;
    this.setData({qualificationPurchase:!this.data.closedRights&&!!qualificationOrderOwner(this.qualificationKey,this.data.id)});
    this.wechatReturn=takeWechatReceiptReturn(this.data.id,historicalCommerceToken());
    void this.load();},
  syncSession(){const token=historicalCommerceToken(),changed=token!==this.lastSessionToken||this.lastSessionRevision!==commerceContextRevision();
    if(changed){this.stopQualificationMoment();this.stopPaymentFollowup();this.paymentFollowupPending=false;}
    if(changed&&this.merchantOrderNumber)this.setData({id:''});
    if(changed){clearWechatReceiptReturn();this.wechatReturn=null;this.receiptQueryAttempt+=1;this.lastSessionToken=token;this.lastSessionRevision=commerceContextRevision();this.data.epoch+=1;this.setData({recordedHistoryOpen:false,fulfillmentOpen:false,recordedGroups:[],...initialRuntimeView(),recoveryRows:[],recoveryLoading:false,recoveryError:"",busy:false,coreReady:false,isolatedPayment:false,paymentRecovery:false,order:null,tracking:null,trackingLoading:false,trackingError:"",shipment:null,shipmentLoading:false,shipmentError:"",receiptQueryLoading:false,receiptQueryError:"",receiptKey:"",receiptVersion:0,refunds:[],refundTotal:0,refundCountLabel:"尚未读取退款记录",refundCursor:null,
      refundFormVisible:false,refundAmount:"",refundReason:"",refundKey:"",cancelKey:"",actionError:"",actionStatus:""});}
    if(changed){this.stopSheetPoll();this.sheetReadEpoch+=1;this.sheetValidationError=false;this.setData({supportSheetOpen:false,sheetCasesReady:false,sheetLinesReady:false,sheetHasRemaining:false,sheetWholeOrder:false,sheetFulfillment:'',sheetApplicationLabel:'',sheetAvailable:[],sheetReapplying:false,sheetPreviousCase:null,sheetCaseLabel:"",sheetCaseAmount:"",sheetLoading:false,sheetSubmitting:false,sheetCase:null,sheetBasisIndex:0,sheetKindIndex:1,sheetReason:"",sheetAttempt:null,sheetKeyboardHeight:0,sheetError:""});}
    },
  confirmationPending:false,
  trackingAttempt:0,
  canAct(){return this.data.visible&&this.data.coreReady&&!this.confirmationPending&&this.lastSessionToken===historicalCommerceToken()&&this.lastSessionRevision===commerceContextRevision();},
  async confirmOperation(options:WechatMiniprogram.ShowModalOption):Promise<{confirm:boolean;cancel?:boolean}>{
    if(this.confirmationPending)return {confirm:false};this.confirmationPending=true;
    try{return await wx.showModal(options);}catch{return {confirm:false};}finally{this.confirmationPending=false;}
  },
  onUnload(){this.onHide();this.data.pageAlive=false;this.data.epoch+=1;},
  normalize(order: CommerceOrder<MemberOrderAddress>) {
    const {address} = order;
    const city = address && address.city !== address.province ? address.city : "";
    return {
      ...order,
      statusLabel: order.aftersale ? aftersaleLabels[order.aftersale.phase]
        : order.status === "paid" && (order.refundedCents ?? 0) > 0
          ? (order.refundedCents! >= order.totalCents ? "已退款" : "部分退款")
          : (labels[order.status] ?? order.status),
      totalYuan: centsToYuan(order.totalCents),
      subtotalYuan: centsToYuan(order.subtotalCents),
      discountYuan: centsToYuan(order.memberDiscountCents),
      couponDiscountYuan: centsToYuan(order.couponDiscountCents ?? 0),
      pointsDiscountYuan: centsToYuan(order.memberDiscountCents - (order.couponDiscountCents ?? 0)),
      shippingYuan: centsToYuan(order.shippingCents),
      creditYuan: centsToYuan(order.creditTenderCents),
      cashYuan: centsToYuan(order.cashPayableCents),
      createdLabel: new Date(order.createdAt).toLocaleString("zh-CN", {hour12: false}),
      expiresLabel: new Date(order.expiresAt).toLocaleString("zh-CN", {hour12: false}),
      lines: order.lines.map(line => ({
        ...line,
        image: nativeCatalogImage(line.image),
        unitPriceYuan: centsToYuan(line.unitPriceCents),
        totalYuan: centsToYuan(line.totalCents)
      })),
      addressSummary: address ? `${address.province}${city}${address.district} ${address.detail}` : ""
    };
  },
  current(epoch:number,token:string){return this.data.pageAlive&&this.data.epoch===epoch&&token===historicalCommerceToken()&&this.lastSessionRevision===commerceContextRevision();},
  readCurrent(epoch:number,token:string,readEpoch:number){return this.data.visible&&this.data.readEpoch===readEpoch&&this.current(epoch,token);},
  onHide(){this.data.visible=false;this.data.readEpoch+=1;this.data.runtimeEpoch+=1;this.receiptQueryAttempt+=1;this.trackingAttempt+=1;
    this.stopQualificationMoment();
    this.stopPaymentFollowup();
    this.stopSheetPoll();this.sheetReadEpoch+=1;this.data.refreshOnShow=true;this.setData({isolatedPayment:false,paymentRecovery:false,receiptQueryLoading:false,trackingLoading:false,sheetKeyboardHeight:0});cancelPageReads(this);cancelRuntimeRead(this);},
  finishAction(epoch:number,token:string,refreshCore=false){if(!this.current(epoch,token))return;
    this.setData({busy:false});if(this.data.visible&&(refreshCore||this.data.refreshOnShow)){this.data.refreshOnShow=false;void this.load();}else if(this.data.visible)void this.loadRecovery();},

  toggleFulfillment(){this.setData({fulfillmentOpen:!this.data.fulfillmentOpen});},
  toggleRecordedHistory(){this.setData({recordedHistoryOpen:!this.data.recordedHistoryOpen});},
  refreshRecordedCommands(){
    if(!this.data.visible||!this.data.coreReady)return;
    const epoch=this.data.epoch,readEpoch=this.data.readEpoch,token=historicalCommerceToken();
    void loadRecordedCommands(this,this.recoveryScope(),()=>this.readCurrent(epoch,token,readEpoch));
  },
  moreRecordedCommands(event:WechatMiniprogram.BaseEvent){
    if(!this.data.visible||!this.data.coreReady)return;
    const epoch=this.data.epoch,readEpoch=this.data.readEpoch,token=historicalCommerceToken();
    void loadRecordedCommands(this,this.recoveryScope(),()=>this.readCurrent(epoch,token,readEpoch),String(event.currentTarget.dataset.kind) as CommerceCommandKind);
  },
  recoveryScope(){return {group:"order" as const,objectId:this.data.id};},
  async loadRecovery(){if(!this.data.visible||!this.data.coreReady||this.data.busy)return;
    const epoch=this.data.epoch,readEpoch=this.data.readEpoch,token=historicalCommerceToken();
    const current=()=>this.readCurrent(epoch,token,readEpoch);
    this.setData({recoveryLoading:true,recoveryError:""});
    try{const recoveryRows=await readCommerceRecovery(this,this.recoveryScope(),current);if(current())this.setData({recoveryRows,recoveryLoading:false});}
    catch{if(current())this.setData({recoveryLoading:false,recoveryError:"上次操作暂时无法核对，请重试查询，不要重复申请。"});}
  },
  async resolveRecovery(event:WechatMiniprogram.BaseEvent){
    const key=String(event.currentTarget.dataset.key??""),row=this.data.recoveryRows.find(item=>item.key===key);
    if(!row||!this.canAct()||this.data.busy||!row.recorded&&!(row.kind==="cancel"||this.data.isolatedPayment))return;
    const epoch=this.data.epoch,token=historicalCommerceToken();
    const current=()=>this.current(epoch,token)&&this.data.visible&&this.data.coreReady&&(row.recorded||(row.kind==="cancel"||this.data.isolatedPayment));
    const answer=await this.confirmOperation({title:row.recorded?"确认已核对原操作？":"重试原操作？",content:row.recorded?"原申请已记录。请先查看付款、退款或到账进度，再开始新的申请。":"将先查询原结果，并使用最初确认的金额和内容重试；后续修改不会提交。重试可能继续原付款、退款或取消订单操作。",confirmText:row.recorded?"已核对":"重试原操作"});
    if(!answer.confirm||!current()||this.data.busy)return;
    this.setData({busy:true,recoveryError:""});
    try{if(row.recorded)await acknowledgeCommerceCommand(key,this.recoveryScope(),current);else await retryCommerceCommand(key,this.recoveryScope(),current);
      if(current())this.setData({actionStatus:"原操作已核对，请查看对应记录；这不代表款项已到账。"});
    }catch(error){if(current())this.setData({recoveryError:(error as {title?:string})?.title||"原操作仍未核实，请稍后重查或联系客服。"});}
    finally{this.finishAction(epoch,token,true);}
  },
  retryRuntime(){if(this.data.closedRights||!this.data.visible||this.data.busy||this.confirmationPending)return;
    if(this.lastSessionToken!==historicalCommerceToken()){void this.load();return;}
    void this.loadRuntime(this.data.epoch,historicalCommerceToken());},
  async load(){
    this.syncSession();
    if(!this.data.visible||this.data.busy){this.data.refreshOnShow=true;return;}
    this.data.refreshOnShow=false;this.stopPaymentFollowup();cancelPageReads(this);cancelRuntimeRead(this);
    // A reload invalidates the previous receipt read. Its late response can no
    // longer clear loading, so release that guard together with its attempt.
    this.receiptQueryAttempt+=1;
    this.setData({receiptQueryLoading:false,receiptQueryError:''});
    const epoch=++this.data.epoch,readEpoch=++this.data.readEpoch,token=historicalCommerceToken();
    if(this.data.invalidId){this.setData({loading:false,coreReady:false,isolatedPayment:false,paymentRecovery:false,error:"请从订单列表选择一笔订单。",order:null});return;}
    this.setData({loading:!this.data.order,coreReady:false,error:"",isolatedPayment:false,paymentRecovery:false});
    if(!this.data.closedRights)void this.loadRuntime(epoch,token);
    try{
      if(this.merchantOrderNumber&&!this.data.id){
        const resolved=await pageRead<{id:string}>(this,{path:`/v1/me/orders/resolve?outTradeNo=${encodeURIComponent(this.merchantOrderNumber)}`});
        if(!this.readCurrent(epoch,token,readEpoch))return;
        if(!orderIdPattern.test(resolved?.id))throw new Error('Invalid order resolution');
        this.setData({id:resolved.id});
      }
      const order=await myOrder(this.data.id,this);
      if(!this.readCurrent(epoch,token,readEpoch))return;
      if(order.id!==this.data.id||!Number.isSafeInteger(order.version)||this.data.order&&order.version<this.data.order.version)throw new Error("Invalid or obsolete order projection");
      const qualificationPaid=this.data.qualificationPurchase&&order.status==='paid';
      const paymentSettled=this.paymentFollowupPending&&order.status!=='pending_payment';
      if(paymentSettled)this.paymentFollowupPending=false;
      this.setData({order:this.normalize(order),coreReady:true,loading:false,
        ...(qualificationPaid?{actionStatus:'',actionError:''}:
          paymentSettled?{actionStatus:order.status==='paid'?'付款已确认。':'',actionError:''}:{})});
      if(this.data.qualificationPurchase)void this.confirmSharingQualification(order);
      this.waitForPaymentConfirmation();
      if(!this.data.closedRights){this.applyRuntime();void this.loadRecovery();this.refreshRecordedCommands();}
      void this.loadShipment();void this.loadRefunds(epoch,token);
      if(this.wechatReturn){const returned=this.wechatReturn;this.wechatReturn=null;void this.queryWechatReceipt(false,returned);}
      if(this.launchAftersale){this.launchAftersale=false;this.openAftersale();}
      else if(this.data.supportSheetOpen)void this.loadSupportSheet();
    }catch(error){if(this.readCurrent(epoch,token,readEpoch))this.setData({order:[401,403,404].includes((error as {status?:number})?.status??0)?null:this.data.order,coreReady:false,loading:false,error:errorTitle(error,"订单详情暂时无法同步。")});}
  },
  stopQualificationMoment(){
    this.qualificationAttempt++;
    this.checkingQualification=false;
    if(this.qualificationTimer!==null)clearTimeout(this.qualificationTimer);
    this.qualificationTimer=null;
    if(this.data.qualificationMoment)this.setData({qualificationMoment:false});
  },
  async confirmSharingQualification(order:CommerceOrder<MemberOrderAddress>){
    const key=this.qualificationKey,owner=qualificationOrderOwner(key,order.id);
    if(!owner||this.checkingQualification||this.data.qualificationMoment||this.data.closedRights||
       order.status!=='paid'||order.transactionSourceKind!=='verified_commerce'||order.cashPayableCents<=0||
       (order.refundedCents??0)>=order.totalCents||
       !order.lines.some(line=>line.productCode===campaignEssenceCode&&line.quantity>0)||
       !qualificationReturnDistance(key,order.id,this))return;
    const attempt=++this.qualificationAttempt,revision=commerceContextRevision(),token=historicalCommerceToken();
    const current=()=>this.data.visible&&this.data.pageAlive&&this.qualificationAttempt===attempt&&
      token===historicalCommerceToken()&&revision===commerceContextRevision()&&this.data.id===order.id&&
      this.data.order?.status==='paid'&&(this.data.order.refundedCents??0)<this.data.order.totalCents&&
      qualificationOrderOwner(key,order.id)===owner;
    this.checkingQualification=true;
    try{
      const wallet=await pageRead<{memberId:string;qualification:{met:boolean}}>(this,{path:'/v1/me/sharing-officer'});
      if(!current()||wallet.memberId!==owner||wallet.qualification?.met!==true)return;
      const reduced=shouldReduceMotion();
      this.setData({qualificationMoment:true,qualificationReduced:reduced});
      this.qualificationTimer=setTimeout(()=>{
        this.qualificationTimer=null;
        if(!current()){
          if(this.qualificationAttempt===attempt)this.setData({qualificationMoment:false});
          return;
        }
        const delta=qualificationReturnDistance(key,order.id,this);
        this.setData({qualificationMoment:false});
        if(!delta)return;
        markQualificationCompleted(key,order.id);
        wx.navigateBack({delta,fail:()=>wx.showToast({title:'任务完成，请返回分享官页',icon:'none'})});
      },reduced?1500:1820);
    }catch{
      if(current())this.setData({actionError:'暂时无法确认分享官资格，请刷新订单或返回分享官页查看。'});
    }finally{
      if(this.qualificationAttempt===attempt)this.checkingQualification=false;
    }
  },
  stopPaymentFollowup(){
    if(this.paymentFollowupTimer!==null)clearTimeout(this.paymentFollowupTimer);
    this.paymentFollowupTimer=null;
  },
  waitForPaymentConfirmation(remaining=4){
    const {id,epoch}=this.data,token=historicalCommerceToken();
    const waiting=()=>this.paymentFollowupPending&&this.data.visible&&this.data.id===id&&
      this.data.order?.id===id&&this.data.order.status==='pending_payment'&&this.current(epoch,token);
    if(!remaining||this.paymentFollowupTimer!==null||!waiting())return;
    const timer=setTimeout(async()=>{
      try{
        if(this.paymentFollowupTimer!==timer||!waiting())return;
        const order=await myOrder(id,this);
        if(this.paymentFollowupTimer!==timer||!waiting())return;
        if(order.id===id&&order.status!=='pending_payment'){void this.load();return;}
      }catch{
        if(this.paymentFollowupTimer!==timer||!waiting())return;
        // The existing order controls remain available if reconciliation is slow.
      }finally{if(this.paymentFollowupTimer===timer)this.paymentFollowupTimer=null;}
      this.waitForPaymentConfirmation(remaining-1);
    },remaining===4?700:1500);
    this.paymentFollowupTimer=timer;
  },
  async loadShipment(){
    if(!this.canAct()||this.data.busy)return;
    const attempt=++this.shipmentAttempt;
    this.trackingAttempt+=1;this.setData({tracking:null,trackingLoading:false,trackingError:""});
    const epoch=this.data.epoch,readEpoch=this.data.readEpoch,token=historicalCommerceToken();
    this.setData({shipmentLoading:true,shipmentError:""});
    try{const row=await myShipment(this.data.id,this);
      if(!this.readCurrent(epoch,token,readEpoch)||attempt!==this.shipmentAttempt)return;
      const labels:Record<string,string>={not_ready:"付款后安排发货",awaiting_dispatch:"待发货",shipped:"已发货",delivered:"快递已签收",exception:"物流异常，请联系客服"};
      if(row.orderId!==this.data.id||!labels[row.logisticsState]||row.id&&(!Number.isSafeInteger(row.version)||row.version!<1))throw new Error("Invalid shipment");
      const order=this.data.order;
      const noCourier=row.deliveryMethod==='local_delivery'||row.deliveryMethod==='pickup';
      const stateLabel=noCourier&&row.receiptConfirmedAt?"已收货"
        :!row.id&&!order?.aftersale&&(order?.refundedCents??0)>0?"退款后暂停发货"
        :row.holdReason==='aftersale'?"售后处理中，暂停发货"
        :row.holdReason==='refund'?"退款处理中，暂停发货"
        :!row.id&&order?.status==='cancelled'?"订单已取消":!row.id&&order?.status==='expired'?"订单已关闭":labels[row.logisticsState]!;
      const shippedLabel=row.shippedAt&&Number.isFinite(Date.parse(row.shippedAt))
        ?new Date(row.shippedAt).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'';
      this.setData({shipment:{...row,stateLabel,shippedLabel,noCourier,wechatReceipt:row.wechatReceipt?
        {...row.wechatReceipt,displayLabel:receiptLabels[row.wechatReceipt.status]??"微信记录：需人工核对",observedLabel:row.wechatReceipt.observedAt?
          new Date(row.wechatReceipt.observedAt).toLocaleString('zh-CN',{hour12:false}):''}:null},shipmentLoading:false,
        ...(row.receiptConfirmedAt?{receiptKey:"",receiptVersion:0}:{})});
    }catch(error){if(this.readCurrent(epoch,token,readEpoch)&&attempt===this.shipmentAttempt)this.setData({shipment:null,shipmentLoading:false,shipmentError:errorTitle(error,"物流记录暂时无法读取，请重试或联系客服。")});}
  },
  async copyWaybill(){
    if(!this.canAct()||this.data.shipmentLoading||!this.data.shipment?.id||!this.data.shipment.trackingNumber)return;
    const epoch=this.data.epoch,readEpoch=this.data.readEpoch,token=historicalCommerceToken();
    try{await wx.setClipboardData({data:this.data.shipment.trackingNumber});}
    catch{if(this.readCurrent(epoch,token,readEpoch))wx.showToast({title:'复制未完成，请长按运单号',icon:'none'});}
  },
  async openLogistics(){
    if(this.data.closedRights||!this.canAct()||this.data.busy||this.data.shipmentLoading||this.data.trackingLoading||!this.data.shipment?.id||this.data.shipment.noCourier
      ||this.data.order?.transactionSourceKind!=='verified_commerce')return;
    const epoch=this.data.epoch,readEpoch=this.data.readEpoch,token=historicalCommerceToken(),shipmentId=this.data.shipment.id,attempt=++this.trackingAttempt;
    const current=()=>this.readCurrent(epoch,token,readEpoch)&&attempt===this.trackingAttempt&&this.data.shipment?.id===shipmentId;
    this.setData({trackingLoading:true,trackingError:''});
    try{
      const result=await myLogisticsView(this.data.id);if(!current())return;
      if(result.orderId!==this.data.id||result.shipmentId!==shipmentId||result.source!=='wechat_logistics_plugin'
        ||typeof result.waybillToken!=='string'||result.waybillToken.length<20||result.waybillToken.length>4096||/[\s\u0000-\u001f\u007f]/.test(result.waybillToken))throw Error('Invalid logistics view');
      // A buyer-only capability stays in this call, never page data or storage.
      const plugin=await requirePlugin.async('logisticsPlugin') as {openWaybillTracking:(options:{waybillToken:string})=>void|Promise<unknown>};
      if(!current())return;
      if(typeof plugin?.openWaybillTracking!=='function')throw Error('Logistics plugin unavailable');
      await plugin.openWaybillTracking({waybillToken:result.waybillToken});
    }catch{if(current())this.setData({trackingError:'暂时无法打开微信物流，可查看轨迹或复制运单号。'});}
    finally{if(current())this.setData({trackingLoading:false});}
  },
  async loadTracking(){
    if(this.data.closedRights||!this.canAct()||this.data.busy||this.data.shipmentLoading||this.data.trackingLoading||!this.data.shipment?.id||this.data.shipment.noCourier)return;
    const epoch=this.data.epoch,readEpoch=this.data.readEpoch,token=historicalCommerceToken(),
      shipmentId=this.data.shipment.id,attempt=++this.trackingAttempt;
    const current=()=>this.readCurrent(epoch,token,readEpoch)&&attempt===this.trackingAttempt&&this.data.shipment?.id===shipmentId;
    this.setData({tracking:null,trackingLoading:true,trackingError:""});
    try{const row=await myTracking(this.data.id,this);
      if(!current())return;
      if(row.orderId!==this.data.id||row.shipmentId!==shipmentId||row.source!=="wechat_logistics"||!Number.isFinite(Date.parse(row.observedAt))
        ||!Array.isArray(row.events)||row.events.length>100||row.events.some(e=>!Number.isFinite(Date.parse(e.time))||typeof e.message!=="string"||e.message.length>2000))throw Error("Invalid tracking");
      this.setData({tracking:{...row,observedLabel:new Date(row.observedAt).toLocaleString("zh-CN",{hour12:false}),
        events:row.events.map((event,index)=>({...event,key:`${event.time}:${index}`,timeLabel:new Date(event.time).toLocaleString("zh-CN",{hour12:false})}))},trackingLoading:false});
    }catch{if(current())this.setData({tracking:null,trackingLoading:false,trackingError:"暂时无法提供物流轨迹。已记录的运单仍可查看，请稍后重试或联系客服。"});}
  },
  async confirmReceipt(){
    if(this.data.closedRights||!this.canAct()||this.data.busy||this.data.shipmentLoading||!this.data.shipment?.id||!this.data.shipment.version||this.data.shipment.receiptConfirmedAt)return;
    const epoch=this.data.epoch,token=historicalCommerceToken();
    const answer=await this.confirmOperation({title:"确认已收到商品？",content:"请确认本单全部商品已收到。此操作记录你的收货确认，不影响依法申请售后。",confirmText:"已收到",cancelText:"暂不确认"});
    if(!answer.confirm||!this.current(epoch,token)||!this.canAct()||this.data.busy)return;
    const receiptKey=this.data.receiptKey||clientOperationKey("receipt"),receiptVersion=this.data.receiptVersion||this.data.shipment.version!;
    this.setData({busy:true,receiptKey,receiptVersion,actionError:"",actionStatus:""});
    try{await confirmMyReceipt(this.data.id,receiptVersion,receiptKey);
      if(this.current(epoch,token))this.setData({receiptKey:"",receiptVersion:0,actionStatus:"已记录你的收货确认。"});
    }catch(error){if(this.current(epoch,token))this.setData({actionError:errorTitle(error,"收货确认结果尚未核实，请刷新物流记录后重试；将沿用原请求。")});}
    finally{this.finishAction(epoch,token,true);}
  },
  async confirmWechatReceipt(){void this.queryWechatReceipt(this.data.shipment?.wechatReceipt?.canOpenComponent===true);},
  async refreshWechatReceipt(){void this.queryWechatReceipt(false);},
  async queryWechatReceipt(open:boolean,returned?:'success'|'fail'|'cancel',retries=2){
    if(this.data.closedRights||!this.canAct()||this.data.busy||this.data.receiptQueryLoading||this.data.order?.status!=='paid'
      ||this.data.order.transactionSourceKind!=='verified_commerce')return;
    const epoch=this.data.epoch,token=historicalCommerceToken(),id=this.data.id,attempt=++this.receiptQueryAttempt;
    const current=()=>this.current(epoch,token)&&this.data.visible&&this.data.order?.id===id&&attempt===this.receiptQueryAttempt;
    this.setData({receiptQueryLoading:true,receiptQueryError:'',actionError:'',actionStatus:''});
    try{
      const result=await queryMyWechatReceipt(id);
      if(!current())return;
      if(result.orderId!==id||this.data.shipment?.id&&result.shipmentId!==this.data.shipment.id)throw Error('Invalid receipt binding');
      this.setData({receiptQueryLoading:false,actionStatus:returned==='cancel'?'已取消微信确认，原订单仍可查看。'
        :returned==='fail'?'微信确认未完成；原订单仍可查看。'
        :result.status==='confirmed'||result.status==='completed'?result.label
        :returned==='success'?'正在更新收货状态，请稍后刷新微信记录。'
        :result.canOpenComponent?'微信记录已更新，可在收到全部商品后确认收货。':result.label});
      void this.loadShipment();
      if(returned==='success'&&retries>0&&result.status!=='confirmed'&&result.status!=='completed'
        &&result.status!=='refunded'){
        const delay=retries===2?2000:5000;
        setTimeout(()=>{if(current()&&!this.data.receiptQueryLoading)void this.queryWechatReceipt(false,'success',retries-1);},delay);
      }
      if(!open)return;
      if(!result.canOpenComponent||!result.component?.transactionId){this.setData({actionError:'当前订单暂不能打开微信确认收货；可稍后刷新状态或联系客服。'});return;}
      if(this.data.runtimeMode==='test'){this.setData({actionStatus:'测试订单不会打开微信确认收货页面。'});return;}
      const api=wx as typeof wx & {openBusinessView?:(options:{businessType:'weappOrderConfirm';extraData:{transaction_id:string};
        success?:()=>void;fail?:()=>void})=>void};
      if(!wx.canIUse('openBusinessView')||typeof api.openBusinessView!=='function'){
        this.setData({actionError:'当前微信版本暂不支持确认收货，请升级微信后再试。'});return;
      }
      beginWechatReceiptReturn(id,token,result.component.transactionId);
      try{api.openBusinessView({businessType:'weappOrderConfirm',extraData:{transaction_id:result.component.transactionId},
        fail:()=>{clearWechatReceiptReturn();if(current())this.setData({actionError:'微信确认收货页面暂时无法打开，请稍后重试或联系客服。'});}});}
      catch{clearWechatReceiptReturn();if(current())this.setData({actionError:'微信确认收货页面暂时无法打开，请稍后重试或联系客服。'});}
    }catch{if(current())this.setData({receiptQueryLoading:false,actionStatus:'',receiptQueryError:'暂时无法查询微信记录。上次有效记录仍保留，请重试或联系售后服务。'});}
  },
  applyRuntime(){const ready=this.canAct()&&this.data.runtimeState==="ready"&&this.data.order?.transactionSourceKind==="verified_commerce",actions=runtimeActions(this.data.runtimeStatus);
    this.setData({isolatedPayment:ready&&actions.money,paymentRecovery:ready&&(actions.money||actions.recovery)});
  },
  async loadRuntime(epoch:number,token:string){cancelRuntimeRead(this);const attempt=++this.data.runtimeEpoch,readEpoch=this.data.readEpoch;
    this.setData({runtimeState:"loading",runtimeMode:"unknown",runtimeStatus:null,runtimeCopy:"正在连接支付服务…",isolatedPayment:false,paymentRecovery:false});
    try{const status=validateRuntime(await orderRuntimeStatus(runtimeReadOwner(this)));
      if(!this.readCurrent(epoch,token,readEpoch)||attempt!==this.data.runtimeEpoch)return;
      this.setData(runtimeView(status));this.applyRuntime();
    }catch{if(this.readCurrent(epoch,token,readEpoch)&&attempt===this.data.runtimeEpoch)this.setData({runtimeState:"error",runtimeCopy:"支付服务暂未连接，订单与售后仍可查看。",isolatedPayment:false,paymentRecovery:false});}
  },
  async loadRefunds(epoch:number,token:string,cursor?:string){
    if(!this.data.visible||!this.data.coreReady||!this.data.order)return;
    const readEpoch=this.data.readEpoch;
    if(cursor)this.setData({refundMoreLoading:true,refundError:""});
    else this.setData({refundLoading:true,refundError:"",refundCountLabel:"正在核对记录数量"});
    try{const page=await pageRead<RefundPage>(this,{path:`/v1/me/refund-requests?orderId=${this.data.id}&limit=10${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`});
      if(!this.readCurrent(epoch,token,readEpoch)||this.data.order?.id!==this.data.id||cursor&&this.data.refundCursor!==cursor)return;
      const rows=page.items.map(row=>({...row,amountLabel:centsToYuan(row.amountCents),
        cashLabel:row.cashRefundCents===null?"":centsToYuan(row.cashRefundCents),
        creditLabel:row.creditReturnCents===null?"":centsToYuan(row.creditReturnCents),
        stateLabel:row.refundState==='succeeded'&&row.cashRefundCents===0&&Number(row.creditReturnCents)>0
          ?'购物权益已退回':refundLabels[row.refundState??""]??refundLabels[row.state]??"进度暂未更新"}));
      const seen=new Set(cursor?this.data.refunds.map(row=>row.id):[]);
      this.setData({refunds:[...(cursor?this.data.refunds:[]),...rows.filter(row=>!seen.has(row.id))],
        refundTotal:page.totalCount,refundCountLabel:`本单申请 ${page.totalCount} 项`,refundCursor:page.nextCursor,refundLoading:false,refundMoreLoading:false});
    }catch(error){if(this.readCurrent(epoch,token,readEpoch))this.setData({refundLoading:false,refundMoreLoading:false,
      refundCountLabel:"记录数量暂未核实",refundError:errorTitle(error,"退款记录暂时无法同步，请重试。")});}},
  loadMoreRefunds(){const cursor=this.data.refundCursor;if(cursor&&!this.data.refundLoading&&!this.data.refundMoreLoading)
    void this.loadRefunds(this.data.epoch,historicalCommerceToken(),cursor);},
  retryRefunds(){void this.loadRefunds(this.data.epoch,historicalCommerceToken());},
  showRefundForm(){if(this.data.runtimeMode!=="formal"&&this.data.isolatedPayment&&this.data.order?.status==="paid"&&!this.data.busy)
    this.setData({refundFormVisible:true,actionError:"",actionStatus:""});},
  closeRefundForm(){if(!this.data.busy)this.setData({refundFormVisible:false,actionError:""});},
  editRefundAmount(event:WechatMiniprogram.Input){if(this.data.busy)return;this.setData({refundAmount:event.detail.value,refundKey:""});},
  editRefundReason(event:WechatMiniprogram.Input){if(this.data.busy)return;this.setData({refundReason:event.detail.value,refundKey:""});},
  async submitRefund(){const order=this.data.order;
    if(!this.canAct()||this.data.busy||!this.data.refundFormVisible||!this.data.isolatedPayment||this.data.runtimeMode==="formal"||!order||order.status!=="paid")return;
    const amountCents=refundCents(this.data.refundAmount),reason=this.data.refundReason.trim();
    if(!Number.isSafeInteger(amountCents)||amountCents<1||amountCents>order.totalCents){this.setData({actionError:`请输入不超过 ¥${order.totalYuan} 的正数金额。`});return;}
    if(Array.from(reason).length<3||Array.from(reason).length>500){this.setData({actionError:"请填写 3 至 500 字的退款原因。"});return;}
    const epoch=this.data.epoch,token=historicalCommerceToken(),id=order.id,
      key=this.data.refundKey||clientOperationKey("refund-request");
    const current=()=>this.current(epoch,token)&&this.data.order?.id===id&&this.data.order.status==="paid"&&this.data.runtimeMode!=="formal";
    const answer=await this.confirmOperation({title:"提交测试退款申请？",content:`订单 ${order.orderNumber}\n申请商品金额 ¥${centsToYuan(amountCents)}。另一名工作人员复核后，按原付款组成处理模拟支付金额与测试购物权益；确认退款成功后才会退回权益。`,confirmText:"提交申请"});
    if(!answer.confirm||!current()||!this.canAct()||this.data.busy)return;
    this.setData({busy:true,refundKey:key,actionError:"",actionStatus:""});
    try{await executeCommerceCommand({kind:"refund",objectId:id,key,payload:{amountCents,reason}},()=>current()&&this.data.visible&&this.data.isolatedPayment);
      if(current()){this.setData({busy:false,refundFormVisible:false,refundAmount:"",refundReason:"",refundKey:"",
        actionStatus:"申请已记录，请在下方查看复核和渠道结果。"});void this.loadRefunds(epoch,token);}}
    catch(error){if(current())this.setData({busy:false,actionError:errorTitle(error,"退款申请结果暂不确定；再次提交会使用同一请求编号。")});}
    finally{this.finishAction(epoch,token);}},
  async preparePayment(){const order=this.data.order;
    if(!this.canAct()||this.data.busy||!order||order.status!=="pending_payment"||!this.data.isolatedPayment)return;
    const epoch=this.data.epoch,token=historicalCommerceToken(),id=order.id;
    const current=()=>this.current(epoch,token)&&this.data.order?.id===id;
    this.setData({busy:true,actionError:"",actionStatus:""});
    try{const result=await request<{state:string;simulation:boolean;requestPayment?:WechatMiniprogram.RequestPaymentOption}>({
      path:`/v1/me/orders/${id}/payment-intent`,method:"POST",data:{}});
      if(!current())return;
      if(result.state==="verified_pending"){
        this.paymentFollowupPending=true;
        this.setData({actionStatus:"已收到支付渠道的结果，订单仍在核对中；暂未确认付款完成。"});
        this.waitForPaymentConfirmation();
      }
      else if(result.simulation)this.setData({actionStatus:"测试支付已准备好，不会发起真实微信付款或扣款。"});
      else if(result.requestPayment&&!this.data.visible){this.setData({actionStatus:"付款信息已获取，请返回订单确认后再付款。"});return;}
      else if(result.requestPayment){
        try{await wx.requestPayment(result.requestPayment);if(current())this.paymentFollowupPending=true;}
        catch{if(current())this.setData({actionError:"微信付款未确认，请按原单核对。"});}
        // The cashier can return while the page is hidden. Keep the original order
        // check in this action, independently of the visible controls.
        await this.readPaymentResult(epoch,token,id);}
    }catch(error){if(current())this.setData({actionError:errorTitle(error,"暂时无法发起付款，请核对原订单后重试。")});}
    finally{this.finishAction(epoch,token);}},
  async recheckPayment(){const order=this.data.order;
    if(!this.canAct()||this.data.busy||!order||order.status!=="pending_payment"||!this.data.paymentRecovery)return;
    const epoch=this.data.epoch,token=historicalCommerceToken(),id=order.id;
    this.setData({busy:true});
    try{await this.readPaymentResult(epoch,token,id);}
    finally{this.finishAction(epoch,token);}},
  async readPaymentResult(epoch:number,token:string,id:string){
    const current=()=>this.current(epoch,token)&&this.data.order?.id===id;
    if(!current())return;
    this.setData({actionError:""});
    try{const result=await request<{state:string}>({path:`/v1/me/orders/${id}/payment-intent`});
      if(!current())return;
      this.setData({actionStatus:result.state==="verified_pending"?"已收到支付渠道的结果，订单仍在核对中；暂未确认付款完成。":
        result.state==="paid"?"付款已确认。":result.state==="notpay"?"渠道仍未确认付款。":"原单状态待确认，请稍后重查。"});
      if(result.state==="paid"){this.paymentFollowupPending=false;this.data.refreshOnShow=true;}
      if(result.state==="verified_pending")this.paymentFollowupPending=true;
    }catch(error){if(current())this.setData({actionError:errorTitle(error,"原单暂时无法核对，请稍后重试。")});}
    finally{if(current())this.waitForPaymentConfirmation();}},
  async cancel(){const order=this.data.order;if(this.data.closedRights||!this.canAct()||this.data.busy||order?.status!=="pending_payment"||
      order.transactionSourceKind==="verified_commerce"&&!this.data.isolatedPayment)return;
    const epoch=this.data.epoch,token=historicalCommerceToken(),id=order.id,version=order.version;
    const current=()=>this.current(epoch,token)&&this.data.order?.id===id&&this.data.order.version===version;
    const answer=await this.confirmOperation({title:"取消待支付订单？",
      content:this.data.isolatedPayment?"将先核对付款结果，再取消订单。付款状态未确认前，不会释放预留库存。":"取消后将释放本单预留库存，订单记录仍保留。",
      confirmText:"确认取消",confirmColor:"#8d3150"}).catch(()=>({confirm:false}));if(!answer.confirm||!current()||!this.canAct()||this.data.busy)return;
    const cancelKey=this.data.cancelKey||clientOperationKey("order-cancel");this.setData({busy:true,error:"",actionError:"",cancelKey});
    try{const result=await executeCommerceCommand<CommerceOrder<MemberOrderAddress>>({kind:this.data.isolatedPayment?"cancel-verified":"cancel",objectId:id,key:cancelKey,
      payload:{expectedVersion:version,reason:"用户确认取消待支付订单"}},()=>current()&&this.data.visible&&(order.transactionSourceKind!=="verified_commerce"||this.data.isolatedPayment));
      const updated=result.result??await myOrder(id,this);
      if(current())this.setData({order:this.normalize(updated),busy:false,cancelKey:"",actionStatus:"订单已取消。"});}
    catch(error){if(current())this.setData({busy:false,actionError:errorTitle(error,"取消结果暂未核实，请核对原单后重试原操作。")});}
    finally{this.finishAction(epoch,token);}},
  sheetCurrent(epoch:number,token:string){return this.canAct()&&this.data.supportSheetOpen&&this.current(epoch,token);},
  stopSheetPoll(){if(this.sheetTimer)clearTimeout(this.sheetTimer);this.sheetTimer=null;},
  scheduleSheetPoll(){this.stopSheetPoll();if(!this.data.supportSheetOpen||!this.data.visible)return;
    this.sheetTimer=setTimeout(()=>void this.loadSupportSheet('poll'),supportPollDelay(this.sheetFailures,false));},
  sheetReadCurrent(epoch:number,token:string,generation:number){return this.sheetCurrent(epoch,token)&&generation===this.sheetReadEpoch;},
  applySheetCases(items:SheetCase[]){
    const owned=items.filter(item=>item.orderId===this.data.id);
    const selected=owned.find(item=>!['cancelled','rejected'].includes(item.state)&&!item.resolved)??null;
    const previous=selected?null:owned[0]??null;
    const current=selected??previous;
    const stateLabels:Record<string,string>={requested:'申请已提交',need_info:'请补充信息',awaiting_instruction:'客服正在准备退货信息',
      awaiting_return:'请按指引寄回',return_in_transit:'退货运输中',return_received:'退货已收到',quality_checked:'质检已完成',
      refund_exception_approved:'无需寄回，待处理退款',refund_pending:'退款处理中',rejected:'申请未通过',cancelled:'申请已撤回'};
    const label=!current?'':current.resolved?(current.refund?.executionKind==='local_credit'?'购物权益已退回':'已退款'):
      current.refund?.reviewState==='rejected'?'退款复核未通过':current.refund?.reviewState==='requested'?'待退款审核':
      ['closed','abnormal'].includes(current.refund?.channelState)?'退款需客服协助':stateLabels[current.state]??'进度暂未更新';
    const amount=current?.amountCents;
    const progressHeight=current?.state==='awaiting_return'&&current.returnDestination?'56vh':
      previous||(current?.lines?.length??0)>1||current?.state==='awaiting_instruction'?'46vh':'300px';
    this.setData({sheetCase:selected,sheetPreviousCase:previous,sheetCasesReady:true,sheetCaseLabel:label,
      sheetCaseAmount:amount!==undefined&&Number.isSafeInteger(amount)?centsToYuan(amount):'',
      sheetProgressHeight:progressHeight,
      ...(selected?{sheetReapplying:false,sheetAttempt:null,sheetKeyboardHeight:0}:{})});
  },
  applySheetAvailability(availability:SheetAvailability){
    const {lines:rows,requiresWholeOrder=false,fulfillmentState}=availability;
    const order=this.data.order,prior=new Map(this.data.sheetAvailable.map(line=>[line.lineId,line.selectedQuantity]));
    if(!order||availability.orderId&&availability.orderId!==this.data.id||!Array.isArray(rows)||rows.length!==order.lines.length||new Set(rows.map(row=>row.lineId)).size!==rows.length||
      rows.some(row=>!order.lines.some(line=>line.id===row.lineId)||!Number.isSafeInteger(row.remainingQuantity)||row.remainingQuantity<0)){
      this.setData({sheetLinesReady:false,sheetError:'商品可申请数量暂未核实，请重试。'});return;}
    this.setData({sheetAvailable:rows.map(row=>{const source=order.lines.find(line=>line.id===row.lineId)!;
      return {...row,productName:source.productName,skuLabel:source.skuLabel,
        ...(source.image?{image:source.image}:{}),
        selectedQuantity:requiresWholeOrder?row.remainingQuantity:Math.min(row.remainingQuantity,prior.get(row.lineId)??row.remainingQuantity)};}),
      sheetHasRemaining:rows.some(row=>row.remainingQuantity>0),sheetWholeOrder:requiresWholeOrder,sheetLinesReady:true,
      sheetFulfillment:fulfillmentState??'',
      sheetApplicationLabel:fulfillmentState==='unshipped'?'未发货 · 无需寄回':fulfillmentState?
        (sheetApplicationKind(fulfillmentState,sheetReasons[this.data.sheetBasisIndex]??'',this.data.sheetKindIndex)==='refund_only'?'仅退款':'退货退款'):''});
  },
  async loadSupportSheet(mode?:unknown){
    if(!this.data.supportSheetOpen||!this.canAct())return;
    const polling=mode==='poll';
    if(polling&&(this.data.sheetLoading||this.data.sheetSubmitting||this.sheetPollInFlight)){
      this.scheduleSheetPoll();return;
    }
    const epoch=this.data.epoch,token=historicalCommerceToken(),generation=polling?this.sheetReadEpoch:++this.sheetReadEpoch;
    if(polling)this.sheetPollInFlight=true;
    else{
      this.stopSheetPoll();this.sheetValidationError=false;
      this.setData({sheetLoading:true,sheetCasesReady:false,sheetLinesReady:false,sheetError:''});
    }
    try{
      const [cases,availability]=await Promise.allSettled([
        pageRead<{items:SheetCase[]}>(this,{path:`/v1/me/aftersales?orderId=${this.data.id}&limit=20`}),
        pageRead<SheetAvailability>(this,{path:`/v1/me/orders/${this.data.id}/aftersales/availability`})]);
      if(!this.sheetReadCurrent(epoch,token,generation))return;
      if(cases.status==='fulfilled'){
        this.applySheetCases(cases.value.items??[]);
        const previous=this.data.sheetPreviousCase;
        if(previous&&previous.id===this.data.order?.aftersale?.caseId&&['rejected','cancelled'].includes(previous.state)){
          const order=await myOrder(this.data.id,this).catch(()=>null);
          if(!this.sheetReadCurrent(epoch,token,generation))return;
          if(order?.id===this.data.id)this.setData({order:this.normalize(order)});
        }
      }
      if(availability.status==='fulfilled')this.applySheetAvailability(availability.value);
      const error=cases.status==='rejected'?'售后进度暂未更新，请重试。':
        availability.status==='rejected'||!this.data.sheetLinesReady?'商品可申请数量暂未更新，请重试。':'';
      this.sheetFailures=error?Math.min(this.sheetFailures+1,5):0;
      if(error)this.sheetValidationError=false;
      if(!polling)this.setData({sheetLoading:false,sheetError:error});
      else if(!this.sheetValidationError)this.setData({sheetError:error});
    }finally{
      if(polling)this.sheetPollInFlight=false;
      if(this.sheetReadCurrent(epoch,token,generation))this.scheduleSheetPoll();
    }
  },
  openAftersale(){if(!this.canAct()||this.data.busy||!this.data.order||this.data.navigating)return;
    this.sheetValidationError=false;this.setData({supportSheetOpen:true,sheetError:''});void this.loadSupportSheet();},
  closeSupportSheet(){this.stopSheetPoll();this.sheetReadEpoch+=1;this.sheetValidationError=false;this.setData({supportSheetOpen:false,sheetCasesReady:false,sheetLinesReady:false,sheetHasRemaining:false,sheetAvailable:[],sheetKeyboardHeight:0});},
  onSupportSheetLeave(){if(this.data.supportSheetOpen)this.closeSupportSheet();},
  copySheetReturnInstruction(){
    if(!this.sheetCurrent(this.data.epoch,historicalCommerceToken())||!this.data.sheetCasesReady)return;
    const row=this.data.sheetCase,d=row?.returnDestination;
    if(!row||row.state!=='awaiting_return'||!d)return;
    wx.setClipboardData({data:`${d.recipientName} ${d.phone}\n${d.region??''} ${d.address}\n退货指引第 ${d.version} 版`});
  },
  startSheetReapply(){
    if(!this.sheetCurrent(this.data.epoch,historicalCommerceToken())||!this.data.sheetCasesReady||!this.data.sheetLinesReady||
      !this.data.sheetPreviousCase||this.data.sheetCase||!this.data.sheetHasRemaining||this.data.sheetSubmitting||this.data.sheetAttempt)return;
    this.sheetValidationError=false;
    this.setData({sheetReapplying:true,sheetBasisIndex:0,sheetReason:'',sheetError:'',
      sheetApplicationLabel:this.data.sheetFulfillment==='unshipped'?'未发货 · 无需寄回':this.data.sheetFulfillment==='shipped'?'退货退款':''});
  },
  stopPropagation(){},
  openOrderSupport(){
    if(!this.canAct()||this.data.navigating||this.data.sheetSubmitting||!orderIdPattern.test(this.data.id))return;
    const caseId=(this.data.sheetCase??this.data.sheetPreviousCase)?.id;
    const query=caseId&&orderIdPattern.test(caseId)?`&caseId=${caseId}`:'';
    this.stopSheetPoll();this.setData({navigating:true});
    wx.navigateTo({url:`/pages/support/index?orderId=${this.data.id}${query}`,fail:()=>{
      this.setData({navigating:false});this.scheduleSheetPoll();
    }});
  },
  openFullAftersale(){if(!this.canAct()||this.data.navigating)return;this.stopSheetPoll();this.setData({navigating:true});
    const row=this.data.sheetCase??this.data.sheetPreviousCase;
    const action=row?.state==='awaiting_return'&&row.returnDestination?'ship_return':row?.state==='need_info'?'provide_info':'';
    const url=row?`/pages/aftersale/index?caseId=${row.id}${action?'&action='+action:''}`:`/pages/aftersale/index?orderId=${this.data.id}`;
    wx.navigateTo({url,fail:()=>{this.setData({navigating:false});this.scheduleSheetPoll();}});},
  chooseSheetKind(event:WechatMiniprogram.PickerChange){if(this.data.sheetSubmitting||this.data.sheetAttempt)return;
    const value=Number(event.detail.value);this.sheetValidationError=false;this.setData({sheetKindIndex:this.data.sheetBasisIndex===1?1:value,sheetError:''});},
  chooseSheetBasis(event:WechatMiniprogram.PickerChange){if(this.data.sheetSubmitting||this.data.sheetAttempt)return;
    const value=Number(event.detail.value);
    if(!Number.isInteger(value)||value<0||value>=sheetReasons.length)return;
    const fulfillment=this.data.sheetFulfillment||undefined;
    this.sheetValidationError=false;this.setData({sheetBasisIndex:value,sheetKindIndex:value===1?1:this.data.sheetKindIndex,sheetError:'',
      sheetApplicationLabel:fulfillment==='unshipped'?'未发货 · 无需寄回':fulfillment?
        (sheetApplicationKind(fulfillment,sheetReasons[value]!,this.data.sheetKindIndex)==='refund_only'?'仅退款':'退货退款'):''});},
  chooseSheetQuantity(event:WechatMiniprogram.TouchEvent){if(this.data.sheetSubmitting||this.data.sheetAttempt||this.data.sheetWholeOrder||!this.data.sheetLinesReady)return;
    const id=String(event.currentTarget.dataset.id??''),delta=Number(event.currentTarget.dataset.delta);
    if(![-1,1].includes(delta)||!this.data.sheetAvailable.some(line=>line.lineId===id))return;
    this.sheetValidationError=false;this.setData({sheetAvailable:this.data.sheetAvailable.map(line=>line.lineId===id?
      {...line,selectedQuantity:Math.max(0,Math.min(line.remainingQuantity,line.selectedQuantity+delta))}:line),sheetError:''});},
  editSheetReason(event:WechatMiniprogram.TextareaInput){if(!this.data.sheetSubmitting&&!this.data.sheetAttempt){this.sheetValidationError=false;this.setData({sheetReason:event.detail.value,sheetError:''});}},
  onSheetKeyboardHeightChange(event:WechatMiniprogram.TextareaKeyboardHeightChange){const height=Number(event.detail.height);this.setData({sheetKeyboardHeight:this.data.supportSheetOpen&&Number.isFinite(height)?Math.max(0,height):0});},
  async submitSheetAftersale(){if(!this.sheetCurrent(this.data.epoch,historicalCommerceToken())||this.data.sheetSubmitting||!this.data.sheetCasesReady||!this.data.sheetLinesReady||!this.data.sheetHasRemaining||this.data.sheetCase||
    this.data.sheetPreviousCase&&!this.data.sheetReapplying&&!this.data.sheetAttempt)return;
    if(!this.data.sheetAttempt){
      if(!this.data.sheetBasisIndex){this.sheetValidationError=true;this.setData({sheetError:'请选择售后问题类型。'});return;}
      if(this.data.sheetBasisIndex!==1&&Array.from(this.data.sheetReason.trim()).length<3){this.sheetValidationError=true;this.setData({sheetError:'请简要说明问题；无理由退货可留空。'});return;}
      const lines=this.data.sheetAvailable.filter(line=>line.selectedQuantity>0).map(line=>({lineId:line.lineId,quantity:line.selectedQuantity}));
      if(!lines.length){this.sheetValidationError=true;this.setData({sheetError:'请选择本次申请的商品数量。'});return;}
      const claimBasis=sheetReasons[this.data.sheetBasisIndex]!;
      const payload={kind:sheetApplicationKind(this.data.sheetFulfillment||undefined,claimBasis,this.data.sheetKindIndex),claimBasis,reason:this.data.sheetReason.trim(),lines};
      this.setData({sheetAttempt:{key:clientOperationKey('aftersale'),payload}});
    }
    const attempt=this.data.sheetAttempt!,epoch=this.data.epoch,token=historicalCommerceToken();
    this.sheetValidationError=false;this.setData({sheetSubmitting:true,sheetError:''});
    try{const row=await request<SheetCase>({path:`/v1/me/orders/${this.data.id}/aftersales`,method:'POST',idempotencyKey:attempt.key,data:attempt.payload,cacheTags:['support','orders']});
      if(!this.sheetCurrent(epoch,token))return;
      const aftersale={caseId:row.id,phase:row.kind==='return_refund'?'returning':'refund_review'} as const;
      if(row.orderId!==this.data.id||!orderIdPattern.test(row.id))throw Error('AFTERSALE_RECEIPT_MISMATCH');
      this.applySheetCases([row]);
      this.setData({sheetReason:'',sheetError:'',sheetAttempt:null,sheetReapplying:false,
        ...(this.data.sheetCase?{order:{...this.data.order!,aftersale,statusLabel:aftersaleLabels[aftersale.phase]}}:{})});
      await this.loadSupportSheet();
    }catch(error){if(this.sheetCurrent(epoch,token)){
      const code=(error as {code?:string})?.code;
      // Background status polling must not erase a submission result
      // before the buyer can read or correct it.
      this.sheetValidationError=true;
      // These named pre-insert business/validation rejections cannot have
      // created this request. Keep the draft but permit a corrected intent.
      if(['AFTERSALE_RETURN_REQUIRED','AFTERSALE_KIND_INVALID','AFTERSALE_CLAIM_BASIS_INVALID',
        'AFTERSALE_NOTE_INVALID','AFTERSALE_SELECTION_INVALID'].includes(code??''))
        this.setData({sheetAttempt:null,sheetError:code==='AFTERSALE_RETURN_REQUIRED'
          ?'本单已发货，请选择退货退款；未收到或漏发可选择对应问题类型。'
          :errorTitle(error,'请修改申请内容后重试。')});
      else if(code==='AFTERSALE_ACTIVE_CASE'||code==='AFTERSALE_EXISTING_REFUND')
        this.setData({sheetError:'本单已有售后或退款记录，请先刷新并核对原案件。'});
      else this.setData({sheetError:'提交结果尚未核实。请用原请求重试，或刷新本单售后记录。'});
    }}finally{if(this.current(epoch,token))this.setData({sheetSubmitting:false});}
  },
  back(){if(this.data.supportSheetOpen){this.closeSupportSheet();return;}
    if(this.data.busy||this.data.navigating)return;this.setData({navigating:true});wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/orders/index"})});}
});
