# 微信原生渲染与 CI 官方核验

核验日期：2026-08-30  
适用对象：`apps/miniprogram` 原生 WXML/WXSS/TypeScript 表现层与发布门禁

## 裁决

冻结 Web 原型继续作为视觉与交互真值，但生产实现不复制浏览器 CSS 运行时。微信原生端必须以窗口、胶囊、安全区、rpx 换算、WXSS 作用域和实际渲染器能力为约束重建表现层。不能因为浏览器中的 `backdrop-filter`、字体度量或 fixed/overflow 组合正确，就假设微信 WebView/Skyline 会得到同样结果。

当前施工规则：

- `app.wxss` 只保留 tokens、reset 与真正共享的按钮/状态基础；页面结构、排版、卡片、插图和交互态均留在页面或组件作用域。
- 顶栏通过 `wx.getWindowInfo()` 与 `wx.getMenuButtonBoundingClientRect()` 的现场数据计算，不能硬编码一台设备。
- `rpx` 用于随逻辑视口缩放的几何，`px` 仅用于明确的物理像素边界或系统返回值；必须在 375、393、427、440 宽度复测。
- 文字按微信可用字体回退验证实际字形与字重；宋体层级保留，但不能把浏览器字体加载成功当作小程序已加载。
- `button` 必须清除原生默认 padding/border/after 规则，使用显式 flex 居中和内部 label 控制基线；点击热区不得由纯文字承担。
- 毛玻璃、阴影与滤镜必须有不损害信息层级的静态降级；不以“原生感”为由改成通用 WeUI。
- 每个视觉结论只对同 route/state/copy/viewport/crop 的 reference/native/comparison 生效；整窗截图和带设备外框的导出只能作诊断。

## 官方依据

- [WXSS 与 rpx](https://developers.weixin.qq.com/miniprogram/en/dev/framework/view/wxss.html)：WXSS 全局/页面作用域、750rpx 设计宽度及样式约束。
- [Skyline WXSS](https://developers.weixin.qq.com/miniprogram/en/dev/framework/runtime/skyline/wxss.html) 与 [兼容性迁移](https://developers.weixin.qq.com/miniprogram/en/dev/framework/runtime/skyline/migration/compatibility.html)：不同渲染器支持面存在差异，迁移必须以兼容性核验为准。
- [微信小程序设计指南](https://developers.weixin.qq.com/miniprogram/en/design/)：导航、反馈、可触达性与平台界面边界。
- [wx.navigateTo](https://developers.weixin.qq.com/miniprogram/en/dev/api/route/wx.navigateTo.html)、[wx.getWindowInfo](https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.getWindowInfo.html)、[wx.getMenuButtonBoundingClientRect](https://developers.weixin.qq.com/miniprogram/dev/api/ui/menu/wx.getMenuButtonBoundingClientRect.html)：路由栈与动态窗口/胶囊几何必须使用平台权威信息。

## CI 裁决

- [miniprogram-ci](https://developers.weixin.qq.com/miniprogram/dev/devtools/ci.html) 是从开发者工具抽离的编译能力，支持 `upload`、`preview`、`pack-npm`。Project 需要合法 AppID、projectPath 与代码上传私钥；preview 需要二维码输出目标。上传密钥拥有预览/上传能力，必须由管理员生成并配置固定或白名单出口 IP，继续保留人工批准。
- [miniprogram-mp-ci](https://developers.weixin.qq.com/miniprogram/dev/devtools/miniprogram-mp-ci.html) 只做项目成员/体验成员批量管理，不是编译、预览或发布流水线，不能替代 `miniprogram-ci`。
- 本地 DevTools、GitHub Actions YAML 或一次 preview 都不是体验版/正式版上传证据。真实上传前仍必须具备 AppID 归属与项目角色、私钥、IP 白名单、合法 HTTPS 域名、隐私/法务配置和当前源码严格 Design QA。

final result: blocked
