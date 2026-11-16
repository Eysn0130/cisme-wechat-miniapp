import{foilData,foilEvents,clearFoil,consumeFoilDrag}from'../../services/card-foil';
import{sectionTabValue}from'../../services/section-tabs';
import {requireMemberAccess,resumeAuthentication,navigateAfterAuthentication} from '../../services/api';
import {validRewardInvitation,rememberRewardInvitation,clearRewardInvitation} from '../../services/reward-invitation';
import {cancelPageReads,pageRead} from '../../services/page-requests';
import {currentChromeStyle,shouldReduceMotion} from '../../services/layout';
import {commerceContextRevision} from '../../services/commerce-command-store';
import {clientOperationKey,type CheckoutAddress} from '../../services/orders';
import {rewardWallet,rewardSelection,rewardClaim,rewardReceipt,abandonReward,rewardQuote,confirmReward,operateReward,rewardInvitation,acceptRewardInvitation,rewardCopy,rewardDate,rewardExpiry,rewardState,purchaseCouponState,
 type RewardWallet,type RewardSelection,type RewardClaim,type RewardBundleCode,type CouponProduct} from '../../services/rewards';
import {pendingReward,prepareReward,forgetReward,type RewardPending} from '../../services/reward-command-store';
const uuid=/^[0-9a-f-]{36}$/i;
const empty={wallet:null as RewardWallet|null,selection:null as RewardSelection|null,claim:null as RewardClaim|null,memberId:'',selectedBundle:'' as RewardBundleCode|'',
 addresses:[] as CheckoutAddress[],selectedAddressId:'',selectedAddress:null as CheckoutAddress|null,surveyOpen:false,rulesOpen:false,returnOpen:false,returnReason:'',
 pending:null as RewardPending|null,unknown:false,newCoupon:false,error:'',productsOpen:false,couponProducts:[] as CouponProduct[],usingCouponId:'',
 invitationOpen:false,invitationVoucherId:'',selectionOpen:false,redemptionId:'',redemptionImage:'',redemptionName:''};
