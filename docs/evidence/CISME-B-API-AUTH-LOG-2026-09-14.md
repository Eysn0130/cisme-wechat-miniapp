# B 阶段：接口授权与日志的当前实证（进行中）

基线：PRD 文件 `CISME-产品需求文档-PRD-V2.1-R4.md`（正文 R4.2），§3.1–3.2、§11.3、§15.3/RBAC-01。仅本地隔离环境和合成数据；不是云端或真机证据。

## 口径

运行时 Fastify 注册路由与源码清单、OpenAPI 一致：当前 **224 个 `/v1` method/path**，另有 2 个 health 方法。224/224 有显式 OpenAPI `security` 声明：193 个须签名会话、30 个无会员会话（含公开读取、短期签名媒体、平台回调）、1 个允许游客或签名会员；唯一安全 scheme 为 `session`。公开/可选例外已固定在 `openapi-security-coverage.test.ts` 中；新增或改成公开接口必须显式审阅该清单，遗漏 `security` 会失败。对 193 个签名入口逐条执行无凭据及伪造 Bearer/actor 探针，386/386 返回 401（`protected-route-entry.test.ts`）；这不测试对象/字段/capability，也不把其余 31 个入口当作无保护。原有 22 处旧 `/v1/admin/*` 的共享 token + 自报 principal 声明已更正；新增合成导出、擦除批准和恢复后，当前 25 个管理入口全部在参数化集成测试中确认仅持旧共享口令均为 401。此项只是**契约/入口身份检查**，不等于 224 个业务授权验证。`tests/integration/contract-inventory.test.ts` 校验运行时与源码，`tests/unit/openapi-security-coverage.test.ts` 校验源码与文档及例外清单；`tests/integration/legacy-admin-auth.test.ts` 动态枚举当前管理入口。

按“身份来源、对象、字段、审计与针对性执行测试均已核对”的严格口径，当前**已验证 23 / 224，未验证 201 / 224；这 23 项新增检查中未留下已证实缺陷**。此数量只计算下表地址簿、合成隐私执行、手机号、待支付订单基础接口与合成退款接口，其他测试已有局部覆盖但尚未完成逐项归属核对，暂不计入。未验证项不能推定无缺陷，整个 B 阶段不能标记 PASS。

