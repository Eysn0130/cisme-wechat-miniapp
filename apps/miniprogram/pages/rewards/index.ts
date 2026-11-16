import{foilData,foilEvents,clearFoil,consumeFoilDrag}from'../../services/card-foil';
import{sectionTabValue}from'../../services/section-tabs';
import {requireMemberAccess,resumeAuthentication,navigateAfterAuthentication} from '../../services/api';
import {validRewardInvitation,rememberRewardInvitation,clearRewardInvitation} from '../../services/reward-invitation';
import {cancelPageReads,pageRead} from '../../services/page-requests';
import {currentChromeStyle,shouldReduceMotion} from '../../services/layout';
import {commerceContextRevision} from '../../services/commerce-command-store';
import {clientOperationKey,type CheckoutAddress} from '../../services/orders';
import {rewardWallet,rewardSelection,rewardClaim,rewardReceipt,abandonReward,rewardQuote,confirmReward,operateReward,rewardCopy,rewardDate,rewardExpiry,rewardState,purchaseCouponState,
 type RewardWallet,type RewardSelection,type RewardClaim,type RewardBundleCode,type CouponProduct} from '../../services/rewards';
import {pendingReward,prepareReward,forgetReward,type RewardPending} from '../../services/reward-command-store';
const uuid=/^[0-9a-f-]{36}$/i;
const empty={wallet:null as RewardWallet|null,selection:null as RewardSelection|null,claim:null as RewardClaim|null,memberId:'',selectedBundle:'' as RewardBundleCode|'',
 addresses:[] as CheckoutAddress[],selectedAddressId:'',selectedAddress:null as CheckoutAddress|null,surveyOpen:false,rulesOpen:false,returnOpen:false,returnReason:'',
 pending:null as RewardPending|null,unknown:false,newCoupon:false,error:'',productsOpen:false,couponProducts:[] as CouponProduct[],usingCouponId:'',
 selectionOpen:false,redemptionId:'',redemptionImage:'',redemptionName:'',redemptionBundle:''};
