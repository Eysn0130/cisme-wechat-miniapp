# 设备与云测边界

本轮本机没有可操作的获授权 iPhone 或 Android。Computer 控制的是 Mac 上的微信开发者工具主模拟器；其 `iPhone 12/13 (Pro) 390×844`、`Huawei nova13 361×804`、`iPhone 14/15 Pro Max 430×932` 只是模拟器布局。无真实设备会话、系统/微信版本、候选安装映射、任务 ID、设备报告或手机软键盘画面，故 iOS 与 Android 均为 **NOT_RUN**。

读取了上轮原始 Codex 会话 `/Users/mini/.codex/sessions/2026/09/25/rollout-2026-09-25T21-43-41-01a0dc06-b0e3-7a63-95f4-b9cc55ed1f6a.jsonl` 中访问官方 MiniTest 文档的失败回执。原文要点：`Browser Use rejected this action due to browser security policy`；`site-safety policy blocks this action`；`no user permission prompt or Auto-review was attempted`；禁止用其他浏览器表面、间接命令或绕过方式达成同一访问结果。本轮没有再访问该受拒入口，也没有切换 Computer 菜单、Playwright、代理或账号重试。云测账号权限、设备和额度依然未核实，没有云真机任务。

上轮的 `appServiceSDKScriptError timeout` 发生于“自动化测试”次级模拟器启动，属于与上述安全拒绝不同的本地技术故障；既有日志与配置记录了这一故障。本轮主模拟器和 `wechatide` 持续可用，已完成当前源码采集；没有为次级模拟器安装 ADB、scrcpy 或 WDA，也没有以其超时阻断主模拟器回归。

设备项暂缺的具体证据为：获授权真实设备或已允许的真实云设备任务、实际系统/微信版本、当前小程序候选与运行设备映射、定向用例的执行记录和报告。此缺口仅影响设备与正常安全预览/发布门禁，不冲销本机源码测试、原生模拟器交互和隔离服务端读回结果。
