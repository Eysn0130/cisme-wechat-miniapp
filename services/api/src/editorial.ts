import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {CANONICAL_WECHAT_MINIPROGRAM_APP_ID,type AppConfig} from '@cisme/config';
import type {EditorialCard,EditorialDetail,EditorialPage,EditorialAuthorPage} from '@cisme/contracts';
import {DomainError} from '@cisme/domain';
import {AuthorityService} from './authority.js';
import {readSnapshot,transaction,type DbClient} from './db.js';
import type {ObjectStorage} from './storage.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA=/^[0-9a-f]{64}$/;
function hash(value:string){return createHash('sha256').update(value).digest('hex');}
const NOT_FOUND=()=>new DomainError('EDITORIAL_NOT_FOUND','这篇精选暂不可见，请返回社区查看其他内容。',404);
export type EditorialMedia={sha256:string;objectKey:string;sourceSha256:string;rightsRef:string;bytes:number;sourceKind:"ai_generated_editorial_artwork";aiUsage:"generated"};
type Media=EditorialMedia;
export interface EditorialPublication {
  externalRef:string;authorMemberId:string;author:string;title:string;excerpt:string;body:string;
  sourceUrl:string|null;authorizationRef:string;rightsEvidence:Record<string,unknown>;media:Media[];
  expectedVersion?:number;
}
type Article={id:string;external_ref:string;author_member_id:string;author_display_name:string;
  title:string;excerpt:string;body:string;source_url:string|null;authorization_ref:string;
  rights_evidence:Record<string,unknown>;media:Media[];content_sha256:string;status:string;version:number;
  published_by:string;published_principal_id:string;published_at:Date;cursor_at:string;like_count:number;save_count:number};
const visible=`a.status='published' AND m.status='active' AND EXISTS(SELECT 1 FROM wechat_identity w
  WHERE w.member_id=m.id AND w.provider='wechat_miniprogram' AND w.adapter='wechat' AND w.app_id=$1)`;
const columns=`a.*,a.published_at::text AS cursor_at,COALESCE(s.like_count,0)::int AS like_count,
  COALESCE(s.save_count,0)::int AS save_count`;
const relations=`editorial_article a JOIN member m ON m.id=a.author_member_id
  LEFT JOIN community_post_stats s ON s.post_id=('editorial:'||a.id::text)`;
function uuid(value:unknown):string{if(typeof value!=='string'||!UUID.test(value))throw NOT_FOUND();return value;}
function text(value:unknown,min:number,max:number):string{
  if(typeof value!=='string')throw new DomainError('EDITORIAL_INPUT_INVALID','精选内容字段无效',422);
  const v=value.trim();if(v.length<min||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v))
    throw new DomainError('EDITORIAL_INPUT_INVALID','精选内容字段无效',422);return v;
}
function page(input:{limit?:unknown;cursor?:unknown},scope:string){
  const limit=input.limit===undefined?20:Number(input.limit);
  if(!Number.isInteger(limit)||limit<1||limit>30)throw new DomainError('EDITORIAL_INPUT_INVALID','分页大小须为1至30',422);
  let cursor:{at:string;id:string}|null=null;
  if(input.cursor!==undefined){try{
    if(typeof input.cursor!=='string'||input.cursor.length>1000)throw new Error();
    const v=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));
    if(!Array.isArray(v)||v.length!==3||v[2]!==scope||typeof v[0]!=='string'||v[0].length>80||
      !/^\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-][0-9:]+)$/.test(v[0])||!Number.isFinite(Date.parse(v[0]))||typeof v[1]!=='string'||!UUID.test(v[1]))throw new Error();
    cursor={at:v[0],id:v[1]};
  }catch{throw new DomainError('EDITORIAL_INPUT_INVALID','精选分页已失效，请刷新',422);}}
  return {limit,cursor,scope};
}
function mediaUrl(id:string,sha:string){return `/v1/editorial/media/${id}/${sha}`;}
function card(a:Article):EditorialCard{return {id:a.id,title:a.title,excerpt:a.excerpt,authorId:a.author_member_id,
  author:a.author_display_name,avatar:'',coverUrl:a.media[0]?mediaUrl(a.id,a.media[0].sha256):null,
  publishedAt:a.published_at.toISOString(),likeCount:a.like_count,saveCount:a.save_count};}
function next(rows:Article[],limit:number,scope:string){const row=rows.length>limit?rows[limit-1]:null;
  return row?Buffer.from(JSON.stringify([row.cursor_at,row.id,scope])).toString('base64url'):null;}

