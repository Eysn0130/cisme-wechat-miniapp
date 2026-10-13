# CISME 正式服务器接续记录 — 2026-10-13

接续聊天“完成正式服务器部署运行”。本轮复查与准备工作仅针对正式实例 `lhins-61ikz4mi` / `124.223.74.198`，未连接旧测试机，未切换生产应用、修改业务数据、开放公网或发布微信版本。裁决仍以 PRD V2.1-R4 §15.5、§15.6、`BASE-WX`、`G0-PRE/G0-OPS` 为准。

## 现场运行与范围

实测元数据保存于 [runtime-readback.json](../evidence/production-runtime-20261013/runtime-readback.json)，时间为 2026-10-13 11:48–11:52 UTC（洛杉矶 04:48–04:52）。记录不包含密钥、成员身份、业务正文或证件号码。

| 项目 | 本轮证据与限制 |
| --- | --- |
| 生产与体验 | 四个 API/Worker 服务 active/running；生产 PID 未改变；两套制品验证各 103 artifacts / 97 migrations 通过。没有重新校验整棵 node_modules。 |
| 数据隔离 | 体验角色能连接 cisme_trial，无法连接 cisme、postgres、template1；不具有 superuser、createdb、createrole、replication、bypassrls 或角色成员权限。六类数据库/会话/上传/联系加密/联系索引/隐私导出配置分别独立，未披露值。 |
| 能力开关 | 体验真实交易、模拟支付、履约、积分、公开 UGC、COS 直传、手机号绑定及开发身份均关闭。 |
| TLS | 两个实际域名 SNI、受信证书链与主机名在本机验证通过，HTTPS readiness HTTP 200；未使用 -k。Certbot timer active，读回两个 renewal hook；本轮未重跑续期或证明公网可达。 |
| 公网边界 | 控制台云防火墙已允许 TCP 443/22/80 和 ICMP；主机 UFW 仍仅允许 22。工作站域名请求经过代理合成地址并超时，不能当作公网验收或归因为云防火墙错误。3100/5432 仍监听全部接口，不得放通这些端口。 |
| 体验协议 | 11:52 初始 /v1/legal 为 ready=false、空文档；12:55 已原子发布独立体验协议，两份新文档 ready=true、全文摘要匹配。未创建会员同意；不替代公网/微信注册实测。 |
| 正式备份 | 定时任务 enabled/active，读回最新回执为 2026-10-12T19:30:06Z、success，并标记 checksum/GCM/archive 可读性通过；这是已有回执，本轮未重新下载或恢复。 |
| 体验备份 | 没有独立 unit。现有维护身份 GET backups/cisme-trial/ 返回 403 AccessDenied，而生产 manifest GET 为 200；未试写或删除对象。生产备份不覆盖体验库。 |
| 续费与告警 | 控制台正式机到期显示 2026-12-08 22:01:23，显示时区未明确；自动续费未勾选。本轮未购买续费，未验证外部告警实际送达。 |

## 备案草稿接续

本轮重新打开原订单的“信息预览与提交备案”，前三步骤已可进入完成后的预览。主体为熹芃（上海）生物科技有限公司，主体备案号沪ICP备2026051386号；新增服务域名 cisme.cn、正式服务器 124.223.74.198，用途保持小程序后台 API，交易与公众 UGC 关闭。

实际预览中的主体负责人为王琼，服务负责人为何国钦，服务页列有其证件与视频核身材料。不得继续沿用旧记录中“服务负责人和主体一致、服务未保存”的说法；预览与材料存在也不证明腾讯云/管局已批准。

本轮放大检查的服务负责人身份证人像面仍带“仅用于腾讯云备案”水印；腾讯云要求材料水印为“仅限 ICP 备案使用”。需要使用符合要求的原件照片更新，不能编辑旧水印后宣称原件要求通过。其他证照的历史材料问题未取得本轮已修正证明。

已只读查看备案承诺书和 ICP 负责人授权书：承诺信息真实有效并及时更新；授权书由本单位授权何国钦负责 cisme.cn 的互联网信息服务及备案事项，相关行为视为本单位行为。两份弹窗均用关闭按钮退出，没有点击“确认”。隐私声明/相关条款同意框与可选公安同步框均未勾选，提交审核仍 disabled，未提交。

最后提交涉及接受具有约束力的条款与承诺，浏览器操作规则要求在实际接受时取得用户明确确认。先完成材料修正，再进行提交前确认；本轮不将“继续”解释为已接受上述授权。预览页已保留供接续。

