# CISME 当前代码审核与唯一主线收敛（2026-09-20）

本轮响应 Owner“只保留最新正确的唯一微信工程并同步 GitHub main”的明确要求。这里的结论是**已验证的源码收敛**；正式商业发布仍未验收。后续任务从最新 `origin/main` 开始，需求唯一基线仍是 PRD V2.1-R4。

## 版本裁决与唯一入口

开始时 `main=8e843a6`，长期主目录却在 `codex/u0-u1-review=6495101`。微信开发者工具只登记了 `f745` 和 `91ad` 两个临时工作目录，没有登记长期主目录。Git 祖先关系证明：

`8e843a6 → 6495101 → f655fff → 7194963`

`71949634d7a0a1fc134a53b17c0fe90cd227187e` 完整包含 main 之后的 63 个提交，没有分叉独有代码需要取舍。已将该链快进汇入 `/Users/mini/CISME` 的 main，保留完整历史，并在其上补本轮依赖与 CI 修复。主线同步采用普通快进推送，不重写历史。GitHub 上的最终 SHA/检查结果需在交接时实时核对，不以本文自指提交制造循环提交。

唯一长期源码目录：`/Users/mini/CISME`。唯一微信开发者工具项目：`/Users/mini/CISME/apps/miniprogram`；AppID `wx4eac2d4fb11d299b`，基础库 3.15.2。`projects-final.json` 是工具实时返回的一项目清单。三个旧 worktree、三个已合并本地分支及 `tmp/cisme-app-deploy` 旧嵌套副本收敛后不再作为开发入口；GitHub 旧分支在确认主线包含其 HEAD 后清理。

旧目录、配置、未追踪证据先归档至本机 `.private-backups/main-consolidation-20260920/`，逐归档校验 SHA-256 后才清理。235 个旧未追踪证据文件另有逐文件路径与 SHA 清单。归档不上传 GitHub，包含可恢复的历史材料，不是第二个可编辑产品工程。已跟踪的历史截图、来源和范围保持原样；`docs/evidence/deployment/sdk-timeout-repro-2026-09-09/` 是历史故障复现证据，不是交付项目，不导入开发者工具。

## 发现与修复

| 问题 | 本轮处理 |
| --- | --- |
| 主目录、IDE 和 GitHub main 指向不同版本 | 以祖先关系及当前回归裁决完整版本，收敛为一个主目录和一个 IDE 项目 |
| README 仍声称 27 路由、248/101 测试和旧哈希是当前基线 | 改为当前 37 路由、368/562 回归及当前包哈希；历史 Release Audit/Owner 台账加生效范围说明 |
| `miniprogram-simulate` 带入旧 Less/image-size、PostCSS，共 4 high 依赖告警 | 仅对该测试工具作用域固定 Less 4.9.1、PostCSS 8.5.28；同步 lockfile、SBOM 和许可清单；完整依赖审计为 0 |
| CI 允许开发依赖 high 告警且漏跑路由审计 | 将完整 npm audit 提升至 high 门槛，并加入 `miniprogram:route-audit` |
| 模拟器缓存旧会话且本机 API 未运行，首页出现连接拒绝 | 启动当前源码的隔离验收 API；旧会话经真实 401 流程失效，重新进入游客首页。未改生产接口地址、未绕过授权 |

新增样式工具链测试检查 PostCSS 8 下的作用域选择器、小数值、媒体查询，以及 Less 4 在模拟器同步回调路径的变量/嵌套编译兼容性。既有 address-editor 原生组件测试也通过。小程序运行代码本轮未作视觉改动，包哈希与接管候选一致，但截图仍重新采集且仅标记实际观察范围。

护理链重点审阅了 `pages/home/index.ts`、`pages/records/index.ts`、`services/api/src/platformService.ts` 及现有回归：游客 onShow 保留首页，planned 激活有显式确认，服务端强制 `[00,01,02,03]` 和有效护理后感受，`care_record_step` 逐步持久化，记录页对历史事实缺失诚实呈现。本轮没有宣称所有业务和所有授权矩阵均已证明正确。

## 本轮验证

