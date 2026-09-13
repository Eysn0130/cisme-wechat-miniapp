import type pg from 'pg';
import { DomainError } from '@cisme/domain';
import { transaction } from './db.js';
import { normalizeMemberAvatar } from './memberAvatar.js';
import { createHash } from 'node:crypto';
import type { AppEnvironment } from '@cisme/config';

export interface MemberProfileInput {
  displayName?: unknown; wechatHandle?: unknown; avatarDataUrl?: unknown;
  communityVisible?: unknown; expectedVersion?: unknown;
}

export class MemberProfile {
  constructor(private pool: pg.Pool,private environment:AppEnvironment='test') {}
  async get(memberId: string | undefined) {
    if (!memberId) throw new DomainError('AUTH_REQUIRED', '请先登录会员账号', 401);
    const row = await this.pool.query(`SELECT m.id, m.display_name, p.wechat_handle, p.handle_source,
      p.avatar_data_url, p.avatar_revision, COALESCE(p.profile_revision,0) AS profile_revision,
      p.completed_at, COALESCE(p.community_visible,false) AS community_visible,
      COALESCE(p.public_status,'private') AS public_status, p.public_review_note
      FROM member m LEFT JOIN member_profile p ON p.member_id=m.id WHERE m.id=$1 AND m.status='active'`, [memberId]);
    if (!row.rows[0]) throw new DomainError('MEMBER_NOT_FOUND', '会员不存在或已停用', 404);
    return row.rows[0];
  }
  async update(memberId: string | undefined, input: MemberProfileInput) {
    if (!memberId) throw new DomainError('AUTH_REQUIRED', '请先登录会员账号', 401);
    const name = typeof input?.displayName === 'string' ? input.displayName.trim() : '';
    const handle = typeof input?.wechatHandle === 'string' ? input.wechatHandle.trim() : '';
    if (!name || Array.from(name).length > 40 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name) || (handle && !/^[A-Za-z][A-Za-z0-9_-]{5,19}$/.test(handle))) {
      throw new DomainError('MEMBER_PROFILE_INVALID', '请填写 1–40 字昵称；微信号为字母开头的 6–20 位字母、数字、下划线或减号', 422);
    }
    if (input.communityVisible !== undefined && typeof input.communityVisible !== 'boolean') throw new DomainError('PROFILE_VISIBILITY_INVALID', '请选择社区展示范围', 422);
    if (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 0)) throw new DomainError('PROFILE_VERSION_INVALID', '请刷新资料后重试', 422);
    const avatar = input.avatarDataUrl === undefined ? undefined : normalizeMemberAvatar(input.avatarDataUrl);
    await transaction(this.pool, async client => {
      const member = (await client.query("SELECT display_name FROM member WHERE id=$1 AND status='active' FOR UPDATE", [memberId])).rows[0];
      if (!member) throw new DomainError('AUTH_REVOKED', '会员账号不可用', 401);
      const previous = (await client.query('SELECT * FROM member_profile WHERE member_id=$1', [memberId])).rows[0];
      const version = previous?.profile_revision ?? 0;
      if (input.expectedVersion !== undefined && input.expectedVersion !== version) throw new DomainError('PROFILE_CHANGED', '资料已在其他页面更新，请重新加载后修改', 409);
      const avatarData = avatar === undefined ? previous?.avatar_data_url ?? null : avatar?.dataUrl ?? null;
      const avatarRevision = avatar === undefined ? previous?.avatar_revision ?? null : avatar?.revision ?? null;
      const visible = input.communityVisible ?? previous?.community_visible ?? false;
      const publicChanged = member.display_name !== name || avatarRevision !== (previous?.avatar_revision ?? null) || visible !== (previous?.community_visible ?? false);
      const publicStatus = !visible ? 'private' : publicChanged || !previous || previous.public_status === 'private' ? 'pending' : previous.public_status;
      await client.query('UPDATE member SET display_name=$2 WHERE id=$1', [memberId, name]);
      await client.query(`INSERT INTO member_profile(member_id,wechat_handle,handle_source,avatar_data_url,avatar_revision,profile_revision,completed_at,community_visible,public_status)
        VALUES($1,$2,'self_reported',$3,$4,1,now(),$5,$6)
        ON CONFLICT(member_id) DO UPDATE SET
          wechat_handle=CASE WHEN $7 THEN $2 ELSE member_profile.wechat_handle END,
          handle_source=CASE WHEN NOT $7 OR member_profile.wechat_handle IS NOT DISTINCT FROM $2 THEN member_profile.handle_source ELSE 'self_reported' END,
          avatar_data_url=$3,avatar_revision=$4,profile_revision=member_profile.profile_revision+1,completed_at=COALESCE(member_profile.completed_at,now()),
          community_visible=$5,public_status=$6,public_review_note=CASE WHEN $8 THEN NULL ELSE member_profile.public_review_note END,
          public_reviewed_by=CASE WHEN $8 THEN NULL ELSE member_profile.public_reviewed_by END,
          public_reviewed_at=CASE WHEN $8 THEN NULL ELSE member_profile.public_reviewed_at END,updated_at=now()`,
        [memberId, handle || null, avatarData, avatarRevision, visible, publicStatus, input.wechatHandle !== undefined, publicChanged]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,trace_id)
        VALUES($1,'member.profile_updated','member',$2,$3,gen_random_uuid()::text)`,
        [`member:${memberId}`, memberId, visible ? 'USER_PROFILE_COMMUNITY_REQUEST' : 'USER_PROFILE_PRIVATE']);
    });
    return this.get(memberId);
  }
  async queue() {
    return (await this.pool.query(`SELECT p.member_id,m.display_name,p.avatar_data_url,p.avatar_revision,p.profile_revision,p.updated_at
      FROM member_profile p JOIN member m ON m.id=p.member_id AND m.status='active'
      WHERE p.community_visible AND p.public_status='pending' ORDER BY p.updated_at,p.member_id LIMIT 50`)).rows;
  }
  async review(reviewerMemberId: string | undefined, principalId: string, memberId: string, input: { decision?: unknown; expectedVersion?: unknown; reason?: unknown }) {
    if (reviewerMemberId === memberId) throw new DomainError('PROFILE_SELF_REVIEW_FORBIDDEN', '请由另一名审核员审核自己的社区资料', 403);
    if (!['approve','reject'].includes(String(input?.decision)) || !Number.isSafeInteger(input?.expectedVersion) || typeof input?.reason !== 'string' || input.reason.trim().length < 2 || input.reason.trim().length > 200) throw new DomainError('PROFILE_REVIEW_INVALID', '请填写审核结论与 2–200 字依据', 422);
    const reason = input.reason.trim();
    return transaction(this.pool, async client => {
      // Profile edits acquire member then profile. Keep that order here to
      // avoid a review/edit lock inversion during a nickname revision.
      const account=(await client.query("SELECT display_name FROM member WHERE id=$1 AND status='active' FOR UPDATE",[memberId])).rows[0];
      const current = (await client.query(`SELECT p.* FROM member_profile p JOIN member m ON m.id=p.member_id AND m.status='active' WHERE p.member_id=$1 FOR UPDATE OF p`, [memberId])).rows[0];
      if (!current || !current.community_visible || current.public_status !== 'pending' || current.profile_revision !== input.expectedVersion) throw new DomainError('PROFILE_REVIEW_CHANGED', '资料或审核状态已变化，请刷新后复核', 409);
      if(input.decision==='approve'&&this.environment!=='test'){
        const sha=createHash('sha256').update(String(account?.display_name??'')).digest('hex');
        const safe=(await client.query(`SELECT 1 FROM ugc_nickname_safety_scan
          WHERE member_id=$1 AND profile_revision=$2 AND name_sha256=$3 AND provider='wechat_v2' AND state='safe'`,
          [memberId,current.profile_revision,sha])).rowCount;
        if(!safe)throw new DomainError('UGC_NICKNAME_SCAN_REQUIRED','新昵称的安全检测尚未通过',409);
      }
      const status = input.decision === 'approve' ? 'approved' : 'rejected';
      await client.query('UPDATE member_profile SET public_status=$2,public_review_note=$3,public_reviewed_by=$4,public_reviewed_at=now() WHERE member_id=$1', [memberId, status, reason, principalId]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,trace_id) VALUES($1,$2,'member',$3,'COMMUNITY_PROFILE_REVIEW',gen_random_uuid()::text)`, [principalId, `member.profile_${status}`, memberId]);
      return { memberId, status };
    });
  }
}

// Only this allowlist may be projected into public community data. Contact
// handles, phone fields, OpenID and internal review reasons never leave here.
export async function communityAuthors(pool: pg.Pool | pg.PoolClient, memberIds: string[]) {
  const ids = [...new Set(memberIds)].filter(Boolean).slice(0,500);
  if (!ids.length) return {} as Record<string,{ name:string; avatar:string; avatarRevision:string | null }>;
  const result = await pool.query(`SELECT m.id,
    CASE WHEN p.community_visible AND p.public_status='approved' THEN m.display_name ELSE 'CISME 会员' END AS name,
    CASE WHEN p.community_visible AND p.public_status='approved' THEN p.avatar_data_url END AS avatar,
    CASE WHEN p.community_visible AND p.public_status='approved' THEN p.avatar_revision END AS revision
    FROM member m LEFT JOIN member_profile p ON p.member_id=m.id WHERE m.id=ANY($1::uuid[]) AND m.status='active'`,[ids]);
  return Object.fromEntries(result.rows.map((row,index)=>[row.id,{name:row.name,avatar:index < 50 ? row.avatar || '' : '',avatarRevision:index < 50 ? row.revision || null : null}]));
}
