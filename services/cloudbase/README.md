# CloudBase 部署准备

`functions/cismeReadiness` 是已远程验证的诊断函数，不承载业务。

运行 `node scripts/package-cloudbase-api.mjs --bundle-runtime` 生成 `dist/cloudbase-api`：复用 API 源码、锁定生产依赖、可执行 `scf_bootstrap`、公共数据库 CA、校验过的官方 Linux x64 Node.js 24.14。包中不含环境配置、私钥或微信凭据。构建不部署、不切换小程序。

HTTP 启动监听 9000，禁止常驻 worker。后台任务仍需独立定时触发实现与验收，否则不可替代当前完整后端。运行时保留项目 `>=24.14 <25` 要求，启动文件会拒绝低版本。CloudBase 文档列出的 `Nodejs24.11` 不能直接视为兼容；须核对实例真实版本或使用符合要求的自定义镜像。

01:24 已在现有 HTTP 诊断函数验证随包 Node.js 24.14：健康检查 200，实际运行时 v24.14.0、Linux x64、glibc 2.28。原始二进制 ZIP 经 CLI 编码后超过 50 MiB 请求上限；Brotli 压缩后部署包 33.0 MB，部署与调用成功。构建脚本在启动阶段用平台 Node 解压到 `/tmp`，应用由随包 Node 运行；流式解压限制内存占用，新构建另校验解压后的二进制摘要。每次冷启动需解压约 122 MB，业务包冷启动耗时仍需实测。无 `--bundle-runtime` 时只接受平台原生版本满足项目要求。

部署时在平台单独配置生产环境变量；数据库 TLS 如需此 CA，设置 `NODE_EXTRA_CA_CERTS=/var/user/supabase-prod-ca.crt`。未验证数据库连接、持久上传、真实微信登录、定时任务前，不修改原生正式 API 入口。不要把现有普通诊断函数覆盖成 HTTP 函数。

本地 Node 24.14 已验证编译包可加载：`/health/live` 为 200，未登录 `/v1/me` 为 401。该检查没有访问数据库或存储，不属于云端业务验收。

01:18 已创建并部署 `cismeHttpReadiness` HTTP 函数。控制台 GET `/health/live` 返回 200，实际版本 `v24.11.1`，确认内置运行时低于项目要求。证据位于 `docs/evidence/deployment/cloudbase-http-runtime-2026-09-09.json`。诊断函数不接数据库，也未开放业务能力。

`services/worker/src/once.ts` 已提供等待一个完整周期并释放连接的内部入口，复用常驻 worker 的业务处理；成功、存储失败和任务失败的连接清理测试通过。尚未部署或配置定时触发器，也不提供公开调用路由。

01:32 完整业务函数 `cismeApi` 已通过官方微信 CLI 上传成功：5668 文件、33.9 MB。构建使用质量 11 的 Brotli 压缩并缓存校验后的结果；微信 CLI 对 HTTP 函数也要求 `index.js`，构建入口已匹配。证据见 `docs/evidence/deployment/cloudbase-api-deploy-2026-09-09.json`。现有 staging 配置通过配置校验，开发身份关闭、常驻 worker 关闭。密钥尚未配置到云函数，因此不能将上传成功当成业务启动或数据库验收成功。

官方依据：[HTTP 函数快速开始](https://docs.cloudbase.net/cloud-function/quickstart/httpfunc/nodejs)、[运行时要求](https://docs.cloudbase.net/cloud-function/runtime-support)。


2026-09-09 状态更新：现有用户授权已覆盖凭据部署，18 项配置已保存回读，真实 ready 检查与原生 Feed 读取通过；上文“密钥尚未配置”只描述当时状态。独立定时 Worker、日志修复、正式身份与上传闭环仍未完成。当前交付清单见 `docs/DELIVERY-REVIEW-2026-09-09.md`。


2026-09-09 12:48 状态：`cismeWorker` 普通函数已独立部署，512 MB / 60 秒，随包 Node 24.14。无凭据调用被拒绝，带凭据完整执行返回 completed:true，连续两次每分钟定时触发成功；截图及请求编号见 `docs/evidence/deployment/cloudbase-worker-2026-09-09.json`。日志采集已开启。普通 CloudBase 触发器只支持 name/type/config，入口因此验证由独立密钥派生的随机触发器名称；触发配置属于私有部署数据，不提交源码。函数权限 `cismeWorker.invoke=false` 禁止客户端调用。HTTP API 继续关闭常驻 worker。真实业务队列仍待真实成员操作验收。

构建 Worker 前需先构建 API 依赖包，然后运行 `node scripts/package-cloudbase-worker.mjs`。源入口为 `services/cloudbase/worker/index.cjs`；它去除子进程 NODE_OPTIONS，限制解压 20 秒与执行 35 秒，避免超过云函数整体 60 秒。不要把事件 Type 字段单独当作可信认证信息。不要轮换触发密钥而不同时更新定时器名称。
