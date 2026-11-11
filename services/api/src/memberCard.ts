// mc is always the owner-scoped member_card_number join. Keep bigint values as
// strings; fixed-length lpad alone would truncate numbers above 99999.
export const memberCardNumberProjection = "lpad(mc.number::text,greatest(5,length(mc.number::text)),'0')";
export const memberCardPortableQuery = `SELECT ${memberCardNumberProjection} AS number,issued_at
  FROM member_card_number mc WHERE member_id=$1`;
