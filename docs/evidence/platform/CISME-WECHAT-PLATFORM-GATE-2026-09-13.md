# CISME 微信公众平台只读门禁 — 2026-09-13

结论：`HUMAN VERIFICATION REQUIRED`。本轮尝试读取已打开的微信公众平台标签页，但浏览器会话隔离拒绝访问；在独立标签页打开 `mp.weixin.qq.com` 又被浏览器安全策略明确阻止。未绕过策略、未读取账号后台、未改平台配置、未上传版本。源码配置值不等同于账号现状。不得把任何下列未知项写成 PASS。

基线：PR #3 初始 HEAD `2ece6653f9bfdf76c600838a04e3fcd6ce692de7`；小程序包 SHA-256 `8c1185cf3b7968c1d8ef32fe31f05270cda41d2ea26b9ed1e644d7004d41aa37`；37 路由。`apps/miniprogram/project.config.json` 的 AppID 仅记录为 `wx4e…299b`，是构建配置，尚未与后台当前 AppID/主体交叉确认；基础库配置为 `3.15.2`。

| 只读核验项 | 当前可证明事实 | 后台证据状态 / Owner 所需动作 |
| --- | --- | --- |
| 当前 AppID、主体名称/类型、统一社会信用代码 | 仅有源码 AppID 掩码；PRD 需求方为“CISME / 熹芃（上海）生物科技有限公司”，不证明账号主体或最终运营主体 | `HUMAN VERIFICATION REQUIRED`：后台展示 masked AppID、主体类型/名称、信用代码掩码；不要提交完整证件号 |
| 微信认证状态/有效期；管理员/运营者 | 源码不可推断 | `HUMAN VERIFICATION REQUIRED`：状态、到期日、角色人数/责任人，勿输出个人手机号或二维码 |
| 小程序名称、服务类目、特殊资质 | 源码不可推断 | `HUMAN VERIFICATION REQUIRED`：名称、类目与资质状态须与护理、化妆品、电商、UGC 实际功能对齐 |
| 小程序备案状态/编号 | 源码不可推断 | `HUMAN VERIFICATION REQUIRED`：状态与备案号掩码；另与域名/ICP 主体核对 |
| 开发版、体验版、审核版、正式版 | PR3 未上传；旧截图和旧开发版不能证明当前 SHA | `HUMAN VERIFICATION REQUIRED`：各版本号、上传时间、对应源码/制品 SHA、状态 |
| 用户隐私保护指引、已声明类别、审核中状态 | 源码 `__usePrivacyCheck__=true`、`requiredPrivateInfos=[chooseAddress]`；当前调用还含手机号、头像/昵称、相册/相机、剪贴板、设备信息、媒体、身份等，完整来源见隐私矩阵 | `HUMAN VERIFICATION REQUIRED`：逐项对照指引类别、审核状态、拒绝/再授权路径；不得只凭 `app.json` 判定通过 |
| 体验版/开发版隐私设置和 consent flow | 仅源码上 `submit`/`support` 明确调用 `requirePrivacyAuthorize`；`community-compose` 未见显式调用 | `HUMAN VERIFICATION REQUIRED`：用当前 SHA 在微信基础库、DevTools 和真机核验首次/拒绝/再授权；未通过时不上传体验版 |
| request/uploadFile/downloadFile/socket 合法域名 | 源码 preview/trial API origin 为 `https://staging-api.cisme.cn`；无证据表明当前账号已配置 request/upload/download 域名 | `HUMAN VERIFICATION REQUIRED`：分别列出后台域名与 TLS 证据；不可用“开发者工具不校验域名”代替 |
| web-view 业务域名 | 当前源码未见 web-view 使用 | `HUMAN VERIFICATION REQUIRED`：后台确认无多余域名/历史遗留授权 |
| 接口设置、插件、订阅消息模板 | 打包源码未见插件或订阅消息调用；不证明后台无历史配置 | `HUMAN VERIFICATION REQUIRED`：后台列状态与适用性，过宽权限不得静默保留 |
| 支付能力、商户号绑定、交易类发货管理 | 代码正式支付 outbound 默认禁止，真实商户号/绑定均未验证 | `HUMAN VERIFICATION REQUIRED`：只报 mchId 掩码、绑定/支付能力/发货管理状态；不读取 APIv3 密钥内容 |

账号后台核验应由获授权 Owner 在其现有安全会话中只读完成，交付经脱敏的状态截图或表格，标注截图时间、后台菜单与账号掩码。不得索取或发布 AppSecret、access token、商户 API key、私钥、证书私有材料、Cookie、OTP 或会话密钥。平台动作（主体迁移、绑定商户、改域名、开权限、上传/提审/发布）全部另设 Owner gate。

参照：[微信支付官方小程序开发接入准备](https://pay.wechatpay.cn/doc/v3/merchant/4015459512)要求已认证的小程序及 AppID 与商户号授权绑定，并提醒交易类小程序的订单发货管理要求；这只是平台规则依据，不是 CISME 账号已满足的证据。
