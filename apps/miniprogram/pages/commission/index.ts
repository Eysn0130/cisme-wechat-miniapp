import { request, requireMemberAccess } from "../../services/api";
import { centsToYuan } from "../../services/commerce";
import { currentChromeStyle } from "../../services/layout";
import { clientOperationKey, orderRuntimeStatus } from "../../services/orders";

type Buckets={pendingCents:number;availableCents:number;paymentHeldCents:number;settledCents:number;
  recoveryCents:number;reservedRecoveryCents:number;netEarnedCents:number;currency:"CNY"};
type MemberStatus={eligible:boolean;membershipState:string;expiresAt:string|null;directReferralCount:number;
  verifiedOrderCount:number;commission:Buckets;settlementAvailable:boolean};
type RequestRow={id:string;amountCents:number;state:string;channelState:string|null;createdAt:string;
  amountLabel?:string;stateLabel?:string;createdLabel?:string};
type RequestPage={items:RequestRow[];totalCount:number;nextCursor:string|null};
const stateNames:Record<string,string>={requested:"待独立复核",reserved:"金额已预占",unknown:"渠道结果待核对",
  processing:"渠道处理中",succeeded:"渠道已确认付款",failed:"未付款",cancelled:"已取消",rejected:"未通过"};
const problem=(error:unknown,fallback:string)=>(error as {title?:string})?.title||fallback;
function yuanToCents(value:string){const parts=/^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(value.trim());
  return parts?Number(parts[1])*100+Number((parts[2]??"").padEnd(2,"0")):NaN;}

Page({
  lastSessionToken:"",
  data:{chromeStyle:currentChromeStyle(),status:null as MemberStatus|null,
    availableLabel:"",pendingLabel:"",heldLabel:"",settledLabel:"",recoveryLabel:"",
    isolatedTransfer:false,requests:[] as RequestRow[],totalCount:0,nextCursor:null as string|null,
    loading:true,loadingMore:false,busy:false,error:"",listError:"",actionError:"",actionStatus:"",
    formVisible:false,amount:"",reason:"",requestKey:"",alive:true,epoch:0,navigating:false},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  onShow(){this.data.alive=true;this.setData({navigating:false});
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(token!==this.lastSessionToken){this.lastSessionToken=token;this.data.epoch+=1;
      this.setData({status:null,requests:[],totalCount:0,nextCursor:null,formVisible:false,
        amount:"",reason:"",requestKey:"",actionError:"",actionStatus:""});}
    if(!requireMemberAccess())return;void this.load();},
  onUnload(){this.data.alive=false;this.data.epoch+=1;},
  current(epoch:number,token:string){return this.data.alive&&this.data.epoch===epoch&&
    token===getApp<IAppOption>().globalData.sessionToken;},
  async load(){
    const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({status:null,requests:[],totalCount:0,nextCursor:null,isolatedTransfer:false,
      loading:true,error:"",listError:""});
    try{
      const [status,runtime]=await Promise.all([
        request<MemberStatus>({path:"/v1/me/commercial-membership"}),orderRuntimeStatus().catch(()=>null)]);
      if(!this.current(epoch,token))return;
      const isolatedTransfer=runtime?.scope==="verified_isolated_test"&&runtime.isolatedTransferAvailable;
      this.setData({status,isolatedTransfer,loading:false,
        availableLabel:centsToYuan(status.commission.availableCents),
        pendingLabel:centsToYuan(status.commission.pendingCents),
        heldLabel:centsToYuan(status.commission.paymentHeldCents),
        settledLabel:centsToYuan(status.commission.settledCents),
        recoveryLabel:centsToYuan(status.commission.recoveryCents+status.commission.reservedRecoveryCents)});
      if(isolatedTransfer)void this.loadRequests(epoch,token);
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
        createdLabel:new Date(row.createdAt).toLocaleString("zh-CN",{hour12:false})}));
      this.setData({requests:[...(cursor?this.data.requests:[]),...rows],totalCount:page.totalCount,
        nextCursor:page.nextCursor,loadingMore:false});
    }catch(error){if(this.current(epoch,token))this.setData({loadingMore:false,listError:problem(error,"申请记录暂时无法同步。")});}
  },
  more(){const cursor=this.data.nextCursor;
    if(cursor&&!this.data.loadingMore)void this.loadRequests(this.data.epoch,getApp<IAppOption>().globalData.sessionToken,cursor);},
  retryList(){void this.loadRequests(this.data.epoch,getApp<IAppOption>().globalData.sessionToken);},
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
