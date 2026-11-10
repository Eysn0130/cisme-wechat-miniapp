import {describe,it,expect} from 'vitest';
import {commerceContent,commerceShopItems,commercePresentation} from '../../apps/miniprogram/services/commerce-content';
import type {CatalogProduct} from '../../apps/miniprogram/services/commerce';

const live=(patch:Partial<CatalogProduct>={}):CatalogProduct=>({
  id:commerceContent[0]!.code,code:commerceContent[0]!.code,productId:'11111111-1111-4111-8111-111111111111',name:'服务端商品',subtitle:'服务端说明',description:'服务端原文',
  image:null,sourceKind:'admin',qualificationStatus:'eligible',publicationStatus:'published',version:3,currency:'CNY',price:19800,stockOnHand:100,inStock:true,purchaseEnabled:true,sellability:'purchasable',
  variants:[{id:'sku-1',code:'AIGERONG_MOISTURE_280',label:'280mL',currency:'CNY',priceCents:19800,priceVersion:1,stockOnHand:100,availableQuantity:100,inventoryVersion:2,inStock:true,purchaseEnabled:true,active:true,version:1}],...patch
});
describe('approved commerce content and server authority',()=>{
  it('shows both supplied materials without inventing inventory or purchase availability',()=>{
    const items=commerceShopItems([]);expect(items).toHaveLength(2);
    expect(items.map(p=>p.displayPrice)).toEqual(['198','298']);
    for(const p of items){expect(p.catalogBound).toBe(false);expect(p.purchaseEnabled).toBe(false);expect(p.variants).toEqual([]);}
  });
  it('binds the exact admin product and preserves server stock and quote identifiers',()=>{
    const p=commerceShopItems([live()])[0]!;expect(p.catalogBound).toBe(true);expect(p.purchaseEnabled).toBe(true);
    expect(p.variants[0]).toMatchObject({id:'sku-1',availableQuantity:100,inventoryVersion:2,priceVersion:1});
  });
  it('does not bind a synthetic product or similar name to an approved physical product',()=>{
    expect(commerceShopItems([live({sourceKind:'synthetic_test'})])[0]!.purchaseEnabled).toBe(false);
    const items=commerceShopItems([live({id:'different-code',code:'different-code'})]);
    expect(items[0]!.catalogBound).toBe(false);expect(items[2]!.code).toBe('different-code');
  });
  it('uses newly confirmed server prices and disables depleted inventory',()=>{
    const p=commercePresentation(live({price:20100,purchaseEnabled:false,inStock:false,sellability:'out_of_stock'}),commerceContent[0])!;
    expect(p.displayPrice).toBe('201');expect(p.qualifier).toBe('当前售价');expect(p.purchaseEnabled).toBe(false);expect(p.availability).toBe('暂时缺货');
  });
  it('rejects invalid server prices rather than substituting a source-poster price',()=>{
    expect(()=>commercePresentation(live({price:null}),commerceContent[0])).toThrow('CATALOG_PRICE_INVALID');
  });
  it('retains all fourteen original images without poster crops and distinguishes the duplicate return image',()=>{
    const originals=commerceContent.flatMap(p=>p.gallery.slice(1));expect(originals).toHaveLength(14);
    expect(new Set(originals.map(p=>p.src)).size).toBe(14);
    for(const p of originals){expect(p.width).toBeGreaterThan(0);expect(p.height).toBeGreaterThan(0);}
    expect(originals.find(p=>p.src.endsWith('1-5364.jpg'))?.label).toContain('另一尺寸');
  });
});
