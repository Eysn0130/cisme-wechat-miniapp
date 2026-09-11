# Settings → 地址管理交互契约

状态：实现基线（2026-09-10）  
适用端：微信小程序，会员 Settings  
业务边界：地址是会员本人可维护的预备数据；保存地址不创建订单，不代表商城、支付或配送已开放。

## 1. 目标与成功标准

用户应能从手工填写、自由文本识别或微信地址中得到同一种 `AddressDraft`，清楚知道哪些字段已确认、哪些仍需复核，并在网络失败或并发修改时不丢失输入。成功的最低条件是：

- 页面正文永不进入状态栏、胶囊或自定义导航栏；底部操作永不进入 Home Indicator。
- 收货人、联系电话、省市区、详细地址逐字段校验，错误紧邻字段并进入可访问的错误摘要。
- 自由文本只在本机解析；仅在用户点击“粘贴并识别”后读取剪贴板。
- 识别结果只填充尚未被用户手工修改的字段；无法确定的内容明确标记，绝不伪造行政区划编码。
- `picker mode="region"` 保存省/市/区名称、三个行政区划 code 和 picker 返回的 postcode。
- 新增使用稳定的幂等键重试；编辑遇到版本冲突时不得静默覆盖服务器版本。
- 草稿仅按当前会员恢复，24 小时过期，保存、明确放弃或退出账号后清除。

## 2. 信息层级与主路径

地址管理区域只在用户展开“收货地址”后出现。

1. 地址簿标题、真实业务说明、最多 10 条的容量状态。
2. 恢复提示（如存在同一会员的未完成草稿）。
3. 地址列表或空状态。
4. 编辑器：快捷填写 → 核对结构化字段 → 标签/默认地址 → 保存。
5. 错误、冲突与恢复动作就地呈现，不用 toast 代替需要决策的信息。

编辑器中的首要任务是“核对并保存”，而不是强调自动识别。快捷填写是加速器；原生地区选择器是地区精度的最终确认点。

## 3. 统一 Address Draft

```text
AddressDraft
├─ id / expectedVersion / clientRequestKey
├─ recipientName / phone / detail / postalCode
├─ regionNames[province, city, district]
├─ regionCodes[provinceCode, cityCode, districtCode]
├─ regionSource: empty | parsed | wechat | picker | server
├─ regionNeedsConfirmation
├─ label / isDefault
└─ manualTouched: per-field flags
```

兼容字段 `nationalCode` 仅作为微信历史返回值或区县 code 的别名传输；服务端以可选 `provinceCode`、`cityCode`、`districtCode` 为规范字段。历史加密 payload 缺少新字段时按空字符串读取，不能导致解密记录失效。

来源合并规则：

| 来源 | 可写入 | 地区可信度 | 后续动作 |
| --- | --- | --- | --- |
| 手工字段 | 当前字段 | 用户确认 | 立即标记 `manualTouched` |
| 原生地区 picker | 三段名称、三段 code、postcode | 已确认 | 清除地区确认提示 |
| `wx.chooseAddress` | 姓名、电话、名称、详细地址、邮编、可获得的 code | 微信来源 | 缺少三段 code 时仍提示用 picker 核对 |
| 本地文本识别 | 高置信且未手改字段 | 推测 | 展示识别摘要；地区必须经 picker 确认 |

后到的导入结果不得覆盖 `manualTouched` 字段。用户可以显式清空字段；清空同样属于手工修改。

## 4. 状态契约

| 状态 | 页面反馈 | 允许动作 |
| --- | --- | --- |
| 初始/列表加载 | 骨架文案“正在安全读取地址” | 返回；不允许重复请求 |
| 空列表 | 说明尚未保存，强调可手填/识别/微信导入 | 新增 |
| 输入 | 字段即时更新，草稿延迟写本机 | 识别、picker、保存、取消 |
| 识别中 | 快捷填写区显示处理中，识别按钮 disabled | 可继续查看，不能重复识别 |
| 识别成功 | 列出已填字段；未确认地区突出显示 | 核对/修改/选地区 |
| 部分识别 | 明确缺少或有歧义的字段 | 手工补全，不猜测 |
| 识别失败 | 保留原文，说明无法可靠拆分 | 编辑原文或手填 |
| 手工修改 | 被修改字段成为合并保护字段 | 后续导入不覆盖 |
| 校验失败 | 字段旁错误 + 顶部摘要；焦点/滚动到首错 | 修正后重试 |
| 保存中 | 保存按钮 loading，离开保护开启 | 等待；不重复提交 |
| 保存成功 | 关闭编辑器、清草稿、刷新地址簿、成功反馈 | 继续管理 |
| 网络失败 | 保留草稿与幂等键 | 原请求重试 |
| 版本冲突 | 告知服务器已有更新 | “加载服务器版本”或“另存为新地址” |
| 未保存离开 | 原生确认框说明后果 | 继续编辑或明确放弃 |
| 恢复 | 同会员、未过期草稿提示时间 | 恢复或丢弃 |

