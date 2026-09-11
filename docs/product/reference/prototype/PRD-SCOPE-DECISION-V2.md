# PRD 范围裁决 V2（原型冻结 / 生产 R0）

日期：2026-08-14

唯一 PRD：[`CISME-产品需求文档-PRD-V2.1-R4.md`](../../CISME-产品需求文档-PRD-V2.1-R4.md)

SHA-256：`e0fc938854e0530ae819a632e43ffaff79bf82da84dca91492b05a6b05a438ac`

## R0 保留

- `home/account/profile`，护理周期与护理记录。
- 有效邀请的 `task → submit → progress`，但不开放公众任务广场。
- 简明积分账解释；基础唯一 `share_id`。
- 少量 SKU 的 `shop/product` 只读浏览。
- 设置、必要/可选许可、数据权利和客服说明。
- 选定唯一交易 profile 后才可开放直接结算、订单和基础售后；当前生产 profile 仍为 `UNSET`。

## 条件启用

- 社区精选/最新和治理可作为经审只读内容面；公众 UGC 仅在 `UGC_GO_LIVE_GATE` 通过后开放。
- 公众 publish/content、评论、关注、搜索、公开作者页仍为 QA/延期能力；AIGC 结构化 provenance 是公众 UGC 上线阻断。
- 积分消费必须在交易 profile 与五项积分契约同时通过后出现：prepare、commit、release、refund-allocation、数据导出/对账。
- 微信分享、上传、支付只可在真实原生 API 和服务端合同接入后启用。

## 合并、延期与舍弃

- 合并：基础分享内联 home/profile；订单/售后作为订单子流；未来通知/成长优先并入 profile。
- 延期：公众任务中心、评论、关注、搜索、公开作者页、详细归因、购物车、券、复杂促销、完整社交图谱。
- 舍弃：纯积分实物、六级成长玩法、个性化“小红书克隆”、独立 growth/messages、消费者端 AI/飞书入口、设备内 QA 控制、假生产成功动作、继续堆毛玻璃/手势库。

## 原型冻结边界

React/Vite 仓库是高保真视觉/交互规格与 QA 基准，不是可提交微信审核的小程序。设备外 QA 参数/面板可验证状态，但不能出现在消费者视口，也不能当订单、支付、上传、审核或积分生产事实。

本轮冻结后只为生产迁移修正规格歧义或 P0/P1 回归，不再增加页面。源码 route 清单从 23 收敛到 21；growth/messages 已删除。旧 47 PNG 只代表 23 route 单一态等历史证据，不代表 route×state 全覆盖。

## 生产 G0/R0 blocker

- 当前 `selected_transaction_profile=UNSET`。BUY 只有在同一供应商提供并实测签名 webhook、主动拉取、退款、发货、全量/增量导出、积分 prepare/commit/release/refund-allocation 与 sandbox 对账后才可选中。
- `UGC_GO_LIVE_GATE=false`；R0 只允许经审只读护理故事和私有外部投稿。
- 积分规则只能保留 3–5 条经财务/产品签字的规则；未签候选必须 disabled。
- 微信 AppID/Secret、商户号、正式域名、云账户、对象/内容安全/物流供应商、法务文本与财务签字是真实外部依赖，不得伪造。
- API、PostgreSQL、对象存储、审核后台、RBAC、审计、append-only 账、幂等/outbox、备份恢复、监控和安全均需在独立生产工程完成。
