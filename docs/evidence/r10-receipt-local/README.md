# R10 收货观察与原生回归：本地证据

本目录只记录原分支在本轮的本地候选、隔离验证和微信开发者工具模拟器结果。它不是 PR22、main、正式生产或微信平台上传回执。基线包含 R9 之后已批准的登录页修改；没有回退到 R9 提交。

## 实现边界

- 保留 R8 的微信确认收货组件、返回处理和服务端 `get_order` 查单。适用订单的主按钮改为“确认收货”；成功返回后若查单暂未反映，页面有界复查并显示“正在更新收货状态”。取消不自动重开组件。
- 新增独立 worker 的只读收货观察：仅选取已同步发货、完整现金支付绑定的真实适用订单；每轮最多四笔。查询前后核对支付与发货绑定；数据库租约和查询 ID 拒绝并发、重启后过期租约及晚到响应的错误覆盖。查询期间不持有订单事务或锁。
- 观察值 1–6 分别投影，状态 3 只表述微信确认收货，状态 4 表述交易完成，状态 5 表述已退款，状态 6 表述资金待结算。没有确认方式或精确时刻时不编造。订单详情、会员订单列表和管理订单视图读取同一观察记录；原本地收货、售后、资金与护理事实保持独立。
- 微信账号或提供方不可用时持久化全局冷却；单笔绑定不匹配只退避该订单，连续三次后交人工核查，不饿死其余批次。当前选择有界 `get_order` 轮询；项目没有可信的 `trade_manage_order_settlement` 消息接收链路，本轮没有虚构该回调。
- 新增迁移 `202609270002_wechat_receipt_watch.sql`、最终 schema 合同、运行信号及隐私字段清单。私有数据导出只列有实际平台观察的行，不把待观察任务当作用户交易事实。

## 受测输入和命令

小程序当前完整输入 SHA-256：`c5fbcd54ef5c209be56fe573fb5dc79a6844c1d6abf6267a5b903c1a588a4c76`，270 文件、40 路由。当前原生证据的文件摘要、分辨率、页面和状态见 [视觉证据清单](../visual/current-source-acceptance.json)。此前 `a906df8d…` 的清单原样归档为 [上一版清单](../visual/source-acceptance-a906df8d7687.json)；旧图没有改称本轮验收。

| 核验 | 结果与范围 |
| --- | --- |
| `npm run typecheck`、`npm run build`、`npm run lint:contracts` | 退出码 0；本地源码和产物检查。 |
| `npm run test` | 128 个测试文件，1467 通过、1 跳过；退出码 0。 |
| `CISME_TEST_POSTGRES_IMAGE=postgres:16.15-alpine npm run test:integration` | 58 个测试文件，921 通过；退出码 0。新单笔失败隔离逻辑随后用同版本隔离库定向重跑 `verified-payment-inbox.test.ts`，14 通过；退出码 0。 |
| `npm run miniprogram:package-gate`、`npm run miniprogram:route-audit` | 退出码 0；包输入及 40 路由与当前清单一致。 |
| `npm run design:qa:status` | 清单结构有效，`releaseReady=false`；全站状态矩阵、正式 DevTools 分类证据及真机尚未齐备。 |
| `npm audit --omit=dev --audit-level=high`、`npm audit --audit-level=high` | 均退出码 0，各报告 0 个漏洞；仅代表执行时依赖审计。 |
| `python3 -m unittest discover -s infra/tencent -p 'test_production_*.py' -v` | 退出码 0；10 项中 9 通过、1 项因需要一次性 Linux root 容器而跳过。不是 Linux 正式安装。 |

PG16.15 隔离用例覆盖从既有旧迁移链升级、完整迁移及回滚保护、模拟有效付款绑定、无顾客打开页面时状态 2→6→3 的服务端持久化和列表投影、单笔失败不阻塞其他订单、全局冷却、进程重启、多实例租约及手动查询抢占晚到响应。没有真实付款或平台自动确认。

## 微信开发者工具实际操作

使用原项目 AppID `wx4eac2d4fb11d299b`、微信开发者工具 Nightly v0.3.11 的 361×804 模拟器与一次性本地 PG/S3 合成 fixture。进入前为游客首页；没有请求手机、iCloud、真实微信支付或真实组件。临时本地测试账号仅用于合成订单导航，结束时退出并恢复原游客首页和原本地身份变量；一次性 fixture 已停止并删除。

| 画面 | 实际操作与可支持的结论 |
| --- | --- |
| [游客登录回归](account-guest.png) | 显示已批准的登录页；未勾选协议时按钮禁用。 |
| [查询前订单](order-before-query.png) → [已发货订单](order-platform-shipped.png) | 在订单详情实际点击“查询微信记录”；合成服务端返回状态 2 后显示“确认收货”主按钮和正确辅助说明。 |
| [合成边界](order-synthetic-boundary.png) | 实际点击主按钮；本地测试只提示组件入口，未打开真实 `weappOrderConfirm`。 |
| [售后底部面板](order-support-sheet.png) | 实际点击、打开并关闭原售后面板；未提交申请或发送顾客消息。 |
| [会员列表](order-list.png)、[管理列表](management-order-list.png)、[管理详情](management-order-detail.png) | 同一合成平台观察状态显示为“已发货”。 |

模拟器未覆盖真机安全区与大字号全矩阵，真实微信组件、真实交易、微信自动确认、正式 API/独立 worker/monitor 和微信开发版上传均未在本目录验收。代码级无人值守闭环的正式运行还取决于准确 main 制品、production 独立 worker、有效 `shipping.query` 授权和该账号实际 `get_order` 资格。
