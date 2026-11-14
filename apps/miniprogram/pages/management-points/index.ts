import {request,requireMemberAccess,retainMemberSnapshot} from '../../services/api';
import {authorityProjection,hasCapability,type AuthorityProjection} from '../../services/authority';
import {currentChromeStyle} from '../../services/layout';
import {commerceContextRevision} from '../../services/commerce-command-store';
import {clientOperationKey} from '../../services/orders';
import {redemptionLabels,type PointsRedemption} from '../../services/points';
import {beijingCivilInstant} from '../../services/business-time';
type Row=PointsRedemption&{address:Record<string,string>};
type PendingCommand={key:string;path:string;data:Record<string,unknown>;method:'POST'|'PUT';token:string;context:number};
function beijingTime(value:unknown){const t=Date.parse(String(value));return Number.isFinite(t)?new Date(t+8*3600000).toISOString().slice(0,16).replace('T',' ')+'（北京时间）':'待核对';}
const publicationLabels:Record<string,string>={draft:'未上架',published:'已上架',withdrawn:'已下架'};
const policyLabels:Record<string,string>={draft:'待复核',active:'生效版本',retired:'历史版本'};
Page({
 token:'',context:0,visible:false,epoch:0,target:{memberId:'',redemptionId:''},openedTarget:false,pendingCommand:null as PendingCommand|null,
 data:{targetMemberId:'',chromeStyle:currentChromeStyle(),authority:null as AuthorityProjection|null,loading:true,busy:false,commandPending:false,error:'',notice:'',canFulfill:false,canPolicy:false,canFeature:false,canProduct:false,
  offers:[] as Array<{productId:string;productVersion:number;name:string;label:string;shoppingPointsMultiplier:number;publicationStatus:string;publicationLabel:string}>,reconciliation:[] as Array<{member_id:string;checked_at:string}>,policies:[] as any[],items:[] as Row[],nextCursor:null as string|null,state:'placed',states:[{id:'placed',label:'待发货'},{id:'return_requested',label:'退货待核对'},{id:'all',label:'全部兑换'}],
  selected:null as Row|null,carrier:'',tracking:'',reason:'',postId:'',featureReason:'',policyVersion:'',startsAt:'',ruleFields:[] as Array<{id:string;label:string;value:string}>,policyOpen:false,expandedPolicy:''},
 onLoad(q:Record<string,string|undefined>={}){this.target={memberId:q.memberId||'',redemptionId:q.redemptionId||''};this.setData({targetMemberId:this.target.memberId});if(q.redemptionId)this.setData({state:'all'});},
 onShow(){this.visible=true;this.epoch++;this.token=getApp<IAppOption>().globalData.sessionToken;this.context=commerceContextRevision();if(this.pendingCommand&&(this.pendingCommand.token!==this.token||this.pendingCommand.context!==this.context))this.pendingCommand=null;this.setData({busy:false,policyOpen:false,commandPending:!!this.pendingCommand});if(!retainMemberSnapshot(this))this.setData({authority:null,items:[],policies:[],selected:null,offers:[],reconciliation:[],postId:'',featureReason:'',policyVersion:'',startsAt:'',reason:'',tracking:'',carrier:''});if(!requireMemberAccess())return;void this.load();},
 onHide(){this.visible=false;this.epoch++;this.setData({authority:null,selected:null,reason:'',carrier:'',tracking:'',items:[],canFulfill:false,canPolicy:false,canFeature:false,canProduct:false});},onUnload(){this.onHide();this.pendingCommand=null;},onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 current(epoch:number){return this.visible&&epoch===this.epoch&&this.token===getApp<IAppOption>().globalData.sessionToken&&this.context===commerceContextRevision();},
 async load(){if(this.data.busy)return;const epoch=++this.epoch;this.setData({loading:true,error:'',authority:null,canPolicy:false,canFulfill:false,canFeature:false,canProduct:false});try{const authority=await authorityProjection();if(!this.current(epoch))return;const canPolicy=hasCapability(authority,'commerce.money.reconcile'),canFulfill=hasCapability(authority,'commerce.fulfillment.manage'),canFeature=hasCapability(authority,'community.moderate'),canProduct=hasCapability(authority,'commerce.product.manage');
  if(authority.version!==1||!authority.managementAvailable||!canPolicy&&!canFulfill&&!canFeature&&!canProduct)throw {title:'当前账号没有积分管理权限。'};
  const data=await request<any>({path:'/v1/management/points'});if(!this.current(epoch))return;
  const labels:Record<string,string>={daily:'每日护理',note:'有效感受',streak7:'每连续7天',streak30:'每连续30天',post:'体验笔记',featured:'精选加分',comment:'有效评论',questionnaire:'首次基础建档',firstOrder:'首次购物',inviteSponsor:'邀请人奖励',inviteFriend:'好友首购奖励',postWeeklyLimit:'每周计分笔记数',commentDailyLimit:'每日计分评论数',expiryMonths:'有效自然月数',reminderDays:'到期提醒天数',discountBps:'现金订单抵扣比例（万分比）',pointsPerYuan:'每元对应积分',refundGraceDays:'过期积分退回宽限天数',birthdayMultiplier:'生日购物倍数'};
  this.setData({authority,canPolicy,canFulfill,canFeature,canProduct,offers:data.offers.map((r:any)=>({...r,publicationLabel:publicationLabels[r.publicationStatus]??'待核对'})),reconciliation:data.reconciliation,policies:data.policies.map((p:any)=>({...p,stateLabel:policyLabels[p.state]??'待核对',startsLabel:beijingTime(p.starts_at)})),ruleFields:Object.entries(data.defaultRules).map(([id,value])=>({id,label:labels[id]??id,value:String(value)})),loading:false});
  if(canFulfill)await this.readRedemptions(false,epoch);
 }catch(e){if(this.current(epoch))this.setData({loading:false,authority:null,error:(e as {title?:string}).title||'积分管理暂时无法加载，请重试。'});}},
 async readRedemptions(more=false,epoch=0){epoch=epoch||this.epoch;if(!this.data.canFulfill||more&&!this.data.nextCursor)return;this.setData({loading:true,error:''});try{const next=await request<{items:Row[];nextCursor:string|null}>({path:`/v1/management/points/redemptions?state=${this.data.state}${more?'&cursor='+encodeURIComponent(this.data.nextCursor!):''}${this.target.memberId?'&memberId='+encodeURIComponent(this.target.memberId):''}${this.target.redemptionId?'&redemptionId='+encodeURIComponent(this.target.redemptionId):''}`});if(!this.current(epoch))return;
  const previous=more?this.data.items:[],ids=new Set(previous.map(r=>r.id));this.setData({items:previous.concat(next.items.filter(r=>!ids.has(r.id)).map(r=>({...r,stateLabel:redemptionLabels[r.state]??'待核对'}))),nextCursor:next.nextCursor});if(!this.openedTarget&&this.target.redemptionId){this.openedTarget=true;const row=this.data.items.find(r=>r.id===this.target.redemptionId);if(row)this.setData({selected:row});else this.setData({error:'兑换记录不存在或不属于该用户'});}
 }catch{if(this.current(epoch))this.setData({error:'兑换列表暂时无法加载，请重试。'});}finally{if(this.current(epoch))this.setData({loading:false});}},
 selectState(e:WechatMiniprogram.TouchEvent){if(this.data.busy||this.data.loading||this.data.commandPending)return;const state=String(e.currentTarget.dataset.id);if(!this.data.states.some(s=>s.id===state))return;this.setData({state,items:[],nextCursor:null});void this.readRedemptions();},more(){void this.readRedemptions(true);},
 choose(e:WechatMiniprogram.TouchEvent){if(this.data.busy||this.data.commandPending)return;const selected=this.data.items.find(r=>r.id===e.currentTarget.dataset.id);if(selected)this.setData({selected,carrier:'',tracking:'',reason:'',error:''});},
 input(e:WechatMiniprogram.Input){const key=String(e.currentTarget.dataset.field);if(this.data.busy||this.data.commandPending||!['carrier','tracking','reason','postId','featureReason','policyVersion','startsAt'].includes(key))return;this.setData({[key]:e.detail.value});},
 close(){if(!this.data.busy)this.setData({selected:null,policyOpen:false});},
 async fulfill(){const selected=this.data.selected;if(!selected||this.data.busy||this.data.commandPending||!this.data.canFulfill||!['placed','return_requested'].includes(selected.state))return;
  if(this.data.reason.trim().length<4||this.data.reason.trim().length>500){this.setData({error:'请填写4–500字的处理依据。'});return;}
  if(selected.state==='placed'&&(!this.data.carrier.trim()||this.data.carrier.trim().length>50||!/^[A-Za-z0-9-]{6,80}$/.test(this.data.tracking.trim()))){this.setData({error:'请填写承运商和6–80位真实运单号。'});return;}
  const action=selected.state==='placed'?'ship':'return_received',epoch=this.epoch;
  const answer=await wx.showModal({title:action==='ship'?'确认已交付承运商？':'确认已收到并核对退货？',content:action==='ship'?'按填写的真实运单保存发货事实。':'退回该笔原积分；退回商品不会自动恢复为可售库存。',confirmText:'确认保存'});if(!answer.confirm||!this.current(epoch))return;
  await this.command(`/v1/management/points/redemptions/${selected.id}/${action}`,{expectedVersion:selected.version,reason:this.data.reason,...(action==='ship'?{carrierName:this.data.carrier,trackingNumber:this.data.tracking}:{})});},
 async multiplier(e:WechatMiniprogram.TouchEvent){if(!this.data.canProduct||this.data.busy||this.data.commandPending)return;const product=this.data.offers.find(r=>r.productId===e.currentTarget.dataset.id),multiplier=Number(e.currentTarget.dataset.multiplier);if(!product||![1,3].includes(multiplier))return;const epoch=this.epoch;
  if(product.shoppingPointsMultiplier===multiplier)return;
  const answer=await wx.showModal({title:`商品购物积分改为${multiplier}倍？`,editable:true,placeholderText:'至少4字，填写已同步的商品积分宣传依据',content:'仅影响新订单；生日当月首单再翻倍。已创建订单保留原倍率。',confirmText:'确认保存'});
  if(answer.confirm&&this.current(epoch))await this.command(`/v1/management/points/products/${product.productId}/multiplier`,{expectedVersion:product.productVersion,multiplier,reason:answer.content??''},'PUT');},
 async feature(){if(!this.data.canFeature||this.data.busy||this.data.commandPending)return;const postId=this.data.postId.trim(),reason=this.data.featureReason.trim();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(postId)||reason.length<4||reason.length>500){this.setData({error:'请填写有效笔记编号和4–500字的精选依据。'});return;}
  await this.command(`/v1/management/points/featured/${postId}`,{reason});},
 openPolicy(){if(this.data.canPolicy&&!this.data.busy&&!this.data.commandPending)this.setData({policyOpen:true,error:''});},
 togglePolicy(e:WechatMiniprogram.TouchEvent){const version=String(e.currentTarget.dataset.id);if(this.data.policies.some(p=>p.version===version))this.setData({expandedPolicy:this.data.expandedPolicy===version?'':version});},
 ruleInput(e:WechatMiniprogram.Input){if(this.data.busy||this.data.commandPending)return;const id=String(e.currentTarget.dataset.id);this.setData({ruleFields:this.data.ruleFields.map(f=>f.id===id?{...f,value:e.detail.value}:f)});},
 async propose(){if(!this.data.canPolicy||this.data.busy||this.data.commandPending)return;const time=this.data.startsAt.trim();if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(time)){this.setData({error:'请按北京时间 YYYY-MM-DD HH:mm 填写生效时间。'});return;}
  const rules:Record<string,number>={};for(const f of this.data.ruleFields){if(!/^\d+$/.test(f.value)||!Number.isSafeInteger(Number(f.value))){this.setData({error:'每项规则请填写非负整数。'});return;}rules[f.id]=Number(f.value);}
  const startsAt=beijingCivilInstant(time.slice(0,10),time.slice(11));if(!startsAt){this.setData({error:'请填写有效生效时间。'});return;}
  const version=this.data.policyVersion.trim();if(!/^[A-Za-z0-9._-]{8,80}$/.test(version)){this.setData({error:'规则版本须为8–80位英文、数字或 . _ -。'});return;}
  await this.command('/v1/management/points/policies',{version,rules,startsAt,endsAt:null});},
 async approve(e:WechatMiniprogram.TouchEvent){if(!this.data.canPolicy||this.data.busy||this.data.commandPending)return;const version=String(e.currentTarget.dataset.id),epoch=this.epoch;const answer=await wx.showModal({title:'复核积分规则？',editable:true,placeholderText:'至少8字，填写已核对的规则及权益依据',content:'需要另一位有权限的人员复核。生效前会展示新规则，历史积分保留原批次权益。',confirmText:'确认复核'});if(answer.confirm&&this.current(epoch))await this.command(`/v1/management/points/policies/${encodeURIComponent(version)}/approve`,{evidence:answer.content??''});},
 retryCommand(){const command=this.pendingCommand;if(command&&this.data.authority&&!this.data.loading)void this.command(command.path,command.data,command.method);},
 async command(path:string,data:Record<string,unknown>,method:'POST'|'PUT'='POST'){
  if(this.data.busy||!this.current(this.epoch))return;
  const previous=this.pendingCommand;
  if(previous&&(previous.token!==this.token||previous.context!==this.context))return;
  if(previous&&(previous.path!==path||previous.method!==method||JSON.stringify(previous.data)!==JSON.stringify(data))){this.setData({error:'请先核对上次操作的结果。'});return;}
  const command=previous??{key:clientOperationKey('points-management'),path,data:{...data},method,token:this.token,context:this.context};
  this.pendingCommand=command;const epoch=this.epoch;this.setData({busy:true,error:'',notice:'',commandPending:true});
  try{await request({path:command.path,method:command.method,idempotencyKey:command.key,data:command.data,cacheTags:['points','orders','catalog']});
   if(this.current(epoch)&&this.pendingCommand===command){this.pendingCommand=null;this.setData({busy:false,commandPending:false,selected:null,policyOpen:false,notice:'已保存'});await this.load();}
  }catch(e){if(this.current(epoch)&&this.pendingCommand===command){
   const status=(e as {status?:number})?.status,definitive=[400,401,403,404,409,422].includes(status??0);
   if(definitive)this.pendingCommand=null;
   const denied=status===401||status===403;
   this.setData({commandPending:!definitive,error:(e as {title?:string}).title||'结果待核对，请重试原操作。',...(denied?{authority:null,items:[],policies:[],offers:[],selected:null,canFulfill:false,canPolicy:false,canFeature:false,canProduct:false}:{})});
  }}finally{if(this.current(epoch))this.setData({busy:false});}
 },
 back(){wx.navigateBack({fail:()=>wx.redirectTo({url:'/pages/management/index'})});}
});
