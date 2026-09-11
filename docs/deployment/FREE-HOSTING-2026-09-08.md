# 免费托管接入记录

用户已授权在免费范围内自主推进，不授权付费、绑卡后自动扣费或付费升级。

## 当前实现

新增根目录 Dockerfile 和 .dockerignore，Node 24.14.0，非 root 运行，默认 staging / 禁用开发身份。API 默认监听3100，可由PORT覆盖。后台worker可使用同一镜像的 `node dist/services/worker/src/main.js` 命令，但尚未完成免费平台上的运行安排。迁移仍需显式执行，不在每次启动时自动改库。镜像不包含 .env、私钥、Git历史、本地DevTools配置或截图证据。

## 免费方案核对

- Render免费Web支持Node和HTTPS，但15分钟无访问休眠，启动约1分钟；无持久磁盘；免费Postgres30天到期，不选作长期数据库。未添加支付方式时，相关额度耗尽会暂停服务或构建。后台worker不是免费服务类型。来源：https://render.com/docs/free
- Supabase Free可作为PostgreSQL/对象存储候选；免费项目可能因一周低活跃暂停，存储免费额度1GB。S3兼容不意味着支持本项目所有POST策略上传操作，必须实测并适配后才能启用。来源：https://supabase.com/pricing 、https://supabase.com/docs/guides/storage/pricing 、https://supabase.com/docs/guides/storage/s3/compatibility
- 微信云托管是期限与额度内赠送，超额/到期可按量扣费，不能称为永久免费；未代为开通。来源：https://cloud.tencent.com/document/product/876/113602

## 当前阻断与下一步

2026-09-08 23:59 复核：Render 的原有应用内浏览器会话有效，服务清单为空；New Web Service 已显示 Eysn0130/cisme_app。部署用独立 checkout 已配置 Git remote，当前快照已推送到私有仓库。尚未创建云服务。继续核实免费套餐、持久数据库/存储、worker、微信合法域名实际可配置性和完整业务运行；不能把仅有API容器或平台临时域名当成团队扫码交付。所有真实身份密钥仅在平台密钥环境中配置，不在聊天中索取。

本地容器健康验证使用专门测试库和仅本机绑定的端口；开发身份/本地上传适配仅为容器启动测试，绝不沿用到公网部署。免费服务暂不承诺生产可用性。

## 本轮验证结果

Docker镜像构建成功，内部类型检查/构建通过，npm audit为0。修正临时目录权限后，以uid1000连接隔离测试库，`/health/ready`返回HTTP200；确认镜像未含.env、Git历史、截图证据与本地DevTools配置。仅本机端口的测试容器已停止。此结果仅证明容器能启动，不证明公网、S3、后台worker或微信真实身份已完成。

## 部署源码准备

已在 tmp/deployment-review/cisme-deployment-source.tar.gz 准备部署快照，逐文件清单见同目录 manifest.json。采用目录白名单，排除环境文件、私钥、本地开发者工具配置、Git历史和验收截图；此为早期快照。用户随后指定 Eysn0130/cisme_app，部署提交在独立 checkout 中进行；原始工作区不自动提交。Render 已能读取该仓库。

## cisme_app 私有仓库接入

已通过 GitHub 页面创建并确认 Eysn0130/cisme_app 为 Private。部署快照在 tmp/cisme-app-deploy，含 195 个文件，独立本地提交 6c0e4e1；原始工作区未提交。原生源码哈希 e991eea5d02280416ff677396d45e2cf778a5d6fdfd37b2dfda10d2eb86dad44。初次命令行与连接器访问失败属于历史状态。23:59 复核 gh 凭据有效、权限为 ADMIN；远端已存在 6c0e4e1，且本轮更新已成功推送。连接器 404 不能作为当前仓库不可访问的依据。

## 当前部署候选（2026-09-08 23:59）

