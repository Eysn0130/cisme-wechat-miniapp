import {DomainError} from '@cisme/domain';
import type {DbClient} from './db.js';

// Keep the reward-selection fact separate from the reversible feed placement.
export const featuredPostSql="(p.featured_at IS NOT NULL AND p.featured_revision=p.published_revision)";

export async function featureCommunityPost(client:DbClient,actor:string,postId:string,reason:string,expectedVersion?:number,at?:Date){
  const post=(await client.query(`SELECT p.* FROM ugc_post p JOIN member m ON m.id=p.author_member_id
    WHERE p.id=$1 AND p.state='published' AND p.visibility='public' AND m.status='active' FOR UPDATE OF p`,[postId])).rows[0];
  if(!post)throw new DomainError('POINTS_FEATURE_POST_UNAVAILABLE','只能精选当前公开的会员帖子',409);
  if(post.author_member_id===actor)throw new DomainError('UGC_SELF_REVIEW_FORBIDDEN','本人的帖子需由另一位管理员精选',403);
  if(post.featured_at&&post.featured_revision===post.published_revision)
    return {id:postId,selected:true,replayed:true,version:post.version};
  if(expectedVersion!==undefined&&post.version!==expectedVersion)
    throw new DomainError('UGC_VERSION_CONFLICT','帖子已变化，请刷新后重试',409);
  const now=at??(await client.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  const first=(await client.query(`INSERT INTO member_points_featured(post_id,selected_by,selected_at,reason)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING post_id`,[postId,actor,now,reason])).rowCount;
  if(first)await client.query(`INSERT INTO member_points_source_event(kind,source_id,member_id,occurred_at)
    VALUES('featured',$1,$2,$3) ON CONFLICT DO NOTHING`,[postId,post.author_member_id,now]);
  await client.query(`UPDATE ugc_post SET featured_revision=published_revision,featured_at=$2,featured_by=$3,
    version=version+1,updated_at=now() WHERE id=$1`,[postId,now,actor]);
  await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
    VALUES($1,'ugc.post_featured','ugc_post',$2,'ADMIN_FEATURED_PUBLIC_REVISION',$3,$4,gen_random_uuid()::text)`,
    [`member:${actor}`,postId,{version:post.version},{revision:post.published_revision,version:post.version+1,reason}]);
  return {id:postId,selected:true,replayed:false,version:post.version+1};
}
