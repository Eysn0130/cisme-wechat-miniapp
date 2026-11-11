import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supportIdentities, supportSenderKey } from '../../services/api/src/supportIdentity';
import { presentSupportMessages } from '../../apps/miniprogram/services/support-thread-state';
const avatar = vi.hoisted(() => ({ load: vi.fn() }));
const own = vi.hoisted(() => ({ request: vi.fn(), token: 'synthetic-owner' }));
vi.mock('../../apps/miniprogram/services/member-avatar', () => ({ defaultMemberAvatar: '/assets/icons/user-circle-plum.svg', localMemberAvatar: avatar.load }));
vi.mock('../../apps/miniprogram/services/api', () => ({ request: own.request }));
import { SupportIdentityCache, supportOwnIdentity } from '../../apps/miniprogram/services/support-identity';
import { clearMemberIdentity, memberIdentity } from '../../apps/miniprogram/services/member-identity';
const person = (key = 'a'.repeat(64), name = '会员一', revision = 1) => ({ key, displayName: name, profileRevision: revision,
  operatorUpdatedAt: null, avatarRevision: 'b'.repeat(64), avatarDataUrl: 'data:image/jpeg;base64,cGlj' });
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
beforeEach(() => { avatar.load.mockReset(); avatar.load.mockResolvedValue('wxfile://usr/avatar-one.jpg');
  own.request.mockReset(); own.token = 'synthetic-owner'; (globalThis as any).getApp = () => ({ globalData: { sessionToken: own.token } }); clearMemberIdentity(); });

