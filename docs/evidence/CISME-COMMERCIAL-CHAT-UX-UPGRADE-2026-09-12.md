# CISME Commercial Chat UX Upgrade 交付报告

日期：2026-09-12（Asia/Shanghai）
范围：原生微信小程序 `pages/support/index`、`pages/management-support/index`、`pages/management-support-chat/index` 及对应 API/Worker/数据库契约
基线：PRD V2.1-R4.1 §2.1、§3.3、§4、§14–§15；补充验收 ID `CHAT-COR-01` 至 `CHAT-ADM-01`
源码证据哈希：`005f03d43a58b106515df69c28fd30413af41afb3a6d760c5e4bb2ea6156cb52`

## 结论

Commercial Chat 的本地实现、契约、隔离 API 集成、微信开发者工具呈现和性能基准已完成。消费者可以区分本人、AI、人工与系统事件；绿点只来自有效真人心跳；发送确认与已读分离；typing 有节流和 TTL；图片与本人订单有服务端所有权校验；管理端与消费者端共享同一消息状态模型。

本轮不是发布验收。物理 iOS/Android、真实软键盘、正式 HTTPS/对象存储、体验版与真实值班仍无证据，因此全局 `design:qa:gate` 正确保持失败，未上传、未发布、未付款、未接触真实用户。

## 主要变化

### 正确性与状态权威

- 同步水位只由消息列表响应推进；本人发送 ACK 只合并消息，不会跳过先到达但尚未拉取的远端 sequence。`100 → 未见 101 → ACK 102 → sync` 回归在两端覆盖。
- `clientMessageId` 保持原键重试；服务端按正文、图片与订单引用识别相同重放和冲突重放。
- `server_accepted` 只显示“已发送”；只有对侧单调 read cursor 覆盖该 sequence 才显示“已读”，不虚构 delivered/read。
- 新的 `support_presence` 是独立短期事实：在线 TTL 10 秒，typing TTL 9 秒，前端最多约 3 秒发送一次 heartbeat。发送、清空、隐藏、卸载、失去 assignment 与 TTL 到期都会停止 typing。
- 活跃轮询约 2 秒、空闲约 5 秒、页面隐藏为 0；single-flight、防旧 session 回写、失败退避和返回前台立即同步均保留。

### 原生会话体验

- Header 支持 AI、等待人工、人工已分配但在线未知、真人在线和 resolved 五种文字+颜色状态；运营别名与管理员微信资料分离，右侧不侵占微信胶囊。
- 本人消息不再重复“你”或头像；AI/人工使用不同头像和气泡；system event 居中；五分钟窗口内按 identity 分组，稀疏显示服务器时间。
- 阅读历史时不强制滚到底部，显示精确“↓ N 条新消息”；历史前插保留旧首项 anchor。
- Composer 使用自然高度布局、1–5 行 textarea、焦点边界、44px 目标、safe-area padding；发送、附件上传或页面中断失败时尽量保留正文、图片和原 idempotency key。
- `+` 打开原生风格 Bottom Sheet，仅提供图片、拍照、选择订单和取消；没有引入 TDesign/WeUI 依赖，也没有把页面改成 Web 实现。

### 附件、订单与管理端

- 图片链路为隐私授权 → `wx.chooseMedia` → 本地预览 → JPG/PNG/WEBP 与 5MiB 校验 → 适用时压缩 → 服务端授权对象键 → 上传进度 → magic bytes/元数据校验 → 消息不可变绑定。
- 服务端最多接受 3 张图片；当前原生 composer 一次选择/预览 1 张。替换未发送图片会删除旧草稿对象；失败可独立重传/移除；离页会 abort 上传并留下可重试草稿；24 小时孤儿对象与会话清理进入 durable cleanup queue。
- 订单选择只读取本人订单；消息保存 `linked_order_id` 与最小不可变 snapshot。服务端再次验证 member ownership；管理端只能经 `commerce.order.read` 进入正式订单详情。
- 管理端支持接管竞争、真人/会员 presence 与 typing、read cursor、历史 anchor、发送失败保留、私有图片预览、最小会员上下文、订单跳转、resolved。AI 建议仍是管理员草稿，不能自动发送；真人接管后迟到 AI 结果受 CAS/ownership 阻断。

