# 本批证据索引与复跑边界

业务源码 tree：`114f89f4c012fce78e56fd7bfdd2d0267e4159d0`；原生包 `8fca4a19907fb7d5d57463c367d63aa2f407d0c490d3b32351d599599e4b91d5`。

本轮代码、78 项 Page/能力测试、4 项清单测试、30 项数据库测试和原有回归均可从仓库复跑。完整说明见 `../../CISME-COMMERCIAL-RUNTIME-DELIVERY-2026-09-21.md`。原 main/上轮护理修复证据保持历史原范围，不重新盖章。

| 证据 | 范围与结果 |
|---|---|
| 首轮 red.log | 原 main 上 36 项诊断：30 失败/6 通过；不是当时全量测试结果 |
| refund-count-before.log | 新数量用例定向执行：2 失败/76 未选中；不把未选中当 PASS |
| 本地 unit-complete.log | Linux / Node 24.18.0 / 原锁文件：70 文件532项通过 |
| typecheck-final/build-final/contracts-final/package-final/routes-final/design-final | 最终8fca包重跑通过；设计结构通过不等于原生验收 |
| tests/integration/commerce-history-gates.test.ts | 新增30项，必须读取最终HEAD的GitHub真实合成库执行日志，不声称本地数据库执行 |
| scripts/audit-commercial-lifecycle.ts | 当前37路由/111文件，角色与状态需求、代码标记和当前哈希；不解释模板作用域或证明全链取消 |
| commercial-readiness-evidence 工作流 | 只读 source identity、当前矩阵和11个来源信息；不是生产发布作业 |
| 原生/真机/真实HTTPS | 本轮未执行；所有页面原生全状态仍未通过 |

原始本地 RED/GREEN 日志、最终验证日志、当前 JSON 清单、精确 PR/main/Actions 回执和 SHA256SUMS 随本轮会话交付包提供。仓库不塞入 node_modules、字体、完整源码历史、真实用户材料或凭据。GitHub 原始 verify 日志和工件保留在 [PR #6](https://github.com/Eysn0130/cisme-wechat-miniapp/pull/6) 对应准确提交的 Actions；不能将旧 HEAD 的成功变成新 HEAD 成功。

复跑：先在仓库根阅读 AGENTS 和环境门禁，使用锁文件准备开发依赖，然后执行 npm run typecheck、npm test、npm run build、npm run lint:contracts、npm run miniprogram:package-gate、npm run miniprogram:route-audit、npm run design:qa:status。运行 ./node_modules/.bin/tsx scripts/audit-commercial-lifecycle.ts 获取只读清单。集成与性能测试只在已确认的 cisme_*test* 合成库；不要默认读取未知 .env 或生产目标。

用于固定候选传输的临时 source-preparation/count-fix 工作流和分片在最终 PR tree 中清退；保留的 commercial-readiness-evidence 是只读审计功能。临时同步曾被 CRC/完整树校验阻止，修正传输和路径排序后仍保持原目标哈希；失败未绕过，未将临时工作流当代码测试。
