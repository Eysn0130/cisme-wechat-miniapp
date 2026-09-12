# CISME U0 完成与 U1 代表页推进验收

日期：2026-09-12（Asia/Shanghai）

审阅基线：Git `8e843a6b0a28628544202889217deda255e86c81`；Mini source `7f5fad5fe84c122a28a9c54234690515a64c09cf86a666daced4ba635672957d`

本轮候选：Mini source SHA-256 `949fcf9da6d4777d17eab31ba42b46394d9268fed3c30bbab09fc5533759ad99`

唯一产品基线：`docs/product/CISME-产品需求文档-PRD-V2.1-R4.md`（内容版本 V2.1-R4.1；SHA-256 `849123637638730129e899f9877f8c2f052afec8928077143fa6dd22a890e0f7`）

本轮是源码修复、正式回归和原生复验，不是旧候选重打包。U0 的 C01–C08 已在本地正确性边界关闭；U1 的公共布局根因与代表页已通过当前源码 DevTools 复验。整体产品仍不可发布：严格 Design QA 因 iOS/Android、全状态矩阵和开放 P0/P1 正确返回非零，staging、HTTPS、真实身份、支付也分别保持未通过。

## 1. 审阅问题逐项结果

| ID | 结果 | 修改与反证 | 未冒充的边界 |
|---|---|---|---|
| C01 客服游标缺口 | **已修 / 正式回归通过** | 用户端与管理端复用消息状态器；服务器同步水位、最大已见序号、可见已读和本地发送状态分离。覆盖 100→101→102、迟到 ACK、逆序/重复、50 条边界、保留清理后服务器水位 | staging 长时线程与真实保留任务仍待测 |
| C02 结算生命周期/敏感清理 | **已修 / 正式回归与关键帧通过** | 引入 visible/session/request epoch；换号或拒绝登录先清地址、报价、金额和重试键；隐藏后的旧回包不能回填。后台返回按服务器时间重算 | 真实微信身份和设备后台策略待测 |
| C03 过期恢复/错误丢失 | **已修 / 正式回归与关键帧通过** | 报价失效与完整会话清理拆开；过期按钮变为“重新确认价格”；真实本地 API 重报价保留已选地址；失败原因不被刷新抹掉；重复提交单飞 | staging 真实时钟、变价与弱网待测 |
| C04 取消订单幂等目标 | **已修 / 真实隔离 PostgreSQL 通过** | actor/operation/order target/request 纳入幂等范围；同订单重放返回原结果，不同订单复用 key 返回 409；库存只释放一次 | 支付后取消/退款不在当前 pending-payment 切片 |
| C05 订单列表 N+1/地址解密 | **已修 / 查询预算通过** | 列表摘要 DTO 与批量聚合替代逐单详情；member/management 在 limit 20 和 50 均为固定 2 条业务 SQL；列表 0 次地址读取/解密 | staging 数据分布和公网时延未测 |
| C06 商品草稿覆盖 | **已修 / 正式回归与关键帧通过** | 服务器快照与本地草稿分离；onShow、失败保存、库存结果不抹其他字段；远端 revision 显示冲突；保留本地可 rebase；撤权/换号清私密草稿 | 真实媒体上传与多 SKU 是 U3，不伪装为已完成 |
| C07 护理事实文案 | **正确性已修 / 自动回归通过** | 以周期时区和事实区分非节点下一里程碑、今日完成、待完成、逾期、暂停、结束；覆盖跨午夜 | 各护理状态原生逐格截图属于 U2，未写成已完成 |
| C08 已读/滚动/轮询 | **已修 / 正式回归与关键帧通过** | visible 与 mounted 分离；隐藏不提交新已读；晚到 onShow/poll 丢弃；阅读历史不强滚；新消息提示跨空轮询保留；最多一个 poll，5/10/20/30 秒退避 | 真实长历史、弱网和设备可访问性待测 |
| AI 草稿补查 | **已修 / 回归通过** | AI suggestion 返回前核对 draft/request/session ownership，不能覆盖管理员期间输入的新草稿，也不能跨任务回填 | Provider/费用/隐私未批准，真实 AI 继续 OFFLINE |
| V01 气泡/队列裁切 | **当前模拟器通过 / 设备待验** | 修正 native scroll 宽度、padding 与 border-box 组合；当前用户/队列/管理聊天帧未见右边裁切 | 紧凑宽度、字体放大、iOS/Android 待验 |
| V02 系统栏对比 | **当前模拟器通过 / 设备待验** | 使用平台支持的 `navigationBarTextStyle: black`；没有误用 `backgroundTextStyle` 或自绘状态栏 | iOS/Android 系统栏待验 |
| V03 固定底栏/多行输入 | **当前模拟器几何通过 / 物理键盘待验** | composer 实测高度驱动 thread 与新消息按钮 bottom；三行时 390×144 px，thread bottom 144 px，notice bottom 156 px | 真实键盘、安全区、管理端三行和字体放大待验 |

