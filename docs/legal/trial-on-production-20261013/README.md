# 正式机内隔离体验协议：事实准备清单（2026-10-13）

本目录只记录事实、缺口和生成方法。没有已批准协议，没有向体验库或生产库发布，也没有代会员创建同意。[FACTS-CHECKLIST.json](FACTS-CHECKLIST.json) 是状态清单，**不能**直接交给 `prepare-legal-documents.ts`。它记录本轮核验的来源与限制；本轮只读结果见[脱敏服务器回执](../../evidence/production-runtime-20261013/runtime-readback.json)。

交付仍按 PRD §15.5、§15.6、BASE-WX 和 G0-PRE/G0-OPS 裁决。当前小程序输入哈希为 `3c895fb74af445001cc5b731dc1199eba90cfe8f0536a1f3d8faa789a2a3901d`；本清单不增加视觉或真机通过证据。

## 复用已有确认

[经营事实确认](../CONFIRMED-OPERATING-FACTS-20260923.md) 已明确公司主体为熹芃（上海）生物科技有限公司、联系渠道为现有微信小程序客服、交易及直接关联售后/客服的三年业务基线、其他资料最短必要保存和备份恢复抑制原则。无需再次从空白填写这些信息，也不新增电话、邮箱、第二客服或独立后台。经营确认不等于平台主体绑定、客服送达或本次文本审批。

当前体验在正式实例 `lhins-61ikz4mi` / `124.223.74.198`，API 为 `https://staging-api.cisme.cn`。本轮只读回执核实独立体验系统用户、数据库/角色、媒体与抑制目录，以及六类独立配置；仅说明配置隔离，不暴露任何秘密或摘要。真实交易、模拟支付、履约、积分消费/规则、公众 UGC、COS 直传和手机号绑定关闭，运行值 `ALLOW_DEV_ADAPTERS=false`。

体验存储实际采用 `api_gateway` 与同机私有媒体目录。旧协议的 CloudBase、COS、海外环境描述不能直接复用。本机正常证书验证的 `/v1/legal` 返回 HTTP 200、`ready=false`、空文档，新库没有协议。没有体验备份 unit；生产备份不覆盖体验库，体验备份目标权限仍未就绪。不得把这些缺口写成消费者已经可用的保障。公网、真实微信身份、客服接待、上传/清理/删除/恢复抑制和平台合法域名仍待实际核验。

## 最少尚缺的运营输入

| 输入 | 已知内容与需确认范围 | 技术先完成 |
| --- | --- | --- |
| 现有客服接待安排 | 沿用同一微信小程序客服；确认可对外说明的服务时段和无法登录时的受理安排，不索取新个人联系方式 | 核对平台接待配置，真机实收与回复；现有 `open-type=contact` 只能证明源码入口 |
| 普通咨询保留参数 | 与交易关联客服分别处理。体验库已读回三个日历月；确认接受或调整该参数及例外，不能把配置称为已批准 | 普通策略 `active=true/enforced/version=2`，自动清理关闭；继续核对结案触发、手动执行范围和争议/hold 例外 |
| 体验结束条件 | 确认成员退出、封闭体验结束或测试目的完成后的护理、私有投稿、资格/权益数据处理条件；必要争议/审计保留范围另列 | 技术按已确认原则准备十三类附件，明确实际删除、匿名化、隔离和备份能力 |

十三类资料不需要经营者重填十三套相同原则。技术先根据实际对象、源码、服务配置和既有经营输入形成带依据的分类附件；只把无法自动核实的保留目的/期限/终止条件和清理责任交经营者确认。实际提供方的服务名、处理位置和接线由技术核对，提供方名称、处理关系及公开联系方式按已有服务条款确认，不能让用户重新抄写技术配置。尚未批准的期限定为待确认，不能代选数字。

2026-10-13 11:52:32 UTC 的体验策略读回还确认：客服审计没有固定天/月且未启用；交易与交易关联客服的三年策略均为 `declared/active=false`，自动清理关闭。这些是配置事实，不是自动删除已执行或文本已批准证据。

本体验没有销售或履约，不因现有生成器要求 `sellerName` 就推定实际销售者或现在索取退货地址、支付资料。若保留商务正文或开放交易，再核实卖方及相应信息；当前先把体验正文的未开放范围说明清楚。

## 生成器要求和可执行方法

`scripts/legal-publication.ts` 的 `LegalReleaseFacts` 要求：

- `version/effectiveDate/operatorName/sellerName/publicContact/operatorEvidence/contactEvidence`；
- `retention` 恰好覆盖 `account/optional_profile/care_media/addresses/order_payment/aftersale_support/community/benefits/privacy_requests/security_audit/temporary_exports/local_cache/backups` 各一次；每行需要 `category/purpose/endCondition/cleanup/exceptions`；
- `recipients` 至少一行；每行需要 `name/relationship/purpose/data/location/publicContact`。

生成的隐私正文必须含“经营者与联系信息”“个人信息保存与清理清单”“第三方信息清单”三份可读附件。四份旧 publication JSON 均缺这些附件，当前验证器拒绝它们；不能重用旧版本或仅补一个 `approved` 字段。

完成并核实上述输入后，在唯一工程根目录运行以下命令。事实来源和审阅稿放在被忽略的 `tmp/`；不加入证件号码、秘密、会员信息或凭据。有效日期由实际拟生效安排确定，不自动使用本清单日期。

```sh
cd /Users/mini/CISME
mkdir -p tmp/legal/trial-on-production-20261013
node --import tsx scripts/prepare-legal-documents.ts \
  tmp/legal/trial-on-production-20261013/VERIFIED-FACTS.json \
  tmp/legal/trial-on-production-20261013/PUBLICATION-REVIEW.json
```

命令需要先存在完整 `VERIFIED-FACTS.json`；清单保留缺口，不制造可通过的占位值。输出使用独占创建，已存在时停止，审阅修订使用新文件名。

**现有生成器固定读取** `production-candidate-20260923/` **正式商务模板**，首段及付款、退货、互动等条款覆盖当前体验未开放能力。它能组装字段和附件，但不能自动保证体验范围正确；上述命令只生成未发布审阅稿。须先核对并收窄体验正文，解决 `sellerName` 的不适用范围，再完成文本审阅、真实批准、原生可读展示、客服送达与实际配置的一致性核对。不得把脚本校验成功当作法务批准。

本目录不提供数据库发布命令。获得匹配具体版本/正文哈希/环境的真实批准后，再按既有事务发布器和相应变更门禁执行；之后分别回读协议和真实微信身份。备案、上传成功、HTTPS、本地模拟器或历史截图均不能替代这些证据。
