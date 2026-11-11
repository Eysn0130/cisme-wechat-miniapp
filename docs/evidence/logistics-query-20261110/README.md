# 无月结账号的物流查询接线

依据当前 PRD §8.2 / ORD-03 及所有者“打通购买、售出、XLSX发货和用户查看”授权。用户明确没有快递月结账号；继续普通寄件后单笔或批量回填实际运单，不生成电子面单或购买物流服务。

微信官方查询插件与电子面单接口分开。官方指南列出的申请条件包括已开通微信支付及过去30天有交易，另须在 MP「功能 → 物流服务」申请开通查询组件；不能通过伪造交易满足。插件使用须真机预览，开发者工具模拟器无法验证插件详情。

- 官方指南：https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/industry/express/business/express_search.md
- 官方传运单接口：https://developers.weixin.qq.com/miniprogram/dev/server/API/weixin-express/express-search/api_trace_waybill.html
- 官方插件管理：https://developers.weixin.qq.com/miniprogram/dev/server/API/plugin-management/api_manageplugin.html

本轮对已核实 AppID 的官方插件申请返回 errcode 0，插件状态2（批准），provider `wx9ad912bf20548d92`；查询组件获取运力接口仍返回48001（未授权）。申请没有发送客户资料、订单或运单，也没有扣款。插件批准不能写成查询组件业务权限已开通。

原生订单页增加“复制运单号”和“查看物流详情”。仅用户明确点击详情才申请查询；服务端重查本人有效身份、真实已支付订单、同 AppID/商户的已应用支付事实、冻结地址及该单实际包裹，再调用官方接口。管理员不能读取买家查询凭证。仅上传原有订单的必要配送手机号、实际运单、微信交易号、购买商品和详情路径；两张原已批准商品照片通过精确白名单公开提供。

凭证按会员和包裹绑定、加密保存在幂等日志；页内仅调用栈持有，不进入页面 data、缓存或审计详情。外部请求之前持久化派发意图。超时或结果不明不自动重传，避免消耗平台修改次数；明确拒绝后可由本人再次操作。平台缺权限在创建派发意图之前失败，开通后可重新点击。物流查询不改写签收、收货、退款、积分或结算事实。

新增保护文件能力 `logistics.query.register`，与旧查询只读授权分开；体验授权仍限定本机独立数据库及真实 AppID/商户。正式环境配置与会员资产不由此更改。

验证结果及发布状态须以本目录随后保存的回执为准。当前本机 PostgreSQL Docker 镜像出现 I/O 读取错误，数据库集成验证交由 CI 独立临时数据库执行；不得将容器启动失败记录成测试通过。真机实际已付款运单尚未验证，不生成虚构订单或物流轨迹。