## 2. PRD 决策一致性修订

当前文件名保持稳定，内容版本更新为 V2.1-R4.1，并新增有限的 Owner 决策差异表。修订结果：

- 固化 One-App：微信小程序移动管理优先，旧 Web 仅应急，不再把第二套管理网站当目标。
- 固化自营 `MAKE`，引用 Commerce ADR；删除当前实施中的 BUY 双轨歧义。
- 购物车/收藏和社区保留为已确认后续 release group，以 U2–U5 工程切片表达，不再沿用会无限推迟需求的旧月份表。
- 当前 AI 客服与未来 AI 经营工作台拆开；先保证人工客服和有限客服建议，不为此建设全套经营 Agent。
- “创始人查看”继续受字段权限、最小必要和审计约束。
- 明确持久化 server quote、幂等 `request_hash` 与未来支付签名是三个不同协议，不机械新增客户端签名。
- 首次受控体验包门禁去循环；公共仓库真实 CI 可作为 CI 证据，同时保留 secret 隔离和最小权限。
- 文档状态拆成基线完整性、决策对齐、业务审批；文件哈希不再冒充法务/财务/资质签字。

仍待业务责任人决定或提供证据：运费、退款/退货/发票、积分价值与失效、商品与类目资质、企业正式 terms/privacy 和保存期限、对外许可范围、支付商户关系与资金测试权限、AI Provider/处理者/地域/保留/预算/知识版本。One-App、自营 MAKE、新企业 AppID 和“微信认证/支付办理中”不再重复询问。

## 3. 修改文件、API/schema 与迁移

| 范围 | 文件 | 结果 |
|---|---|---|
| Mini 公共/页面 | `apps/miniprogram/app.json`、`app.wxss`；home、product、checkout、orders、support、management-orders、management-product、management-support、management-support-chat 的 TS/WXML/WXSS | 生命周期、文案、列表摘要、布局、滚动、草稿与权限处理 |
| Mini 状态器 | 新增 `services/support-thread-state.ts`、`checkout-state.ts`、`product-draft-state.ts`、`care-home-state.ts`；更新 `services/orders.ts` | 将关键不变量提取为可执行纯状态逻辑，页面复用 |
| API/契约 | `services/api/src/commerceOrders.ts`、`packages/contracts/src/index.ts`、`openapi/openapi.yaml` | 取消目标绑定；member/management 列表摘要固定查询；列表 `address: null`，详情才返回授权地址 |
| 回归 | 新增 5 个 U0 单元测试文件；扩展 commerce integration、native boundary、flow safety 和 role-aware support 测试 | 覆盖状态器、Page 生命周期、真实 DB 幂等/查询预算和用户文案 |
| 产品/合规 | 唯一 PRD、产品索引/历史 manifest/原型范围引用、Mini 个人数据清单 | 决策对齐、哈希更新、去除未使用观察器声明 |
| 证据 | 当前源码 acceptance manifest、本报告、当前视觉包、SBOM/license report | 源码—包—原生图—回归绑定 |

