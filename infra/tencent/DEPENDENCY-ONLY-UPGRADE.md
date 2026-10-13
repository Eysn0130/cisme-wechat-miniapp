# 本次 Fastify / Sharp 依赖补丁的独立升级入口

`dependency-only-upgrade.py` 仅承接已审阅的 Fastify `5.12.3 → 5.12.5`、Sharp
`0.35.4 → 0.35.5` 及对应锁文件树。它不修改 `production-release.py` 的通用升级门禁，
也不重跑 `production-trial.py` 的首次初始化。当前文档与离线测试不代表服务器已升级。

候选必须来自 GitHub 当前准确 `main`、该 SHA 最新一次成功的 `push` CI，使用
Linux x64 glibc / Node 24.14.0 在无服务器秘密的独立构建环境运行现有
`scripts/package-tencent-release.mjs`。操作员先核对构建来源及归档 SHA，再传输至正式实例，
在各自 `releases` 下作为 root 所有、组及其他用户不可写的新目录解包；旧制品保留。
不要在正式服务器运行 npm 安装。归档哈希与依赖树指纹是不同的证据，不能互相替代。

工具固定核对已独立审阅的源码许可：

- 根 `package.json` SHA256：`64eb8819e2c7ae109586daa3fe6108d3079a21f0bc2f21f719cd970efe5e75f5`。
- 根 `package-lock.json` SHA256：`d86ed2df5d94478e0a189393dba1ce10207ecf50cd77f0ca0b6f172247399be9`。
- release package 除上述两项精确版本外逐项相同；release lock 必须是现有打包器对许可锁的原有转换结果。
- 正在运行的旧制品与候选的 `index.js`、`worker.js`、`worker-once.js`、`migrate.mjs`
  和完整、有序 SQL 文件集逐字节相同。任一变化退出，不能扩展成 schema 或业务源码升级。

在同一正式实例 `lhins-61ikz4mi` 上，production 固定 `/opt/cisme`、`cisme` DB/role/user、
`api.cisme.cn`；trial 固定 `/opt/cisme-trial`、`cisme_trial` DB/role、`cisme-trial` user、
`staging-api.cisme.cn`。每次分别预检、分别升级并保存各自私有状态。
工具脚本及其相邻导入模块应来自同一已审阅提交，置于服务账号不可写的运维目录。
以下参数中的目录须替换为实际核验过的不可变候选；`--approval-ref` 记录既有授权来源，
不由工具生成业务准入批准。

```sh
sudo python3 /path/to/reviewed/infra/tencent/dependency-only-upgrade.py preflight \
  --environment production --release /opt/cisme/releases/tencent-release-<main-sha-prefix>
sudo python3 /path/to/reviewed/infra/tencent/dependency-only-upgrade.py preflight \
  --environment trial --release /opt/cisme-trial/releases/tencent-release-<main-sha-prefix>
sudo python3 /path/to/reviewed/infra/tencent/dependency-only-upgrade.py apply \
  --environment production --release /opt/cisme/releases/tencent-release-<main-sha-prefix> \
  --approval-ref <existing-authorization-reference>
```

trial 的 apply 使用相同参数格式、自己的 environment 与 release。不要并行执行两环境切换。
先确认本环境没有另一个 worker、管理脚本或外部写入器在持续写库；工具停止自身 API/Worker 后，
要求 Pg 无其他 client 且迁移 journal 与原制品全等，否则退出并恢复已验证旧应用。
它复用对应原升级/初始化锁，不能把该锁当成外部写入器已经排空的证明。

预检绑定原 `runtime.env` 的完整字节、root 所有/原服务组/0640 与实际服务可读性，
私有文件按本环境服务 UID 绑定。API 和 Worker 的实际进程环境必须继续关闭开发身份、
订单、模拟付款/转账、积分消费/规则及公开 UGC；trial 另要求 formal protocol 和 fulfillment
关闭。production 保留这两个准备配置的既有 bool，并逐项绑定原 env 与实际进程值、完整私有授权文件，
不能因修依赖改变配置。按 `packages/config/src/index.ts` 的契约，formal protocol 准备信任与传输
绑定，不授予订单、退款或转账权限；本工具的成功回执不授予真实交易准入。
工具不修改 env、密钥、配置、监听、存储或网络。
旧、新两个入口都先以对应服务身份解析实际依赖并用合成 PNG 做 WebP/JPEG 转换，
验证 Node/平台、实际版本及候选 librsvg；没有处理业务图片。

切换和每次启动前，工具核对原 unit 的完整字节及有效静态定义，不支持 drop-in，
存在 drop-in、待 daemon-reload 或未知定义就退出。ExecStart 的动态执行时间/PID/退出状态
不作为定义指纹。production 只切换原 `current` symlink；trial 只替换已核验的原
ExecStart 路径，其余 unit 字节不变，并保持原 WorkingDirectory。

各环境 `dependency-upgrades` 下保存 root0700 状态目录，旧 env/unit、初始化记录、
私有绑定与回执均为 0600。env、secret、private key/grant 内容及其摘要不进入公开输出。
trial 的 ownershipId、原 ownership.source、empty-database 和 initial migration-complete
保持历史原样；新的 `dependency-active-release.json` 与 upgrade 回执记录当前制品，
不伪造重新初始化，也不删除已有体验资料、审计或协议。

启用后检查实际 PID/路径/环境、域名证书验证的本机 HTTPS readiness、新 Worker heartbeat
与实际 native 版本。任一失败仅回退应用，保留数据库新事实。回退前必须仍是已知原/候选 unit、
原 env/secret/初始历史和原/本次 active marker；未知漂移不覆盖，停止自身服务并写私有人工恢复回执。
若停止命令本身失败，回执 `servicesStopped=false`，不能声称已经隔离，需按现状处理。
成功回退仍运行旧有漏洞版本，`securityPatchInstalled=false`，不得报告修复完成。

本入口仅执行 `migrate.mjs verify`，没有 `up`、restore、凭据轮换、建库或数据重置。
应用/SQL 完全相同的本次补丁，不制造整库恢复 SQL 或新的全量容灾资格条件。
其 HTTPS 检查是本机证书及服务就绪证据；公开可达、微信体验准入及正式运营验收仍按各自真实
版本证据和 PRD §15.5/§15.6 判断，不由该工具授予。

离线拒绝与应用回退测试：

```sh
python3 -W error::ResourceWarning -m unittest discover -s infra/tencent \
  -p test_production_dependency_upgrade.py -v
```

测试使用临时合成文件与 mock 服务/数据库/GitHub，不接触正式机、COS、任何业务库，
不替代发布窗的只读预检和真实启用后检查。
