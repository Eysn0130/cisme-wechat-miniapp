import { authorityProjection, hasCapability, type AuthorityProjection } from "../../services/authority";
import { currentChromeStyle } from "../../services/layout";
import { orderRuntimeStatus } from "../../services/orders";
import { cancelPageReads } from "../../services/page-requests";
import { cancelRuntimeRead, initialRuntimeView, runtimeActions, runtimeReadOwner, runtimeView, validateRuntime } from "../../services/commerce-runtime";

Page({
 lastSessionToken:"",
 data:{...initialRuntimeView(),chromeStyle:currentChromeStyle(),authority:null as AuthorityProjection|null,canSupport:false,canCatalog:false,canOrders:false,canMembers:false,canPrivacy:false,canFinance:false,coreReady:false,loading:true,navigating:false,error:"",epoch:0,alive:true,visible:true,runtimeEpoch:0},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 onShow(){this.data.alive=true;this.data.visible=true;this.setData({navigating:false});void this.load();},
 onHide(){this.data.visible=false;this.data.epoch+=1;this.data.runtimeEpoch+=1;cancelPageReads(this);cancelRuntimeRead(this);this.setData({canSupport:false,canCatalog:false,canOrders:false,canMembers:false,canPrivacy:false,canFinance:false,coreReady:false});},
 onUnload(){this.onHide();this.data.alive=false;},
 current(epoch:number,token:string){return this.data.alive&&this.data.visible&&this.data.epoch===epoch&&token===getApp<IAppOption>().globalData.sessionToken;},
 async load(){if(!this.data.visible)return;cancelPageReads(this);cancelRuntimeRead(this);
  const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;this.lastSessionToken=token;
  this.setData({authority:null,canSupport:false,canCatalog:false,canOrders:false,canMembers:false,canPrivacy:false,canFinance:false,coreReady:false,loading:true,error:""});
  void this.loadRuntime(epoch,token);
  try{const authority=await authorityProjection(this);
    if(!this.current(epoch,token))return;
    if(authority.version!==1||!Array.isArray(authority.capabilities)||typeof authority.managementAvailable!=="boolean")throw new Error("Invalid authority projection");
    if(!authority.managementAvailable){this.setData({loading:false,error:"当前账号没有管理权限。"});wx.showToast({title:"当前账号没有管理权限",icon:"none"});wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});return;}
    this.setData({authority,coreReady:true,canSupport:hasCapability(authority,"support.read"),canCatalog:["commerce.product.manage","commerce.qualification.manage","commerce.inventory.manage"].some(capability=>hasCapability(authority,capability as Parameters<typeof hasCapability>[1])),canOrders:hasCapability(authority,"commerce.order.read"),canMembers:hasCapability(authority,"member.profile.read"),canPrivacy:hasCapability(authority,"privacy.request.manage"),loading:false});
    this.applyRuntime();
  }catch{if(this.current(epoch,token))this.setData({authority:null,coreReady:false,loading:false,error:"管理权限暂时无法核验，所有管理入口保持关闭。"});}},
 applyRuntime(){const actions=runtimeActions(this.data.runtimeStatus);
  this.setData({canFinance:this.lastSessionToken===getApp<IAppOption>().globalData.sessionToken&&this.data.coreReady&&this.data.runtimeState==="ready"&&(actions.money||actions.recovery)&&[
    "commerce.refund.approve","commerce.fulfillment.manage","commission.settlement.approve","commerce.money.reconcile"
  ].some(capability=>hasCapability(this.data.authority,capability as Parameters<typeof hasCapability>[1]))});},
 async loadRuntime(epoch:number,token:string){cancelRuntimeRead(this);const attempt=++this.data.runtimeEpoch;
  this.setData({runtimeState:"loading",runtimeMode:"unknown",runtimeStatus:null,runtimeCopy:"正在核验资金操作状态，其他已授权入口不受影响。",canFinance:false});
  try{const status=validateRuntime(await orderRuntimeStatus(runtimeReadOwner(this)));
    if(!this.current(epoch,token)||attempt!==this.data.runtimeEpoch)return;
    this.setData(runtimeView(status));this.applyRuntime();
  }catch{if(this.current(epoch,token)&&attempt===this.data.runtimeEpoch)this.setData({runtimeState:"error",runtimeCopy:"资金操作状态暂时无法核验，相关入口保持关闭；可单独重试。",canFinance:false});}},
 retryRuntime(){if(!this.data.visible)return;if(this.lastSessionToken!==getApp<IAppOption>().globalData.sessionToken){void this.load();return;}void this.loadRuntime(this.data.epoch,getApp<IAppOption>().globalData.sessionToken);},
 canNavigate(){return this.data.alive&&this.data.visible&&this.data.coreReady&&this.lastSessionToken===getApp<IAppOption>().globalData.sessionToken;},
 can(capability:Parameters<typeof hasCapability>[1]){return this.canNavigate()&&hasCapability(this.data.authority,capability);},
 openSupport(){if(!this.can("support.read")||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-support/index",fail:()=>this.setData({navigating:false})});},
  openCatalog(){if(!this.canNavigate()||!this.data.canCatalog||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-catalog/index",fail:()=>this.setData({navigating:false})});},
 openOrders(){if(!this.canNavigate()||!this.data.canOrders||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-orders/index",fail:()=>this.setData({navigating:false})});},
 openMembers(){if(!this.canNavigate()||!this.data.canMembers||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-members/index",fail:()=>this.setData({navigating:false})});},
 openPrivacy(){if(!this.can("privacy.request.manage")||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-privacy/index",fail:()=>this.setData({navigating:false})});},
 openFinance(){if(!this.canNavigate()||!this.data.canFinance||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-finance/index",fail:()=>this.setData({navigating:false})});},
 retry(){void this.load();},back(){wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});}
});