本地截图仅是云控制台证据，按仓库规则不进入 Git：

- `docs/evidence/production-runtime-20261013/filing-review-pending.jpg`：折叠证件和联系方式的未提交预览。
- `docs/evidence/production-runtime-20261013/filing-commitment-preview.jpg`：仅含公司名称的承诺书预览。
- `docs/evidence/production-runtime-20261013/cloud-firewall-readback.jpg`：正式实例现有规则。

政府证件大图和含身份证号码的授权书未保存到证据目录。

## 体验交付准备与下一步

当前原生包 source SHA-256 仍为 `3c895fb74af445001cc5b731dc1199eba90cfe8f0536a1f3d8faa789a2a3901d`，270 文件/40 路由，主包 591,113 B；包门禁和 local preflight 通过。当前完整 Design QA releaseReady=false。本轮没有抢占微信开发者工具、创建小程序截图、真机测试、上传或设置体验版；9 月旧截图不自动作为本轮通过。

四份历史协议 JSON 均缺当前验证器要求的三份可读附件，不能直接导入新体验库。用户于本轮明确委托按合理判断研究、确定体验运营安排，不再要求逐项回填参数：每日北京时间 09:00–22:00 人工接待，其余时间留言；普通已结案咨询保留三个日历月；退出或体验结束后按必要用途清理，未结争议和必要处理凭证隔离保留。交易关联资料继续沿用已确认三年业务基线，不扩及普通咨询。已基于这一授权与真实能力范围准备并发布 [封闭体验协议与三份附件](../legal/trial-on-production-20261013/README.md)，不再把上述运营参数作为缺少用户输入的阻塞。

12:55:35–12:55:48 UTC（洛杉矶05:55）的 [实际协议发布回执](../evidence/production-runtime-20261013/trial-legal-publication.json) 绑定准确JSON SHA `573582b3d1e461fac209f3ef5eeb3d495108af05d7fcc8d12abd1b4c62b3c700`。现有发布器与验证器本地bundle仅external既有pg，受控root只向体验角色传递独立URL，原子写入体验两文档和一条审计，版本 `2026-10-13-v1-trial`。前后成员及三类同意记录均为0；本机真实域名可信TLS读回 ready=true、正文摘要完全一致。正式协议、全部服务PID、UFW均未改变；没有安装依赖、重启服务、迁移、修改微信平台或打开公网。

首次受控体验按 PRD §15.6 验证当次上传、指定名单、真实微信身份、HTTPS API/合法域名、独立数据/存储及能力开关 fail-closed。完整媒体容灾、正式运营具名值守和签字 RPO/RTO 不整体前移为首轮体验前置；iOS/Android、弱网、隐私、上传和后台审核证据在体验中取得后评估候选准入。未核实的真实门禁仍不能声称通过；故障恢复必须避免已删除资料重新活跃。

体验独立加密备份候选在 `infra/tencent/cisme-trial-encrypted-backup.*`，操作条件与恢复边界见 [候选说明](../../infra/tencent/TRIAL-BACKUP-PREPARED.md)，当前未安装/启用。14 项本地合成测试、Python 语法检查及独立代码审阅通过；最终脚本 SHA-256 为 `d84a53c74aa81397c5c8851496e33daa29f05e334adeb91b047af35acb0cbbe0`。测试包含真实合成 dump 子进程成功/失败、完整 GCM 认证与篡改拒绝、403/非 NoSuchKey 404 拒绝、生产目标与跨前缀清理拒绝。远端体验前缀权限、独立密钥及恢复/删除抑制验证尚未完成，不得以工具写完或数据库归档可读性宣称完整恢复合格。

## 依赖审计发现与修复候选

草稿 PR #26 的 `94ef829` 验证在生产依赖审计失败：Sharp 0.35.4 处于 [GHSA-wq5f-xc86-pv6w](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w) 的高危受影响范围，另有 Fastify、busboy、fast-uri 和 ip-address 中危项。本轮没有关闭或降低审计门禁。候选已精确升级 Fastify 5.12.5、Sharp 0.35.5，并在原依赖范围内更新这些传递包以及开发工具链的 brace-expansion、http-cache-semantics、source-map-js，未跨 major 或增加 override。

锁定候选的 [依赖修复回执](../evidence/production-runtime-20261013/dependency-candidate.json) 记录两份 manifest/lock 与 workflow 摘要。生产和全依赖的 high 门禁均 exit 0，所有严重程度合计均为 0；构建（包含两套 typecheck）、8 文件/261 项定向 unit 和内存合成 PNG→128×128 WebP/JPEG 转换通过。没有启动本地后端、数据库或重复跑真实集成；完整远端 CI 仍须单独取得准确提交的回执。

