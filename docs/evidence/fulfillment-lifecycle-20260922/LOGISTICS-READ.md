# 微信物流只读接线及批量恢复补充

2026-09-22；接续已部署源码 `0f1b4c346173ed26d6ffd3d6e3612ef893b14212`，属于 PR22 后续源码。**本补充源码尚未部署 staging 或 production，不能把原部署/截图自动推广为本次验收。**

## 实现与范围

按[查询轨迹](https://developers.weixin.qq.com/miniprogram/dev/server/API/express/express-by-business/api_getpath.html)、[已绑定账号](https://developers.weixin.qq.com/miniprogram/dev/server/API/express/express-by-business/api_getallaccount.html)、[支持快递公司](https://developers.weixin.qq.com/miniprogram/dev/server/API/express/express-by-business/api_getalldelivery.html)实现 TypeScript 官方客户端；无外部 SDK 或付费依赖。账号接口成功示例省略 errcode，解析允许省略或数值0，但必须通过完整字段校验。轨迹示例出现300001而合法码表未定义，源码保留 unknown，不猜为派送或签收。

- 新增本人 GET `/v1/me/orders/{orderId}/shipment/tracking`；从已核验支付及加密原包裹提取绑定字段，调用前后核验主体；网络不持有DB事务。
- 新增管理 GET `/v1/management/logistics/capabilities`；调用前后检查当前履约权限，只投影承运商、原绑定状态码、余额是否可用；不返回客户编码、别名或备注。
- 保护文件新增两个独立读取能力，不默认授予。轨迹额外绑定AppID/商户/staging隔离订单白名单。未安装真实授权文件，也未读取真实物流账号。
- 小程序在已有发货卡片提供显式查询、加载、空结果、失败重试、来源及查询时间；继承现有颜色/间距/按钮，长消息换行，aria-live提示。离页、换号、包裹刷新后丢弃旧响应；不自动变更确认收货、退款、物流终态或佣金。
- 管理端提供只读能力核验入口；支持列表不等于已签约，散单能力不等于免费。物流助手是否覆盖手填运单须实际核验；不可查时保留原运单并显示不可用，不能构造轨迹。
- 修复 Excel 粘贴导入的重放：首次准入固定订单ID/版本映射，后续订单变更不改变原重试内容；只保存ID/版本及指纹，不保存明文导入运单。改行重用键冲突；单行发货仍独立事务，部分成功逐行报告。

## 两个新增方法的13维复核

|维度|轨迹 / 能力查询的证据|
|---|---|
|PRD业务|§8.2 / ORD-03；原订单本人轨迹、管理员能力核验；不把外部轨迹当本地收货事实|
|身份|共同HTTP认证前置；本人活动账号在外部调用前后核验|
|权限|能力接口当前commerce.fulfillment.manage前后复核；无权集成测试|
|对象|订单member归属→shipment→原加密parcel→唯一applied full_cash支付事实；外人请求无网络|
|字段|OpenID/运单仅受控出站；严格响应三字段绑定；轨迹本人瞬时显示；审计只有对象/数量|
|动作状态|只读，不创建面单、不绑定账号、不修改签收/退款/佣金；集成验证查询到delivered后本地仍shipped|
|环境|默认无出站权限；环境/AppID/商户/到期/隔离订单白名单，token获取后复核撤销|
|输入|UUID、固定承运商/运单格式、整数时间/节点码、消息长度、三字段响应绑定；未知码unknown|
|幂等版本|读取不产生履约变更；重复读取各有审计。导入另外固定首次版本映射并按内容指纹重放|
|并发|外部调用无DB锁；返回前活动会员/履约权限复核；查询期间停用账号拒返轨迹|
|DB/外部|固定官方HTTPS，拒绝重定向；不记录token/URL/上游错误正文；只写计数审计|
|预算/分页|15秒依赖预算、64KiB JSON、最多100节点/200账号或公司；不静默截断|
|正反证据|接口/响应单元、撤销授权、本人/外人、停用竞争、状态独立集成；实际账号及原生成功轨迹仍未验收|

全接口分母当前236个/v1方法、238个含健康方法、32事件、205个保护方法。映射不等于完整13维验收；全量 accepted 仍未填为238。

## 已执行验证与限制

- 全量单元1048通过、1跳过；全量集成804通过（45文件），本轮隔离run `2d02ff0be3e907e6f5d688f1`，DB/S3已按归属删除。该全量集成发生在导入版本映射补丁之前。
- 导入补丁后的定向支付/履约14项通过，run `70294d0f11805e741eb8ed03`，DB/S3已按归属删除；包括两单成功、同批重放、订单版本变化后重放、改运单冲突、批量部分成功及重放。
- 首次直接调用disposable runner未通过npm PATH导致vitest ENOENT；无测试执行，runner仍按归属回收资源。修正调用方式后通过，不将首次尝试算成功。
- TypeScript/OpenAPI/build/包预算通过；官方wechatide内置skill0.3.9的WXML编译success/codeLength36578，WXSS success/2文件/18524字符。**这只是局部编译，不是新增物流成功态原生截图或真机验收。**
- 小程序包SHA256 `e39643c8276ae8ee50cbc46cf0d37fb45031e1630f3d02ed96b6f39cf0c72c6f`，259文件/37路由。原两图对应旧包dda91…，保留原范围；新包全状态门仍blocked。
- 2026-09-22T10:53:20Z，腾讯云staging控制台只读probe：lhins-ei4hz4fi、sourceHead0f1b4c3完整值、API/worker active、HTTPS200、healthy=true、freeBytes41555435520。production未变更。

## 继续施工项

真实物流助手资格/已绑定承运商/手填运单覆盖；平台订单列表和签收后提醒；耐久物流事件及去重、微信同步manual_review恢复；完整正式交易新命令/非隔离售后/操作员登录；全域隐私导出删除及批准保留规则；新增源码的staging完整交易验收、原生有效对象全状态、iOS/Android设备验收。上述源码/验收缺口不能改写为“只等运营截图”。

production公网443、域名ICP/腾讯云接入备案、微信合法域名四栏继续独立核验；当前用户报告仍为“小程序备案 管局审核中”。没有操作审核、付费服务、真实资金、生产删除或旧cisme_test。
