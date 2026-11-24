# ADR 0008 — 受控 AI 客服与知识检索

状态：接受当前架构决策；具体实现和验收以当前源码、测试及实际环境证据为准。本 ADR 不代表已部署或通过真机验收。

## 背景与原决策

早期 R2 已有 PostgreSQL 客服会话、人工申请与接待人归属。当时模型供应商、知识和自动答复尚未接线，因此本 ADR 先定义关闭状态的 provider、版本化知识与只读工具边界。曾评估 LangGraph.js 1.4.14（MIT，`9ae75600dd84d6b2bc736e33baaf66a556d61c49`）；额外图状态、检查点和工具权限未能抵消引入第二套会话权威的成本，故未复制源码或新增该依赖。

上述“provider 尚未接线”和“人工接管后整个会话停止 AI”的历史描述已过时。[PRD N.6](../product/CISME-产品需求文档-PRD-V2.1-R4.md) 的 `SUPPORT-COLLAB-01`、`SUPPORT-COLLAB-ROUTE-01` 和 `SUPPORT-COLLAB-STATE-01` 覆盖此前整段暂停规则：人工负责原事项，同一会话中的其他基础咨询仍可受控回答。

## 决策

继续使用 CISME 原生小程序会员客服与管理客服、Fastify 和 PostgreSQL 会话及权限。沿用既有 DeepSeek 接入和服务端来源校验。当前小规模问答选择仓库内精选、版本化的已审核知识条目，以及确定性的小范围检索；不引入第三方客服系统、图编排、向量数据库或新的模型供应商。Dify、RAGFlow 可在知识规模和运维条件确有需要时，作为独立检索服务重新评估；Chatwoot 可作为人工队列和接管归还的对照。本轮决策不复制下述候选代码或新增其依赖。

本轮方案中的条目审核、确定性检索、命中与未命中处理，需要与具体实现和测试逐项核对；仅写入本决策不意味着这些能力已经全部实现或运行。条目的发布内容、版本、来源和变更须可追溯；哈希只能证明内容一致，不能代替事实审定。检索命中或模型自报引用也不能单独证明答案被来源支持。

## 当前源码边界

- [deepseekSupportAi.ts](../../services/api/src/deepseekSupportAi.ts) 已定义 `deepseek-flash` provider、护理／客服规则／安全三份版本化知识，以及最小化会话输入和脱敏处理；[supportCatalogKnowledge.ts](../../services/api/src/supportCatalogKnowledge.ts) 生成服务端当前公开商品的只读快照。脱敏是规则匹配，不能声称能识别全部个人信息。当前模型接入由 [config](../../packages/config/src/index.ts) 控制，默认关闭；启用需要服务端配置真实密钥，配置通过不等于已完成真实推理或部署验收。
- [supportAiBoundary.ts](../../services/api/src/supportAiBoundary.ts) 定义来源 ID、版本和 SHA-256 注册表，校验内容哈希并拒绝缺失或未知来源、无效输出及超时。当前注册表校验来源是否存在，不能证明每个回答与来源语义一致。[supportHelpArticles.ts](../../services/api/src/supportHelpArticles.ts) 维护已核对的操作指引及来源。[supportKnowledgeRetrieval.ts](../../services/api/src/supportKnowledgeRetrieval.ts) 按本轮问题最多选三个相关指引，要求引用出现在本轮输入。明确命中的操作回复直接使用已审核条目，价格、规格、库存使用当前公开商品快照。
- [supportService.ts](../../services/api/src/supportService.ts) 以当前问题、聊天代际和人工事项为依据处理 `general`、`human_followup`、`clarify`、`mixed`；人工原事项进度由服务端依据真实状态说明。写回前重新检查事项代次、目标消息及是否已由人工回复，并保持每个源消息的自动回复幂等。低置信、附件或失败可以建议申请人工，不能冒称用户已申请或客服已接待。
- 普通客服须由用户明确申请才进入人工队列。管理端读取、认领、回复分别受 `support.read`、`support.assign`、`support.reply` 及当前处理人等服务端约束；模型不能授予权限。AI 只回答和引导，不调用退款、改价、订单、积分、会员资产或其他业务写操作；[只读工具边界](../../services/api/src/supportAiBoundary.ts) 也不允许模型指定会员身份、SQL 或任意 URL。人工服务不依赖模型可用。当前接待员工或具备分配与会员管理权限的调度人员，可确认交回人工队列并保留原事项。
- 会员和员工继续使用[用户客服页](../../apps/miniprogram/pages/support/index.ts)与[管理客服页](../../apps/miniprogram/pages/management-support/index.ts)／[接待页](../../apps/miniprogram/pages/management-support-chat/index.ts)，会话身份由服务端核验；昵称、客户端参数和徽章不授予权限。历史订单专用身份等受限上下文依 PRD 不送模型。
- [模型边界单元测试](../../tests/unit/support-ai-boundary.test.ts)、[DeepSeek 单元测试](../../tests/unit/deepseek-support-ai.test.ts)及[会话集成测试](../../tests/integration/support-ai-conversation.test.ts)提供对应的测试入口，不因测试文件存在而宣称本轮测试已通过。

