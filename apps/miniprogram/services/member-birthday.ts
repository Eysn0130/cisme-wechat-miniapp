export function validBirthdayMonthDay(value:unknown):value is string {
  if(typeof value!=='string'||!/^\d{2}-\d{2}$/.test(value))return false;
  const date=new Date('2000-'+value+'T00:00:00Z');
  return Number.isFinite(+date)&&date.toISOString().slice(5,10)===value;
}
export function birthdayPicker(value?:string|null) {
  const month=validBirthdayMonthDay(value)?Number(value.slice(0,2)):1;
  const day=validBirthdayMonthDay(value)?Number(value.slice(3)):1;
  return {birthday:validBirthdayMonthDay(value)?value:'',birthdayLabel:validBirthdayMonthDay(value)?`${month}月${day}日`:'',birthdayIndex:[month-1,day-1],
    birthdayRanges:[Array.from({length:12},(_,i)=>`${i+1}月`),Array.from({length:new Date(2000,month,0).getDate()},(_,i)=>`${i+1}日`)]};
}
export function birthdayMonthColumn(ranges:string[][],index:number[],event:{column:number;value:number}) {
  if(event.column!==0)return null;
  const month=Math.max(1,Math.min(12,event.value+1)),days=new Date(2000,month,0).getDate();
  return {birthdayRanges:[ranges[0]!,Array.from({length:days},(_,i)=>`${i+1}日`)],birthdayIndex:[month-1,Math.min(index[1]??0,days-1)]};
}
export function selectedBirthday(index:number[]) {
  const value=`${String((index[0]??0)+1).padStart(2,'0')}-${String((index[1]??0)+1).padStart(2,'0')}`;
  return validBirthdayMonthDay(value)?birthdayPicker(value):null;
}
