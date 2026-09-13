import { request, requireMemberAccess } from "../../services/api";
import { centsToYuan } from "../../services/commerce";
import { currentChromeStyle } from "../../services/layout";
import { clientOperationKey, orderRuntimeStatus } from "../../services/orders";

type Buckets={pendingCents:number;availableCents:number;paymentHeldCents:number;settledCents:number;
  recoveryCents:number;reservedRecoveryCents:number;netEarnedCents:number;currency:"CNY"};
type MemberStatus={eligible:boolean;membershipState:string;expiresAt:string|null;directReferralCount:number;
  verifiedOrderCount:number;commission:Buckets;settlementAvailable:boolean};
type RequestRow={id:string;amountCents:number;state:string;channelState:string|null;createdAt:string;
  amountLabel?:string;stateLabel?:string;createdLabel?:string;canConfirm?:boolean};
type RequestPage={items:RequestRow[];totalCount:number;nextCursor:string|null};
type TransferConfirmation={requestId:string;state:"WAIT_USER_CONFIRM";appId:string;mchId:string;
  package:string;simulation:true};
type CreditRow={id:string;amountCents:number;availableCents:number;cancellable:boolean;state:"available"|"cancelled";
  createdAt:string;amountLabel?:string;availableLabel?:string;createdLabel?:string};
type CreditPage={items:CreditRow[];totalCount:number;availableCents:number;nextCursor:string|null;
  redemptionStatus:"ISOLATED_TEST_ONLY"};
const stateNames:Record<string,string>={requested:"待独立复核",reserved:"金额已预占",unknown:"渠道结果待核对",
  processing:"渠道处理中",succeeded:"渠道已确认付款",failed:"未付款",cancelled:"已取消",rejected:"未通过"};
const problem=(error:unknown,fallback:string)=>(error as {title?:string})?.title||fallback;
function yuanToCents(value:string){const parts=/^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(value.trim());
  return parts?Number(parts[1])*100+Number((parts[2]??"").padEnd(2,"0")):NaN;}

