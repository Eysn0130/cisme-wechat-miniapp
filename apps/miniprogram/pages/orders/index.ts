import { requireMemberAccess } from "../../services/api";
import { centsToYuan } from "../../services/commerce";
import { myOrders, type CommerceOrder, type MemberOrderAddress } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";

const labels:Record<string,string>={pending_payment:"待支付",cancelled:"已取消",expired:"已超时"};
Page({
  data:{chromeStyle:currentChromeStyle(),items:[] as any[],nextCursor:null as string|null,loading:true,loadingMore:false,navigating:false,error:"",pageAlive:true},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},onShow(){this.data.pageAlive=true;this.setData({navigating:false});if(!requireMemberAccess())return;void this.load();},onUnload(){this.data.pageAlive=false;},
  normalize(items:Array<CommerceOrder<MemberOrderAddress>>){return items.map(item=>({...item,statusLabel:labels[item.status]??item.status,totalYuan:centsToYuan(item.totalCents),createdLabel:new Date(item.createdAt).toLocaleString("zh-CN",{hour12:false}),summary:item.lines.map(line=>`${line.productName} · ${line.skuLabel} × ${line.quantity}`).join("；")}));},
  async load(){this.setData({loading:true,error:"",items:[],nextCursor:null});try{const page=await myOrders();if(this.data.pageAlive)this.setData({items:this.normalize(page.items),nextCursor:page.nextCursor,loading:false});}catch(error){if(this.data.pageAlive)this.setData({loading:false,error:(error as {title?:string}).title??"订单暂时无法同步，请检查网络后重试。"});}},
  async loadMore(){if(this.data.loadingMore||!this.data.nextCursor)return;this.setData({loadingMore:true});try{const page=await myOrders(this.data.nextCursor);if(this.data.pageAlive)this.setData({items:[...this.data.items,...this.normalize(page.items)],nextCursor:page.nextCursor});}catch{wx.showToast({title:"更多订单暂时无法加载",icon:"none"});}finally{if(this.data.pageAlive)this.setData({loadingMore:false});}},
  open(event:WechatMiniprogram.TouchEvent){if(this.data.navigating)return;const id=String(event.currentTarget.dataset.id??"");if(!id)return;this.setData({navigating:true});wx.navigateTo({url:`/pages/order-detail/index?id=${encodeURIComponent(id)}`,fail:()=>this.setData({navigating:false})});},
  openShop(){if(this.data.navigating)return;this.setData({navigating:true});wx.redirectTo({url:"/pages/shop/index",fail:()=>this.setData({navigating:false})});},
  back(){if(this.data.navigating)return;this.setData({navigating:true});wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/profile/index"})});}
});
