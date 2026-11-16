import {resumeAuthentication} from '../../../../services/api';
import {cancelPageReads,pageRead} from '../../../../services/page-requests';
import {commerceContextRevision} from '../../../../services/commerce-command-store';
import {clientOperationKey,type CheckoutAddress} from '../../../../services/orders';
import {confirmCreditOwner} from '../../../../services/points-feedback';
import {rewardSelection,rewardReceipt,abandonReward,rewardQuote,confirmReward,rewardCopy,rewardExpiry,type RewardSelection,type RewardBundle,type RewardBundleCode} from '../../../../services/rewards';
import {pendingReward,prepareReward,forgetReward,type RewardPending} from '../../../../services/reward-command-store';
type Runtime={alive:boolean;visible:boolean;epoch:number;token:string;context:number;voucher:string;reading:number|null};
const states=new WeakMap<object,Runtime>();
const empty={selection:null as RewardSelection|null,memberId:'',addresses:[] as CheckoutAddress[],selectedAddressId:'',selectedBundle:'' as RewardBundleCode|'',selectedItem:null as RewardBundle|null,draftBundle:'' as RewardBundleCode|'',bundleSheetOpen:true,
 pending:null as RewardPending|null,unknown:false,error:'',loading:true,busy:false,navigating:false,syncError:'',surveyOpen:false,expiry:'',redemptionId:'',redemptionName:'',redemptionBundle:'',redemptionImage:'',completedId:'',addressReadOnly:false,addressEmptyCopy:'添加收货地址'};
