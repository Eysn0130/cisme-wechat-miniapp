# R5 实际配置映射

最终私有准备 env：`/opt/cisme/prepared/r5-20260926/runtime.production.closed.authorized.v2.env`。它尚未替换 live `/opt/cisme/runtime.env`。旧 v1 准备文件保留历史，因路径已修正不可再用作切换输入。

本机材料根为 `/Users/mini/CISME/.secrets/wechat-pay`，下表简称 LOCAL；服务器最终材料根为 `/etc/cisme-wechat-pay`，简称 PROD。普通商户1000579096；AppID wx4eac2d4fb11d299b。用户本人确认绑定；本轮未创建支付订单重新验证该平台绑定。

| 实际配置键 / 清单字段 | 消费函数 | 私有来源 → 生产位置 | 实际验证与剩余动作 |
| --- | --- | --- | --- |
| `WECHAT_APP_ID`, `WECHAT_APP_SECRET` | loadConfig、登录、fulfillmentRuntime.token | 既有 live/R3 prepared → v2 env 保留 | stable_token真实200/errcode0；无需重新生成。 |
| `COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED` | loadConfig → formalPaymentProtocol | v2 env=true | 开启协议配置装配，不等于营业许可；实际装载已通过。 |
| `COMMERCE_FORMAL_MERCHANT_ID` | 协议、请求签名、grant绑定 | v2 env=1000579096 | 真实证书CN绑定及真实只读请求成功。 |
| `COMMERCE_FORMAL_MERCHANT_SERIAL` | loadFormalWechatPayTrust、WechatPayV3Client.authorization | 用户真实serial → v2 env | `5F6A1DC257C5763FA4BD3DB831223052394D503A`；对应商户证书，不作为Wechatpay-Serial头。 |
| `COMMERCE_FORMAL_MERCHANT_PRIVATE_KEY_FILE` | loadFormalWechatPayTrust、请求签名 | LOCAL/merchant-api-cert/apiclient_key.pem → PROD同相对路径 | cisme可读0600、RSA2048、证书私钥匹配、真实签名查询通过。 |
| `COMMERCE_FORMAL_MERCHANT_CERTIFICATE_FILE` | 装载、authorizeCommerce、出站authorizeRecovery | LOCAL/merchant-api-cert/apiclient_cert.pem → PROD同相对路径 | CN/serial/私钥/日期通过；有效至2031-09-25T13:34:50Z；未删安全校验。 |
| `COMMERCE_FORMAL_API_V3_KEY_FILE` | 装载、回调Inbox解密 | LOCAL/api-v3-key.txt → PROD/api-v3-key.txt | 真实文件严格32字节；未变更。真实微信回调解密尚未测试，不能由长度或查单代证。 |
| `COMMERCE_FORMAL_PLATFORM_TRUST_FILE` | loadFormalWechatPayTrust | LOCAL/r5-prepared/production/trusted-public-keys.json → PROD/trusted-public-keys.json | schemaVersion1，1个已确认公钥，路径与运行身份已绑定。 |
| `activePublicKeyId`, `keys[].id` | selectWechatPayPublicKey、响应/回调验签 | 用户 public-key-id.txt → 私有可信清单 | `PUB_KEY_ID_0111178110872026092600191735000402`；已与真实响应签名ID及签名匹配。 |
| `keys[].publicKeyFile` | 可信公钥装载 | LOCAL/wechatpay-public-key/pub_key.pem → PROD同相对路径 | RSA格式、身份读取、真实响应验签通过；安装器递归绑定此引用文件。 |
| `COMMERCE_FORMAL_PAYMENT_NOTIFY_URL` | 交易请求、回调路由 | v2 env | `https://api.cisme.cn/v1/payments/wechat/callback`；真实公网送达NOT_RUN。 |
| `COMMERCE_FORMAL_REFUND_NOTIFY_URL` | 退款请求、回调路由 | v2 env | `https://api.cisme.cn/v1/payments/wechat/refund-callback`；真实公网送达NOT_RUN。 |
| `COMMERCE_FORMAL_COMMERCE_AUTHORIZATION_FILE` | commerceAuthorization、authorizeCommerce | 已批准有限配置 → PROD/commerce-authorization.json | 6项正常业务能力按命令检查通过；不会授权代理验收实付、退款或转账。 |
| `COMMERCE_FORMAL_RECOVERY_AUTHORIZATION_FILE` | recoveryAuthorization、authorizeRecovery、recoveryTransport | 已批准有限配置 → PROD/recovery-authorization.json | 查询/账单/支付退款回调5项；实际只执行1次无订单创建的支付查询。 |
| `COMMERCE_FULFILLMENT_ENABLED`, `COMMERCE_FULFILLMENT_MERCHANT_ID` | loadConfig → fulfillmentRuntime | v2 env=true / 1000579096 | 服务构造通过，保持本地发货事实与远端同步结果分离。 |
| `COMMERCE_FULFILLMENT_AUTHORIZATION_FILE` | shippingAuthorization、runCycle、WechatOrderShippingClient | 已批准有限配置 → PROD/shipping-authorization.json | 仅shipping.query/upload；未添加电子面单或物流助手权限。账户状态查询两项48001待平台核验。 |
| `COMMERCE_ORDER_FLOW_ENABLED`, `CISME_MIGRATION_READ_ONLY`, `RUN_BACKGROUND_WORKER` | API业务开关与writer控制 | v2 env=false / true / false | 准备配置保持营业关闭；这是受控切换准备，不是最终营业状态。 |
| `UGC_GO_LIVE_GATE` | 公开UGC能力开关 | v2 env=false | 保留代码，不将公开发布纳入首发；护理/客服附件处理未移除。 |
| CONTACT、数据库、COS、`PRIVACY_FORMAL_EXPORT_KEY` | 原有持久化、加密和恢复链 | 既有R3 prepared → v2 env | 私有比较保持一致，原导出密钥未轮换；见机器回执布尔结果，无内容/摘要外泄。 |

9个落地材料包括额外的 `public-key-id.txt` 备存文件；8个运行输入是安装器实际消费的7个文件键加可信清单引用公钥。P12和ZIP留在本机备份，不复制进运行目录或应用制品。

私有保护点 `authorized-materials-and-config-v2.aesgcm` 使用既有 `/etc/cisme/backup-aes256.key` 和 AAD `CISME-R5-AUTHORIZED-MATERIALS-V2-v1`，随机nonce前12字节，其后AES-GCM密文；已在内存解密并逐字节比较。`installer-private-input-binding.json` 保存实际路径、内容摘要、UID/GID、模式、父目录及env绑定，仅root可读。它不是未来切换窗口的新鲜数据库备份，也不是main/CI资格许可。

三项授权均使用真实依据 `CISME-R5-USER-20260926`、environment production、上述AppID/商户和有限截止2026-12-25T15:59:59Z。本机提案保留原未确认历史，并追加用户澄清后委托决定；未编造微信审批或接受回执。
