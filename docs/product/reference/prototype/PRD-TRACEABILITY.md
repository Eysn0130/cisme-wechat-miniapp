# PRD 追踪矩阵（冻结原型 → 生产 R0）

“原型完成”只指可见规格和交互合同；“生产阻断”必须在独立生产工程关闭。

| PRD / 裁决能力 | 冻结原型状态 | 生产 R0 验收权威 |
|---|---|---|
| 微信身份、协议接受 | account 视觉与来源返回 | `member/wechat_identity/consent_acceptance`；生产凭证缺失 fail closed |
| 合格事实→护理周期 | dev QA fixture；订单完成仅建 planned | 合格事实 adapter；planned 后用户显式 activate |
| D1/D7/D14/D28 | 单一 selector + QA clock + 幂等完成 | 服务端时区/协议版本、唯一记录约束、并发测试 |
| 记录与个人页 | 与 home 共用 selector | API read model，不使用本机权威缓存 |
| 有效邀请 | community 直达 task；tasks QA 独立 | 唯一 campaign/task/claim/submission，claim 原子幂等 |
| 投稿素材与许可 | 字段/草稿/状态视觉规格 | 预签上传、原图/截图/链接/账号/披露/用途许可，对象存储 |
| 人工审核与申诉 | progress 状态规格 | admin RBAC、原因码、证据、audit_log、并发控制 |
| 积分获取 | pending/frozen/available 历史解释 | 单次 reward_claim/points_grant；append-only entry/lot/projection/outbox |
| 积分消费 | 默认隐藏；五门未齐 fail closed | prepare/commit/release/refund-allocation/export-reconcile 全部验收 |
| 基础分享归因 | 唯一 share_id 规格 | 服务端 ID、归因窗口/边界、审计事件 |
| 经审社区只读 | 精选/最新/治理视觉与滚动合同 | 只读 feed read model；`UGC_GO_LIVE_GATE=false` |
| 商品浏览 | 少 SKU；无纯积分实物 | 服务端目录；交易 profile 未选时无 checkout |
| 交易/订单/售后 | 条件只读视觉规格，不生成成功事实 | 唯一 MAKE/BUY profile、支付/履约/退款、库存物流、对账 |
| 设置/许可/数据权利 | 必要与可撤许可、说明态 | grant 与 revocation_request 分离；撤回阻止新增使用且保留历史证据 |
| growth/messages | 从 R0 route/入口删除 | 若未来需要，优先作为 profile 子视图重新立项 |
| 公众社交/UGC | 条件 QA，不算闭环 | provenance、内容安全、审核 SLA、许可与删除合同通过后才上线 |

## 真实范围标记

- 原型 P0/P1：只依据截图反证、交互/状态测试和工程门禁。
- 生产 G0/R0 blocker：身份、数据、上传、审核、积分、交易、安全、运维合同未实现即阻断。
- 外部依赖：真实凭证/账号/付费、法务或财务签字、正式供应商和公开发布必须由用户/组织完成。

护理合同见 `CARE-CYCLE-CONTRACT.md`；详细页面矩阵见 `INTERACTION-STATE-MATRIX-V3.md`；生产裁决不得从原型 QA 参数或本机持久化反推。
