import {CAPABILITIES,type Capability} from '@cisme/contracts';
import {createHash} from 'node:crypto';
import type {DbClient} from './db.js';
import {transaction} from './db.js';
import type {MemberAdministration} from './memberAdministration.js';
import {userId,userInput,userFail} from './memberAdministrationPolicy.js';

const dependencies:Partial<Record<Capability,Capability[]>>={'member.care.read':['member.profile.read'],'member.contact.read':['member.profile.read'],'member.export':['member.profile.read'],'member.manage':['member.profile.read'],'member.support_view':['support.read'],'support.reply':['support.read'],'support.assign':['support.read'],'commission.rate.manage':['member.profile.read'],'commission.rate.approve':['member.profile.read']};
const groups:Array<{label:string;items:Array<{capability:Capability;label:string;requires:Capability[]}>}>=[];
for(const [label,entries]of [
 ['用户',[['member.profile.read','用户资料'],['member.care.read','护理档案'],['member.contact.read','联系资料'],['member.export','用户导出'],['member.support_view','客服用户资料'],['member.manage','会员与分享官资格']]],
 ['客服',[['support.read','查看会话'],['support.reply','回复消息'],['support.assign','分配客服']]],
 ['商城',[['commerce.product.manage','商品管理'],['commerce.qualification.manage','商品资格'],['commerce.inventory.manage','库存管理'],['commerce.order.read','订单查看'],['commerce.fulfillment.manage','发货履约']]],
 ['售后',[['commerce.aftersale.review','售后审核'],['commerce.return.receive','退货签收'],['commerce.return.inspect','退货检验']]],
 ['财务与推广',[['commerce.refund.approve','退款复核'],['commerce.money.reconcile','交易与积分核对'],['commission.read','推广佣金查看'],['commission.rate.manage','推广规则申请'],['commission.rate.approve','推广规则复核'],['commission.settlement.approve','月结财务']]],
 ['内容与隐私',[['community.moderate','社区管理'],['editorial.manage','官方内容'],['privacy.request.manage','隐私请求']]]
] as Array<[string,Array<[Capability,string]>]>)groups.push({label,items:entries.map(([capability,label])=>({capability,label,requires:dependencies[capability]??[]}))});

export const administratorCapabilityGroups=groups;

