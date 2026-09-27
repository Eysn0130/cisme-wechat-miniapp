# R4 正式配置映射与缺项

本轮核对本地 18499d 的真实实现，随后冻结到 640185b。没有输出密钥，没有扫描个人全部目录，没有执行真实交易、退款、转账、物流交寄或消息发送。

## 已检查范围

- 本机 `/Users/mini/CISME/tmp/tencent-deployment` 和 `tmp/deployment-secrets` 中已有 env、JSON、证书文件；JSON 仅输出键名。已有 `wechat.json` 只含 AppID/AppSecret；数据库 TLS 文件不是商户证书。
- 正确生产实例 `lhins-61ikz4mi` 的 `/opt/cisme/prepared`、`/etc/cisme`、既有 `/opt/cisme/runtime*.env` 及项目配置目录。检查名称/权限/配置键，不展开历史 releases、node_modules 或个人目录。`/opt/cisme/secrets`、`/opt/cisme/certs` 不存在。
- 补查 `/opt/cisme/runtime-r5-prepared.env`、`/opt/cisme/runtime.pre-cos.env`，仍只有 AppID/AppSecret。不能据此断言用户所有授权位置都没有支付材料。
- 用户授权打开商户平台后，`https://pay.weixin.qq.com/` 被浏览器站点安全策略直接拒绝；未进入 Auto-review。没有换入口/浏览器/账号/工具访问。用户需在本人浏览器操作现有商户，之后只提供项目私有文件位置。

## 映射

下表的“缺项”表示本次已核对范围内的结果，不等于要求重新开户或重新生成凭据。运行身份 `cisme` 必须实际可读私有文件；文件为无链接 regular file、0600 或更严，属主为进程用户或 root。root:root 0600 即使通过属主规则，也不能假定 `cisme` 可读取。

| 代码键名 | 实际消费者 | 已有位置 / 验证 | 尚缺的具体动作 |
| --- | --- | --- | --- |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | `loadConfig`、登录能力、`fulfillmentRuntime.token` | 本机 `tmp/deployment-secrets/wechat.json`；生产 live env 及 R3 prepared env 已存在。AppID 为现有小程序 `wx4eac2d4fb11d299b`；秘密未输出 | 本人平台确认该 AppID 与真实商户的绑定及权限；不能由配置文件自证 |
| `COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED` | `loadConfig` → `formalPaymentProtocol` | prepared 尚未装配正式支付材料；布尔开关不是授权 | 有材料后装配并以 `cisme` 身份验证 |
| `COMMERCE_FORMAL_MERCHANT_ID` | `loadConfig`、协议身份、商务/恢复授权 | 已检查路径未发现真实商户号；实际模式未确认 | 本人现有商户平台确认普通商户/实际模式、商户号及 AppID 绑定；不得切换灰度新接口 |
| `COMMERCE_FORMAL_MERCHANT_PRIVATE_KEY_FILE` | `loadFormalWechatPayTrust` | 路径未取得；要求 RSA≥2048、可读、安全权限 | 指向现有私钥，验证与真实证书的公钥一致 |
| `COMMERCE_FORMAL_MERCHANT_SERIAL` / `COMMERCE_FORMAL_MERCHANT_CERTIFICATE_FILE` | `loadFormalWechatPayTrust`、`authorizeCommerce`、出站 `authorizeRecovery` | 路径/真实 serial/有效期均未取得。**证书只对独立入站配置可省略；出站交易仍必需** | 使用现有证书验证 CN=商户号、serial、私钥匹配及有效期；确认平台仍有效 |
| `COMMERCE_FORMAL_API_V3_KEY_FILE` | 信任装载、支付/退款 Inbox 解密 | 已检查路径未取得；要求32字节 | 指向现有 APIv3 密钥；以真实授权回调验证解密和身份绑定，不能只凭长度宣布可用 |
| `COMMERCE_FORMAL_PLATFORM_TRUST_FILE` | 信任装载、响应/回调验签 | 缺真实可信公钥及标识；schema 为 `{schemaVersion:1,keys:[{id,publicKeyFile}]}`，1–8项、ID唯一、RSA≥2048 | 从商户认可的现有可信材料形成清单；若提供平台证书，先核验并提取对应公钥；未知响应 serial 必须拒绝 |
| `COMMERCE_FORMAL_PAYMENT_NOTIFY_URL` | `WechatPayV3Client`、支付回调路由 | 对应 `https://api.cisme.cn/v1/payments/wechat/callback`；尚无最终 main 程序的真实通知验签回执 | 装配正确路径，核验代理原始 body/Wechatpay-* 头及真实授权通知 |
| `COMMERCE_FORMAL_REFUND_NOTIFY_URL` | 退款协议/Inbox/回调路由 | 对应 `https://api.cisme.cn/v1/payments/wechat/refund-callback`，同上 | 装配正确路径并核验授权通知；不得为测试自行退款 |
| `COMMERCE_FORMAL_COMMERCE_AUTHORIZATION_FILE` | `commerceAuthorization` / `authorizeCommerce` | 仓库自定义私有授权 JSON；不是微信申请表。未生成不实授权 | 真实身份确认后，依据已批准能力和有效期生成。每次命令重读；不能自动允许实付/退款/转账测试 |
| `COMMERCE_FORMAL_RECOVERY_AUTHORIZATION_FILE` | `recoveryAuthorization` / `authorizeRecovery` | 仓库自定义恢复授权 JSON；未生成不实授权 | 按真实环境/AppID/商户及批准范围绑定查询、账单、支付/退款回调；新单命令要求这些恢复能力齐备 |
| `COMMERCE_FULFILLMENT_ENABLED` / `COMMERCE_FULFILLMENT_MERCHANT_ID` | `loadConfig` → `fulfillmentRuntime` | prepared 未启用正式履约；真实商户号待取得；现有 CONTACT 密钥保留 | 匹配支付身份，以既有 CONTACT 密钥派生履约加密/摘要，不能重新生成并丢失地址可读性 |
| `COMMERCE_FULFILLMENT_AUTHORIZATION_FILE` | `shippingAuthorization`、发货同步/查询客户端 | 仓库自定义 `wechat-shipping-sync` 授权；无真实授权文件 | 以批准范围绑定 `shipping.query`/`shipping.upload`；实际上传须对应真实本地发货事实。可选电子面单、账号查询/轨迹不作为首发前提 |
| `UGC_GO_LIVE_GATE` | 配置、公开 UGC 入口 | 维持关闭；源码/草稿/既有权益保留；独立 worker 缺扫描配置返回空句柄，单测覆盖 | 公开UGC后续接入审核；护理/客服附件安全处理不关闭，未审核内容不放行 |
| `WECHAT_MESSAGE_TOKEN` / `WECHAT_MESSAGE_AES_KEY`、客服接待配置 | 消息处理/微信平台原生客服 | 尚无本轮正式接待/送达证据；保留 R3 模拟器“暂不支持打开客服会话”的真实结果 | 本人允许的平台配置与实际送达证据；不改为假成功 |
| `PRIVACY_FORMAL_EXPORT_KEY` | 正式隐私导出 | R3 prepared env 中既有稳定密钥，本轮原字节未改并新增可解密的配置保护副本 | 最终切换安装同一密钥；切换保护点需重新绑定，不能每轮生成新值 |

