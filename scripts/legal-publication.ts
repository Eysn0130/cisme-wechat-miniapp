export type LegalDocument = {
  type: 'terms' | 'privacy' | 'cross_border';
  version: string;
  title: string;
  body: string;
  operatorName: string;
  contact: string;
};

const draftMarker = /\{\{[^}]+\}\}|TBD|待填写|测试占位|example\.invalid|正式环境候选|未生效|生产待批准|合成身份|工程测试/i;
const annexTitles = ['经营者与联系信息', '个人信息保存与清理清单', '第三方信息清单'];

export function validateLegalPublication(value: unknown): LegalDocument[] {
  if (!Array.isArray(value) || ![2, 3].includes(value.length)) throw new Error('Both terms and privacy are required');
  const documents = value as LegalDocument[];
  const types = documents.map(doc => doc?.type);
  if (new Set(types).size !== documents.length || types.some(type => !['terms', 'privacy', 'cross_border'].includes(type)) ||
      !['terms', 'privacy'].every(type => types.includes(type as LegalDocument['type'])))
    throw new Error('Both terms and privacy are required');
  for (const doc of documents) {
    if (![doc.version, doc.title, doc.body, doc.operatorName, doc.contact].every(field => typeof field === 'string') ||
        doc.body.trim().length < 100 || [doc.version, doc.title, doc.body, doc.operatorName, doc.contact].some(field =>
          !field.trim() || draftMarker.test(field))) throw new Error(`Incomplete publication data: ${doc.type}`);
  }
  const terms = documents.find(doc => doc.type === 'terms')!;
  const privacy = documents.find(doc => doc.type === 'privacy')!;
  if (terms.operatorName !== privacy.operatorName || terms.contact !== privacy.contact)
    throw new Error('Terms and privacy must name the same operator and public contact');
  if (!annexTitles.every(title => privacy.body.includes(title)))
    throw new Error('Privacy publication must include all three readable annexes');
  return documents;
}

export type LegalReleaseFacts = {
  version: string;
  effectiveDate: string;
  operatorName: string;
  sellerName: string;
  publicContact: string;
  operatorEvidence: string;
  contactEvidence: string;
  retention: {code: string; category: string; purpose: string; endCondition: string; cleanup: string; exceptions: string}[];
  recipients: {name: string; relationship: string; purpose: string; data: string; location: string; publicContact: string}[];
};

export const retentionCodes = ['account', 'optional_profile', 'care_media', 'addresses', 'order_payment',
  'aftersale_support', 'community', 'benefits', 'privacy_requests', 'security_audit', 'temporary_exports',
  'local_cache', 'backups'] as const;

function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || draftMarker.test(value)) throw new Error(`Missing verified ${label}`);
  return value.trim();
}

function replaceTemplate(template: string, fields: Record<string, string>): string {
  const body = template.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    if (!fields[key]) throw new Error(`Unknown legal template field: ${key}`);
    return fields[key];
  });
  if (draftMarker.test(body)) throw new Error('Unresolved legal template field');
  return body.trim();
}

/** Prepares the exact JSON consumed by the existing transactional publisher.
 * Business facts stay outside source and require a separate evidence-backed input. */
export function assembleLegalPublication(termsTemplate: string, privacyTemplate: string, facts: LegalReleaseFacts): LegalDocument[] {
  const version = required(facts?.version, 'version');
  const effectiveDate = required(facts?.effectiveDate, 'effective date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || new Date(`${effectiveDate}T00:00:00Z`).toISOString().slice(0, 10) !== effectiveDate)
    throw new Error('Effective date must be a real ISO calendar date');
  const operatorName = required(facts.operatorName, 'operator');
  const sellerName = required(facts.sellerName, 'seller');
  const contact = required(facts.publicContact, 'public contact');
  required(facts.operatorEvidence, 'operator evidence');
  required(facts.contactEvidence, 'contact evidence');
  if (!Array.isArray(facts.retention) || facts.retention.length !== retentionCodes.length ||
      new Set(facts.retention.map(row => row?.code)).size !== retentionCodes.length ||
      !retentionCodes.every(code => facts.retention.some(row => row?.code === code)))
    throw new Error('Retention inventory must cover each named data category exactly once');
  for (const row of facts.retention) {
    required(row.category, `${row.code} category`);
    required(row.purpose, `${row.code} purpose`);
    required(row.endCondition, `${row.code} end condition`);
    required(row.cleanup, `${row.code} cleanup`);
    required(row.exceptions, `${row.code} exceptions`);
  }
  if (!Array.isArray(facts.recipients) || !facts.recipients.length) throw new Error('Third-party inventory is missing');
  for (const row of facts.recipients)
    for (const field of ['name', 'relationship', 'purpose', 'data', 'location', 'publicContact'] as const)
      required(row[field], `${row.name ?? 'recipient'} ${field}`);

  const fields = {'协议版本': version, '隐私政策版本': version, '生效日期': effectiveDate, '运营主体全称': operatorName};
  const operatorText = `运营主体：${operatorName}。实际销售者：${sellerName}。公开联系渠道：${contact}。`;
  const termsBody = replaceTemplate(termsTemplate, fields) + `\n\n### 经营者与联系信息\n\n${operatorText}`;
  const retentionLines = facts.retention.map(row =>
    `- ${row.category}：用途为${row.purpose}；保存至${row.endCondition}；${row.cleanup}；例外：${row.exceptions}。`).join('\n');
  const recipientLines = facts.recipients.map(row =>
    `- ${row.name}（${row.relationship}）：${row.purpose}；涉及${row.data}；处理位置：${row.location}；联系渠道：${row.publicContact}。`).join('\n');
  const annexes = `\n\n### 经营者与联系信息\n\n${operatorText}\n\n`+
    `### 个人信息保存与清理清单\n\n${retentionLines}\n\n### 第三方信息清单\n\n${recipientLines}`;
  const privacyBody = replaceTemplate(privacyTemplate, fields) + annexes;
  return validateLegalPublication([
    {type: 'terms', version, title: 'CISME 用户协议', body: termsBody, operatorName, contact},
    {type: 'privacy', version, title: 'CISME 隐私政策', body: privacyBody, operatorName, contact}
  ]);
}
