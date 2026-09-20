# ChatGPT + GitHub 下一轮施工提示词

请接管 GitHub 仓库 `Eysn0130/cisme-wechat-miniapp` 的最新 `main`。先获取当前 HEAD、工作树状态和该 SHA 的 Actions 结果，再阅读 `AGENTS.md`、`docs/product/CISME-产品需求文档-PRD-V2.1-R4.md`、`docs/evidence/main-consolidation-20260920/README.md` 及 `docs/evidence/visual/current-source-acceptance.json`。不要使用旧 PR #1/#2/#3 的分支作为施工基线。

唯一长期本地根目录是 `/Users/mini/CISME`，消费者产品是 `apps/miniprogram` 中的原生微信小程序。不得创建 `cisme-r0-platform` 嵌套项目，不得用网页或独立 App 替代。临时开发分支必须来自最新 main；交付后合并、同步主目录并清理已合并分支，保留唯一有效小程序工程。历史证据和私密备份不得重标为新验收或上传到公共仓库。

本轮优先完成“游客首页 → 授权入口 → 显式开始护理周期 → 四步护理 → 护理后感受 → 记录回看”的原生交付闭环。先审查现有实现，不重复造页面或推翻已正确的结构。依据 PRD §5.4、§6.3.1、§15.1 的 A20、CARE-01–04 及 AGENTS.md，逐项核对：

1. 游客可停留首页并看见“授权身份并开始”，onShow 不自动赶走游客；授权取消、失败、会话过期、切换账号后可恢复正确入口。
2. 周期从 planned 开始，显式确认后才激活；到期节点按 00 净澈、01 清洁、02 修护、03 精护顺序完成，选择护理后感受再提交。服务端校验顺序、归属、版本和幂等，持久化每一步事实。
3. 记录页展示服务器保存的时间、步骤、感受；旧记录如实标注事实缺失。弱网、重试、快速连点、返回、后台恢复、旧请求晚到及账号切换不得串号、重记或丢失已保存事实。
4. 先列出现状与可复现缺陷，再修复。每个业务修复补有意义的正反向回归；涉及 API 的部分补主体×对象×字段×动作授权测试。现有 562 集成测试、386 入口探针不等于 224 个方法已全部完成对象级授权审计。
5. UI 决策遵循 PRD → 微信原生约束 → mobile-ui-ux-designer → design-taste-frontend → 开发者工具/真机。核对胶囊、安全区、字号、图片、滚动、键盘、Tab 导航和错误恢复。用户正在操作开发者工具时不抢占页面。

验证：`npm ci`、`npm run typecheck`、`npm run miniprogram:package-gate`、`npm run miniprogram:route-audit`、`npm run design:qa:status`、`npm test`、隔离数据库 `npm run test:integration`、`npm run build`、`npm run lint:contracts`、`npm audit --audit-level=high`、`git diff --check`。仅在显式指定的本机 `cisme_*test*` 合成测试库运行重置；不要加载未知 .env 或连接生产库。

每轮重新计算小程序包 SHA-256。源码变更后，用 `scripts/update-current-source-manifest.ts` 重置过期验收绑定，保留旧证据的时间、来源、原 SHA 和适用范围。当前 37 路由只有静态清单和部分历史/默认态证据；WXML/WXSS 编译通过、单个游客页截图、Web build 或历史截图均不能写成完整状态矩阵 PASS。

若 ChatGPT/GitHub 环境没有微信开发者工具或授权真机，继续完成源码、测试、契约和可执行验收脚本，明确列出待本机执行的步骤和预期结果；不得编造运行结果。不要启用真实支付、退款、转账、公开 UGC、正式隐私删除，也不要把 main 同步解释为平台认证、云端部署或体验版发布授权。

最终交付：本轮 PRD/验收 ID、修复及风险、当前提交/PR/Actions 链接、测试结果、包 SHA、已实测与未实测状态、剩余缺口和下一轮最小施工任务。若可以从现有信息推进，直接完成，不只输出计划。
