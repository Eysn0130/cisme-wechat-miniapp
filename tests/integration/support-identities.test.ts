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

  it('dismisses the observed workbench row only for the current employee until a new message',async()=>{
    const member=await identity('synthetic-dismissal-member');
    const send=(body:string,key:string)=>app.inject({method:'POST',url:'/v1/me/support/messages',headers:auth(member),payload:{body,clientMessageId:key}});
    const firstMessage=(await send('需要了解物流','operator-dismiss-first')).json();
    const conversation=firstMessage.conversation;
    const queue=(person:any)=>app.inject({method:'GET',url:'/v1/management/support/conversations',headers:auth(person)});
    const hasRow=async(person:any)=>(await queue(person)).json().items.some((row:any)=>row.id===conversation.id);
    const dismiss=(person:any,expectedVersion:number)=>app.inject({method:'POST',url:`/v1/management/support/conversations/${conversation.id}/dismiss`,headers:auth(person),payload:{expectedVersion}});
    expect(await hasRow(first)).toBe(true);
    expect((await dismiss(member,conversation.version)).statusCode).toBe(403);
    expect((await dismiss(first,conversation.version-1)).statusCode).toBe(409);
    const removed=await dismiss(first,conversation.version);
    expect(removed.statusCode).toBe(200); expect(removed.json()).toEqual({conversationId:conversation.id,dismissed:true});
    expect((await dismiss(first,conversation.version)).json()).toEqual(removed.json());
    expect(await hasRow(first)).toBe(false); expect(await hasRow(second)).toBe(true);
    const memberPage=await app.inject({method:'GET',url:'/v1/me/support/messages',headers:auth(member)});
    expect(memberPage.json().messages.some((row:any)=>row.id===firstMessage.message.id)).toBe(true);
    expect(memberPage.json().conversation.status).toBe(conversation.status);
    expect((await send('补充一条想咨询','operator-dismiss-second')).statusCode).toBe(200);
    expect(await hasRow(first)).toBe(true);
    expect((await dismiss(first,conversation.version)).statusCode).toBe(409);
  });

  it('keeps the issue and verified identities when an assigned employee returns it for another employee',async()=>{
    const member=await identity('synthetic-returning-member');
    const avatar=await profile(member,'synthetic-returning-member-photo');
    const grant=(person:any,capability:string)=>pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
      VALUES($1,$2,'synthetic','Staff handoff integration','test','integration_fixture')`,[person.memberId,capability]);
    await grant(member,'member.manage');
    for(const capability of ['support.read','support.assign'])await grant(stranger,capability);
    const sent=(await app.inject({method:'POST',url:'/v1/me/support/messages',headers:auth(member),
      payload:{body:'物流信息需要人工核对',clientMessageId:'support-return-question'}})).json();
    const waiting=(await app.inject({method:'POST',url:'/v1/me/support/handoff',headers:auth(member),
      payload:{expectedConversationId:sent.conversation.id,contextVersion:0,questionMessageId:sent.message.id}})).json();
    const base=`/v1/management/support/conversations/${waiting.id}`;
    const command=(person:any,action:string,expectedVersion:number)=>app.inject({method:'POST',url:`${base}/${action}`,headers:auth(person),payload:{expectedVersion}});
    expect((await command(stranger,'claim',waiting.version)).statusCode).toBe(403);
    const claimed=(await command(first,'claim',waiting.version)).json();
    const operatorPage=(person:any)=>app.inject({method:'GET',url:`${base}/messages`,headers:auth(person)}).then(response=>response.json());
    const own=await operatorPage(first),other=await operatorPage(second);
    expect(own).toMatchObject({assignedToMe:true,canReturnToQueue:true});
    expect(other).toMatchObject({assignedToMe:false,canReturnToQueue:false});
    expect(own.identities[own.memberIdentityKey]).toMatchObject({identityBadge:'administrator',avatarDataUrl:avatar.data});
    expect(own.identities[own.agentIdentityKey]).toMatchObject({identityBadge:'support'});
    expect((await command(second,'return-to-queue',claimed.version)).statusCode).toBe(403);
    expect((await command(first,'return-to-queue',claimed.version-1)).statusCode).toBe(409);
    const returned=(await command(first,'return-to-queue',claimed.version)).json();
    expect(returned.status).toBe('waiting_human');
    const page=await operatorPage(second);
    expect(page).toMatchObject({agentIdentityKey:null,canReturnToQueue:false,humanRequest:{generation:1,anchorMessageId:sent.message.id}});
    const queue=(await app.inject({method:'GET',url:'/v1/management/support/conversations',headers:auth(second)})).json();
    expect(queue.items.find((row:any)=>row.id===returned.id)).toMatchObject({member:{identityBadge:'administrator',avatarDataUrl:avatar.data},status:'waiting_human'});
    expect(JSON.stringify(queue)).not.toMatch(/sender_principal_id|openid|phone_masked/);
    const reassigned=(await command(second,'claim',returned.version)).json();
    expect(reassigned.status).toBe('human_active');
    const payload={body:'可以继续核对旧问题。',clientMessageId:'support-return-answer',replyToMessageId:sent.message.id,expectedHumanRequestGeneration:1,contextVersion:0};
    expect((await app.inject({method:'POST',url:`${base}/messages`,headers:auth(first),payload})).statusCode).toBe(409);
    const reply=await app.inject({method:'POST',url:`${base}/messages`,headers:auth(second),payload});
    expect(reply.statusCode).toBe(200);
    expect(reply.json().message).toMatchObject({replyToMessageId:sent.message.id,sender:{identityBadge:'support'}});
    expect((await pool.query("SELECT 1 FROM audit_log WHERE object_id=$1 AND action='support.conversation.return_to_queue'",[returned.id])).rowCount).toBe(1);
  });
});