## 开源候选比较

以下星标于 **2026-11-24 09:58 UTC** 查询 GitHub API；它是热度参考，不代表质量、安全或生产可用性。部署规格均为官方起步建议，不代表 CISME 机器有可用余量。所有项目都需要独立核对版本、数据留存、访问控制、备份和恢复；自托管不自动消除模型或 embedding 提供商的数据传输。

| 项目 | 星标、许可与成熟度 | API、人工协作和数据边界 |
| --- | --- | --- |
| [Chatwoot](https://github.com/chatwoot/chatwoot) | 40,463；[主体 MIT，`enterprise/` 另受商业许可](https://github.com/chatwoot/chatwoot/blob/develop/LICENSE)。成熟客服队列，但不是原生微信组件。 | [Client/Application API](https://developers.chatwoot.com/api-reference/introduction) 可连接自定义界面；[AgentBot](https://www.chatwoot.com/hc/user-guide/articles/1677497472-how-to-use-agent-bots) 用 `pending`／`open` 将会话交给人工。社区版不含 Captain AI，高级功能按[自托管版本](https://www.chatwoot.com/pricing/self-hosted-plans)区分。接入会新增客服副本、webhook、员工权限和会话同步，须与 CISME 事实及保留期限协调。 |
| [Dify](https://github.com/langgenius/dify) | 161,811；[附加条件的 Apache 许可](https://github.com/langgenius/dify/blob/main/LICENSE)，单 workspace 企业后端可商用，多 workspace 与前端版权存在限制；成熟的 AI 应用与知识平台。 | [知识检索 API](https://docs.dify.ai/en/api-reference/knowledge-bases/retrieve-chunks-from-a-knowledge-base-test-retrieval) 和[聊天来源元数据](https://docs.dify.ai/en/api-reference/chat-messages/send-chat-message)可供服务端对接；其工作流人工输入不能直接等同于 CISME 原生坐席接管。官方称 API `user` [不由 Dify 认证](https://docs.dify.ai/en/api-reference/guides/end-user-identity)，API 聊天会进入[应用日志](https://docs.dify.ai/en/self-host/use-dify/monitor/logs)；必须由 CISME 服务端绑定身份并管理副本留存。官方 Docker 起步为 [2 核／4 GiB](https://docs.dify.ai/en/self-host/deploy/quick-start/docker-compose)。 |
| [RAGFlow](https://github.com/infiniflow/ragflow) | 94,632；Apache 2.0，成熟的检索项目。官方建议起步 4 核／16 GB／50 GB。 | [HTTP API](https://ragflow.io/docs/http_api_reference) 支持文档和片段引用；所查资料未证明其开箱即用地接管 CISME 的原生员工队列，仍需后端集成。知识、索引、日志及所用模型的副本需单独治理。 |
| [TGO](https://github.com/tgoai/tgo) | 665；[附加条件的 Apache 许可](https://github.com/tgoai/tgo/blob/main/LICENSE)，单企业商用和前端版权条件须遵守；相对较小，GitHub 当时显示最近推送为 2026-04-28。 | 官方提供[微信小程序原生组件](https://github.com/tgoai/tgo/blob/main/repos/tgo-widget-miniprogram/README.md)，项目声明支持知识库和人工坐席，仍需独立 IM 与服务、合法域名、CISME 身份及权限映射。引用展示和完整接管未实证；其一条 [Agent 构造路径](https://github.com/tgoai/tgo/blob/23545936/repos/tgo-ai/app/runtime/tools/builder/agent_builder.py)在 RAG 工具初始化异常后继续，不能据此视为无来源时必然拒答。 |

## 闭环证据

本次候选完成后应以同一源码及小程序包哈希记录结果：覆盖知识审核、版本变化、确定性命中／未命中、未知或伪造引用、无依据回答降级；覆盖四类问题路由、显式申请人工、人工认领与回复、迟到 AI、重复发送、换号及权限拒绝。隔离数据库测试、真实供应商的合成输入、小程序开发者工具、获授权账号和真机的证据分别标注范围，不以旧截图或配置开关冒充通过。

真实体验账号如需新增验收事实，先保留只读基线，并按精确记录标识可恢复隔离本轮测试数据，核对原有及并发事实不变。实际启用仍须核对真实密钥、服务端数据处理与隐私说明、合法域名以及模型和基础设施费用；实际部署及验收结果须另有对应证据。
