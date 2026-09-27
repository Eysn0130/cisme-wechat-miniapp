import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {assembleLegalPublication, retentionCodes, validateLegalPublication, type LegalReleaseFacts} from '../../scripts/legal-publication.js';

const base = new URL('../../docs/legal/production-candidate-20260923/', import.meta.url);
const terms = readFileSync(new URL('用户协议.md', base), 'utf8');
const privacy = readFileSync(new URL('隐私政策.md', base), 'utf8');
const facts:LegalReleaseFacts = {
  version: 'synthetic-v1', effectiveDate: '2026-09-23', operatorName: '合成运营主体', sellerName: '合成销售主体',
  publicContact: '合成公开联系入口', operatorEvidence: '隔离主体核验记录', contactEvidence: '隔离渠道核验记录',
  retention: retentionCodes.map(code => ({code, category: `${code} 类资料`, purpose: '提供对应服务',
    endCondition: '具体目的完成并核验保存义务终止', cleanup: '随后清理业务副本', exceptions: '有效保全范围内限制使用'})),
  recipients: [{name: '合成平台', relationship: '受托处理', purpose: '提供隔离服务', data: '最小业务资料',
    location: '隔离环境', publicContact: '合成平台公开联系入口'}]
};

describe('legal publication boundary', () => {
  it('assembles both complete consumer texts with readable annexes but no internal draft markers', () => {
    const [agreement, policy] = assembleLegalPublication(terms, privacy, facts);
    expect(agreement?.body).toContain('七日无理由退货');
    expect(policy?.body).toContain('个人信息保存与清理清单');
    expect(policy?.body).toContain('第三方信息清单');
    expect(policy?.body).not.toContain('{{');
    expect(policy?.body).not.toContain('必须由代码/配置完成');
    expect(validateLegalPublication([agreement, policy])).toHaveLength(2);
  });
  it('rejects missing data classes, recipient facts and unverifiable draft text before publication', () => {
    expect(() => assembleLegalPublication(terms, privacy, {...facts, retention: facts.retention.slice(1)}))
      .toThrow(/Retention inventory/);
    expect(() => assembleLegalPublication(terms, privacy, {...facts, recipients: []}))
      .toThrow(/Third-party inventory/);
    expect(() => assembleLegalPublication(terms, privacy, {...facts, publicContact: '待填写'}))
      .toThrow(/Missing verified public contact/);
    const documents = assembleLegalPublication(terms, privacy, facts);
    expect(() => validateLegalPublication(documents.map(doc => doc.type === 'terms'
      ? {...doc, body: `${doc.body}\n{{运营主体全称}}`} : doc))).toThrow(/Incomplete publication data/);
  });
  it('rejects inconsistent operator identity and malformed effective date', () => {
    const documents = assembleLegalPublication(terms, privacy, facts);
    expect(() => validateLegalPublication(documents.map(doc => doc.type === 'privacy'
      ? {...doc, operatorName: '另一个主体'} : doc))).toThrow(/same operator/);
    expect(() => assembleLegalPublication(terms, privacy, {...facts, effectiveDate: '2026-02-30'}))
      .toThrow();
  });
});
