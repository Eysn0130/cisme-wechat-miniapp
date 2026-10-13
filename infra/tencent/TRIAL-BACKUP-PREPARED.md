# 同机独立体验数据库备份候选 — 2026-10-13

候选仅新增 `cisme-trial-encrypted-backup.py`、专用 service/timer 和针对性测试；没有修改生产备份脚本/配置，没有安装服务器任务、生成新密钥、修改 IAM 或向 COS 写入。PRD 基线为 `docs/product/CISME-产品需求文档-PRD-V2.1-R4.md`：首次受控体验准入按 §15.6 判断；正式运营及备份/恢复验收引用 §13、§15.5、`NFR-04`、`REC-01` 和 `G0-OPS`。本候选不证明这些验收已通过。

## 候选异地备份启用的当前阻塞

正式实例仅为 `lhins-61ikz4mi` / `124.223.74.198`。2026-10-13 11:50:45 UTC 的只读 COS 核验中，现有 maintenance 身份 GET `backups/cisme-trial/read-only-permission-probe-nonexistent` 返回 **403 AccessDenied**，同身份 GET `backups/postgres/manifest.json` 返回 200，未读取/输出其正文。没有创建测试对象，PUT/DELETE 未验证。现有生产维护身份不能据此视为获准使用体验前缀；本轮不扩权或启用候选。候选使用更窄的 `backups/cisme-trial/postgres/`，未来须独立验证此准确前缀。

11:49 UTC 的只读核验中，体验 OS 账号仅属 cisme-trial 组，体验数据库角色无 superuser/createdb/createrole/replication/bypassrls 或成员关系；Pg HBA 仅允许 cisme_trial 角色通过 127.0.0.1 SCRAM 连接同名库，再拒绝其他 local/IPv4/IPv6 连接。独立对象和抑制目录均为正确体验账号所有、0700，当前无子项；没有体验备份任务。这些是现场状态，不是恢复演练结果。

## 固定资源与安装条件

| 项目 | 专用目标 |
| --- | --- |
| 执行身份 | `User=cisme-trial` / `Group=cisme-trial`；脚本拒绝 root 和附加组 |
| 数据库 | `cisme_trial` / 同名角色，TCP `127.0.0.1:5432`；只读连接环境与无权限 dump |
| 运行配置 | 只读 `/opt/cisme-trial/runtime.env`；禁止生产 URL、对象驱动或抑制目录 |
| 加密密钥 | `/etc/cisme-trial-backup/backup-aes256.key`，独立随机 32 字节；不得复用任何生产或字段密钥 |
| COS 凭据 | `/etc/cisme-trial-backup/cos.json`，仅 `accessKeyId` / `secretAccessKey` 两字段；独立身份，不能复制生产 maintenance 配置 |
| 本地加密目录 | `/var/backups/cisme-trial-encrypted`，cisme-trial:cisme-trial / 0700 |
| 远端 | 私有桶 `lhcos-81ddf-1257392443` / `ap-shanghai`，仅 `backups/cisme-trial/postgres/` |
| 任务 | 独立 `cisme-trial-encrypted-backup.service` / `.timer`；每日服务器时区 03:45，最多延迟 5 分钟 |

安装前必须由获授权运维核对并准备这些专用资源；当前任务不生成凭据或执行安装。私有输入文件要求 root:cisme-trial / 0640、单个硬链接、无符号链接，父目录须 root 所有且不可被组/其他用户写入。脚本、systemd units 与维护 Python 依赖必须 root 所有、体验账号不可修改；可复用只读的 `/opt/cisme-maintenance` Python 运行时，但不能复用其生产配置/身份。systemd 隐藏 `/opt/cisme`、`/etc/cisme`、`/var/lib/cisme` 与生产备份目录，只允许体验加密目录写入。

专用 COS 身份的最小对象操作为固定体验前缀内的 GetObject、PutObject、DeleteObject（含具名 manifest）；不需要桶枚举、桶策略、生命周期或 DNS 权限，不应能访问 `backups/postgres/`、生产媒体或生产抑制对象。需独立取得实际 IAM 授权与拒绝证据；代码固定前缀不能证明凭据本身无多余权限。专用 AES 密钥须有受控的独立恢复副本；应用字段加密密钥的安全恢复安排另行记录且不写入仓库。

安装前另须复核现有 HBA 仅允许体验角色连接同名库，并拒绝跨库 local/IPv4/IPv6，保留新鲜的脱敏验证证据。候选无权读取/修改 PostgreSQL 访问规则，不把 catalog 中 CONNECT 权限推定为实际可连接，也不要求为了候选改变生产库权限。

