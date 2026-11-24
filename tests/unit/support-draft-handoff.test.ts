import { afterEach, expect, it, vi } from 'vitest';
import { GENERAL_SUPPORT_SCOPE, clearSupportDraftHandoffs, stageSupportDraft, takeSupportDraft, stageSupportSendAttempt, takeSupportSendAttempt, stageSupportRecovery, takeSupportRecovery } from '../../apps/miniprogram/services/support-draft-handoff';

afterEach(()=>{vi.useRealTimers();clearSupportDraftHandoffs();});

it('hands an unsent support draft to the same account and order once',()=>{
  stageSupportDraft('session-a','order-a','请帮我核对运单');
  expect(takeSupportDraft('session-a','order-a')).toBe('请帮我核对运单');
  expect(takeSupportDraft('session-a','order-a')).toBeNull();
});

it('retains an ordinary support draft and uncertain send only for the same account and scope',()=>{
  stageSupportDraft('session-a',GENERAL_SUPPORT_SCOPE,'未发送的客服正文');
  expect(takeSupportDraft('session-a',GENERAL_SUPPORT_SCOPE)).toBe('未发送的客服正文');
  const attempt={id:'support-general-1',body:'发送结果未确认',linkedOrderId:null};
  stageSupportSendAttempt('session-a',GENERAL_SUPPORT_SCOPE,attempt);
  expect(takeSupportSendAttempt('session-b',GENERAL_SUPPORT_SCOPE)).toBeNull();
  stageSupportSendAttempt('session-a',GENERAL_SUPPORT_SCOPE,attempt);
  expect(takeSupportSendAttempt('session-a',GENERAL_SUPPORT_SCOPE)).toEqual(attempt);
});

it('keeps the exact uncertain support message ID for a same-account order handoff',()=>{
  const attempt={id:'support-original-1',body:'请核对漏发',linkedOrderId:'order-a',expectedConversationId:'conversation-a',contextVersion:12};
  stageSupportSendAttempt('session-a','order-a',attempt);
  expect(takeSupportSendAttempt('session-a','order-a')).toEqual(attempt);
  expect(takeSupportSendAttempt('session-a','order-a')).toBeNull();
});

it('discards uncertain support sends across account, order, and expiry boundaries',()=>{
  const attempt={id:'support-original-2',body:'私人订单内容',linkedOrderId:'order-a'};
  stageSupportSendAttempt('session-a','order-a',attempt);
  expect(takeSupportSendAttempt('session-b','order-a')).toBeNull();
  stageSupportSendAttempt('session-a','order-a',attempt);
  expect(takeSupportSendAttempt('session-a','order-b')).toBeNull();
  stageSupportSendAttempt('session-a','order-a',attempt);
  vi.useFakeTimers();
  vi.advanceTimersByTime(10*60*1000+1);
  expect(takeSupportSendAttempt('session-a','order-a')).toBeNull();
  stageSupportSendAttempt('session-a','order-b',attempt);
  expect(takeSupportSendAttempt('session-a','order-b')).toBeNull();
});

it('discards drafts across account or order changes and after a short idle window',()=>{
  stageSupportDraft('session-a','order-a','私人订单内容');
  expect(takeSupportDraft('session-b','order-a')).toBeNull();
  expect(takeSupportDraft('session-a','order-a')).toBeNull();
  stageSupportDraft('session-a','order-a','另一条内容');
  expect(takeSupportDraft('session-a','order-b')).toBeNull();
  vi.useFakeTimers();
  stageSupportDraft('session-a','order-a','过期内容');
  vi.advanceTimersByTime(10*60*1000+1);
  expect(takeSupportDraft('session-a','order-a')).toBeNull();
});

it('bounds full chat recovery to the same identity, scope and environment revision',()=>{
  vi.useFakeTimers();
  const parked={body:'待核对',messageId:'original-key'};
  stageSupportRecovery('session-a',1,'operator:conversation-a',parked);
  expect(takeSupportRecovery('session-a',1,'operator:conversation-b')).toBeNull();
  expect(takeSupportRecovery('session-a',1,'operator:conversation-a')).toEqual(parked);
  expect(takeSupportRecovery('session-a',1,'operator:conversation-a')).toBeNull();
  stageSupportRecovery('session-a',1,'operator:conversation-a',parked);
  expect(takeSupportRecovery('session-a',2,'operator:conversation-a')).toBeNull();
  stageSupportRecovery('session-a',2,'operator:conversation-a',parked);
  vi.advanceTimersByTime(10*60_000+1);
  expect(takeSupportRecovery('session-a',2,'operator:conversation-a')).toBeNull();
});

it('clears all support handoffs even if the previous session later returns',()=>{
  stageSupportDraft('session-a','order-a','私人订单正文');
  stageSupportSendAttempt('session-a','order-a',{id:'previous-key',body:'待核对',linkedOrderId:'order-a'});
  stageSupportRecovery('session-a',1,'operator:conversation-a',{body:'待核对'});
  clearSupportDraftHandoffs();
  expect(takeSupportDraft('session-a','order-a')).toBeNull();
  expect(takeSupportSendAttempt('session-a','order-a')).toBeNull();
  expect(takeSupportRecovery('session-a',1,'operator:conversation-a')).toBeNull();
});
