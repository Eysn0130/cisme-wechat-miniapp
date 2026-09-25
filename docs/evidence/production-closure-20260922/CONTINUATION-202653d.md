# CISME 当前施工断点（2026-09-23 UTC）

唯一工程 /Users/mini/CISME；唯一仓库 Eysn0130/cisme-wechat-miniapp。未创建 Goal、新长期项目、生产权限或付费服务。

## 源码与准确验证

本次源码候选 202653d35b745c9cad2e47cba248dcf9e4706946，tree e8148bb768aa00b6932fa8d319fc9e6c3fefc36c；分支 codex/fulfillment-lifecycle-20260922。GitHub main 实时仍为 5740e18544fa37dd473c36934a2a12a07a2d5ec9，main 历史 CI35712388809 success，不是本候选 main CI。PR22 OPEN Draft；尚未 merge。

f4c8df9 → 202653d：源码/测试/脚本新增6、修改13、删除0，+177/-22；另有原生截图与证据。40abede 新增小程序内履约列表、审计 Excel 导出、五列物流粘贴批量回写、幂等重试与撤权清空，并修复私有下载迟到回调/取消/换账号的临时文件清理。202653d 统一所有 /v1 响应 private,no-store；见 HTTP-CACHE-BOUNDARY.md。PC 登录 UI/设备码/PC Session 不在当前小程序/API/migration 路径；历史 apps/admin 为参考代码，打包器不把它放入正式制品。通用成员会话、capability、防重放、审计保留给实际原生与服务端消费者。

准确 CI35803110597 success：1099 单元/100文件、818 集成/48文件、52 Python 检查。实际 checkout 41ad88f 是 PR 合成提交；凭据预览和候选设计验收 skipped。补充当前源码 PostgreSQL16.15 全量隔离集成 818/48，通过；run a2f04bb189915cf32f32817b 的新建 PG/S3 已清理。PG18 全量隔离 run39762b428e0b9d61365ce21c 已清理。不可变包自身另在新建 run406c40979f4350fbfbfb8582 通过81项制品校验、75迁移、重复0迁移、bundle health200/metrics401；这些是合成验证。

当前后端候选 dist/tencent-release-202653d35b74；归档 tmp/tencent-release-202653d35b74.tar.gz，435202字节，SHA256 0e2f04184ef3d21c147833946f56021d90b4873e69ce8d7ddd44c95b5f05fdbf。不含 PC Admin、runtime.env 或凭据；仍非 main 正式制品。

原生包 f627b97144377bfc333509614417342552d3c7b570bee05df944dee85552d815、39页、267文件。39页当前包原始采集：38正常、资金页按预期关闭；另有2张真实按钮交互截图。隔离 UI 导出、一次物流登记/重复提交和撤权清空已验证。截图原始来源为本机合成 harness，不代表当前 staging 全状态、iOS/Android 或完整原生通过。没有物理设备验收回执。

## staging（与production分开）

当前已激活准确202653d候选，run rc20260922-00c7d2e9。15项HTTP合成业务、18次缓存检查、23→75项保留数据升级、129表及选定业务恢复、61次健康采样、实际回滚并保留备份后新写入已通过。监控Result=success。原始回执和限制见STAGING-202653d-ACCEPTANCE.md及STAGING-202653d-RAW.json；正式资金仍关闭，COS和外部告警未通过。

## production（没有改动）

仅 lhins-61ikz4mi / cisme-app-shanghai /124.223.74.198/api.cisme.cn 是目标。最后现场 release /opt/cisme/releases/20260909-native-login 无 sourceHead，SHA UNKNOWN；不等于新 main。APP_ENV 错标 staging。原 cisme DB、COS lhcos-81ddf-1257392443 保留。

数据库完整连接串曾进入工具输出，事件确认；未发现提交到 Git 的证据，不等于排除滥用。凭据尚未轮换。两进程共用凭据、loopback5432；旧 CloudBase 消费者绑定未查清。5432 对 all IPv4 云规则、UFW IPv4/6 Anywhere，PG实际监听；SCRAM/mTLS 不替代网络收紧。22 同样开放、80云允许但OS无允许且不监听、443监听但两层未见允许。Production DNS-01 hooks/timer 已有配置，未做真实续期/最小 DNS 权限验收。精确现场范围见 SECURITY-INCIDENT.md；没有变更网络或凭据。

本机最新探针解析为198.18/15地址，对两环境都失败：只记录为本机路径不可用，不能当作云实例真实IP或推断新的staging故障。不得绕过工具站点限制。腾讯云已登录控制通道可用；微信公众/商户相关受限页面及旧CloudBase关联权限仍未验证。

## 技术未完成（不能写成待截图）

1. 正式隐私执行仍为 SyntheticPrivacyExecution 的 dev_test/资料子集，正式全主体数据映射、导出/下载/TTL、撤回及按批准保留规则删除仍需源码和测试。不能把受理回复或合成导出标成执行完成。
2. 完整售后：退换申请/撤销/受理/退货运单/收货核验/换补寄与微信退款事实关联仍需完成；已有退款状态机和资金恢复保留。物流助手 getPath 不能冒充任意手工运单查询，物流查询组件适用路径与真实账号资格需核实，不新增付费服务。五列粘贴已做，XLSX文件解析导入未做。
3. 239个/v1（241含health）入口的13维逐入口审阅未全部完成。208个会话接口共同鉴权和缓存测试不代表对象/字段/并发等全维完成。
4. 必须实现并演练真正 production 保留原数据升级入口，现场采集并接入 production-target.py；当前只有只读guard和staging部署。不能把新空库installer用于production。独立审查/main合并/main自身CI和正式制品尚未完成。
5. 当前staging业务验收有边界：资金关闭、合成HTTP及本地对象恢复不是完整支付/履约/真实微信/COS/告警验收。仍须覆盖正式候选、真实隔离COS恢复、密钥与角色恢复、外部告警送达、完整原生状态和iOS/Android真机。

## 业务批准与平台外部项

用户明确尚无另外批准资料：实际退货收件地址/电话、正式用户协议/隐私政策及保留期限、生产故障告警渠道/接收人。先复用真实可核验来源，否则上线前集中确认；禁止编造，不阻断无关施工。真实资金/轮换/网络敏感变更/正式提审发布分别在动作点确认。

备案仅保留用户原文“小程序备案 管局审核中”，未撤回/重提/推断为代码审核。ICP/腾讯接入、微信合法服务器域名及商户AppID绑定与具体授权仍需允许通道的原始平台证据。iOS/Android需实际设备。旧cisme_test影响UNKNOWN / 未恢复。

## 分开的发布状态

implementationComplete=false（上述技术缺口）；mainMerged=false（PR22 Draft）；productionDeployed=false（旧release）；productionValidated=false（HTTPS/恢复/安全等未闭环）；commerceEnabled=false（候选真实资金门禁关闭，无交易验收）；filingComplete=false（管局审核中）；codeReviewApproved=false（无微信代码审核通过证据）；miniProgramReleased=false（无正式发布）。这些状态不能被CI或staging成功替换。

下一施工动作：先补正式隐私与完整售后并完成剩余接口审阅，再以允许的控制通道核对旧DB消费者/物流与支付绑定；在最小业务批准、恢复/告警与真机验收齐备后独立审查、合并main、验证main CI并保留数据升级正确production。备案通过后仍须明确批准微信提审和正式发布；不能声称现在只剩备案。