具备上述条件后，脚本默认 `preflight` 只读：检查专用 OS 身份、私有路径、关闭态配置、同名数据库拥有者与无特权角色，然后读取准确体验 manifest。只允许 HTTP 404 **且 SDK 错误码为 NoSuchKey** 代表首次备份；NoSuchBucket、缺错误码、403 或其他错误立即失败，依据[腾讯云 COS 错误码](https://cloud.tencent.com/document/product/436/7730)。preflight 不创建目录、锁、文件或远端探针，不证明 PUT/DELETE 权限。显式 `backup` 才会加锁、生成本地密文和写固定体验前缀。未经独立实际运行，不能把候选测试写成服务器备份成功。

## 备份范围、保留与错误边界

数据库 dump 经管道直接 AES-256-GCM 加密，使用体验专用格式/AAD；没有落盘数据库明文。密文在上传前及远端下载后均通过 SHA-256、完整 GCM 认证和 `pg_restore --list` 可读性验证；先完整认证并丢弃第一遍明文，认证成功后才将第二遍明文经管道传给只读解析器，篡改/认证失败不会启动解析器。后者只解析目录，不连接数据库、不执行恢复 SQL。SDK/Pg 原始错误、敏感 URL、响应正文与私有输入不进入输出，失败只返回受限错误码。

远端保留策略为至少最近 7 份，并只清理其余超过 30 天的**准确体验命名**对象；manifest 有外来路径、重复项或未来时间即拒绝，删除时间只取自受验证文件名。manifest 只加入本次远端验证成功的对象，不扫描本地失败文件冒充远端副本。每次只重新下载/认证本次新归档，`remoteMinimumCopies=7` 是策略参数，不能宣称历史 7 份当前均存在、可读或可恢复。本地在远端成功后保留最近 7 个已知完成副本；未知文件保留待审查。远端写入后若 manifest 更新失败，可能留下本次独立前缀的未追踪密文，任务不报成功；需要受控核对而非桶级扫描/删除。实际权限、周期持续成功和故障告警仍待验证。

所有成功回执明确 `scope=database-only`、`fullRecoveryQualified=false`、`admissionMayOpen=false`。候选不备份本地媒体，不复制/删除抑制目录，不提供 createdb/dropdb/pg_restore-to-database 或自动回退入口。`admissionMayOpen=false` 表示本备份工具不授予体验准入，实际版本准入由 §15.6 的相应门禁判断。

首次受控体验需验证当次不可变 release manifest 对应的上传成功、指定体验名单、真实微信身份、HTTPS 测试 API/合法 request/upload/download 域名、独立测试数据与存储，以及能力开关 fail-closed；只采集该封闭验收范围必要的数据，说明当前备份和故障恢复的覆盖局限。真实交易、积分消费和公众 UGC 等未通过各自门禁的能力保持关闭，实际启用范围的隐私指引与协议须正确展示。体验后的候选准入再补齐 iOS/Android、弱网、隐私、上传和后台审核证据；正式版按 §15.5 全部适用门槛评估。完整商业运营恢复资格与这些体验后证据不提前合并为首轮体验的前置条件。

## 恢复与删除抑制规则

1. 应用回退不能覆盖数据库：不得将生产备份恢复到体验库，或将体验备份恢复到生产/现有体验库。恢复演练只允许新建、具名且所有权绑定的独立体验验证库/对象目录，由另行审阅的工具执行；本候选没有这种权限或入口。Pg 数据库角色继续禁止访问生产。
2. 停止待恢复环境 API/Worker，阻断所有写入者并保持公众入口/注册关闭。准确绑定备份摘要、体验密钥和同版本字段密钥，记录 DB 与对象数据各自的恢复点；数据库目录可读不替代实际恢复、业务对账和签字 RPO/RTO。
3. 删除/注销/撤回等抑制记录是单调追加、独立于数据库保护点的事实。必须取**恢复前最新**、完整可验证的体验抑制记录，保留并合并最新记录，不得以旧备份里的抑制快照覆盖新记录，不得按数据库备份 30 天策略清理抑制记录。不得混入相同 AppID 的生产抑制命名空间。
4. 现有 staging 运行模式仅持久化本地 `/opt/cisme-trial/privacy-suppression`；缺少每次删除成功前确认的独立远端抑制副本。目录现在为空不证明采集后的完整性。主机丢失、本地抑制丢失或无法证明最新记录完整时，**禁止用旧备份恢复或重新暴露相关旧资料**，不能从旧数据库推断“没有删除”；须补齐可信的最新抑制事实并成功回放后，才可恢复相关服务。该恢复缺口须在首轮封闭体验的数据范围与故障处置说明中明确，并按实际采集风险完善体验专用抑制方案；它不自动成为 §15.6 首次受控体验的完整容灾前置。
5. 恢复验证必须回放所恢复数据适用的 `AccountClosure` 现有版本 1–5 事实，包括注销、可选资料删除、地址删除、授权撤回、客服保留抑制，并检查新旧版本冲突及媒体不可重新暴露；回放失败不得启动承载这些恢复资料的对外 API。不能将启动时回放有实现等同于本轮演练通过。
6. 正式运营与恢复资格按实际启用范围完成独立媒体恢复/抑制方案、实际恢复对账、失败演练、准确源码和证据绑定、具名值守及签字 RPO/RTO；本候选不能证明该资格。首次封闭体验按 §15.6 的真实版本门禁、有限数据范围及已说明的恢复局限判断，不将上述完整运营/恢复验收整体前移为首次体验采集条件；本备份工具也不替代尚未通过的身份、域名、数据隔离、隐私或能力门禁。

## 本地验证

`python3 -W error::ResourceWarning -m unittest discover -s infra/tencent -p test_cisme_trial_encrypted_backup.py -v` 的 14 项测试覆盖固定 Pg 目标、生产 URL/路径/特权拒绝、root/附加组拒绝、只读预检、内容与认证标签篡改/错误密钥、生产格式/截断拒绝、只读解析器提前退出仍完整认证、真实合成 dump 子进程成功/失败、403 拒绝与错误脱敏、7 份/30 天保留、跨前缀/路径穿越/重复/未来 manifest 拒绝及 systemd 隔离。测试仅使用临时合成字节/进程与 mock，不连接服务器或 COS、不生成运行密钥，不证明数据库实际恢复或定时任务安装。
