# Cisme 熹丝密小程序

CISME 是一套原生微信小程序与 Node.js/Fastify、PostgreSQL 后端的开发基线。当前仓库公开用于开发协作与审阅；公开源码不等于生产部署、微信体验版或正式发布。

## 当前基线

- GitHub：`Eysn0130/cisme-wechat-miniapp`，`main`，PUBLIC。
- 源码基线提交：`d5b0e9b00cec476a42793c68f3826b0d54b36115`。
- 合成视觉证据补充提交：`652ca350c5982b97581a1913e1f53f50d9b3a3c6`。
- GitHub Actions：[`CISME R0 gates` 34603405920](https://github.com/Eysn0130/cisme-wechat-miniapp/actions/runs/34603405920) 已通过。
- 小程序：27 条原生路由；当前源码哈希 `7f5fad5fe84c122a28a9c54234690515a64c09cf86a666daced4ba635672957d`。
- 本地验收：单元测试 248 项、隔离数据库集成测试 101 项、34 个 migration、75 条 OpenAPI path、27 个事件契约均通过。

当前订单域仅覆盖隔离非生产环境中的 `pending_payment → cancelled/expired`、服务端报价、库存预留与释放。真实支付、`paid`、履约、退款、真实 AI Provider、生产部署和正式小程序上传均未启用。

## 本地验证

需要 Node.js `24.18.0` 与 Docker：

```bash
npm ci
docker compose -f infra/compose.yaml up -d --wait
npm run typecheck
npm run miniprogram:package-gate
npm run design:qa:status
npm test
npm run test:integration
npm run build
npm run lint:contracts
```

`design:qa:status` 的结构校验通过不代表正式发布门禁通过；iOS、Android、完整交互状态矩阵和远端 staging 仍需独立证据。

## 审阅入口

- [完整产品需求文档（PRD V2.1-R4）](docs/product/CISME-产品需求文档-PRD-V2.1-R4.md)
- [产品文档索引与生效规则](docs/product/README.md)
- [统一交付台账](docs/evidence/deployment/CISME-ENTERPRISE-RECONCILIATION-R4-R3-2026-09-11.md)
- [Design QA](design-qa.md)
- [Release Audit](RELEASE-AUDIT.md)
- [27 路由健康合成基线](docs/evidence/visual/review-commercial-r4b-healthy-7f5fad5f-20260911T202609+0800/README.md)
- [第三方许可说明](docs/THIRD-PARTY-NOTICES.md)

不要提交 `.env`、密钥、证书、数据库副本或真实用户数据；`.env.example` 只包含占位与非敏感配置说明。
