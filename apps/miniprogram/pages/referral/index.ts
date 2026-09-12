import { request, resumeAuthentication } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";

const normalized=(value:string)=>value.trim().toUpperCase().replace(/\s+/g,"");
const confirmationKey=()=>`referral-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
const sessionOwners=new WeakMap<object,string>();
Page({
  data:{chromeStyle:currentChromeStyle(),code:"",key:confirmationKey(),busy:false,confirmed:false,error:"",status:"",alive:true,
    preview:null as null|{code:string;sponsorLabel:string;relationState:string;attributionLevel:number}},
  onLoad(query:Record<string,string|undefined>){sessionOwners.set(this,getApp<IAppOption>().globalData.sessionToken);
    this.setData({code:normalized(String(query.code||""))});},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  onShow(){this.data.alive=true;const token=getApp<IAppOption>().globalData.sessionToken;
    if(sessionOwners.get(this)!==token){sessionOwners.set(this,token);this.setData({key:confirmationKey(),busy:false,confirmed:false,preview:null,error:"",status:""});}},
  onUnload(){this.data.alive=false;},
  editCode(event:WechatMiniprogram.Input){this.setData({code:normalized(event.detail.value),key:confirmationKey(),confirmed:false,preview:null,error:"",status:""});},
  async preview(){
    const code=this.data.code;if(!/^CM[A-HJ-NP-Z2-9]{10}$/.test(code)){this.setData({error:"请输入完整的 12 位会员推荐码。"});return;}
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(!token){resumeAuthentication(`/pages/referral/index?code=${code}`);return;}
    const key=this.data.key,current=()=>this.data.alive&&sessionOwners.get(this)===token&&
      token===getApp<IAppOption>().globalData.sessionToken&&code===this.data.code&&key===this.data.key;
    this.setData({busy:true,error:"",preview:null});
    try{const answer=await request<{code:string;sponsorLabel:string;relationState:string;attributionLevel:number}>({
      path:`/v1/me/referral/preview?code=${encodeURIComponent(code)}`});
      if(current())this.setData({preview:answer,busy:false});}
    catch(error){if(current())this.setData({busy:false,error:(error as {title?:string}).title||"推荐码暂未核实，请重试。"});}
  },
  async confirm(){
    if(this.data.busy||this.data.confirmed||!this.data.preview)return;
    const code=this.data.code;
    if(!/^CM[A-HJ-NP-Z2-9]{10}$/.test(code)){this.setData({error:"请输入完整的 12 位会员推荐码。"});return;}
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(!token){resumeAuthentication(`/pages/referral/index?code=${code}`);return;}
    const key=this.data.key,preview=this.data.preview;
    const current=()=>this.data.alive&&token===getApp<IAppOption>().globalData.sessionToken&&
      sessionOwners.get(this)===token&&this.data.code===code&&this.data.key===key&&this.data.preview?.code===preview.code;
    if(preview.relationState==="already_bound_other"){this.setData({error:"你已确认其他直接推荐关系，不能再次绑定。"});return;}
    const result=await wx.showModal({title:"确认直接推荐关系？",content:`推荐人：${preview.sponsorLabel}（${code}）。确认只建立一级关系，不代表购买或即时收益；已有关系不能改绑。`,confirmText:"确认关系"});
    if(!result.confirm||!current())return;
    this.setData({busy:true,error:"",status:""});
    try{if(!current())return;
      const response=await request<{confirmed:boolean;alreadyConfirmed:boolean}>({path:"/v1/me/referral/confirm",method:"POST",data:{code,confirmationKey:key}});
      if(current())this.setData({busy:false,confirmed:true,status:response.alreadyConfirmed?"这段推荐关系此前已确认。":"直接推荐关系已确认。"});}
    catch(error){if(current())this.setData({busy:false,error:(error as {title?:string}).title||"确认结果暂不可用，请重试。"});}
  },
  back(){wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});}
});
