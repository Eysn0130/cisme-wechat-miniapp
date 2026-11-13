export interface SectionTab {id:string;label:string;disabled:boolean;selected:boolean;domId:string}
/** Normalize existing page models without copying permissions into the component. */
export function sectionTabs(items:unknown[],value:string,itemKey='id'):SectionTab[]{
 const seen=new Set<string>();return items.flatMap((raw,index)=>{if(!raw||typeof raw!=='object')return[];const item=raw as Record<string,unknown>,id=item[itemKey];
  if(item.hidden===true||typeof id!=='string'||!id||typeof item.label!=='string'||!item.label||seen.has(id))return[];
  seen.add(id);return[{id,label:item.label,disabled:item.disabled===true,selected:id===value,domId:`section-tab-${index}`}];});
}
/** Existing controller tests and callers may still send native dataset events. */
export function sectionTabValue(event:unknown,legacyKey='id'):string{
 if(!event||typeof event!=='object')return'';const e=event as {detail?:{value?:unknown};currentTarget?:{dataset?:Record<string,unknown>}};
 const value=typeof e.detail?.value==='string'?e.detail.value:e.currentTarget?.dataset?.[legacyKey];return typeof value==='string'?value:'';
}