- 私有仓库：Eysn0130/cisme_app，main 为 `a0a5535955a843f7a676574d1ad86c8ddaf03b0a`，已通过 GitHub API 复核。
- 204 个白名单源码文件同步至独立 checkout，原生包哈希 `23691a4cfe64bb6e0e81c909f2ee7b134707663d8b3715d3ee98675185ea36d1`。环境文件、私钥、开发者工具私有配置和截图未加入部署源；保留原有 README 与第三方声明。
- 从该独立目录执行 Docker 构建成功，镜像标签 `cisme-deployment:23691a4c`，manifest digest `sha256:b94eed795dda4a604635a541ce4972d13dcb468f7d1d8a4a6352ee9f1271b492`。npm ci 报告 0 vulnerabilities；类型检查、API/worker 和管理界面构建通过。这不是云端运行或当前端到端业务验证。
- Render 新服务草案已选该仓库，平台识别 Docker。默认付费规格已改选 Free：$0/月、0.1 CPU、512MB RAM；页面明确无持久磁盘、SSH 和一次性任务，空闲会休眠。未点击 Deploy，未创建资源或支付。
- 当前尚无配置到平台的正式微信凭据、公网 PostgreSQL 与 S3 存储，免费 worker/迁移执行方案也未完成。不能用开发身份或本地上传适配填补公网配置。正式账号、合法域名、团队体验成员及真机验收继续单独阻断。

## 2026-09-09 00:04 免费数据库接入

已通过 GitHub 的只读邮箱 OAuth 登录 Supabase，并创建 CISME Free 组织（rynwtjrfdmsqofefpvnu）与 cisme-staging 项目（lvjfkmifgeiduucctxsh）。平台实际显示 ap-south-1 / Mumbai / NANO，正在 Coming up；不能视为连接已验证。创建时关闭 Enable Data API，后续业务表通过 CISME API 访问。专用数据库密码仅保存在受限权限的本地临时秘密文件中，未进入 Git、日志或聊天。尚未导入任何会员/投稿或运行种子数据。

Supabase S3 官方兼容清单列出 PutObject/HeadObject/GetObject/DeleteObject，但没有承诺本项目依赖的表单 Presigned POST 完整支持。必须实际验证；若不兼容，应实现持久 S3 网关上传适配，不能在 Render 临时磁盘上保存投稿原图。参考：https://supabase.com/docs/guides/storage/s3/compatibility 。

## 2026-09-09 00:11 数据库迁移与私有存储

项目已由 Coming up 转为 Healthy。使用平台提供的 IPv4 Session pooler（aws-0-ap-south-1.pooler.supabase.com:5432）连接；初始默认 CA 校验失败后，下载官方数据库 CA，保持证书与主机名校验，实际 clientTls=true、certificateAuthorized=true。数据库强制 SSL 开关已启用。

仓库 17 项 up 迁移全部成功，复核 public schema 共 38 张表，member=0、submission=0。未运行开发 seed。平台默认授予 anon/authenticated 的 532 项表权限已通过 `supabase-private-schema.sql` 撤销，复核剩余为 0，并关闭 postgres 后续建表/序列的相同默认授权。Data API 持续关闭。

证据桶 cisme-evidence 已创建并通过数据库查询复核 public=false；单文件上限 10,485,760 bytes；允许 image/jpeg、image/png、image/webp。目前桶仍未经过 CISME 上传授权、验签、下载与删除链路验证；不能据此声明小程序投稿可在公网使用。

机器可读复核记录：`docs/evidence/deployment/supabase-migration-2026-09-09.json`。数据库凭据与 CA 在本地受限临时目录中，未进入部署 Git。Render 服务仍未创建，正式微信凭据、S3 上传兼容、worker 与团队扫码验收仍未完成。

## 2026-09-09 00:21 私有存储真实合约测试与修复

S3 endpoint 为项目控制台提供的 storage.supabase.co 域名。后端专用 S3 凭据已生成并存入受限本地配置，未进入 Git/日志。

真实 Presigned POST 正常上传/HEAD/GET/删除成功，篡改 key、MIME、签名以及匿名读取均 403；但授权上限 1KB 的上传接受了 2KB 以上文件（HTTP 200）。该供应商的直传方式不能作为当前部署配置。原始结果保留在 supabase-s3-post 与 supabase-s3-boundaries 证据 JSON 中，不能写成全部通过。

已实现 `s3_gateway`：API 先验证签名、期限、媒体/对象绑定、授权大小与实际图片格式，再使用 PutObject 写入私有 S3。verify/delete 仍针对远程对象，worker 使用相同驱动；本地文件存储不参与该驱动。小程序继续使用原有 wx.uploadFile POST，无需改页面。真实复测超限请求在写入前拒绝且对象不存在，正常 68-byte PNG 校验与删除通过，详见 `docs/evidence/deployment/supabase-s3-gateway-2026-09-09.json`。

