# CISME native repair — 2026-09-20

## State and evidence boundary

Baseline main: `56432fb9b42777ffd4b3aeaf17134a666c7f243c` (not the older research SHA). Branch: `codex/native-perf-ux-repair-20260920`. This is source repair plus synthetic/loopback verification, **not** full native/product/release acceptance. Permanent root remains `/Users/mini/CISME`; the cloud directory and runner baseline are ephemeral. No access to that Mac or its uncommitted work was obtained, so local/main divergence and final Mac sync are **unverified**. No production environment/data, real account, payment/refund/transfer, public UGC, privacy deletion, uploader key or release was used.

The current package hash is `ce7c06c1bac5e3efaaf6151783e2353cb896f1ed7087a2c0b97ab1cf71e19b3e`. 254 files, 37 routes; main 1,427,766 bytes, total 2,161,688; global WXSS 8,137/8,192 unchanged. Compared with the research baseline, +30,576 bytes is the cost of explicit states/budgets/telemetry, not a package-size improvement. Current manifest remains blocked; original cf5fe2… screenshots/manifest retain their original hash/date/scope.

## Independent continuation correction

The later independent continuation found and repaired two real regressions missed by the inherited tests: early PostgreSQL cancellation left active backend SQL after rejection, and Fastify 5.12.3 treated a normally completed HTTP request body as cancellation. It also repaired the same-runner harness's rate-limit population, failure classification and output-path errors. See [continuation evidence](evidence/native-continuation-20260920/README.md) and its `validation.json` for RED→GREEN, exact changed-file hashes, per-route measurements, residual risks and updated 443/571 results. This section supersedes earlier intermediate PR descriptions, not the original dated research evidence.

## Defect ledger

Evidence labels distinguish source risks, deterministic reproduction and actual environments. Test counts do not establish universal correctness. File locations are this candidate's locations, not the older report's lines.

