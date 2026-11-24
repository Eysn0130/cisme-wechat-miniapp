import { describe, expect, it } from 'vitest';
import { ApprovedKnowledgeRegistry, SupportAiBoundary } from '../../services/api/src/supportAiBoundary';
import { catalogAnswer, supportCatalogKnowledge } from '../../services/api/src/supportCatalogKnowledge';
import { redactSupportModelText, supportKnowledge } from '../../services/api/src/deepseekSupportAi';
import { supportKnowledgeGrounding } from '../../services/api/src/supportKnowledgeRetrieval';
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
    expect(observed).toEqual([a.version, b.version]); expect(boundary.status().approvedKnowledgeSources).toHaveLength(supportKnowledge().length);
    const wrong = new SupportAiBoundary({ id: 'wrong-citation', available: true, async suggest() {
      return { text: '错误版本', confidence: 1, handoffReason: null, citations: [{ sourceId: a.id, version: a.version }] };
    } }, new ApprovedKnowledgeRegistry(supportKnowledge()));
    await expect(wrong.suggestedReply(conversation, [b])).rejects.toMatchObject({ code: 'SUPPORT_AI_UNGROUNDED' });
  });
  it('answers exact product price from the supplied snapshot and asks to identify an unspecified item',()=>{
    expect(catalogAnswer(catalog(),'净润小紫瓶 280mL 多少钱？')).toContain('280mL ¥198.00');
    expect(catalogAnswer(catalog(20100),'净润小紫瓶 280mL 多少钱？')).toContain('¥201.00');
    expect(catalogAnswer(catalog(),'多少钱？')).toContain('哪款');
    expect(catalogAnswer(supportCatalogKnowledge(null),'净润小紫瓶多少钱？')).toContain('暂时无法确认');
  });
  it('describes the published product from its own snapshot without promising a gift, sale or other size',()=>{
    const published=supportCatalogKnowledge({ checkoutEnabled:false, items:[{name:'净润小紫瓶 280mL',
      subtitle:'买 280 mL，享 620 mL',description:'简短的商城介绍。买 280 mL，享 620 mL。',shoppingPointsMultiplier:3,
      variants:[{label:'净润小紫瓶 280mL',currency:'CNY',priceCents:19800,inStock:true,purchaseEnabled:false}]}] });
    const answer=catalogAnswer(published,'介绍一下小紫瓶，280毫升定价多少？');
    expect(answer).toContain('商城介绍「简短的商城介绍」');
    expect(answer).toContain('¥198.00');
    expect(answer).toContain('商城当前暂不可下单');
    expect(answer).not.toContain('620');
    expect(catalogAnswer(published,'小紫瓶620毫升什么价格？')).toMatch(/^商城当前资料未能确认这个规格/);
    expect(catalogAnswer(published,'小紫瓶有赠品吗？')).toContain('以商城和结算页显示为准');
    expect(catalogAnswer(published,'商城积分规则是什么？')).toBeNull();
  });
  it('uses the cited current catalog for product facts even when a general help guide was also cited',async()=>{
    const registry=new ApprovedKnowledgeRegistry(supportKnowledge());
    const live=catalog();
    const boundary=new SupportAiBoundary({id:'synthetic',available:true,async suggest({knowledge}){
      const selected=knowledge.filter(item=>[live.id,'cisme.help-shop'].includes(item.id));
      expect(selected).toHaveLength(2);
      return {text:'The model quoted the wrong number.',confidence:1,handoffReason:null,
        citations:selected.map(({id,version})=>({sourceId:id,version}))};
    }},registry,1000,false,supportKnowledgeGrounding);
    const answer=await boundary.suggestedReply({...conversation,question:{sequence:1,body:'小紫瓶怎么买，定价多少？'}},[live]);
    expect(answer.text).toContain('¥198.00');
    expect(answer.citations).toEqual([{sourceId:live.id,version:live.version}]);
  });
  it('redacts volunteered order, waybill and contact identifiers without swallowing ordinary WeChat questions', () => {
    const message = '订单号：CM202611110001，快递单号为SF1234567890。微信号是member_secret；联系手机：13800138000';
    expect(redactSupportModelText(message)).not.toMatch(/CM2026|SF123|member_secret|138001/);
    expect(redactSupportModelText('微信支付怎么使用，护理精华多少钱？')).toBe('微信支付怎么使用，护理精华多少钱？');
  });
});
