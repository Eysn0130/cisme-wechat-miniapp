import {requireMemberAccess,request,registerPrivateExport} from '../../services/api';
import {authorityProjection} from '../../services/authority';
import {currentChromeStyle} from '../../services/layout';
import {cancelPageReads} from '../../services/page-requests';
import {commerceContextRevision} from '../../services/commerce-command-store';
import {sectionTabValue} from '../../services/section-tabs';
import {officerRead,officerCommand,officerPending,resolveOfficerPending,officerMoney,officerDate,officerError,officerLabels,officerHistoryRow,type OfficerPending} from '../../services/sharing-officer';
import {groupOfficerRows,officerFilters,officerReviewView,prepareOfficerRow,type OfficerDay} from './review';
type CustomerRow={id:string;displayName:string;userCode:string;version:number;controlVersion:number;expired:boolean;restorable:boolean;removedAt:string|null};
const customerFilters=[{id:'retained',label:'保留归属'},{id:'removed',label:'已移除'}];
const customerEmpty={customers:[] as CustomerRow[],customerFilterIndex:0,customerCursor:null as string|null,customerMore:false,customerLoading:false,
 customerError:'',customerOfficerVersion:0,customerOfficerState:'',customerSelected:null as CustomerRow|null};
const reviewEmpty={...customerEmpty,review:null as ReturnType<typeof officerReviewView>|null,reviewLoading:false,reviewError:'',reviewStale:false,reviewOpen:'',qualificationActions:false};
const qualificationConfirmation:Record<string,string>={
 suspended:'暂停期间新订单不计佣，保留现有推荐归属和历史订单。',
 active:'仍保留归属的会员，从恢复后的新订单起计佣。暂停期间的订单不补计。',
 terminated:'终止推广资格，V2.0 资格的推荐归属将解除。再次开通需要重新申请，历史订单按原归属处理。'
};
const empty={...reviewEmpty,officerGroups:[] as OfficerDay[],memberId:'',scope:null as any,policy:null as any,items:[] as any[],tabs:[] as Array<{id:string;label:string}>,nextCursor:null as string|null,hasMore:false,pending:null as OfficerPending|null,selected:null as any,sheet:'',payee:null as any,error:'',reason:'',verificationReference:'',rate:'',days:'',attributionDays:'',durationIndex:0,priorityIndex:0,enabled:false,tax:'',taxNote:'',reference:'',paymentNote:'',paidAt:'',recoveryAmount:'',receivedAmount:'',taxAdjustment:'',orderDetail:null as any,history:[] as any[],historyCursor:null as string|null,historyMore:false,historyLoading:false,sourceOrders:[] as any[],sourceCursor:null as string|null,sourceMore:false};
function moneyInput(value:string){const m=/^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value.trim());return m?Number(m[1])*100+Number((m[2]??'').padEnd(2,'0')):NaN;}
function viewRow(r:any){return {...r,label:officerLabels[r.state]||'',date:officerDate((r.state==='pending'?r.updatedAt:null)||r.paidAt||r.appliedAt||r.createdAt),gross:officerMoney(r.grossCents),tax:officerMoney(r.taxCents),net:officerMoney(r.netCents),cash:officerMoney(r.cashMerchandiseCents),recovery:officerMoney(r.outstandingRecoveryCents)};}
Page({
 alive:false,visible:false,epoch:0,reviewAttempt:0,customerAttempt:0,session:'',context:0,target:{memberId:'',batchId:'',lineId:'',tab:''},openedTarget:false,files:[] as Array<()=>void>,
 data:{...empty,targetMemberId:'',chromeStyle:currentChromeStyle(),loading:true,busy:false,tab:'officers',batchId:'',batchPeriod:'',filter:'all',filterIndex:0,filters:officerFilters.map(filter=>filter.label),customerFilters:customerFilters.map(filter=>filter.label),period:'',afterMemberId:'',continuePrepare:false,decisionState:'',decisionLabel:'',durations:['永久','按天'],priorities:['首次推荐','最近一次推荐']},
 onLoad(q:Record<string,string|undefined>={}){this.alive=true;this.target={memberId:q.memberId||'',batchId:q.batchId||'',lineId:q.lineId||'',tab:q.tab||''};
  const filterIndex=this.target.memberId?0:Math.max(0,officerFilters.findIndex(filter=>filter.id===q.filter));
  const now=new Date(Date.now()+8*3600_000);now.setUTCDate(0);
  this.setData({targetMemberId:this.target.memberId,period:now.toISOString().slice(0,7),filter:officerFilters[filterIndex]!.id,filterIndex});},
 onShow(){this.visible=true;this.epoch++;this.cleanup();const s=getApp<IAppOption>().globalData.sessionToken,c=commerceContextRevision();if(s!==this.session||c!==this.context)this.setData({...empty,batchId:'',batchPeriod:'',tab:'officers'});this.session=s;this.context=c;if(!this.openedTarget&&this.target.memberId)this.setData({tab:this.target.tab||'officers',batchId:this.target.batchId});if(requireMemberAccess())void this.load();},
 onHide(){this.visible=false;this.epoch++;cancelPageReads(this);this.setData({...empty,busy:false});},
 onUnload(){this.onHide();this.cleanup();this.alive=false;this.setData({...empty});},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 current(epoch?:number){return this.alive&&this.visible&&(epoch===undefined||epoch===this.epoch)&&this.session===getApp<IAppOption>().globalData.sessionToken&&this.context===commerceContextRevision();},
 async load(more=false){if(!this.current())return;const epoch=++this.epoch;this.setData({loading:true,error:''});try{
  const authority=await authorityProjection(this);if(!this.current(epoch))return;const has=(c:string)=>authority.capabilities.includes(c as any),tabs=[];
  if(has('member.manage')||has('commission.read'))tabs.push({id:'officers',label:'分享官'});if(has('commission.rate.manage'))tabs.push({id:'policy',label:'规则'});if(has('commission.read')||has('commission.settlement.approve'))tabs.push({id:'orders',label:'推广订单'});if(has('commission.settlement.approve'))tabs.push({id:'batches',label:'月度结算'});
  if(this.target.memberId){const allowed=new Set(['officers','orders','batches']);for(let i=tabs.length-1;i>=0;i--)if(!allowed.has(tabs[i]!.id))tabs.splice(i,1);}
  if(!tabs.length)throw {title:'当前账号没有分享官管理权限'};const tab=tabs.some(t=>t.id===this.data.tab)?this.data.tab:tabs[0]!.id;this.setData({tabs,tab});
  const section=tab==='batches'&&this.data.batchId?'lines':tab;
  const result=await officerRead(this,`/v1/management/sharing-officer?section=${section}&limit=20${this.data.batchId?'&batchId='+this.data.batchId:''}${tab==='officers'?'&filter='+this.data.filter:''}${more&&this.data.nextCursor?'&cursor='+encodeURIComponent(this.data.nextCursor):''}${this.target.memberId?'&memberId='+encodeURIComponent(this.target.memberId):''}${this.target.lineId?'&lineId='+encodeURIComponent(this.target.lineId):''}`);if(!this.current(epoch))return;
  const page=result.items??[];
  const rows=tab==='officers'?await Promise.all(page.map(prepareOfficerRow)):page.map(viewRow);
  if(!this.current(epoch))return;
  const items=more?(tab==='officers'?[...new Map([...this.data.items,...rows].map(row=>[row.memberId,row])).values()]:[...this.data.items,...rows]):rows;
  this.setData({memberId:result.memberId,scope:result.scope,policy:result.policy,items,officerGroups:tab==='officers'?groupOfficerRows(items):[],nextCursor:result.nextCursor??null,hasMore:Boolean(result.hasMore),pending:officerPending(result.memberId)});if(!this.openedTarget&&this.target.memberId){this.openedTarget=true;const row=this.data.items.find(v=>this.target.lineId?v.id===this.target.lineId:v.memberId===this.target.memberId);if(row&&this.target.lineId)this.selectLine({currentTarget:{dataset:{id:row.id}}} as any);else if(row&&tab==='officers')this.selectOfficer({currentTarget:{dataset:{id:row.memberId}}} as any);else if(this.target.lineId)this.setData({error:'月结记录不存在或不属于该用户'});}
 }catch(e){if(this.current(epoch)){
   if((e as {code?:string}).code==='CAPABILITY_REQUIRED')this.setData({...empty,error:officerError(e)});
   else this.setData({error:officerError(e)});
  }}finally{if(this.current(epoch))this.setData({loading:false,busy:false});wx.stopPullDownRefresh();}},
 retry(){if(!this.data.busy)void this.load();},
 onPullDownRefresh(){if(!this.data.busy)void this.load();else wx.stopPullDownRefresh();},
 more(){if(!this.data.loading&&!this.data.busy&&this.data.hasMore)void this.load(true);},
 changeTab(e:unknown){const tab=sectionTabValue(e);if(this.data.busy||this.data.pending||!this.data.tabs.some(t=>t.id===tab)||tab===this.data.tab)return;cancelPageReads(this);this.epoch++;this.setData({tab,batchId:'',batchPeriod:'',items:[],officerGroups:[],nextCursor:null,hasMore:false});void this.load();},
 filterChange(e:WechatMiniprogram.CustomEvent){
  const index=Number(e.detail.value),filter=officerFilters[index];
  if(!filter||filter.id===this.data.filter||this.data.busy||this.data.pending||this.data.sheet)return;
  cancelPageReads(this);
  this.setData({filterIndex:index,filter:filter.id,items:[],officerGroups:[],nextCursor:null,hasMore:false});
  void this.load();
 },
 edit(e:WechatMiniprogram.CustomEvent){const field=String(e.currentTarget.dataset.field);if(['reason','verificationReference','rate','days','attributionDays','tax','taxNote','reference','paymentNote','paidAt','period','recoveryAmount','receivedAmount','taxAdjustment'].includes(field)&&!this.data.busy)this.setData({[field]:String(e.detail.value)});},
 pick(e:WechatMiniprogram.CustomEvent){const field=String(e.currentTarget.dataset.field);if(['durationIndex','priorityIndex'].includes(field))this.setData({[field]:Number(e.detail.value)});},
 toggle(e:WechatMiniprogram.CustomEvent){this.setData({enabled:Boolean(e.detail.value)});},
 openPolicy(){if(this.target.memberId)return;if(!this.data.scope?.configure||this.data.busy||this.data.pending)return;const p=this.data.policy;this.setData({sheet:'policy',rate:String((p?.basisPoints??0)/100),days:String(p?.releaseDays??0),durationIndex:p?.attributionDays===null?0:1,attributionDays:p?.attributionDays===null?'':String(p?.attributionDays??''),priorityIndex:p?.priority==='last'?1:0,enabled:p?.enabled===true,reason:'',error:''});},
 selectOfficer(e:WechatMiniprogram.TouchEvent){
  if(!this.data.scope?.manage||this.data.busy||this.data.pending)return;
  const row=this.data.items.find(v=>v.memberId===e.currentTarget.dataset.id);
  if(!row)return;
  this.setData({...reviewEmpty,selected:row,sheet:'officer',reason:'',error:''});
  void this.readOfficerReview();
 },
 async readOfficerReview(){
  const selected=this.data.selected;
  if(!this.current()||this.data.sheet!=='officer'||!selected||this.data.reviewLoading)return;
  const epoch=this.epoch,attempt=++this.reviewAttempt;
  const current=()=>this.current(epoch)&&this.reviewAttempt===attempt&&this.data.sheet==='officer'&&this.data.selected?.memberId===selected.memberId;
  this.setData({reviewLoading:true,reviewError:'',reviewStale:false});
  try{
   const result=await officerRead(this,`/v1/management/sharing-officer?section=officer-detail&memberId=${encodeURIComponent(selected.memberId)}&version=${selected.version}`);
   if(!current())return;
   if(result.memberId!==this.data.memberId||result.detail?.officer?.memberId!==selected.memberId||result.detail.officer.version!==selected.version){
    this.setData({reviewError:'申请已更新，请重新加载',reviewStale:true});
    return;
   }
   this.setData({review:officerReviewView(result.detail)});
  }catch(error){if(current()){
   if((error as {code?:string}).code==='CAPABILITY_REQUIRED'){this.close();void this.load();return;}
   this.setData({reviewError:officerError(error),reviewStale:(error as {code?:string}).code==='VERSION_CONFLICT'});
  }}finally{if(current())this.setData({reviewLoading:false});}
 },
 refreshOfficerReview(){if(this.data.reviewStale){this.close();void this.load();}else void this.readOfficerReview();},
 toggleOfficerRecord(e:WechatMiniprogram.TouchEvent){
  const section=String(e.currentTarget.dataset.section);
  this.setData({reviewOpen:this.data.reviewOpen===section?'':section});
 },
 toggleQualificationActions(){this.setData({qualificationActions:!this.data.qualificationActions});},
 openCustomers(){
  const selected=this.data.selected;
  if(!this.current()||this.data.sheet!=='officer'||!this.data.scope?.customers||this.data.busy||this.data.pending
    ||!this.data.review?.accountActive||!selected||selected.memberId===this.data.memberId||!['active','suspended'].includes(selected.state))return;
  this.setData({...customerEmpty,sheet:'customers',error:''});
  void this.readCustomers();
 },
 async readCustomers(more=false){
  const selected=this.data.selected,filter=customerFilters[this.data.customerFilterIndex];
  if(!this.current()||this.data.sheet!=='customers'||!selected||!filter||this.data.customerLoading)return;
  const epoch=this.epoch,attempt=++this.customerAttempt;
  const current=()=>this.current(epoch)&&this.customerAttempt===attempt&&this.data.sheet==='customers'&&this.data.selected?.memberId===selected.memberId;
  this.setData({customerLoading:true,customerError:''});
  try{
   const page=this.data.customerCursor&&more?'&cursor='+encodeURIComponent(this.data.customerCursor):'';
   const result=await officerRead(this,`/v1/management/sharing-officer?section=customers&memberId=${encodeURIComponent(selected.memberId)}&customerFilter=${filter.id}&limit=20${page}`);
   if(!current())return;
   if(result.memberId!==this.data.memberId||!result.scope?.customers){
    this.closeAll();void this.load();return;
   }
   const items:CustomerRow[]=result.items??[];
   const customers=more?[...new Map([...this.data.customers,...items].map(row=>[row.id,row])).values()]:items;
   this.setData({customers,customerCursor:result.nextCursor??null,customerMore:Boolean(result.hasMore),
    customerOfficerVersion:result.officerVersion,customerOfficerState:result.officerState});
  }catch(error){if(current()){
   if((error as {code?:string}).code==='CAPABILITY_REQUIRED'){this.closeAll();void this.load();return;}
   this.setData({customerError:officerError(error)});
  }}finally{if(current())this.setData({customerLoading:false});}
 },
 changeCustomerFilter(e:WechatMiniprogram.CustomEvent){
  const index=Number(e.detail.value);
  if(this.data.busy||this.data.pending||!customerFilters[index]||index===this.data.customerFilterIndex)return;
  this.customerAttempt++;
  this.setData({...customerEmpty,customerFilterIndex:index});
  void this.readCustomers();
 },
 retryCustomers(){void this.readCustomers();},
 moreCustomers(){if(this.data.customerMore)void this.readCustomers(true);},
 chooseCustomer(e:WechatMiniprogram.TouchEvent){
  if(!this.current()||this.data.sheet!=='customers'||!this.data.scope?.customers||this.data.busy||this.data.pending||this.data.customerLoading||this.data.customerError)return;
  const row=this.data.customers.find(item=>item.id===e.currentTarget.dataset.id);
  if(!row||row.id===this.data.memberId||row.expired||(row.removedAt&&!row.restorable))return;
  this.setData({sheet:'customer-decision',customerSelected:row,reason:'',error:''});
 },
 async confirmCustomer(){
  const row=this.data.customerSelected,selected=this.data.selected,reason=this.data.reason.trim();
  if(!this.current()||this.data.sheet!=='customer-decision'||!this.data.scope?.customers||!row||!selected||this.data.pending||this.data.busy||reason.length<2)return;
  const epoch=this.epoch,remove=!row.removedAt,action=remove?'移除归属':'恢复归属';
  const content=remove?'移除后，这名会员的新订单不计入此分享官名下。':
   this.data.customerOfficerState==='suspended'?'归属将恢复。分享官资格恢复后的新订单才计佣。':'恢复后的新订单计入此分享官名下。';
  const input={memberId:selected.memberId,buyerId:row.id,expectedVersion:row.version,expectedControlVersion:row.controlVersion,
   expectedOfficerVersion:this.data.customerOfficerVersion,reason,remove,confirmed:true};
  this.setData({busy:true,error:''});
  try{
   const confirmation=await wx.showModal({title:action,content:content+'历史订单按原归属处理。',confirmText:remove?'确认移除':'确认恢复'});
   if(!confirmation.confirm||!this.current(epoch))return;
   await officerCommand(this.data.memberId,'customer_relation',input,true);
   if(!this.current(epoch))return;
   wx.showToast({title:remove?'已移除归属':'已恢复归属',icon:'none'});
   this.setData({sheet:'customers',customerSelected:null,customers:[],customerMore:false,customerCursor:null,reason:''});
   void this.readCustomers();
  }catch(error){if(this.current(epoch)){
   const code=(error as {code?:string}).code;
   if(code==='CAPABILITY_REQUIRED'){this.closeAll();void this.load();return;}
   if(['VERSION_CONFLICT','SHARING_CUSTOMER_EXPIRED','SHARING_CUSTOMER_REPLACEMENT_PENDING'].includes(code??'')){
    this.setData({sheet:'customers',customerSelected:null,reason:''});
    wx.showToast({title:officerError(error),icon:'none'});
    void this.readCustomers();
   }else this.setData({error:officerError(error),pending:officerPending(this.data.memberId)});
  }}finally{if(this.current(epoch))this.setData({busy:false});}
 },
 chooseDecision(e:WechatMiniprogram.TouchEvent){
  if(!this.current()||!this.data.scope?.manage||this.data.busy||this.data.pending||this.data.sheet!=='officer'||!this.data.selected||this.data.selected.memberId===this.data.memberId)return;
  const state=String(e.currentTarget.dataset.state),selected=this.data.selected;
  if(!this.data.review?.accountActive||this.data.reviewStale||(selected.state==='pending'&&state==='active'&&!this.data.review.canApprove))return;
  this.setData({decisionState:state,decisionLabel:String(e.currentTarget.dataset.label),sheet:'decision',verificationReference:'',reason:'',error:''});},
 selectBatch(e:WechatMiniprogram.TouchEvent){if(this.data.busy)return;const row=this.data.items.find(v=>v.id===e.currentTarget.dataset.id);if(!row)return;this.setData({batchId:row.id,batchPeriod:row.period,items:[],nextCursor:null,hasMore:false});void this.load();},
 closeBatch(){if(this.data.busy)return;this.setData({batchId:'',batchPeriod:'',items:[]});void this.load();},
 selectLine(e:WechatMiniprogram.TouchEvent){if(this.data.busy||this.data.pending)return;const row=this.data.items.find(v=>v.id===e.currentTarget.dataset.id);if(row)this.setData({sheet:'line',selected:row,payee:null,sourceOrders:[],sourceCursor:null,sourceMore:false,error:'',tax:row.taxCents===null?'':row.tax,taxNote:row.taxNote??'',reference:'',paymentNote:'',paidAt:new Date(Date.now()+8*3600_000).toISOString().slice(0,19).replace('T',' ')});},
 async readPayee(){if(this.data.busy||!this.data.selected)return;const epoch=this.epoch;this.setData({busy:true,error:''});try{const payee=await request<any>({path:'/v1/management/sharing-officer/payee/'+this.data.selected.memberId,method:'POST'});if(this.current(epoch))this.setData({payee});}catch(e){if(this.current(epoch))this.setData({error:officerError(e)});}finally{if(this.current(epoch))this.setData({busy:false});}},
 async order(e:WechatMiniprogram.TouchEvent){if(this.data.busy)return;const selected=[...this.data.items,...this.data.sourceOrders].find(v=>v.id===e.currentTarget.dataset.id);if(!selected)return;this.setData({sheet:'order',selected,error:'',orderDetail:null,history:[],historyCursor:null,historyMore:false,recoveryAmount:'',receivedAmount:'',taxAdjustment:'',reference:'',reason:''});await this.readHistory();},
 async readHistory(more=false){const selected=this.data.selected;if(!selected||this.data.sheet!=='order'||this.data.historyLoading)return;const epoch=this.epoch;this.setData({historyLoading:true});try{const data=await officerRead(this,`/v1/management/sharing-officer/orders/${selected.id}?limit=20${more&&this.data.historyCursor?'&cursor='+encodeURIComponent(this.data.historyCursor):''}`);if(this.current(epoch)&&this.data.sheet==='order'&&this.data.selected?.id===selected.id)this.setData({history:[...(more?this.data.history:[]),...data.items.map(officerHistoryRow)],historyCursor:data.nextCursor,historyMore:data.hasMore});}catch(e){if(this.current(epoch))this.setData({error:officerError(e)});}finally{if(this.current(epoch)&&this.data.selected?.id===selected.id)this.setData({historyLoading:false});}},
 moreHistory(){void this.readHistory(true);},
 async lineOrders(more=false){const selected=this.data.selected;if(!selected||this.data.busy||this.data.loading)return;const epoch=this.epoch;this.setData({historyLoading:true,error:''});try{const result=await officerRead(this,`/v1/management/sharing-officer?section=orders&lineId=${selected.id}&limit=20${more&&this.data.sourceCursor?'&cursor='+encodeURIComponent(this.data.sourceCursor):''}`);if(this.current(epoch)&&this.data.sheet==='line'&&this.data.selected?.id===selected.id)this.setData({sourceOrders:[...(more?this.data.sourceOrders:[]),...result.items.map(viewRow)],sourceCursor:result.nextCursor,sourceMore:result.hasMore});}catch(e){if(this.current(epoch))this.setData({error:officerError(e)});}finally{if(this.current(epoch))this.setData({historyLoading:false});}},
 loadLineOrders(){void this.lineOrders();},moreLineOrders(){void this.lineOrders(true);},
 close(){
  if(this.data.busy)return;
  const sheet=this.data.sheet;
  if(sheet==='customer-decision'){this.setData({sheet:'customers',customerSelected:null,reason:'',error:''});return;}
  if(sheet==='customers'||sheet==='decision'){
   this.customerAttempt++;
   this.setData({...customerEmpty,sheet:'officer',reason:'',verificationReference:'',error:''});
   void this.readOfficerReview();
   return;
  }
  this.closeAll();
 },
 closeAll(){
  this.reviewAttempt++;
  this.customerAttempt++;
  this.setData({...reviewEmpty,sheet:'',selected:null,payee:null,orderDetail:null,history:[],historyCursor:null,historyMore:false,historyLoading:false,reason:'',verificationReference:'',taxNote:'',reference:'',paymentNote:'',error:''});
 },
 stop(){},
 back(){if(this.data.busy)return;if(this.data.sheet){this.close();return;}if(this.data.batchId){this.closeBatch();return;}wx.navigateBack({fail:()=>wx.switchTab({url:'/pages/profile/index'})});},
 async operate(e:WechatMiniprogram.TouchEvent){if(this.data.busy||this.data.pending||!this.current())return;const action=String(e.currentTarget.dataset.action);if(this.target.memberId&&['prepare_month','policy'].includes(action))return;const selected=this.data.selected;let input:Record<string,unknown>;
  if(action==='policy')input={enabled:this.data.enabled,attributionDays:this.data.durationIndex===0?null:Number(this.data.attributionDays),priority:this.data.priorityIndex===0?'first':'last',selfPurchase:false,basisPoints:moneyInput(this.data.rate),releaseDays:Number(this.data.days),reason:this.data.reason,expectedVersion:this.data.policy?.version??0};
  else if(action==='officer_state'&&selected&&this.data.scope?.manage&&this.data.sheet==='decision'&&selected.memberId!==this.data.memberId)input={memberId:selected.memberId,state:this.data.decisionState,reason:this.data.reason,expectedVersion:selected.version,
   ...(selected.agreementVersion&&selected.state==='pending'&&this.data.decisionState==='active'?{verificationReference:this.data.verificationReference.trim()}:{})};
  else if(action==='prepare_month')input={period:this.data.period,...(this.data.continuePrepare?{afterMemberId:this.data.afterMemberId}:{})};
  else if(action==='review_line'&&selected)input={lineId:selected.id,expectedVersion:selected.version,taxCents:moneyInput(this.data.tax),taxNote:this.data.taxNote};
  else if(action==='void_line'&&selected)input={lineId:selected.id,expectedVersion:selected.version,reason:this.data.reason};
  else if(action==='record_payment'&&selected){const confirmed=await wx.showModal({title:'登记已完成的付款',content:`税前 ¥${selected.gross}，扣税 ¥${selected.tax}，实际付款 ¥${selected.net}。请确认公司已经付款。`,confirmText:'已实际付款'});if(!confirmed.confirm||!this.current())return;
   input={lineId:selected.id,expectedVersion:selected.version,paidConfirmed:true,paymentReference:this.data.reference,paymentNote:this.data.paymentNote,paidAt:this.data.paidAt.replace(' ','T')+(this.data.paidAt.length===16?':00':'')+'+08:00'};}
  else if(action==='record_recovery'&&selected){const confirmed=await wx.showModal({title:'登记已完成的回收',content:'请确认公司已实际收到退款佣金，税务调整金额已经财务审核。',confirmText:'已实际收回'});if(!confirmed.confirm||!this.current())return;input={orderId:selected.id,amountCents:moneyInput(this.data.recoveryAmount),receivedCents:moneyInput(this.data.receivedAmount),taxAdjustmentCents:this.data.taxAdjustment.startsWith('-')?-moneyInput(this.data.taxAdjustment.slice(1)):moneyInput(this.data.taxAdjustment),reference:this.data.reference,note:this.data.reason,receivedConfirmed:true};}else return;
  const epoch=this.epoch;this.setData({busy:true,error:''});try{
   if(action==='officer_state'&&selected.state!=='pending'){
    const label=this.data.decisionLabel,content=qualificationConfirmation[this.data.decisionState];
    if(!content)return;
    const confirmed=await wx.showModal({title:'确认'+label,content,confirmText:'确认'});
    if(!confirmed.confirm||!this.current(epoch))return;
   }
   const result=await officerCommand(this.data.memberId,action,input,true);if(!this.current(epoch))return;
   this.setData({sheet:'',selected:null,payee:null,reason:'',verificationReference:'',reference:'',paymentNote:'',taxNote:'',...(action==='prepare_month'?{batchId:result.batchId,batchPeriod:result.period,continuePrepare:result.hasMore,afterMemberId:result.afterMemberId??''}:{})});
   const title=action==='prepare_month'?`已生成 ${result.created} 条`:action==='officer_state'&&result.state==='active'?(selected.state==='suspended'?'资格已恢复':'分享官已开通'):'已保存';
   wx.showToast({title,icon:'none'});await this.load();
  }catch(error){if(this.current(epoch))this.setData({error:officerError(error),pending:officerPending(this.data.memberId)});}finally{if(this.current(epoch))this.setData({busy:false});}},
 async recover(e:WechatMiniprogram.TouchEvent){const p=this.data.pending;if(!p||this.data.busy)return;const epoch=this.epoch;this.setData({busy:true,error:''});try{const r=await resolveOfficerPending(p,e.currentTarget.dataset.abandon===true);if(!this.current(epoch))return;if(r.state==='not_found')this.setData({error:'尚未执行，可结束这次请求后重新填写。'});else{this.setData({pending:null,sheet:'',payee:null});await this.load();}}catch(e){if(this.current(epoch))this.setData({error:officerError(e)});}finally{if(this.current(epoch))this.setData({busy:false});}},
 async exportBatch(){if(this.target.memberId)return;if(this.data.busy||!this.data.batchId||!this.data.scope?.finance)return;const epoch=this.epoch,path=`${wx.env.USER_DATA_PATH}/sharing-settlement-${Date.now()}.csv`;this.files.push(registerPrivateExport(path));this.setData({busy:true,error:''});try{let cursor='',first=true;do{const r=await officerRead(this,`/v1/management/sharing-officer/batches/${this.data.batchId}/export?limit=50${cursor?'&cursor='+encodeURIComponent(cursor):''}`);if(!this.current(epoch))return;const data=first?r.csv:r.csv.replace(/^\uFEFF[^\r]*\r\n/,'');if(first)wx.getFileSystemManager().writeFileSync(path,data,'utf8');else wx.getFileSystemManager().appendFileSync(path,'\r\n'+data,'utf8');first=false;cursor=r.nextCursor??'';}while(cursor);
   if(this.current(epoch))wx.shareFileMessage({filePath:path,fileName:`分享官月结-${this.data.batchPeriod}.csv`,fail:()=>{if(this.current())this.setData({error:'文件已生成，可重试导出。'});}});
  }catch(e){if(this.current(epoch))this.setData({error:officerError(e)});}finally{if(this.current(epoch))this.setData({busy:false});}},
 cleanup(){for(const release of this.files)release();this.files=[];}
});
