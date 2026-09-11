import { requireCapability } from "../../services/authority";
import { centsToYuan } from "../../services/commerce";
import { managementOrders, type CommerceOrder, type ManagementOrderAddress } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";
const labels:Record<string,string>={pending_payment:"待支付",cancelled:"已取消",expired:"已超时"};
Page({
 data:{chromeStyle:currentChromeStyle(),items:[] as any[],nextCursor:null as string|null,loading:true,loadingMore:false,navigating:false,error:"",pageAlive:true},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},async onShow(){this.data.pageAlive=true;this.setData({navigating:false});if(!await requireCapability("commerce.order.read"))return;await this.load();},onUnload(){this.data.pageAlive=false;},
 normalize(items:Array<CommerceOrder<ManagementOrderAddress>>){return items.map(item=>({...item,statusLabel:labels[item.status]??item.status,totalYuan:centsToYuan(item.totalCents),createdLabel:new Date(item.createdAt).toLocaleString("zh-CN",{hour12:false}),recipient:item.address?`${item.address.recipientNameMasked} · ${item.address.phoneMasked}`:"地址不可用",summary:item.lines.map(line=>`${line.productName} × ${line.quantity}`).join("；")}));},
 async load(){this.setData({loading:true,error:"",items:[],nextCursor:null});try{const page=await managementOrders();if(this.data.pageAlive)this.setData({items:this.normalize(page.items),nextCursor:page.nextCursor,loading:false});}catch(error){if(this.data.pageAlive)this.setData({loading:false,error:(error as {title?:string}).title??"订单队列暂时无法同步，权限和旧状态不会被缓存。"});}},
 async loadMore(){if(this.data.loadingMore||!this.data.nextCursor)return;this.setData({loadingMore:true});try{const page=await managementOrders(this.data.nextCursor);if(this.data.pageAlive)this.setData({items:[...this.data.items,...this.normalize(page.items)],nextCursor:page.nextCursor});}catch{wx.showToast({title:"更多订单暂时无法加载",icon:"none"});}finally{if(this.data.pageAlive)this.setData({loadingMore:false});}},
 open(event:WechatMiniprogram.TouchEvent){if(this.data.navigating)return;const id=String(event.currentTarget.dataset.id??"");if(!id)return;this.setData({navigating:true});wx.navigateTo({url:`/pages/management-order-detail/index?id=${encodeURIComponent(id)}`,fail:()=>this.setData({navigating:false})});},
 back(){if(this.data.navigating)return;this.setData({navigating:true});wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management/index"})});}
});