## Before / After

| 维度 | Before | After | 变更理由 |
| --- | --- | --- | --- |
| 原生帧 | [`before support`](visual/review-u0-u1-949fcf9d-20260912T0220Z/screenshots/raw/pages__support__index.png) | [`after state sheet`](support-commercial-chat-2026-09-12/support-state-contact-sheet.png) | 从单一 success frame 扩展为消费者/管理端 21 个重要状态 |
| Header | `人工处理中`，assignment 容易被理解为在线 | AI/等待/中性分配/真实在线/resolved 五态 | 在线承诺必须来自 heartbeat 权威 |
| 消息 | 重复“你”、大块同色卡片、身份与时间弱 | identity grouping、AI/人工头像、system event、稀疏服务器时间 | 一眼识别“和谁说话”并降低视觉噪音 |
| 发送事实 | 无成熟 pending/failed/read 呈现 | 正在发送、已发送、已读、发送失败·重试 | 服务端接受与人工阅读是不同事实 |
| 输入区 | `+` 实际 disabled，层级弱 | 自然高度 composer、focus、Bottom Sheet、失败保留 | 高频主操作可用且中断可恢复 |
| 商业连接 | 无附件/订单入口 | 私有图片与本人订单卡片 | 把商城事实安全带入客服，不让用户重复输入订单号 |
| 滚动 | 新消息可能拉走历史阅读位置 | 精确新消息 chip、显式回到底部、历史 anchor | 尊重用户当前阅读上下文 |
| 管理端 | 以基础操作为主 | 与消费者对称的消息、presence、typing、附件、订单与上下文 | 避免只精修消费者端、运营仍像调试页 |

## 最终状态矩阵

| 项目 | 状态 | 证据与限定 |
| --- | --- | --- |
| Support correctness | **PASS** | 共享 cursor 状态机、幂等、分页、换号/撤权/隐藏页回归；295 单测与 108 集成全绿 |
| Support UX | **PASS** | 微信开发者工具 21 个确定性原生状态 + 2 个本地 API/大字体补充状态；真实手机键盘与真机触感不在此 PASS 范围 |
| Typing | **PASS** | 双向 heartbeat、3 秒节流、9 秒 TTL、发送/隐藏/失去 assignment 停止；TTL/生命周期/API 集成与原生呈现通过 |
| Presence | **PASS** | 10 秒真人 lease；assignment-only 保持中性，非 assigned reader 不能熄灭他人状态；本地 API 中性态已截图 |
| Attachments | **PASS** | 私有授权、MIME/大小/magic-byte、所有权、最多 3 图服务端绑定、失败/重试/移除/离页 abort/清理队列通过；正式系统 picker 与公网上传未验证 |
| Order linking | **PASS** | 本人订单读取、跨会员拒绝、最小 snapshot、管理订单详情 capability 通过 |
| AI/Human handoff | **PASS** | 等待→单赢家接管→正式 system event；真人接管后 AI 无自动发布权，建议只保留草稿 |
| Admin UX | **PASS** | 原生队列/会话、typing、read、图片、订单、上下文、失败与 resolved 状态通过本地集成和开发者工具呈现 |
| Performance | **PASS** | 可复现实验 30/20 samples；仅本地 Fastify inject + PostgreSQL，见下表；端到端公网时延未验证 |
| DevTools | **PASS** | Stable 2.02.2608070；最终源码 27/27 路由健康，限定 console=0、network=0；4 段 H.264 微信模拟器录像已逐帧复核 |
| iOS | **UNVERIFIED** | 没有获授权物理 iPhone 会话；软键盘、VoiceOver、弱网、图片/相机选择器未实测 |
| Android | **UNVERIFIED** | 没有获授权物理 Android 会话；键盘、TalkBack/厂商差异、弱网与返回手势未实测 |
| Staging | **BLOCKED** | 正式 AppID/体验版、HTTPS 合法域名、对象存储上传、真实 operator 排班与监控未在本轮授权范围内联调 |

## 性能证据

