# 有限原生观察复跑

工程仅 `/Users/mini/CISME/apps/miniprogram`；先运行根目录的 package-gate，核 `receipt.json` 包 SHA 一致。仅在用户未操作开发者工具时沿用当前窗口。基础库 3.15.2，iPhone 12/13 (Pro) 模拟器，逻辑 390×844，字体 16，截图为工具 62% 缩放原图。

1. 从 app.json 主包/分包枚举实际路由；每页依次调用官方 `wechatide -c Codex compile_wxml --project /Users/mini/CISME/apps/miniprogram --file-path <route>.wxml` 与 `compile_wxss`。每个响应须 `ok=true/result.success=true`。不并行叠加截屏调用触发 60 次/分钟限额。
2. `simulator_refresh --project ...` 只表示触发刷新；以实际页面和运行时另证。游客依次 `automation_navigate --action switchTab --url /pages/records/index`、community、profile、home；每次用 `automation_runtime_info --action currentPage` 记录真实路径，再 `simulator_screenshot --path <absolute.png> --optimize false`。不点击协议/登录，不创建真实账号。records/profile 本轮实际为 account 登录页，不能把文件名作为实际路由。
3. 首页游客保持“授权身份并开始”。`automation_navigate --action navigateTo --url /pages/management-support/index` 后，在 guest=true 下只应有空列表及权限重新核验提示。以运行时验证 visible=true/loading=false/coreReady=false/itemCount=0。
4. 合成只读展示单独标 fixture。仅在游客客服页用 `automation_evaluate` 调用现有 normalize/setData：一条 ID `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`、合成长昵称/咨询，waiting_human、120 未读、normal 优先级；loading=false、refreshing=true、coreReady=false。验证 canOpen=false 后截原图。这不替代真实权限/网络状态，也不调用写 API。
5. 夹具完成即 `automation_page_action --action callMethod --method load` 恢复真实游客拒绝态，再 switchTab 回 home。本轮最终运行时仍 guest=true。禁止清全局存储来复跑。

当前 loopback API 目标不是已核验 staging；社区实际请求失败，只有本地精选降级可见。截图未达到既有视觉门的最小宽度，保留原图，不放大冒充合格证据。完整角色、原生存储、异常恢复、设备与端到端性能未通过。
