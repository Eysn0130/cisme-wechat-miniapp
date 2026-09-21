# 已审查的接口切片与未关闭维度

全量分母见 api-surface.json（228 方法/路由），实际 HTTP 命中见 executed-http-evidence.json。全量清单不是全量安全审查已完成。下列是本轮人工源码审查加反例覆盖的具体切片；不要把同文件其他方法自动计为已通过。

| 切片 | 身份 / 对象 / 字段 / 动作 | 幂等 / 并发 / 副作用 | 已执行证据及余项 |
|---|---|---|---|
| GET `/v1/admin/runtime-metrics` | 签名、active；每次检查 review_lead/auditor/support，拒绝伪造 actor；只返回聚合，不含 IDs/PII | 只读，重复调用只影响进程指标；数据库计数不触发重投，不将 unknown 判失败 | legacy-admin-auth、operational-signals；真实值守送达未做，多实例指标聚合另需实现 |
| POST `/v1/identity/wechat` | 固定 AppID 的服务端交换；code 有界，不信任调用方 OpenID/role；只采 openid/unionid；现行协议事务校验 | 自然身份 key advisory lock；既有身份不覆盖本人资料；服务端签发会话；外部交换 12 秒/64 KiB/禁止重定向 | identity-public-boundary、member-registration、wechat-identity；真实配置/平台登录未验证；恶意滥用的全生命周期仍需负载审查 |
| GET `/v1/bootstrap/{home,profile,settings}` | 签名与 service 主体快照；输出不含 provider 标识/密钥 | 只读组合事实，HTTP 执行不代表所有角色状态均测 | identity-public-boundary、native-operation-budget；封禁、ABA 与全部返回字段逐项审查尚未闭合 |
| POST/PUT/DELETE/default `/v1/me/addresses` | 只用 session 主体，行查询带 member_id；归一化和版本约束；PII 加密，管理快照另遮盖；事务 active 锁 | 新增 key 绑定 HMAC，不同输入 409；已有 common 幂等表只记 ID；所有写先 member 后 address；并发不同载荷同 key 仅一个创建；旧无摘要须核对 | delivery-address、member-write-revocation；删他人 ID 返回幂等不存在且不改对方；所有输入边界/密钥轮换策略仍需综合验收 |
| POST/DELETE `/v1/me/phone` | session 主体不可被 body 替换；事务 active 锁；平台 watermark AppID 校验；仅 masked 输出 | code/phone HMAC advisory locks，代码绑定主体；不自动合并账号；加密及审计同事务；先获授权事务与封禁线性排序 | phone-route-authorization、member-registration、member-write-revocation；手机号 provider 已加 64 KiB 流限制/禁重定向/字段类型检查，真实平台未接验 |
| GET `/v1/ugc/own-preview/{ownerId}/{mediaId}` | 签名期限、owner/asset/source-post 状态和 active 主体复核；不因短期 URL 绕过封禁 | 只读私有原图，不缓存公开；不能据此声称撤回已下载副本 | formal-ugc-editor；真实 COS 和外部缓存行为未验证 |
| GET `/v1/ugc/scan-source/{mediaId}` | 签名期限/revision/hash、待审版本；作者 active、asset owner 等于 post author | 拒绝后不读取对象；现有 callbacks 可记录迟到事实但不复活删帖 | ugc-safety；扫描 provider 已加 64 KiB 流限制/禁重定向；真实配置和延迟撤权竞态仍需后续审查 |
| GET/POST `/v1/ugc/safety-callback` | 无会员会话，由平台签名/时间/加密/AppID 边界认证；合成明文只 test 配置 | inbox trace 去重、冲突拒绝、版本对应；不能复活 deleted 或用旧 scan 覆盖新结果 | identity-public-boundary、ugc-safety、rate-limits；真实反向代理保真及后台配置待隔离部署验证 |
| 支付/退款/转账及账单 | 原号/金额/币种/主体绑定，验签解密，普通商户恢复 grant 分能力；商户证书 CN/serial/key 精确一致 | 原号保留，dispatch marker/lease/fencing、Inbox/Outbox，未知不重发；库存与佣金事务副作用 | payment-http-simulation、verified-payment-inbox、wechat-pay-v3；当前正式源码仅历史恢复，新订单/资金命令/正式履约策略仍未完成 |

PRD 依据为 `docs/product/CISME-产品需求文档-PRD-V2.1-R4.md` 的身份、会员资料/地址、隐私、社区治理、交易及验收章节；本文件尚未把每一方法绑定到具体稳定验收 ID，因此 api-surface 的 `prdBusinessId` 继续 UNREVIEWED。没有以自动文本搜索替代业务裁决。

限流由统一 rateLimits/operationBudget 入口和各服务分页施加；195 个 signed 方法已实际拒绝无会话和伪造会话。这只证明入口维度，不能证明每个操作的对象/字段/状态/动作、幂等、并发和副作用。剩余维度及后台 worker/storage/平台回调非路由面仍是技术工作，不能列为负责人补截图即可关闭。
