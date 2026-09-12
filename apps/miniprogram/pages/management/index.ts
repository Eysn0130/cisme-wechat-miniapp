import { authorityProjection,hasCapability,type AuthorityProjection } from "../../services/authority";
import { currentChromeStyle } from "../../services/layout";

Page({
 data:{chromeStyle:currentChromeStyle(),authority:null as AuthorityProjection|null,canSupport:false,canCatalog:false,canOrders:false,canMembers:false,loading:true,navigating:false,error:""},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},onShow(){this.setData({navigating:false});void this.load();},
 async load(){this.setData({authority:null,canSupport:false,canCatalog:false,canOrders:false,canMembers:false,loading:true,error:""});try{const authority=await authorityProjection();if(!authority.managementAvailable){wx.showToast({title:"当前账号没有管理权限",icon:"none"});wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});return;}this.setData({authority,canSupport:hasCapability(authority,"support.read"),canCatalog:["commerce.product.manage","commerce.qualification.manage","commerce.inventory.manage"].some((capability)=>hasCapability(authority,capability as any)),canOrders:hasCapability(authority,"commerce.order.read"),canMembers:hasCapability(authority,"member.profile.read"),loading:false});}catch{this.setData({loading:false,error:"管理权限暂时无法核验，所有管理入口保持关闭。"});}},
 can(capability:Parameters<typeof hasCapability>[1]){return hasCapability(this.data.authority,capability);},
 openSupport(){if(!this.can("support.read")||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-support/index",fail:()=>this.setData({navigating:false})});},
  openCatalog(){if(!this.data.canCatalog||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-catalog/index",fail:()=>this.setData({navigating:false})});},
 openOrders(){if(!this.data.canOrders||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-orders/index",fail:()=>this.setData({navigating:false})});},
 openMembers(){if(!this.data.canMembers||this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-members/index",fail:()=>this.setData({navigating:false})});},
 retry(){void this.load();},back(){wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});}
});
