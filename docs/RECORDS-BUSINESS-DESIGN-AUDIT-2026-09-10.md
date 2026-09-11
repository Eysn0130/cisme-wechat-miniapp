# 记录页业务、系统与界面审计

日期：2026-09-10  
对象：原生微信小程序 `pages/records/index`、`GET /v1/me/care` 及护理周期契约  
依据：整合 PRD V2.1 §5.4、§6.1 P23、§6.3.1、项目 `AGENTS.md`、冻结 Web 参照与微信开发者工具实拍  
结论：本轮已补齐 R0 可由真实数据支撑的跨周期档案、状态语义、记录详情与交互闭环；日历、趋势、取消态和分享草稿仍保持未开放，不以静态界面冒充能力。完整同状态视觉矩阵及 iOS/Android 真机验收仍为 `blocked`。

## 1. 产品裁决

PRD 是方向和目标契约，不是要求前端展示所有名词。采用以下裁决：

1. R0 的核心是可审计的 `care_cycle` 与 D1/D7/D14/D28 护理事实，不做每日签到式留存。
2. `PLANNED` 只表示护理服务已就绪，必须由用户在护理首页显式确认开始；记录页不重复主 CTA。
3. 已完成的四段步骤、护理后感受、完成时间、时区和协议版本必须可回看；旧记录缺字段时明确说明，不补造默认值。
4. 暂停只影响未来里程碑，已完成记录不可改写；暂停期间不展示看似确定的未来日期。
5. 终止保留档案，不自动表达退款、奖励或医疗结论。
6. 完成或终止后的下一步只提供真实可用的护理首页与只读商品目录，不添加没有护理分享契约的“分享周报”。
7. PRD P23 的日历、趋势、分享草稿只有在记录查询、趋势口径、编辑/许可和 UGC 门禁契约齐备后启用。§6.3.1 明确禁止为了页面齐全交付无数据源空壳，因此本轮不伪造。

## 2. 审计发现与处理

| 级别 | 发现 | 处理 | 当前状态 |
|---|---|---|---|
| P1 | `GET /v1/me/care` 只返回最近周期，复购后旧周期从记录页消失，与“历史真实”冲突 | 服务端按创建时间倒序读取本人全部周期，返回当前周期及 `history`；契约和 OpenAPI 同步 | fixed |
| P1 | 全周期档案若逐周期读取记录与步骤会形成 N+1 查询，历史越长响应越慢 | 本人周期、全部记录、全部分步事实分别批量读取并在内存分组，查询次数不随周期数线性增长 | fixed |
| P1 | 记录详情没有每条记录实际使用的协议版本 | 每条记录返回并展示 `protocolVersion`，旧数据回退到周期版本或“版本未记录” | fixed |
| P1 | 完成时间按设备本地时区显示，可能与周期冻结时区不一致 | 优先使用周期 `timezone` 格式化日期与时间，旧运行时才降级为设备本地格式 | fixed |
| P1 | 暂停态把尚未确定的未来节点展示为固定日期 | 改为“暂停中 / 恢复后安排”，只保留已完成事实 | fixed |
| P1 | planned、active、paused、terminated、completed 共用泛化标题与周期管理文案 | 各生命周期使用独立标题、说明、按钮和空记录语义 | fixed |
| P1 | 里程碑与周期管理是两个等权重卡片，档案列表层级弱且信息密度不稳 | 合并为一个紧凑周期总览，档案改为按周期分组的轻量账本行，详情使用底部 sheet | fixed |
| P1 | 旧记录缺少步骤或自评时容易被误解为完整记录 | 明示“历史记录，部分详细事实缺失”，详情分别解释缺失字段 | fixed |
| P1 | 详情弹层关闭即卸载、底部 Tab 仍可操作，造成退出动效截断及层级冲突 | 引入 mounted/visible/closing 生命周期，240ms 退出后再卸载；弹层期间隐藏 Tab，并对背景设置辅助功能隔离 | fixed |
| P1 | 长期复购会一次渲染全部周期，列表成本随档案持续增长 | 初始只渲染最近 3 个周期，使用真实“查看更早周期”动作每次追加 3 组，同时始终显示精确总数 | fixed |
| P1 | 自动鉴权被用户取消后，页面停留在同步中，既没有登录入口也无法恢复 | 把登录要求建模为独立页面状态；自动鉴权取消后停止 loading、清除私人数据并显示“重新登录”，显式操作通过 `resumeAuthentication('/pages/records/index')` 恢复来源 | fixed + unit-covered |
| P1 | 普通刷新失败会把已经确认过的档案清空，用户无法判断旧数据是否仍可信 | 首次加载失败显示错误态；已有权威快照的普通刷新失败则保留并标注上次同步时间；401/会员失效仍立即清除私人快照 | fixed + unit-covered |
| P1 | 页面可能出现与后端无关的分享动作 | 未加入虚假分享；完成/终止态仅开放真实只读目录入口 | fixed |
| P1 | PRD 包含 `CANCELLED`，当前数据库枚举、领域契约和退款事实链均未实现该状态 | 不把它伪装成 `TERMINATED`；需在交易 profile、全退事件和周期迁移契约确定后另行实现 | blocked |
| P1 | Web 参照是 active D7，当前原生账号只有无周期状态，无法做同 fixture 像素对照 | 两端均已实拍并明确标注状态不等价；原生 active/paused/completed 与长档案仍需当前源码 fixture 或真数据复拍 | blocked |
| P2 | 卡片圆角、标题、微文案和动作间距偏松，长列表滚动成本高 | 收敛为 16px 软卡、44px 最小命中、较高正文对比、统一 8/12/16px 视觉节奏，并保留减少动态效果 | fixed in source |
| P2 | Records WXSS 使用标签/伪类选择器，Stable 开发者工具产生组件样式兼容警告 | 全部替换为显式类选择器，热重编译后清空控制台复核为 0 error / 0 warning | fixed and retested |

