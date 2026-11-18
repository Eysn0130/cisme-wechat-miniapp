import {beijingDateParts} from '../../services/business-time';
import {sectionTabValue} from '../../services/section-tabs';
import { authorityProjection } from "../../services/authority";
import { clearAuthenticationRedirectSuppression, requireMemberAccess, retainMemberSnapshot } from "../../services/api";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { cancelPageReads } from "../../services/page-requests";
import { centsToYuan } from "../../services/commerce";
import { orderLineSummary, managementOrders, type CommerceOrderSummary } from "../../services/orders";
import { currentChromeStyle } from "../../services/layout";
const labels:Record<string,string>={pending_payment:"待支付",cancelled:"已取消",expired:"已超时",paid:"已付款"};
Page({
  lastToken:"",lastRevision:-1,
  data:{stage:'all',from:'',through:'',totalCount:null as number|null,canRewards:false,stages:[{id:'all',label:'全部'},{id:'pending_payment',label:'待付款'},{id:'unshipped',label:'待发货'},{id:'shipped',label:'已发货'},{id:'completed',label:'已完成'},{id:'refunded',label:'退款'},{id:'closed',label:'已关闭'}],hasSnapshot:false,chromeStyle:currentChromeStyle(),items:[] as any[],nextCursor:null as string|null,loading:true,refreshing:false,loadingMore:false,navigating:false,error:"",pageAlive:true,visible:true,coreReady:false,loadAttempt:0},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  syncSession(){const token=getApp<IAppOption>().globalData.sessionToken,revision=commerceContextRevision();
    if(token!==this.lastToken||revision!==this.lastRevision){cancelPageReads(this);this.data.loadAttempt+=1;this.lastToken=token;this.lastRevision=revision;
      this.setData({hasSnapshot:false,items:[],nextCursor:null,coreReady:false,loadingMore:false,error:""});}},
  onShow(){this.data.pageAlive=true;this.data.visible=true;
    if(!retainMemberSnapshot(this))this.setData({hasSnapshot:false,items:[],nextCursor:null,coreReady:false});
    this.setData({navigating:false});return this.load();},
  onHide(){this.data.visible=false;this.data.coreReady=false;this.data.loadAttempt+=1;cancelPageReads(this);},
  onUnload(){this.onHide();this.data.pageAlive=false;},
  current(attempt:number,token:string){return this.data.pageAlive&&this.data.visible&&this.data.loadAttempt===attempt&&this.lastToken===token&&token===getApp<IAppOption>().globalData.sessionToken&&this.lastRevision===commerceContextRevision();},
  canOpen(){return this.data.coreReady&&this.current(this.data.loadAttempt,this.lastToken)&&!this.data.navigating;},
  normalize(items:CommerceOrderSummary[]){return items.map(item=>({...item,statusLabel:item.status==="paid"&&(item.refundedCents??0)>0?(item.refundedCents!>=item.totalCents?"已退款":"部分退款"):(item.status==='paid'?({unshipped:'待发货',shipped:'已发货',completed:'已完成'}[item.fulfillmentState??'unshipped']??'已付款'):(labels[item.status]??"状态待核对")),totalYuan:centsToYuan(item.totalCents),createdLabel:beijingDateParts(item.createdAt).date+' '+beijingDateParts(item.createdAt).time,summary:item.lines.map(orderLineSummary).join("；")}));},
  async load(event?:WechatMiniprogram.TouchEvent){
    if(!this.data.visible||!this.data.pageAlive)return;
    if(event?.type)clearAuthenticationRedirectSuppression();this.syncSession();
    if(!requireMemberAccess()){this.setData({loading:false,refreshing:false,coreReady:false,items:[],nextCursor:null,error:"请先登录，再查看订单。"});return;}
    cancelPageReads(this);const attempt=++this.data.loadAttempt,token=this.lastToken;
    this.setData({loading:!this.data.hasSnapshot,refreshing:this.data.hasSnapshot,coreReady:false,loadingMore:false,error:""});
    try{
      const authority=await authorityProjection(this);
      if(!this.current(attempt,token))return;
      if(authority.version!==1||authority.managementAvailable!==true||!Array.isArray(authority.capabilities)||!authority.capabilities.includes("commerce.order.read"))throw {status:403,title:"当前账号没有订单查看权限。"};
      this.setData({canRewards:authority.capabilities.includes('commerce.fulfillment.manage')});const page=await managementOrders(undefined,this,{stage:this.data.stage,from:this.data.from,through:this.data.through});if(!this.current(attempt,token))return;
      this.setData({totalCount:page.totalCount??null,items:this.normalize(page.items),nextCursor:page.nextCursor,hasSnapshot:true,loading:false,refreshing:false,coreReady:true});
    }catch(error){if(this.current(attempt,token)){
      const denied=[401,403,404].includes((error as {status?:number})?.status??0);
      this.setData({loading:false,refreshing:false,coreReady:false,hasSnapshot:!denied&&this.data.hasSnapshot,items:denied?[]:this.data.items,nextCursor:denied?null:this.data.nextCursor,error:(error as {title?:string})?.title??"暂时无法更新订单，请重试后核对最新状态。"});}}
  },
  async loadMore(){const cursor=this.data.nextCursor;if(!this.canOpen()||this.data.loadingMore||!cursor)return;
    const attempt=this.data.loadAttempt,token=this.lastToken;this.setData({loadingMore:true});
    try{const page=await managementOrders(cursor,this,{stage:this.data.stage,from:this.data.from,through:this.data.through});if(!this.current(attempt,token)||this.data.nextCursor!==cursor)return;
      const seen=new Set(this.data.items.map(item=>item.id));this.setData({items:[...this.data.items,...this.normalize(page.items).filter((item: { id: string })=>!seen.has(item.id))],nextCursor:page.nextCursor});
    }catch(error){if(this.current(attempt,token)){
      if([401,403,404].includes((error as {status?:number})?.status??0))this.setData({hasSnapshot:false,items:[],nextCursor:null,coreReady:false,error:"暂时无法确认订单访问权限，请重试。"});
      else wx.showToast({title:"更多订单暂时无法加载",icon:"none"});}}
    finally{if(this.current(attempt,token))this.setData({loadingMore:false});}
  },
  selectStage(event:WechatMiniprogram.TouchEvent){const stage=sectionTabValue(event,'stage');if(this.data.navigating||!this.data.stages.some(x=>x.id===stage)||stage===this.data.stage)return;this.setData({stage,hasSnapshot:false,items:[],nextCursor:null,totalCount:null});void this.load();},
  selectDate(event:WechatMiniprogram.CustomEvent<{value:string}>){const field=String(event.currentTarget.dataset.field);if(this.data.navigating||!['from','through'].includes(field))return;const from=field==='from'?event.detail.value:this.data.from,through=field==='through'?event.detail.value:this.data.through;if(from&&through&&from>through){wx.showToast({title:'结束日期不能早于开始日期',icon:'none'});return;}this.setData({from,through,hasSnapshot:false,items:[],nextCursor:null,totalCount:null});void this.load();},
  clearDates(){if(this.data.navigating||!this.data.from&&!this.data.through)return;this.setData({from:'',through:'',hasSnapshot:false,items:[],nextCursor:null,totalCount:null});void this.load();},
  openFulfillment(){if(!this.data.canRewards||!this.canOpen())return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-fulfillment/index",fail:()=>this.setData({navigating:false})});},
  openRewards(){if(!this.data.canRewards||!this.canOpen())return;this.setData({navigating:true});wx.navigateTo({url:'/pages/management-rewards/index?tab=fulfill',fail:()=>this.setData({navigating:false})});},
  open(event:WechatMiniprogram.TouchEvent){if(!this.canOpen())return;const id=String(event.currentTarget.dataset.id??"");if(!this.data.items.some(item=>item.id===id))return;
    this.setData({navigating:true});wx.navigateTo({url:`/pages/management-order-detail/index?id=${encodeURIComponent(id)}`,fail:()=>this.setData({navigating:false})});},
  back(){if(!this.data.visible||this.data.navigating)return;this.setData({navigating:true});wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management/index"})});}
});
