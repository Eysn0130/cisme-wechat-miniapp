import {request} from './api';
import {commerceContextRevision,readCommerceCommands,putCommerceCommand,forgetCommerceCommand,normalizeCommandPayload,type StoredCommerceCommand,type CommandPayload} from './commerce-command-store';
import {clientOperationKey} from './orders';
import type {PointsRedemption} from './points';
function environment(){const d=getApp<IAppOption>().globalData;return JSON.stringify([d.apiBaseUrl.replace(/\/$/,''),d.cloudFunction??null]);}
export function pendingPointsGift(ownerId:string){return readCommerceCommands().find(c=>c.ownerId===ownerId&&c.environment===environment()&&c.kind==='points-gift')??null;}
export function preparePointsGift(ownerId:string,payload:CommandPayload){
 if(pendingPointsGift(ownerId))throw {title:'请先核对上一笔兑换，再开始新的兑换。'};
 const command:StoredCommerceCommand={version:1,ownerId,environment:environment(),kind:'points-gift',objectId:null,key:clientOperationKey('points-gift'),
  payload:normalizeCommandPayload('points-gift',payload),createdAt:Date.now(),dispatched:false};
 putCommerceCommand(command);return command;
}
async function check(command:StoredCommerceCommand){
 const token=getApp<IAppOption>().globalData.sessionToken,revision=commerceContextRevision(),target=environment();
 const current=()=>Boolean(token)&&token===getApp<IAppOption>().globalData.sessionToken&&revision===commerceContextRevision()&&target===environment()&&command.environment===target;
 if(!current())throw {title:'登录或环境已变化，请重新核对兑换。'};
 const profile=await request<{id:string}>({path:'/v1/me/profile'});
 if(!current()||profile.id!==command.ownerId)throw {title:'请回到原账号核对这笔兑换。'};
 return current;
}
export async function inspectPointsGift(command:StoredCommerceCommand,abandon=false){
 const current=await check(command);const value=await request<{status:'found'|'not_found'|'abandoned';record?:PointsRedemption}>({path:`/v1/me/points/commands/${encodeURIComponent(command.key)}${abandon?'/abandon':''}`,
  ...(abandon?{method:'POST' as const,data:{}}:{}),cacheTags:['points','orders']});
 if(!current())throw {title:'登录已变化，请回到原账号核对兑换。'};
 if(!value||!['found','not_found','abandoned'].includes(value.status)||value.status==='found'&&!value.record?.id)throw {title:'暂时无法确认兑换结果，请重试核对。'};
 if(value.status!=='not_found')forgetCommerceCommand(command);return value;
}
export async function dispatchPointsGift(command:StoredCommerceCommand){
 const current=await check(command);if(!command.payload)throw {title:'上次填写内容已清除，请核对原兑换，或取消尚未受理的原操作。'};
 const revision=commerceContextRevision(),token=getApp<IAppOption>().globalData.sessionToken;
 putCommerceCommand({...command,dispatched:true});
 try{
  const result=await request<PointsRedemption>({path:'/v1/me/points/redemptions',method:'POST',idempotencyKey:command.key,data:command.payload,cacheTags:['points','orders','catalog']});
  if(!result?.id||result.skuId!==command.payload.skuId||result.quantity!==command.payload.quantity||!Number.isSafeInteger(result.pointsCost)||result.pointsCost<1)throw {title:'兑换结果尚未确认，请核对原操作。'};
  if(!current())throw {title:'登录已变化，请回到原账号核对兑换。'};
  forgetCommerceCommand(command);
  if(revision!==commerceContextRevision()||token!==getApp<IAppOption>().globalData.sessionToken)throw {title:'登录已变化，请回到原账号查看兑换。'};
  return result;
 }catch(error){const e=error as {status?:number};if(current()&&e.status&&e.status>=400&&e.status<500&&![408,429].includes(e.status))forgetCommerceCommand(command);throw error;}
}
