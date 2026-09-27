import { authorityProjection } from "../../services/authority";
import { clearAuthenticationRedirectSuppression, requireMemberAccess, retainMemberSnapshot } from "../../services/api";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { cancelPageReads } from "../../services/page-requests";
import { centsToYuan } from "../../services/commerce";
import { managementOrders, type CommerceOrderSummary } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";
const labels:Record<string,string>={pending_payment:"待支付",cancelled:"已取消",expired:"已超时",paid:"已付款"};
Page({
  lastToken:"",lastRevision:-1,
  data:{chromeStyle:currentChromeStyle(),items:[] as any[],nextCursor:null as string|null,loading:true,refreshing:false,loadingMore:false,navigating:false,error:"",pageAlive:true,visible:true,coreReady:false,loadAttempt:0},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  syncSession(){const token=getApp<IAppOption>().globalData.sessionToken,revision=commerceContextRevision();
    if(token!==this.lastToken||revision!==this.lastRevision){cancelPageReads(this);this.data.loadAttempt+=1;this.lastToken=token;this.lastRevision=revision;
      this.setData({items:[],nextCursor:null,coreReady:false,loadingMore:false,error:""});}},
  onShow(){this.data.pageAlive=true;this.data.visible=true;
    if(!retainMemberSnapshot(this))this.setData({items:[],nextCursor:null,coreReady:false});
    this.setData({navigating:false});return this.load();},
  onHide(){this.data.visible=false;this.data.coreReady=false;this.data.loadAttempt+=1;cancelPageReads(this);},
  onUnload(){this.onHide();this.data.pageAlive=false;},
  current(attempt:number,token:string){return this.data.pageAlive&&this.data.visible&&this.data.loadAttempt===attempt&&this.lastToken===token&&token===getApp<IAppOption>().globalData.sessionToken&&this.lastRevision===commerceContextRevision();},
  canOpen(){return this.data.coreReady&&this.current(this.data.loadAttempt,this.lastToken)&&!this.data.navigating;},
  normalize(items:CommerceOrderSummary[]){return items.map(item=>({...item,statusLabel:labels[item.status]??"状态更新中",totalYuan:centsToYuan(item.totalCents),createdLabel:new Date(item.createdAt).toLocaleString("zh-CN",{hour12:false}),summary:item.lines.map(line=>`${line.productName} · ${line.skuLabel} × ${line.quantity}`).join("；")}));},
  async load(event?:WechatMiniprogram.TouchEvent){
    if(!this.data.visible||!this.data.pageAlive)return;
    if(event?.type)clearAuthenticationRedirectSuppression();this.syncSession();
    if(!requireMemberAccess()){this.setData({loading:false,refreshing:false,coreReady:false,items:[],nextCursor:null,error:"请先确认身份后查看订单。"});return;}
    cancelPageReads(this);const attempt=++this.data.loadAttempt,token=this.lastToken;
    this.setData({loading:this.data.items.length===0,refreshing:this.data.items.length>0,coreReady:false,loadingMore:false,error:""});
    try{
      const authority=await authorityProjection(this);
      if(!this.current(attempt,token))return;
      if(authority.version!==1||authority.managementAvailable!==true||!Array.isArray(authority.capabilities)||!authority.capabilities.includes("commerce.order.read"))throw {status:403,title:"当前账号没有订单查看权限。"};
      const page=await managementOrders(undefined,this);if(!this.current(attempt,token))return;
      this.setData({items:this.normalize(page.items),nextCursor:page.nextCursor,loading:false,refreshing:false,coreReady:true});
    }catch(error){if(this.current(attempt,token)){
      const denied=[401,403,404].includes((error as {status?:number})?.status??0);
      this.setData({loading:false,refreshing:false,coreReady:false,items:denied?[]:this.data.items,nextCursor:denied?null:this.data.nextCursor,error:(error as {title?:string})?.title??"订单暂时无法同步，已显示内容仅供参考，请重试。"});}}
  },
  async loadMore(){const cursor=this.data.nextCursor;if(!this.canOpen()||this.data.loadingMore||!cursor)return;
    const attempt=this.data.loadAttempt,token=this.lastToken;this.setData({loadingMore:true});
    try{const page=await managementOrders(cursor,this);if(!this.current(attempt,token)||this.data.nextCursor!==cursor)return;
      const seen=new Set(this.data.items.map(item=>item.id));this.setData({items:[...this.data.items,...this.normalize(page.items).filter((item: { id: string })=>!seen.has(item.id))],nextCursor:page.nextCursor});
    }catch(error){if(this.current(attempt,token)){
      if([401,403,404].includes((error as {status?:number})?.status??0))this.setData({items:[],nextCursor:null,coreReady:false,error:"订单访问权限需重新核验，请重试。"});
      else wx.showToast({title:"更多订单暂时无法加载",icon:"none"});}}
    finally{if(this.current(attempt,token))this.setData({loadingMore:false});}
  },
  open(event:WechatMiniprogram.TouchEvent){if(!this.canOpen())return;const id=String(event.currentTarget.dataset.id??"");if(!this.data.items.some(item=>item.id===id))return;
    this.setData({navigating:true});wx.navigateTo({url:`/pages/management-order-detail/index?id=${encodeURIComponent(id)}`,fail:()=>this.setData({navigating:false})});},
  back(){if(!this.data.visible||this.data.navigating)return;this.setData({navigating:true});wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management/index"})});}
});