| ID | Severity | Location | PRD / acceptance | Evidence | Repair | Positive and negative regressions | Rollback |
|---|---|---|---|---|---|---|---|
| PERF-01 | P1 | `apps/miniprogram/pages/home/index.ts` | A20 / CARE-01 | 源码VM已复现→行为回归通过 | 护理快照不等未读；未读独立未知/错误；会话、attempt、pageAlive、businessVersion守卫 | native-progressive-load：挂起未读仍可用；主快照失败关闭写；换号/旧尝试不可覆盖 | 恢复home加载链及其测试；不回滚服务端事实 |
| PERF-02 | P1 | `apps/miniprogram/pages/profile/index.ts:67` | ME-01 | 源码VM已复现→行为回归通过 | 主快照独立；权限/商业/未读/中性头像渐进；历史商业入口不误关 | 分别挂起/失败、头像慢、A→B换号；服务端商业字段映射 | 成组回退profile状态与WXML，不用假0/none |
| PERF-03 | P1 | `apps/miniprogram/pages/home/index.ts:93` | §5.4 / CARE-01 | 源码VM已复现→行为回归通过 | 游客可选00–03，始终保留授权CTA；显式动作才授权 | onShow/选步/分钟更新/401恢复；无自动重定向 | 回退visitorView与调用点；保持显式授权不变量 |
| PERF-04 | P1 | `services/api/src/operationBudget.ts:44` | NFR-01 / A20 | 真实回环HTTP与合成依赖回归通过；staging待测 | 接收期限保留；业务期限由ALS单调预算独立执行，不依赖已复现有误的Fastify request.signal；预算传SQL/fetch/存储；503与未知提交分开 | Fastify真实503/合作取消/请求隔离；COS真实SDK回环取消后零重试请求 | 预算、server、db、storage必须成组回退；不删除鉴权/幂等 |
| PERF-05 | P1 | `services/api/src/db.ts:237` | §13 / A20 | 真实隔离PostgreSQL与单测通过；部署环境待测 | 回滚释放后退避；每次尝试一租约，坏连接销毁；40001/40P01有界重试 | 事务14单测；真实pg冲突/终止/提前取消/回滚/池排队等8测试及savepoint恢复通过 | 成组回退事务封装；无schema迁移 |
| PERF-06 | P1 | `services/api/src/db.ts:139` | NFR-01 / A20 | 真实隔离PostgreSQL与单测通过；部署环境待测 | 单绝对期限贯穿排队/SQL/退避/提交前；非裸race；COMMIT未知不重试；ROLLBACK命令不称成功 | pool耗尽/实际CancelRequest+查询回执/取消确认丢失/重试耗尽/丢COMMIT确认/提交tag；实际pg_sleep回归通过 | 同PERF-05；不能撤销既有合法写入 |
| PERF-07 | P1 | `services/api/src/observability.ts:51` | NFR-01–04 | 真实注册表226方法+有界聚合测试通过 | method+模板预注册；未知有界桶；onSend/完成/断开分开；Cloud200保留业务503 | 226 OpenAPI方法全登记；260模板×2方法；10000未知路径；CPU/事件循环/池/SQL | 只回退指标代码不删除业务守卫；不平均实例P95 |
| PERF-08 | P2 | `apps/miniprogram/services/api.ts:270` | NFR-01 / §11 | 请求计时/取消行为回归通过；真实微信网络待测 | 单交互预算含批准GET的一次重试；429有界；共享读引用取消；Cloud仅逻辑取消 | 挂起/预算/429/两个消费者/最后取消/晚回调；写不自动重试 | 成组回退api/http/coordinator/page-requests |
| PERF-09 | P2 | `apps/miniprogram/services/api.ts` | ME-01 / §11 | 会话隔离与未知状态回归通过 | 权限/legal等完成响应TTL暂为0，避免无订阅SWR伪新；保留inflight去重、tag/generation、头像缓存 | 跨会话/写后失效/aux失败非0/非none；未知权限无可执行入口 | 恢复缓存前必须同时证明订阅传播与stale UI/授权合同 |
| PERF-10 | P2 | `apps/miniprogram/services/feed-projection.ts:3` | §6.3.1 / COM-02 | 实际源码VM字节对照通过；真机卡顿未测 | 不再setData原feed与累计列双份；只发新增/改变卡片；ABA/换号/尾部失败隔离 | 30/100/300卡片；分页重叠去重/失败保留/ABA；不启生产UGC | 回退projection+community成组；保留原始源模型；滚动/内存待真机 |
| DOC-01 | P1 | `G0-DECISION-REGISTER.md` / `docs/NFR-MEASUREMENT.md` | §13 / §15.1 | 历史与当前源码已核对 | 保留旧日期新增覆盖表；MAKE/版本/500ms/2s/99.9候选；区分主工程与可选上传工具 | 源包manifest重绑且旧截图范围未扩大；无签字伪造 | 只回退本轮附录，不改历史材料 |

Additional repairs: care mutation ownership now includes page-visible epoch/session/target version. Pending writes retain original idempotency key and frozen assessment; read-only refresh cannot re-POST; explicit retry reuses the original command. Only a server acknowledgement or matching persisted step facts permits success. Process-killed unsaved drafts are **not** claimed persistent. COS SDK internal retries were initially found to escape ALS cancellation in a real loopback test; binding an immutable budget to a request-scoped SDK client corrected this and the same real SDK test passed. Neither result authorizes enabling COS direct upload in a deployed environment.

## Source-based interaction contracts, not fake native coverage

`evidence/native-repair-20260920/interaction-contracts.json` contains all 37 actual routes, observed handlers/lifecycle/service calls, PRD references, preconditions and loading/success/empty/error/offline/permission/cancel/resume/navigation/accessibility/event requirements. Imported wrapper API internals are not reconstructed from truncated tokens. It explicitly distinguishes the required state contract from executed native acceptance. Home/profile/community/care changed; remaining routes keep their existing implementation and still need the complete device state audit. Care/server order/ownership/idempotency/facts and historical-record missing-detail semantics are retained, not rewritten into optimistic UI.

The source-only audit is not a subject×object×field×action proof for all 224 `/v1` methods. Existing service checks and integration tests remain; new budget tests add failure/cancellation coverage, not universal authorization coverage. Review actual denied-other-owner reads and writes, overposted fields, stale capability/version, repeated idempotency and resulting persisted facts route by route before closing the API security ledger.

## Validation state at candidate preparation

