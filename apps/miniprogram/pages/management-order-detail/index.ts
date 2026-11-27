import { requireCapability } from "../../services/authority";
import { centsToYuan } from "../../services/commerce";
import { managementOrder, managementShipment, shipmentCarriers, type ShipmentCarrier, dispatchShipment, reconcileShipment, clientOperationKey, orderLineSummary, type CommerceOrder, type ManagementOrderAddress, type NoCourierDelivery, type OrderShipment, type ShipmentDispatchInput } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";
import {cancelPageReads, pageRead} from "../../services/page-requests";
import { request } from "../../services/api";
import { aftersaleContact, aftersaleLabels, managementAftersaleActions, pendingRefundDecision, refundApprovalAction, type ManagementAftersaleAction, type RefundReviewCase } from "../../services/order-aftersale";
const labels:Record<string,string>={pending_payment:"待支付",cancelled:"已取消",expired:"已超时",paid:"支付已核验"};
const syncLabels:Record<string,string>={prepared:"等待微信同步",dispatching:"正在提交微信",verifying:"微信结果核对中",synced:"微信已确认",manual_review:"微信同步待人工核对"};
const deliveryLabels:Record<string,string>={awaiting_dispatch:"待发货",not_ready:"尚不满足发货条件",shipped:"已交寄",delivered:"已签收",exception:"物流异常"};
const orderIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const inlineActions = ['request_refund','approve_pending_refund','approve_return','reject','reject_pending_refund'];
const primaryActions = ['approve_pending_refund','request_refund','approve_return','send_return_instruction','receive_return','inspect_return','reopen_refund','resolve_old_route'];
type DecisionAttempt = {key:string;caseId:string;subjectId:string;version:number;path:string;data:Record<string,unknown>;success:string;uncertain:boolean};
const emptyAftersale = {
 decision:"" as ManagementAftersaleAction|"",decisionLabel:"",decisionInline:false,
 canReject:false,rejectAction:"",rejectLabel:"",canContact:false,caseType:"",caseAmount:"",caseItems:"",caseReason:"",caseHint:"",caseError:""
};
const emptyForm=()=>({carrierCode:"",carrierName:"",trackingNumber:"",evidenceReference:""});
const noCourierOptions=[{method:"local_delivery",label:"同城配送"},{method:"pickup",label:"用户自提"}] as const;
function chooseNoCourierDelivery():Promise<NoCourierDelivery|null>{
 return new Promise((resolve,reject)=>wx.showActionSheet({itemList:noCourierOptions.map(option=>option.label),
  success:answer=>resolve(noCourierOptions[answer.tapIndex]?.method??null),
  fail:error=>{if(error.errMsg.includes("cancel"))resolve(null);else reject(error);}}));
}
Page({
 lastReadToken:"",
 capabilities:[] as string[],
 refreshTimer:null as ReturnType<typeof setInterval>|null,
 refreshInFlight:false,
 pendingDispatch:null as {key:string;input:ShipmentDispatchInput}|null,
 caseSnapshot:null as RefundReviewCase|null,
 pendingDecision:null as DecisionAttempt|null,
 data:{chromeStyle:currentChromeStyle(),id:"",order:null as any,shipment:null as OrderShipment|null,shipmentLabel:"",shippedLabel:"",syncLabel:"",messageLabel:"",canReadShipment:false,canDispatch:false,canOpenAftersale:false,...emptyAftersale,
  decisionBusy:false,decisionRetry:false,decisionFeedback:"",shipmentLoading:false,shipmentError:"",carriers:[] as ShipmentCarrier[],carrierLabels:["请选择快递公司"],carrierIndex:0,carriersLoading:false,carriersError:"",dispatchBusy:false,dispatchRecovery:false,dispatchMessage:"",form:emptyForm(),loading:true,navigating:false,error:"",invalidId:false,pageAlive:true,epoch:0},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 onLoad(query:Record<string,string|undefined>){const id=query.id??"";this.setData({id,invalidId:!orderIdPattern.test(id)});},
 async onShow(){
  this.data.pageAlive=true;this.setData({navigating:false});await this.load();
  if(this.data.pageAlive&&!this.refreshTimer)this.refreshTimer=setInterval(()=>void this.recheckOrder(),10_000);
 },
 onHide(){
  if(this.refreshTimer!==null)clearInterval(this.refreshTimer);
  this.refreshTimer=null;this.data.pageAlive=false;this.data.epoch+=1;this.pendingDispatch=null;this.capabilities=[];cancelPageReads(this);
  this.caseSnapshot=null;
  this.setData({carriers:[],carrierLabels:["请选择快递公司"],carrierIndex:0,carriersLoading:false,carriersError:"",order:null,shipment:null,
   canReadShipment:false,canDispatch:false,canOpenAftersale:false,...emptyAftersale,decisionBusy:false,decisionRetry:false,decisionFeedback:"",
   form:emptyForm(),dispatchBusy:false,dispatchRecovery:false,dispatchMessage:"",shipmentError:""});
 },
 onUnload(){this.onHide();this.pendingDecision=null;},
 current(epoch:number,token:string){return this.data.pageAlive&&this.data.epoch===epoch&&token===getApp<IAppOption>().globalData.sessionToken;},
 normalize(order:CommerceOrder<ManagementOrderAddress>){return {...order,statusLabel:order.aftersale?aftersaleLabels[order.aftersale.phase]:order.status==="paid"&&(order.refundedCents??0)>0?(order.refundedCents!>=order.totalCents?"已退款":"部分退款"):(labels[order.status]??order.status),totalYuan:centsToYuan(order.totalCents),creditYuan:centsToYuan(order.creditTenderCents),cashYuan:centsToYuan(order.cashPayableCents),createdLabel:new Date(order.createdAt).toLocaleString("zh-CN",{hour12:false,timeZone:"Asia/Shanghai"}),lines:order.lines.map(line=>({...line,totalYuan:centsToYuan(line.totalCents)})),addressSummary:order.address?`${order.address.province}${order.address.city}${order.address.district}`:""};},
 async load(){
  if(this.data.dispatchBusy||this.data.decisionBusy)return;
  const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
  if(this.lastReadToken!==token)this.pendingDecision=null;
  this.lastReadToken=token;
  this.pendingDispatch=null;this.capabilities=[];this.caseSnapshot=null;
  this.setData({order:null,shipment:null,canReadShipment:false,canDispatch:false,canOpenAftersale:false,...emptyAftersale,
   decisionRetry:false,decisionFeedback:"",form:emptyForm(),loading:true,error:"",shipmentError:"",dispatchRecovery:false,dispatchMessage:""});
  if(this.data.invalidId){if(this.current(epoch,token))this.setData({loading:false,error:"请从订单列表选择一笔订单。"});return;}
  const allowed=await requireCapability("commerce.order.read");
  if(!this.current(epoch,token))return;
  if(!allowed){this.setData({loading:false,error:"当前账号没有订单查看权限。"});return;}
  try{const order=await managementOrder(this.data.id);
   if(!this.current(epoch,token))return;
   if(order.id!==this.data.id)throw Error("Invalid order details");
   this.capabilities=allowed.capabilities;
   const canReadShipment=allowed.capabilities.includes("commerce.fulfillment.manage");
   const caseId=order.aftersale?.caseId??order.aftersaleCaseId;
   const canOpenAftersale=Boolean(caseId)&&allowed.capabilities.some(capability=>
    ['commerce.aftersale.review','commerce.return.receive','commerce.return.inspect'].includes(capability));
   this.setData({order:this.normalize(order),canReadShipment,canDispatch:false,canOpenAftersale,loading:false,
    caseHint:caseId&&!canOpenAftersale?"请由售后管理员处理此申请。":""});
   await Promise.all([
    canReadShipment?this.readShipment(epoch,token):undefined,
    canOpenAftersale&&caseId?this.readAftersale(caseId,epoch,token):undefined
   ]);
  }catch(error){if(this.current(epoch,token))this.setData({loading:false,error:(error as {title?:string}).title??"暂时无法查看订单详情，请重试或返回列表。"});}
 },
 async recheckOrder(){
  const order=this.data.order,epoch=this.data.epoch,token=this.lastReadToken;
  if(!order||this.refreshInFlight||this.data.loading||this.data.navigating||this.data.dispatchBusy||this.pendingDispatch||this.data.decisionBusy
    ||!this.current(epoch,token))return;
  this.refreshInFlight=true;
  try{
   const latest=await managementOrder(this.data.id);
   if(!this.current(epoch,token)||this.data.navigating||this.data.dispatchBusy||this.pendingDispatch||this.data.decisionBusy)return;
   if(latest.version!==order.version||latest.aftersale?.caseId!==order.aftersale?.caseId
     ||latest.aftersale?.phase!==order.aftersale?.phase||latest.aftersaleCaseId!==order.aftersaleCaseId
     ||latest.refundedCents!==order.refundedCents){await this.load();return;}
   const caseId=latest.aftersale?.caseId??latest.aftersaleCaseId;
   if(caseId&&this.data.canOpenAftersale)await this.readAftersale(caseId,epoch,token);
  }catch(error){if(this.current(epoch,token)&&[401,403].includes((error as {status?:number}).status??0))await this.load();}
  finally{this.refreshInFlight=false;}
 },
 async readAftersale(caseId:string,epoch:number,token:string){
  if(!orderIdPattern.test(caseId))return;
  try{
   const row=await pageRead<RefundReviewCase>(this,{path:`/v1/management/aftersales/${caseId}`});
   if(!this.current(epoch,token))return;
   if(row.id!==caseId||row.orderId!==this.data.id)throw Error("Invalid aftersale details");
   const active=this.data.order?.aftersale?.caseId===row.id;
   const actions=active?managementAftersaleActions(row,this.capabilities):[];
   const primary=actions.find(item=>primaryActions.includes(item.action));
   const rejection=actions.find(item=>item.action==='reject'||item.action==='reject_pending_refund');
   const canReview=row.canReview!==false&&this.capabilities.includes('commerce.aftersale.review');
   const orderLines=(this.data.order?.lines??[]) as CommerceOrder['lines'];
   const caseLines=row.lines??[];
   const wholeOrder=caseLines.length===orderLines.length&&caseLines.every(line=>
    orderLines.some(item=>item.id===line.lineId&&item.quantity===line.quantity));
   this.caseSnapshot=row;
   if(this.pendingDecision&&this.pendingDecision.caseId!==row.id)this.pendingDecision=null;
   this.setData({
    decision:primary?.action??"",decisionLabel:primary?.label??"",decisionInline:inlineActions.includes(primary?.action??""),
    canReject:Boolean(rejection),rejectAction:rejection?.action??"",rejectLabel:rejection?.label??"",
    caseType:row.kind==='return_refund'&&row.fulfillment?.state==='shipped'?'退货退款':'退款申请',
    caseAmount:centsToYuan(row.amountCents??-1),caseItems:wholeOrder?"":caseLines.map(orderLineSummary).join("、"),caseReason:row.reason??"",
    caseHint:active&&row.canReview===false?"请由另一位售后管理员处理此申请。"
      :active&&row.refund?.reviewState==='requested'&&!primary?"待具备退款权限的管理员审批。"
      :active&&row.partialBeforeDispatch?"未发货订单需整单退款，请联系买家重新提交申请。"
      :active&&row.state==='awaiting_return'&&!primary?"待买家寄回商品。"
      :active&&row.refund?.reviewState==='approved'&&this.data.order?.aftersale?.phase==='refunding'?"已同意退款，等待渠道确认。":"",
    canContact:canReview&&this.capabilities.includes('support.read')&&this.capabilities.includes('support.reply'),
    decisionRetry:Boolean(this.pendingDecision),caseError:""
   });
  }catch(error){
   if(this.current(epoch,token)){
    const denied=[401,403].includes((error as {status?:number}).status??0);
    this.caseSnapshot=null;
    this.setData({...emptyAftersale,canOpenAftersale:!denied,decisionRetry:false,
     caseError:denied?"当前账号没有售后处理权限。":"售后操作暂时无法核对，请刷新。"});
   }
  }
 },
 async decideAftersale(event:WechatMiniprogram.TouchEvent){
  const row=this.caseSnapshot,epoch=this.data.epoch,token=this.lastReadToken;
  const action=String(event.currentTarget.dataset.action??"");
  if(!row||row.orderId!==this.data.id||!this.current(epoch,token)||!this.data.canOpenAftersale
    ||this.data.navigating||this.data.dispatchBusy||this.data.decisionBusy)return;
  if(this.pendingDecision&&(action||this.pendingDecision.caseId!==row.id))return;
  const option=managementAftersaleActions(row,this.capabilities).find(item=>item.action===action);
  if(!this.pendingDecision&&(!option||!inlineActions.includes(action)||this.data.order?.aftersale?.caseId!==row.id
    ||action!==this.data.decision&&action!==this.data.rejectAction||!Number.isSafeInteger(row.version)))return;
  this.setData({decisionBusy:true,decisionFeedback:""});
  try{
   if(!this.pendingDecision&&option){
    const rejection=action==='reject'||action==='reject_pending_refund';
    const refund=action==='request_refund'||action==='approve_pending_refund';
    if(refund&&(!Number.isSafeInteger(row.amountCents)||!row.amountCents||row.amountCents<1)){
     this.setData({decisionFeedback:"暂时无法确认退款金额，请刷新订单。"});
     return;
    }
    const direct=refundApprovalAction(row,this.capabilities)===action;
    const title=option.label;
    const detail=refund?`退款金额 ¥${centsToYuan(row.amountCents??-1)}\n${direct?"退款将按原支付路径退回。":"提交后由退款审批人处理。"}`
      :"同意后可继续发送退货地址。";
    const answer=await wx.showModal(rejection?{
     title,editable:true,placeholderText:"填写拒绝原因",confirmText:"确认拒绝",confirmColor:"#9a3d55"
    }:{title,content:detail,confirmText:"确认"});
    if(!this.current(epoch,token)||this.caseSnapshot!==row||!answer.confirm)return;
    const why=rejection?(answer.content??"").trim():title;
    const size=Array.from(why).length;
    if(size<3||size>500){this.setData({decisionFeedback:"请填写 3 至 500 字的拒绝原因。"});return;}
    const review=action==='approve_pending_refund'||action==='reject_pending_refund';
    const command=review
     ?pendingRefundDecision(row,action==='approve_pending_refund'?'approve':'reject',why)
     :{path:`/v1/management/aftersales/${row.id}/actions`,
       data:{action,expectedVersion:row.version,note:why,...(action==='request_refund'&&direct?{approveRefund:true}:{})}};
    this.pendingDecision={...command,key:clientOperationKey("aftersale"),caseId:row.id,
     subjectId:review?row.refundRequestId!:row.id,version:command.data.expectedVersion!,uncertain:false,
     success:rejection?"已记录拒绝结果。":refund?(direct?"已同意退款，等待渠道确认。":"已提交退款复核。"):"已同意退货，请发送收件地址。"};
   }
   const attempt=this.pendingDecision;
   if(!attempt)return;
   const receipt=await request<{id:string;orderId:string;version:number}>({
    path:attempt.path,method:"POST",idempotencyKey:attempt.key,data:attempt.data,cacheTags:["orders","support"]
   });
   if(receipt?.id!==attempt.subjectId||receipt.orderId!==row.orderId||!Number.isSafeInteger(receipt.version)||receipt.version<=attempt.version)
    throw Error("Invalid aftersale receipt");
   if(this.pendingDecision===attempt)this.pendingDecision=null;
   if(!this.current(epoch,token))return;
   this.setData({decisionBusy:false,decisionRetry:false});
   const refreshEpoch=epoch+1;
   await this.load();
   if(this.current(refreshEpoch,token)&&this.data.order?.id===row.orderId)this.setData({decisionFeedback:attempt.success});
  }catch(error){
   if(!this.current(epoch,token))return;
   const issue=error as {status?:number;code?:string;title?:string};
   const attempt=this.pendingDecision;
   const gateDenied=issue.status===503&&/^FORMAL_(PAYMENT|COMMERCE)_/.test(issue.code??"");
   const known=issue.code!=="TRANSACTION_OUTCOME_UNKNOWN"&&[400,401,403,404,409,422].includes(issue.status??0);
   const stale=['VERSION_CONFLICT','REFUND_REQUEST_ALREADY_DECIDED'].includes(issue.code??'');
   if(attempt&&((gateDenied||known)&&!attempt.uncertain||stale)){
    this.pendingDecision=null;
    this.setData({decisionBusy:false,decisionRetry:false});
    const refreshEpoch=epoch+1;
    await this.load();
    if(this.current(refreshEpoch,token))this.setData({decisionFeedback:gateDenied?"当前环境尚未获准执行此退款操作。":issue.title??"请查看最新售后状态。"});
   }else if(attempt){
    attempt.uncertain=true;
    this.setData({decisionRetry:true,decisionFeedback:"提交结果待确认。重试会沿用这次操作。"});
   }else this.setData({decisionFeedback:"暂时无法打开确认窗口，请重试。"});
  }finally{
   if(this.current(epoch,token))this.setData({decisionBusy:false});
  }
 },
 openAftersale(event?:WechatMiniprogram.TouchEvent){
  const caseId=this.data.order?.aftersale?.caseId??this.data.order?.aftersaleCaseId,token=getApp<IAppOption>().globalData.sessionToken;
  if(!this.data.canOpenAftersale||this.data.navigating||this.data.dispatchBusy||this.data.decisionBusy||this.lastReadToken!==token
    ||!this.current(this.data.epoch,token)||!orderIdPattern.test(caseId??""))return;
  const decision=event?.currentTarget.dataset.action??this.data.decision;
  if(decision&&decision!==this.data.decision&&decision!==this.data.rejectAction)return;
  const action=decision?`&action=${decision}`:"";
  this.setData({navigating:true});
  wx.navigateTo({url:`/pages/aftersale/index?mode=management&caseId=${caseId}${action}`,fail:()=>this.setData({navigating:false})});
 },
 async contactBuyer(){
  const epoch=this.data.epoch,token=this.lastReadToken,caseId=this.data.order?.aftersale?.caseId??this.data.order?.aftersaleCaseId;
  if(!this.data.canContact||!orderIdPattern.test(caseId??"")||this.data.navigating||this.data.dispatchBusy||this.data.decisionBusy||!this.current(epoch,token))return;
  this.setData({navigating:true,caseError:""});
  try{
   const contact=await aftersaleContact(caseId);
   if(!this.current(epoch,token))return;
   if(contact.caseId!==caseId||contact.orderId!==this.data.id||!orderIdPattern.test(contact.conversationId))throw Error("Invalid support link");
   wx.navigateTo({url:`/pages/management-support-chat/index?id=${contact.conversationId}&caseId=${caseId}`,
    fail:()=>{if(this.current(epoch,token))this.setData({navigating:false,caseError:"暂时无法打开客服会话，请重试。"});}});
  }catch(error){if(this.current(epoch,token))this.setData({navigating:false,caseError:(error as {title?:string}).title??"暂时无法打开客服会话，请重试。"});}
 },
 async readShipment(epoch:number,token:string){
  this.setData({shipmentLoading:true,shipmentError:""});
  try{const shipment=await managementShipment(this.data.id);if(!this.current(epoch,token))return;
   if(shipment.orderId!==this.data.id||!deliveryLabels[shipment.logisticsState])throw Error('Invalid shipment');
   const shippedLabel=shipment.shippedAt&&Number.isFinite(Date.parse(shipment.shippedAt))
    ?new Date(shipment.shippedAt).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'';
   const shipmentLabel=shipment.receiptConfirmedAt?"已收货"
    :!shipment.id&&!this.data.order?.aftersale&&(this.data.order?.refundedCents??0)>0?"退款后暂停发货"
    :shipment.holdReason==='aftersale'?"售后处理中，暂停发货"
    :shipment.holdReason==='refund'?"退款处理中，暂停发货"
    :shipment.autoReceiptAt&&shipment.logisticsState==='shipped'?"已发货":deliveryLabels[shipment.logisticsState]??"状态待核对";
   const canDispatch=this.data.canReadShipment&&!this.data.order?.aftersale&&!shipment.holdReason;
   this.setData({shipment,canDispatch,shippedLabel,shipmentLabel,syncLabel:syncLabels[shipment.wechatSyncState??""]??"微信同步尚未开始",messageLabel:({queued:"物流消息待登记",retry:"物流消息稍后重试",dispatching:"物流消息结果待核对",registered:"物流消息已登记",unknown:"物流消息结果待核对",review:"物流消息需人工核对",cancelled:"物流消息已停止"} as Record<string,string>)[shipment.logisticsMessageState??""]??""});
   if(canDispatch&&shipment.logisticsState==="awaiting_dispatch"&&!this.data.order?.refundedCents&&this.data.order?.status==="paid"&&this.data.order.transactionSourceKind==="verified_commerce")void this.loadCarriers();
   if(shipment.id&&this.pendingDispatch){this.pendingDispatch=null;this.setData({form:emptyForm(),dispatchRecovery:false,dispatchMessage:"已核对到发货记录。"});}
  }catch(error){if(this.current(epoch,token)){const status=(error as {status?:number}).status;
   this.setData({shipment:null,canDispatch:false,shipmentError:(error as {title?:string}).title??"履约状态暂时无法核验，请刷新后重试。",...(status===401||status===403?{canReadShipment:false,order:null,form:emptyForm(),error:"登录状态或履约权限已变化，请返回管理中心重试。"}:{})});}}
  finally{if(this.current(epoch,token))this.setData({shipmentLoading:false});}
 },
 retryShipment(){
  const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
  if(this.current(epoch,token)&&token===this.lastReadToken&&this.data.canReadShipment&&!this.data.shipmentLoading&&!this.data.dispatchBusy)
   return this.readShipment(epoch,token);
 },
 async loadCarriers(){
  const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
  if(!this.current(epoch,token)||token!==this.lastReadToken||!this.data.canDispatch||this.data.shipment?.logisticsState!=="awaiting_dispatch"||this.data.carriersLoading)return;
  this.setData({carriersLoading:true,carriersError:""});
  try{const result=await shipmentCarriers(this);
   if(!this.current(epoch,token)||!this.data.canDispatch)return;
   if(!Array.isArray(result.carriers)||!result.carriers.length||result.carriers.some(r=>!r||!r.id||!r.name))throw Error('CARRIER_LIST_INVALID');
   this.setData({carriers:result.carriers,carrierLabels:["请选择快递公司",...result.carriers.map(r=>r.name)],carrierIndex:result.carriers.findIndex(r=>r.id===this.data.form.carrierCode)+1});
  }catch(error){if(this.current(epoch,token)){
   const denied=[401,403].includes((error as {status?:number})?.status??0);
   this.setData({carriers:[],carrierLabels:["请选择快递公司"],carrierIndex:0,carriersError:denied?"履约权限已变化，请重新打开订单":"快递列表暂未读取，可重试或手动填写",
    ...(denied?{canDispatch:false,order:null,shipment:null,form:emptyForm(),error:"登录状态或履约权限已变化，请返回管理中心重试。"}:{})});
  }}finally{if(this.current(epoch,token))this.setData({carriersLoading:false});}
 },
 selectCarrier(event:WechatMiniprogram.PickerChange){
  if(this.data.dispatchBusy||this.pendingDispatch||!this.data.canDispatch||this.lastReadToken!==getApp<IAppOption>().globalData.sessionToken)return;
  const index=Number(event.detail.value),row=this.data.carriers[index-1];if(!Number.isSafeInteger(index)||!row)return;
  this.setData({carrierIndex:index,form:{...this.data.form,carrierCode:row.id,carrierName:row.name},dispatchMessage:""});
 },
 shipmentInput(event:WechatMiniprogram.Input){if(this.data.dispatchBusy||this.pendingDispatch||!this.data.canDispatch)return;const field=event.currentTarget.dataset.field as keyof ReturnType<typeof emptyForm>;
  if(!Object.prototype.hasOwnProperty.call(emptyForm(),field))return;
  const value=event.detail.value.trim();
  this.setData({form:{...this.data.form,[field]:field==='carrierCode'?value.normalize('NFKC').toUpperCase():field==='trackingNumber'?value.normalize('NFKC'):value},dispatchMessage:""});},
 async reconcile(){
  if(this.lastReadToken!==getApp<IAppOption>().globalData.sessionToken){await this.load();return;}
  if(this.data.dispatchBusy||!this.data.pageAlive||!this.data.canDispatch||this.data.shipment?.wechatSyncState!=="manual_review")return;
  const evidence=this.data.form.evidenceReference;
  if(!/^[A-Za-z0-9._:-]{8,120}$/.test(evidence)){this.setData({dispatchMessage:"请填写本次人工核对记录编号（8–120 位字母、数字或 . _ : -）。"});return;}
  const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
  this.setData({dispatchBusy:true,dispatchMessage:""});
  try{
   const result=await reconcileShipment(this.data.id,evidence,clientOperationKey("shipping-query"));
   if(!this.current(epoch,token))return;
   this.setData({dispatchMessage:result.state==="synced"?"已确认微信记录为同一包裹，未重复上传，也未改变签收或退款记录。":"微信尚未确认同一包裹，已保留核对记录。请排查平台原订单，不要重复发货。"});
   await this.readShipment(epoch,token);
  }catch(error){if(this.current(epoch,token)){
   const status=(error as {status?:number}).status;
   if(status===401||status===403)this.setData({order:null,shipment:null,canDispatch:false,form:emptyForm(),error:"登录状态或履约权限已变化，请返回管理中心重试。"});
   else this.setData({dispatchMessage:(error as {title?:string}).title??"暂时无法核对微信结果，已保存的交寄记录不变。请稍后重试。"});
  }}finally{if(this.current(epoch,token))this.setData({dispatchBusy:false});}
 },
 submitShipment(){return this.submitDispatch('express');},
 submitWithoutLogistics(){return this.submitDispatch('no-courier');},
 async submitDispatch(mode:'express'|'no-courier'){
  if(this.lastReadToken!==getApp<IAppOption>().globalData.sessionToken){await this.load();return;}
  const order=this.data.order;
  if(this.data.dispatchBusy||this.data.shipmentLoading||!this.data.pageAlive||!this.data.canDispatch||!order||order.status!=="paid"||order.refundedCents||order.transactionSourceKind!=="verified_commerce"||this.data.shipment?.logisticsState!=="awaiting_dispatch"||mode==='no-courier'&&this.pendingDispatch)return;
  const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,form=this.data.form;
  if(!this.pendingDispatch&&mode==='express'&&(!/^[A-Z0-9_]{2,32}$/.test(form.carrierCode)
    ||!form.carrierName||form.carrierName.length>80||!/^[A-Za-z0-9-]{6,64}$/.test(form.trackingNumber))){
   this.setData({dispatchMessage:"请选择快递公司并填写实际运单号。"});return;
  }
  this.setData({dispatchBusy:true,dispatchMessage:""});
  try{
   if(!this.pendingDispatch){
    const method=mode==='no-courier'?await chooseNoCourierDelivery():null;
    if(!this.current(epoch,token)||!this.data.canDispatch||mode==='no-courier'&&!method)return;
    const title=method==='pickup'?"确认买家已取货":method==='local_delivery'?"确认同城配送已完成":"确认已交付快递";
    const content=method?`订单 ${order.orderNumber}\n发货满 7 天后自动确认收货，有退款或售后时暂停。`
      :`订单 ${order.orderNumber}\n${form.carrierName} · ${form.trackingNumber}\n确认后自动记录当前交寄时间。`;
    const decision=await new Promise<WechatMiniprogram.ShowModalSuccessCallbackResult>((resolve,reject)=>wx.showModal({
     title,content,confirmText:"登记发货",success:resolve,fail:reject}));
    if(!this.current(epoch,token)||!this.data.canDispatch||!decision.confirm)return;
    const key=clientOperationKey("shipment"),evidence={evidenceReference:`dispatch:${key}`,expectedOrderVersion:order.version};
    const input:ShipmentDispatchInput=method?{deliveryMethod:method,...evidence}
      :{carrierCode:form.carrierCode,carrierName:form.carrierName,trackingNumber:form.trackingNumber,...evidence};
    this.pendingDispatch={key,input};
   }
   await dispatchShipment(this.data.id,this.pendingDispatch.input,this.pendingDispatch.key);
   if(!this.current(epoch,token))return;
   this.pendingDispatch=null;this.setData({form:emptyForm(),dispatchRecovery:false,dispatchMessage:"发货记录已保存。"});
   await this.readShipment(epoch,token);
  }catch(error){if(this.current(epoch,token)){
   const problem=error as {status?:number;code?:string;title?:string};
   if(!this.pendingDispatch){this.setData({dispatchMessage:'确认窗口暂时无法打开，已保留待填写的信息。'});}
   else if(problem.status===401||problem.status===403){this.pendingDispatch=null;this.setData({order:null,shipment:null,canDispatch:false,form:emptyForm(),dispatchRecovery:false,error:"登录状态或履约权限已变化，请返回管理中心重试。"});}
   else if(problem.status===422){this.pendingDispatch=null;this.setData({dispatchRecovery:false,dispatchMessage:problem.title??"发货信息未通过校验，请核对后重试。"});}
   else if(problem.status===409){this.setData({dispatchBusy:false});await this.load();
    if(this.current(this.data.epoch,token)&&this.data.order)this.setData({dispatchMessage:problem.title??'订单状态已变化，请核对最新记录。'});}
   else{this.setData({dispatchRecovery:true,dispatchMessage:"登记结果待核对，重试会沿用原发货记录。"});await this.readShipment(epoch,token);}
  }}finally{if(this.current(epoch,token))this.setData({dispatchBusy:false});}
 },
 back(){if(this.data.navigating)return;this.setData({navigating:true});wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management-orders/index"})});}
});
