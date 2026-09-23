import { authorityProjection, type Capability } from '../../services/authority';
import { request, requireMemberAccess } from '../../services/api';
import { pageRead, cancelPageReads } from '../../services/page-requests';
import { currentChromeStyle } from '../../services/layout';
import { clientOperationKey } from '../../services/orders';
import { commerceContextRevision } from '../../services/commerce-command-store';
import { centsToYuan } from '../../services/commerce';
const caps:Capability[]=['commerce.aftersale.review','commerce.return.receive','commerce.return.inspect'];
const labels:Record<string,string>={requested:'申请已收到',need_info:'请补充信息',awaiting_instruction:'待客服发送退货指引',awaiting_return:'请按本案指引寄回',return_in_transit:'退货运输中',return_received:'已收件，待质检',quality_checked:'已质检，待核对退款',refund_exception_approved:'无需寄回，待退款审批',refund_pending:'退款处理中',rejected:'申请未通过',cancelled:'已撤回'};
const actions:Record<string,string>={cancel:'撤回申请',provide_info:'提交补充说明',report_old_route:'已按旧版指引寄出，联系客服协助',ship_return:'登记退货运单',request_info:'请用户补充说明',reject:'不予受理并说明',approve_return:'确认需寄回核对',approve_refund_without_return:'核对无需寄回例外',receive_return:'确认实际收到退货',inspect_return:'记录质检结果',request_refund:'转入独立退款审批',reopen_refund:'恢复原售后案件'};
type ReturnInstruction={version:number;recipientName:string;phone:string;region:string;address:string;freightPayer:string;instructions:string;issuedAt?:string};
type Row={id:string;orderId:string;state:string;kind:string;version:number;reason:string;claimBasis:string;supportConversationId:string|null;requestedAt:string;amountCents:number;resolved:boolean;refund:any;returnDestination:ReturnInstruction|null;returnInstructionHistory?:ReturnInstruction[];returnCarrier:string|null;returnTracking:string|null;shippedInstructionVersion:number|null;returnRouteReviewRequired:boolean;qualityResult:string|null;exceptionResolution:null|{kind:string;evidenceReference:string;approvedAt:string};lines:any[];events?:any[];historyTruncated?:boolean;label?:string;amountLabel?:string};
Page({
 visible:false,epoch:0,token:'',revision:-1,timer:null as ReturnType<typeof setInterval>|null,
 pending:null as {key:string;path:string;data:Record<string,unknown>}|null,selection:'',
 data:{chromeStyle:currentChromeStyle(),management:false,orderId:'',items:[] as Row[],selected:null as Row|null,nextCursor:null as string|null,capabilities:[] as Capability[],
  loading:true,busy:false,coreReady:false,error:'',notice:'',note:'',carrier:'',tracking:'',shipmentIndex:0,shipmentOptions:[] as string[],shipmentInstruction:null as ReturnInstruction|null,qualityIndex:0,kindIndex:0,basisIndex:0,
  exceptionIndex:0,exceptionEvidence:'',exceptionOptions:['请选择无法寄回的情形','物流丢件','漏发商品','承运商拦截退回','确实无法合理寄回'],
  kindOptions:['仅退款','退货退款'],basisOptions:['请选择问题类型','七日无理由','商品问题','错发','漏发','物流问题','其他'],
  qualityOptions:['请选择质检结果','可售','不可售'],available:[] as {action:string;label:string}[],needsReconcile:false,reconciliationReady:false,locked:false},
 onLoad(options:Record<string,string>){this.selection=/^[0-9a-f-]{36}$/i.test(options.caseId??'')?options.caseId!:'';
  this.setData({management:options.mode==='management',orderId:/^[0-9a-f-]{36}$/i.test(options.orderId??'')?options.orderId!:''});},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 onShow(){this.visible=true;return this.load();},
 onHide(){this.visible=false;this.epoch++;this.stop();cancelPageReads(this);if(this.pending)this.setData({needsReconcile:true});this.pending=null;this.setData({reconciliationReady:false});this.clear();},
 onUnload(){this.onHide();},
 current(epoch?:number,token?:string){epoch ??= this.epoch;token ??= this.token;return this.visible&&this.epoch===epoch&&this.token===token&&token===getApp<IAppOption>().globalData.sessionToken&&this.revision===commerceContextRevision();},
 canAct(){return this.current()&&this.data.coreReady&&!this.data.busy&&!this.data.loading;},
 stop(){if(this.timer!==null)clearInterval(this.timer);this.timer=null;},
 clear(){this.setData({items:[],selected:null,nextCursor:null,capabilities:[],available:[],note:'',carrier:'',tracking:'',shipmentIndex:0,shipmentOptions:[],shipmentInstruction:null,qualityIndex:0,basisIndex:0,exceptionIndex:0,exceptionEvidence:'',coreReady:false,busy:false,locked:false});},
 deny(message:string){this.stop();cancelPageReads(this);if(this.pending)this.setData({needsReconcile:true});this.pending=null;this.clear();this.setData({error:message});},
 base(){return this.data.management?'/v1/management/aftersales':'/v1/me/aftersales';},
 normalize(row:Row){return {...row,label:row.resolved?'退款已由渠道核验成功':row.refund?.reviewState==='rejected'?'退款审批未通过，待核对':row.refund?.channelState==='closed'?'退款已关闭，待恢复':row.refund?.channelState==='abnormal'?'退款异常，待核对':row.returnRouteReviewRequired?(row.returnTracking?'旧版指引寄件，待客服核对':'已寄出，待补运单与客服核对'):labels[row.state]??'待核验',amountLabel:centsToYuan(row.amountCents)};},
 selectActions(row:Row){const out:string[]=[];
  if(this.data.management){
   if(this.data.capabilities.includes('commerce.aftersale.review')){
    if(row.state==='requested')out.push('request_info','reject',row.kind==='return_refund'?'approve_return':'request_refund');
    if(['requested','need_info','awaiting_instruction','awaiting_return','return_in_transit'].includes(row.state)
      &&(row.kind==='return_refund'||['delivery_issue','missing_item'].includes(row.claimBasis)))out.push('approve_refund_without_return');
    if(row.state==='need_info')out.push('reject');
    if(['quality_checked','refund_exception_approved'].includes(row.state))out.push('request_refund');
    if(row.state==='refund_pending'&&(row.refund?.reviewState==='rejected'||row.refund?.channelState==='closed'))out.push('reopen_refund');
   }
   if(row.state==='return_in_transit'&&this.data.capabilities.includes('commerce.return.receive'))out.push('receive_return');
   if(row.state==='return_received'&&this.data.capabilities.includes('commerce.return.inspect'))out.push('inspect_return');
  }else{
   if(['requested','need_info','awaiting_instruction','awaiting_return'].includes(row.state)&&row.shippedInstructionVersion==null)out.push('cancel');
   if(row.state==='need_info')out.push('provide_info');
   if(row.state==='awaiting_return'){
    if(row.shippedInstructionVersion==null&&Number(row.returnDestination?.version)>1)out.push('report_old_route');
    out.push('ship_return');
   }
  }
  return out.map(action=>({action,label:actions[action]!}));
 },
 async recheck(){if(!this.visible||this.data.loading||this.data.busy)return;if(!this.current()){this.deny('身份已变化，请重新核验。');return;}
  if(!this.data.management||!this.data.coreReady)return;const epoch=this.epoch,token=this.token;
  try{const a=await authorityProjection(this);if(!this.current(epoch,token))return;
   if(a.version!==1||!a.managementAvailable||!caps.some(c=>a.capabilities.includes(c)))throw Error();
   this.setData({capabilities:a.capabilities});if(this.data.selected)this.setData({available:this.selectActions(this.data.selected)});
  }catch{if(this.current(epoch,token))this.deny('售后权限暂不可用，请重新核验。');}
 },
 async load(next=false){if(!this.visible||this.data.busy)return;if(!requireMemberAccess()){this.deny('请先确认身份。');this.setData({loading:false});return;}
  const cursor=next?this.data.nextCursor:null;if(next&&!cursor)return;
  this.stop();cancelPageReads(this);const epoch=++this.epoch,token=getApp<IAppOption>().globalData.sessionToken;this.token=token;this.revision=commerceContextRevision();
  this.setData({loading:true,coreReady:false,error:'',items:[],selected:null,nextCursor:null,available:[],qualityIndex:this.pending?this.data.qualityIndex:0});
  try{
   if(this.data.management){const a=await authorityProjection(this);if(!this.current(epoch,token))return;if(a.version!==1||!a.managementAvailable||!caps.some(c=>a.capabilities.includes(c)))throw {status:403};this.setData({capabilities:a.capabilities});}
   const page=await pageRead<{items:Row[];nextCursor:string|null}>(this,{path:`${this.base()}?limit=20${this.data.orderId?`&orderId=${this.data.orderId}`:''}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`});
   if(!this.current(epoch,token))return;
   this.setData({items:page.items.map(r=>this.normalize(r)),nextCursor:page.nextCursor,coreReady:true,reconciliationReady:true});
   if(this.selection){const selected=await pageRead<Row>(this,{path:`${this.base()}/${this.selection}`});if(!this.current(epoch,token))return;
    const history=selected.returnInstructionHistory??[],recorded=history.findIndex(item=>item.version===selected.shippedInstructionVersion),
      shipmentIndex=recorded>=0?recorded:Math.min(this.data.shipmentIndex,Math.max(0,history.length-1));
    this.setData({selected:this.normalize(selected),available:this.selectActions(selected),shipmentIndex,
      shipmentOptions:history.map(item=>`第 ${item.version} 版 · ${item.region} ${item.address}`),shipmentInstruction:history[shipmentIndex]??null});}
  }catch(e){if(this.current(epoch,token))this.deny([401,403,404].includes((e as any)?.status)?'当前身份不可读取这条售后记录。':'售后记录暂不可用，请检查网络后重试。');}
  finally{if(this.visible&&epoch===this.epoch){this.setData({loading:false});if(!this.current(epoch,token))this.deny('身份已变化，请重新核验。');else this.timer=setInterval(()=>void this.recheck(),6000);}}
 },
 open(e:WechatMiniprogram.TouchEvent){if(!this.canAct()||this.pending)return;const id=String(e.currentTarget.dataset.id??'');if(!this.data.items.some(r=>r.id===id))return;this.selection=id;this.setData({note:'',carrier:'',tracking:'',shipmentIndex:0,shipmentOptions:[],shipmentInstruction:null,qualityIndex:0,exceptionIndex:0,exceptionEvidence:'',notice:''});void this.load();},
 list(){if(!this.canAct()||this.pending)return;this.selection='';this.setData({selected:null,available:[],note:'',carrier:'',tracking:'',shipmentIndex:0,shipmentOptions:[],shipmentInstruction:null,qualityIndex:0,exceptionIndex:0,exceptionEvidence:''});},
 edit(e:WechatMiniprogram.Input){if(!this.canAct()||this.pending||this.data.needsReconcile)return;const field=e.currentTarget.dataset.field;if(['note','carrier','tracking','exceptionEvidence'].includes(field))this.setData({[field]:e.detail.value});},
 chooseKind(e:WechatMiniprogram.PickerChange){if(this.canAct()&&!this.pending&&!this.data.needsReconcile)this.setData({kindIndex:Number(e.detail.value)});},
 chooseBasis(e:WechatMiniprogram.PickerChange){if(!this.canAct()||this.pending||this.data.needsReconcile)return;
  const basisIndex=Number(e.detail.value);this.setData({basisIndex,kindIndex:basisIndex===1?1:this.data.kindIndex});},
 chooseQuality(e:WechatMiniprogram.PickerChange){if(!this.canAct()||this.pending||this.data.needsReconcile)return;const value=String(e.detail.value);this.setData({qualityIndex:value==='1'?1:value==='2'?2:0});},
 chooseShipmentInstruction(e:WechatMiniprogram.PickerChange){if(!this.canAct()||this.pending||this.data.needsReconcile)return;
  const index=Number(e.detail.value),history=this.data.selected?.returnInstructionHistory??[];
  if(Number.isInteger(index)&&index>=0&&index<history.length)this.setData({shipmentIndex:index,shipmentInstruction:history[index]!});},
 chooseException(e:WechatMiniprogram.PickerChange){if(!this.canAct()||this.pending||this.data.needsReconcile)return;
  const value=Number(e.detail.value);this.setData({exceptionIndex:Number.isInteger(value)&&value>=0&&value<=4?value:0});},
 async submit(e?:WechatMiniprogram.TouchEvent){if(!this.canAct()||this.data.needsReconcile)return;
  const action=String(e?.currentTarget.dataset.action??'request'),row=this.data.selected;
  if(!this.pending){
   const noReason=action==='request'&&this.data.basisIndex===1;
   if(action==='request'&&this.data.basisIndex===0){this.setData({notice:'请选择问题类型。'});return;}
   if(!noReason&&Array.from(this.data.note.trim()).length<3){this.setData({notice:'请填写至少 3 字的说明。'});return;}
   if(action==='request'&&(this.data.management||!this.data.orderId||row))return;
   if(action!=='request'&&(!row||!this.data.available.some(a=>a.action===action)))return;
   // Inspection is an explicit fact, not a default or a selection from another case.
   if(action==='inspect_return'&&![1,2].includes(this.data.qualityIndex)){this.setData({notice:'请选择本次实际质检结果，再提交记录。'});return;}
   if(action==='approve_refund_without_return'&&(!this.data.exceptionIndex||!/^[A-Za-z0-9._:/-]{8,200}$/.test(this.data.exceptionEvidence.trim()))){
    this.setData({notice:'请选择无法寄回的情形，并填写可核对的物流或客服记录编号。'});return;}
   if(['ship_return','report_old_route'].includes(action)&&!this.data.shipmentInstruction){this.setData({notice:'请先选择实际寄件时使用的退货指引。'});return;}
   if(action==='report_old_route'&&this.data.shipmentInstruction!.version>=Number(row?.returnDestination?.version??0)){
    this.setData({notice:'请选择已使用的旧版有效退货指引；当前版本无需人工改址协助。'});return;}
   const bases=['','no_reason','quality','wrong_item','missing_item','delivery_issue','other'];
   const data:Record<string,unknown>=action==='request'?{kind:this.data.kindIndex===1?'return_refund':'refund_only',claimBasis:bases[this.data.basisIndex],reason:this.data.note.trim()}:
    {action,expectedVersion:row!.version,note:this.data.note.trim(),...(['ship_return','report_old_route'].includes(action)?{instructionVersion:this.data.shipmentInstruction!.version}:{}),...(action==='ship_return'?{carrier:this.data.carrier.trim(),tracking:this.data.tracking.trim()}:{}),...(action==='inspect_return'?{qualityResult:this.data.qualityIndex===2?'unsellable':'sellable'}:{}),
     ...(action==='approve_refund_without_return'?{exceptionKind:['','lost_in_transit','item_missing','carrier_intercepted','return_impracticable'][this.data.exceptionIndex],evidenceReference:this.data.exceptionEvidence.trim()}:{})};
   const epoch=this.epoch,token=this.token;this.setData({busy:true});
   const extra=['ship_return','report_old_route'].includes(action)?`实际使用第 ${this.data.shipmentInstruction!.version} 版指引。${this.data.shipmentInstruction!.version<Number(row?.returnDestination?.version??0)?'旧版地址将通知客服协助核对。':''}${action==='report_old_route'?'稍后可补充运单号。':''}\n`:
    action==='inspect_return'?`质检结果：${this.data.qualityOptions[this.data.qualityIndex]}。\n`:
    action==='approve_refund_without_return'?`例外：${this.data.exceptionOptions[this.data.exceptionIndex]}。\n依据：${this.data.exceptionEvidence.trim()}。\n此操作不等于已退款。\n`:'';
   const yes=await new Promise<boolean>(resolve=>wx.showModal({title:action==='request'?'提交售后申请':actions[action]!,
    content:extra+'提交后由服务端记录申请时间和案件编号；退货指引、收件、质检及退款分别留痕。',
    confirmText:'确认提交',success:r=>resolve(r.confirm),fail:()=>resolve(false)}));
   if(!this.current(epoch,token)){if(this.visible&&epoch===this.epoch)this.deny('身份已变化，请重新核验。');return;}this.setData({busy:false});if(!yes)return;
   this.pending={key:clientOperationKey('aftersale'),path:action==='request'?`/v1/me/orders/${this.data.orderId}/aftersales`:`${this.base()}/${row!.id}/actions`,data};
  }
  const pending=this.pending,epoch=this.epoch,token=this.token;this.setData({busy:true,locked:true,reconciliationReady:false,notice:'正在提交，请勿重复操作。'});
  try{const result=await request<Row>({path:pending.path,method:'POST',idempotencyKey:pending.key,data:pending.data});if(!this.current(epoch,token))return;
   this.selection=result.id;this.pending=null;this.setData({busy:false,locked:false,note:'',carrier:'',tracking:'',qualityIndex:0,exceptionIndex:0,exceptionEvidence:'',notice:'本次操作已记录，请核对最新案件事实。'});await this.load();
  }catch(error){if(this.current(epoch,token)){
   if([401,403].includes((error as any)?.status))this.deny('身份或权限已变化，请重新核验。');
   else if([400,404,409,422].includes((error as any)?.status)&&(error as any)?.code!=='TRANSACTION_OUTCOME_UNKNOWN'){
    // Even explicit rejection does not erase a previous uncertain attempt.
    this.setData({notice:(error as any)?.title??'请核对原案件后重试。',needsReconcile:true});this.pending=null;this.setData({locked:false});
   }else this.setData({notice:'提交结果尚未确认。可用原请求重试；也可刷新案件核对，勿新建重复申请。'});
  }}finally{if(this.visible&&epoch===this.epoch){this.setData({busy:false});if(!this.current(epoch,token))this.deny('身份已变化，请重新核验。');}}
 },
 async reconcile(){if(!this.canAct())return;if(!this.data.reconciliationReady){this.setData({notice:'请先刷新并核对原案件。'});return;}const epoch=this.epoch,token=this.token;this.setData({busy:true});
  const yes=await new Promise<boolean>(resolve=>wx.showModal({title:'核对原售后记录',content:'请先刷新并查看原案件和处理记录。确认已核对后，仅清除本页重试上下文，不撤回服务端已经记录的操作。',confirmText:'已核对',success:r=>resolve(r.confirm),fail:()=>resolve(false)}));
  if(this.current(epoch,token)){if(yes){this.pending=null;this.setData({needsReconcile:false,reconciliationReady:false,locked:false,note:'',carrier:'',tracking:'',qualityIndex:0,notice:''});}this.setData({busy:false});}
 },
 retry(){void this.load();},next(){if(this.canAct()&&!this.pending){this.selection='';void this.load(true);}},
 openChat(){const conversationId=this.data.selected?.supportConversationId;
  if(!conversationId||!this.canAct())return;
  wx.navigateTo({url:this.data.management?`/pages/management-support-chat/index?id=${conversationId}`:'/pages/support/index'});
 },
 back(){if(this.data.busy)return;wx.navigateBack({fail:()=>wx.redirectTo({url:this.data.management?'/pages/management/index':'/pages/orders/index'})});}
});
