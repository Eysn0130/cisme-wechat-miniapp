# 商业正式版复核证据

基线：`c695cd04847d1a43ee8b4b5168877799e57cbbc1`（PR #4 已合并）。本轮源码修改只有个人页护理展示字段映射；无接口、数据库、依赖或生产开关修改。完整分析见 [商业正式版复核](../../CISME-COMMERCIAL-RELEASE-AUDIT-2026-09-21.md)，后续执行入口见 [完整施工提示词](../../CHATGPT-GITHUB-NEXT-PROMPT.md)。

## 当前源码与回归

包 SHA-256：`6ceca531174cd17e0968cfef69111f83c92e5523bac54db4a3a59a85a971e8c7`。

| 检查 | 证据与实际结果 |
|---|---|
| 护理状态回归，修复前 | `profile-before.log`：7 新用例失败、17 既有用例通过 |
| 护理状态回归，修复后 | `profile-after.log`：24/24 通过；使用真实 Page 逻辑与合成服务，不是原生渲染测试 |
| 全量本地单元测试 | `unit.log`：68 文件，449 通过，1 Linux 专用性能测量用例跳过，450 总数 |
| 类型与构建 | `typecheck.log`、`build.log`：通过；Web 构建不是微信验收 |
| 契约 | `contracts.log`：224 `/v1` 方法、含 health 共226方法、32事件对齐；不是完整权限覆盖 |
| 包 | `package.log`：主包1,427,864 bytes，总2,161,786 bytes，37路由，全局WXSS8,137 bytes |
| 原生模板/样式编译 | `native-compile.json`：74/74 官方开发者工具只读编译成功（37 WXML + 37 WXSS），逐文件结果；不能扩大为画面、交互、全状态或真机通过 |
| 设计结构 | `design.log`：结构通过；`releaseReady=false`，当前包37路由矩阵与双平台证据缺失 |
| 依赖审计 | `audit.log`：根工程0漏洞；未安装/启用独立tools/wechat-ci，不能据此声称其上游风险消失 |

本地未为一个前端字段映射重复跑全量数据库集成；当前 PR 和最终 main 的完整 GitHub verify 才是本轮集成结果来源。最终提交及Actions以GitHub记录为准，不将父提交CI继承为本轮CI。

## 原生工具恢复与验收边界

最初错误地把仓库根作为 compile 的 project 参数，返回 PROJECT_CONFIG_JSON_ERROR；真正微信配置在 `apps/miniprogram`。改为正确路径后编译调用未返回，当时开发者工具处于项目列表。列表中只有 `/Users/mini/CISME/apps/miniprogram`，点击打开提示“该文件路径下项目不存在”，而磁盘目录和配置确实存在。

取消提示、终止本轮挂起的 CLI 编译进程后，官方 `open_project_window` 对同一目录返回 `success:true` / `newopen`；随后个人页 WXML/WXSS 编译成功，再执行全路由模板/样式编译。没有复制工程、重建第二个项目、修改安全设置或上传小程序。工具版本读取为 Stable 2.02.2608070，Skills0.3.9，项目配置基础库3.15.2。恢复打开不等于解释了GUI提示的根因。

本轮没有为37页或个人页生成新的真实接口截图/真机证据；native-compile仅是模板/样式编译。旧包 `ce7c06c1bac5…` manifest已归档，当前manifest仍blocked，无旧图继承。

## 静态盘点与外部研究

- `inventory.mjs` 可从仓库根复跑：`node docs/evidence/commercial-release-audit-20260921/inventory.mjs`。
- `page-inventory.json`：37路由111个TS/WXML/WXSS文件及各自哈希、事件/接口词法、字号、动效、等待点、发布限制文案。词法清单不能解释模板作用域、完整调用图、实际渲染尺寸或执行请求数。逐页人工分析在报告中，未将所有字段或按钮宣告正确。
- `github-resources.json`：重新读取11个仓库公开元数据与默认分支SHA，k6较上一轮变化，其余10个一致。许可证API为空不证明没有任何授权，只意味着复制前还要核查文件授权。没有安装这些仓库。
- `official-retrieval.json`：Apple官方Loading/Motion数据及微信setData/request官方HTML的时间、字节、哈希。原文仅保存在本地tmp，仓库不复制完整版权内容。用户所给其他链接的公开页面与Skill源码也已重新审阅，结论及链接在报告。
- GitHub治理只读观察：2026-09-21 UTC，rulesets `[]`，main `protected:false`，environments总数0；未擅自修改权限或部署配置。这不能推断云资源不存在。

## 回滚与后续

个人页修复无需数据迁移；若要撤销，应通过新的revert提交并再次计算包哈希。撤回会恢复已知空白回归，不作为常规解决方案。报告/提示词可独立修改。任何新增原生源码都需重新生成当前包验收绑定，不能把本轮编译摘要自动套用新源码。

日志仅规范化结尾空行以通过diff检查，未改测试内容。`SHA256SUMS`覆盖本目录交付文件（不包含自身）。CI/合并回执由外部GitHub链接提供，避免为写入自身提交号无限产生新提交。
