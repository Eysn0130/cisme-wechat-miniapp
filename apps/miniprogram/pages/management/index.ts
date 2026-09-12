import { authorityProjection,hasCapability,type AuthorityProjection } from "../../services/authority";
import { currentChromeStyle } from "../../services/layout";
import { orderRuntimeStatus } from "../../services/orders";

Page({
 data:{chromeStyle:currentChromeStyle(),authority:null as AuthorityProjection|null,canSupport:false,canCatalog:false,canOrders:false,canMembers:false,canFinance:false,loading:true,navigating:false,error:"",epoch:0,alive:true},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},onShow(){this.data.alive=true;this.setData({navigating:false});void this.load();},onUnload(){this.data.alive=false;this.data.epoch+=1;},
 async load(){const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
  this.setData({authority:null,canSupport:false,canCatalog:false,canOrders:false,canMembers:false,canFinance:false,loading:true,error:""});
  const current=()=>this.data.alive&&this.data.epoch===epoch&&token===getApp<IAppOption>().globalData.sessionToken;
  try{const [authority,status]=await Promise.all([authorityProjection(),orderRuntimeStatus().catch(()=>null)]);
    if(!current())return;
    if(!authority.managementAvailable){wx.showToast({title:"当前账号没有管理权限",icon:"none"});wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});return;}
    const canFinance=Boolean(status?.isolatedMoneyOperationsAvailable)&&[
      "commerce.refund.approve","commerce.fulfillment.manage","commission.settlement.approve","commerce.money.reconcile"
    ].some(capability=>hasCapability(authority,capability as Parameters<typeof hasCapability>[1]));
    this.setData({authority,canSupport:hasCapability(authority,"support.read"),canCatalog:["commerce.product.manage","commerce.qualification.manage","commerce.inventory.manage"].some((capability)=>hasCapability(authority,capability as Parameters<typeof hasCapability>[1])),canOrders:hasCapability(authority,"commerce.order.read"),canMembers:hasCapability(authority,"member.profile.read"),canFinance,loading:false});
  }catch{if(current())this.setData({loading:false,error:"管理权限暂时无法核验，所有管理入口保持关闭。"});}},
 can(capability:Parameters<typeof hasCapability>[1]){return hasCapability(this.data.authority,capability);},
 openSupport(){if(!this.can("support.read")||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-support/index",fail:()=>this.setData({navigating:false})});},
  openCatalog(){if(!this.data.canCatalog||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-catalog/index",fail:()=>this.setData({navigating:false})});},
 openOrders(){if(!this.data.canOrders||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-orders/index",fail:()=>this.setData({navigating:false})});},
 openMembers(){if(!this.data.canMembers||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-members/index",fail:()=>this.setData({navigating:false})});},
 openFinance(){if(!this.data.canFinance||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-finance/index",fail:()=>this.setData({navigating:false})});},
 retry(){void this.load();},back(){wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});}
});
