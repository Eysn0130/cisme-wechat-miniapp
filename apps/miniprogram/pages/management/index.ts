import { authorityProjection, hasCapability, type Capability, type AuthorityProjection } from "../../services/authority";
import { currentChromeStyle } from "../../services/layout";
import { orderRuntimeStatus } from "../../services/orders";
import { cancelPageReads, pageRead } from "../../services/page-requests";
import { cancelRuntimeRead, initialRuntimeView, runtimeActions, runtimeReadOwner, runtimeView, validateRuntime } from "../../services/commerce-runtime";

Page({
 lastSessionToken:"",
 data:{...initialRuntimeView(),chromeStyle:currentChromeStyle(),authority:null as AuthorityProjection|null,canSupport:false,canCatalog:false,canAftersale:false,canOrders:false,canFulfillment:false,canMembers:false,canPrivacy:false,hasFinanceCapability:false,canFinance:false,attention:null as null|{support?:{count:number};newAftersales?:{count:number};returnInstructions?:{count:number};oldRouteShipments?:{count:number};returnsToReceive?:{count:number};returnsToInspect?:{count:number};pendingRefunds?:{count:number};privacyRequests?:{count:number};privacyOverdue?:{count:number}},attentionHasItems:false,attentionError:false,coreReady:false,loading:true,navigating:false,error:"",epoch:0,alive:true,visible:true,runtimeEpoch:0},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 onShow(){this.data.alive=true;this.data.visible=true;this.setData({navigating:false});void this.load();},
 onHide(){this.data.visible=false;this.data.epoch+=1;this.data.runtimeEpoch+=1;cancelPageReads(this);cancelRuntimeRead(this);this.setData({canSupport:false,canCatalog:false,canAftersale:false,canOrders:false,canFulfillment:false,canMembers:false,canPrivacy:false,hasFinanceCapability:false,canFinance:false,attention:null,attentionHasItems:false,attentionError:false,coreReady:false});},
 onUnload(){this.onHide();this.data.alive=false;},
 current(epoch:number,token:string){return this.data.alive&&this.data.visible&&this.data.epoch===epoch&&token===getApp<IAppOption>().globalData.sessionToken;},
 async load(){if(!this.data.visible)return;cancelPageReads(this);cancelRuntimeRead(this);
  const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;this.lastSessionToken=token;
  this.setData({authority:null,canSupport:false,canCatalog:false,canAftersale:false,canOrders:false,canFulfillment:false,canMembers:false,canPrivacy:false,hasFinanceCapability:false,canFinance:false,attention:null,attentionHasItems:false,attentionError:false,coreReady:false,loading:true,error:""});
  void this.loadRuntime(epoch,token);
  try{const authority=await authorityProjection(this);
    if(!this.current(epoch,token))return;
    if(authority.version!==1||!Array.isArray(authority.capabilities)||typeof authority.managementAvailable!=="boolean")throw new Error("Invalid authority projection");
    if(!authority.managementAvailable){this.setData({loading:false,error:"当前账号没有管理权限。"});wx.showToast({title:"当前账号没有管理权限",icon:"none"});wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});return;}
    this.setData({authority,coreReady:true,canSupport:hasCapability(authority,"support.read"),canCatalog:["commerce.product.manage","commerce.qualification.manage","commerce.inventory.manage"].some(capability=>hasCapability(authority,capability as Parameters<typeof hasCapability>[1])),canAftersale:["commerce.aftersale.review","commerce.return.receive","commerce.return.inspect"].some(c=>hasCapability(authority,c as Capability)),canOrders:hasCapability(authority,"commerce.order.read"),canFulfillment:hasCapability(authority,"commerce.fulfillment.manage"),canMembers:hasCapability(authority,"member.profile.read"),canPrivacy:hasCapability(authority,"privacy.request.manage"),hasFinanceCapability:["commerce.refund.approve","commerce.fulfillment.manage","commission.settlement.approve","commerce.money.reconcile"].some(c=>hasCapability(authority,c as Capability)),loading:false});
    this.applyRuntime();
    void this.loadAttention(epoch,token);
  }catch{if(this.current(epoch,token))this.setData({authority:null,coreReady:false,loading:false,error:"管理权限暂时无法核验，所有管理入口保持关闭。"});}},
 async loadAttention(epoch:number,token:string){
  try{const result=await pageRead<{version:number;counts:Record<string,{count:number}>}>(this,{path:'/v1/management/attention'});
   if(!this.current(epoch,token))return;
   if(result.version!==1||!result.counts||Object.values(result.counts).some(row=>!Number.isSafeInteger(row.count)||row.count<0))throw Error();
   this.setData({attention:result.counts,attentionHasItems:this.hasActionableAttention(result.counts),attentionError:false});
  }catch{if(this.current(epoch,token))this.setData({attention:null,attentionHasItems:false,attentionError:true});}
 },
 hasActionableAttention(counts:Record<string,{count:number}>|null,canFinance?:boolean){
  const finance=canFinance??this.data.canFinance;
  return !!counts&&Object.entries(counts).some(([kind,row])=>kind!=="privacyOverdue"&&(kind!=="pendingRefunds"||finance)&&row.count>0);
 },
 applyRuntime(){const actions=runtimeActions(this.data.runtimeStatus);
  const canFinance=this.lastSessionToken===getApp<IAppOption>().globalData.sessionToken&&this.data.coreReady&&this.data.runtimeState==="ready"&&(actions.money||actions.recovery)&&this.data.hasFinanceCapability;
  this.setData({canFinance,attentionHasItems:this.hasActionableAttention(this.data.attention,canFinance)});},
 async loadRuntime(epoch:number,token:string){cancelRuntimeRead(this);const attempt=++this.data.runtimeEpoch;
  this.setData({runtimeState:"loading",runtimeMode:"unknown",runtimeStatus:null,runtimeCopy:"正在检查资金状态…",canFinance:false,
    attentionHasItems:this.hasActionableAttention(this.data.attention,false)});
  try{const status=validateRuntime(await orderRuntimeStatus(runtimeReadOwner(this)));
    if(!this.current(epoch,token)||attempt!==this.data.runtimeEpoch)return;
    this.setData(runtimeView(status));this.applyRuntime();
  }catch{if(this.current(epoch,token)&&attempt===this.data.runtimeEpoch)this.setData({runtimeState:"error",runtimeCopy:"资金状态暂不可用，请重试。",canFinance:false,
    attentionHasItems:this.hasActionableAttention(this.data.attention,false)});}},
 retryRuntime(){if(!this.data.visible)return;if(this.lastSessionToken!==getApp<IAppOption>().globalData.sessionToken){void this.load();return;}void this.loadRuntime(this.data.epoch,getApp<IAppOption>().globalData.sessionToken);},
 canNavigate(){return this.data.alive&&this.data.visible&&this.data.coreReady&&this.lastSessionToken===getApp<IAppOption>().globalData.sessionToken;},
 can(capability:Parameters<typeof hasCapability>[1]){return this.canNavigate()&&hasCapability(this.data.authority,capability);},
 openSupport(){if(!this.can("support.read")||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-support/index",fail:()=>this.setData({navigating:false})});},
  openCatalog(){if(!this.canNavigate()||!this.data.canCatalog||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-catalog/index",fail:()=>this.setData({navigating:false})});},
 openAftersale(event?:WechatMiniprogram.TouchEvent){if(!this.canNavigate()||!this.data.canAftersale||this.data.navigating)return;
  const filter=String(event?.currentTarget?.dataset?.attention??'');
  if(filter&&!['requested','instruction','old_route','receiving','inspection'].includes(filter))return;
  const required=filter==='receiving'?'commerce.return.receive':filter==='inspection'?'commerce.return.inspect':'commerce.aftersale.review';
  if(filter&&!this.can(required as Capability))return;
  this.setData({navigating:true});wx.navigateTo({url:`/pages/aftersale/index?mode=management${filter?`&attention=${filter}`:''}`,fail:()=>this.setData({navigating:false})});},
 openOrders(){if(!this.canNavigate()||!this.data.canOrders||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-orders/index",fail:()=>this.setData({navigating:false})});},
 openFulfillment(){if(!this.can("commerce.fulfillment.manage")||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-fulfillment/index",fail:()=>this.setData({navigating:false})});},
 openMembers(){if(!this.canNavigate()||!this.data.canMembers||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-members/index",fail:()=>this.setData({navigating:false})});},
 openPrivacy(){if(!this.can("privacy.request.manage")||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-privacy/index",fail:()=>this.setData({navigating:false})});},
 openFinance(){if(!this.canNavigate()||!this.data.canFinance||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-finance/index",fail:()=>this.setData({navigating:false})});},
 retry(){void this.load();},back(){wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});}
});
