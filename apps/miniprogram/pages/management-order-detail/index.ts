import { requireCapability } from "../../services/authority";
import { centsToYuan } from "../../services/commerce";
import { managementOrder, managementShipment, dispatchShipment, reconcileShipment, clientOperationKey, type CommerceOrder, type ManagementOrderAddress, type OrderShipment, type ShipmentDispatchInput } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";
import { shanghaiShipmentInstant } from "../../services/shipment-time";
const labels:Record<string,string>={pending_payment:"待支付",cancelled:"已取消",expired:"已超时",paid:"支付已核验"};
const syncLabels:Record<string,string>={prepared:"等待微信同步",dispatching:"正在提交微信",verifying:"微信结果核对中",synced:"微信已确认",manual_review:"微信同步待人工核对"};
const deliveryLabels:Record<string,string>={awaiting_dispatch:"待发货",not_ready:"尚不满足发货条件",shipped:"已交寄",delivered:"已签收",exception:"物流异常"};
const orderIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emptyForm=()=>({carrierCode:"",carrierName:"",trackingNumber:"",evidenceReference:"",date:"",time:""});
Page({
 lastReadToken:"",
 pendingDispatch:null as {key:string;input:ShipmentDispatchInput}|null,
 data:{chromeStyle:currentChromeStyle(),id:"",order:null as any,shipment:null as OrderShipment|null,shipmentLabel:"",syncLabel:"",canDispatch:false,shipmentLoading:false,shipmentError:"",dispatchBusy:false,dispatchMessage:"",form:emptyForm(),loading:true,navigating:false,error:"",invalidId:false,pageAlive:true,epoch:0},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 onLoad(query:Record<string,string|undefined>){const id=query.id??"";this.setData({id,invalidId:!orderIdPattern.test(id)});},
 async onShow(){this.data.pageAlive=true;this.setData({navigating:false});await this.load();},
 onHide(){this.data.pageAlive=false;this.data.epoch+=1;this.pendingDispatch=null;this.setData({order:null,shipment:null,canDispatch:false,form:emptyForm(),dispatchBusy:false,dispatchMessage:"",shipmentError:""});},
 onUnload(){this.onHide();},
 current(epoch:number,token:string){return this.data.pageAlive&&this.data.epoch===epoch&&token===getApp<IAppOption>().globalData.sessionToken;},
 normalize(order:CommerceOrder<ManagementOrderAddress>){return {...order,statusLabel:labels[order.status]??order.status,totalYuan:centsToYuan(order.totalCents),creditYuan:centsToYuan(order.creditTenderCents),cashYuan:centsToYuan(order.cashPayableCents),createdLabel:new Date(order.createdAt).toLocaleString("zh-CN",{hour12:false,timeZone:"Asia/Shanghai"}),lines:order.lines.map(line=>({...line,totalYuan:centsToYuan(line.totalCents)})),addressSummary:order.address?`${order.address.province}${order.address.city}${order.address.district}`:""};},
 async load(){
  if(this.data.dispatchBusy)return;
  const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
  this.lastReadToken=token;
  this.pendingDispatch=null;this.setData({order:null,shipment:null,canDispatch:false,form:emptyForm(),loading:true,error:"",shipmentError:"",dispatchMessage:""});
  if(this.data.invalidId){if(this.current(epoch,token))this.setData({loading:false,error:"请从订单列表选择一笔订单。"});return;}
  const allowed=await requireCapability("commerce.order.read");
  if(!this.current(epoch,token))return;
  if(!allowed){this.setData({loading:false,error:"当前账号没有订单查看权限。"});return;}
  try{const order=await managementOrder(this.data.id);
   if(!this.current(epoch,token))return;
   const canDispatch=allowed.capabilities.includes("commerce.fulfillment.manage");
   this.setData({order:this.normalize(order),canDispatch,loading:false});
   if(canDispatch)await this.readShipment(epoch,token);
  }catch(error){if(this.current(epoch,token))this.setData({loading:false,error:(error as {title?:string}).title??"订单详情暂时无法读取；权限变化后不会继续展示旧内容。"});}
 },
 async readShipment(epoch:number,token:string){
  this.setData({shipmentLoading:true,shipmentError:""});
  try{const shipment=await managementShipment(this.data.id);if(!this.current(epoch,token))return;
   this.setData({shipment,shipmentLabel:deliveryLabels[shipment.logisticsState]??"状态待核对",syncLabel:syncLabels[shipment.wechatSyncState??""]??"微信同步尚未开始"});
   if(shipment.id&&this.pendingDispatch){this.pendingDispatch=null;this.setData({form:emptyForm(),dispatchMessage:"原订单已记录交寄；请核对微信同步状态，不要重复交寄。"});}
  }catch(error){if(this.current(epoch,token)){const status=(error as {status?:number}).status;
   this.setData({shipment:null,shipmentError:(error as {title?:string}).title??"履约状态暂时无法核验，请刷新后重试。",...(status===401||status===403?{canDispatch:false,order:null,form:emptyForm(),error:"登录或履约权限已变化，请返回管理中心重新核验。"}:{})});}}
  finally{if(this.current(epoch,token))this.setData({shipmentLoading:false});}
 },
 shipmentInput(event:WechatMiniprogram.Input){if(this.data.dispatchBusy||this.pendingDispatch)return;const field=event.currentTarget.dataset.field as keyof ReturnType<typeof emptyForm>;
  if(!Object.prototype.hasOwnProperty.call(emptyForm(),field))return;this.setData({form:{...this.data.form,[field]:event.detail.value.trim()},dispatchMessage:""});},
 shipmentDate(event:WechatMiniprogram.PickerChange){if(!this.data.dispatchBusy&&!this.pendingDispatch)this.setData({form:{...this.data.form,date:String(event.detail.value)}});},
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
   this.setData({dispatchMessage:result.state==="synced"?"微信已核对为同一包裹；未重复上传或改变签收、退款事实。":"微信尚未确认同一包裹，已保留核对记录。请排查平台原订单，不要重复发货。"});
   await this.readShipment(epoch,token);
  }catch(error){if(this.current(epoch,token)){
   const status=(error as {status?:number}).status;
   if(status===401||status===403)this.setData({order:null,shipment:null,canDispatch:false,form:emptyForm(),error:"登录或履约权限已变化，请返回管理中心重新核验。"});
   else this.setData({dispatchMessage:(error as {title?:string}).title??"微信核对暂不可用，交寄事实保持不变。请稍后重试。"});
  }}finally{if(this.current(epoch,token))this.setData({dispatchBusy:false});}
 },
 async submitShipment(){
  if(this.lastReadToken!==getApp<IAppOption>().globalData.sessionToken){await this.load();return;}
  if(this.data.dispatchBusy||!this.data.pageAlive||!this.data.canDispatch||!this.data.order||this.data.order.status!=="paid"||this.data.order.transactionSourceKind!=="verified_commerce"||this.data.shipment?.logisticsState!=="awaiting_dispatch")return;
  const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,form=this.data.form;
  const shippedAt=shanghaiShipmentInstant(form.date,form.time);
  if(!/^[A-Z0-9_]{2,32}$/.test(form.carrierCode)||!form.carrierName||form.carrierName.length>80||! /^[A-Za-z0-9-]{6,64}$/.test(form.trackingNumber)||! /^[A-Za-z0-9._:-]{8,120}$/.test(form.evidenceReference)||!shippedAt){this.setData({dispatchMessage:"请完整填写快递公司、公司编码、真实运单、北京时间的实际交寄时间和凭证编号。"});return;}
  this.setData({dispatchBusy:true,dispatchMessage:""});
  try{
   const decision=await new Promise<WechatMiniprogram.ShowModalSuccessCallbackResult>((resolve,reject)=>wx.showModal({title:"确认已交付快递",content:`订单 ${this.data.order.orderNumber}\n${form.carrierName} · ${form.trackingNumber}\n实际交寄：北京时间 ${form.date} ${form.time}\n仅登记已实际交寄的整单包裹。微信同步状态会单独显示。`,confirmText:"登记发货",success:resolve,fail:reject}));
   if(!this.current(epoch,token)||!decision.confirm)return;
   this.pendingDispatch??={key:clientOperationKey("shipment"),input:{carrierCode:form.carrierCode,carrierName:form.carrierName,trackingNumber:form.trackingNumber,evidenceReference:form.evidenceReference,shippedAt,expectedOrderVersion:this.data.order.version}};
   await dispatchShipment(this.data.id,this.pendingDispatch.input,this.pendingDispatch.key);
   if(!this.current(epoch,token))return;
   this.pendingDispatch=null;this.setData({form:emptyForm(),dispatchMessage:"交寄事实已保存；微信同步和签收状态请分别核对。"});
   await this.readShipment(epoch,token);
  }catch(error){if(this.current(epoch,token)){
   const status=(error as {status?:number}).status;
   if(status===401||status===403){this.pendingDispatch=null;this.setData({order:null,shipment:null,canDispatch:false,form:emptyForm(),error:"登录或履约权限已变化，请返回管理中心重新核验。"});}
   else if(status===422){this.pendingDispatch=null;this.setData({dispatchMessage:(error as {code?:string}).code==="SHIPMENT_TIME_INVALID"?"交寄时间须晚于支付成功时间，且不能晚于当前时间。请核对后重新填写。":((error as {title?:string}).title??"交寄信息未通过校验，请修正后重试。")});}
   else{this.setData({dispatchMessage:"提交结果尚未确认，请先刷新核对原订单。不要重新交寄包裹。"});await this.readShipment(epoch,token);}
  }}finally{if(this.current(epoch,token))this.setData({dispatchBusy:false});}
 },
 back(){if(this.data.navigating)return;this.setData({navigating:true});wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management-orders/index"})});}
});
