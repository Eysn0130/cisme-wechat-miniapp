import {DomainError} from '@cisme/domain';
export function managementDates(input:{from?:unknown;through?:unknown}){
 const day=(v:unknown)=>{if(v==null||v==='')return null;if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)throw new DomainError('MANAGEMENT_DATE_INVALID','请选择有效日期',422);return v;};
 const from=day(input.from),through=day(input.through);if(from&&through&&from>through)throw new DomainError('MANAGEMENT_DATE_INVALID','结束日期不能早于开始日期',422);return {from,through};
}
