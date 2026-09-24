import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
let state: any, requests: any[], navigate: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules(); requests = []; navigate = vi.fn();
  state = { globalData: { sessionToken: 'member-a', privacyRightsToken: '', apiBaseUrl: 'https://synthetic.invalid' } };
  vi.stubGlobal('getApp', () => state);
  vi.stubGlobal('getCurrentPages', () => [{ route: 'pages/privacy-rights/index' }]);
  vi.stubGlobal('wx', { request: (options: any) => { requests.push(options); return { abort() {} }; },
    navigateTo: navigate, getStorageSync: () => '', setStorageSync: vi.fn(), removeStorageSync: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('prelaunch historical rights and request context', () => {
  it('reads the historical balance with the closed-account token, without reopening login', async () => {
    const api = await import('../../apps/miniprogram/services/api');
    api.setPrivacyRightsToken('closed-rights');
    const pending = api.request({ path: '/v1/me/commercial-membership' });
    expect(requests).toHaveLength(1);
    expect(requests[0].header.Authorization).toBe('Bearer closed-rights');
    requests[0].success({ statusCode: 200, data: { commission: { availableCents: 12300 } } });
    await expect(pending).resolves.toMatchObject({ commission: { availableCents: 12300 } });
    expect(navigate).not.toHaveBeenCalled();
  });
  it('does not widen the rights token to membership writes or unrelated member routes', async () => {
    const api = await import('../../apps/miniprogram/services/api');
    api.setPrivacyRightsToken('closed-rights');
    await expect(api.request({ path: '/v1/me/commercial-membership/code', method: 'POST', data: {} }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    const guest = api.request({ path: '/v1/me', authMode: 'optional' });
    expect(requests).toHaveLength(1); expect(requests[0].header.Authorization).toBe('');
    requests[0].success({ statusCode: 200, data: { guest: true } }); await guest;
  });
  it.each(['GET', 'POST'] as const)('rejects a late %s result after A to B to A', async method => {
    const api = await import('../../apps/miniprogram/services/api');
    const pending = api.request({ path: '/v1/me/privacy-requests', method,
      ...(method === 'POST' ? { data: { kind: 'access' }, idempotencyKey: 'unchanged-original-request' } : {}) }).catch(error => error);
    api.setSessionToken('member-b'); api.setSessionToken('member-a');
    requests[0].success({ statusCode: 200, data: { stale: true } });
    expect(await pending).toMatchObject({ code: 'REQUEST_SESSION_CHANGED' });
    expect(state.globalData.sessionToken).toBe('member-a');
    expect(requests).toHaveLength(1);
  });
  it('does not clear a renewed same-token session after an obsolete write returns 401', async () => {
    const api = await import('../../apps/miniprogram/services/api');
    const pending = api.request({ path: '/v1/me/privacy-requests', method: 'POST', data: { kind: 'access' } }).catch(error => error);
    api.setSessionToken('member-b'); api.setSessionToken('member-a');
    requests[0].success({ statusCode: 401, data: { code: 'SESSION_EXPIRED' } });
    expect(await pending).toMatchObject({ code: 'REQUEST_SESSION_CHANGED' });
    expect(state.globalData.sessionToken).toBe('member-a'); expect(navigate).not.toHaveBeenCalled();
  });
  it.each(['api', 'cloud'] as const)('rejects old write results when the %s destination changes', async target => {
    const api = await import('../../apps/miniprogram/services/api');
    const pending = api.request({ path: '/v1/me/privacy-requests', method: 'POST', data: { kind: 'access' } }).catch(error => error);
    if (target === 'api') state.globalData.apiBaseUrl = 'https://different-synthetic.invalid';
    else state.globalData.cloudFunction = { env: 'another-isolated-env', name: 'api' };
    requests[0].success({ statusCode: 200, data: { wrongEnvironment: true } });
    expect(await pending).toMatchObject({ code: 'REQUEST_ENVIRONMENT_CHANGED' });
    expect(requests).toHaveLength(1); expect(navigate).not.toHaveBeenCalled();
  });
  it('retains page data only for an unchanged identity revision and destination', async () => {
    const api = await import('../../apps/miniprogram/services/api'), page = {};
    expect(api.retainMemberSnapshot(page)).toBe(false); expect(api.retainMemberSnapshot(page)).toBe(true);
    api.setSessionToken('member-b'); api.setSessionToken('member-a');
    expect(api.retainMemberSnapshot(page)).toBe(false); expect(api.retainMemberSnapshot(page)).toBe(true);
    state.globalData.apiBaseUrl = 'https://different-synthetic.invalid';
    expect(api.retainMemberSnapshot(page)).toBe(false); expect(api.retainMemberSnapshot(page)).toBe(true);
  });
});

it('keeps user-facing progress and order copy free of obsolete development claims', () => {
  const progress = readFileSync('apps/miniprogram/pages/progress/index.wxml', 'utf8');
  const orders = readFileSync('apps/miniprogram/pages/management-orders/index.wxml', 'utf8');
  const api = readFileSync('apps/miniprogram/services/api.ts', 'utf8');
  expect(progress).not.toMatch(/虚构积分流水|历史证据保持可审计|STATUS UNAVAILABLE/);
  expect(progress).toContain('submission.reward_enabled');
  expect(progress).toContain('本次投稿不发放积分');
  expect(orders).not.toContain('未来履约');
  expect(orders).toContain('!coreReady||navigating');
  expect(api).not.toContain('不要更换幂等键重复提交');
});

it('keeps aftersale touch targets at least 44 CSS pixels on narrow viewports', () => {
  const styles = readFileSync('apps/miniprogram/pages/aftersale/index.wxss', 'utf8');
  for (const selector of ['.choice', 'input', '.primary,.secondary']) {
    const body = styles.slice(styles.indexOf(`${selector}{`)).split('}')[0]!;
    expect(body).toContain('min-height:44px');
    expect(body).not.toContain('min-height:88rpx');
  }
});
