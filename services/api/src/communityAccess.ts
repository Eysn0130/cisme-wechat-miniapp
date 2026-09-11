import type pg from 'pg';
import type { AppConfig } from '@cisme/config';
import { DomainError } from '@cisme/domain';
import type { AuthorityService } from './authority.js';

export class CommunityAccess {
  constructor(private pool: pg.Pool, private config: AppConfig, private authority: AuthorityService) {}
  private assertSocialPreview(): void {
    if (!this.config.allowDevAdapters || (this.config.env !== 'development' && this.config.env !== 'test')) {
      throw new DomainError('COMMUNITY_PREVIEW_CLOSED', '社区关注尚未开放', 503);
    }
  }
  async capabilities(memberId: string | undefined) {
    const projection = await this.authority.projection(memberId);
    const canReview = projection.capabilities.includes('community.moderate');
    return { canReview, teamRole: canReview ? 'community.moderate' : null };
  }
  async teamPrincipal(memberId: string | undefined, principalId: string | undefined): Promise<string> {
    // The verified session binds principalId to memberId. Business authority is
    // evaluated from the environment-scoped grant on every sensitive request;
    // legacy member_team_access rows cannot grant management access.
    await this.authority.require(memberId, 'community.moderate');
    if (!principalId) throw new DomainError('TEAM_ACCESS_REQUIRED', '仅授权管理员可审核', 403);
    return principalId;
  }
  async follows(memberId: string | undefined): Promise<string[]> {
    this.assertSocialPreview();
    const result = await this.pool.query('SELECT author_id FROM community_follow WHERE member_id=$1 ORDER BY created_at DESC', [memberId]);
    return result.rows.map(row => row.author_id);
  }
  async follow(memberId: string | undefined, authorId: string, active: unknown) {
    this.assertSocialPreview();
    if (typeof active !== 'boolean') throw new DomainError('FOLLOW_INVALID', '关注状态无效', 422);
    if (authorId !== 'brand:cisme') {
      if (!/^[0-9a-f-]{36}$/.test(authorId) || authorId === memberId) throw new DomainError('AUTHOR_INVALID', '作者不可关注', 422);
      const author = await this.pool.query(`SELECT 1 FROM feed_item f JOIN submission s ON s.id=f.submission_id WHERE f.visible=true AND s.member_id=$1 LIMIT 1`, [authorId]);
      if (!author.rowCount) throw new DomainError('AUTHOR_UNAVAILABLE', '作者暂不可关注', 404);
    }
    if (active) await this.pool.query('INSERT INTO community_follow(member_id,author_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[memberId,authorId]);
    else await this.pool.query('DELETE FROM community_follow WHERE member_id=$1 AND author_id=$2',[memberId,authorId]);
    return { authorId, following: active };
  }
}