| Method / path | 类别；可信身份；capability | 对象归属；可读/可写字段；审计 | 合成执行结论 / 测试 ID |
|---|---|---|---|
| `GET /v1/me/addresses` | 会员；签名 active member；无管理 capability | `member_id` 仅当前会员；只返回本人解密后的地址字段；读取不写审计 | 游客 401，B 看不到 A 的地址；`delivery-address.test.ts` / stores address PII encrypted |
| `POST /v1/me/addresses` | 会员；签名 active member；无管理 capability | `member_id` 只由会话确定，提交 `memberId`/`role` 不提权；输入白名单归一化，加密存储；创建写审计 | 伪造归属字段未进入 B，幂等重放不重复创建；同上 |
| `PUT /v1/me/addresses/{addressId}` | 会员；签名 active member；无管理 capability | `id + member_id`，版本守卫；只改本人地址，更新写审计 | B 改 A 地址为 404，过期版本 409；`delivery-address.test.ts` / enforces optimistic versions |
| `POST /v1/me/addresses/{addressId}/default` | 会员；签名 active member；无管理 capability | `id + member_id`，版本守卫；只改变本人默认项，写审计 | B 设 A 地址默认值为 404；同上 |
| `DELETE /v1/me/addresses/{addressId}` | 会员；签名 active member；无管理 capability | `id + member_id`，软删除及默认项迁移，写审计仅在本人的存在对象上发生 | B 删除 A 地址按既有幂等语义返回 200，但 A 对象仍在且不新增审计；`delivery-address.test.ts` / enforces optimistic versions、soft-deletes |
| `GET /v1/me/phone` | 会员；签名 active member；无管理 capability | `member_id` 只从会话取；仅返回是否开通、是否绑定及本人掩码，不返回密文/原号；只读无写审计 | 游客 401，B 不见 A 的绑定和尾号；`phone-route-authorization.test.ts` / signed-member phone routes |
| `POST /v1/me/phone` | 会员；签名 active member；无管理 capability | 仅接收一次性微信授权 `code`，客户端 `memberId/principalId/role` 不作归属；按服务端绑定的 AppID 水印、code/手机号冲突守卫，加密存储，写 `member.phone_bound` 审计 | 游客 401，B 复用 A code 409，伪造归属仍只绑定当前会员，响应只有掩码；同上及 `member-registration.test.ts` / encrypts phone |
| `DELETE /v1/me/phone` | 会员；签名 active member；无管理 capability | `member_id` 只从会话取；忽略伪造正文，仅删除本人联系方式；有删除事实时写 `member.phone_unbound` 审计 | 游客 401，B 传 A id 只删 B，A 电话及审计未改；同上及 `member-profile-display.test.ts` / phone unbinding |
| `POST /v1/me/commerce/quotes` | 会员；签名 active member；无管理 capability | 地址必须属于本人且版本匹配；只收 SKU/数量/地址/版本及隔离测试才可用的权益字段；价格、币种和库存由服务端定；创建写 `commerce.quote.create` 审计 | B 以 A 地址报价 404，伪造 memberId/role/总价 422，A 报价审计为签名 actor，幂等漂移 409；`commerce-orders.test.ts` / quotes server-authoritative totals |
| `POST /v1/me/orders` | 会员；签名 active member；无管理 capability | 报价 `id + member_id`，正文只许 `quoteId`；订单归属、地址快照、金额和状态由服务端生成，写 `commerce.order.create` 审计 | B 用 A 报价创建 404，伪造 memberId/status/role 422，A 创建审计为签名 actor，重复键不重复占库存；同上 / immutable pending order |
| `GET /v1/me/orders` | 会员；签名 active member；无管理 capability | 列表 SQL `member_id` 过滤；只返回本人摘要且 `address=null`，不解密地址；只读无写审计 | B 列表不含 A 订单/电话，A 列表地址为空且查询有界；同上 / list summaries |
| `GET /v1/me/orders/{orderId}` | 会员；签名 active member；无管理 capability | `id + member_id`；只给本人明文地址快照，不返回加密存储字段；只读无写审计 | B 读 A 订单 404，A 可读地址/手机号，响应无密文字段；同上 / immutable pending order |
| `POST /v1/me/orders/{orderId}/cancel` | 会员；签名 active member；无管理 capability | `id + member_id + version`，仅待支付可取消，释放预留；伪造 memberId/role/status 不参与决策，写服务端签名 actor 的取消审计和状态转换 | B 取消 A 404 且无取消审计，A 即使带伪造字段也只取消本人，审计 actor 为 A；相同键重放不重复释放，改目标 409；同上 / immutable pending order |
| `POST /v1/me/orders/{orderId}/refund-requests` | 会员；签名 active member；无管理 capability | 已核验支付订单 `id + member_id`，金额受原支付及累计申请上限约束；提交 memberId/status/role 不改归属/状态；请求记录及新增 `commerce.refund.request` 审计只存签名主体、状态、金额，不复制自由文本原因 | 游客 401，B 申请 A 订单 404，A 伪造 B 身份仍为本人 requested；幂等重放不重复请求或审计；`payment-http-simulation.test.ts` / partial refunds and cumulative cents |
| `GET /v1/me/refund-requests` | 会员；签名 active member；无管理 capability | `requested_by_member_id` 固定本人；`orderId` 仅过滤本人记录，分页 cursor 绑定本人/订单范围；只返回申请摘要和金额/状态/原因，不包含支付凭据；只读无写审计 | 游客 401，B 用 A `orderId` 得空列表，A 分页总数和记录正确；同上 / partial refunds |
| `GET /v1/management/refund-requests/pending` | 管理；签名 active member，服务端 `commerce.refund.approve` capability | 全局待审批队列仅对该 capability 开放；字段限申请 ID、订单 ID、申请者 ID、金额、原因、版本和时间；只读无写审计 | 游客 401，无 capability 的 B 403，授权运营者能见当前待审申请；同上 / partial refunds |
| `POST /v1/management/refund-requests/{requestId}/decision` | 管理；签名 active member，服务端 `commerce.refund.approve` capability | 申请 ID/version、已核验订单状态与原支付/商品分摊事实；申请人或佣金受益人不可自批；提交 memberId/principalId/role 不改审批 actor；写 `commerce.refund.decision` 审计 | 游客 401，无 capability 403，申请人即使有 capability 仍 403，独立审批 200；审计 actor 为签名运营者，累计金额和原退款号保持权威；同上 / partial refunds |
| `POST /v1/management/refund-submissions/{intentId}/redrive` | 管理；签名 active member，服务端 `commerce.money.reconcile` capability | 仅 quarantined 的 prepared/unknown 原意图，`expectedAttempts` 守卫；伪造 memberId/principalId/state 不改对象或 actor；保留原退款号、只重新查单，写 `commerce.refund_submission_redrive` 审计 | 游客 401，无 capability 403，授权运营者一次重驱 200、同状态重复 409；审计恰一次且 actor 正确、合成渠道无第二个退款号；同上 / original refund number through unknown response |
| `POST /v1/admin/privacy-requests/{requestId}/export-approval` | 管理；签名 active operator，服务端 `review_lead` 角色；必须是不同计划人 | 仅 `dev_test` 会员、`APP_ENV=test` 与独立密钥、固定会员资料范围；版本/状态守卫；原因码与 before/after 审计 | 计划人及 support 403、旧版本 409、伪造 actor 403、第二复核人 200；`privacy-rights.test.ts` / synthetic profile export |
| `GET /v1/me/privacy-requests/{requestId}/export` | 会员；签名 active member；无管理 capability | `request_id + member_id`，只解密本人未过期、未撤销的子集；字段白名单排除他人、手机号密文、token；逐次读取审计 | B 访问 A 为 404，正常读取 200/no-store，过期/撤销 404；`privacy-rights.test.ts` / synthetic profile export |
| `POST /v1/me/privacy-requests/{requestId}/export-revoke` | 会员；签名 active member；无管理 capability | `request_id + member_id`，忽略伪造 `memberId` 正文；仅修改本人的副本可用性，写 before/after 审计 | B 伪造 owner 字段仍 404，本人撤销 200、后续读取 404；`privacy-rights.test.ts` / synthetic profile export |
| `POST /v1/admin/privacy-requests/{requestId}/erasure-approval` | 管理；签名 active operator，服务端 `review_lead` 且非计划人 | 仅 `dev_test`、`APP_ENV=test`、独立密钥；本人不可改的 `scope_code` 与计划范围一致；测试保留政策 active、无 member/profile 法定保留；版本/原因码/审计 | 自批/support/伪造 actor 403，旧版本/未知政策/有保留 409；第二复核人 200；`privacy-rights.test.ts` / scoped profile-handle erasure |
| `POST /v1/admin/privacy-requests/{requestId}/execution-redrive` | 管理；签名 active operator、服务端 `review_lead` | 仅已耗尽、固定范围、同一合成主体；擦除需再查政策/保留；重试归零不扩大字段范围；原因码与状态审计 | support 403，旧版本/有保留 409；人工复核恢复后仅原范围执行，删除失败回滚无部分落库；`privacy-rights.test.ts` / exhausted synthetic redrive |

