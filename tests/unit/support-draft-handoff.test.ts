import { afterEach, expect, it, vi } from 'vitest';
import { GENERAL_SUPPORT_SCOPE, stageSupportDraft, takeSupportDraft, stageSupportSendAttempt, takeSupportSendAttempt } from '../../apps/miniprogram/services/support-draft-handoff';

afterEach(()=>{vi.useRealTimers();stageSupportDraft('','','');stageSupportSendAttempt('','',null);});

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
  const attempt={id:'support-original-1',body:'请核对漏发',linkedOrderId:'order-a'};
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