删除和设默认同样使用版本检查。失败时先重新同步再让用户决定，不用过期版本持续重试。

## 5. 解析与隐私

- 快捷文本最大 500 字；兼容换行、空格、常见中文标签、全角标点。
- 电话优先识别中国大陆手机号码，也接受显式标注的可配送联系电话；邮编只在“邮编/邮政编码”标签或独立六位数字上下文中识别。
- 省/自治区/直辖市、城市、区县只做字符串拆分，不携带本地行政区数据库，不声称 code 精确。
- 同一字段出现多个候选、地区层级缺失或剩余详细地址过短时进入部分识别。
- 原文只保存在同会员、24 小时有效的本机草稿中；不会随识别请求上传。保存时只提交结构化地址。
- 页面展示不得自动调用 `wx.getClipboardData()`；剪贴板读取只能绑定到明确的“粘贴并识别”点击。

## 6. 导航栏、安全区与控件几何

统一 metrics 来自 `wx.getWindowInfo()` 和 `wx.getMenuButtonBoundingClientRect()`：

```text
navBarHeight = max(44px, 2 × (capsule.top − statusBarHeight) + capsule.height)
topbarHeight = statusBarHeight + navBarHeight
contentTop = topbarHeight + 12px
backTop = statusBarHeight + (navBarHeight − 44px) / 2
```

导航栏从屏幕顶端覆盖完整 `topbarHeight`，独立背景和高于正文的 z-index；标题只在导航内容行内居中。正文以 `contentTop` 作为真实 placeholder。底部 padding/固定操作条使用 `max(设备 safeBottom, env(safe-area-inset-bottom))` 后再增加视觉间距。

地址标签按钮的交互框固定为 44px：`height:44px; padding:0 12px; display:flex; align-items:center; justify-content:center; line-height:20px`。文字使用独立 `<text>`，不依赖微信 `button` 默认 padding 或 line-height。pressed、selected、disabled 分别改变背景/位移、边框/颜色和透明度；disabled 不保留 pressed 动效。所有主要按钮遵守同一几何规则。

## 7. 视觉、动效与可访问性

- 视觉延续 CISME 珠光紫：暖白表面、低饱和紫灰边框、单一深梅紫主动作；错误使用柔和莓红，不用纯红大面积背景。
- 区块以间距和细边框建立层级，避免在一张卡里继续堆卡。
- 状态变化使用 160–220ms 的透明度/轻位移；保存、解析等业务等待不做循环位移动效。低性能设备保持静态反馈。
- 触控目标至少 44×44px；正文最小 12px，输入与关键说明 14px 以上。
- 错误区使用 `aria-live`；picker 与按钮具备描述性 `aria-label`；颜色不是确认/错误的唯一信号。

## 8. 验收矩阵

- 单元：navbar metrics、解析器、合并保护、校验、草稿 TTL/会员隔离、后端新旧 payload。
- 组件：`miniprogram-simulate` 渲染地址编辑器并断言快捷填写、标签状态、disabled、错误和事件；内置 picker/textarea 仅检查契约和事件，不把模拟器当作原生行为证明。
- IDE：Nightly/`wechatide` 用于编译、指定页面、导航、console/network、截图和基础断言；Stable 用于发布前复验。
- 真机：至少 iOS 刘海/Home Indicator 与 Android 全面屏各一台，覆盖键盘弹起、picker、剪贴板权限、微信地址授权、断网重试、后台恢复。
- MiniTest/Minium：仅在团队确认具体执行器与设备渠道后记录为真机自动化；没有可验证的官方 MiniTest 接口时，不用同名第三方框架代替。

当前环境记录：Stable 2.02.2608070 已重新编译并打开 Settings，页面与地址组件的 WXML/WXSS 编译均成功。官方签名的 Nightly 2.02.2609102 可通过独立临时用户目录启动，日志确认版本无误；隔离实例没有登录态，不能在不复制账号凭据或打断 Stable 未保存编辑器的前提下继续运行时自动化。Stable Automator 握手此前连续超时，因此本轮不通过强制重启规避。视觉截图只作诊断，不替代上述测试层。

## 9. 交互审计结论

按“入口 → 编辑 → 校验 → 保存 → 失败恢复”完整路径复核后，已关闭以下源码级问题：Settings 页面 shorthand padding 覆盖全局导航占位的 P1；单行带标签地址无法可靠拆分的 P1；空文本识别、冲突动作、textarea、默认地址在忙碌态仍呈现可点击反馈的 P2；以及页面样式穿透自定义组件、可能重新覆盖 44px 控件几何的风险。地址编辑器现使用隔离样式，状态与动作由同一草稿模型驱动。

当前没有发现新的源码级 P0/P1。仍未通过的是需要外部设备或账号态才能证明的项目：iOS/Android 真机安全区与键盘、原生地区 picker、剪贴板权限、微信地址授权、断网恢复、系统大字号/读屏，以及经团队确认执行器后的 MiniTest/Minium。上述项目继续保持 `blocked`，不会以静态扫描、组件模拟器或 IDE 截图冒充通过。
