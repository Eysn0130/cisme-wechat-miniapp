BEGIN;

-- Stable public lookup code, independent of the private sequential card number.
-- Existing officer codes remain valid; all other members receive one code.
LOCK TABLE member,member_card_number,sharing_officer IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE member_card_number ADD COLUMN user_code text;
ALTER TABLE member_card_number ADD CONSTRAINT member_user_code_unique UNIQUE(user_code);
CREATE FUNCTION new_member_user_code() RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE candidate text;
BEGIN
 LOOP
  candidate:='CM'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
  PERFORM pg_advisory_xact_lock(hashtextextended('member-user-code:'||candidate,0));
  IF NOT EXISTS(SELECT 1 FROM public.member_card_number WHERE user_code=candidate) THEN RETURN candidate; END IF;
 END LOOP;
END;
$$;
ALTER TABLE member_card_number DISABLE TRIGGER member_card_number_immutable;
UPDATE member_card_number n SET user_code=o.referral_code FROM sharing_officer o WHERE o.member_id=n.member_id;
UPDATE member_card_number SET user_code=new_member_user_code() WHERE user_code IS NULL;
ALTER TABLE member_card_number ENABLE TRIGGER member_card_number_immutable;
ALTER TABLE member_card_number ALTER COLUMN user_code SET DEFAULT new_member_user_code(),
 ALTER COLUMN user_code SET NOT NULL,
 ADD CONSTRAINT member_user_code_format CHECK(user_code ~ '^[A-Z0-9]{12}$'),
 ADD CONSTRAINT member_user_code_owner_pair UNIQUE(member_id,user_code);
ALTER TABLE sharing_officer DROP CONSTRAINT sharing_officer_referral_code_check,
 ADD CONSTRAINT sharing_officer_referral_code_check CHECK(referral_code ~ '^[A-Z0-9]{12}$');
ALTER TABLE sharing_officer ADD CONSTRAINT sharing_officer_member_user_code_fk
 FOREIGN KEY(member_id,referral_code) REFERENCES member_card_number(member_id,user_code);

COMMIT;

-- migrate:down
DO $$ BEGIN
 RAISE EXCEPTION 'MEMBER_PUBLIC_CODE_ROLLBACK_REQUIRES_IDENTIFIER_PRESERVATION';
END $$;
