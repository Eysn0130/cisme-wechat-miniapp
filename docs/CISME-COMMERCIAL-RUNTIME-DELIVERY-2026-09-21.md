# CISME 商业版推进：渐进读取、生命周期与历史查询

## 1. 事实与范围

本轮从已合并 PR #5 的 main `42e9b44db959000b10c8e6f4d0fd0e150fe69b89` 开始；变更在 [PR #6](https://github.com/Eysn0130/cisme-wechat-miniapp/pull/6)。本报告是一个可审查源码阶段的交付，不是全部商业正式版完成或发布授权。

受测业务源码和验证脚本 tree：`114f89f4c012fce78e56fd7bfdd2d0267e4159d0`（不包含本报告等后加说明）。原生包：`8fca4a19907fb7d5d57463c367d63aa2f407d0c490d3b32351d599599e4b91d5`。最终 PR HEAD、合并 main、准确 Actions 及合并后结果由 PR 收口评论和外部回执绑定，不能继承父提交绿色结果。

唯一长期工程仍为 `/Users/mini/CISME`。本轮只在临时 Linux 副本和 GitHub Actions 施工，没有访问或同步 Mac、打开开发者工具、原生编译、拍摄截图、微信体验版上传、真机测试或生产部署。不能把上轮 74 项编译结果套用本轮新包。`releaseReady=false`，当前包 manifest 保持 blocked。

## 2. 已施工缺陷与回归边界

| ID / 优先级 | 已复现事实及处理 | 证据、回滚与剩余边界 |
|---|---|---|
| PERF-11 / P2 | management、commission、order-detail 的核心事实不再与 runtime 共用等待屏障；核心/能力各自加载、失败和重试。金融动作须核心、当前会话及有效能力同时成立。 | 真实 Page 逻辑挂起/拒绝两侧依赖；辅助未知时可读核心但不执行资金动作。非真机耗时证明。 |
| PERF-12-A / P2 | 本批三页 onHide/onUnload 取消页面自己的 GET 订阅，保留其他消费者和写请求；独立读世代、runtime 重试世代、账号/页面存活守卫；返回前台后重新核验。 | 覆盖隐藏、换号、旧响应、新一轮读取、写入中返回。Cloud HTTP 仅逻辑取消，不承诺底层传输中断。其余页未整体关闭 PERF-12。 |
| REL-02-A / P2 | 本人的退款、结算、购物权益历史查询与出站 Provider/资金开关分离；关闭资金操作后，仍可核对已发生事实。 | 三个 GET 的真实数据库反向测试；保留本人谓词、受限游标、分页及 REPEATABLE READ；所有资金 POST、确认参数接口仍保持原门禁。不是正式退款执行闭环。 |
| SEC-01-A / P1 验证项 | 历史列表明确最小字段；结算列表不返回 payee/OpenID、confirmation package、幂等键或请求哈希。 | 本人/他人、伪造参数、跨人游标、失效身份、停用会员、关闭能力的负面验证。本批测试不证明全仓对象授权完整。 |
| UI-02 / P2 | 订单退款记录 pending/error 原先可显示“0 项”；改为“正在核对记录数量/记录数量暂未核实”，仅收到权威空结果才显示 0。 | 两项新增用例修复前均失败，修复后通过，检查 WXML 实际绑定 refundCountLabel。 |
| REL-02-B / P2 | 快速连续点击确认仅产生一笔命令；页面隐藏后的旧支付/收款响应不主动拉起微信资金面板；修复已支付查单路径 busy 无法释放。 | 包含正向开放、隐藏、重复点击、当前页丢响应重试同键等用例。卸载/进程重启后的持久恢复仍开放。 |

实现入口：`apps/miniprogram/services/commerce-runtime.ts`、上述三页 TS/WXML、`services/orders.ts`、`services/api/src/commerceHistory.ts`、原 refundCommand/settlementCommand/shoppingCredit/server 及三个 OpenAPI GET 说明。未增加数据库迁移、依赖、生产开关或正式能力。现有 v1 runtime 仍只支持 disabled/测试；formal 类型为预留，未知版本及真实支付字段不能被当前客户端自行批准。

