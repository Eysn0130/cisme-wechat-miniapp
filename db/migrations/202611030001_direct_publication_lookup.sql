-- migrate:up
-- Bound the current author-intent lookup without scanning unrelated audit history.
-- Existing immutable publication facts and their principals remain unchanged.
CREATE INDEX ugc_direct_publication_intent_idx
  ON audit_log(object_id, (after_state->>'newRevision'))
  WHERE object_type='ugc_post' AND action='ugc.post_submitted'
    AND after_state->>'directPublication'='true';

-- migrate:down
DROP INDEX ugc_direct_publication_intent_idx;
