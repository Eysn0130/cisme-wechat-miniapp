# PR7 后本机接续：客服队列读取所有权与本人命令发现

本批是源码修复及本机验收增量，不是商业发布。`releaseReady=false`。

## 接管与来源

- 唯一工程 `/Users/mini/CISME`，唯一微信项目 `apps/miniprogram`。接管时本地 main 为 `42e9b44db959000b10c8e6f4d0fd0e150fe69b89`，工作树干净，只有一个 worktree。
- 实时 GitHub main/PR7 合并提交 `1ec6ad4d01552c722432f47516989aee579570c2`；正常 fetch、`merge --ff-only` 同步。未应用 PR4/5/6/7 patch，未创建第二长期工程。
- 交付 ZIP SHA256 `b97acef66a02160a8206d731b2bb86178e420cb69384102557762613a3c2f2fa`。91 条目无重复、路径穿越或符号链接，解压总大小 9,843,489 bytes；直接用 zipfile 读取，未执行包内程序，90 个 SHA256SUMS 全部匹配。
- 完整读取 DELIVERY-REPORT、DELIVERY-RECEIPT、DEFECTS-AND-BLOCKERS、CODEX-EXECUTION A—G；历史授权陈述作为交接上下文，按本轮用户请求继续，未启动 Goal。
- 入场包重新计算为 `9d5f9fc09ad04e58c04e44efc1148a78ebe98fcf89bb9c36c266647eaa63461a`，与交付相同。

## 已复现与修改

`PERF-12-SUPPORT-QUEUE`，PRD §3.2、§6.3.1、§6.6、§11.3、§15.4，源码修复已验证，完整原生/设备仍开放。

真实 Page 逻辑的 13 个合成反例在旧源码全部失败：隐藏时挂起 GET 未取消；隐藏后的权限拒绝仍导航别的页面；换号后迟到列表回填/旧卡可点击；隐藏时重试和分页继续；静默轮询 401/403/404 不清敏感摘要；503 旧行无只读提示；慢轮询重叠；旧实例卸载停止新实例计时器；A→B→A 会话修订失效；分页重试出现重复行。

修复复用 `pageRead/cancelPageReads` 和已有会话修订；计时器、读取序列与展开历史状态归各 Page。隐藏只取消该页 GET 订阅。显式刷新重新核验权限；刷新显示旧内容时禁用入口；拒绝访问清除会话摘要。暂时分页失败保留已有内容/游标，重试去重。慢轮询不叠加，展开历史后保留原有停止自动刷新策略。未更改客服写入、服务端权限或真实资金/UGC/隐私门禁。

交互合同（复用现有 queue-shell、queue-card、state、text-button，无新组件/动效/字号）：首次读取展示 loading；成功显示会话；空态保持返回；刷新保留只读卡片并显示核验提示；临时失败保留只读内容及重试；401/403/404 清空并提示重试核验；隐藏不读取，返回重新核验；当前身份/世代/已核验状态都匹配才允许打开列表中存在的会话。按钮使用原生 disabled 和已有可读标签。窄屏、字体缩放和读屏实际效果仍须设备验证。没有把 Web ARIA、CSS 或测试数量当原生通过。

## 验证范围

- 15 项新客服行为回归 RED→GREEN（初始 13 项，加上真实 401 先失效会话及分页换号 2 项），原有分页返回回归保留通过。
- 命令发现新增 40 项集成场景；未实现接口时 14 项失败，其余鉴权探针由已有全局门通过，不能把它们声称首次具备鉴权。当前全部通过。
- 本机单元 78 文件：877 通过、1 跳过；跳过是 `performance-measurement.test.ts` 的 Linux 专用 loopback 来源测试，不冒称通过。
- 独立新建 `cisme-pr7-followup-test-20260921` PostgreSQL 18.4 容器，随机 loopback 端口，数据库 `cisme_pr7_followup_test`；先核 current_database/current_user，显式 TEST_DATABASE_URL，39 文件/702 集成通过。未读取未知 .env 或生产库；但一次漏写 TEST_DATABASE_URL 的补跑误重置了既有默认本机测试库，见 TEST-DATABASE-INCIDENT.md，不能声称全程仅触及新库。模拟器沿用已有 loopback API 配置，其当前后端身份未另行核实，不计 staging。
- typecheck/build/contracts/package/routes/design 结构通过；226 个 /v1 方法、228 个含 health 方法、32 事件对齐；195 个 session-required 入口的匿名/伪造拒绝并不等于全对象权限。设计 `releaseReady=false`。
- 根生产/全部依赖审计均 0 漏洞；无新依赖/迁移、ci.yml/全局样式预算修改。独立上传工具未安装、未注入凭据。
- 原始日志和截图保存在本机 `tmp/pr7-followup`，可公开的脱敏摘要与文件哈希见本目录 JSON。被平台限频中断的截图调用保留失败，不计入 PASS。

