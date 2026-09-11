# CISME 活动项目文档退役清单

- 执行日期：2026-08-13（Asia/Shanghai）
- 唯一开发基线：[`CISME-产品需求文档-PRD-V2.1-R4.md`](../CISME-产品需求文档-PRD-V2.1-R4.md)
- 当前基线 SHA-256：`849123637638730129e899f9877f8c2f052afec8928077143fa6dd22a890e0f7`（V2.1-R4.1，2026-09-12）
- 退役原则：活动项目只保留 Markdown 开发基线；DOC、DOCX、PDF 不再作为实现或验收依据。
- DOC/DOCX 恢复位置：`/Users/mini/.Trash/CISME-docx-retired-20260813`。
- PDF 恢复位置：`/Users/mini/.Trash/CISME-pdf-retired-20260813`，按原项目相对路径保存。在系统废纸篓被清空前，可按本清单恢复。

## 源需求证据

两份源 PRD 在退出活动目录前，已逐字节复制到项目外只读归档：

[`/Users/mini/CISME-source-archive-20260813/ARCHIVE-MANIFEST.md`](/Users/mini/CISME-source-archive-20260813/ARCHIVE-MANIFEST.md)

归档同时保存原始 DOCX、渲染 PDF、文本抽取、SHA-256、保留期与取回验证。项目外归档不是本次清理对象，不得随项目工作副本删除。

## 退役文件

| 原项目路径 | SHA-256 | 处置与理由 |
|---|---|---|
| `/Users/mini/CISME/CISME飞书AI经营助理产品需求说明书_V1.0 .docx` | `8f605147156e9683c5e135239c4ce57dac9ed9f70a269421d2bd360264d332ba` | 源件已进入项目外只读归档；工作副本移入废纸篓 |
| `/Users/mini/CISME/CISME微信小程序会员积分与UGC商城_PRD_V1.0(1).docx` | `720ad3e8ef03de27c79a931e2d39e05ff04b0746f7201196b8ad82338770a2d4` | 源件已进入项目外只读归档；工作副本移入废纸篓 |
| `/Users/mini/CISME/CISME消费者小程序与飞书AI经营中台_整合PRD_V2.0.docx` | `f15539abd27794973ec8452fd7f51be3a6cd523bd7ac9f8e7d8302727dee73a4` | 已被独立复核后的 V2.1 Markdown 替代；移入废纸篓 |
| `/Users/mini/CISME/CISME双系统最终产品收口与交付说明_V1.0.docx` | `3af466c366b5336f9bb02f39b2f3631308f8285b80670bc6893b2cab955c5f3f` | 历史派生交付说明，不再是权威基线；移入废纸篓 |
| `/Users/mini/CISME/CISME双系统最终产品收口与验收报告_V2.0.docx` | `261a2dd3dbaa62f7cae083fbd99217d8611a94c77f6b8b029141a70bb14d583c` | 历史派生验收报告，不再是权威基线；移入废纸篓 |
| `/Users/mini/CISME/cisme-home-prototype/docs/CISME双系统最终产品收口与验收报告_V2.0.docx` | `261a2dd3dbaa62f7cae083fbd99217d8611a94c77f6b8b029141a70bb14d583c` | 上一项的重复副本；改名后移入废纸篓，避免覆盖 |

## PDF 清理

活动项目内共识别并退役 24 份 PDF：根目录及 `cisme-home-prototype/docs` 的 4 份历史交付/PRD PDF，以及 `.docx-review`、`.work` 下的 20 份源文档审阅或中间渲染 PDF。它们按原项目相对路径移入 PDF 废纸篓目录，避免同名文件覆盖并保留可恢复性。

项目外只读证据归档中的两份源 DOCX 对应 PDF 不属于活动项目清理范围，继续用于原始版式取回；它们不构成开发基线。

## 生效口径

1. 产品、设计、开发、测试、供应商询价和验收只引用 V2.1 Markdown 的章节、状态机、API、事件和验收 ID。
2. 源 DOCX 仅在争议追溯时从项目外归档读取，不得重新作为需求基线。
3. 任何恢复到项目的 DOC/DOCX 都必须先经过产品负责人批准，并标记 `SUPERSEDED_DO_NOT_IMPLEMENT`；否则 CI/交付检查应视为文档基线回归。
4. 活动项目不得重新引入 DOC、DOCX 或 PDF 作为需求/验收基线；确需恢复证据时只读使用项目外归档或废纸篓副本。
