import { requireCapability } from "../../services/authority";
import { centsToYuan } from "../../services/commerce";
import { managementOrder, type CommerceOrder, type ManagementOrderAddress } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";
const labels:Record<string,string>={pending_payment:"待支付",cancelled:"已取消",expired:"已超时",paid:"支付已核验"};
const orderIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
Page({
 data:{chromeStyle:currentChromeStyle(),id:"",order:null as any,loading:true,navigating:false,error:"",invalidId:false,pageAlive:true,epoch:0},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},onLoad(query:Record<string,string|undefined>){const id=query.id??"";
   this.setData({id,invalidId:!orderIdPattern.test(id)});},async onShow(){
   this.data.pageAlive=true;
   const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
   this.setData({order:null,navigating:false,loading:true,error:""});
   const allowed=await requireCapability("commerce.order.read");
   if(!this.current(epoch,token))return;
   if(!allowed){this.setData({loading:false,error:"当前账号没有订单查看权限。"});return;}
   await this.load();
 },onUnload(){this.data.pageAlive=false;this.data.epoch+=1;},
 current(epoch:number,token:string){return this.data.pageAlive&&this.data.epoch===epoch&&
   token===getApp<IAppOption>().globalData.sessionToken;},
 normalize(order:CommerceOrder<ManagementOrderAddress>){return {...order,statusLabel:labels[order.status]??order.status,totalYuan:centsToYuan(order.totalCents),creditYuan:centsToYuan(order.creditTenderCents),cashYuan:centsToYuan(order.cashPayableCents),createdLabel:new Date(order.createdAt).toLocaleString("zh-CN",{hour12:false}),lines:order.lines.map(line=>({...line,totalYuan:centsToYuan(line.totalCents)})),addressSummary:order.address?`${order.address.province}${order.address.city}${order.address.district}`:""};},
 async load(){const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
   this.setData({order:null,loading:true,error:""});
   if(this.data.invalidId){if(this.current(epoch,token))this.setData({loading:false,error:"请从订单列表选择一笔订单。"});return;}
   try{const order=await managementOrder(this.data.id);
     if(this.current(epoch,token))this.setData({order:this.normalize(order),loading:false});
   }catch(error){if(this.current(epoch,token))this.setData({loading:false,
     error:(error as {title?:string}).title??"订单详情暂时无法读取；权限变化后不会继续展示旧内容。"});}},
 back(){if(this.data.navigating)return;this.setData({navigating:true});wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management-orders/index"})});}
});