API path **没有新增或删除**；现有 `POST /v1/me/commerce/quotes`、`POST/GET /v1/me/orders`、`POST /v1/me/orders/{orderId}/cancel`、`GET /v1/management/commerce/orders` 保持。行为/响应契约变化仅是：列表显式返回不含地址事实的 summary（`address: null`）；跨订单复用取消幂等键明确 409。

数据库 schema **没有变化**，仍为 34 migrations / 71 tables；本轮 **不需要数据迁移**。

## 4. 正式回归、CI 与源码身份

| Gate | 结果 |
|---|---|
| TypeScript typecheck（server + Mini） | PASS |
| Unit | PASS：41 files / 285 tests |
| Integration / isolated PostgreSQL | PASS：21 files / 102 tests |
| Contract lint | PASS：34 migrations / 71 tables / 75 paths / 27 events |
| Build | PASS：API、Worker、Admin |
| Mini package | PASS：203 files / 27 routes / 1,747,034 B total / 1,356,517 B main / 8,137 B app.wxss |
| Production dependency audit | PASS：0 vulnerabilities |
| Full dev graph audit | KNOWN：4 high / 0 critical，均来自既有 `miniprogram-simulate` 的旧 dev-only `less/postcss/image-size` 链；不进入 runtime；`--force` 会破坏性降级，不执行 |
| SBOM/license dependency report | PASS：CycloneDX regenerated；624 dependency rows；0 unknown |
| Design QA structure | PASS；manifest 精确绑定 `949fcf9d…` |
| Strict Design QA release gate | EXPECTED FAIL：27 路由完整 state matrix、iOS、Android 和开放 P0/P1 未闭合 |