回滚以新的 revert 提交为单位，重算原生包并保留历史验收绑定；无需迁移回滚。回滚会恢复上述已知问题，不是默认处理方案。原 PR4/PR5 回归、全局样式预算与普通 CI 保持，不以删测试或改门槛通过。

## 3. 验证与测量

本地 Linux 使用 Node 24.18.0 和原锁文件，最终 70 个单元文件、532 项通过；其中新增 78 个 Page/能力回归、4 个清单验证。首轮 36 个诊断在原 main 上 30 失败/6 通过；退款数量的后加两例单独选择执行，修复前 2 失败/76 未选中。没有把未选中标为失败或通过。

最终包重新执行 typecheck、build、contracts、package、routes、design QA 结构检查及 diff hygiene，均通过。新增 30 个数据库集成用例位于 `tests/integration/commerce-history-gates.test.ts`；本地没有 PostgreSQL，不声称本地执行。其结果和全量总数以最终 HEAD 的正常 GitHub verify 日志为准。原 CI 同时执行两类根依赖审计与六组隔离性能对照；独立 `tools/wechat-ci` 未安装，不声称该工具风险消失。

255 文件、37 路由；主包 1,431,193 bytes，总包 2,176,943 bytes，相对起点分别增加 3,329 / 15,157 bytes。全局 WXSS 仍 8,137 / 8,192 bytes，未扩大预算。业务运行源码 13 文件 +339/-174；测试 4 文件 +421/-3；脚本/工作流 3 文件 +166/-0；契约与验收绑定 4 文件 +484/-4（其中两个 240 行历史 manifest 是追溯数据）。此统计不包含随后新增的说明文件。

挂起依赖的行为测试证明“先显示哪个区域”和“动作能否执行”，没有真实毫秒提升值。app.inject、同 runner 容量结果不包含真实公网 TLS/微信桥/手机渲染；不宣称核心 API P95≤500ms 或页面 P95≤2s 已达标。G0 签字、地域、网络、样本、失败分母和真机窗口仍须按 PRD §13/NFR-MEASUREMENT 完成。

## 4. 37 页清单不是 37 页验收

运行 `./node_modules/.bin/tsx scripts/audit-commercial-lifecycle.ts` 生成当前包 JSON：覆盖 37 个实际注册路由、111 个 TS/WXML/WXSS 哈希，逐页列出入口角色、权限撤销/换号等验证角色、既有 PRD/interaction contract 需求、事件、生命周期标记、局部字号/动效及原生验收缺口。CI 的 `Commercial preparation evidence (not release authorization)` 可重跑并保留独立工件。

6 页出现直接 pageRead/owner 标记，分别是 home、profile、community 与本轮三页；另 31 页需要沿 imported service、包装器及轮询追踪，不能直接称 31 个取消漏洞。12 页没有词法 onHide 标记：legal、management-catalog、management-orders、management-order-detail、management-members、management-member、referral、community-post、community-author、community-review、community-activity、management-finance。没有 onHide 不自动等于缺陷；需要真实挂起/离页/恢复复现。

每一页的原生编译、视觉、iOS、Android、完整状态都明确为本轮未执行。原清单的状态是继承的需求，不是继承的 PASS。卡片、字号、按钮内部文字、窄屏、键盘、安全区、可访问性、减少动效和 blur 需当前包原生证据；本轮未进行全局字体替换、换主题或装 Web 动画库。详细逐页业务检查继续使用商业审计的 37 行和当前生成清单，不新建空壳页面。

## 5. 上游采用与治理

见 [资源选择](CISME-COMMERCIAL-RESOURCES-2026-09-21.md)。2026-09-21 07:29 UTC 重新核验 11 仓库元数据、准确提交和可读根许可证哈希；只是来源核验，不是所有 runtime/素材授权证明。本轮依赖增加为 0。

