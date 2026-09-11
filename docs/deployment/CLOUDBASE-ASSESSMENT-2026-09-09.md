# 微信云开发接管评估 — 2026-09-09

用户明确授权检查并接管微信开发者工具中的云开发控制台。本轮已进入真实 cloud1 环境，核对套餐、数据库和云函数配置；尚未迁移业务或创建云函数。

## 实际控制台状态

- 环境：cloud1-d4g0khuk495d48600，绑定 CISME / wx4eac2d4fb11d299b。
- 套餐标识：免费开发环境。显示调用次数 20 万、容量 3 GB、云函数外网出流量 4 GB、资源使用量 15 万 GBS、CDN 流量 10 GB、回源流量 10 GB。页面另有 19.9 元/月购买入口；不能将该价格误写为已付费。按量付费与自动续费均未选中。
- 数据库界面为集合管理，目前无集合。
- 云函数列表为空；创建页提供普通云函数和 HTTP 云函数；下拉列表有 Node.js 24.11/22.21（公测）、20.19、18.15、16.13。没有提交创建，已取消草案。

## 为什么前一方案采用 Render + Supabase

现有服务直接使用 PostgreSQL SQL、事务、行锁、SKIP LOCKED、advisory lock 和持久任务队列；Docker 跑 API 与后台 worker。此前没有确认该账号已有免费云开发环境，优先保留了已有架构。遗漏对微信自带环境的早期检查应纠正；已经部署过其他平台不是继续沿用它的充分理由。

## 当前结论

微信云开发是有效候选。此免费环境不是现有 PostgreSQL 服务的直接替换：若用文档数据库，需要改写数据访问及并发一致性；若保留 SQL，可评估腾讯云 CloudBase 新建 PG 环境。官方说明微信控制台暂不创建 PG 环境，已有传统环境不能升级为 PG 模式。云托管 CPU/MEM 不包含在环境套餐内，不能以开发环境免费为由开启额外按量计费。

优先评估云函数、微信身份和云存储的原生接入；数据库迁移须先证明事务与并发合同可以完整保留。HTTP 云函数也能运行 Web 服务，需实际核对运行时兼容、上传大小、数据库连接、定时后台任务及费用。不能把当前显示的运行时选项当成业务部署成功。现有 Render/Supabase 可作为对照与回退，未删除或停止。

## 官方依据

- 环境与 PG 模式限制：https://docs.cloudbase.net/quick-start/env-overview
- 云托管按量计费边界：https://docs.cloudbase.net/run/limitation
- 云函数类型：https://docs.cloudbase.net/cloud-function/introduce
- 运行时：https://docs.cloudbase.net/cloud-function/runtime-support

尚无云开发业务部署、真实微信登录/上传或团队扫码验收结果。此前的合法域名提问属于现有公网 API 路径；若采用官方云调用，需按新接入方式重新判断，不能沿用为所有路线的前置阻断。

## 首次云端执行

00:57 已在 cloud1 创建普通函数 cismeReadiness（Node.js 20.19、256MB、3秒超时）。平台随后显示已部署。通过控制台输入空对象执行，返回空对象，测试成功；运行 10ms、计费 100ms、内存 7.31MB。这是平台默认示例，不是 CISME 业务或本地验证源码已部署。证据见 cloudbase-initial-call-2026-09-09.json。

已准备 services/cloudbase/functions/cismeReadiness/index.js 和无依赖 package.json，本地调用通过。官方微信开发者工具 CLI 支持 --paths 部署，不要求更改原生 project.config；当前 CLI 服务端口关闭，已请求用户选择是否开启或保持界面操作，尚未改变安全设置。

## 自定义函数部署与远程调用

用户明确同意开启本机 CLI 服务端口。通过开发者工具安全设置启用，官方 CLI 确认监听 http://127.0.0.1:42190；未启用获取工具登录票据、默认信任自动化项目或多端插件服务端口。

官方 CLI 对 cismeReadiness 完成更新：2 个文件，729 bytes，success=true。正式 AppID/AppSecret 请求微信 stable_token 成功，短期令牌仅存放受限本地目录，无输出或提交。随后通过腾讯官方 tcb/invokecloudfunction 接口调用，errcode=0，返回本地代码定义的版本 2026-09-09.1 与运行时 v20.19.3，证明自定义代码已在云端执行。该 HTTP 管理调用没有终端用户身份，不能当成真实会员登录。

第二次调用 probe=network 在 1806ms 触发预设 1800ms 期限，返回 NETWORK_OR_TIMEOUT；不能据此判定外网不可达，也不能将云函数代理 Render 的链路列为可用。下一步应核对可配置超时及本地 API 直接打包到 HTTP 云函数的兼容性，并验证 PG、持久存储和后台任务；不要把简单请求转发当成整个微信云开发接管完成。

机器证据：docs/evidence/deployment/cloudbase-custom-probe-2026-09-09.json。诊断函数没有业务写入，也没有输出 OPENID、密钥或会话令牌。
