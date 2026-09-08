import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AppConfig } from "@cisme/config";
import { DomainError } from "@cisme/domain";
import { transaction } from "./db.js";

// These are the explicitly labelled local brand-preview stories, not public UGC.
const previewPosts = new Set(["brand-scalp-ritual", "brand-night-routine", "brand-care-journal", "brand-roots-check", "brand-product-ritual"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function member(value: string | undefined): string {
  if (!value) throw new DomainError("MEMBER_REQUIRED", "请先登录再参与交流", 401);
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new DomainError("COMMENT_ID_INVALID", "评论编号无效", 422);
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new DomainError("REACTION_INVALID", "请选择明确的互动状态", 422);
  return value;
}
export class CommunityService {
  constructor(private pool: pg.Pool, private config: AppConfig) {}
  enabled(): boolean { return this.config.allowDevAdapters && (this.config.env === "development" || this.config.env === "test"); }
  private assertPost(postId: string): void {
    if (!this.enabled()) throw new DomainError("COMMUNITY_PREVIEW_CLOSED", "社区互动尚未开放", 503);
    if (!previewPosts.has(postId)) throw new DomainError("COMMUNITY_POST_UNAVAILABLE", "这篇内容暂不支持互动", 404);
  }
  async read(postId: string, memberId?: string) {
    this.assertPost(postId);
    const [counts, reactions, comments, commentCount] = await Promise.all([
      this.pool.query("SELECT kind, count(*)::int count FROM community_reaction r JOIN member m ON m.id=r.member_id AND m.status='active' WHERE post_id=$1 GROUP BY kind", [postId]),
      this.pool.query("SELECT kind FROM community_reaction WHERE post_id=$1 AND member_id=$2", [postId, memberId ?? null]),
      this.pool.query(`SELECT c.id, c.body, c.status, c.parent_id AS "parentId", c.reply_to_id AS "replyToId", c.created_at AS "createdAt", m.display_name AS "authorName", c.member_id=$2 AS "isMine",
        reply_author.display_name AS "replyToName", (SELECT count(*)::int FROM community_comment_like l JOIN member lm ON lm.id=l.member_id AND lm.status='active' WHERE l.comment_id=c.id) AS "likeCount",
        EXISTS(SELECT 1 FROM community_comment_like l WHERE l.comment_id=c.id AND l.member_id=$2) AS liked
        FROM community_comment c JOIN member m ON m.id=c.member_id AND m.status='active'
        LEFT JOIN community_comment reply ON reply.id=c.reply_to_id LEFT JOIN member reply_author ON reply_author.id=reply.member_id
        WHERE c.post_id=$1 AND ((c.status='published' OR (c.status='deleted' AND c.was_public)) OR (c.member_id=$2 AND c.status IN ('pending','rejected')))
        ORDER BY c.created_at, c.id LIMIT 500`, [postId, memberId ?? null]),
      this.pool.query("SELECT count(*)::int count FROM community_comment c JOIN member m ON m.id=c.member_id AND m.status='active' WHERE c.post_id=$1 AND c.status='published'", [postId])
    ]);
    return { preview: true, liked: reactions.rows.some(r => r.kind === "like"), saved: reactions.rows.some(r => r.kind === "save"), likeCount: counts.rows.find(r => r.kind === "like")?.count ?? 0, saveCount: counts.rows.find(r => r.kind === "save")?.count ?? 0,
      commentCount: commentCount.rows[0].count, truncated: comments.rows.length === 500,
      comments: comments.rows.map(c => ({ ...c, isMine: Boolean(c.isMine), body: c.status === "deleted" ? "这条评论已删除" : c.body })) };
  }
  async reaction(postId: string, memberId: string | undefined, input: { kind?: unknown; active?: unknown }) {
    this.assertPost(postId);
    const owner = member(memberId), active = boolean(input?.active);
    if (input?.kind !== "like" && input?.kind !== "save") throw new DomainError("REACTION_INVALID", "互动类型无效", 422);
    if (active) await this.pool.query("INSERT INTO community_reaction(member_id,post_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [owner, postId, input.kind]);
    else await this.pool.query("DELETE FROM community_reaction WHERE member_id=$1 AND post_id=$2 AND kind=$3", [owner, postId, input.kind]);
    return this.read(postId, owner);
  }
  async comment(postId: string, memberId: string | undefined, operationId: string, input: { body?: unknown; replyToId?: unknown }) {
    this.assertPost(postId);
    const owner = member(memberId), body = typeof input?.body === "string" ? input.body.trim() : "";
    if (body.length < 2 || body.length > 180) throw new DomainError("COMMENT_BODY_INVALID", "评论请输入 2 至 180 个字", 422);
    const replyId = input.replyToId == null ? null : identifier(input.replyToId);
    await transaction(this.pool, async client => {
      // Serialize retries of the same command, including simultaneous requests.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${owner}:${operationId}`]);
      const old = (await client.query("SELECT * FROM community_comment WHERE member_id=$1 AND operation_id=$2", [owner, operationId])).rows[0];
      if (old) {
        if (old.post_id !== postId || old.body !== body || old.reply_to_id !== replyId) throw new DomainError("IDEMPOTENCY_CONFLICT", "该提交编号已用于另一条评论", 409);
        return;
      }
      let parentId: string | null = null;
      if (replyId) {
        const reply = (await client.query("SELECT c.* FROM community_comment c JOIN member m ON m.id=c.member_id AND m.status='active' WHERE c.id=$1 AND c.post_id=$2 AND c.status='published' FOR SHARE OF c", [replyId, postId])).rows[0];
        if (!reply) throw new DomainError("COMMENT_REPLY_UNAVAILABLE", "这条评论已不可回复，请刷新后重试", 409);
        parentId = reply.parent_id ?? reply.id;
      }
      await client.query("INSERT INTO community_comment(post_id,member_id,body,parent_id,reply_to_id,operation_id) VALUES($1,$2,$3,$4,$5,$6)", [postId, owner, body, parentId, replyId, operationId]);
    });
    return this.read(postId, owner);
  }
  async deleteComment(postId: string, memberId: string | undefined, commentId: string) {
    this.assertPost(postId);
    const owner = member(memberId);
    const result = await this.pool.query("UPDATE community_comment SET status='deleted',body='这条评论已删除' WHERE id=$1 AND post_id=$2 AND member_id=$3 RETURNING id", [identifier(commentId), postId, owner]);
    if (!result.rowCount) throw new DomainError("COMMENT_NOT_FOUND", "只能删除本人的评论", 404);
    return this.read(postId, owner);
  }
  async likeComment(postId: string, memberId: string | undefined, commentId: string, active: unknown) {
    this.assertPost(postId);
    const owner = member(memberId), id = identifier(commentId), next = boolean(active);
    await transaction(this.pool, async client => {
      const visible = await client.query("SELECT c.id FROM community_comment c JOIN member m ON m.id=c.member_id AND m.status='active' WHERE c.id=$1 AND c.post_id=$2 AND c.status='published' FOR SHARE OF c", [id, postId]);
      if (!visible.rowCount) throw new DomainError("COMMENT_NOT_FOUND", "评论已不可互动", 404);
      if (next) await client.query("INSERT INTO community_comment_like(member_id,comment_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [owner, id]);
      else await client.query("DELETE FROM community_comment_like WHERE member_id=$1 AND comment_id=$2", [owner, id]);
    });
    return this.read(postId, owner);
  }
  async review(postId: string, principalId: string, commentId: string, input: { decision?: unknown; reason?: unknown }, traceId: string) {
    this.assertPost(postId);
    if (!["published", "rejected"].includes(String(input?.decision)) || typeof input?.reason !== "string" || input.reason.trim().length < 4) throw new DomainError("REVIEW_INVALID", "审核须提供结论与理由", 422);
    const reason = input.reason.trim();
    return transaction(this.pool, async client => {
      const role = await client.query("SELECT 1 FROM principal_role WHERE principal_id=$1 AND role='review_lead'", [principalId]);
      if (!role.rowCount) throw new DomainError("REVIEW_ROLE_REQUIRED", "需要审核负责人权限", 403);
      const before = (await client.query("SELECT * FROM community_comment WHERE id=$1 AND post_id=$2 FOR UPDATE", [identifier(commentId), postId])).rows[0];
      if (!before || before.status !== "pending") throw new DomainError("COMMENT_REVIEW_CONFLICT", "评论已处理或不存在", 409);
      await client.query("UPDATE community_comment SET status=$2,was_public=($2='published') WHERE id=$1", [commentId, input.decision]);
      await client.query("INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id) VALUES($1,'community_comment_review','community_comment',$2,$3,$4,$5,$6)", [principalId, commentId, reason, JSON.stringify({ status: before.status }), JSON.stringify({ status: input.decision }), traceId || randomUUID()]);
      return { id: commentId, status: input.decision };
    });
  }
}
