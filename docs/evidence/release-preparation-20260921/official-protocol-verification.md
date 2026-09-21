# M：官方协议核验（2026-09-21）

本轮已读取以下正文；来源日期不同于本机验证日期。普通商户是当前代码实现范围，实际商户接入模式尚缺获授权配置确认，不能因此切换为服务商或灰度合作伙伴模式。

| 来源 | 页面更新时间 | 核验结果及本工程约束 |
|---|---|---|
| [W1 小程序支付开发接入准备](https://pay.wechatpay.cn/doc/v3/merchant/4015459512) | 2026-09-18 | 支付开通、AppID/mchid 绑定分别核验；交易类小程序发货管理适用性需确认。小程序支付不是网页 JSAPI 授权目录配置；Request-ID 用于渠道诊断。 |
| [W2 开发指引](https://pay.wechatpay.cn/doc/v3/merchant/4012791911) | 2026-06-09 | 原商户单号预支付、有效期、查单与回调闭环；前端成功/错误不作终态。未知结果不产生新单号。 |
| [W3 必要参数](https://pay.wechatpay.cn/doc/v3/merchant/4013070756) | 2026-06-02 | 普通商户标识、AppID 绑定、商户私钥/证书序列号、平台公钥 ID、APIv3 密钥需独立校验。本机仅按明确给定的受保护路径加载，未读取未知秘密目录。 |
| [W4 公钥验签](https://pay.wechatpay.cn/doc/v3/merchant/4013053249) | 2024-11-20 | HTTP 204 空 body 仍验签（含末尾换行）；账单下载按签名申请和文件摘要校验。已加入真实合成签名反例。 |
| [W5 支付成功回调](https://pay.wechatpay.cn/doc/v3/merchant/4012791902) | 2024-12-27 | associated_data 可选；缺省归一化空串，非法类型拒绝。保留原 body 验签解密并可靠入 Inbox 后应答；慢业务由 worker 处理。目标应答时间不等于实际代理链已测。 |
| [W6 回调和查单指引](https://pay.wechatpay.cn/doc/v3/merchant/4012075249) | 2024-12-18 | 查单/通知/账单构成恢复闭环；原单号恢复，前端不决定交易终态。 |
| [W7 转账升级说明](https://pay.wechatpay.cn/doc/v3/merchant/4015273741) | 2026-08-12 | 商家转账是独立产品及权限；新接口和用户确认方式不能由“小程序支付已开通”推断。本轮未开通、申请或执行真实转账。 |
| [W8 腾讯云隐私指引适配](https://cloud.tencent.com/document/product/1301/97930) | 以读取正文为准 | 此文面向微搭。仅采用隐私指引及相应微信隐私接口的前置约束；不套用其部署/自动弹窗方案。 |

[微信原生 PrivacyAuthorize 正文](https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/PrivacyAuthorize.html)本轮公开读取失败，不能视为已核验最新平台规则。项目当前实际声明 `chooseAddress`，电话授权另按实际调用、隐私指引与后台配置逐项核对；不以工具登录态证明后台配置。

[W9 山西通知](https://sxca.miit.gov.cn/zwgk/tzgg/art/2024/art_2ab1282ce0a941caafe53eebf15f45d5.html)本轮读取超时。已补核[工信部 2023 年 105 号通知原文](https://www.miit.gov.cn/zwgk/zcwj/wjfb/tz/art/2023/art_920db564162e4312916a01bed6540ad8.html)及[官方解读](https://www.miit.gov.cn/jgsj/xgj/hlwgl/art/2023/art_564bf0759d7e41d5b4aa8ce4996b9e84.html)：备案与公开运营前置关系适用，历史过渡日期不作为本轮排期。用户报告“备案审核中”，未推断后台具体上传/提审按钮可用；其等待不阻塞安全工程、隔离测试和材料制作。微信备案操作正文及本 AppID 当前状态仍须获授权渠道核实。

以上资料不证明实际商户绑定、平台权限、回调可达、真实支付/退款或发布批准。没有一般性 APIv3 sandbox 的假设，也没有把 staging、小金额或 APP_ENV=test 视为不动真钱的保证。

补核 [商户号、商户 API 证书与序列号匹配排错](https://pay.wechatpay.cn/doc/v3/merchant/4012365345)（2024-12-12）：官方明确用证书 CN 查看对应商户号，并核对商户 API 证书 serial。正式恢复装配新增私钥/证书/CN/serial/有效期本地精确绑定；不以平台证书替代商户证书，不以本地一致性宣称商户绑定/权限或证书线上有效。
