import { describe, expect, it, vi } from 'vitest';
vi.mock('../../apps/miniprogram/services/page-requests', () => ({ cancelPageReads: vi.fn() }));
import { runtimeActions, runtimeView, validateRuntime } from '../../apps/miniprogram/services/commerce-runtime';
import type { CommerceOrderRuntimeStatus } from '../../apps/miniprogram/services/orders';

const isolated: CommerceOrderRuntimeStatus = {
  version: 1, currency: 'CNY', orderFlowEnabled: true, paymentAvailable: false,
  paymentOnboarding: 'IN_PROGRESS', scope: 'verified_isolated_test',
  isolatedMoneyOperationsAvailable: true, isolatedTransferAvailable: true,
  isolatedCreditCheckoutAvailable: true
};
const formal: CommerceOrderRuntimeStatus = {
  version: 2, currency: 'CNY', orderFlowEnabled: true, paymentAvailable: true,
  paymentOnboarding: 'READY', scope: 'formal_commerce', formalMoneyOperationsAvailable: true,
  formalRecoveryAvailable: true, isolatedMoneyOperationsAvailable: false,
  isolatedTransferAvailable: false, isolatedCreditCheckoutAvailable: false
};
const closed = { money: false, recovery: false, transfer: false, credit: false };
const invalid: unknown[] = [
  null, [], { ...isolated, version: 99 },
  { ...isolated, scope: 'synthetic_nonproduction' },
  { ...isolated, scope: 'disabled' },
  { ...isolated, formalRecoveryAvailable: true },
  { ...isolated, formalMoneyOperationsAvailable: 'false' },
  { ...isolated, isolatedMoneyOperationsAvailable: 'true' },
  { ...formal, paymentAvailable: false },
  { ...formal, formalRecoveryAvailable: 'true' },
  { ...formal, isolatedCreditCheckoutAvailable: true }
];
describe('native runtime projection at the action boundary', () => {
  it.each(invalid.map(value => [value]))('rejects an invalid projection and exposes no write action: %j', value => {
    expect(() => validateRuntime(value)).toThrow('Unsupported commerce capability contract');
    expect(runtimeActions(value as CommerceOrderRuntimeStatus)).toEqual(closed);
  });
  it.each(['disabled', 'synthetic_nonproduction'] as const)('keeps %s read-only', scope => {
    const value = { ...isolated, scope, isolatedMoneyOperationsAvailable: false,
      isolatedTransferAvailable: false, isolatedCreditCheckoutAvailable: false };
    expect(validateRuntime(value)).toEqual(value);
    expect(runtimeActions(value)).toEqual(closed);
  });
  it('preserves the existing isolated capabilities', () => {
    expect(runtimeActions(isolated)).toEqual({ money: true, recovery: false, transfer: true, credit: true });
  });
  it('keeps formal commerce separate from isolated transfers and credit', () => {
    expect(runtimeActions(formal)).toEqual({ money: true, recovery: true, transfer: false, credit: false });
  });
  it('keeps recovery available when new formal payments are paused', () => {
    const value = { ...formal, orderFlowEnabled: false, paymentAvailable: false,
      formalMoneyOperationsAvailable: false, paymentOnboarding: 'IN_PROGRESS' as const };
    expect(runtimeActions(value)).toEqual({ ...closed, recovery: true });
  });
  it('does not mislabel an isolated run as real payment in the shorter copy', () => {
    expect(runtimeView(isolated).runtimeCopy).toContain('测试环境');
    expect(runtimeView(isolated).runtimeCopy).toContain('不会真实扣款');
    expect(runtimeView(formal).runtimeCopy).not.toMatch(/合成|隔离|渠道事实/);
  });
});
