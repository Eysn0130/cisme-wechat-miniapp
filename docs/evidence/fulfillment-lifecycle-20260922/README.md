# 首发履约源码与隔离验收 — 2026-09-22

基线：PR21 merge `5740e18544fa37dd473c36934a2a12a07a2d5ec9`。引用 PRD V2.1-R4 §8.2、ORD-02/03、WX-PAY-MAKE-01、AFS-02。本批完成的是首发单仓单包裹的本地履约事实与平台同步接线，不是正式发布通过。

## 用户批准的经营承诺

本任务用户于2026-09-22批准：中国大陆快递可达地区包邮，港澳台暂不配送；普通现货支付成功后72小时发货；例外必须下单前披露；依法七日无理由，化妆品按必要一次性密封及完好状态判断；非质量退货消费者付运费，质量/错漏发/运输问题商家承担合理费用；人工微信在线客服主入口。尚无批准的退货电话/地址，不编造。

新报价生成承诺快照并复制到订单，DB触发器拒绝事后覆盖；旧单 NULL 保持未知。当前普通现货无另行延迟例外。行政区校验不冒充承运商可达性证明，carrierReachabilityVerified=false。

## 本批实现

- `commerce_shipment`、line、event；原生订单物流与显式收货确认。首发全量商品一个包裹，拒绝重复发货，不能静默拆单。
- 退款命令与发货锁定同一订单行；存在待复核退款、处理中/异常/已成功退款时拒绝发货，首发不静默处理部分退款后的发货。
- 本地发货与 `commerce_shipping_sync` 任务一个事务；微信网络在事务外。平台不确定结果继续查单，不自动重传；本地收货不伪造承运商签收、微信确认、退款或佣金释放。
- API/独立及内置 worker 接线；默认关闭。保护文件逐次校验环境/AppID/商户/能力/期限，staging 限批准隔离订单号；没有安装出站批准文件，没有调用真实微信发货或资金 API。
- 管理端独立履约面板：已支付订单按状态/精确订单号筛选、游标分页、Excel XLSX导出、单笔/批量物流登记。Excel复制5列粘贴（最多25行），不声称已支持任意xlsx文件上传。全部行先检查格式、重复/错单，逐行原子提交并报告部分结果。
- 导出500单上限，全部单元格为字面字符串，姓名手机号地址只在请求内存，权限锁+提交前复核，审计操作员/时间/筛选/数量/摘要，提交审计后响应，no-store，不落服务器磁盘。
- 隐私主体映射129表。仍未完成全域主体导出、删除、正式保留策略，不把映射视为执行完成。

## 已执行验证

准确源码HEAD `0f1b4c346173ed26d6ffd3d6e3612ef893b14212` 的 [CI35715524252](https://github.com/Eysn0130/cisme-wechat-miniapp/actions/runs/35715524252) verify SUCCESS：1023单元、800集成。条件设计/凭据预览任务SKIPPED，不算原生/真机通过。

- 本机全量集成：45文件、800测试通过；run `a054ef5659f43f048446ef44`，本轮新DB/S3已按归属删除。
- 全量单元：1018通过、1跳过；新增原生生命周期4例后定向82例全部通过。最终CI以准确HEAD为准。
- typecheck/build、234个/v1方法、236个含健康方法与OpenAPI一致；32事件。
- 追加复核：阻止退款中及已退款订单发货；签名合成退款回执路径14项通过，run `0d1a72159aaf514d7aede9d6`。最初退款夹具错误地分配到不存在的佣金快照，原服务正确拒绝；修正为非佣金商品退款后通过。
- 定向14个支付/履约集成包含：待支付拒发、已支付发货、并发重放、改运单冲突、无权限、错单/重复行、微信查询失败保留本地事实、所有者隔离、显式收货重放、不可变证据、Excel审计、撤权竞争。
- 单元覆盖授权文件绑定/过期/撤销/权限、ZIP目录与CRC、公式样文本、地区规则；原生生命周期覆盖离页/切账号迟到物流、确认弹窗切账号、未知收货结果沿用原请求。
- 失败记录保留：第一次导出审计 object_id 非UUID导致回滚，修复为随机审计对象UUID；原生禁用样式补齐。未掩盖失败或降低验收门槛。

## 原生证据

当前源码包SHA256 `dda91b4f41eff04665bcd52717bd950c50f23be0284cea45c0ad60ebffa35644`；259文件/37路由。
原生截图时API源为249efe38a08953f94611dc155a9f48be37a79842；随后仅后端退款拦截修复到0f1b4c3，小程序包哈希未变。截图不冒充该后端修复的端到端原生验收。官方wechatide CLI实际连接IDE内置skill0.3.9。真实模拟器、真实本机API `127.0.0.1:18082`、本轮合成DB `cisme_test_895ea1f7428eae68e3cd1131`，74迁移。没有setData伪造页面状态、没有mock接口。

- native-order-pending.jpg：真实待支付订单、not_ready履约状态、固化承诺，coreReady=true，shipmentError为空。
- native-checkout-policy.jpg：点击报价按钮后真实报价、运费0、包邮/72h/退货承诺、环境支付关闭提示、底部按钮与滚动布局。

这两图不覆盖已发货/签收/售后全状态，不替代iOS/Android真机。已恢复模拟器原API `127.0.0.1:18080`、原会话并回首页；未输出/保存任何会话值。全部37页完整状态门仍blocked。

## 环境与未完成项

- production `lhins-61ikz4mi` /124.223.74.198 维持只读，版本Git SHA仍UNKNOWN。不得套用staging版本结论。
- staging `lhins-ei4hz4fi` /150.158.39.74 已部署 `0f1b4c346173ed26d6ffd3d6e3612ef893b14212`；74迁移/重复0，HTTPS200，监控绑定已更新，74迁移/129表恢复计数一致。详见 STAGING-DEPLOYMENT.json。全部交易/物流真实账号与真机验收仍未完成。
- 微信原文由用户提供：**小程序备案 管局审核中**，非代码版本审核结论。未改审核流程。
- 腾讯云控制通道已可用；私有微信平台受工具站点策略限制，合法域名四栏、物流助手开通/承运商绑定仍待平台证据；不认定服务未开通。
- 仍有源码技术项：正式商品/订单/支付启动门的完整接线，非隔离售后工单与退款闭环，物流助手轨迹/事件/确认收货提醒，微信同步人工复核恢复，管理端正式操作员登录；全接口13维逐项验收、全面隐私执行、74迁移候选staging验收与物理设备验收。
- 最小业务配置：真实退货电话与地址、正式隐私保留策略批准。ICP/腾讯云接入备案和production公网443仍需独立确证/处理；stagingTCP80按用户决定暂不修改。
- 旧cisme_test事故影响UNKNOWN、未恢复、未触碰。没有真实付款、续费、生产删除、正式提审或发布。

## 官方依据

[微信发货信息管理](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_uploadshippinginfo.html)、[查询订单](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_getorder.html)、[订单列表](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_getorderlist.html)、[提醒确认收货](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_notifyconfirmreceive.html)、[物流助手轨迹](https://developers.weixin.qq.com/miniprogram/dev/server/API/express/express-by-business/api_getpath.html)。真实签收后才能发送提醒，提醒不是自动确认；未因SDK存在引入付费Provider。

[Microsoft SpreadsheetML结构](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document)、[Node zlib CRC32](https://nodejs.org/api/zlib.html)。仅实现有界输出，无第三方SDK源码复制/依赖新增。