本轮没有发现需要停发的新增 P0。发布级 Design QA 仍因完整路由矩阵、同状态对照和双端真机证据缺失而 blocked。

## 3. 业务状态覆盖

| 编号 | 状态/步骤 | 页面行为 | 健康度 |
|---:|---|---|---|
| 1 | 进入页面与 loading | 清空或保留权威快照；操作后刷新时不闪回伪空态 | healthy, unit-covered |
| 2 | 未登录/自动鉴权被取消/会话过期 | 显式进入登录要求态；停止同步动画、清空私人记录并提供“重新登录”，成功后回到 Records 来源 | healthy, unit-covered |
| 3 | GET 失败或离线 | 首次进入显示错误与重试；普通刷新保留带“上次同步”标签的权威快照；401/会员失效清空快照；旧权威动作在无法确认结果时保持锁定 | healthy, unit-covered |
| 4 | 无护理周期 | 明确“会员注册不等于开通护理服务”，只说明未来会保存的事实 | healthy, DevTools captured |
| 5 | planned | 显示待确认、四个节点均不伪造日期；引导回护理首页显式激活 | healthy, unit-covered |
| 6 | active | 显示完成数、今日到期节点、未来节点日期与暂停/终止动作 | healthy, unit/integration-covered; visual open |
| 7 | paused | 保留完成事实，未来节点显示恢复后安排；允许恢复或终止 | healthy, unit/integration-covered; visual open |
| 8 | terminated | 历史仍可回看，不再生成里程碑；不推导退款或积分 | healthy, source-covered; visual open |
| 9 | completed | 四个里程碑归档；可回护理首页或浏览只读商品目录 | healthy, integration-covered; visual open |
| 10 | 多护理周期 | 当前周期在前，历史周期按新到旧分组，记录总数跨周期汇总 | healthy, integration-covered |
| 11 | 完整记录详情 | 展示完成日期/时间、00 至 03 四段护理、自评、协议版本、非医疗提示 | healthy, unit-covered; visual open |
| 12 | 旧记录详情 | 保留里程碑与时间，并分别说明步骤、自评或版本缺失 | healthy, unit-covered |
| 13 | 暂停/恢复/终止确认 | 二次确认；取消不发请求；确认时带对象版本、原因和幂等键 | healthy, unit/integration-covered |
| 14 | mutation 进行中 | 锁页面动作与 Tab 切换，提示离页不会撤回已发送服务端处理 | healthy, unit-covered |
| 15 | mutation 结果不确定 | 先重新读取权威状态；读取也失败时不宣布成功并保持动作锁定 | healthy, unit-covered |
| 16 | 长档案/滚动到底 | 普通账本行按周期分组，首屏 3 组并可逐批查看更早周期；总数不截断、无“查看全部”假入口 | healthy, unit-covered; device evidence open |
| 17 | cancelled | 目标语义已识别，但当前无权威状态和全退事件来源 | blocked by domain/transaction contract |
| 18 | 日历/趋势/分享草稿 | 目标能力保留，当前无真实聚合/编辑/许可闭环 | intentionally deferred |

