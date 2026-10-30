-- Owner's 2026-10-30 rule: comments publish directly. Automated safety patrol
-- and administrator removal remain independent from a pre-publication queue.
ALTER TABLE editorial_comment ALTER COLUMN state SET DEFAULT 'published';
WITH candidates AS MATERIALIZED (
  SELECT c.id,c.parent_id FROM editorial_comment c
  JOIN member m ON m.id=c.author_member_id AND m.status='active'
  JOIN editorial_article a ON a.id=c.article_id AND a.status='published'
  JOIN member author ON author.id=a.author_member_id AND author.status='active'
  WHERE c.state='pending_review' AND c.deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM editorial_comment_safety_scan scan WHERE scan.comment_id=c.id AND scan.state IN ('review','risky'))
), promoted AS (
  UPDATE editorial_comment c SET state='published',version=version+1,updated_at=now()
  FROM candidates candidate WHERE c.id=candidate.id AND (candidate.parent_id IS NULL OR EXISTS(
    SELECT 1 FROM editorial_comment root JOIN member rm ON rm.id=root.author_member_id AND rm.status='active'
    WHERE root.id=candidate.parent_id AND root.deleted_at IS NULL AND (root.state='published' OR root.id IN (SELECT id FROM candidates))))
  RETURNING c.id,c.article_id,c.version
)
INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
SELECT 'migration:202610300002','editorial.comment_direct_publication','editorial_comment',id,
  'OWNER_DIRECT_PUBLICATION_20261030',jsonb_build_object('articleId',article_id,'state','published','version',version),gen_random_uuid()::text FROM promoted;

-- migrate:down
-- Existing publication facts are retained; rollback only restores the default.
ALTER TABLE editorial_comment ALTER COLUMN state SET DEFAULT 'pending_review';
