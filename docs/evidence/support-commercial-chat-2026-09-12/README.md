# CISME Commercial Chat 原生证据说明

日期：2026-09-12（Asia/Shanghai）
小程序源码 SHA-256：`005f03d43a58b106515df69c28fd30413af41afb3a6d760c5e4bb2ea6156cb52`
产品基线：`docs/product/CISME-产品需求文档-PRD-V2.1-R4.md` V2.1-R4.1
补充实现契约：`docs/product/reference/support/CISME-COMMERCIAL-CHAT-UX-CONTRACT.md`

## 证据环境

- 微信开发者工具 Stable 2.02.2608070，`wechatide` 0.3.9。
- iPhone 12/13 Pro 模拟器，截图像素为 484 × 1048。
- 隔离本地 API `http://127.0.0.1:18080`、数据库 `cisme_test`、35 个迁移，最新迁移为 `202609120001_support_commercial_chat.sql`。
- 只使用合成验收身份、订单、消息与图片；没有生产身份、真实用户数据、真实支付或正式上传。

## 证据分层

| 证据 | 数量 | 权威范围 | 不证明 |
| --- | ---: | --- | --- |
| `screenshots/01`–`21` | 21 | 当前 WXML/WXSS/TypeScript 在微信原生模拟器中的确定性状态呈现 | API 交互、物理设备、系统媒体选择器 |
| `member-human-assigned-neutral.png` | 1 | 当前本地 API、登录会话和已分配但无有效心跳时的中性状态 | 公网或生产 presence |
| `screenshots/22-member-large-font-23.png` | 1 | 开发者工具 `fontSizeSetting=23` 下无标题、气泡、时间和输入区重叠 | 物理设备动态字体、屏幕阅读器 |
| `recordings/*.mov` | 4 | 可见微信模拟器区域的真实 H.264 屏幕录像；展示确定性状态序列 | 手指操作、真实轮询时延、系统媒体选择器、公开网络上传 |
| `performance.json` | 1 | Fastify inject + PostgreSQL 本地服务端路径的 P50/P95/P99 | 公网、客户端渲染、轮询调度和终端吞吐 |
| `visual-evidence-manifest.json` | 1 | 文件哈希、尺寸、源码哈希、环境与限定词 | 超出清单所写范围的发布结论 |

截图 14 是聚焦多行输入区与 300px 键盘 inset 的运行时呈现，不是桌面开发者工具无法显示的手机软键盘。物理 iOS/Android 键盘、旋转、屏幕阅读器和真机弱网保持 `UNVERIFIED`。

## 状态覆盖

消费者端覆盖：空会话、仅用户消息、AI、等待人工、已分配但在线未知、真人在线、真人 typing、AI→人工/system event、图片、订单、发送失败、读历史时新消息计数、resolved、多行输入、长文本、附件 sheet、图片上传失败与大字体。

管理端覆盖：会员 typing、图片与订单、最小必要会员信息面板、resolved。4 段录像分别呈现：

- A：用户消息 → 人工分配 → 人工 typing → 人工回复。
- B：AI → 等待人工 → 人工接管 → 人工回复。
- C：附件 sheet → 图片上传失败保留 → 图片消息。
- D：附件 sheet → 订单卡片 → 管理员会话页。

`recordings/*-keyframes.png` 和 `recordings/recordings-contact-sheet.png` 由最终 MOV 派生，仅用于快速人工复核，不构成独立运行时证据。

## 复现

在隔离数据库和微信开发者工具已连接的前提下：

```bash
npm run miniprogram:acceptance
npx tsx scripts/capture-support-commercial-chat.ts
npx vitest run tests/integration/support-commercial-chat-performance.test.ts --pool=forks --maxWorkers=1 --reporter=verbose --disableConsoleIntercept
```

全路由健康包位于 `../visual/review-commercial-chat-005f03d4-20260912t0508cst/`，记录 27/27 路由、0 个限定控制台错误匹配和 0 个限定网络失败匹配。完整文件校验见 `SHA256SUMS`；清单本身包含逐项 SHA-256。

## 明确排除

以下项目没有被本目录宣称为通过：物理 iOS、物理 Android、真实软键盘、系统图片/相机选择器自动化、正式 HTTPS 合法域名、正式小程序上传、生产身份、真实支付、真实订单和真实用户数据。
