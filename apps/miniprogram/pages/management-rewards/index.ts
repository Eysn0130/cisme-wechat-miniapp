import{sectionTabValue}from'../../services/section-tabs';
import {requireMemberAccess} from '../../services/api';
import {currentChromeStyle} from '../../services/layout';
import {cancelPageReads} from '../../services/page-requests';
import {commerceContextRevision} from '../../services/commerce-command-store';
import {catalogList,type CatalogProduct} from '../../services/commerce';
import {rewardManagement,rewardManagementCommand,rewardClaim,rewardReceipt,abandonReward,exportRewards,prepareRewardShare,rewardCopy,rewardDate,rewardState,
 type RewardManagement,type RewardActivity,type RewardClaim,type RewardTerms,type RewardShare} from '../../services/rewards';
import {pendingReward,prepareReward,forgetReward,type RewardPending} from '../../services/reward-command-store';
const exportsList=[{code:'awarded',name:'领券会员'},{code:'issued',name:'已发券'},{code:'claimed',name:'已领取'},{code:'pending_dispatch',name:'待发货'},{code:'unclaimed',name:'未领取'}];
const empty={manager:null as RewardManagement|null,detail:null as RewardClaim|null,products:[] as Array<CatalogProduct&{selected:boolean}>,productCursor:null as string|null,selectedProducts:[] as string[],pending:null as RewardPending|null,
 sheet:'',titleInput:'',codeInput:'',reasonInput:'',issueInput:'',batchInput:'',stockInput:'',stockCode:'',stockDirection:1,stockVersion:0,stockVersions:{} as Record<string,number>,share:null as RewardShare|null,trackingInput:'',carrierInput:'',memberId:'',error:''};
