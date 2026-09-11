-- Exact transactional counters for the community hotspot. Reading counts by
-- scanning every reaction/comment made one popular post consume database CPU
-- linearly with audience size. These counters remain PostgreSQL-authoritative:
-- the same transaction that changes an interaction changes its counters.
CREATE TABLE community_post_stats (
  post_id text PRIMARY KEY,
  like_count integer NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  save_count integer NOT NULL DEFAULT 0 CHECK (save_count >= 0),
  comment_count integer NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Prevent a write from landing between the backfill snapshot and trigger
-- installation. Reads continue; interaction/member-status writes wait for this
-- migration transaction to commit.
LOCK TABLE member,community_reaction,community_comment IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO community_post_stats(post_id, like_count, save_count, comment_count)
SELECT post_id,
  count(*) FILTER (WHERE source='reaction' AND kind='like')::int,
  count(*) FILTER (WHERE source='reaction' AND kind='save')::int,
  count(*) FILTER (WHERE source='comment')::int
FROM (
  SELECT r.post_id,'reaction'::text AS source,r.kind
  FROM community_reaction r JOIN member m ON m.id=r.member_id AND m.status='active'
  UNION ALL
  SELECT c.post_id,'comment'::text AS source,NULL::text AS kind
  FROM community_comment c JOIN member m ON m.id=c.member_id AND m.status='active'
  WHERE c.status='published'
) interactions
GROUP BY post_id;

CREATE FUNCTION adjust_community_post_stats(target_post_id text, likes integer, saves integer, comments integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE community_post_stats SET
    like_count=like_count+likes,save_count=save_count+saves,comment_count=comment_count+comments,
    version=version+1,updated_at=clock_timestamp()
  WHERE post_id=target_post_id;
  IF FOUND THEN RETURN; END IF;
  IF likes<0 OR saves<0 OR comments<0 THEN
    RAISE EXCEPTION 'COMMUNITY_POST_STATS_UNDERFLOW:%',target_post_id USING ERRCODE='23514';
  END IF;
  INSERT INTO community_post_stats(post_id,like_count,save_count,comment_count,version,updated_at)
  VALUES(target_post_id,likes,saves,comments,1,clock_timestamp())
  ON CONFLICT(post_id) DO UPDATE SET
    like_count=community_post_stats.like_count+EXCLUDED.like_count,
    save_count=community_post_stats.save_count+EXCLUDED.save_count,
    comment_count=community_post_stats.comment_count+EXCLUDED.comment_count,
    version=community_post_stats.version+1,updated_at=clock_timestamp();
END $$;

CREATE FUNCTION community_reaction_stats_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_member boolean;
BEGIN
  IF TG_OP='DELETE' THEN
    SELECT status='active' INTO active_member FROM member WHERE id=OLD.member_id;
  ELSE
    SELECT status='active' INTO active_member FROM member WHERE id=NEW.member_id;
  END IF;
  IF NOT COALESCE(active_member,false) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP='DELETE' THEN
    PERFORM adjust_community_post_stats(OLD.post_id,CASE WHEN OLD.kind='like' THEN -1 ELSE 0 END,CASE WHEN OLD.kind='save' THEN -1 ELSE 0 END,0);
    RETURN OLD;
  END IF;
  PERFORM adjust_community_post_stats(NEW.post_id,CASE WHEN NEW.kind='like' THEN 1 ELSE 0 END,CASE WHEN NEW.kind='save' THEN 1 ELSE 0 END,0);
  RETURN NEW;
END $$;
CREATE TRIGGER community_reaction_stats AFTER INSERT OR DELETE ON community_reaction
FOR EACH ROW EXECUTE FUNCTION community_reaction_stats_trigger();

CREATE FUNCTION community_comment_stats_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_active boolean := false; new_active boolean := false;
BEGIN
  IF TG_OP<>'INSERT' THEN
    SELECT status='active' INTO old_active FROM member WHERE id=OLD.member_id;
    IF OLD.status='published' AND COALESCE(old_active,false) THEN
      PERFORM adjust_community_post_stats(OLD.post_id,0,0,-1);
    END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
    SELECT status='active' INTO new_active FROM member WHERE id=NEW.member_id;
    IF NEW.status='published' AND COALESCE(new_active,false) THEN
      PERFORM adjust_community_post_stats(NEW.post_id,0,0,1);
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER community_comment_stats AFTER INSERT OR DELETE OR UPDATE OF status,post_id,member_id ON community_comment
FOR EACH ROW EXECUTE FUNCTION community_comment_stats_trigger();

CREATE FUNCTION community_member_status_stats_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE multiplier integer;
DECLARE row record;
BEGIN
  IF (OLD.status='active')=(NEW.status='active') THEN RETURN NEW; END IF;
  multiplier := CASE WHEN NEW.status='active' THEN 1 ELSE -1 END;
  FOR row IN
    SELECT post_id,
      count(*) FILTER (WHERE source='reaction' AND kind='like')::int AS likes,
      count(*) FILTER (WHERE source='reaction' AND kind='save')::int AS saves,
      count(*) FILTER (WHERE source='comment')::int AS comments
    FROM (
      SELECT post_id,'reaction'::text AS source,kind FROM community_reaction WHERE member_id=NEW.id
      UNION ALL
      SELECT post_id,'comment'::text AS source,NULL::text AS kind FROM community_comment WHERE member_id=NEW.id AND status='published'
    ) owned GROUP BY post_id
  LOOP
    PERFORM adjust_community_post_stats(row.post_id,row.likes*multiplier,row.saves*multiplier,row.comments*multiplier);
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER community_member_status_stats AFTER UPDATE OF status ON member
FOR EACH ROW EXECUTE FUNCTION community_member_status_stats_trigger();

-- migrate:down
DROP TRIGGER community_member_status_stats ON member;
DROP FUNCTION community_member_status_stats_trigger();
DROP TRIGGER community_comment_stats ON community_comment;
DROP FUNCTION community_comment_stats_trigger();
DROP TRIGGER community_reaction_stats ON community_reaction;
DROP FUNCTION community_reaction_stats_trigger();
DROP FUNCTION adjust_community_post_stats(text,integer,integer,integer);
DROP TABLE community_post_stats;
