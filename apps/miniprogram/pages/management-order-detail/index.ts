import { requireCapability } from "../../services/authority";
import { centsToYuan } from "../../services/commerce";
import { managementOrder, managementShipment, shipmentCarriers, type ShipmentCarrier, dispatchShipment, reconcileShipment, clientOperationKey, type CommerceOrder, type ManagementOrderAddress, type NoCourierDelivery, type OrderShipment, type ShipmentDispatchInput } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";
import {cancelPageReads, pageRead} from "../../services/page-requests";
import { aftersaleContact, aftersaleLabels, refundApprovalAction, type RefundReviewCase, type OrderDecisionAction } from "../../services/order-aftersale";
const labels:Record<string,string>={pending_payment:"待支付",cancelled:"已取消",expired:"已超时",paid:"支付已核验"};
const syncLabels:Record<string,string>={prepared:"等待微信同步",dispatching:"正在提交微信",verifying:"微信结果核对中",synced:"微信已确认",manual_review:"微信同步待人工核对"};
const deliveryLabels:Record<string,string>={awaiting_dispatch:"待发货",not_ready:"尚不满足发货条件",shipped:"已交寄",delivered:"已签收",exception:"物流异常"};
const orderIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
 data:{chromeStyle:currentChromeStyle(),id:"",order:null as any,shipment:null as OrderShipment|null,shipmentLabel:"",shippedLabel:"",syncLabel:"",messageLabel:"",canReadShipment:false,canDispatch:false,canOpenAftersale:false,decision:"" as OrderDecisionAction|"",decisionLabel:"",canReject:false,canContact:false,caseError:"",shipmentLoading:false,shipmentError:"",carriers:[] as ShipmentCarrier[],carrierLabels:["请选择快递公司"],carrierIndex:0,carriersLoading:false,carriersError:"",dispatchBusy:false,dispatchRecovery:false,dispatchMessage:"",form:emptyForm(),loading:true,navigating:false,error:"",invalidId:false,pageAlive:true,epoch:0},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 onLoad(query:Record<string,string|undefined>){const id=query.id??"";this.setData({id,invalidId:!orderIdPattern.test(id)});},
 async onShow(){
  this.data.pageAlive=true;this.setData({navigating:false});await this.load();
  if(this.data.pageAlive&&!this.refreshTimer)this.refreshTimer=setInterval(()=>void this.recheckOrder(),10_000);
 },
 onHide(){
  if(this.refreshTimer!==null)clearInterval(this.refreshTimer);
  this.refreshTimer=null;this.data.pageAlive=false;this.data.epoch+=1;this.pendingDispatch=null;this.capabilities=[];cancelPageReads(this);
  this.setData({carriers:[],carrierLabels:["请选择快递公司"],carrierIndex:0,carriersLoading:false,carriersError:"",order:null,shipment:null,
   canReadShipment:false,canDispatch:false,canOpenAftersale:false,decision:"",decisionLabel:"",canReject:false,canContact:false,caseError:"",
   form:emptyForm(),dispatchBusy:false,dispatchRecovery:false,dispatchMessage:"",shipmentError:""});
 },
 onUnload(){this.onHide();},
 current(epoch:number,token:string){return this.data.pageAlive&&this.data.epoch===epoch&&token===getApp<IAppOption>().globalData.sessionToken;},
 normalize(order:CommerceOrder<ManagementOrderAddress>){return {...order,statusLabel:order.aftersale?aftersaleLabels[order.aftersale.phase]:order.status==="paid"&&(order.refundedCents??0)>0?(order.refundedCents!>=order.totalCents?"已退款":"部分退款"):(labels[order.status]??order.status),totalYuan:centsToYuan(order.totalCents),creditYuan:centsToYuan(order.creditTenderCents),cashYuan:centsToYuan(order.cashPayableCents),createdLabel:new Date(order.createdAt).toLocaleString("zh-CN",{hour12:false,timeZone:"Asia/Shanghai"}),lines:order.lines.map(line=>({...line,totalYuan:centsToYuan(line.totalCents)})),addressSummary:order.address?`${order.address.province}${order.address.city}${order.address.district}`:""};},
 async load(){
  if(this.data.dispatchBusy)return;
  const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
  this.lastReadToken=token;
  this.pendingDispatch=null;this.capabilities=[];
  this.setData({order:null,shipment:null,canReadShipment:false,canDispatch:false,canOpenAftersale:false,decision:"",decisionLabel:"",
   canReject:false,canContact:false,caseError:"",form:emptyForm(),loading:true,error:"",shipmentError:"",dispatchRecovery:false,dispatchMessage:""});
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
   this.setData({order:this.normalize(order),canReadShipment,canDispatch:false,canOpenAftersale,loading:false});
   await Promise.all([
    canReadShipment?this.readShipment(epoch,token):undefined,
    canOpenAftersale&&caseId?this.readAftersale(caseId,epoch,token):undefined
   ]);
  }catch(error){if(this.current(epoch,token))this.setData({loading:false,error:(error as {title?:string}).title??"暂时无法查看订单详情，请重试或返回列表。"});}
 },
 async recheckOrder(){
  const order=this.data.order,epoch=this.data.epoch,token=this.lastReadToken;
  if(!order||this.refreshInFlight||this.data.loading||this.data.navigating||this.data.dispatchBusy||this.pendingDispatch
    ||!this.current(epoch,token))return;
  this.refreshInFlight=true;
  try{
   const latest=await managementOrder(this.data.id);
   if(!this.current(epoch,token)||this.data.navigating||this.data.dispatchBusy||this.pendingDispatch)return;
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
   const canReview=row.canReview!==false&&this.capabilities.includes('commerce.aftersale.review');
   const active=this.data.order?.aftersale?.caseId===row.id;
   const refund=active?refundApprovalAction(row,this.capabilities):null;
   const approveReturn=active&&canReview&&row.state==='requested'&&row.kind==='return_refund'&&row.fulfillment?.state==='shipped';
   const requestReview=active&&canReview&&row.canStartRefund===true;
   this.setData({
    decision:refund??(approveReturn?'approve_return':requestReview?'request_refund':''),
    decisionLabel:refund?'同意退款':approveReturn?'同意退货':requestReview?'提交退款复核':'',
    canReject:active&&canReview&&['requested','need_info'].includes(row.state??''),
    canContact:canReview&&this.capabilities.includes('support.read')&&this.capabilities.includes('support.reply'),
    caseError:""
   });
  }catch(error){
   if(this.current(epoch,token)){
    const denied=[401,403].includes((error as {status?:number}).status??0);
    this.setData({canOpenAftersale:!denied,decision:"",decisionLabel:"",canReject:false,canContact:false,
     caseError:denied?"当前账号没有售后处理权限。":"售后操作暂时无法核对，请刷新。"});
   }
  }
 },
 openAftersale(event?:WechatMiniprogram.TouchEvent){
  const caseId=this.data.order?.aftersale?.caseId??this.data.order?.aftersaleCaseId,token=getApp<IAppOption>().globalData.sessionToken;
  if(!this.data.canOpenAftersale||this.data.navigating||this.data.dispatchBusy||this.lastReadToken!==token
    ||!this.current(this.data.epoch,token)||!orderIdPattern.test(caseId??""))return;
  const decision=event?.currentTarget.dataset.action??this.data.decision;
  if(decision&&decision!==this.data.decision&&!(decision==='reject'&&this.data.canReject))return;
  const action=decision?`&action=${decision}`:"";
  this.setData({navigating:true});
  wx.navigateTo({url:`/pages/aftersale/index?mode=management&caseId=${caseId}${action}`,fail:()=>this.setData({navigating:false})});
 },
 async contactBuyer(){
  const epoch=this.data.epoch,token=this.lastReadToken,caseId=this.data.order?.aftersale?.caseId??this.data.order?.aftersaleCaseId;
  if(!this.data.canContact||!orderIdPattern.test(caseId??"")||this.data.navigating||this.data.dispatchBusy||!this.current(epoch,token))return;
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
