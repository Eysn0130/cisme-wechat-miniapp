# PR7 原命令恢复证据索引

完整说明：`../../CISME-COMMERCIAL-RECOVERY-2026-09-21.md`。原始诊断日志在会话交付包和准确PR/main的GitHub Actions工件；不复制真实用户记录、密钥或设备素材。

- 旧基线538单元；新Page诊断六项RED，运行源码修改后六项GREEN。
- 新增存储25、恢复服务57、请求/会话2，共90项新增；当前本地总628单元通过。
- 资金重启测试重置模块但保持合成wx存储；不是微信实际进程或设备验收。
- 新数据库用例位于 `tests/integration/commerce-history-gates.test.ts`，只使用已有cisme_*test*保护的合成数据库，包含关门查询、本人/他人、缺失/伪造/撤销/过期身份、字段泄露、原键/对象/角色注入、原取消事实不重复。
- 数据库结果和最终CI必须从当前HEAD原始日志取得，不能继承准备工作流或PR6总数。
- 当前包、37页源码需求清单不等于视觉验收，`current-source-acceptance.json`继续blocked。