function authorizationRef(value:unknown){
  const ref=text(value,3,200);if(!/^[A-Za-z0-9][A-Za-z0-9:/._-]+$/.test(ref))
    throw new DomainError('EDITORIAL_INPUT_INVALID','授权依据仅填写可追溯的编号',422);return ref;
}
export function validateEditorialPublication(input:EditorialPublication){
  if(!input||typeof input!=='object')throw new DomainError('EDITORIAL_INPUT_INVALID','精选内容字段无效',422);
  const sourceUrl=input.sourceUrl===null||input.sourceUrl===undefined?null:text(input.sourceUrl,8,2000);
  if(sourceUrl){let u:URL;try{u=new URL(sourceUrl);}catch{throw new DomainError('EDITORIAL_INPUT_INVALID','内容来源链接无效',422);}
    if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new DomainError('EDITORIAL_INPUT_INVALID','来源须为不含凭据或临时查询参数的HTTPS链接',422);}
  if(!input.rightsEvidence||typeof input.rightsEvidence!=='object'||Array.isArray(input.rightsEvidence)||
    Object.keys(input.rightsEvidence).length===0||JSON.stringify(input.rightsEvidence).length>10000)
    throw new DomainError('EDITORIAL_INPUT_INVALID','需要可追溯的正文与素材展示授权',422);
  if(!Array.isArray(input.media)||input.media.length>9)throw new DomainError('EDITORIAL_INPUT_INVALID','最多9张精选图片',422);
  const media=input.media.map(item=>{
    if(!item||typeof item!=='object'||!SHA.test(item.sha256)||!SHA.test(item.sourceSha256)||item.objectKey!==`editorial-derived/${item.sha256}.webp`)
      throw new DomainError('EDITORIAL_INPUT_INVALID','精选图片来源或衍生文件校验无效',422);
    if(item.sourceKind!=='ai_generated_editorial_artwork'||item.aiUsage!=='generated')throw new DomainError('EDITORIAL_INPUT_INVALID','需要保留AI配图来源标识',422);
    if(!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>10*1024*1024)throw new DomainError('EDITORIAL_INPUT_INVALID','精选图片大小无效',422);
    return {sha256:item.sha256,objectKey:item.objectKey,sourceSha256:item.sourceSha256,rightsRef:text(item.rightsRef,3,500),bytes:item.bytes,sourceKind:item.sourceKind,aiUsage:item.aiUsage};
  });
  if(new Set(media.map(x=>x.sha256)).size!==media.length)throw new DomainError('EDITORIAL_INPUT_INVALID','精选图片不能重复',422);
  if(input.expectedVersion!==undefined&&(!Number.isInteger(input.expectedVersion)||input.expectedVersion<0))
    throw new DomainError('EDITORIAL_INPUT_INVALID','精选版本无效',422);
  return {externalRef:text(input.externalRef,3,200),authorMemberId:uuid(input.authorMemberId),author:text(input.author,1,40),
    title:text(input.title,1,120),excerpt:text(input.excerpt,0,320),body:text(input.body,1,20000),sourceUrl,
    authorizationRef:authorizationRef(input.authorizationRef),rightsEvidence:input.rightsEvidence,media};
}