12:09:50 UTC（洛杉矶 05:09:50）的 [已部署依赖回执](../evidence/production-runtime-20261013/deployed-dependency-readback.json) 确认两环境四个入口均解析到 Node 24.14.0、Fastify 5.12.3、Sharp 0.35.4、librsvg 2.62.91。这个版本查询没有处理图像、测试利用或修改服务器。源码依赖更新和 npm 审计通过不能关闭已部署服务器的漏洞；必须在准确主线及 CI 通过后重新制作不可变制品，按生产与体验各自的升级/保护点流程部署并读回实际版本。禁止在当前运行目录内原地 npm 更新。

独立 [Linux/x64/glibc provisional构建](../evidence/production-runtime-20261013/provisional-linux-build.json) 使用固定无挂载、无凭据镜像及Node24.14，绑定准确3b1提交/tree。新制品的index、worker、worker-once、migrate与完整97SQL，共101文件分别与两环境751f运行制品逐字节相同，哈希清单差异仅package.json/lock；manifest的来源元数据另有变化。候选解析Fastify5.12.5、Sharp0.35.5、librsvg2.63.2、libvips8.18.7；25,586,859 B归档SHA为 `d08354ad00d833537a9ee19f5eff5a45634c19d157d3db0bb45d50f901119c9e`。这支持限定依赖升级范围，不制造数据库迁移或整库恢复；该包只是provisional，最终main仍须重新打包、现场确认全等和部署后读回，不能提前宣称服务器漏洞已关闭。

已准备并独立审阅 [限定依赖升级入口](../../infra/tencent/DEPENDENCY-ONLY-UPGRADE.md)，不修改通用生产升级和首次体验初始化门禁。工具SHA `f3167be74d1e9322eec2155bc5d11e6cfb4ac3a73edc0d137f599e8ce4c0e6dd`，固定本次package/lock许可、101个运行/SQL字节全等及准确main最新push CI。两环境原配置、私有文件、unit定义/实际进程和数据库分别绑定，先停止本环境并排空连接，失败只恢复应用；未知漂移保持停止，不恢复数据库或覆盖新事实。trial初始化历史和新协议保留。29项新增离线拒绝/回退检查和独立终审通过；完整production套件54项通过、1项保留原Linux容器条件跳过。工具当前尚未启用，后续真实预检/切换回执另行记录。

13:23:42 UTC只读读回确认正式配置及两进程的 `COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED`、`COMMERCE_FULFILLMENT_ENABLED` 原为true，订单/公开UGC/开发身份为false；试用的对应配置全部关闭。协议准备配置不授予订单/退款/转账，新入口按环境保留既有准备配置并严格绑定原值，不能为补丁修改env；模拟和积分等缺省关闭值也与实际进程绑定。§12记录工具仅访问公开GitHub来源与本机元数据/健康检查，私有快照不外发。静态签名31→32的唯一新增为离线测试的本地 `def fetch(path):` 声明，已同步严格指纹，未改门禁正则或断言。

CI 性能比较已与安全补丁协调：保留历史基线业务源码，两组使用相同修复后的依赖输入，保留基线脚本并拒绝无关 manifest/workspace/安装生命周期漂移，保存原始与共同 manifest/lock、实际安装依赖摘要；不能用旧依赖运行基线，不能把受控比较称为旧依赖下的历史成绩。该调整不跳过性能、审计、集成或原生验收门禁。新增独立 Python venv 的精确 cryptography/cffi/pycparser 依赖与体验备份 14 项、Certbot 8 项 CI 覆盖。YAML、Bash、嵌入 Node 与正反漂移夹具验证通过，未把静态验证称为性能通过。

`216421b` 的完整 unit 校验有 1471 项通过、2 项失败。新增备份的 COS 客户端构造触发既有隐私调用签名门禁；已逐项审阅加密归档、manifest、固定前缀、轮换、权限与恢复限制，补充 [数据流审阅 §11](../CISME-PRIVACY-PERSONAL-DATA-ARCHITECTURE-AUDIT-2026-09-11.md) 和字典，签名精确由 30 条变为 31 条，未改门禁断言。另一失败是 unit 串行发出两个真实公网协议探测、默认各等待 8 秒，在 CI 负载下超过既有 20 秒测试上限；测试已改为受限匿名 GET 合成响应并并发执行两个真实 CLI，保留实际证据读取、人工门禁和公共协议失败断言，没有修改发布实现或提高超时。定向 4 项隐私与 21 项发布检查分别通过；合成 unit 传输不能作为公网或微信验收。

