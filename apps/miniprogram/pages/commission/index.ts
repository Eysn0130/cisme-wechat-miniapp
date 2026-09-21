import { commerceContextRevision } from "../../services/commerce-command-store";
import { acknowledgeCommerceCommand, executeCommerceCommand, readCommerceRecovery, retryCommerceCommand, type RecoveryView } from "../../services/commerce-command-recovery";
import { cancelPageReads, pageRead } from "../../services/page-requests";
import { cancelRuntimeRead, initialRuntimeView, runtimeActions, runtimeReadOwner, runtimeView, validateRuntime } from "../../services/commerce-runtime";
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
const stateNames:Record<string,string>={requested:"已登记意向，等待周期候选",reserved:"金额已预占",unknown:"渠道结果待核对",
  processing:"渠道处理中",succeeded:"渠道已确认付款",failed:"未付款",cancelled:"已取消",rejected:"未通过"};
const problem=(error:unknown,fallback:string)=>(error as {title?:string})?.title||fallback;
function yuanToCents(value:string){const parts=/^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(value.trim());
  return parts?Number(parts[1])*100+Number((parts[2]??"").padEnd(2,"0")):NaN;}

Page({
  lastSessionToken:"",lastSessionRevision:-1,
  data:{...initialRuntimeView(),recoveryRows:[] as RecoveryView[],recoveryLoading:false,recoveryError:"",coreReady:false,visible:true,readEpoch:0,runtimeEpoch:0,refreshOnShow:false,chromeStyle:currentChromeStyle(),status:null as MemberStatus|null,
    availableLabel:"",pendingLabel:"",heldLabel:"",settledLabel:"",recoveryLabel:"",
    isolatedTransfer:false,isolatedCredit:false,requests:[] as RequestRow[],totalCount:0,nextCursor:null as string|null,
    creditRows:[] as CreditRow[],creditTotal:0,creditCursor:null as string|null,
    creditAvailableCents:0,creditAvailableLabel:"0.00",creditLoading:false,creditMoreLoading:false,
    creditError:"",creditActionError:"",creditActionStatus:"",creditFormVisible:false,
    creditAmount:"",creditRequestKey:"",creditCancelKeys:{} as Record<string,string>,
    loading:true,requestsLoading:false,loadingMore:false,busy:false,error:"",listError:"",actionError:"",actionStatus:"",
    formVisible:false,amount:"",reason:"",requestKey:"",alive:true,epoch:0,navigating:false},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  onShow(){this.data.alive=true;this.data.visible=true;this.setData({navigating:false});
    this.syncSession();
    if(!requireMemberAccess())return;void this.load();},
  syncSession(){const token=getApp<IAppOption>().globalData.sessionToken;
    if(token!==this.lastSessionToken||this.lastSessionRevision!==commerceContextRevision()){this.lastSessionToken=token;this.lastSessionRevision=commerceContextRevision();this.data.epoch+=1;
      this.setData({...initialRuntimeView(),recoveryRows:[],recoveryLoading:false,recoveryError:"",coreReady:false,busy:false,isolatedTransfer:false,isolatedCredit:false,status:null,requests:[],totalCount:0,nextCursor:null,formVisible:false,
        amount:"",reason:"",requestKey:"",actionError:"",actionStatus:"",
        creditRows:[],creditTotal:0,creditCursor:null,creditAvailableCents:0,
        creditAvailableLabel:"0.00",creditAmount:"",creditRequestKey:"",creditCancelKeys:{},
        creditActionError:"",creditActionStatus:"",creditFormVisible:false});}
    },
  confirmationPending:false,
  canAct(){return this.data.visible&&this.data.coreReady&&!this.confirmationPending&&this.lastSessionToken===getApp<IAppOption>().globalData.sessionToken&&this.lastSessionRevision===commerceContextRevision();},
  async confirmOperation(options:WechatMiniprogram.ShowModalOption):Promise<{confirm:boolean;cancel?:boolean}>{
    if(this.confirmationPending)return {confirm:false};this.confirmationPending=true;
    try{return await wx.showModal(options);}catch{return {confirm:false};}finally{this.confirmationPending=false;}
  },
  onUnload(){this.onHide();this.data.alive=false;this.data.epoch+=1;},
  current(epoch:number,token:string){return this.data.alive&&this.data.epoch===epoch&&
    token===getApp<IAppOption>().globalData.sessionToken&&this.lastSessionRevision===commerceContextRevision();},
  readCurrent(epoch:number,token:string,readEpoch:number){return this.data.visible&&this.data.readEpoch===readEpoch&&this.current(epoch,token);},
  onHide(){this.data.visible=false;this.data.readEpoch+=1;this.data.runtimeEpoch+=1;
    this.data.refreshOnShow=true;cancelPageReads(this);cancelRuntimeRead(this);},
  finishAction(epoch:number,token:string){if(!this.current(epoch,token))return;
    this.setData({busy:false});if(this.data.visible&&this.data.refreshOnShow){this.data.refreshOnShow=false;void this.load();}else if(this.data.visible)void this.loadRecovery();},

  recoveryScope(){return {group:"commission" as const};},
  async loadRecovery(){if(!this.data.visible||!this.data.coreReady||this.data.busy)return;
    const epoch=this.data.epoch,readEpoch=this.data.readEpoch,token=getApp<IAppOption>().globalData.sessionToken;
    const current=()=>this.readCurrent(epoch,token,readEpoch);
    this.setData({recoveryLoading:true,recoveryError:""});
    try{const recoveryRows=await readCommerceRecovery(this,this.recoveryScope(),current);if(current())this.setData({recoveryRows,recoveryLoading:false});}
    catch{if(current())this.setData({recoveryLoading:false,recoveryError:"原操作暂时无法核对；请重试核对，不要重新创建重复申请。"});}
  },
  async resolveRecovery(event:WechatMiniprogram.BaseEvent){
    const key=String(event.currentTarget.dataset.key??""),row=this.data.recoveryRows.find(item=>item.key===key);
    if(!row||!this.canAct()||this.data.busy||!row.recorded&&!(row.kind==="settlement"?this.data.isolatedTransfer:this.data.isolatedCredit))return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    const current=()=>this.current(epoch,token)&&this.data.visible&&this.data.coreReady&&(row.recorded||(row.kind==="settlement"?this.data.isolatedTransfer:this.data.isolatedCredit));
    const answer=await this.confirmOperation({title:row.recorded?"确认已核对原操作？":"重试原操作？",content:row.recorded?"原申请已由服务端记录。确认后才可开始新的申请；付款、退款和到账仍分别按权威状态展示。":"只使用最初确认的金额、原因、版本和请求编号，先查询原结果；不会使用后来修改的内容，也不会开启真实资金操作。",confirmText:row.recorded?"已核对":"重试原操作"});
    if(!answer.confirm||!current()||this.data.busy)return;
    this.setData({busy:true,recoveryError:""});
    try{if(row.recorded)await acknowledgeCommerceCommand(key,this.recoveryScope(),current);else await retryCommerceCommand(key,this.recoveryScope(),current);
      if(current())this.setData({actionStatus:"原操作已核对，请查看对应记录；这不代表款项已到账。"});
    }catch(error){if(current())this.setData({recoveryError:(error as {title?:string})?.title||"原操作仍未核实，请稍后重查或联系客服。"});}
    finally{this.finishAction(epoch,token);if(this.current(epoch,token)&&this.data.visible)void this.load();}
  },
  retryRuntime(){if(!this.data.visible||this.data.busy||this.confirmationPending)return;
    if(this.lastSessionToken!==getApp<IAppOption>().globalData.sessionToken){void this.load();return;}
    void this.loadRuntime(this.data.epoch,getApp<IAppOption>().globalData.sessionToken);},
  async load(){
    this.syncSession();
    if(!this.data.visible||this.data.busy){this.data.refreshOnShow=true;return;}
    this.data.refreshOnShow=false;cancelPageReads(this);cancelRuntimeRead(this);
    const epoch=++this.data.epoch,readEpoch=++this.data.readEpoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({coreReady:false,isolatedTransfer:false,isolatedCredit:false,loading:!this.data.status,error:""});
    void this.loadRuntime(epoch,token);
    try{
      const status=await pageRead<MemberStatus>(this,{path:"/v1/me/commercial-membership"});
      if(!this.readCurrent(epoch,token,readEpoch))return;
      const amounts=status?.commission;
      if(typeof status?.eligible!=="boolean"||!["none","active","suspended","expired"].includes(status.membershipState)||!amounts||amounts.currency!=="CNY"||![amounts.availableCents,amounts.pendingCents,amounts.paymentHeldCents,amounts.settledCents,amounts.recoveryCents,amounts.reservedRecoveryCents].every(Number.isSafeInteger))throw new Error("Invalid commission projection");
      this.setData({status,coreReady:true,loading:false,
        availableLabel:centsToYuan(amounts.availableCents),pendingLabel:centsToYuan(amounts.pendingCents),
        heldLabel:centsToYuan(amounts.paymentHeldCents),settledLabel:centsToYuan(amounts.settledCents),
        recoveryLabel:centsToYuan(amounts.recoveryCents+amounts.reservedRecoveryCents)});
      this.applyRuntime();void this.loadRequests(epoch,token);void this.loadCredits(epoch,token);void this.loadRecovery();
    }catch(error){if(this.readCurrent(epoch,token,readEpoch))this.setData({status:[401,403,404].includes((error as {status?:number})?.status??0)?null:this.data.status,coreReady:false,loading:false,error:problem(error,"商业资格与佣金事实暂时无法核对。")});}
  },
  applyRuntime(){const actions=runtimeActions(this.data.runtimeStatus),ready=this.canAct()&&this.data.runtimeState==="ready";
    const isolatedTransfer=ready&&actions.transfer,isolatedCredit=ready&&actions.credit;
    this.setData({isolatedTransfer,isolatedCredit});
  },
  async loadRuntime(epoch:number,token:string){cancelRuntimeRead(this);const attempt=++this.data.runtimeEpoch,readEpoch=this.data.readEpoch;
    this.setData({runtimeState:"loading",runtimeMode:"unknown",runtimeStatus:null,runtimeCopy:"正在核验资金操作状态，佣金事实可先查看。",isolatedTransfer:false,isolatedCredit:false});
    try{const status=validateRuntime(await orderRuntimeStatus(runtimeReadOwner(this)));
      if(!this.readCurrent(epoch,token,readEpoch)||attempt!==this.data.runtimeEpoch)return;
      this.setData(runtimeView(status));this.applyRuntime();
    }catch{if(this.readCurrent(epoch,token,readEpoch)&&attempt===this.data.runtimeEpoch)this.setData({runtimeState:"error",runtimeCopy:"资金操作状态暂时无法核验，转换和结算保持关闭；可单独重试。",isolatedTransfer:false,isolatedCredit:false});}
  },
  async loadRequests(epoch:number,token:string,cursor?:string){
    if(!this.data.visible||!this.data.coreReady)return;
    const readEpoch=this.data.readEpoch;
    if(cursor)this.setData({loadingMore:true,listError:""});
    else this.setData({requestsLoading:true,listError:""});
    try{const page=await pageRead<RequestPage>(this,{path:`/v1/me/commission/settlement-requests?limit=10${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`});
      if(!this.readCurrent(epoch,token,readEpoch)||cursor&&this.data.nextCursor!==cursor)return;
      const seen=new Set(cursor?this.data.requests.map(row=>row.id):[]);
      const rows=page.items.filter(row=>!seen.has(row.id)).map(row=>({...row,
        amountLabel:centsToYuan(row.amountCents),stateLabel:stateNames[row.state]??row.state,
        canConfirm:row.state==="processing"&&row.channelState==="WAIT_USER_CONFIRM",
        createdLabel:new Date(row.createdAt).toLocaleString("zh-CN",{hour12:false})}));
      this.setData({requests:[...(cursor?this.data.requests:[]),...rows],totalCount:page.totalCount,
        nextCursor:page.nextCursor,requestsLoading:false,loadingMore:false});
    }catch(error){if(this.readCurrent(epoch,token,readEpoch))this.setData({requestsLoading:false,loadingMore:false,listError:problem(error,"申请记录暂时无法同步。")});}
  },
  more(){const cursor=this.data.nextCursor;
    if(cursor&&!this.data.loadingMore)void this.loadRequests(this.data.epoch,getApp<IAppOption>().globalData.sessionToken,cursor);},
  retryList(){void this.loadRequests(this.data.epoch,getApp<IAppOption>().globalData.sessionToken);},
  async loadCredits(epoch:number,token:string,cursor?:string){
    if(!this.data.visible||!this.data.coreReady)return;
    const readEpoch=this.data.readEpoch;
    this.setData({creditLoading:!cursor,creditMoreLoading:Boolean(cursor),creditError:""});
    try{const page=await pageRead<CreditPage>(this,{path:`/v1/me/commission/credit-conversions?limit=10${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`});
      if(!this.readCurrent(epoch,token,readEpoch)||cursor&&this.data.creditCursor!==cursor)return;
      const seen=new Set(cursor?this.data.creditRows.map(row=>row.id):[]);
      const rows=page.items.filter(row=>!seen.has(row.id)).map(row=>({...row,
        amountLabel:centsToYuan(row.amountCents),availableLabel:centsToYuan(row.availableCents),
        createdLabel:new Date(row.createdAt).toLocaleString("zh-CN",{hour12:false})}));
      this.setData({creditRows:[...(cursor?this.data.creditRows:[]),...rows],
        creditTotal:page.totalCount,creditCursor:page.nextCursor,creditAvailableCents:page.availableCents,
        creditAvailableLabel:centsToYuan(page.availableCents),creditLoading:false,creditMoreLoading:false});
    }catch(error){if(this.readCurrent(epoch,token,readEpoch))this.setData({creditLoading:false,creditMoreLoading:false,
      creditError:problem(error,"测试购物权益暂时无法核对，请稍后刷新。")});}
  },
  moreCredits(){const cursor=this.data.creditCursor;
    if(cursor&&!this.data.creditMoreLoading)void this.loadCredits(this.data.epoch,getApp<IAppOption>().globalData.sessionToken,cursor);},
  retryCredits(){void this.loadCredits(this.data.epoch,getApp<IAppOption>().globalData.sessionToken);},
  showCreditForm(){if(this.data.isolatedCredit&&this.data.status?.commission.availableCents&&
    !this.data.busy)this.setData({creditFormVisible:true,creditActionError:"",creditActionStatus:""});},
  closeCreditForm(){if(!this.data.busy)this.setData({creditFormVisible:false,creditActionError:""});},
  editCreditAmount(event:WechatMiniprogram.Input){if(this.data.busy)return;this.setData({creditAmount:event.detail.value,creditRequestKey:""});},
  async submitCredit(){const status=this.data.status;
    if(!this.canAct()||!this.data.isolatedCredit||!this.data.creditFormVisible||!status||this.data.busy)return;
    const amountCents=yuanToCents(this.data.creditAmount);
    if(!Number.isSafeInteger(amountCents)||amountCents<1||amountCents>status.commission.availableCents){
      this.setData({creditActionError:`金额须不超过已释放可用佣金 ¥${this.data.availableLabel}。`});return;}
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,
      key=this.data.creditRequestKey||clientOperationKey("credit-convert");
    const current=()=>this.current(epoch,token)&&this.data.isolatedCredit;
    const answer=await this.confirmOperation({title:"确认隔离测试转换？",
      content:`自愿将 ¥${centsToYuan(amountCents)} 已释放佣金按 1:1 转为仅本机可测试购物权益。无赠额、不提现、不转让；零扣缴仅为合成测试口径，不代表真实免税。使用或冻结后不可直接撤销。`,
      confirmText:"确认测试"}).catch(()=>({confirm:false}));
    if(!answer.confirm||!current()||!this.canAct()||this.data.busy)return;
    this.setData({busy:true,creditRequestKey:key,creditActionError:"",creditActionStatus:""});
    try{await executeCommerceCommand({kind:"credit",key,payload:{amountCents,confirmed:true,taxPolicyVersion:"isolated-synthetic-zero-withholding-v1"}},()=>current()&&this.data.visible);
      if(current()){this.setData({busy:false,creditFormVisible:false,creditAmount:"",creditRequestKey:"",
        creditActionStatus:"隔离测试转换已记录，原现金来源和权益分录可分别核对。"});void this.load();}}
    catch(error){if(current())this.setData({creditActionError:problem(error,"转换结果不确定；重试会使用同一请求编号。")});}
    finally{this.finishAction(epoch,token);}
  },
  async cancelCredit(event:WechatMiniprogram.BaseEvent){
    const id=String(event.currentTarget.dataset.id??""),row=this.data.creditRows.find(item=>item.id===id);
    if(!this.canAct()||!this.data.isolatedCredit||this.data.busy||!row||!row.cancellable)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,
      key=this.data.creditCancelKeys[id]||clientOperationKey("credit-cancel");
    const current=()=>this.current(epoch,token)&&this.data.isolatedCredit;
    const answer=await this.confirmOperation({title:"撤销未使用的测试权益？",
      content:`仅当 ¥${row.amountLabel} 全部未使用、未预占、未冻结且原销售无争议，才会追加分录恢复原佣金来源。`,
      confirmText:"确认撤销"}).catch(()=>({confirm:false}));
    if(!answer.confirm||!current()||!this.canAct()||this.data.busy)return;
    this.setData({busy:true,creditCancelKeys:{...this.data.creditCancelKeys,[id]:key},
      creditActionError:"",creditActionStatus:""});
    try{await executeCommerceCommand({kind:"credit-cancel",objectId:id,key,payload:{}},()=>current()&&this.data.visible);
      if(current()){const keys={...this.data.creditCancelKeys};delete keys[id];
        this.setData({busy:false,creditCancelKeys:keys,creditActionStatus:"未使用的测试权益已撤销，原佣金来源已恢复。"});void this.load();}}
    catch(error){if(current())this.setData({creditActionError:problem(error,"撤销结果暂不确定，可沿原请求编号重试。")});}
    finally{this.finishAction(epoch,token);}
  },
  async confirmReceipt(event:WechatMiniprogram.BaseEvent){
    const id=event.currentTarget.dataset.id as string;
    if(!this.canAct()||this.data.busy||!this.data.isolatedTransfer||!this.data.requests.some(row=>row.id===id&&row.canConfirm))return;
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
      if(!this.data.visible){this.setData({actionStatus:"请返回此页后核对原申请，再主动打开确认收款。"});return;}
      launched=true;
      wx.requestMerchantTransfer({mchId:confirmation.mchId,appId:confirmation.appId,
        package:confirmation.package,
        success:()=>{if(this.current(epoch,token))this.setData({actionStatus:"已打开收款确认页；是否到账仍以渠道查单为准。"});},
        fail:()=>{if(this.current(epoch,token))this.setData({actionError:"确认页未完成或已取消，可刷新原单后重试。"});},
        complete:()=>{if(this.current(epoch,token)){this.finishAction(epoch,token);void this.loadRequests(epoch,token);}}});
    }catch(error){launched=false;if(this.current(epoch,token))this.setData({actionError:problem(error,"原转账单暂不可确认，请稍后刷新。")});}
    finally{if(!launched)this.finishAction(epoch,token);}
  },
  showForm(){if(this.data.isolatedTransfer&&this.data.status?.commission.availableCents&&
      !this.data.busy)this.setData({formVisible:true,actionError:"",actionStatus:""});},
  closeForm(){if(!this.data.busy)this.setData({formVisible:false,actionError:""});},
  editAmount(event:WechatMiniprogram.Input){if(this.data.busy)return;this.setData({amount:event.detail.value,requestKey:""});},
  editReason(event:WechatMiniprogram.Input){if(this.data.busy)return;this.setData({reason:event.detail.value,requestKey:""});},
  async submit(){const status=this.data.status;
    if(!this.canAct()||this.data.busy||!this.data.formVisible||!this.data.isolatedTransfer||!status)return;
    const amountCents=yuanToCents(this.data.amount),why=this.data.reason.trim();
    if(!Number.isSafeInteger(amountCents)||amountCents<1||amountCents>status.commission.availableCents){
      this.setData({actionError:`金额须为正数，且不超过当前可用 ¥${this.data.availableLabel}。`});return;}
    if(Array.from(why).length<4||Array.from(why).length>300){this.setData({actionError:"请填写 4 至 300 字的申请依据。"});return;}
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,
      key=this.data.requestKey||clientOperationKey("settlement-request");
    const current=()=>this.current(epoch,token)&&this.data.isolatedTransfer;
    const answer=await this.confirmOperation({title:"登记隔离结算意向？",
      content:`意向 ¥${centsToYuan(amountCents)}。它不会直接预占或发款；公司每月 15 日起准备上一月候选，税前未满 ¥100 结转，须由另一人按来源与合成税务规则复核。本环境不转出真实资金。`,
      confirmText:"登记意向"});
    if(!answer.confirm||!current()||!this.canAct()||this.data.busy)return;
    this.setData({busy:true,requestKey:key,actionError:"",actionStatus:""});
    try{await executeCommerceCommand({kind:"settlement",key,payload:{amountCents,reason:why}},()=>current()&&this.data.visible);
      if(current()){this.setData({busy:false,formVisible:false,amount:"",reason:"",requestKey:"",
        actionStatus:"结算意向已记录；它不会绕开周期候选和独立复核。"});void this.loadRequests(epoch,token);}}
    catch(error){if(current())this.setData({busy:false,
      actionError:problem(error,"申请结果暂时无法确认；再次提交会使用同一请求编号。")});}
    finally{this.finishAction(epoch,token);}
  },
  back(){if(this.data.navigating||this.data.busy)return;this.setData({navigating:true});
    wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});}
});
