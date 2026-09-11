# WeChat DevTools checkpoint — 703377ee

日期：2026-08-30  
结果：blocked（本机工程检查点，不是开发版/体验版/正式版签字）

## 绑定对象

- Package SHA-256：`703377eef1136d8458f99f1b1dbca3bdac02a048b8006805719fe8c2f69c7b6e`
- Package：128 files / 13 routes / 1,292,369 bytes
- Global WXSS：8,117 bytes（内部 8,192-byte 门禁余量 75 bytes，不应继续扩张）
- 微信开发者工具：RC 2.02.2608031
- 基础库：2.32.3
- 项目路径：`/Users/mini/CISME/cisme-r0-platform/apps/miniprogram`
- 当前工具显示的项目 AppID：`wxf639399a761abc01`（接口测试号；归属、正式项目角色、AppSecret 与生产资格未核验）

## 现场结果

| 检查 | 结果 | 证据边界 |
|---|---|---|
| Problems | 0 | `visual/current-run/native/devtools-package-703377ee-compile-0-problems-2026-08-30.jpg`；证明当前工作区未检测到问题，不替代全路由运行验收 |
| Console | 0 product errors；2 system warnings | `visual/current-run/native/devtools-package-703377ee-console-0-errors-2-system-warnings-2026-08-30.jpg`；两条分别来自预加载但未使用的 WAAutoService/WAServiceMainContext 资源 |
| Account 未勾选 | 本机按钮文字水平/垂直居中，禁用态层级可读 | 全窗口基线与 664×1434 RC 导出；后者含设备外侧细条，不能伪称 750×1624 原始 page-frame |
| Account 已勾选 | 未验收 | 法律确认必须由用户本人操作；本轮未点击 |
| Network | unknown | 未形成当前哈希结构化 trace/HAR，严格门禁失败关闭 |
| iOS/Android 真机 | 未执行 | 模拟器不等于真机；键盘、相机、相册、弱网、安全区仍无证据 |

Account 代码基线采用显式 50px action height、16/20px UI 字体、flex 双轴居中与内部 label 1px 视觉基线补偿；全局关键动作和 Home 主 CTA 已按同一规则审计。该代码与当前模拟器只关闭“本机未勾选按钮字体/位置”finding，不能继承到已勾选、长文案、大字号或真机。

## 2026-08-30 预览误触事件

在尝试进入开发者工具安全设置时，RC 将快捷操作解释为“预览”，使用当前已登录接口测试号生成了一次有时效的开发预览二维码。

- 未扫码、未分发、未设置为体验版、未提交审核、未发布。
- 这不是 `upload`、体验版或正式版证据，也不证明 AppID 生产归属。
- 含二维码的仓库截图已立即删除；未保留可恢复副本。
- 保留不含二维码的 `visual/current-run/native/devtools-promo-interruption-703377ee-2026-08-30.png` 作为审计事件上下文，但不进入 current-source acceptance manifest。
- DevTools CLI 服务端口仍关闭；未为绕过门禁而开启。

## 退出标准

要把本检查点升级为候选，仍需：用户本人完成法律勾选态复测；当前源码 Network trace；13 路由规定状态与动作矩阵；同状态同裁切 reference/native/comparison；真实微信登录与媒体闭环；至少 iOS/Android 真机；AppID/角色/法务/域名/CI 密钥与 IP 白名单证据。未满足前 final result 只能为 blocked。
