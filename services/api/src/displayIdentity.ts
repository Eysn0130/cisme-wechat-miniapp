import type pg from "pg";
import type { AppEnvironment } from "@cisme/config";
import type { Capability, CommunityIdentityBadge, MemberDisplayIdentity } from "@cisme/contracts";

const administrationCapabilities: readonly Capability[] = [
  "member.manage", "community.moderate", "editorial.manage", "privacy.request.manage",
  "commerce.product.manage", "commerce.qualification.manage", "commerce.inventory.manage", "commerce.fulfillment.manage"
];
export const displayCapabilities = [...administrationCapabilities, "support.reply", "community.admin_badge"];

export function privateMemberDisplayIdentity(officer:boolean,grants:readonly Capability[]): MemberDisplayIdentity {
  if (administrationCapabilities.some(capability => grants.includes(capability))) return "administrator";
  if (grants.includes("support.reply")) return "support";
  return officer ? "sharing-officer" : "member";
}

interface IdentityRow {
  id: string;
  officer: boolean;
  grants: Capability[];
}

interface DisplayIdentity {
  privateIdentity: MemberDisplayIdentity;
  publicBadge: CommunityIdentityBadge | undefined;
}

export async function memberDisplayIdentities(
  client: pg.Pool | pg.PoolClient, environment: AppEnvironment, memberIds: readonly string[]
): Promise<Map<string, DisplayIdentity>> {
  if (!memberIds.length) return new Map();
  const { rows } = await client.query<IdentityRow>(
    "SELECT m.id, COALESCE(o.state='active',false) AS officer, "
      + "ARRAY(SELECT g.capability FROM authority_grant g WHERE g.member_id=m.id AND g.environment=$2 "
      + "AND g.capability=ANY($3::text[]) AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())) AS grants "
      + "FROM member m LEFT JOIN sharing_officer o ON o.member_id=m.id "
      + "WHERE m.id=ANY($1::uuid[]) AND m.status='active'",
    [memberIds, environment, displayCapabilities]
  );
  return new Map(rows.map(row => {
    const privateIdentity = privateMemberDisplayIdentity(row.officer,row.grants);
    const publicBadge = privateIdentity === "administrator" && row.grants.includes("community.admin_badge") ? "administrator"
      : row.officer ? "sharing-officer" : undefined;
    return [row.id, { privateIdentity, publicBadge }];
  }));
}
