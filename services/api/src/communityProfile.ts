import type pg from 'pg';
import { CANONICAL_WECHAT_MINIPROGRAM_APP_ID, type AppConfig } from '@cisme/config';
import type { CommunityAuthorPage } from '@cisme/contracts';
import { DomainError } from '@cisme/domain';
import { readSnapshot, transaction } from './db.js';
import { communityAuthors } from './memberProfile.js';
import type { EditorialService } from './editorial.js';
import type { FormalUgcService } from './formalUgc.js';
import type { UgcSafetyService } from './ugcSafety.js';
import {officialPublisher} from './editorialPublisher.js';
import type {AuthorityService} from './authority.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable=()=>new DomainError('COMMUNITY_AUTHOR_NOT_FOUND','作者暂不可见',404);

/** One native profile for its owner and visitors. Only published, currently
 * visible stories are counted; drafts and moderation facts never enter it. */
export class CommunityProfileService {
  constructor(private pool:pg.Pool,private config:AppConfig,private editorial:EditorialService,
    private ugc:FormalUgcService,private safety:UgcSafetyService,private authority:AuthorityService){}

  async page(memberId:string|undefined,authorId:string|undefined,input:{limit?:unknown;cursor?:unknown}={}):Promise<CommunityAuthorPage>{
    if(!authorId||!uuid.test(authorId))throw unavailable();
    if(authorId===officialPublisher.id){
      const page=await this.editorial.author(memberId,authorId,input);
      const profile=(await this.pool.query('SELECT biography,profile_revision FROM editorial_publisher WHERE id=$1',[officialPublisher.key])).rows[0];
      if(!profile)throw unavailable();
      const canManage=await this.editorial.canManage(memberId);
      return {author:{...page.author,accountType:'official',name:officialPublisher.name,avatar:officialPublisher.avatar,
        avatarRevision:null,membershipLabel:'CISME官方',bio:profile.biography,bioRevision:canManage?profile.profile_revision:null,isMine:false,canManage,canFollow:true,
        followArticleId:page.items[0]?.id??null},
        items:page.items.map(item=>({...item,kind:'editorial',avatar:officialPublisher.avatar,avatarRevision:null})),
        nextCursor:page.nextCursor};
    }
    const limit=input.limit===undefined?20:Number(input.limit);
    if(!Number.isSafeInteger(limit)||limit<1||limit>30)throw new DomainError('COMMUNITY_AUTHOR_PAGE_INVALID','请重新加载作者主页',422);
    let cursor:{at:string;kind:string;id:string}|null=null;
    if(input.cursor!==undefined){try{
      if(typeof input.cursor!=='string'||input.cursor.length>1000)throw new Error();
      const value=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));
      if(!Array.isArray(value)||value.length!==6||value[0]!==1||value[1]!==authorId||value[2]!== (memberId??null)||
        typeof value[3]!=='string'||value[3].length>80||!Number.isFinite(Date.parse(value[3]))||
        !['editorial','formal','ugc'].includes(value[4])||typeof value[5]!=='string'||!uuid.test(value[5]))throw new Error();
      cursor={at:value[3],kind:value[4],id:value[5]};
    }catch{throw new DomainError('COMMUNITY_AUTHOR_PAGE_INVALID','分页已失效，请重新加载作者主页',422);}}
    const publicEnabled=await this.ugc.publicEnabled();
    return readSnapshot(this.pool,async client=>{
      const member=(await client.query(`SELECT m.id,m.display_name,p.avatar_data_url,p.avatar_revision,
        COALESCE(p.community_bio,'') AS bio,COALESCE(p.community_bio_revision,0) AS bio_revision,
        EXISTS(SELECT 1 FROM community_follow f WHERE f.member_id=$2 AND f.author_id=m.id::text)
          OR EXISTS(SELECT 1 FROM ugc_author_follow f WHERE f.follower_member_id=$2 AND f.followed_member_id=m.id) AS following
        FROM member m LEFT JOIN member_profile p ON p.member_id=m.id WHERE m.id=$1 AND m.status='active'
          AND NOT EXISTS(SELECT 1 FROM ugc_block_relation b WHERE b.blocker_member_id=$2 AND b.blocked_member_id=m.id)`,
        [authorId,memberId??null])).rows[0];
      if(!member)throw unavailable();
      const summary=(await client.query(`WITH posts AS (
        SELECT 'editorial'::text AS kind,a.id,a.title,a.excerpt,a.published_at,a.author_display_name AS editorial_author,
          CASE WHEN jsonb_array_length(a.media)>0 THEN '/v1/editorial/media/'||a.id::text||'/'||
            COALESCE(a.media->0->'poster'->>'sha256',a.media->0->>'sha256') END AS cover_url,
          COALESCE(s.like_count,0)::int AS like_count
        FROM editorial_article a LEFT JOIN community_post_stats s ON s.post_id=('editorial:'||a.id::text)
        WHERE a.author_member_id=$1 AND a.publisher_id IS NULL AND a.status='published' AND EXISTS(SELECT 1 FROM wechat_identity w
          WHERE w.member_id=a.author_member_id AND w.provider='wechat_miniprogram' AND w.adapter='wechat' AND w.app_id=$3)
        UNION ALL
        SELECT 'formal',p.id,COALESCE(NULLIF(r.title,''),NULLIF(left(r.body,40),''),'图片护理故事'),left(r.body,100),
          p.published_at,NULL,(SELECT '/v1/ugc/media/'||m.media_asset_id::text||'?variant=thumbnail' FROM ugc_post_media m
            WHERE m.post_id=p.id AND m.revision=p.published_revision ORDER BY m.position LIMIT 1),
          (SELECT count(*)::int FROM ugc_post_reaction x WHERE x.post_id=p.id AND x.kind='like')
        FROM ugc_post p JOIN ugc_post_revision r ON r.post_id=p.id AND r.revision=p.published_revision
        WHERE p.author_member_id=$1 AND $2::boolean AND p.state='published' AND p.visibility='public'
        UNION ALL
        SELECT 'ugc',f.id,f.title,f.excerpt,f.published_at,NULL,NULL,
          COALESCE((SELECT c.like_count FROM community_post_stats c WHERE c.post_id=f.id::text),0)::int
        FROM feed_item f JOIN submission s ON s.id=f.submission_id WHERE s.member_id=$1 AND $2::boolean AND f.visible
      ), page AS (
        SELECT *,published_at::text AS cursor_at FROM posts
        WHERE ($4::timestamptz IS NULL OR (published_at,kind,id)<($4::timestamptz,$5::text,$6::uuid))
        ORDER BY published_at DESC,kind DESC,id DESC LIMIT $7
      ) SELECT (SELECT count(*)::int FROM posts) AS post_count,
        (SELECT count(*)::int FROM posts WHERE kind='formal') AS formal_count,
        (SELECT id FROM posts WHERE kind='editorial' ORDER BY published_at DESC,id DESC LIMIT 1) AS follow_article_id,
        COALESCE((SELECT jsonb_agg(page ORDER BY published_at DESC,kind DESC,id DESC) FROM page),'[]'::jsonb) AS items`,
        [authorId,publicEnabled,this.config.wechat.appId===CANONICAL_WECHAT_MINIPROGRAM_APP_ID?this.config.wechat.appId:null,
          cursor?.at??null,cursor?.kind??null,cursor?.id??null,limit+1])).rows[0];
      const isMine=memberId===authorId;
      if(!isMine&&!summary.post_count)throw unavailable();
      const publicAuthor=(await communityAuthors(client,[authorId]))[authorId];
      const personalName=(isMine?member.display_name:publicAuthor?.name)||'CISME 会员';
      const avatar=isMine?member.avatar_data_url||'':publicAuthor?.avatar||'';
      const rows=summary.items.slice(0,limit),last=rows.at(-1);
      return {author:{id:authorId,accountType:'member',name:personalName,avatar,avatarRevision:isMine?member.avatar_revision??null:publicAuthor?.avatarRevision??null,
        membershipLabel:'CISME会员',bio:member.bio,bioRevision:isMine?member.bio_revision:null,
        postCount:summary.post_count,following:member.following===true,isMine,canManage:false,canFollow:Boolean(summary.follow_article_id||summary.formal_count),followArticleId:summary.follow_article_id??null},
        items:rows.map((row:any)=>({id:row.id,kind:row.kind,authorId,author:row.editorial_author||personalName,avatar,
          avatarRevision:isMine?member.avatar_revision??null:publicAuthor?.avatarRevision??null,
          title:row.title,excerpt:row.excerpt,coverUrl:row.cover_url,publishedAt:new Date(row.published_at).toISOString(),likeCount:row.like_count})),
        nextCursor:summary.items.length>limit&&last?Buffer.from(JSON.stringify([1,authorId,memberId??null,last.cursor_at,last.kind,last.id])).toString('base64url'):null};
    });
  }

  async updateOfficialBio(memberId:string|undefined,principalId:string|undefined,input:{bio?:unknown;expectedVersion?:unknown}){
    if(!memberId)throw new DomainError('AUTH_REQUIRED','请先登录会员账号',401);
    const bio=this.biography(input);
    await readSnapshot(this.pool,client=>this.editorial.commentReader(client,memberId,principalId));
    if(!await this.editorial.canManage(memberId))throw new DomainError('CAPABILITY_REQUIRED','需要已授予的官方内容管理权限',403);
    if(bio)await this.safety.checkProfileBio(memberId,bio);
    return transaction(this.pool,async client=>{
      const owner=await this.editorial.commentActor(client,memberId,principalId);
      await this.authority.requireWithClient(client,owner,'editorial.manage');
      const row=(await client.query(`UPDATE editorial_publisher SET biography=$2,profile_revision=profile_revision+1
        WHERE id=$1 AND profile_revision=$3 RETURNING biography AS bio,profile_revision AS "bioRevision"`,
        [officialPublisher.key,bio,input.expectedVersion])).rows[0];
      if(!row)throw new DomainError('COMMUNITY_BIO_CHANGED','简介已在其他页面更新，请重新加载后修改',409);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
        VALUES($1,'editorial.publisher_bio_updated','editorial_publisher',$2,'EXPLICIT_AUTHORIZED_PUBLISHER_EDIT',$3,gen_random_uuid()::text)`,
        [principalId,officialPublisher.id,{actorMemberId:owner,revision:row.bioRevision}]);
      return row;
    });
  }

  private biography(input:{bio?:unknown;expectedVersion?:unknown}){
    if(typeof input?.bio!=='string'||Array.from(input.bio.trim()).length>120||
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(input.bio)||
      !Number.isSafeInteger(input.expectedVersion)||Number(input.expectedVersion)<0||Number(input.expectedVersion)>=2147483647)
      throw new DomainError('COMMUNITY_BIO_INVALID','简介最多120字，请检查后重试',422);
    return input.bio.trim();
  }

  async updateBio(memberId:string|undefined,principalId:string|undefined,input:{bio?:unknown;expectedVersion?:unknown}){
    if(!memberId)throw new DomainError('AUTH_REQUIRED','请先登录会员账号',401);
    const bio=this.biography(input);
    // Never hold member locks across a network call. Authority and the version
    // are checked again in the write transaction after the exact text is safe.
    await readSnapshot(this.pool,client=>this.editorial.commentReader(client,memberId,principalId));
    if(bio)await this.safety.checkProfileBio(memberId,bio);
    return transaction(this.pool,async client=>{
      const owner=await this.editorial.commentActor(client,memberId,principalId);
      const row=(await client.query(`INSERT INTO member_profile(member_id,handle_source,community_bio,community_bio_revision)
        SELECT $1,'self_reported',$2,1 WHERE $3::integer=0 OR EXISTS(SELECT 1 FROM member_profile WHERE member_id=$1)
        ON CONFLICT(member_id) DO UPDATE SET community_bio=$2,community_bio_revision=member_profile.community_bio_revision+1,updated_at=now()
        WHERE member_profile.community_bio_revision=$3 RETURNING community_bio AS bio,community_bio_revision AS "bioRevision"`,
        [owner,bio,input.expectedVersion])).rows[0];
      if(!row)throw new DomainError('COMMUNITY_BIO_CHANGED','简介已在其他页面更新，请重新加载后修改',409);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,trace_id)
        VALUES($1,'member.community_bio_updated','member',$2,'OWNER_EXPLICIT_PUBLIC_BIO',gen_random_uuid()::text)`,[principalId,owner]);
      return row;
    });
  }
}
