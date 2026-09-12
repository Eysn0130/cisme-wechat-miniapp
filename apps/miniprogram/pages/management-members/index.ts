import { request } from "../../services/api";
import { authorityProjection, hasCapability, requireCapability } from "../../services/authority";
import { currentChromeStyle } from "../../services/layout";

type MemberRow={id:string;displayName:string;accountStatus:string;membershipState:string;commercialEligible:boolean;expiresAt:string|null;referralCode:string|null;directReferralCount?:number};
type RateProposal={id:string;memberId:string|null;displayName:string;action:"override"|"inherit";basisPoints:number|null;effectiveAt:string;createdBy:string;reason:string};
type GlobalRate={basisPoints:number|null;effectiveAt:string|null;serverTime:string;suggestedEffectiveAt:string;policyKind:string;paymentAvailable:boolean};
type RateForm={percent:string;date:string;time:string;reason:string};
const rateDateParts=(value:string)=>{const date=new Date(value),pad=(n:number)=>String(n).padStart(2,"0");
  return {date:`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`,time:`${pad(date.getHours())}:${pad(date.getMinutes())}`};};
const dateLabel=(value:string|null)=>value?new Date(value).toLocaleDateString("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit"}):"未设置";

Page({
  globalRateCommand:null as null|{key:string;basisPoints:number;effectiveAt:string;reason:string},
  data:{chromeStyle:currentChromeStyle(),q:"",appliedQuery:"",filter:"all",filters:[{id:"all",label:"全部"},{id:"members",label:"会员"},{id:"ordinary",label:"普通用户"}],summary:{all:0,members:0,ordinary:0},items:[] as Array<MemberRow&{initial:string}>,pending:[] as Array<RateProposal&{rateLabel:string}>,canApprove:false,canReadCommission:false,
    canManageRate:false,globalRate:null as GlobalRate|null,globalRateLabel:"",globalRateError:"",globalRateStatus:"",globalRateFormVisible:false,
    globalRateForm:{percent:"",date:"",time:"",reason:""} as RateForm,globalRateBusy:false,pendingVisible:false,
    matchingTotal:0,loadedCount:0,nextCursor:null as string|null,loadingMore:false,moreError:"",
    pendingTotal:0,pendingCursor:null as string|null,pendingLoadingMore:false,pendingMoreError:"",
    loading:true,reviewBusy:false,navigating:false,attempt:0,alive:true,error:"",reviewError:""},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  onShow(){this.data.alive=true;this.globalRateCommand=null;this.setData({navigating:false,items:[],pending:[],canApprove:false,canReadCommission:false,canManageRate:false,
    globalRate:null,globalRateLabel:"",globalRateError:"",globalRateFormVisible:false,globalRateBusy:false,pendingVisible:false,
    summary:{all:0,members:0,ordinary:0},matchingTotal:0,loadedCount:0,nextCursor:null,loadingMore:false,moreError:"",
    pendingTotal:0,pendingCursor:null,pendingLoadingMore:false,pendingMoreError:"",loading:true,error:""});void this.load();},
  onUnload(){this.data.alive=false;this.globalRateCommand=null;this.data.attempt+=1;},
  editSearch(event:WechatMiniprogram.Input){this.setData({q:event.detail.value});},
  search(){void this.load();},
  selectFilter(event:WechatMiniprogram.TouchEvent){const filter=String(event.currentTarget.dataset.filter);if(!["all","members","ordinary"].includes(filter))return;this.setData({filter});void this.load();},
  onReachBottom(){void this.loadMore();},
  async load(){
    const attempt=++this.data.attempt,token=getApp<IAppOption>().globalData.sessionToken;
    const q=this.data.q.trim(),filter=this.data.filter;
    this.setData({items:[],pending:[],canApprove:false,canReadCommission:false,canManageRate:false,reviewBusy:false,
      globalRate:null,globalRateLabel:"",globalRateError:"",globalRateStatus:"",globalRateFormVisible:false,
      summary:{all:0,members:0,ordinary:0},matchingTotal:0,loadedCount:0,nextCursor:null,loadingMore:false,moreError:"",
      pendingTotal:0,pendingCursor:null,pendingLoadingMore:false,pendingMoreError:"",loading:true,error:""});
    const projection=await requireCapability("member.profile.read");
    if(!projection||!this.data.alive||attempt!==this.data.attempt||token!==getApp<IAppOption>().globalData.sessionToken)return;
    const canApprove=hasCapability(projection,"commission.rate.approve"),canReadCommission=hasCapability(projection,"commission.read"),
      canManageRate=hasCapability(projection,"commission.rate.manage");
    this.setData({loading:true,error:"",canApprove,canReadCommission,canManageRate});
    try{
      const query=`?q=${encodeURIComponent(q)}&filter=${filter}&limit=30`;
      const members=await request<{items:MemberRow[];summary:{all:number;members:number;ordinary:number};matchingTotal:number;loadedCount:number;nextCursor:string|null}>({path:`/v1/management/members${query}`});
      if(!this.data.alive||this.data.attempt!==attempt||token!==getApp<IAppOption>().globalData.sessionToken)return;
      this.setData({items:members.items.map(row=>({...row,initial:row.displayName?.slice(0,1)||"C",expiresLabel:dateLabel(row.expiresAt)})),summary:members.summary,
        appliedQuery:q,matchingTotal:members.matchingTotal,loadedCount:members.loadedCount,nextCursor:members.nextCursor,
        loading:false});
      if(canApprove)void this.loadPending(attempt,token);
      if(canReadCommission||canManageRate)void this.loadGlobalRate(attempt,token);
    }catch(error){if(this.data.alive&&this.data.attempt===attempt&&token===getApp<IAppOption>().globalData.sessionToken)
      this.setData({loading:false,error:(error as {title?:string}).title||"成员资料暂未加载，请重试。"});}
  },
  async loadPending(attempt:number,token:string){try{const rates=await request<{items:RateProposal[];matchingTotal:number;nextCursor:string|null}>({path:"/v1/management/commission-rates/pending?limit=30"});
    if(!this.data.alive||this.data.attempt!==attempt||token!==getApp<IAppOption>().globalData.sessionToken)return;
    this.setData({pending:rates.items.map(row=>({...row,rateLabel:row.action==="inherit"?"恢复继承全局":`${((row.basisPoints??0)/100).toFixed(2)}%`})),
      pendingTotal:rates.matchingTotal,pendingCursor:rates.nextCursor});
  }catch(error){if(this.data.alive&&this.data.attempt===attempt&&token===getApp<IAppOption>().globalData.sessionToken)
    this.setData({pendingMoreError:(error as {title?:string}).title||"待复核费率暂未加载。"});}},
  async loadGlobalRate(attempt:number,token:string){try{const rate=await request<GlobalRate>({path:"/v1/management/commission-rates/current"});
    if(!this.data.alive||this.data.attempt!==attempt||token!==getApp<IAppOption>().globalData.sessionToken)return;
    this.setData({globalRate:rate,globalRateLabel:rate.basisPoints==null?"未配置":`${(rate.basisPoints/100).toFixed(2)}%`,globalRateError:""});
  }catch(error){if(this.data.alive&&this.data.attempt===attempt&&token===getApp<IAppOption>().globalData.sessionToken)
    this.setData({globalRateError:(error as {title?:string}).title||"全局费率暂未加载。"});}},
  togglePending(){this.setData({pendingVisible:!this.data.pendingVisible});},
  async loadMore(){
    const cursor=this.data.nextCursor;if(!cursor||this.data.loading||this.data.loadingMore||this.data.error)return;
    const attempt=this.data.attempt,token=getApp<IAppOption>().globalData.sessionToken,q=this.data.appliedQuery,filter=this.data.filter;
    this.setData({loadingMore:true,moreError:""});
    try{const query=`?q=${encodeURIComponent(q)}&filter=${filter}&limit=30&cursor=${encodeURIComponent(cursor)}`;
      const page=await request<{items:MemberRow[];matchingTotal:number;nextCursor:string|null}>({path:`/v1/management/members${query}`});
      if(!this.data.alive||attempt!==this.data.attempt||token!==getApp<IAppOption>().globalData.sessionToken||
        q!==this.data.appliedQuery||filter!==this.data.filter||cursor!==this.data.nextCursor)return;
      const seen=new Set(this.data.items.map(row=>row.id));
      const appended=page.items.filter(row=>!seen.has(row.id)).map(row=>({...row,initial:row.displayName?.slice(0,1)||"C",expiresLabel:dateLabel(row.expiresAt)}));
      const items=[...this.data.items,...appended];
      this.setData({items,loadedCount:items.length,matchingTotal:page.matchingTotal,nextCursor:page.nextCursor,loadingMore:false});
    }catch(error){if(this.data.alive&&attempt===this.data.attempt&&token===getApp<IAppOption>().globalData.sessionToken)
      this.setData({loadingMore:false,moreError:(error as {title?:string}).title||"更多成员暂未加载，请重试。"});}
  },
  async loadMoreRates(){
    const cursor=this.data.pendingCursor;if(!cursor||!this.data.canApprove||this.data.loading||this.data.pendingLoadingMore)return;
    const attempt=this.data.attempt,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({pendingLoadingMore:true,pendingMoreError:""});
    try{const page=await request<{items:RateProposal[];matchingTotal:number;nextCursor:string|null}>({
      path:`/v1/management/commission-rates/pending?limit=30&cursor=${encodeURIComponent(cursor)}`});
      if(!this.data.alive||attempt!==this.data.attempt||token!==getApp<IAppOption>().globalData.sessionToken||cursor!==this.data.pendingCursor)return;
      const seen=new Set(this.data.pending.map(row=>row.id));
      this.setData({pending:[...this.data.pending,...page.items.filter(row=>!seen.has(row.id)).map(row=>({...row,rateLabel:row.action==="inherit"?"恢复继承全局":`${((row.basisPoints??0)/100).toFixed(2)}%`}))],
        pendingTotal:page.matchingTotal,pendingCursor:page.nextCursor,pendingLoadingMore:false});
    }catch(error){if(this.data.alive&&attempt===this.data.attempt&&token===getApp<IAppOption>().globalData.sessionToken)
      this.setData({pendingLoadingMore:false,pendingMoreError:(error as {title?:string}).title||"更多费率提议暂未加载，请重试。"});}
  },
  openGlobalRateForm(){if(!this.data.canManageRate||!this.data.globalRate||this.data.globalRateBusy)return;
    if(this.globalRateCommand){void this.sendGlobalRateCommand();return;}
    const when=rateDateParts(this.data.globalRate.suggestedEffectiveAt);
    this.setData({globalRateFormVisible:true,globalRateForm:{percent:String((this.data.globalRate.basisPoints??2000)/100),
      date:when.date,time:when.time,reason:""},globalRateError:"",globalRateStatus:""});
  },
  closeGlobalRateForm(){if(this.data.globalRateBusy||this.globalRateCommand)return;
    this.setData({globalRateFormVisible:false,globalRateError:""});},
  editGlobalPercent(event:WechatMiniprogram.Input){this.setData({globalRateForm:{...this.data.globalRateForm,percent:event.detail.value}});},
  editGlobalReason(event:WechatMiniprogram.Input){this.setData({globalRateForm:{...this.data.globalRateForm,reason:event.detail.value}});},
  changeGlobalDate(event:WechatMiniprogram.PickerChange){this.setData({globalRateForm:{...this.data.globalRateForm,date:String(event.detail.value)}});},
  changeGlobalTime(event:WechatMiniprogram.PickerChange){this.setData({globalRateForm:{...this.data.globalRateForm,time:String(event.detail.value)}});},
  async submitGlobalRateForm(){if(!this.data.canManageRate||!this.data.globalRateFormVisible||this.data.globalRateBusy)return;
    if(this.globalRateCommand){void this.sendGlobalRateCommand();return;}
    const form=this.data.globalRateForm,parts=/^(\d{2})(?:\.(\d{1,2}))?$/.exec(form.percent.trim());
    const basisPoints=parts?Number(parts[1])*100+Number((parts[2]||"").padEnd(2,"0")):NaN,reason=form.reason.trim();
    if(!Number.isInteger(basisPoints)||basisPoints<2000||basisPoints>3500){this.setData({globalRateError:"费率须在 20%–35% 之间，最多两位小数。"});return;}
    if(reason.length<4||reason.length>300){this.setData({globalRateError:"请填写 4–300 字的变更依据。"});return;}
    const effective=new Date(`${form.date}T${form.time}:00`);
    if(!Number.isFinite(effective.getTime())){this.setData({globalRateError:"请选择有效的生效日期和时间。"});return;}
    const attempt=this.data.attempt,token=getApp<IAppOption>().globalData.sessionToken;
    const current=()=>this.data.alive&&attempt===this.data.attempt&&token===getApp<IAppOption>().globalData.sessionToken&&this.data.canManageRate;
    const confirmation=await wx.showModal({title:"提交全局费率提议？",
      content:`当前 ${this.data.globalRateLabel} → ${form.percent.trim()}%\n生效：${form.date} ${form.time}\n${reason}\n须由另一名授权管理者复核，仅影响生效后的新订单。`,confirmText:"提交复核"});
    if(!confirmation.confirm||!current())return;
    this.globalRateCommand={key:`global-rate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,12)}`,
      basisPoints,effectiveAt:effective.toISOString(),reason};
    void this.sendGlobalRateCommand();
  },
  async sendGlobalRateCommand(){const command=this.globalRateCommand;if(!command||this.data.globalRateBusy)return;
    const attempt=this.data.attempt,token=getApp<IAppOption>().globalData.sessionToken;
    const current=()=>this.data.alive&&attempt===this.data.attempt&&token===getApp<IAppOption>().globalData.sessionToken&&
      this.data.canManageRate&&this.globalRateCommand?.key===command.key;
    this.setData({globalRateBusy:true,globalRateError:"",globalRateStatus:""});
    try{if(!current())return;
      const result=await request<{id:string}>({path:"/v1/management/commission-rates",method:"POST",idempotencyKey:command.key,
        data:{action:"override",basisPoints:command.basisPoints,effectiveAt:command.effectiveAt,reason:command.reason}});
      if(current()){this.globalRateCommand=null;this.setData({globalRateFormVisible:false,globalRateStatus:`全局费率提议 ${result.id.slice(0,8)} 已记录，等待独立复核。`});}}
    catch(error){if(!current())return;
      try{const existing=await request<{id:string}>({path:`/v1/management/commission-rates/by-request/${command.key}`});
        if(current()){this.globalRateCommand=null;this.setData({globalRateFormVisible:false,globalRateStatus:`原提议 ${existing.id.slice(0,8)} 已记录，等待复核。`});}}
      catch{if(current())this.setData({globalRateError:(error as {title?:string}).title||"结果暂不可确认。再次点击将查询并重试同一提议编号。"});}}
    finally{if(current())this.setData({globalRateBusy:false});}
  },
  openMember(event:WechatMiniprogram.TouchEvent){if(this.data.navigating)return;const id=String(event.currentTarget.dataset.id||"");if(!/^[0-9a-f-]{36}$/i.test(id))return;this.setData({navigating:true});wx.navigateTo({url:`/pages/management-member/index?id=${id}`,fail:()=>this.setData({navigating:false})});},
  async reviewRate(event:WechatMiniprogram.TouchEvent){
    if(!this.data.canApprove||this.data.reviewBusy)return;
    const id=String(event.currentTarget.dataset.id||""),decision=String(event.currentTarget.dataset.decision||"");
    const item=this.data.pending.find(row=>row.id===id);
    if(!item||!["active","rejected"].includes(decision))return;
    const attempt=this.data.attempt,token=getApp<IAppOption>().globalData.sessionToken;
    const current=()=>this.data.alive&&attempt===this.data.attempt&&token===getApp<IAppOption>().globalData.sessionToken&&
      this.data.canApprove&&this.data.pending.some(row=>row.id===id&&row.memberId===item.memberId&&row.basisPoints===item.basisPoints);
    const modal=await wx.showModal({title:decision==="active"?"批准费率提议？":"退回费率提议？",
      content:`${item.displayName} · ${item.rateLabel}\n计划生效 ${dateLabel(item.effectiveAt)}\n${item.reason}\n由另一名授权管理者复核，仅影响生效后的新订单。`,confirmText:decision==="active"?"批准":"退回"});
    if(!modal.confirm||!current())return;
    this.setData({reviewBusy:true,reviewError:""});
    try{if(!current())return;
      await request({path:`/v1/management/commission-rates/${id}/decision`,method:"POST",data:{decision}});
      if(current()){this.setData({reviewBusy:false});await this.load();}}
    catch(error){if(current())this.setData({reviewError:(error as {title?:string}).title||"费率处理未确认，请刷新后核对。"});}
    finally{if(current())this.setData({reviewBusy:false});}
  },
  async refreshAuthority(){const projection=await authorityProjection().catch(()=>null);if(!projection||!hasCapability(projection,"member.profile.read"))return;void this.load();},
  back(){wx.navigateBack({fail:()=>wx.navigateTo({url:"/pages/management/index"})});}
});
