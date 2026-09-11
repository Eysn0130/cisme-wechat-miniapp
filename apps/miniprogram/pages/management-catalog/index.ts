import { requireCapability } from "../../services/authority";
import { centsToYuan, managementCatalog, type CatalogProduct } from "../../services/commerce";
import { currentChromeStyle } from "../../services/layout";

const qualificationLabels: Record<string,string> = { pending:"待核验", eligible:"资质已确认", blocked:"已阻止" };
const publicationLabels: Record<string,string> = { draft:"草稿", published:"已上架", unpublished:"已下架" };

Page({
  data:{chromeStyle:currentChromeStyle(),items:[] as Array<CatalogProduct & {priceYuan:string;qualificationLabel:string;publicationLabel:string}>,nextCursor:null as string|null,loading:true,loadingMore:false,navigating:false,error:"",pageAlive:true},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  async onShow(){this.data.pageAlive=true;this.setData({navigating:false});if(!await requireCapability("commerce.product.manage"))return;await this.load();},
  onUnload(){this.data.pageAlive=false;},
  normalize(items:CatalogProduct[]){return items.map((item)=>({...item,priceYuan:item.price===null?"未定价":`¥${centsToYuan(item.price)}`,qualificationLabel:qualificationLabels[item.qualificationStatus]??item.qualificationStatus,publicationLabel:publicationLabels[item.publicationStatus]??item.publicationStatus}));},
  async load(){this.setData({loading:true,error:"",items:[],nextCursor:null});try{const page=await managementCatalog();if(this.data.pageAlive)this.setData({items:this.normalize(page.items),nextCursor:page.nextCursor,loading:false});}catch{if(this.data.pageAlive)this.setData({loading:false,error:"商品管理目录暂时无法同步。旧数据不会被当作当前权威。"});}},
  async loadMore(){if(this.data.loadingMore||!this.data.nextCursor)return;this.setData({loadingMore:true});try{const page=await managementCatalog(this.data.nextCursor);if(this.data.pageAlive)this.setData({items:[...this.data.items,...this.normalize(page.items)],nextCursor:page.nextCursor});}catch{wx.showToast({title:"更多商品暂时无法加载",icon:"none"});}finally{if(this.data.pageAlive)this.setData({loadingMore:false});}},
  create(){if(this.data.navigating)return;this.setData({navigating:true});wx.navigateTo({url:"/pages/management-product/index",fail:()=>this.setData({navigating:false})});},
  open(event:WechatMiniprogram.TouchEvent){if(this.data.navigating)return;const id=String(event.currentTarget.dataset.id??"");if(!id)return;this.setData({navigating:true});wx.navigateTo({url:`/pages/management-product/index?id=${encodeURIComponent(id)}`,fail:()=>this.setData({navigating:false})});},
  back(){wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management/index"})});}
});
