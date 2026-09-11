import { CAPABILITIES, type Capability } from "@cisme/contracts";
import { CANONICAL_WECHAT_MINIPROGRAM_APP_ID } from "@cisme/config";
import { createPool, transaction } from "../services/api/src/db.js";

const [action, memberId, capabilityInput, actorInput, reasonInput, sourceInput, expiryInput] = process.argv.slice(2);
const environment = process.env.APP_ENV;
const databaseUrl = process.env.DATABASE_URL;
const expectedDatabaseName = process.env.EXPECTED_DATABASE_NAME;
const expectedAppId = process.env.WECHAT_APP_ID;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function usage(): never {
  throw new Error(
    "Usage: authority-grants.ts list MEMBER_UUID | grant MEMBER_UUID CAPABILITY ACTOR REASON SOURCE EXPIRES_AT_OR_NONE | revoke MEMBER_UUID CAPABILITY ACTOR REASON"
  );
}
function boundedText(value: string | undefined, label: string, maximum: number): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length < 3 || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label}_INVALID`);
  return normalized;
}

if (!databaseUrl || !expectedDatabaseName || !environment || !["staging", "production"].includes(environment)) {
  throw new Error("DATABASE_URL, EXPECTED_DATABASE_NAME and APP_ENV=staging|production are required");
}
if (new URL(databaseUrl).pathname.slice(1) !== expectedDatabaseName) throw new Error("EXPECTED_DATABASE_NAME_MISMATCH");
if (expectedAppId !== CANONICAL_WECHAT_MINIPROGRAM_APP_ID) throw new Error("WECHAT_APP_ID_NOT_CANONICAL");
if (!UUID.test(memberId ?? "") || !["list", "grant", "revoke"].includes(action ?? "")) usage();

const capability = capabilityInput as Capability | undefined;
if (action !== "list" && (!capability || !CAPABILITIES.includes(capability))) usage();
const pool = createPool(databaseUrl);
try {
  const result = await transaction(pool, async (client) => {
    const identity = await client.query(`SELECT 1 FROM member m JOIN wechat_identity i ON i.member_id=m.id
      WHERE m.id=$1 AND m.status='active' AND i.provider='wechat_miniprogram' AND i.app_id=$2 FOR UPDATE OF m`,
      [memberId, CANONICAL_WECHAT_MINIPROGRAM_APP_ID]);
    if (!identity.rowCount) throw new Error("ACTIVE_CANONICAL_WECHAT_MEMBER_REQUIRED");

    if (action === "list") {
      const grants = await client.query(`SELECT capability,environment,grant_source,granted_by,grant_reason,granted_at,expires_at,
        revoked_by,revoke_reason,revoked_at FROM authority_grant WHERE member_id=$1 ORDER BY granted_at DESC,id DESC`, [memberId]);
      return { action, memberId, grants: grants.rows };
    }

    const actor = boundedText(actorInput, "ACTOR", 300);
    const reason = boundedText(reasonInput, "REASON", 500);
    if (action === "grant") {
      const source = boundedText(sourceInput, "SOURCE", 200);
      let expiresAt: Date | null = null;
      if (expiryInput !== "none") {
        expiresAt = new Date(expiryInput ?? "");
        if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new Error("EXPIRES_AT_INVALID");
      }
      const inserted = await client.query<{ id: string }>(`INSERT INTO authority_grant
        (member_id,capability,granted_by,grant_reason,environment,grant_source,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [memberId, capability, actor, reason, environment, source, expiresAt]);
      return { action, grantId: inserted.rows[0]!.id, memberId, capability, environment, expiresAt: expiresAt?.toISOString() ?? null };
    }

    const revoked = await client.query<{ id: string }>(`UPDATE authority_grant SET revoked_at=now(),revoked_by=$4,revoke_reason=$5
      WHERE member_id=$1 AND capability=$2 AND environment=$3 AND revoked_at IS NULL RETURNING id`,
      [memberId, capability, environment, actor, reason]);
    if (revoked.rowCount !== 1) throw new Error("ACTIVE_AUTHORITY_GRANT_NOT_FOUND");
    return { action, grantId: revoked.rows[0]!.id, memberId, capability, environment };
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
