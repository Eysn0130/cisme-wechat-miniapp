import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {CANONICAL_WECHAT_MINIPROGRAM_APP_ID,type AppConfig} from '@cisme/config';
import {DomainError} from '@cisme/domain';
import {transaction} from './db.js';
import type {EditorialService} from './editorial.js';
import {finishPage,pageLimit,pageScope,readPageCursor} from './keysetPage.js';
import {communityAuthors} from './memberProfile.js';

export type EditorialActivitySection='comments'|'saves'|'reports'|'blocks';
type Row={id:string;created_at:Date;cursor_at:string;post_id?:string;post_title?:string|null;
  available?:boolean;body?:string|null;state?:string;version?:number;parent_id?:string|null;reply_to_id?:string|null;
  target_id?:string;category?:string;description?:string|null};
const context='WITH ctx AS (SELECT $1::uuid AS owner,$2::text AS app_id)';
// A private association can remain in its owner's history after withdrawal or
// blocking. Its article title must still follow the public visibility boundary.
const available=`a.status='published' AND m.status='active' AND EXISTS(SELECT 1 FROM wechat_identity w
  WHERE w.member_id=m.id AND w.provider='wechat_miniprogram' AND w.adapter='wechat' AND w.app_id=x.app_id)
  AND NOT EXISTS(SELECT 1 FROM ugc_block_relation b WHERE
    (b.blocker_member_id=x.owner AND b.blocked_member_id=m.id) OR
    (b.blocker_member_id=m.id AND b.blocked_member_id=x.owner))`;
const articleRelations='JOIN editorial_article a ON a.id=c.article_id JOIN member m ON m.id=a.author_member_id CROSS JOIN ctx x';
const articleProjection=`a.id AS post_id,CASE WHEN ${available} THEN a.title ELSE NULL END AS post_title,(${available}) AS available`;

function query(section:EditorialActivitySection){
  switch(section){
    case 'comments':return {from:`editorial_comment c ${articleRelations}`,where:'c.author_member_id=x.owner',
      at:'c.created_at',id:'c.id',columns:`c.id,c.created_at,${articleProjection},
        CASE WHEN c.deleted_at IS NOT NULL THEN NULL ELSE c.body END AS body,
        CASE WHEN c.deleted_at IS NOT NULL THEN 'deleted' ELSE c.state END AS state,
        c.version,c.parent_id,c.reply_to_id`};
    case 'saves':return {from:`community_reaction r JOIN editorial_article a ON r.post_id=('editorial:'||a.id::text)
        JOIN member m ON m.id=a.author_member_id CROSS JOIN ctx x`,where:"r.member_id=x.owner AND r.kind='save'",
      at:'r.created_at',id:'a.id',columns:`a.id,r.created_at,${articleProjection}`};
    case 'reports':return {from:`editorial_comment_report r JOIN editorial_comment c ON c.id=r.comment_id ${articleRelations}`,
      where:'r.reporter_member_id=x.owner',at:'r.created_at',id:'r.id',
      columns:`r.id,r.created_at,${articleProjection},r.comment_id AS target_id,r.category,r.description,r.state`};
    case 'blocks':return {from:'ugc_block_relation b CROSS JOIN ctx x',where:'b.blocker_member_id=x.owner',
      at:'b.created_at',id:'b.blocked_member_id',columns:'b.blocked_member_id AS id,b.created_at'};
  }
}

/** The member's independent editorial history. This never reads ordinary UGC
 * activity, publishes content or changes the existing interaction contracts. */
export class EditorialActivityService{
  constructor(private pool:pg.Pool,private config:AppConfig,private editorial:EditorialService){}
  async removeSave(memberId:string|undefined,principalId:string|undefined,articleId:unknown){
    if(typeof articleId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(articleId))
      throw new DomainError('EDITORIAL_ACTIVITY_INPUT_INVALID','精选记录编号无效',422);
    const id=articleId.toLowerCase();
    return transaction(this.pool,async client=>{
      const owner=await this.editorial.commentActor(client,memberId,principalId,false);
      const changed=await client.query("DELETE FROM community_reaction WHERE member_id=$1 AND post_id=$2 AND kind='save'",
        [owner,`editorial:${id}`]);
      if(changed.rowCount)await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
        VALUES($1,'editorial.reaction','editorial_article',$2,'EXPLICIT_MEMBER_OR_OWNER_ACTION',$3,$4)`,
        [principalId,id,{kind:'save',active:false,actorMemberId:owner},randomUUID()]);
      return {id,saved:false as const};
    });
  }
  async read(memberId:string|undefined,principalId:string|undefined,section:unknown,input:{limit?:unknown;cursor?:unknown}={}){
    if(typeof section!=='string'||!['comments','saves','reports','blocks'].includes(section))
      throw new DomainError('EDITORIAL_ACTIVITY_SECTION_INVALID','精选记录分类无效',422);
    const kind=section as EditorialActivitySection,limit=pageLimit(input.limit,30,50);
    const scope=pageScope(['editorial-activity',memberId,kind]),cursor=readPageCursor(input.cursor,scope),q=query(kind);
    // commentActor uses the existing canonical identity FOR SHARE guard. A
    // repeatable-read transaction keeps totals and rows consistent, with no
    // business writes and no fresh consent prerequisite for reading history.
    return transaction(this.pool,async client=>{
      const owner=await this.editorial.commentActor(client,memberId,principalId,false);
      const appId=this.config.wechat.appId===CANONICAL_WECHAT_MINIPROGRAM_APP_ID?this.config.wechat.appId:null;
      const rows=(await client.query<Row>(`${context} SELECT ${q.columns},${q.at}::text AS cursor_at
        FROM ${q.from} WHERE ${q.where}
        AND ($3::timestamptz IS NULL OR (${q.at},${q.id})<($3::timestamptz,$4::uuid))
        ORDER BY ${q.at} DESC,${q.id} DESC LIMIT $5`,[owner,appId,cursor?.at??null,cursor?.id??null,limit+1])).rows;
      const matchingTotal=(await client.query<{n:number}>(`${context} SELECT count(*)::int n FROM ${q.from} WHERE ${q.where}`,
        [owner,appId])).rows[0]!.n;
      const page=finishPage(rows.map(row=>({...row,cursorAt:row.cursor_at})),limit,scope);
      const authors=kind==='blocks'?await communityAuthors(client,page.items.map(row=>row.id)):{};
      const items=page.items.map(row=>{
        const common={id:row.id,createdAt:row.created_at};
        if(kind==='blocks')return {...common,source:'shared' as const,memberId:row.id,
          displayName:authors[row.id]?.name??'CISME 会员'};
        const article={...common,source:'editorial' as const,postId:row.post_id!,available:row.available===true};
        if(kind==='saves')return {...article,title:row.post_title??null};
        if(kind==='reports')return {...article,postTitle:row.post_title??null,targetType:'comment' as const,
          targetId:row.target_id!,category:row.category!,description:row.description??null,state:row.state!};
        return {...article,postTitle:row.post_title??null,body:row.body??null,state:row.state!,version:row.version!,
          parentId:row.parent_id??null,replyToId:row.reply_to_id??null};
      });
      return {items,nextCursor:page.nextCursor,matchingTotal,loadedCount:page.loadedCount,hasMore:page.hasMore};
    },'REPEATABLE READ');
  }
}