function current(c:any,epoch?:number){const r=states.get(c);return Boolean(r&&r.alive&&r.visible&&c.properties.active&&(epoch===undefined||r.epoch===epoch)&&r.token===getApp<IAppOption>().globalData.sessionToken&&r.context===commerceContextRevision()&&r.voucher===c.properties.voucher);}
function stop(c:any,update=true){const r=states.get(c);if(r){r.epoch++;r.reading=null;}cancelPageReads(c);if(update){c.setData({busy:false,navigating:false});c.triggerEvent('busychange',{busy:false});}}
Component({
 properties:{voucher:{type:String,value:''},active:{type:Boolean,value:false}},data:{...empty},
 observers:{'voucher,active':function(){this.activate();}},
 lifetimes:{attached(){states.set(this,{alive:true,visible:true,epoch:0,token:'',context:0,voucher:'',reading:null});this.activate();},detached(){const r=states.get(this);if(r)r.alive=false;stop(this,false);states.delete(this);}},
 pageLifetimes:{hide(){const r=states.get(this);if(r)r.visible=false;stop(this);},show(){const r=states.get(this);if(r)r.visible=true;this.activate();}},
 methods:{
  activate(){const r=states.get(this);if(!r)return;const token=getApp<IAppOption>().globalData.sessionToken,context=commerceContextRevision();
   if(r.token!==token||r.context!==context||r.voucher!==this.properties.voucher){stop(this);this.setData({...empty});}
   r.token=token;r.context=context;r.voucher=this.properties.voucher;
   if(!this.properties.active||!r.visible||!token){stop(this);return;}void this.load();
  },
  busy(value:boolean){this.setData({busy:value});this.triggerEvent('busychange',{busy:value});},
  async load(){if(!current(this)||this.data.busy)return;const r=states.get(this)!;if(r.reading!==null)return;const epoch=++r.epoch;r.reading=epoch;this.setData({loading:true,error:''});
   try{if(!/^[a-f0-9-]{36}$/i.test(this.properties.voucher))throw {title:'兑换券链接无效'};
    const [selection,book]=await Promise.all([rewardSelection(this,this.properties.voucher),pageRead<{addresses:CheckoutAddress[]}>(this,{path:'/v1/me/addresses',cacheTags:['member']})]);if(!current(this,epoch))return;
    const selected=book.addresses.find(a=>a.id===this.data.selectedAddressId)??book.addresses.find(a=>a.isDefault)??book.addresses[0]??null;
    const item=selection.bundles.find(b=>b.code===this.data.selectedBundle&&b.stockConfirmed&&(b.availableQuantity??0)>0)??null;
    confirmCreditOwner(selection.memberId);this.setData({selection,memberId:selection.memberId,addresses:book.addresses,selectedAddressId:selected?.id??'',selectedBundle:item?.code??'',selectedItem:item??null,draftBundle:item?.code??'',bundleSheetOpen:selection.voucher.state==='unused'&&!item,expiry:rewardExpiry(selection.voucher.expiresAt)});
    const pending=pendingReward(selection.memberId);this.setData({pending,unknown:Boolean(pending),addressReadOnly:Boolean(pending)||selection.voucher.state!=='unused',bundleSheetOpen:pending?false:this.data.bundleSheetOpen});
    if(pending){const receipt=await rewardReceipt(this,pending.key);if(!current(this,epoch))return;
     if(receipt.status==='abandoned'){forgetReward(pending);this.setData({pending:null,unknown:false,addressReadOnly:false});}
     else if(receipt.status==='found'){forgetReward(pending);this.setData({pending:null,unknown:false,addressReadOnly:false});if(receipt.action==='reward.claim'&&receipt.record?.id)this.complete(receipt.record.id);}
    }
   }catch(error){if(current(this,epoch))this.setData({error:rewardCopy(error)});}finally{if(r.reading===epoch)r.reading=null;if(current(this,epoch))this.setData({loading:false});}
  },
  openBundleSheet(){if(current(this)&&!this.data.busy&&!this.data.unknown)this.setData({bundleSheetOpen:true,draftBundle:this.data.selectedBundle,error:''});},
  closeBundleSheet(){if(!this.data.busy)this.setData({bundleSheetOpen:false});},stop(){},
  chooseBundle(event:WechatMiniprogram.TouchEvent){if(!current(this)||this.data.busy||this.data.unknown)return;const item=this.data.selection?.bundles.find(b=>b.code===String(event.currentTarget.dataset.code));if(item?.stockConfirmed&&(item.availableQuantity??0)>0)this.setData({draftBundle:item.code});},
  confirmBundle(){if(!current(this)||this.data.busy||this.data.unknown)return;const item=this.data.selection?.bundles.find(b=>b.code===this.data.draftBundle&&b.stockConfirmed&&(b.availableQuantity??0)>0);if(item)this.setData({selectedBundle:item.code,selectedItem:item,bundleSheetOpen:false,error:''});},
  selectAddress(event:WechatMiniprogram.TouchEvent){if(!this.data.busy&&!this.data.loading&&!this.data.unknown&&!this.data.addressReadOnly){const id=String(event.currentTarget.dataset.id);if(this.data.addresses.some(a=>a.id===id))this.setData({selectedAddressId:id,error:''});}},
  editAddresses(){if(!this.data.busy&&!this.data.unknown&&!this.data.addressReadOnly)wx.navigateTo({url:'/pages/settings/index?section=addresses'});},
  editSurvey(){if(!this.data.busy&&!this.data.unknown)this.setData({surveyOpen:true});},closeSurvey(){this.setData({surveyOpen:false});},
  async completeSurvey(){this.setData({surveyOpen:false});await this.load();if(current(this))await this.selectComponent('#reward-profile-credit')?.present?.();},
  async confirm(){if(!current(this)||this.data.busy||this.data.loading||this.data.unknown||this.data.navigating||this.data.completedId)return;const s=this.data.selection,address=this.data.addresses.find(a=>a.id===this.data.selectedAddressId),code=this.data.selectedBundle;
   if(!s||!address||!code||!s.survey.completed||s.voucher.state!=='unused')return;const epoch=states.get(this)!.epoch;this.busy(true);this.setData({error:''});let pending:RewardPending|null=null;
   try{const quote=await rewardQuote({voucherId:s.voucher.id,bundleCode:code,addressId:address.id,addressVersion:address.version,surveyVersion:s.survey.version},clientOperationKey('reward-quote'));if(!current(this,epoch))return;
    pending=prepareReward(this.data.memberId,'claim',s.voucher.id,quote.id);this.setData({pending});const result=await confirmReward(quote.id,pending.key);if(!current(this,epoch))return;
    forgetReward(pending);this.setData({pending:null,unknown:false,bundleSheetOpen:false,redemptionId:result.id,redemptionName:quote.item.name,redemptionImage:quote.item.image,redemptionBundle:quote.item.code});
   }catch(error){if(current(this,epoch)){const message=rewardCopy(error);this.setData({unknown:Boolean(pending),addressReadOnly:Boolean(pending),error:message});if((error as {code?:string})?.code==='REWARD_SOLD_OUT'){this.busy(false);this.setData({selectedBundle:'',selectedItem:null,draftBundle:'',bundleSheetOpen:true});if(pending)await this.cancelPending();else await this.load();if(current(this))this.setData({error:message});}}}finally{if(current(this,epoch))this.busy(false);}
  },
  async retryPending(){const p=this.data.pending;if(!current(this)||this.data.busy||!p||p.kind!=='claim'||!p.quoteId)return;const epoch=states.get(this)!.epoch;this.busy(true);this.setData({error:''});
   try{const result=await confirmReward(p.quoteId,p.key);if(!current(this,epoch))return;forgetReward(p);this.setData({pending:null,unknown:false,addressReadOnly:false});this.complete(result.id);}catch(error){if(current(this,epoch))this.setData({error:rewardCopy(error)});}finally{if(current(this,epoch))this.busy(false);}
  },
  async cancelPending(){const p=this.data.pending;if(!current(this)||this.data.busy||!p)return;const epoch=states.get(this)!.epoch;this.busy(true);this.setData({error:''});
   try{const receipt=await abandonReward(p.key);if(!current(this,epoch))return;if(receipt.status==='found'&&receipt.action==='reward.claim'&&receipt.record?.id){forgetReward(p);this.setData({pending:null,unknown:false,addressReadOnly:false});this.complete(receipt.record.id);}else if(receipt.status==='abandoned'||receipt.status==='found'){forgetReward(p);this.setData({pending:null,unknown:false,addressReadOnly:false});}}
   catch(error){if(current(this,epoch))this.setData({error:rewardCopy(error)});}finally{if(current(this,epoch)){this.busy(false);if(!this.data.navigating)void this.load();}}
  },
  finishRedemption(event:WechatMiniprogram.CustomEvent<{owner:string;reference:string}>){if(current(this)&&event.detail.owner===this.data.memberId&&event.detail.reference===this.data.redemptionId)this.complete(this.data.redemptionId);},
  complete(id:string){if(!current(this)||this.data.navigating)return;this.setData({navigating:true,redemptionId:'',completedId:id,addressReadOnly:true});this.triggerEvent('complete',{owner:this.data.memberId,id});},
  navigationFailed(){if(current(this))this.setData({navigating:false,error:'礼遇已领取，订单暂时无法打开'});},
  viewCompleted(){if(this.data.completedId)this.complete(this.data.completedId);},
  support(){if(!this.data.busy)wx.navigateTo({url:'/pages/support/index'});},
  viewClaim(){const id=this.data.selection?.voucher.claimId;if(id)this.complete(id);}
 }
});
