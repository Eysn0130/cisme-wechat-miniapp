import { loadRecordedCommands, type RecordedGroup } from "../../services/commerce-command-discovery";
import type { CommerceCommandKind } from "../../services/commerce-command-store";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { acknowledgeCommerceCommand, executeCommerceCommand, readCommerceRecovery, retryCommerceCommand, type RecoveryView } from "../../services/commerce-command-recovery";
import { cancelPageReads, pageRead } from "../../services/page-requests";
import { cancelRuntimeRead, initialRuntimeView, runtimeActions, runtimeReadOwner, runtimeView, validateRuntime } from "../../services/commerce-runtime";
import { request, requireMemberAccess } from "../../services/api";
import { centsToYuan } from "../../services/commerce";
import { clientOperationKey, myOrder, myShipment, myTracking, confirmMyReceipt, type OrderShipment, type OrderTracking, orderRuntimeStatus, type CommerceOrder, type MemberOrderAddress } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";
import { createSupportThreadState,mergeAcknowledgement,mergeSyncPage,presentSupportMessages,supportPollDelay,type SupportThreadState } from "../../services/support-thread-state";
import { stageSupportDraft, takeSupportDraft, stageSupportSendAttempt, takeSupportSendAttempt } from "../../services/support-draft-handoff";
const labels:Record<string,string>={pending_payment:"待支付",cancelled:"已取消",expired:"已超时",paid:"已支付"};
type RefundRow={id:string;orderId:string;amountCents:number;state:string;refundState:string|null;reason:string;createdAt:string;
  cashRefundCents:number|null;creditReturnCents:number|null;amountLabel?:string;stateLabel?:string;
  cashLabel?:string;creditLabel?:string};
type RefundPage={items:RefundRow[];totalCount:number;nextCursor:string|null};
const refundLabels:Record<string,string>={requested:"申请已收到",rejected:"申请未通过",approved:"退款处理中",prepared:"退款处理中",succeeded:"已退款",closed:"退款已关闭",abnormal:"退款需客服协助"};
const orderIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type SheetCase={id:string;orderId:string;state:string;kind:string;reason:string;claimBasis:string;requestedAt:string;supportConversationId:string|null;returnDestination:any;refund:any;resolved:boolean};
type SheetAvailable={lineId:string;remainingQuantity:number;selectedQuantity:number;productName:string;skuLabel:string};
type SheetMessage={id:string;sequence:number;senderType:string;body:string;createdAt:string;deliveryState:string;orderCard:any;returnInstruction:any};
type SheetShown=ReturnType<typeof presentSupportMessages<SheetMessage>>[number];
const errorTitle=(error:unknown,fallback:string)=>(error as {title?:string})?.title||fallback;
function refundCents(value:string){const match=/^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(value.trim());
  return match?Number(match[1])*100+Number((match[2]??"").padEnd(2,"0")):NaN;}
