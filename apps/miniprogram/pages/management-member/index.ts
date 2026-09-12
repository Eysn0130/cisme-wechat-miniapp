import { request } from "../../services/api";
import { authorityProjection, hasCapability, requireCapability } from "../../services/authority";
import { currentChromeStyle } from "../../services/layout";

type MemberDetail={member:{id:string;displayName:string;accountStatus:string;membershipState:string;commercialEligible:boolean;effectiveAt:string|null;expiresAt:string|null;version:number;referralCode:string|null};rate:{basisPoints:number|null;effectiveAt:string|null;source:"member_override"|"global"|"none"}|null;
  commission:{pendingCents:number;availableCents:number;settledCents:number;settlementAvailable:boolean};scope:{referrals:boolean;orders:boolean;ownOrders:boolean};
  membershipPolicy:{kind:string;termDays:number;serverTime:string;renewalExpiresAt:string;rateProposalSuggestedAt:string}};
type SectionRow={id:string;displayName?:string;confirmedAt?:string;verifiedOrderCount?:number;orderNumber?:string;status?:string;statusLabel?:string;productName?:string;totalCents?:number;totalLabel?:string;transactionSourceKind?:string;basisPoints?:number|null;rateLabel?:string;commissionNetCents?:number|null;commissionLabel?:string;title?:string};
type SectionPage={items:SectionRow[];matchingTotal:number;nextCursor:string|null};
type RateForm={mode:"override"|"inherit";percent:string;date:string;time:string;reason:string};
const dateLabel=(value:string|null)=>value?new Date(value).toLocaleDateString("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit"}):"未设置";
const money=(value:number)=>`¥${(value/100).toFixed(2)}`;
const orderStatusLabel=(value:string|undefined)=>({paid:"已支付",pending_payment:"待支付",cancelled:"已取消",expired:"已超时"})[value??""]??"状态待核对";
const rateDateParts=(value:string)=>{const date=new Date(value),pad=(n:number)=>String(n).padStart(2,"0");
  return {date:`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`,time:`${pad(date.getHours())}:${pad(date.getMinutes())}`};};

