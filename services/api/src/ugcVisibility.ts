// SQL predicates use the p=ugc_post and r=ugc_post_revision aliases. Every
// reviewer-facing read and scanner source must agree on this revision boundary.
export const reviewableRevisionSql=`p.state IN ('pending_review','published')
  AND r.moderation_state IN ('pending','approved')
  AND p.current_revision=r.revision
  AND (p.published_revision IS NULL OR p.current_revision<>p.published_revision)`;

export const pendingReviewRevisionSql=`${reviewableRevisionSql} AND r.moderation_state='pending'`;
