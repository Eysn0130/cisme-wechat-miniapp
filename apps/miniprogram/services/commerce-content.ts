import type {CatalogProduct} from "./commerce";
import {formatCnyCents} from "./presentation";
import {nativeCatalogImage} from "./catalog";

export interface ProductMedia {src:string; label:string; width:number; height:number}
export interface CommerceContent {
  code:string; name:string; subline:string; headline:string[]; qualifier:string; sourcePrice:string;
  gift:string; variant:string; value:string; card:string; hero:string; gallery:ProductMedia[]; details:ProductMedia[];
}
const sizes:Record<string,[number,number]>={5358:[1254,1254],5359:[1122,1402],5360:[1072,1467],5361:[1122,1402],5362:[1536,1024],5363:[1122,1402],5364:[1254,836],5365:[1254,1254],5366:[934,1684],5367:[1254,1254],5368:[1254,1254],5369:[1122,1402],5370:[1254,1881],5371:[1254,1254]};
const labels:Record<string,string>={5358:"净润小紫瓶与赠品、首批预售价及活动说明",5359:"净润小紫瓶配方说明",5360:"柔光强韧护发乳成分说明",5361:"香调说明",5362:"试用与退货说明",5363:"洗护使用方法",5364:"试用与退货说明另一尺寸原图",5365:"头皮精华与赠品、预售首推低至价格及活动说明",5366:"头皮精华产品介绍",5367:"梳齿导头使用方法",5368:"精华液、梳齿与质地说明",5369:"精华液配方亮点",5370:"精华液配方与包装展示",5371:"使用答疑"};
const media=(n:number,file:string):ProductMedia=>({src:`/pages/product/assets/${n}-${file}.jpg`,label:labels[file]!,width:sizes[file]![0],height:sizes[file]![1]});
const content=(n:number,fields:Omit<CommerceContent,"card"|"hero"|"gallery"|"details">,gallery:string[],details:string[]):CommerceContent=>({...fields,
  card:`/assets/commerce/product${n}-glass-v4b.jpg`,hero:`/assets/commerce/product${n}-hero-v2.jpg`,
  gallery:[{src:`/pages/product/assets/product${n}-clean-v2.jpg`,label:`${fields.name}与随赠物精修展示图`,width:1448,height:1086},...gallery.map(f=>media(n,f))],details:details.map(f=>media(n,f))});

/** Owner-approved product materials, not inventory, prices, qualification or a publication record. */
export const commerceContent:readonly CommerceContent[]=[
  content(1,{code:"aigerong-moisture-shampoo-280",name:"净润小紫瓶 280mL",subline:"买 280 mL，享 620 mL",headline:["发根要蓬，","头皮要润"],qualifier:"首批预售价",sourcePrice:"198",gift:"赠 正装护发素",variant:"净润小紫瓶 280mL",value:""},["5358","5359","5360","5361","5363","5362","5364"],["5359","5360","5361","5363","5362"]),
  content(2,{code:"aigerong-scalp-repair-essence-100",name:"头皮紧致修护精华液",subline:"买正装头皮精华，赠洗护双正装",headline:["头皮紧实，","发根立得住"],qualifier:"售价",sourcePrice:"298",gift:"赠 洗护双正装",variant:"头皮紧致修护精华液 100ml",value:"套组价值 ¥763"},["5365","5366","5368","5369","5370","5367","5371"],["5366","5368","5369","5370","5367","5371"])
];
export function approvedCommerceContent(code:string){return commerceContent.find(item=>item.code===code);}

export function commercePresentation(live:CatalogProduct|null,materials?:CommerceContent){
  if(live&&(typeof live.price!=="number"||formatCnyCents(live.price)===null))throw Error("CATALOG_PRICE_INVALID");
  if(!live&&!materials)return null;
  // Only an exact, server-published admin code can connect a material to checkout.
  const bound=Boolean(live&&(!materials||(live.code===materials.code&&live.sourceKind==="admin")));
  return {...live,id:live?.id??materials!.code,code:live?.code??materials!.code,
    name:materials?.name??live!.name,subtitle:materials?.subline??live!.subtitle,
    image:materials?.card??nativeCatalogImage(live?.image),hero:materials?.hero??nativeCatalogImage(live?.image),
    headline:materials?.headline??[live!.name],displayPrice:live?formatCnyCents(live.price)!:materials!.sourcePrice,
    qualifier:materials&&(!live||formatCnyCents(live.price)===materials.sourcePrice)?materials.qualifier:"当前售价",materials:materials??null,catalogBound:bound,
    purchaseEnabled:Boolean(bound&&live?.purchaseEnabled),variants:live?.variants??[],
    availability:live?(live.sellability==="out_of_stock"?"暂时缺货":live.purchaseEnabled?"选择规格":"暂未开售"):"商品准备中"};
}

export function commerceShopItems(items:CatalogProduct[]){
  const featured=commerceContent.map(c=>commercePresentation(items.find(p=>p.code===c.code&&p.sourceKind==="admin")??null,c)!);
  return [...featured,...items.filter(p=>!commerceContent.some(c=>c.code===p.code)).map(p=>commercePresentation(p)!)];
}
