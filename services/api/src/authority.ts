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

export class AuthorityService {
  constructor(private readonly pool: pg.Pool, private readonly environment: AppEnvironment) {}

  async projection(memberId: string | undefined): Promise<AuthorityProjection> {
    const owner = member(memberId);
    const result = await this.pool.query<{ capability: Capability }>(`SELECT capability FROM authority_grant
      WHERE member_id=$1 AND environment=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) ORDER BY capability`, [owner, this.environment]);
    const capabilities = result.rows.map((row) => row.capability).filter((value) => capabilitySet.has(value));
    return { version: 1, capabilities, managementAvailable: capabilities.length > 0 };
  }

  async require(memberId: string | undefined, capability: Capability): Promise<string> {
    const owner = member(memberId);
    const result = await this.pool.query("SELECT 1 FROM authority_grant WHERE member_id=$1 AND capability=$2 AND environment=$3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())", [owner, capability, this.environment]);
    if (!result.rowCount) throw new DomainError("CAPABILITY_REQUIRED", `Required capability: ${capability}`, 403);
    return owner;
  }

  async has(memberId: string | undefined, capability: Capability): Promise<boolean> {
    if (!memberId) return false;
    const result = await this.pool.query("SELECT 1 FROM authority_grant WHERE member_id=$1 AND capability=$2 AND environment=$3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())", [memberId, capability, this.environment]);
    return Boolean(result.rowCount);
  }

  async requireWithClient(client: DbClient, memberId: string | undefined, capability: Capability): Promise<string> {
    const owner = member(memberId);
    const result = await client.query("SELECT 1 FROM authority_grant WHERE member_id=$1 AND capability=$2 AND environment=$3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())", [owner, capability, this.environment]);
    if (!result.rowCount) throw new DomainError("CAPABILITY_REQUIRED", `Required capability: ${capability}`, 403);
    return owner;
  }

  async requireAny(memberId: string | undefined, capabilities: Capability[]): Promise<string> {
    const owner = member(memberId);
    const result = await this.pool.query("SELECT 1 FROM authority_grant WHERE member_id=$1 AND capability=ANY($2::text[]) AND environment=$3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) LIMIT 1", [owner, capabilities, this.environment]);
    if (!result.rowCount) throw new DomainError("CAPABILITY_REQUIRED", `One of these capabilities is required: ${capabilities.join(",")}`, 403);
    return owner;
  }
}
