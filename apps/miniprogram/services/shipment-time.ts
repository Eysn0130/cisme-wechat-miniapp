/** Physical handoff is entered as a China business civil time, regardless of the operator's device timezone. */
export function shanghaiShipmentInstant(date:string,time:string):string|null {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))return null;
  const [year,month,day]=date.split('-').map(Number);
  const calendar=new Date(`${date}T00:00:00Z`);
  if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()+1!==month||calendar.getUTCDate()!==day)return null;
  const instant=new Date(`${date}T${time}:00+08:00`);
  return Number.isFinite(instant.getTime())?instant.toISOString():null;
}