原生截图只覆盖实际记录的默认/拒绝态；不证明 37 页、全部角色、键盘、弱网、真实 wx 存储、iOS/Android 或商业核心旅程通过。WXML/WXSS 编译诊断与截图各有独立范围；旧截图保留原包来源。当前验收 manifest 继续 blocked。

## 三类余项与下一步

| 类别 / ID | 当前证据与边界 | 责任人与下一动作 |
|---|---|---|
| 本机 / NATIVE-37-CURRENT | 本轮模板样式与截图以 JSON 的实际成功项为准；0 页取得完整角色×状态矩阵 | 本机实施者/获授权 QA：按交付 C2 用独立合成 API 验证六类原命令、真实 wx 存储、后台/杀进程/切号、护理四步与周期权威事实，再双平台设备 |
| 源码 / PERF-12-REMAINING | 本批仅修客服管理队列；其余页没有继承通过 | 实施者：management-members、作者/详情/草稿、客服聊天轮询继续沿实际服务调用链复现；不能只数 pageRead |
| 源码 / MONEY-RECOVERY-01-B | 新增服务端本人已记录命令发现已验证；原生接入/跨设备端到端恢复仍未实现 | API/原生实施者：以只读列表接入原生恢复入口，不自动解锁或重发；缺失命令的权威失败事实及人工解除另续；人工解除策略另由运营/财务批准，不能以等待政策停掉只读工作 |
| 源码 / SEC-OBJECT-FIELD-ACTION | 195 认证入口不是全对象权限；本次新增 Page 测试不增加服务端对象覆盖分母 | 安全/API：沿当前 228 方法映射本人/他人/撤权/字段白名单/动作和并发，不相加测试数量 |
| 源码+负责人 / FORMAL-PROVIDER-FULFILLMENT | formalPaymentProtocol 的正式出站仍 fail-closed；合成 transport 只允许 test | API/支付负责人：核适用平台模式和商户绑定，继续隔离异常/退款/履约/对账测试；不改 paymentAvailable 绕过 Provider |
| 源码+负责人 / PRIVACY-EXECUTION | 125 表结构清单未成为完整主体联结/导出白名单；现有执行子集不代表正式全量执行 | 隐私实施者补主体联结；法务/业务批准保留/hold、核验、有效期及撤销；财务审计禁止硬删 |
| 负责人 / PLATFORM-OPS-GOVERNANCE | 实时 rulesets=[]、environments=[]、main protected=false；未配置保护 | 仓库管理员：确认独立审阅者，要求 PR、verify、最新基线、解决对话、禁止强推删除；绑定真实 staging/production 后再配部署审批，以测试 PR 实证 |
| 负责人 / IMMUTABLE-RELEASE-SCOPE | 发布 manifest 尚未批准；One-App/MAKE 已定，不重新选型 | Owner：固定 R0CORE/启用 R0GATED、exactSHA、包/配置/迁移、测试/平台/回滚证据并签字 |
| 负责人 / NFR-G0 | 本机测试不是真实 HTTPS/端到端 P95 | G0/QA：签字环境/地域/设备/网络/冷暖/样本/失败分母/30%余量及 RPO/RTO；500ms/2s 仍为目标 |

## 已实现的 D1 只读增量与保留边界

`GET /v1/me/commerce/recorded-commands/:kind` 支持 refund、settlement、credit、credit-cancel、cancel、cancel-verified。从既有领域表读取已认证本人保留的事实；Provider 关闭时可读，未新建资金账本或开放写入。响应仅 id、objectId、state、recordVersion、commandCreatedAt；不返回原 key、原载荷、金额、自由文本、payee/OpenID、确认包或任意内部 response_body。原生尚未调用此接口，本批不声称已经闭环跨设备恢复。