Page({
 ...foilEvents,
 alive:false,visible:false,epoch:0,token:'',context:0,forwardVoucher:'',fromCare:false,
 data:{...empty,...foilData,chromeStyle:currentChromeStyle(),reducedMotion:shouldReduceMotion(),mode:'wallet' as 'wallet'|'select'|'claim',tab:'rewards',inviteToken:'',invalidInvitation:false,voucherId:'',claimId:'',loading:true,busy:false,navigating:false,stateLabel:'',expiryLabel:'',claimDate:''},
 onLoad(query:Record<string,string|undefined>){this.alive=true;this.fromCare=query.from==='care';this.forwardVoucher=uuid.test(query.voucher??'')?query.voucher!:'';const inviteToken=validRewardInvitation(query.invite)?query.invite:'';if(inviteToken)rememberRewardInvitation(inviteToken);this.setData({inviteToken,invalidInvitation:Boolean(query.invite&&!inviteToken),mode:query.claim?'claim':'wallet',selectionOpen:false,voucherId:query.voucher??'',claimId:query.claim??'',tab:query.tab==='coupons'?'coupons':'rewards'});},
 onShow(){this.visible=true;this.epoch++;const d=getApp<IAppOption>().globalData,next=d.sessionToken,revision=commerceContextRevision();
  if(this.token!==next||this.context!==revision){this.setData({...empty,selectionOpen:this.data.mode==='select'});}this.token=next;this.context=revision;
  this.setData({chromeStyle:currentChromeStyle(),reducedMotion:shouldReduceMotion(),busy:false,navigating:false});if(this.data.invalidInvitation){this.setData({loading:false,error:'领取链接已失效，请向分享人获取新链接'});return;}if(this.data.inviteToken){void navigateAfterAuthentication('/pages/home/index');return;}if(this.forwardVoucher){void navigateAfterAuthentication(`/pages/checkout/index?rewardVoucher=${this.forwardVoucher}${this.fromCare?'&from=care':''}`);return;}if(!requireMemberAccess(this.data.inviteToken?`/pages/rewards/index?invite=${this.data.inviteToken}`:undefined))return;void this.load();},
 onHide(){clearFoil(this);this.visible=false;this.epoch++;cancelPageReads(this);},
 onUnload(){clearFoil(this);this.alive=false;this.visible=false;this.epoch++;cancelPageReads(this);this.setData({...empty});},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 onPullDownRefresh(){void this.load().finally(()=>wx.stopPullDownRefresh());},
 current(epoch?:number){return this.alive&&this.visible&&(epoch===undefined||epoch===this.epoch)&&this.token===getApp<IAppOption>().globalData.sessionToken&&this.context===commerceContextRevision();},
 async load(){if(!this.current()||this.data.busy||this.data.invalidInvitation)return;if(this.data.inviteToken){await navigateAfterAuthentication('/pages/home/index');return;}const epoch=++this.epoch;this.setData({loading:true,error:''});
  try{
   if(this.data.mode==='wallet'){
    const wallet=await rewardWallet(this);if(!this.current(epoch))return;
    this.setData({wallet:{...wallet,vouchers:wallet.vouchers.map(v=>({...v,date:rewardExpiry(v.expiresAt),label:rewardState[v.state]})),claims:wallet.claims.map(c=>({...c,date:rewardDate(c.createdAt),label:rewardState[c.state]})),coupons:wallet.coupons.map(c=>({...c,date:rewardExpiry(c.expiresAt),label:purchaseCouponState[c.state]}))},memberId:wallet.memberId});
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
 back(){if(this.data.busy)return;if(this.data.productsOpen){this.closeProducts();return;}if(this.data.rulesOpen){this.closeRules();return;}if(this.data.returnOpen){this.closeReturn();return;}wx.navigateBack({fail:()=>wx.switchTab({url:this.token?'/pages/profile/index':'/pages/community/index'})});},
 openWallet(){if(!this.current()||this.data.busy)return;clearRewardInvitation(this.data.inviteToken);this.setData({inviteToken:'',invalidInvitation:false,mode:'wallet',selectionOpen:false,error:''});if(this.token)void this.load();else resumeAuthentication('/pages/rewards/index');},
 login(){resumeAuthentication(`/pages/rewards/index${this.data.voucherId?`?voucher=${this.data.voucherId}`:''}`);},
 navigate(url:string,replace=false){if(this.data.navigating||!this.current())return;this.setData({navigating:true});const options={url,fail:()=>{if(this.alive)this.setData({navigating:false,error:'暂时无法打开，请重试'});}};if(replace)wx.redirectTo(options);else wx.navigateTo(options);},
 changeTab(event:WechatMiniprogram.TouchEvent){if(!this.data.busy)this.setData({tab:sectionTabValue(event,'tab'),error:''});},
 openVoucher(event:{currentTarget:{dataset:{id?:unknown}}}){if(consumeFoilDrag(this)||!this.current()||this.data.busy||this.data.unknown||this.data.navigating)return;const id=String(event.currentTarget.dataset.id);if(uuid.test(id))this.navigate(`/pages/checkout/index?rewardVoucher=${id}`);},
 onShareAppMessage(){return {title:'领取你的旅行洗护礼遇',path:validRewardInvitation(this.data.inviteToken)?`/pages/home/index?gift=${this.data.inviteToken}`:'/pages/home/index',imageUrl:'/assets/cisme/travel-reward-share-v2.jpg'};},
 openClaim(event:WechatMiniprogram.TouchEvent){if(!this.data.busy)this.navigate(`/pages/rewards/index?claim=${event.currentTarget.dataset.id}`);},
 openRules(){this.setData({rulesOpen:true});},closeRules(){this.setData({rulesOpen:false});},stop(){},
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
