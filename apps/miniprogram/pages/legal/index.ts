import { request } from '../../services/api';
import { currentChromeStyle } from '../../services/layout';
import { legalTextBlocks, type LegalTextBlock } from '../../services/legal-text';
Page({
 data:{chromeStyle:currentChromeStyle(),legalDoc:null as any,legalBlocks:[] as LegalTextBlock[],type:'terms',loading:true,error:'',alive:true,readAttempt:0},
 onLoad(query:Record<string,string|undefined>){this.setData({type:['privacy','cross_border'].includes(query.type || '')?query.type!:'terms'});void this.load();},
 onUnload(){this.data.alive=false;this.data.readAttempt+=1;},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 async load(){
  const attempt=++this.data.readAttempt;
  const current=()=>this.data.alive&&attempt===this.data.readAttempt;
  this.setData({loading:true,error:'',legalDoc:null,legalBlocks:[]});
  try{
   const result=await request<{ready:boolean;documents:any[]}>({path:'/v1/legal',authMode:'public'});
   if(!current())return;
   const legalDoc=Array.isArray(result.documents)?result.documents.find(item=>item?.document_type===this.data.type):null;
   const valid=legalDoc&&typeof legalDoc.body==='string'&&legalDoc.body.trim()&&typeof legalDoc.title==='string'&&typeof legalDoc.version==='string';
   this.setData({legalDoc:valid?legalDoc:null,legalBlocks:valid?legalTextBlocks(legalDoc.body,legalDoc.title):[],error:valid?'':'协议暂不可用，请稍后重试。'});
  }catch{if(current())this.setData({error:'协议暂时无法加载，请检查网络后重试。'});}
  finally{if(current())this.setData({loading:false});}
 },
 privacyRights(){wx.navigateTo({url:"/pages/privacy-rights/index",fail:()=>wx.showToast({title:'数据权利页面暂时无法打开，请重试。',icon:'none'})});},
 back(){wx.navigateBack({fail:()=>wx.switchTab({url:'/pages/community/index'})});}
});
