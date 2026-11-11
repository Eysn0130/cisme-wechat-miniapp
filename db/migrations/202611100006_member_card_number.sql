BEGIN;

-- A private display identifier, independent of UUIDs, permissions and assets.
-- Serialize the one-time backfill with registration. Identity sequences may
-- contain gaps after a failed transaction; issued numbers are never recycled.
LOCK TABLE member IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE member_card_number (
  member_id uuid PRIMARY KEY REFERENCES member(id) ON DELETE CASCADE,
  number bigint GENERATED ALWAYS AS IDENTITY (MINVALUE 1 NO CYCLE) UNIQUE NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_card_number_positive CHECK (number > 0)
);
INSERT INTO member_card_number(member_id,issued_at)
  SELECT id,created_at FROM member ORDER BY created_at,id;

CREATE FUNCTION assign_member_card_number() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  INSERT INTO public.member_card_number(member_id) VALUES(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER member_card_number_on_registration
AFTER INSERT ON member FOR EACH ROW EXECUTE FUNCTION assign_member_card_number();

CREATE FUNCTION preserve_member_card_number() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'MEMBER_CARD_NUMBER_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER member_card_number_immutable
BEFORE UPDATE ON member_card_number FOR EACH ROW EXECUTE FUNCTION preserve_member_card_number();

COMMIT;

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'MEMBER_CARD_NUMBER_ROLLBACK_REQUIRES_IDENTIFIER_PRESERVATION';
END $$;
