import { authorityProjection, type Capability } from '../../services/authority';
import { historicalCommerceClosed, historicalCommerceToken, request, requireHistoricalCommerceAccess } from '../../services/api';
import { pageRead, cancelPageReads } from '../../services/page-requests';
import { currentChromeStyle, shouldReduceMotion } from '../../services/layout';
import { clientOperationKey } from '../../services/orders';
import { commerceContextRevision } from '../../services/commerce-command-store';
import { centsToYuan } from '../../services/commerce';
import { sectionTabValue } from '../../services/section-tabs';
const caps:Capability[]=['commerce.aftersale.review','commerce.return.receive','commerce.return.inspect'];
const labels:Record<string,string>={requested:'申请已收到',need_info:'请补充信息',awaiting_instruction:'待客服发送退货指引',awaiting_return:'请按本案指引寄回',return_in_transit:'退货运输中',return_received:'已收件，待质检',quality_checked:'已质检，待核对退款',refund_exception_approved:'无需寄回，待退款审批',refund_pending:'退款处理中',rejected:'申请未通过',cancelled:'已撤回'};
const actions:Record<string,string>={cancel:'撤回申请',provide_info:'提交补充说明',report_old_route:'已按旧版指引寄出，联系客服协助',ship_return:'登记退货运单',request_info:'请用户补充说明',reject:'不予受理并说明',approve_return:'确认需寄回核对',approve_refund_without_return:'核对无需寄回例外',resolve_old_route:'记录旧地址处理结果',receive_return:'确认实际收到退货',inspect_return:'记录质检结果',request_refund:'提交退款审批',reopen_refund:'恢复原售后案件'};
const managementActions:Record<string,string>={request_refund:'同意退款',approve_return:'同意退货',request_info:'补充材料',reject:'拒绝申请',
 send_return_instruction:'发送退货地址',approve_refund_without_return:'无需寄回处理',receive_return:'确认收件',inspect_return:'提交质检',
 resolve_old_route:'处理旧址退货',reopen_refund:'恢复处理'};
