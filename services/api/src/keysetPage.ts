import { createHash } from "node:crypto";
import { DomainError } from "@cisme/domain";

const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type PageCursor={at:string;id:string};
/** Accept both existing producers: ISO UTC and PostgreSQL timestamptz::text.
 * Check calendar/offset fields without converting the SQL boundary through a
 * millisecond Date. The original timestamp and microseconds are returned intact. */
function cursorTimestamp(value:unknown):value is string{
  if(typeof value!=="string"||value.length>50)return false;
  const match=/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|([+-])(\d{2})(?::(\d{2})(?::(\d{2}))?)?)$/.exec(value);
  if(!match||value.startsWith("0000-"))return false;
  if(match[4]&&(Number(match[5])>15||Number(match[6]??0)>59||Number(match[7]??0)>59))return false;
  // Validate local calendar fields as UTC solely to reject normalization such
  // as February 30 or 24:00. Do not change the actual stored offset or precision.
  const calendar=`${match[1]}T${match[2]}`;
  const milliseconds=Date.parse(`${calendar}Z`);
  return Number.isFinite(milliseconds)&&new Date(milliseconds).toISOString().slice(0,19)===calendar;
}
export function pageLimit(value:unknown,fallback=30,max=50):number{
  if(value==null||value==="")return fallback;
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<1||number>max)throw new DomainError("PAGE_LIMIT_INVALID",`每页数量须在 1–${max} 之间`,422);
  return number;
}
export function pageScope(parts:unknown[]):string{
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0,24);
}
export function readPageCursor(value:unknown,scope:string):PageCursor|null{
  if(value==null||value==="")return null;
  if(typeof value!=="string"||value.length>600||!/^[A-Za-z0-9_-]+$/.test(value))
    throw new DomainError("PAGE_CURSOR_INVALID","列表位置已失效，请从第一页重新加载",422);
  try{
    const decoded=JSON.parse(Buffer.from(value,"base64url").toString("utf8")) as {v?:unknown;s?:unknown;t?:unknown;i?:unknown};
    if(decoded.v!==1||decoded.s!==scope||!cursorTimestamp(decoded.t)||
      typeof decoded.i!=="string"||!idPattern.test(decoded.i))throw new Error("invalid");
    return {at:decoded.t,id:decoded.i};
  }catch{throw new DomainError("PAGE_CURSOR_INVALID","列表位置已失效，请从第一页重新加载",422);}
}
export function finishPage<T extends {cursorAt:string;id:string}>(rows:T[],limit:number,scope:string){
  const hasMore=rows.length>limit,items=rows.slice(0,limit),last=items.at(-1);
  const nextCursor=hasMore&&last?Buffer.from(JSON.stringify({v:1,s:scope,t:last.cursorAt,i:last.id})).toString("base64url"):null;
  return {items,loadedCount:items.length,hasMore,nextCursor};
}
