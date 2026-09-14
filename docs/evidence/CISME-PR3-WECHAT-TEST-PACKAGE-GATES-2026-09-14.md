# PR #3 微信内部测试包与最终验收分离

问题复现：原 `wechat-credentialed-preview` 在生成预览二维码之前运行 `design:qa:gate`；`scripts/miniprogram-ci.ts` 与 `scripts/wechat-release.ts preflight preview` 也强制读取完整设计放行错误。当前 37 路由、DevTools、iOS/Android 证据尚未完成，因此生成用于采集该证据的内部测试包被后置证据阻断。

现在的 `INTERNAL_TEST_PACKAGE_PREFLIGHT` 仅适用于 `wechat:preflight:preview`、`wechat:preview` 与 `wechat:ci:isolated`（开发版内部二维码，不是体验版上传或发布）：

1. `verify` 代码检查通过；小程序包预算、源码 hash 与 blocked 证据 manifest 结构一致（`design:qa:status` 的 `ok=true`，不要求 `releaseReady=true`）。
2. 目标 AppID 语法与项目配置一致，并已另行取得账号/项目角色证明；隐私指引、正式法律文本、合法请求域名或已核验云通道、明确 demo 范围仍须有真实证明。源码中的域名或 AppID 不等于平台已批准。
3. 明确授权内部测试动作与测试人员范围；`WECHAT_EXPERIENCE_MEMBERS_CONFIGURED`、`WECHAT_CI_RISK_ACCEPTED` 均为 `true`。
4. 本轮预览 API 的隔离性、真实支付/退款/转账出站关闭、公众 UGC 关闭，分别有证明后才将 `WECHAT_TEST_TARGET_ISOLATED_VERIFIED`、`WECHAT_TEST_PAYMENTS_DISABLED_VERIFIED`、`WECHAT_TEST_PUBLIC_UGC_DISABLED_VERIFIED` 设为 `true`。这些变量是人工提供的门禁证明，不是代码自动证实其事实；不得以 `APP_ENV=test` 部署远程 staging 绕过业务限制。
5. `wechat-credentialed-preview` 仍只在显式 `workflow_dispatch`、受保护环境且风险变量为 `true` 时可运行；本轮未运行该任务，未上传或生成二维码。

`FINAL_ACCEPTANCE` 仍适用于 `wechat:preflight:trial`、`wechat:upload` 与 `candidate-design-qa`：当前 hash 的 DevTools、逐页适用状态、iOS/Android、性能、平台与发布证据及无开放 P0/P1 必须齐全，`design:qa:gate` 仍需通过。`wechat:upload` 还需显式 `--confirm-upload`、版本和说明。当前 `design:qa:status` 为 `ok=true, releaseReady=false`，因此最终验收和真实体验版均未放行。

CI 的 `verify` 是代码检查；`candidate-design-qa` 是候选发布证据检查，目前 PR 中可 `skipped`，不等于通过。去重后 `verify` 在 PR 合并结果、`main` push、`candidate-*` tag 及手动触发执行；普通 PR 分支 push 不再重复跑同一检查。不修改 GitHub ruleset。可实施的最小必需检查名是 `verify`，候选发布时还须独立确认 `candidate-design-qa` 的实际成功状态；不能把跳过态设为“发布 PASS”。

本地验证：`tests/unit/wechat-release.test.ts` 15/15，整包单测 360/360、隔离库集成测试 169/169、构建/契约/包预算通过；`npm run wechat:preflight:preview` 在缺证明的当前环境返回上述明确错误，未再返回 `DESIGN_QA_FINAL_RESULT_NOT_PASSED`；没有真实微信凭据、扫码或外部副作用。