Page({
  lastSessionToken:"",lastSessionRevision:-1,
  launchAftersale:false,
  sheetTimer:null as ReturnType<typeof setTimeout>|null,sheetFailures:0,sheetCursor:0,sheetReadEpoch:0,sheetPollInFlight:false,
  data:{recordedGroups:[] as RecordedGroup[],...initialRuntimeView(),recoveryRows:[] as RecoveryView[],recoveryLoading:false,recoveryError:"",coreReady:false,visible:true,readEpoch:0,runtimeEpoch:0,refreshOnShow:false,chromeStyle:currentChromeStyle(),id:"",order:null as (CommerceOrder<MemberOrderAddress>&Record<string,unknown>)|null,
    tracking:null as (Omit<OrderTracking,"events">&{observedLabel:string;events:Array<OrderTracking["events"][number]&{timeLabel:string}>})|null,trackingLoading:false,trackingError:"",shipment:null as (OrderShipment&{stateLabel:string})|null,shipmentLoading:false,shipmentError:"",receiptKey:"",receiptVersion:0,isolatedPayment:false,paymentRecovery:false,refunds:[] as RefundRow[],refundTotal:0,refundCountLabel:"尚未读取退款记录",refundCursor:null as string|null,refundLoading:false,refundMoreLoading:false,refundError:"",
    refundFormVisible:false,refundAmount:"",refundReason:"",refundKey:"",actionStatus:"",actionError:"",
    loading:true,busy:false,navigating:false,error:"",invalidId:false,cancelKey:"",pageAlive:true,epoch:0,
    supportSheetOpen:false,sheetLoading:false,sheetCasesReady:false,sheetLinesReady:false,sheetHasRemaining:false,sheetAvailable:[] as SheetAvailable[],sheetConsulting:false,sheetPreviousCase:null as SheetCase|null,sheetCaseLabel:"",sheetCaseShortId:"",sheetRequestedLabel:"",sheetError:"",sheetCase:null as SheetCase|null,sheetMessages:[] as SheetShown[],
    sheetConversation:null as {id:string;teamReadSequence?:number}|null,sheetKindIndex:1,sheetKindOptions:['仅退款','退货退款'],
    sheetBasisIndex:0,sheetBasisOptions:['请选择问题类型','七日无理由','商品问题','错发','漏发','物流问题','其他'],
    sheetReason:"",sheetSubmitting:false,sheetAttempt:null as {key:string;payload:Record<string,unknown>}|null,
    sheetInput:"",sheetSending:false,sheetSendAttempt:null as {key:string;body:string}|null,sheetKeyboardHeight:0},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},onLoad(query:Record<string,string|undefined>){const id=query.id??"";
    this.launchAftersale=query.aftersale==='1';
    this.setData({id,invalidId:!orderIdPattern.test(id)});},
  onShow(){this.data.pageAlive=true;this.data.visible=true;this.setData({navigating:false});this.syncSession();
    if(!requireMemberAccess())return;
    if(this.data.supportSheetOpen&&!this.data.sheetSendAttempt){
      const attempt=takeSupportSendAttempt(getApp<IAppOption>().globalData.sessionToken,this.data.id);
      if(attempt)this.setData({sheetInput:attempt.body,sheetSendAttempt:{key:attempt.id,body:attempt.body},sheetError:'原消息结果尚未核实；重试将使用同一消息编号。'});
    }
    if(this.data.supportSheetOpen&&!this.data.sheetInput&&!this.data.sheetSendAttempt){
      const draft=takeSupportDraft(getApp<IAppOption>().globalData.sessionToken,this.data.id);
      if(draft)this.setData({sheetInput:draft});
    }
    void this.load();},
  syncSession(){const token=getApp<IAppOption>().globalData.sessionToken,changed=token!==this.lastSessionToken||this.lastSessionRevision!==commerceContextRevision();
    if(changed){this.lastSessionToken=token;this.lastSessionRevision=commerceContextRevision();this.data.epoch+=1;this.setData({recordedGroups:[],...initialRuntimeView(),recoveryRows:[],recoveryLoading:false,recoveryError:"",busy:false,coreReady:false,isolatedPayment:false,paymentRecovery:false,order:null,tracking:null,trackingLoading:false,trackingError:"",shipment:null,shipmentLoading:false,shipmentError:"",receiptKey:"",receiptVersion:0,refunds:[],refundTotal:0,refundCountLabel:"尚未读取退款记录",refundCursor:null,
      refundFormVisible:false,refundAmount:"",refundReason:"",refundKey:"",cancelKey:"",actionError:"",actionStatus:""});}
    if(changed){this.stopSheetPoll();this.sheetReadEpoch+=1;this.setData({supportSheetOpen:false,sheetCasesReady:false,sheetLinesReady:false,sheetHasRemaining:false,sheetAvailable:[],sheetConsulting:false,sheetPreviousCase:null,sheetCaseLabel:"",sheetCaseShortId:"",sheetRequestedLabel:"",sheetLoading:false,sheetSubmitting:false,sheetSending:false,sheetCase:null,sheetMessages:[],sheetConversation:null,sheetReason:"",sheetAttempt:null,sheetInput:"",sheetSendAttempt:null,sheetError:""});}
    },
  confirmationPending:false,
  trackingAttempt:0,
  canAct(){return this.data.visible&&this.data.coreReady&&!this.confirmationPending&&this.lastSessionToken===getApp<IAppOption>().globalData.sessionToken&&this.lastSessionRevision===commerceContextRevision();},
  async confirmOperation(options:WechatMiniprogram.ShowModalOption):Promise<{confirm:boolean;cancel?:boolean}>{
    if(this.confirmationPending)return {confirm:false};this.confirmationPending=true;
    try{return await wx.showModal(options);}catch{return {confirm:false};}finally{this.confirmationPending=false;}
  },
  onUnload(){this.onHide();this.data.pageAlive=false;this.data.epoch+=1;},
  normalize(order:CommerceOrder<MemberOrderAddress>){return {...order,statusLabel:labels[order.status]??order.status,totalYuan:centsToYuan(order.totalCents),subtotalYuan:centsToYuan(order.subtotalCents),discountYuan:centsToYuan(order.memberDiscountCents),shippingYuan:centsToYuan(order.shippingCents),creditYuan:centsToYuan(order.creditTenderCents),cashYuan:centsToYuan(order.cashPayableCents),createdLabel:new Date(order.createdAt).toLocaleString("zh-CN",{hour12:false}),expiresLabel:new Date(order.expiresAt).toLocaleString("zh-CN",{hour12:false}),lines:order.lines.map(line=>({...line,unitPriceYuan:centsToYuan(line.unitPriceCents),totalYuan:centsToYuan(line.totalCents)})),addressSummary:order.address?`${order.address.province}${order.address.city}${order.address.district} ${order.address.detail}`:""};},
  current(epoch:number,token:string){return this.data.pageAlive&&this.data.epoch===epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.lastSessionRevision===commerceContextRevision();},
  readCurrent(epoch:number,token:string,readEpoch:number){return this.data.visible&&this.data.readEpoch===readEpoch&&this.current(epoch,token);},
  onHide(){this.data.visible=false;this.data.readEpoch+=1;this.data.runtimeEpoch+=1;
    this.stopSheetPoll();this.sheetReadEpoch+=1;this.data.refreshOnShow=true;this.setData({isolatedPayment:false,paymentRecovery:false,sheetKeyboardHeight:0});cancelPageReads(this);cancelRuntimeRead(this);},
  finishAction(epoch:number,token:string,refreshCore=false){if(!this.current(epoch,token))return;
    this.setData({busy:false});if(this.data.visible&&(refreshCore||this.data.refreshOnShow)){this.data.refreshOnShow=false;void this.load();}else if(this.data.visible)void this.loadRecovery();},

  refreshRecordedCommands(){
    if(!this.data.visible||!this.data.coreReady)return;
    const epoch=this.data.epoch,readEpoch=this.data.readEpoch,token=getApp<IAppOption>().globalData.sessionToken;
    void loadRecordedCommands(this,this.recoveryScope(),()=>this.readCurrent(epoch,token,readEpoch));
  },
  moreRecordedCommands(event:WechatMiniprogram.BaseEvent){
    if(!this.data.visible||!this.data.coreReady)return;
    const epoch=this.data.epoch,readEpoch=this.data.readEpoch,token=getApp<IAppOption>().globalData.sessionToken;
    void loadRecordedCommands(this,this.recoveryScope(),()=>this.readCurrent(epoch,token,readEpoch),String(event.currentTarget.dataset.kind) as CommerceCommandKind);
  },
  recoveryScope(){return {group:"order" as const,objectId:this.data.id};},
  async loadRecovery(){if(!this.data.visible||!this.data.coreReady||this.data.busy)return;
    const epoch=this.data.epoch,readEpoch=this.data.readEpoch,token=getApp<IAppOption>().globalData.sessionToken;
    const current=()=>this.readCurrent(epoch,token,readEpoch);
    this.setData({recoveryLoading:true,recoveryError:""});
    try{const recoveryRows=await readCommerceRecovery(this,this.recoveryScope(),current);if(current())this.setData({recoveryRows,recoveryLoading:false});}
    catch{if(current())this.setData({recoveryLoading:false,recoveryError:"原操作暂时无法核对；请重试核对，不要重新创建重复申请。"});}
  },
  async resolveRecovery(event:WechatMiniprogram.BaseEvent){
    const key=String(event.currentTarget.dataset.key??""),row=this.data.recoveryRows.find(item=>item.key===key);
    if(!row||!this.canAct()||this.data.busy||!row.recorded&&!(row.kind==="cancel"||this.data.isolatedPayment))return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    const current=()=>this.current(epoch,token)&&this.data.visible&&this.data.coreReady&&(row.recorded||(row.kind==="cancel"||this.data.isolatedPayment));
    const answer=await this.confirmOperation({title:row.recorded?"确认已核对原操作？":"重试原操作？",content:row.recorded?"原申请已由服务端记录。确认后才可开始新的申请；付款、退款和到账仍分别按权威状态展示。":"只使用最初确认的金额、原因、版本和请求编号，先查询原结果；不会使用后来修改的内容，资金操作仍须服务端当前授权，重试可能继续原付款、退款或关单操作。",confirmText:row.recorded?"已核对":"重试原操作"});
    if(!answer.confirm||!current()||this.data.busy)return;
    this.setData({busy:true,recoveryError:""});
    try{if(row.recorded)await acknowledgeCommerceCommand(key,this.recoveryScope(),current);else await retryCommerceCommand(key,this.recoveryScope(),current);
      if(current())this.setData({actionStatus:"原操作已核对，请查看对应记录；这不代表款项已到账。"});
    }catch(error){if(current())this.setData({recoveryError:(error as {title?:string})?.title||"原操作仍未核实，请稍后重查或联系客服。"});}
    finally{this.finishAction(epoch,token,true);}
  },
  retryRuntime(){if(!this.data.visible||this.data.busy||this.confirmationPending)return;
    if(this.lastSessionToken!==getApp<IAppOption>().globalData.sessionToken){void this.load();return;}
    void this.loadRuntime(this.data.epoch,getApp<IAppOption>().globalData.sessionToken);},
  async load(){
    this.syncSession();
    if(!this.data.visible||this.data.busy){this.data.refreshOnShow=true;return;}
    this.data.refreshOnShow=false;cancelPageReads(this);cancelRuntimeRead(this);
    const epoch=++this.data.epoch,readEpoch=++this.data.readEpoch,token=getApp<IAppOption>().globalData.sessionToken;
    if(this.data.invalidId){this.setData({loading:false,coreReady:false,isolatedPayment:false,paymentRecovery:false,error:"请从订单列表选择一笔订单。",order:null});return;}
    this.setData({loading:!this.data.order,coreReady:false,error:"",isolatedPayment:false,paymentRecovery:false});
    void this.loadRuntime(epoch,token);
    try{const order=await myOrder(this.data.id,this);
      if(!this.readCurrent(epoch,token,readEpoch))return;
      if(order.id!==this.data.id||!Number.isSafeInteger(order.version)||this.data.order&&order.version<this.data.order.version)throw new Error("Invalid or obsolete order projection");
      this.setData({order:this.normalize(order),coreReady:true,loading:false});this.applyRuntime();void this.loadShipment();void this.loadRefunds(epoch,token);void this.loadRecovery();this.refreshRecordedCommands();
      if(this.launchAftersale){this.launchAftersale=false;this.openAftersale();}
      else if(this.data.supportSheetOpen)void this.loadSupportSheet();
    }catch(error){if(this.readCurrent(epoch,token,readEpoch))this.setData({order:[401,403,404].includes((error as {status?:number})?.status??0)?null:this.data.order,coreReady:false,loading:false,error:errorTitle(error,"订单详情暂时无法同步。")});}
  },
  async loadShipment(){
    if(!this.canAct()||this.data.busy)return;
    this.trackingAttempt+=1;this.setData({tracking:null,trackingLoading:false,trackingError:""});
    const epoch=this.data.epoch,readEpoch=this.data.readEpoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({shipmentLoading:true,shipmentError:""});
    try{const row=await myShipment(this.data.id,this);
      if(!this.readCurrent(epoch,token,readEpoch))return;
      const labels:Record<string,string>={not_ready:"待支付后安排发货",awaiting_dispatch:"待发货",shipped:"已发货",delivered:"快递已签收",exception:"物流异常，请联系客服"};
      if(row.orderId!==this.data.id||!labels[row.logisticsState]||row.id&&(!Number.isSafeInteger(row.version)||row.version!<1))throw new Error("Invalid shipment");
      this.setData({shipment:{...row,stateLabel:row.receiptConfirmedAt?"你已确认收货":labels[row.logisticsState]!},shipmentLoading:false,
        ...(row.receiptConfirmedAt?{receiptKey:"",receiptVersion:0}:{})});
    }catch(error){if(this.readCurrent(epoch,token,readEpoch))this.setData({shipment:null,shipmentLoading:false,shipmentError:errorTitle(error,"物流记录暂时无法读取，请重试或联系客服。")});}
  },
  async loadTracking(){
    if(!this.canAct()||this.data.busy||this.data.shipmentLoading||this.data.trackingLoading||!this.data.shipment?.id)return;
    const epoch=this.data.epoch,readEpoch=this.data.readEpoch,token=getApp<IAppOption>().globalData.sessionToken,
      shipmentId=this.data.shipment.id,attempt=++this.trackingAttempt;
    const current=()=>this.readCurrent(epoch,token,readEpoch)&&attempt===this.trackingAttempt&&this.data.shipment?.id===shipmentId;
    this.setData({tracking:null,trackingLoading:true,trackingError:""});
    try{const row=await myTracking(this.data.id,this);
      if(!current())return;
      if(row.orderId!==this.data.id||row.shipmentId!==shipmentId||row.source!=="wechat_logistics"||!Number.isFinite(Date.parse(row.observedAt))
        ||!Array.isArray(row.events)||row.events.length>100||row.events.some(e=>!Number.isFinite(Date.parse(e.time))||typeof e.message!=="string"||e.message.length>2000))throw Error("Invalid tracking");
      this.setData({tracking:{...row,observedLabel:new Date(row.observedAt).toLocaleString("zh-CN",{hour12:false}),
        events:row.events.map(e=>({...e,timeLabel:new Date(e.time).toLocaleString("zh-CN",{hour12:false})}))},trackingLoading:false});
    }catch{if(current())this.setData({tracking:null,trackingLoading:false,trackingError:"暂时无法提供物流轨迹。已记录的运单仍可查看，请稍后重试或联系客服。"});}
  },
  async confirmReceipt(){
    if(!this.canAct()||this.data.busy||this.data.shipmentLoading||!this.data.shipment?.id||!this.data.shipment.version||this.data.shipment.receiptConfirmedAt)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    const answer=await this.confirmOperation({title:"确认已收到商品？",content:"请确认本单全部商品已收到。此操作记录你的收货确认，不影响依法申请售后。",confirmText:"已收到",cancelText:"暂不确认"});
    if(!answer.confirm||!this.current(epoch,token)||!this.canAct()||this.data.busy)return;
    const receiptKey=this.data.receiptKey||clientOperationKey("receipt"),receiptVersion=this.data.receiptVersion||this.data.shipment.version!;
    this.setData({busy:true,receiptKey,receiptVersion,actionError:"",actionStatus:""});
    try{await confirmMyReceipt(this.data.id,receiptVersion,receiptKey);
      if(this.current(epoch,token))this.setData({receiptKey:"",receiptVersion:0,actionStatus:"已记录你的收货确认。"});
    }catch(error){if(this.current(epoch,token))this.setData({actionError:errorTitle(error,"收货确认结果尚未核实，请刷新物流记录后重试；将沿用原请求。")});}
    finally{this.finishAction(epoch,token,true);}
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
    void this.loadRefunds(this.data.epoch,getApp<IAppOption>().globalData.sessionToken,cursor);},
  retryRefunds(){void this.loadRefunds(this.data.epoch,getApp<IAppOption>().globalData.sessionToken);},
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
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,id=order.id,
      key=this.data.refundKey||clientOperationKey("refund-request");
    const current=()=>this.current(epoch,token)&&this.data.order?.id===id&&this.data.order.status==="paid"&&this.data.runtimeMode!=="formal";
    const answer=await this.confirmOperation({title:"提交隔离退款申请？",content:`订单 ${order.orderNumber}\n申请商品金额 ¥${centsToYuan(amountCents)}。另一名授权人员复核后按原组成分配现金与购物权益；只有可信渠道成功才退回权益。`,confirmText:"提交申请"});
    if(!answer.confirm||!current()||!this.canAct()||this.data.busy)return;
    this.setData({busy:true,refundKey:key,actionError:"",actionStatus:""});
    try{await executeCommerceCommand({kind:"refund",objectId:id,key,payload:{amountCents,reason}},()=>current()&&this.data.visible&&this.data.isolatedPayment);
      if(current()){this.setData({busy:false,refundFormVisible:false,refundAmount:"",refundReason:"",refundKey:"",
        actionStatus:"申请已记录，请在下方查看复核和渠道结果。"});void this.loadRefunds(epoch,token);}}
    catch(error){if(current())this.setData({busy:false,actionError:errorTitle(error,"退款申请结果暂不确定；再次提交会使用同一请求编号。")});}
    finally{this.finishAction(epoch,token);}},
  async preparePayment(){const order=this.data.order;
    if(!this.canAct()||this.data.busy||!order||order.status!=="pending_payment"||!this.data.isolatedPayment)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,id=order.id;
    const current=()=>this.current(epoch,token)&&this.data.order?.id===id;
    this.setData({busy:true,actionError:"",actionStatus:""});
    try{const result=await request<{state:string;simulation:boolean;requestPayment?:WechatMiniprogram.RequestPaymentOption}>({
      path:`/v1/me/orders/${id}/payment-intent`,method:"POST",data:{}});
      if(!current())return;
      if(result.state==="verified_pending")this.setData({actionStatus:"渠道支付事实已收到，等待服务端入账。"});
      else if(result.simulation)this.setData({actionStatus:"隔离预支付意图已建立。此环境不会拉起真实微信付款或扣款。"});
      else if(result.requestPayment&&!this.data.visible){this.setData({actionStatus:"支付意图已返回，请回到订单核对原单后再主动付款。"});return;}
      else if(result.requestPayment){try{await wx.requestPayment(result.requestPayment);}
        catch{if(current())this.setData({actionError:"微信付款未确认，请按原单核对。"});}
        // The intent action must not release busy while its authoritative follow-up is pending.
        if(current()){this.setData({busy:false});await this.recheckPayment();}}
    }catch(error){if(current())this.setData({actionError:errorTitle(error,"支付意图暂未建立，请核对原单后重试。")});}
    finally{this.finishAction(epoch,token);}},
  async recheckPayment(){const order=this.data.order;
    if(!this.canAct()||this.data.busy||!order||order.status!=="pending_payment"||!this.data.paymentRecovery)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,id=order.id;
    const current=()=>this.current(epoch,token)&&this.data.order?.id===id;
    this.setData({busy:true,actionError:""});
    try{const result=await request<{state:string}>({path:`/v1/me/orders/${id}/payment-intent`});
      if(!current())return;
      this.setData({actionStatus:result.state==="verified_pending"?"渠道事实已收到，待服务端入账。":
        result.state==="paid"?"支付已由服务端核验。":result.state==="notpay"?"渠道仍未确认付款。":"原单状态待确认，请稍后重查。"});
      if(result.state==="paid"){this.setData({busy:false});void this.load();}
    }catch(error){if(current())this.setData({actionError:errorTitle(error,"原单暂时无法核对，请稍后重试。")});}
    finally{this.finishAction(epoch,token);}},
  async cancel(){const order=this.data.order;if(!this.canAct()||this.data.busy||order?.status!=="pending_payment"||
      order.transactionSourceKind==="verified_commerce"&&!this.data.isolatedPayment)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,id=order.id,version=order.version;
    const current=()=>this.current(epoch,token)&&this.data.order?.id===id&&this.data.order.version===version;
    const answer=await this.confirmOperation({title:"取消待支付订单？",
      content:this.data.isolatedPayment?"系统会先按原商户订单号核对并关闭渠道订单；未知支付状态不会释放库存。":"取消后将释放本单预留库存，订单记录仍保留。",
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
    this.sheetTimer=setTimeout(()=>void this.pollSupportSheet(),supportPollDelay(this.sheetFailures,false));},
  sheetReadCurrent(epoch:number,token:string,generation:number){return this.sheetCurrent(epoch,token)&&generation===this.sheetReadEpoch;},
  applySheetCases(items:SheetCase[]){
    const selected=items.find(item=>!['cancelled','rejected'].includes(item.state)&&!item.resolved)??null;
    const stateLabels:Record<string,string>={requested:'申请已收到',need_info:'请补充信息',awaiting_instruction:'客服正在准备退货信息',
      awaiting_return:'请按指引寄回',return_in_transit:'退货运输中',return_received:'退货已收到',quality_checked:'正在处理退款',
      refund_exception_approved:'无需寄回，正在处理退款',refund_pending:'退款处理中'};
    const label=!selected?'':selected.resolved?(selected.refund?.executionKind==='local_credit'?'购物权益已退回':'已退款'):selected.refund?.reviewState==='rejected'?'退款申请未通过':
      ['closed','abnormal'].includes(selected.refund?.channelState)?'退款需客服协助':stateLabels[selected.state]??'进度暂未更新';
    const at=selected?Date.parse(selected.requestedAt):NaN;
    this.setData({sheetCase:selected,sheetPreviousCase:selected?null:items[0]??null,sheetCasesReady:true,sheetCaseLabel:label,sheetCaseShortId:selected?.id.slice(-6)??'',
      sheetRequestedLabel:Number.isFinite(at)?new Date(at).toLocaleString('zh-CN',{hour12:false}):'',
      ...(selected&&this.data.sheetAttempt?{sheetAttempt:null}:{})});
  },
  applySheetAvailability(rows:Array<{lineId:string;remainingQuantity:number}>){
    const order=this.data.order,prior=new Map(this.data.sheetAvailable.map(line=>[line.lineId,line.selectedQuantity]));
    if(!order||rows.length!==order.lines.length||new Set(rows.map(row=>row.lineId)).size!==rows.length||
      rows.some(row=>!order.lines.some(line=>line.id===row.lineId)||!Number.isSafeInteger(row.remainingQuantity)||row.remainingQuantity<0)){
      this.setData({sheetLinesReady:false,sheetError:'商品可申请数量暂未核实，请重试。'});return;}
    this.setData({sheetAvailable:rows.map(row=>{const source=order.lines.find(line=>line.id===row.lineId)!;
      return {...row,productName:source.productName,skuLabel:source.skuLabel,
        selectedQuantity:Math.min(row.remainingQuantity,prior.get(row.lineId)??row.remainingQuantity)};}),
      sheetHasRemaining:rows.some(row=>row.remainingQuantity>0),sheetLinesReady:true});
  },
  async pollSupportSheet(){if(!this.data.supportSheetOpen||!this.canAct()||this.data.sheetLoading||this.data.sheetSending||this.sheetPollInFlight){this.scheduleSheetPoll();return;}
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,cursor=this.sheetCursor,generation=this.sheetReadEpoch;
    this.sheetPollInFlight=true;
    try{
      // Progress is a case fact, not inferred from the latest chat message.
      const [messages,cases,availability]=await Promise.allSettled([
        pageRead<{messages:SheetMessage[];latestCursor:number;conversation:{id:string;teamReadSequence?:number}|null}>(this,
          {path:`/v1/me/support/messages?after=${cursor}&limit=50`,cacheTags:['support']}),
        pageRead<{items:SheetCase[]}>(this,{path:`/v1/me/aftersales?orderId=${this.data.id}&limit=20`}),
        pageRead<{lines:Array<{lineId:string;remainingQuantity:number}>}>(this,{path:`/v1/me/orders/${this.data.id}/aftersales/availability`})]);
      if(!this.sheetReadCurrent(epoch,token,generation))return;
      if(cases.status==='fulfilled')this.applySheetCases(cases.value.items??[]);
      if(availability.status==='fulfilled')this.applySheetAvailability(availability.value.lines??[]);
      if(messages.status==='fulfilled'){
        const page=messages.value;
        const state=mergeSyncPage<SheetShown>({messages:this.data.sheetMessages,syncCursor:this.sheetCursor,maxSeenSequence:this.sheetCursor,readCursor:0},
          presentSupportMessages(page.messages??[],{ownSenderType:'user',counterpartyReadSequence:page.conversation?.teamReadSequence??0}),page.latestCursor??cursor);
        this.sheetCursor=state.syncCursor;this.setData({sheetMessages:presentSupportMessages(state.messages,{ownSenderType:'user',counterpartyReadSequence:page.conversation?.teamReadSequence??0}).slice(-30),sheetConversation:page.conversation});
      }
      this.sheetFailures=messages.status==='rejected'||cases.status==='rejected'||availability.status==='rejected'?Math.min(this.sheetFailures+1,5):0;
      this.setData({sheetError:cases.status==='rejected'?'售后进度暂未更新，请重试。':availability.status==='rejected'||!this.data.sheetLinesReady?'商品可申请数量暂未更新，请重试。':messages.status==='rejected'?'消息暂未更新，请重试。':''});
    }finally{
      this.sheetPollInFlight=false;
      if(this.sheetReadCurrent(epoch,token,generation))this.scheduleSheetPoll();
    }
  },
  async loadSupportSheet(){if(!this.data.supportSheetOpen||!this.canAct())return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,generation=++this.sheetReadEpoch;
    this.stopSheetPoll();this.setData({sheetLoading:true,sheetCasesReady:false,sheetLinesReady:false,sheetError:''});
    const [cases,messages,availability]=await Promise.allSettled([
      pageRead<{items:SheetCase[]}>(this,{path:`/v1/me/aftersales?orderId=${this.data.id}&limit=20`}),
      pageRead<{messages:SheetMessage[];latestCursor:number;conversation:{id:string;teamReadSequence?:number}|null}>(this,{path:'/v1/me/support/messages?limit=30',cacheTags:['support']}),
      pageRead<{lines:Array<{lineId:string;remainingQuantity:number}>}>(this,{path:`/v1/me/orders/${this.data.id}/aftersales/availability`})]);
    if(!this.sheetReadCurrent(epoch,token,generation))return;
    if(cases.status==='fulfilled')this.applySheetCases(cases.value.items??[]);
    if(availability.status==='fulfilled')this.applySheetAvailability(availability.value.lines??[]);
    if(messages.status==='fulfilled'){
      const page=messages.value;this.sheetCursor=page.latestCursor??0;
      this.setData({sheetConversation:page.conversation,sheetMessages:presentSupportMessages(page.messages??[],{ownSenderType:'user',counterpartyReadSequence:page.conversation?.teamReadSequence??0})});
    }
    this.setData({sheetLoading:false,sheetError:cases.status==='rejected'?'售后记录暂未加载，请重试。':availability.status==='rejected'||!this.data.sheetLinesReady?'商品可申请数量暂未加载，请重试。':messages.status==='rejected'?'消息暂未更新，仍可提交售后申请。':''});
    this.scheduleSheetPoll();
  },
  openAftersale(){if(!this.canAct()||this.data.busy||!this.data.order||this.data.navigating)return;
    this.setData({supportSheetOpen:true,sheetError:''});void this.loadSupportSheet();},
  closeSupportSheet(){this.stopSheetPoll();this.sheetReadEpoch+=1;this.setData({supportSheetOpen:false,sheetCasesReady:false,sheetLinesReady:false,sheetHasRemaining:false,sheetAvailable:[],sheetKeyboardHeight:0});},
  onSupportSheetLeave(){if(this.data.supportSheetOpen)this.closeSupportSheet();},
  copySheetReturnInstruction(){
    if(!this.sheetCurrent(this.data.epoch,getApp<IAppOption>().globalData.sessionToken)||!this.data.sheetCasesReady)return;
    const row=this.data.sheetCase,d=row?.returnDestination;
    if(!row||row.state!=='awaiting_return'||!d)return;
    wx.setClipboardData({data:`${d.recipientName} ${d.phone}\n${d.region??''} ${d.address}\n退货指引第 ${d.version} 版`});
  },
  toggleSheetConsulting(){if(this.data.sheetSubmitting||this.data.sheetSending||this.data.sheetAttempt||this.data.sheetSendAttempt)return;
    this.setData({sheetConsulting:!this.data.sheetConsulting});},
  stopPropagation(){},
  expandSupport(){if(!this.canAct()||this.data.navigating||this.data.sheetSending)return;this.stopSheetPoll();
    const handoff=this.data.sheetSendAttempt?null:this.data.sheetInput;
    if(handoff?.trim())stageSupportDraft(getApp<IAppOption>().globalData.sessionToken,this.data.id,handoff);
    const attempt=this.data.sheetSendAttempt;
    if(attempt)stageSupportSendAttempt(getApp<IAppOption>().globalData.sessionToken,this.data.id,{id:attempt.key,body:attempt.body,linkedOrderId:this.data.id});
    this.setData({navigating:true,...(handoff?.trim()?{sheetInput:''}:{})});
    wx.navigateTo({url:`/pages/support/index?orderId=${this.data.id}`,success:()=>{
      if(attempt?.key===this.data.sheetSendAttempt?.key)this.setData({sheetInput:'',sheetSendAttempt:null,sheetError:''});
    },fail:()=>{
      const draft=takeSupportDraft(getApp<IAppOption>().globalData.sessionToken,this.data.id);
      if(attempt)takeSupportSendAttempt(getApp<IAppOption>().globalData.sessionToken,this.data.id);
      this.setData({navigating:false,...(draft?{sheetInput:draft}:{})});this.scheduleSheetPoll();
    }});},
  openFullAftersale(){if(!this.canAct()||this.data.navigating)return;this.stopSheetPoll();this.setData({navigating:true});
    const caseId=this.data.sheetCase?.id;wx.navigateTo({url:caseId?`/pages/aftersale/index?caseId=${caseId}`:`/pages/aftersale/index?orderId=${this.data.id}`,fail:()=>{this.setData({navigating:false});this.scheduleSheetPoll();}});},
  chooseSheetKind(event:WechatMiniprogram.PickerChange){if(this.data.sheetSubmitting||this.data.sheetAttempt)return;
    const value=Number(event.detail.value);this.setData({sheetKindIndex:this.data.sheetBasisIndex===1?1:value});},
  chooseSheetBasis(event:WechatMiniprogram.PickerChange){if(this.data.sheetSubmitting||this.data.sheetAttempt)return;
    const value=Number(event.detail.value);this.setData({sheetBasisIndex:value,sheetKindIndex:value===1?1:this.data.sheetKindIndex});},
  chooseSheetQuantity(event:WechatMiniprogram.TouchEvent){if(this.data.sheetSubmitting||this.data.sheetAttempt||!this.data.sheetLinesReady)return;
    const id=String(event.currentTarget.dataset.id??''),delta=Number(event.currentTarget.dataset.delta);
    if(![-1,1].includes(delta)||!this.data.sheetAvailable.some(line=>line.lineId===id))return;
    this.setData({sheetAvailable:this.data.sheetAvailable.map(line=>line.lineId===id?
      {...line,selectedQuantity:Math.max(0,Math.min(line.remainingQuantity,line.selectedQuantity+delta))}:line),sheetError:''});},
  editSheetReason(event:WechatMiniprogram.TextareaInput){if(!this.data.sheetSubmitting&&!this.data.sheetAttempt)this.setData({sheetReason:event.detail.value});},
  editSheetInput(event:WechatMiniprogram.TextareaInput){if(!this.data.sheetSending&&!this.data.sheetSendAttempt)this.setData({sheetInput:event.detail.value});},
  onSheetKeyboardHeightChange(event:WechatMiniprogram.TextareaKeyboardHeightChange){const height=Number(event.detail.height);this.setData({sheetKeyboardHeight:this.data.supportSheetOpen&&Number.isFinite(height)?Math.max(0,height):0});},
  async submitSheetAftersale(){if(!this.sheetCurrent(this.data.epoch,getApp<IAppOption>().globalData.sessionToken)||this.data.sheetSubmitting||!this.data.sheetCasesReady||!this.data.sheetLinesReady||!this.data.sheetHasRemaining||this.data.sheetCase)return;
    const bases=['','no_reason','quality','wrong_item','missing_item','delivery_issue','other'];
    if(!this.data.sheetAttempt){
      if(!this.data.sheetBasisIndex){this.setData({sheetError:'请选择售后问题类型。'});return;}
      if(this.data.sheetBasisIndex!==1&&Array.from(this.data.sheetReason.trim()).length<3){this.setData({sheetError:'请简要说明问题；无理由退货可留空。'});return;}
      const lines=this.data.sheetAvailable.filter(line=>line.selectedQuantity>0).map(line=>({lineId:line.lineId,quantity:line.selectedQuantity}));
      if(!lines.length){this.setData({sheetError:'请选择本次申请的商品数量。'});return;}
      const payload={kind:this.data.sheetKindIndex===1?'return_refund':'refund_only',claimBasis:bases[this.data.sheetBasisIndex],reason:this.data.sheetReason.trim(),lines};
      this.setData({sheetAttempt:{key:clientOperationKey('aftersale'),payload}});
    }
    const attempt=this.data.sheetAttempt!,epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({sheetSubmitting:true,sheetError:''});
    try{const row=await request<SheetCase>({path:`/v1/me/orders/${this.data.id}/aftersales`,method:'POST',idempotencyKey:attempt.key,data:attempt.payload,cacheTags:['support']});
      if(!this.sheetCurrent(epoch,token))return;
      this.setData({sheetCase:row,sheetAttempt:null,sheetReason:'',sheetError:''});await this.loadSupportSheet();
    }catch(error){if(this.sheetCurrent(epoch,token)){
      this.setData({sheetError:(error as {status?:number})?.status===409?'本单可能已有申请，请先刷新核对原案件。':'提交结果尚未核实。请用原请求重试，或刷新本单售后记录。'});
    }}finally{if(this.current(epoch,token))this.setData({sheetSubmitting:false});}
  },
  async sendSheetMessage(){if(!this.sheetCurrent(this.data.epoch,getApp<IAppOption>().globalData.sessionToken)||this.data.sheetSending)return;
    const body=this.data.sheetInput.trim();if(!this.data.sheetSendAttempt&&!body)return;
    const attempt=this.data.sheetSendAttempt??{key:clientOperationKey('support-order'),body};
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;this.setData({sheetSending:true,sheetSendAttempt:attempt,sheetError:''});
    try{const result=await request<{message:SheetMessage;conversation:{id:string;teamReadSequence?:number}}>({path:'/v1/me/support/messages',method:'POST',
      data:{body:attempt.body,clientMessageId:attempt.key,linkedOrderId:this.data.id},cacheTags:['support']});
      if(!this.sheetCurrent(epoch,token))return;
      const state=mergeAcknowledgement<SheetShown>({messages:this.data.sheetMessages,syncCursor:this.sheetCursor,maxSeenSequence:this.sheetCursor,readCursor:0},
        presentSupportMessages([result.message],{ownSenderType:'user',counterpartyReadSequence:result.conversation.teamReadSequence??0})[0]!);
      this.setData({sheetMessages:presentSupportMessages(state.messages,{ownSenderType:'user',counterpartyReadSequence:result.conversation.teamReadSequence??0}).slice(-30),
        sheetConversation:result.conversation,sheetInput:'',sheetSendAttempt:null});
    }catch{if(this.sheetCurrent(epoch,token))this.setData({sheetError:'消息结果尚未核实；请用原内容重试，或展开会话查看。'});}
    finally{if(this.current(epoch,token))this.setData({sheetSending:false});}
  },
  back(){if(this.data.supportSheetOpen){this.closeSupportSheet();return;}
    if(this.data.busy||this.data.navigating)return;this.setData({navigating:true});wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/orders/index"})});}
});