Current local Node 24.18.0 / Linux: **443/443 unit tests in 68 files** and **571/571 integration tests in 37 files** passed. PostgreSQL18.4 and SeaweedFS4.29 were recovered from verified existing CI artifacts into strictly loopback synthetic services; no Docker/production/Mac access was used. The final current-source integration rerun includes the cancellation fix, normal HTTP body-completion fix, bounded uncertain-ack cleanup and storage contract. Typecheck, package gate, 37-route static audit, design-QA structure, build and contracts passed. Unit/mock tests of TLS cancellation do not prove deployed mTLS or actual WeChat acceptance.

Root manifest/lock unchanged. Local networking does not permit a new npm install/audit; the verified lock-bound npm-ci artifact supplied dependencies. Fresh candidate npm ci and both root audits are mandatory exact-SHA CI steps, not inferred from old evidence. Optional `tools/wechat-ci` was not installed or audited anew; its historical 80 upstream alerts remain separately unresolved. Final Actions status and SHA are recorded on PR4 after execution; this document does not predeclare CI or merge success.

The existing CI now preserves exact run logs and a same-runner baseline/candidate comparison using existing smoke/capacity/worker scripts and local synthetic DB only. Root `npm ci`, typecheck, package/route/design status, unit/integration/build/contracts/audits and diff hygiene remain mandatory. Candidate-design and credentialed-preview gates were not relaxed. The temporary transfer workflow must be removed before merge. No raw test log becomes a signed native or production acceptance.

## Measured improvement and unmeasured cost

Actual baseline/current community page functions executed in the same Node VM with deterministic card fixtures:

| Cards | Prior cumulative setData bytes | Candidate bytes | Reduction | Calls before/after |
|---|---:|---:|---:|---|
| 30 | 19,570 | 7,906 | 59.60% | 4 / 4 |
| 100 | 182,089 | 26,523 | 85.43% | 16 / 16 |
| 300 | 1,073,016 | 79,706 | 92.57% | 40 / 40 |

One deterministic payload sample per case; these are **not latency percentiles**, FPS, memory, network, image decode or real setData callback timings. Call count did not improve. Fixed image containers/lazy loading, avatar cache and existing polling/differential messages/subpackages/upload fallbacks are reused; no recycle-view/virtualization or new transport was introduced. Community return-position continuity and long-list memory remain device work.

Per-query residual SQL timeout setup adds round trips; request-scoped COS clients add allocation. The independent same-machine measurements show increased backend latency (bootstrap smoke P95 about10.03→16.66ms), not an across-the-board speedup. Both cohorts had zero request errors with the corrected harness. Preserve this correctness cost and remeasure staging before further optimization; no China-network/device claim follows. The smoke comparison uses an identical instrumented measurement harness for baseline and candidate runtime, with separate per-route distributions; capacity mixes remain explicitly labelled. Baseline then candidate ordering and small synthetic datasets can bias caches.

## Measurement contract and remaining controlled experiments

PRD targets stay core API P95≤500ms and core page interactive P95≤2s (excluding third-party payment/media upload), G0 high load+30% headroom; 99.9% monthly availability is only a conditional candidate. No owner/operations signature is invented.

For staging, freeze commit/package hash, actual API/DB/storage region, legal domain/TLS, instance count, device/iOS/Android/WeChat/base-library version, normal-network RTT/loss, cold/warm definitions, representative data volume, concurrency and arrival model, window and sample/exclusion rules. Those deployed dimensions are currently **unknown/unmeasured**, not filled with runner settings. Device cohorts need ≥100 effective actions; each core API scenario ≥1,000 requests. Smaller samples are exploratory. Observe action feedback, package load, client queue, supported wx profile phases, first byte/receive, processing, setData callback and safely usable action separately. Do not add nested connect/TLS times twice or subtract client/server wall clocks. Missing profile fields are missing, not zero; Cloud HTTP logical cancellation differs from direct task.abort.

