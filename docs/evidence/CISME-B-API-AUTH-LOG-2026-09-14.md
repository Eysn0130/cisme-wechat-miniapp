# B 阶段：接口授权与日志的当前实证（进行中）

基线：PRD 文件 `CISME-产品需求文档-PRD-V2.1-R4.md`（正文 R4.2），§3.1–3.2、§11.3、§15.3/RBAC-01。仅本地隔离环境和合成数据；不是云端或真机证据。

## 口径

运行时 Fastify 注册路由与源码清单、OpenAPI 一致：当前 **224 个 `/v1` method/path**，另有 2 个 health 方法。224/224 有显式 OpenAPI `security` 声明，安全方案只剩签名 `session`；其中原有 22 处旧 `/v1/admin/*` 的共享 token + 自报 principal 声明已更正。新增合成导出、擦除批准和恢复后，当前 25 个管理入口全部在参数化集成测试中确认仅持旧共享口令均为 401。此项只是**契约/入口身份检查**，不等于 224 个业务授权验证。`tests/integration/contract-inventory.test.ts` 校验运行时与源码，`tests/unit/openapi-security-coverage.test.ts` 校验源码与文档、管理入口会话声明和新接口声明缺失；`tests/integration/legacy-admin-auth.test.ts` 动态枚举当前管理入口。

按“身份来源、对象、字段、审计与针对性执行测试均已核对”的严格口径，当前**已验证 10 / 224，未验证 214 / 224；这 10 项新增检查中未留下已证实缺陷**。此数量只计算下表地址簿和合成隐私执行接口，其他测试已有局部覆盖但尚未完成逐项归属核对，暂不计入。未验证项不能推定无缺陷，整个 B 阶段不能标记 PASS。

| Method / path | 类别；可信身份；capability | 对象归属；可读/可写字段；审计 | 合成执行结论 / 测试 ID |
|---|---|---|---|
| `GET /v1/me/addresses` | 会员；签名 active member；无管理 capability | `member_id` 仅当前会员；只返回本人解密后的地址字段；读取不写审计 | 游客 401，B 看不到 A 的地址；`delivery-address.test.ts` / stores address PII encrypted |
| `POST /v1/me/addresses` | 会员；签名 active member；无管理 capability | `member_id` 只由会话确定，提交 `memberId`/`role` 不提权；输入白名单归一化，加密存储；创建写审计 | 伪造归属字段未进入 B，幂等重放不重复创建；同上 |
| `PUT /v1/me/addresses/{addressId}` | 会员；签名 active member；无管理 capability | `id + member_id`，版本守卫；只改本人地址，更新写审计 | B 改 A 地址为 404，过期版本 409；`delivery-address.test.ts` / enforces optimistic versions |
| `POST /v1/me/addresses/{addressId}/default` | 会员；签名 active member；无管理 capability | `id + member_id`，版本守卫；只改变本人默认项，写审计 | B 设 A 地址默认值为 404；同上 |
| `DELETE /v1/me/addresses/{addressId}` | 会员；签名 active member；无管理 capability | `id + member_id`，软删除及默认项迁移，写审计仅在本人的存在对象上发生 | B 删除 A 地址按既有幂等语义返回 200，但 A 对象仍在且不新增审计；`delivery-address.test.ts` / enforces optimistic versions、soft-deletes |
| `POST /v1/admin/privacy-requests/{requestId}/export-approval` | 管理；签名 active operator，服务端 `review_lead` 角色；必须是不同计划人 | 仅 `dev_test` 会员、`APP_ENV=test` 与独立密钥、固定会员资料范围；版本/状态守卫；原因码与 before/after 审计 | 计划人及 support 403、旧版本 409、伪造 actor 403、第二复核人 200；`privacy-rights.test.ts` / synthetic profile export |
| `GET /v1/me/privacy-requests/{requestId}/export` | 会员；签名 active member；无管理 capability | `request_id + member_id`，只解密本人未过期、未撤销的子集；字段白名单排除他人、手机号密文、token；逐次读取审计 | B 访问 A 为 404，正常读取 200/no-store，过期/撤销 404；`privacy-rights.test.ts` / synthetic profile export |
| `POST /v1/me/privacy-requests/{requestId}/export-revoke` | 会员；签名 active member；无管理 capability | `request_id + member_id`，忽略伪造 `memberId` 正文；仅修改本人的副本可用性，写 before/after 审计 | B 伪造 owner 字段仍 404，本人撤销 200、后续读取 404；`privacy-rights.test.ts` / synthetic profile export |
| `POST /v1/admin/privacy-requests/{requestId}/erasure-approval` | 管理；签名 active operator，服务端 `review_lead` 且非计划人 | 仅 `dev_test`、`APP_ENV=test`、独立密钥；本人不可改的 `scope_code` 与计划范围一致；测试保留政策 active、无 member/profile 法定保留；版本/原因码/审计 | 自批/support/伪造 actor 403，旧版本/未知政策/有保留 409；第二复核人 200；`privacy-rights.test.ts` / scoped profile-handle erasure |
| `POST /v1/admin/privacy-requests/{requestId}/execution-redrive` | 管理；签名 active operator、服务端 `review_lead` | 仅已耗尽、固定范围、同一合成主体；擦除需再查政策/保留；重试归零不扩大字段范围；原因码与状态审计 | support 403，旧版本/有保留 409；人工复核恢复后仅原范围执行，删除失败回滚无部分落库；`privacy-rights.test.ts` / exhausted synthetic redrive |

## 日志回归

此前 Fastify 自动请求日志会保留原始 URL，`request.log.error(error)` 与 worker `console.error(error)` 会序列化任意异常信息；调用方提供的 `x-request-id` 也可进入日志。现在关闭自动请求行，仅记录 route template、服务端生成的 trace ID、状态与耗时；5xx/worker 只写受控 `failure_class` 和安全格式的 `failure_code`。`runtime-log-redaction.test.ts` 把合成手机号/地址/签名 URL/token 标记放在 query、Authorization、`x-request-id`、数据库错误 message/detail/query 中，确认日志无该标记。HTTP 状态及业务 `application/problem+json` 未变。

追查管理失败队列时还发现 `outbox_event.last_error`、`media_cleanup_queue.last_error` 原先保存 `String(error)`，随后可经管理读取和 redrive 审计传播。现只保存已知 worker 常量、白名单 SQLSTATE 或通用故障类；`worker-delivery.test.ts` 合成私密标记的存储删除异常验证持久化字段没有标记，同时确认保存点隔离、重试、死信和恢复用例仍通过。历史队列中若已存原始异常，本改动不会自动清洗；需要在隔离/正式数据清理方案中单独核定。

待做：剩余 214 路由按同样口径逐项核对，优先订单/退款/佣金、管理授权、手机号、隐私权利其它入口、客服与 UGC 媒体；继续检查其它队列/第三方 SDK 的错误持久化路径；正式运维身份签发方案尚未获平台批准。因此 `CODE_SECURITY_READY=false`、`ENGINEERING_MERGE_READY=false`、`RELEASE_READY=false`。
