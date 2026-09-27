# PR22 R3：实际执行记录（2026-09-26）

唯一工程 `/Users/mini/CISME`，原分支 `codex/fulfillment-lifecycle-20260922`。需求依据为 [PRD V2.1-R4](../../product/CISME-产品需求文档-PRD-V2.1-R4.md) §2、§5、§15 与 NFR-04。R2 证据原样保留。

## 来源及当前边界

- 启动 HEAD `e295a64055f707902337b3d2c3368963c7127f1a`，tree `c86bf483a837b54bc6021e77c6edad374fc64af4`，工作树干净。
- 首个完整 Linux x64 演练制品来自 `d3b9a3c85718a0378db8144e19584487c469a18a`，tree `494b890c9fba470a211fb51fbb804f935efc50c9`，有实际 API、worker、worker-once、95 份迁移及 Linux Sharp。清洁 tar SHA-256 `22aa66ddd08f07541abe4d568fd26c86d832d30cfb700b23f696edc5fe38c3cf`。**非 main，未部署生产。**
- 小程序输入仍为 `e97db4690df66ae2c86b2e9539a5d631afbc501a27489fc32dc21c32ec436a4a`；266 文件、40 路由。下列原生截图是本轮此输入的定向模拟器证据，不是全状态或实体设备证明。
- PR22 只读核对仍为旧 Draft `5ab4a00d4e71d8a9a2de14e31b64fca0bbe92e88`；main `5740e18544fa37dd473c36934a2a12a07a2d5ec9`。未推送、未合并，新候选远端 CI 未运行。
- 最终 Linux 运行制品来自 `82656217d83d9ebeb6febf646597a395625c74d6`、tree `4621ff2e07d5579947a02b4f7c636e9d68e1dd25`，tar SHA-256 `350de71b92aba931b42b9199ee2c3c5267464595dd15577af354fa037ffb22f2`。Linux 实际核验 101 项制品与 95 份 SQL，API/独立 worker 启动成功、ready=200、未认证隐私=401；独立 UGC 调度已启用，但无真实扫描商或待扫描媒体，不能记为真实内容安全通过。见[制品清单](server/runtime-artifact-manifest.json)与[最终回执](server/final-receipts.json)。之后的本地变更仅为部署恢复入口和本目录证据，不改变该运行制品的业务代码。

## A：正规定位已发送，尚未恢复写入