Run normal cohorts separately from ≥400ms RTT +5% loss, offline, upload interruption and lost response. Weak-network acceptance emphasizes truthful bounded feedback, recoverability and zero duplicate writes; report actual latency/error/timeout/cancel/queue/memory/cold-warm rather than diluting samples. Use a controlled staging target and synthetic accounts only after its identity is explicitly confirmed. Stop the experiment on any business-invariant/duplicate-write failure, unknown target, sustained timeout/error >1%, pool queue exceeding configured acquire budget, or memory growth that does not recover; capture the cause before increasing load. These stop limits are proposed safety conditions, not signed G0 throughput promises.

CI source comparison: Node 24.18.0, runner-local PostgreSQL 18.4, synthetic `cisme_test`, smoke 4,000 requests at concurrency 10 (1,000 capabilities /3,000 bootstrap), matrix 10/20 workers ×2 rounds ×50 requests/worker with 100 members, worker 1/2 concurrency ×2 rounds ×1,000 events. Smoke is app.inject + DB; capacity is **real loopback HTTP/1.1** with bounded synthetic source addresses; worker is isolated audit-only outbox. None is public-network or high-G0 capacity evidence. Production rate limits remain unchanged; 429s and per-route error/latency outcomes are not silently excluded. Current client local ring is bounded/sampled and not automatically exported; it stores only whitelisted timings/stage/result enums, no token/openid/phone/content/signed URL. Server timings expose onSend separately from completion/abort and per-process resource/queue metrics; never average instance percentiles.

## Resource and dependency decisions

The pinned resource/maintenance/license inventory in `evidence/performance-research-20260920/github-resources.json` and the original research report are retained. No external skill, package or paid design content was installed/copied this round. Local Codex skills named by the Owner are not available in this cloud; repository contracts and original source guide the repair instead.

| Resource | Decision / cost / validation / exit |
|---|---|
| Existing native api-typings 5.2.3 / official miniprogram-demo (0fe5c7d…) | Reuse platform types and feature checks, no demo project copied; types do not prove runtime support; no new package cost |
| Fastify 5.12.3 / pg 8.23.0 locked source/tests | Reuse without upgrade. Own business deadline avoids the reproduced normal-body-close signal bug; pg protocol cancel preserves TLS, drains the original query, and reports lost acknowledgements as unknown; pinned internal adapter has explicit upgrade/TLS tests and deployment limitations; no framework replacement |
| Apple HIG / mobile UX principles | Progressive real content, truthful feedback, cancellable unobtrusive motion; existing CISME layout and 300ms close contract retained; no UIKit/Liquid Glass library |
| Appllama dd5caae… (MIT) | Do not import Expo/RN/Reanimated stack; no paid MCP flow inspected |
| GSAP Skills aed9cfd… (MIT skill) | Do not import DOM/ScrollTrigger/GSAP runtime; native opacity/transform principles only; skill license is not runtime license |
| Mobbin | No authenticated case-flow access; no fabricated case study or copied assets |
| Transitions 598d3d6… | No code copied because relevant license/access not confirmed; no Web animation dependency |
| recycle-view 70a5b5a… | Not adopted: incremental native projection solves measured byte duplication; actual device benefit/maintenance needed before virtualization |
| OpenTelemetry / k6 / autocannon | Not installed: existing bounded metrics and scripts cover current source/isolated-DB work; real HTTP arrival modelling may justify one later with overhead/license/rollback review |

New dependency count: **0**, root manifest/lock unchanged. Existing root/license report is reproduced by CI. No hidden waiver for independent uploader vulnerabilities.

## Rollback and completion gates

No schema migration, production feature enabling or brand redesign. Revert related source groups together (client request budget + coordinator; home pending-command + WXML; server budget + DB/storage; feed projection + page), then rerun matching regressions/package hash/manifest. A Git revert never reverses already-persisted care/payment facts or authorizes repeating an unknown write. Preserve idempotency/query recovery and all external release gates.

Source PR/Actions and merge results must be attached from actual GitHub responses after execution. Before merge, verify current main still contains the expected baseline, final branch SHA and required checks; no force push. Mac `/Users/mini/CISME` sync/dirty-state preservation is a separate **pending** local step, not something the cloud performed. Release remains **false**: no new DevTools full-state, authorised iOS/Android, deployed legal-domain/staging, formal platform/business qualification, recovery/operations or money-path evidence was obtained. Source fixes can land independently; those missing gates cannot be marked green by CI.