Page({
  lastSessionToken:"",
  data:{chromeStyle:currentChromeStyle(),status:null as MemberStatus|null,
    availableLabel:"",pendingLabel:"",heldLabel:"",settledLabel:"",recoveryLabel:"",
    isolatedTransfer:false,isolatedCredit:false,requests:[] as RequestRow[],totalCount:0,nextCursor:null as string|null,
    creditRows:[] as CreditRow[],creditTotal:0,creditCursor:null as string|null,
    creditAvailableCents:0,creditAvailableLabel:"0.00",creditLoading:false,creditMoreLoading:false,
    creditError:"",creditActionError:"",creditActionStatus:"",creditFormVisible:false,
    creditAmount:"",creditRequestKey:"",creditCancelKeys:{} as Record<string,string>,
    loading:true,loadingMore:false,busy:false,error:"",listError:"",actionError:"",actionStatus:"",
    formVisible:false,amount:"",reason:"",requestKey:"",alive:true,epoch:0,navigating:false},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  onShow(){this.data.alive=true;this.setData({navigating:false});
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(token!==this.lastSessionToken){this.lastSessionToken=token;this.data.epoch+=1;
      this.setData({status:null,requests:[],totalCount:0,nextCursor:null,formVisible:false,
        amount:"",reason:"",requestKey:"",actionError:"",actionStatus:"",
        creditRows:[],creditTotal:0,creditCursor:null,creditAvailableCents:0,
        creditAvailableLabel:"0.00",creditAmount:"",creditRequestKey:"",creditCancelKeys:{},
        creditActionError:"",creditActionStatus:"",creditFormVisible:false});}
    if(!requireMemberAccess())return;void this.load();},
  onUnload(){this.data.alive=false;this.data.epoch+=1;},
  current(epoch:number,token:string){return this.data.alive&&this.data.epoch===epoch&&
    token===getApp<IAppOption>().globalData.sessionToken;},
  async load(){
    const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({status:null,requests:[],totalCount:0,nextCursor:null,isolatedTransfer:false,isolatedCredit:false,
      loading:true,error:"",listError:""});
    try{
      const [status,runtime]=await Promise.all([
        request<MemberStatus>({path:"/v1/me/commercial-membership"}),orderRuntimeStatus().catch(()=>null)]);
      if(!this.current(epoch,token))return;
      const isolatedTransfer=runtime?.scope==="verified_isolated_test"&&runtime.isolatedTransferAvailable;
      const isolatedCredit=runtime?.isolatedCreditCheckoutAvailable===true;
      this.setData({status,isolatedTransfer,isolatedCredit,loading:false,
        availableLabel:centsToYuan(status.commission.availableCents),
        pendingLabel:centsToYuan(status.commission.pendingCents),
        heldLabel:centsToYuan(status.commission.paymentHeldCents),
        settledLabel:centsToYuan(status.commission.settledCents),
        recoveryLabel:centsToYuan(status.commission.recoveryCents+status.commission.reservedRecoveryCents)});
      if(isolatedTransfer)void this.loadRequests(epoch,token);
      if(isolatedCredit)void this.loadCredits(epoch,token);
    }catch(error){if(this.current(epoch,token))this.setData({loading:false,error:problem(error,"商业资格与佣金事实暂时无法核对。")});}
  },
  async loadRequests(epoch:number,token:string,cursor?:string){
    if(!this.data.isolatedTransfer)return;
    if(cursor)this.setData({loadingMore:true,listError:""});
    else this.setData({requests:[],totalCount:0,nextCursor:null,listError:""});
    try{const page=await request<RequestPage>({path:`/v1/me/commission/settlement-requests?limit=10${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`});
      if(!this.current(epoch,token)||cursor&&this.data.nextCursor!==cursor)return;
      const seen=new Set(cursor?this.data.requests.map(row=>row.id):[]);
      const rows=page.items.filter(row=>!seen.has(row.id)).map(row=>({...row,
        amountLabel:centsToYuan(row.amountCents),stateLabel:stateNames[row.state]??row.state,
        canConfirm:row.state==="processing"&&row.channelState==="WAIT_USER_CONFIRM",
        createdLabel:new Date(row.createdAt).toLocaleString("zh-CN",{hour12:false})}));
      this.setData({requests:[...(cursor?this.data.requests:[]),...rows],totalCount:page.totalCount,
        nextCursor:page.nextCursor,loadingMore:false});
    }catch(error){if(this.current(epoch,token))this.setData({loadingMore:false,listError:problem(error,"申请记录暂时无法同步。")});}
  },
  more(){const cursor=this.data.nextCursor;
    if(cursor&&!this.data.loadingMore)void this.loadRequests(this.data.epoch,getApp<IAppOption>().globalData.sessionToken,cursor);},
  retryList(){void this.loadRequests(this.data.epoch,getApp<IAppOption>().globalData.sessionToken);},
  async loadCredits(epoch:number,token:string,cursor?:string){
    if(!this.data.isolatedCredit)return;
    this.setData({creditLoading:!cursor,creditMoreLoading:Boolean(cursor),creditError:""});
    try{const page=await request<CreditPage>({path:`/v1/me/commission/credit-conversions?limit=10${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`});
      if(!this.current(epoch,token)||cursor&&this.data.creditCursor!==cursor)return;
      const seen=new Set(cursor?this.data.creditRows.map(row=>row.id):[]);
      const rows=page.items.filter(row=>!seen.has(row.id)).map(row=>({...row,
        amountLabel:centsToYuan(row.amountCents),availableLabel:centsToYuan(row.availableCents),
        createdLabel:new Date(row.createdAt).toLocaleString("zh-CN",{hour12:false})}));
      this.setData({creditRows:[...(cursor?this.data.creditRows:[]),...rows],
        creditTotal:page.totalCount,creditCursor:page.nextCursor,creditAvailableCents:page.availableCents,
        creditAvailableLabel:centsToYuan(page.availableCents),creditLoading:false,creditMoreLoading:false});
    }catch(error){if(this.current(epoch,token))this.setData({creditLoading:false,creditMoreLoading:false,
      creditError:problem(error,"测试购物权益暂时无法核对，请稍后刷新。")});}
  },
  moreCredits(){const cursor=this.data.creditCursor;
    if(cursor&&!this.data.creditMoreLoading)void this.loadCredits(this.data.epoch,getApp<IAppOption>().globalData.sessionToken,cursor);},
  retryCredits(){void this.loadCredits(this.data.epoch,getApp<IAppOption>().globalData.sessionToken);},
  showCreditForm(){if(this.data.isolatedCredit&&this.data.status?.commission.availableCents&&
    !this.data.busy)this.setData({creditFormVisible:true,creditActionError:"",creditActionStatus:""});},
  closeCreditForm(){if(!this.data.busy)this.setData({creditFormVisible:false,creditActionError:""});},
  editCreditAmount(event:WechatMiniprogram.Input){this.setData({creditAmount:event.detail.value,creditRequestKey:""});},
  async submitCredit(){const status=this.data.status;
    if(!this.data.isolatedCredit||!this.data.creditFormVisible||!status||this.data.busy)return;
    const amountCents=yuanToCents(this.data.creditAmount);
    if(!Number.isSafeInteger(amountCents)||amountCents<1||amountCents>status.commission.availableCents){
      this.setData({creditActionError:`金额须不超过已释放可用佣金 ¥${this.data.availableLabel}。`});return;}
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,
      key=this.data.creditRequestKey||clientOperationKey("credit-convert");
    const current=()=>this.current(epoch,token)&&this.data.isolatedCredit;
    const answer=await wx.showModal({title:"确认隔离测试转换？",
      content:`自愿将 ¥${centsToYuan(amountCents)} 已释放佣金按 1:1 转为仅本机可测试购物权益。无赠额、不提现、不转让；零扣缴仅为合成测试口径，不代表真实免税。使用或冻结后不可直接撤销。`,
      confirmText:"确认测试"}).catch(()=>({confirm:false}));
    if(!answer.confirm||!current())return;
    this.setData({busy:true,creditRequestKey:key,creditActionError:"",creditActionStatus:""});
    try{await request({path:"/v1/me/commission/credit-conversions",method:"POST",idempotencyKey:key,
      data:{amountCents,confirmed:true,taxPolicyVersion:"isolated-synthetic-zero-withholding-v1"}});
      if(current()){this.setData({busy:false,creditFormVisible:false,creditAmount:"",creditRequestKey:"",
        creditActionStatus:"隔离测试转换已记录，原现金来源和权益分录可分别核对。"});void this.load();}}
    catch(error){if(current())this.setData({creditActionError:problem(error,"转换结果不确定；重试会使用同一请求编号。")});}
    finally{if(current())this.setData({busy:false});}
  },
  async cancelCredit(event:WechatMiniprogram.BaseEvent){
    const id=String(event.currentTarget.dataset.id??""),row=this.data.creditRows.find(item=>item.id===id);
    if(!this.data.isolatedCredit||this.data.busy||!row||!row.cancellable)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,
      key=this.data.creditCancelKeys[id]||clientOperationKey("credit-cancel");
    const current=()=>this.current(epoch,token)&&this.data.isolatedCredit;
    const answer=await wx.showModal({title:"撤销未使用的测试权益？",
      content:`仅当 ¥${row.amountLabel} 全部未使用、未预占、未冻结且原销售无争议，才会追加分录恢复原佣金来源。`,
      confirmText:"确认撤销"}).catch(()=>({confirm:false}));
    if(!answer.confirm||!current())return;
    this.setData({busy:true,creditCancelKeys:{...this.data.creditCancelKeys,[id]:key},
      creditActionError:"",creditActionStatus:""});
    try{await request({path:`/v1/me/commission/credit-conversions/${id}/cancel`,method:"POST",idempotencyKey:key});
      if(current()){const keys={...this.data.creditCancelKeys};delete keys[id];
        this.setData({busy:false,creditCancelKeys:keys,creditActionStatus:"未使用的测试权益已撤销，原佣金来源已恢复。"});void this.load();}}
    catch(error){if(current())this.setData({creditActionError:problem(error,"撤销结果暂不确定，可沿原请求编号重试。")});}
    finally{if(current())this.setData({busy:false});}
  },
  async confirmReceipt(event:WechatMiniprogram.BaseEvent){
    const id=event.currentTarget.dataset.id as string;
    if(this.data.busy||!this.data.isolatedTransfer||!this.data.requests.some(row=>row.id===id&&row.canConfirm))return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    let launched=false;
    this.setData({busy:true,actionError:"",actionStatus:""});
    try{
      if(!wx.canIUse("requestMerchantTransfer")){
        this.setData({actionError:"当前微信版本不支持确认收款，请更新微信后再试。"});return;
      }
      const confirmation=await request<TransferConfirmation>({path:`/v1/me/commission/settlement-requests/${id}/confirmation`});
      if(!this.current(epoch,token))return;
      if(confirmation.state!=="WAIT_USER_CONFIRM"||confirmation.appId!==wx.getAccountInfoSync().miniProgram.appId){
        this.setData({actionError:"收款确认的原单或小程序身份不匹配，请刷新后联系管理员核对。"});return;
      }
      launched=true;
      wx.requestMerchantTransfer({mchId:confirmation.mchId,appId:confirmation.appId,
        package:confirmation.package,
        success:()=>{if(this.current(epoch,token))this.setData({actionStatus:"已打开收款确认页；是否到账仍以渠道查单为准。"});},
        fail:()=>{if(this.current(epoch,token))this.setData({actionError:"确认页未完成或已取消，可刷新原单后重试。"});},
        complete:()=>{if(this.current(epoch,token)){this.setData({busy:false});void this.loadRequests(epoch,token);}}});
    }catch(error){launched=false;if(this.current(epoch,token))this.setData({actionError:problem(error,"原转账单暂不可确认，请稍后刷新。")});}
    finally{if(!launched&&this.current(epoch,token))this.setData({busy:false});}
  },
  showForm(){if(this.data.isolatedTransfer&&this.data.status?.commission.availableCents&&
      !this.data.busy)this.setData({formVisible:true,actionError:"",actionStatus:""});},
  closeForm(){if(!this.data.busy)this.setData({formVisible:false,actionError:""});},
  editAmount(event:WechatMiniprogram.Input){this.setData({amount:event.detail.value,requestKey:""});},
  editReason(event:WechatMiniprogram.Input){this.setData({reason:event.detail.value,requestKey:""});},
  async submit(){const status=this.data.status;
    if(this.data.busy||!this.data.formVisible||!this.data.isolatedTransfer||!status)return;
    const amountCents=yuanToCents(this.data.amount),why=this.data.reason.trim();
    if(!Number.isSafeInteger(amountCents)||amountCents<1||amountCents>status.commission.availableCents){
      this.setData({actionError:`金额须为正数，且不超过当前可用 ¥${this.data.availableLabel}。`});return;}
    if(Array.from(why).length<4||Array.from(why).length>300){this.setData({actionError:"请填写 4 至 300 字的申请依据。"});return;}
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,
      key=this.data.requestKey||clientOperationKey("settlement-request");
    const current=()=>this.current(epoch,token)&&this.data.isolatedTransfer;
    const answer=await wx.showModal({title:"提交隔离结算申请？",
      content:`申请 ¥${centsToYuan(amountCents)}。独立复核后才预占，渠道确认成功前均不计为已付款。本环境不转出真实资金。`,
      confirmText:"提交申请"});
    if(!answer.confirm||!current())return;
    this.setData({busy:true,requestKey:key,actionError:"",actionStatus:""});
    try{await request({path:"/v1/me/commission/settlement-requests",method:"POST",idempotencyKey:key,
      data:{amountCents,reason:why}});
      if(current()){this.setData({busy:false,formVisible:false,amount:"",reason:"",requestKey:"",
        actionStatus:"申请已记录，请在下方查看复核及渠道状态。"});void this.loadRequests(epoch,token);}}
    catch(error){if(current())this.setData({busy:false,
      actionError:problem(error,"申请结果暂时无法确认；再次提交会使用同一请求编号。")});}
    finally{if(current())this.setData({busy:false});}
  },
  back(){if(this.data.navigating||this.data.busy)return;this.setData({navigating:true});
    wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});}
});
