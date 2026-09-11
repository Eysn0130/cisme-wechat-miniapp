> 2026-09-09 17:18 最新状态：数据库、API、Worker 与对象存储已切换腾讯云；现行协议为 `2026-09-09-v2-domestic`。开发版 `0.1.2-dev.20260909` 已上传，体验版设置、备案及真机验收尚未完成。详见 [会员与迁移复盘](MEMBER-PERFORMANCE-DOMESTIC-2026-09-09.md)；下方旧记录保留原时间范围。

# CISME 微信小程序开发版与体验版发布手册

状态（2026-09-09）：Stable 2.02.2608070 / 基础库 3.15.2 已运行，AppID `wx4eac2d4fb11d299b` 的微信凭据兑换、云函数部署、数据库与存储就绪已验证。协议正文/阅读入口、云上传通道和独立定时 Worker 已完成并部署；当前源码真机业务验收和体验版设置仍另行跟踪。没有可移交的团队体验二维码。以 [本轮交付审阅](DELIVERY-REVIEW-2026-09-09.md) 和 [外部阻塞登记](EXTERNAL-BLOCKERS.md) 为当前状态；下文有明确日期的旧事件只作历史记录。

## 1. 发布裁决

CISME 只使用腾讯官方微信开发者工具及其内置 CLI 作为当前发布主路径。第三方“小程序上传”GitHub Action、非官方 CLI、小红书克隆 UI、毛玻璃组件库和腾讯云低代码模板不进入项目。

官方 `miniprogram-ci` 2.1.31 仅作为隔离、人工批准的 CI 候选。2026-08-15 的精确依赖树为 73 个告警（41 critical、16 high、15 moderate、1 low），因此它不进入生产 lock/SBOM，也不作为当前本机上传前置。待上游修复或安全负责人接受限定风险后，才允许在一次性、网络受限 runner 中使用。官方 `miniprogram-mp-ci` 只管理项目/体验成员，不是编译、预览或发布流水线。

## 2. 四级版本边界

| 级别 | 目标 | 允许能力 | 不等于 |
|---|---|---|---|
| 本地模拟器 | 工程和接口联调 | 正式 AppID 已验证微信兑换及云部署；本地 PostgreSQL/对象存储/API 可用开发身份，云调用禁止开发身份；发布角色与资格仍须核对 | 真机、正式微信身份或体验版 |
| 受控真机调试 | 开发成员连接当前 DevTools 会话 | `develop` 环境、专用编译条件；同局域网私网 API 或严格 `https://*.trycloudflare.com` 临时隧道；短时 QR | 体验版、公开消费者分发、持久测试环境、正式域名或生产微信身份 |
| 开发版二维码 | 开发者真机验证 | 真实 AppID、受邀开发成员、HTTPS 测试 API、开发版二维码 | 体验成员可用或已上传版本 |
| 体验版 | 团队/审核前封闭测试 | 真实微信身份、体验成员、测试环境、邀请制投稿、护理、简明积分解释、品牌自有/单独签字精选 | 正式审核、用户内容公开、真实支付或公众 UGC |
| 正式版 | 经平台审核后的公众产品 | 只开放当前 release group 已通过的能力 | “体验版没报错即可上线” |

开发版、体验版、正式版共用同一领域合同，但使用独立环境、数据库、对象存储、密钥、App 会话和证据。体验版数据不得迁移为正式会员资产，除非有单独的数据迁移与用户告知方案。

## 3. 当前体验版范围

保留：微信身份、协议接受、护理周期与记录、有效邀请任务、原子领取、原图/截图上传、投稿进度、人工领奖审核/补件/申诉、简明积分解释、品牌自有或已单独签字的只读精选、少 SKU 浏览、设置与许可。外部领奖投稿即使通过审核也保持私有，不能自动进入精选。

关闭：交易 profile、支付、退款、物流、积分消费、公众 UGC、评论/关注/搜索/公开主页、公开任务广场、购物车/券、复杂成长、AI 经营工作台和任何假成功动作。后台与测试环境可以验证其领域合同，但消费者端不显示空壳入口。