| 验证 | 实际结果 / 证据 |
| --- | --- |
| TypeScript、应用构建 | PASS；`build-final.txt`。其中 Web 管理构建只证明该构建步骤，不计小程序视觉验收 |
| 单元测试 | 56 文件、368/368 PASS；`unit-complete.txt` |
| 集成测试 | 35 文件、562/562 PASS；`integration-complete.txt` |
| 隔离数据库 | 专用本机 `cisme_main_audit_test_20260920`；72 个 migration；未接触生产数据 |
| 包门禁 | 250 文件、37 路由，主包 1,397,190 bytes，所有预算通过；`package-final.json` |
| 包 SHA-256 | `cf5fe2fd9baadf7a71d8bdfb4629b832ddd44559739c2226d2199d402c83c791` |
| 契约 | 224 注册 `/v1` 方法、含 health 共 226 documented methods、32 typed events；`contracts-final.txt` |
| 路由与 Design QA | 静态 37/37，证据 manifest 与包 SHA 一致；结构 PASS，`releaseReady=false`；`routes-final.json`、`design-final.json` |
| 主工程依赖审计 | root prod/dev 全部 0 漏洞；`audit-final.json`。不包含独立可选上传工具 |
| 独立可选微信上传工具 | `miniprogram-ci` 2.1.31 为 registry 当前 latest，80 告警（41 critical/19 high/19 moderate/1 low），direct package 无可用修复；`wechat-ci-audit-summary.json`。本轮未安装、加载或启用其凭据工作流 |
| 原生编译诊断 | 37 路由的 WXML 与 WXSS 共 74/74 成功；`native-compile.json`。不代表 37 页运行时状态全覆盖 |
| 原生游客首页 | Stable 2.02.2608070 / 基础库 3.15.2，真实窗口看到“授权身份并开始”、00–03 顺序、Tab Bar；0 Problems、0 Errors；2 条微信基础库 preload 警告仍保留 |
| diff hygiene | `git diff --check` PASS |

执行记录：第一次集成检查与依赖重装发生重叠，运行器被中断，此次不计通过；顺序重跑后发现 SeaweedFS 未启动导致 1 个存储契约失败，启动既有本机存储容器后，完整 562 项重新执行全部通过。报告仅采用最后完整结果。

本机验收 API 为 `http://127.0.0.1:18080`，数据库 `cisme_native_test_20260920`，由现有 `miniprogram:acceptance` 脚本初始化，使用合成账号与随机本地会话密钥，公众 UGC 关闭。该服务用于当前本地观察，不是 staging、真实微信登录或体验版。重启此专用合成环境的命令是 `TEST_DATABASE_URL=postgres://cisme:cisme-dev-only@127.0.0.1:55432/cisme_native_test_20260920 npm run miniprogram:acceptance`；该命令会重置指定测试库，切勿替换为生产 URL。

原始窗口截图 `devtools-guest-home.png` 和 `devtools-guest-home-ax.txt` 仅证明游客首页默认态及当时工具状态。未使用剪裁、合成图或旧截图替代本轮观察；文本日志仅统一行尾空白，截图字节未改动；文件摘要见 `SHA256SUMS`。

## 仍未关闭的交付缺口

- 当前包完整 DevTools 角色×状态矩阵仍 0/37 正式 PASS；iOS 0/37、Android 0/37，当前体验版未验收。`current-source-acceptance.json` 保持 blocked。
- 224 个方法的主体/对象/字段/动作安全审计尚未全部完成。此前台账的严格授权覆盖 31/224，与 193 个入口×两种未授权凭据的 386 个探针是不同分母；本轮未扩大严格覆盖，不能把 562 测试总数当作全量授权证明。
- 当前云端独立 staging、微信主体/隐私/域名和正式版本状态未在本轮复核。正式资金、公众 UGC、真实隐私导出/擦除/注销继续受独立门禁约束。
- 独立 `tools/wechat-ci` 上游漏洞未修复，继续受现有显式风险接受和发布前置门禁限制，不能因 root audit 为 0 而启用。当前可用的原生编译路径是微信开发者工具；本轮未用高风险依赖制造上传/体验版证据。
- GitHub verify 绿色不证明上述外部验收。源代码同步 main 是 Owner 本轮的单独明确要求，不自动把 `RELEASE_READY` 或历史安全缺口改为通过。

下一轮执行入口：[ChatGPT + GitHub 续建提示词](../../CHATGPT-GITHUB-NEXT-PROMPT.md)。先完善护理关键链的原生全状态证据及发现的缺陷，再按 PRD 推进其他页面和剩余接口授权。