Page({
  sectionCache:{} as Record<string,SectionPage>,
  rateCommand:null as null|{key:string;memberId:string;action:"override"|"inherit";basisPoints?:number;effectiveAt:string;reason:string},
  data:{chromeStyle:currentChromeStyle(),id:"",detail:null as MemberDetail|null,
    section:"overview",sections:[{id:"overview",label:"概览"},{id:"referrals",label:"推荐"},{id:"orders",label:"订单"},{id:"posts",label:"内容"}],canManageRate:false,canManageMembership:false,
    orderMode:"own-orders",orderModes:[{id:"own-orders",label:"本人购买"},{id:"attributed-orders",label:"推荐成交"}],
    visibleRows:[] as SectionRow[],visibleTotal:0,visibleCursor:null as string|null,sectionLoading:false,sectionLoadingMore:false,sectionError:"",
    effectiveLabel:"",expiresLabel:"",rateLabel:"",rateFormVisible:false,
    rateForm:{mode:"override",percent:"",date:"",time:"",reason:""} as RateForm,
    loading:true,busy:false,alive:true,attempt:0,sectionAttempt:0,error:"",actionError:"",actionStatus:""},
  onLoad(query:Record<string,string|undefined>){this.setData({id:String(query.id||"")});},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  onShow(){this.data.alive=true;this.sectionCache={};this.rateCommand=null;this.setData({detail:null,visibleRows:[],visibleTotal:0,visibleCursor:null,sectionLoading:false,sectionError:"",
    canManageRate:false,canManageMembership:false,rateFormVisible:false,loading:true,error:""});void this.load();},
  onUnload(){this.data.alive=false;this.rateCommand=null;this.data.attempt+=1;this.data.sectionAttempt+=1;},
  selectSection(event:WechatMiniprogram.TouchEvent){const section=String(event.currentTarget.dataset.section);if(!this.data.sections.some(item=>item.id===section))return;
    this.setData({section});void this.showSection();},
  selectOrderMode(event:WechatMiniprogram.TouchEvent){const mode=String(event.currentTarget.dataset.mode);
    if(mode!=="own-orders"&&mode!=="attributed-orders")return;
    if(mode==="attributed-orders"&&!this.data.detail?.scope.orders)return;
    this.setData({orderMode:mode});void this.showSection();},
  sectionKey(){return this.data.section==="orders"?this.data.orderMode:this.data.section;},
  async showSection(){
    const section=this.sectionKey(),cached=this.sectionCache[section];
    this.data.sectionAttempt+=1;
    if(section==="overview")return;
    if(cached){this.setData({visibleRows:cached.items,visibleTotal:cached.matchingTotal,visibleCursor:cached.nextCursor,
      sectionLoading:false,sectionError:""});return;}
    this.setData({visibleRows:[],visibleTotal:0,visibleCursor:null,sectionLoading:true,sectionError:""});
    await this.loadSection(section,null);
  },
  onReachBottom(){void this.loadMoreSection();},
  async loadMoreSection(){const cursor=this.data.visibleCursor;if(!cursor||this.data.sectionLoading||this.data.sectionLoadingMore)return;
    this.setData({sectionLoadingMore:true,sectionError:""});await this.loadSection(this.sectionKey(),cursor);},
  async loadSection(section:string,cursor:string|null){
    const attempt=this.data.attempt,sectionAttempt=this.data.sectionAttempt,token=getApp<IAppOption>().globalData.sessionToken,id=this.data.id;
    try{const page=await request<SectionPage>({path:`/v1/management/members/${id}/sections/${section}?limit=30${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`});
      if(!this.data.alive||attempt!==this.data.attempt||sectionAttempt!==this.data.sectionAttempt||
        token!==getApp<IAppOption>().globalData.sessionToken||section!==this.sectionKey()||id!==this.data.id)return;
      const earlier=cursor?this.sectionCache[section]?.items??[]:[];
      const seen=new Set(earlier.map(item=>item.id));
      const merged=[...earlier,...page.items.filter(item=>!seen.has(item.id)).map(item=>({...item,
        statusLabel:orderStatusLabel(item.status),totalLabel:typeof item.totalCents==="number"?money(item.totalCents):"",
        rateLabel:typeof item.basisPoints==="number"?`${(item.basisPoints/100).toFixed(2)}%`:"",
        commissionLabel:item.transactionSourceKind==="verified_commerce"&&item.status==="paid"&&typeof item.commissionNetCents==="number"
          ?money(item.commissionNetCents):""}))];
      this.sectionCache[section]={...page,items:merged};
      this.setData({visibleRows:merged,visibleTotal:page.matchingTotal,visibleCursor:page.nextCursor,
        sectionLoading:false,sectionLoadingMore:false,sectionError:""});
    }catch(error){if(this.data.alive&&attempt===this.data.attempt&&sectionAttempt===this.data.sectionAttempt&&
      token===getApp<IAppOption>().globalData.sessionToken)
      this.setData({sectionLoading:false,sectionLoadingMore:false,
        sectionError:(error as {title?:string}).title||"此分类暂未加载，请重试。"});}
  },
  retrySection(){const key=this.sectionKey();void this.loadSection(key,this.data.visibleCursor);},
  openRow(event:WechatMiniprogram.TouchEvent){const id=String(event.currentTarget.dataset.id||"");
    if(!/^[0-9a-f-]{36}$/i.test(id))return;
    const section=this.sectionKey();
    if(section==="referrals")wx.navigateTo({url:`/pages/management-member/index?id=${id}`});
    else if(section==="posts")wx.navigateTo({url:`/pages/community-post/index?id=${id}`});
    else wx.navigateTo({url:`/pages/management-order-detail/index?id=${id}`});
  },
  async load(){const attempt=++this.data.attempt,token=getApp<IAppOption>().globalData.sessionToken;
    this.sectionCache={};this.data.sectionAttempt+=1;
    this.setData({detail:null,visibleRows:[],visibleTotal:0,visibleCursor:null,
    sectionLoading:false,sectionLoadingMore:false,sectionError:"",canManageRate:false,
    canManageMembership:false,loading:true,busy:false,error:""});const authority=await requireCapability("member.profile.read");
    if(!authority||!this.data.alive||attempt!==this.data.attempt||token!==getApp<IAppOption>().globalData.sessionToken)return;
    this.setData({loading:true,error:"",canManageRate:hasCapability(authority,"commission.rate.manage"),canManageMembership:hasCapability(authority,"member.manage")});
    try{const detail=await request<MemberDetail>({path:`/v1/management/members/${this.data.id}`});
      if(!this.data.alive||this.data.attempt!==attempt||token!==getApp<IAppOption>().globalData.sessionToken)return;
      const sections=[{id:"overview",label:"概览"},
        ...(detail.scope.referrals?[{id:"referrals",label:"推荐"}]:[]),
        ...((detail.scope.orders||detail.scope.ownOrders)?[{id:"orders",label:"订单"}]:[]),{id:"posts",label:"内容"}];
      const orderMode=detail.scope.ownOrders?"own-orders":"attributed-orders";
      this.setData({detail,sections,section:sections.some(item=>item.id===this.data.section)?this.data.section:"overview",
        orderMode,effectiveLabel:dateLabel(detail.member.effectiveAt),expiresLabel:dateLabel(detail.member.expiresAt),
        rateLabel:detail.rate?.basisPoints==null?"未配置":`${(detail.rate.basisPoints/100).toFixed(2)}% · ${detail.rate.source==="member_override"?"单独设置":"继承全局"}`,
        loading:false});
      if(this.data.section!=="overview")void this.showSection();
    }catch(error){if(this.data.alive&&attempt===this.data.attempt&&token===getApp<IAppOption>().globalData.sessionToken)
      this.setData({loading:false,error:(error as {title?:string}).title||"成员详情暂未加载，请重试。"});}
  },
  async changeMembership(event:WechatMiniprogram.TouchEvent){
    const detail=this.data.detail;if(!detail||this.data.busy)return;
    const attempt=this.data.attempt,token=getApp<IAppOption>().globalData.sessionToken,id=detail.member.id,version=detail.member.version;
    const current=()=>this.data.alive&&attempt===this.data.attempt&&token===getApp<IAppOption>().globalData.sessionToken&&
      this.data.detail?.member.id===id&&this.data.detail.member.version===version;
    const state=String(event.currentTarget.dataset.state||"");if(state!=="active"&&state!=="suspended")return;
    const active=state==="active";
    const result=await wx.showModal({title:active?"授予或续期商业会员？":"暂停商业会员资格？",
      content:active?`工程测试期限 ${detail.membershipPolicy.termDays} 天。当前到期：${dateLabel(detail.member.expiresAt)}；变更后预计到期：${dateLabel(detail.membershipPolicy.renewalExpiresAt)}。正式政策待签字。请填写依据。`
        :`暂停后推荐码不用于新关系或订单；当前到期 ${dateLabel(detail.member.expiresAt)} 保留。请填写依据。`,
      editable:true,placeholderText:"至少 4 字的变更依据",confirmText:active?"确认资格":"确认暂停"});
    if(!result.confirm||!current())return;
    const reason=(result.content||"").trim();if(reason.length<4){this.setData({actionError:"请填写至少 4 字的变更依据。"});return;}
    this.setData({busy:true,actionError:"",actionStatus:""});
    try{if(!current())return;
      await request({path:`/v1/management/members/${id}/membership`,method:"POST",data:{state,...(active?{term:"engineering_365_day"}:{}),expectedVersion:version,reason}});
      if(current()){this.setData({busy:false,actionStatus:active?"资格已更新，请核对有效期。":"资格已暂停。"});await this.load();}}
    catch(error){if(current())this.setData({actionError:(error as {title?:string}).title||"资格变更尚未确认，请刷新后核对。"});}
    finally{if(current())this.setData({busy:false});}
  },
  openRateForm(){const detail=this.data.detail;if(!detail||!this.data.canManageRate||this.data.busy)return;
    if(this.rateCommand){void this.sendRateCommand();return;}
    const when=rateDateParts(detail.membershipPolicy.rateProposalSuggestedAt);
    this.setData({rateFormVisible:true,rateForm:{mode:"override",percent:detail.rate?.basisPoints?String(detail.rate.basisPoints/100):"20",
      date:when.date,time:when.time,reason:""},actionError:"",actionStatus:""});
  },
  closeRateForm(){if(this.data.busy||this.rateCommand)return;this.setData({rateFormVisible:false,actionError:""});},
  selectRateMode(event:WechatMiniprogram.TouchEvent){const mode=String(event.currentTarget.dataset.mode);
    if(mode!=="override"&&mode!=="inherit")return;this.setData({rateForm:{...this.data.rateForm,mode}});},
  editRatePercent(event:WechatMiniprogram.Input){this.setData({rateForm:{...this.data.rateForm,percent:event.detail.value}});},
  editRateReason(event:WechatMiniprogram.Input){this.setData({rateForm:{...this.data.rateForm,reason:event.detail.value}});},
  changeRateDate(event:WechatMiniprogram.PickerChange){this.setData({rateForm:{...this.data.rateForm,date:String(event.detail.value)}});},
  changeRateTime(event:WechatMiniprogram.PickerChange){this.setData({rateForm:{...this.data.rateForm,time:String(event.detail.value)}});},
  async submitRateForm(){const detail=this.data.detail;if(!detail||!this.data.canManageRate||this.data.busy||!this.data.rateFormVisible)return;
    if(this.rateCommand){void this.sendRateCommand();return;}
    const form=this.data.rateForm,reason=form.reason.trim(),parts=/^(\d{2})(?:\.(\d{1,2}))?$/.exec(form.percent.trim());
    const basisPoints=parts?Number(parts[1])*100+Number((parts[2]||"").padEnd(2,"0")):NaN;
    if(form.mode==="override"&&(!Number.isInteger(basisPoints)||basisPoints<2000||basisPoints>3500)){
      this.setData({actionError:"费率须在 20%–35% 之间，最多两位小数。"});return;}
    if(reason.length<4||reason.length>300){this.setData({actionError:"请填写 4–300 字的变更依据。"});return;}
    const effective=new Date(`${form.date}T${form.time}:00`);
    if(!Number.isFinite(effective.getTime())){this.setData({actionError:"请选择有效的生效日期和时间。"});return;}
    const attempt=this.data.attempt,token=getApp<IAppOption>().globalData.sessionToken,id=detail.member.id,version=detail.member.version;
    const current=()=>this.data.alive&&attempt===this.data.attempt&&token===getApp<IAppOption>().globalData.sessionToken&&
      this.data.detail?.member.id===id&&this.data.detail.member.version===version&&this.data.canManageRate;
    const modeLabel=form.mode==="inherit"?"恢复继承全局费率":`单独设置 ${(basisPoints/100).toFixed(2)}%`;
    const modal=await wx.showModal({title:"提交费率提议？",content:`${detail.member.displayName} · ${modeLabel}\n生效：${form.date} ${form.time}\n${reason}\n须由另一名授权管理者复核，仅影响生效后的新订单。`,confirmText:"提交复核"});
    if(!modal.confirm||!current())return;
    this.rateCommand={key:`rate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,12)}`,
      memberId:id,action:form.mode,...(form.mode==="override"?{basisPoints}:{}),effectiveAt:effective.toISOString(),reason};
    void this.sendRateCommand();
  },
  async sendRateCommand(){const command=this.rateCommand;if(!command||this.data.busy)return;
    const attempt=this.data.attempt,token=getApp<IAppOption>().globalData.sessionToken;
    const current=()=>this.data.alive&&attempt===this.data.attempt&&token===getApp<IAppOption>().globalData.sessionToken&&
      this.data.detail?.member.id===command.memberId&&this.rateCommand?.key===command.key;
    this.setData({busy:true,actionError:"",actionStatus:""});
    try{if(!current())return;
      const answer=await request<{id:string;state:string}>({path:"/v1/management/commission-rates",method:"POST",idempotencyKey:command.key,
        data:{memberId:command.memberId,action:command.action,...(command.action==="override"?{basisPoints:command.basisPoints}:{}),effectiveAt:command.effectiveAt,reason:command.reason}});
      if(current()){this.rateCommand=null;this.setData({rateFormVisible:false,actionStatus:`费率提议 ${answer.id.slice(0,8)} 已记录，等待另一名管理者复核。`});}}
    catch(error){if(!current())return;
      try{const existing=await request<{id:string}>({path:`/v1/management/commission-rates/by-request/${command.key}`});
        if(current()){this.rateCommand=null;this.setData({rateFormVisible:false,actionStatus:`原提议 ${existing.id.slice(0,8)} 已记录，等待复核。`});}}
      catch{if(current())this.setData({actionError:(error as {title?:string}).title||"结果暂不可确认。再次点击将查询并重试同一提议编号。"});}}
    finally{if(current())this.setData({busy:false});}
  },
  async refreshAuthority(){const projection=await authorityProjection().catch(()=>null);if(projection&&hasCapability(projection,"member.profile.read"))void this.load();},
  back(){wx.navigateBack({fail:()=>wx.navigateTo({url:"/pages/management-members/index"})});}
});