精确提交 `3b1fbe861a4684c53f5af32e6425e1350c017a14` 的 [CI run 38397962896](https://github.com/Eysn0130/cisme-wechat-miniapp/actions/runs/38397962896) 于 12:40:04 UTC 完成成功：verify job 115297914087 的两项审计、128 文件/1473 项 unit、58 文件/921 项隔离真实 integration、构建、合成恢复和两组同依赖性能比较均通过。原生 Design QA 与带凭证的微信预览 job 按该 PR 触发条件 skipped，不作为已上传、真机或原生视觉验收。该回执只覆盖此准确提交；后续文档版本及主线部署绑定仍须分别核对。

PR #26 已合入准确主线 `9a0417300e2f03da803543ba1e73bcd98057be42` / tree `0d868aacc396aafd786e91ce4db8a7e906c90c11`；该主线push [CI 38406957800](https://github.com/Eysn0130/cisme-wechat-miniapp/actions/runs/38406957800) 完整verify成功，原生QA/微信预览仍按触发条件skipped。该main独立Linux归档SHA为 `874cb4dfb7f3896c039dc90d166d636e0c9a6f528405ccb2e263746a20a88381`，25,585,711 B，fresh读取两套旧制品确认101个应用/SQL字节全等。没有激活此归档。

13:45:37 UTC现场只读检查发现正式API/Worker各有root:root0644的 `10-privacy-suppression.conf`，唯一directive为ReadWritePaths，父链root0755；体验没有drop-in。初版工具在停止服务前就会拒绝该输入。已保留配置并补充原drop-in完整字节、磁盘/加载文件集、父链元数据、静态有效定义和服务不可写边界的绑定，工具SHA更新为 `4f17023475c5022d78cf6097873849579772b37581af34c7364338b9f5a0373b`。35项拒绝/回退检查及两份独立审阅通过；全production离线检查60通过、1项原Linux条件skip。此后需新准确main及其push CI、重新打包和现场预检，不能修改9a制品manifest冒充新来源。尚未改变现场drop-in、配置、PID或数据库。

PR #27 已合入8eb主线，其 [push CI 38409876173](https://github.com/Eysn0130/cisme-wechat-miniapp/actions/runs/38409876173) 于14:10:20 UTC完成成功；verify job115339049584成功，原生QA/预览仍skipped。新的准确8eb Linux归档SHA `6842c80dc6b193218079de260f1c4e9e0192ad4d7bf4f339dbfca1c4f888906f`、25,586,442 B，101应用/SQL字节与两套现网全等。14:14已完整暂存至两套新release目录，manifest SHA `ee207238501bda6ab3d446a69e9eae0b2eef42e970e8f4d4c5e3b70087eb4a75`、整棵依赖SHA `351d7b03ebf507c9ddfc68c6cc04cdc69104e4bb6a6cc660b7b39bad256c5e44`及7运维模块匹配，未启用此包。两套只读preflight均通过。

两次体验apply在停止服务之前退出，诊断定位为GitHub Contents API锁文件HTTP200响应截断：声明457363、实际455857字节，缺1506，JSON无法解析。升级状态目录未生成，四旧PID全等，未迁移、恢复或切换。已保留 [真实截断及固定raw读回证据](../evidence/production-runtime-20261013/source-response-truncation.json)，并将三份固定提交源文件改为TLS验证的raw传输、64KiB循环完整读、1MiB上限及已知长度不符拒绝。新工具SHA `7c0f9e3456bc77c4659fd3538b23267f16719fc1e4f0e2cdb77c008671a3e429`；38项专项、完整production63项及独立审阅通过，保留1条原Linux条件skip。main/tree、最新push CI、原package/lock许可和migrator字节门禁不变，不注入假来源或复用旧制品元数据。

下一步按实际证据推进：材料修正 → 提交前明确确认 → 腾讯云/管局实际结果 → 公网入口与外部 HTTPS 验证；并行落实有效体验协议和服务器依赖补丁，备份候选按准确权限与恢复范围逐步启用。之后读回微信合法域名/隐私指引和准确开发版，设置指定成员体验版，进行 iOS/Android 原生验收。正式发布与真实交易、公众 UGC 各自通过适用门禁后才开放。
