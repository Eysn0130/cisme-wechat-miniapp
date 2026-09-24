import { request, resumeAuthentication, setSessionToken } from '../../services/api';
import { currentChromeStyle } from '../../services/layout';
import { clientOperationKey } from '../../services/orders';
const kinds=['access','correct','delete','close_account','withdraw','other'];
const labels=['查阅或复制个人信息','更正个人信息','删除个人信息','申请注销账号','撤回个人信息处理同意','其他隐私咨询'];
const closedKinds=kinds.filter(kind=>kind!=='close_account');
const closedLabels=labels.filter((_,index)=>kinds[index]!=='close_account');
const statuses:Record<string,string>={received:'已受理',verifying:'身份核验中',reviewing:'处理中',approved:'待执行',executing:'正在执行',completed:'已完成',partially_completed:'部分完成',rejected:'未批准',canceled:'已取消',responded:'已回复，待处理'};
const executionStatuses:Record<string,string>={planned:'已建立计划，尚未执行',approved:'已复核待执行',running:'正在执行',succeeded:'执行成功',partially_succeeded:'部分执行成功',failed:'执行失败待处理',expired:'导出已过期',canceled:'计划已取消'};
const deliveryStatuses:Record<string,string>={available:'会员资料副本可查看',revoked:'资料副本已撤销',expired:'资料副本已过期',removed:'资料副本已清理'};
type PrivacyPage={items:any[];nextCursor:string|null};
function privacyToken():string {const data=getApp<IAppOption>().globalData;return data.sessionToken||data.privacyRightsToken||'';}
function displayRecord(r:any,closedRights=false){
 const delivery=closedRights&&r.execution?.deliveryState==='available'
  ? '如需历史副本，请在本页提交请求'
  : deliveryStatuses[r.execution?.deliveryState]||'仅会员资料子集，完整导出仍待处理';
 return {...r,execution:closedRights&&r.execution?{...r.execution,downloadAvailable:false}:r.execution,
  label:labels[kinds.indexOf(r.kind)]||'隐私请求',
  statusLabel:r.status==='responded'&&r.waitingOn==='member'?'请补充信息':statuses[r.status]||'状态待核对',
  executionSummary:r.execution?`${r.execution.type==='export'?'数据副本':'数据处理'}：${executionStatuses[r.execution.status]||'状态待核对'}${r.execution.scope==='member_profile_only'?'；'+delivery:''}${r.execution.scopeCode==='member_profile_handle_v1'&&r.execution.status==='partially_succeeded'?'；仅清除自报微信号，其他资料未删除':''}`:''};
}
Page({
 data:{chromeStyle:currentChromeStyle(),authenticated:false,closedRights:false,legalIdentity:null as null|{operator:string;version:string;contact:string},legalAttempt:0,labels,selected:0,message:'',records:[] as any[],recordToken:'',nextCursor:null as string|null,loadingMore:false,moreError:'',busy:false,loading:false,error:'',notice:'',alive:true,loadAttempt:0,operationAttempt:0,visibleExport:null as null|{requestId:string;displayName:string;wechatHandle:string},replyFor:'',replyDraft:'',replyKey:'',replyBusy:false,supportOpening:false},
 onShow(){this.data.alive=true;const closedRights=Boolean(getApp<IAppOption>().globalData.privacyRightsToken && !getApp<IAppOption>().globalData.sessionToken);
  this.setData({authenticated:Boolean(privacyToken()),closedRights,labels:closedRights?closedLabels:labels,selected:0,supportOpening:false});void this.loadLegalIdentity();void this.load();},
 onHide(){this.data.alive=false;this.data.legalAttempt+=1;this.data.loadAttempt+=1;this.data.operationAttempt+=1;this.setData({visibleExport:null,records:[],recordToken:'',nextCursor:null,loadingMore:false,moreError:'',replyFor:'',replyDraft:'',replyKey:'',replyBusy:false});},
 onUnload(){this.data.alive=false;this.data.legalAttempt+=1;this.data.loadAttempt+=1;this.data.operationAttempt+=1;},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 choose(e:WechatMiniprogram.PickerChange){this.setData({selected:Number(e.detail.value)});},
 input(e:WechatMiniprogram.TextareaInput){this.setData({message:e.detail.value});},
 login(){resumeAuthentication('/pages/privacy-rights/index');},
 openSupport(){
  if(this.data.supportOpening)return;
  if(Boolean(getApp<IAppOption>().globalData.privacyRightsToken && !getApp<IAppOption>().globalData.sessionToken)){this.setData({notice:'可在本页提交历史事项，工作人员会在受理记录回复。'});return;}
  if(!getApp<IAppOption>().globalData.sessionToken){resumeAuthentication('/pages/support/index');return;}
  this.setData({supportOpening:true,error:''});
  wx.navigateTo({url:'/pages/support/index',fail:()=>this.setData({supportOpening:false,error:'客服暂时无法打开，请重试。'})});
 },
 async loadLegalIdentity(){
  const attempt=++this.data.legalAttempt;
  this.setData({legalIdentity:null});
  try{
   const result=await request<{documents:Array<{document_type:string;operator_name:string;version:string;contact:string}>}>({path:'/v1/legal',authMode:'public'});
   if(!this.data.alive||attempt!==this.data.legalAttempt)return;
   const privacy=result.documents.find(doc=>doc.document_type==='privacy');
   if(privacy)this.setData({legalIdentity:{operator:privacy.operator_name,version:privacy.version,contact:privacy.contact}});
  }catch{/* Existing rights records and contact actions remain available. */}
 },
 async load(){
  if(!this.data.authenticated){this.setData({records:[],recordToken:'',nextCursor:null});return;}
  const attempt=++this.data.loadAttempt;
  const token=privacyToken();
  this.setData({loading:true,error:'',records:[],recordToken:token,nextCursor:null,loadingMore:false,moreError:''});
  try{const page=await request<PrivacyPage>({path:'/v1/me/privacy-requests?page=1'});if(this.data.alive && attempt===this.data.loadAttempt && token===privacyToken())this.setData({records:page.items.map(r=>displayRecord(r,this.data.closedRights)),nextCursor:page.nextCursor});}
  catch(e){if(this.data.alive && attempt===this.data.loadAttempt && token===privacyToken())this.setData({error:(e as {title?:string}).title||'受理记录加载失败，请重试。'});}
  finally{if(this.data.alive && attempt===this.data.loadAttempt && token===privacyToken())this.setData({loading:false});}
 },
 async loadMore(){
  const cursor=this.data.nextCursor;if(!cursor||this.data.loading||this.data.loadingMore||!this.data.authenticated)return;
  const attempt=this.data.loadAttempt,token=privacyToken();
  if(token!==this.data.recordToken){this.setData({records:[],recordToken:'',nextCursor:null,visibleExport:null,error:'身份已变化，请刷新后查看自己的记录。'});return;}
  this.setData({loadingMore:true,moreError:''});
  try{const page=await request<PrivacyPage>({path:`/v1/me/privacy-requests?page=1&cursor=${encodeURIComponent(cursor)}`});
   if(this.data.alive&&attempt===this.data.loadAttempt&&token===privacyToken()){const seen=new Set(this.data.records.map((r:any)=>r.id));this.setData({records:[...this.data.records,...page.items.filter(r=>!seen.has(r.id)).map(r=>displayRecord(r,this.data.closedRights))],nextCursor:page.nextCursor});}}
  catch(e){if(this.data.alive&&attempt===this.data.loadAttempt&&token===privacyToken())this.setData({moreError:(e as {title?:string}).title||'后续记录加载失败，请重试。'});}
  finally{if(this.data.alive&&attempt===this.data.loadAttempt){if(token!==privacyToken())this.setData({records:[],recordToken:'',nextCursor:null,visibleExport:null,loadingMore:false,error:'身份已变化，请刷新后查看自己的记录。'});else this.setData({loadingMore:false});}}
 },
 async submit(){
  if(this.data.busy)return;
  const kind=(this.data.closedRights?closedKinds:kinds)[this.data.selected];
  if(kind!=='close_account'&&!this.data.message.trim()){this.setData({error:'请填写需要协助的事项。'});return;}
  if(kind==='close_account'){
   const confirmed=await new Promise<boolean>(resolve=>wx.showModal({title:'注销账号',
    content:'注销后将退出当前账号。交易及售后记录按必要期限留存；您仍可核验微信身份处理历史隐私请求。',
    confirmText:'确认注销',confirmColor:'#6b3975',success:result=>resolve(result.confirm),fail:()=>resolve(false)}));
   if(!confirmed)return;
  }
  const token=privacyToken();
  this.setData({busy:true,error:'',notice:''});
  try{const result=await request<{accountClosed?:boolean}>({path:'/v1/me/privacy-requests',method:'POST',data:{kind,message:kind==='close_account'?'本人申请注销 CISME 账号':this.data.message}});
   if(this.data.alive && token===privacyToken()){
    if(result.accountClosed){setSessionToken('');this.setData({authenticated:false,closedRights:false,records:[],message:'',busy:false,notice:'账号已注销。需要处理历史资料时，可重新核验微信身份。'});return;}
    this.setData({message:'',notice:'请求已受理，进度可在下方查看。'});await this.load();}}
  catch(e){if(this.data.alive && token===privacyToken())this.setData({error:(e as {title?:string}).title||'尚未确认提交结果，请刷新受理记录后再试。'});}
  finally{if(this.data.alive && token===privacyToken())this.setData({busy:false});}
 },
 startReply(e:WechatMiniprogram.BaseEvent){
  if(this.data.replyBusy)return;
  const id=String(e.currentTarget.dataset.id||''),row=this.data.records.find((item:any)=>item.id===id);
  if(row?.status==='responded'&&row.waitingOn==='member')this.setData({replyFor:id,replyDraft:'',replyKey:'',error:'',notice:''});
 },
 editReply(e:WechatMiniprogram.TextareaInput){if(!this.data.replyBusy)this.setData({replyDraft:e.detail.value,replyKey:'',error:''});},
 cancelReply(){if(!this.data.replyBusy)this.setData({replyFor:'',replyDraft:'',replyKey:''});},
 async sendReply(){
  if(this.data.replyBusy||!this.data.replyFor)return;
  const row=this.data.records.find((item:any)=>item.id===this.data.replyFor);
  if(!row||row.status!=='responded'||row.waitingOn!=='member')return;
  const message=this.data.replyDraft.trim();
  if(!message||Array.from(message).length>2000){this.setData({error:'请填写不超过 2000 字的补充说明。'});return;}
  const token=privacyToken(),id=row.id as string,
    key=this.data.replyKey||clientOperationKey('privacy-reply');
  this.setData({replyBusy:true,replyKey:key,error:'',notice:''});
  try{await request({path:`/v1/me/privacy-requests/${encodeURIComponent(id)}/reply`,method:'POST',
    idempotencyKey:key,data:{message,expectedVersion:row.version}});
   if(this.data.alive&&token===privacyToken()){
    this.setData({replyFor:'',replyDraft:'',replyKey:'',notice:'补充信息已收到，工作人员会继续处理。'});await this.load();}}
  catch(e){if(this.data.alive&&token===privacyToken())
    this.setData({error:(e as {title?:string}).title||'结果暂未确认，请刷新记录核对；若仍待补充，可重试原内容。'});}
  finally{if(this.data.alive&&token===privacyToken())this.setData({replyBusy:false});}
 },
 async viewExport(e:WechatMiniprogram.BaseEvent){
  const requestId=String(e.currentTarget.dataset.id||'');
  const token=privacyToken();
  const attempt=++this.data.operationAttempt;
  this.setData({visibleExport:null,error:''});
  try{
   const archive=await request<{scope:string;member:{displayName:string};profile:{wechatHandle:string|null}|null}>({path:`/v1/me/privacy-requests/${requestId}/export`});
   if(!this.data.alive||attempt!==this.data.operationAttempt||token!==privacyToken())return;
   if(archive.scope!=='member_profile_only')throw new Error('EXPORT_SCOPE_UNEXPECTED');
   this.setData({visibleExport:{requestId,displayName:archive.member.displayName,wechatHandle:archive.profile?.wechatHandle||'未填写'}});
  }catch(e){if(this.data.alive&&attempt===this.data.operationAttempt&&token===privacyToken())this.setData({error:(e as {title?:string}).title||'资料副本暂不可读取，请刷新记录后重试。'});}
 },
 async revokeExport(e:WechatMiniprogram.BaseEvent){
  const requestId=String(e.currentTarget.dataset.id||'');
  const token=privacyToken();
  const attempt=++this.data.operationAttempt;
  const confirmation=await new Promise<boolean>(resolve=>wx.showModal({title:'撤销这份资料副本？',content:'撤销后该副本将无法再次查看；原始会员资料不会因此删除。',confirmText:'撤销副本',success:result=>resolve(result.confirm),fail:()=>resolve(false)}));
  if(!confirmation||!this.data.alive||attempt!==this.data.operationAttempt||token!==privacyToken())return;
  try{
   await request({path:`/v1/me/privacy-requests/${requestId}/export-revoke`,method:'POST'});
   if(!this.data.alive||attempt!==this.data.operationAttempt||token!==privacyToken())return;
   this.setData({visibleExport:null,notice:'这份资料副本已撤销；原始资料未因此删除。'});
   await this.load();
  }catch(e){if(this.data.alive&&attempt===this.data.operationAttempt&&token===privacyToken())this.setData({error:(e as {title?:string}).title||'撤销结果尚未确认，请刷新记录后重试。'});}
 },
 back(){wx.navigateBack({fail:()=>wx.switchTab({url:'/pages/community/index'})});}
});
