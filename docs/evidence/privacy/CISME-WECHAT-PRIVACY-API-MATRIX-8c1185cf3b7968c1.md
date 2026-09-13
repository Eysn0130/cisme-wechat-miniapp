# CISME 微信能力与个人数据矩阵（源码基线）

- 小程序源码 SHA-256：`8c1185cf3b7968c1d8ef32fe31f05270cda41d2ea26b9ed1e644d7004d41aa37`；Git 基线：PR #3 初始提交 `2ece6653f9bfdf76c600838a04e3fcd6ce692de7`。
- 范围：`apps/miniprogram` 的 250 个打包文件、37 个路由，以及 `app.json` / 各页 JSON / 内部 `address-editor` 组件；用 `rg` 枚举全部 `wx.*`、`open-type` 和 `input type=nickname`。当前包没有 `miniprogram_npm`、第三方小程序组件或插件；这不证明微信运行时或后台配置已通过。
- 证据等级：`SOURCE` 仅为可达源码路径；`CONDITIONAL` 依赖运行时开关、会员身份或正式外部门禁；`BLOCKED` 表示尚无当前微信后台、DevTools、iOS/Android 或 staging 互通证据。此矩阵不是隐私指引审核通过证明。业务需求按 PRD V2.1-R4.2 §6.3.1、§6.6.2、§6.8、§7.7、§8.2、§15.5–15.6 判定。

## 共用判定规则

下表每行的「拒绝/再授权」只描述当前代码入口，不等于已实测微信系统弹窗。`/v1/me/*` 使用当前会话会员；管理接口须服务端 capability；服务端保留期限若没有已批准、已执行的政策，一律 `POLICY PENDING`，不能擅写天数。用户权利入口是 `/pages/privacy-rights/index` → `/v1/me/privacy-requests`，当前导出仅 plan-only、擦除仅 dry-run；单项手机号和地址有独立解绑/删除入口。CISME API 是第一方接收方；微信平台、微信支付、微信内容安全和对象存储只有对应能力启用时才是额外接收方。`onSend` 记录 route/status/耗时/字节数，不记录业务正文；是否存在其他异常日志、平台日志、边缘日志的完整脱敏证据仍待审。

## 需逐项核对隐私指引的数据能力

