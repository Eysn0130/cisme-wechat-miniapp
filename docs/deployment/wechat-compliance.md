# 微信平台整改与恢复

依据 Owner 于 2026-11-17 要求复核并执行的整改方案，对应 PRD P01/P02/P15–P18/P20、PTS-R01、§11.3、WX-PAY-MAKE-01，以及新增 AUTH-PHONE-MIN-01、AUTH-PUBLIC-01、AUTH-PRIVACY-01、WX-ORDER-RETURN-01、WX-TRADE-01。此记录区分代码、已部署配置、发布版本和微信批准，不能互相替代。

## 已核对的事实

- 2026-11-17 17:35 UTC：正式与体验 `phoneBindingEnabled=false` 读回成功；只暂停新增绑定，没有删除会员、订单、库存或密钥。
- 17:52 UTC 官方只读接口：`is_trade_managed=true`、`completed=false`、订单详情 `path=""`。HTTP 200、errcode 0；空路径和未确认都是实际结果。未调用支付、退款、发货或转账。
- 历史数据只读审计：正式18会员/15联系电话、体验9会员/8联系电话，所有现存联系电话均有 `USER_WECHAT_PHONE_AUTHORIZATION` 审计；这不单独证明所有历史用途必要，也不是批准保留期限。没有按日期、昵称或数量删除数据；有明确撤回或缺少依据的记录应经精确标识走原权利流程，不清空订单。
- 微信公众平台页面被浏览工具站点安全策略阻止。没有改用浏览器私有协议、Cookie、其他表面或抓取工具绕过；商户结算确认、订单中心协议、隐私提交、违规复核和品牌申请仍需账号管理员取得真实后台结果。
- 既有 main `fbfc18917214` 的代码包 0.1.55 已经官方工具上传成功，仍不是本次合规改造包，也没有本次正式发布回执。本轮目标客户端为0.1.56；发布状态以随后真实回执更新。

## 改造范围

1. 微信身份登录不读取手机号状态、不收集手机号；设置只保留历史号码查看及解绑。失效会话仍用原微信 canonical 身份恢复，不新建或合并账户。头像昵称仍在登录页内按需确认；原问卷及积分回执、卡券、订单和推荐关系不变。
2. 冷启动默认公开护理首页。公开商城、产品、社区帖子/作者与显式游客使用同一策略；会员资产、订单、护理记录、发布/评论及管理写入依旧认证核权。
3. `__usePrivacyCheck__=true`，保留微信官方隐私弹窗；在补齐头像/昵称前调用 `requirePrivacyAuthorize`，覆盖昵称聚焦不会主动触发的场景。没有用自己的协议勾选假冒微信同意，没有为注册或授权发分。
4. 收件人电话只在主动维护地址时用于配送，可以与付款会员不同，不绑定账户。解绑删除联系密文、HMAC索引及掩码，撤销旧资料导出并增加擦除版本，阻止在途旧快照继续下载；防重放凭证摘要和真实交易留存分开。
5. 订单中心 `outTradeNo` 与发货通知 `merchant_trade_no` 共用本人订单解析；绑定不可变支付意图、当前AppID/商户、会员和当前环境数据库。非法/不存在/他人号码统一404；源参数在认证返回时保留，换账号清除解析和详情。原UUID链接与注销后窄权利会话继续支持。
6. 复用原微信发货/收货查询与持久化同步。官方接入状态及订单路径诊断通过管理权限或只读运维命令读取，不从本地开关推断微信许可。已知未接入、未确认或管控会禁止新支付；旧订单、退款和客服不因此关闭。
7. 现有AES消息回调按类型分发4种交易通知，保留内容安全处理。验签、解密及接收AppID验证后持久去重，订单通知还须匹配可信支付意图和支付回执。每轮最多4笔只读查单，错误退避30分钟、最多12次后待人工核对；不生成付款、发货、收货、积分、佣金或结算终态。
8. `wxa_trade_controlled` 跨重启保留本地管控；普通接入提醒或UNKNOWN不会清除。记录官方解除处理单且重新核对两项状态后，具备履约和财务核对两项既有权限的管理员才能解除本地锁定；仍不声称已完成一笔真实支付。

