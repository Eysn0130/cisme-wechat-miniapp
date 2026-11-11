import {careProducts,careRewardLabel,type CareUsageRecord} from './care-usage';

const rewardNames:Record<string,string>={daily:'首次有效护理记录',note:'有效护理感受',streak7:'连续 7 天护理奖励',streak30:'连续 30 天护理奖励'};
export function usageDayLabel(day:string){return `${Number(day.slice(5,7))} 月 ${Number(day.slice(8,10))} 日`;}
export function usageRecordView(row:CareUsageRecord,serverDay:string){
  const time=(value:string)=>new Date(Date.parse(value)+8*3600000).toISOString().slice(11,16);
  return {...row,productLabel:careProducts.filter(p=>row.products.includes(p.id)).map(p=>p.label).join(' · '),
    productNames:careProducts.filter(p=>row.products.includes(p.id)).map(p=>p.label),
    dateLabel:usageDayLabel(row.careDay),
    savedTime:time(row.completedAt),updatedTime:time(row.updatedAt),canAdjust:row.careDay===serverDay,
    rewardLabel:careRewardLabel(row.rewards),rewardItems:(row.rewards?.components??[]).map(c=>({...c,label:rewardNames[c.code]??'护理奖励'}))};
}
export type CareUsageRow=ReturnType<typeof usageRecordView>;
export function usageWeekFrom(serverDay:string){return new Date(Date.parse(serverDay+'T00:00:00Z')-6*86400000).toISOString().slice(0,10);}
export function usageWeekDays(serverDay:string,recordedDays:readonly string[],selectedDay:string){
  const start=Date.parse(usageWeekFrom(serverDay)+'T00:00:00Z'),recorded=new Set(recordedDays);
  return Array.from({length:7},(_,index)=>{const date=new Date(start+index*86400000),day=date.toISOString().slice(0,10);
    return {day,label:['日','一','二','三','四','五','六'][date.getUTCDay()],number:String(date.getUTCDate()),
      recorded:recorded.has(day),selected:day===selectedDay,isToday:day===serverDay};});
}
