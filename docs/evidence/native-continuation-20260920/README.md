# PR4 独立接续复核与修复（2026-09-20，洛杉矶）

本接续基于 main `56432fb9b42777ffd4b3aeaf17134a666c7f243c` 的原 PR4，复用继承候选 `3442d385d3aa64541c6ea8d486cf07147e7b0575`，没有新建第二套永久项目。本目录是源码/隔离验证证据，不是微信真机或发布验收。

## 新增、实际修复的缺陷

| ID | 证据与影响 | 修复及正反向验证 |
|---|---|---|
| PERF-06-R1 / P1 | `early-cancel-before.json`：提前取消已返回失败，但实际 PostgreSQL 仍有 1 条活动 SQL。原有期限测试未覆盖提前取消。 | `pgCancellation.ts` 使用已锁 pg 8.23.0 的协议编码与 TLS 协商；不使用会在 TLS 协商前发送的 Client.cancel。原连接等原查询结束，取消通道结束后才回滚/释放。`early-cancel-red.log` → `early-cancel-green.log`；新测试不加“等待后再看”的宽限。 |
| PERF-06-R2 / P1 | 网络分区可能丢失取消确认；销毁连接不证明 SQL 没执行。 | 保留服务器 statement timeout；取消后最多等待剩余 statement 期限加 500ms 清理宽限，仍无确认则隔离连接并返回 `DATABASE_CANCELLATION_UNCONFIRMED`。该宽限不是延长业务期限或宣称取消成功。`bounded-cleanup.log`；COMMIT 丢确认仍是 `TRANSACTION_OUTCOME_UNKNOWN`，不自动重试。 |
| PERF-04-R1 / P1 | 已锁 Fastify 5.12.3 的 request.signal 在普通 HTTP 请求体完成的 close 上中止，并清掉其 handler timer。真实 HTTP 正常写入因此返回503；app.inject 未发现。 | 不绑定该 signal；停用有此行为的内建 handler timer，保留接收期限，沿现有 ALS 预算实现响应期限/协作取消。仅真实断开或响应结束终止工作，正常请求体结束不终止。`http-body-red.log` → `http-body-green.log`；正式测试再加真实断开与 held-handler 顺序断言，避免紧时间阈值偶发失败。 |
| MEAS-01 / P1 | 原 CI baseline 4,000请求出现3,220失败；单来源/单会员触发原有600/180限流，非有效性能比较。 | 保留全部限流；100个合成会员/来源。smoke显式注入地址，capacity使用Linux真实回环来源，不伪造转发头。状态、429、超时、每方法/路径分布均报告；baseline/candidate用完全相同测量代码。 |
| MEAS-02 / P1 | capacity原判定遗漏4xx，CI输出又违反脚本目录保护；一个失败会中止另一候选采集。 | 全错误率与分路由500ms目标入判定；保留原400ms混合P95/800ms P99等更严格内部诊断，不放宽PRD。文件仍在受保护目录生成再收集；各cohort均执行并保存退出码，任一失败仍使CI失败。 |
| MEAS-03 / P2 | worker未把未完成/死信/数量不符作为失败；性能重置仅凭库名可误接远端。 | worker校验处理数、总数、pending、dead；三个性能脚本均要求显式本地`TEST_DATABASE_URL`和单独重置授权。拒绝远端、非测试库、host/hostaddr覆盖。 |

## 验证与解释

`validation.json` 保存候选文件SHA-256、工具链、443单测/571集成结果、smoke逐路由、capacity每轮/逐路由、worker结果和所有边界。数据库是明确指定的本机 `cisme_native_pr4_test`；使用已锁 PostgreSQL18.4、SeaweedFS4.29、Node24.18.0。没有读取未知.env或生产库。

本地网络不能重新执行npm安装/audit，因此只复用经哈希验证的锁定npm-ci工件。新提交必须再经GitHub的npm ci和两类audit，不把旧工件的0告警冒充新SHA审计。主manifest/lock未变，没有新增依赖。可选tools/wechat-ci没有安装，其历史80项上游告警继续独立未解决。

同机、同数据、同脚本：smoke护理bootstrap P95约10.03ms → 16.66ms，capabilities约0.272ms → 0.297ms；两者各场景均0错误。新增期限保护带来SQL往返开销，**不能写成后端整体提速**。capacity真实回环HTTP的4轮混合P95：旧12.46/13.59/18.94/20.03ms，新20.23/19.47/42.01/33.41ms，均0错误、统计事实一致。容量每路由样本仍少，标为探索性；不是G0高档或中国网络证据，也没有平均这些P95。

smoke是app.inject+隔离DB；capacity是真实回环HTTP/1.1；worker是audit-only outbox，不代表所有事件的外部I/O。前后进程顺序、无固定CPU配额和缓存可影响结果。服务器额外成本需在受控staging复核，不能盲目用缓存、关鉴权/幂等、删事务或抬连接池来“优化”。

原研究的护理/我的/游客渐进加载、未知状态、原幂等键/原感受重试、只读事实恢复、增量feed和37路由interaction contract被保留。native包仍为 `ce7c06c1bac5e3efaaf6151783e2353cb896f1ed7087a2c0b97ab1cf71e19b3e`，本接续未再改小程序源码。现行manifest仍blocked，历史截图没有扩展范围。

## 可复核执行与证据边界

本目录保留原始RED/首次GREEN的可读副本（仅移除末尾空行以满足diff hygiene）；完整原始输出、最终443/571测试日志和高基数HTTP指标随交付附件与最终Actions工件提供。最初一次误用无目录过滤的Vitest调用被中断，属于无效探索记录，不计入通过数。随后按npm脚本限定目录、集成单worker重新执行。临时GitHub传输只用于可核验对象树；不改main/保护/发布权限，最终tree不留传输文件。

TLS取消的CA/非枚举私钥保留、普通/直接TLS协商顺序和失败清理有单测；真实pg取消实测是本机明文测试连接，不冒充已部署mTLS验收。收到取消请求本身不证明取消成功，仍等待原查询回执；见PostgreSQL18官方协议54.2.8及锁定pg源码。Fastify官方handlerTimeout说明是协作取消，本次额外发现来自锁定实现和真实HTTP复现，而不是假定文档保证一切。

发布仍 `releaseReady=false`。开发者工具、授权iOS/Android、合法域名/实际地域、400ms RTT/5%丢包等真机韧性、G0签字/运维能力、完整主体×对象×字段×动作审计、生产链路和 `/Users/mini/CISME` 同步均未被本轮云端证据替代。源代码合并与正式发布是两道不同门禁。

回滚必须按预算/数据库/存储依赖成组，不单独恢复已证实有回归的中间候选。无schema迁移；Git回滚不撤销持久化业务事实，也不授权对未知写入换键重试。下一步按主报告的原生状态矩阵与实际部署条件继续，不能重造框架、重开生产UGC或要求提供真实支付/上传私钥。
