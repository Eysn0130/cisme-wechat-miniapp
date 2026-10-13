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
| 体验协议 | 本机 /v1/legal 返回 HTTP 200、ready=false、documents=[]，体验库 legal_document 为 0。基础服务健康不代表注册可用。 |
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

四份历史协议 JSON 均缺当前验证器要求的三份可读附件，不能直接导入新体验库。已形成 [体验协议事实核对清单](../legal/trial-on-production-20261013/README.md)，复用已确认主体、客服渠道与处理原则，并明确尚缺实际客服接待、普通咨询保存参数和体验结束处理条件。清单不是生成器输入，也不构成发布批准。正式商务模板需收窄为体验实际范围后才能审阅。

体验独立加密备份候选在 `infra/tencent/cisme-trial-encrypted-backup.*`，操作条件与恢复边界见 [候选说明](../../infra/tencent/TRIAL-BACKUP-PREPARED.md)，当前未安装/启用。14 项本地合成测试、Python 语法检查及独立代码审阅通过；最终脚本 SHA-256 为 `d84a53c74aa81397c5c8851496e33daa29f05e334adeb91b047af35acb0cbbe0`。测试包含真实合成 dump 子进程成功/失败、完整 GCM 认证与篡改拒绝、403/非 NoSuchKey 404 拒绝、生产目标与跨前缀清理拒绝。远端体验前缀权限、独立密钥及恢复/删除抑制验证尚未完成，不得以工具写完或数据库归档可读性宣称完整恢复合格。

## 依赖审计发现与修复候选

草稿 PR #26 的 `94ef829` 验证在生产依赖审计失败：Sharp 0.35.4 处于 [GHSA-wq5f-xc86-pv6w](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w) 的高危受影响范围，另有 Fastify、busboy、fast-uri 和 ip-address 中危项。本轮没有关闭或降低审计门禁。候选已精确升级 Fastify 5.12.5、Sharp 0.35.5，并在原依赖范围内更新这些传递包以及开发工具链的 brace-expansion、http-cache-semantics、source-map-js，未跨 major 或增加 override。

锁定候选的 [依赖修复回执](../evidence/production-runtime-20261013/dependency-candidate.json) 记录两份 manifest/lock 与 workflow 摘要。生产和全依赖的 high 门禁均 exit 0，所有严重程度合计均为 0；构建（包含两套 typecheck）、8 文件/261 项定向 unit 和内存合成 PNG→128×128 WebP/JPEG 转换通过。没有启动本地后端、数据库或重复跑真实集成；完整远端 CI 仍须单独取得准确提交的回执。

12:09:50 UTC（洛杉矶 05:09:50）的 [已部署依赖回执](../evidence/production-runtime-20261013/deployed-dependency-readback.json) 确认两环境四个入口均解析到 Node 24.14.0、Fastify 5.12.3、Sharp 0.35.4、librsvg 2.62.91。这个版本查询没有处理图像、测试利用或修改服务器。源码依赖更新和 npm 审计通过不能关闭已部署服务器的漏洞；必须在准确主线及 CI 通过后重新制作不可变制品，按生产与体验各自的升级/保护点流程部署并读回实际版本。禁止在当前运行目录内原地 npm 更新。

CI 性能比较已与安全补丁协调：保留历史基线业务源码，两组使用相同修复后的依赖输入，保留基线脚本并拒绝无关 manifest/workspace/安装生命周期漂移，保存原始与共同 manifest/lock、实际安装依赖摘要；不能用旧依赖运行基线，不能把受控比较称为旧依赖下的历史成绩。该调整不跳过性能、审计、集成或原生验收门禁。新增独立 Python venv 的精确 cryptography/cffi/pycparser 依赖与体验备份 14 项、Certbot 8 项 CI 覆盖。YAML、Bash、嵌入 Node 与正反漂移夹具验证通过，未把静态验证称为性能通过。

下一步按实际证据推进：材料修正 → 提交前明确确认 → 腾讯云/管局实际结果 → 公网入口与外部 HTTPS 验证；并行完成体验备份权限/恢复抑制、有效协议及客服事实。之后读回微信合法域名/隐私指引和准确开发版，设置指定成员体验版，进行 iOS/Android 原生验收。正式发布与真实交易、公众 UGC 各自通过适用门禁后才开放。
