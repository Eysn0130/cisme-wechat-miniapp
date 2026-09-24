import { authorityProjection, hasCapability } from "../../services/authority";
import { currentChromeStyle } from "../../services/layout";
import { request } from "../../services/api";
import { pageRead, cancelPageReads } from "../../services/page-requests";
import { commerceContextRevision } from "../../services/commerce-command-store";
type PrivacyRow={id:string;kind:string;message:string;status:string;waitingOn:"operator"|"member";response:string|null;replyHistory:Array<{actor:'operator'|'member';body:string;createdAt:string;version:number}>;version:number;due_at:string;execution:{type:string;status:string}|null;kindLabel?:string;statusLabel?:string;dueLabel?:string;executionLabel?:string;editable?:boolean};
type PrivacyPage={items:PrivacyRow[];nextCursor:string|null};
const kinds:Record<string,string>={access:"查询 / 导出",correct:"信息更正",delete:"删除请求",close_account:"注销账号",withdraw:"撤回同意",other:"其他请求"};
const states:Record<string,string>={received:"待受理",verifying:"待核验",reviewing:"处理中",approved:"已批准",executing:"执行中",completed:"已完成",partially_completed:"部分完成",failed:"执行失败",rejected:"已拒绝",canceled:"已取消",responded:"已回复"};
const executionStates:Record<string,string>={planned:"待执行",approved:"待执行",running:"执行中",succeeded:"已完成",partially_succeeded:"部分完成",failed:"执行失败",canceled:"已取消",expired:"副本已过期"};
const editable=new Set(["received","verifying","reviewing","responded"]);
function displayRow(row:PrivacyRow):PrivacyRow{return {...row,kindLabel:kinds[row.kind]||"其他请求",statusLabel:row.status==="responded"?(row.waitingOn==="member"?"待用户补充":"已回复待处理"):states[row.status]||"待核验",dueLabel:new Date(row.due_at).toLocaleDateString("zh-CN"),executionLabel:row.execution?(executionStates[row.execution.status]||"待核对"):"",editable:editable.has(row.status)};}
Page({
 lastToken:"",lastRevision:-1,epoch:0,visible:false,readPending:false,timer:null as ReturnType<typeof setInterval>|null,
 data:{chromeStyle:currentChromeStyle(),items:[] as PrivacyRow[],nextCursor:null as string|null,moreBusy:false,moreError:"",selected:null as PrivacyRow|null,response:"",statusIndex:0,statusOptions:["处理中","回复进度","请用户补充"],loading:true,busy:false,coreReady:false,error:"",actionError:"",notice:""},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 onShow(){this.visible=true;return this.load();},
 onHide(){this.visible=false;this.epoch++;cancelPageReads(this);this.stopPolling();this.readPending=false;this.setData({items:[],nextCursor:null,moreBusy:false,moreError:"",selected:null,response:"",coreReady:false,busy:false,actionError:"",notice:""});},
 onUnload(){this.onHide();},
 current(epoch:number,token:string){return this.visible&&epoch===this.epoch&&token===this.lastToken&&token===getApp<IAppOption>().globalData.sessionToken&&this.lastRevision===commerceContextRevision();},
 stopPolling(){if(this.timer!==null)clearInterval(this.timer);this.timer=null;},
 startPolling(){this.stopPolling();if(this.visible&&this.data.coreReady&&!this.data.moreBusy)this.timer=setInterval(()=>void this.load(true),6000);},
 invalidate(message:string){this.stopPolling();this.setData({items:[],nextCursor:null,moreBusy:false,moreError:"",selected:null,response:"",coreReady:false,busy:false,error:message});},
 async load(silent=false){
  if(!this.visible||this.readPending||(silent&&(this.data.busy||this.data.moreBusy)))return;
  if(silent&&!this.current(this.epoch,this.lastToken)){this.invalidate("身份已变化，请重新核验权限。");return;}
  if(!silent){cancelPageReads(this);this.stopPolling();this.epoch++;this.lastToken=getApp<IAppOption>().globalData.sessionToken;this.lastRevision=commerceContextRevision();this.setData({items:[],nextCursor:null,moreBusy:false,moreError:"",selected:null,response:"",coreReady:false,loading:true,error:"",actionError:""});}
  const epoch=this.epoch,token=this.lastToken;this.readPending=true;
  try{
   if(!token)throw {status:401};
   const authority=await authorityProjection(this);
   if(!this.current(epoch,token))return;
   if(authority.version!==1||!authority.managementAvailable||!hasCapability(authority,"privacy.request.manage"))throw {status:403};
   // Expanded pages retain their rows and draft, but never stop checking
   // revocable authority. Explicit refresh still reloads the queue from page 1.
   if(silent&&this.data.items.length>30)return;
   const page=await pageRead<PrivacyPage>(this,{path:"/v1/management/privacy-requests?page=1"});
   if(!this.current(epoch,token))return;
   const items=page.items.map(displayRow);
   const chosen=this.data.selected,latest=chosen?items.find(row=>row.id===chosen.id):null;
   const changed=chosen&&(!latest||latest.version!==chosen.version);
   this.setData({items,nextCursor:page.nextCursor,coreReady:true,error:"",...(changed?{selected:null,response:"",actionError:"受理记录已变化，请重新选择后查看最新结果。"}:{})});
  }catch(error){if(this.current(epoch,token))this.invalidate([401,403].includes((error as {status?:number})?.status??0)?"当前身份没有隐私受理权限，请返回管理中心或重试。":"受理记录暂时无法同步，请重试。");}
  finally{if(this.visible&&epoch===this.epoch){this.readPending=false;this.setData({loading:false});if(!this.current(epoch,token))this.invalidate("身份已变化，请重新核验权限。");else if(this.data.coreReady)this.startPolling();}}
 },
 async loadMore(){
  const cursor=this.data.nextCursor;if(!cursor||!this.visible||!this.data.coreReady||this.readPending||this.data.moreBusy||this.data.busy)return;
  this.stopPolling();const epoch=this.epoch,token=this.lastToken;this.data.moreBusy=true;this.setData({moreBusy:true,moreError:""});
  try{const page=await pageRead<PrivacyPage>(this,{path:`/v1/management/privacy-requests?page=1&cursor=${encodeURIComponent(cursor)}`});
   if(!this.current(epoch,token))return;
   const seen=new Set(this.data.items.map(row=>row.id));this.setData({items:[...this.data.items,...page.items.filter(row=>!seen.has(row.id)).map(displayRow)],nextCursor:page.nextCursor});
  }catch(error){if(!this.current(epoch,token))return;
   if([401,403].includes((error as {status?:number})?.status??0))this.invalidate("当前身份没有隐私受理权限，请返回管理中心或重试。");
   else this.setData({moreError:"后续请求加载失败，请重试。"});
  }finally{if(this.visible&&epoch===this.epoch){this.data.moreBusy=false;this.setData({moreBusy:false});if(!this.current(epoch,token))this.invalidate("身份已变化，请重新核验权限。");else if(this.data.coreReady)this.startPolling();}}
 },
 canAct(){return this.data.coreReady&&this.current(this.epoch,this.lastToken)&&!this.data.busy;},
 select(event:WechatMiniprogram.TouchEvent){if(!this.canAct())return;const row=this.data.items.find(row=>row.id===String(event.currentTarget.dataset.id||""));if(row)this.setData({selected:row,response:row.response||"",statusIndex:row.status==="responded"?(row.waitingOn==="member"?2:1):0,actionError:"",notice:""});},
 closeDetail(){if(this.canAct())this.setData({selected:null,response:"",actionError:""});},
 onResponse(event:WechatMiniprogram.Input){if(this.canAct())this.setData({response:event.detail.value,actionError:"",notice:""});},
 onStatus(event:WechatMiniprogram.PickerChange){if(this.canAct()){const index=Number(event.detail.value);this.setData({statusIndex:index>=0&&index<=2?index:0});}},
 async submit(){
  const row=this.data.selected;if(!this.canAct()||!row?.editable)return;
  const response=this.data.response.trim();if(!response||Array.from(response).length>4000){this.setData({actionError:"请填写不超过 4000 字的具体回复。"});return;}
  cancelPageReads(this);this.stopPolling();this.epoch++;this.readPending=false;const epoch=this.epoch,token=this.lastToken;this.setData({busy:true,actionError:"",notice:""});
  try{await request({path:`/v1/management/privacy-requests/${encodeURIComponent(row.id)}/response`,method:"POST",data:{status:this.data.statusIndex===0?"reviewing":"responded",waitingOn:this.data.statusIndex===2?"member":"operator",response,expectedVersion:row.version}});
   if(!this.current(epoch,token))return;this.setData({busy:false,selected:null,response:"",notice:this.data.statusIndex===2?"已请用户补充；收到回复后回到待办。":"回复已保存，请继续处理请求。"});await this.load();
  }catch(error){if(!this.current(epoch,token))return;const status=(error as {status?:number})?.status;
   if(status===401||status===403)this.invalidate("权限已失效，回复未获确认。请重新核验。");
   else if(status===409){this.setData({busy:false});await this.load();if(this.visible&&token===getApp<IAppOption>().globalData.sessionToken&&this.lastRevision===commerceContextRevision())this.setData({actionError:"记录已变化或回复已被接收，请查看最新内容后再操作。"});}
   else this.setData({actionError:"回复结果未确认，请刷新受理记录后核对；不要重复提交。",coreReady:false});
  }finally{if(this.visible&&epoch===this.epoch){this.setData({busy:false});if(!this.current(epoch,token))this.invalidate("身份已变化，请重新核验权限。");}}
 },
 retry(){if(!this.data.busy)void this.load();},
 back(){if(this.data.selected&&!this.data.busy){this.setData({selected:null,response:"",actionError:""});return;}wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management/index"})});}
});
