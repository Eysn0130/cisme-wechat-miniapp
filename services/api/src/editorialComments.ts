import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {AppConfig} from '@cisme/config';
import {DomainError} from '@cisme/domain';
import {AuthorityService} from './authority.js';
import type {EditorialService} from './editorial.js';
import {communityAuthors} from './memberProfile.js';
import {readSnapshot,transaction,type DbClient} from './db.js';
import {finishPage,pageLimit,pageScope,readPageCursor} from './keysetPage.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const missing=()=>new DomainError('COMMENT_NOT_FOUND','这条评论暂不可见，请刷新后重试',404);
function uuid(value:unknown){if(typeof value!=='string'||!UUID.test(value))throw missing();return value;}
function clean(value:unknown,min:number,max:number,code='COMMENT_BODY_INVALID'){
  const body=typeof value==='string'?value.trim():'';
  if(Array.from(body).length<min||Array.from(body).length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body))
    throw new DomainError(code,`请输入 ${min} 至 ${max} 个字`,422);
  return body;
}
const status=(state:string)=>state==='pending_review'?'pending':state;
const blocked=(author:string,viewer='$2')=>`NOT EXISTS(SELECT 1 FROM ugc_block_relation b WHERE
  (b.blocker_member_id=${viewer} AND b.blocked_member_id=${author}) OR
  (b.blocker_member_id=${author} AND b.blocked_member_id=${viewer}))`;
// A reply never survives an invisible root, including deletion, account closure
// and the viewer's block relationship. The same predicate drives counts/writes.
const publicComment=`c.state='published' AND c.deleted_at IS NULL AND commenter.status='active' AND ${blocked('c.author_member_id')}
  AND (c.parent_id IS NULL OR EXISTS(SELECT 1 FROM editorial_comment root JOIN member rm ON rm.id=root.author_member_id
    WHERE root.id=c.parent_id AND root.article_id=c.article_id AND root.state='published' AND rm.status='active'
      AND ${blocked('root.author_member_id')}))`;
type Comment={id:string;article_id:string;author_member_id:string;parent_id:string|null;reply_to_id:string|null;
  body:string|null;state:string;version:number;created_at:Date;deleted_at:Date|null;cursor_at:string;request_sha256:string;like_count?:number;liked?:boolean};

export async function editorialCommentSummary(client:DbClient,environment:string,id:string,authorId:string,memberId?:string){
  const policy=(await client.query<{enabled:boolean;version:number}>('SELECT enabled,version FROM editorial_comment_policy WHERE article_id=$1',[id])).rows[0];
  const count=(await client.query<{n:number}>(`SELECT count(*)::int n FROM editorial_comment c JOIN member commenter ON commenter.id=c.author_member_id
    WHERE c.article_id=$1 AND ${publicComment}`,[id,memberId??null])).rows[0]!.n;
  const moderator=memberId?Boolean((await client.query(`SELECT 1 FROM authority_grant g JOIN member m ON m.id=g.member_id AND m.status='active'
    WHERE g.member_id=$1 AND g.environment=$2 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
    AND (g.capability='community.moderate' OR g.capability='editorial.manage' AND $1::uuid=$3::uuid) LIMIT 1`,[memberId,environment,authorId])).rowCount):false;
  return {commentsEnabled:policy?.enabled??true,commentsPolicyVersion:policy?.version??0,commentCount:count,canModerate:moderator};
}