const stages=[{value:'all',label:'全部'},{value:'review',label:'待处理'},{value:'returns',label:'退货中'},{value:'refunds',label:'退款中'},{value:'closed',label:'已结束'}];
const dateLabel=(value?:string)=>{if(!value||!Number.isFinite(new Date(value).getTime()))return '';return new Date(new Date(value).getTime()+8*3600000).toISOString().slice(5,16).replace('T',' ');};
const attentionLabels:Record<string,string>={requested:'待受理',instruction:'待发送退货指引',old_route:'旧地址寄件待协助',receiving:'待收件',inspection:'待质检'};
type ReturnInstruction={version:number;recipientName:string;phone:string;region:string;address:string;freightPayer:string;instructions:string;issuedAt?:string};
type Row={id:string;orderId:string;orderNumber?:string;canReview?:boolean;fulfillment?:{state:string;canRefundWithoutReturn:boolean};state:string;kind:string;version:number;reason:string;claimBasis:string;supportConversationId:string|null;requestedAt:string;amountCents:number;resolved:boolean;refund:any;returnDestination:ReturnInstruction|null;returnInstructionHistory?:ReturnInstruction[];returnCarrier:string|null;returnTracking:string|null;shippedInstructionVersion:number|null;returnRouteReviewRequired:boolean;routeReviewOutcome:string|null;routeReviewedAt:string|null;canReviewOldRoute?:boolean;qualityResult:string|null;exceptionResolution:null|{kind:string;evidenceReference:string;approvedAt:string};lines:any[];events?:any[];historyTruncated?:boolean;label?:string;amountLabel?:string;dateLabel?:string;productSummary?:string;fulfillmentLabel?:string};
Page({
 visible:false,leaving:false,epoch:0,token:'',revision:-1,timer:null as ReturnType<typeof setInterval>|null,
 pending:null as {key:string;path:string;data:Record<string,unknown>}|null,selection:'',attention:'',
 data:{motionActive:true,reducedMotion:shouldReduceMotion(),chromeStyle:currentChromeStyle(),management:false,orderId:'',attentionLabel:'',items:[] as Row[],selected:null as Row|null,nextCursor:null as string|null,hasOpenCase:false,capabilities:[] as Capability[],
  stages,stage:'all',totalCount:0,actionId:'',actionTitle:'',actionNoteRequired:false,actionDirectRefund:false,recipientName:'',returnPhone:'',returnRegion:'',returnAddress:'',returnInstructions:'',freightIndex:0,freightOptions:['选择运费承担方','商家承担','会员承担'],
  canOrder:false,canChat:false,canFinance:false,
  loading:true,busy:false,coreReady:false,error:'',notice:'',note:'',carrier:'',tracking:'',shipmentIndex:0,shipmentOptions:[] as string[],shipmentInstruction:null as ReturnInstruction|null,qualityIndex:0,kindIndex:0,basisIndex:0,
  exceptionIndex:0,exceptionEvidence:'',exceptionOptions:['请选择无法寄回的情形','物流丢件','漏发商品','承运商拦截退回','确实无法合理寄回'],
  kindOptions:['仅退款','退货退款'],basisOptions:['请选择问题类型','七日无理由','商品问题','错发','漏发','物流问题','其他'],
  qualityOptions:['请选择质检结果','可售','不可售'],routeOutcomeIndex:0,routeOutcomeOptions:['请选择实际处理结果','已联系承运商','已协调转寄','已妥善收到'],available:[] as {action:string;label:string}[],needsReconcile:false,reconciliationReady:false,locked:false},
 onLoad(options:Record<string,string>){this.selection=/^[0-9a-f-]{36}$/i.test(options.caseId??'')?options.caseId!:'';
  this.attention=options.mode==='management'&&Object.prototype.hasOwnProperty.call(attentionLabels,options.attention??'')?options.attention!:'';
  this.setData({management:options.mode==='management',orderId:/^[0-9a-f-]{36}$/i.test(options.orderId??'')?options.orderId!:'',attentionLabel:attentionLabels[this.attention]??''});},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 onShow(){this.visible=true;this.leaving=false;this.setData({motionActive:true,reducedMotion:shouldReduceMotion()});return this.load();},
 onHide(){this.visible=false;this.setData({motionActive:false});this.epoch++;this.stop();cancelPageReads(this);if(this.pending)this.setData({needsReconcile:true});this.pending=null;this.setData({reconciliationReady:false});this.clear();},
 onUnload(){this.onHide();},
 current(epoch?:number,token?:string){epoch ??= this.epoch;token ??= this.token;return this.visible&&this.epoch===epoch&&this.token===token&&token===historicalCommerceToken()&&this.revision===commerceContextRevision();},
 canAct(){return this.current()&&this.data.coreReady&&!this.data.busy&&!this.data.loading&&!this.data.error;},
 stop(){if(this.timer!==null)clearInterval(this.timer);this.timer=null;},
 clear(){this.setData({items:[],selected:null,nextCursor:null,totalCount:0,hasOpenCase:false,capabilities:[],canOrder:false,canChat:false,canFinance:false,available:[],actionId:'',actionTitle:'',note:'',recipientName:'',returnPhone:'',returnRegion:'',returnAddress:'',returnInstructions:'',freightIndex:0,carrier:'',tracking:'',shipmentIndex:0,shipmentOptions:[],shipmentInstruction:null,qualityIndex:0,basisIndex:0,routeOutcomeIndex:0,exceptionIndex:0,exceptionEvidence:'',coreReady:false,busy:false,locked:false});},
 deny(){this.stop();cancelPageReads(this);if(this.pending)this.setData({needsReconcile:true});this.pending=null;this.clear();this.setData({loading:false,error:''});
  if(!this.visible||this.leaving)return;this.leaving=true;
  const target=historicalCommerceToken()?(this.data.management?'/pages/management/index':'/pages/orders/index'):'/pages/account/index';
  wx.redirectTo({url:target,fail:()=>wx.switchTab({url:'/pages/profile/index'})});
 },
 base(){return this.data.management?'/v1/management/aftersales':'/v1/me/aftersales';},
 normalize(row:Row){return {...row,dateLabel:dateLabel(row.requestedAt),productSummary:row.lines?.map(line=>`${line.productName} × ${line.quantity}`).join('、')??'',
  fulfillmentLabel:row.fulfillment?.state==='shipped'?'已发货':row.fulfillment?.state==='unshipped'?'未发货':'',
  events:row.events?.map(event=>({...event,actionLabel:managementActions[event.action]??actions[event.action]??(event.action==='request'?'提交申请':'进度更新'),dateLabel:dateLabel(event.createdAt)})),
  canReviewOldRoute:['awaiting_return','return_in_transit','return_received'].includes(row.state)
  &&row.shippedInstructionVersion!==null&&row.shippedInstructionVersion<Number(row.returnDestination?.version??0)
  &&(row.routeReviewOutcome===null||row.routeReviewOutcome==='carrier_contacted'),
  label:row.resolved?(row.refund?.executionKind==='local_credit'?'购物权益已退回':'已退款'):row.refund?.reviewState==='rejected'?'退款复核未通过':row.refund?.channelState==='closed'?'退款已关闭':row.refund?.channelState==='abnormal'?'退款异常':row.returnRouteReviewRequired?(row.returnTracking?'旧址退货待处理':'待补退货运单'):row.refund?.reviewState==='requested'?'待退款复核':labels[row.state]??'进度暂未更新',amountLabel:centsToYuan(row.amountCents)};},
 selectActions(row:Row){const out:string[]=[];
  if(this.data.management){
   if(row.canReview===false)return [];
   if(this.data.capabilities.includes('commerce.aftersale.review')){
    const unshipped=row.fulfillment?.canRefundWithoutReturn===true;
    if(unshipped)out.push('request_refund');
    if(row.state==='requested')out.push(...(unshipped?[]:[row.kind==='return_refund'?'approve_return':'request_refund']),'request_info','reject');
    if(['awaiting_instruction','awaiting_return'].includes(row.state)&&row.kind==='return_refund'&&!row.returnTracking&&row.shippedInstructionVersion==null)out.push('send_return_instruction');
    if(['requested','need_info','awaiting_instruction','awaiting_return','return_in_transit'].includes(row.state)
      &&!unshipped&&(row.kind==='return_refund'||['delivery_issue','missing_item'].includes(row.claimBasis)))out.push('approve_refund_without_return');
    if(row.state==='need_info')out.push('reject');
    if(['quality_checked','refund_exception_approved'].includes(row.state))out.push('request_refund');
   if(row.state==='refund_pending'&&(row.refund?.reviewState==='rejected'||row.refund?.channelState==='closed'))out.push('reopen_refund');
    if(['awaiting_return','return_in_transit','return_received'].includes(row.state)
      &&row.shippedInstructionVersion!==null&&row.shippedInstructionVersion<Number(row.returnDestination?.version??0)
      &&(row.routeReviewOutcome===null||row.routeReviewOutcome==='carrier_contacted'))out.push('resolve_old_route');
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
  return [...new Set(out)].map(action=>({action,label:this.data.management?(action==='request_refund'&&!(row.fulfillment?.canRefundWithoutReturn&&this.data.capabilities.includes('commerce.refund.approve'))?'提交退款复核':managementActions[action]??actions[action]!):actions[action]!}));
 },
 async recheck(){if(!this.visible||this.data.loading||this.data.busy)return;if(!this.current()){this.deny();return;}
  if(!this.data.coreReady)return;const epoch=this.epoch,token=this.token;
  if(!this.data.management){
   if(!this.selection)return;
   try{const selected=await pageRead<Row>(this,{path:`${this.base()}/${this.selection}`});if(!this.current(epoch,token)||selected.id!==this.selection)return;
    const history=selected.returnInstructionHistory??[],previousVersion=this.data.shipmentInstruction?.version,
      index=Math.max(0,history.findIndex(item=>item.version===previousVersion));
    this.setData({selected:this.normalize(selected),available:this.selectActions(selected),shipmentIndex:index,
      shipmentOptions:history.map(item=>`第 ${item.version} 版 · ${item.region} ${item.address}`),shipmentInstruction:history[index]??null});
   }catch{if(this.current(epoch,token))this.setData({notice:'售后进度暂未更新，可点击刷新重试。'});}
   return;
  }
  try{const a=await authorityProjection(this);if(!this.current(epoch,token))return;
   if(a.version!==1||!a.managementAvailable||!caps.some(c=>a.capabilities.includes(c)))throw {status:403};
   this.setData({capabilities:a.capabilities,canOrder:a.capabilities.includes('commerce.order.read'),canChat:a.capabilities.includes('support.read'),canFinance:a.capabilities.includes('commerce.refund.approve')||a.capabilities.includes('commerce.money.reconcile')});if(this.data.selected)this.setData({available:this.selectActions(this.data.selected)});if(this.data.actionId&&!this.data.available.some(item=>item.action===this.data.actionId))this.setData({actionId:'',note:'',exceptionEvidence:'',recipientName:'',returnPhone:'',returnRegion:'',returnAddress:'',returnInstructions:''});
  }catch(error){if(this.current(epoch,token)){if([401,403].includes((error as {status?:number})?.status??0))this.deny();else this.setData({error:'暂时无法更新，请重试'});}}
 },
 async load(next=false){if(!this.visible||this.data.busy)return;if(this.data.management?!historicalCommerceToken()||historicalCommerceClosed():!requireHistoricalCommerceAccess()){this.deny();this.setData({loading:false});return;}
  const cursor=next?this.data.nextCursor:null;if(next&&!cursor)return;
  const preserve=this.current()&&this.data.coreReady,previous=preserve?this.data.items:[];
  this.stop();cancelPageReads(this);const epoch=++this.epoch,token=historicalCommerceToken();this.token=token;this.revision=commerceContextRevision();
  this.setData({loading:true,error:'',coreReady:preserve,...(!preserve?{items:[],selected:null,available:[]}:{}),qualityIndex:this.pending?this.data.qualityIndex:0});
  try{
   if(this.data.management){const a=await authorityProjection(this);if(!this.current(epoch,token))return;if(a.version!==1||!a.managementAvailable||!caps.some(c=>a.capabilities.includes(c)))throw {status:403};
    this.setData({capabilities:a.capabilities,canOrder:a.capabilities.includes('commerce.order.read'),canChat:a.capabilities.includes('support.read'),canFinance:a.capabilities.includes('commerce.refund.approve')||a.capabilities.includes('commerce.money.reconcile')});}
   if(this.selection){const selected=await pageRead<Row>(this,{path:`${this.base()}/${this.selection}`});if(!this.current(epoch,token))return;
    const history=selected.returnInstructionHistory??[],recorded=history.findIndex(item=>item.version===selected.shippedInstructionVersion),
      shipmentIndex=recorded>=0?recorded:Math.min(this.data.shipmentIndex,Math.max(0,history.length-1));
    this.setData({selected:this.normalize(selected),available:this.selectActions(selected),coreReady:true,reconciliationReady:true,shipmentIndex,
      shipmentOptions:history.map(item=>`第 ${item.version} 版 · ${item.region} ${item.address}`),shipmentInstruction:history[shipmentIndex]??null});
   }else{
    const page=await pageRead<{items:Row[];nextCursor:string|null;totalCount?:number}>(this,{path:`${this.base()}?limit=20${this.data.orderId?`&orderId=${this.data.orderId}`:''}${this.attention?`&attention=${this.attention}`:''}${this.data.management&&this.data.stage!=='all'?`&stage=${this.data.stage}`:''}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`});
    if(!this.current(epoch,token))return;const seen=new Set(previous.map(row=>row.id));
    this.setData({items:next?[...previous,...page.items.filter(row=>!seen.has(row.id)).map(row=>this.normalize(row))]:page.items.map(row=>this.normalize(row)),
      totalCount:page.totalCount??page.items.length,nextCursor:page.nextCursor,selected:null,available:[],
      hasOpenCase:(next&&this.data.hasOpenCase)||page.items.some(row=>!['cancelled','rejected'].includes(row.state)&&!row.resolved),coreReady:true,reconciliationReady:true});
   }
  }catch(e){if(this.current(epoch,token)){
   if([401,403].includes((e as any)?.status))this.deny();
   else if((e as any)?.status===404&&this.selection){this.selection='';this.setData({selected:null,items:[],coreReady:false,error:'这条记录已更新，请刷新'});}
   else this.setData({error:'售后记录暂未更新，请重试。',coreReady:preserve});
  }}finally{if(this.visible&&epoch===this.epoch){this.setData({loading:false});if(!this.current(epoch,token))this.deny();else this.timer=setInterval(()=>void this.recheck(),6000);}}
 },
 open(e:WechatMiniprogram.TouchEvent){if(!this.canAct()||this.pending)return;const id=String(e.currentTarget.dataset.id??'');if(!this.data.items.some(r=>r.id===id))return;this.selection=id;this.setData({note:'',carrier:'',tracking:'',shipmentIndex:0,shipmentOptions:[],shipmentInstruction:null,qualityIndex:0,routeOutcomeIndex:0,exceptionIndex:0,exceptionEvidence:'',notice:''});void this.load();},
 list(){if(!this.canAct()||this.pending)return;this.selection='';this.setData({selected:null,available:[],actionId:'',note:'',carrier:'',tracking:'',shipmentIndex:0,shipmentOptions:[],shipmentInstruction:null,qualityIndex:0,routeOutcomeIndex:0,exceptionIndex:0,exceptionEvidence:''});void this.load();},
 clearAttention(){if(!this.canAct()||this.pending)return;this.attention='';this.selection='';this.setData({attentionLabel:''});void this.load();},
 edit(e:WechatMiniprogram.Input){if(!this.canAct()||this.pending||this.data.needsReconcile)return;const field=e.currentTarget.dataset.field;if(['note','carrier','tracking','exceptionEvidence','recipientName','returnPhone','returnRegion','returnAddress','returnInstructions'].includes(field))this.setData({[field]:e.detail.value});},
 chooseKind(e:WechatMiniprogram.PickerChange){if(this.canAct()&&!this.pending&&!this.data.needsReconcile)this.setData({kindIndex:Number(e.detail.value)});},
 chooseBasis(e:WechatMiniprogram.PickerChange){if(!this.canAct()||this.pending||this.data.needsReconcile)return;
  const basisIndex=Number(e.detail.value);this.setData({basisIndex,kindIndex:basisIndex===1?1:this.data.kindIndex});},
 chooseQuality(e:WechatMiniprogram.PickerChange){if(!this.canAct()||this.pending||this.data.needsReconcile)return;const value=String(e.detail.value);this.setData({qualityIndex:value==='1'?1:value==='2'?2:0});},
 chooseRouteOutcome(e:WechatMiniprogram.PickerChange){if(!this.canAct()||this.pending||this.data.needsReconcile)return;
  const index=Number(e.detail.value);this.setData({routeOutcomeIndex:Number.isInteger(index)&&index>=0&&index<=3?index:0});},
 chooseShipmentInstruction(e:WechatMiniprogram.PickerChange){if(!this.canAct()||this.pending||this.data.needsReconcile)return;
  const index=Number(e.detail.value),history=this.data.selected?.returnInstructionHistory??[];
  if(Number.isInteger(index)&&index>=0&&index<history.length)this.setData({shipmentIndex:index,shipmentInstruction:history[index]!});},
 chooseException(e:WechatMiniprogram.PickerChange){if(!this.canAct()||this.pending||this.data.needsReconcile)return;
  const value=Number(e.detail.value);this.setData({exceptionIndex:Number.isInteger(value)&&value>=0&&value<=4?value:0});},
 chooseOrderItems(){if(!this.canAct()||this.data.management||!this.data.orderId||this.data.hasOpenCase||this.pending)return;
  const pages=typeof getCurrentPages==='function'?getCurrentPages():[];
  const previous=pages.length>1?pages[pages.length-2]:null;
  if(previous?.route==='pages/order-detail/index'&&(previous as any).data?.id===this.data.orderId){
   wx.navigateBack({delta:1,fail:()=>wx.redirectTo({url:`/pages/order-detail/index?id=${this.data.orderId}&aftersale=1`})});
  }else wx.redirectTo({url:`/pages/order-detail/index?id=${this.data.orderId}&aftersale=1`});
 },
 async submit(e?:WechatMiniprogram.TouchEvent){if(!this.canAct()||this.data.needsReconcile)return;
  const action=String(e?.currentTarget.dataset.action??''),row=this.data.selected;
  if(!this.pending){
   if(!row||!this.data.available.some(a=>a.action===action))return;
   const required=!this.data.management||['request_info','reject','approve_refund_without_return'].includes(action);
   const entered=this.data.note.trim(),why=entered||(!required?(managementActions[action]??actions[action]??''):'');
   if(Array.from(why).length<3){this.setData({notice:'请填写至少 3 字的说明。'});return;}
   if(action==='send_return_instruction'&&(!this.data.recipientName.trim()||!this.data.returnPhone.trim()||!this.data.returnRegion.trim()||this.data.returnAddress.trim().length<5||!this.data.freightIndex)){this.setData({notice:'请填写收件信息并选择运费承担方。'});return;}
   // Inspection is an explicit fact, not a default or a selection from another case.
   if(action==='inspect_return'&&![1,2].includes(this.data.qualityIndex)){this.setData({notice:'请选择本次实际质检结果，再提交记录。'});return;}
   if(action==='approve_refund_without_return'&&(!this.data.exceptionIndex||!/^[A-Za-z0-9._:/-]{8,200}$/.test(this.data.exceptionEvidence.trim()))){
    this.setData({notice:'请选择无法寄回的情形，并填写可核对的物流或客服记录编号。'});return;}
   if(action==='resolve_old_route'&&!this.data.routeOutcomeIndex){this.setData({notice:'请选择实际处理结果。'});return;}
   if(['ship_return','report_old_route'].includes(action)&&!this.data.shipmentInstruction){this.setData({notice:'请先选择实际寄件时使用的退货指引。'});return;}
   if(action==='report_old_route'&&this.data.shipmentInstruction!.version>=Number(row?.returnDestination?.version??0)){
    this.setData({notice:'请选择已使用的旧版有效退货指引；当前版本无需人工改址协助。'});return;}
   const data:Record<string,unknown>={action,expectedVersion:row.version,note:why,...(action==='send_return_instruction'?{recipientName:this.data.recipientName.trim(),phone:this.data.returnPhone.trim(),region:this.data.returnRegion.trim(),address:this.data.returnAddress.trim(),instructions:this.data.returnInstructions.trim(),freightPayer:this.data.freightIndex===1?'merchant':'member'}:{}),...(action==='request_refund'&&row.fulfillment?.canRefundWithoutReturn&&this.data.capabilities.includes('commerce.refund.approve')?{approveRefund:true}:{}),...(['ship_return','report_old_route'].includes(action)?{instructionVersion:this.data.shipmentInstruction!.version}:{}),...(action==='ship_return'?{carrier:this.data.carrier.trim(),tracking:this.data.tracking.trim()}:{}),...(action==='inspect_return'?{qualityResult:this.data.qualityIndex===2?'unsellable':'sellable'}:{}),
     ...(action==='approve_refund_without_return'?{exceptionKind:['','lost_in_transit','item_missing','carrier_intercepted','return_impracticable'][this.data.exceptionIndex],evidenceReference:this.data.exceptionEvidence.trim()}:{})};
   if(action==='resolve_old_route')data.routeOutcome=['','carrier_contacted','rerouted','received'][this.data.routeOutcomeIndex];
   const epoch=this.epoch,token=this.token;this.setData({busy:true});
   const extra=['ship_return','report_old_route'].includes(action)?`实际使用第 ${this.data.shipmentInstruction!.version} 版指引。${this.data.shipmentInstruction!.version<Number(row?.returnDestination?.version??0)?'旧版地址将通知客服协助核对。':''}${action==='report_old_route'?'稍后可补充运单号。':''}\n`:
    action==='inspect_return'?`质检结果：${this.data.qualityOptions[this.data.qualityIndex]}。\n`:
    action==='resolve_old_route'?`处理结果：${this.data.routeOutcomeOptions[this.data.routeOutcomeIndex]}。\n`:
    action==='approve_refund_without_return'?`例外：${this.data.exceptionOptions[this.data.exceptionIndex]}。\n依据：${this.data.exceptionEvidence.trim()}。\n此操作不等于已退款。\n`:'';
   const yes=await new Promise<boolean>(resolve=>wx.showModal({title:this.data.management?(managementActions[action]??actions[action]!):actions[action]!,
    content:action==='request_refund'?`订单 ${row.orderNumber||row.id}\n金额 ¥${centsToYuan(row.amountCents)}\n${data.approveRefund?'同意后将提交原路退款，结果以微信返回为准。':'提交退款复核，核准后再原路退回。'}`:extra+(action==='reject'?`拒绝原因：${why}`:action==='send_return_instruction'?'收件信息将发送到本案客服会话，用户可按此地址寄回。':'确认记录本次处理结果？'),
    confirmText:'确认提交',success:r=>resolve(r.confirm),fail:()=>resolve(false)}));
   if(!this.current(epoch,token)){if(this.visible&&epoch===this.epoch)this.deny();return;}this.setData({busy:false});if(!yes)return;
   this.pending={key:clientOperationKey('aftersale'),path:`${this.base()}/${row.id}/actions`,data};
  }
  const pending=this.pending,epoch=this.epoch,token=this.token;this.setData({busy:true,locked:true,reconciliationReady:false,notice:'正在提交，请勿重复操作。'});
  try{const result=await request<Row>({path:pending.path,method:'POST',idempotencyKey:pending.key,data:pending.data});if(!this.current(epoch,token))return;
   this.selection=result.id;this.pending=null;this.setData({busy:false,locked:false,actionId:'',note:'',carrier:'',tracking:'',qualityIndex:0,exceptionIndex:0,exceptionEvidence:'',notice:action==='request_refund'?'已同意，退款进度将在此更新。':'已记录'});await this.load();
  }catch(error){if(this.current(epoch,token)){
   if([401,403].includes((error as any)?.status))this.deny();
   else if([400,404,409,422].includes((error as any)?.status)&&(error as any)?.code!=='TRANSACTION_OUTCOME_UNKNOWN'){
    // Even explicit rejection does not erase a previous uncertain attempt.
    this.setData({notice:(error as any)?.title??'请核对原案件后重试。',needsReconcile:true});this.pending=null;this.setData({locked:false});
   }else this.setData({notice:'提交结果还未确认。请重试上次操作或刷新售后记录，不要重复申请。'});
  }}finally{if(this.visible&&epoch===this.epoch){this.setData({busy:false});if(!this.current(epoch,token))this.deny();}}
 },
 async reconcile(){if(!this.canAct())return;if(!this.data.reconciliationReady){this.setData({notice:'请先刷新并核对原案件。'});return;}const epoch=this.epoch,token=this.token;this.setData({busy:true});
  const yes=await new Promise<boolean>(resolve=>wx.showModal({title:'核对原售后记录',content:'请先刷新并查看原售后申请和处理记录。确认后将结束本页重试，不会撤回已提交的操作。',confirmText:'已核对',success:r=>resolve(r.confirm),fail:()=>resolve(false)}));
  if(this.current(epoch,token)){if(yes){this.pending=null;this.setData({needsReconcile:false,reconciliationReady:false,locked:false,note:'',carrier:'',tracking:'',qualityIndex:0,notice:''});}this.setData({busy:false});}
 },
 selectStage(e:WechatMiniprogram.TouchEvent){if(!this.canAct()||this.pending||this.data.actionId)return;const stage=sectionTabValue(e,'stage');if(!stages.some(item=>item.value===stage)||stage===this.data.stage)return;this.attention='';this.selection='';this.setData({stage,attentionLabel:'',items:[],selected:null,nextCursor:null,coreReady:false,notice:''});void this.load();},
 prepareAction(e:WechatMiniprogram.TouchEvent){if(!this.canAct()||this.pending||this.data.needsReconcile)return;const action=String(e.currentTarget.dataset.action??'');const allowed=this.data.available.find(item=>item.action===action);if(!allowed)return;
  this.setData({actionId:action,actionTitle:allowed.label,actionDirectRefund:action==='request_refund'&&this.data.selected?.fulfillment?.canRefundWithoutReturn===true&&this.data.capabilities.includes('commerce.refund.approve'),actionNoteRequired:['request_info','reject','approve_refund_without_return'].includes(action),note:'',notice:'',qualityIndex:0,routeOutcomeIndex:0,exceptionIndex:0,exceptionEvidence:'',recipientName:'',returnPhone:'',returnRegion:'',returnAddress:'',returnInstructions:'',freightIndex:0});},
 closeAction(){if(this.data.busy||this.pending||this.data.locked)return;this.setData({actionId:'',note:'',notice:'',recipientName:'',returnPhone:'',returnRegion:'',returnAddress:'',returnInstructions:'',exceptionEvidence:''});},
 swallow(){},
 submitPrepared(){if(!this.data.actionId||!this.data.management)return;void this.submit({currentTarget:{dataset:{action:this.data.actionId}}} as unknown as WechatMiniprogram.TouchEvent);},
 chooseFreight(e:WechatMiniprogram.PickerChange){if(!this.canAct()||this.pending)return;const index=Number(e.detail.value);if(index===1||index===2)this.setData({freightIndex:index});},
 openOrder(){if(!this.canAct()||!this.data.canOrder||!this.data.selected||this.pending)return;wx.navigateTo({url:`/pages/management-order-detail/index?id=${this.data.selected.orderId}`});},
 openFinance(){if(!this.canAct()||!this.data.canFinance||this.pending)return;wx.navigateTo({url:'/pages/management-finance/index'});},
 copyOrder(){if(!this.canAct()||!this.data.selected?.orderNumber)return;wx.setClipboardData({data:this.data.selected.orderNumber});},
 retry(){void this.load();},next(){if(this.canAct()&&!this.pending){this.selection='';void this.load(true);}},
 openChat(){const conversationId=this.data.selected?.supportConversationId;
  if(!conversationId||!this.canAct()||this.data.management&&!this.data.canChat)return;
  wx.navigateTo({url:this.data.management?`/pages/management-support-chat/index?id=${conversationId}`:
    historicalCommerceClosed()?`/pages/order-detail/index?id=${this.data.selected!.orderId}&aftersale=1`:`/pages/support/index?orderId=${this.data.selected!.orderId}`});
 },
 back(){if(this.data.busy)return;wx.navigateBack({fail:()=>wx.redirectTo({url:this.data.management?'/pages/management/index':'/pages/orders/index'})});}
});
