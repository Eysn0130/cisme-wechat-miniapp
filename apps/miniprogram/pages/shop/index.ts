import { requireGuestCommunityAccess, requireMemberAccess } from "../../services/api";
import { cancelPageReads } from "../../services/page-requests";
import {retainReadPresentation} from "../../services/read-presentation";
import {catalogList} from "../../services/commerce";
import {commerceShopItems} from "../../services/commerce-content";
import {currentChromeStyle} from "../../services/layout";

Page({
  data:{chromeStyle:currentChromeStyle(),items:commerceShopItems([]),catalogLoaded:false,loading:true,navigating:false,loadAttempt: 0,pageAlive:true,error:""},
  onLoad(){this.data.pageAlive=true;},
  onShow(){
    if(!requireGuestCommunityAccess("/pages/shop/index"))return;
    this.data.pageAlive=true;
    this.setData({navigating:false});
    const tab=this.getTabBar?.();
    tab?.syncActive?.(1);
    tab?.setData({active:1,externalBusy:false});
    void this.load();
  },
  onHide(){this.data.loadAttempt += 1;cancelPageReads(this);},
  onUnload(){this.data.pageAlive = false;this.onHide();},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  async onPullDownRefresh(){await this.load();wx.stopPullDownRefresh();},
  async load(){
    cancelPageReads(this);
    const attempt=this.data.loadAttempt+1;
    const preserve = retainReadPresentation(this);
    this.setData({loadAttempt:attempt,...(!preserve?{items:commerceShopItems([]),catalogLoaded:false}:{}),loading:true,error:""});
    try{
      const catalog=await catalogList(undefined,this);
      if(!this.data.pageAlive || this.data.loadAttempt !== attempt)return;
      const items=commerceShopItems(catalog.items);
      this.setData({items,catalogLoaded:true,loading:false,error:""});
    }catch{
      if(this.data.pageAlive&&this.data.loadAttempt===attempt)
        this.setData({items:commerceShopItems([]),catalogLoaded:false,loading:false,error:"商品开售与库存信息暂未更新，请重试。"});
    }
  },
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
