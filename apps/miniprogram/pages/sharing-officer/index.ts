import {officerRewardOffers,prepareOfficerRewardShare,type OfficerRewardOffers} from '../../services/rewards';
import {prepareRewardDetailImages} from '../../services/reward-images';
import {clientOperationKey} from '../../services/orders';
import {requireMemberAccess,request} from '../../services/api';
import {currentChromeStyle} from '../../services/layout';
import {cancelPageReads} from '../../services/page-requests';
import {commerceContextRevision} from '../../services/commerce-command-store';
import {catalogList} from '../../services/commerce';
import {nativeCatalogImage} from '../../services/catalog';
import {campaignEssenceCode} from '../../services/home-campaign';
import {sectionTabValue} from '../../services/section-tabs';
import {officerRead,officerCommand,officerPending,resolveOfficerPending,officerMoney,officerDate,officerError,officerLabels,officerHistoryRow,type OfficerPending} from '../../services/sharing-officer';
const tabs=[{id:'overview',label:'推广'},{id:'orders',label:'推广订单'},{id:'settlements',label:'结算'}];
function orderRow(r:any){return {...r,date:officerDate(r.createdAt),cash:officerMoney(r.cashMerchandiseCents),refund:officerMoney(r.refundedMerchandiseCents),pending:officerMoney(r.pendingCents),available:officerMoney(r.availableCents),settled:officerMoney(r.settledCents),recovery:officerMoney(r.outstandingRecoveryCents),rate:(r.basisPoints/100).toFixed(2).replace(/\.00$/,''),label:r.orderStatus==='pending_payment'?'待付款':['cancelled','expired','closed'].includes(r.orderStatus)?'已关闭':r.disputed?'售后处理中':r.outstandingRecoveryCents?'待核对冲回':r.paymentHeldCents?'结算中':r.settledCents?'已结算':r.availableCents?'可结算':r.pendingCents?'待结算':r.paidAt?'无可结算佣金':'未计佣'};}
function settlementRow(r:any){return {...r,date:officerDate(r.paidAt||r.createdAt),gross:officerMoney(r.grossCents),tax:officerMoney(r.taxCents),net:officerMoney(r.netCents),label:officerLabels[r.state]||r.state};}
const giftClear={giftActivities:[] as OfficerRewardOffers['activities'],giftActivityId:'',giftBundles:[] as any[],giftShare:null as any,giftShareBusy:false,giftError:'',giftAvailable:false,detailBusy:false};
const cleared={...giftClear,memberId:'',wallet:null as any,metrics:{} as Record<string,string>,items:[] as any[],products:[] as any[],productCursor:null as string|null,moreProducts:false,nextCursor:null as string|null,hasMore:false,pending:null as OfficerPending|null,preview:null as any,assets:null as any,share:null as any,sheet:'',selected:null as any,history:[] as any[],historyCursor:null as string|null,historyMore:false,historyLoading:false,orderLineId:'',sourcePeriod:'',note:'',legalName:'',channel:'',account:'',code:'',error:''};
Page({
 alive:false,visible:false,epoch:0,session:'',context:0,qrPath:'',
 data:{...cleared,chromeStyle:currentChromeStyle(),tabs,tab:'overview',referrerOnly:false,loading:true,busy:false,stateLabel:'',rate:'',releaseDays:0,hasDashboard:false,giftMode:false},
 onLoad(query:Record<string,string>){this.alive=true;this.setData({referrerOnly:query.mode==='referrer',giftMode:query.mode==='gift'});},
 onShow(){wx.hideShareMenu();this.visible=true;this.epoch++;const session=getApp<IAppOption>().globalData.sessionToken,context=commerceContextRevision();if(session!==this.session||context!==this.context)this.setData({...cleared});this.session=session;this.context=context;if(requireMemberAccess())void this.load();},
 onHide(){wx.hideShareMenu();this.visible=false;this.epoch++;cancelPageReads(this);this.cleanupQr();this.setData({sheet:'',legalName:'',channel:'',account:'',assets:null,giftShare:null,giftShareBusy:false,detailBusy:false});},
 onUnload(){this.onHide();this.alive=false;this.setData({...cleared});},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 current(epoch?:number){return this.alive&&this.visible&&(epoch===undefined||epoch===this.epoch)&&this.session===getApp<IAppOption>().globalData.sessionToken&&this.context===commerceContextRevision();},
 async load(more=false){if(!this.current())return;const epoch=++this.epoch;this.setData({loading:true,error:''});try{
  const wallet=await officerRead(this,'/v1/me/sharing-officer');if(!this.current(epoch))return;
  const metrics:Record<string,string>={};for(const key of Object.keys(wallet.metrics))metrics[key]=officerMoney(wallet.metrics[key]);
  this.setData({wallet,memberId:wallet.memberId,metrics,stateLabel:wallet.officer?.state==='active'&&!wallet.policy?.enabled?'推广已暂停':officerLabels[wallet.officer?.state]||'',hasDashboard:Boolean(wallet.officer&&(['active','suspended','terminated'].includes(wallet.officer.state)||wallet.metrics.orderCount>0)),rate:((wallet.policy?.basisPoints??0)/100).toFixed(2).replace(/\.00$/,''),releaseDays:wallet.policy?.releaseDays??0,pending:officerPending(wallet.memberId)});
  if(this.data.giftMode){await this.loadGiftOffers(epoch);return;}
  if(!this.data.referrerOnly&&wallet.officer?.state==='active'&&this.data.tab==='overview')await this.loadProducts(false,epoch);
  if(!this.data.referrerOnly&&this.data.tab!=='overview'){
   const page=await officerRead(this,`/v1/me/sharing-officer/${this.data.tab}?limit=20${this.data.tab==='orders'&&this.data.orderLineId?'&lineId='+this.data.orderLineId:''}${more&&this.data.nextCursor?'&cursor='+encodeURIComponent(this.data.nextCursor):''}`);if(!this.current(epoch))return;
   const rows=page.items.map(this.data.tab==='orders'?orderRow:settlementRow);this.setData({items:more?[...this.data.items,...rows]:rows,nextCursor:page.nextCursor,hasMore:page.hasMore});
  }
 }catch(error){if(this.current(epoch))this.setData({error:officerError(error)});}finally{if(this.current(epoch))this.setData({loading:false,busy:false});wx.stopPullDownRefresh();}},
 openGiftSharing(){if(this.current()&&this.data.wallet?.canShare&&!this.data.busy&&!this.data.pending)wx.navigateTo({url:'/pages/sharing-officer/index?mode=gift'});},
 async loadGiftOffers(epoch:number){
  if(!this.data.wallet?.canShare){this.setData({...giftClear});return;}
  const result=await officerRewardOffers(this);if(!this.current(epoch)||result.memberId!==this.data.memberId)return;
  const activity=result.activities.find(a=>a.id===this.data.giftActivityId)??result.activities[0];
  this.setData({giftActivities:result.activities,giftActivityId:activity?.id??'',giftShare:null,giftBundles:(activity?.bundles??[]).map(b=>({...b,photo:`/pages/sharing-officer/assets/travel-${b.code}-pair-v3.webp`,benefit:b.code==='moisture'?'温和净洗 · 柔顺有光':'控油净屑 · 洗后清爽'})),giftAvailable:activity?.bundles.some(b=>b.available)??false});
  if(this.data.giftAvailable)await this.prepareGiftShare(epoch);
 },
 async chooseGiftActivity(e:WechatMiniprogram.PickerChange){if(!this.current()||this.data.loading||this.data.giftShareBusy)return;const a=this.data.giftActivities[Number(e.detail.value)];if(!a||a.id===this.data.giftActivityId)return;this.setData({giftActivityId:a.id,giftShare:null,giftError:''});await this.load();},
 async prepareGiftShare(epoch?:number){
  epoch=epoch??this.epoch;
  if(!this.current(epoch)||!this.data.wallet?.canShare||!this.data.giftActivityId||!this.data.giftAvailable||this.data.giftShareBusy)return;
  const id=this.data.giftActivityId;this.setData({giftShareBusy:true,giftError:''});
  try{const share=await prepareOfficerRewardShare(id,clientOperationKey('gift-share'));if(this.current(epoch)&&id===this.data.giftActivityId&&share.activityId===id){this.setData({giftShare:share});wx.showShareMenu({menus:['shareAppMessage']});}}
  catch(error){if(this.current(epoch)){this.setData({giftShare:null,giftError:officerError(error)});if((error as {code?:string})?.code==='SHARING_OFFICER_INACTIVE')this.setData({...giftClear,wallet:null,error:'分享官资格已更新，请返回后重新查看'});}}
  finally{if(this.current(epoch))this.setData({giftShareBusy:false});}
 },
 retryGiftShare(){if(!this.data.loading)void this.prepareGiftShare();},
 async giftDetails(e:WechatMiniprogram.TouchEvent){const code=String(e.currentTarget.dataset.code);if(!['moisture','dandruff'].includes(code)||!this.current()||this.data.detailBusy)return;const epoch=this.epoch;this.setData({detailBusy:true});try{const images=await prepareRewardDetailImages('sharing-officer');if(this.current(epoch))wx.previewImage({current:images[code as 'moisture'|'dandruff'],urls:[images.moisture,images.dandruff]});}catch{if(this.current(epoch))wx.showToast({title:'图片暂不可用，请重试',icon:'none'});}finally{if(this.current(epoch))this.setData({detailBusy:false});}},
 async loadProducts(more=false,epoch?:number){const page=await catalogList(more&&this.data.productCursor?this.data.productCursor:undefined,this);if(!this.current(epoch))return;
  this.setData({products:[...(more?this.data.products:[]),...page.items.map((p:any)=>({...p,displayImage:nativeCatalogImage(p.imagePath||p.image||''),price:p.price!==null?officerMoney(p.price):''}))],productCursor:page.nextCursor,moreProducts:Boolean(page.nextCursor)});},
 qualifyPurchase(){if(!this.current()||this.data.busy||this.data.pending)return;wx.navigateTo({url:`/pages/product/index?id=${campaignEssenceCode}`});},
 retry(){if(!this.data.busy)void this.load();},
 onPullDownRefresh(){if(!this.data.busy)void this.load();else wx.stopPullDownRefresh();},
 more(){if(!this.data.loading&&!this.data.busy&&this.data.hasMore)void this.load(true);},
 async moreProducts(){if(this.data.loading||this.data.busy)return;this.setData({busy:true});try{await this.loadProducts(true);}catch(e){this.setData({error:officerError(e)});}finally{if(this.current())this.setData({busy:false});}},
 changeTab(e:unknown){const tab=sectionTabValue(e);if(this.data.busy||this.data.pending||!tabs.some(t=>t.id===tab)||tab===this.data.tab)return;cancelPageReads(this);this.epoch++;this.setData({tab,items:[],nextCursor:null,hasMore:false,orderLineId:'',sourcePeriod:''});void this.load();},
 edit(e:WechatMiniprogram.CustomEvent){const field=String(e.currentTarget.dataset.field);if(['note','legalName','channel','account','code'].includes(field)&&!this.data.busy)this.setData({[field]:String(e.detail.value),...(field==='code'?{preview:null}:{})});},
 open(e:WechatMiniprogram.TouchEvent){if(this.data.busy||this.data.pending)return;const sheet=String(e.currentTarget.dataset.sheet);if(sheet==='apply'&&!this.data.wallet?.canApply)return;if(['apply','payee','referrer'].includes(sheet))this.setData({sheet,preview:null,code:'',note:'',legalName:'',channel:'',account:'',error:''});},
 close(){if(!this.data.busy){this.cleanupQr();this.setData({sheet:'',selected:null,history:[],historyCursor:null,historyMore:false,historyLoading:false,assets:null,preview:null,legalName:'',channel:'',account:'',error:''});}},
 stop(){},back(){if(this.data.busy)return;wx.navigateBack({fail:()=>wx.switchTab({url:'/pages/profile/index'})});},
 async operate(e:WechatMiniprogram.TouchEvent){if(this.data.busy||this.data.pending||!this.current())return;const action=String(e.currentTarget.dataset.action);let input:Record<string,unknown>;
  if(action==='apply'){if(!this.data.wallet?.canApply)return;input={note:this.data.note};}else if(action==='payee')input={legalName:this.data.legalName,channel:this.data.channel,account:this.data.account,expectedVersion:this.data.wallet?.payee?.version??0};
  else if(action==='change_referrer'&&this.data.preview?.eligible===true)input={code:this.data.preview.code,confirmed:true,expectedVersion:this.data.wallet?.relation?.version??0};else return;
  this.setData({busy:true,error:''});const epoch=this.epoch;
  try{await officerCommand(this.data.memberId,action,input);if(!this.current(epoch))return;this.setData({sheet:'',legalName:'',channel:'',account:'',preview:null});wx.showToast({title:action==='apply'?'申请已提交':action==='payee'?'收款资料已保存':'推荐人已更新',icon:'success'});await this.load();}
  catch(error){if(this.current(epoch))this.setData({error:officerError(error),pending:officerPending(this.data.memberId)});}finally{if(this.current(epoch))this.setData({busy:false});}},
 async recover(e:WechatMiniprogram.TouchEvent){const p=this.data.pending;if(!p||this.data.busy)return;const epoch=this.epoch;this.setData({busy:true,error:''});try{const r=await resolveOfficerPending(p,e.currentTarget.dataset.abandon===true);if(!this.current(epoch))return;if(r.state==='not_found')this.setData({error:'尚未执行，可结束这次请求后重新填写。'});else{this.setData({pending:null,sheet:''});await this.load();}}catch(e){if(this.current(epoch))this.setData({error:officerError(e)});}finally{if(this.current(epoch))this.setData({busy:false});}},
 async previewReferrer(){if(this.data.busy)return;const epoch=this.epoch;this.setData({busy:true,error:'',preview:null});try{const p=await officerRead(this,'/v1/me/sharing-officer/referrer-preview?code='+encodeURIComponent(this.data.code.trim().toUpperCase()));if(this.current(epoch))this.setData({preview:p});}catch(e){if(this.current(epoch))this.setData({error:officerError(e)});}finally{if(this.current(epoch))this.setData({busy:false});}},
 async promote(e:WechatMiniprogram.TouchEvent){if(!this.data.wallet?.canShare||this.data.busy||this.data.pending)return;const product=this.data.products.find(p=>p.code===e.currentTarget.dataset.code);if(!product)return;
  const epoch=this.epoch;this.setData({busy:true,error:'',share:null,assets:null,sheet:'share',selected:product});
  try{const share=await officerCommand(this.data.memberId,'share',{productCode:product.code});if(!this.current(epoch))return;this.setData({share});wx.showShareMenu({menus:['shareAppMessage']});
   const assets=await request<any>({path:'/v1/me/sharing-officer/share-assets',method:'POST',data:{shareId:share.shareId}});if(!this.current(epoch))return;
   this.cleanupQr();this.qrPath=`${wx.env.USER_DATA_PATH}/sharing-${share.shareId}.png`;wx.getFileSystemManager().writeFileSync(this.qrPath,assets.qrPngBase64,'base64');this.setData({assets:{...assets,qrPath:this.qrPath}});
  }catch(e){if(this.current(epoch))this.setData({error:officerError(e),pending:officerPending(this.data.memberId)});}finally{if(this.current(epoch))this.setData({busy:false});}},
 copyLink(){const url=this.data.assets?.urlLink;if(url)wx.setClipboardData({data:url});},
 previewCode(){if(this.qrPath)wx.previewImage({current:this.qrPath,urls:[this.qrPath]});},
 cleanupQr(){if(this.qrPath){try{wx.getFileSystemManager().unlinkSync(this.qrPath);}catch{}this.qrPath='';}},
 onShareAppMessage(){if(this.data.giftMode){const share=this.current()&&this.data.wallet?.canShare&&this.data.giftShare?.activityId===this.data.giftActivityId?this.data.giftShare:null;return {title:'送你一份旅行洗护礼遇',path:share?.path??'/pages/home/index',imageUrl:'/assets/cisme/travel-reward-share-v2.jpg'};}return {title:this.data.selected?.name||'CISME',path:this.current()&&this.data.wallet?.canShare?this.data.share?.path||'/pages/shop/index':'/pages/shop/index'};},
 async detail(e:WechatMiniprogram.TouchEvent){if(this.data.busy)return;const selected=this.data.items.find(v=>v.id===e.currentTarget.dataset.id);if(!selected)return;this.setData({sheet:'detail',selected,history:[],historyCursor:null,historyMore:false});if(this.data.tab==='orders')await this.readHistory();},
 async readHistory(more=false){const selected=this.data.selected;if(!selected||this.data.sheet!=='detail'||this.data.historyLoading)return;const epoch=this.epoch;this.setData({historyLoading:true});try{
  const data=await officerRead(this,`/v1/me/sharing-officer/orders/${selected.id}?limit=20${more&&this.data.historyCursor?'&cursor='+encodeURIComponent(this.data.historyCursor):''}`);
  if(this.current(epoch)&&this.data.sheet==='detail'&&this.data.selected?.id===selected.id)this.setData({history:[...(more?this.data.history:[]),...data.items.map(officerHistoryRow)],historyCursor:data.nextCursor,historyMore:data.hasMore});
 }catch(e){if(this.current(epoch)&&this.data.sheet==='detail')this.setData({error:officerError(e)});}finally{if(this.current(epoch)&&this.data.selected?.id===selected.id)this.setData({historyLoading:false});}},
 moreHistory(){void this.readHistory(true);},
 settlementOrders(){if(!this.data.selected||this.data.busy)return;const selected=this.data.selected;this.setData({tab:'orders',orderLineId:selected.id,sourcePeriod:selected.period,sheet:'',items:[],nextCursor:null,hasMore:false});void this.load();},
 clearSource(){if(this.data.busy)return;this.setData({orderLineId:'',sourcePeriod:'',items:[],nextCursor:null,hasMore:false});void this.load();}

});