## 4. 数据与系统闭环

读取链路：

`GET /v1/me/care` → 校验本人 → 批量查询本人全部周期 → 批量查询全部里程碑与步骤事实 → 当前周期附带 `history` → 客户端按周期分组并渐进渲染 → 打开记录详情。

命令链路：

`pause / resume / terminate` → 本地二次确认 → `expectedVersion + reasonCode + idempotencyKey` → 服务端状态守卫与事务 → 重新读取权威快照 → 只有确认成功后显示成功文案。

关键不变量：

- 一个开放周期只能处于 planned、active 或 paused；复购新周期不复用旧周期。
- 里程碑唯一键仍为 `care_cycle_id + milestone`。
- D1/D7/D14/D28 由 `started_on + offset + schedule_offset_days` 与冻结时区推导。
- pause/resume/terminate 不删除 `care_record`。
- 记录详情的 `stepCodes` 与 `selfAssessment` 不由前端推断。
- 未知或旧记录缺失字段时失败关闭为“缺失”，不补造护理事实。

## 5. 视觉与交互裁决

本轮 Design Read 是“可信、克制的护理档案”：信息密度较高，但通过标题层级、轻分隔和留白保持安静感。只使用品牌紫作为主要强调色；总览为 16px 软圆角，周期动作使用轻量胶囊，记录列表不再每行套卡。详情 sheet 的 180–240ms 动效只表达层级变化，并在系统减少动态效果时关闭。

Web 参照提供了 hero、进度、周期管理与最近记录的结构锚点；原生实现保留这些结构关系，但没有复制其“分享护理周报”，也没有为了视觉一致把 active D7 演示数据写入生产客户端。

## 6. 证据与限制

| 文件 | 状态 | 用途 |
|---|---|---|
| `docs/evidence/visual/records-audit-2026-09-10/01-native-no-cycle-before.png` | 原生，无周期，修改前 | 定位旧空态与页面密度 |
| `docs/evidence/visual/records-audit-2026-09-10/02-web-reference-active.png` | Web，active D7 | 结构与视觉参照，不作为同状态验收 |
| `docs/evidence/visual/records-audit-2026-09-10/03-native-no-cycle-after.jpg` | 原生，无周期，历史修改后 | 历史包 `7a46ce3e…` 的空态实拍；Stable 2.02.2608070，页面路径正确，清空后 Console 0 error / 0 warning、Problems 0；不继承给当前源码 |
| `docs/evidence/visual/profile-settings-records-audit-2026-09-10/current/04-records-empty-after.png` | 原生，无周期，历史视觉复核 | 历史包 `2be680bf…` 的 Records 空态全窗口实拍；明确下一步、刷新入口和同步时间。Build 显示 analyzer success、Problems 0；不继承当前源码 |

当前证据只能确认原生空周期首屏、编译和结构；登录要求、刷新保留快照与鉴权失败清空由单测覆盖，但静态图不能替代现场中断恢复。它也不能证明 active、paused、terminated、completed、长记录、详情 sheet、Network 或真机状态。Web active 与原生 empty 不是同 fixture，不做“像素通过”结论。

## 7. 验证结果

- TypeScript 与原生小程序类型检查：passed。
- 全量单元测试：198 passed；包含 Records 鉴权取消、显式恢复、刷新保留快照与鉴权失败清空。
- 全量集成测试：68 passed，包含第二周期及历史归档、协议版本、收货地址独立链路。
- OpenAPI、迁移、表和事件交叉校验：passed。
- 原生包预算：146 files、16 routes、1,542,360 bytes、global WXSS 8,117 bytes，passed。
- 当前源码包 SHA-256：`40b500b8b69e958f657c73fb56c7dedfca6ee5896b1bd6f829fa0c5a3270b920`。
- 全产品 Design QA：honest blocked；本报告不把记录页局部验收扩大为发布验收。

## 8. 后续退出条件

1. 用同一真实或受控 fixture 捕获 Web 与原生的 active、paused、terminated、completed、长档案和完整记录详情。
2. 补 iOS 与 Android 真机的大字号、弱网、滚动、弹层、返回和安全区证据。
3. 交易 profile 能提供“未开始全退”权威事实后，补 `CANCELLED` 数据库迁移、领域事件、API 与页面状态。
4. 只有 care records/trends 与草稿编辑、许可、审核门禁形成真实闭环后，才启用 P23 日历、趋势和分享草稿。
