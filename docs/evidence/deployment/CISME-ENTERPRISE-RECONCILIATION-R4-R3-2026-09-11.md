# CISME Commercial Delivery：企业主体、R1/R2、R4-A/R4-B 与 bounded R3 统一交付台账

- 核验日期：2026-09-11（Asia/Shanghai）
- 运营主体：熹芃（上海）生物科技有限公司
- canonical Mini Program AppID：`wx4eac2d4fb11d299b`
- 父候选：`r1-r2-staging-slice-20260911T080300Z`，不可变、未部署
- 当前小程序源码：`7f5fad5fe84c122a28a9c54234690515a64c09cf86a666daced4ba635672957d`
- GitHub 已验收开发基线：`Eysn0130/cisme_app`，PUBLIC；源码 `d5b0e9b00cec476a42793c68f3826b0d54b36115`，合成视觉证据 `652ca350c5982b97581a1913e1f53f50d9b3a3c6`
- 本轮边界：本地实现/验证、隔离数据库、独立 follow-up 候选、公开官方资料核验，以及 Owner 明确授权的现有 GitHub 仓库普通 commit/push 与 PUBLIC 切换；未执行生产、真实支付、真实 AI、正式小程序上传、真实用户数据处理、force push、history rewrite、merge、tag 或 release

## 执行结论

本次企业主体变化属于分支 **B：新的企业 AppID**，不是“同一 AppID 完成主体迁移”，也没有证据表明只是分支 C 的凭据/管理员变化。Owner 已确认旧版本未发布、无真实生产用户，因此没有建立虚构的旧账号迁移、UnionID 合并或历史 consent 搬迁。旧个人 AppID 仍是 `UNKNOWN`；仓库历史中的 `wxf639399a761abc01` 仅是微信接口测试号证据，绝不能倒推为旧个人 AppID。

当前运行源码已把微信身份权威键固定为 `provider + app_id + openid`，session 带 provider/AppID audience，staging/production 配错 AppID 会 fail closed。微信后台管理员/开发者身份与 CISME 业务管理员继续分离；业务权限只来自可撤销、可过期、按环境隔离的 `authority_grant`，不存在“第一个登录用户自动变管理员”。UnionID 只保留为可选元数据；当前单小程序架构不要求为登录或支付先绑定微信开放平台。

R4-A 已形成同一原生小程序内的本地商品目录闭环：第一方商品、单 SKU、CNY 整数分价格、库存、资质判断、发布相互分责；三个旧预览商品被保留为 `legacy_preview + pending + draft + stock=0`，不会自动公开。管理员可新增/编辑、判定资质、上下架、调整库存；普通用户无需购买会员即可浏览 `eligible + published` 商品。

R4-B 现已形成**仅隔离非生产合成环境**的最小订单域闭环：商品详情 → SKU/数量 → 地址 → 服务端报价 → 创建 `pending_payment` → 本人/管理员列表与详情 → 用户取消或 Worker 超时 → 库存预留精确释放。价格、库存、地址版本、快照、幂等和并发由服务端/数据库控制。真实会员价和运费规则没有被虚构；`paymentAvailable=false`，不存在 `paid`、模拟支付成功、履约、退款或售后动作。购物车、收藏、真实支付、商品媒体上传和后续运营处理仍是后续切片。

bounded R3 只交付安全边界：runtime Provider 关闭、批准知识库为空、工具只读且代码 allowlist、member scope 由服务端注入、建议草稿不保存/不发送。状态保持 `PROVIDER INTEGRATION PENDING`。现阶段继续使用既有状态机与 Worker，不引入 LangGraph 第二套 checkpoint/权限面。

Owner 随后明确否决新建仓库方案，指定沿用 `https://github.com/Eysn0130/cisme_app` 并要求开发期 PUBLIC。执行时保留远端原 6 个提交：`d5b0e9b00cec476a42793c68f3826b0d54b36115` 是原 `main` 的普通直接后继，逐文件等于预发布 694-file review-source；`652ca350c5982b97581a1913e1f53f50d9b3a3c6` 只补入 27 张已校验的合成路线截图与 1 张联系表。两次均为非强推。匿名 GitHub API 与 raw 文件读取已核对 PUBLIC、`main` SHA 与 `package.json` SHA；GitHub Actions run `34603405920` 的 secret scan、依赖审计、typecheck、Mini package、Design QA 结构、248 项单元测试、101 项集成测试、build、contracts、SBOM 与 license report 全部通过。该公开动作不改变 production/payment/formal-upload 的关闭状态。

R1/R2 的本地候选与演练仍有效，但远端没有部署。TCP 443 可达；带 `staging-api.cisme.cn` 正确 SNI 的 TLS 握手立即 EOF，而直接 IP、不带正确 SNI 时可见目标证书。当前工作站没有可用 SSH 身份、没有 `tccli`，此前控制台自动化初始化也已在同一根因下失败三次并停止重试。因此只可写 `R1/R2 REMOTE STAGING BLOCKED`，不能写 `STAGING VERIFIED`。

## 原始 R1/R2 证据与统一统计口径

原候选 `dist/r1-r2-staging-slice-20260911T080300Z` 保持未覆盖：

- `MANIFEST.json` SHA-256：`046a4833a554171e2f1814db2484eff3ca60b6a56fdeb17c9bf8d372e19363c2`；
- `SHA256SUMS` SHA-256：`c2da6e8c19710d5d54f8810c18591aeb9f0b5ce6ad46b10fdd2531627e8300c6`；
- 240 项逐项校验通过；
- migration 29 的 API + `runtime/index.patch` 可字节级重建 migration 31 候选 API；
- 候选不含 `.env`、私有项目配置、key/cert/PEM、凭据或真实用户数据；
- parent manifest 明确 production/payment/formal upload 均未授权。

