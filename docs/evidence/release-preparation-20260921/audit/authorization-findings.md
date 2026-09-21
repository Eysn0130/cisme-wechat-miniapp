# 本轮授权反例与修复

范围依据 PRD §3、§4.3、§5.1、§6.6.2、§11。当前审计仍未逐条验收全部接口；`api-surface.json` 的测试引用只是定位候选，不是覆盖结论。

| 缺陷 | 修复前合成反例 | 修复与已执行证据 |
|---|---|---|
| 会员被停用后，仍有效的上传 token 可写入护理/UGC 图片 | cloud-upload 新增用例失败；UGC chunks/assemble 反例失败 | 同事务锁定 active 主体，写入提交前维持授权顺序。`cloud-upload.test.ts`、`formal-ugc-editor.test.ts`。正式直接 S3 的签名授权撤销能力不能从此推断；UGC 直接 S3 仍禁用。 |
| UGC 原草稿已删除后，未消耗的上传授权仍可写入 | `invalidates unconsumed upload grants when their source draft is deleted` 修复前收到成功，预期锁定错误 | post→asset 与 complete/submit 使用一致锁顺序；检查原作者/原内容和 uploads 开关。chunks/assemble 两路径均拒绝。 |
| 已获权限事务与撤权更新没有数据库锁序 | 两个真实 PG 连接：命令持有事务时，撤权 UPDATE 原先立即成功 | `AuthorityService.requireWithClient` 锁定 grant/member；撤权等待提交，后续调用拒绝。`authority-revocation.test.ts`。非事务入口不借此继承全部并发保证。 |
| blocked 主体仍获得 capability projection/has=true | 独立新授予权限后将会员停用，原测试失败 | require/has/requireAny/projection 统一校验 active 会员。 |

定向修复后 4 文件 14 测试通过；此前完整 706 集成通过发生在原草稿状态修复前，最终准确 HEAD CI 必须另核。补丁中一次范围过宽的替换曾误影响审核路径，测试发现并修正，审核用例已重新通过。

安全边界：没有对生产角色或商户权限进行修改；所有反例仅在本次新建实例的合成主体/对象上执行。原始本机日志位于 `tmp/release-preparation/{upload-revocation-before,ugc-upload-before,authority-before,ugc-source-before,authorization-after-final}.log`，不会把这些日志中的历史失败覆盖成通过。

## 后续复核：私有图片读取撤权

`revokes signed own-image preview URLs when the owning member is blocked` 在修复前实际返回 200（应 404），证明有效期内的本人图片签名 URL 未校验主体停用。现在两种本人预览投影均在读取时检查 active 会员；签名、原作者、原内容状态、原图片关系和期限检查继续保留。定向 `formal-ugc-editor` 全部 5 用例及运维信号用例通过。原始反例日志 `tmp/release-preparation/preview-revocation-before.log`。

## Runtime metrics and WeChat identity input (current operations batch)

`GET /v1/admin/runtime-metrics` accepted an ordinary signed member and exposed aggregate operations facts. The new HTTP counterexample failed with 200 instead of 403 on the pre-fix handler. It now checks the existing operations-reader roles (`review_lead`, `auditor`, `support`), rechecks each read and rejects role revocation; it does not add grants. First attempted runner invocation failed to find `vitest`; the recorded before/after evidence is from the subsequent successful disposable npm launcher.

`POST /v1/identity/wechat` coerced missing/object codes into an external request; the injected-transport counterexample returned 500. Input is now bounded and rejected before dispatch; provider responses are streamed with a 64 KiB limit, redirects denied, and typed identifiers alone passed into the existing identity transaction. Provider error text/session_key never enters the client projection. Synthetic HTTP tests cover malformed input, provider failures, current consent, app binding, three bootstrap projections and no unexpected identity writes. This is not a real WeChat credential/login acceptance.

The five previously unobserved HTTP entry points now have targeted executions, including public capability/UGC status and signed challenge/unsigned scan source. A missing successful status still requires semantic review: a deliberately closed feature can correctly return 503. The executed route report does not close the 13-axis security audit by itself.

## Member write revocation, scanner URLs, address command identity

A service-level counterexample using a blocked synthetic member created an address because `SELECT ... status='active' FOR UPDATE` was not checked for an empty result. The phone binding transaction likewise proceeded to its injected provider while blocked. Address create/update/default/remove and phone bind/unbind now require an active member while holding the member row lock through commit. A real second PostgreSQL connection confirms suspension cannot overtake an already-authorized phone transaction; after suspension a new command is denied. This is a linearized authorization boundary, not a claim that an action committed before suspension is retroactively undone.

A valid content-scanner URL still returned synthetic bytes after author suspension. Scan-source now also checks active author and asset-owner/post-author equality, before reading storage. Existing signature/revision/state/expiry checks remain. The before run had the expected assertion failure and dependent fixture failures because the owner stayed blocked; the regression now restores fixture status in `finally`.

Address creation reused a key with different normalized address/label/default fields and silently returned 200. The existing `idempotency_operation` now records an HMAC of normalized input and only an owned address ID, in the same transaction. A changed input conflicts; concurrent creates are serialized by the member lock. Replays return the current authorized address rather than caching plaintext PII. A historical row without an original request digest explicitly requires reviewing the existing address; the code does not invent an original hash from mutable current fields. Key rotation can conservatively invalidate old HMAC comparisons and requires review; no destructive repair is automatic.

No migration, new database, funding lane, public UGC or real privacy deletion is enabled by these changes. Per-route semantic review remains partial; these concrete fixes do not certify all 228 operations.

Phone and content-safety provider calls now share the streamed 64 KiB JSON-object boundary used by identity exchange and deny redirects. Access-token shape/expiry and phone-number field types are checked without coercion. Tests exercise chunked cancellation, invalid/non-object/error JSON, and the actual phone/content fetch options. These are the same existing WeChat recipients; no new egress or real credential is involved.
