import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { loadConfig } from '@cisme/config';
import { TEST_DATABASE_URL, resetDatabase, testPool } from '@cisme/testkit';
import { createApp } from '../../services/api/src/server';
import { createApiGatewayStorage } from '../../services/api/src/storage';

const pool = testPool();
const config = loadConfig({ APP_ENV: 'test', DATABASE_URL: TEST_DATABASE_URL, APP_SESSION_SECRET: 'synthetic-sender-session',
  UPLOAD_TOKEN_SECRET: 'synthetic-sender-upload', OBJECT_STORAGE_DRIVER: 'api_gateway' });
let app: Awaited<ReturnType<typeof createApp>>, owner: any, first: any, second: any, stranger: any;
const auth = (person: any) => ({ authorization: `Bearer ${person.sessionToken}` });
const identity = async (name: string) => (await app.inject({ method: 'POST', url: '/v1/identity/dev', payload: {
  externalUserId: name, displayName: name, consents: [{ documentType: 'privacy', version: 'v1' }, { documentType: 'terms', version: 'v1' }] } })).json();
const thumbnail = (label: string) => ({ data: 'data:image/jpeg;base64,' + Buffer.from(label).toString('base64'),
  revision: createHash('sha256').update(label).digest('hex') });
async function profile(person: any, label: string, revision = 1) {
  const avatar = thumbnail(label);
  await pool.query(`INSERT INTO member_profile(member_id,handle_source,profile_revision,avatar_data_url,avatar_revision)
    VALUES($1,'self_reported',$2,$3,$4) ON CONFLICT(member_id) DO UPDATE SET profile_revision=$2,avatar_data_url=$3,avatar_revision=$4`,
    [person.memberId, revision, avatar.data, avatar.revision]);
  return avatar;
}
beforeAll(async () => {
  await resetDatabase(pool); app = await createApp({ config, pool, storage: createApiGatewayStorage(config) });
  [owner, first, second, stranger] = await Promise.all(['synthetic-new-member', 'synthetic-agent-one', 'synthetic-agent-two', 'synthetic-outsider'].map(identity));
  for (const agent of [first, second]) for (const capability of ['support.read', 'support.assign', 'support.reply'])
    await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
      VALUES($1,$2,'synthetic','Sender identity integration','test','integration_fixture')`, [agent.memberId, capability]);
});
afterAll(async () => { await app.close(); await pool.end(); });

describe.sequential('canonical support message sender profiles', () => {
  it('keeps a new member opening an empty chat read-only', async () => {
    const page = await app.inject({ method: 'GET', url: '/v1/me/support/messages', headers: auth(owner) });
    expect(page.statusCode).toBe(200); expect(page.json().conversation).toBeNull();
    expect((await pool.query('SELECT id FROM support_conversation WHERE member_id=$1', [owner.memberId])).rowCount).toBe(0);
  });
  it('projects both participants on both sides, refreshes profiles on empty polls, and preserves the first operator after reassignment', async () => {
    const ownAvatar = await profile(owner, 'synthetic-owner-thumbnail'), firstAvatar = await profile(first, 'synthetic-first-thumbnail');
    const secondAvatar = await profile(second, 'synthetic-second-thumbnail');
    await pool.query("INSERT INTO support_operator_profile(principal_id,display_name) VALUES($1,'客服甲'),($2,'客服乙')", [first.principalId, second.principalId]);
    const sent = (await app.inject({ method: 'POST', url: '/v1/me/support/messages', headers: auth(owner),
      payload: { body: '咨询商品规格', clientMessageId: 'sender-question-one' } })).json();
    expect(sent.message.sender).toMatchObject({ displayName: 'synthetic-new-member', avatarRevision: ownAvatar.revision, avatarDataUrl: ownAvatar.data });
    const id = sent.conversation.id, base = `/v1/management/support/conversations/${id}`;
    const claimed = (await app.inject({ method: 'POST', url: `${base}/claim`, headers: auth(first), payload: { expectedVersion: sent.conversation.version } })).json();
    const reply = await app.inject({ method: 'POST', url: `${base}/messages`, headers: auth(first),
      payload: { body: '这是甲的回复', clientMessageId: 'sender-reply-one', replyToMessageId: sent.message.id, expectedHumanRequestGeneration: 0, contextVersion: 0 } });
    expect(reply.statusCode).toBe(200); expect(reply.json().message.sender).toMatchObject({ displayName: '客服甲', avatarRevision: firstAvatar.revision });
    const resolved = await app.inject({ method: 'POST', url: `${base}/resolve`, headers: auth(first), payload: { expectedVersion: reply.json().conversation.version } });
    expect(resolved.statusCode).toBe(200);
    const again = (await app.inject({ method: 'POST', url: '/v1/me/support/messages', headers: auth(owner),
      payload: { body: '再咨询商品', clientMessageId: 'sender-question-two' } })).json();
    const secondClaim = await app.inject({ method: 'POST', url: `${base}/claim`, headers: auth(second), payload: { expectedVersion: again.conversation.version } });
    expect(secondClaim.statusCode).toBe(200);
    const secondReply = await app.inject({ method: 'POST', url: `${base}/messages`, headers: auth(second),
      payload: { body: '这是乙的回复', clientMessageId: 'sender-reply-two', replyToMessageId: again.message.id, expectedHumanRequestGeneration: 0, contextVersion: 0 } });
    expect(secondReply.statusCode).toBe(200);
    const userPage = (await app.inject({ method: 'GET', url: '/v1/me/support/messages', headers: auth(owner) })).json();
    const adminPage = (await app.inject({ method: 'GET', url: `${base}/messages`, headers: auth(second) })).json();
    for (const page of [userPage, adminPage]) {
      const replies = page.messages.filter((item: any) => item.senderType === 'admin');
      expect(replies.map((item: any) => item.sender.displayName)).toEqual(['客服甲', '客服乙']);
      expect(replies[0].sender.key).not.toBe(replies[1].sender.key);
      expect(page.identities[page.memberIdentityKey].avatarDataUrl).toBe(ownAvatar.data);
      expect(page.identities[page.agentIdentityKey].avatarDataUrl).toBe(secondAvatar.data);
      expect(page.presence.agentDisplayName).toBe('客服乙');
      expect(page.messages.every((item: any) => !item.sender || item.sender.avatarDataUrl === undefined)).toBe(true);
      expect(JSON.stringify(page)).not.toMatch(/sender_principal_id|openid|sessionToken|phone_masked|wechat_handle/);
    }
    const newer = await profile(owner, 'synthetic-owner-updated', 2);
    const poll = (await app.inject({ method: 'GET', url: `${base}/messages?after=${adminPage.latestCursor}`, headers: auth(second) })).json();
    expect(poll.messages).toHaveLength(0); expect(poll.identities[poll.memberIdentityKey]).toMatchObject({ avatarRevision: newer.revision, profileRevision: 2 });
    expect((await app.inject({ method: 'POST', url: `${base}/member-context`, headers: auth(second) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `${base}/messages`, headers: auth(stranger) })).statusCode).toBe(403);
    expect(claimed.status).toBe('human_active');
  });
});