物理表口径固定为：

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;
```

`physical_table_count` 只计 `public` schema 的 base table，包含 `schema_migration`。若存在 leaf partition，它会按独立 base-table row 计入；本次 migration 33 的本地实例实测 `partitioned parents=0`、`leaf partitions=0`。view、materialized view、sequence、index、其他 schema 及 extension-owned object 不进入该数；本地 `public` extension-owned relation 实测为 0。索引和约束分别用 `pg_indexes` 与 `information_schema.table_constraints` 单列，不与表数相加。

`contract_required_table_count` 是验证器维护的“本能力必须存在”的清单，不是数据库物理对象清单：migration 31 为 59，migration 33 为 65。原 migration 31 清单有意不含 10 张仍存在的物理表：`community_comment`、`community_comment_like`、`community_post_stats`、`community_reaction`、`consent_acceptance`、`emergency_switch`、`idempotency_operation`、`principal_role`、`review_action`、`schema_migration`。

| 迁移状态 | ledger | physical_table_count | contract_required_table_count | indexes | constraints | 物理增量 |
|---|---:|---:|---:|---:|---:|---|
| P0/P1，migration 29 | 29 | 66 | 56 | 147 | 849 | 基线 |
| R1/R2，migration 31 | 31 | 69 | 59 | 158 | 905 | `authority_grant`、`support_conversation`、`support_message`；无删除/重命名 |
| Enterprise/R4-A，migration 33 | 33 | 75 | 65 | 177 | 1013 | 6 张 `catalog_*` 表；migration 32 只加强身份/授权列与约束 |
| Commercial R4-B，migration 34 | 34 | 81 | 71 | 198 | 1170 | 6 张 quote/order/line/address/reservation/transition 表；inventory 增加受约束 reserved quantity |

当前源码与旧候选不同，旧哈希没有被沿用。上一 follow-up 相对 parent 增加 migration 32–33、企业身份 audience、R4-A、bounded R3 和 2 条原生商品管理路由；本次 Commercial Delivery 再增加 migration 34、R4-B 服务/API/Worker、5 条原生结算/订单路由和对应 OpenAPI/contracts/tests。小程序从 `c7e457b5… / 178 files / 22 routes` 变为 `7f5fad5f… / 199 files / 27 routes`。旧 follow-up 保持独立不可变；本次必须另建候选，不覆盖旧包。

## E0 企业主体实际状态矩阵

`OWNER-CONFIRMED` 表示 Owner 于 2026-09-11 明确提供，但没有冒充公众平台截图/API 证明；需要账号后台或真实调用的均标 `PENDING ACCOUNT EVIDENCE`。

| 项目 | 旧状态 | 当前状态 | 证据及核验时间 | 是否影响现有功能 | 是否需要重新申请/绑定 | 是否需要代码调整 | 是否需要用户操作 | 对应功能开放门禁 |
|---|---|---|---|---|---|---|---|---|
| 企业完整名称 | 旧个人主体真实名称 `UNKNOWN` | 熹芃（上海）生物科技有限公司 | OWNER-CONFIRMED 2026-09-11；本地 legal/config 同名；平台页待证 | 影响处理者、销售者、协议、类目/资质 | 不是把旧主体字段直接继承；认证/备案分别办理 | 已更新新企业版本，不改历史文本 | 在公众平台核对主体页并遮挡个人/证件字段留证 | 企业身份、协议、认证/备案 |
| 当前 AppID | 历史接口测试号 `wxf639399a761abc01`，不是旧个人 AppID 证明 | `wx4eac2d4fb11d299b` | OWNER-CONFIRMED；`project.config.json`、config、env example、session audience 本地核验 2026-09-11 | 影响登录 namespace、域名、模板、token、支付绑定 | 新账号下逐项配置，不“继承”旧测试号 | 已完成 runtime/build 调整 | 平台基本信息 + 一次真实登录取证 | 登录、体验版、域名、支付 |
| 原个人 AppID | `UNKNOWN` | 不再作为目标 | 全仓搜索仅找到接口测试号与历史证据；2026-09-11 | 无真实用户，故不建迁移系统 | 否 | 否；禁止按头像/昵称/手机号合并 | 无 | N/A；历史证据保留 |
| 原始 ID | 旧账号 `UNKNOWN` | `gh_af14af2f2ad3` 仅为 2026-09-08 文档记录，尚未平台核验 | `docs/TAKEOVER-PLAN-2026-09-08.md`；PENDING ACCOUNT EVIDENCE | 不参与登录/授权 | 否 | 否 | 在当前企业小程序基本信息页核对 | 账号证据完整性，不是 runtime authority |
| 主体变更类型/完成状态 | 不是可证明的同 AppID 迁移 | 分支 B：新企业 AppID；账号目标已确定，但认证、备案、发布均未完成 | OWNER-CONFIRMED 2026-09-11 | 决定不做旧用户迁移；所有账号配置重新核对 | 按能力办理认证/备案/域名/模板/支付，不笼统“全部重申请” | 已加 namespace/audience fail-closed | 补平台状态证据 | 真实发布仍关闭 |
| 微信认证 | `UNKNOWN` | `IN_PROGRESS`；完成结果尚未通知 | OWNER-CONFIRMED 2026-09-11；平台订单/状态待证 | 不阻塞本地订单开发；完成并核验前仍阻塞手机号与真实小程序支付 | 正在办理，不重复要求重新申请 | 无需为此重写登录 | Owner 完成后主动通知；届时只核验状态/能力证据 | `IN_PROGRESS`；不等于支付或发布授权 |
| 管理员/开发者/体验成员 | 旧账号名单 `UNKNOWN` | 两名测试/管理人员为当前微信最高权限开发/管理人员；精确角色拆分与体验成员名单 `UNKNOWN` | OWNER-CONFIRMED 2026-09-11；成员管理页待证 | 只影响公众平台/开发；不自动产生 CISME 权限 | 成员角色可能需当前 AppID 下重新配置 | 业务权限已改为 `authority_grant` only | 核对人数/角色；真实登录后按最小 capability 发 staging grant | DevTools/体验版与移动管理分别门禁 |
| 微信开放平台 | 旧绑定 `UNKNOWN` | 是否绑定 `UNKNOWN`；当前单小程序架构不要求 | 官方规则核验 2026-09-11；账号页待证 | 不影响当前登录或支付路线；不得假设 UnionID 连续 | 当前无需主动绑定 | 已明确 UnionID 非 authority | 只核对是否已绑定，不为未来可能性新建依赖 | `NOT REQUIRED FOR CURRENT SINGLE-MINIPROGRAM ARCHITECTURE` |
| 服务类目 | `UNKNOWN` | 当前账号类目 `UNKNOWN` | PENDING ACCOUNT EVIDENCE 2026-09-11 | 影响自营商品、UGC、护理记录、AI 客服审核边界 | 按真实业务/商品逐项选择或补材料 | 已有 Qualification Gate；不增加医疗诊断/第三方商户等业务 | 企业负责人确认真实业务描述、经营范围和材料 | 商品 publish 不等于平台可售；正式发布关闭 |
| 小程序备案 | `UNKNOWN` | 未备案 | OWNER-CONFIRMED 2026-09-11 | 不阻塞本地/隔离 staging；阻塞正式发布 | 需要备案 | 无 runtime 重写 | 企业管理员完成提交、真实性确认和现场核验 | `WECHAT_MINIPROGRAM_FILING=PENDING EXTERNAL OWNER ACTION` |
| 服务域名/部署目标 | 历史账号配置 `UNKNOWN` | code：preview/trial=`https://staging-api.cisme.cn`，release origin 为空；新 AppID 四栏均待证；当前 SNI TLS EOF | 本地 release-config + 公网诊断 2026-09-11 | 阻塞真实小程序 staging 网络 | 新 AppID 下配置实际使用栏位；不使用的留空/N/A | code 已 fail closed；远端 TLS 仍需运维修复 | 修复 SNI 后在公众平台配置并关闭域名绕过实测 | DevTools Network、体验版、正式发布 |
| 云资源归属 | 历史 CloudBase/COS 文本不能证明现状 | 技术目标为上海 Lighthouse/PostgreSQL；CloudBase 未映射 preview/trial，COS/media 开关关闭；腾讯云账号/实例/证书/域名归属待证 | local config/privacy draft + PENDING ACCOUNT EVIDENCE 2026-09-11 | 影响部署、证书、媒体与数据处理披露 | 微信主体变化不会自动迁移腾讯云资源 | 未迁移生产资产；媒体保持关闭 | 对精确 staging 实例、域名、证书分别取证 | 远端部署与媒体开放 |
| 微信支付 | 旧商户关系 `UNKNOWN` | `WECHAT_PAY_ONBOARDING=IN_PROGRESS`；商户模式/AppID 关联/接口权限/回调/安全材料尚待完成后核验 | OWNER-CONFIRMED 2026-09-11；不读取或索取密钥 | R4-B pending-payment 域不受阻；真实资金动作继续阻塞 | 正在办理，不重复要求申请 | 已预留 payment seam，但无 provider/paid route | Owner 完成后主动通知；真实资金测试仍需独立额度与动作授权 | `IN_PROGRESS`；完成不自动允许真实支付 |

## 身份连续性与管理员授权结论

- `wx.login` code 只能交给服务端，服务端使用当前企业 AppID 的合法配置换取可信 OpenID/session；客户端自报 OpenID、UnionID、member/user ID、角色或 header 均不是 authority。
- migration 32 把 `wechat_identity` 唯一性改为 `(provider, app_id, openid)`；runtime 微信使用 `wechat_miniprogram`，隔离开发测试使用 `dev_test`。旧 provider 被显式回填，不做跨 namespace 自动合并。
- session claim 携带 provider/AppID，并按 runtime audience 验证；旧/错 AppID token 被拒绝。staging/production 启动时如果 `WECHAT_APP_ID` 不是 canonical AppID 会 fail closed。
- 由于没有真实旧用户，不建立 identity migration/account linking 流程，也不清空或批量改 OpenID。若 staging 发现旧测试 identity，必须先证明 synthetic，再按精确 test run 处理；不能凭昵称、头像、客户端字段或未验证手机号合并。
- `authority_grant` 按 `member + capability + environment` 唯一，带 grant source、expiry、revocation 和不可变审计；legacy grant 回填为 `legacy_unspecified` 并在所有明确环境 fail closed。`member_team_access` 不能再授权会员侧社区/客服/商品管理。
- `scripts/authority-grants.ts` 只允许 staging/production，要求精确 `EXPECTED_DATABASE_NAME`、canonical AppID、真实 `wechat_miniprogram` identity 和一个精确 capability；grant/revoke/list 均不接受昵称或客户端角色。普通登录用户与付费会员继续分离；商品浏览和本人客服不要求先购买会员。
- 撤权的本地证据覆盖 API 权限、管理队列/会话读取、人工回复、成员敏感投影和环境隔离。增量轮询每次重新请求都会复核 session/capability；当前没有后台 push/AI job，也没有“待发送 AI 回复”可在撤权后迟到发送。真实 App 前后台恢复仍需设备验收。

