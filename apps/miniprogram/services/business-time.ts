import { shanghaiShipmentInstant } from './shipment-time';
/** China business civil time must not depend on the operator's device timezone. */
export const beijingCivilInstant=shanghaiShipmentInstant;
export function beijingDateParts(value:string):{date:string;time:string}{
  const instant=Date.parse(value);
  if(!Number.isFinite(instant))return {date:'',time:''};
  const civil=new Date(instant+8*60*60*1000).toISOString();
  return {date:civil.slice(0,10),time:civil.slice(11,16)};
}
export function beijingDateLabel(value:string|null):string{
  const date=value?beijingDateParts(value).date:'';
  return date?date.replace(/-/g,'/'):'未设置';
}
