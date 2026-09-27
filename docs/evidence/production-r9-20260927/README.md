# CISME R9：订单详情与会员账号原生精修、R8 收货差异复核

本记录只描述 `/Users/mini/CISME` 原分支在 R8 本地提交 `9e219d113c05abc01314e53fddb3817ccceb7e4d`（tree `cdd7bd63db84baad77b66026a6d049aacce3da8c`）之后的工作。最终候选是**包含本记录的本地提交**；远端 PR22、main、正式主机与微信平台的状态分别记录，不能由本地提交推定。时间均为 2026-09-27 UTC。

## 基线与设计依据

- 唯一有效 PRD 为 `docs/product/CISME-产品需求文档-PRD-V2.1-R4.md`；本轮对应 P02 登录/协议/按需手机号与 A21，P18 订单/物流/售后与 A04/05/13、AFS-01–03，以及订单支付、履约、售后事实分轴。R8 的微信收货只读复核和本店历史确认继续分开。
- 订单参考图是 R8 原图 `docs/evidence/production-r8-20260927/native/order-receipt-platform-shipped.png`，原 SHA-256 `5d6efea1ca794d869c7477bd84b7e9a30c50e7101630e4fa67f9c5dd856b42c2`。交接书提及的第二张原始 `account-login-reference.png` 未随本次本地文件提供；登录页以当前开发者工具实际重现和仓库已有历史图作定向对照，未把历史图冒充当前证据。
- 实际读取 Taste `redesign-existing-projects`：`Leonxlnx/taste-skill/skills/redesign-skill/SKILL.md`，本次取得的文件 SHA-256 `0713bbfa0337d2384ec9478ba2906079c552268c`。按扫描现状、诊断层级、局部修改、原生验证使用；微信原生行为与 PRD 优先。另读取本机 `mobile-ui-ux-designer`、`design-taste-frontend`、`miniprogram-development`，没有安装框架或新增插件。

## 实际改动

1. 两页引入局部 `action-hierarchy.wxss`：主/次操作统一最小高度 50px、文字操作最小 44px；禁用主操作采用确定背景、文字和边框，去掉渐变残影与浮起阴影。紫色品牌、WXML/WXSS/TypeScript 和原售后底部面板保留。
2. 会员账号页移除重复标题与英文眉题，简化首登说明。原生勾选和两条协议链接分行，整条协议名称一起换行；链接在 checkbox label 之外，点击文档不等于同意。手机号说明改为普通文字，只有能力已知时显示。本地协议文案明确是开发验证，不宣称正式协议未发布。未同意、法律文本未就绪、可选跨境授权等原禁用条件仍在。
3. 订单详情把订单号降为可选择的辅助信息，保留支付主状态；物流与收货合为一张卡，微信平台观察单独标来源与查询时间。当前确可打开组件时只保留“去微信确认收货”主操作；其他状态用文字查询/刷新，查询失败保留上次有效观察和重试。售后服务在物流之后作次操作，仍打开原底部面板。现有正式配置未授予物流轨迹读权限，页面不再暴露注定失败的轨迹按钮；承运商和运单保留。
4. 合成 `runtimeMode=test` 的订单主操作在完成只读查询后直接拦住真实 `wx.openBusinessView`。页面隐藏/换号时旧查询结果作废，查询失败不会把已有状态误写成新的成功或“未开放”。
5. R8 新表 `commerce_wechat_receipt_observation` 在旧版小副本与分卷数据副本中共用一条按 `commerce_order.member_id` 过滤的固定投影，仅输出订单/发货标识、平台状态、争议标志与观察时间，不输出支付凭据、查询 ID 或原始微信响应。既有旧本店收货记录不被覆盖。R8 新迁移不改写：外键绑定、每发货唯一、观察值一致性约束及非空数据回滚拒绝均保留。
6. 隐私主体图原哈希仍对应旧迁移集合，更新为当前 96 份 SQL 的有序字节哈希 `e266f99c53635146df6d34268ad040be580efd8425e22248a6a1243085844a7c`；保留已有人工审核的导出/擦除/保留决策。旧生成脚本会把这些人工决策退回保守默认值，未用它覆盖正式主体图；该脚本需单独治理，不能作为本轮数据保留规则已获批准的证据。
7. 正式主机本轮只读确认 `x86_64`。发布包脚本现要求 Linux x64/glibc 构建机，并在安装运行依赖后加载 `sharp` 作原生依赖探针；manifest 记录构建平台。本机 macOS arm64 调用会明确拒绝，防止将 Darwin `node_modules` 装入 Ubuntu。此为**打包前置修复**，未生成可部署的 main 制品。

## 当前源码与原生模拟器证据

小程序完整输入 SHA-256 为 `bcbd6232f910a92b47bb7384e0db11b0315e0071b7f43e42653edf0673cd8999`，268 文件、40 路由；主包 529,806 B，总计 1,525,978 B。三张原图由原微信开发者工具 v0.3.11、AppID `wx4eac2d4fb11d299b` 的 361×804 模拟器产生。图像原字节保存在本目录；`docs/evidence/visual/current-source-acceptance.json` 逐张绑定当前输入哈希，仍诚实标为 `finalResult=blocked`。

