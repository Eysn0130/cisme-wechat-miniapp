import { DomainError } from '@cisme/domain';
import type { DbClient } from './db.js';

/** HTTP passes the member bound to the verified session, never a body field.
 * Role-only operations CLI has no member session; its role check still applies.
 * Acquire after job/request locks and before role locks, matching the worker. */
export async function requirePrivacyActor(client:DbClient,memberId:string|undefined) {
  if(memberId===undefined)return;
  const active=await client.query("SELECT id FROM member WHERE id=$1 AND status='active' FOR SHARE",[memberId]);
  if(!active.rowCount)throw new DomainError('PRIVACY_ACTOR_NOT_ACTIVE','当前受理账号不可执行此操作',403);
}