limit 默认 30、最大 50；可选 objectId（退款/订单取消为订单 ID，结算为申请 ID，权益类为转换 ID）；游标绑定环境/主体/member/种类/对象，SQL 每页再次核本人 active 与领域对象归属。时间保留 PostgreSQL 微秒，6 条分页夹具含同毫秒 3 条记录，未跳漏。取消只认可 principal+operation+business_key+当前订单版本/状态一致的原命令事实；两个 cancel 名称指向同一领域取消，不能推断 UI 来源。

`coverage=retained_recorded_facts_only`、`absenceIsFailure=false`：未记录/在途/已经不在保留范围不等于失败；记录存在也不等于到账。无版本的权益事实 recordVersion=null，不虚构业务版本。接口不恢复原载荷、重建原键、解除锁定或创建新操作；后续原生接入应只显示历史事实。服务端权威失败记录、跨设备完整旅程和人工解除仍开放。

人工解除仍需具名资格、独立复核人、证据、范围、不可变审计、保留/hold 与权威失败终态规则。本批没有代签、增加解除 API 或改保留政策。

## 当前包原生观察

最终包 `8f52c46a8bac5ba83021788de1b21ca24093f843f9b74b8610756b6e2e5fdcd6`，257 文件/37 路由，主包 1,453,097 bytes，总包 2,214,308 bytes；全局 WXSS 8,137/8,192 bytes。74 项逐页 WXML/WXSS 诊断成功，不含运行时/真机结论。

四 Tab 入口实际结果：首页游客 CTA 可见且没有自动跳走；记录、我的实际转到 account?intent=login；社区显示请求失败提示并展示本地精选降级，不能冒称接口成功。另观察客服游客拒绝态和合成只读卡片；后者只通过原生 setData 渲染，未登录或伪造客服权限，不能当真实服务端角色证据。合成展示后调用真实 load 清除夹具并回首页。

原始模拟器截图为 242×524（工具当前 62% 缩放，逻辑视口 390×844、基础库 3.15.2、字体 16），没有放大或重绘。宽度低于既有设计门 320px，故仅作有限观察，未塞进 current-source-acceptance 充当合格视觉证据。窄屏/系统大字/键盘/读屏/弱网/设备与全部角色状态仍未完成。没有完整原生“前图”，RED 是 Page 逻辑证据，不伪造原生前后对比。

本批无新增第三方依赖/素材；复用既有原生组件、pageRead、事务与 keysetPage 原则，保持现有资源许可。未安装 GSAP/React Native/Mobbin，也未声称完成外部案例研究。本批没有端到端性能采样，不复用历史 CI 数字作为新提速证据。

## 负责人最小证据（不需要秘密值）

平台管理员提供同日脱敏 AppID/主体/认证/类目/备案、request/upload/download 域名、隐私指引版本与状态、商户绑定及发货能力；运维提供 API/DB role/worker/桶或前缀/日志/队列/callback 的 staging 与 production 隔离表及受保护访问通道；Owner/财务/法务提供上述发布范围、真实资金验证范围、人工核对及隐私保留政策；QA 提供获授权 iOS/Android 设备与测试成员范围。

本轮微信公众平台既有页的只读访问被浏览器站点安全策略拦截，未发起用户权限弹窗；没有绕过。源码 AppID 和工具登录态不能替代平台证据。未上传体验版、提审、正式发布、部署未知云服务、调用真实资金、公开 UGC 或正式隐私删除接口；默认本机测试库误重置的影响单独记未知。

## 测试目标防误触

执行中发生默认测试库误重置，已单独记录影响与未知范围。testkit 现要求显式 TEST_DATABASE_URL，既不回退应用 DATABASE_URL，也不选默认地址；reset 前核实际库名与指定目标一致。新增 3 个失败反例已转绿；完整单元较本批前增加 2 项（原默认成功用例改为拒绝缺省）。CI 本来已显式指定目标，无门槛修改。此保护不能恢复已被重置的旧测试数据。

## 回滚

采用新 revert 撤回本批只读 API/契约、队列 TS/WXML 与对应源码清单绑定后，重新计算包并验证；无数据库/依赖迁移。回滚将恢复已知后台读取与旧会话点击风险，不作为默认处置。保留 PR7 恢复命令、本地未知操作资料和所有历史原生证据；本批不清缓存。