类型检查通过；108 单元测试通过。首次集成命令因两个套件缺少 DATABASE_URL 而未完整运行；指定新建的本地隔离测试库 cisme_storage_test_20260909 后，7 套件 37 集成测试全部通过。公网数据库未用作测试清空目标。当前尚未启动 Render/API 或验证真实微信上传，不据存储适配通过宣称端到端上线。

部署修复已从独立 checkout 推送到私有 main：`2123248531341072c6f62575b93d4e5258249ee6`，GitHub API 已复核。Docker 从该快照构建通过，镜像 `cisme-deployment:s3-gateway`，manifest digest `sha256:4c9690025158bea41d2749672e99ee10d3fac563ee4976eb6b8f199e4edf1a69`。

## 2026-09-09 00:29 免费服务后台任务运行

容器默认 `RUN_BACKGROUND_WORKER=true`，API 与后台任务共享服务进程，处理持久 PostgreSQL 队列及 S3 清理。独立 worker 入口继续可用，单独部署时 API 可关闭此开关。调度循环在上一轮结束后启动下一轮，停止时等待当前任务完成并关闭连接池。

编译产物实测（本地隔离库）：API /health/ready 成功；准备的过期上传由后台循环自动加入并完成清理；SIGTERM 后退出码 0、无 stderr。详见 `docs/evidence/deployment/background-runtime-2026-09-09.json`。110 单元、37 集成测试通过。免费平台空闲休眠会延迟后台处理，不能承诺连续运行的生产 SLA。

已准备并打开本地受限 `tmp/deployment-secrets/wechat.json`，请求用户填写正式 AppID/AppSecret；未将真实微信配置替换为开发身份或虚构密钥。外部身份配置仍是实际部署的待办。

部署仓库当前 main：`dcf156a6fde93526d307e6067c671e16d323c477`，已推送并复核。镜像 cisme-deployment:background 构建通过，digest `sha256:d9250e908fd4eadac0ea09d09d1d135f3010c3ec84d91db27749b9fc2373d1b8`。

## 2026-09-09 测试隔离与正式配置

发现本地测试默认库曾与开发预览共用，导致预览数据被测试重置；未恢复原历史数据，已重新建立本地测试登录。现默认使用独立 cisme_test，重置前校验实际数据库名称；117 单元与 37 集成测试通过。重复两套集成测试后，预览 schema OID 与会员数保持不变，证据见 test-database-isolation-2026-09-09.json。公网数据库未作为测试重置目标。

用户已填入正式微信配置，AppID 与原生项目匹配；真实登录仍待验证。已生成受限 Render 配置并导入 17 项环境变量。数据库 URL 使用 verify-full 与公开 Supabase CA，实际连接已通过证书校验。已提交新加坡 Free 服务创建，尚待云端构建/健康验证。

## 2026-09-09 00:46 公网后端已上线

Render 免费服务 cisme_app（srv-dag3m7942hec7390kfhg）在新加坡上线，公开 origin 为 https://cisme-app.onrender.com。控制台 Live 提交为 56a187477da080f11fd79b0dc5f68a2f2f28a441，与 GitHub main 一致。APP_ENV=staging；控制台默认环境分组名 Production 不代表应用正式发布。

公网实测 /health/ready 与 /v1/catalog 为 HTTP 200；开发身份接口返回 DEV_ADAPTER_FORBIDDEN，未认证 /v1/me 返回 401。微信接口以无效测试 code 收到上游 invalid code 响应；仅证明上游连通，不证明真实身份登录或密钥的全部有效性。没有新建真实会员、伪造同意或公开投稿。机器证据见 render-public-smoke-2026-09-09.json。

原生包仍为 23691a4cfe64bb6e0e81c909f2ee7b134707663d8b3715d3ee98675185ea36d1，138 文件、14 路由、1,693,253 bytes，包门禁通过。preview/trial origin 尚未填入：微信后台合法域名接受结果尚未验证；不得将公网 HTTP 成功等同于微信平台允许访问。下一步应由管理员确认 request 与 uploadFile 合法域名 https://cisme-app.onrender.com 是否可保存，并补齐正式协议/隐私指引、体验成员与真实扫码验收。若平台拒绝托管域名，应使用可被平台接受的自有域名，不关闭体验版域名校验。
