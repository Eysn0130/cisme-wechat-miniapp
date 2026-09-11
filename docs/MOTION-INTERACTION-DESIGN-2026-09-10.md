# CISME 底部动效与护理弹层交互设计

日期：2026-09-10  
范围：原生微信小程序 `apps/miniprogram`  
结论：本轮交互逻辑已实现并在微信开发者工具 Stable 2.02.2608070 中复测；后续连续性复核又补齐请求超时恢复、弹层后台隐藏和社区标签选中语义，详见 `docs/MOTION-CONTINUITY-AUDIT-2026-09-10.md`。完整 iOS/Android 真机动效与系统辅助功能验收仍保持 open。

## 1. 现状审计

| 步骤 | 用户看到的状态 | 健康度 | 结论 |
|---|---|---|---|
| 1 | 首页开始护理前 | 良好 | 主 CTA、四步轨道和底部导航层级清楚。 |
| 2 | 护理弹层打开 | 修复前有 P1；修复后良好 | 修复前主导航仍压在弹层底部，造成遮挡与错误的可切页暗示；修复后导航完整下沉，弹层底部操作无遮挡。 |
| 3 | 进入社区 | 修复后良好 | 恢复原设计的圆形发布入口，并用真实 Phosphor Plus 图标、62px 命中面和既有珠光紫玻璃语言实现。 |
| 4 | 社区上滑与停滑 | 逻辑通过，真机待验 | 累积上滑后导航与发布入口一起下沉；停滑 180ms、反向滑动或回到顶部会恢复，避免用户等不到切页入口。 |

修复前证据：

- `docs/evidence/visual/motion-interaction-audit-2026-09-10/01-native-care-sheet-before.jpg`
- `docs/evidence/visual/motion-interaction-audit-2026-09-10/02-web-community-reference-before.jpg`

修复后证据：

- `docs/evidence/visual/motion-interaction-audit-2026-09-10/03-native-care-sheet-after.jpg`
- `docs/evidence/visual/motion-interaction-audit-2026-09-10/04-native-community-fab-after.jpg`
- `docs/evidence/visual/motion-interaction-audit-2026-09-10/05-native-community-stop-recovered-after.jpg`
- `docs/evidence/visual/motion-interaction-audit-2026-09-10/06-devtools-console-clean-after.jpg`

## 2. 动效时序

### 护理弹层

1. 点击“开始今日护理/开始今晚护理”的同一帧：锁定底部 Chrome，挂载透明弹层。
2. 下一渲染帧：弹层由底部 `translateY(58rpx) + scale(.975)` 生长到终态；底部 Chrome 向下退出。
3. 遮罩用 200ms 渐显，导航用 280ms 强减速曲线，弹层用 320ms 强减速曲线。较大的主体稍晚收住，形成有重量的层级感。
4. 关闭时先撤去可见态并释放导航锁，弹层与导航在尾段交叠运动；300ms 后才卸载弹层，避免 `wx:if` 导致的硬切。
5. 护理中已有未提交步骤时，原退出确认仍优先；服务端提交中的 `working` 锁也不会被动效绕过。

### 社区发布入口与滚动

1. 社区页显示后先挂载发布入口，再在下一帧从 `scale(.58) + 18px` 生长到终态；时长 360ms，使用一次轻微超调的弹性曲线。
2. 首个页面滚动事件只用于校准当前位置，不触发收起，避免缓存页恢复时闪动。
3. 内容向上移动累计 24px 后，发布入口与四页导航作为一个整体下沉。
4. 内容反向移动累计 8px、滚动位置回到 12px 内，或停滑 180ms，立即恢复底部 Chrome。
5. 只在状态翻转时 `setData`，滚动过程不持续写视图数据；计时器在离页和卸载时清理。

## 3. 冲突与恢复模型

自定义 TabBar 使用按来源计数的隐藏锁，而不是单一布尔值：

- `care-sheet`：护理弹层拥有。
- `community-scroll`：社区滚动拥有。
- `externalBusy / switching`：已有业务提交与页面切换锁继续独立生效。

只有所有隐藏来源都释放后导航才恢复。因此即使未来社区叠加其他弹层，也不会出现“一个交互提前把另一个交互隐藏的导航拉回来”的竞态。导航隐藏期间按钮同时禁用并移除指针响应；页面切换失败仍回滚选中态，离页会清理社区 FAB 与滚动计时器。

## 4. 发布入口业务边界

圆形 “+” 不是装饰性假按钮：

- 游客点击时进入既有身份确认，并保留社区返回地址。
- 已登录且存在有效投稿/邀请时，进入最高优先级的真实任务或草稿。
- 已登录但没有有效邀请时，明确提示“当前没有可发布的护理邀请”。
- 加载、导航或底部 Chrome 隐藏期间不可重复触发。

## 5. 素材与实现选型

没有引入新的动画运行库。当前 WebView 原生页面只需要 `transform`、`opacity`、`transition`、`wx.nextTick` 和少量状态管理；这比迁移渲染器或把高频滚动交给第三方组件更小、更稳定。

调研参考：

- 微信官方示例仓库包含 Skyline Worklet Bottom Sheet，并用共享值、手势协商和 `translateY` 实现拖动；该方案要求 Skyline/Worklet，当前产品仍是既有 WebView 原生页面，因此本轮不为一个非拖拽弹层迁移渲染器：https://github.com/wechat-miniprogram/miniprogram-demo/tree/master/miniprogram/packageSkyline/pages/worklet/bottom-sheet
- 微信官方自定义 TabBar 模型为每个 Tab 页维护独立组件实例，页面通过 `getTabBar` 同步选中和展示状态；本轮沿用这一边界：https://github.com/wechat-miniprogram/miniprogram-demo
- TDesign 小程序组件库提供成熟组件，但为本次两个受控过渡整体引入依赖会增加包与样式接管成本，因此只参考其组件化边界，不新增运行依赖：https://github.com/Tencent/tdesign-miniprogram
- “+” 使用项目已采用的 `@phosphor-icons/core` 正规图标源，由资产同步脚本生成白色 regular SVG，不使用文本符号或手绘图标。

## 6. 可访问性与证据边界

确认项：发布入口命中面为 62×62px；有“发布护理记录”名称；隐藏期间 Tab 与发布入口同步禁用；护理弹层关闭按钮保留 44px 最小命中面；弹层挂载时后台首页从开发者工具辅助功能树移除；社区分类暴露标签组、标签与选中态；低性能设备和 `prefers-reduced-motion` 均关闭过渡。

仍需真机验证：VoiceOver/ TalkBack 的焦点移动、微信对系统“减少动态效果”的实际映射、iOS/Android 安全区、120Hz 与低端 Android 帧率、连续快速滑动中的停滑回显。开发者工具截图能证明最终布局与控制语义，不能单独证明真机帧稳定性或完整 WCAG 符合性。