Page({
 alive:false,visible:false,epoch:0,token:'',context:0,target:{memberId:'',voucherId:'',claimId:'',tab:''},openedTarget:false,exportFiles:[] as string[],
 data:{...empty,chromeStyle:currentChromeStyle(),loading:true,busy:false,activityId:'',activityIndex:0,activity:null as RewardActivity|null,tab:'activity',filter:'all',filterIndex:0,
  filters:[{code:'all',name:'全部'}],exports:exportsList,exportIndex:0,exportAfter:'',nextCursor:null as string|null,hasMore:false,editingId:'',editingVersion:0,detailState:'',stockLabel:'',targetMemberId:''},
 onLoad(q:Record<string,string|undefined>={}){this.alive=true;this.target={memberId:q.memberId||'',voucherId:q.voucherId||'',claimId:q.claimId||'',tab:q.tab||''};this.setData({targetMemberId:this.target.memberId,tab:q.claimId?'fulfill':q.memberId?'issue':'activity',filter:'all'});},
 onShow(){this.visible=true;this.epoch++;this.cleanupExports();const token=getApp<IAppOption>().globalData.sessionToken,context=commerceContextRevision();if(token!==this.token||context!==this.context)this.setData({...empty,activityId:'',activity:null});this.token=token;this.context=context;this.setData({busy:false});if(requireMemberAccess())void this.load();},
 onHide(){this.visible=false;this.epoch++;cancelPageReads(this);this.setData({sheet:'',detail:null,issueInput:'',trackingInput:'',carrierInput:'',reasonInput:''});},
 onUnload(){this.alive=false;this.visible=false;this.epoch++;cancelPageReads(this);this.cleanupExports();this.setData({...empty});},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 current(epoch?:number){return this.alive&&this.visible&&(epoch===undefined||epoch===this.epoch)&&this.token===getApp<IAppOption>().globalData.sessionToken&&this.context===commerceContextRevision();},
 async load(more=false){if(!this.current()||this.data.busy)return;const epoch=++this.epoch;this.setData({loading:true,error:''});
  try{const query=`?state=${encodeURIComponent(this.data.filter)}${this.data.activityId?`&activityId=${this.data.activityId}`:''}${more&&this.data.nextCursor?`&after=${this.data.nextCursor}`:''}`;
   const target=Object.entries(this.target).filter(([key,value])=>key!=='tab'&&value).map(([key,value])=>'&'+key+'='+encodeURIComponent(String(value))).join('');const manager=await rewardManagement(this,query+target);if(!this.current(epoch))return;
   const index=Math.max(0,manager.activities.findIndex(a=>a.id===(manager.selectedActivityId||this.data.activityId))),activity=manager.activities[index]??null;
   const previous=this.data.manager;
   const mapped:RewardManagement={...manager,vouchers:manager.vouchers.map(r=>({...r,label:rewardState[r.state],date:rewardDate(r.expires_at)})),claims:manager.claims.map(c=>({...c,label:rewardState[c.state],date:rewardDate(c.createdAt)}))};
   if(more&&previous){if(this.data.tab==='fulfill')mapped.claims=[...previous.claims,...mapped.claims];else mapped.vouchers=[...previous.vouchers,...mapped.vouchers];}
   const cursor=this.data.tab==='fulfill'?manager.claimNext:manager.voucherNext,pending=pendingReward(manager.memberId);
   this.setData({manager:mapped,memberId:manager.memberId,activityId:activity?.id??'',activityIndex:index,activity,nextCursor:cursor,hasMore:Boolean(cursor),pending});
   if(!this.openedTarget){this.openedTarget=true;if(this.target.claimId&&mapped.claims.some(c=>c.id===this.target.claimId))void this.openDetail({currentTarget:{dataset:{id:this.target.claimId}}} as any);else if(this.target.tab==='issue')this.openIssue();}
   if(pending){const r=await rewardReceipt(this,pending.key);if(!this.current(epoch))return;if(r.status!=='not_found'){forgetReward(pending);this.setData({pending:null});}}
  }catch(error){if(this.current(epoch)){const status=(error as {status?:number}).status;this.setData({...([401,403].includes(status??0)?{manager:null,detail:null,products:[],sheet:'',activity:null,share:null,stockVersions:{},issueInput:'',trackingInput:'',carrierInput:'',reasonInput:''}:{}),error:rewardCopy(error)});}}finally{if(this.current(epoch))this.setData({loading:false});}},
 back(){if(!this.data.busy)wx.navigateBack({fail:()=>wx.switchTab({url:'/pages/profile/index'})});},stop(){},
 closeSheet(){if(!this.data.busy)this.setData({sheet:'',detail:null,issueInput:'',trackingInput:'',carrierInput:'',reasonInput:''});},
 activityChange(event:{detail:{value:string}}){if(this.data.busy)return;const activity=this.data.manager?.activities[Number(event.detail.value)];if(activity){this.setData({share:null,sheet:'',activityId:activity.id,activityIndex:Number(event.detail.value),activity,exportAfter:'',filter:'all',filterIndex:0,nextCursor:null});void this.load();}},
 changeTab(event:WechatMiniprogram.TouchEvent){if(this.data.busy)return;const tab=sectionTabValue(event,'tab'),filters=tab==='fulfill'?[{code:'all',name:'全部'},{code:'placed',name:'待发货'},{code:'shipped',name:'待收货'},{code:'received',name:'已收货'},{code:'aftersale_requested',name:'售后中'},{code:'cancelled',name:'已取消'},{code:'closed',name:'已完成'}]:[{code:'all',name:'全部'},{code:'unused',name:'待领取'},{code:'used',name:'已领取'},{code:'expired',name:'已过期'},{code:'revoked',name:'已撤销'}];this.setData({tab,filters,filter:'all',filterIndex:0,nextCursor:null});void this.load();},
 filterChange(event:{detail:{value:string}}){const index=Number(event.detail.value);this.setData({filterIndex:index,filter:this.data.filters[index]?.code??'all',nextCursor:null});void this.load();},
 loadMore(){if(!this.data.loading&&!this.data.busy&&this.data.hasMore)void this.load(true);},
 retryLoad(){void this.load(false);},
 editField(event:WechatMiniprogram.Input){if(this.data.busy||this.data.pending)return;const field=String(event.currentTarget.dataset.field);if(['titleInput','codeInput','reasonInput','issueInput','batchInput','stockInput','trackingInput','carrierInput'].includes(field))this.setData({[field]:event.detail.value});},
 async openConfig(event?:WechatMiniprogram.TouchEvent){if(this.target.memberId)return;if(this.data.pending||this.data.busy||!this.data.manager?.permissions.configure)return;
  const create=event?.currentTarget.dataset.new===true||event?.currentTarget.dataset.new==='true',a=create?null:this.data.activity;
  this.setData({sheet:'config',editingId:a?.id??'',editingVersion:a?.version??0,titleInput:a?.title??'旅行洗护礼遇',codeInput:a?.code??`travel-gift-${Date.now().toString(36)}`,selectedProducts:a?.terms?.eligibleProductIds??[],reasonInput:'',products:[],productCursor:null});await this.loadProducts();},
 async loadProducts(){const epoch=this.epoch;try{const result=await catalogList(this.data.productCursor??undefined,this);if(this.current(epoch))this.setData({products:[...this.data.products,...result.items.map(p=>({...p,selected:this.data.selectedProducts.includes(p.productId)}))],productCursor:result.nextCursor});}catch(error){if(this.current(epoch))this.setData({error:rewardCopy(error)});}},
 changeProducts(event:{detail:{value:string[]}}){if(this.data.busy||this.data.pending)return;const displayed=new Set(this.data.products.map(p=>p.productId)),selectedProducts=[...this.data.selectedProducts.filter(id=>!displayed.has(id)),...event.detail.value];this.setData({selectedProducts,products:this.data.products.map(p=>({...p,selected:selectedProducts.includes(p.productId)}))});},
 async saveConfig(event:WechatMiniprogram.TouchEvent){const action=String(event.currentTarget.dataset.action??'save');
  if(!this.data.selectedProducts.length){this.setData({error:'请选择收货赠券的适用商品'});return;}
  const terms:RewardTerms={maxAwardsPerMember:1,voucherValidityDays:30,shippingCents:0,dispatchHours:72,restoreGraceDays:0,stockoutPolicy:'retain_until_expiry',eligibleProductIds:this.data.selectedProducts};
  await this.run('activities',{...(this.data.editingId?{id:this.data.editingId}:{}),code:this.data.codeInput.trim(),title:this.data.titleInput.trim(),expectedVersion:this.data.editingVersion,terms,action},this.data.editingId||'new-activity');},
 openStock(event:WechatMiniprogram.TouchEvent){if(this.target.memberId)return;if(this.data.busy||this.data.pending||!this.data.manager?.permissions.stock)return;const code=String(event.currentTarget.dataset.code),r=this.data.manager.bundles?.find(r=>r.code===code);if(r)this.setData({sheet:'stock',stockCode:code,stockLabel:r.name,stockVersions:r.expectedVersions,stockInput:'',stockDirection:1});},
 stockDirection(event:WechatMiniprogram.TouchEvent){if(!this.data.busy&&!this.data.pending)this.setData({stockDirection:Number(event.currentTarget.dataset.direction)});},
 async saveStock(){const amount=Number(this.data.stockInput);if(!/^\d{1,9}$/.test(this.data.stockInput)||!Number.isSafeInteger(amount)){this.setData({error:'请填写实际套数'});return;}await this.run('bundle-inventory',{bundleCode:this.data.stockCode,expectedVersions:this.data.stockVersions,delta:amount*this.data.stockDirection},this.data.stockCode);},
 async openIssue(){if(this.data.busy||this.data.pending||!this.data.manager?.permissions.issue||!this.data.activityId||this.data.activity?.state!=='published')return;const epoch=this.epoch;this.setData({busy:true,error:'',share:null});
  try{const pending=prepareReward(this.data.memberId,'management',this.data.activityId);this.setData({pending});const share=await prepareRewardShare(this.data.activityId,pending.key);if(!this.current(epoch))return;forgetReward(pending);this.setData({pending:null,share,sheet:'share'});wx.showShareMenu?.({menus:['shareAppMessage']});}
  catch(error){if(this.current(epoch))this.setData({error:rewardCopy(error)});}finally{if(this.current(epoch))this.setData({busy:false});}},
 onShareAppMessage(){const share=this.current()&&this.data.manager?.permissions.issue&&this.data.share?.activityId===this.data.activityId?this.data.share:null;return {title:'领取你的旅行洗护礼遇',path:share?.path??'/pages/home/index',imageUrl:'/assets/cisme/travel-reward-share-v2.jpg'};},
 async run(path:string,data:WechatMiniprogram.IAnyObject,objectId:string){if(this.data.busy||this.data.pending||!this.data.memberId)return;const epoch=this.epoch;let pending:RewardPending|null=null;this.setData({busy:true,error:''});
  try{pending=prepareReward(this.data.memberId,'management',objectId);this.setData({pending});const result=await rewardManagementCommand(path,data,pending.key);if(!this.current(epoch))return;
   forgetReward(pending);this.setData({pending:null,busy:false,sheet:'',detail:null,issueInput:'',trackingInput:'',carrierInput:'',reasonInput:'',...(path==='activities'&&result.id?{activityId:result.id}:{})});
   wx.showToast({title:typeof result.issued==='number'?`发出${result.issued}张，已有${result.existing??0}张`:'已更新',icon:'none'});await this.load();
  }catch(error){if(this.current(epoch))this.setData({error:rewardCopy(error)});}finally{if(this.current(epoch))this.setData({busy:false});}},
 async reconcile(){const p=this.data.pending;if(!p||this.data.busy)return;const epoch=this.epoch;this.setData({busy:true,error:''});try{await abandonReward(p.key);if(!this.current(epoch))return;forgetReward(p);this.setData({pending:null,busy:false,sheet:''});await this.load();}catch(error){if(this.current(epoch))this.setData({error:rewardCopy(error)});}finally{if(this.current(epoch))this.setData({busy:false});}},
 async openDetail(event:WechatMiniprogram.TouchEvent){if(this.data.busy||!this.data.manager?.permissions.fulfill)return;const epoch=this.epoch;this.setData({sheet:'detail',detail:null,error:'',reasonInput:'',trackingInput:'',carrierInput:''});try{const detail=await rewardClaim(this,String(event.currentTarget.dataset.id),true);if(this.current(epoch))this.setData({detail,detailState:rewardState[detail.state]??'状态待更新'});}catch(error){if(this.current(epoch))this.setData({error:rewardCopy(error)});}},
 async operate(event:WechatMiniprogram.TouchEvent){const c=this.data.detail,action=String(event.currentTarget.dataset.action);if(!c)return;
  if(action==='ship'&&(!this.data.carrierInput.trim()||!/^[A-Za-z0-9-]{6,80}$/.test(this.data.trackingInput.trim()))){this.setData({error:'请填写真实承运商与物流单号'});return;}
  if(action!=='ship'&&this.data.reasonInput.trim().length<3){this.setData({error:'请填写处理依据'});return;}
  await this.run(`claims/${c.id}/${action}`,{expectedVersion:c.version,...(action==='ship'?{carrierName:this.data.carrierInput.trim(),trackingNumber:this.data.trackingInput.trim()}:{reason:this.data.reasonInput.trim()})},c.id);},
 openRevoke(event:WechatMiniprogram.TouchEvent){if(this.data.busy||this.data.pending)return;const id=String(event.currentTarget.dataset.id),r=this.data.manager?.vouchers.find(v=>v.id===id);if(r)this.setData({sheet:'revoke',editingId:r.id,editingVersion:r.version,reasonInput:''});},
 async revoke(){if(this.data.reasonInput.trim().length<4){this.setData({error:'请填写至少4字的撤销依据'});return;}await this.run(`vouchers/${this.data.editingId}/revoke`,{expectedVersion:this.data.editingVersion,reason:this.data.reasonInput.trim()},this.data.editingId);},
 exportChange(event:{detail:{value:string}}){this.setData({exportIndex:Number(event.detail.value),exportAfter:''});},
 async export(){if(this.target.memberId)return;if(this.data.busy||!this.data.activityId||!this.data.manager?.permissions.issue)return;const epoch=this.epoch;this.setData({busy:true,error:''});try{
  const result=await exportRewards(this.data.activityId,this.data.exports[this.data.exportIndex]!.code,this.data.exportAfter||undefined);if(!this.current(epoch))return;
  if(!result.count){wx.showToast({title:'暂无对应记录',icon:'none'});return;}
  const path=`${wx.env.USER_DATA_PATH}/cisme-reward-export-${Date.now()}.xlsx`;this.exportFiles.push(path);
  await new Promise<void>((resolve,reject)=>wx.getFileSystemManager().writeFile({filePath:path,data:wx.base64ToArrayBuffer(result.fileBase64),success:()=>resolve(),fail:reject}));if(!this.current(epoch)){this.cleanupExports();return;}
  this.setData({exportAfter:result.nextCursor??''});await new Promise<void>((resolve,reject)=>wx.openDocument({filePath:path,fileType:'xlsx',showMenu:true,success:()=>resolve(),fail:reject}));
 }catch(error){if(this.current(epoch))this.setData({error:rewardCopy(error)});}finally{if(this.current(epoch))this.setData({busy:false});}},
 cleanupExports(){for(const path of this.exportFiles)wx.getFileSystemManager().unlink({filePath:path,fail:()=>undefined});this.exportFiles=[];}
});