| 原图 | SHA-256 | 所见范围 |
| --- | --- | --- |
| [订单：合成已付、微信记录已发货](native/order-platform-shipped.png) | `d96eebbb2bc109f06e51dd16ff56741045130acd8f66f3971097cd90e82efb81` | 支付与物流状态分层、微信主操作、售后次操作 |
| [账号：未勾选](native/account-consent-disabled.png) | `84d6f0f085a3d1c502956a9878215faceefb9b012ddfe69fe061486b3ab55eb0` | 分开的协议链接、本地说明、明确禁用样式 |
| [账号：已勾选](native/account-consent-enabled.png) | `7a6cc53ad29d0d69bad1ca3589ae62e3299b070a326005992db13a247698bb1a` | 原生勾选后主操作启用；随后已重新取消勾选 |

实际操作：本地隔离 PG16.15/S3 fixture 的订单先显示“微信记录：待核对”，点只读查询后显示“已发货”；点击合成主操作时只显示测试边界说明，未打开真实微信组件。售后按钮打开原底部面板，展开和关闭可用；下滚可到达配送承诺及金额。账号页直接打开本地协议说明，勾选仍为 `false`；点原生勾选后按钮启用，随后重置为 `false`，没有调用微信登录或索取手机号。仅为开发者工具模拟器与合成交易，不是微信真实组件、真机、真实支付/发货/收货或正式法务同意的证据。测试前备份的原开发者工具会话已恢复，临时备份键移除，隔离服务按其 runId 停止。

## 验证边界

- `npm run typecheck`、`npm run build`、`npm run lint:contracts`、`npm run miniprogram:package-gate`、`npm run miniprogram:route-audit`、`git diff --check` 通过。两页 WXML/WXSS 在微信开发者工具分别编译成功；这不代替上述实际页面点击与设备验收。
- 单测 1465 通过、1 跳过。PG16.15 全套集成首次发现旧主体图哈希与本轮新增导出投影验证问题；修正后相关两文件 15/15 通过，完整集成复跑为 58 文件、921 测试通过。既有 R8 Linux ARM64 安装/恢复 97 项为原范围，不能冒称 x86_64 正式主机切换。
- `design:qa:status` 结构检查通过，但 `releaseReady=false`；40 路由完整状态矩阵、iOS/Android 真机、正式组件与真实交易仍无通过证据。网页构建成功不作小程序验收。
- 本机运行 `package-tencent-release.mjs` 得到预期 `PRODUCTION_RELEASE_REQUIRES_LINUX_X64_GLIBC_BUILDER`；Linux x64 最终包只能在准确 main M 形成后由匹配构建环境生成，随后核验 `index.js`、`worker.js`、`worker-once.js`、依赖锁、`migrate.mjs`、96 份迁移、manifest 与运行依赖。现在没有 M 制品。

## 外部状态与下一步

- 约 05:19 UTC，只读原腾讯云 `lhins-61ikz4mi` OrcaTerm：`uname -m=x86_64`；`/opt/cisme/current → /opt/cisme/releases/20260909-native-login`；API、独立 worker active，`cisme-production-health.timer` inactive；live 白名单值 `APP_ENV=staging`、`RUN_BACKGROUND_WORKER=false`。未读秘密或完整 env，未安装、迁移、切换或启动 timer。R7 的 23 条迁移和 2 条身份事件是历史观察，本轮未重新计数。
- 约 05:18 UTC 只读远端：PR22 Open/Draft/UNSTABLE，远端原分支仍 `5ab4a00d4e71d8a9a2de14e31b64fca0bbe92e88`，main 仍 `5740e18544fa37dd473c36934a2a12a07a2d5ec9`。没有准确新候选 CI。R8 的原 `GitHub.create_tree` 安全拒绝仍无可适用恢复；本轮只读查阅原相关任务也未取得原响应/request ID。没有以 `git`、`gh`、网页或另一账号探测等价写入，也不把缺少原 ID 变成永久新门槛。
- R8 两项本 AppID `48001` 的 rid 分别为 `6ab88d33-7ad80a5c-63033670` 和 `6ab88d33-467c5900-539943c8`；官方 rid 回读仍不能确定账号权限原因。本轮没有重复请求。需微信后台或平台支持给出该账号的具体资格结果，再各作一次只读复测；不能把 `48001` 解读成业务 false 或“只等备案”。
- R8 的 2026-12-25 后有限恢复授权仅是提案，未见用户批准，也未写入正式私有授权。当前有效期之外的恢复处理、微信真实回调与发货资格，仍需各自适用的实际凭据。
- 原拒绝取得同一动作适用恢复且仓库条件满足后：同步**本地最终 C**到原分支并读回，完成 C 的 CI/审阅；正常合并 PR22，读回真实 main M/tree 和 M 的 main CI；在 Linux x64/glibc 从 M 建不可变服务器包，完成新鲜备份保护点、同沙箱私有输入/写入者围栏、真实旧库迁移、production 闭单态切换及 API/独立 worker/monitor/业务读回；从干净 M 上传对应微信开发版并读回版本。体验版、备案、代码审核、发布、营业逐项以平台与业务准入回执判断。上述远端及生产动作目前均为 `NOT_RUN`。
