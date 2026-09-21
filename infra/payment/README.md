# 正式支付历史恢复装配（默认关闭）

PRD R4.2 §8.2/8.4、§11.2/11.3、§13；普通商户路径延续现有协议实现，实际商户模式仍待后台核实。没有改变 One-App/MAKE 决策。

`COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED` 仅装配与校验本机受保护密钥；配置现有 appId/mchid/serial、private key/APIv3 key/trust manifest 路径及 payment/refund notify HTTPS 地址。全部文件必须为 regular file、无符号链接、0600 或更严，拥有者为进程用户或 root；平台公钥清单内的文件也适用。只读取显式路径，不搜索秘密目录。不把凭据、完整订单、token 或回调体放入 Git/日志。

可选 `COMMERCE_FORMAL_RECOVERY_AUTHORIZATION_FILE` 指向**另行审批后**安装的 0600 JSON。示例故意不可用：没有批准、能力为空且已过期。每次调用重新核对环境（staging/production）、精确 AppID/mchid、ordinary-merchant 模式、到期时间与审批引用；删除/撤销/过期立即拒绝后续出站和通知接收。平台真实绑定不能仅靠 JSON 自证，安装前须由授权人核验。APIv3 不假设通用 sandbox。

独立能力：`payment.query`、`refund.query`、`bill.read`、`payment.callback`、`refund.callback`。传输仅允许正式 HTTPS 主域的已列 GET 路径及两个渠道域的签名账单下载路径；禁重定向和所有 POST。SDK 继续验证签名、金额/身份/币种/单号以及账单摘要、流大小和超时。日志只留能力/审批引用/状态/Request-ID/耗时，不留 URL、报文或鉴权头。

API 与独立 worker 均装配这些恢复通道。历史回调先验签解密与绑定、持久化 Inbox 后 204；后台处理复用现有账本和事务。回调授权与查单授权分开；退款 worker 只查已受理单，绝不 processDue 发送新退款。某一通道没有授权不阻断其他独立通道。反向代理必须保留原始 body 和 Wechatpay-* 头；实际代理透传尚待获授权环境验证。

**本次没有安装任何真实授权文件或调用商户接口。** 正式新单、预支付、关闭订单、退款发送、转账、权益消费、双人履约政策仍由原门禁关闭，不能改 paymentAvailable 开放。正式新资金命令/履约与微信订单发货管理的完整生产装配仍属未完成源码工作，不能归为“负责人待截图”。真实验证必须另列具体订单/金额上限/次数/操作者/退款核对/停止条件，由负责人批准且人工操作。
