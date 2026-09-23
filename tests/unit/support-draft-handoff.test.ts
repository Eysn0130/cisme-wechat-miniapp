import { afterEach, expect, it, vi } from 'vitest';
import { stageSupportDraft, takeSupportDraft } from '../../apps/miniprogram/services/support-draft-handoff';

afterEach(()=>{vi.useRealTimers();stageSupportDraft('','','');});

it('hands an unsent support draft to the same account and order once',()=>{
  stageSupportDraft('session-a','order-a','请帮我核对运单');
  expect(takeSupportDraft('session-a','order-a')).toBe('请帮我核对运单');
  expect(takeSupportDraft('session-a','order-a')).toBeNull();
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
