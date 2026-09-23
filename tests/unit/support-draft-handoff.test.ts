import { afterEach, expect, it, vi } from 'vitest';
import { stageSupportDraft, takeSupportDraft, stageSupportSendAttempt, takeSupportSendAttempt } from '../../apps/miniprogram/services/support-draft-handoff';

afterEach(()=>{vi.useRealTimers();stageSupportDraft('','','');stageSupportSendAttempt('','',null);});

it('hands an unsent support draft to the same account and order once',()=>{
  stageSupportDraft('session-a','order-a','请帮我核对运单');
  expect(takeSupportDraft('session-a','order-a')).toBe('请帮我核对运单');
  expect(takeSupportDraft('session-a','order-a')).toBeNull();
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
