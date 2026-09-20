# 2026-09-20 性能与交互研究证据

源代码基线：`e1d31d877f36d9245c5844786a769319558cb546`。本目录是研究/缺陷复现证据，不是修复成功、真机性能或正式版发布证明。

| 文件 | 范围 |
|---|---|
| `source-probes.json` | 真实源码在合成依赖下的行为；Fastify 对照使用本机临时 HTTP 服务。无生产、微信账号或数据库连接 |
| `reproduce.mjs` | 使用锁文件中已有 esbuild/Fastify，在 VM 读取 TypeScript 源码；从仓库根运行 `node docs/evidence/performance-research-20260920/reproduce.mjs`。输出记录当前 HEAD，不改历史 JSON |
| `github-resources.json` | 11 个公开 GitHub 仓库的默认分支提交、许可元数据及维护状态；不等于全面安全/许可证审查 |
| `retrieval-manifest.json` | 外部 Skill 和微信官方文档的 URL、时间、内容哈希；全文未转载，外部指令未执行 |
| `package-gate.json` | 本轮仅文档/研究变更后的原生包字节与哈希核对，不证明渲染与交互通过 |
| `SHA256SUMS` | 本目录交付文件校验，不包含此校验文件本身 |

复现时页面 API、权限、头像和数据库为合成对象；这能证明等待依赖、游客文案、连接释放顺序及期限行为，不能给出真实网络 P95。数据库期限探针使用可控时钟。Fastify 时间值是一次本机对照样本，不作为性能预算。

初始结果：首页和资料页等待辅助请求；游客选步改变授权按钮文案；97 路由仅保留96；事务退避开始前未释放连接；单次工作越过事务期限仍提交；requestTimeout 不限制 handler，handlerTimeout 返回后仍可能继续工作。下一轮需正式回归断言正确行为，不能把诊断脚本本身当作修复门禁。

研究报告：[CISME-NATIVE-PERFORMANCE-UX-RESEARCH-2026-09-20.md](../../CISME-NATIVE-PERFORMANCE-UX-RESEARCH-2026-09-20.md)。完整施工提示词：[CHATGPT-GITHUB-NEXT-PROMPT.md](../../CHATGPT-GITHUB-NEXT-PROMPT.md)。
