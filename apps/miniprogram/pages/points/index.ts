import {requireMemberAccess,retainMemberSnapshot,request} from '../../services/api';
import {currentChromeStyle} from '../../services/layout';
import {commerceContextRevision} from '../../services/commerce-command-store';
import {clientOperationKey,memberAddresses,type CheckoutAddress} from '../../services/orders';
import {readMyPoints,readPointsClub,readPointsGifts,readMyRedemptions,redemptionLabels,type PointRules,type PointsSnapshot,type PointsClub,type PointsGift,type PointsRedemption} from '../../services/points';
import {pendingPointsGift,preparePointsGift,dispatchPointsGift,inspectPointsGift} from '../../services/points-gift-recovery';
import {nativeCatalogImage} from '../../services/catalog';
function pointRuleRows(r:PointRules){return [{title:'护理与连续记录',copy:`每日首次有效护理记录 ${r.daily} 分；满10个有效字的感受额外 ${r.note} 分。同日多个产品只计一次。每连续满7天加 ${r.streak7} 分，每满30天加 ${r.streak30} 分，可叠加并循环；中断重新计数。不要求每天使用洗发水。`},
   {title:'建档与社区',copy:`首次完成基础护理建档 ${r.questionnaire} 分，跳过个人情况或拒绝可选授权不影响。安全检查通过的体验笔记 ${r.post} 分，每周最多 ${r.postWeeklyLimit} 篇；官方精选额外 ${r.featured} 分。同日最多 ${r.commentDailyLimit} 条有效评论，每条 ${r.comment} 分。重复或无意义内容不计分，删除或下架计分内容会撤回奖励。`},
   {title:'购物与邀请',copy:`现金实付商品每满1元基础1分；商品公示3倍时按订单倍率计分，运费不计；首笔有效订单额外 ${r.firstOrder} 分，确认收货后处理。生日当月首单购物积分在商品倍率基础上再乘 ${r.birthdayMultiplier}（3倍商品合计6倍），生日须在下单前填写，每年可设置一次。经邀请分享注册并完成首购收货，邀请人 ${r.inviteSponsor} 分、好友 ${r.inviteFriend} 分。退款会撤回奖励，不重复重置首购资格。`},
   {title:'使用与有效期',copy:`${r.pointsPerYuan} 积分可抵扣商品价1元，单笔最高 ${(r.discountBps/100).toFixed(0)}%，运费不抵扣；全部正常上架商品均可纯积分兑换。获得后 ${r.expiryMonths} 个自然月内有效，提前 ${r.reminderDays} 天在此提示。取消订单释放预占，已过期部分按原规则失效；实际退款退回原批次，已到期的退回积分延长 ${r.refundGraceDays} 天。不可提现或转让。`},
   {title:'异常和权益',copy:'新规则仅处理生效后的新事实，每笔奖励有唯一来源。已使用奖励被撤回后形成欠分，后续所得优先冲抵，欠分未清不能使用积分。规则变更提前公示，已到账积分按原权益保留，未到账来源可在此核对，异常可联系客服。'}];}
