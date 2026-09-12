import { request } from "../../services/api";
import { authorityProjection, hasCapability, requireCapability } from "../../services/authority";
import { currentChromeStyle } from "../../services/layout";

type MemberDetail={member:{id:string;displayName:string;accountStatus:string;membershipState:string;commercialEligible:boolean;effectiveAt:string|null;expiresAt:string|null;version:number;referralCode:string|null};rate:{basisPoints:number;effectiveAt:string|null}|null;
  referrals:Array<{id:string;displayName:string;confirmedAt:string;orderCount:number;syntheticMerchandiseCents:number}>;
  orders:Array<{id:string;orderNumber:string;status:string;productName:string;cashMerchandiseCents:number;basisPoints:number;sourceKind:string;createdAt:string}>;
  publicPosts:Array<{id:string;title:string;state:string;updated_at:string}>;
  commission:{pendingCents:number;availableCents:number;settledCents:number;settlementAvailable:boolean};scope:{referrals:boolean;orders:boolean}};
const dateLabel=(value:string|null)=>value?new Date(value).toLocaleDateString("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit"}):"未设置";
const money=(value:number)=>`¥${(value/100).toFixed(2)}`;

Page({
  data:{chromeStyle:currentChromeStyle(),id:"",detail:null as MemberDetail|null,referrals:[] as Array<{id:string;displayName:string;orderCount:number}>,orders:[] as Array<{id:string;orderNumber:string;status:string;productName:string;amount:string}>,posts:[] as Array<{id:string;title:string}>,
    section:"overview",sections:[{id:"overview",label:"概览"},{id:"referrals",label:"推荐"},{id:"orders",label:"订单"},{id:"posts",label:"内容"}],canManageRate:false,canManageMembership:false,
    loading:true,busy:false,alive:true,attempt:0,error:"",actionError:"",actionStatus:""},
  onLoad(query:Record<string,string|undefined>){this.setData({id:String(query.id||"")});},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  onShow(){this.data.alive=true;this.setData({detail:null,referrals:[],orders:[],posts:[],
    canManageRate:false,canManageMembership:false,loading:true,error:""});void this.load();},
  onUnload(){this.data.alive=false;this.data.attempt+=1;},
  selectSection(event:WechatMiniprogram.TouchEvent){const section=String(event.currentTarget.dataset.section);if(this.data.sections.some(item=>item.id===section))this.setData({section});},
  async load(){this.setData({detail:null,referrals:[],orders:[],posts:[],canManageRate:false,
    canManageMembership:false,loading:true,error:""});const authority=await requireCapability("member.profile.read");if(!authority)return;
    const attempt=++this.data.attempt;const token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({loading:true,error:"",canManageRate:hasCapability(authority,"commission.rate.manage"),canManageMembership:hasCapability(authority,"member.manage")});
    try{const detail=await request<MemberDetail>({path:`/v1/management/members/${this.data.id}`});
      if(!this.data.alive||this.data.attempt!==attempt||token!==getApp<IAppOption>().globalData.sessionToken)return;
      const sections=[{id:"overview",label:"概览"},
        ...(detail.scope.referrals?[{id:"referrals",label:"推荐"}]:[]),
        ...(detail.scope.orders?[{id:"orders",label:"订单"}]:[]),{id:"posts",label:"内容"}];
      this.setData({detail,sections,section:sections.some(item=>item.id===this.data.section)?this.data.section:"overview",
        referrals:detail.referrals.map(row=>({id:row.id,displayName:row.displayName,orderCount:row.orderCount})),
        orders:detail.orders.map(row=>({id:row.id,orderNumber:row.orderNumber,status:row.status,productName:row.productName,amount:money(row.cashMerchandiseCents)})),
        posts:detail.publicPosts.map(row=>({id:row.id,title:row.title||"未命名护理故事"})),loading:false});
    }catch(error){if(this.data.alive&&attempt===this.data.attempt)this.setData({loading:false,error:(error as {title?:string}).title||"成员详情暂未加载，请重试。"});}
  },
  async changeMembership(event:WechatMiniprogram.TouchEvent){
    const detail=this.data.detail;if(!detail||this.data.busy)return;
    const state=String(event.currentTarget.dataset.state||"");if(state!=="active"&&state!=="suspended")return;
    const active=state==="active";
    const result=await wx.showModal({title:active?"授予或续期商业会员？":"暂停商业会员资格？",
      content:active?"工程默认有效期为一年；最终权益、复购与结算规则仍待业务签字。请填写变更依据。":"暂停后推荐码不再用于新关系或新订单；历史快照保留。请填写依据。",
      editable:true,placeholderText:"至少 4 字的变更依据",confirmText:active?"确认资格":"确认暂停"});
    if(!result.confirm||!this.data.alive)return;
    const reason=(result.content||"").trim();if(reason.length<4){this.setData({actionError:"请填写至少 4 字的变更依据。"});return;}
    const expiresAt=active?new Date(Date.now()+365*24*60*60*1000).toISOString():undefined;
    this.setData({busy:true,actionError:"",actionStatus:""});
    try{await request({path:`/v1/management/members/${detail.member.id}/membership`,method:"POST",data:{state,expiresAt,expectedVersion:detail.member.version,reason}});
      if(this.data.alive){this.setData({actionStatus:active?"资格已更新，请核对有效期。":"资格已暂停。"});await this.load();}}
    catch(error){if(this.data.alive)this.setData({actionError:(error as {title?:string}).title||"资格变更尚未确认，请刷新后核对。"});}
    finally{if(this.data.alive)this.setData({busy:false});}
  },
  async proposeRate(){const detail=this.data.detail;if(!detail||!this.data.canManageRate||this.data.busy)return;
    const first=await wx.showModal({title:"提议会员费率",content:"输入 20–35 之间的百分比。提交后须由另一名授权管理者批准，且只影响生效后的新订单。",editable:true,placeholderText:"例如 20 或 25.5",confirmText:"下一步"});
    if(!first.confirm||!this.data.alive)return;
    const input=(first.content||"").trim(),parts=/^(\d{2})(?:\.(\d{1,2}))?$/.exec(input);
    const basisPoints=parts?Number(parts[1])*100+Number((parts[2]||"").padEnd(2,"0")):NaN;
    if(!Number.isInteger(basisPoints)||basisPoints<2000||basisPoints>3500){
      this.setData({actionError:"费率须在 20%–35% 之间，最多两位小数。"});return;
    }
    const second=await wx.showModal({title:"填写变更依据",editable:true,placeholderText:"至少 4 字，供另一名管理者复核",confirmText:"提交提议"});
    if(!second.confirm||!this.data.alive)return;
    const reason=(second.content||"").trim();if(reason.length<4){this.setData({actionError:"请填写至少 4 字的依据。"});return;}
    this.setData({busy:true,actionError:"",actionStatus:""});
    try{await request({path:"/v1/management/commission-rates",method:"POST",data:{memberId:detail.member.id,basisPoints,effectiveAt:new Date(Date.now()+60*60*1000).toISOString(),reason}});
      if(this.data.alive)this.setData({actionStatus:"费率提议已提交，等待另一名管理者复核。"});}
    catch(error){if(this.data.alive)this.setData({actionError:(error as {title?:string}).title||"费率提议未确认，请重试。"});}
    finally{if(this.data.alive)this.setData({busy:false});}
  },
  async refreshAuthority(){const projection=await authorityProjection().catch(()=>null);if(projection&&hasCapability(projection,"member.profile.read"))void this.load();},
  back(){wx.navigateBack({fail:()=>wx.navigateTo({url:"/pages/management-members/index"})});}
});
