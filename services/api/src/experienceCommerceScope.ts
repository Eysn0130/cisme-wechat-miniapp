import type {AppConfig} from '@cisme/config';

/** A distinct owner-approved real-commerce scope, bound to the isolated
 * experience database and its callback origin. Never inferred from credentials. */
export function ownerExperienceCommerceScope(config:AppConfig,grant:Record<string,unknown>):boolean{
  if(config.env!=='staging'||grant.dataScope!=='owner-authorized-experience-commerce'||grant.databaseName!=='cisme_trial')return false;
  try{if(decodeURIComponent(new URL(config.databaseUrl).pathname.slice(1))!=='cisme_trial')return false;}catch{return false;}
  const profile=config.commerce.formalProtocol;
  return Boolean(profile
    &&profile.paymentNotifyUrl==='https://staging-api.cisme.cn/v1/payments/wechat/callback'
    &&profile.refundNotifyUrl==='https://staging-api.cisme.cn/v1/payments/wechat/refund-callback');
}