export class EditorialCommentsService{
  constructor(private pool:pg.Pool,private config:AppConfig,private editorial:EditorialService,private authority:AuthorityService){}
  private async policy(client:DbClient,articleId:string,lock=false){
    const row=(await client.query<{enabled:boolean;version:number}>(`SELECT enabled,version FROM editorial_comment_policy WHERE article_id=$1${lock?' FOR SHARE':''}`,[articleId])).rows[0];
    return {commentsEnabled:row?.enabled??true,commentsPolicyVersion:row?.version??0};
  }
  private async requireEnabled(client:DbClient,articleId:string){
    // This shares the article lock with policy updates, including first insert.
    const policy=await this.policy(client,articleId,true);
    if(!policy.commentsEnabled)throw new DomainError('EDITORIAL_COMMENTS_CLOSED','这篇文章暂不接受新评论，已发布的内容仍可查看',409);
  }
  private async moderator(client:DbClient,memberId:string|undefined,principalId:string|undefined,authorId?:string){
    const owner=await this.editorial.commentActor(client,memberId,principalId,false);
    try{await this.authority.requireWithClient(client,owner,'community.moderate');return {owner,all:true};}
    catch(error){if(!(error instanceof DomainError)||error.code!=='CAPABILITY_REQUIRED')throw error;}
    await this.authority.requireWithClient(client,owner,'editorial.manage');
    if(authorId!==undefined&&authorId!==owner)throw new DomainError('CAPABILITY_REQUIRED','只能管理本人精选下的评论',403);
    return {owner,all:false};
  }
  private async audit(client:DbClient,principalId:string,action:string,id:string,evidence:object){
    await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
      VALUES($1,$2,'editorial_comment',$3,'EXPLICIT_COMMENT_ACTION',$4,$5)`,[principalId,action,id,evidence,randomUUID()]);
  }
  private async available(client:DbClient,articleId:string,viewer:string|undefined,id:string,lock=false){
    const row=(await client.query<Comment>(`SELECT c.* FROM editorial_comment c JOIN member commenter ON commenter.id=c.author_member_id
      WHERE c.article_id=$1 AND c.id=$3 AND ${publicComment}${lock?' FOR SHARE OF c,commenter':''}`,[articleId,viewer??null,id])).rows[0];
    if(!row)throw missing();
    if(lock&&row.parent_id){
      const root=await client.query(`SELECT c.id FROM editorial_comment c JOIN member commenter ON commenter.id=c.author_member_id
        WHERE c.article_id=$1 AND c.id=$3 AND ${publicComment} FOR SHARE OF c,commenter`,[articleId,viewer??null,row.parent_id]);
      if(!root.rowCount)throw missing();
    }
    return row;
  }
  async read(memberId:string|undefined,articleId:string,input:{limit?:unknown;cursor?:unknown}={}){
    const id=uuid(articleId),limit=pageLimit(input.limit,30,50),scope=pageScope(['editorial-comments',id,memberId??'guest']);
    const cursor=readPageCursor(input.cursor,scope);
    return readSnapshot(this.pool,async(client,asOf)=>{
      const article=await this.editorial.commentArticle(client,id),summary=await editorialCommentSummary(client,this.config.env,id,article.authorMemberId,memberId);
      const condition=`c.article_id=$1 AND c.deleted_at IS NULL AND ((${publicComment}) OR (c.author_member_id=$2 AND c.state IN ('pending_review','rejected','hidden')
        AND commenter.status='active' AND (c.parent_id IS NULL OR EXISTS(SELECT 1 FROM editorial_comment r JOIN member rm ON rm.id=r.author_member_id
          WHERE r.id=c.parent_id AND r.state='published' AND rm.status='active' AND ${blocked('r.author_member_id')}))))`;
      const rows=(await client.query<Comment>(`SELECT c.*,c.created_at::text AS cursor_at,
        (SELECT count(*)::int FROM editorial_comment_like l JOIN member lm ON lm.id=l.member_id AND lm.status='active' WHERE l.comment_id=c.id) AS like_count,
        EXISTS(SELECT 1 FROM editorial_comment_like l WHERE l.comment_id=c.id AND l.member_id=$2) AS liked
        FROM editorial_comment c JOIN member commenter ON commenter.id=c.author_member_id WHERE ${condition}
        AND ($3::timestamptz IS NULL OR (c.created_at,c.id)>($3::timestamptz,$4::uuid))
        ORDER BY c.created_at,c.id LIMIT $5`,[id,memberId??null,cursor?.at??null,cursor?.id??null,limit+1])).rows;
      const targets=rows.flatMap(row=>[row.author_member_id]);
      const replyIds=rows.map(row=>row.reply_to_id).filter(Boolean);
      const replies=replyIds.length?(await client.query<{id:string;author_member_id:string}>(`SELECT id,author_member_id FROM editorial_comment WHERE id=ANY($1::uuid[])`,[replyIds])).rows:[];
      const authors=await communityAuthors(client,[...targets,...replies.map(row=>row.author_member_id)]);
      const page=finishPage(rows.map(row=>({...row,cursorAt:row.cursor_at})),limit,scope);
      return {...summary,preview:false,asOf:asOf.toISOString(),authors,
        nextCursor:page.nextCursor,truncated:page.hasMore,hasMore:page.hasMore,loadedCount:page.loadedCount,
        comments:page.items.map(row=>({id:row.id,version:row.version,body:row.body,status:status(row.state),parentId:row.parent_id,
          replyRootId:row.parent_id??row.id,replyToId:row.reply_to_id,createdAt:row.created_at,authorId:row.author_member_id,
          authorName:authors[row.author_member_id]?.name??'CISME 会员',replyToName:row.reply_to_id?authors[replies.find(r=>r.id===row.reply_to_id)?.author_member_id??'']?.name??'CISME 会员':null,
          isMine:row.author_member_id===memberId,likeCount:row.like_count??0,liked:row.liked===true}))};
    });
  }
  async create(memberId:string|undefined,principalId:string|undefined,articleId:string,operationId:unknown,input:{body?:unknown;replyToId?:unknown}){
    const id=uuid(articleId),body=clean(input?.body,2,180),replyId=input?.replyToId==null?null:uuid(input.replyToId);
    if(typeof operationId!=='string'||!/^[A-Za-z0-9._:-]{8,200}$/.test(operationId))throw new DomainError('COMMENT_REQUEST_KEY_INVALID','请保留本次提交编号后重试',422);
    const fingerprint=createHash('sha256').update(JSON.stringify([id,body,replyId])).digest('hex');
    return transaction(this.pool,async client=>{
      const owner=await this.editorial.commentActor(client,memberId,principalId);
      const article=await this.editorial.commentArticle(client,id,true);await this.requireEnabled(client,id);
      if(!(await client.query(`SELECT 1 WHERE ${blocked('$1','$2')}`,[article.authorMemberId,owner])).rowCount)throw missing();
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`editorial-comment:${owner}:${operationId}`]);
      const previous=(await client.query<Comment>('SELECT * FROM editorial_comment WHERE author_member_id=$1 AND operation_id=$2',[owner,operationId])).rows[0];
      if(previous){if(previous.request_sha256!==fingerprint)throw new DomainError('IDEMPOTENCY_CONFLICT','该提交编号已用于另一条评论，请重新发送',409);
        return {id:previous.id,status:previous.deleted_at?'deleted':status(previous.state),version:previous.version,replayed:true};}
      let reply:Comment|null=null;
      if(replyId)try{reply=await this.available(client,id,owner,replyId,true);}catch(error){
        if(error instanceof DomainError&&error.code==='COMMENT_NOT_FOUND')throw new DomainError('COMMENT_REPLY_UNAVAILABLE','回复对象已不可见，请刷新后重试',409);
        throw error;
      }
      const created=(await client.query<Comment>(`INSERT INTO editorial_comment(article_id,author_member_id,parent_id,reply_to_id,body,operation_id,request_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[id,owner,reply?.parent_id??reply?.id??null,replyId,body,operationId,fingerprint])).rows[0]!;
      await this.audit(client,principalId!,'editorial.comment_submit',created.id,{articleId:id,version:1});
      return {id:created.id,status:'pending',version:1,replayed:false};
    });
  }
  async remove(memberId:string|undefined,principalId:string|undefined,articleId:string,commentId:string){
    return transaction(this.pool,async client=>{
      const owner=await this.editorial.commentActor(client,memberId,principalId,false);
      const row=(await client.query<Comment>('SELECT * FROM editorial_comment WHERE id=$1 AND article_id=$2 AND author_member_id=$3 FOR UPDATE',[uuid(commentId),uuid(articleId),owner])).rows[0];
      if(!row)throw missing();
      if(row.state!=='deleted'){
        await client.query('LOCK TABLE legal_hold IN SHARE MODE');await client.query('LOCK TABLE legal_hold_binding IN SHARE MODE');
        const held=Boolean((await client.query(`SELECT 1 FROM legal_hold_binding b JOIN legal_hold h ON h.id=b.hold_id
          WHERE h.status='active' AND h.expires_at>now() AND (b.object_type='member' AND b.object_id=$1
            OR b.object_type='editorial_comment' AND b.object_id=$2) LIMIT 1`,[owner,row.id])).rowCount);
        await client.query(`UPDATE editorial_comment SET body=CASE WHEN $2 THEN body ELSE NULL END,
          state=CASE WHEN $2 THEN 'hidden' ELSE 'deleted' END,deleted_at=COALESCE(deleted_at,now()),
          version=version+1,updated_at=now() WHERE id=$1`,[row.id,held]);
        await client.query('DELETE FROM editorial_comment_like WHERE comment_id=$1',[row.id]);
        await this.audit(client,principalId!,'editorial.comment_delete',row.id,{articleId:row.article_id});
        await client.query('UPDATE member SET privacy_erasure_revision=privacy_erasure_revision+1 WHERE id=$1',[owner]);
        await client.query('UPDATE privacy_export_artifact SET revoked_at=now() WHERE member_id=$1 AND revoked_at IS NULL',[owner]);
      }
      return {id:row.id,status:'deleted'};
    });
  }
  async like(memberId:string|undefined,principalId:string|undefined,articleId:string,commentId:string,active:unknown){
    if(typeof active!=='boolean')throw new DomainError('REACTION_INVALID','请选择明确的点赞状态',422);
    return transaction(this.pool,async client=>{
      const owner=await this.editorial.commentActor(client,memberId,principalId);
      const id=uuid(articleId);await this.editorial.commentArticle(client,id,true);await this.requireEnabled(client,id);
      const comment=await this.available(client,id,owner,uuid(commentId),true);
      if(active)await client.query('INSERT INTO editorial_comment_like(member_id,comment_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[owner,comment.id]);
      else await client.query('DELETE FROM editorial_comment_like WHERE member_id=$1 AND comment_id=$2',[owner,comment.id]);
      const count=(await client.query<{n:number}>(`SELECT count(*)::int n FROM editorial_comment_like l JOIN member m ON m.id=l.member_id AND m.status='active' WHERE comment_id=$1`,[comment.id])).rows[0]!.n;
      return {id:comment.id,liked:active,likeCount:count};
    });
  }
  async report(memberId:string|undefined,principalId:string|undefined,articleId:string,commentId:string,input:{category?:unknown;description?:unknown}){
    const category=input?.category;
    if(typeof category!=='string'||!['spam','abuse','privacy','misinformation','rights','other'].includes(category))throw new DomainError('COMMENT_REPORT_INVALID','请选择举报原因',422);
    const description=input.description==null||input.description===''?null:clean(input.description,1,500,'COMMENT_REPORT_INVALID');
    return transaction(this.pool,async client=>{
      const owner=await this.editorial.commentActor(client,memberId,principalId,false),id=uuid(articleId);
      await this.editorial.commentArticle(client,id,true);const comment=await this.available(client,id,owner,uuid(commentId),true);
      if(comment.author_member_id===owner)throw new DomainError('COMMENT_REPORT_INVALID','本人的评论可直接删除',422);
      const created=(await client.query<{id:string;state:string}>(`INSERT INTO editorial_comment_report(comment_id,reporter_member_id,category,description)
        VALUES($1,$2,$3,$4) ON CONFLICT(comment_id,reporter_member_id) DO UPDATE SET comment_id=EXCLUDED.comment_id RETURNING id,state`,[comment.id,owner,category,description])).rows[0]!;
      return {id:created.id,status:created.state};
    });
  }
  async block(memberId:string|undefined,principalId:string|undefined,blockedId:string,active:unknown){
    if(typeof active!=='boolean')throw new DomainError('COMMENT_BLOCK_INVALID','请选择明确的屏蔽状态',422);
    return transaction(this.pool,async client=>{
      const owner=await this.editorial.commentActor(client,memberId,principalId,false),target=uuid(blockedId);
      if(owner===target)throw new DomainError('COMMENT_BLOCK_INVALID','不能屏蔽自己',422);
      if(active&&!(await client.query("SELECT 1 FROM member WHERE id=$1 AND status='active'",[target])).rowCount)throw missing();
      if(active)await client.query('INSERT INTO ugc_block_relation(blocker_member_id,blocked_member_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[owner,target]);
      else await client.query('DELETE FROM ugc_block_relation WHERE blocker_member_id=$1 AND blocked_member_id=$2',[owner,target]);
      return {authorId:target,blocked:active};
    });
  }
  async blocks(memberId:string|undefined,principalId:string|undefined,input:{limit?:unknown;cursor?:unknown}={}){
    const limit=pageLimit(input.limit,30,50),scope=pageScope(['editorial-blocks',memberId]),cursor=readPageCursor(input.cursor,scope);
    return transaction(this.pool,async client=>{
      const owner=await this.editorial.commentActor(client,memberId,principalId,false);
      const rows=(await client.query<{id:string;cursor_at:string}>(`SELECT blocked_member_id AS id,created_at::text AS cursor_at
        FROM ugc_block_relation WHERE blocker_member_id=$1 AND
          ($2::timestamptz IS NULL OR (created_at,blocked_member_id)<($2::timestamptz,$3::uuid))
        ORDER BY created_at DESC,blocked_member_id DESC LIMIT $4`,[owner,cursor?.at??null,cursor?.id??null,limit+1])).rows;
      const page=finishPage(rows.map(row=>({...row,cursorAt:row.cursor_at})),limit,scope);
      const authors=await communityAuthors(client,page.items.map(row=>row.id));
      return {...page,items:page.items.map(row=>({authorId:row.id,name:authors[row.id]?.name??'CISME 会员',
        avatar:authors[row.id]?.avatar??'',avatarRevision:authors[row.id]?.avatarRevision??null}))};
    });
  }
  async queue(memberId:string|undefined,principalId:string|undefined,input:{limit?:unknown;cursor?:unknown;state?:unknown;articleId?:unknown}={}){
    const state=input.state??'pending';if(typeof state!=='string'||!['pending','published','rejected','hidden','reported'].includes(state))throw new DomainError('COMMENT_REVIEW_INVALID','审核队列类型无效',422);
    const articleId=input.articleId==null?null:uuid(input.articleId);
    const limit=pageLimit(input.limit,30,50),scope=pageScope(['editorial-review',memberId,state,articleId]),cursor=readPageCursor(input.cursor,scope);
    return transaction(this.pool,async client=>{
      const permission=await this.moderator(client,memberId,principalId);
      const rows=(await client.query(`SELECT c.*,c.created_at::text AS cursor_at,a.title AS article_title,a.author_member_id AS article_owner,
        (SELECT s.state FROM editorial_comment_safety_scan s WHERE s.comment_id=c.id ORDER BY s.created_at DESC,s.id DESC LIMIT 1) AS safety_state,
        (SELECT count(*)::int FROM editorial_comment_report r WHERE r.comment_id=c.id AND r.state='open') AS report_count
        FROM editorial_comment c JOIN editorial_article a ON a.id=c.article_id
        WHERE c.deleted_at IS NULL AND ($1::boolean OR a.author_member_id=$2) AND ($8::uuid IS NULL OR c.article_id=$8) AND
          (($3='reported' AND c.state='published' AND EXISTS(SELECT 1 FROM editorial_comment_report r WHERE r.comment_id=c.id AND r.state='open'))
           OR $3<>'reported' AND c.state=$4)
        AND ($5::timestamptz IS NULL OR (c.created_at,c.id)>($5::timestamptz,$6::uuid)) ORDER BY c.created_at,c.id LIMIT $7`,
      [permission.all,permission.owner,state,state==='pending'?'pending_review':state,cursor?.at??null,cursor?.id??null,limit+1,articleId])).rows;
      const authors=await communityAuthors(client,rows.map(row=>row.author_member_id));
      const page=finishPage(rows.map(row=>({id:row.id,cursorAt:row.cursor_at,articleId:row.article_id,articleTitle:row.article_title,
        authorId:row.author_member_id,authorName:authors[row.author_member_id]?.name??'CISME 会员',body:row.body,status:status(row.state),version:row.version,
        parentId:row.parent_id,replyToId:row.reply_to_id,replyRootId:row.parent_id??row.id,createdAt:row.created_at,safetyState:row.safety_state??'pending',reportCount:row.report_count})),limit,scope);
      return {...page,items:page.items.map(({cursorAt:_,...item})=>item),authors};
    });
  }
  async review(memberId:string|undefined,principalId:string|undefined,commentId:string,input:{decision?:unknown;reason?:unknown;expectedVersion?:unknown}){
    if(typeof input?.decision!=='string'||!['approve','reject','hide'].includes(input.decision)||!Number.isSafeInteger(input.expectedVersion)||Number(input.expectedVersion)<1)
      throw new DomainError('COMMENT_REVIEW_INVALID','请刷新评论并选择处理结果',422);
    const reason=clean(input.reason,4,500,'COMMENT_REVIEW_INVALID'),id=uuid(commentId);
    return transaction(this.pool,async client=>{
      const target=(await client.query<{article_id:string;author_member_id:string}>('SELECT c.article_id,a.author_member_id FROM editorial_comment c JOIN editorial_article a ON a.id=c.article_id WHERE c.id=$1',[id])).rows[0];
      if(!target)throw missing();
      const permission=await this.moderator(client,memberId,principalId,target.author_member_id);
      // Serialize all moderation/policy/creation against withdrawal of the article.
      const currentArticle=input.decision==='approve'?await this.editorial.commentArticle(client,target.article_id,true):
        {authorMemberId:(await client.query<{author_member_id:string}>('SELECT author_member_id FROM editorial_article WHERE id=$1 FOR SHARE',[target.article_id])).rows[0]!.author_member_id};
      if(!permission.all&&currentArticle.authorMemberId!==permission.owner)throw new DomainError('CAPABILITY_REQUIRED','只能管理本人精选下的评论',403);
      const row=(await client.query<Comment>('SELECT * FROM editorial_comment WHERE id=$1 FOR UPDATE',[id])).rows[0]!;
      if(row.deleted_at||row.version!==input.expectedVersion||row.state!==(input.decision==='hide'?'published':'pending_review'))throw new DomainError('COMMENT_REVIEW_CONFLICT','评论状态已变化，请刷新后重试',409);
      if(input.decision==='approve'){
        await this.requireEnabled(client,row.article_id);
        const scan=(await client.query<{state:string;provider:string;body_sha256:string}>('SELECT state,provider,body_sha256 FROM editorial_comment_safety_scan WHERE comment_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[id])).rows[0];
        if(scan?.state!=='safe'||scan.provider!=='wechat_v2'||scan.body_sha256!==createHash('sha256').update(row.body!).digest('hex'))
          throw new DomainError('COMMENT_TEXT_SCAN_REQUIRED','评论安全检查尚未通过，请稍后重新核对',409);
        if(!(await client.query("SELECT 1 FROM member WHERE id=$1 AND status='active' FOR SHARE",[row.author_member_id])).rowCount)throw missing();
        if(row.parent_id)await this.available(client,row.article_id,row.author_member_id,row.parent_id,true);
      }
      const next=input.decision==='approve'?'published':input.decision==='reject'?'rejected':'hidden';
      await client.query('UPDATE editorial_comment SET state=$2,version=version+1,updated_at=now() WHERE id=$1',[id,next]);
      await client.query("UPDATE editorial_comment_report SET state='resolved',updated_at=now() WHERE comment_id=$1 AND state='open'",[id]);
      await this.audit(client,principalId!,'editorial.comment_review',id,{decision:input.decision,reason,version:row.version+1});
      return {id,status:status(next),version:row.version+1};
    });
  }
  async setPolicy(memberId:string|undefined,principalId:string|undefined,articleId:string,input:{enabled?:unknown;expectedVersion?:unknown}){
    if(typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.expectedVersion)||Number(input.expectedVersion)<0)throw new DomainError('COMMENT_POLICY_INVALID','请刷新评论设置后重试',422);
    const id=uuid(articleId);
    return transaction(this.pool,async client=>{
      const author=(await client.query<{author_member_id:string}>('SELECT author_member_id FROM editorial_article WHERE id=$1',[id])).rows[0];if(!author)throw missing();
      const permission=await this.moderator(client,memberId,principalId,author.author_member_id);
      const locked=(await client.query<{author_member_id:string}>('SELECT author_member_id FROM editorial_article WHERE id=$1 FOR UPDATE',[id])).rows[0]!;
      if(!permission.all&&locked.author_member_id!==permission.owner)throw new DomainError('CAPABILITY_REQUIRED','只能管理本人精选下的评论',403);
      const policy=await this.policy(client,id);
      if(policy.commentsPolicyVersion!==input.expectedVersion)throw new DomainError('COMMENT_POLICY_CONFLICT','评论设置已更新，请刷新',409);
      const row=(await client.query<{enabled:boolean;version:number}>(`INSERT INTO editorial_comment_policy(article_id,enabled) VALUES($1,$2)
        ON CONFLICT(article_id) DO UPDATE SET enabled=EXCLUDED.enabled,version=editorial_comment_policy.version+1,updated_at=now() RETURNING enabled,version`,[id,input.enabled])).rows[0]!;
      await this.audit(client,principalId!,'editorial.comment_policy',id,{enabled:row.enabled,version:row.version});
      return {commentsEnabled:row.enabled,commentsPolicyVersion:row.version};
    });
  }
}