Page({
 ...foilEvents,
 alive:false,visible:false,epoch:0,token:'',context:0,surveyStarted:false,invitationHandled:false,
 data:{...empty,...foilData,chromeStyle:currentChromeStyle(),reducedMotion:shouldReduceMotion(),mode:'wallet' as 'wallet'|'select'|'claim',tab:'rewards',inviteToken:'',invalidInvitation:false,voucherId:'',claimId:'',loading:true,busy:false,navigating:false,stateLabel:'',expiryLabel:'',claimDate:''},
 onLoad(query:Record<string,string|undefined>){this.alive=true;const inviteToken=validRewardInvitation(query.invite)?query.invite:'';if(inviteToken)rememberRewardInvitation(inviteToken);this.setData({inviteToken,invalidInvitation:Boolean(query.invite&&!inviteToken),mode:query.voucher?'select':query.claim?'claim':'wallet',selectionOpen:Boolean(query.voucher),voucherId:query.voucher??'',claimId:query.claim??'',tab:query.tab==='coupons'?'coupons':'rewards'});},
 onShow(){this.visible=true;this.epoch++;const d=getApp<IAppOption>().globalData,next=d.sessionToken,revision=commerceContextRevision();
  if(this.token!==next||this.context!==revision){this.surveyStarted=false;this.invitationHandled=false;this.setData({...empty,selectionOpen:this.data.mode==='select'});}this.token=next;this.context=revision;
  this.setData({chromeStyle:currentChromeStyle(),reducedMotion:shouldReduceMotion(),busy:false,navigating:false});if(this.data.invalidInvitation){this.setData({loading:false,error:'领取链接已失效，请向分享人获取新链接'});return;}if(this.data.inviteToken&&!next){void this.inspectInvitation();return;}if(!requireMemberAccess(this.data.inviteToken?`/pages/rewards/index?invite=${this.data.inviteToken}`:undefined))return;void this.load();},
 onHide(){clearFoil(this);this.visible=false;this.epoch++;cancelPageReads(this);},
 onUnload(){clearFoil(this);this.alive=false;this.visible=false;this.epoch++;cancelPageReads(this);this.setData({...empty});},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 onPullDownRefresh(){void this.load().finally(()=>wx.stopPullDownRefresh());},
 current(epoch?:number){return this.alive&&this.visible&&(epoch===undefined||epoch===this.epoch)&&this.token===getApp<IAppOption>().globalData.sessionToken&&this.context===commerceContextRevision();},
 async inspectInvitation(){if(!this.current()||!this.data.inviteToken||this.data.busy)return;const epoch=++this.epoch;this.setData({loading:true,error:''});try{const invitation=await rewardInvitation(this,this.data.inviteToken);if(!this.current(epoch))return;if(!invitation.bundles.some(b=>b.stockConfirmed&&(b.availableQuantity??0)>0)){clearRewardInvitation(this.data.inviteToken);this.setData({error:invitation.bundles.some(b=>!b.stockConfirmed)?'这份礼遇尚未开放，请稍后重试':'这次洗护礼遇已领完'});return;}resumeAuthentication(`/pages/rewards/index?invite=${this.data.inviteToken}`);}catch(error){if(this.current(epoch)){if((error as {code?:string})?.code==='REWARD_LINK_UNAVAILABLE')clearRewardInvitation(this.data.inviteToken);this.setData({error:rewardCopy(error)});}}finally{if(this.current(epoch))this.setData({loading:false});}},
 async load(){if(!this.current()||this.data.busy||this.data.invalidInvitation)return;if(this.data.inviteToken&&!this.token){await this.inspectInvitation();return;}const epoch=++this.epoch;this.setData({loading:true,error:''});
  try{
   if(this.data.inviteToken&&!this.invitationHandled){
    const received=await acceptRewardInvitation(this.data.inviteToken,clientOperationKey('reward-invitation'));
    if(!this.current(epoch))return;this.invitationHandled=true;clearRewardInvitation(this.data.inviteToken);
    const voucher=received.voucher;
    this.setData({memberId:received.memberId,invitationVoucherId:voucher.id,invitationOpen:voucher.state==='unused',
     ...(voucher.claimId?{mode:'claim',claimId:voucher.claimId,selectionOpen:false}:{}),
     ...(voucher.state==='expired'?{error:'这张礼遇券已过期'}:voucher.state==='revoked'?{error:'这张礼遇券已撤销'}:{})});
    wx.showShareMenu?.({menus:['shareAppMessage']});
   }
   if(this.data.mode==='wallet'){
    const wallet=await rewardWallet(this);if(!this.current(epoch))return;
    this.setData({wallet:{...wallet,vouchers:wallet.vouchers.map(v=>({...v,date:rewardExpiry(v.expiresAt),label:rewardState[v.state]})),claims:wallet.claims.map(c=>({...c,date:rewardDate(c.createdAt),label:rewardState[c.state]})),coupons:wallet.coupons.map(c=>({...c,date:rewardExpiry(c.expiresAt),label:purchaseCouponState[c.state]}))},memberId:wallet.memberId});
   }else if(this.data.mode==='select'){
    if(!uuid.test(this.data.voucherId))throw {title:'兑换券链接无效'};
    const [selection,addressBook]=await Promise.all([rewardSelection(this,this.data.voucherId),pageRead<{addresses:CheckoutAddress[]}>(this,{path:'/v1/me/addresses',cacheTags:['member']})]);if(!this.current(epoch))return;
    const selected=addressBook.addresses.find(a=>a.id===this.data.selectedAddressId)??addressBook.addresses.find(a=>a.isDefault)??addressBook.addresses[0]??null;
    const selectedBundle=selection.bundles.some(b=>b.code===this.data.selectedBundle&&b.stockConfirmed&&(b.availableQuantity??0)>0)?this.data.selectedBundle:'';
    this.setData({selection,selectionOpen:true,selectedBundle,memberId:selection.memberId,addresses:addressBook.addresses,selectedAddressId:selected?.id??'',selectedAddress:selected,expiryLabel:rewardExpiry(selection.voucher.expiresAt)});
    if(!selection.survey.completed&&!this.surveyStarted&&selection.voucher.state==='unused'){this.surveyStarted=true;this.setData({surveyOpen:true});}
   }else{
    if(!uuid.test(this.data.claimId))throw {title:'领取订单链接无效'};
    const claim=await rewardClaim(this,this.data.claimId);if(!this.current(epoch))return;
    this.setData({claim,memberId:claim.memberId,stateLabel:rewardState[claim.state]??'状态待更新',claimDate:rewardDate(claim.createdAt)});
   }
   const pending=pendingReward(this.data.memberId);if(!this.current(epoch))return;this.setData({pending,unknown:Boolean(pending)});
   if(pending){const receipt=await rewardReceipt(this,pending.key);if(!this.current(epoch))return;
    if(receipt.status==='abandoned'){forgetReward(pending);this.setData({pending:null,unknown:false});}
    else if(receipt.status==='found'){forgetReward(pending);this.setData({pending:null,unknown:false});if(receipt.action==='reward.claim'&&receipt.record?.id)this.navigate(`/pages/rewards/index?claim=${receipt.record.id}`,true);}
   }
  }catch(error){if(this.current(epoch)){
   if((error as {code?:string})?.code==='REWARD_ONBOARDING_REQUIRED'&&this.data.inviteToken){const app=getApp<IAppOption>();app.globalData.onboardingReturnUrl=`/pages/rewards/index?invite=${this.data.inviteToken}`;app.globalData.onboardingReturnToken=this.token;await navigateAfterAuthentication('/pages/home/index');}
   else{if(['REWARD_LINK_UNAVAILABLE','REWARD_ALL_SOLD_OUT'].includes((error as {code?:string})?.code??''))clearRewardInvitation(this.data.inviteToken);this.setData({error:rewardCopy(error)});}
  }}finally{if(this.current(epoch))this.setData({loading:false});}
 },
 async loadMoreClaims(){const wallet=this.data.wallet;if(!wallet?.claimsNextCursor||this.data.busy||this.data.loading)return;const epoch=this.epoch;this.setData({busy:true,error:''});try{const page=await rewardWallet(this,wallet.claimsNextCursor);if(!this.current(epoch))return;const ids=new Set(wallet.claims.map(c=>c.id));this.setData({wallet:{...wallet,claims:[...wallet.claims,...page.claims.filter(c=>!ids.has(c.id)).map(c=>({...c,date:rewardDate(c.createdAt),label:rewardState[c.state]}))],moreClaims:page.moreClaims,claimsNextCursor:page.claimsNextCursor??null}});}catch(error){if(this.current(epoch))this.setData({error:rewardCopy(error)});}finally{if(this.current(epoch))this.setData({busy:false});}},
 back(){if(this.data.busy)return;if(this.data.productsOpen){this.closeProducts();return;}if(this.data.rulesOpen){this.closeRules();return;}if(this.data.returnOpen){this.closeReturn();return;}if(this.data.selectionOpen){this.closeSelection();return;}if(this.data.invitationOpen){this.deferInvitation();return;}wx.navigateBack({fail:()=>wx.switchTab({url:this.token?'/pages/profile/index':'/pages/community/index'})});},
 openWallet(){if(!this.current()||this.data.busy)return;clearRewardInvitation(this.data.inviteToken);this.invitationHandled=true;this.setData({inviteToken:'',invalidInvitation:false,mode:'wallet',selectionOpen:false,error:''});if(this.token)void this.load();else resumeAuthentication('/pages/rewards/index');},
 login(){resumeAuthentication(`/pages/rewards/index${this.data.voucherId?`?voucher=${this.data.voucherId}`:''}`);},
 navigate(url:string,replace=false){if(this.data.navigating||!this.current())return;this.setData({navigating:true});const options={url,fail:()=>{if(this.alive)this.setData({navigating:false,error:'暂时无法打开，请重试'});}};if(replace)wx.redirectTo(options);else wx.navigateTo(options);},
 changeTab(event:WechatMiniprogram.TouchEvent){if(!this.data.busy)this.setData({tab:sectionTabValue(event,'tab'),error:''});},
 openVoucher(event:{currentTarget:{dataset:{id?:unknown}}}){if(consumeFoilDrag(this))return;if(!this.current()||this.data.busy||this.data.unknown||this.data.navigating)return;const voucherId=String(event.currentTarget.dataset.id);if(!uuid.test(voucherId))return;this.setData({invitationOpen:false,mode:'select',voucherId,selectionOpen:true,selectedBundle:'',selection:null,error:''});void this.load();},
 chooseInvitation(){if(this.data.invitationOpen&&this.data.invitationVoucherId)this.openVoucher({currentTarget:{dataset:{id:this.data.invitationVoucherId}}});},
 deferInvitation(){if(this.current()&&!this.data.busy)this.setData({invitationOpen:false});},
 closeSelection(){if(this.data.busy||this.data.navigating)return;this.setData({selectionOpen:false,mode:'wallet',selection:null,selectedBundle:'',error:''});void this.load();},
 finishRedemption(event:WechatMiniprogram.CustomEvent<{owner:string;reference:string}>){if(!this.current()||event.detail.owner!==this.data.memberId||event.detail.reference!==this.data.redemptionId||this.data.navigating)return;const id=this.data.redemptionId;this.setData({redemptionId:'',selectionOpen:false});this.navigate(`/pages/rewards/index?claim=${id}`,true);},
 onShareAppMessage(){return {title:'领取你的旅行洗护礼遇',path:validRewardInvitation(this.data.inviteToken)?`/pages/rewards/index?invite=${this.data.inviteToken}`:'/pages/home/index',imageUrl:'/assets/cisme/travel-reward-share-v1.jpg'};},
 openClaim(event:WechatMiniprogram.TouchEvent){if(!this.data.busy)this.navigate(`/pages/rewards/index?claim=${event.currentTarget.dataset.id}`);},
 openSelectedClaim(){const id=this.data.selection?.voucher.claimId;if(id)this.navigate(`/pages/rewards/index?claim=${id}`,true);},
 chooseBundle(event:WechatMiniprogram.TouchEvent){if(this.data.busy||this.data.unknown)return;const code=String(event.currentTarget.dataset.code) as RewardBundleCode;
  const b=this.data.selection?.bundles.find(b=>b.code===code);if(b&&b.stockConfirmed&&(b.availableQuantity??0)>0)this.setData({selectedBundle:code,error:''});},
 changeAddress(event:{detail:{value:string}}){if(this.data.busy||this.data.unknown)return;const selected=this.data.addresses[Number(event.detail.value)];if(selected)this.setData({selectedAddressId:selected.id,selectedAddress:selected,error:''});},
 editAddress(){if(!this.data.busy&&!this.data.unknown)this.navigate('/pages/settings/index?section=addresses');},
 editSurvey(){if(!this.data.busy&&!this.data.unknown)this.setData({surveyOpen:true});},
 closeSurvey(){this.setData({surveyOpen:false});},
 completeSurvey(){this.setData({surveyOpen:false,selectedBundle:''});void this.load();},
 openRules(){this.setData({rulesOpen:true});},closeRules(){this.setData({rulesOpen:false});},stop(){},
 async confirm(){
  if(this.data.busy||this.data.loading||this.data.unknown||this.data.navigating)return;
  const s=this.data.selection,address=this.data.selectedAddress,code=this.data.selectedBundle;if(!s||!address||!code||!s.survey.completed||s.voucher.state!=='unused')return;
  const epoch=this.epoch;this.setData({busy:true,error:''});let pending:RewardPending|null=null;
  try{
   const q=await rewardQuote({voucherId:s.voucher.id,bundleCode:code,addressId:address.id,addressVersion:address.version,surveyVersion:s.survey.version},clientOperationKey('reward-quote'));
   if(!this.current(epoch))return;
   // Persist only opaque, owner/environment-bound IDs before dispatch.
   pending=prepareReward(this.data.memberId,'claim',s.voucher.id,q.id);this.setData({pending});
   const result=await confirmReward(q.id,pending.key);if(!this.current(epoch))return;
   forgetReward(pending);this.setData({pending:null,unknown:false,selectionOpen:false,redemptionId:result.id,redemptionImage:q.item.image,redemptionName:q.item.name});
  }catch(error){if(this.current(epoch)){const message=rewardCopy(error);this.setData({unknown:Boolean(pending),error:message});if((error as {code?:string})?.code==='REWARD_SOLD_OUT'){this.setData({busy:false,selectedBundle:''});if(pending)await this.cancelPending();else await this.load();if(this.current())this.setData({error:message});}}}finally{if(this.current(epoch))this.setData({busy:false});}
 },
 async retryPending(){const p=this.data.pending;if(this.data.busy||!p||p.kind!=='claim'||!p.quoteId)return;const epoch=this.epoch;this.setData({busy:true,error:''});
  try{const result=await confirmReward(p.quoteId,p.key);if(!this.current(epoch))return;forgetReward(p);this.setData({pending:null,unknown:false});this.navigate(`/pages/rewards/index?claim=${result.id}`,true);
  }catch(error){if(this.current(epoch))this.setData({error:rewardCopy(error)});}finally{if(this.current(epoch))this.setData({busy:false});}},
 async cancelPending(){const p=this.data.pending;if(!p||this.data.busy)return;const epoch=this.epoch;this.setData({busy:true,error:''});
  try{const receipt=await abandonReward(p.key);if(!this.current(epoch))return;
   if(receipt.status==='found'&&receipt.action==='reward.claim'&&receipt.record?.id){forgetReward(p);this.setData({pending:null,unknown:false});this.navigate(`/pages/rewards/index?claim=${receipt.record.id}`,true);}
   else if(receipt.status==='abandoned'||receipt.status==='found'){forgetReward(p);this.setData({pending:null,unknown:false});}
  }catch(error){if(this.current(epoch))this.setData({error:rewardCopy(error)});}finally{if(this.current(epoch)){this.setData({busy:false});if(!this.data.navigating)void this.load();}}},
 async claimAction(action:string){const c=this.data.claim;if(!c||this.data.busy)return;const epoch=this.epoch;this.setData({busy:true,error:''});
  try{await operateReward(c.id,action,{expectedVersion:c.version,...(action==='request_return'?{reason:this.data.returnReason.trim()}:{})},clientOperationKey(`reward-${action}`));if(!this.current(epoch))return;
   this.setData({returnOpen:false,newCoupon:action==='receive',busy:false});await this.load();
  }catch(error){if(this.current(epoch))this.setData({error:rewardCopy(error)});}finally{if(this.current(epoch))this.setData({busy:false});}},
 receive(){wx.showModal({title:'已收到这份洗护了吗？',content:'确认后，体验正装券将到账',confirmText:'确认收货',success:r=>{if(r.confirm&&this.current())void this.claimAction('receive');}});},
 cancelClaim(){wx.showModal({title:'取消这次领取？',content:'兑换券将返还至我的奖励',confirmText:'取消领取',success:r=>{if(r.confirm&&this.current())void this.claimAction('cancel');}});},
 openReturn(){if(!this.data.busy)this.setData({returnOpen:true,returnReason:''});},closeReturn(){if(!this.data.busy)this.setData({returnOpen:false});},
 editReturn(event:WechatMiniprogram.Input){if(!this.data.busy)this.setData({returnReason:event.detail.value});},
 submitReturn(){if(this.data.returnReason.trim().length<3){this.setData({error:'请简单说明遇到的问题'});return;}void this.claimAction('request_return');},
 copyTracking(){if(this.data.claim?.trackingNumber)wx.setClipboardData({data:this.data.claim.trackingNumber});},
 openCoupons(){this.navigate('/pages/rewards/index?tab=coupons',true);},
 useCoupon(event:WechatMiniprogram.TouchEvent){if(consumeFoilDrag(this))return;if(this.data.busy)return;const coupon=this.data.wallet?.coupons.find(c=>c.id===String(event.currentTarget.dataset.id));if(coupon?.state==='available')this.setData({productsOpen:true,couponProducts:coupon.products??[],usingCouponId:coupon.id});},
 closeProducts(){this.setData({productsOpen:false,couponProducts:[],usingCouponId:''});},
 openCouponProduct(event:WechatMiniprogram.TouchEvent){const code=String(event.currentTarget.dataset.code),coupon=this.data.usingCouponId;if(!this.data.couponProducts.some(p=>p.code===code)||!coupon)return;this.setData({productsOpen:false});this.navigate(`/pages/product/index?id=${encodeURIComponent(code)}&coupon=${encodeURIComponent(coupon)}`);},
 support(){if(!this.data.busy)this.navigate('/pages/support/index');}
});