治理现状重新读取：rulesets `[]`，main `protected:false`。当前连接拒绝 environments 路径，不能把上轮 0 个 environment 当成本轮已核实为空。没有配置分支保护或部署审批；连接未提供相应管理写入动作。建议由有管理权限的仓库负责人创建 main 规则：要求 PR、禁止强推和删除、准确 `verify` 检查、最新基线；review 人数按实际可用的独立审阅者设置，不能用自己的审阅冒充独立批准。通过不涉及生产的测试 PR 验证拦截后才记录生效。

staging 与 production 环境应有独立资源身份、最小权限及 production 审批/防自批/分支限制；目前只能准备方案，不能填入未经确认的部署目标。旧材料说明曾有 staging，不说明现在没有服务，也不说明当前包已部署。production origin、正式协议与发布候选仍需真实配置和证据；不得试探未知线上库。

## 6. 未完成项：责任与下一动作

| ID | 当前状态 / 负责人角色 | 最小证据与下一动作 |
|---|---|---|
| MONEY-RECOVERY-01 / P1 | 代码仍可继续；原生/API 实施者 | 当前页保持原载荷可同键重试已测。超时后编辑金额、离页卸载、进程重启可能丢原键/载荷；复用既有护理恢复原则建立按主体隔离的命令日志，先查原结果再准新操作，覆盖 A→B→A、重启及最终未知。不是等待商户才可做。 |
| PERF-12-B / P2 | 代码仍可继续；原生实施者 | 从 37 页清单选 orders/records/管理列表及客服，实际挂起读取和后台计时器，跟踪共享消费者后逐批修复；不盲目把所有 request 改为可取消写请求。 |
| REL-01 / P1 | 代码差距与外部依赖并存；支付/API 实施者、商户负责人 | 当前 v1 不会正式支付；继续 provider gap、查单/回调/部分退款/履约/护理资格/对账的隔离测试。外部仅需确认适用商户模式、主体/AppID、证书安全注入通道和批准的交易验证范围；不要在聊天提供私钥。 |
| SEC-01-B / P1 | 代码仍可继续；安全/API 实施者 | 重算全部已注册方法分母，扩展资产/地址/私有媒体/客服/管理撤权对象字段动作矩阵；三个历史 GET 不是全覆盖。 |
| PRIVACY-EXEC-01 / P1 | 代码与政策；隐私实施者、业务/隐私负责人 | 全量数据目录、身份核验、导出期限/撤销、注销下游会话、法定保留及 hold 规则；保留规则需责任人确认，先用合成库验证，不能硬删财务审计。 |
| NATIVE-37 / P1 | 需要 Mac/原生执行者及获授权真机 | 唯一目录安全 ff 同步最终 main，正确 project 参数在 apps/miniprogram；当前包 37 页角色/状态、原生截图、iOS/Android 与低端设备证据，不复用旧 74 编译摘要。 |
| NFR-G0 / P1 | 工程与签字；性能实施者、G0 责任人 | 先确认隔离环境；同网络/冷暖/数据量前后测量、P50/P95/P99/失败超时完整分母，手机与真实 HTTPS 另测。缺签字只作探索结果。 |
| PLATFORM-OPS / P1 | 平台/运维负责人及有管理权限者 | 主体类目备案、域名/隐私 API、正式协议、staging/prod 隔离、备份恢复/告警/回滚、客服升级/投诉与 UGC 审核流程、仓库规则实际生效回执。源码准备继续做，不能声称已部署/体验版/审核完成。 |
| RELEASE-SCOPE / P1 | 产品/Owner 责任人 | 固定本次 R0 CORE/实际 R0 GATED 的正式 release manifest；购物车、复杂成长、AI 经营、多渠道保持已批准后续范围。该表未替责任人签字或批准延期。 |

以上角色尚不代表已指派到具体人员或完成签字。没有因本轮通过测试而宣称“其他代码没有隐患”，也没有宣称所有可独立施工代码已完成。下一阶段继续原需求，入口见 [下一轮增量执行](CISME-COMMERCIAL-NEXT-EXECUTION-2026-09-21.md)。
