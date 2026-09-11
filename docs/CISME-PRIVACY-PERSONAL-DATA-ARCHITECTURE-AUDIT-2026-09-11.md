# CISME Privacy / Personal Data Architecture Audit

审计日期：2026-09-11  
适用范围：CISME 最终产品规划、当前微信小程序源码、Fastify API、PostgreSQL migrations、OpenAPI、运营后台、日志与备份配置。  
结论性质：产品与工程控制基线，不替代中国执业律师、税务负责人或微信平台审核的最终意见。

## 1. 结论

CISME 的目标数据能力应覆盖会员、护理、完整社区、完整商城、微信支付、物流、售后、人工客服与可选邮箱通知；但当前实际实现仍是会员/护理/邀请投稿、地址簿、少量 dev/test 社区互动和数据权利“受理记录”。二者不能混写：最终范围是施工边界，当前真实处理才是现阶段隐私指引和微信后台勾选边界。

当前有四个 P0/P1 级缺口：

1. 审计基线中的投稿页在上传开关关闭时仍会先请求微信隐私授权并调用图片选择，随后才由服务端拒绝上传；这会产生没有当前业务结果的相册/摄像头访问。staging API 已返回权威的上传关闭投影并拒绝授权，但配套的小程序前置阻断仅进入审计包、未上传，且尚无 iOS/Android 真机证明，因此客户端闭环仍未完成。
2. staging 已部署不可变权利事件、期限/版本控制、plan-only 导出任务和 dry-run 擦除任务，并通过合成验证；它们刻意没有批准或执行入口，不会读取导出内容、删除数据或关闭账号，因此仍不能宣称权利操作已完成。
3. staging 已部署 8 表的 closed-by-construction 正式 UGC 基础，但没有可调用 API、小程序页面、审核 worker、权利执行映射或开放资格；`community` 在 API 与数据库两层均保持关闭。商品 SKU、购物车、订单、支付、物流、退款、客服和邮箱通知域仍不存在；不得用旧投稿表、仅有表结构或静态商品目录冒充可用能力。
4. 保存期限目前主要写在文字中，没有可执行的 retention policy、legal hold、purge job、export job、erasure job 和对象/备份删除证明。运行日志也未在仓库内形成可核验的 6 个月轮转策略。

因此上线原则固定为：

> 需求确定 → 字段与用途设计 → 功能实现 → 权限/同意机制 → 隐私文档 → 微信后台类别 → staging 验证 → 开放开关。

任何阶段均不得反向用“以后可能需要”支持提前采集。

## 2. 审计依据与事实边界

### 2.1 当前实现事实

- 当前工作树与已部署 staging 均为 29 条 migrations、65 个业务/控制表（另有 `schema_migration`）；staging 已从 27 条 migration 的隔离基线继承 9 个隐私生命周期基础表和 8 个正式 UGC 基础表。
- `/v1/catalog` 是静态只读目录；`implementedTransactionProfiles` 为空，结算、订单、支付、物流、退款没有实现。
- `CommunityService` 与 `CommunityAccess` 只允许 development/test；staging/production 的品牌预览互动被服务端关闭。现有 `community_comment`、`community_reaction`、`community_follow` 不是正式公众 UGC 域；已部署 staging 的 `ugc_*` / `moderation_*` 与这些预览表物理隔离，`community` emergency switch 在应用与数据库两层均不可开启，且没有 `/v1/ugc/*` 路由。
- 小程序当前使用 `chooseAvatar`、昵称填写、`getPhoneNumber`、`chooseAddress`、`getClipboardData`、`chooseMedia` 和本地 `getDeviceInfo`；未使用定位、麦克风、通讯录写入、日历写入、相册写入或身份证采集 API。
- 手机号和收货地址分别使用 AES-GCM 密文与 HMAC 盲索引；头像被规范化为 128px JPEG data URL。OpenID/UnionID 与会员编号仍是明文关系键。
- staging 隐私请求可提交、查看、由授权人员版本化回复，并由 `review_lead` 建立非执行计划；计划只创建 `planned` 记录，不读取导出内容、不删除数据、不注销账号。
- 当前 staging 法律文档是用户已批准并发布的 terms v4 / privacy v5；本地待后续一致性发布稿为 privacy v6，增加了设备适配事实。不得在新功能实现前把商城、客服、邮箱或正式社区写成“已收集”。
- 当前 staging 上传开关关闭、COS 未启用；生产不在本审计变更范围。

### 2.2 法规与平台控制基线

