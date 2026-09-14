# B 阶段：接口授权与日志的当前实证（进行中）

基线：PRD 文件 `CISME-产品需求文档-PRD-V2.1-R4.md`（正文 R4.2），§3.1–3.2、§11.3、§15.3/RBAC-01。仅本地隔离环境和合成数据；不是云端或真机证据。

## 口径

运行时 Fastify 注册路由与源码清单、OpenAPI 一致：**219 个 `/v1` method/path**，另有 2 个 health 方法。219/219 有显式 OpenAPI `security` 声明，安全方案只剩签名 `session`；其中 22 处旧 `/v1/admin/*` 的共享 token + 自报 principal 声明已更正，并以参数化集成测试逐条确认仅持旧共享口令均为 401。此项只是**契约/入口身份检查**，不等于 219 个业务授权验证，也不等于 22 个管理动作的能力、对象和字段验证。`tests/integration/contract-inventory.test.ts` 校验运行时与源码，`tests/unit/openapi-security-coverage.test.ts` 校验源码与文档、管理入口会话声明和新接口声明缺失；`tests/integration/legacy-admin-auth.test.ts` 校验 22 个入口。

按“身份来源、对象、字段、审计与针对性执行测试均已核对”的严格口径，当前**已验证 5 / 219，未验证 214 / 219；这 5 项新增检查中未留下已证实缺陷**。此数量只计算下表地址簿接口，其他测试已有局部覆盖但尚未完成逐项归属核对，暂不计入。未验证项不能推定无缺陷，整个 B 阶段不能标记 PASS。

| Method / path | 类别；可信身份；capability | 对象归属；可读/可写字段；审计 | 合成执行结论 / 测试 ID |
|---|---|---|---|
| `GET /v1/me/addresses` | 会员；签名 active member；无管理 capability | `member_id` 仅当前会员；只返回本人解密后的地址字段；读取不写审计 | 游客 401，B 看不到 A 的地址；`delivery-address.test.ts` / stores address PII encrypted |
| `POST /v1/me/addresses` | 会员；签名 active member；无管理 capability | `member_id` 只由会话确定，提交 `memberId`/`role` 不提权；输入白名单归一化，加密存储；创建写审计 | 伪造归属字段未进入 B，幂等重放不重复创建；同上 |
| `PUT /v1/me/addresses/{addressId}` | 会员；签名 active member；无管理 capability | `id + member_id`，版本守卫；只改本人地址，更新写审计 | B 改 A 地址为 404，过期版本 409；`delivery-address.test.ts` / enforces optimistic versions |
| `POST /v1/me/addresses/{addressId}/default` | 会员；签名 active member；无管理 capability | `id + member_id`，版本守卫；只改变本人默认项，写审计 | B 设 A 地址默认值为 404；同上 |
| `DELETE /v1/me/addresses/{addressId}` | 会员；签名 active member；无管理 capability | `id + member_id`，软删除及默认项迁移，写审计仅在本人的存在对象上发生 | B 删除 A 地址按既有幂等语义返回 200，但 A 对象仍在且不新增审计；`delivery-address.test.ts` / enforces optimistic versions、soft-deletes |

## 日志回归

此前 Fastify 自动请求日志会保留原始 URL，`request.log.error(error)` 与 worker `console.error(error)` 会序列化任意异常信息；调用方提供的 `x-request-id` 也可进入日志。现在关闭自动请求行，仅记录 route template、服务端生成的 trace ID、状态与耗时；5xx/worker 只写受控 `failure_class` 和安全格式的 `failure_code`。`runtime-log-redaction.test.ts` 把合成手机号/地址/签名 URL/token 标记放在 query、Authorization、`x-request-id`、数据库错误 message/detail/query 中，确认日志无该标记。HTTP 状态及业务 `application/problem+json` 未变。

追查管理失败队列时还发现 `outbox_event.last_error`、`media_cleanup_queue.last_error` 原先保存 `String(error)`，随后可经管理读取和 redrive 审计传播。现只保存已知 worker 常量、白名单 SQLSTATE 或通用故障类；`worker-delivery.test.ts` 合成私密标记的存储删除异常验证持久化字段没有标记，同时确认保存点隔离、重试、死信和恢复用例仍通过。历史队列中若已存原始异常，本改动不会自动清洗；需要在隔离/正式数据清理方案中单独核定。

待做：剩余 214 路由按同样口径逐项核对，优先订单/退款/佣金、管理授权、手机号、隐私权利、客服与 UGC 媒体；继续检查其它队列/第三方 SDK 的错误持久化路径；正式运维身份签发方案尚未获平台批准。因此 `CODE_SECURITY_READY=false`、`ENGINEERING_MERGE_READY=false`、`RELEASE_READY=false`。
