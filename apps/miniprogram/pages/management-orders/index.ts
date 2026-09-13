import { requireCapability } from "../../services/authority";
import { centsToYuan } from "../../services/commerce";
import { managementOrders, type CommerceOrderSummary } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";
const labels:Record<string,string>={pending_payment:"待支付",cancelled:"已取消",expired:"已超时"};
Page({
 data:{chromeStyle:currentChromeStyle(),items:[] as any[],nextCursor:null as string|null,loading:true,loadingMore:false,navigating:false,error:"",pageAlive:true,epoch:0},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},async onShow(){
   this.data.pageAlive=true;
   const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
   this.setData({items:[],nextCursor:null,loading:true,loadingMore:false,navigating:false,error:""});
   const allowed=await requireCapability("commerce.order.read");
   if(!this.current(epoch,token))return;
   if(!allowed){this.setData({loading:false,error:"当前账号没有订单查看权限。"});return;}
   await this.load();
 },onUnload(){this.data.pageAlive=false;this.data.epoch+=1;},
 current(epoch:number,token:string){return this.data.pageAlive&&this.data.epoch===epoch&&
   token===getApp<IAppOption>().globalData.sessionToken;},
 normalize(items:Array<CommerceOrderSummary>){return items.map(item=>({...item,statusLabel:labels[item.status]??item.status,totalYuan:centsToYuan(item.totalCents),createdLabel:new Date(item.createdAt).toLocaleString("zh-CN",{hour12:false}),summary:item.lines.map(line=>`${line.productName} × ${line.quantity}`).join("；")}));},
 async load(){const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
   this.setData({loading:true,error:"",items:[],nextCursor:null});
   try{const page=await managementOrders();if(this.current(epoch,token))
     this.setData({items:this.normalize(page.items),nextCursor:page.nextCursor,loading:false});
   }catch(error){if(this.current(epoch,token))this.setData({loading:false,
     error:(error as {title?:string}).title??"订单队列暂时无法同步，权限和旧状态不会被缓存。"});}},
 async loadMore(){const cursor=this.data.nextCursor;if(this.data.loadingMore||!cursor)return;
   const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
   this.setData({loadingMore:true});try{const page=await managementOrders(cursor);
     if(this.current(epoch,token)&&this.data.nextCursor===cursor)this.setData({items:[...this.data.items,...this.normalize(page.items)],nextCursor:page.nextCursor});
   }catch{if(this.current(epoch,token))wx.showToast({title:"更多订单暂时无法加载",icon:"none"});}
   finally{if(this.current(epoch,token))this.setData({loadingMore:false});}},
 open(event:WechatMiniprogram.TouchEvent){if(this.data.navigating)return;const id=String(event.currentTarget.dataset.id??"");if(!id)return;this.setData({navigating:true});wx.navigateTo({url:`/pages/management-order-detail/index?id=${encodeURIComponent(id)}`,fail:()=>this.setData({navigating:false})});},
 back(){if(this.data.navigating)return;this.setData({navigating:true});wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management/index"})});}
});
