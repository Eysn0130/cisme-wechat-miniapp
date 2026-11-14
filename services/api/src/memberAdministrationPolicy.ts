import {createHash,createHmac} from 'node:crypto';
import {DomainError} from '@cisme/domain';
import type {AppConfig} from '@cisme/config';
import {cursorTimestamp} from './keysetPage.js';
export const userViews=['profile','commerce','activity','assets','sharing'] as const;
export const userSections=['profile','addresses','care','points','vouchers','orders','aftersales','sharing','sharing-orders','settlements','posts','comments','support','privacy','logs'] as const;
export type UserView=typeof userViews[number];
export type UserSection=typeof userSections[number];
export type UserScope={profile:true;contact:boolean;care:boolean;orders:boolean;points:boolean;rewards:boolean;sharing:boolean;commission:boolean;finance:boolean;support:boolean;privacy:boolean;moderate:boolean;manage:boolean;export:boolean};
export type UserQuery={q:string;view:UserView;account:string;onboarding:string;officer:string;sort:string;direction:'asc'|'desc';limit:number;cursor?:string};
export function userFail(code:string,title:string,status=422):never{throw new DomainError(code,title,status);}
export function userId(value:unknown){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))userFail('MEMBER_ID_INVALID','会员编号无效');return value.toLowerCase();}
export function userInput(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))userFail('USER_INPUT_INVALID','请核对提交内容');return value as Record<string,unknown>;}
export function userQuery(input:Record<string,unknown>={}):UserQuery{
 input=userInput(input,['q','view','account','onboarding','officer','sort','direction','limit','cursor']);
 if(input.q!==undefined&&typeof input.q!=='string'||input.cursor!==undefined&&typeof input.cursor!=='string'||input.limit!==undefined&&!['string','number'].includes(typeof input.limit))userFail('USER_FILTER_INVALID','筛选条件无效');
 const one=(key:string,values:readonly string[],fallback:string)=>{const v=input[key]??fallback;if(typeof v!=='string'||!values.includes(v))userFail('USER_FILTER_INVALID','筛选条件无效');return v;};
 const q=typeof input.q==='string'?input.q.trim():'';if(q.length>80||/[\u0000-\u001f\u007f]/.test(q))userFail('USER_SEARCH_INVALID','请缩短搜索内容');
 const n=input.limit==null||input.limit===''?30:Number(input.limit);if(!Number.isSafeInteger(n)||n<1||n>50)userFail('PAGE_LIMIT_INVALID','每页数量须为1至50');
 return {q,view:one('view',userViews,'profile') as UserView,account:one('account',['all','active','blocked'],'all'),onboarding:one('onboarding',['all','complete','incomplete'],'all'),officer:one('officer',['all','none','pending','active','rejected','suspended','terminated'],'all'),sort:one('sort',['registered','number','paid','points','care','recent'],'registered'),direction:one('direction',['asc','desc'],'desc') as 'asc'|'desc',limit:n,...(typeof input.cursor==='string'&&input.cursor?{cursor:input.cursor}:{})};
}
export function userQueryAccess(q:UserQuery,s:UserScope){
 if((q.view==='commerce'||q.sort==='paid')&&!s.orders)userFail('CAPABILITY_REQUIRED','当前账号没有订单查看权限',403);
 if((q.view==='activity'||q.sort==='care'||q.sort==='recent')&&!s.care)userFail('CAPABILITY_REQUIRED','当前账号没有护理服务资料权限',403);
 if((q.view==='assets'||q.sort==='points')&&!s.points)userFail('CAPABILITY_REQUIRED','当前账号没有积分查看权限',403);
 if((q.view==='sharing'||q.officer!=='all')&&!s.sharing)userFail('CAPABILITY_REQUIRED','当前账号没有推广资料权限',403);
}
export const userPhoneQuery=(q:unknown)=>typeof q==='string'&&/^(?:1\d{10}|\+[1-9]\d{4,18})$/.test(q.trim());
export function userPhoneHash(q:string,config:AppConfig,scope:UserScope){
 const phone=/^1\d{10}$/.test(q)?'+86'+q:/^\+[1-9]\d{4,18}$/.test(q)?q:null;
 if(!phone)return null;if(!scope.contact)userFail('CAPABILITY_REQUIRED','当前账号没有手机号查找权限',403);
 const key=config.contacts.hashKey;if(!key||!/^[0-9a-f]{64}$/i.test(key))userFail('CONTACT_SEARCH_UNAVAILABLE','手机号查找暂不可用',503);
 return createHmac('sha256',Buffer.from(key,'hex')).update('phone:'+phone).digest('hex');
}
export function userCursorScope(actor:string,query:UserQuery,scope:UserScope){const{cursor:_,limit:__,...q}=query;return createHash('sha256').update(JSON.stringify([actor,q,scope])).digest('hex').slice(0,32);}
export function userCursor(input:string|undefined,scope:string,sort:string):{value:string;id:string}|null{
 if(!input)return null;try{if(input.length>800||!/^[\w-]+$/.test(input))throw Error();const r=JSON.parse(Buffer.from(input,'base64url').toString('utf8'));if(r.v!==1||r.scope!==scope||typeof r.value!=='string')throw Error();userId(r.id);
 if(['registered','recent'].includes(sort)?!cursorTimestamp(r.value):!/^\d{1,20}$/.test(r.value))throw Error();return {value:r.value,id:r.id};
 }catch{userFail('PAGE_CURSOR_INVALID','列表已变化，请重新加载');}
}
export function userNext(scope:string,value:string,id:string){return Buffer.from(JSON.stringify({v:1,scope,value,id})).toString('base64url');}
export function userNumber(value:unknown){const n=Number(value??0);if(!Number.isSafeInteger(n))userFail('USER_AGGREGATE_INVALID','统计数据需核对',503);return n;}
export function userReason(value:unknown){if(typeof value!=='string'||value.trim().length<2||value.trim().length>200||/[\u0000-\u001f\u007f]/.test(value))userFail('USER_PURPOSE_REQUIRED','请填写2至200字的查看用途');return value.trim();}
