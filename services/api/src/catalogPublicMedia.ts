import data from './catalog-public-images.json';
import {DomainError} from '@cisme/domain';

// Generated solely from the two owner-approved public product photographs.
// No filesystem path, private member media or arbitrary remote URL is accepted.
const images=data as Record<string,{sha256:string;base64:string}>;
export function catalogPublicImage(code:string){
  const row=Object.hasOwn(images,code)?images[code]:undefined;
  if(!row)throw new DomainError('LOGISTICS_PRODUCT_IMAGE_UNAVAILABLE','商品图片暂未准备好，请使用已保存的运单查询',503);
  return {name:`${code}-${row.sha256}.jpg`,sha256:row.sha256,bytes:Buffer.from(row.base64,'base64')};
}
export function catalogPublicImageByName(name:string){
  const code=Object.keys(images).find(code=>name===`${code}-${images[code]!.sha256}.jpg`);
  if(!code)throw new DomainError('CATALOG_IMAGE_NOT_FOUND','图片不存在',404);
  return catalogPublicImage(code);
}
export function catalogPublicImageUrl(origin:string,code:string){
  if(!['https://staging-api.cisme.cn','https://api.cisme.cn'].includes(origin))throw Error('LOGISTICS_IMAGE_ORIGIN_INVALID');
  return `${origin}/v1/catalog/public-images/${catalogPublicImage(code).name}`;
}
