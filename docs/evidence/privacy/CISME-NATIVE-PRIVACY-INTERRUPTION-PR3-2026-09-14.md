# PR #3 原生隐私中断与会话隔离（源码/本地行为证据）

- 当前 `apps/miniprogram` 包源码 SHA-256：`2284c462fa917009dac1780ba40ec5ef9955a1fbdff0abaf087effb5453bbc71`；此前 `8c1185cf…` 的矩阵与截图只代表原始基线，不作为当前运行证据。
- 需求判据：PRD `docs/product/CISME-产品需求文档-PRD-V2.1-R4.md` 正文 R4.2 的 §6.3.1、§6.6.2、§7.7、§8.2、§15.5–15.6；小程序原生交互不改成网页权限模型。
- 证据等级：`SOURCE + LOCAL_BEHAVIOR_TEST`。`npm test` 359/359、隔离测试库 169/169、`build`、`lint:contracts`（219 个 `/v1` 方法）、包预算通过；`design:qa:status` 结构检查通过但 `releaseReady=false`，37 路由、DevTools 和双平台真机完整状态证据仍缺。下述行为不是 DevTools、iOS、Android 或微信后台批准结果。

| 个人数据/入口 | 微信后台声明类别 | 系统或微信权限 | CISME 业务同意与保留 | 当前处理与回归 |
| --- | --- | --- | --- | --- |
| 投稿、客服、UGC 图片 | 当前账号后台批准类别 `UNKNOWN`，待 Owner 核验 | `requirePrivacyAuthorize` 后才调用 `chooseMedia`；相册/相机权限按用户当次选择 | 投稿用途许可、客服会话、UGC 发布许可分别按既有业务流程；服务端保留 `POLICY PENDING` | 拒绝不选图/不上传，保留文字；离页、切号及迟到选图/压缩回调不进入旧上传；已有上传可中止。`tests/unit/miniprogram-page-behavior.test.ts`。 |
| 微信地址与本机剪贴板 | `chooseAddress` 已在 `app.json.requiredPrivateInfos`，后台实际通过状态 `UNKNOWN`；剪贴板类别待核 | 用户点导入/粘贴才调用 `chooseAddress`/`getClipboardData`，失败可手填 | 地址仅在用户保存时写入本人加密地址；交易快照及保留 `POLICY PENDING` | 离页或会话/会员改变使迟到回调失效；剪贴板不后台读取。`tests/unit/miniprogram-page-behavior.test.ts`。 |
| 登录/设置头像 | 当前账号后台批准类别 `UNKNOWN` | 用户点击微信 `chooseAvatar` 后本机 canvas 处理 | 可保持默认头像；资料保存由本人会话发起，保留 `POLICY PENDING` | 登录页及设置页离页、切号使处理回调失效；登录页在过期后不请求资料或上传。`tests/unit/miniprogram-page-behavior.test.ts`。 |
| 可选手机号 | 当前账号后台批准类别 `UNKNOWN` | 原生 `getPhoneNumber` 用户手势；拒绝不阻断登录 | 独立可选绑定、可解绑；保留 `POLICY PENDING` | 本轮未改已存在的手机号业务链；微信真实授权/拒绝/迟到返回仍待 DevTools 与真机。 |

`mobile-ui-ux-designer` 的中断恢复契约用于上述源码修正：页面隐藏和会话变化应使旧异步结果失效，拒绝图片权限不丢文字输入，并提供用户主动重试。未新增权限弹窗组件；微信实际弹窗及后台声明不能由本地 mock 推断。

待验：当前 hash 的 DevTools 首次/拒绝/再授权、弱网、切号、后台恢复与系统权限；iOS/Android 真机；微信后台隐私指引实际类别和审核状态；服务端正式保留/删除政策。所有旧截图保留原 hash 与来源，不重标为本次通过。
