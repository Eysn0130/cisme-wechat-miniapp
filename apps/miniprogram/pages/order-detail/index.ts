import { request, requireMemberAccess } from "../../services/api";
import { centsToYuan } from "../../services/commerce";
import { cancelMyOrder, clientOperationKey, myOrder, orderRuntimeStatus, type CommerceOrder, type MemberOrderAddress } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";
const labels:Record<string,string>={pending_payment:"待支付",cancelled:"已取消",expired:"已超时",paid:"已支付，待履约"};
type RefundRow={id:string;orderId:string;amountCents:number;state:string;refundState:string|null;reason:string;createdAt:string;amountLabel?:string;stateLabel?:string};
type RefundPage={items:RefundRow[];totalCount:number;nextCursor:string|null};
const refundLabels:Record<string,string>={requested:"待复核",rejected:"未通过",approved:"已核准，待渠道处理",prepared:"待提交渠道",succeeded:"渠道已退款",closed:"渠道已关闭",abnormal:"渠道异常"};
const orderIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const errorTitle=(error:unknown,fallback:string)=>(error as {title?:string})?.title||fallback;
function refundCents(value:string){const match=/^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(value.trim());
  return match?Number(match[1])*100+Number((match[2]??"").padEnd(2,"0")):NaN;}
Page({
  lastSessionToken:"",
  data:{chromeStyle:currentChromeStyle(),id:"",order:null as (CommerceOrder<MemberOrderAddress>&Record<string,unknown>)|null,
    isolatedPayment:false,refunds:[] as RefundRow[],refundTotal:0,refundCursor:null as string|null,refundLoading:false,refundMoreLoading:false,refundError:"",
    refundFormVisible:false,refundAmount:"",refundReason:"",refundKey:"",actionStatus:"",actionError:"",
    loading:true,busy:false,navigating:false,error:"",invalidId:false,cancelKey:"",pageAlive:true,epoch:0},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},onLoad(query:Record<string,string|undefined>){const id=query.id??"";
    this.setData({id,invalidId:!orderIdPattern.test(id)});},
  onShow(){this.data.pageAlive=true;this.setData({navigating:false});const token=getApp<IAppOption>().globalData.sessionToken;
    if(token!==this.lastSessionToken){this.lastSessionToken=token;this.data.epoch+=1;this.setData({order:null,refunds:[],refundTotal:0,refundCursor:null,
      refundFormVisible:false,refundAmount:"",refundReason:"",refundKey:"",cancelKey:"",actionError:"",actionStatus:""});}
    if(!requireMemberAccess())return;void this.load();},
  onUnload(){this.data.pageAlive=false;this.data.epoch+=1;},
  normalize(order:CommerceOrder<MemberOrderAddress>){return {...order,statusLabel:labels[order.status]??order.status,totalYuan:centsToYuan(order.totalCents),subtotalYuan:centsToYuan(order.subtotalCents),discountYuan:centsToYuan(order.memberDiscountCents),shippingYuan:centsToYuan(order.shippingCents),createdLabel:new Date(order.createdAt).toLocaleString("zh-CN",{hour12:false}),expiresLabel:new Date(order.expiresAt).toLocaleString("zh-CN",{hour12:false}),lines:order.lines.map(line=>({...line,unitPriceYuan:centsToYuan(line.unitPriceCents),totalYuan:centsToYuan(line.totalCents)})),addressSummary:order.address?`${order.address.province}${order.address.city}${order.address.district} ${order.address.detail}`:""};},
  current(epoch:number,token:string){return this.data.pageAlive&&this.data.epoch===epoch&&token===getApp<IAppOption>().globalData.sessionToken;},
  async load(){const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    if(this.data.invalidId){this.setData({loading:false,error:"请从订单列表选择一笔订单。",order:null});return;}
    this.setData({loading:true,error:"",order:null,refunds:[],refundTotal:0,refundCursor:null,isolatedPayment:false,refundError:""});
    try{const [order,status]=await Promise.all([myOrder(this.data.id),orderRuntimeStatus().catch(()=>null)]);
      if(!this.current(epoch,token))return;
      const isolatedPayment=(status?.scope==="verified_isolated_test"||status?.scope==="formal_protocol_synthetic_test")&&
        status.isolatedMoneyOperationsAvailable&&order.transactionSourceKind==="verified_commerce";
      this.setData({order:this.normalize(order),isolatedPayment,loading:false});
      if(isolatedPayment&&order.status==="paid")void this.loadRefunds(epoch,token);
    }catch(error){if(this.current(epoch,token))this.setData({order:null,loading:false,error:errorTitle(error,"订单详情暂时无法同步。")});}},
  async loadRefunds(epoch:number,token:string,cursor?:string){
    if(!this.data.order||!this.data.isolatedPayment)return;
    if(cursor)this.setData({refundMoreLoading:true,refundError:""});
    else this.setData({refundLoading:true,refunds:[],refundTotal:0,refundCursor:null,refundError:""});
    try{const page=await request<RefundPage>({path:`/v1/me/refund-requests?orderId=${this.data.id}&limit=10${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`});
      if(!this.current(epoch,token)||this.data.order?.id!==this.data.id||cursor&&this.data.refundCursor!==cursor)return;
      const rows=page.items.map(row=>({...row,amountLabel:centsToYuan(row.amountCents),
        stateLabel:refundLabels[row.refundState??""]??refundLabels[row.state]??row.state}));
      const seen=new Set(cursor?this.data.refunds.map(row=>row.id):[]);
      this.setData({refunds:[...(cursor?this.data.refunds:[]),...rows.filter(row=>!seen.has(row.id))],
        refundTotal:page.totalCount,refundCursor:page.nextCursor,refundLoading:false,refundMoreLoading:false});
    }catch(error){if(this.current(epoch,token))this.setData({refundLoading:false,refundMoreLoading:false,
      refundError:errorTitle(error,"退款记录暂时无法同步，请重试。")});}},
  loadMoreRefunds(){const cursor=this.data.refundCursor;if(cursor&&!this.data.refundLoading&&!this.data.refundMoreLoading)
    void this.loadRefunds(this.data.epoch,getApp<IAppOption>().globalData.sessionToken,cursor);},
  retryRefunds(){void this.loadRefunds(this.data.epoch,getApp<IAppOption>().globalData.sessionToken);},
  showRefundForm(){if(this.data.isolatedPayment&&this.data.order?.status==="paid"&&!this.data.busy)
    this.setData({refundFormVisible:true,actionError:"",actionStatus:""});},
  closeRefundForm(){if(!this.data.busy)this.setData({refundFormVisible:false,actionError:""});},
  editRefundAmount(event:WechatMiniprogram.Input){this.setData({refundAmount:event.detail.value,refundKey:""});},
  editRefundReason(event:WechatMiniprogram.Input){this.setData({refundReason:event.detail.value,refundKey:""});},
  async submitRefund(){const order=this.data.order;
    if(this.data.busy||!this.data.refundFormVisible||!this.data.isolatedPayment||!order||order.status!=="paid")return;
    const amountCents=refundCents(this.data.refundAmount),reason=this.data.refundReason.trim();
    if(!Number.isSafeInteger(amountCents)||amountCents<1||amountCents>order.totalCents){this.setData({actionError:`请输入不超过 ¥${order.totalYuan} 的正数金额。`});return;}
    if(Array.from(reason).length<3||Array.from(reason).length>500){this.setData({actionError:"请填写 3 至 500 字的退款原因。"});return;}
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,id=order.id,
      key=this.data.refundKey||clientOperationKey("refund-request");
    const current=()=>this.current(epoch,token)&&this.data.order?.id===id&&this.data.order.status==="paid";
    const answer=await wx.showModal({title:"提交隔离退款申请？",content:`订单 ${order.orderNumber}\n申请 ¥${centsToYuan(amountCents)}。另一名授权人员复核后才可能向测试渠道提交；受理不代表退款成功。`,confirmText:"提交申请"});
    if(!answer.confirm||!current())return;
    this.setData({busy:true,refundKey:key,actionError:"",actionStatus:""});
    try{await request({path:`/v1/me/orders/${id}/refund-requests`,method:"POST",idempotencyKey:key,data:{amountCents,reason}});
      if(current()){this.setData({busy:false,refundFormVisible:false,refundAmount:"",refundReason:"",refundKey:"",
        actionStatus:"申请已记录，请在下方查看复核和渠道结果。"});void this.loadRefunds(epoch,token);}}
    catch(error){if(current())this.setData({busy:false,actionError:errorTitle(error,"退款申请结果暂不确定；再次提交会使用同一请求编号。")});}
    finally{if(current())this.setData({busy:false});}},
  async preparePayment(){const order=this.data.order;
    if(this.data.busy||!order||order.status!=="pending_payment"||!this.data.isolatedPayment)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,id=order.id;
    const current=()=>this.current(epoch,token)&&this.data.order?.id===id;
    this.setData({busy:true,actionError:"",actionStatus:""});
    try{const result=await request<{state:string;simulation:boolean;requestPayment?:WechatMiniprogram.RequestPaymentOption}>({
      path:`/v1/me/orders/${id}/payment-intent`,method:"POST",data:{}});
      if(!current())return;
      if(result.state==="verified_pending")this.setData({actionStatus:"渠道支付事实已收到，等待服务端入账。"});
      else if(result.simulation)this.setData({actionStatus:"隔离预支付意图已建立。此环境不会拉起真实微信付款或扣款。"});
      else if(result.requestPayment){try{await wx.requestPayment(result.requestPayment);}
        catch{if(current())this.setData({actionError:"微信付款未确认，请按原单核对。"});}
        if(current()){this.setData({busy:false});void this.recheckPayment();}}
    }catch(error){if(current())this.setData({actionError:errorTitle(error,"支付意图暂未建立，请核对原单后重试。")});}
    finally{if(current())this.setData({busy:false});}},
  async recheckPayment(){const order=this.data.order;
    if(this.data.busy||!order||order.status!=="pending_payment"||!this.data.isolatedPayment)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,id=order.id;
    const current=()=>this.current(epoch,token)&&this.data.order?.id===id;
    this.setData({busy:true,actionError:""});
    try{const result=await request<{state:string}>({path:`/v1/me/orders/${id}/payment-intent`});
      if(!current())return;
      this.setData({actionStatus:result.state==="verified_pending"?"渠道事实已收到，待服务端入账。":
        result.state==="paid"?"支付已由服务端核验。":result.state==="notpay"?"渠道仍未确认付款。":"原单状态待确认，请稍后重查。"});
      if(result.state==="paid")void this.load();
    }catch(error){if(current())this.setData({actionError:errorTitle(error,"原单暂时无法核对，请稍后重试。")});}
    finally{if(current())this.setData({busy:false});}},
  async cancel(){const order=this.data.order;if(this.data.busy||order?.status!=="pending_payment"||
      order.transactionSourceKind==="verified_commerce"&&!this.data.isolatedPayment)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,id=order.id,version=order.version;
    const current=()=>this.current(epoch,token)&&this.data.order?.id===id&&this.data.order.version===version;
    const answer=await wx.showModal({title:"取消待支付订单？",
      content:this.data.isolatedPayment?"系统会先按原商户订单号查询并关闭测试渠道订单；未知支付状态不会释放库存。":"取消后将释放本单预留库存，订单记录仍保留。",
      confirmText:"确认取消",confirmColor:"#8d3150"}).catch(()=>({confirm:false}));if(!answer.confirm||!current())return;
    const cancelKey=this.data.cancelKey||clientOperationKey("order-cancel");this.setData({busy:true,error:"",actionError:"",cancelKey});
    try{const updated=this.data.isolatedPayment?await request<CommerceOrder<MemberOrderAddress>>({
      path:`/v1/me/orders/${id}/cancel-verified`,method:"POST",idempotencyKey:cancelKey,data:{expectedVersion:version,reason:"用户确认取消待支付订单"}})
      :await cancelMyOrder(id,version,"用户确认取消待支付订单",cancelKey);
      if(current())this.setData({order:this.normalize(updated),busy:false,cancelKey:"",actionStatus:"订单已取消，预留库存已释放。"});}
    catch(error){if(current())this.setData({busy:false,actionError:errorTitle(error,"取消未完成，请刷新订单状态后重试。")});}
    finally{if(current())this.setData({busy:false});}},
  back(){if(this.data.busy||this.data.navigating)return;this.setData({navigating:true});wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/orders/index"})});}
});
