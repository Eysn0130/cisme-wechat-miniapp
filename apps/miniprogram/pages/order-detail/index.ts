import { commerceContextRevision } from "../../services/commerce-command-store";
import { acknowledgeCommerceCommand, executeCommerceCommand, readCommerceRecovery, retryCommerceCommand, type RecoveryView } from "../../services/commerce-command-recovery";
import { cancelPageReads, pageRead } from "../../services/page-requests";
import { cancelRuntimeRead, initialRuntimeView, runtimeActions, runtimeReadOwner, runtimeView, validateRuntime } from "../../services/commerce-runtime";
import { request, requireMemberAccess } from "../../services/api";
import { centsToYuan } from "../../services/commerce";
import { clientOperationKey, myOrder, orderRuntimeStatus, type CommerceOrder, type MemberOrderAddress } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";
const labels:Record<string,string>={pending_payment:"待支付",cancelled:"已取消",expired:"已超时",paid:"已支付，待履约"};
type RefundRow={id:string;orderId:string;amountCents:number;state:string;refundState:string|null;reason:string;createdAt:string;
  cashRefundCents:number|null;creditReturnCents:number|null;amountLabel?:string;stateLabel?:string;
  cashLabel?:string;creditLabel?:string};
type RefundPage={items:RefundRow[];totalCount:number;nextCursor:string|null};
const refundLabels:Record<string,string>={requested:"待复核",rejected:"未通过",approved:"已核准，待渠道处理",prepared:"待提交渠道",succeeded:"渠道已退款",closed:"渠道已关闭",abnormal:"渠道异常"};
const orderIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const errorTitle=(error:unknown,fallback:string)=>(error as {title?:string})?.title||fallback;
function refundCents(value:string){const match=/^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(value.trim());
  return match?Number(match[1])*100+Number((match[2]??"").padEnd(2,"0")):NaN;}
