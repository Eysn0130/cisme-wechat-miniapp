import { communityAuthors } from './memberProfile.js';
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AppConfig } from "@cisme/config";
import { DomainError } from "@cisme/domain";
import { readSnapshot, transaction } from "./db.js";

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
function pageLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new DomainError("PAGE_LIMIT_INVALID", "评论分页大小须为 1 至 100", 422);
  return value;
}
function commentCursor(value: { createdAt: Date | string; id: string }): string {
  return Buffer.from(JSON.stringify([new Date(value.createdAt).toISOString(), value.id])).toString("base64url");
}
function decodeCommentCursor(value: string | undefined): { createdAt: Date; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const createdAt = new Date(String(parsed[0])), id = identifier(parsed[1]);
    if (!Number.isFinite(createdAt.getTime())) throw new Error();
    return { createdAt, id };
  } catch { throw new DomainError("CURSOR_INVALID", "评论分页游标无效", 422); }
}
export class CommunityService {
  constructor(private pool: pg.Pool, private config: AppConfig) {}
  enabled(): boolean { return this.config.allowDevAdapters && (this.config.env === "development" || this.config.env === "test"); }
  private assertPost(postId: string): void {
    if (!this.enabled()) throw new DomainError("COMMUNITY_PREVIEW_CLOSED", "社区互动尚未开放", 503);
    if (!previewPosts.has(postId)) throw new DomainError("COMMUNITY_POST_UNAVAILABLE", "这篇内容暂不支持互动", 404);
  }
  async read(postId: string, memberId?: string, options: { cursor?: string; limit?: number } = {}) {
    this.assertPost(postId);
    const limit = pageLimit(options.limit), cursor = decodeCommentCursor(options.cursor);
    return readSnapshot(this.pool, async (client, asOf) => {
      const summary = await client.query(`SELECT
          COALESCE(s.like_count,0)::int AS "likeCount",COALESCE(s.save_count,0)::int AS "saveCount",
          COALESCE(s.comment_count,0)::int AS "commentCount",COALESCE(s.version,0)::bigint AS "aggregateVersion",
          EXISTS(SELECT 1 FROM community_reaction WHERE post_id=$1 AND member_id=$2 AND kind='like') AS liked,
          EXISTS(SELECT 1 FROM community_reaction WHERE post_id=$1 AND member_id=$2 AND kind='save') AS saved
        FROM (VALUES(1)) singleton(value) LEFT JOIN community_post_stats s ON s.post_id=$1`, [postId, memberId ?? null]);
      const comments = await client.query(`WITH page AS MATERIALIZED (
          SELECT c.* FROM community_comment c JOIN member m ON m.id=c.member_id AND m.status='active'
          WHERE c.post_id=$1 AND ((c.status='published' OR (c.status='deleted' AND c.was_public)) OR (c.member_id=$2 AND c.status IN ('pending','rejected')))
            AND ($3::timestamptz IS NULL OR (c.created_at,c.id) > ($3::timestamptz,$4::uuid))
          ORDER BY c.created_at,c.id LIMIT $5
        ), like_counts AS (
          SELECT l.comment_id,count(*)::int AS count FROM community_comment_like l JOIN page p ON p.id=l.comment_id
          JOIN member lm ON lm.id=l.member_id AND lm.status='active' GROUP BY l.comment_id
        ), mine AS (SELECT l.comment_id FROM community_comment_like l JOIN page p ON p.id=l.comment_id WHERE l.member_id=$2)
        SELECT c.id,c.body,c.status,c.parent_id AS "parentId",c.reply_to_id AS "replyToId",c.created_at AS "createdAt",c.member_id AS "authorId",c.member_id=$2 AS "isMine",
          reply.member_id AS "replyAuthorId",COALESCE(lc.count,0) AS "likeCount",(mine.comment_id IS NOT NULL) AS liked
        FROM page c
        LEFT JOIN community_comment reply ON reply.id=c.reply_to_id LEFT JOIN like_counts lc ON lc.comment_id=c.id LEFT JOIN mine ON mine.comment_id=c.id
        ORDER BY c.created_at,c.id LIMIT $5`, [postId, memberId ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]);
      const rows = comments.rows.slice(0, limit);
      const authors = await communityAuthors(client, rows.flatMap(c => [c.authorId,c.replyAuthorId]));
      const last = comments.rows.length > limit ? rows[rows.length - 1] : null;
      const nextCursor = last ? commentCursor({ createdAt: last.createdAt, id: last.id }) : null;
      const aggregate = summary.rows[0];
      return { preview: true, asOf: asOf.toISOString(), authors, liked: Boolean(aggregate.liked), saved: Boolean(aggregate.saved), likeCount: aggregate.likeCount ?? 0, saveCount: aggregate.saveCount ?? 0,
        commentCount: aggregate.commentCount ?? 0, aggregateVersion: Number(aggregate.aggregateVersion ?? 0), truncated: Boolean(nextCursor), nextCursor,
        comments: rows.map(c => ({ ...c, authorName: c.status === "deleted" ? "CISME 会员" : authors[c.authorId]?.name || "CISME 会员", replyToName: c.replyAuthorId ? authors[c.replyAuthorId]?.name || "CISME 会员" : null, isMine: Boolean(c.isMine), body: c.status === "deleted" ? "这条评论已删除" : c.body })) };
    });
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
