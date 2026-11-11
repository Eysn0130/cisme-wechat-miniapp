import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { SupportSenderIdentityView } from '@cisme/contracts';
import type { DbClient } from './db.js';

type IdentityMessage = { sender_type: string; sender_principal_id?: string | null };
type IdentityConversation = { id: string; member_id: string; current_handler_principal_id: string | null };
type IdentityRow = { role: string; principal: string | null; status: string | null; display_name: string | null;
  alias: string | null; operator_updated_at: Date | null; profile_revision: number; avatar_revision: string | null; avatar_data_url: string | null };

export function supportSenderKey(conversationId: string, role: string, principal: string): string {
  return createHash('sha256').update(JSON.stringify([conversationId, role, principal])).digest('hex');
}

/** One query per page, including the current participants even for an empty poll. */
export async function supportIdentities(client: DbClient | pg.Pool, conversation: IdentityConversation, messages: readonly IdentityMessage[]) {
  const principals = [...new Set([...messages.filter(item => item.sender_type === 'admin').map(item => item.sender_principal_id),
    conversation.current_handler_principal_id].filter((item): item is string => Boolean(item)))];
  const rows = await client.query<IdentityRow>(`
    SELECT 'user'::text AS role,NULL::text AS principal,m.status,m.display_name,NULL::text AS alias,
      NULL::timestamptz AS operator_updated_at,COALESCE(p.profile_revision,0) AS profile_revision,p.avatar_revision,p.avatar_data_url
    FROM member m LEFT JOIN member_profile p ON p.member_id=m.id WHERE m.id=$1
    UNION ALL
    SELECT 'admin',actor.principal,m.status,m.display_name,o.display_name,o.updated_at,
      COALESCE(p.profile_revision,0),p.avatar_revision,p.avatar_data_url
    FROM unnest($2::text[]) AS actor(principal)
    LEFT JOIN support_operator_profile o ON o.principal_id=actor.principal
    LEFT JOIN wechat_identity w ON w.id=CASE WHEN actor.principal ~ '^[a-z_]+:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN split_part(actor.principal,':',2)::uuid END AND w.provider=split_part(actor.principal,':',1)
    LEFT JOIN member m ON m.id=w.member_id LEFT JOIN member_profile p ON p.member_id=m.id`, [conversation.member_id, principals]);
  const identities: Record<string, SupportSenderIdentityView> = {};
  for (const row of rows.rows) {
    const key = supportSenderKey(conversation.id, row.role, row.role === 'user' ? conversation.member_id : row.principal!);
    const redacted = row.status === 'deleted';
    identities[key] = { key, displayName: redacted ? (row.role === 'user' ? '已注销会员' : 'CISME 客服')
      : (row.role === 'admin' ? row.alias || row.display_name || 'CISME 客服' : row.display_name || 'CISME 会员'),
      profileRevision: Number(row.profile_revision), operatorUpdatedAt: row.operator_updated_at?.toISOString() ?? null,
      avatarRevision: redacted ? null : row.avatar_revision, avatarDataUrl: redacted ? null : row.avatar_data_url, redacted };
  }
  const memberIdentityKey = supportSenderKey(conversation.id, 'user', conversation.member_id);
  const agentIdentityKey = conversation.current_handler_principal_id
    ? supportSenderKey(conversation.id, 'admin', conversation.current_handler_principal_id) : null;
  const sender = (message: IdentityMessage, includeAvatar = false): SupportSenderIdentityView | undefined => {
    const key = message.sender_type === 'user' ? memberIdentityKey : message.sender_type === 'admin' && message.sender_principal_id
      ? supportSenderKey(conversation.id, 'admin', message.sender_principal_id) : null;
    const identity = key ? identities[key] : undefined;
    if (!identity || includeAvatar) return identity;
    const { avatarDataUrl: _avatar, ...compact } = identity;
    return compact;
  };
  return { identities, memberIdentityKey, agentIdentityKey, sender };
}
