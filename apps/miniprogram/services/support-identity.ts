import { defaultMemberAvatar, localMemberAvatar } from './member-avatar';
import { memberIdentity, publishMemberIdentity } from './member-identity';
import { request } from './api';

export type SupportSender = { key: string; displayName: string; profileRevision: number; operatorUpdatedAt: string | null;
  avatarRevision: string | null; avatarDataUrl?: string | null; redacted?: boolean };
type Entry = { identity: SupportSender; avatarPath: string; failed: boolean; loading: boolean };

/** Private per-page cache. Raw image bytes never enter the rendering bridge. */
export class SupportIdentityCache {
  private entries = new Map<string, Entry>();
  private generation = 0;
  private scope = '';
  memberKey = '';
  agentKey = '';
  reset() { this.generation += 1; this.entries.clear(); this.scope = ''; this.memberKey = ''; this.agentKey = ''; }
  absorb(page: { conversation?: { id: string } | null; contextVersion?: number; identities?: Record<string, SupportSender>;
    memberIdentityKey?: string; agentIdentityKey?: string | null }, changed: () => void) {
    const scope = `${page.conversation?.id ?? ''}:${page.contextVersion ?? 0}`;
    if (scope !== this.scope) { this.reset(); this.scope = scope; }
    this.memberKey = page.memberIdentityKey ?? this.memberKey;
    this.agentKey = page.agentIdentityKey === null ? '' : page.agentIdentityKey ?? this.agentKey;
    for (const identity of Object.values(page.identities ?? {})) this.accept(identity, changed);
  }
  accept(value: SupportSender | undefined, changed: () => void) {
    if (!value || !/^[a-f0-9]{64}$/.test(value.key) || typeof value.displayName !== 'string'
      || !Number.isSafeInteger(value.profileRevision) || value.profileRevision < 0
      || value.avatarRevision !== null && !/^[a-f0-9]{64}$/.test(value.avatarRevision ?? '')) return;
    const previous = this.entries.get(value.key);
    if (previous && !value.redacted && (previous.identity.redacted || value.profileRevision < previous.identity.profileRevision
      || Date.parse(value.operatorUpdatedAt ?? '') < Date.parse(previous.identity.operatorUpdatedAt ?? ''))) return;
    const { avatarDataUrl, ...identity } = value;
    const sameAvatar = previous && previous.identity.avatarRevision === identity.avatarRevision && !identity.redacted;
    const entry: Entry = sameAvatar ? previous : { identity, avatarPath: defaultMemberAvatar, failed: false, loading: false };
    entry.identity = identity;
    this.entries.set(value.key, entry);
    if (identity.redacted || !avatarDataUrl || !identity.avatarRevision || entry.failed || entry.loading || entry.avatarPath !== defaultMemberAvatar) return;
    entry.loading = true;
    const generation = this.generation;
    void localMemberAvatar(avatarDataUrl, identity.avatarRevision).then(path => {
      if (generation !== this.generation || this.entries.get(value.key) !== entry) return;
      entry.loading = false; entry.failed = path === defaultMemberAvatar; entry.avatarPath = path; changed();
    }).catch(() => { if (generation === this.generation && this.entries.get(value.key) === entry) entry.failed = true; });
  }
  resolve<T extends { sender?: SupportSender; avatarPath?: string }>(message: T): Omit<T, 'sender' | 'avatarPath'> & { sender?: SupportSender; avatarPath: string } {
    const sender = message.sender;
    if (!sender) return { ...message, avatarPath: defaultMemberAvatar };
    const entry = this.entries.get(sender.key);
    const { avatarDataUrl: _raw, ...compact } = entry?.identity ?? sender;
    return { ...message, sender: compact, avatarPath: entry?.avatarPath ?? defaultMemberAvatar };
  }
  avatar(key: string) { return this.entries.get(key)?.avatarPath ?? defaultMemberAvatar; }
  name(key: string) { return this.entries.get(key)?.identity.displayName; }
  fail(key: string) { const entry = this.entries.get(key); if (entry) { entry.avatarPath = defaultMemberAvatar; entry.failed = true; } }
}

export async function supportOwnIdentity(current: () => boolean) {
  const snapshot = memberIdentity();
  try {
    const result = await request<any>({ path: '/v1/me/profile' });
    if (!current()) return null;
    const member = result.member ?? result;
    if (!member?.id) return snapshot;
    const avatarUrl = await localMemberAvatar(member.avatar_data_url, member.avatar_revision).catch(() => defaultMemberAvatar);
    if (!current()) return null;
    publishMemberIdentity({ id: member.id, display_name: member.display_name, profile_revision: member.profile_revision ?? 0, avatarUrl });
    return memberIdentity();
  } catch { return current() ? snapshot : null; }
}
