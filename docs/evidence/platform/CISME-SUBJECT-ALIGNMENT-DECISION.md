# CISME 主体与应用身份对齐决策（2026-09-13）

当前裁决：`PRODUCTION SUBJECT GATE = BLOCKED`，不是“需要迁移”或“不需要迁移”的结论。PRD V2.1-R4.2 §0.1.1 已确认 One-App、自营 MAKE、新小程序 AppID 的产品方向，需求方写为“CISME / 熹芃（上海）生物科技有限公司”；但本轮不能读取微信后台，实际拟运营主体、ICP/域名实名、微信支付商户、COS/云账号主体也未取得同一时点的脱敏证据。`project.config.json` AppID `wx4e…299b` 仅证明源码配置。

小程序 `pages/privacy-rights/index.wxml` 已向用户展示“运营主体：熹芃（上海）生物科技有限公司”。该可见文案必须与最终 A/B 主体、已发布隐私指引和当前法定运营责任核对；在核对之前，它只是源码声明，不是主体已获平台确认的证明。

| 对齐对象 | 目前状态 | 需要的最小脱敏证据 |
| --- | --- | --- |
| A. 当前微信小程序主体 | `HUMAN VERIFICATION REQUIRED` | 后台主体名称、类型、统一社会信用代码掩码、AppID 掩码、认证/备案状态 |
| B. 实际计划上线运营主体 | `OWNER DECISION REQUIRED` | 法定主体名称、统一社会信用代码掩码、已批准的经营/收款责任主体 |
| C. 服务器域名实名与 ICP 主体 | `HUMAN VERIFICATION REQUIRED` | `cisme.cn`/API 域名实名主体、ICP 主体/编号掩码、备案状态及适用服务 |
| D. 微信支付商户主体 | `HUMAN VERIFICATION REQUIRED` | mchId 掩码、商户主体/类型、与当前 AppID 绑定状态、支付能力 |
| E. COS/腾讯云账户主体 | `HUMAN VERIFICATION REQUIRED` | 账号实名认证主体、桶所有者/IAM 租户与私有存储归属；不提供密钥 |

先以统一社会信用代码及法定身份核 A–E，再选以下互斥处理路径；名字相近、相同法定代表人或同一品牌不能自动证明同一法人。平台是否允许具体操作，以当时官方后台、备案属地和资质审核为准。

| 情况 | 决策与待办 | 本轮禁令 |
| --- | --- | --- |
| CASE A：同一法人、证件号不变，仅名称/登记信息更新 | 先由 Owner 核验微信“主体修正/主体信息变更”适用性及备案变更；同步核域名实名、ICP、商户、COS 名称与资料。| 不擅创 AppID，不把名称更新写成已完成迁移。 |
| CASE B：不同法人、证件号变化 | 保持 `PRODUCTION SUBJECT GATE = BLOCKED`；由 Owner/法务评估小程序主体迁移或重新注册、微信认证、备案、类目/特殊资质、隐私指引、域名实名/ICP、支付绑定、订阅模板、接口权限、管理员、第三方平台授权、旧数据权利和停机/回滚。 | 不提交迁移、备案、绑定或授权；不能把旧主体资质直接继承。 |
| CASE C：实际使用新 AppID | 视为新的应用身份；建立 `wechat_identity(app_id,openid)` 新命名空间与经验证 UnionID/受控人工合并方案，重新核 privacy、域名、支付、订阅、接口和版本证据。 | 不把旧 OpenID 当同一主键，不假定旧平台配置、商户绑定、模板或授权继承。 |

这一决策同时阻断真实支付、公众 UGC、正式体验版向外演示和生产发布。Owner 给出 A–E 的脱敏同日快照后，才能把上述条件判断转为明确 CASE；如属 CASE B/C，还需 Owner 单独批准有高影响的迁移实施。

平台参照：[腾讯云关于主体修正与小程序迁移的说明](https://cloud.tencent.com/document/faq/1301/67756)、[腾讯云 ICP 备案主体变更说明](https://cloud.tencent.com/document/product/243/103521)、[微信支付小程序 AppID 与商户绑定前置条件](https://pay.wechatpay.cn/doc/v3/merchant/4015459512)。这些是条件规则，不代表 CISME 当前主体、备案或支付已通过。