## 4. 已安装和已有工具

- 当前微信开发者工具 UI 为 Stable 2.02.2608070、基础库 3.15.2：`/Applications/wechatwebdevtools.app`；`405ae15c…` 检查点使用基础库 2.32.3。
- 官方 CLI：`/Applications/wechatwebdevtools.app/Contents/MacOS/cli`，已通过 Apple 公证与腾讯签名校验。
- `miniprogram-api-typings` 5.2.3：仅开发期类型。
- `miniprogram-ci` 2.1.31：只在 `tools/wechat-ci` 隔离清单中，默认不安装、不执行。
- 微信官方 `wechat-miniprogram/ai-mode-skills` 中的生成辅助 Skill 已安装到 Codex 个人环境；它只辅助后续开发，不是项目运行依赖，也不能替代开发者工具、AppID、隐私指引或发布审核。
- `miniprogram-automator` 仅做过一次隔离评估；安装树出现 10 个安全告警（其中 3 个 critical、1 个 high），已立即卸载，未进入 lock、SBOM 或发布链路。
- GitHub Actions：主 job 设计为运行无发布密钥的构建、测试、迁移、包体积/哈希、SBOM 与许可证门禁；另有默认不运行的 `miniprogram-ci` protected-environment preview job。YAML 和隔离脚本双层要求风险接受、匹配 AppID/私钥、公共 HTTPS、隐私/法律/域名/demo approvals 与 current-source strict Design QA；脚本只做 `packNpm + preview`，不做 upload。required reviewers、固定 runner 出口 IP 和微信 IP 白名单仍属未证明的外部配置；没有 remote 或 CI run，YAML 不是执行证据。

2026-08-30 误触 Preview 事件：RC 在尝试进入安全设置时生成了当前接口测试号的短时开发 QR。未扫码、未分发、未设体验版、未提交审核、未发布；含 QR 截图已删除，DevTools CLI 服务端口没有开启。该事件只进入审计记录，不进入 current-source evidence manifest。

2026-09-01 受控真机调试：本机 API 已验证通过私网地址的 live/ready，`wechat:device-debug:configure` 只修改被忽略的私有项目配置并创建 `CISME 真机调试` 条件；DevTools RC 2.02.2608031 已明确点击“真机调试”、启用“局域网模式”并生成短时 QR。当前仍等待获授权成员扫码，故只能证明二维码已受控生成，不能证明设备连接、真实微信身份、Network、iOS/Android 视觉或体验版可用。二维码不保存、不提交，也不计入 current-source acceptance manifest。

不需要安装 Codex 插件、Figma、腾讯云插件或额外 Skill 才能发布体验版。真正的外部依赖是微信账号权限、AppID、测试环境与合法域名，不是插件数量。

## 5. 账号与控制台一次性配置

由小程序管理员完成或扫码授权后由项目负责人接管：

1. 确认小程序主体、类目和 AppID；把开发者加入项目成员。
2. 在“小程序管理后台 → 设置 → 服务内容声明 → 用户隐私保护指引”声明实际处理的信息；未声明的隐私接口会被微信禁用。
3. 配置 request/upload/download 合法域名和有效 TLS；体验/正式环境不得关闭域名校验。
4. 添加体验成员并限定名单；体验二维码不得公开传播。
5. 仅在准备启用 CI 时生成代码上传密钥，存入受保护密钥库并设置 IP 白名单；密钥文件禁止进入仓库、聊天、日志和制品。
6. 体验版使用独立 HTTPS API、数据库和对象存储；交易、UGC、积分消费开关保持关闭。
7. 无真实交易 profile 时，体验成员登录后复制自己的“体验登记编号”，由 `review_lead/support` 在内部后台凭唯一签收/测试履约证据登记。命令只生成 qualification fact 与一个 PLANNED 护理周期，有审计且不能冒充订单、支付、库存或收入。

## 6. 工程配置