AppID 全仓分类结果：runtime/config（API、session audience、env example）和 build/DevTools project 均指向 canonical AppID；当前 ADR/交付报告明确新企业 AppID；历史 DevTools/RELEASE-AUDIT 仍保留 `wxf639399a761abc01` 接口测试号，不篡改；旧 R1/R2 manifest 本身没有显式 AppID 字段，不能凭包内容把它说成已经做过企业主体核验，新的 follow-up manifest 才明确锁定 canonical AppID。

## 微信能力逐项核对

下表中的官方通用规则不能证明新 AppID 已经开通；新账号专属状态仍标 `PENDING ACCOUNT EVIDENCE`。微信开放文档多数页面不显示独立发布日期，统一记录“2026-09-11 直接核验”；微信支付/Tencent Cloud 有页面更新时间的另行写明。

| 能力 | 当前源码/产品使用 | 官方通用要求 | 新企业 AppID 结论 | 是否重申请/绑定 | 证据与开放门禁 |
|---|---|---|---|---|---|
| 登录 | 用户点击后 `wx.login`；服务端 `code2Session`；dev_test 仅隔离开发 | code 约 5 分钟、只能服务端用 AppID/AppSecret 交换；OpenID 属当前小程序 namespace | 未发现“微信认证才可登录”的普遍前置；必须使用新 AppID 自己的 secret/code | 不叫“重申请登录”，但须配置新凭据并真实交换一次 | [wx.login](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html)、[code2Session](https://developers.weixin.qq.com/miniprogram/dev/server/API/user-login/api_code2session)；真实交换 PENDING |
| 手机号 | 选填绑定；拒绝不影响公开浏览/无需手机号功能；不授管理员 | 快速验证能力面向非个人且已认证小程序；手机号 code 与 login code 不同、5 分钟且一次性；当前成功调用 0.03 元/次，每 AppID 有 1000 次开发/体验额度 | 企业主体满足主体类型，微信认证正在办理；完成并实证前不开放真实手机号流程 | 认证完成后仍核对接口页、体验额度/付费、余额与同意/拒绝/额度不足/接口失败恢复 | [手机号组件](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html)、[服务端接口](https://developers.weixin.qq.com/miniprogram/dev/server/API/user-info/phone-number/api_getphonenumber)；当前 IN_PROGRESS/BLOCKED |
| 收货地址 | 手工填写、`wx.chooseAddress` 导入草稿；用户核对保存；当前无下单/物流 | 由用户动作调起；隐私声明应与实际字段/用途一致 | 不等于 GPS，不因企业认证额外申请定位；拒绝后仍可手填 | 无“主体迁移式重申请”，但新 AppID 隐私保护指引需如实声明 | [wx.chooseAddress](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/address/wx.chooseAddress.html)；账号隐私声明/真机 allow-deny PENDING |
| 剪贴板 | 只有用户点“粘贴并识别”才读，最多 500 字符；本机解析，保存前不上传 | 应由明确用户动作触发并提供拒绝/失败 fallback | 与地址导入分开；不是后台读取 | 无单独业务资格申请；新 AppID 隐私声明和真机行为需一致 | [wx.getClipboardData](https://developers.weixin.qq.com/miniprogram/dev/api/device/clipboard/wx.getClipboardData.html)；真机证据 PENDING |
| 头像/昵称 | `open-type=chooseAvatar`、`input type=nickname`；用户编辑保存；不用于账号合并/授权 | 使用当前头像选择/昵称填写能力，不能假设自动取得微信资料 | 不因企业认证自动读取；拒绝不应阻塞公开浏览 | 无笼统重申请；需当前基础库/真机与隐私声明核验 | [用户头像昵称能力](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/userProfile.html)；当前 source only |
| 照片/摄像头/媒体 | 投稿页存在 `wx.chooseMedia` 与 upload boundary，但服务端 `media_uploads_enabled=false` 时先拦截，不请求相册/相机；商品只允许打包 JPG 引用 | 选择图片不等于写入系统相册；相册、摄像头、上传分别按实际动作/隐私/域名处理 | 当前媒体原图上传保持关闭；不能因商品管理顺手扩大到社区/客服附件 | 未来每类媒体单独 gate；当前无需配置 upload 域名来冒充已启用 | [wx.chooseMedia](https://developers.weixin.qq.com/miniprogram/dev/api/media/video/wx.chooseMedia.html)；allow/deny/cancel/弱网/内容安全未验 |
| 订阅消息 | 当前应用内未读依赖 CISME 数据，不依赖订阅消息 | 平台选/审模板；基础库 2.8.2 起应在用户点击或支付回调后调 `wx.requestSubscribeMessage`，一次最多 5 个不同标题模板；用户可拒绝/关闭；不是无限主动推送权 | 企业认证不自动授模板或发送权；当前可不启用 | 模板 ID/类型/状态、类目、场景均属于新 AppID 账号配置 | [订阅消息指南](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message.html)、[请求授权](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html)；PENDING |
| 文本内容安全 | 社区/客服仍以业务审核、举报、申诉为 authority；未以 API 结果替代审核 | `msgSecCheck` 服务端调用，需近两小时访问过小程序的 OpenID；未上架 100 次/日，上架后上限 4000/分钟、200 万/日 | 新未上架 AppID 只能按 100 次/日做 synthetic 预算，不能上传真实聊天测试 | 新 AppID access token/配额/调用结果均需实证 | [msgSecCheck](https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_msgseccheck)；PENDING ACCOUNT EVIDENCE |
| 图片/音频及未来视频安全 | 原图上传关闭；无视频业务 | `mediaCheckAsync` 当前文档明确图片/音频，单文件 10MB、2000/分钟、20 万/日，约 30 分钟内异步回调；review/risky 仍需业务处理 | 不能从“多媒体”名称推断未来视频已覆盖；视频到切片时重查 | 开启媒体前另做 callback、配额和申诉/人工审核 | [mediaCheckAsync](https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_mediacheckasync)；当前 N/A/未来 PENDING |
| CISME 自建客服 | 当前主方案：同一 PostgreSQL 会话、同一 API、同一小程序管理端 | 属 CISME 自有系统，不依赖微信客服产品开通 | 企业认证变化不要求换客服系统 | 无微信侧重新申请；真实 staging/retention/device 仍需验 | 本地 R1/R2 tests PASS；remote/device BLOCKED |
| `open-type=contact` | 当前主路径未切换到它 | 微信原生小程序客服会话，可带 session-from/消息卡片，与自建会话不是同一记录 | 只是可选独立入口，不会自动汇入 CISME 工单 | 若采用，单独配置客服账号/消息推送并做身份/留痕方案 | [小程序客服消息](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/customer-message/customer-message.html)；当前未启用 |
| 小程序客服消息接口 | 当前未接入 | 服务端 `sendCustomMessage`；用户发消息后当前规则为 48 小时内最多下发 5 条，不能无限主动发 | 与订阅消息、自建客服不同 | 若采用，需新 AppID 回调/token/AES、OpenID 映射、失败策略 | [服务端发送客服消息](https://developers.weixin.qq.com/miniprogram/dev/server/API/kf-mgnt/kf-message/api_sendcustommessage)；当前未启用/PENDING |
| 企业微信“微信客服” | 当前未接入 | 独立产品；API 模式需企业微信后台、可调用应用、指定客服账号/API 接待配置 | 企业小程序认证不会自动产生这套系统 | 只有明确业务需要才单独接入 | [企业微信微信客服](https://developer.work.weixin.qq.com/document/path/94638)；当前未启用/PENDING |
| request 域名 | preview/trial 指向 `staging-api.cisme.cn`；release 空 | 新 AppID 后台配置精确 HTTPS 域名；不能用 IP/localhost；DevTools 关闭校验不是上线证据 | 代码目标明确，但账号配置和真实 TLS 均未通过 | 必须在新 AppID 配置并关闭绕过实测 | [网络能力](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)；SNI BLOCKED |
| upload/download/socket 域名 | upload path gated off；无业务 download/socket | HTTPS/WSS 各栏独立、只配置真实使用域名 | 未使用的栏位应留空/N/A，不为“看起来完整”虚构 | 启用对应能力时再配置、取证 | 同上；当前 upload/download/socket 未开放 |
| 业务域名 | 源码无 `web-view` | 只在 `web-view` 普通网页场景单独配置，与 request 域名不同 | 当前 NOT APPLICABLE | 否；若未来新增 web-view 再单独核验 | [web-view](https://developers.weixin.qq.com/miniprogram/dev/component/web-view.html) |
| 服务类目/商品资质 | 第一方目录 + 数据库 Qualification Gate；UGC/护理/AI 各自保留 gate | 类目/材料随政策变化，以提交时清单为准；营业执照不自动证明任意商品可售 | 当前类目/每个商品材料均未知；不增加医疗诊断、第三方商家、直播等业务 | 真实业务/商品逐项申请或补材料 | [开放服务类目](https://developers.weixin.qq.com/miniprogram/product/material/)；PENDING ACCOUNT EVIDENCE |
| 小程序备案 | 本地/staging 开发不依赖；release gate 关闭 | 主办单位/负责人/小程序负责人、必要专项审批、现场核验等由官方流程决定 | 当前明确未备案；与服务器域名 ICP 是两个门禁 | 正式发布前办理 | [备案指引](https://developers.weixin.qq.com/miniprogram/product/record_guidelines.html)；PENDING EXTERNAL OWNER ACTION |
| 微信认证 | 登录/本地目录不依赖；手机号/真实支付依赖 | 企业注册不等于认证完成；营业执照、协议、资料、费用、第三方审核/真实性核验按平台流程 | `IN_PROGRESS`；完成结果尚待 Owner 通知和平台实证 | 不重复申请；完成后核验 | [认证指引](https://developers.weixin.qq.com/miniprogram/product/renzheng.html)；IN_PROGRESS |
| 微信支付 | R4-B 只有 pending-payment 域状态；客户端无假成功、无 `wx.requestPayment` | 已认证小程序→商户号/JSAPI 权限→绑定新 AppID；通知验签/解密、查单、幂等/对账是服务端 authority | onboarding `IN_PROGRESS`；商户模式/权限/绑定/credentials 等待完成后核验；开放平台不是当前单小程序前置 | 不重复申请；完成后进入独立支付适配与明确授权的资金测试 | [接入准备](https://pay.weixin.qq.com/doc/v3/merchant/4015459512.md)（2026-05-19）、[绑定 AppID](https://pay.weixin.qq.com/doc/v3/merchant/4013287504.md)（2025-07-02）、[支付通知](https://pay.weixin.qq.com/doc/v3/merchant/4012791902.md)（2024-12-27） |
| 云资源 | 当前目标 Lighthouse/PostgreSQL；CloudBase 不映射 preview/trial；COS/media off | 微信主体/AppID 变化不会自动迁移腾讯云账号、实例、证书、COS/CloudBase | 每项归属和 runtime 状态需分别取证 | 不迁生产、不扩大 COS 权限；只恢复精确 staging | PENDING ACCOUNT EVIDENCE |

官方资料只证明规则，不能证明账号已开通。后续账号证据应遮挡微信号、AppSecret、token、EncodingAESKey、session_key、完整 OpenID、证照/身份证/银行账号和支付密钥，只保留 AppID、主体、状态、角色人数、域名、模板/类目状态、时间、结果码与内部 trace/request ID。

## 企业法律文本与真实数据流

- 历史 legal publication 文件及同意版本均保留，未覆盖或改写。没有真实生产用户，因此不构造不存在的 consent migration，也不批量重置 consent。
- 当前源码的 production `approvedLegalDocumentVersions=null`，即正式版法务版本 fail closed；DevTools 只允许明确标注的本地 visual fixture。
- 本地 staging 候选是 `terms=2026-09-11-v4-staging`、`privacy=2026-09-11-v7-staging-support`，处理者均为熹芃（上海）生物科技有限公司；它们是待审/待发布文本，不是当前 staging 或生产已生效证明。远端 active version 因无授权通道为 `UNKNOWN`。
- 联系方式当前只有小程序“会员账号/设置与隐私→隐私与数据权利”以及微信反馈；在公司确认可持续受理渠道前不能写成已完成的企业售后联系方式。
- 商品目录只处理第一方 catalog 与管理员审计；购买、支付、物流、售后退款尚未开放，因此文本不得把这些外部处理关系写成已发生。正式交易前需补销售/售后条款、支付/物流处理者和交易记录保存规则。
- AI Provider 未接入、批准知识为空、无真实聊天外发，因此没有把不存在的 AI 服务商或跨境传输写成已发生；真实 Provider 前必须补处理者、地域、保留、生成内容标识/适用登记备案和用户告知。
- COS/media 当前关闭；本地 staging draft 对上海 Lighthouse/PostgreSQL 的描述仍需远端资源归属与实际数据流复核后才可发布。
- Support message、conversation 和 audit 的保存期限仍是 `POLICY PENDING`。代码只在策略显式 active、resolved 后到期、无 member/conversation legal hold、精确 UUID 和幂等键均满足时允许 targeted purge；不能宣称全系统导出/擦除/注销已闭合。

法律/隐私状态因此是 `LOCAL DRAFT PASS / PUBLICATION UNVERIFIED`，不是 release pass。

## O1 远端通道与公网 HTTPS 分层诊断

| 层级 | 状态 | 已排除/已观察 | 当前影响 |
|---|---|---|---|
| 桌面自动化初始化 | BLOCKED | 完整 reset 后同一初始化根因已失败至少三次，按停止规则未继续机械重试 | 无法安全操作已登录云控制台 |
| 浏览器登录会话 | UNVERIFIED | 因初始化层不可用，不能把“可能已登录”当作可操作通道 | 无法取得账号后台证据或加临时 key |
| SSH 主机身份 | PARTIAL | 本机 known_hosts 有目标记录；未以关闭校验绕过，可信控制台复核仍缺 | 不能只凭缓存记录扩大授权 |
| SSH 认证 | BLOCKED | `BatchMode` 到 staging 返回 publickey/password denied；ssh-agent 无 identity；未搜索聊天/浏览器/无关目录凭据 | 无法读取主机/数据库或部署 |
| Cloud API/TCCLI | BLOCKED | 本机无 `tccli`/Tencent CLI，也无获授权短期 profile；未安装、未读取 secret | TAT 尚不可调用 |
| 实例网络 | PARTIAL PASS | 公网 TCP 443 可达；不证明应用健康 | 故障不是“整台实例完全不可达” |
| 应用 runtime | UNVERIFIED | 无 shell/health/port/process/env 证据 | 不能定位 upstream 进程或安全重启 |
| TLS/SNI | FAIL | 直接 IP 无正确 SNI 可见目标 LE 证书；正确 `staging-api.cisme.cn` SNI 立即 EOF；没有关闭 TLS 校验 | 真实小程序 HTTPS 与公网 API 阻塞 |
| DNS 外部路径 | UNVERIFIED | 本机 resolver 受代理映射影响；固定 IP 诊断不冒充正常 DNS 成功 | 需外部网络 + 正确 SNI/DNS 复证 |

受控替代路径已核验 Tencent Cloud 官方 [TAT CAM](https://cloud.tencent.com/document/product/1340/56294)（更新 2026-06-02）、[免登录执行命令](https://cloud.tencent.com/document/product/1340/51946)（更新 2025-06-05）和 [TCCLI 凭证管理](https://cloud.tencent.com/document/product/440/96291)（更新 2026-02-05）：TAT 是地域服务，目标实例需 agent online；命令正文/输出会留存，不能用它传 secret；Lighthouse 也不适合用 TAT 文件输出搬运完整 release。最小方案是 Owner 用短时 STS/CAM，在控制台预创建不可变、普通 `cisme-deploy` 用户执行的单实例命令，仅允许 Describe/Preview/Invoke 精确 CommandId，显式拒绝 `RunCommand`、Create/Modify/Delete、多实例和 root。固定命令只核验 instance marker/hostname/env/数据库名/主机公钥指纹，并追加一枚有限时、禁转发/禁 PTY 的临时 SSH 公钥；随后本地 pin 指纹、上传不可变候选、主机端校验 SHA，完成后由固定撤销命令删除精确公钥并 logout/revoke STS。

远端正式动作的统一停止条件是：实例/region/tag 不是唯一 staging；主机指纹不匹配；运行用户不是受限 deploy 用户；数据库名/role/连接目标或数据可销毁性不明；migration ledger/table list 与实际基线不符；候选 SHA 失败；发现真实数据却准备做 down migration；任何 secret 将进入命令/输出；TLS 修复要求关闭验证。任一命中即停止对应风险动作，不停止本地安全工作。

R1/R2 部署恢复顺序仍是：只读确认远端真实 ledger/schema/runtime/topology → 在明确可销毁的专用 rehearsal 库执行 `29→30→31→30→29→30→31` → 正式 staging 只做受控前向 30–31 → runtime/worker/支持链/retention/502/TLS/性能/final-state → 再以独立候选前向应用 32–34。已有真实写入后不自动 drop table；应用回滚、数据库 down 和数据恢复分别裁决。

## R4-A 实际可操作范围

migration 33 只增加六张职责分离表：

- `catalog_product`：第一方商品主数据、source、qualification/publication aggregate state、版本；
- `catalog_sku`：当前显式“每商品一个默认 SKU”的规格身份、active/sort/version；
- `catalog_price`：`CNY` 整数分与独立版本；
- `catalog_inventory_level`：库存权威投影与独立版本；
- `catalog_qualification_decision`：不可变资质判断，`eligible` 强制 evidence reference；
- `catalog_inventory_adjustment`：不可变 before/after/delta/reason/actor/idempotency evidence。

三个预览商品的名称/价格只能追溯到初始提交 `1d334f3` 中的硬编码，冻结 Web 原型中又是不同商品/价格；只有打包图片经过原型资产 SHA 校验。没有商品资质、采购或正式定价来源，所以迁移保留它们用于管理端核验，但必须继续是 pending/draft/stock 0，不能恢复成公共 fallback 或直接转成真实可售商品。

管理 API 逐请求检查 `commerce.product.manage`、`commerce.qualification.manage`、`commerce.inventory.manage`，使用 expected version、row lock、幂等 replay、audit 与 body-free Outbox。production 禁止发布 `synthetic_test`；任何非 eligible 判断都会撤下已发布商品。下架保留商品/证据，不破坏未来历史引用。

同一小程序新增 `pages/management-catalog/index` 与 `pages/management-product/index`：列表分页；基础资料、默认 SKU/价格、资质、发布、库存分组表单；“元”用 regex + `BigInt` 严格转整数分；库存变化必须写理由；服务端确认后才显示成功；退出未保存内容有 guard；版本冲突不静默覆盖；图片只从打包静态 JPG allowlist 选择。Shop/Product 改为服务端目录及直接详情 API，不再用硬编码 fallback 或在首个分页里客户端找详情。

R4-A 当时明确未完成的订单/地址快照/库存预留已经由本次 R4-B 在隔离非生产边界补齐；该历史结论不再用于描述当前源码。仍未完成：多 SKU 新增/停用/排序；真实会员价与运费规则；商品媒体上传；收藏/购物车；真实支付/发货/售后退款；多商户/租户/分账。公共目录只有在服务端非生产订单 gate 开启且商品为 `synthetic_test` 时才返回 `purchaseEnabled:true`；production 启动时对此 gate fail closed。

## R4-B 最小订单闭环

migration 34 在现有目录上增加 `commerce_checkout_quote`、`commerce_order`、`commerce_order_line`、`commerce_order_address`、`commerce_inventory_reservation`、`commerce_order_transition`，并为 `catalog_inventory_level` 增加受 `0 <= reserved_quantity <= stock_on_hand` 约束的预留量。完整决策见 ADR 0009。

- 报价只接受本人、版本匹配的地址以及服务端存在的 SKU/数量，重新读取 `synthetic_test + eligible + published + active`、整数分价格和可用库存；报价时不占库存。
- 创建订单在一个事务中锁定报价和 inventory，复核 product/SKU/price/address 版本与可售状态，保存商品/规格/金额/规则/加密地址快照，建立 active reservation，并把订单置为唯一初态 `pending_payment`。
- 同一用户/业务意图/请求内容使用显式幂等键；完全重试返回原结果，同键异内容拒绝。同一 quote 只能生成一个 order，覆盖“服务端成功但客户端丢响应”。
- 用户取消与 Worker 超时只允许从 `pending_payment` 进入 `cancelled` 或 `expired`，释放 active reservation 一次；订单创建 gate 关闭后仍允许本人取消。
- 本人详情可读取自己的完整配送快照；具备 `commerce.order.read` 的管理员只看到掩码姓名、掩码手机号及省市区。本切片没有发货、退款、改价或管理员改状态能力。
- 订单 line/address/transition 是不可变证据，商品后续改名、改价或下架不会改写历史。Outbox/audit 不含地址和自由文本取消原因。
- 真实会员权益、运费、配送、售后和发票政策尚未批准，所以当前规则明确命名为 synthetic base price、discount=0、shipping=0；不能解释为商业规则已签字。
- 支付状态保持 `paymentAvailable=false` / `WECHAT_PAY_ONBOARDING=IN_PROGRESS`。源码、OpenAPI 和 UI 均无 `paid`、`wx.requestPayment` 或“模拟支付成功”路径。未来接支付前必须先补 provider close/query、晚到支付异常/退款 seam，再允许超时/取消与支付竞争。

原生新增 `pages/checkout/index`、`pages/orders/index`、`pages/order-detail/index`、`pages/management-orders/index`、`pages/management-order-detail/index`。Product 提供 SKU/数量且仅在隔离 gate 下进入 checkout；Profile 增加“我的订单”；管理中心按 `commerce.order.read` 条件显示订单入口。购物车与收藏仍在紧随其后的独立切片，不因本次最小购买闭环被删除。

## bounded R3 实际实现

- `SupportAiProvider` 为 provider-neutral contract；runtime 唯一实例是 `DisabledSupportAiProvider`，状态 `PROVIDER INTEGRATION PENDING`，没有外部模型调用。
- `ApprovedKnowledgeRegistry` 只接受显式 approved、versioned、SHA-256 匹配的知识来源；runtime 列表为空。三个 legacy preview 商品不是批准知识。
- 只读工具必须命中代码 allowlist；model input 如果携带 member/user/principal ID、SQL、query、URL/URI override 即拒绝，scope 只能来自经过鉴权的服务端 context。
- provider output 限制正文长度、0–1 confidence 和有效知识引用；坏哈希、未知引用、无依据、prompt injection、伪造工具、timeout、rate limit 均作为失败，不包装成答案。
- `POST .../ai/suggested-draft` 只允许具备 `support.reply` 且当前持有该人工会话的 operator；结果不持久化、不发送、不改变会话状态。小程序只显示 Provider pending，不播放逐字动画或伪 AI 头像。
- 当前没有 `support_ai_job`、AI Outbox consumer、AI message writer 或外部 tracing。未来真实推理必须在 DB 长事务之外，最终发送前 `FOR UPDATE`/CAS 复核 conversation version/status/ownership，使人工接管必胜。

## One-App UX 改动与证据边界

仍是同一小程序、同一微信身份、同一 Fastify API、同一 PostgreSQL、同一 `authority_grant`。没有第二套官网/管理后台，也没有 WebView 包装；旧 Web Admin 只作为 legacy/internal operations candidate，未成为新商品能力的唯一入口。

本轮已在源码/契约中修复：

- 护理左上角使用明确的对话图标并进入“本人客服”，不会误跳管理员队列；“我的→客服”进入同一本人会话。
- 用户本人客服未读与管理员共享队列未读分离；管理员默认仍是普通用户，只有 authority projection 有能力时“我的”才显示管理中心。
- 原会员账号/资料入口保留在“我的/设置”；商城、我的订单、地址、客服、设置与隐私均在同一信息架构中。
- 用户客服是聊天界面：waiting human/human active/resolved 清楚，消息有 pending/sent/failed/retry，同 client id 重试，明确转人工，增量轮询不重叠并随前后台/身份切换清理。
- 管理客服按队列→会话详情→最小 member context；接管、回复、解决、重开均由服务端 capability/版本控制，AI pending 不伪装在线。
- 管理中心新增原生商品列表/编辑；表单分组、金额/库存/证据/上架分开，保存失败、资质缺证据、版本冲突和未保存离开均有恢复文案。
- Shop/Product 公开浏览不强制登录或会员；长商品名、价格层级、SKU、数量、库存状态与可购买原因有独立展示；详情直接请求 `/v1/catalog/{productCode}`，修复分页后非首屏商品被误判下架的问题。
- Checkout 把地址、数量、SKU 与服务端报价分层展示，报价过期和价格/地址/库存变化要求重新确认；确认按钮只创建待支付订单，明确提示支付仍在接入中。
- My Orders/Order Detail 展示服务端快照和三种真实状态；取消使用版本与稳定幂等键。Management Orders 只读且脱敏，不用“发货/退款”等假按钮冒充运营能力。
- 动态状态栏/微信胶囊/底部安全区变量、44px 最小触摸区、长昵称换行、导航防双击、reduced-motion、堆叠页 Back 与错误滚入视口继续由现有原生边界复用。

首次 current-source 截图揭示了两个真实根因，不是页面渲染慢：DevTools develop 包配置为 `http://127.0.0.1:18080`，当时该端口没有 listener；唯一运行的 `3100` API 连接旧 `cisme` 数据库、没有 migration 34 且订单 gate 关闭。与此同时 DevTools 没有 session，protected routes 正确跳回 Account。把客户端临时改接 `3100` 只会掩盖错误，因此没有采用。

修复后建立了明确的 local-only acceptance seam：`scripts/miniprogram-acceptance.ts --reset` 强制 loopback `cisme_test`、schema 34、随机内存 secret、合成身份/地址/商品/订单/客服/护理/capability，绑定 `127.0.0.1:18080`，payment 仍为 false；它不会进入 Mini runtime 或正式包。DevTools 只预置固定 synthetic external user id，清除旧 session 后由 Account 页面显式点选本地夹具同意并调用真实 `/v1/identity/dev`，没有注入 token。健康截图前 `ready/legal/order boundary/session/protected read` 全部通过。

当前 `7f5fad…` 的 27/27 route-specific success state 均由 WeChat DevTools 0.3.9 原生模拟器打开；每页等待 4 秒并断言 current route、`loading=false`、page error 为空后，保存 482×1044 untouched PNG。有界 console/network 过滤均 0 命中。健康 Review Pack 是 `docs/evidence/visual/review-commercial-r4b-healthy-7f5fad5f-20260911T202609+0800`，46 项校验通过；旧的 `review-commercial-r4b-7f5fad…` 保留为被根因分析推翻的 diagnostic。录屏仍 0、结构化 HAR 仍 0、完整 state/comparison matrix 仍未完成，iOS/Android 设备数组为空。因此 `DEVTOOLS COMPILE/OPEN + AUTHENTICATED HEALTHY BASELINE` 为本地 PASS；完整交互/视觉、iOS、Android 仍 BLOCKED，不能用模拟器基线冒充真机或 staging。

## 本地验证与制品

| 检查 | 结果 |
|---|---|
| TypeScript | API/Worker/Admin + Mini Program PASS |
| Unit | 36 files / 248 tests PASS |
| Integration | 21 files / 101 tests PASS；含 R4-B 双击/丢响应重放/同键异内容、最后一件并发、地址/价格/下架变化、取消/超时释放、权限/脱敏与无 PII 事件 |
| migration lifecycle | empty→34→33→32→31→30→29→28→27→34；rollback guard PASS |
| schema 34 | 81 physical tables、198 indexes、1170 constraints、invalid indexes 0、unvalidated constraints 0、partitioned parents 0、leaf partitions 0 |
| contracts | 34 migrations、71 required tables、75 paths、27 events cross-checked |
| build | API、Worker、Admin production build PASS |
| Mini Program package | 199 files、27 routes、1,707,657 bytes；main 1,343,431 bytes；gate PASS；source SHA `7f5fad5f…` |
| DevTools | 0.3.9 logged in/project reused；local synthetic schema-34 acceptance API 与 Account UI 登录通过；27/27 route open + runtime health PASS；27 张 482×1044 native PNG；console/network bounded filter 0；0 recording、0 device session；无 preview/upload |
| design evidence | structural PASS；healthy current-source baseline available；完整 state/comparison/device gate 仍 `releaseReady=false` |
| dependency audit | production dependency `npm audit --omit=dev --audit-level=high`：0；全量 dev graph：4 high / 0 critical，来自既有 `miniprogram-simulate` 旧 dev-only 链，保持隔离且不进入 runtime |
| SBOM / license | CycloneDX SBOM regenerated；624 dependency rows，unknown license 0；本轮上游仅概念参考、无新增 runtime dependency |
| API SHA-256 | `1261080064772b685301339465cb309f28c6d20fbdab39f23d58f93e027b5879` |
| Worker SHA-256 | `e728887231fc7c04b5f60abb3b67446df5031ce4291b06c6098a33a465e2e2a0` |
| Worker-once SHA-256 | `271007e8a15b4e3a1385ba2feb8dbf3c257d69752e8fecd55dade7c4b966e678` |
| runtime lock SHA-256 | `a51f71d7721523b9c06cd728857d3c23a3aff3f73e6093ac1c48b60cf63e8293` |
| migration 32 SHA-256 | `9ce1b457e2825716be4c11053dbab6c0b374b930c3372d6f1714d6b1289c243e` |
| migration 33 SHA-256 | `fb97d27908efeac5ded127655c3e22f7d9a68640558384fa197d3b386075181b` |
| migration 34 SHA-256 | `ccf189fe6603949574a64e0f5e923632e37629057f44448c3e1e30054f3f3501` |

Commercial Delivery 候选固定使用新目录 `dist/commercial-delivery-r4b-20260911T125000Z`，是 enterprise follow-up 的独立 child，不覆盖原 R1/R2 或 enterprise slice；`MANIFEST.json` 明确 canonical AppID、parent manifest、81/71 双表数、scope/exclusions、production/formal upload/payment/git false、credentials/real-user-data false。源码来自当前受控工作树快照而非伪造的 clean commit；它由逐文件 SHA 绑定，不能把 dirty worktree 说成已 commit 的 release。最终目录中的 `SHA256SUMS` 是唯一逐文件校验清单。

GitHub 外发没有把“scanner 运行过”夸大成安全保证：Gitleaks 8.30.1 的 Darwin arm64 archive 用官方 checksums 文件逐项核验。对整个本地工作目录的扫描在 `.gitleaks.toml` 排除公开 SHA-256 和明确 synthetic idempotency-key 误报后仍发现 50 项，全部位于已经被 `.gitignore` 排除的 `tmp/`（其中包括明确命名的 deployment secret/key 文件）；没有读取、复制、提交或输出其值，也没有删除用户资产。远端原 6 条历史、原工作树、694-file review-source、staged tree、提交后的 7/8 条完整历史均为 0 finding。同步逐文件使用 source manifest allowlist 与精确删除列表，未使用 `git add .`；公开证据补充只包含 27 张合成截图和 1 张联系表。候选仍提供完整源码审阅 ZIP、相对原本地 HEAD 的差异 ZIP、视觉审阅 ZIP 和精确 source/diff manifests；该不可变候选的 `git=false` 描述保留为动作前事实，不回写伪造。

## 验收状态分层

| 层 | 状态 | 精确范围 |
|---|---|---|
| CODE | PASS | 企业 identity/authority、R1/R2、R4-A、R4-B 隔离 pending-payment、bounded R3 本地源码与完整测试；不包含真实 Provider、真实支付、履约或退款 |
| PACKAGE | PASS LOCAL IMMUTABLE CANDIDATE | parent 240 项及旧 follow-up 266 项保持不可变；独立 `commercial-delivery-r4b-20260911T125000Z` 含 1608 项逐项 SHA、3 个可直接上传 ZIP、source/diff manifests；内部 checksum、ZIP integrity、artifact Gitleaks 0 finding；未部署 |
| GITHUB DEVELOPMENT SOURCE | PASS PUBLIC | 现有 `Eysn0130/cisme_app` 原 6 条历史保留；普通提交 `d5b0e9b` + 合成视觉证据补充 `652ca35`；匿名读取回验通过；Actions run `34603405920` 全绿；不等于部署或发布 |
| SCHEMA REHEARSAL | PASS | 本地 disposable：R1/R2 指定 29↔31 往返通过；完整 migration lifecycle 到 34 通过；远端 rehearsal 不在此 PASS 内 |
| REMOTE STAGING | BLOCKED | 无授权 shell/TAT；remote ledger、migration、runtime、Worker、legal publication、SNI 修复均未执行 |
| WECHAT SUBJECT / CAPABILITIES | PARTIAL / EXTERNAL IN PROGRESS | 企业名/新 AppID 是 OWNER-CONFIRMED；认证与支付 onboarding 为 IN_PROGRESS；备案仍 PENDING；账号后台配置、真实接口、域名/类目/模板/内容安全仍需平台证据 |
| LEGAL / PRIVACY | UNVERIFIED | 本地新企业 staging draft 和 inventory 有证据；远端/正式生效版本、联系渠道、retention policy、微信后台声明未闭合 |
| DEVTOOLS COMPILE / OPEN | PASS LOCAL SYNTHETIC | 当前 `7f5fad…`、canonical AppID、schema-34 loopback API、真实 Account dev-login 会话；27/27 route open 和健康断言通过；不是 staging 或真机 |
| DEVTOOLS NATIVE BASELINE | PASS LOCAL SYNTHETIC | 27/27 当前源码 success-state 原生帧、46 checksum、视觉总览人工复核无“全在登录/同步中”的旧故障；旧诊断包不计入通过 |
| DEVTOOLS INTERACTION / FULL VISUAL | BLOCKED | 0 录屏、0 structured HAR；loading/empty/error/unauthorized/long-copy/keyboard/modal/scroll/back 与多视口 comparison matrices 未闭合 |
| IOS | BLOCKED | 无当前 SHA 的设备页面帧、登录、键盘、权限、弱网和业务网络证据 |
| ANDROID | BLOCKED | 同上 |
| PERFORMANCE — LOCAL R1/R2 | PASS | parent slice 的本地 staging-profile HTTP 25 samples/path、0 errors；support first-message p95 11.76ms，poll p95 3.16ms，SQL p95 1.24ms；只属于旧 parent 本地基线 |
| PERFORMANCE — LOCAL FOLLOW-UP | UNVERIFIED | R4-A/R4-B/R3 完整功能测试通过，但未重跑当前订单/页面独立容量与延迟 profile，不能继承旧数字 |
| PERFORMANCE — REMOTE SERVER | BLOCKED | 无授权远端通道，未压测 |
| PERFORMANCE — PUBLIC HTTP | BLOCKED | 正确 SNI TLS 失败，未压测 |
| PERFORMANCE — DEVICE E2E | BLOCKED | 无 iOS/Android 当前源码会话 |
| PRODUCTION RELEASE | NOT APPLICABLE | 本轮未授权、未尝试；认证/备案/类目/法务/设备/支付等发布门禁均未关闭 |

所以当前总验收是：`LOCAL CODE/SCHEMA/PACKAGE PASS + DEVTOOLS HEALTHY BASELINE PASS + FULL INTERACTION/DEVICE QA BLOCKED + REMOTE STAGING BLOCKED`，不是全部 staging verified。R4-A 是本地目录 PASS；R4-B 是隔离 pending-payment 域 PASS，不是已能收款/履约的商城；R3 是 offline boundary PASS，不是真实 AI。

## 上游核验、许可与 CISME 落点

所有下列项目都区分“概念参考”与“直接复制”。本轮没有从这些上游复制源代码，没有新增 Chatwoot/Medusa/LangGraph/TDesign/WeChat Pay runtime dependency；因此没有把受限代码翻译后当自研，也没有产生新的上游 NOTICE 义务。现有 `miniprogram-simulate` 仍按 lockfile/SBOM/license report 管理。

| 上游固定点 | 核验路径 | 许可/例外 | 借鉴范围 | CISME 落点 | 依赖/测试结果 |
|---|---|---|---|---|---|
| Chatwoot v4.17.1 `b354a9550e1fb59fa537a9c384232cb076213e72` | `app/models/conversation.rb`、`app/models/message.rb`、`app/services/conversations/assignment_service.rb`、非 enterprise controller/tests | 根目录 MIT；`enterprise/` 为专有许可，明确未用 | conversation/assignee/message role、pending/resolved/reopen、last-seen、bot handoff 概念 | `supportService.ts`、migration 31、ADR 0004/0006、support integration tests | 概念改写；0 新依赖；未复制代码 |
| Medusa v2.20.1 `0ed927bdb7a396a8fd5f6447ed69b7b354b150d3` | `packages/modules/product/src/models/product.ts`、`product-variant.ts`；`pricing/src/models/price.ts`；`inventory/src/models/inventory-level.ts`、`reservation-item.ts`；order domain models/workflows | 根目录 MIT；`ENTERPRISE-LICENSE.md` 列出的 enterprise RBAC/SSO 等专有材料未用 | product/SKU/price/inventory 分责及 reservation/order invariant 概念 | migrations 33–34、`commerceCatalog.ts`、`commerceOrders.ts`、ADR 0005/0009、commerce integration tests | 概念改写；0 新依赖；未复制 enterprise/schema/runtime |
| LangGraph.js 1.4.14 `9ae75600dd84d6b2bc736e33baaf66a556d61c49` | `libs/langgraph-core/src/graph/state.ts`、`prebuilt/tool_node.ts`、`libs/checkpoint/src/base.ts` | MIT | 评估 state/tool/checkpoint 的价值与删除/权限成本 | ADR 0008：当前不引入；使用既有状态机/Worker + provider/tool boundary | 0 依赖；offline adversarial tests |
| TDesign Mini Program 1.16.1 `e6f1ec7693694c1ad647746f8b7beeb32dbd0387` | `packages/components/form`、`input`、`textarea`、`stepper`、`dialog`、`cell`、`loading`、`empty` | MIT | 分组表单、反馈/空态/对话框交互参考 | 原生 management catalog/product WXML/WXSS；继续 CISME tokens | 0 新依赖；未迁框架 |
| `wechat-miniprogram/miniprogram-demo` `0fe5c7df8e90582dd0b89e283df7fe32e04413f9` | `miniprogram/packageWeStoreCoffee/pages/sku-picker`、`packageComponent/pages/form`、`packageAPI/pages/network/request`、`upload-file`、`request-payment` | MIT | 原生 API 生命周期和 SKU/form 模式；demo 存在不等于账号有资格 | 当前只落表单/请求生命周期；支付/上传仍关闭 | 概念参考；未复制 demo；route-open 不冒充设备证据 |
| `miniprogram-simulate` 1.6.2 `fa11f619e3abff9d111c9c8c1abacc26e6fed334` | package README/runtime | MIT；其旧 Less/PostCSS/image-size dev-only 链仍有 4 个 high audit finding | 可信本地组件 fixture | 现有 unit harness，不参与视觉/真机结论 | 已有 dev dependency，非本轮新增；必须继续隔离 trusted fixture |
| `wechatpay-apiv3/wechatpay-go` v0.2.21 `6dbd7ce2ec5967ac2de5fa053479b411967b9c29` | `core/auth/validators/wechat_pay_notify_validator.go`、`core/notify`、`services/payments/jsapi`、`services/refunddomestic` | Apache-2.0 | 后续验签/通知/JSAPI/close/query/refund 协议测试思路 | ADR 0009 只固定 payment seam；当前无 provider/验签/通知/paid route | 0 依赖；未复制 Go；真实支付仍由独立切片和权限门禁控制 |
| `TencentCloud/tencentcloud-cli` master `708ab6745b6ba491078ec90a2c86c256f40a5b98` | `tccli/`、README、TAT API/CAM/credential docs | Apache-2.0 | 受限 STS/CAM + TAT 运维通道 | 仅 O1 recovery design，不是业务依赖 | 本机未安装/未配置；不获得任意云权限 |

## 下一步最小切片

当前第一批的最小订单闭环已经按 Owner 最新指令命名为 **R4-B**，这明确替代旧文档中把“收藏 + 购物车”称作 R4-B 的排序。独立 Commercial Delivery 制品、安全外发准备和现有仓库 PUBLIC 开发基线已经完成；下一依赖链是：恢复精确 staging 通道并从真实 ledger 规划 30–34；修复正常 DNS+SNI 公网路径；完成真实 `wx.login`、关键交互录屏、多状态矩阵和 iOS/Android 证据。紧随其后的业务切片仍为收藏 + 认证用户购物车（购物车不长期占库存），没有从正式范围删除；支付、履约、售后退款在 onboarding 完成并获得各自动作授权后再进入。真实 AI 继续等待 Provider/处理者/预算/知识审批。

## Owner 唯一行动表

以下是本轮唯一仍需要 Owner 处理的集中清单；GitHub 第 0 项已按 Owner 后续明确指令完成，因此从待办表移除。Secret、私钥、数据库密码、完整 OpenID/session_key、证件、银行资料和真实聊天均只在官方平台或受控运维环境中使用，不贴回线程。

| 事项 | 为什么不能自主完成 | 目标平台/资源 | 所需最小权限或非敏感材料 | 操作步骤 | 预期结果 | 影响范围 | 撤销方式 |
|---|---|---|---|---|---|---|---|
| 1. 新企业账号证据包 | 需要账号后台身份与企业管理员真实性确认 | 微信公众平台：基本信息、成员管理、开发设置、版本、认证、类目、备案 | AppID、主体全名、原始 ID、未发布/认证/备案状态、管理员/开发者/体验成员人数与角色；个人微信号/证件/secret 遮挡 | 在 `wx4eac2d4fb11d299b` 后台逐页核对；只导出/截图非敏感字段并记录时间 | E0 从 OWNER-CONFIRMED 升级为 PLATFORM-VERIFIED；旧个人 AppID 继续 UNKNOWN 也可接受 | 只读账号核验，不改 runtime | 删除本地临时截图；平台无状态变更可撤销 |
| 2. 一次性恢复 staging 控制通道 | 当前无 SSH identity/tccli；公网 DNS 显示 `api.cisme.cn→124.223.74.198`、`staging-api.cisme.cn→150.158.39.74`，不能擅自假定同机或猜部署 | 腾讯云 `ap-shanghai`；已知候选 Lighthouse `lhins-61ikz4mi` / `cisme-app-shanghai` / `124.223.74.198`，先只读证明它是否为允许目标；`150.158.39.74` 只作 DNS 事实，未映射前不得操作 | 主账号 UIN、目标实例/域名映射、TAT agent Online、普通 `cisme-deploy` 用户、经 Owner 核验的 ED25519 host fingerprint、固定追加/删除临时 key 的 CommandId；短时 STS 仅允许 Describe + Preview/Invoke 这两个精确 CommandId/单实例 | Owner 在控制台预建不可变非 root 命令；显式拒绝 `RunCommand`、Create/Modify/Delete、多实例、production/COS；第一条只输出 allowlist marker/hostname/env name/database name/service user/fingerprint，确认映射后才追加有限时禁转发/禁 PTY key；本地 pin 指纹 | 恢复可审计 read-only→受控 staging 通道，并先解决两 IP/实例映射；获得 invocation/request/exit 证据 | 仅经 marker 证明的 staging 单实例；若 `lhins-61ikz4mi` 是 production 或映射不符立即停止 | 固定删除命令移除精确公钥；cancel 未完成 invocation；logout/revoke STS；删除专用 profile并复核 key 不存在 |
| 3. R1/R2 + follow-up staging 验收和 SNI 修复 | 需真实远端数据库/进程/Nginx/证书证据 | staging PostgreSQL、API/Worker、Nginx、`staging-api.cisme.cn` | 父/子 `MANIFEST.json` 与 `SHA256SUMS`、实际 ledger/table list、服务用户/端口、可销毁 rehearsal 库证明；不提供 DATABASE_URL | 先只读核验；只在专用可销毁库跑 29↔31；正式 staging 前向 30–31，再用独立候选前向 32–34；验证 health/worker/outbox/retention/502；修 SNI 并用正常 DNS+SNI 外测 | R1/R2 可从 remote BLOCKED 转为 SERVER STAGING PASS；follow-up 有独立 staging 证据 | staging runtime/schema/TLS；无 production | SHA/基线不符立即停；有真实写入时优先旧应用兼容或 forward fix；应用回滚、DB down、数据恢复分开；删除临时 key |
| 4. 新 AppID 平台域名与真实登录 | 账号域名和 code2Session 只能由当前 AppID/secret/真实微信调用证明 | 微信公众平台服务器域名 + 当前小程序 + staging API | request/upload/download/socket 四栏脱敏截图；未用栏位写空/N/A；时间、AppID、结果码、内部 trace ID | SNI 正常后只配置真实使用的 request 域名；关闭 DevTools 域名绕过；执行一次 `wx.login→服务端 code2Session`；遮挡 code/OpenID/session_key | 登录 namespace 和真实 request 链从 local PASS 升级为 account/runtime evidence | 新企业 AppID staging 登录；不授业务 admin | 删除测试 session/合成 identity 按 run ID；若域名错误恢复到审核前配置；绝不轮换/回传 secret |
| 5. 两名验收人员最小业务授权 | 微信后台角色不能替代 CISME capability，完整 member ID 不应在聊天传递 | staging PostgreSQL 上的 `authority_grant` 受控脚本 | 两人先通过新 AppID 登录；完整 member UUID 只在受控终端；需要的 capability、environment、expiry、grant source | 用 `npm run authority:manage -- grant ...` 每次授一个 staging capability，先短期；测试 revoke/expiry；报告只留 grant ID/capability/environment/expiry/actor | 解锁必要商品/客服验收且可追溯；不自动获得退款/隐私/库存等无关权限 | 仅两名 staging synthetic/test operators | 对每个 grant 执行精确 revoke，验证 API/轮询/恢复立刻失权 |
| 6. 当前源码的交互/设备证据 | 27/27 DevTools 健康 baseline 已自主完成；剩余动作需要手机、真人微信权限/键盘操作和体验成员资格 | WeChat DevTools 0.3.9、iOS、Android | 当前 SHA、27 路由、synthetic fixture、工具/设备/OS/微信版本；无需正式上传；必要时只申请体验版而非发布 | 基于已通过的健康 preflight 录制客服发送/丢响应重试、管理员接管/撤权、商品保存冲突、订单 quote/create/replay/cancel/expiry；iOS/Android 各做安全区、字体、键盘、权限拒绝、弱网和返回；绑定 trace/time/role | 逐格关闭 interaction/state/device matrices；当前 27 张 simulator success baseline 保留，不重复采集同一状态 | 只测试/体验环境；不 formal upload、不真实付款 | 删除 synthetic fixture/敏感临时证据，移除体验成员，停止调试会话；不杀非本任务进程 |
| 7. 认证、备案、类目/商品资质与企业版法务确认 | 必须企业管理员提交材料、扫码/签署/缴费并对真实性负责 | 微信公众平台认证/备案/类目；公司法务/运营 | 官方平台直接填营业执照/负责人/必要专项材料；线程只留状态/受理号/脱敏 evidence ref；公司确认联系渠道与 retention | 完成微信认证；并行备案；按第一方商品/UGC/护理/AI 真实范围选类目；每个商品建立资质 evidence；批准企业版 terms/privacy/售后/保存政策后再发布 | 解锁手机号、正式审核准备和商品平台门禁；仍不自动解锁支付 | 账号/发布合规；本地工程不被无关阻塞 | 未提交可撤草稿；提交后按官方更正/撤回流程；代码 gate 在证据失效时回到 blocked/unpublish |
| 8. 真实支付（仅未来进入支付切片时） | 需要企业商户关系、密钥材料与资金风险授权 | 微信支付商户平台 + 新 AppID | 已认证状态、商户号/JSAPI 权限/经营场景/绑定状态的脱敏证据；APIv3 key/私钥/证书只进密钥系统 | 申请/选择企业商户号→开通小程序支付→绑定新 AppID→配置回调/技术负责人→用授权 sandbox 做验签、解密、金额/币种/merchant/AppID/order、重放/重复通知、查单/对账 | 才能启动独立 order/payment slice；客户端 success 永不直接写 PAID | 交易/资金；不使用真实资金开发测试 | 关闭支付 capability/业务开关、解绑或撤 API 配置按官方流程；保留订单事实，不能删除账本假装回滚 |
| 9. 真实 AI（仅未来批准时） | 当前无 Provider、DPA/地域/保留、预算、批准知识和生成内容合规结论 | 选定 Provider + 公司隐私/安全/运营评审 | Provider 决策、处理者/DPA 编号、数据地域/保留、预算、知识版本 SHA、风险分级与 synthetic red-team 摘要；无真实聊天 | 批准后另做 durable AI job/consumer + transaction-outside inference + final CAS；先 synthetic staging，再小流量、明确 AI 标识/转人工 | bounded R3 才进入 provider integration；当前接口继续 pending | 仅低风险建议/答疑；禁止退款/发货/改订单/库存/隐私等写工具 | provider switch off、撤 credentials/processor purpose、停止 consumer；保留人工会话，不发送迟到 AI 回复 |

GitHub 第 0 项已完成，未新建仓库、未 force push、未改写历史。完成第 2–4 项之前不能安全操作或宣布 staging；完成第 6–7 项之前不能正式上传/发布；完成第 8/9 项之前，支付与真实 AI 必须继续关闭。