已通过 [OpenAI 官方支持入口](https://help.openai.com/en/articles/6614161-how-can-i-contact-support)发送仓库、PR、动作、拒绝摘要和未知字段。支持聊天要求输入邮箱或本人登录后继续。见 [发送后页面](support/submitted-awaiting-identity.png)。无支持单号、人工答复或解除回执；不能把发送给支持机器人等同正式受理或允许写入。没有换 Git/gh/网页/账号重试被拒动作，也没有使用其他会话 `/approve`。

## 存储产品、最小授权及对象恢复

控制面确认应用桶为 Lighthouse 轻量对象存储，隐私桶是标准 COS；prod 没有共享挂载，现有挂载属于另一台 staging 实例。共享挂载不算备份。

- 按 [腾讯轻量对象存储说明](https://cloud.tencent.com/document/product/1207/108904)，应用桶采用对象级 HEAD/GET 和预置对象摘要做就绪检查；不再要求不支持的桶接口，未开版本控制、未新购桶、未改公开权限。
- 原应用身份 `cisme-storage-runtime` 的标准隐私桶 403 确认为权限缺口。用户确认后，将策略 `CismeShanghaiMediaRuntime` 285775844 保存为当前版本 2。完整 [原策略](permissions/CismeShanghaiMediaRuntime-observed-v1.json)、[最小差异后的策略](permissions/CismeShanghaiMediaRuntime-proposed-v2.json)、[保存回执](permissions/saved-policy-v2.png)保留。
- 仅补版本状态读取、当前 AppID 抑制前缀列表/对象读写及本轮探针前缀读写；PutObject 强制 `x-cos-forbid-overwrite=true`；未授予隐私删除或桶管理。列表条件按 [官方条件键规则](https://cloud.tencent.com/document/product/436/71307)编码前缀。
- 两桶均用原应用身份完成本轮自有对象：写入 → HEAD/GET → SHA → 同主机私有备份 → 另一隔离键恢复 → SHA。保留原对象。标准桶根列表、其他 AppID 前缀、越界 HEAD 为 403；无禁止覆盖参数的写入 403，覆盖原对象 409 FileAlreadyExists。
- 应用桶 canary 41 字节 SHA `25f62e1c96e45bb05478d2ee960b21b28dbd8fb834d7ddb1bb3580f6bbd86f07`；标准桶 canary 51 字节 SHA `dacaec8ca8a4045b037550cecccf5c659ac6267b42d2fe974fb87ea0ed976219`。这些对象演练不证明整个桶备份完成。
- 控制面观察应用桶 `backups/postgres/` 有 21 份加密数据库备份和 1 份清单；这覆盖数据库备份对象，不能冒称所有业务对象已有离机备份。切换前须刷新对象清单和保护点。

## 新版运行、旧数据与任务

在正确生产主机 `lhins-61ikz4mi` 的独立 PostgreSQL 集群 `127.0.0.1:31956` 中，保留真实备份原样副本，再复制用于新版运行。登录角色 `r3_runtime` 为 NOSUPERUSER/NOCREATEDB/NOCREATEROLE、INHERIT，复制生产应用角色权限属性；特权操作实际被 42501 拒绝。真实备份 SHA 沿用 R2 `e2f8bdb66c79d9d0f1072a9d5c71c0f6f3b7e3f20afaaa64dc3740b82fbaacca`。

- 实际编译 API 通过 HTTP 验证商品资格/发布/库存、报价及未付款订单、售后校验与受理、客服收发/读回、隐私补充、planned 显式激活和 00→01→02→03 护理与感受持久化；重复请求不重复产生订单/售后/消息。身份、存储、签名支付夹具均为隔离合成，不冒充微信或真实资金。
- API 与独立 worker 主入口作为两个 cisme 系统进程启动；独立心跳写在演练私有 TMPDIR，未覆盖生产心跳。使用 systemd 禁止外网，仅允许 loopback，隔离媒体、隐私、客服清理的外部副作用。
- 两条旧 identity outbox 尝试次数 0 的根因是旧 worker 的事件白名单只含 `submission.publication.approved.v1`。同一恢复副本中旧处理器认领 0，新处理器认领 2，重入 0；每条 attempts=1、processing_outcome=audit_only。身份事实已在原事务产生，此事件只记审计。生产两条事件未被填 processed_at、删除或修改，不能称生产已消费。
- 另一个旧 schema 副本补合成旧护理与隐私数据后升级，实际新版 API 保留旧答复，护理返回 `stepCodes=[]`、`selfAssessment=null`，不生成缺失历史事实。
- 无新写入时，保护点恢复副本全部旧表行摘要一致；新业务写入后，重新 pg_dump 并实际恢复到另一隔离库，全部表行摘要一致，未用旧备份覆盖新业务。维护写入返回 503；API 重启后同订单幂等重试返回原订单。
- 另建私有副本实际持锁，引发原迁移器 PostgreSQL lock timeout：journal 停在24条；释放锁后续跑71条至95，再次执行0条。没有改 SQL 或回填 journal，没有恢复旧库覆盖事实。此补证只针对失败恢复，不重复声称 R2 的一般迁移结果是新增成果。
- `APP_ENV=production`、`ALLOW_DEV_ADAPTERS=false`、实际 COS、隔离 DB 的候选启动成功：ready=200，维护写入=503。此为安装期验证，非营业验收。

完整脱敏机器结果在[业务、存储、恢复与续期回执](server/receipts.json)。真实会员内容、数据库转储、生产凭据未下载或纳入仓库。

## 配置、网络及修复

- 服务器已私有准备 `/opt/cisme/prepared/r3-20260926/runtime.production.closed.env`（root 0600，目录0700）；保留既有密钥，仅初始化原来缺失的正式隐私导出密钥，未写入 live runtime.env。
- 已确认 `/var/lib/cisme/privacy-suppression` 为 cisme 0700，API/worker 的 ReadWritePaths 均含该目录，无需重复修改。
- 发现 UGC 扫描只在 API 内嵌 worker 启动，已补独立 worker 扫描和停止逻辑，以 `UGC_SCAN_WORKER_MODE=standalone` 明确拓扑。API 保持 `RUN_BACKGROUND_WORKER=false`，同时开启两种拓扑会拒绝启动；原正式凭据与内容安全守卫保留。
- 修复部署检查把非密的 `COS_READINESS_OBJECT_KEY` 当成密钥轮换的问题；真正 S3 密钥变更仍拒绝。
- 部署恢复入口增加明确的 `forward-only` 模式：资格材料必须证明保留新写入、部分迁移续跑和维护围栏；失败后停止服务并留回执，禁止自动启动未经证明的旧程序，禁止恢复旧数据库。原有同数据应用回退模式仍要求相应证据。main/CI、目标、备份及材料绑定检查保留。
- 历史23份 SQL 字节缺失时，入口现在允许**显式审阅的替代证据**：真实恢复副本与 live schema 比较摘要、待执行 SQL 内容审阅、缺失历史内容的风险接受记录。仅名称一致仍拒绝。未为本轮演练伪造正式生产资格材料。
- 首次 Mac tar 含 AppleDouble `._*.sql`，Linux 清单校验正确拒绝；重新封装清洁包后通过。打包脚本现默认禁止此元数据并输出 tar SHA，避免下次重现。
- `api.cisme.cn` 现有 DNS-01 auth/cleanup hook 已实际执行 certbot dry-run，退出0，续期成功。见 [回执](server/dns01-dry-run-success.png)。本轮未新增公网443规则；尚无已验证 main 正式服务可切换，不能提前公开旧 staging 服务。保留22，不开放5432。

## 当前包原生验证

开发者工具 RC 2.02.2609231、基础库3.15.2、HUAWEI nova 13 模拟器361×804；本轮确认工具可用后执行 Computer 与现有 CLI。

1. [游客首页](native/01-guest-home.png)：保留“授权身份并开始”，未自动重定向。
2. [未认证隐私](native/02-privacy-guest.png)：不显示会员记录，保留登录与客服入口。
3. [原生客服落点](native/03-contact-platform-limit.png)：真实按钮触发开发者工具“暂不支持打开客服会话”提示。正式接待配置此前站点拒绝仍遵守；未证明消息送达。
4. [登录网络失败](native/04-login-transport-failure.png)：模拟连接拒绝，提示与重试可见、loading 解除；恢复隔离 API 后正常登录。
5. [售后校验](native/05-aftersale-validation.png)到[成功受理](native/06-aftersale-success.png)：问题类型、原因分别校验，提示经轮询仍保留；完成选择及输入后原生提交成功。
6. [客服草稿交接](native/07-support-draft-handoff.png)：展开保留文字和订单附件；[服务端读回](native/business-readback.json)确认该草稿未发送，售后只生成一单。

iOS、Android 实体设备均 **NOT_RUN**。没有将模拟器或合成支付写成真机、微信接待或正式资金通过。

## 待闭合项

正式支持身份验证及有效恢复 → 正确分支同步和准确 CI/审阅 → main/main CI → main 完整制品比较 → 新鲜 DB/对象保护点 → 安装/迁移/配置/current 切换 → API/独立 worker 版本和业务读回 → 受控443验证。备案与平台发布另行保留。

计划营业至少需解除维护、配置获批准的正式商务与履约能力；UGC 另需消息安全凭据、扫描回调和审批材料。只切 APP_ENV 或商务开关不能证明营业就绪。[安装、开通与恢复执行顺序](CUTOVER-AND-OPENING.md)列明具体配置差异和事实缺口。

## 本轮结束状态及验证

- `2026-09-26T11:53:46Z` [GitHub 只读回执](support/github-final-state.json)：仍是上述旧 PR/main；本地提交不等于远端同步。
- `2026-09-26T11:59:20Z` [最终服务器回执](server/final-receipts.json)：current 仍为 `20260909-native-login`，生产 API/worker active，迁移23条，pending outbox 2条。
- 两个本轮服务器演练目录及其临时数据库、运行凭据、备份副本已精确清理，31956–31961均无监听，演练 unit 无 active；私有日志/执行源/清单保存在 `/opt/cisme/rehearsal-evidence/r3-20260926`（0700）。原生产备份保留；两个桶的原探针与恢复探针保留。标准桶探针私有备份已移至 `/opt/cisme/backups/r3-20260926-1135z.bin`（0600），早期回执中的演练目录路径仅代表当时位置。见[清理截图](server/final-cleanup.png)。
- 本机原生模拟器夹具 API 已停止；只删除 runId `69bf8d645532ba7bc9bff733` 的两个自有容器，18080无监听；清理合成登录后回到游客首页。
- 本轮早期 d3 候选：typecheck、build、完整单测1439通过/1跳过及存储契约通过。最终826业务源码：typecheck通过；配置/独立UGC/停止排空3个单测文件20项通过；worker与正式UGC隔离集成2文件11项通过。最后部署入口39项 Python 回归通过。均非远端 CI。
- [最终包检查](verification/final-mini-package.log)、[11项隔离集成](verification/final-integration-v2.log)、[39项部署回归](verification/release-tests.log)与[执行源说明](harness/README.md)可复核。证据目录 `SHA256SUMS` 包含原始截图与机器回执。
- 现场工具问题已分别纠正：Mac AppleDouble 导致清单拒绝；COS HEAD 的错误码实际为字符串 `403`；直接调用 vitest 未继承 npm PATH；迁移器错误输出按设计脱敏，真实 lock timeout 需对照私有 PG 日志。均未用降低生产守卫或修改生产数据来消除失败。