| 路由/组件；接口或组件 | 可达/数据与必要性；PRD | 微信指引类别；首次/拒绝/再授权 | 会话归属；后端 API → 表/字段、对象路径 | 第三方；日志/保留/删除修正；证据 |
| --- | --- | --- | --- | --- |
| `pages/account`；`wx.login` | `SOURCE`，微信登录 code、OpenID/可选 UnionID，会员身份必需；§7.7、A21 | 微信身份信息；点击登录后取 code，失败留在登录页重试；不等同隐私弹窗授权 | AppID+OpenID 绑定当前会话；`POST /v1/identity/wechat` → `wechat_identity(app_id,openid,unionid,member_id)`、`member` | 微信登录服务；服务端不应记录 code/token，保留 `POLICY PENDING`，身份纠正/合并仅经受控流程；`SOURCE/BLOCKED` |
| `pages/account`,`pages/settings`；`open-type=getPhoneNumber` | `CONDITIONAL`，授权 code/手机号仅选填联系与冲突核验；§7.7 | 手机号；用户点击授权，拒绝可跳过，之后重新点绑定 | 当前会员；`POST /v1/me/phone` → `member_contact(phone_encrypted,phone_hmac,phone_masked)`、`phone_authorization(code_hash)` | 微信手机号服务；不记明文，`POLICY PENDING`，`DELETE /v1/me/phone` 解绑；后台声明与真机拒绝路径 `BLOCKED` |
| `pages/account`,`pages/settings`；`open-type=chooseAvatar` | `SOURCE`，用户选择的头像，非基础护理必需；§7.7、§8.6 | 头像；主动点击，拒绝保留默认头像，可重试 | 当前会员；`PUT /v1/me/profile` → `member_profile.avatar_data_url/avatar_revision`；本机派生 JPEG 缓存 `wx.env.USER_DATA_PATH/cisme-avatar-*` | 微信选择器；服务器接收用户选择的图，`POLICY PENDING`；恢复默认头像/权利请求，跨会话清本地缓存；运行时 `BLOCKED` |
| `pages/account`,`pages/settings`；`input type=nickname` | `SOURCE`，用户填昵称，可使用默认名；§7.7、COM-U03 | 昵称；主动编辑保存，拒绝用默认名，再编辑；公开展示还须安全扫描和独立人工复核 | 当前会员；`PUT /v1/me/profile` → `member.display_name`、`member_profile.public_status/profile_revision`、`ugc_nickname_safety_scan` | 微信内容安全仅公开资料检测时接收；`POLICY PENDING`，本人修改或权利请求；后台与真机 `BLOCKED` |
| `pages/settings`；`wx.chooseAddress` | `SOURCE`，微信地址簿的收件人、电话、地区、详细地址；用户主动导入购物地址草稿；§8.2 | 收货地址、姓名、电话；主动点击，拒绝可手填，之后重试；`app.json.requiredPrivateInfos` 已列 `chooseAddress` | 当前会员且异步回调有会话围栏；保存才调用 `/v1/me/addresses` → `member_delivery_address.encrypted_payload/payload_hmac/label` | 微信地址簿选择器；未保存草稿不上传；已存地址 `POLICY PENDING`、本人可改/删；平台声明与真机 `BLOCKED` |
| `pages/settings/components/address-editor`；手填 `input`/`textarea`/`picker mode=region` | `SOURCE`，收件人、配送电话、行政区、详细地址、邮编、地址标签；用户主动为自营 MAKE 配送填写；§8.2 | 姓名/电话/收货地址；用户自行录入，放弃不保存，可再编辑 | 当前会员；`POST/PUT /v1/me/addresses` → `member_delivery_address.encrypted_payload/payload_hmac/label`；下单时另形成 `commerce_order_address` 快照 | CISME API 首方，未见组件内第三方调用；已存地址本人可改/删，交易快照按 `POLICY PENDING`/争议保留；`SOURCE/BLOCKED` |
| `pages/settings`；`wx.getClipboardData` | `SOURCE`，用户主动粘贴最多 500 字地址文本；§8.2 | 剪贴板；主动点击，拒绝改为手填，重新点击重试 | 本机解析后当前会员确认；仅保存时 `/v1/me/addresses` → 加密地址字段 | 微信剪贴板；原剪贴板不自动上传/写日志；已存地址本人可改/删，读取弹窗实测 `BLOCKED` |
| `pages/community-compose`；`wx.chooseMedia` | `CONDITIONAL`，最多 9 张用户图，正式 UGC 草稿；COM-U01/U02 | 用户选择的相册图片/拍摄图片；点添加，拒绝保留草稿并可再次点击；该入口源码未显式调用 `requirePrivacyAuthorize`，须核对微信运行时隐私回调 | 当前作者/帖子版本；`POST /v1/me/ugc/posts/:id/media/authorize`、complete → `ugc_media_asset`、`ugc_post_media`，私有 `ugc/{member}/{post}/{media}` | 微信相册/相机；配置存储 Provider；公开需微信安全扫描+人工复核；源图私有、保留 `POLICY PENDING`，本人删草稿/媒体及权利请求；`SOURCE/BLOCKED` |
| `pages/submit`；`wx.chooseMedia` | `CONDITIONAL`，投稿原图/截图；§6.5、§7.7 | 用户选中的相册/相机图片；源码先 `requirePrivacyAuthorize`；拒绝显示隐私或设置恢复入口，重试点选择 | 当前会员+投稿；`POST /v1/submissions/:id/media/authorize`、complete → `media_object`，私有受控对象键 | 微信相册/相机、启用时的对象存储；媒体开关关闭时不应弹选择；`POLICY PENDING`，本人权利请求/受控清理；`SOURCE/BLOCKED` |
| `pages/support`；`wx.chooseMedia` | `CONDITIONAL`，最多 3 张客服图片；§6.3.1 支持路径 | 用户选图/拍照；源码先 `requirePrivacyAuthorize`；拒绝保留文字客服，重试点附件 | 当前会员会话；`POST /v1/me/support/media/authorize`、complete → `media_object`/`support_message`，私有对象键 | 微信相册/相机、启用时对象存储；未发草稿 24h 到期，已发会话 `POLICY PENDING`，未绑定可删、会话需 retention/hold 审核；`SOURCE/BLOCKED` |
| `pages/support`；`wx.compressImage` | `SOURCE`，客服选择图的本机压缩副本；§6.3.1 | 不新增微信数据类别；选择图片之后处理，失败保留原选择/重试 | 当前会员本地临时路径；仅用户确认后上传至客服媒体接口/`media_object` | 本机处理，未见新增接收方；临时文件由微信管理，服务端期限同客服附件；`SOURCE/BLOCKED` |
| `services/api` 客户端包装；`wx.uploadFile` | `CONDITIONAL`，用户选择的 UGC/投稿/客服图片；COM-U01/U02、§7.7 | 图片上传；选择且服务端短期授权后；拒绝/超时保留私有待处理，重新授权后重试 | 当前会员/对象/短期上传 token；各媒体 authorize/complete → `ugc_media_asset` 或 `media_object`，分别 `ugc/{member}/{post}/{media}` / 受控媒体键 | 配置的对象存储或受控网关；请求/响应正文不进常规 HTTP 日志，真实 COS IAM/保留/清理 `BLOCKED` |
| `services/api` 客户端包装；`wx.downloadFile` | `SOURCE`，已鉴权的客服图片临时预览；§6.3.1 | 图片文件；用户点击消息图，失败提示后重试 | 当前会员或 `support.read` 管理者；`GET /v1/me/support/media/:id` 或管理会话媒体 → `media_object.object_key`，`private,no-store` | 本机微信临时文件；不产生新服务端副本，客户端临时清理由微信负责；`SOURCE/BLOCKED` |
| `services/api`,`services/http`；`wx.request` | `SOURCE`，全业务 API：身份、护理、订单、客服、UGC、管理、隐私权利；§6–§10 | 按各行对应类别，网络请求本身非单一隐私弹窗；请求失败/离线须逐路由重试 | 会话 token / 管理 capability；219 个 `/v1` 注册方法见 `lint:contracts` 与静态路由审计；表按该业务域确定 | CISME API 首方，网络/IP/请求 ID/状态日志；保留随各表 `POLICY PENDING`，更正/删除按该域和权利请求；逐字段权限/真机 `BLOCKED` |
| `pages/order-detail`；`wx.requestPayment` | `CONDITIONAL`，订单/预支付参数；WX-PAY-MAKE-01 | 支付交易；用户主动发起；取消/失败只重查原单，不以客户端成功作财务事实 | 当前订单所属会员；`/v1/me/orders/:id/payment-intent` → `commerce_order`、支付意图/可信 inbox；金额/币种/商户/AppID 由服务端核对 | 微信支付；正式资金未授权，当前 staging 必须禁用或 mock；财务保留 `POLICY PENDING`，退款/权利请求按法定保存裁决；`BLOCKED` |
| `pages/commission`；`wx.requestMerchantTransfer` | `CONDITIONAL`，结算收款确认参数；COM-C01–03 | 商家转账/收款身份；本人主动确认；失败查询原单 | 当前收款会员及已签名查询的 `WAIT_USER_CONFIRM` 原单；`/v1/me/commission/*` → `commission_settlement_request`/可信回调与账单 | 微信支付；真实转账未授权，staging 禁用；保留 `POLICY PENDING`，不可把客户端回调作为入账；`BLOCKED` |
| `pages/account` 等；`wx.getAccountInfoSync` | `SOURCE`，当前 AppID/环境版本；§15.6 | 应用身份信息，不是用户隐私接口；无需额外授权，失败阻断不安全环境路径 | 本机用于环境/身份边界；`/v1/identity/wechat` 的 AppID 必须与服务端一致，`wechat_identity.app_id` | 微信平台；不应记录完整 AppID 外的个人数据；新 AppID 不可继承 OpenID；运行时 `BLOCKED` |
| `app.ts`,`services/layout`,`pages/account`；`wx.getDeviceInfo` | `SOURCE`，平台/benchmarkLevel 供本机适配；§6.3.1 | 设备信息；随布局调用，失败应回退，非用户手动授权 | 本机，不上传完整设备对象；无后端字段 | 微信运行时本地读取；不在业务表保留，设备日志需另核；`SOURCE/BLOCKED` |
| `services/layout`；`wx.getWindowInfo`,`wx.getMenuButtonBoundingClientRect` | `SOURCE`，屏幕几何/胶囊避让；§6.3.1 | 设备显示信息；布局时自动读取，失败退回安全间距 | 本机，不提交后端/无对象路径 | 微信运行时；无业务保留/删除不适用；真机视觉 `BLOCKED` |
| `services/member-avatar`,`services/api`,`pages/post`,`pages/community-compose`,`pages/support`；`wx.getFileSystemManager`,`wx.env.USER_DATA_PATH` | `SOURCE`，头像缓存和用户主动选择的媒体临时文件；§7.7、COM-U01 | 本机文件；头像派生/选择媒体后使用，失败可重选/重试 | 头像缓存按 run/session 清理；图片仅授权后通过相关媒体接口上传；服务端表同上 | 微信本机文件系统；本地残留清理与设备实测 `BLOCKED` |
| `pages/submit`；`wx.requirePrivacyAuthorize`,`wx.openPrivacyContract`,`wx.openSetting` | `SOURCE`，投稿选图前微信隐私确认/拒绝恢复；§7.7 | 隐私指引及相册/相机权限；首次点选择；拒绝保留草稿，打开隐私指引/系统设置后重试 | 不写业务表；只有后续实际选图才有媒体授权 | 微信隐私/系统设置；当前后台声明与体验版配置 `BLOCKED` |
| `pages/support`；`wx.requirePrivacyAuthorize` | `SOURCE`，客服选图前确认；§7.7 | 隐私指引；拒绝仍可文字咨询，再点击重试 | 不写业务表；后续选择才走客服媒体授权 | 微信隐私服务；后台声明/拒绝路径运行时 `BLOCKED` |
| `app.ts`,`services/api`,`services/share`,`services/ugc-local-backup`；`wx.getStorageSync`,`wx.setStorageSync`,`wx.removeStorageSync` | `SOURCE`，会话 token、分享访问/归因上下文、本人 UGC 草稿；§7.7、COM-U01、COM-R01 | 本机个人数据；登录/分享/编辑时产生，拒绝持久化应保留当前操作失败提示，重新登录/编辑可重试 | token 只归当前会员会话；分享归因经 `/v1/shares/:id/*` 写 `share_visit/share_attribution`；草稿正文不自动上传，提交时写 `ugc_post_revision` | 微信本机存储；token 与草稿不进常规 HTTP 日志；UGC 本机备份 7 日清理且跨账号清空，服务器 `POLICY PENDING`、权利请求；设备持久化实测 `BLOCKED` |
| `pages/settings`,`pages/community`,`pages/invite`,`pages/submit`；`wx.setClipboardData` | `SOURCE`，本人会员号/推荐码/投稿号、经审链接复制；§6.3.1、COM-R01 | 主动复制的业务标识/链接；用户点击，失败可手动查看/重试 | 当前页当前会话；不额外请求后端，原值由相应本人或公开 API 取得 | 写入系统剪贴板，其他 App 可能读取；本服务不追踪剪贴板，删除需用户自行覆盖，风险文案待核；`SOURCE/BLOCKED` |
| 分享按钮 `open-type=share`、`wx.showShareMenu` | `SOURCE`，用户主动分享公开页面/一次性 share ID；§6.3.1、COM-R01 | 分享内容；无被动通讯录读取，用户取消不归因，下次可重试 | 当前会员创建 `/v1/shares`、公开 `/v1/shares/:id/visits`、身份归因 → `share_link/share_visit/share_attribution` | 微信分享服务与用户选择的接收方；保留 `POLICY PENDING`，归因纠正/权利请求；真机 `BLOCKED` |
| `open-type=feedback` | `SOURCE`，微信反馈入口；§6.3.1 | 用户主动向微信反馈的内容；取消即不发送，可再次进入 | 不进 CISME 后端或表；微信平台处理 | 微信为接收方，其保留/删除由微信机制；业务必要性须产品确认，当前平台/真机 `BLOCKED` |

