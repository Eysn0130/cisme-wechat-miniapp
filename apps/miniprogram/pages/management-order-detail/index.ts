import { requireCapability } from "../../services/authority";
import { centsToYuan } from "../../services/commerce";
import { managementOrder, type CommerceOrder, type ManagementOrderAddress } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";
const labels:Record<string,string>={pending_payment:"待支付",cancelled:"已取消",expired:"已超时"};
Page({
 data:{chromeStyle:currentChromeStyle(),id:"",order:null as any,loading:true,navigating:false,error:"",pageAlive:true},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},onLoad(query:Record<string,string|undefined>){this.setData({id:query.id??""});},async onShow(){this.data.pageAlive=true;this.setData({navigating:false});if(!await requireCapability("commerce.order.read"))return;await this.load();},onUnload(){this.data.pageAlive=false;},
 normalize(order:CommerceOrder<ManagementOrderAddress>){return {...order,statusLabel:labels[order.status]??order.status,totalYuan:centsToYuan(order.totalCents),createdLabel:new Date(order.createdAt).toLocaleString("zh-CN",{hour12:false}),lines:order.lines.map(line=>({...line,totalYuan:centsToYuan(line.totalCents)})),addressSummary:order.address?`${order.address.province}${order.address.city}${order.address.district}`:""};},
 async load(){this.setData({loading:true,error:""});try{const order=await managementOrder(this.data.id);if(this.data.pageAlive)this.setData({order:this.normalize(order),loading:false});}catch(error){if(this.data.pageAlive)this.setData({order:null,loading:false,error:(error as {title?:string}).title??"订单详情暂时无法读取；权限变化后不会继续展示旧内容。"});}},
 back(){if(this.data.navigating)return;this.setData({navigating:true});wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management-orders/index"})});}
});