Review branch：`codex/u0-u1-review`。实现与证据提交：`594490c6fcf2c072f4918ebdea350cb47d49092f`。PR：[GitHub #1](https://github.com/Eysn0130/cisme-wechat-miniapp/pull/1)。该提交的 [push CI 34635302492](https://github.com/Eysn0130/cisme-wechat-miniapp/actions/runs/34635302492) 与 [pull-request CI 34635329365](https://github.com/Eysn0130/cisme-wechat-miniapp/actions/runs/34635329365) 均 PASS；两次都执行 diff hygiene、经校验 Gitleaks、dependency audit、typecheck、Mini package、Design QA structure、285 unit、102 integration、build、contracts、SBOM 和 license report。报告元数据后续提交不改变 Mini source SHA；是否可合并仍以 PR 当前 head 的 required checks 和人工审阅为准。

## 5. 27 页前后图与六组关键交互

视觉包：`docs/evidence/visual/review-u0-u1-949fcf9d-20260912T0220Z/`

- Before：27/27 原始 482×1044 PNG，逐字节复制自 Owner 提供的审阅包，仍绑定 `8e843a6` / `7f5fad5f…`。
- After：27/27 原始 484×1048 微信开发者工具模拟器 PNG，绑定当前 `949fcf9d…`；每页在截图前核对当前 route、`loading=false`、空 page error；过滤 compile/console/network 命中均为 0。
- 对照索引：`contact-sheets/before-after-key-routes.png`；全量 current 索引：`healthy-routes.png`。联系表只导航，不替代原图。
- 关键帧：6 组 / 25 帧，覆盖消息失败重试、阅读历史/新消息、报价返回/过期/重报价、商品草稿返回/冲突、三行 composer、权限撤销/私密草稿清理。
- 明确缺失：0 段视频；0 次 iOS；0 次 Android。模拟器未证明物理键盘、设备安全区、字体放大、弱 4G 或帧耗时。

精确步骤、注入条件、预期/实际、帧路径与边界见 `interaction-evidence.json`；27 默认态和关键子状态清单见 `route-state-inventory.csv`。

## 6. 性能变化

| 项目 | 基线 | 当前 | 结论 |
|---|---:|---:|---|
| 订单列表业务 SQL | `1 + 2N`；20 单 41、50 单 101；并逐单读地址 | limit 20/50 均为 2；地址读取/解密 0 | 真实隔离 PostgreSQL 固定上界通过 |
| 21 条消息的空 poll `setData` | 1 次 / 5,966 UTF-8 B | 1 次 / 333 B；messages 引用保持 | 字节下降 94.42% |
| 健康可见 poll | 12/min | 12/min | 保留 5 秒需求 |
| 持续失败 poll | 12/min | 30 秒上限时 2/min | 5/10/20/30 秒有界退避 |
| 隐藏页 poll | 存在竞态 | 0/min；晚到结果丢弃 | 生命周期回归通过 |
| 三行 composer | 固定高度存在覆盖风险 | 390×144 px；依赖 bottom 同步 | 当前模拟器几何通过 |

1,920 ms（旧）和 2,311 ms（当前）的命令往返包含 DevTools automation/CLI，**不是 API latency**，不作快慢比较。staging/public HTTPS、pool wait、4G 核心内容 P95、冷/热启动、滚动长帧和真机 API 时延均为 `UNVERIFIED`。

## 7. 外部工作线分别状态

| 工作线 | 当前状态 | 已有证据 | 解除条件 |
|---|---|---|---|
| Staging runtime/schema | **BLOCKED** | 本地 cisme_test schema 34 全回归；没有当前远端 ledger、服务或 Outbox 访问 | 一次性受限 staging 通道；先只读核对实例/数据库/ledger，再用可销毁 rehearsal 库与不可变候选 |
| Public HTTPS/DNS+SNI | **BLOCKED** | 当前本机解析经过 198.18/15 synthetic resolver；对两个 HTTPS 主机的握手均 `SSL_ERROR_SYSCALL`，不能由此宣称真实公网 DNS；既有外部证据同样未形成正常 SNI PASS | 从正常公网 DNS+SNI 修 vhost/listener/cert 链并外测；不得关闭证书验证 |
| 新企业身份 / `wx.login` | **IN PROGRESS EXTERNAL** | Owner 已确认新 AppID/企业主体；本地仅用可见 Account UI 的 synthetic dev identity，无 token 注入 | 平台域名证据 + 真实 `wx.login → code2Session` + namespace/session 清理证据 |
| 微信支付 | **IN PROGRESS EXTERNAL / RUNTIME OFF** | pending-payment seam 存在；没有 `requestPayment`、provider paid route 或伪成功 UI | 商户/AppID 绑定、APIv3 密钥系统、回调/查单/对账和单独资金测试授权 |
| iOS | **BLOCKED OWNER-ASSISTED** | 0 次当前源码设备会话 | 授权 synthetic 体验账号，记录设备/OS/微信版本并走安全区、字体、键盘、弱网、返回与权限拒绝 |
| Android | **BLOCKED OWNER-ASSISTED** | 0 次当前源码设备会话 | 与 iOS 同等矩阵，不能互相替代 |

## 8. 下一最小切片与唯一 Owner 行动表

下一最小工程切片是 **U2：27 页一致性与必要子状态**。优先把当前清单中尚未原生覆盖的护理事实、地址编辑/冲突、SKU/sold-out、订单空/错/筛选、客服管理端长历史、多行键盘、危险确认和权限失效逐格补齐，并在 375/393/440 宽度复测；同时获取 iOS/Android 真机和 staging/public HTTPS 证据。U2 不扩成支付或正式发布。其后进入 U3 的真实商品媒体、多 SKU、收藏与认证购物车闭环。

下表是本次交付唯一、去重的 Owner 待办入口，取代把同一账号/通道/设备请求散落重复提出的做法。Secret、私钥、数据库密码、完整身份标识、证件、银行资料和真实聊天只在官方平台或受控运维环境处理，不贴回线程。

| ID | Owner 一次动作 | 最小非敏感输入/权限 | 完成证据 | 当前工程如何继续 | 撤销/停止边界 |
|---|---|---|---|---|---|
| O1 Staging + HTTPS | 在腾讯云确认准确 staging 实例/域名映射，并提供一次性最小 TAT/SSH 通道；允许只读检查后在专用可销毁 rehearsal 库操作 | 目标实例 marker、普通部署用户、核验过的 host fingerprint、仅限单实例/固定命令的短时权限；不提供数据库 URL | 实际 ledger、服务/端口、API/Worker/Outbox、正常 DNS+SNI 握手与撤权记录 | 本地 U2/U3 不等待；远端只在映射正确后推进 | 映射/哈希不符立即停；删除临时 key、revoke STS；不碰 production |
| O2 微信账号 + 身份域名 | 认证完成后通知；在平台核对基本信息、成员、类目/备案、request 域名并安排一次真实登录 | 脱敏状态页、人数/角色、域名栏、时间/结果码/内部 trace；不回传 secret、code、OpenID、session_key | 平台证据 + `wx.login→code2Session` + session 清理 | synthetic 本地测试继续；不重复申请认证 | 删除测试 session/identity；配置错误时恢复审核前域名 |
| O3 设备验收 | 安排一台 iOS、一台 Android 和最小 synthetic 验收成员/开发者资格；如必须生成体验版，另确认该具体上传动作 | 当前 source SHA、设备/OS/微信版本、synthetic role；无真实用户数据 | 两端录屏/关键帧、route+state matrix、键盘/安全区/字体/弱网/权限记录 | DevTools 子状态继续补；不把模拟器当真机 | 移除体验成员、停止调试；不正式发布 |
| O4 商业/法务政策包 | 一次批准运费、退退货/退款/发票、积分价值/失效、客服和审计保存期、商品/类目资质、企业 terms/privacy | 签字版本/政策 ID/生效日/证据引用；证件原件不上公开仓库 | PRD TBD 关闭记录和对应服务端配置/发布门禁 | 未决定项继续 fail-closed，不阻塞无关 U2 | 失效即下架或 gate blocked；按正式更正流程更新 |
| O5 项目许可范围 | 对公开仓库作一次明确版权/许可决定：保持未授予开源许可并加保留权利说明，或选定代码许可；同时单独定义品牌、产品图、资质、用户内容和第三方材料是否排除 | 法定版权主体、覆盖目录、许可文本/版本、品牌与内容资产排除范围 | 根 LICENSE/NOTICE/资产政策与 Owner 决策记录一致 | 当前功能开发不停；不擅自给全仓 MIT/Apache | 只对后续版本变更；不得追溯改写第三方许可或用户权利 |
| O6 支付（进入 U4 时） | 微信支付 onboarding 完成后通知，并另批一笔 sandbox/小额资金测试和参与人员 | 脱敏商户/AppID/JSAPI/回调状态；密钥只进密钥系统 | APIv3 验签解密、通知去重、查单/关单/对账与回滚记录 | 先做 provider adapter 和状态机；runtime 继续 OFF | 关闭 capability/开关、撤回调/credential；订单账本不删除 |
| O7 AI（另行批准时） | 选择 Provider、处理者/DPA、地域/保留、预算、批准知识版本和低风险范围 | 非敏感审批编号、知识 SHA、预算上限、synthetic red-team 摘要 | 仅建议/答疑的 staging 证据、明确标识、人工接管和关停测试 | 当前人工客服继续；AI 保持 OFFLINE | provider switch off、撤 credential/purpose；迟到回复不得发送 |

本轮未执行 production、正式小程序上传、真实付款、真实用户数据处理、merge、tag 或 release。
