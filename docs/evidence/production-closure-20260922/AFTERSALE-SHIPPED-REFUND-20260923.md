# 已交寄订单的售后入口（2026-09-23 UTC）

| ID | 范围 | 复现与风险 | 状态 | 修复与证据 | 后续 |
|---|---|---|---|---|---|
| AFS-SHIP-01 | `AftersaleService.request`，PRD §8.2 / AFS-01–03 | 已交寄订单仍可受理 `refund_only`，但 `request_refund` 会拒绝已存在的 `commerce_shipment` 或 `commerce_shipping_sync`。消费者会得到一个管理员无法按原路径完成的案件。隔离集成测试先证明请求错误地成功。 | Fixed（服务端与隔离集成） / Verification gap（原生与实际政策） | 在同一订单行锁内，于创建案件前拦截已交寄的 `refund_only`，返回 `AFTERSALE_RETURN_REQUIRED` 和明确的退货退款/客服指引；已交寄的 `return_refund` 仍可创建。定向隔离集成测试先 RED 后 GREEN，`npm run typecheck` 通过。 | 微信原生上核对 409 文案与改选路径；实际特殊售后政策和经批准的退货收件信息仍待运营确认。 |

本批只修改服务端和隔离测试；小程序包 SHA256 仍为 `55a8abca05ad5dd5ab9b1c68a2e4a1bc73470ef7b180445fa776c08277a6b9cc`。旧 staging 和原生截图不构成此服务端变更的生产验收。

微信“物流助手” `express/business/delivery/getall` 与本项目发货同步使用的 `/wxa/sec/order` 是不同能力；当前没有取得本账号交易发货编码清单的权威证据，不把前者返回列表直接接入正式交寄表单。承运商可搜索选择仍是待核验的 UX 缺口。
