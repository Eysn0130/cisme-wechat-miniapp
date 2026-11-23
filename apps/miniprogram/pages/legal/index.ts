import { request } from '../../services/api';
import { currentChromeStyle } from '../../services/layout';
import { legalTextBlocks, type LegalTextBlock } from '../../services/legal-text';
import {sectionTabValue} from '../../services/section-tabs';
const documentTabs=[{id:'privacy',label:'隐私保护指引'},{id:'terms',label:'用户协议'}];
Page({
 data:{chromeStyle:currentChromeStyle(),legalDoc:null as any,legalBlocks:[] as LegalTextBlock[],documentTabs:[...documentTabs],type:'terms',loading:true,error:'',alive:true,readAttempt:0},
 onLoad(query:Record<string,string|undefined>){const type=['privacy','cross_border'].includes(query.type || '')?query.type!:'terms';this.setData({type,documentTabs:type==='cross_border'?[...documentTabs,{id:'cross_border',label:'境外存储告知'}]:[...documentTabs]});void this.load();},
 onUnload(){this.data.alive=false;this.data.readAttempt+=1;},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 async changeDocument(event:WechatMiniprogram.CustomEvent){
  const type=sectionTabValue(event);
  if(!this.data.alive||type===this.data.type||!this.data.documentTabs.some(item=>item.id===type))return;
  this.setData({type});wx.pageScrollTo({scrollTop:0,duration:0});await this.load();
 },
 async load(){
  const attempt=++this.data.readAttempt;
  const current=()=>this.data.alive&&attempt===this.data.readAttempt;
  this.setData({loading:true,error:'',legalDoc:null,legalBlocks:[]});
  try{
   const result=await request<{ready:boolean;documents:any[]}>({path:'/v1/legal',authMode:'public'});
   if(!current())return;
   this.setData({documentTabs:Array.isArray(result.documents)&&result.documents.some(item=>item?.document_type==='cross_border')?[...documentTabs,{id:'cross_border',label:'境外存储告知'}]:this.data.type==='cross_border'?this.data.documentTabs:[...documentTabs]});
   const legalDoc=Array.isArray(result.documents)?result.documents.find(item=>item?.document_type===this.data.type):null;
   const valid=legalDoc&&typeof legalDoc.body==='string'&&legalDoc.body.trim()&&typeof legalDoc.title==='string'&&typeof legalDoc.version==='string';
   this.setData({legalDoc:valid?legalDoc:null,legalBlocks:valid?legalTextBlocks(legalDoc.body,legalDoc.title):[],error:valid?'':'协议暂不可用，请稍后重试。'});
  }catch{if(current())this.setData({error:'协议暂时无法加载，请检查网络后重试。'});}
  finally{if(current())this.setData({loading:false});}
 },
 privacyRights(){wx.navigateTo({url:"/pages/privacy-rights/index",fail:()=>wx.showToast({title:'数据权利页面暂时无法打开，请重试。',icon:'none'})});},
 back(){wx.navigateBack({fail:()=>wx.switchTab({url:'/pages/community/index'})});}
});
