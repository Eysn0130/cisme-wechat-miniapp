# 微信原生云调用接入核对

截至本次核对，业务函数凭据已获明确授权并保存；真实业务函数的数据库、存储就绪检查及原生 SDK 调用均返回 200。原生页面入口尚未切换。以下是当前源码与官方接口的差异，不是验收通过清单。

| 项目 | 当前源码 | 云调用接入要求 |
| --- | --- | --- |
| 基础库 | 项目配置与本地覆盖均已从 2.32.3 升至 3.15.2；DevTools 日志确认已加载 | 官方 HTTP 函数调用页要求 ≥3.15.1；集成调用页要求 ≥3.15.2。仍须逐页与真机兼容性验证 |
| JSON 请求 | `services/api.ts` 使用 `wx.request`；URL 来自 runtime 对应 origin | 使用 `wx.cloud.callHTTPFunction` 的 name、config.env、path、method、header、data；确认返回 statusCode/data 和失败回调行为 |
| 登录与会话 | 现有 Bearer 会话、过期会话清理、页面返回保护 | 保留已验证的业务鉴权和会话竞态保护。平台可能注入的身份头不能未经信任边界验证就替代当前身份流程 |
| 幂等性 | `Idempotency-Key` 请求头 | 云调用须保留请求头并用真实写入/重试验证 |
| 上传 | `uploadAuthorized` 调用 `wx.uploadFile`，提交 multipart 文件和服务端签发字段 | 当前授权返回 URL，云调用文档未证明 `callHTTPFunction` 可直接替代该 multipart 上传。须选择并实际验证独立上传通道，保留授权、哈希校验、完成确认及删除闭环 |
| 上传 URL | API 从 Host/X-Forwarded-Proto 推导代理上传地址 | 云网关场景必须核对实际返回 URL 可被真机访问；不能把函数内部主机名当成可用外网地址 |
| 发布门禁 | `wechat-release-lib.ts` 只验证公开 HTTPS origin 和域名证明 | 若接入官方云调用，门禁应按真实 transport 验证环境/函数配置和接入证据，同时保留外部上传域名所需证明 |

已用开发者工具 Console 的原生 `wx.cloud.callHTTPFunction` 调用 `cismeHttpReadiness`：第二次测试返回 200、Node.js v24.14.0、收到的路径 `/health/live`。首次调用返回 404，诊断函数重新部署后复测成功；没有据此断言首次失败原因。该次诊断使用的原生包哈希为 `326f66260bac017eda78fed4e4594468e7e988caf59d11162f85817bb555c74c`；类型和包预算检查通过。证据见 `docs/evidence/deployment/native-cloud-sdk-2026-09-09.json`。

请求层随后新增可配置的云调用实现（`services/http.ts`），保留现有会话、幂等、公开请求和过期响应处理；缺少云 SDK 时明确失败，不把携带凭据的请求回退到其他主机。`miniProgramCloudFunctions` 仍为空，业务入口未切换，上传通道未改。新的 `df86445f…` 原生源码必须重新验收，不能继承上述诊断包的页面证据。

仍需完成：页面业务通道接入；当前源码逐页重新验收；业务原生云调用；真实登录、邀请及上传；定时任务；体验成员与 iOS/Android 扫码验收。没有将诊断 JSON 云调用的成功扩展为整个上传链路可用。

官方来源（2026-09-09 核对）：

- [HTTP 云函数调用方式](https://docs.cloudbase.net/cloud-function/function-calls/)
- [英文版最低基础库与返回参数](https://docs.cloudbase.net/en/cloud-function/function-calls/)
- [集成函数原生调用流程](https://docs.cloudbase.net/en/integration/usage)

## 2026-09-09 实际业务函数复测

`cismeApi` 的 18 项环境变量及 60 秒超时已保存并回读。`/health/ready` 的数据库 `SELECT 1` 与存储就绪检查通过，`/v1/feed` 返回真实空列表。原生 SDK 的回调与 Promise 两种调用均收到 `200 ready`。

实测 SDK 将 HTTP 401/422 转为只有 `errCode/errMsg` 的失败对象，丢失业务响应体。因此新增显式 `X-CISME-Transport: cloud-http-v1`：服务端仅对该通道的 JSON 错误发送带原始状态码、业务码和追踪编号的 HTTP 200 信封；客户端解包后沿用既有错误与会话竞态处理。普通 HTTP 状态码保留。云端修正版和原生 SDK 已实测收到完整 `401 AUTH_REQUIRED`。

真实 `wx.login` 代码兑换已通过微信服务端并到达 `422 CONSENT_REQUIRED`；测试没有提交协议同意、没有创建会员，不能称为完整登录成功。18 个单元测试文件、135 项测试与类型检查通过。当前原生源码哈希 `07336cb4ada052572756d262d7ca2b5c810ef411d6e7a3a7ad7e553994e01b23` 仍无完整逐页/真机验收。完整证据见 `docs/evidence/deployment/cloudbase-api-configured-2026-09-09.json`。

当前源码社区页已通过一次真实云函数联调：临时启用 `cismeApi` 且按游客读取 `/v1/feed`，首次出现 401；修正服务端公开路径判断对查询参数的处理后，页面重试完成，`loading=false`、`error=""`、`feedCount=0`、`tasksError=""`。原有云目标与会话随后恢复，持久化发布入口仍未切换。此项是当前源码的接口联调证据，不是完整视觉或设备验收。


## 2026-09-09 全面审阅补充

当前源码 `1fc45699…` 修复了云目标启用时的开发身份/本地协议夹具回退；136 单元、41 集成测试通过。原生 SDK 实测拒绝 multipart ArrayBuffer（`-401003`），因此不能直接以此替代 `wx.uploadFile`。存储预签名 PUT 可被重放覆盖，未启用。实际探测证据和最终剩余清单见 `docs/DELIVERY-REVIEW-2026-09-09.md`。原有 07336cb4 页面联调仍是该旧哈希的历史证据，不能当作当前哈希验收。
