BEGIN;

-- Preserve all existing issued identifiers and assets. Future real WeChat
-- identities explicitly start pending; SQL/dev fixtures keep their established
-- completed-registration default.
LOCK TABLE member IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE member ADD COLUMN registration_completed_at timestamptz;
UPDATE member SET registration_completed_at=created_at;
ALTER TABLE member ALTER COLUMN registration_completed_at SET DEFAULT clock_timestamp();

CREATE OR REPLACE FUNCTION assign_member_card_number() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.registration_completed_at IS NOT NULL THEN
    INSERT INTO public.member_card_number(member_id,issued_at)
      VALUES(NEW.id,NEW.registration_completed_at);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER member_card_number_on_confirmation
AFTER UPDATE OF registration_completed_at ON member FOR EACH ROW
WHEN (OLD.registration_completed_at IS NULL AND NEW.registration_completed_at IS NOT NULL)
EXECUTE FUNCTION assign_member_card_number();

CREATE FUNCTION preserve_member_registration() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.registration_completed_at IS NOT NULL
     AND NEW.registration_completed_at IS DISTINCT FROM OLD.registration_completed_at THEN
    RAISE EXCEPTION 'MEMBER_REGISTRATION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER member_registration_immutable
BEFORE UPDATE OF registration_completed_at ON member FOR EACH ROW
EXECUTE FUNCTION preserve_member_registration();

COMMIT;

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'MEMBER_REGISTRATION_ROLLBACK_REQUIRES_PENDING_IDENTITY_PRESERVATION';
END $$;