1. 核验 `apps/miniprogram/project.config.json` 中的 AppID 确属目标小程序，并由管理员/项目成员权限证明；当前 AppID 的微信凭据兑换和云部署已验证，仍须核对发布角色及体验成员。AppID 不是私钥，仍必须与目标项目和 CI 期望值一致。
2. 在 `apps/miniprogram/release-config.ts` 填写公共 HTTPS origin：
   - `preview`：开发版二维码在手机上访问的 API；
   - `trial`：体验版 API；
   - `release`：正式版 API，正式提审前才填写。
3. 测试后台必须使用真实微信 `jscode2session`；`ALLOW_DEV_ADAPTERS=false`。生产/体验密钥缺失时服务必须 fail closed。

## 7. 命令

```bash
npm run wechat:preflight:local
npm run wechat:preflight:preview
npm run wechat:preflight:trial
```

受控真机调试（不上传体验版）：

```bash
npm run dev:api
npm run wechat:device-debug:configure
# 同局域网：选择“CISME 局域网真机调试”→编译→“真机调试”→开启“局域网模式”→授权成员扫码

# 异地协作：另行启动临时 Cloudflare Quick Tunnel 后执行
npm run wechat:device-debug:configure -- --origin=https://<random>.trycloudflare.com
# 选择“CISME 异地真机调试”→编译→“真机调试”→关闭“局域网模式”→仅向授权成员发送短时 QR
```

该命令只接受 RFC1918 私网 HTTP origin 或 origin-only `https://*.trycloudflare.com`。运行时只在物理设备 `develop` + 显式 query 下启用开发身份与本地法务夹具；trial/release 保持 fail-closed。Quick Tunnel 是无 SLA 的临时开发通道，进程停止即失效；二维码不得公开传播，不能替代体验版。长期团队访问必须使用下方自有公共 HTTPS、真实 AppID/角色和体验成员流程。

生成开发版二维码：

```bash
WECHAT_APP_ID=wx... \
WECHAT_PRIVACY_GUIDE_CONFIGURED=true \
WECHAT_LEGAL_TEXTS_APPROVED=true \
WECHAT_SERVER_DOMAINS_CONFIGURED=true \
WECHAT_DEMO_SCOPE_APPROVED=true \
npm run wechat:preview
```

上传一个开发版本，供后台选为体验版：

```bash
WECHAT_APP_ID=wx... \
WECHAT_PRIVACY_GUIDE_CONFIGURED=true \
WECHAT_LEGAL_TEXTS_APPROVED=true \
WECHAT_SERVER_DOMAINS_CONFIGURED=true \
WECHAT_DEMO_SCOPE_APPROVED=true \
WECHAT_EXPERIENCE_MEMBERS_CONFIGURED=true \
WECHAT_VERSION=0.1.0-demo.1 \
WECHAT_RELEASE_DESC='CISME R0 封闭体验：护理、邀请投稿与积分账' \
npm run wechat:upload -- --confirm-upload
```

二维码和 CLI 信息只写入被 Git 忽略的 `docs/evidence/wechat/`，不会进入提交历史。上传成功后仍需在小程序管理后台把该开发版本设为体验版；本项目不自动提交审核或发布正式版。

## 8. 上传后验收

- iPhone、Android、窄屏大字号各完成一轮身份→护理→邀请→投稿→进度→积分解释。
- 覆盖相册/相机拒绝、隐私拒绝、弱网、上传中断/重试/替换、会话过期、重复领取与重复提交。
- 管理后台完成补件、驳回、申诉和通过；验证只产生一个条件 grant，待审不增加余额，审核通过也不自动生成公开 Feed。UGC 门关闭时独立发布命令和 Worker 均 fail closed。
- 验证真机开发二维码不调用 `/v1/identity/dev`；体验资格同证据重放复用同一周期，不同证据不能为同一会员制造并行开放周期。
- 验证体验版中交易、积分消费、公开 UGC、评论/关注/搜索及 AI 入口确实不可见且服务端开关关闭。
- 每一轮记录 AppID、版本号、commit、基础库、设备、微信版本、测试环境、截图、trace ID 与结果。

只有上述证据完成，才把体验版称为“团队可验收”；它仍不能称为“生产上线”。
