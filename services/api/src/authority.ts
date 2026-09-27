import type pg from "pg";
import { CAPABILITIES, type AuthorityProjection, type Capability } from "@cisme/contracts";
import { DomainError } from "@cisme/domain";
import type { AppEnvironment } from "@cisme/config";
import type { DbClient } from "./db.js";

const capabilitySet = new Set<string>(CAPABILITIES);

function member(memberId: string | undefined): string {
  if (!memberId) throw new DomainError("AUTH_REQUIRED", "Member session required", 401);
  return memberId;
}

/** Serialize an owning member action/read against account blocking. */
export async function requireActiveMemberWithClient(client:DbClient,memberId:string|undefined):Promise<string> {
  const owner=member(memberId);
  const active=await client.query("SELECT id FROM member WHERE id=$1 AND status='active' FOR SHARE",[owner]);
  if(!active.rowCount)throw new DomainError('MEMBER_NOT_ACTIVE','账号暂不可执行此操作',403);
  return owner;
}

/** A freshly verified privacy-rights identity may finish an existing trade.
 * The caller must be an explicitly allowlisted historical route; ordinary
 * member sessions must never use this to bypass account closure. */
export async function requireHistoricalMemberWithClient(client:DbClient,memberId:string|undefined,
  closedRights=false):Promise<string> {
  if(!closedRights)return requireActiveMemberWithClient(client,memberId);
  const owner=member(memberId);
  const closed=await client.query("SELECT id FROM member WHERE id=$1 AND status='deleted' FOR SHARE",[owner]);
  if(!closed.rowCount)throw new DomainError('MEMBER_NOT_CLOSED','历史账号身份已变化，请重新核验',403);
  return owner;
}

export class AuthorityService {
  constructor(private readonly pool: pg.Pool, private readonly environment: AppEnvironment) {}

  async projection(memberId: string | undefined): Promise<AuthorityProjection> {
    const owner = member(memberId);
    const result = await this.pool.query<{ capability: Capability }>(`SELECT capability FROM authority_grant
      WHERE EXISTS(SELECT 1 FROM member m WHERE m.id=member_id AND m.status='active') AND member_id=$1 AND environment=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) ORDER BY capability`, [owner, this.environment]);
    const capabilities = result.rows.map((row) => row.capability).filter((value) => capabilitySet.has(value));
    return { version: 1, capabilities, managementAvailable: capabilities.length > 0 };
  }

  async require(memberId: string | undefined, capability: Capability): Promise<string> {
    const owner = member(memberId);
    const result = await this.pool.query("SELECT 1 FROM authority_grant WHERE EXISTS(SELECT 1 FROM member m WHERE m.id=member_id AND m.status='active') AND member_id=$1 AND capability=$2 AND environment=$3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())", [owner, capability, this.environment]);
    if (!result.rowCount) throw new DomainError("CAPABILITY_REQUIRED", `Required capability: ${capability}`, 403);
    return owner;
  }

  async has(memberId: string | undefined, capability: Capability): Promise<boolean> {
    if (!memberId) return false;
    const result = await this.pool.query("SELECT 1 FROM authority_grant WHERE EXISTS(SELECT 1 FROM member m WHERE m.id=member_id AND m.status='active') AND member_id=$1 AND capability=$2 AND environment=$3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())", [memberId, capability, this.environment]);
    return Boolean(result.rowCount);
  }

  async requireWithClient(client: DbClient, memberId: string | undefined, capability: Capability): Promise<string> {
    const owner = member(memberId);
    const result = await client.query<{expires_at:Date|null}>("SELECT g.expires_at FROM authority_grant g JOIN member m ON m.id=g.member_id WHERE g.member_id=$1 AND m.status='active' AND g.capability=$2 AND g.environment=$3 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) FOR SHARE OF g,m", [owner, capability, this.environment]);
    // The predicate may precede a row-lock wait; now() is frozen at BEGIN.
    // Check the database wall clock only after all authority locks are held.
    const grant=result.rows[0];
    const current=grant&&(grant.expires_at===null||(await client.query<{valid:boolean}>(
      'SELECT $1::timestamptz>clock_timestamp() AS valid',[grant.expires_at])).rows[0]?.valid);
    if (!current) throw new DomainError("CAPABILITY_REQUIRED", `Required capability: ${capability}`, 403);
    return owner;
  }

  async requireAny(memberId: string | undefined, capabilities: Capability[]): Promise<string> {
    const owner = member(memberId);
    const result = await this.pool.query("SELECT 1 FROM authority_grant WHERE EXISTS(SELECT 1 FROM member m WHERE m.id=member_id AND m.status='active') AND member_id=$1 AND capability=ANY($2::text[]) AND environment=$3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) LIMIT 1", [owner, capabilities, this.environment]);
    if (!result.rowCount) throw new DomainError("CAPABILITY_REQUIRED", `One of these capabilities is required: ${capabilities.join(",")}`, 403);
    return owner;
  }
}