## 原生版本发布后的路径设置

**必须先发布含解析器的客户端**，完成订单中心协议签署和所有关联商户的结算确认，再设置路径；不能给仍只识别UUID的旧客户端下发商户号。

订单中心路径（保留字面占位符，不填一笔真实单号）：

```text
pages/order-detail/index?outTradeNo=${商品订单号}&source=wechat_order
```

发货/确认收货消息路径：

```text
pages/order-detail/index?source=wechat_shipping
```

微信会追加 `transaction_id`、`merchant_id`、`merchant_trade_no`；代码不信任客户端提供的支付事实，只用商户单号在本人范围解析后读服务端事实。

运维只读：在已加载对应环境、密钥和现有 `shipping.query` 授权的受保护会话运行 `npx tsx scripts/wechat-trade-readiness.ts`。不要将环境文件、Token或返回URL贴入工单。

路径变更另用0600受保护审批文件，包含 schemaVersion=1、mode=`wechat-published-order-paths`、真实environment/AppID/merchantId、真实publishedClientVersion、orderCenterAgreementConfirmed=true、实际approvalReference与未来expiresAt；它不授权支付、发货或退款。确认真实发布版本后运行：

```text
npx tsx scripts/wechat-trade-readiness.ts --configure-paths --published-version <已发布版本> --approval-file <受保护审批文件>
```

命令只允许两个固定官方写接口，随后读回详情路径；消息路径接口无读回，保留其独立响应。任何一项失败都不能声称全部完成。不要在发布前为缩短步骤填写虚假的“已发布”证明。

## 隐私与营销后台

新版候选位于 `docs/legal/compliance-20261117/`。`MP-PRIVACY-FIELDS.txt` 提供9项实际用途，含管理员批量发货文件；`PRIVACY-SUPPLEMENT.txt` 小于100KB。经营者核对后，通过原版本化协议流程发布并同步微信后台；在取得回执前保留候选状态，不覆盖历史已确认版本。

手机号条目不可再写“登录／注册必需”。后台如保留“手机号”类型，应限定为用户主动填写的配送收件电话，并与地址用途一致；不因当前无getPhoneNumber组件而隐瞒真实配送电话处理。普通用户不被要求选文件或视频。

营销优先核对公告认可的真实品牌资质：认可品牌/认定商标或符合要求的平台品牌旗舰店及主体/授权关系。项目里的Logo、普通商标或普通店铺不自动满足。暂缺材料时继续原生微信卡片、朋友圈及小程序码；现有外链失败降级不妨碍原生分享。Scheme默认额度不推断为所有访问共用100次。不得缴旧保证金、刷单或改类目规避；微信小店会改变订单和资产体系，另行决策。

## 验证与发布边界

- 当前源码须通过类型、完整单元、隔离PostgreSQL集成、OpenAPI、最终迁移和数据用途清单检查；旧证据不自动继承。
- 原生检查包括：公开冷启动和游客Tab，登录无手机号且旧会员资料保留，微信隐私拒绝/重试，两个外部订单参数、认证返回、换账号和404，支付受限时旧订单/客服可达。官方系统隐私弹窗、微信订单中心和真实物流消息仍须物理设备验证。
- 新验收数据只能进隔离库；真实体验账号如需产生数据先取基线，按精确ID隔离恢复。当前没有实发订单，不创建假运单，不自行扣款或退款。
- 手机号整改截止保持通知原文 **2026-11-24 14:27:09**，以后台时区和处理单为准。代码上传不等于正式发布，已提交整改不等于微信通过；支付、手机号与营销分别取得平台结果。

官方依据（2026-11-17读取）：[手机号组件](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html)、[隐私授权](https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/PrivacyAuthorize.html)、[购物订单与路径](https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/order_center/order_center.html)、[发货管理与事件](https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/order-shipping/order-shipping)、[消息路径](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_setmsgjumppath.html)、[结算确认](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_istrademanagementconfirmationcompleted.html)。
