import {retainReadPresentation} from "../../services/read-presentation";
import {catalogList} from "../../services/commerce";
import {commerceShopItems} from "../../services/commerce-content";
import {requireMemberAccess} from "../../services/api";
import {currentChromeStyle,shouldReduceMotion} from "../../services/layout";

Page({
  data:{chromeStyle:currentChromeStyle(),catalog:null as any,featured:null as any,items:commerceShopItems([]),heroes:commerceShopItems([]).slice(0,2),heroIndex:0,autoplay:false,purchaseAvailable:false,loading:true,navigating:false,loadAttempt: 0,pageAlive:true,error:""},
  visible:false,
  onLoad(){this.data.pageAlive=true;},
  onShow(){this.visible=true;this.data.pageAlive=true;this.setData({navigating:false,autoplay:!shouldReduceMotion()});const tab=this.getTabBar?.();tab?.syncActive?.(1);tab?.setData({active:1,externalBusy:false});void this.load();},
  onHide(){this.visible=false;this.data.loadAttempt += 1;this.setData({autoplay:false});},
  onUnload(){this.visible=false;this.data.pageAlive = false;this.data.loadAttempt += 1;},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  onPageScroll(event:WechatMiniprogram.Page.IPageScrollOption){const autoplay=this.visible&&event.scrollTop<360&&!shouldReduceMotion();if(autoplay!==this.data.autoplay)this.setData({autoplay});},
  async onPullDownRefresh(){await this.load();wx.stopPullDownRefresh();},
  async load(){
    const attempt=this.data.loadAttempt+1;
    const preserve = retainReadPresentation(this);
    this.setData({loadAttempt:attempt,...(!preserve?{catalog:null,featured:null,purchaseAvailable:false}:{}),loading:true,error:""});
    try{
      const catalog=await catalogList();
      if(!this.data.pageAlive || this.data.loadAttempt !== attempt)return;
      const items=commerceShopItems(catalog.items);
      this.setData({catalog,items,heroes:items.slice(0,2),featured:items[0]??null,purchaseAvailable:items.some(p=>p.purchaseEnabled),loading:false,error:""});
    }catch{if(this.data.pageAlive&&this.data.loadAttempt===attempt)this.setData({catalog:null,items:commerceShopItems([]),heroes:commerceShopItems([]).slice(0,2),purchaseAvailable:false,loading:false,error:"商品开售与库存信息暂未更新，请重试。"});}
  },
  heroChange(event:WechatMiniprogram.CustomEvent<{current:number}>){this.setData({heroIndex:event.detail.current});},
  openProduct(event:WechatMiniprogram.TouchEvent){
    if(this.data.navigating)return;
    const id=String(event.currentTarget.dataset.id??"");if(!id)return;
    this.setData({navigating:true});this.getTabBar?.()?.setData({externalBusy:true});
    wx.navigateTo({url:`/pages/product/index?id=${encodeURIComponent(id)}`,fail:()=>{if(this.data.pageAlive)this.setData({navigating:false});this.getTabBar?.()?.setData({externalBusy:false});wx.showToast({title:"商品详情暂时无法打开",icon:"none"});}});
  },
  openOrders(){
    if(this.data.navigating||!requireMemberAccess("/pages/orders/index"))return;
    this.setData({navigating:true});this.getTabBar?.()?.setData({externalBusy:true});
    wx.navigateTo({url:"/pages/orders/index",fail:()=>{this.setData({navigating:false});this.getTabBar?.()?.setData({externalBusy:false});wx.showToast({title:"订单暂时无法打开",icon:"none"});}});
  }
});
