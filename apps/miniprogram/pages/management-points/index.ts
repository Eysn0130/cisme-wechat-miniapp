import {request,requireMemberAccess,retainMemberSnapshot} from '../../services/api';
import {authorityProjection,hasCapability,type AuthorityProjection} from '../../services/authority';
import {currentChromeStyle} from '../../services/layout';
import {commerceContextRevision} from '../../services/commerce-command-store';
import {clientOperationKey} from '../../services/orders';
import {redemptionLabels,type PointsRedemption} from '../../services/points';
type Row=PointsRedemption&{address:Record<string,string>};
function beijingTime(value:unknown){const t=Date.parse(String(value));return Number.isFinite(t)?new Date(t+8*3600000).toISOString().slice(0,16).replace('T',' ')+'（北京时间）':'待核对';}
const publicationLabels:Record<string,string>={draft:'未上架',published:'已上架',withdrawn:'已下架'};
const policyLabels:Record<string,string>={draft:'待复核',active:'生效版本',retired:'历史版本'};
Page({
 token:'',context:0,visible:false,epoch:0,
 data:{chromeStyle:currentChromeStyle(),authority:null as AuthorityProjection|null,loading:true,busy:false,error:'',notice:'',canFulfill:false,canPolicy:false,canFeature:false,canProduct:false,
  offers:[] as Array<{productId:string;productVersion:number;name:string;label:string;shoppingPointsMultiplier:number;publicationStatus:string;publicationLabel:string}>,reconciliation:[] as Array<{member_id:string;checked_at:string}>,policies:[] as any[],items:[] as Row[],nextCursor:null as string|null,state:'placed',states:[{id:'placed',label:'待发货'},{id:'return_requested',label:'退货待核对'},{id:'all',label:'全部兑换'}],
  selected:null as Row|null,carrier:'',tracking:'',reason:'',postId:'',featureReason:'',policyVersion:'',startsAt:'',ruleFields:[] as Array<{id:string;label:string;value:string}>,policyOpen:false},
 onShow(){this.visible=true;this.epoch++;this.setData({busy:false,policyOpen:false});this.token=getApp<IAppOption>().globalData.sessionToken;this.context=commerceContextRevision();if(!retainMemberSnapshot(this))this.setData({authority:null,items:[],policies:[],selected:null,offers:[],reconciliation:[],postId:'',featureReason:'',policyVersion:'',startsAt:'',reason:'',tracking:'',carrier:''});if(!requireMemberAccess())return;void this.load();},
 onHide(){this.visible=false;this.epoch++;this.setData({authority:null,selected:null,reason:'',carrier:'',tracking:'',items:[],canFulfill:false,canPolicy:false,canFeature:false,canProduct:false});},onUnload(){this.onHide();},onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 current(epoch:number){return this.visible&&epoch===this.epoch&&this.token===getApp<IAppOption>().globalData.sessionToken&&this.context===commerceContextRevision();},
 async load(){const epoch=++this.epoch;this.setData({loading:true,error:''});try{const authority=await authorityProjection();if(!this.current(epoch))return;const canPolicy=hasCapability(authority,'commerce.money.reconcile'),canFulfill=hasCapability(authority,'commerce.fulfillment.manage'),canFeature=hasCapability(authority,'community.moderate'),canProduct=hasCapability(authority,'commerce.product.manage');
  if(!canPolicy&&!canFulfill&&!canFeature&&!hasCapability(authority,'commerce.product.manage'))throw {title:'当前账号没有积分管理权限。'};
  const data=await request<any>({path:'/v1/management/points'});if(!this.current(epoch))return;
  const labels:Record<string,string>={daily:'每日护理',note:'有效感受',streak7:'每连续7天',streak30:'每连续30天',post:'体验笔记',featured:'精选加分',comment:'有效评论',questionnaire:'首次基础建档',firstOrder:'首次购物',inviteSponsor:'邀请人奖励',inviteFriend:'好友首购奖励',postWeeklyLimit:'每周计分笔记数',commentDailyLimit:'每日计分评论数',expiryMonths:'有效自然月数',reminderDays:'到期提醒天数',discountBps:'现金订单抵扣比例（万分比）',pointsPerYuan:'每元对应积分',refundGraceDays:'过期积分退回宽限天数',birthdayMultiplier:'生日购物倍数'};
  this.setData({authority,canPolicy,canFulfill,canFeature,canProduct,offers:data.offers.map((r:any)=>({...r,publicationLabel:publicationLabels[r.publicationStatus]??'待核对'})),reconciliation:data.reconciliation,policies:data.policies.map((p:any)=>({...p,stateLabel:policyLabels[p.state]??'待核对',startsLabel:beijingTime(p.starts_at)})),ruleFields:Object.entries(data.defaultRules).map(([id,value])=>({id,label:labels[id]??id,value:String(value)})),loading:false});
  if(canFulfill)await this.readRedemptions(false,epoch);
 }catch(e){if(this.current(epoch))this.setData({loading:false,authority:null,error:(e as {title?:string}).title||'积分管理暂时无法加载，请重试。'});}},
 async readRedemptions(more=false,epoch=0){epoch=epoch||this.epoch;if(!this.data.canFulfill||more&&!this.data.nextCursor)return;this.setData({loading:true,error:''});try{const next=await request<{items:Row[];nextCursor:string|null}>({path:`/v1/management/points/redemptions?state=${this.data.state}${more?'&cursor='+encodeURIComponent(this.data.nextCursor!):''}`});if(!this.current(epoch))return;
  const previous=more?this.data.items:[],ids=new Set(previous.map(r=>r.id));this.setData({items:previous.concat(next.items.filter(r=>!ids.has(r.id)).map(r=>({...r,stateLabel:redemptionLabels[r.state]??'待核对'}))),nextCursor:next.nextCursor});
 }catch{if(this.current(epoch))this.setData({error:'兑换列表暂时无法加载，请重试。'});}finally{if(this.current(epoch))this.setData({loading:false});}},
 selectState(e:WechatMiniprogram.TouchEvent){if(this.data.busy||this.data.loading)return;const state=String(e.currentTarget.dataset.id);if(!this.data.states.some(s=>s.id===state))return;this.setData({state,items:[],nextCursor:null});void this.readRedemptions();},more(){void this.readRedemptions(true);},
 choose(e:WechatMiniprogram.TouchEvent){if(this.data.busy)return;const selected=this.data.items.find(r=>r.id===e.currentTarget.dataset.id);if(selected)this.setData({selected,carrier:'',tracking:'',reason:'',error:''});},
 input(e:WechatMiniprogram.Input){const key=String(e.currentTarget.dataset.field);if(this.data.busy||!['carrier','tracking','reason','postId','featureReason','policyVersion','startsAt'].includes(key))return;this.setData({[key]:e.detail.value});},
 close(){if(!this.data.busy)this.setData({selected:null,policyOpen:false});},
 async fulfill(){const selected=this.data.selected;if(!selected||this.data.busy||!this.data.canFulfill||!['placed','return_requested'].includes(selected.state))return;
  const action=selected.state==='placed'?'ship':'return_received',epoch=this.epoch;
  const answer=await wx.showModal({title:action==='ship'?'确认已交付承运商？':'确认已收到并核对退货？',content:action==='ship'?'按填写的真实运单保存发货事实。':'退回该笔原积分；退回商品不会自动恢复为可售库存。',confirmText:'确认保存'});if(!answer.confirm||!this.current(epoch))return;
  await this.command(`/v1/management/points/redemptions/${selected.id}/${action}`,{expectedVersion:selected.version,reason:this.data.reason,...(action==='ship'?{carrierName:this.data.carrier,trackingNumber:this.data.tracking}:{})});},
 async multiplier(e:WechatMiniprogram.TouchEvent){if(!this.data.canProduct||this.data.busy)return;const product=this.data.offers.find(r=>r.productId===e.currentTarget.dataset.id),multiplier=Number(e.currentTarget.dataset.multiplier);if(!product||![1,3].includes(multiplier))return;const epoch=this.epoch;
  const answer=await wx.showModal({title:`商品购物积分改为${multiplier}倍？`,editable:true,placeholderText:'至少4字，填写已同步的商品积分宣传依据',content:'仅影响重新确认后创建的新订单；生日当月首单在商品倍率上再翻倍。已创建订单按原快照处理。',confirmText:'确认保存'});
  if(answer.confirm&&this.current(epoch))await this.command(`/v1/management/points/products/${product.productId}/multiplier`,{expectedVersion:product.productVersion,multiplier,reason:answer.content??''},'PUT');},
 async feature(){if(!this.data.canFeature||this.data.busy)return;await this.command(`/v1/management/points/featured/${encodeURIComponent(this.data.postId.trim())}`,{reason:this.data.featureReason});},
 openPolicy(){if(this.data.canPolicy&&!this.data.busy)this.setData({policyOpen:true,error:''});},
 ruleInput(e:WechatMiniprogram.Input){if(this.data.busy)return;const id=String(e.currentTarget.dataset.id);this.setData({ruleFields:this.data.ruleFields.map(f=>f.id===id?{...f,value:e.detail.value}:f)});},
 async propose(){if(!this.data.canPolicy||this.data.busy)return;const time=this.data.startsAt.trim();if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(time)){this.setData({error:'请按北京时间 YYYY-MM-DD HH:mm 填写生效时间。'});return;}
  const rules:Record<string,number>={};for(const f of this.data.ruleFields){if(!/^\d+$/.test(f.value)||!Number.isSafeInteger(Number(f.value))){this.setData({error:'每项规则请填写非负整数。'});return;}rules[f.id]=Number(f.value);}
  const startsAt=new Date(time.replace(' ','T')+':00+08:00');if(!Number.isFinite(+startsAt)){this.setData({error:'请填写有效生效时间。'});return;}
  await this.command('/v1/management/points/policies',{version:this.data.policyVersion.trim(),rules,startsAt:startsAt.toISOString(),endsAt:null});},
 async approve(e:WechatMiniprogram.TouchEvent){if(!this.data.canPolicy||this.data.busy)return;const version=String(e.currentTarget.dataset.id),epoch=this.epoch;const answer=await wx.showModal({title:'复核积分规则？',editable:true,placeholderText:'至少8字，填写已核对的规则及权益依据',content:'需要另一位有权限的人员复核。生效前会展示新规则，历史积分保留原批次权益。',confirmText:'确认复核'});if(answer.confirm&&this.current(epoch))await this.command(`/v1/management/points/policies/${encodeURIComponent(version)}/approve`,{evidence:answer.content??''});},
 async command(path:string,data:Record<string,unknown>,method:'POST'|'PUT'='POST'){if(this.data.busy||!this.current(this.epoch))return;const epoch=this.epoch;this.setData({busy:true,error:'',notice:''});try{await request({path,method,idempotencyKey:clientOperationKey('points-management'),data,cacheTags:['points','orders','catalog']});if(this.current(epoch)){this.setData({busy:false,selected:null,policyOpen:false,notice:'已保存，请核对最新记录。'});await this.load();}}catch(e){if(this.current(epoch))this.setData({error:(e as {title?:string}).title||'结果尚未确认，请刷新记录核对后重试。'});}finally{if(this.current(epoch))this.setData({busy:false});}},
 back(){wx.navigateBack({fail:()=>wx.redirectTo({url:'/pages/management/index'})});}
});
