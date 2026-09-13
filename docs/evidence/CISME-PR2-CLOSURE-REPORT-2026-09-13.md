# CISME PR #2 收敛施工与隔离验收（2026-09-13）

状态：**Draft PR 工程候选；商业发布未授权。** 权威需求仍是 `docs/product/CISME-产品需求文档-PRD-V2.1-R4.md` 的 R4.2 §6.8 及相关章节。本文不把隔离渠道或模拟器证据写成微信真机、真实商户或生产验收。

## 接管与证据口径

| 对象 | 本轮核实 |
|---|---|
| 项目 | 长期根目录 `/Users/mini/CISME`；本轮工作树 `/Users/mini/.codex/worktrees/f745/CISME`，没有新建主项目 |
| Git | 接管 `57e577b651c9dcf215986d398371d92086ed5977`；分支 `codex/commercial-closure-20260912`，stacked Draft [PR #2](https://github.com/Eysn0130/cisme-wechat-miniapp/pull/2) 的 base 是 `codex/u0-u1-review`（PR #1），未改 main/历史 |
| 当前小程序源码包 | 37 条原生路由、`ae5d67bbc1bbbaad5a7cd82e46a0b17ae646f818636d8d8baa0473245492f3a7`；这是包源码哈希，区别于 Git commit 与截图 SHA |
| 隔离 API | `127.0.0.1:18080`、专用 `cisme_closure_test_f745`、合成账号；重置前证明是本机 `cisme_*test*` 库。前向迁移至 `202609120021`，只运行在本地测试库 |
| 补充业务对话 | `https://chatgpt.com/s/t_6aa57eccac2c8191bcacba42e67c6038` 原文未取得，状态 `EXTERNAL_INPUT_MISSING`；未猜测其增量需求 |

## R01–R12 结果

| ID | 结论与可复核入口 | 证据边界 |
|---|---|---|
| R01 私有修订图片 | 修复审核候选、图片预览签发及签名 URL 读取使用同一可审核修订条件；保存但未提交的新图三条路径均拒绝。`formalUgc.ts`、`formal-ugc-editor.test.ts` | 隔离访问测试通过；真实对象存储/CDN 权限未联调 |
| R02 敏感页面旧账号残留 | 审核、成员详情及敏感操作统一按 session、页面代次、对象与版本守卫；权限失败清空旧私有视图。`community-review`、`management-member`、`sensitive-action-intents.test.ts` | 源码/单测；相册、后台恢复、跨设备需真机 |
| R03 审核终态 | 退回/公开后进入结果状态，不把候选 404 当操作失败；队列刷新与可再次操作按钮分离。`community-review`、`community-review-lifecycle.test.ts` | 未用正式微信人员角色原生复现全部终态 |
| R04 截断分页 | 成员、推荐、本人/归因订单、内容、费率待办、评论等贯通 cursor/总数；31/51/101 边界测试。`commercial-pagination.test.ts`、`formal-ugc-editor.test.ts` | 合成数据量，未完成线上规模性能基线 |
| R05 会员经营操作 | 四页签区分本人购买和推荐归因，资格/费率来源/可用金额按权限展示；对象行可进详情，默认费率与个别费率有表单和复核。`commercialMembership.ts`、`management-members`、`management-member` | 经营规则尚未正式批准，生产写入继续关闭 |
| R06 时间和费率 | 资格/生效判断使用数据库时间；续期不缩短既有有效期；费率提议稳定幂等、过期计划不能伪称已生效。`commercial-membership.test.ts` | 具体会员期限和费率生效政策仍待 Owner/财务签定 |
| R07 创作恢复 | 本地草稿按账户/帖子/版本暂存且不复制 bearer；支持独立图预览、上传失败恢复、退回理由、仅本人草稿删除。7 日清理由启动/前台/编辑触发，退出与换会话清除。`ugc-local-backup.ts`、`community-compose` | 本地系统时间与异常断电保留仍需设备测试；正式告知待法务 |
| R08 社区治理 | 回复/待审评论/收藏回看/屏蔽、举报决定、下架与申诉有 API 和原生入口；审核最近一次评论安全结果，举报记录所见公开版本，冲突审核人不能读取或裁决本人目标。`formalUgc.ts`、迁移 013/014/021、`formal-ugc-editor.test.ts` | 加密回调、昵称检测和真账号角色演练未完成，公开 gate 关闭 |
| R09 字号与命中 | 修正创作列表标题选择器覆盖；原生量测成员详情 Tab 39→45 逻辑 px、成员筛选 37→45 px，创作“添加图片”45 px。`management-member/index.wxss`、`management-members/index.wxss` | 只测列举控件；全屏控件、对比度、键盘未取得完整实测 |
| R10 契约 | 实际注册 213 条 `/v1` 方法与 OpenAPI 双向匹配；32 typed events 与目录一致，空测试库应用最终 55 迁移后核对表/约束，回滚生命周期和漏登记负例可复现。`validate-contracts.ts`、`contract-inventory.test.ts`、`migration-lifecycle.test.ts` | 不代替生产迁移计划或真实微信契约 |
| R11 Inbox 可靠性 | 支付/退款 Inbox 按到期、租约、退避、隔离和授权审计重驱；原通知/原单号复用，前 20 条失败不饿死后项。`moneyInboxRetry.ts`、`verifiedPaymentInbox.ts`、`verifiedRefundInbox.ts` | 只在专用库/HTTP fixture 验证并发和重启恢复 |
| R12 交易链 | 隔离 JSAPI 预支付、原单查单、验签回调、原子取消、退款请求/复核/同号补偿、履约核验、佣金释放、结算预占/原号查询/成功入账、交易账单下载与双向缺行检查可运行。最后独立资金审阅发现的取消拆事务、受益人自审、预占后退款、空账单漏报均有针对性修复/测试。`payment-http-simulation.test.ts` | `APP_ENV=test` 且 loopback 签名渠道；真实支付、退款、转账、物流与平台账单均未执行 |

## 用户、管理、资金状态与权限

普通登录用户不自动取得商业会员资格，可独立写文字、纯图或图文故事；社区创建不再依赖邀请。商业会员的稳定推荐码只建立一级直接关系，被推荐人必须显式确认。订单保留受益人、规则和费率快照；合成待付/取消不产生现金佣金。已验支付才计提，已验退款追加冲回；履约证明及异人复核后才释放，在途结算先预占，商家转账原单签名查询 `SUCCESS` 才记已结算。积分继续独立记账。

管理最小资料读、资格管理、费率提议、独立批准、佣金读、订单读、退款批准、履约管理、结算批准和资金核对是不同 capability。没有相关能力时界面不显示假 `0` 代替无权读取。申请人、受益人和复核人的冲突边界在服务端执行；客户端确认框不能提升权限。正式额度、资格、售后窗口、税务和商家转账场景仍由 [发布决策表](../product/CISME-PR2-RELEASE-DECISIONS-20260913.md) 单独批准。

## 当前原生证据及局限

原始 PNG、逐文件 SHA-256、37 条默认导航和 11 条带合成参数的路由捕获清单在 `docs/evidence/commercial-closure-ae5d67bbc1bb-20260913/`。捕获使用**此工作树独立微信开发者工具模拟器**、合成登录与专用 loopback API。默认导航中，账户页会按已登录状态跳首页；缺 `id` 的任务/订单/管理详情显示守卫；公开 UGC 与真实资金关闭时显示相应不可用状态。带参数的产品、结算前订单、护理任务、投稿、审核进度、管理订单、客服会话及品牌帖有可读原始帧。成员详情及“本人购买”页签、创作编辑器另有真实模拟器 tap 截图；相关按钮矩形以开发者工具自动化读取。

这构成 `CODE_VERIFIED` 和**部分** `DEVTOOLS_VERIFIED`，不是 37 路由 × 角色/状态/首中末屏完整矩阵。`DEVICE_VERIFIED=false`、`PLATFORM_VERIFIED=false`、`RELEASE_AUTHORIZED=false`。旧 `f830…`/27 页图不被重标为新包。`current-source-acceptance.json` 对 `ae5d…` 仍应保持 `blocked`，直到 iOS/Android、键盘/滚动/弱网/手势、所有适用状态及当前哈希逐页验收完成。

本轮文案裁决集中于任务入口、权限/资金诚实状态、无效订单 ID 的“请从订单列表选择一笔订单”、资格和计佣来源；未把此前 2488 条静态候选标为全部已审。动效维持微信原生即时反馈与状态连续性，没有增加动画依赖；连续帧、减少动态效果与系统输入法尚未验收。独立审阅由两名只读审阅者分别检查资金/权限和 UGC/隐私，问题已回修；模拟器视觉是施工者本人检查，**不称独立视觉评审**。

## 验证与剩余边界

本轮最后完整检查：`npm run test` **320/320**、`npm run test:integration` **142/142**，`typecheck`、`build`、`lint:contracts`、37 路由 package gate、`git diff --check` 通过。生产依赖 `npm audit --omit=dev` 为 0；完整开发依赖仍需单独审计既有 `miniprogram-simulate` 链。`design:qa:status` 结构有效但 `releaseReady=false`：设备与完整路由矩阵缺失。当前 PR 的 CI 结果应以推送后新 run 为准；推送前展示的成功 run 是固定基线，candidate-design-qa 与 wechat-credentialed-preview 当时跳过。

仍需明确阻断的不是“小程序再加几页”：真实 UGC 的加密回调、昵称检测、内容审核分工/申诉策略和实账号测试；真实商户证书/合法域名/转账场景、退款与履约政策、资金流水及商家转账账单四方核对、异常结案；生产迁移/回滚演练；获授权的 iOS/Android 全状态体验。当前明文内容安全回调仅是隔离协议形态，其签名未覆盖消息体且并发评论扫描仍需一次在途冲突控制，故不得打开生产公开 gate。经同意的首次受控体验与正式公开/资金启用应分别做授权和验收。

Owner 最少需提供：已确认商业资格/费率/归属/售后/结算政策的版本与负责人；平台及商户可用的测试能力、合法回调域名和凭据的安全交付渠道；内容治理人员/加密回调配置；获授权设备操作者和测试范围。无需在聊天或仓库粘贴密钥。本轮没有生产迁移、真实资金动作、公开 UGC 或正式发布。
