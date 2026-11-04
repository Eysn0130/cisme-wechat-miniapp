import type pg from "pg";
import { CANONICAL_WECHAT_MINIPROGRAM_APP_ID, type AppConfig } from "@cisme/config";
import type { CommunityFollowingPage } from "@cisme/contracts";
import { DomainError } from "@cisme/domain";
import { readSnapshot } from "./db.js";
import type { EditorialService } from "./editorial.js";
import type { FormalUgcService } from "./formalUgc.js";
import { communityAuthors } from "./memberProfile.js";
import {editorialPublicAuthorIdSql} from './editorialPublisher.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const kinds = ["editorial", "formal", "ugc"] as const;
type Kind = typeof kinds[number];

export class CommunityFollowingService {
  constructor(private pool: pg.Pool, private config: AppConfig,
    private editorial: EditorialService, private ugc: FormalUgcService) {}

  async page(memberId: string | undefined, principalId: string | undefined,
    input: { limit?: unknown; cursor?: unknown } = {}): Promise<CommunityFollowingPage> {
    const limit = input.limit === undefined ? 30 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 30)
      throw new DomainError("FOLLOWING_PAGE_INVALID", "请重新加载关注内容", 422);
    let cursor: { at: string; kind: Kind; id: string } | null = null;
    if (input.cursor !== undefined) {
      try {
        if (typeof input.cursor !== "string" || input.cursor.length > 1000) throw new Error();
        const value = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
        if (!Array.isArray(value) || value.length !== 4 || value[3] !== memberId ||
          typeof value[0] !== "string" || value[0].length > 80 || !Number.isFinite(Date.parse(value[0])) ||
          !kinds.includes(value[1]) || typeof value[2] !== "string" || !uuid.test(value[2])) throw new Error();
        cursor = { at: value[0], kind: value[1], id: value[2] };
      } catch { throw new DomainError("FOLLOWING_PAGE_INVALID", "关注分页已失效，请下拉刷新", 422); }
    }
    const publicEnabled = await this.ugc.publicEnabled();
    return readSnapshot(this.pool, async client => {
      const owner = await this.editorial.commentReader(client, memberId, principalId);
      const result = await client.query(`WITH followed AS (
        SELECT CASE WHEN author_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN author_id::uuid END AS author_id FROM community_follow WHERE member_id=$1
        UNION SELECT followed_member_id FROM ugc_author_follow WHERE follower_member_id=$1
      ), posts AS (
        SELECT 'editorial'::text AS kind,a.id,(${editorialPublicAuthorIdSql}) AS author_id,a.title,a.excerpt,a.published_at,
          a.author_display_name AS editorial_author,
          CASE WHEN jsonb_array_length(a.media)>0 THEN '/v1/editorial/media/'||a.id::text||'/'||
            COALESCE(a.media->0->'poster'->>'sha256',a.media->0->>'sha256') END AS cover_url,
          COALESCE(s.like_count,0)::int AS like_count
        FROM editorial_article a LEFT JOIN community_post_stats s ON s.post_id=('editorial:'||a.id::text)
        WHERE a.status='published' AND EXISTS(SELECT 1 FROM member m WHERE m.id=a.author_member_id AND m.status='active')
          AND EXISTS(SELECT 1 FROM wechat_identity w WHERE w.member_id=a.author_member_id
          AND w.provider='wechat_miniprogram' AND w.adapter='wechat' AND w.app_id=$3)
        UNION ALL
        SELECT 'formal',p.id,p.author_member_id,COALESCE(NULLIF(r.title,''),NULLIF(left(r.body,40),''),'图片护理故事'),
          left(r.body,100),p.published_at,NULL,
          (SELECT '/v1/ugc/media/'||m.media_asset_id::text||'?variant=thumbnail' FROM ugc_post_media m
            WHERE m.post_id=p.id AND m.revision=p.published_revision ORDER BY m.position LIMIT 1),
          (SELECT count(*)::int FROM ugc_post_reaction x WHERE x.post_id=p.id AND x.kind='like')
        FROM ugc_post p JOIN ugc_post_revision r ON r.post_id=p.id AND r.revision=p.published_revision
        WHERE $2::boolean AND p.state='published' AND p.visibility='public'
        UNION ALL
        SELECT 'ugc',f.id,s.member_id,f.title,f.excerpt,f.published_at,NULL,NULL,
          COALESCE((SELECT c.like_count FROM community_post_stats c WHERE c.post_id=f.id::text),0)::int
        FROM feed_item f JOIN submission s ON s.id=f.submission_id WHERE $2::boolean AND f.visible
      ) SELECT p.*,p.published_at::text AS cursor_at FROM posts p
        JOIN followed f ON f.author_id=p.author_id
        WHERE (p.kind='editorial' OR EXISTS(SELECT 1 FROM member m WHERE m.id=p.author_id AND m.status='active'))
          AND NOT EXISTS(SELECT 1 FROM ugc_block_relation b WHERE b.blocker_member_id=$1 AND b.blocked_member_id=p.author_id)
          AND ($4::timestamptz IS NULL OR (p.published_at,p.kind,p.id)<($4::timestamptz,$5::text,$6::uuid))
        ORDER BY p.published_at DESC,p.kind DESC,p.id DESC LIMIT $7`, [owner, publicEnabled,
        this.config.wechat.appId === CANONICAL_WECHAT_MINIPROGRAM_APP_ID ? this.config.wechat.appId : null,
        cursor?.at ?? null, cursor?.kind ?? null, cursor?.id ?? null, limit + 1]);
      const rows = result.rows.slice(0, limit), last = rows[rows.length - 1];
      const authors = await communityAuthors(client, rows.filter(row => row.kind !== "editorial").map(row => row.author_id));
      return { items: rows.map(row => ({ kind: row.kind, id: row.id, authorId: row.author_id,
        author: row.kind === "editorial" ? row.editorial_author : authors[row.author_id]?.name ?? "CISME 会员",
        avatar: row.kind === "editorial" ? "" : authors[row.author_id]?.avatar ?? "",
        avatarRevision: row.kind === "editorial" ? null : authors[row.author_id]?.avatarRevision ?? null,
        title: row.title, excerpt: row.excerpt, coverUrl: row.cover_url,
        publishedAt: row.published_at.toISOString(), likeCount: row.like_count })),
        nextCursor: result.rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.cursor_at, last.kind, last.id, owner])).toString("base64url") : null };
    });
  }
}
