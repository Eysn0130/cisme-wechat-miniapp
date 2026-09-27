# 原生页面逐项问题台账

逻辑视口由开发者工具设备菜单确定；缩放是开发者工具显示比例，不是真机或新视口。原始 PNG 不缩放、不改哈希。`screenshots/` 中前期截图来自 `b39bda6` 上持续修改的 dirty 工作树，只能证明当次所述状态；最终冻结输入为 `e96dc0f6c375e952b153266b483d008a7d7807a9a20844286ca3987cbc99e990`，另由本轮 40 路由包重新捕获。前期画面不冒充最终哈希的全状态验收。

| 页面与组件 | 文字/状态、视口与原图 | 实际样式与根因 | 修复文件与原生回归 |
| --- | --- | --- | --- |
| `pages/shop/index`，`.product-grid > .product-card` | 唯一商品“合成验收护理精华·图像核验”，默认态，Huawei nova13 模拟器 361×804、100%。[修前](screenshots/shop-image-after-small.png) 最后一个字落单，右栏空置；[修后](screenshots/shop-image-after-layout-small.png)。 | 原 `.product-grid` 固定双列，约半屏卡片承载商品名和说明，窄屏文字被压成孤字。只在商品数为 1 时改一列，卡片内图片占 34%、高度 200rpx，文字区 `min-width:0`；点击仍为原生 `button`。 | `pages/shop/index.wxml/.wxss`；361 点按可进详情，另看 [390](screenshots/shop-after-390.png) 与 [430](screenshots/shop-after-430.png) 默认态。[最终哈希的 361 原图](screenshots/shop-final-small.png)和 390 路由图复核单商品布局。 |
| `pages/order-detail/index`，`.support-sheet__error` 与 `.support-sheet__primary` | 未选问题类型点“提交申请”，逻辑视口 430×932。[修前](screenshots/aftersale-validation-before-430.png) 当前视口无报错；[修后](screenshots/aftersale-validation-after-430.png) 红字贴近提交按钮。修前显示比例 100%、原图 430×932；修后比例 75%、原图 323×699，**逻辑视口仍为 430×932**。390×844 的修后图是 75% 显示，原图 293×633。 | 原错误节点在 `scroll-view.support-sheet__body` 顶部，消息列表滚到底时被卷走；底部 `.support-sheet__footer` 独立滚动。原“重试”还错误地把表单校验当数据加载失败。另一次真实轮询会将校验消息清空。 | `pages/order-detail/index.wxml/.ts`：错误移至表单按钮旁，仅数据未就绪才显示“重试加载”；本地校验保持至表单修正或远端错误，避免轮询清除。Computer 实点后 10 秒/轮询再读仍为 `请选择售后问题类型。`，390 与 430 两种逻辑视口均复核；[390 关键帧](screenshots/aftersale-validation-after-390.png)。售后成功提交和服务端读回见业务记录。 |
| `pages/support/index`，附件面板 `.support-sheet__title` | 原标题“关联附件”但该模式只选择订单。[修前](screenshots/support-sheet-small-before.png)、[修后](screenshots/support-sheet-small-after.png)，均为 361×804、100% 的原生模拟器面板。 | 标题比真实动作宽泛，图片模式已有单独标题“添加图片”；原按钮、订单选择与 `bindtap` 均保留。 | `pages/support/index.wxml` 改为“关联订单”；Computer 实际点按后标题与订单入口匹配。 |
| `pages/management-product/index`，`.catalog-image-field` 说明 | 原源码条件会将 `/assets/cisme/` 下所有图片视为退役历史图，自有合成图片也会被误判。修前无留存原图；[文字编辑前](screenshots/management-image-before-edit-small.png)、[文字编辑后](screenshots/management-image-after-top-small.png)是修后同一 361×804 视口，不能充作修前画面。 | 原 `imagePath.startsWith('/assets/cisme/')` 过宽，合成自有且已批准的测试图片被误分类；存在图片与“历史原图暂不展示”文案不一致的风险。 | `services/catalog.ts` 与 `pages/management-product/index.ts/.wxml` 仅精确豁免合成 JPG，旧无授权素材仍隐藏。原生输入只改文字并保存后，`wx.getImageInfo=320×320`，列表、详情和 DB `image_path` 一致；最终哈希默认帧再核对。 |

## 已量测但未发现文字偏移的按钮

原生 `button` 未换 `view`。商品详情主操作在 390×844 的原生节点读回为 `left=10,right=380,top=752,bottom=802`（370×50 px）；计算样式 `height/min-height=50px`、`line-height=20px`、`padding=0 12px`、`border=1px`、`box-sizing=border-box`、`display:flex`、`align-items/justify-content=center`，文字子节点 `top=767,bottom=787`（20 px），几何居中。客服发送图标原生按钮为 44×44 px，flex 居中。检查了登录、商品详情/步进器、结算提交、订单详情、售后、客服发送/返回、隐私入口、护理与管理员保存的默认/可用状态；具体发现仅上表所列。字形视觉中心不能仅由盒子中心证明，仍以原图和点按为准。未取得所有控件的按下、加载、软键盘和真机状态，不写全状态 PASS。

连续关键帧：[结算 1 件](screenshots/checkout-430-quantity1.png)、[2 件](screenshots/checkout-430-quantity2.png)、[3 件报价](screenshots/checkout-430-quantity3-quote.png)、[售后面板](screenshots/aftersale-panel-430-open.png)、[客服草稿交接](screenshots/support-draft-handoff-430.png)。客服草稿帧为 430×932 逻辑视口、75% 显示的 323×699 原图。这些是实际原生交互关键帧，不宣称为视频、帧率测量或手机软键盘证据。
