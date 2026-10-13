# 正式机内封闭体验协议（2026-10-13）

已经准备结构完整的两份协议、十三类资料保存清理清单和三附件。用户授权我们判断研究验证运营参数，已采用北京时间09:00–22:00人工接待、其他时间留言后处理，普通结案咨询三个日历月、交易关联证据三年业务基线及必要例外，体验结束/退出按最短必要目的清理。**不再等待用户逐项填写这三项参数。** 原句、研究和技术来源见 [授权与研究记录](USER-AUTHORIZATION-AND-RESEARCH.md)。

候选准备完成后，根代理于12:55 UTC依据本轮用户授权使用既有事务发布器，已将本目录准确文本发布到独立 `cisme_trial`，增加两份文档及一条 `legal.publish` 审计。可信本机TLS `/v1/legal` 已返回 `ready=true`，两正文SHA与文件一致。正式协议、四个服务PID和UFW未改变，会员及三个同意表计数仍全部为0；未改微信平台或开放公网，未记录独立法务签字、实际客服送达或真机通过。[实际发布回执](../../evidence/production-runtime-20261013/trial-legal-publication.json)与初始空库读回分别保存。

## 可审阅文件

- [用户协议模板](TERMS-CANDIDATE.md) 与 [隐私政策模板](PRIVACY-CANDIDATE.md)：只覆盖封闭体验，明确未开放销售、真实支付/退款/发货、积分消费、公众UGC和AI自动答复。
- [经营者与联系信息](ANNEX-OPERATOR.md)、[个人信息保存与清理清单](ANNEX-RETENTION.md)、[第三方信息清单](ANNEX-RECIPIENTS.md)：已同时完整附入隐私正文，原生协议页无需再跳转才能阅读。
- [publication-candidate.json](publication-candidate.json)：现有事务发布器需要的真实schema——顶层为两项数组，每项是 `type/version/title/body/operatorName/contact`；不是清单wrapper，没有伪造批准字段。
- [PUBLICATION-FACTS.json](PUBLICATION-FACTS.json)：现有 `LegalReleaseFacts` 输入，十三类retention各一行、实际提供方两行，保存事实和能力限制。`sellerName` 明确本次不开放销售，不猜测未来卖方。
- [版本摘要](CANDIDATE-MANIFEST.json) 与 [状态清单](FACTS-CHECKLIST.json)：绑定版本、正文SHA-256和实际体验库发布回执。

版本是 `2026-10-13-v1-trial`。拟适用日期2026-10-13，正文明确实际在体验环境发布展示后才适用；若实际安排变更，应形成新版本/日期，不能覆盖既有已发布版本。

## 生成与验证

本候选使用现有 `assembleLegalPublication`，传入本目录体验专用模板；没有修改helper，避免固定正式商务模板把未开放购买/支付/退货写成可用能力。再次生成使用新输出文件名，以独占创建保留版本。

```sh
cd /Users/mini/CISME
node --import tsx --input-type=module - <<'JS'
import {readFile,writeFile} from 'node:fs/promises';
import {assembleLegalPublication,validateLegalPublication} from './scripts/legal-publication.ts';
const base='docs/legal/trial-on-production-20261013/';
const facts=JSON.parse(await readFile(base+'PUBLICATION-FACTS.json','utf8'));
const docs=assembleLegalPublication(await readFile(base+'TERMS-CANDIDATE.md','utf8'),await readFile(base+'PRIVACY-CANDIDATE.md','utf8'),facts);
for(const d of docs)d.title=d.type==='terms'?'CISME 用户协议（封闭体验）':'CISME 隐私政策（封闭体验）';
validateLegalPublication(docs);
await writeFile(base+'publication-review-next.json',JSON.stringify(docs,null,2)+'\n',{flag:'wx'});
console.log('Two trial documents and all three annexes structurally validated; no database publication.');
JS
```

发布执行使用既有事务程序及对应证据，首次封闭体验按照PRD §15.6首次门槛推进；不把完整商业上线的RPO/RTO或全量真机矩阵额外前置。体验库协议已非空，不再阻塞协议加载；这仍无法替代公网/备案、微信后台合法域名/隐私/版本/名单、真实微信身份和平台客服接待读回，也不是待用户补写运营参数。
