# 第一阶段唯一管理客户端（2026-09-22 用户更正）

本文件记录本轮用户直接指示，优先于历史交接书中对 PC 管理入口的要求。唯一工程 /Users/mini/CISME；第一阶段只有微信小程序「CISME 管理中心」。Chrome 仅是施工/控制台工具。

本轮接收实时基点 bc7a14ae94c9f182b2a55783369019b57f2324c0；GitHub main 5740e18544fa37dd473c36934a2a12a07a2d5ec9。更正时 PR22 OPEN/Draft，远端没有电脑登录改动。

## 已撤回（均为本轮未提交修改）

- 小程序 management 页的电脑登录码、确认/撤销电脑登录 UI、处理器和样式。
- 六条 operator-login/browser-login API、opaque PC session 分支及该专用限流扩展。
- 专用 OperatorLogin 服务、Admin Web 登录器和 202609220003_operator_web_session migration（两张表）。
- OPERATOR_WEB_ORIGIN 配置、原生确认/PC claim 测试、专用隐私清单项、API 文档与本地 Vite 代理。
- 仅为上述功能修改的 18 个已跟踪文件恢复至接收 HEAD；4 个本轮新文件移除。未 reset 分支、未重放补丁、未改动未知工作。
- 本轮隔离 run b5af1e0e0f4a7974bc27cf88 的 API/Vite 停止，DB/S3 两个明确归属容器清理。migration 从未进入 staging/production；无须对正式 DB 执行 down。

## 保留与边界

- 原有微信身份会话、AuthorityService、服务端权限锁/撤权复核、幂等账本和审计有现行消费者，保留。
- 原有 apps/admin 八个文件仅为历史受控工具源码，未扩大功能；不作为第一阶段产品入口、登录依赖或上线条件。后续业务必须在原生管理中心可操作。
- 当前 package-tencent-release.mjs 只打 API/Worker/依赖清单/迁移，不包含 apps/admin 或 dist/admin；release-migrate.mjs 对制品清单执行严格验证。没有部署 Web UI、DNS 或代理入口。
- 根 build 仍编译历史 Admin 以维持原有测试/构建兼容；编译产物不等于纳入生产制品。不可把历史 Web 截图算作原生验收。
- 撤回前的电脑确认截图已失去产品验收意义，不能用于当前候选。

当前继续施工：复用既有发货、退款、隐私、权限等后端能力完善原生界面，不建立新认证体系。
