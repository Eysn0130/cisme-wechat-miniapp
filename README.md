# Cisme 熹丝密小程序

CISME 是一套原生微信小程序与 Node.js/Fastify、PostgreSQL 后端的开发基线。当前仓库公开用于开发协作与审阅；公开源码不等于生产部署、微信体验版或正式发布。

## 当前基线（2026-09-20）

- 唯一长期目录：`/Users/mini/CISME`；微信开发者工具只导入其中的 `apps/miniprogram`。
- 唯一开发主线：[`Eysn0130/cisme-wechat-miniapp/main`](https://github.com/Eysn0130/cisme-wechat-miniapp/tree/main)。后续工作从最新 `origin/main` 开始，不再接旧的串联 PR 分支。
- 本轮收敛完整提交链至 `71949634d7a0a1fc134a53b17c0fe90cd227187e`，并修复测试工具依赖；最终代码提交与 CI 请以当前 main 的精确 SHA 为准，旧 CI 绿色不能继承。
- 小程序：37 条原生路由、250 个包文件；源码包 SHA-256 `cf5fe2fd9baadf7a71d8bdfb4629b832ddd44559739c2226d2199d402c83c791`。
- 本轮本地验证：368 单元测试、562 隔离数据库集成测试通过；72 个 migration、224 个 `/v1` 方法、32 个事件契约。完整 npm 依赖审计 0 漏洞。
- [当前代码审核及收敛记录](docs/evidence/main-consolidation-20260920/README.md)；[ChatGPT + GitHub 续建提示词](docs/CHATGPT-GITHUB-NEXT-PROMPT.md)。

订单、支付、退款、履约、佣金与结算已有隔离协议和合成回归；真实资金、公众 UGC、正式隐私执行、当前云端 staging、体验版和 iOS/Android 验收仍有独立门禁。同步 main 仅表示源码收敛，不表示商业发布通过。

## 本地验证

需要 Node.js `24.18.0` 与 Docker：

```bash
npm ci
docker compose -f infra/compose.yaml up -d --wait
npm run typecheck
npm run miniprogram:package-gate
npm run miniprogram:route-audit
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
- [当前代码审核及收敛记录](docs/evidence/main-consolidation-20260920/README.md)
- [Owner 外部门禁与历史台账](docs/evidence/CISME-OWNER-GATE-LEDGER-2026-09-13.md)
- [Design QA](design-qa.md)
- [Release Audit](RELEASE-AUDIT.md)
- [历史 27 路由健康合成基线（非当前包验收）](docs/evidence/visual/review-commercial-r4b-healthy-7f5fad5f-20260911T202609+0800/README.md)
- [第三方许可说明](docs/THIRD-PARTY-NOTICES.md)

不要提交 `.env`、密钥、证书、数据库副本或真实用户数据；`.env.example` 只包含占位与非敏感配置说明。
