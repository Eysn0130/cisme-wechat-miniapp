import { request } from '../../services/api';
import { currentChromeStyle } from '../../services/layout';
Page({
 data:{chromeStyle:currentChromeStyle(),legalDoc:null as any,type:'terms',loading:true,error:'',alive:true},
 onLoad(query:Record<string,string|undefined>){this.setData({type:['privacy','cross_border'].includes(query.type || '')?query.type!:'terms'});void this.load();},
 onUnload(){this.data.alive=false;},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 async load(){
  this.setData({loading:true,error:'',legalDoc:null});
  try{const result=await request<{ready:boolean;documents:any[]}>({path:'/v1/legal',authMode:'public'});if(!this.data.alive)return;const legalDoc=result.documents.find(item=>item.document_type===this.data.type);this.setData({legalDoc:legalDoc||null,error:legalDoc?'':'协议资料正在完善，发布后可在此阅读全文。'});}
  catch{if(this.data.alive)this.setData({error:'协议暂时无法加载，请检查网络后重试。'});}
  finally{if(this.data.alive)this.setData({loading:false});}
 },
 privacyRights(){wx.navigateTo({url:"/pages/privacy-rights/index"});},
 back(){wx.navigateBack({fail:()=>wx.switchTab({url:'/pages/community/index'})});}
});