describe('support sender identity and native avatar cache', () => {
  it('loads the actual flat member-profile response for a cold-start user without requiring a previous profile-page visit', async () => {
    own.request.mockResolvedValue({ id: 'owner', display_name: '新建账号', profile_revision: 1, avatar_data_url: person().avatarDataUrl, avatar_revision: person().avatarRevision });
    expect(await supportOwnIdentity(() => true)).toMatchObject({ id: 'owner', display_name: '新建账号', avatarUrl: 'wxfile://usr/avatar-one.jpg' });
    expect(own.request).toHaveBeenCalledWith({ path: '/v1/me/profile' });
    expect(JSON.stringify(memberIdentity())).not.toContain('base64');
  });
  it('does not publish a late profile after losing ownership and tolerates a failed first profile load', async () => {
    own.request.mockRejectedValueOnce(new Error('offline'));
    expect(await supportOwnIdentity(() => true)).toBeNull();
    let finish!: (v: any) => void; let current = true; own.request.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = supportOwnIdentity(() => current); current = false; own.token = 'new-account';
    finish({ id: 'old-owner', display_name: '旧会员', profile_revision: 1 }); await pending;
    expect(memberIdentity()).toBeNull(); expect(avatar.load).not.toHaveBeenCalled();
  });
  it('resolves canonical owner and actual operators once per page without exposing principals or contacts', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      { role: 'user', principal: null, status: 'active', display_name: '新会员', profile_revision: 2, avatar_revision: 'b'.repeat(64), avatar_data_url: 'small-jpeg' },
      { role: 'admin', principal: 'wechat_miniprogram:agent-one', status: 'active', display_name: '操作者一', alias: '客服小熹', profile_revision: 3, avatar_revision: 'c'.repeat(64), avatar_data_url: 'other-jpeg' },
      { role: 'admin', principal: 'legacy:unknown', status: null, display_name: null, profile_revision: 0, avatar_revision: null, avatar_data_url: null }
    ] });
    const owner = { id: 'thread', member_id: 'owner', current_handler_principal_id: 'legacy:unknown' };
    const page = await supportIdentities({ query } as any, owner, [{ sender_type: 'user', sender_principal_id: 'must-not-be-used' },
      { sender_type: 'admin', sender_principal_id: 'wechat_miniprogram:agent-one' }]);
    expect(query).toHaveBeenCalledOnce();
    expect(page.sender({ sender_type: 'user' })).toMatchObject({ key: supportSenderKey('thread', 'user', 'owner'), displayName: '新会员' });
    expect(page.sender({ sender_type: 'admin', sender_principal_id: 'wechat_miniprogram:agent-one' })).toMatchObject({ displayName: '客服小熹', profileRevision: 3 });
    expect(page.sender({ sender_type: 'admin', sender_principal_id: 'legacy:unknown' })).toMatchObject({ displayName: 'CISME 客服', avatarRevision: null });
    expect(page.sender({ sender_type: 'admin', sender_principal_id: 'wechat_miniprogram:agent-one' })).not.toHaveProperty('avatarDataUrl');
    expect(JSON.stringify(page.identities)).not.toMatch(/wechat_miniprogram|legacy:unknown|phone|openid|owner/);
    expect(supportSenderKey('other-thread', 'user', 'owner')).not.toBe(page.memberIdentityKey);
  });
  it('strips avatars for deleted people even when an old profile and professional alias remain', async () => {
    const page = await supportIdentities({ query: vi.fn().mockResolvedValue({ rows: [{ role: 'user', status: 'deleted', display_name: '旧姓名',
      alias: '旧客服', profile_revision: 0, avatar_revision: 'a'.repeat(64), avatar_data_url: 'old-jpeg' }] }) } as any,
    { id: 'thread', member_id: 'owner', current_handler_principal_id: null }, []);
    expect(page.identities[page.memberIdentityKey]).toMatchObject({ displayName: '已注销会员', redacted: true, avatarDataUrl: null, avatarRevision: null });
  });
  it('loads a shared thumbnail once and sends only a local path through presentation', async () => {
    const cache = new SupportIdentityCache(), changed = vi.fn(), identity = person();
    cache.absorb({ conversation: { id: 'thread' }, identities: { [identity.key]: identity }, memberIdentityKey: identity.key }, changed);
    cache.accept(identity, changed); await flush();
    const item = cache.resolve({ id: 'msg', sequence: 1, senderType: 'user', sender: identity, body: '你好' });
    expect(avatar.load).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledOnce();
    expect(item.avatarPath).toBe('wxfile://usr/avatar-one.jpg'); expect(item.sender).not.toHaveProperty('avatarDataUrl');
    expect(JSON.stringify(presentSupportMessages([item], { ownSenderType: 'user' }))).not.toContain('base64');
  });
  it('rejects older profile and alias metadata, and a deletion tombstone wins over delayed active responses', async () => {
    const cache = new SupportIdentityCache(), changed = vi.fn();
    cache.accept({ ...person(), operatorUpdatedAt: '2026-11-11T10:00:00Z' }, changed); await flush();
    cache.accept({ ...person(undefined, '旧称', 0) }, changed);
    expect(cache.resolve({ sender: person() }).sender!.displayName).toBe('会员一');
    cache.accept({ ...person(undefined, '已注销会员', 0), avatarDataUrl: null, avatarRevision: null, redacted: true }, changed);
    cache.accept(person(undefined, '迟到资料', 3), changed); await flush();
    expect(cache.resolve({ sender: person() })).toMatchObject({ sender: { displayName: '已注销会员', redacted: true }, avatarPath: '/assets/icons/user-circle-plum.svg' });
  });
  it('does not apply an avatar after switching conversation/account and does not loop after image failure', async () => {
    let finish!: (v: string) => void; avatar.load.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const cache = new SupportIdentityCache(), changed = vi.fn(); cache.accept(person(), changed); cache.reset();
    finish('wxfile://usr/old-account.jpg'); await flush(); expect(changed).not.toHaveBeenCalled();
    cache.accept(person(), changed); await flush(); cache.fail(person().key); cache.accept(person(), changed); await flush();
    expect(avatar.load).toHaveBeenCalledTimes(2); expect(cache.avatar(person().key)).toBe('/assets/icons/user-circle-plum.svg');
  });
  it('keeps adjacent replies from different operators distinct and never relabels legacy replies as the current handler', () => {
    const raw = [person('a'.repeat(64), '小熹'), person('c'.repeat(64), '小明')].map((sender, index) => ({ id: `${index}`, sequence: index + 1,
      senderType: 'admin', sender, body: '回复', createdAt: `2026-11-11T10:0${index}:00Z`, avatarPath: 'https://untrusted.example/avatar.jpg' }));
    const result = presentSupportMessages([...raw, { ...raw[0]!, id: 'legacy', sequence: 3, sender: undefined } as any], { ownSenderType: 'admin', agentDisplayName: '现在接待的另一位' });
    expect(result.map(item => item.groupStart)).toEqual([true, true, true]);
    expect(result.map(item => item.senderLabel)).toEqual(['小熹 · 人工客服', '小明 · 人工客服', 'CISME 客服 · 人工客服']);
    expect(JSON.stringify(result)).not.toContain('https://untrusted');
  });
});