export class EditorialService{
  constructor(private pool:pg.Pool,private config:AppConfig,private storage:ObjectStorage,private authority:AuthorityService){}
  private canonicalApp(){return this.config.wechat.appId===CANONICAL_WECHAT_MINIPROGRAM_APP_ID?this.config.wechat.appId:null;}
  private async actor(client:DbClient,memberId:string|undefined,principalId:string|undefined){
    if(!memberId||!principalId)throw new DomainError('AUTH_REQUIRED','请先使用微信账号登录',401);
    const found=await client.query(`SELECT 1 FROM member m JOIN wechat_identity w ON w.member_id=m.id
      WHERE m.id=$1 AND m.status='active' AND w.provider='wechat_miniprogram' AND w.adapter='wechat'
        AND w.app_id=$2 AND ('wechat_miniprogram:'||w.id::text)=$3 FOR SHARE OF m,w`,
      [memberId,this.canonicalApp(),principalId]);
    if(!found.rowCount)throw new DomainError('AUTH_REQUIRED','需要当前小程序的真实微信身份',401);
    return memberId;
  }
  private async article(client:DbClient,id:string,lock=false):Promise<Article>{
    const result=await client.query<Article>(`SELECT ${columns} FROM ${relations} WHERE a.id=$2 AND ${visible}${lock?' FOR SHARE OF a,m':''}`,[this.canonicalApp(),uuid(id)]);
    if(!result.rows[0])throw NOT_FOUND();return result.rows[0];
  }
  private async state(client:DbClient,a:Article,memberId?:string){
    const row=(await client.query(`SELECT
      EXISTS(SELECT 1 FROM community_reaction WHERE post_id=$1 AND member_id=$2 AND kind='like') AS liked,
      EXISTS(SELECT 1 FROM community_reaction WHERE post_id=$1 AND member_id=$2 AND kind='save') AS saved,
      EXISTS(SELECT 1 FROM community_follow WHERE member_id=$2 AND author_id=$3) AS following`,
      [`editorial:${a.id}`,memberId??null,a.author_member_id])).rows[0];
    return {liked:Boolean(row.liked),saved:Boolean(row.saved),following:Boolean(row.following)};
  }
  private async currentLegal(client:DbClient){
    const documents=(await client.query<{document_type:'terms'|'privacy';version:string}>(`SELECT document_type,version FROM legal_document
      WHERE active=true AND document_type IN ('terms','privacy') ORDER BY document_type FOR SHARE`)).rows;
    if(documents.length!==2||!['terms','privacy'].every(type=>documents.some(d=>d.document_type===type)))
      throw new DomainError('CURRENT_LEGAL_CONSENT_REQUIRED','请阅读并同意当前用户协议和隐私指引',409);
    return documents;
  }
  private async requireCurrentLegal(client:DbClient,memberId:string){
    const documents=await this.currentLegal(client);
    const acceptance=(await client.query<{document_type:string;document_version:string}>(`SELECT document_type,document_version FROM consent_acceptance
      WHERE member_id=$1 AND (document_type,document_version) IN (SELECT document_type,version FROM legal_document
        WHERE active=true AND document_type IN ('terms','privacy'))`,[memberId])).rows;
    if(documents.some(d=>!acceptance.some(a=>a.document_type===d.document_type&&a.document_version===d.version)))
      throw new DomainError('CURRENT_LEGAL_CONSENT_REQUIRED','请阅读并同意当前用户协议和隐私指引后再互动',409);
  }
  async acceptCurrentLegal(memberId:string|undefined,principalId:string|undefined,input:{consents?:unknown}){
    const consents=input.consents;
    if(!Array.isArray(consents)||consents.length!==2||new Set(consents.map(c=>c?.documentType)).size!==2||
      consents.some(c=>!c||!['terms','privacy'].includes(c.documentType)||typeof c.version!=='string'||c.version.length<1||c.version.length>100))
      throw new DomainError('LEGAL_ACCEPTANCE_INVALID','请明确确认用户协议和隐私指引的当前版本',422);
    return transaction(this.pool,async client=>{
      const owner=await this.actor(client,memberId,principalId),documents=await this.currentLegal(client);
      if(documents.some(d=>!consents.some(c=>c.documentType===d.document_type&&c.version===d.version)))
        throw new DomainError('CURRENT_LEGAL_CONSENT_REQUIRED','协议版本已更新，请重新阅读确认',409);
      let inserted=0;
      for(const doc of documents)inserted+=(await client.query(`INSERT INTO consent_acceptance(member_id,document_type,document_version,accepted_at,principal_id)
        VALUES($1,$2,$3,now(),$4) ON CONFLICT DO NOTHING`,[owner,doc.document_type,doc.version,principalId])).rowCount??0;
      if(inserted)await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
        VALUES($1,'legal.accept','member',$2,'EXPLICIT_CURRENT_LEGAL_ACCEPTANCE',$3,$4)`,[principalId,owner,
          {documents:documents.map(d=>({documentType:d.document_type,version:d.version}))},randomUUID()]);
      return {accepted:true,documents:documents.map(d=>({documentType:d.document_type,version:d.version}))};
    });
  }
  async list(input:{limit?:unknown;cursor?:unknown}={}):Promise<EditorialPage>{
    const p=page(input,'editorial');return readSnapshot(this.pool,async client=>{
      const rows=(await client.query<Article>(`SELECT ${columns} FROM ${relations} WHERE ${visible}
        AND ($2::timestamptz IS NULL OR (a.published_at,a.id)<($2::timestamptz,$3::uuid))
        ORDER BY a.published_at DESC,a.id DESC LIMIT $4`,[this.canonicalApp(),p.cursor?.at??null,p.cursor?.id??null,p.limit+1])).rows;
      return {items:rows.slice(0,p.limit).map(card),nextCursor:next(rows,p.limit,p.scope)};
    });
  }
  async detail(memberId:string|undefined,id:string):Promise<EditorialDetail>{return readSnapshot(this.pool,async client=>{
    const a=await this.article(client,id);return {...card(a),version:a.version,body:a.body,
      media:a.media.map(x=>({id:x.sha256,url:mediaUrl(a.id,x.sha256)})),...await this.state(client,a,memberId),
      isMine:memberId===a.author_member_id,interactionsEnabled:true,sourceUrl:a.source_url,provenanceLabel:a.media.length?'AI辅助配图':'CISME原创内容'};
  });}
  async author(memberId:string|undefined,authorId:string,input:{limit?:unknown;cursor?:unknown}={}):Promise<EditorialAuthorPage>{
    const author=uuid(authorId),p=page(input,`editorial-author:${author}`);return readSnapshot(this.pool,async client=>{
      const summary=(await client.query<{name:string;post_count:number}>(`SELECT
        (SELECT b.author_display_name FROM editorial_article b WHERE b.author_member_id=$2 AND b.status='published'
          ORDER BY b.published_at DESC,b.id DESC LIMIT 1) AS name,count(*)::int AS post_count
        FROM editorial_article a JOIN member m ON m.id=a.author_member_id WHERE ${visible} AND a.author_member_id=$2`,
        [this.canonicalApp(),author])).rows[0]!;
      if(!summary.post_count)throw NOT_FOUND();
      const rows=(await client.query<Article>(`SELECT ${columns} FROM ${relations} WHERE ${visible} AND a.author_member_id=$2
        AND ($3::timestamptz IS NULL OR (a.published_at,a.id)<($3::timestamptz,$4::uuid))
        ORDER BY a.published_at DESC,a.id DESC LIMIT $5`,[this.canonicalApp(),author,p.cursor?.at??null,p.cursor?.id??null,p.limit+1])).rows;
      const following=Boolean((await client.query('SELECT 1 FROM community_follow WHERE member_id=$1 AND author_id=$2',[memberId??null,author])).rowCount);
      return {author:{id:author,name:summary.name,avatar:'',postCount:summary.post_count,following,isMine:memberId===author},
        items:rows.slice(0,p.limit).map(card),nextCursor:next(rows,p.limit,p.scope)};
    });
  }
  async media(articleId:string,sha:string){
    if(!SHA.test(sha))throw NOT_FOUND();return transaction(this.pool,async client=>{
      const a=await this.article(client,articleId,true),media=a.media.find(x=>x.sha256===sha);if(!media)throw NOT_FOUND();
      // The SHARE locks serialize withdrawal and author deactivation with this read.
      return this.checkedMedia(media);
    });
  }
  private async checkedMedia(media:Media){
    const object=await this.storage.read(media.objectKey,10*1024*1024);
    if(object.bytes.length!==media.bytes||object.mimeType!=='image/webp'||createHash('sha256').update(object.bytes).digest('hex')!==media.sha256)
      throw new DomainError('EDITORIAL_MEDIA_UNAVAILABLE','精选图片暂时无法读取',503);
    return object;
  }
  async react(memberId:string|undefined,principalId:string|undefined,id:string,input:{kind?:unknown;active?:unknown}){
    if(!['like','save'].includes(String(input.kind))||typeof input.active!=='boolean')throw new DomainError('EDITORIAL_REACTION_INVALID','互动状态无效',422);
    return transaction(this.pool,async client=>{const owner=await this.actor(client,memberId,principalId);await this.requireCurrentLegal(client,owner);const a=await this.article(client,id,true);
      const key=`editorial:${a.id}`;const changed=input.active
        ?await client.query('INSERT INTO community_reaction(member_id,post_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[owner,key,input.kind])
        :await client.query('DELETE FROM community_reaction WHERE member_id=$1 AND post_id=$2 AND kind=$3',[owner,key,input.kind]);
      if(changed.rowCount)await this.audit(client,owner,principalId!,'editorial.reaction',a.id,{kind:input.kind,active:input.active});
      const current=await this.article(client,id);const state=await this.state(client,current,owner);
      return {kind:input.kind,active:input.active,count:input.kind==='like'?current.like_count:current.save_count,
        liked:state.liked,saved:state.saved,likeCount:current.like_count,saveCount:current.save_count};
    });
  }
  async follow(memberId:string|undefined,principalId:string|undefined,id:string,active:unknown){
    if(typeof active!=='boolean')throw new DomainError('EDITORIAL_FOLLOW_INVALID','关注状态无效',422);
    return transaction(this.pool,async client=>{const owner=await this.actor(client,memberId,principalId);await this.requireCurrentLegal(client,owner);const a=await this.article(client,id,true);
      if(owner===a.author_member_id)throw new DomainError('EDITORIAL_FOLLOW_INVALID','不能关注自己',422);
      const changed=active?await client.query('INSERT INTO community_follow(member_id,author_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[owner,a.author_member_id])
        :await client.query('DELETE FROM community_follow WHERE member_id=$1 AND author_id=$2',[owner,a.author_member_id]);
      if(changed.rowCount)await this.audit(client,owner,principalId!,'editorial.follow',a.id,{authorId:a.author_member_id,active});
      return {authorId:a.author_member_id,following:active};
    });
  }
  async publish(operatorId:string,principalId:string,input:EditorialPublication){
    const content=validateEditorialPublication(input),fingerprint=createHash('sha256').update(JSON.stringify(content)).digest('hex');
    return transaction(this.pool,async client=>{
      await this.actor(client,operatorId,principalId);await this.authority.requireWithClient(client,operatorId,'editorial.manage');
      const author=await client.query(`SELECT 1 FROM member m JOIN wechat_identity w ON w.member_id=m.id
        WHERE m.id=$1 AND m.status='active' AND w.provider='wechat_miniprogram' AND w.adapter='wechat' AND w.app_id=$2 FOR SHARE OF m,w`,
        [content.authorMemberId,this.canonicalApp()]);if(!author.rowCount)throw new DomainError('EDITORIAL_AUTHOR_REQUIRED','作者须为已核实的当前小程序活跃微信会员',422);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`editorial:${content.externalRef}`]);
      const old=(await client.query<Article>('SELECT * FROM editorial_article WHERE external_ref=$1 FOR UPDATE',[content.externalRef])).rows[0];
      if(old&&old.author_member_id!==content.authorMemberId)throw new DomainError('EDITORIAL_SOURCE_CONFLICT','该来源已属于另一作者',409);
      if(old?.content_sha256===fingerprint&&old.status==='published')return {id:old.id,version:old.version,status:'published',replayed:true};
      if((old?.version??0)!==(input.expectedVersion??0))throw new DomainError('EDITORIAL_VERSION_CONFLICT','精选版本已变化，请重新核对',409);
      for(const media of [...content.media].sort((a,b)=>a.sha256.localeCompare(b.sha256))){
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[media.objectKey]);await this.checkedMedia(media);
      }
      const id=old?.id??randomUUID(),version=(old?.version??0)+1;
      const values=[id,content.externalRef,content.authorMemberId,content.author,content.title,content.excerpt,content.body,
        content.sourceUrl,content.authorizationRef,content.rightsEvidence,JSON.stringify(content.media),fingerprint,version,operatorId,principalId];
      await client.query(`INSERT INTO editorial_article(id,external_ref,author_member_id,author_display_name,title,excerpt,body,
        source_url,authorization_ref,rights_evidence,media,content_sha256,status,version,published_by,published_principal_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'published',$13,$14,$15)
        ON CONFLICT(id) DO UPDATE SET author_display_name=$4,title=$5,excerpt=$6,body=$7,source_url=$8,
        authorization_ref=$9,rights_evidence=$10,media=$11,content_sha256=$12,status='published',version=$13,
        published_by=$14,published_principal_id=$15,published_at=now(),updated_at=now()`,values);
      await client.query(`INSERT INTO editorial_article_revision(article_id,version,content_sha256,action,authorization_sha256,rights_sha256,actor_member_id,actor_principal_id)
        VALUES($1,$2,$3,'publish',$4,$5,$6,$7)`,[id,version,fingerprint,hash(content.authorizationRef),hash(JSON.stringify(content.rightsEvidence)),operatorId,principalId]);
      await this.audit(client,operatorId,principalId,'editorial.publish',id,{version,contentSha256:fingerprint,authorizationRef:content.authorizationRef});
      return {id,version,status:'published',replayed:false};
    });
  }
  async withdraw(operatorId:string,principalId:string,id:string,expectedVersion:number,reason:unknown){
    if(!Number.isInteger(expectedVersion)||expectedVersion<1)throw new DomainError('EDITORIAL_INPUT_INVALID','精选版本无效',422);
    const why=text(reason,3,500);return transaction(this.pool,async client=>{
      await this.actor(client,operatorId,principalId);await this.authority.requireWithClient(client,operatorId,'editorial.manage');
      const a=(await client.query<Article>('SELECT * FROM editorial_article WHERE id=$1 FOR UPDATE',[uuid(id)])).rows[0];
      if(!a)throw NOT_FOUND();if(a.version!==expectedVersion)throw new DomainError('EDITORIAL_VERSION_CONFLICT','精选版本已变化，请刷新',409);
      await client.query("UPDATE editorial_article SET status='withdrawn',version=version+1,updated_at=now() WHERE id=$1",[id]);
      await client.query(`INSERT INTO editorial_article_revision(article_id,version,content_sha256,action,authorization_sha256,rights_sha256,actor_member_id,actor_principal_id)
        VALUES($1,$2,$3,'withdraw',$4,$5,$6,$7)`,[id,a.version+1,a.content_sha256,hash(a.authorization_ref),hash(JSON.stringify(a.rights_evidence)),operatorId,principalId]);
      await this.audit(client,operatorId,principalId,'editorial.withdraw',id,{version:a.version+1,reason:why});return {id,version:a.version+1,status:'withdrawn'};
    });
  }
  /** Explicit operator cleanup after withdrawal; no automatic-retention promise. */
  async purgeWithdrawn(operatorId:string,principalId:string,id:string,expectedVersion:number){
    if(!Number.isInteger(expectedVersion)||expectedVersion<1)throw new DomainError('EDITORIAL_INPUT_INVALID','精选版本无效',422);
    return transaction(this.pool,async client=>{
      await this.actor(client,operatorId,principalId);await this.authority.requireWithClient(client,operatorId,'editorial.manage');
      const ref=(await client.query<{external_ref:string}>('SELECT external_ref FROM editorial_article WHERE id=$1',[uuid(id)])).rows[0];
      if(!ref)throw NOT_FOUND();
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`editorial:${ref.external_ref}`]);
      const a=(await client.query<Article>('SELECT * FROM editorial_article WHERE id=$1 FOR UPDATE',[id])).rows[0]!;
      if(a.status!=='withdrawn'||a.version!==expectedVersion)throw new DomainError('EDITORIAL_VERSION_CONFLICT','只能清理已核对版本的撤回内容',409);
      await client.query('LOCK TABLE legal_hold IN SHARE MODE');await client.query('LOCK TABLE legal_hold_binding IN SHARE MODE');
      const held=await client.query(`SELECT 1 FROM legal_hold_binding b JOIN legal_hold h ON h.id=b.hold_id
        WHERE h.status='active' AND h.expires_at>now() AND ((b.object_type='editorial_article' AND b.object_id=$1)
        OR (b.object_type IN ('member','member_profile','member_contact','wechat_identity') AND b.object_id=$2)) LIMIT 1`,[id,a.author_member_id]);
      if(held.rowCount)throw new DomainError('EDITORIAL_HELD','内容受必要保全约束，已保持不公开',409);
      let removed=0;
      for(const media of [...a.media].sort((x,y)=>x.sha256.localeCompare(y.sha256))){
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[media.objectKey]);
        const other=await client.query(`SELECT 1 FROM editorial_article WHERE id<>$1 AND media @> $2::jsonb LIMIT 1`,[id,JSON.stringify([{objectKey:media.objectKey}])]);
        if(!other.rowCount){await this.storage.delete(media.objectKey);removed++;}
      }
      await client.query(`UPDATE editorial_article SET author_display_name='已撤回作者',title='已撤回内容',excerpt='',body='已撤回内容',
        source_url=NULL,rights_evidence='{}',media='[]',updated_at=now() WHERE id=$1`,[id]);
      await this.audit(client,operatorId,principalId,'editorial.purge',id,{version:expectedVersion,removedObjects:removed});
      return {id,version:expectedVersion,status:'withdrawn',removedObjects:removed};
    });
  }
  private async audit(client:DbClient,memberId:string,principalId:string,action:string,id:string,evidence:Record<string,unknown>){
    await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
      VALUES($1,$2,'editorial_article',$3,'EXPLICIT_MEMBER_OR_OWNER_ACTION',$4,$5)`,[principalId,action,id,{...evidence,actorMemberId:memberId},randomUUID()]);
  }
}
