import { request, resumeAuthentication } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";

const normalized=(value:string)=>value.trim().toUpperCase().replace(/\s+/g,"");
const confirmationKey=()=>`referral-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
Page({
  data:{chromeStyle:currentChromeStyle(),code:"",key:confirmationKey(),busy:false,confirmed:false,error:"",status:"",alive:true},
  onLoad(query:Record<string,string|undefined>){this.setData({code:normalized(String(query.code||""))});},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  onShow(){this.data.alive=true;},
  onUnload(){this.data.alive=false;},
  editCode(event:WechatMiniprogram.Input){this.setData({code:normalized(event.detail.value),key:confirmationKey(),confirmed:false,error:"",status:""});},
  async confirm(){
    if(this.data.busy||this.data.confirmed)return;
    const code=this.data.code;
    if(!/^CM[A-HJ-NP-Z2-9]{10}$/.test(code)){this.setData({error:"请输入完整的 12 位会员推荐码。"});return;}
    if(!getApp<IAppOption>().globalData.sessionToken){resumeAuthentication(`/pages/referral/index?code=${code}`);return;}
    const result=await wx.showModal({title:"确认直接推荐关系？",content:`确认后，${code} 对应的会员将成为你的直接推荐人。关系不能重复绑定；未来若开放合格商品佣金，仅按一级关系计算。`,confirmText:"确认关系"});
    if(!result.confirm||!this.data.alive)return;
    this.setData({busy:true,error:"",status:""});
    try{const response=await request<{confirmed:boolean;alreadyConfirmed:boolean}>({path:"/v1/me/referral/confirm",method:"POST",data:{code,confirmationKey:this.data.key}});
      if(this.data.alive)this.setData({busy:false,confirmed:true,status:response.alreadyConfirmed?"这段推荐关系此前已确认。":"直接推荐关系已确认。"});}
    catch(error){if(this.data.alive)this.setData({busy:false,error:(error as {title?:string}).title||"确认结果暂不可用，请重试。"});}
  },
  back(){wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});}
});