## 其余 `wx.*` 全量分类

以下接口未见新增个人数据采集、上传或第三方组件调用。每项仍为源码可达；共用字段为：微信隐私类别 `不新增`，授权/拒绝/再授权 `不适用（按页面可重试）`，会话归属 `当前页面（若其触发后续业务请求则按上表 wx.request）`，后端表/COS/第三方/日志/保留/删除 `无直接新增`，证据 `SOURCE；运行时 BLOCKED`。

| 类别 | 逐项枚举 | 路由/组件、必要性；PRD |
| --- | --- | --- |
| 导航 | `wx.navigateBack`, `wx.navigateTo`, `wx.reLaunch`, `wx.redirectTo`, `wx.switchTab`, `wx.pageScrollTo` | 全页路由与滚动；§6.3.1；不能代替当前会话归属检查 |
| 交互与渲染 | `wx.nextTick`, `wx.createSelectorQuery`, `wx.showModal`, `wx.showActionSheet`, `wx.showToast`, `wx.hideKeyboard`, `wx.onKeyboardHeightChange`, `wx.offKeyboardHeightChange`, `wx.stopPullDownRefresh` | 页面布局、输入、错误恢复与确认；§6.3.1；输入正文仅在用户明确提交后走相应 API |
| 离开保护 | `wx.enableAlertBeforeUnload`, `wx.disableAlertBeforeUnload` | 护理、投稿、客服等未保存草稿提示；§6.3.1；不形成服务端事实 |
| 分享可见性/预览 | `wx.hideShareMenu`, `wx.previewImage` | 商品/UGC/客服等受控分享与图片预览；§6.3.1；预览的图片本身按上表媒体归属判定 |
| 本机轻反馈/能力 | `wx.vibrateShort`, `wx.canIUse` | 护理触感与商家转账可用性探测；§6.3.1、COM-C03；无直接后端存储 |

## 需要关闭的证据缺口

1. 微信后台实际隐私保护指引数据类别、审核状态、体验版隐私设置与源码逐项对照尚不可读；不能把 `requiredPrivateInfos=[chooseAddress]` 解释为平台配置已通过。
2. `community-compose` 的选择图片路径未显式 `requirePrivacyAuthorize`；需在当前微信基础库/真机验证是否由隐私弹窗钩子统一拦截，必要时在 change-safety 确认后补充显式拒绝/再授权路径。
3. 微信隐私授权、手机号、地址、头像、照片、剪贴板、文件下载、支付及转账的拒绝、切换账号和迟到回调，仍缺当前源码 DevTools/iOS/Android 逐态证据。
4. 实际部署的 API/COS/微信内容安全接收方、地域、保留期限、日志脱敏、数据导出/擦除执行与法定保存依据尚未由 Owner/平台证明；仅有计划或 dry-run 不得标记完成。
