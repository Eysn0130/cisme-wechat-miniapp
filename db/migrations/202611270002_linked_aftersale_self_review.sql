-- Authorised administrators may decide a regular refund linked to their own
-- order's aftersale. Keep both actors recorded and preserve standalone and
-- exceptional no-return review boundaries.
ALTER TABLE commerce_refund_request DROP CONSTRAINT commerce_refund_request_check1;

CREATE FUNCTION guard_linked_aftersale_self_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM commerce_aftersale_case c
    WHERE c.refund_request_id = NEW.id AND c.order_id = NEW.order_id
      AND c.member_id = NEW.requested_by_member_id AND c.amount_cents = NEW.amount_cents
      AND c.state = 'refund_pending' AND c.exception_kind IS NULL
  ) THEN
    RAISE EXCEPTION 'REFUND_SELF_APPROVAL_REQUIRES_REGULAR_AFTERSALE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER linked_aftersale_self_review_guard
BEFORE INSERT OR UPDATE ON commerce_refund_request
FOR EACH ROW WHEN (NEW.state <> 'requested' AND NEW.decided_by_member_id = NEW.requested_by_member_id)
EXECUTE FUNCTION guard_linked_aftersale_self_review();

-- migrate:down
-- Reapplying the old check is only possible before any self-decisions exist.
ALTER TABLE commerce_refund_request ADD CONSTRAINT commerce_refund_request_check1
  CHECK (state = 'requested' OR decided_by_member_id <> requested_by_member_id);
DROP TRIGGER linked_aftersale_self_review_guard ON commerce_refund_request;
DROP FUNCTION guard_linked_aftersale_self_review();