Page({
  lastSessionToken:"",lastSessionRevision:-1,
  data:{...initialRuntimeView(),recoveryRows:[] as RecoveryView[],recoveryLoading:false,recoveryError:"",coreReady:false,visible:true,readEpoch:0,runtimeEpoch:0,refreshOnShow:false,chromeStyle:currentChromeStyle(),id:"",order:null as (CommerceOrder<MemberOrderAddress>&Record<string,unknown>)|null,
    isolatedPayment:false,refunds:[] as RefundRow[],refundTotal:0,refundCountLabel:"尚未读取退款记录",refundCursor:null as string|null,refundLoading:false,refundMoreLoading:false,refundError:"",
    refundFormVisible:false,refundAmount:"",refundReason:"",refundKey:"",actionStatus:"",actionError:"",
    loading:true,busy:false,navigating:false,error:"",invalidId:false,cancelKey:"",pageAlive:true,epoch:0},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},onLoad(query:Record<string,string|undefined>){const id=query.id??"";
    this.setData({id,invalidId:!orderIdPattern.test(id)});},
  onShow(){this.data.pageAlive=true;this.data.visible=true;this.setData({navigating:false});this.syncSession();
    if(!requireMemberAccess())return;void this.load();},
  syncSession(){const token=getApp<IAppOption>().globalData.sessionToken;
    if(token!==this.lastSessionToken||this.lastSessionRevision!==commerceContextRevision()){this.lastSessionToken=token;this.lastSessionRevision=commerceContextRevision();this.data.epoch+=1;this.setData({...initialRuntimeView(),recoveryRows:[],recoveryLoading:false,recoveryError:"",busy:false,coreReady:false,isolatedPayment:false,order:null,refunds:[],refundTotal:0,refundCountLabel:"尚未读取退款记录",refundCursor:null,
      refundFormVisible:false,refundAmount:"",refundReason:"",refundKey:"",cancelKey:"",actionError:"",actionStatus:""});}
    },
  confirmationPending:false,
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
    this.data.refreshOnShow=true;cancelPageReads(this);cancelRuntimeRead(this);},
  finishAction(epoch:number,token:string,refreshCore=false){if(!this.current(epoch,token))return;
    this.setData({busy:false});if(this.data.visible&&(refreshCore||this.data.refreshOnShow)){this.data.refreshOnShow=false;void this.load();}else if(this.data.visible)void this.loadRecovery();},

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
    const answer=await this.confirmOperation({title:row.recorded?"确认已核对原操作？":"重试原操作？",content:row.recorded?"原申请已由服务端记录。确认后才可开始新的申请；付款、退款和到账仍分别按权威状态展示。":"只使用最初确认的金额、原因、版本和请求编号，先查询原结果；不会使用后来修改的内容，也不会开启真实资金操作。",confirmText:row.recorded?"已核对":"重试原操作"});
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
    if(this.data.invalidId){this.setData({loading:false,coreReady:false,isolatedPayment:false,error:"请从订单列表选择一笔订单。",order:null});return;}
    this.setData({loading:!this.data.order,coreReady:false,error:"",isolatedPayment:false});
    void this.loadRuntime(epoch,token);
    try{const order=await myOrder(this.data.id,this);
      if(!this.readCurrent(epoch,token,readEpoch))return;
      if(order.id!==this.data.id||!Number.isSafeInteger(order.version)||this.data.order&&order.version<this.data.order.version)throw new Error("Invalid or obsolete order projection");
      this.setData({order:this.normalize(order),coreReady:true,loading:false});this.applyRuntime();void this.loadRefunds(epoch,token);void this.loadRecovery();
    }catch(error){if(this.readCurrent(epoch,token,readEpoch))this.setData({order:[401,403,404].includes((error as {status?:number})?.status??0)?null:this.data.order,coreReady:false,loading:false,error:errorTitle(error,"订单详情暂时无法同步。")});}
  },
  applyRuntime(){const isolatedPayment=this.canAct()&&this.data.runtimeState==="ready"&&runtimeActions(this.data.runtimeStatus).money&&this.data.order?.transactionSourceKind==="verified_commerce";
    this.setData({isolatedPayment});
  },
  async loadRuntime(epoch:number,token:string){cancelRuntimeRead(this);const attempt=++this.data.runtimeEpoch,readEpoch=this.data.readEpoch;
    this.setData({runtimeState:"loading",runtimeMode:"unknown",runtimeStatus:null,runtimeCopy:"正在核验资金操作状态，订单事实可先查看。",isolatedPayment:false});
    try{const status=validateRuntime(await orderRuntimeStatus(runtimeReadOwner(this)));
      if(!this.readCurrent(epoch,token,readEpoch)||attempt!==this.data.runtimeEpoch)return;
      this.setData(runtimeView(status));this.applyRuntime();
    }catch{if(this.readCurrent(epoch,token,readEpoch)&&attempt===this.data.runtimeEpoch)this.setData({runtimeState:"error",runtimeCopy:"资金操作状态暂时无法核验，付款及退款申请保持关闭；可单独重试。",isolatedPayment:false});}
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
        stateLabel:refundLabels[row.refundState??""]??refundLabels[row.state]??row.state}));
      const seen=new Set(cursor?this.data.refunds.map(row=>row.id):[]);
      this.setData({refunds:[...(cursor?this.data.refunds:[]),...rows.filter(row=>!seen.has(row.id))],
        refundTotal:page.totalCount,refundCountLabel:`本单申请 ${page.totalCount} 项`,refundCursor:page.nextCursor,refundLoading:false,refundMoreLoading:false});
    }catch(error){if(this.readCurrent(epoch,token,readEpoch))this.setData({refundLoading:false,refundMoreLoading:false,
      refundCountLabel:"记录数量暂未核实",refundError:errorTitle(error,"退款记录暂时无法同步，请重试。")});}},
  loadMoreRefunds(){const cursor=this.data.refundCursor;if(cursor&&!this.data.refundLoading&&!this.data.refundMoreLoading)
    void this.loadRefunds(this.data.epoch,getApp<IAppOption>().globalData.sessionToken,cursor);},
  retryRefunds(){void this.loadRefunds(this.data.epoch,getApp<IAppOption>().globalData.sessionToken);},
  showRefundForm(){if(this.data.isolatedPayment&&this.data.order?.status==="paid"&&!this.data.busy)
    this.setData({refundFormVisible:true,actionError:"",actionStatus:""});},
  closeRefundForm(){if(!this.data.busy)this.setData({refundFormVisible:false,actionError:""});},
  editRefundAmount(event:WechatMiniprogram.Input){if(this.data.busy)return;this.setData({refundAmount:event.detail.value,refundKey:""});},
  editRefundReason(event:WechatMiniprogram.Input){if(this.data.busy)return;this.setData({refundReason:event.detail.value,refundKey:""});},
  async submitRefund(){const order=this.data.order;
    if(!this.canAct()||this.data.busy||!this.data.refundFormVisible||!this.data.isolatedPayment||!order||order.status!=="paid")return;
    const amountCents=refundCents(this.data.refundAmount),reason=this.data.refundReason.trim();
    if(!Number.isSafeInteger(amountCents)||amountCents<1||amountCents>order.totalCents){this.setData({actionError:`请输入不超过 ¥${order.totalYuan} 的正数金额。`});return;}
    if(Array.from(reason).length<3||Array.from(reason).length>500){this.setData({actionError:"请填写 3 至 500 字的退款原因。"});return;}
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,id=order.id,
      key=this.data.refundKey||clientOperationKey("refund-request");
    const current=()=>this.current(epoch,token)&&this.data.order?.id===id&&this.data.order.status==="paid";
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
    if(!this.canAct()||this.data.busy||!order||order.status!=="pending_payment"||!this.data.isolatedPayment)return;
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
      content:this.data.isolatedPayment?"系统会先按原商户订单号查询并关闭测试渠道订单；未知支付状态不会释放库存。":"取消后将释放本单预留库存，订单记录仍保留。",
      confirmText:"确认取消",confirmColor:"#8d3150"}).catch(()=>({confirm:false}));if(!answer.confirm||!current()||!this.canAct()||this.data.busy)return;
    const cancelKey=this.data.cancelKey||clientOperationKey("order-cancel");this.setData({busy:true,error:"",actionError:"",cancelKey});
    try{const result=await executeCommerceCommand<CommerceOrder<MemberOrderAddress>>({kind:this.data.isolatedPayment?"cancel-verified":"cancel",objectId:id,key:cancelKey,
      payload:{expectedVersion:version,reason:"用户确认取消待支付订单"}},()=>current()&&this.data.visible&&(order.transactionSourceKind!=="verified_commerce"||this.data.isolatedPayment));
      const updated=result.result??await myOrder(id,this);
      if(current())this.setData({order:this.normalize(updated),busy:false,cancelKey:"",actionStatus:"订单已取消，预留库存及测试购物权益已释放。"});}
    catch(error){if(current())this.setData({busy:false,actionError:errorTitle(error,"取消结果暂未核实，请核对原单后重试原操作。")});}
    finally{this.finishAction(epoch,token);}},
  back(){if(this.data.busy||this.data.navigating)return;this.setData({navigating:true});wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/orders/index"})});}
});
