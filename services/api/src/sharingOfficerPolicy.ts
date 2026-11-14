import {DomainError} from '@cisme/domain';

export const SHARING_STATES=['pending','rejected','active','suspended','terminated'] as const;
export function sharingFail(code:string,message:string,status=409):never{throw new DomainError(code,message,status);}
export function sharingText(value:unknown,label:string,min=1,max=300){
 if(typeof value!=='string'||value.trim().length<min||value.trim().length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
  sharingFail('SHARING_INPUT_INVALID',`请填写${label}`,422);
 return value.trim();
}
export function sharingId(value:unknown){const id=sharingText(value,'有效编号',36,36);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))sharingFail('SHARING_ID_INVALID','编号无效',422);return id;}
export function sharingInt(value:unknown,label:string,min=0,max=9_900_000_000){if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)sharingFail('SHARING_INPUT_INVALID',`${label}无效`,422);return Number(value);}
export function sharingPolicyInput(input:Record<string,unknown>){
 if(typeof input.enabled!=='boolean'||input.selfPurchase!==false||!['first','last'].includes(String(input.priority))||!Object.hasOwn(input,'attributionDays'))
  sharingFail('SHARING_RULES_INCOMPLETE','请完整确认客户归属规则',422);
 return {enabled:input.enabled,attributionDays:input.attributionDays===null?null:sharingInt(input.attributionDays,'归属天数',1,36500),
  priority:input.priority as 'first'|'last',selfPurchase:input.selfPurchase,basisPoints:sharingInt(input.basisPoints,'佣金比例',0,10000),
  releaseDays:sharingInt(input.releaseDays,'收货后等待天数',0,3650),reason:sharingText(input.reason,'调整依据',2)};
}
export function sharingMonth(value:unknown,now=new Date()){
 const period=sharingText(value,'结算月份',7,7);
 if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(period))sharingFail('SHARING_MONTH_INVALID','请选择有效月份',422);
 const [year,month]=period.split('-').map(Number);
 const cutoff=new Date(Date.UTC(year!,month!,1)-8*3600_000);
 if(cutoff>now)sharingFail('SHARING_MONTH_NOT_ENDED','该月份尚未结束',422);
 return {period,cutoff};
}
export function sharingTax(gross:number,tax:unknown,note:unknown){return {taxCents:sharingInt(tax,'扣税金额',0,gross),taxNote:sharingText(note,'财务税务处理依据',1,500)};}
export function csvCell(value:unknown){const cell=String(value??'');return '"'+(/^[\s]*[=+\-@\t\r]/.test(cell)?"'"+cell:cell).replaceAll('"','""')+'"';}