- 《个人信息保护法》要求目的明确、最小必要、处理前清晰告知、便捷撤回；敏感个人信息须有特定目的、充分必要性、严格保护并取得单独同意。参见[中国人大网全文](https://www.npc.gov.cn/npc/c2/c30834/202108/t20210820_313088.html)。
- 《网络数据安全管理条例》要求隐私规则列明目的、方式、种类、期限、权利路径；受托处理记录至少保存 3 年；注销或收集到非必要信息时应删除或匿名化，不能删除时只允许存储和必要安全保护。参见[国务院令第 790 号](https://app.www.gov.cn/govdata/gov/202409/30/520076/article.html)。
- 2025 年修正的《网络安全法》要求按规定留存网络日志不少于 6 个月，并要求对用户发布信息进行管理、处置和保存必要记录。参见[中央网信办发布的现行文本](https://www.cac.gov.cn/2025-12/29/c_1768735112911946.htm)。
- 《电子商务法》要求电子商务经营者提供便捷的查询、更正、删除和注销路径；注销后应立即删除，法律或约定需要继续保存的除外。交易记录“不少于 3 年”的直接条文对象含平台经营者；CISME 作为自营商户的税务、会计、消费者争议等具体期限需在 P2 上线前由法务/财务确认。参见[中国人大网全文](https://www.npc.gov.cn/WZWSREL3pncmR3L25wYy9sZnp0L3JseXcvMjAxOC0wOC8zMS9jb250ZW50XzIwNjA4MjcuaHRt)和[市场监管总局文本](https://www.samr.gov.cn/zfjcj/tzgg/art/2023/art_d337c3291e8b40459ca03dea54395856.html)。
- 微信支付的客户端回调不能作为支付成功事实；商户端应验证支付通知并主动查单。退款受理也不等于退款完成，须以退款通知/查单为准。参见[小程序支付开发指引](https://pay.wechatpay.cn/doc/v3/merchant/4012791911)、[支付成功通知](https://pay.wechatpay.cn/doc/v3/merchant/4012791902)与[退款开发指引](https://pay.wechatpay.cn/doc/v3/merchant/4013071031)。
- 微信隐私接口必须与管理后台声明及用户授权一致；代码扫描可能遗漏隐蔽调用，仍须按真实 API 使用补齐。参见[腾讯云对微信官方规则的适配说明](https://cloud.tencent.cn/document/product/1301/97930)。

## 3. 个人信息处理矩阵

“当前微信后台”是现在应声明/勾选的状态，不是最终产品愿望。`是（条件）`表示源码存在且仅在用户主动触发和服务端能力开启时处理；`未来`表示功能完成前不得勾选、不得收集。期限是工程基线，涉及交易、争议、财税、内容违法处置或司法要求时以经确认的法定义务为准。

| 信息类型 | 产品功能 | 最终需要 | 当前实现 | 当前微信后台 | API / 字段 | 存储位置 | 保存期限基线 | 用户如何删除 | 同意要求 | 第三方接收方 | 上线前剩余施工 |
|---|---|---:|---|---|---|---|---|---|---|---|---|
| 微信昵称、头像 | 会员资料、社区作者展示 | 是 | 已实现；社区展示需另行审核 | 是，标准类别 | `chooseAvatar`/nickname；`member.display_name`、`member_profile.avatar_data_url` | 上海 PostgreSQL；本机短期缓存 | 账号存续；替换/移除后在线值立即覆盖，旧缓存下次启动清理 | 设置页修改/移除；注销流程清除 | 登录基础告知；公开展示单独、可撤回选择 | 微信；腾讯云基础设施 | 完成注销执行与缓存/备份到期证明 |
| 手机号 | 会员联系、账号冲突核验、未来订单/售后 | 是 | 已实现为选填微信授权 | 是，标准类别 | `getPhoneNumber`；`member_contact.phone_encrypted/phone_hmac` | 上海 PostgreSQL 加密 | 绑定期间；解绑即删密文/盲索引；授权消费与安全审计按证据期限 | 设置页解绑；注销流程清除 | 用户主动点击的明示授权；普通浏览非必需 | 微信；腾讯云基础设施 | 验证 staging 实际授权；定义订单快照与客服副本删除边界 |
| 收货地址 | 地址簿、下单、履约、售后 | 是 | 地址簿已实现；订单/物流未实现 | 是，标准“地址/收货地址” | `chooseAddress`；`member_delivery_address.encrypted_payload` | 上海 PostgreSQL 加密；未保存草稿仅本机 | 地址簿保留到用户删除/注销；订单地址快照按交易法定期限 | 设置页修改/软删；P2 后地址簿删除不改历史订单快照 | 主动导入/填写；履约使用基于合同必要性并告知 | 微信；未来物流商仅接收履约最小字段 | 软删物理清理；订单快照隔离；物流处理者合同和披露 |
| 邮箱 | 服务通知、账号安全、可选订阅 | 是 | 未实现 | 未来，标准“邮箱” | 目标 `member_email`、verification、subscription | 上海 PostgreSQL 加密/规范化 HMAC | 验证关系存续；退订后立即停止营销，必要服务地址移除后删除 | 资料页删除；每封营销邮件一键退订 | 填写与验证明示；营销需独立 opt-in，不与服务通知捆绑 | 待选境内邮件服务商 | P4 完成验证、服务/营销双通道、退订、退信、处理者评估 |
| OpenID / UnionID、会员编号 | 微信登录、账号唯一性 | 是 | 已实现 | 是，自定义“微信登录标识及会员编号” | `jscode2session`；`wechat_identity.openid/unionid`、`member.id` | 上海 PostgreSQL | 账号存续；注销后删除身份映射，必要反滥用仅保留不可逆 tombstone | 注销执行 | 登录所必需；不得用不同意可选资料阻断公开浏览 | 微信；腾讯云基础设施 | P1 注销状态机、不可逆 tombstone、会话吊销与证明 |
| 选填微信号 | 人工联系 | 是 | 已实现资料字段 | 是，自定义“选填微信号” | `member_profile.wechat_handle` | 上海 PostgreSQL | 用户保留期间 | 设置页清空；注销清除 | 主动填写；不可作为登录或公开字段 | 仅授权客服人员；腾讯云基础设施 | 增加字段级访问审计与客服 RBAC |
| 护理文字记录 | 护理周期、步骤、自我感受与回看 | 是 | 已实现结构化步骤和自我感受 | 是，自定义“护理记录” | `care_cycle`、`care_record`、`care_record_step` | 上海 PostgreSQL | 用户需要回看期间；删除/注销后按未完成活动与争议最小保留 | 数据权利执行；未来逐条删除 | 服务合同/用户主动录入；若演进为医疗健康信息须单独同意和 PIPIA | 腾讯云基础设施 | 当前不允许诊断病历；增加逐条删除、导出与敏感字段拦截 |
| 投稿链接、账号、披露、草稿 | 邀请投稿、人工审核 | 是（旧活动域） | 已实现 | 是，可使用标准“发布内容”并在补充文档限定范围 | `submission.*`、`review_case/action` | 上海 PostgreSQL | 草稿 30 天无活动；审核/争议结束后 180 天；依法需留存的证据隔离 | 草稿删除、撤回精选；现仅部分媒体删除 | 存储/人工审核明示；公开精选独立可撤回 | 授权审核人员；腾讯云基础设施 | retention job、草稿删除、完整导出/擦除映射 |
| 用户发布文字 | 正式社区帖子/评论 | 是 | 本地仅有关闭态 `ugc_post/revision/comment` schema；评论预览仅 dev/test；无正式 API/UI | 未来；功能开放前标准“发布内容” | 本地 `ugc_post`、`ugc_post_revision`、`ugc_comment` | PostgreSQL；发布投影 | 草稿 30 天；已发布至用户删除；处置证据 180 天或法定期限 | 帖子/评论自助删除；注销时匿名化或删除规则可选且告知 | 发布动作明示；公开展示是功能本身；敏感内容另行治理 | 内容审核服务商待选；腾讯云 | P1 API/审核/举报/删除/注销映射、未成年人保护与真机验证 |
| 选中的照片或视频 | 社区发布、客服/售后附件、旧投稿证据 | 是 | `chooseMedia` 仅图片；staging 上传关闭 | 是（条件），标准类别 | `wx.chooseMedia`；目标 `media_asset/media_binding` | 当前不存原图；未来私有 COS | 未提交临时文件立即清；草稿媒体 30 天；发布/工单期间；删除后对象清理队列 | 草稿/帖子/工单删除；账号擦除 | 调用前微信隐私授权；上传/公开目的分层告知 | 微信；未来 COS；审核商待选 | P0 前置能力阻断；Gate D 私有 COS、病毒/内容审查、对象删除证明 |
| 摄像头 | 用户主动拍摄社区/客服附件 | 是（条件） | `chooseMedia sourceType` 包含 camera；staging 上传关闭 | 是（条件），标准类别 | `wx.chooseMedia` | 当前仅微信本机临时文件 | 未选择/未提交不持久化 | 取消即不保存；已上传按媒体规则 | 每次用户主动选择；拒绝不影响文字功能 | 微信；未来 COS | 与相册选择分开提示；无后台采集；真机拒绝/恢复测试 |
| 设备适配信息 | 页面兼容、降级动画 | 是 | 本机读取 platform/benchmark，不传业务 API | 是，标准“设备信息”（说明仅本地处理） | `wx.getDeviceInfo` | 仅内存 | 页面/进程生命周期 | 退出即消失 | 基础功能必要性告知，不做画像 | 微信运行环境 | 建立自动测试保证不随请求上送、不写日志 |
| 剪贴板内容 | 地址快捷解析 | 是（条件） | 已实现，用户点击后最多读取 500 字并本机解析 | 是，标准“剪贴板” | `wx.getClipboardData`；未保存前无服务端字段 | 本机草稿；保存后拆分入地址密文 | 未保存即不持久；保存后按地址期限 | 取消草稿/删除地址 | 用户主动点击；不得后台读取 | 微信 | 真机验证拒绝、空内容、超长和不保存路径 |
| 所关注账号 | 社区关注流 | 是 | dev/test 预览 API；正式 `ugc_follow` 因无 runtime 而从本轮 migration 推迟 | 未来，标准类别 | 未来 `ugc_follow`；旧预览 `community_follow` | PostgreSQL | 关注关系存续 | 取消关注；注销清除 | 用户主动操作，通常无需单独同意 | 腾讯云；无外部接收方 | P1 确定 API、作者关闭/匿名化、导出/删除与速率限制后再迁移 |
| 点赞、评论、收藏、保存内容 | 社区互动与历史 | 是 | 正式评论仅有关闭态 schema；点赞/关注/收藏均因无 runtime 从本轮 migration 推迟 | 未来，自定义“社区内容及互动记录” | 本地 `ugc_comment`；未来 reaction / saved-item 关系 | PostgreSQL | 关系存续；删除账号时清除；评论处置证据按治理期限 | 取消点赞/收藏、删评论、清历史 | 主动操作；公开评论需明确可见性 | 内容审核商待选；腾讯云 | P1 API、批量权利执行、聚合计数重算与滥用控制确定后再迁移关系表 |
| 社区草稿 | 断点续写 | 是 | 本地 `ugc_post.state=draft` + immutable revision 基础；无 API/UI/过期任务 | 未来，合并进自定义社区类别 | 本地 `ugc_post`、`ugc_post_revision`、`ugc_post_media` | PostgreSQL/COS 私有前缀 | 最后编辑后 30 天自动清理，可配置提醒 | 草稿列表删除；注销清除 | 主动保存；不可公开 | 腾讯云/COS | P1 自动过期、媒体引用 GC、并发版本与草稿 UI |
| 社区举报与审核记录 | 内容安全、申诉 | 是 | 本地有关闭态 `ugc_report` / `moderation_*` 基础；申诉表已因产品状态机未定义而推迟；无 API/队列/处置执行 | 未来，自定义社区类别；补充文档列明治理 | 本地 `ugc_report`、`moderation_case/action` | PostgreSQL；证据附件 COS | 结案后 180 天基线；违法处置记录按法定义务 | 举报人可申请删除非必要说明；治理证据限制处理 | 举报为主动提交；涉及他人信息时提示最小化 | 审核商待选；主管机关依法要求时 | P1 目标存在性校验、四眼权限、举报速率限制、申诉/屏蔽、证据 legal hold |
| 商品收藏 | 商城个性状态 | 是 | 未实现 | 未来，自定义“商城浏览与意向状态” | 目标 `product_favorite` | PostgreSQL | 关系存续 | 取消收藏/注销清除 | 主动操作 | 腾讯云 | P2 API、页面、导出/删除 |
| 购物车 | 待购商品状态 | 是 | 未实现 | 未来，自定义“商城浏览与意向状态” | 目标 `cart/cart_item` | PostgreSQL | 最后活动后 90 天或账号存续内较短者 | 移除/清空购物车/注销 | 履行用户请求所需 | 腾讯云 | P2 SKU 版本、价格不作为结算权威、过期清理 |
| 订单信息 | 下单、履约、售后、对账 | 是 | 未实现 | 未来，标准“订单信息” | 目标 `commerce_order/order_item/order_address_snapshot` | PostgreSQL | 交易完成后至少按适用法律/财税期限；上线前法务财务确认 | 账号注销后去标识；法定期限内限制处理而非删除 | 履行合同所必需并告知 | 微信支付、物流商、腾讯云；按订单最小提供 | P2 全状态机、快照、发票/财税边界、访问审计 |
| 支付状态与微信交易标识 | 支付确认、对账、退款 | 是 | 未实现 | 未来，通常归入标准“订单信息”；补充文档细分支付记录 | 目标 `payment_attempt/payment_event`；仅保存 `transaction_id/out_trade_no/state/amount/time` | PostgreSQL；支付凭据仅密钥系统 | 与订单/财税/争议期限一致 | 法定期限内限制处理；期满去标识/删除 | 履行合同；金融账户等敏感信息若实际处理则单独同意/PIPIA | 微信支付 | P2 APIv3 签名验签、AES-GCM 通知解密、主动查单、幂等、对账；禁止存银行卡号/CVV |
| 物流信息 | 发货、追踪、签收 | 是 | 未实现 | 未来，订单信息/自定义“订单履约与物流信息” | 目标 `shipment/shipment_event` | PostgreSQL；物流商系统 | 交易/售后完成后按适用期限 | 法定期限后删除/去标识 | 履行合同；向物流商提供前告知接收方类别 | 待选物流商 | P2 处理者尽调、最小字段、面单脱敏、回调验签、删除接口 |
| 售后、退款信息 | 退换货、退款、争议 | 是 | 未实现 | 未来，标准订单信息 + 自定义客服类别 | 目标 `after_sales_case/refund/refund_event` | PostgreSQL；附件 COS | 结案后按交易/争议法定期限 | 期限内限制处理；期满去标识/删除附件 | 履行合同/法定义务；退款结果不依赖客户端声明 | 微信支付、物流商、腾讯云 | P2 工单状态、退款查单/回调、资损双人复核、审计 |
| 客服咨询文本 | 人工客服、投诉、账号与服务问题 | 是 | R2 本地实现，未部署 | 上线前仍需批准自定义“客服及售后服务信息” | `support_conversation/message` | CISME PostgreSQL；无外部客服平台/COS 附件 | 已声明结案后 180 天但 policy inactive，purge 未实现 | 权利请求；自动清理未实现 | 用户主动发送；首版仅文字 | 无新增处理者 | 上线前法律文本、enforced retention/purge、staging/真机证据；附件/订单投影/SLA 后续 |
| 邮件订阅与发送记录 | 服务/安全/审核/营销通知 | 是 | 未实现 | 未来，自定义“通知订阅与发送记录”或补充文档 | 目标 `notification_subscription/delivery` | PostgreSQL；邮件商最小事件 | 订阅关系至退订；投递日志 180 天；法定证据另行确认 | 退订、删除邮箱；服务通知偏好按允许范围调整 | 营销单独 opt-in；服务通知不得借机营销 | 待选境内邮件服务商 | P4 双通道、模板分类、退订 header、bounce/complaint、处理者合同 |
| 操作/安全日志 | 安全、审计、故障与合规证明 | 是 | 应用有结构化日志与 `audit_log`，但轮转策略未在仓库闭环 | 是，标准“操作日志” | Fastify/Pino；`audit_log`、`idempotency_operation` | Lighthouse journal/files、PostgreSQL；备份副本 | 网络日志不少于 6 个月；业务审计按目的/法定义务分层 | 通常不支持逐条前台删除；期满自动清理，权利回复说明限制 | 安全法定义务/合法权益；日志不得存密钥和内容正文 | 腾讯云基础设施 | 明确 6 个月轮转、字段白名单、IP 最小化、导出/删除审计 |
| 数据权利请求记录 | 查阅、复制、更正、删除、注销、撤回 | 是 | staging 仅受理/回复；本地已有不可变事件、期限/版本与非执行计划 | 是，自定义“数据权利请求记录” | `privacy_request`、`privacy_request_event`、`data_export_job`、`data_erasure_job` | PostgreSQL；未来导出临时私有对象 | 结案后 3 年作为合规证据基线；导出文件 7 天 | 请求人可要求删除非必要说明；证据到期清理 | 用户主动提交；不得要求无关身份证 | 腾讯云；无外部接收方 | P1 批准/执行双人复核、一次性下载、结果清单、失败恢复；当前不得把 planned 当 completed |
| 位置信息 | 附近门店、城市或地图选址 | 条件 | 未实现 | 不勾选 | 未来 `wx.getLocation/chooseLocation` | 尚无 | 尚无 | 尚无 | 实际上线时单独、按次授权；行踪轨迹属敏感信息 | 地图服务商待选 | P5 必要性评估、精度最小化、PIPIA、拒绝替代路径 |
| 麦克风 | 语音客服/语音内容 | 条件 | 未实现 | 不勾选 | 未来 recorder API | 尚无 | 尚无 | 尚无 | 实际录音前单独显著授权 | 语音服务商待选 | P5 录音提示、转写处理者、原音/文本分离期限 |
| 相册（仅写入） | 保存海报/图片到系统相册 | 条件 | 未实现 | 不勾选 | 未来 `saveImageToPhotosAlbum` | 用户设备 | 由用户控制 | 用户系统相册删除 | 调用时系统授权 | 微信/设备系统 | P5 只有真实保存功能上线才申请 |
| 日历（仅写入） | 活动/护理/订单提醒 | 条件 | 未实现 | 不勾选 | 未来日历写入 API | 用户设备 | 由用户控制 | 用户日历删除；应用提供撤销 | 每次写入明确提示 | 微信/设备日历 | P5 只有真实写入上线才申请 |
| 通讯录（仅写入） | 保存客服电话/联系人 | 条件 | 未实现，客服不需要该权限 | 不勾选 | 未来 `addPhoneContact` | 用户设备 | 由用户控制 | 用户通讯录删除 | 用户主动触发 | 微信/设备通讯录 | P5 仅真实“保存联系人”功能上线才申请 |
| 身份证号码 | 原则不收集 | 否，除明确法律必要 | 未实现 | 不勾选 | 无 | 无 | 无 | 无 | 若未来必须处理，需单独同意、PIPIA、严格访问 | 待定 | 法务书面必要性、不能用订单/客服便利性替代必要性 |

## 4. 微信后台类别的准确配置策略

### 4.1 当前阶段应配置

微信已有标准类别优先使用，不用自定义名称重复包装：

- 微信昵称、头像：用于会员资料、本人页面展示；只有用户另行开启且审核通过后才用于社区作者展示。
- 手机号：用于用户主动绑定后的会员联系与账号冲突核验；非公开浏览必需。
- 地址/收货地址：用于用户主动保存和管理收货地址；当前尚不自动用于订单或配送。
- 摄像头：仅在用户主动选择拍摄投稿审核图片时调用；上传能力关闭时不得调用。
- 选中的照片或视频：当前代码仅选择图片，用于旧投稿审核证据；上传能力关闭时不接收原件。
- 设备信息：仅在本机读取平台和性能等级用于界面适配，不向业务服务端发送完整设备信息。
- 发布内容：限定为当前旧投稿链接、平台账号、利益披露和审核草稿；不能描述为正式社区发帖已经开放。
- 操作日志：用于安全、故障排查和审计，不得记录密钥、完整手机号、地址、正文或支付密文。
- 剪贴板：仅用户点击“粘贴并识别”后读取最多 500 字，本机解析，未保存不上传。

当前自定义类别：

- `微信登录标识及会员编号`：用于识别微信账号、维持会话、防止重复注册和账号冒用。
- `选填微信号`：用于用户主动填写后的会员服务联系，不公开、不作为登录依据。
- `护理记录`：用于保存并回看用户主动填写的护理周期、步骤和自我感受；提示不要填写诊断、病历等无关敏感信息。
- `数据权利请求记录`：用于登记、核验、处理并展示查阅、复制、更正、删除、注销、撤回等请求及回复。

当前不应勾选：邮箱、订单信息、所关注账号、正式社区互动、购物车/商品收藏、客服售后、位置、麦克风、相册仅写入、日历仅写入、通讯录仅写入、身份证号码。dev/test 中存在的互动预览不等于 staging/正式小程序已收集。

### 4.2 对应功能完成后才新增

- `社区内容及互动记录`：用于保存用户主动发布、评论、点赞、关注、收藏、草稿、举报及其他社区互动状态，为用户提供发布、内容管理、互动、收藏、历史记录和安全治理功能。
- `商城浏览与意向状态`：用于保存用户主动加入购物车、收藏商品和调整待购商品数量等状态，为用户提供跨会话购物准备功能。
- `客服及售后服务信息`：用于处理用户主动提出的咨询、投诉、订单售后、退款、账号及其他服务请求，并记录必要的处理过程和结果。
- `通知订阅与发送记录`：用于记录用户的服务通知偏好、独立营销订阅/退订状态及必要投递结果，避免重复发送并处理退信或投诉。
- 如平台标准“订单信息”不能完整覆盖物流和支付状态说明，再增加 `订单履约与物流信息`，不得用一个宽泛自定义类别隐藏不同接收方。

## 5. 目标数据模型

### 5.1 统一控制层

| 目标表 | 关键字段/约束 | 个人数据控制 |
|---|---|---|
| `processing_purpose` | `code`、lawful basis、required/optional、retention policy、active version | 目的先于字段；关闭目的即禁止新写入 |
| `consent_receipt` | member、purpose、document/version、scope、granted/withdrawn_at、channel、proof hash | 替代“某业务表里一个 boolean”；可选目的独立撤回 |
| `processor_registry` | provider、role、data categories、region、contract/DPA version、subprocessors、exit plan | 未完成尽调/合同的处理者不能进入 active |
| `data_retention_policy` | data class、trigger、duration、legal basis、purge action、owner | 可执行期限，不只写文档 |
| `legal_hold` / `legal_hold_binding` | scope、reason、approved_by、expires/review_at | 只冻结有法律依据的最小记录 |
| `data_subject_request` | request type、scope、identity proof、deadline、status | 从受理升级为可执行状态机 |
| `data_export_job` / `data_erasure_job` | manifest、row/object counts、attempts、result hash、reviewer | 幂等、可重试、可证明，不在 chat 回复里假装完成 |
| `data_processing_audit` | purpose、actor、object、action、before/after hashes、trace | 不复制正文或秘密；至少覆盖查看、导出、提供、删除 |

### 5.2 会员与通知

| 目标表 | 主要关系 | 设计决定 |
|---|---|---|
| `member` / `wechat_identity` / `member_profile` | 继续沿用 | 注销进入 `closure_pending → restricted → closed`；身份映射擦除后仅保留不可逆反滥用 tombstone |
| `member_phone` | 从现有 `member_contact` 演进 | 密文、HMAC、验证来源、验证时间；客服/订单不直接复制当前手机号 |
| `member_email` | member 1:N | 密文、规范化 HMAC、verified_at、removed_at；普通浏览非必填 |
| `notification_subscription` | member + channel + purpose unique | `service` 与 `marketing` 严格分离；营销默认关闭 |
| `notification_delivery` | template/version + recipient ref + provider event | 不保存完整邮件正文和敏感 payload；投递/退信/投诉幂等 |
| `member_delivery_address` | 继续作为可变地址簿 | 订单创建时复制到独立加密快照；删除地址簿不修改历史订单事实 |

### 5.3 正式社区

下表使用逻辑域名；当前本地 migration 为避免与 dev/test 的 `community_*` 品牌预览表混淆，正式物理表统一使用 `ugc_*`（审核域使用 `moderation_*`）。本地基础表只表达约束和未来边界，不代表功能已经实现或允许收集。

| 目标表 | 关键关系 | 设计决定 |
|---|---|---|
| `community_post` / `community_post_revision` | author member；draft/pending/published/rejected/deleted | 草稿与公开投影分离；每次编辑可审计；作者可删除 |
| `community_media_asset` / `community_post_media` | 私有原件、经审衍生件、顺序 | 对象默认私有；病毒/内容审查；删除使用 lease + token 的 GC |
| `community_comment` | post、author、parent/reply | 扩展现有预览表；删除后按公开历史需求显示匿名 tombstone，不保留正文 |
| `community_reaction` | member + target + kind | like/save 可撤销；计数是可重建投影 |
| `community_follow` | member + author member | 不允许自关注；注销清除关注边；作者关闭后不再可关注 |
| `community_saved_item` | member + post | 与公开收藏计数分离，支持“我的收藏”删除与导出 |
| `community_report` | reporter、target、category、description | 举报人身份仅治理人员可见；去重、速率限制、申诉 |
| `moderation_case` / `moderation_action` | post/comment/media/report | 人机结论、原因码、模型/规则版本、四眼高风险处置；申诉表推迟到真实申诉状态机与产品流程确定时再建 |
| `community_author_projection` | approved nickname/avatar only | 不把电话、邮箱、微信号或真实身份带入公开读取 |

注销时默认：删除草稿、私有保存、关注/点赞/收藏；已发布帖子由用户在注销确认页选择“先删除”或“保留并匿名化”，评论正文可删除并保留无身份 tombstone 以维持对话结构。存在违法处置、投诉或诉讼 hold 时仅限制处理并告知理由。

### 5.4 商城、支付与履约

| 目标表 | 关键关系 | 设计决定 |
|---|---|---|
| `product` / `product_variant` | product 1:N SKU | 商品内容与库存标识无个人数据；SKU 快照进入订单项 |
| `inventory_reservation` | SKU + order + expiry | 防超卖；支付失败/超时释放 |
| `cart` / `cart_item` | member 1:1 cart；SKU + quantity | 展示价非结算权威；90 天无活动清理 |
| `product_favorite` | member + product unique | 直接取消/注销清除 |
| `commerce_order` | member、currency、totals、state/version | 状态机；任何客户端“支付成功”仅作提示，不驱动完成 |
| `commerce_order_item` | order + immutable SKU/name/price snapshot | 保留交易当时事实，商品变更不重写订单 |
| `order_address_snapshot` | order 1:1 encrypted snapshot | 与地址簿分离；仅履约/售后授权角色可解密 |
| `payment_attempt` | order + unique out_trade_no + prepay expiry | 不存银行卡号、CVV、微信钱包明细；支付密钥不进数据库 |
| `payment_event` | WeChat notification id unique、verified_at、transaction id/state/amount | 先验签/解密/金额与商户号校验，再幂等推进订单；主动查单兜底 |
| `shipment` / `shipment_event` | order、carrier、tracking token、status | 物流商只接收姓名/电话/地址/商品必要信息；回调验签 |
| `after_sales_case` / `after_sales_item` | order/item、reason、requested resolution | 退货/换货/补发与客服流程统一关联 |
| `refund` / `refund_event` | payment + unique out_refund_no | 申请受理不等于成功；通知/查单确认；金额守恒和 maker-checker |

### 5.5 客服与附件

| 目标表 | 关键关系 | 设计决定 |
|---|---|---|
| `support_conversation` | member、status、handler、priority、unread、sequence/version | R2 已本地实现一会员一会话；同一 PostgreSQL Authority、行锁接管与解决/重开 |
| `support_message` | conversation、sender type/principal、body、sequence、created_at | R2 已本地实现 4000 字首版文字；append-only，Outbox 不携正文，AI/human 写入由数据库 guard |
| `support_attachment` | ticket/message、private media asset | 私有对象、下载短链、病毒扫描、逐件删除 |
| `support_assignment` / `support_action` | operator、role、SLA、reason | 所有查看/转派/导出均审计；禁止共享后台账号 |

## 6. 数据生命周期与删除算法

1. **即时删除层**：解绑手机号删除密文/HMAC；地址、草稿、互动、订阅可由用户直接删/撤回；临时上传分块到期自动清。
2. **业务事实层**：订单、支付、物流、退款、财务账本不因前台删除而改写；账号注销后去标识并限制处理，达到已确认期限后清理可识别字段。
3. **公开内容层**：用户删除后立即从公开投影消失；搜索/缓存 purge；对象进入可重试清理队列；计数从事实重建。
4. **证据层**：同意、撤回、审核、举报、退款和权利执行只保留证明合法处理所需的最小字段，不保留不必要正文。
5. **备份层**：在线删除后写入 erasure manifest；备份不做原地篡改，在 30 天备份窗口自然到期；恢复演练必须在恢复后重放 manifest，避免“删后复活”。
6. **legal hold**：必须有对象范围、法律理由、批准人、复核/到期日；hold 内数据禁止其他使用，用户请求回复说明保留范围。

建议基线：草稿 30 天、购物车 90 天、普通客服/内容治理结案后 180 天、安全网络日志至少 6 个月、处理者提供/委托记录至少 3 年、交易和财税记录使用 P2 法务/财务确认后的较长期限、备份 30 天。以上期限必须进入 `data_retention_policy` 和自动任务测试，不能只出现在文档中。

## 7. 第三方处理边界

| 处理者 | 当前/未来 | CISME 提供或取得的数据 | 上线门槛 |
|---|---|---|---|
| 微信/腾讯 | 当前 | 登录 code 换取 OpenID/UnionID；用户主动手机号、地址、头像昵称、隐私接口；运行与反馈 | AppID/Secret 服务端保管；平台类别和隐私指引一致；拒绝路径可用 |
| 腾讯云 Lighthouse/DNS/证书 | 当前 staging | 加密传输和上海基础设施中的业务数据 | 最小权限、补丁、日志、备份、处理地域和合同记录 |
| 腾讯云 COS | 未来 Gate D | 私有媒体原件/附件与必要 metadata | 私有 bucket、短期签名、CORS 最小域、服务端校验、生命周期/删除证明；开启前更新隐私 |
| 微信支付 | 未来 P2 | 商户订单号、金额、描述、支付 OpenID、交易/退款状态 | 商户资质、APIv3 密钥与证书、验签/解密、查单/对账、DPA/披露；不收银行卡资料 |
| 物流服务商 | 未来 P2 | 单次履约所需姓名、电话、地址、商品/包裹必要信息 | 确定具体接收方、合同、地域、字段最小化、回调安全、删除/退出机制 |
| 内容安全/审核服务商 | 未来 P1 | 待审文字/媒体、最小业务 ID | 供应商确定后 PIPIA/合同；禁止把全量会员资料发送给审核商 |
| 客服 SaaS | 未来 P3 | 工单、用户主动提供的联系方式与必要订单摘要 | 境内处理优先、席位 RBAC、下载/导出控制、删除接口、退出全量导出 |
| 邮件服务商 | 未来 P4 | 邮箱、模板变量、投递状态 | 服务/营销模板分离、退订和投诉回传、境内处理/出境评估、删除与抑制列表边界 |

不得在具体供应商尚未选择时在隐私指引中虚构名称；但架构必须先预留 processor registry 和“未激活处理者不能发送”的门。

## 8. 分阶段施工计划与验收门

### P0 — 当前处理与声明完全对齐

- 投稿详情返回权威上传开关；小程序在任何微信隐私/媒体 API 前阻断关闭状态，并显示“当前不访问相册/摄像头、不上传”。
- 保持 staging uploads/COS 关闭；v6 隐私文案、微信后台标准类别与真实代码路径一致后再做真机验证。
- 明确日志字段白名单、`journald`/Nginx 轮转 6 个月与备份 30 天；禁止 header、token、手机号、地址和正文进入日志。
- 建立 privacy inventory 测试：新增任何 `wx.*` 隐私 API、个人字段或外部 provider 时 CI 必须同时更新清单，否则失败。
- 验收：单测、typecheck、OpenAPI lint、staging 开关关闭路径、iOS/Android 真机拒绝/恢复；没有媒体选择器弹出、没有上传请求、没有对象。

### P1 — 正式社区与数据权利

- 在已落地的统一 purpose/consent/retention/processor、rights job 与关闭态正式 UGC 基础表之上，实现 API、后台审核、worker 和小程序页面；默认 gate 持续关闭。
- 实现自助删除、草稿过期、关注/互动清理、内容举报/申诉、作者匿名化规则、对象 GC、导出 manifest、注销/擦除状态机。
- 数据权利 operator 只能发起任务；删除/导出完成须由任务结果和 hash 证明，UI 才能显示“已完成”。
- 更新隐私为未来新版本并在微信后台新增“社区内容及互动记录”，完成 staging 多账号/并发/越权/恢复测试后再开社区 gate。

### P2 — 商城、微信支付、物流、售后

- 按 product→SKU→inventory→cart/favorite→order snapshot→WeChat Pay→server notification/query→shipment→after-sales→refund 构建；全链路幂等与金额守恒。
- 支付成功必须来自验签解密通知或商户查单；退款成功来自退款通知/查单；客户端回调永不作为权威事实。
- 选定商户号、物流商并完成资质、处理者合同、期限与 PIPIA/安全评审后，才更新隐私和微信订单类别。
- staging 使用微信支付沙箱/测试商户能力（若官方可用）或签名固定夹具；任何真实资金操作需用户另行授权。

### P3 — 人工客服及工单

- 构建 ticket/message/attachment/assignment/action；支持订单/售后最小关联、内部备注、用户可见回复、附件删除和席位审计。
- 不申请通讯录写入；手机号、邮箱、微信号均只在用户主动提供和具体工单必要时使用。
- 选供应商后再更新 processor registry、隐私和微信自定义“客服及售后服务信息”。

### P4 — 邮箱与通知

- `member_email` 验证；service/marketing 两套 purpose 和 subscription；营销默认关闭、可随时退订。
- 订单、售后、安全、审核结果、重要服务通知使用服务模板；促销、活动使用营销模板，不得跨目的复用。
- 选定邮件商并完成退信、投诉、抑制列表、处理地域和退出删除验证后才开放。

### P5 — 条件权限

- 定位、麦克风、相册写入、日历写入、通讯录写入均重新走完整八步门；没有对应真实按钮和用户价值时不进入 app.json、不勾微信后台、不写隐私“正在收集”。
- 身份证号码默认永久禁止；只有书面法律/业务必要性、无低侵入替代、PIPIA、单独同意、加密隔离和专门删除规则全部成立时才能立项。

## 9. 当前发布判定

- **会员/护理/地址/旧投稿文字**：已实现但仍需完成真实微信登录、隐私后台、设备 UX 和数据权利执行边界验证。
- **媒体**：源码有选择能力，staging 上传与 COS 关闭，API 权威关闭投影与授权拒绝已验证；小程序 P0 前置阻断未上传且未做 iOS/Android 复验，不能宣称已部署客户端“不会访问选择器”。
- **正式社区**：staging 只有关闭态 schema 基础，API/UI/worker/权利执行未实现；仍视为未实现/未开放，当前微信后台不得勾选关注/社区互动类别。
- **商城/支付/物流/售后/客服/邮箱**：未实现/未开放；只能作为 P2-P4 施工需求，当前隐私与微信后台不得写成已收集。
- **条件权限**：全部未开放、不勾选。
- **生产发布**：本审计没有授权，也没有执行。P0-P5 中任一新目的只有完成对应 gate 后才允许开启。

## 10. 本次落地状态（staging 已验证，客户端未上传）

- P0 媒体最小化：staging 的 `GET /v1/submissions/{id}` 已返回同一 repeatable-read 快照内的 `media_uploads_enabled=false`，授权端点返回 503，未产生媒体行。小程序本地候选默认 false，并在草稿保存、微信隐私授权、`chooseMedia` 与上传请求之前阻断；session owner 变化或退出时先清空上一会员状态。该小程序 hunk 本轮未上传，仍待 DevTools/iOS/Android 验证。
- P0 变更门禁：`docs/privacy/miniprogram-personal-data-inventory.json` 绑定全部当前 `wx.*` API、固定 WXML 数据接口、`requiredPrivateInfos`、migration 集合与已知运行时 egress 调用签名；任何变化都会使单测失败并要求先复核本清单。
- P1 生命周期 schema：staging 已新增 purpose、retention、processor、consent receipt、legal hold/binding、export job、erasure job 与 immutable request event；registry 默认空、policy 默认 inactive，不能因“表存在”被视作治理已生效。数据库层把 export 锁为 `plan_only`、erasure 锁为 `dry_run`，二者只能停在 `planned` 或 `canceled`，不能写入批准、租约、尝试次数或完成证据；未来实现真实 worker 时必须以新 migration 显式解锁。
- P1 权利计划：回复写入改为版本保护；仅 `review_lead` 可幂等创建 plan-only 导出或 dry-run 擦除计划。support 不能建计划，计划不能执行，导出/擦除不能同时绑定同一请求，事件禁止更新/删除。
- P1 正式 UGC 基础：staging 已部署 scope audit 后保留的 8 个、与旧预览物理隔离的 `ugc_*` / `moderation_*` 表；删除尚无 runtime 消费者的 `ugc_post_stats` 投影、点赞/评论点赞/关注/收藏关系，以及未定义产品状态机的 `moderation_appeal`，待各自真实功能与删除规则确定时再迁移。社区开关在 API 与数据库两层强制关闭且没有业务路由。帖子必须在同一事务内拥有作者一致的 revision；revision 正文不可原地改写、审核状态只能单向推进；发布要求当前 revision、作者和全部媒体均满足批准条件；跨会员媒体和可变审核 action 均由数据库拒绝。
- staging 演练与运行证据：迁移按 27→28→29→28→27→28→29 完成，基线事实保持；P0/P1 合成路径通过并清理回零；最终为 29 migrations、66 张 public base tables（含 ledger）、0 member/identity/privacy job/event/UGC/outbox/DLQ 行，上传和社区开关均为 false。API-only release 为 `/opt/cisme/releases/20260911T051500Z-p0p1-staging`；worker 与 worker-once 哈希保持基线不变。
- 仍未实现：身份核验状态机、maker-checker 批准、真实导出生成、一次性下载、legal-hold 计算、字段级删除/匿名化、账号关闭、备份 manifest 重放以及任务 worker。上述任一项完成前，UI 和隐私回复不得显示“已执行”。
- 正式社区仍未实现：业务 API、小程序/后台交互、媒体对象、内容安全供应商、举报目标存在性/速率限制、审核处置 worker、草稿过期、对象 GC、导出/擦除映射和真机验证。上述闭环完成前 `community` 开关不得解除数据库约束。
