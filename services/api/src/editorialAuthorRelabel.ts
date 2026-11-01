import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {CANONICAL_WECHAT_MINIPROGRAM_APP_ID,type AppConfig} from '@cisme/config';
import {DomainError} from '@cisme/domain';
import type {AuthorityService} from './authority.js';
import {transaction} from './db.js';
import {validateEditorialPublication,type EditorialPublication} from './editorial.js';

export interface EditorialAuthorRelabelTarget {
  id:string;externalRef:string;expectedVersion:number;expectedContentSha256:string;expectedRowSha256:string;
}
export interface EditorialAuthorRelabelPlan {
  schemaVersion:1;environment:'staging';databaseName:'cisme_trial';appId:string;
  operatorMemberId:string;operatorPrincipalId:string;authorMemberId:string;
  oldName:string;newName:string;authorizationRef:string;targets:EditorialAuthorRelabelTarget[];
}
type ArticleRow={id:string;external_ref:string;author_member_id:string;author_display_name:string;
  title:string;excerpt:string;body:string;source_url:string|null;authorization_ref:string;
  rights_evidence:Record<string,unknown>;media:EditorialPublication['media'];content_sha256:string;
  status:string;version:number;relabel_row_sha256:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA=/^[0-9a-f]{64}$/;
const validUuid=(value:unknown):value is string=>typeof value==='string'&&UUID.test(value);
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const fail=(code:string)=>new DomainError(code,'作者更新条件已变化，请重新核对精确计划',409);
function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function exactKeys(value:unknown,names:string[]):value is Record<string,unknown>{
  return record(value)&&Object.keys(value).sort().join('\0')===names.slice().sort().join('\0');
}
function cleanText(value:unknown,min:number,max:number):value is string {
  return typeof value==='string'&&value===value.trim()&&value.length>=min&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
}
function validatePlan(config:AppConfig,input:EditorialAuthorRelabelPlan):EditorialAuthorRelabelPlan {
  let configuredDatabase:string|undefined;
  try{configuredDatabase=decodeURIComponent(new URL(config.databaseUrl).pathname.slice(1));}catch{}
  if(!exactKeys(input,['schemaVersion','environment','databaseName','appId','operatorMemberId','operatorPrincipalId','authorMemberId','oldName','newName','authorizationRef','targets'])||
    input.schemaVersion!==1||input.environment!=='staging'||input.databaseName!=='cisme_trial'||
    input.appId!==CANONICAL_WECHAT_MINIPROGRAM_APP_ID||config.env!=='staging'||configuredDatabase!=='cisme_trial'||config.wechat.appId!==input.appId)
    throw fail('EDITORIAL_RELABEL_TARGET_MISMATCH');
  if(!validUuid(input.operatorMemberId)||!validUuid(input.authorMemberId)||typeof input.operatorPrincipalId!=='string'||
    !/^wechat_miniprogram:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.operatorPrincipalId)||
    !cleanText(input.oldName,1,40)||!cleanText(input.newName,1,40)||input.oldName===input.newName||
    !cleanText(input.authorizationRef,3,200)||!/^[A-Za-z0-9][A-Za-z0-9:/._-]+$/.test(input.authorizationRef)||
    !Array.isArray(input.targets)||input.targets.length<1||input.targets.length>30)
    throw fail('EDITORIAL_RELABEL_PLAN_INVALID');
  const ids=new Set<string>(),refs=new Set<string>();
  for(const target of input.targets){
    if(!exactKeys(target,['id','externalRef','expectedVersion','expectedContentSha256','expectedRowSha256'])||!validUuid(target.id)||
      !cleanText(target.externalRef,3,200)||!Number.isSafeInteger(target.expectedVersion)||target.expectedVersion<1||target.expectedVersion>=2147483647||
      typeof target.expectedContentSha256!=='string'||!SHA.test(target.expectedContentSha256)||
      typeof target.expectedRowSha256!=='string'||!SHA.test(target.expectedRowSha256)||ids.has(target.id)||refs.has(target.externalRef))throw fail('EDITORIAL_RELABEL_PLAN_INVALID');
    ids.add(target.id);refs.add(target.externalRef);
  }
  // Own a detached plan before awaiting any connection or authority check.
  return structuredClone(input);
}
function publication(row:ArticleRow):EditorialPublication {
  return {externalRef:row.external_ref,authorMemberId:row.author_member_id,author:row.author_display_name,
    title:row.title,excerpt:row.excerpt,body:row.body,sourceUrl:row.source_url,authorizationRef:row.authorization_ref,
    rightsEvidence:row.rights_evidence,media:row.media};
}

/** Explicit, exact-ID trial maintenance. Never publishes new posts or changes
 * account identity, media, original publication time, or existing revisions. */