Page({
 token:'',context:0,visible:false,
 data:{chromeStyle:currentChromeStyle(),points:null as PointsSnapshot|null,club:null as PointsClub|null,balanceClass:'',loading:true,loadingMore:false,
  navigating:false,loadAttempt:0,pageAlive:true,error:'',clubError:'',giftError:'',moreError:'',actionError:'',actionStatus:'',busy:false,
  section:'earn',sections:[{id:'earn',label:'赚积分'},{id:'ledger',label:'积分明细'},{id:'gifts',label:'积分兑换'}],
  source:'all',sources:[{id:'all',label:'全部'},{id:'earn',label:'获得'},{id:'spend',label:'使用'},{id:'expiry',label:'失效'},{id:'adjustment',label:'其他变动'}],
  gifts:[] as PointsGift[],redemptions:[] as PointsRedemption[],addresses:[] as CheckoutAddress[],giftSelected:null as PointsGift|null,selectedAddressId:'',
  rulesOpen:false,
  redemptionsCursor:null as string|null,redemptionsLoading:false,redemptionsError:'',giftQuantity:1,giftTotal:0,addressesState:'loading',addressError:'',recoveryPending:false,recoveryRetryable:false,recoveryKey:'',expiryDate:'',upcomingRules:[] as Array<{version:string;startsLabel:string;rows:Array<{title:string;copy:string}>}>,rulesRows:[] as Array<{title:string;copy:string}>},
 onLoad(){this.data.pageAlive=true;},onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 onShow(){this.visible=true;this.data.pageAlive=true;const token=getApp<IAppOption>().globalData.sessionToken,context=commerceContextRevision();
  if(this.token!==token||this.context!==context||!retainMemberSnapshot(this)){
   this.setData({points:null,club:null,gifts:[],redemptions:[],addresses:[],giftSelected:null,balanceClass:'',selectedAddressId:'',addressesState:'loading',addressError:'',recoveryPending:false,error:'',actionError:'',actionStatus:''});
  }
  this.token=token;this.context=context;if(!requireMemberAccess()){this.setData({loading:false,error:'登录后即可查看积分。'});return;}
  this.setData({navigating:false,busy:false,loadingMore:false,redemptionsLoading:false});void this.load();
 },
 onHide(){this.visible=false;this.data.loadAttempt++;if(this.data.busy)this.setData({busy:false});},
 onUnload(){this.data.pageAlive=false;this.onHide();},
 current(attempt?:number){return this.data.pageAlive&&this.visible&&(attempt??this.data.loadAttempt)===this.data.loadAttempt&&this.token===getApp<IAppOption>().globalData.sessionToken&&this.context===commerceContextRevision();},
 async load(){
  const attempt=++this.data.loadAttempt;this.setData({loading:true,loadingMore:false,redemptionsLoading:false,error:'',clubError:'',giftError:'',moreError:'',addressError:'',addressesState:'loading'});
  await Promise.allSettled([
   readMyPoints(this.data.source).then(points=>{if(!this.current(attempt))return;
    this.setData({points,balanceClass:String(points.projection.available).length>=8?'points-hero__balance--compact':'',expiryDate:points.expiring.earliestAt?new Date(Date.parse(points.expiring.earliestAt)+8*3600000).toISOString().slice(0,10):''});
   }).catch(()=>{if(this.current(attempt))this.setData({points:null,error:'积分账本暂时无法加载，请重新查询。'});}),
   readPointsClub().then(c=>{if(!this.current(attempt))return;
    this.setData({club:c});this.projectRules();
    try{const pending=pendingPointsGift(c.memberId);this.setData({recoveryPending:Boolean(pending),recoveryRetryable:Boolean(pending?.payload),recoveryKey:pending?.key??''});}
    catch{this.setData({recoveryPending:true,recoveryRetryable:false,actionError:'上次兑换恢复记录需核对，请联系客服后再提交。'});}
   }).catch(()=>{if(this.current(attempt))this.setData({club:null,clubError:'赚分活动暂时无法加载，历史账本仍可查看。'});}),
   readPointsGifts().then(result=>{if(this.current(attempt))this.setData({gifts:result.items.map(g=>({...g,image:g.image?nativeCatalogImage(g.image):null,stockLabel:g.availableQuantity<1?'暂时兑完':'剩余 '+g.availableQuantity+' 份'}))});})
    .catch(()=>{if(this.current(attempt))this.setData({gifts:[],giftError:'兑换商品暂时无法加载，请重试。'});}),
   readMyRedemptions().then(result=>{if(this.current(attempt))this.setData({redemptionsCursor:result.nextCursor,redemptionsError:'',redemptions:result.items.map(r=>({...r,stateLabel:redemptionLabels[r.state]??'状态待核对'}))});})
    .catch(()=>{if(this.current(attempt))this.setData({redemptions:[],giftError:'兑换记录暂时无法加载，请重试。'});}),
   memberAddresses().then(result=>{if(this.current(attempt))this.setData({addresses:result.addresses,addressesState:'ready',addressError:''});})
    .catch(()=>{if(this.current(attempt))this.setData({addresses:[],addressesState:'error',addressError:'收货地址暂时无法加载，请重新核对。'});})
  ]);
  if(this.current(attempt))this.setData({loading:false});
 },
 selectSection(e:WechatMiniprogram.TouchEvent){const section=String(e.currentTarget.dataset.id);if(this.data.busy||!this.data.sections.some(s=>s.id===section))return;this.setData({section,actionError:'',actionStatus:''});},
 selectSource(e:WechatMiniprogram.TouchEvent){const source=String(e.currentTarget.dataset.id);if(this.data.loading||this.data.loadingMore||!this.data.sources.some(s=>s.id===source))return;this.setData({source});void this.load();},
 async loadMore(){const p=this.data.points;if(!p?.nextCursor||this.data.loadingMore||this.data.loading)return;const attempt=this.data.loadAttempt,source=this.data.source;this.setData({loadingMore:true,moreError:''});
  try{const next=await readMyPoints(source,p.nextCursor);if(!this.current(attempt)||source!==this.data.source)return;const ids=new Set(p.entries.map(e=>e.id));this.setData({points:{...next,entries:p.entries.concat(next.entries.filter(e=>!ids.has(e.id)))}});
  }catch{if(this.current(attempt))this.setData({moreError:'更多记录加载失败，请重试。'});}finally{if(this.current(attempt))this.setData({loadingMore:false});}
 },
 openRules(){this.setData({rulesOpen:true});},closeRules(){this.setData({rulesOpen:false});},
 projectRules(){const c=this.data.club;this.setData({rulesRows:c?.policy?pointRuleRows(c.policy.rules):[],upcomingRules:(c?.upcomingPolicies??[]).map(p=>({version:p.version,startsLabel:new Date(Date.parse(p.starts_at)+8*3600000).toISOString().slice(0,16).replace('T',' '),rows:pointRuleRows(p.rules)}))});},
 chooseGift(e:WechatMiniprogram.TouchEvent){if(this.data.busy||this.data.recoveryPending||!this.data.club?.enabled)return;const gift=this.data.gifts.find(g=>g.skuId===e.currentTarget.dataset.id);if(!gift||gift.availableQuantity<1)return;const preferred=this.data.addresses.find(a=>a.isDefault)??this.data.addresses[0];this.setData({giftSelected:gift,giftQuantity:1,giftTotal:gift.points,selectedAddressId:preferred?.id??'',actionError:''});},
 changeGiftQuantity(e:WechatMiniprogram.TouchEvent){const g=this.data.giftSelected;if(!g||this.data.busy)return;const quantity=this.data.giftQuantity+Number(e.currentTarget.dataset.delta);if(!Number.isSafeInteger(quantity)||quantity<1||quantity>Math.min(99,g.availableQuantity))return;this.setData({giftQuantity:quantity,giftTotal:quantity*g.points});},
 async moreRedemptions(){const cursor=this.data.redemptionsCursor;if(!cursor||this.data.redemptionsLoading||this.data.loading)return;const attempt=this.data.loadAttempt;this.setData({redemptionsLoading:true,redemptionsError:''});try{const next=await readMyRedemptions(cursor);if(!this.current(attempt))return;const ids=new Set(this.data.redemptions.map(r=>r.id));this.setData({redemptions:this.data.redemptions.concat(next.items.filter(r=>!ids.has(r.id)).map(r=>({...r,stateLabel:redemptionLabels[r.state]??'状态待核对'}))),redemptionsCursor:next.nextCursor});}catch{if(this.current(attempt))this.setData({redemptionsError:'更多兑换记录暂时无法加载。'});}finally{if(this.current(attempt))this.setData({redemptionsLoading:false});}},
 closeGift(){if(!this.data.busy)this.setData({giftSelected:null});},chooseAddress(e:WechatMiniprogram.TouchEvent){if(!this.data.busy)this.setData({selectedAddressId:String(e.currentTarget.dataset.id)});},
 async redeemGift(){if(!this.current()||this.data.busy||this.data.recoveryPending||!this.data.giftSelected||!this.data.club)return;if(this.data.addressesState!=='ready'){this.setData({actionError:'请先重新核对收货地址。'});return;}const gift=this.data.giftSelected,address=this.data.addresses.find(a=>a.id===this.data.selectedAddressId);if(!address){this.setData({actionError:'请先添加并选择收货地址。'});return;}const attempt=this.data.loadAttempt;this.setData({busy:true,actionError:''});
  try{const command=preparePointsGift(this.data.club.memberId,{skuId:gift.skuId,offerVersion:gift.version,policyVersion:gift.policyVersion,expectedPoints:gift.points,quantity:this.data.giftQuantity,addressId:address.id,addressVersion:address.version});await dispatchPointsGift(command);if(this.current(attempt)){this.setData({busy:false,giftSelected:null,actionStatus:'兑换已完成，可在兑换记录中查看发货进度。'});await this.load();}}
  catch(e){if(this.current(attempt)){this.setData({busy:false,giftSelected:null,actionError:(e as {title?:string}).title||'兑换结果尚未确认，请核对原操作。'});await this.load();}}finally{if(this.current(attempt))this.setData({busy:false});}
 },
 async recoverGift(e:WechatMiniprogram.TouchEvent){if(!this.current()||this.data.busy||!this.data.club)return;const command=pendingPointsGift(this.data.club.memberId);if(!command)return;const action=String(e.currentTarget.dataset.action),attempt=this.data.loadAttempt;this.setData({busy:true,actionError:''});
  try{if(action==='retry')await dispatchPointsGift(command);else if(action==='abandon'){const answer=await wx.showModal({title:'取消尚未受理的原操作？',content:'原兑换已经完成时会显示原记录；尚未受理时会阻止这笔原请求以后再执行。',confirmText:'核对并取消'});if(!answer.confirm||!this.current(attempt))return;await inspectPointsGift(command,true);}else{const r=await inspectPointsGift(command);if(r.status==='not_found'&&this.current(attempt))this.setData({actionError:'尚未查到原兑换，可重试原操作，或取消尚未受理的原操作。'});}if(this.current(attempt)){this.setData({busy:false});await this.load();}}
  catch(e){if(this.current(attempt))this.setData({actionError:(e as {title?:string}).title||'原兑换暂时无法核对，请稍后重试。'});}finally{if(this.current(attempt))this.setData({busy:false});}
 },
 async giftAction(e:WechatMiniprogram.TouchEvent){if(!this.current()||this.data.busy)return;const id=String(e.currentTarget.dataset.id),action=String(e.currentTarget.dataset.action),r=this.data.redemptions.find(x=>x.id===id);if(!r||!['cancel','receive','request_return'].includes(action))return;const attempt=this.data.loadAttempt;
  const answer=await wx.showModal({title:action==='cancel'?'取消这笔礼品兑换？':action==='receive'?'已收到这份礼品？':'申请退回礼品？',content:action==='cancel'?'发货前取消会退回这笔兑换的原积分。':action==='receive'?'请在本人实际收到礼品后确认。':'请联系客服确认退货地址；工作人员收到并核对后退回原积分。',confirmText:'确认'});if(!answer.confirm||!this.current(attempt))return;this.setData({busy:true,actionError:''});
  try{await request({path:`/v1/me/points/redemptions/${id}/${action}`,method:'POST',idempotencyKey:clientOperationKey('gift-'+action),data:{expectedVersion:r.version,reason:action==='cancel'?'会员主动取消发货前兑换':action==='receive'?'会员明确确认收到兑换礼品':'会员申请退回兑换礼品'},cacheTags:['points','orders','catalog']});if(this.current(attempt)){this.setData({busy:false});await this.load();}}catch(error){if(this.current(attempt)){this.setData({busy:false,actionError:(error as {title?:string}).title||'操作结果未确认，请刷新兑换记录核对。'});await this.load();}}finally{if(this.current(attempt))this.setData({busy:false});}
 },
 stopPropagation(){},openAddresses(){wx.navigateTo({url:'/pages/settings/index?section=addresses'});},openCommunity(){wx.switchTab({url:'/pages/community/index'});},openInvite(){wx.navigateTo({url:'/pages/invite/index'});},openSupport(){wx.navigateTo({url:'/pages/support/index'});},
 openShop(){if(this.data.navigating)return;this.setData({navigating:true});wx.switchTab({url:'/pages/shop/index',fail:()=>{if(this.data.pageAlive)this.setData({navigating:false});wx.showToast({title:'商品目录暂时无法打开',icon:'none'});}});},back(){wx.navigateBack({fail:()=>wx.switchTab({url:'/pages/profile/index'})});}
});
