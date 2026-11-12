import { authorityProjection, hasCapability, type Capability } from "../../services/authority";
import { centsToYuan, managementCatalog, type CatalogProduct } from "../../services/commerce";
import { currentChromeStyle } from "../../services/layout";
import { nativeCatalogImage } from "../../services/catalog";
import { commerceContextRevision } from "../../services/commerce-command-store";

const qualificationLabels: Record<string,string> = { pending:"待核验", eligible:"资质已确认", blocked:"已阻止" };
const publicationLabels: Record<string,string> = { draft:"草稿", published:"已上架", unpublished:"已下架" };

Page({
  authorityToken:"", authorityContext:-1,
  data:{chromeStyle:currentChromeStyle(),items:[] as Array<CatalogProduct & {priceYuan:string;qualificationLabel:string;publicationLabel:string}>,nextCursor:null as string|null,loading:true,loadingMore:false,navigating:false,canCreate:false,error:"",pageAlive:true,epoch:0},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  async onShow(){this.data.pageAlive=true;this.setData({navigating:false});await this.load();},
  onHide(){this.data.pageAlive=false;this.data.epoch+=1;this.authorityToken="";this.setData({canCreate:false,items:[],nextCursor:null});},
  onUnload(){this.onHide();},
  current(epoch:number,token:string){return this.data.pageAlive&&this.data.epoch===epoch&&
    token===getApp<IAppOption>().globalData.sessionToken&&this.authorityContext===commerceContextRevision();},
  canOpen(){if(this.authorityToken&&(this.authorityToken!==getApp<IAppOption>().globalData.sessionToken||this.authorityContext!==commerceContextRevision())){
    this.authorityToken="";this.setData({canCreate:false,items:[],nextCursor:null,error:"身份已变化，请重新核验商品访问权限。"});return false;}
    return this.current(this.data.epoch,this.authorityToken)&&!!this.authorityToken&&!this.data.loading&&!this.data.navigating&&!this.data.error;},
  normalize(items:CatalogProduct[]){return items.map((item)=>({...item,image:nativeCatalogImage(item.image),priceYuan:item.price===null?"未定价":`¥${centsToYuan(item.price)}`,qualificationLabel:qualificationLabels[item.qualificationStatus]??item.qualificationStatus,publicationLabel:publicationLabels[item.publicationStatus]??item.publicationStatus}));},
  async load(){const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.authorityToken="";
    this.authorityContext=commerceContextRevision();
    this.setData({loading:true,loadingMore:false,canCreate:false,error:"",items:[],nextCursor:null});
    const allowed=await authorityProjection().catch(()=>null);
    if(!this.current(epoch,token))return;
    if(!allowed||allowed.version!==1||!allowed.managementAvailable||!["commerce.product.manage","commerce.qualification.manage","commerce.inventory.manage"].some(capability=>hasCapability(allowed,capability as Capability))){this.setData({loading:false,error:"当前账号没有商品管理权限。"});return;}
    this.authorityToken=token;this.setData({canCreate:hasCapability(allowed,"commerce.product.manage")});
    try{const page=await managementCatalog();if(this.current(epoch,token))
      this.setData({items:this.normalize(page.items),nextCursor:page.nextCursor,loading:false});
    }catch{if(this.current(epoch,token))this.setData({loading:false,error:"商品列表暂未加载，请重试后查看最新资料。"});}},
  async loadMore(){const cursor=this.data.nextCursor;if(!this.canOpen()||this.data.loadingMore||!cursor)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({loadingMore:true});try{const page=await managementCatalog(cursor);
      if(this.current(epoch,token)&&this.data.nextCursor===cursor){
        const seen=new Set(this.data.items.map(item=>item.productId));
        this.setData({items:[...this.data.items,...this.normalize(page.items).filter(item=>{if(seen.has(item.productId))return false;seen.add(item.productId);return true;})],nextCursor:page.nextCursor});}
    }catch(error){if(this.current(epoch,token)){
      if([401,403,404].includes((error as {status?:number})?.status??0)){this.authorityToken="";this.setData({canCreate:false,items:[],nextCursor:null,error:"商品访问权限已变化，请重新核验。"});}
      else wx.showToast({title:"更多商品暂时无法加载",icon:"none"});}}
    finally{if(this.current(epoch,token))this.setData({loadingMore:false});}},
  create(){if(!this.canOpen())return;
    if(!this.data.canCreate||!this.authorityToken||this.authorityToken!==getApp<IAppOption>().globalData.sessionToken){
      this.setData({canCreate:false});wx.showToast({title:"当前账号没有新建商品权限",icon:"none"});return;}
    const epoch=this.data.epoch,token=this.authorityToken;
    this.setData({navigating:true});wx.navigateTo({url:"/pages/management-product/index",fail:()=>{if(this.current(epoch,token))this.setData({navigating:false});}});},
  open(event:WechatMiniprogram.TouchEvent){if(!this.canOpen())return;const id=String(event.currentTarget.dataset.id??"");if(!this.data.items.some(item=>item.productId===id))return;
    const epoch=this.data.epoch,token=this.authorityToken;this.setData({navigating:true});wx.navigateTo({url:`/pages/management-product/index?id=${encodeURIComponent(id)}`,fail:()=>{if(this.current(epoch,token))this.setData({navigating:false});}});},
  back(){wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management/index"})});}
});
