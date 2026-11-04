-- Public publisher identity is independent of member attribution and operators.
-- This does not create a member, WeChat identity, grant, consent or new post.
CREATE TABLE editorial_publisher (
  id text PRIMARY KEY CHECK (id='cisme-scalp-lab'),
  biography text NOT NULL DEFAULT '' CHECK (char_length(biography)<=120),
  profile_revision integer NOT NULL DEFAULT 0 CHECK (profile_revision>=0)
);
INSERT INTO editorial_publisher(id) VALUES('cisme-scalp-lab');
ALTER TABLE editorial_article ADD COLUMN publisher_id text REFERENCES editorial_publisher(id);

-- Only the already authorized brand relabel operation establishes historical
-- official attribution. A matching nickname alone is not identity evidence.
UPDATE editorial_article a SET publisher_id='cisme-scalp-lab'
WHERE a.author_display_name='CISME头皮实验室' AND EXISTS (
  SELECT 1 FROM audit_log l WHERE l.object_type='editorial_article' AND l.object_id=a.id
    AND l.action='editorial.author_relabel' AND l.reason_code='OWNER_AUTHORIZED_AUTHOR_RELABEL'
    AND l.after_state->>'authorName'='CISME头皮实验室'
    AND l.after_state->>'authorizationRef'='cisme-editorial-brand-author-owner-20261101'
);

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM editorial_article WHERE publisher_id IS NOT NULL) OR
    EXISTS(SELECT 1 FROM community_follow WHERE author_id='fe841ebb-1db1-57de-988b-4ff1534f23e6') OR
    EXISTS(SELECT 1 FROM editorial_publisher WHERE profile_revision>0 OR biography<>'') THEN
    RAISE EXCEPTION 'OFFICIAL_PUBLISHER_FACTS_REQUIRE_PRESERVATION';
  END IF;
END $$;
ALTER TABLE editorial_article DROP COLUMN publisher_id;
DROP TABLE editorial_publisher;