export async function relabelEditorialAuthors(pool:pg.Pool,config:AppConfig,authority:AuthorityService,input:EditorialAuthorRelabelPlan){
  const plan=validatePlan(config,input);
  const targets=plan.targets.slice().sort((a,b)=>a.externalRef<b.externalRef?-1:a.externalRef>b.externalRef?1:0);
  return transaction(pool,async client=>{
    if((await client.query<{name:string}>('SELECT current_database() AS name')).rows[0]?.name!==plan.databaseName)
      throw fail('EDITORIAL_RELABEL_TARGET_MISMATCH');
    const actor=await client.query(`SELECT 1 FROM member m JOIN wechat_identity w ON w.member_id=m.id
      WHERE m.id=$1 AND m.status='active' AND w.provider='wechat_miniprogram' AND w.adapter='wechat'
      AND w.app_id=$2 AND ('wechat_miniprogram:'||w.id::text)=$3 FOR SHARE OF m,w`,
      [plan.operatorMemberId,plan.appId,plan.operatorPrincipalId]);
    if(!actor.rowCount)throw fail('EDITORIAL_RELABEL_IDENTITY_REQUIRED');
    await authority.requireWithClient(client,plan.operatorMemberId,'editorial.manage');
    const author=await client.query(`SELECT 1 FROM member m JOIN wechat_identity w ON w.member_id=m.id
      WHERE m.id=$1 AND m.status='active' AND w.provider='wechat_miniprogram' AND w.adapter='wechat'
      AND w.app_id=$2 FOR SHARE OF m,w`,[plan.authorMemberId,plan.appId]);
    if(!author.rowCount)throw fail('EDITORIAL_RELABEL_IDENTITY_REQUIRED');
    for(const target of targets)await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`editorial:${target.externalRef}`]);
    const prepared=[];
    for(const target of targets){
      const row=(await client.query<ArticleRow>(`SELECT a.*,encode(digest(to_jsonb(a)::text,'sha256'),'hex') AS relabel_row_sha256
        FROM editorial_article a WHERE a.id=$1 AND a.external_ref=$2 FOR UPDATE OF a`,[target.id,target.externalRef])).rows[0];
      if(!row||row.id!==target.id||row.external_ref!==target.externalRef||row.author_member_id!==plan.authorMemberId||
        row.author_display_name!==plan.oldName||row.status!=='published'||row.version!==target.expectedVersion||
        row.content_sha256!==target.expectedContentSha256||row.relabel_row_sha256!==target.expectedRowSha256)throw fail('EDITORIAL_RELABEL_CONFLICT');
      const content=validateEditorialPublication(publication(row));
      // JSONB does not retain the historical JSON key order used by publication
      // fingerprints. The database's complete row digest plus immutable revision
      // proves the old fact; never claim to reconstruct its original serialization.
      const revision=(await client.query<{content_sha256:string;action:string}>(
        'SELECT content_sha256,action FROM editorial_article_revision WHERE article_id=$1 AND version=$2',[row.id,row.version])).rows[0];
      if(!revision||revision.content_sha256!==row.content_sha256||revision.action!=='publish')throw fail('EDITORIAL_RELABEL_REVISION_MISMATCH');
      const next=validateEditorialPublication({...content,author:plan.newName});
      prepared.push({row,content,nextHash:digest(JSON.stringify(next))});
    }
    const articles=[];
    for(const {row,content,nextHash} of prepared){
      const version=row.version+1;
      const updated=await client.query(`UPDATE editorial_article SET author_display_name=$2,content_sha256=$3,version=$4,updated_at=now()
        WHERE id=$1 AND external_ref=$5 AND version=$6 AND content_sha256=$7 AND author_member_id=$8 AND author_display_name=$9 AND status='published'`,
        [row.id,plan.newName,nextHash,version,row.external_ref,row.version,row.content_sha256,plan.authorMemberId,plan.oldName]);
      if(updated.rowCount!==1)throw fail('EDITORIAL_RELABEL_CONFLICT');
      await client.query(`INSERT INTO editorial_article_revision(article_id,version,content_sha256,action,authorization_sha256,rights_sha256,actor_member_id,actor_principal_id)
        VALUES($1,$2,$3,'publish',$4,$5,$6,$7)`,[row.id,version,nextHash,digest(content.authorizationRef),digest(JSON.stringify(content.rightsEvidence)),plan.operatorMemberId,plan.operatorPrincipalId]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES($1,'editorial.author_relabel','editorial_article',$2,'OWNER_AUTHORIZED_AUTHOR_RELABEL',$3,$4,$5)`,
        [plan.operatorPrincipalId,row.id,{authorName:row.author_display_name,version:row.version,contentSha256:row.content_sha256},
          {authorName:plan.newName,version,contentSha256:nextHash,authorizationRef:plan.authorizationRef,
            relabelAuthorizationSha256:digest(plan.authorizationRef),actorMemberId:plan.operatorMemberId},randomUUID()]);
      articles.push({id:row.id,externalRef:row.external_ref,previousVersion:row.version,version,previousContentSha256:row.content_sha256,contentSha256:nextHash});
    }
    return {mode:'author_relabelled' as const,authorMemberId:plan.authorMemberId,oldName:plan.oldName,newName:plan.newName,count:articles.length,articles};
  },'READ COMMITTED',1);
}
