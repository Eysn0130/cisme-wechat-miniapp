import { request } from "../../services/api";
import { authorityProjection, hasCapability, requireCapability } from "../../services/authority";
import { currentChromeStyle } from "../../services/layout";

type MemberRow={id:string;displayName:string;accountStatus:string;membershipState:string;commercialEligible:boolean;expiresAt:string|null;referralCode:string|null;directReferralCount:number};
type RateProposal={id:string;memberId:string|null;displayName:string;basisPoints:number;effectiveAt:string;createdBy:string;reason:string};

Page({
  data:{chromeStyle:currentChromeStyle(),q:"",filter:"all",filters:[{id:"all",label:"全部"},{id:"members",label:"会员"},{id:"ordinary",label:"普通用户"}],summary:{all:0,members:0,ordinary:0},items:[] as Array<MemberRow&{initial:string}>,pending:[] as Array<RateProposal&{rateLabel:string}>,canApprove:false,
    loading:true,reviewBusy:false,navigating:false,attempt:0,alive:true,error:"",reviewError:""},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  onShow(){this.data.alive=true;this.setData({navigating:false,items:[],pending:[],canApprove:false,
    summary:{all:0,members:0,ordinary:0},loading:true,error:""});void this.load();},
  onUnload(){this.data.alive=false;this.data.attempt+=1;},
  editSearch(event:WechatMiniprogram.Input){this.setData({q:event.detail.value});},
  search(){void this.load();},
  selectFilter(event:WechatMiniprogram.TouchEvent){const filter=String(event.currentTarget.dataset.filter);if(!["all","members","ordinary"].includes(filter))return;this.setData({filter});void this.load();},
  async load(){
    this.setData({items:[],pending:[],canApprove:false,summary:{all:0,members:0,ordinary:0},loading:true,error:""});
    const projection=await requireCapability("member.profile.read");if(!projection)return;
    const attempt=++this.data.attempt;const token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({loading:true,error:"",canApprove:hasCapability(projection,"commission.rate.approve")});
    try{
      const query=`?q=${encodeURIComponent(this.data.q.trim())}&filter=${this.data.filter}&limit=30`;
      const [members,rates]=await Promise.all([
        request<{items:MemberRow[];summary:{all:number;members:number;ordinary:number}}>({path:`/v1/management/members${query}`}),
        hasCapability(projection,"commission.rate.approve")?request<{items:RateProposal[]}>({path:"/v1/management/commission-rates/pending"}):Promise.resolve({items:[] as RateProposal[]})
      ]);
      if(!this.data.alive||this.data.attempt!==attempt||token!==getApp<IAppOption>().globalData.sessionToken)return;
      this.setData({items:members.items.map(row=>({...row,initial:row.displayName?.slice(0,1)||"C"})),summary:members.summary,
        pending:rates.items.map(row=>({...row,rateLabel:`${(row.basisPoints/100).toFixed(2)}%`})),loading:false});
    }catch(error){if(this.data.alive&&this.data.attempt===attempt)this.setData({loading:false,error:(error as {title?:string}).title||"成员资料暂未加载，请重试。"});}
  },
  openMember(event:WechatMiniprogram.TouchEvent){if(this.data.navigating)return;const id=String(event.currentTarget.dataset.id||"");if(!/^[0-9a-f-]{36}$/i.test(id))return;this.setData({navigating:true});wx.navigateTo({url:`/pages/management-member/index?id=${id}`,fail:()=>this.setData({navigating:false})});},
  async reviewRate(event:WechatMiniprogram.TouchEvent){
    if(!this.data.canApprove||this.data.reviewBusy)return;
    const id=String(event.currentTarget.dataset.id||""),decision=String(event.currentTarget.dataset.decision||"");
    const item=this.data.pending.find(row=>row.id===id);
    if(!item||!["active","rejected"].includes(decision))return;
    const modal=await wx.showModal({title:decision==="active"?"批准费率提议？":"退回费率提议？",
      content:`${item.displayName} · ${item.basisPoints/100}%\n${item.reason}\n由另一名授权管理者复核，生效时间之后的新订单才使用新费率。`,confirmText:decision==="active"?"批准":"退回"});
    if(!modal.confirm||!this.data.alive)return;
    this.setData({reviewBusy:true,reviewError:""});
    try{await request({path:`/v1/management/commission-rates/${id}/decision`,method:"POST",data:{decision}});await this.load();}
    catch(error){if(this.data.alive)this.setData({reviewError:(error as {title?:string}).title||"费率处理未确认，请刷新后核对。"});}
    finally{if(this.data.alive)this.setData({reviewBusy:false});}
  },
  async refreshAuthority(){const projection=await authorityProjection().catch(()=>null);if(!projection||!hasCapability(projection,"member.profile.read"))return;void this.load();},
  back(){wx.navigateBack({fail:()=>wx.navigateTo({url:"/pages/management/index"})});}
});