type Grant={id:string;capability:Capability;expires_at:Date|null};
const version=(target:string,environment:string,rows:Grant[])=>createHash('sha256').update(JSON.stringify([target,environment,rows.map(r=>[r.id,r.capability,r.expires_at?.toISOString()??null])])).digest('hex');
export class MemberAdministrators{
 constructor(readonly administration:MemberAdministration){}
 private async root(c:DbClient,actorId:string|undefined){const context=await this.administration.context(c,actorId);if(!context.scope.administrators)userFail('ROOT_ADMIN_REQUIRED','仅最高管理员可设置管理员',403);return context.actor;}
 private async grants(c:DbClient,target:string,lock=false){return(await c.query<Grant>(`SELECT id,capability,expires_at FROM authority_grant WHERE member_id=$1 AND environment=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY capability,id${lock?' FOR UPDATE':''}`,[target,this.administration.config.env])).rows;}
 private async target(c:DbClient,target:string){
  const real=['test','development'].includes(this.administration.config.env)?'true':"EXISTS(SELECT 1 FROM wechat_identity w WHERE w.member_id=m.id AND w.provider='wechat_miniprogram' AND w.adapter='wechat' AND w.app_id='wx4eac2d4fb11d299b')";
  const row=(await c.query(`SELECT m.id,m.status FROM member m WHERE m.id=$1 AND m.status<>'deleted' AND ${real} FOR SHARE`,[target])).rows[0];if(!row)userFail('MEMBER_NOT_FOUND','请选择已注册的微信会员',404);return row;
 }
 async read(actorId:string|undefined,targetInput:string){const target=userId(targetInput);return transaction(this.administration.pool,async c=>{
  const actor=await this.root(c,actorId);await this.target(c,target);const rows=await this.grants(c,target);
  await this.administration.audit(c,actor,target,'member.admin.roles.read');
  const rootOwner=target===this.administration.config.memberAdministrationRootId,requiredCapabilities:Capability[]=rootOwner?['member.profile.read','member.manage']:[];return {capabilities:rows.map(r=>r.capability),version:version(target,this.administration.config.env,rows),rootOwner,requiredCapabilities,groups:groups.map(g=>({...g,items:g.items.map(p=>({...p,fixed:requiredCapabilities.includes(p.capability)}))}))};
 });}
 async save(actorId:string|undefined,targetInput:string,key:string,input:Record<string,unknown>){
  const target=userId(targetInput);input=userInput(input,['capabilities','expectedVersion']);
  if(!Array.isArray(input.capabilities)||input.capabilities.length>CAPABILITIES.length||input.capabilities.some(v=>typeof v!=='string'||!CAPABILITIES.includes(v as Capability))||new Set(input.capabilities).size!==input.capabilities.length)userFail('ADMINISTRATOR_CAPABILITIES_INVALID','请核对管理员权限');
  if(typeof input.expectedVersion!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedVersion))userFail('ADMINISTRATOR_VERSION_INVALID','请重新读取管理权限');
  if(typeof key!=='string'||key.length<8||key.length>200)userFail('IDEMPOTENCY_KEY_INVALID','操作编号无效');
  const desired=[...input.capabilities as Capability[]].sort();if(desired.some(cap=>(dependencies[cap]??[]).some(required=>!desired.includes(required))))userFail('ADMINISTRATOR_DEPENDENCY_REQUIRED','请补齐所选职责需要的基础权限');
  const digest=createHash('sha256').update(JSON.stringify([target,input.expectedVersion,desired])).digest('hex');
  return transaction(this.administration.pool,async c=>{
   const rootTarget=target===this.administration.config.memberAdministrationRootId;if(rootTarget&&actorId===target)await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['member-admin-target:'+target]);
   const actor=await this.root(c,actorId);if(rootTarget&&(!desired.includes('member.profile.read')||!desired.includes('member.manage')))userFail('ROOT_ADMIN_PROTECTED','最高管理员身份及基础权限不可移除',403);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['member-admin-command:'+actor+':'+key]);
   const prior=(await c.query("SELECT request_hash,response_body FROM idempotency_operation WHERE principal_id=$1 AND operation='member.administrator.permissions' AND idempotency_key=$2",['member:'+actor,key])).rows[0];
   if(prior){if(prior.request_hash!==digest)userFail('IDEMPOTENCY_CONFLICT','同一操作编号不能用于不同权限',409);return prior.response_body;}
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['member-admin-target:'+target]);
   const member=await this.target(c,target);if(desired.length&&member.status!=='active')userFail('MEMBER_NOT_ACTIVE','停用账号不能新增管理权限',409);
   const rows=await this.grants(c,target,true);if(version(target,this.administration.config.env,rows)!==input.expectedVersion)userFail('ADMINISTRATOR_CHANGED','管理权限已更新，请重新核对',409);
   const reason='最高管理员调整管理权限',principal='member:'+actor;
   await c.query(`UPDATE authority_grant SET revoked_at=clock_timestamp(),revoked_by=$3,revoke_reason=$4 WHERE member_id=$1 AND environment=$2 AND revoked_at IS NULL AND (NOT(capability=ANY($5::text[])) OR expires_at<=clock_timestamp())`,[target,this.administration.config.env,principal,reason,desired]);
   await c.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) SELECT $1,capability,$3,$4,$2,'root_member_console' FROM unnest($5::text[]) AS selected(capability) WHERE NOT EXISTS(SELECT 1 FROM authority_grant g WHERE g.member_id=$1 AND g.environment=$2 AND g.capability=selected.capability AND g.revoked_at IS NULL)`,[target,this.administration.config.env,principal,reason,desired]);
   const after=await this.grants(c,target),result={capabilities:after.map(r=>r.capability),version:version(target,this.administration.config.env,after)};
   await this.administration.audit(c,actor,target,'member.admin.roles.update',{before:rows.map(r=>r.capability),after:result.capabilities});
   await c.query(`INSERT INTO idempotency_operation(principal_id,operation,idempotency_key,business_key,request_hash,response_status,response_body) VALUES($1,'member.administrator.permissions',$2,$3,$4,200,$5)`,[principal,key,target+':'+key,digest,result]);return result;
  });
 }
}
