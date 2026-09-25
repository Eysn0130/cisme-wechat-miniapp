import { DomainError } from '@cisme/domain';
import type { AddressPayload } from './deliveryAddress.js';

/** Owner-approved launch rules, 2026-09-22 task reply. This is not a grant to
 * enable sales or a substitute for verified carrier coverage/return contacts. */
export const LAUNCH_FULFILLMENT_POLICY_VERSION='cisme-launch-fulfillment-20260922-v1';
const mainlandNames=['北京','天津','河北','山西','内蒙古','辽宁','吉林','黑龙江','上海','江苏','浙江','安徽',
  '福建','江西','山东','河南','湖北','湖南','广东','广西','海南','重庆','四川','贵州','云南','西藏','陕西','甘肃','青海','宁夏','新疆'];
const mainlandCodes=['11','12','13','14','15','21','22','23','31','32','33','34','35','36','37','41','42','43','44','45','46','50','51','52','53','54','61','62','63','64','65'];
export function launchFulfillmentPolicy(address:Pick<AddressPayload,'province'|'provinceCode'|'nationalCode'>){
  const index=mainlandNames.findIndex(name=>address.province.startsWith(name));
  const codes=[address.provinceCode,address.nationalCode].filter(Boolean) as string[];
  if(index<0||codes.some(code=>!/^\d{6}$/.test(code)||code.slice(0,2)!==mainlandCodes[index]))
    throw new DomainError('DELIVERY_REGION_UNSUPPORTED','首发仅配送中国大陆快递可达地区，港澳台暂不配送',422);
  return {
    version:LAUNCH_FULFILLMENT_POLICY_VERSION,region:'CN_MAINLAND_COURIER_REACHABLE',shippingCents:0,
    dispatchWithinHoursAfterPaid:72,preorder:false,disclosedExceptions:[] as string[],
    dispatchPromise:'普通现货支付成功后72小时内发货；本订单未另行约定预售或延迟发货。',
    shippingPromise:'中国大陆快递可达地区全场包邮，港澳台暂不配送。',
    returnsPromise:'依法支持七日无理由退货；化妆品按必要的一次性密封是否完整及商品是否完好判断，不按拆封一律拒退。',
    returnFreight:{noReason:'consumer',qualityWrongMissingTransport:'merchant_reasonable_cost'},
    customerService:'MINIPROGRAM_HUMAN_SUPPORT',carrierReachabilityVerified:false
  };
}
