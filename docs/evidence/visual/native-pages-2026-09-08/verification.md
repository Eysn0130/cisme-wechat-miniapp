# 原生小程序逐页精修 · 2026-09-08 23:37

产品与验收对象：微信小程序 WXML/WXSS/TypeScript。以下图片均来自微信开发者工具 RC 2.02.2608031 / 基础库 2.32.3 / iPhone X 模拟器 375×812（全窗口显示比例 64%），不是网页预览或独立 App。

## 本轮发现与修复

| 页面与状态 | 原生实测问题 | 修复与复核 |
|---|---|---|
| 护理首页，已登录且资格待确认 | 微信 disabled 按钮默认灰字覆盖视觉设计，等待原因几乎不可读 | 为既有 CTA 文本显式指定白色；真实 disabled 保留；前后同坐标截图确认文字可读 |
| 记录页，无护理周期 | 标题末尾“惯。”成为第三行孤字；状态同时声称待用户开始，与无周期矛盾 | 标题容器从 64% 调至 72%，保留字体/字号/两行文案；无周期显示等待体验资格确认，已存在 planned 周期仍待用户确认开始；模拟器 AX 与画面均复核 |
| 记录页加载/错误标题 | DevTools 报页面 strong 标签选择器不支持 | 改用专有 class；未更改加载/错误状态处理；本轮保留旧警告记录，不用清空日志制造全程无警告结论 |
| 商品详情 | 底部按钮重复价格且使用“交易”术语 | 对齐已确认文案“购买尚未开放”，真实禁用不变，价格仍在商品主信息区显示 |

## 原生商品交互验证

- 初次进入自动轮播已观察到 1/3 → 2/3 → 3/3。
- 点击下一张后暂停控件消失；超过 5 秒周期仍停在 3/3。
- 从目录重新进入，新一轮自动播放已启动；不先点击箭头，直接横向拖动后显示 1/3，暂停控件消失。时间戳间隔 31,476ms 后仍为 1/3。
- 商品下方说明能够垂直滚动到可见区域，固定底部动作保持可见。
- 手势测试中 DevTools WAWebview 内部产生 `undefined is not iterable`（Array.from）错误，画面切图与停止行为已观察，但不能推断真机无错。该问题仍需实机区分，不是 release passed。

## 证据文件

- `home-waiting-before.png` / `home-waiting-after.png` / `home-waiting-comparison.png`
- `records-no-cycle-before.png` / `records-no-cycle-after.png` / `records-no-cycle-comparison.png`
- `product-manual-stop-first.png` / `product-manual-stop-settled.png`
- `product-swipe-stop-first.png` / `product-swipe-stop-settled.png`
- `product-short-footer.png`

对照图统一从全窗口裁切 x893/y88/w240/h521，不缩放或改变任一侧内容。前后比较仅证明本轮修复，不是冻结 Web 的全部状态视觉验收。

## 当前源码与验证边界

最终包 SHA-256：`b0b1c7c8d1d9cc528c7802f98ca2eddf1af76ada1dcaba8ca96d6cf49b39a2e6`。138 files / 14 routes / 1,693,220 bytes / global WXSS 8,117 bytes。截图在本轮逐步修改过程中采集，不能把较早截图自动提升为最终哈希的全矩阵证据。

无周期与 planned 状态区别加入行为回归；全量单元、类型、包门禁以本轮命令结果为准。当前源码 acceptance manifest 保持 blocked；所有完整路由矩阵、Network、正式账号/域名条件及 iOS/Android 真机验收仍需补齐。

## 23:40–23:44 当前源码局部复查

源码包哈希在采集前后保持上述 b0b1c7c8…，6 张完整窗口截图已按实际字节哈希、尺寸、路由和状态登记在 current-source-acceptance.json。均为微信开发者工具 iPhone X 模拟器（375×812，64%），不是物理手机证据。

| 页面 | 已观察范围 | 截图 |
| --- | --- | --- |
| 我的 | 默认展示、从邀请返回后导航恢复 | profile-default.png；profile-back-restore-b0b1c7c8.png |
| 积分 | 0 积分与空账本展示 | points-empty-b0b1c7c8.png |
| 设置 | 未授权展示、退出确认弹层；取消后保留会话 | settings-empty-b0b1c7c8.png；settings-modal-b0b1c7c8.png |
| 邀请 | 已生成分享编号的卡片展示；未发送外部分享 | invite-default-b0b1c7c8.png |

以上 4 页、6 个状态仅登记局部原生证据，状态矩阵仍 blocked。未将现存 DevTools 报错清除或声明为零；没有新增 Network、参考并排对照或 iOS/Android 真机证据。

采集工具返回的 6 张图片实际编码为 JPEG（历史文件名后缀为 .png）；清单按文件签名登记 image/jpeg、1250×733，并保留原始字节。

## 23:49–23:54 任务、投稿与进度异常页

现有调试入口中的任务/投稿编号对当前会员不可访问。真实原生页面已观察到邀请不可用、草稿不可用、记录不可用，未伪造有效任务或提交任何材料。任务及投稿的返回来源按钮已验证回到社区。

发现投稿加载失败时顶部仍承诺输入后保存草稿，已改为仅在 submission 已加载且非 loading 时显示 draftState，并使用原生 text 节点。同裁切修复前后图 `submit-unavailable-comparison.png` 已检查：标题正常居中，错误说明与返回按钮完整。

本次最终源码哈希：`23691a4cfe64bb6e0e81c909f2ee7b134707663d8b3715d3ee98675185ea36d1`，138 files / 14 routes / 1,693,253 bytes / global WXSS 8,117 bytes。新清单绑定投稿和进度的不可访问状态截图；b0b1c7c8 清单完整归档，之前截图不转绑。任务不可用及任务返回截图属于 b0b1c7c8。当前 Console 有请求失败记录，未声明 Console/Network 清洁或完整路由通过。

补充：审核进度页“返回投稿来源”亦已确认回到社区。类型检查、包门禁与证据门禁 10/10 测试通过；releaseReady=false。
