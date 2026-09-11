import { requireCapability } from "../../services/authority";
import { request } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";
const labels:Record<string,string>={waiting_human:"待人工",human_active:"人工处理中",ai_active:"AI 处理中",resolved:"已解决"};
let timer:ReturnType<typeof setInterval>|null=null;
Page({
 data:{chromeStyle:currentChromeStyle(),items:[] as any[],nextCursor:null as string|null,loading:true,loadingMore:false,error:"",navigating:false,pageAlive:true},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},async onShow(){this.data.pageAlive=true;this.setData({items:[],nextCursor:null,navigating:false,loading:true,error:""});if(!await requireCapability("support.read"))return;await this.load();this.startPolling();},
 onHide(){this.stopPolling();},onUnload(){this.data.pageAlive=false;this.stopPolling();},startPolling(){this.stopPolling();timer=setInterval(()=>void this.load(true),6000);},stopPolling(){if(timer)clearInterval(timer);timer=null;},
 normalize(items:any[]){return items.map(item=>({...item,initial:Array.from(String(item.memberDisplayName||"C"))[0]||"C",statusLabel:labels[item.status]||item.status,unreadLabel:item.teamUnreadCount>99?"99+":String(item.teamUnreadCount||""),timeLabel:new Date(item.updatedAt).toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})}));},
 async load(silent=false){if(!silent)this.setData({loading:true,error:""});try{const page=await request<any>({path:"/v1/management/support/conversations?limit=30",cacheTags:["support"]});if(this.data.pageAlive)this.setData({items:this.normalize(page.items||[]),nextCursor:page.nextCursor??null,loading:false,error:""});}catch{if(this.data.pageAlive&&!silent)this.setData({loading:false,error:"客服队列暂时无法同步，旧列表不会被当作当前状态。"});}},
 async loadMore(){if(this.data.loadingMore||this.data.nextCursor===null)return;this.setData({loadingMore:true});try{const page=await request<any>({path:`/v1/management/support/conversations?limit=30&cursor=${encodeURIComponent(this.data.nextCursor)}`,cacheTags:["support"]});if(this.data.pageAlive)this.setData({items:[...this.data.items,...this.normalize(page.items||[])],nextCursor:page.nextCursor??null});}catch{wx.showToast({title:"更多会话暂时无法加载",icon:"none"});}finally{if(this.data.pageAlive)this.setData({loadingMore:false});}},
 open(event:WechatMiniprogram.TouchEvent){if(this.data.navigating)return;const id=String(event.currentTarget.dataset.id||"");if(!id)return;this.setData({navigating:true});wx.navigateTo({url:`/pages/management-support-chat/index?id=${encodeURIComponent(id)}`,fail:()=>this.setData({navigating:false})});},
 retry(){void this.load();},back(){wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management/index"})});}
});
