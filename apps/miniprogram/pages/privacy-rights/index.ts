import { request, resumeAuthentication, setSessionToken } from '../../services/api';
import { currentChromeStyle } from '../../services/layout';
import { clientOperationKey } from '../../services/orders';
const kinds=['access','correct','delete','close_account','withdraw','other'];
const labels=['查阅或复制个人信息','更正个人信息','删除个人信息','申请注销账号','撤回个人信息处理同意','其他隐私咨询'];
const closedKinds=kinds.filter(kind=>kind!=='close_account');
const closedLabels=labels.filter((_,index)=>kinds[index]!=='close_account');
const deleteScopes=['清除账户资料','申请处理其他数据'];
const statuses:Record<string,string>={received:'已受理',verifying:'身份核验中',reviewing:'处理中',approved:'处理中',executing:'处理中',completed:'已完成',partially_completed:'部分完成',failed:'处理未完成',rejected:'暂无法办理',canceled:'已取消',responded:'已回复'};
const executionStatuses:Record<string,string>={succeeded:'已处理',partially_succeeded:'部分资料已处理',failed:'处理遇到问题',expired:'副本已过期',canceled:'已取消'};
const deliveryStatuses:Record<string,string>={available:'数据副本可获取',revoked:'资料副本已撤销',expired:'资料副本已过期',removed:'资料副本已清理'};
const activeExportFiles=new Set<string>();
function exportFilePath(name='cisme-private-data-copy'){
 const directory=wx.env?.USER_DATA_PATH;
 if(!directory)throw new Error('PRIVATE_COPY_DIRECTORY_UNAVAILABLE');
 return `${directory}/${name}.json`;
}
function clearExportFile(path?:string){
 if(path)activeExportFiles.delete(path);
 if(!wx.env?.USER_DATA_PATH||!wx.getFileSystemManager)return;
 wx.getFileSystemManager().unlink({filePath:path??exportFilePath(),fail:()=>{/* Retry abandoned copies on the next page open. */}});
}
function clearAbandonedExportFiles(){
 if(!wx.env?.USER_DATA_PATH||!wx.getFileSystemManager)return;
 const fs=wx.getFileSystemManager();
 if(typeof fs?.readdir!=='function')return;
 fs.readdir({dirPath:wx.env.USER_DATA_PATH,success:result=>{
  for(const name of result.files){
   if(!/^cisme-private-data-copy-[a-z0-9-]+\.json$/.test(name))continue;
   const path=`${wx.env.USER_DATA_PATH}/${name}`;
   // A second page instance must not unlink a file still used by WeChat.
   if(!activeExportFiles.has(path))clearExportFile(path);
  }
 },fail:()=>{/* Retain other app files; never clear the entire directory. */}});
}
type PrivacyPage={items:any[];nextCursor:string|null};
function privacyToken():string {const data=getApp<IAppOption>().globalData;return data.sessionToken||data.privacyRightsToken||'';}
function displayRecord(r:any,closedRights=false){
 const delivery=closedRights&&r.execution?.scope==='member_profile_only'&&r.execution?.deliveryState==='available'
  ? '如需历史副本，请在本页提交请求'
  : r.execution?.scope==='member_profile_only'&&r.execution?.deliveryState==='available'
   ? '会员资料副本可查看'
   : deliveryStatuses[r.execution?.deliveryState]||'';
 const executionStatus=executionStatuses[r.execution?.status]||'';
 const scopeDetail=['member_profile_only','member_portable_copy_v1'].includes(r.execution?.scope)&&delivery?`；${delivery}`:
  r.execution?.scopeCode==='member_profile_handle_v1'&&r.execution.status==='partially_succeeded'?'；已清除自报微信号，其他资料仍保留':'';
 const response=typeof r.response==='string'?r.response.trim():'';
 return {...r,execution:closedRights&&r.execution?.scope==='member_profile_only'?{...r.execution,downloadAvailable:false}:r.execution,
  shortId:typeof r.id==='string'?r.id.slice(-6).toUpperCase():'',
  label:labels[kinds.indexOf(r.kind)]||'隐私请求',
  statusLabel:r.status==='responded'&&r.waitingOn==='member'?'请补充信息':statuses[r.status]||'状态待核对',
  executionSummary:executionStatus?`${executionStatus}${scopeDetail}`:'',
  responseSummary:response&&!r.replyHistory?.some((entry:{body?:string})=>entry.body?.trim()===response)?response:''};
}
Page({
 identityToken:'',
 hiddenRecords:[] as any[],hiddenRecordToken:'',hiddenNextCursor:null as string|null,
 actionBusy(){return this.data.busy||this.data.replyBusy||this.data.exportBusy;},
 onLoad(){clearExportFile();clearAbandonedExportFiles();},
 data:{chromeStyle:currentChromeStyle(),authenticated:false,closedRights:false,legalIdentity:null as null|{operator:string;version:string;contact:string},legalAttempt:0,labels,selected:0,deleteScopes,deleteScopeIndex:0,message:'',records:[] as any[],recordToken:'',nextCursor:null as string|null,loadingMore:false,moreError:'',busy:false,exportBusy:false,exportRequestId:'',loading:false,error:'',notice:'',alive:true,loadAttempt:0,operationAttempt:0,visibleExport:null as null|{requestId:string;displayName:string;wechatHandle:string},replyFor:'',replyDraft:'',replyKey:'',replyBusy:false,supportOpening:false,historicalBalance:null as null|{available:string;pending:string;held:string}},
 onShow(){this.data.alive=true;const token=privacyToken(),changed=token!==this.identityToken;
  if(changed)clearExportFile();
  this.identityToken=token;const closedRights=Boolean(getApp<IAppOption>().globalData.privacyRightsToken && !getApp<IAppOption>().globalData.sessionToken);
  const restore=this.hiddenRecordToken===token&&Boolean(token);
  this.setData({authenticated:Boolean(token),closedRights,labels:closedRights?closedLabels:labels,
    ...(restore?{records:this.hiddenRecords,recordToken:token,nextCursor:this.hiddenNextCursor}:{}),
    ...(changed?{selected:0,deleteScopeIndex:0,message:'',replyFor:'',replyDraft:'',replyKey:'',notice:'',error:''}:{}),
    busy:false,replyBusy:false,exportBusy:false,exportRequestId:'',supportOpening:false,historicalBalance:null});void this.loadLegalIdentity();void this.load();if(closedRights&&token)void this.loadHistoricalBalance(token);},
 onHide(){this.data.alive=false;this.data.legalAttempt+=1;this.data.loadAttempt+=1;this.data.operationAttempt+=1;
  this.hiddenRecordToken=this.data.recordToken;this.hiddenRecords=this.data.records;this.hiddenNextCursor=this.data.nextCursor;
  this.setData({visibleExport:null,records:[],recordToken:'',nextCursor:null,loading:false,loadingMore:false,moreError:'',busy:false,replyBusy:false,exportBusy:false,exportRequestId:'',supportOpening:false,historicalBalance:null});},
 onUnload(){this.data.alive=false;this.data.legalAttempt+=1;this.data.loadAttempt+=1;this.data.operationAttempt+=1;
  this.hiddenRecordToken='';this.hiddenRecords=[];this.hiddenNextCursor=null;},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 choose(e:WechatMiniprogram.PickerChange){if(this.actionBusy())return;this.setData({selected:Number(e.detail.value)});},
 chooseDeleteScope(e:WechatMiniprogram.PickerChange){if(this.actionBusy())return;this.setData({deleteScopeIndex:Number(e.detail.value),error:''});},
 input(e:WechatMiniprogram.TextareaInput){if(this.actionBusy())return;this.setData({message:e.detail.value});},
 login(){resumeAuthentication('/pages/privacy-rights/index');},
 openSupport(){
  if(this.data.supportOpening)return;
  if(Boolean(getApp<IAppOption>().globalData.privacyRightsToken && !getApp<IAppOption>().globalData.sessionToken)){this.setData({notice:'可在本页提交历史事项，工作人员会在受理记录回复。'});return;}
  if(!getApp<IAppOption>().globalData.sessionToken){resumeAuthentication('/pages/support/index');return;}
  this.setData({supportOpening:true,error:''});
  wx.navigateTo({url:'/pages/support/index',fail:()=>this.setData({supportOpening:false,error:'客服暂时无法打开，请重试。'})});
 },
 openHistoricalOrders(){
  if(!this.data.closedRights||!privacyToken())return;
  wx.navigateTo({url:'/pages/orders/index',fail:()=>this.setData({error:'历史订单暂时无法打开，请重试。'})});
 },
 async loadHistoricalBalance(token:string){
  try{
   const status=await request<{commission:{availableCents:number;pendingCents:number;paymentHeldCents:number;currency:string}}>({path:'/v1/me/commercial-membership'});
   if(!this.data.alive||!this.data.closedRights||token!==privacyToken())return;
   const amounts=status.commission;
   if(amounts?.currency!=='CNY'||![amounts.availableCents,amounts.pendingCents,amounts.paymentHeldCents].every(value=>Number.isSafeInteger(value)&&value>=0))return;
   if(amounts.availableCents+amounts.pendingCents+amounts.paymentHeldCents===0)return;
   this.setData({historicalBalance:{available:(amounts.availableCents/100).toFixed(2),pending:(amounts.pendingCents/100).toFixed(2),held:(amounts.paymentHeldCents/100).toFixed(2)}});
  }catch{/* The rights request and historical orders remain available. */}
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
  this.setData({loading:true,error:'',...(this.data.recordToken!==token?{records:[],nextCursor:null}:{}),recordToken:token,loadingMore:false,moreError:''});
  try{const page=await request<PrivacyPage>({path:'/v1/me/privacy-requests?page=1'});if(this.data.alive && attempt===this.data.loadAttempt && token===privacyToken())this.setData({records:page.items.map(r=>displayRecord(r,this.data.closedRights)),nextCursor:page.nextCursor});}
  catch(e){if(this.data.alive && attempt===this.data.loadAttempt && token===privacyToken())this.setData({...([401,403,404].includes((e as {status?:number})?.status??0)?{records:[],recordToken:'',nextCursor:null,visibleExport:null}:{}),error:(e as {title?:string}).title||'受理记录加载失败，请重试。'});}
  finally{if(this.data.alive && attempt===this.data.loadAttempt)this.setData({loading:false,...(token!==privacyToken()?{records:[],recordToken:'',nextCursor:null,visibleExport:null,error:'账号已切换，请重新加载记录。'}:{})});}
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
  if(this.actionBusy())return;
  const kind=(this.data.closedRights?closedKinds:kinds)[this.data.selected];
  const optionalProfileDelete=kind==='delete'&&!this.data.closedRights&&this.data.deleteScopeIndex===0;
  if(kind!=='close_account'&&!optionalProfileDelete&&!this.data.message.trim()){this.setData({error:'请填写需要协助的事项。'});return;}
  const token=privacyToken(),attempt=++this.data.operationAttempt;
  if(kind==='close_account'||optionalProfileDelete){
   this.setData({busy:true,error:''});
   const confirmed=await new Promise<boolean>(resolve=>wx.showModal({
    title:optionalProfileDelete?'删除账户资料':'注销账号',
    content:optionalProfileDelete?'昵称、手机号、头像和地址将清除；交易及售后记录按必要期限保留。账号仍可使用。':'注销后将退出当前账号。交易及售后记录按必要期限留存；您仍可核验微信身份处理历史隐私请求。',
    confirmText:optionalProfileDelete?'确认删除':'确认注销',confirmColor:'#6b3975',
    success:result=>resolve(result.confirm),fail:()=>resolve(false)}));
   if(!confirmed||!this.data.alive||attempt!==this.data.operationAttempt||token!==privacyToken()){if(this.data.alive&&attempt===this.data.operationAttempt)this.setData({busy:false});return;}
  }
  this.setData({busy:true,error:'',notice:''});
  try{const result=await request<{accountClosed?:boolean;status?:string}>({path:'/v1/me/privacy-requests',method:'POST',
   data:{kind,message:kind==='close_account'?'本人申请注销 CISME 账号':optionalProfileDelete?'删除可清除的账户资料':this.data.message,
    ...(optionalProfileDelete?{scopeCode:'member_optional_profile_v1'}:{})}});
   if(this.data.alive && attempt===this.data.operationAttempt && token===privacyToken()){
    if(result.accountClosed){setSessionToken('');this.identityToken='';this.setData({authenticated:false,closedRights:false,records:[],message:'',busy:false,notice:'账号已注销。交易和售后记录按必要期限保留；历史资料仍可核验身份后申请处理。'});return;}
    this.setData({message:'',notice:result.status==='completed'?'账户资料已处理，可在下方查看结果。':'请求已受理，进度可在下方查看。'});await this.load();}}
  catch(e){if(this.data.alive && attempt===this.data.operationAttempt && token===privacyToken())this.setData({error:(e as {title?:string}).title||'尚未确认提交结果，请刷新受理记录后再试。'});}
  finally{if(this.data.alive && attempt===this.data.operationAttempt && token===privacyToken())this.setData({busy:false});}
 },
 startReply(e:WechatMiniprogram.BaseEvent){
  if(this.actionBusy())return;
  const id=String(e.currentTarget.dataset.id||''),row=this.data.records.find((item:any)=>item.id===id);
  if(row?.status==='responded'&&row.waitingOn==='member')this.setData({replyFor:id,replyDraft:'',replyKey:'',error:'',notice:''});
 },
 editReply(e:WechatMiniprogram.TextareaInput){if(!this.data.replyBusy)this.setData({replyDraft:e.detail.value,replyKey:'',error:''});},
 cancelReply(){if(!this.data.replyBusy)this.setData({replyFor:'',replyDraft:'',replyKey:''});},
 async sendReply(){
  if(this.actionBusy()||!this.data.replyFor)return;
  const row=this.data.records.find((item:any)=>item.id===this.data.replyFor);
  if(!row||row.status!=='responded'||row.waitingOn!=='member')return;
  const message=this.data.replyDraft.trim();
  if(!message||Array.from(message).length>2000){this.setData({error:'请填写不超过 2000 字的补充说明。'});return;}
  const token=privacyToken(),attempt=++this.data.operationAttempt,id=row.id as string,
    key=this.data.replyKey||clientOperationKey('privacy-reply');
  this.setData({replyBusy:true,replyKey:key,error:'',notice:''});
  try{await request({path:`/v1/me/privacy-requests/${encodeURIComponent(id)}/reply`,method:'POST',
    idempotencyKey:key,data:{message,expectedVersion:row.version}});
   if(this.data.alive&&attempt===this.data.operationAttempt&&token===privacyToken()){
    this.setData({replyFor:'',replyDraft:'',replyKey:'',notice:'补充信息已收到，工作人员会继续处理。'});await this.load();}}
  catch(e){if(this.data.alive&&attempt===this.data.operationAttempt&&token===privacyToken())
    this.setData({error:(e as {title?:string}).title||'结果暂未确认，请刷新记录核对；若仍待补充，可重试原内容。'});}
  finally{if(this.data.alive&&attempt===this.data.operationAttempt&&token===privacyToken())this.setData({replyBusy:false});}
 },
 async viewExport(e:WechatMiniprogram.BaseEvent){
  if(this.actionBusy())return;
  const requestId=String(e.currentTarget.dataset.id||'');
  const row=this.data.records.find((item:any)=>item.id===requestId);
  if(!row?.execution?.downloadAvailable)return;
  const token=privacyToken();
  const attempt=++this.data.operationAttempt;
  this.setData({visibleExport:null,error:'',exportBusy:true,exportRequestId:requestId});
  let filePath:string|undefined;
  try{
   const archive=await request<any>({path:`/v1/me/privacy-requests/${requestId}/export`});
   if(!this.data.alive||attempt!==this.data.operationAttempt||token!==privacyToken())return;
   if(row.execution.scope==='member_portable_copy_v1'&&archive?.schema==='cisme.member.portable.v1'){
    const fs=wx.getFileSystemManager();
    const currentPath=exportFilePath(clientOperationKey('cisme-private-data-copy'));
    filePath=currentPath;activeExportFiles.add(currentPath);
    await new Promise<void>((resolve,reject)=>fs.writeFile({filePath:currentPath,data:JSON.stringify(archive),
      encoding:'utf8',success:()=>resolve(),fail:reject}));
    if(!this.data.alive||attempt!==this.data.operationAttempt||token!==privacyToken()){
      clearExportFile(filePath);return;
    }
    await new Promise<void>((resolve,reject)=>wx.shareFileMessage({filePath:currentPath,
      fileName:`CISME-个人信息副本-${requestId.slice(-6)}.json`,success:()=>resolve(),fail:reject,
      complete:()=>clearExportFile(filePath)}));
    if(this.data.alive&&attempt===this.data.operationAttempt&&token===privacyToken())
      this.setData({notice:'数据副本已交给微信，请在接收会话查看。'});
   }else if(archive?.scope==='member_profile_only'){
    this.setData({visibleExport:{requestId,displayName:archive.member.displayName,wechatHandle:archive.profile?.wechatHandle||'未填写'}});
   }else throw new Error('EXPORT_SCOPE_UNEXPECTED');
  }catch(e){if(filePath)clearExportFile(filePath);if(this.data.alive&&attempt===this.data.operationAttempt&&token===privacyToken())this.setData({error:(e as {title?:string}).title||'资料副本暂不可读取，请刷新记录后重试。'});}
  finally{if(this.data.alive&&attempt===this.data.operationAttempt&&token===privacyToken())this.setData({exportBusy:false,exportRequestId:''});}
 },
 async revokeExport(e:WechatMiniprogram.BaseEvent){
  if(this.actionBusy())return;
  const requestId=String(e.currentTarget.dataset.id||'');
  if(!this.data.records.some((row:any)=>row.id===requestId&&row.execution?.downloadAvailable))return;
  const token=privacyToken(),attempt=++this.data.operationAttempt;
  this.setData({exportBusy:true,exportRequestId:requestId,error:''});
  try{
   const confirmation=await new Promise<boolean>(resolve=>wx.showModal({title:'撤销副本访问？',
    content:'撤销后不能再从小程序获取这份副本。已发送的文件不会被收回，原始资料不会删除。',
    confirmText:'撤销访问',success:result=>resolve(result.confirm),fail:()=>resolve(false)}));
   if(!confirmation||!this.data.alive||attempt!==this.data.operationAttempt||token!==privacyToken())return;
   await request({path:`/v1/me/privacy-requests/${requestId}/export-revoke`,method:'POST'});
   if(!this.data.alive||attempt!==this.data.operationAttempt||token!==privacyToken())return;
   this.setData({visibleExport:null,notice:'副本访问已撤销，已发送的文件和原始资料不受影响。'});
   await this.load();
  }catch(e){if(this.data.alive&&attempt===this.data.operationAttempt&&token===privacyToken())this.setData({error:(e as {title?:string}).title||'撤销结果尚未确认，请刷新记录后重试。'});}
  finally{if(this.data.alive&&attempt===this.data.operationAttempt&&token===privacyToken())this.setData({exportBusy:false,exportRequestId:''});}
 },
 async retryExport(e:WechatMiniprogram.BaseEvent){
  if(this.actionBusy())return;
  const requestId=String(e.currentTarget.dataset.id||'');
  const row=this.data.records.find((item:any)=>item.id===requestId);
  if(!row||row.status!=='failed'||row.execution?.scope!=='member_portable_copy_v1')return;
  const token=privacyToken(),attempt=++this.data.operationAttempt;
  this.setData({error:'',notice:'',exportBusy:true,exportRequestId:requestId});
  try{
   await request({path:`/v1/me/privacy-requests/${requestId}/export-retry`,method:'POST'});
   if(this.data.alive&&attempt===this.data.operationAttempt&&token===privacyToken()){
    this.setData({notice:'已重新开始生成副本，请稍后刷新记录。'});await this.load();
   }
  }catch(e){if(this.data.alive&&attempt===this.data.operationAttempt&&token===privacyToken())
    this.setData({error:(e as {title?:string}).title||'重试结果暂未确认，请刷新记录。'});}
  finally{if(this.data.alive&&attempt===this.data.operationAttempt&&token===privacyToken())this.setData({exportBusy:false,exportRequestId:''});}
 },
 copyRequestId(e:WechatMiniprogram.BaseEvent){
  const id=String(e.currentTarget.dataset.id||'');
  if(!this.data.records.some((row:any)=>row.id===id))return;
  wx.setClipboardData({data:id,success:()=>this.setData({notice:'申请编号已复制。'}),fail:()=>this.setData({error:'复制失败，请稍后重试。'})});
 },
 back(){wx.navigateBack({fail:()=>wx.switchTab({url:'/pages/community/index'})});}
});
