import { describe, expect, it } from 'vitest';
import { ApprovedKnowledgeRegistry, SupportAiBoundary } from '../../services/api/src/supportAiBoundary';
import { supportCatalogKnowledge } from '../../services/api/src/supportCatalogKnowledge';
import { redactSupportModelText, supportKnowledge } from '../../services/api/src/deepseekSupportAi';
const catalog = (priceCents = 19800) => supportCatalogKnowledge({ checkoutEnabled: true, nextCursor: null,
  items: [{ name: '净润小紫瓶', subtitle: '已发布', description: '按产品说明使用', shoppingPointsMultiplier: 3,
    variants: [{ label: '280mL', currency: 'CNY', priceCents, inStock: true, purchaseEnabled: true }] }] });
const conversation = { conversationId: 'synthetic', status: 'ai_active', messages: [{ sequence: 1, senderType: 'user', body: '多少钱？' }] };
describe('approved live catalog knowledge', () => {
  it('projects only public fields, versions exact facts, and distinguishes unavailable/incomplete from empty', () => {
    const source = catalog(), page = { checkoutEnabled: true, nextCursor: 'more', items: [] };
    expect(() => new ApprovedKnowledgeRegistry([source])).not.toThrow();
    expect(source.content).toContain('"priceCents":19800'); expect(source.content).toContain('"shoppingPointsMultiplier":3');
    expect(source.version).not.toBe(catalog(19900).version);
    expect(supportCatalogKnowledge(null).content).toContain('"available":false');
    expect(supportCatalogKnowledge(page).content).toContain('"complete":false');
    const withPrivate = { ...page, privateMember: { phone: 'SECRET_PHONE' }, items: [{ name: '公开名称', subtitle: '', description: '', shoppingPointsMultiplier: 1,
      orderId: 'SECRET_ORDER', variants: [{ label: '一件', priceCents: 100, currency: 'CNY', inStock: false, purchaseEnabled: false, supplierSecret: 'SECRET_SUPPLIER' }] }] };
    expect(supportCatalogKnowledge(withPrivate).content).not.toMatch(/SECRET_|orderId|phone|supplierSecret/);
  });
  it('isolates simultaneous snapshots and rejects a citation from another request', async () => {
    const a = catalog(), b = catalog(19900), observed: string[] = [];
    const boundary = new SupportAiBoundary({ id: 'synthetic', available: true, async suggest({ knowledge }) {
      const live = knowledge.find(item => item.id === 'cisme.catalog-live')!; observed.push(live.version);
      await Promise.resolve(); return { text: '请查看商品当前规格。', confidence: 1, handoffReason: null,
        citations: [{ sourceId: live.id, version: live.version }] };
    } }, new ApprovedKnowledgeRegistry(supportKnowledge()));
    const replies = await Promise.all([boundary.suggestedReply(conversation, [a]), boundary.suggestedReply(conversation, [b])]);
    expect(replies.map(reply => reply.citations[0]!.version)).toEqual([a.version, b.version]);
    expect(observed).toEqual([a.version, b.version]); expect(boundary.status().approvedKnowledgeSources).toHaveLength(3);
    const wrong = new SupportAiBoundary({ id: 'wrong-citation', available: true, async suggest() {
      return { text: '错误版本', confidence: 1, handoffReason: null, citations: [{ sourceId: a.id, version: a.version }] };
    } }, new ApprovedKnowledgeRegistry(supportKnowledge()));
    await expect(wrong.suggestedReply(conversation, [b])).rejects.toMatchObject({ code: 'SUPPORT_AI_UNGROUNDED' });
  });
  it('redacts volunteered order, waybill and contact identifiers without swallowing ordinary WeChat questions', () => {
    const message = '订单号：CM202611110001，快递单号为SF1234567890。微信号是member_secret；联系手机：13800138000';
    expect(redactSupportModelText(message)).not.toMatch(/CM2026|SF123|member_secret|138001/);
    expect(redactSupportModelText('微信支付怎么使用，护理精华多少钱？')).toBe('微信支付怎么使用，护理精华多少钱？');
  });
});
