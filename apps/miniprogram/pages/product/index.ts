import {incomingOfficerShare} from '../../services/officer-attribution';
import{sectionTabValue}from'../../services/section-tabs';
import { requireGuestCommunityAccess } from "../../services/api";
import { cancelPageReads } from "../../services/page-requests";
import {retainReadPresentation} from "../../services/read-presentation";
import {nativeCatalogImage} from "../../services/catalog";
import {catalogDetail} from "../../services/commerce";
import {approvedCommerceContent,commercePresentation,type ProductMedia} from "../../services/commerce-content";
import {requireMemberAccess} from "../../services/api";
import {currentChromeStyle} from "../../services/layout";
import {formatCnyCents} from "../../services/presentation";
import {prepareShareDetails,registerIncomingShare} from "../../services/share";

function validProductCode(value:string){return /^[a-z0-9][a-z0-9-]{2,63}$/.test(value);}
const anchors=["goods","details","reviews"];
Page({
  data:{qrScene:"",incomingResolving:false,requestedCouponId:'',chromeStyle:currentChromeStyle(),id:"",item:null as any,catalog:null as any,gallery:[] as ProductMedia[],galleryIndex:0,details:[] as ProductMedia[],anchor:"goods",selectedSku:null as any,quantity:1,selected:false,sheetOpen:false,draftSku:null as any,draftQuantity:1,shareId:"",officerShareId:"",loading:true,navigating:false,loadAttempt: 0,pageAlive:true,leaving:false,errorKind:"none" as "none"|"selection"|"missing"|"load",errorTitle:"",error:""},
  scrollTop:0,anchorTimer:null as ReturnType<typeof setTimeout>|null,visible:false,
  onLoad(query:Record<string,string|undefined>){const id=query.id??"",requestedCouponId=/^[0-9a-f-]{36}$/i.test(query.coupon??'')?query.coupon!: '';this.setData({id,pageAlive:true,requestedCouponId});if(validProductCode(id)){void registerIncomingShare(query.share_id,"product",id);if(query.officer_share)void incomingOfficerShare(query.officer_share,id).catch(()=>{});}
  if(query.scene){let scene='';try{scene=decodeURIComponent(query.scene);}catch{}if(/^[0-9a-f]{32}$/.test(scene)){this.setData({qrScene:scene});void this.resolveQr();}}wx.hideShareMenu();},
  async resolveQr(){if(this.data.incomingResolving||!this.data.qrScene)return;this.setData({incomingResolving:true,loading:true,error:''});try{const code=await incomingOfficerShare(this.data.qrScene);if(!this.data.pageAlive)return;if(!code)throw Error('SHARE_UNAVAILABLE');this.setData({id:code,incomingResolving:false});if(this.visible)this.onShow();}catch{if(this.data.pageAlive)this.setData({incomingResolving:false,loading:false,error:'分享商品暂时无法打开，请重试',errorKind:'load'});}},
  onShow(){this.visible=true;if(this.data.incomingResolving)return;if(!this.data.id&&this.data.qrScene){void this.resolveQr();return;}if(!requireGuestCommunityAccess("/pages/product/index?id="+encodeURIComponent(this.data.id)))return;this.setData({pageAlive:true,leaving:false,navigating:false});void this.load();},
  onHide(){this.visible=false;this.data.loadAttempt += 1;cancelPageReads(this);this.setData({sheetOpen:false});this.clearAnchorTimer();},
  onUnload(){this.visible=false;this.data.pageAlive = false;this.data.loadAttempt += 1;cancelPageReads(this);this.clearAnchorTimer();},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});this.syncAnchor();},
  clearAnchorTimer(){if(this.anchorTimer)clearTimeout(this.anchorTimer);this.anchorTimer=null;},
  onPageScroll(event:WechatMiniprogram.Page.IPageScrollOption){this.scrollTop=event.scrollTop;if(this.anchorTimer)return;this.anchorTimer=setTimeout(()=>{this.anchorTimer=null;this.syncAnchor();},100);},
  syncAnchor(){if(!this.visible||!this.data.item)return;const q=wx.createSelectorQuery();q.select(".product-nav").boundingClientRect();for(const id of anchors)q.select(`#${id}`).boundingClientRect();q.exec(rects=>{if(!this.visible||!rects[0])return;let active="goods";for(let i=1;i<rects.length;i++)if(rects[i]&&rects[i].top<=rects[0].bottom+5)active=anchors[i-1]!;if(active!==this.data.anchor)this.setData({anchor:active});});},
  jumpAnchor(event:WechatMiniprogram.TouchEvent){const id=sectionTabValue(event,'anchor');if(!anchors.includes(id))return;const q=wx.createSelectorQuery();q.select(".product-nav").boundingClientRect();q.select(`#${id}`).boundingClientRect();q.exec(rects=>{if(!this.visible||!rects[0]||!rects[1])return;wx.pageScrollTo({scrollTop:Math.max(0,this.scrollTop+rects[1].top-rects[0].bottom),duration:0});this.setData({anchor:id});});},
  async load(){if(!this.data.id&&this.data.qrScene){await this.resolveQr();return;}
    cancelPageReads(this);
    const attempt=this.data.loadAttempt+1;wx.hideShareMenu();const preserve=retainReadPresentation(this,this.data.id);
    const previousSku=preserve?this.data.selectedSku?.id:"",previousQuantity=preserve?this.data.quantity:1;
    const materials=approvedCommerceContent(this.data.id);
    this.setData({loadAttempt:attempt,...(!preserve?{item:null,catalog:null}:{}),shareId:"",officerShareId:"",loading:true,navigating:false,errorKind:"none",errorTitle:"",error:""});
    if(!validProductCode(this.data.id)){this.setData({loading:false,errorKind:"selection",errorTitle:"先选一件商品",error:"请从商城选择商品，再查看详细资料。"});return;}
    if(materials&&!preserve)this.present(null,materials,previousSku,previousQuantity);
    try{
      const detail=await catalogDetail(this.data.id,this);
      const raw=materials&&!(detail.code===materials.code&&detail.sourceKind==="admin")?null:detail;
      if(!this.data.pageAlive || this.data.loadAttempt !== attempt)return;
      if(raw&&formatCnyCents(raw.price)===null)throw new Error("CATALOG_PRICE_INVALID");
      this.present(raw,materials,previousSku,previousQuantity);this.setData({loading:false});
      if(this.data.item){
        // Attribution links require a real server product, not just approved materials.
        if(raw){const share=await prepareShareDetails("product",this.data.id);if(this.data.pageAlive&&this.data.loadAttempt===attempt){this.setData({shareId:share?.shareId??"",officerShareId:share?.officerShareId??""});if(share?.shareId||!getApp<IAppOption>().globalData.sessionToken)wx.showShareMenu({menus:["shareAppMessage"]});}}
        else wx.showShareMenu({menus:["shareAppMessage"]});
      }
    }catch(error){
      if(!this.data.pageAlive||this.data.loadAttempt!==attempt)return;
      const problem=error as {status?:number;code?:string};const missing=problem.status===404&&problem.code==="CATALOG_PRODUCT_NOT_FOUND";
      if(materials){this.present(null,materials,previousSku,previousQuantity);this.setData({loading:false,error:"开售与库存信息暂未更新，请重试。"});}
      else this.setData({item:null,catalog:null,loading:false,errorKind:missing?"missing":"load",errorTitle:missing?"这件商品暂不可用":"商品资料暂时未同步",error:missing?"商品已下架或暂不可见，请返回商城选择。":"商品资料暂时无法加载，请检查网络后重试。"});
    }
  },
  present(raw:any,materials:ReturnType<typeof approvedCommerceContent>,previousSku:string,previousQuantity:number){
    const item=commercePresentation(raw,materials);
    if(!item){this.setData({item:null,catalog:null,errorKind:"missing",errorTitle:"这件商品暂不可用",error:"请返回商城选择商品。"});return;}
    const selectedSku=item.variants.find((s:any)=>s.id===previousSku&&s.active)??item.variants.find((s:any)=>s.active&&s.inStock)??item.variants.find((s:any)=>s.active)??null;
    const quantity=Math.max(1,Math.min(previousQuantity,99,Math.max(1,selectedSku?.availableQuantity??1)));
    const gallery=materials?.gallery??[{src:nativeCatalogImage(raw?.image),label:item.name,width:1254,height:1254}];
    this.setData({item,catalog:{items:[item]},gallery,details:materials?.details??[],selectedSku,quantity,...(!selectedSku?{selected:false}:{}),errorKind:"none"});
  },
  galleryChange(event:WechatMiniprogram.CustomEvent<{current:number}>){this.setData({galleryIndex:event.detail.current});},
  selectGallery(event:WechatMiniprogram.TouchEvent){this.setData({galleryIndex:Number(event.currentTarget.dataset.index)||0});},
  previewGallery(){const urls=this.data.gallery.map(a=>a.src);if(!urls.length)return;wx.previewImage({current:urls[this.data.galleryIndex]??urls[0]!,urls});},
  previewDetail(event:WechatMiniprogram.TouchEvent){const urls=this.data.details.map(a=>a.src);const current=String(event.currentTarget.dataset.src);wx.previewImage({current,urls});},
  imageLoaded(){this.syncAnchor();},
  openSku(){if(!this.data.item||this.data.navigating||this.data.loading)return;this.setData({sheetOpen:true,draftSku:this.data.selectedSku,draftQuantity:this.data.quantity});},
  closeSku(){this.setData({sheetOpen:false});},
  stopPropagation(){},
  selectSku(event:WechatMiniprogram.TouchEvent){if(this.data.loading||this.data.navigating)return;const sku=this.data.item?.variants.find((s:any)=>s.id===String(event.currentTarget.dataset.id));if(!sku||!sku.active)return;this.setData({draftSku:sku,draftQuantity:Math.max(1,Math.min(this.data.draftQuantity,sku.availableQuantity||1))});},
  decrease(){if(this.data.draftQuantity>1)this.setData({draftQuantity:this.data.draftQuantity-1});},
  increase(){const maximum=Math.min(99,this.data.draftSku?.availableQuantity??0);if(this.data.draftQuantity<maximum)this.setData({draftQuantity:this.data.draftQuantity+1});},
  confirmSku(){if(!this.data.draftSku?.active||!this.data.draftSku.inStock)return;this.setData({selectedSku:this.data.draftSku,quantity:this.data.draftQuantity,selected:true,sheetOpen:false});},
  buy(){if(this.data.selected)this.openCheckout();else this.openSku();},
  openCheckout(){const sku=this.data.selectedSku;if(this.data.loading||this.data.navigating||!this.data.item?.catalogBound||!this.data.item.purchaseEnabled||!sku?.purchaseEnabled)return;if(!requireMemberAccess(`/pages/product/index?id=${encodeURIComponent(this.data.id)}`))return;this.setData({navigating:true});wx.navigateTo({url:`/pages/checkout/index?product=${encodeURIComponent(this.data.id)}&sku=${encodeURIComponent(sku.id)}&quantity=${this.data.quantity}${this.data.requestedCouponId?`&coupon=${encodeURIComponent(this.data.requestedCouponId)}`:""}`,fail:()=>{this.setData({navigating:false});wx.showToast({title:"结算页暂时无法打开",icon:"none"});}});},
  openSupport(){if(this.data.navigating||!requireMemberAccess("/pages/support/index"))return;this.setData({navigating:true});wx.navigateTo({url:"/pages/support/index",fail:()=>{this.setData({navigating:false});wx.showToast({title:"客服暂时无法打开",icon:"none"});}});},
  back(){if(!this.data.pageAlive||this.data.leaving)return;if(this.data.sheetOpen){this.closeSku();return;}this.setData({leaving:true});const failed=()=>{if(this.data.pageAlive)this.setData({leaving:false});wx.showToast({title:"暂时无法返回，请重试",icon:"none"});};wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/shop/index",fail:failed})});},
  onShareAppMessage(){return {title:this.data.item?.name??"CISME 商城",path:`/pages/product/index?id=${encodeURIComponent(this.data.id)}${this.data.shareId?`&share_id=${this.data.shareId}`:""}${this.data.officerShareId?`&officer_share=${this.data.officerShareId}`:""}`};}
});
