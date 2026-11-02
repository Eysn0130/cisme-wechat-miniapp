# 社区“＋”生长动效 · 2026-11-01

用户明确满意原底部中央“＋”的样式，本轮只调整进入社区时的生长动效，不采用上一轮建议的右下角文字按钮。保留62px圆形、原位置、材质、四个导航与真实发布门禁。关联PRD §6.7创作入口、COM-U01与ED-READ-01中的原生触达和导航约束；不扩展公开UGC能力或草稿管理范围。

## 修改与检查

- FAB挂载时直接进入显示状态，由WXSS keyframes提供首帧，避免setData/nextTick合并隐藏与显示样式。
- 球体从下方24px、0.24倍生长，420ms结束；最多1.025倍轻微舒展；“＋”延迟80ms、用240ms显现，不旋转。
- 不使用forwards长期覆盖按压transform；重复点社区、滚动导航恢复均不重新挂载。切换失败恢复时仍核对发布门禁；离开或门禁关闭立即移除，无延迟回调复活。
- 系统减少动态效果与低性能class均关闭球体和图标动画；系统媒体查询修正了图标选择器优先级。
- 5个相关测试文件173项通过：native-navigation、native-boundaries、miniprogram-flow-safety、miniprogram-page-behavior、editorial-native。TypeScript检查、包检查与git diff --check通过。官方compile_wxss返回success，仅视为局部编译检查。
- 当前小程序源码指纹：`e8653567e1ed8f05f9336c9b47fa2c44a013a7db1e7cc40598b6199701634151`。来源为现有包检查的sourceSha256，不是官方上传包哈希。

## 原生验证范围

使用本机官方微信开发者工具2.02.2610292 Nightly / Skill0.3.14，在独立目录`/tmp/cisme-community-motion-20261101`运行离线组件校验。真实custom-tab-bar的TS/WXML/WXSS/JSON逐字复制；布局工具和图标来自本项目。独立app/page只负责四页切换和本地展示，使用同一AppID及原项目的window/样式模式，不加载真实会员、网络接口或存储，不支持实际投稿。此目录是一次性验证夹具，不是新的项目根目录。

- `native-offline-community.png`：本轮390×844原生截图，已打开检查；62×62圆形和原四个导航可见。它不代表正式社区公开投稿已开放。
- `native-offline-animation-samples.json`：通过官方automation_evaluate调用原组件，再经wx.createSelectorQuery采集实际渲染样式。外球从0.24倍连续到1.02338倍，再回到62×62/scale1；图标由透明到可见。采样用于确认动画和终态，不用于宣称手机帧率。
- `native-offline-reduced-motion.json`：独立组件启用既有reducedMotion class时，外球与图标均为animation-name:none/0s，结束恢复普通模式。没有修改用户系统偏好；系统媒体查询仅完成源码与优先级审阅，尚无真机复验。
- `component-source-proof.json`：独立夹具与当前组件四文件的逐字相同校验。
- 原正式项目始终停留`pages/home/index`，未操作用户登录态或真实数据，未开启UGC、未上传体验版。

初次夹具误加了正式项目没有的style:v2，产生默认按钮宽度184px的椭圆。相应截图与采样保留于`rejected-fixture-v2/`，明确拒绝作为验收证据；修正夹具为原项目样式后重新采样与截图。未为夹具配置问题修改产品的圆形样式。

本轮未验证：正式包内开放投稿的完整流程、真机触感和掉帧、系统减少动态效果偏好在真实微信中的适配。已有历史截图不作为本轮新状态证据。