| 操作 | 样本 | P50 | P95 | P99 |
| --- | ---: | ---: | ---: | ---: |
| 首次加载最近 50 条 | 30 | 2.63ms | 6.63ms | 9.43ms |
| 发送到服务端 ACK | 30 | 5.66ms | 10.27ms | 10.86ms |
| 远端消息增量同步 | 30 | 1.73ms | 3.29ms | 4.20ms |
| typing 发布+投影 | 30 | 3.70ms | 5.79ms | 6.11ms |
| 历史 50 条 | 30 | 2.08ms | 3.77ms | 4.49ms |
| 256KiB 附件授权+网关上传+组装+校验 | 20 | 20.54ms | 28.58ms | 29.26ms |

以上是本机 API/数据库执行时间，不包含网络、渲染或轮询调度。客户端发现上界配置为 active 2 秒、idle 5 秒、hidden 0；它不是已测终端延迟。

## 验收与安全门禁

| 门禁 | 结果 |
| --- | --- |
| Unit | 41 files / 295 tests，PASS |
| Integration | 23 files / 108 tests，PASS |
| Commercial chat performance | 1 test，PASS |
| TypeScript / production build | PASS |
| Contract cross-check | 35 migrations / 73 tables / 81 paths / 27 events，PASS |
| Mini Program package | 204 files / 27 routes / 1,818,447 bytes；main 1,364,610；global WXSS 8,137，PASS |
| Final native route health | 27/27，console filter 0，network filter 0，PASS_LOCAL_SYNTHETIC |
| Gitleaks 8.30.1 | 12 commits / ~7.15MB，0 leaks，PASS |
| Production dependency audit | 0 vulnerabilities，PASS |
| Development-tool critical audit | 0 critical，PASS；`miniprogram-simulate` 间接依赖仍报告 4 high，强制修复会产生破坏性降级，未执行 |
| SBOM / license | CycloneDX 1.6 已生成；624 rows / 0 unknown，PASS |
| Design structural status | `ok=true`，PASS |
| Candidate design/release gate | `releaseReady=false`，**BLOCKED as intended**：全路由交互矩阵、物理 iOS/Android 与既有 open P0/P1 未关闭 |

## 证据索引

- 客服状态、录像、性能与逐文件哈希：[`support-commercial-chat-2026-09-12/`](support-commercial-chat-2026-09-12/)
- 最终源码 27 路由健康包：[`review-commercial-chat-005f03d4-20260912t0508cst/`](visual/review-commercial-chat-005f03d4-20260912t0508cst/)
- 当前源码验收清单：[`current-source-acceptance.json`](visual/current-source-acceptance.json)
- 状态与数据裁决：[`ADR-0010`](../adr/0010-commercial-chat-presence-and-media.md)
- 路由/状态/API 验收矩阵：[`ROUTE-STATE-ACTION-API-ACCEPTANCE.md`](../ROUTE-STATE-ACTION-API-ACCEPTANCE.md)

## 尚未关闭的发布工作

| Owner | 下一项可验收工作 | 完成定义 |
| --- | --- | --- |
| 产品 QA + 获授权真机持有人 | iOS：真实键盘、多行、大字体、VoiceOver、弱网/切后台、图片/相机与滚动 | 源码哈希绑定的真机截图/录像、设备/系统版本、结果与缺陷闭环 |
| 产品 QA + 获授权真机持有人 | Android：键盘、TalkBack、返回手势、厂商安全区、弱网/切后台、图片/相机 | 同上，且至少覆盖目标最低/主流系统版本 |
| 微信管理员 + 后端/安全 | 体验版、合法域名、正式 HTTPS、对象存储私有上传/预览、开关与告警 | 受控 staging 账号联调；无生产密钥进入仓库；失败/删除/孤儿清理证据齐全 |
| 运营负责人 | 真实客服别名、服务时段、主备排班、升级与不良反应路径 | 具名值班表、监控告警、夜间中性状态与人工接管演练 |
| 产品/设计 QA | 关闭全路由交互矩阵与既有 open P0/P1 | `design:qa:gate` 真正通过，而不是修改门禁或把模拟器证据冒充真机 |
| 工程依赖 Owner | 跟踪 `miniprogram-simulate` 的 high 级间接依赖 | 无破坏性升级的可验证修复，或签字隔离/替代方案；生产依赖持续为 0 high |

## 未执行动作

没有 merge、tag、release、正式小程序 upload/preview、生产部署、真实支付、真实订单操作或真实用户数据处理。