## 授权 schema 与期限

- 商务：`schemaVersion=1`、`mode=ordinary-merchant-commerce-commands`、`environment=production`、真实 appId/merchantId、approvalReference、未来 expiresAt、非空且不重复的 capabilities。已实现 `order.create/payment.prepare/payment.close/refund.request/refund.approve/refund.submit`；这不是转账授权。
- 恢复：`mode=ordinary-merchant-recovery-only`，staging/production 精确绑定，能力为 `payment.query/refund.query/bill.read/payment.callback/refund.callback`。能力独立；入站回调不强行要求运行时商户证书文件。
- 履约：`mode=wechat-shipping-sync`；staging 还必须 `dataScope=isolated-test-only` 与明确订单列表。生产同样必须真实批准和有效期。
- 本轮缺真实商户身份及已确定的营业窗口，故不生成带虚构绑定或无限期限的授权。取得材料后应结合真实批准期限生成，营业前重验/按原批准续期；不得删除到期检查，也不能承诺未知备案日所有授权必然有效。

普通商户小程序支付沿用 `/v3/pay/transactions/jsapi`。小程序与 JSAPI 共享部分权限，不需要网页 JSAPI 支付授权目录；商户 AppID 绑定和交易类小程序订单发货管理仍需平台事实。[微信支付小程序接入说明](https://pay.wechatpay.cn/doc/v3/merchant/4015459512)、[JSAPI/小程序下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791897)。

## 首发与安装边界

核心交易、履约、护理、客服、隐私仍为目标，不能把当前关闭交易的安装状态当成完整首发。公开 UGC 单独维持关闭，不作为核心接线缺失的借口。安装器禁止隐式改变既有秘密；新增支付私有文件及其 env 路径要走明确的配置准备步骤，并按实际安装身份检查后绑定候选/资格摘要，不修改无关会话、地址、上传密钥。