## 日志回归

此前 Fastify 自动请求日志会保留原始 URL，`request.log.error(error)` 与 worker `console.error(error)` 会序列化任意异常信息；调用方提供的 `x-request-id` 也可进入日志。现在关闭自动请求行，仅记录 route template、服务端生成的 trace ID、状态与耗时；5xx/worker 只写受控 `failure_class` 和安全格式的 `failure_code`。`runtime-log-redaction.test.ts` 把合成手机号/地址/签名 URL/token 标记放在 query、Authorization、`x-request-id`、数据库错误 message/detail/query 中，确认日志无该标记。HTTP 状态及业务 `application/problem+json` 未变。

追查管理失败队列时还发现 `outbox_event.last_error`、`media_cleanup_queue.last_error` 原先保存 `String(error)`，随后可经管理读取和 redrive 审计传播。现只保存已知 worker 常量、白名单 SQLSTATE 或通用故障类；`worker-delivery.test.ts` 合成私密标记的存储删除异常验证持久化字段没有标记，同时确认保存点隔离、重试、死信和恢复用例仍通过。历史队列中若已存原始异常，本改动不会自动清洗；需要在隔离/正式数据清理方案中单独核定。

手机号路由的外部微信响应由 `createApp` **仅在 `APP_ENV=test`** 接受的合成 fetcher 注入；其它环境仍使用原实例默认微信传输，本轮未调用真实手机号接口或更改平台设置。

待做：剩余 201 路由按同样口径逐项核对，优先已验证基础订单与退款之后的支付/佣金、管理授权、隐私权利其它入口、客服与 UGC 媒体；继续检查其它队列/第三方 SDK 的错误持久化路径；正式运维身份签发方案尚未获平台批准。因此 `CODE_SECURITY_READY=false`、`ENGINEERING_MERGE_READY=false`、`RELEASE_READY=false`。
