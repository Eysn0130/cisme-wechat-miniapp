# 商城卡片局部精修

设计判断：面向洗护消费者的原生微信商城，保留既有紫灰品牌与真实商品图，只校准卡片形状和层次。Operate 模式，DESIGN_VARIANCE=3、MOTION_INTENSITY=2、VISUAL_DENSITY=4；不套用 Web 框架、字体包、重构或展示动画。mobile-ui-ux-designer 为交互主约束，Taste 作辅助视觉审阅，Impeccable polish 用于窄范围精修。

- 本地缺少 PRODUCT.md/DESIGN.md。Impeccable context 明确允许既有代码的 scoped fix；采用现有小程序实现、用户当前截图与 PRD，不创建或替换产品世界。
- 当前 44rpx（375宽约22px）圆角偏大，统一缩为28rpx（约14px），活动横幅与商品卡片使用同一局部形状值。
- 单层有偏移的紫灰阴影为0 8rpx 24rpx rgba(61,37,79,.07)。不用彩色光晕，不叠加卡片描边；价格与商品图继续承担主要层级。
- 图片固定尺寸保留，display:block 消除行内基线缝隙；卡片与商品路径、文案、库存、价格及结算逻辑不改变，不增加网络或运行时依赖。
- 当前原生页面从真实公开 HTTPS 目录读取两款商品（198/298元），检查圆角、阴影、图片display和商品跳转；未登录、未触发购买、未写入真实会员事实。截图/计算值在对应源码哈希目录 shop-facts.json。
- Impeccable mechanical detector 返回[]；它不替代微信原生渲染验收。Taste 的 Web专属与全站重构规则不适用于本次微信局部修正，保留既有品牌字体和紫色，不增设新设计系统。既有加载/异常/权限恢复由原实现与回归保持；物理设备仍待验。
