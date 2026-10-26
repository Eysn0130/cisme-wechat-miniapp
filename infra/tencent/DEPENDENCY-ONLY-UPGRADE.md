# 2026-10-26 Fastify 依赖补丁的独立升级入口

`dependency-only-upgrade.py` 本次仅承接已审阅的 Fastify `5.12.5 → 5.12.6`
及对应精确锁文件树，Sharp 保持 `0.35.5`。旧制品必须为 10 月 13 日已经部署的
`b7e853e9dcd9f72f3cf7b933707fd477e635d6d7`，source tree 必须为
`abbf0a257effdc2575c3c6d2706fde4d265a6e7e`，source lock SHA256 必须为
`d86ed2df5d94478e0a189393dba1ce10207ecf50cd77f0ca0b6f172247399be9`。
其他旧来源即使应用文件相同也拒绝。此次入口不修改 `production-release.py` 的通用升级门禁，
也不重跑 `production-trial.py` 的首次初始化。10 月 13 日升级的历史证据仍保留原范围；
本次文档与离线测试不代表 10 月 26 日服务器已升级。

候选必须来自 GitHub 当前准确 `main`、该 SHA 最新一次成功的 `push` CI，使用
Linux x64 glibc / Node 24.14.0 在无服务器秘密的独立构建环境运行现有
`scripts/package-tencent-release.mjs`。操作员先核对构建来源及归档 SHA，再传输至正式实例，
在各自 `releases` 下作为 root 所有、组及其他用户不可写的新目录解包；旧制品保留。
不要在正式服务器运行 npm 安装。归档哈希与依赖树指纹是不同的证据，不能互相替代。

工具固定核对已独立审阅的源码许可：

- 根 `package.json` SHA256：`c70b97f3ec0e6c339c5c27b0e9067549f9256287cfbfdf32f39ae46fcf54e231`。
- 根 `package-lock.json` SHA256：`2a14af4f1bfdd86d0108015b43df14d62b2cc6e8eedcd3831446970a26d7d32a`。
- release package 仅允许上述 Fastify 精确版本变化，其他字段和直接依赖逐项相同；
  release lock 必须是现有打包器对许可锁的原有转换结果。锁文件含本次审阅的
  fast-uri `3.1.8 → 3.1.9` / `4.2.2 → 4.2.3`，以及开发依赖 Vite `8.1.3 → 8.1.6`、
  Vitest `4.1.11 → 4.1.12`；它们不扩大 release package 的直接依赖变更许可。
- 正在运行的旧制品与候选的 `index.js`、`worker.js`、`worker-once.js`、`migrate.mjs`
  和完整、有序 SQL 文件集逐字节相同。任一变化退出，不能扩展成 schema 或业务源码升级。

`package.json`、`package-lock.json` 和 `scripts/release-migrate.mjs` 仅从固定仓库
`raw.githubusercontent.com` 的准确 40 位提交路径
读取原始字节，使用默认 HTTPS 证书验证、拒绝重定向和 `Cache-Control: no-cache`。
读取按 64KiB 循环直至 EOF，总量最多 1MiB；已知 `Content-Length` 不符或正文越界即拒绝。
原 Contents API 的已观察截断响应曾在停止服务前被拒绝，不能把不完整 JSON 当作来源证明。
raw 传输随后仍须通过上述精确哈希及 migrator 字节比对；准确 main/tree、最新 push CI
和切换前后来源复核保持原样，不使用注入响应或源缓存替代。

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
验证 Node/平台、Fastify 旧/新版本、两侧 Sharp `0.35.5` 及候选 librsvg `≥ 2.63.2`；
没有处理业务图片，不再接受本次基线之前的 Sharp `0.35.4`。

切换和每次启动前，工具核对原 unit 的完整字节及有效静态定义。已有 drop-in 仅接受
该 unit 在 `/etc/systemd/system/<unit>.d` 内的普通 `.conf` 文件；文件单硬链接、目录及全部
父路径均须 root 所有且组和其他用户不可写。预检捕获每份完整字节、路径集与有效定义，
服务 sandbox 不得允许写入这些文件或目录。任何增删、未知路径、权限或内容漂移、
待 daemon-reload 或未知有效定义都退出；不删除、替换或放宽原 drop-in。
ExecStart 的动态执行时间/PID/退出状态
不作为定义指纹。production 只切换原 `current` symlink；trial 只替换已核验的原
ExecStart 路径，其余 unit 字节不变，并保持原 WorkingDirectory。

各环境 `dependency-upgrades` 下保存 root0700 状态目录，旧 env/unit、初始化记录、
私有绑定、drop-in 原字节快照与回执均为 0600；drop-in 快照目录为 root0700。
env、secret、private key/grant 内容及其摘要不进入公开输出。
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
