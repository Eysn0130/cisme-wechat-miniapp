# 本机隔离业务读回

以下均为 2026-09-25 本机一次性服务 `127.0.0.1:18080` 的合成事实，runId `519be460383d35107017021e`，数据库 `cisme_test_519be460383d35107017021e`，95 条迁移。该轮主模拟器在修改售后轮询前的候选上操作；商品、结算、客服相关源码此后未改。没有真实付款、退款或正式客服送达。

| 路径 | 原生操作与服务端 SELECT 结果 |
| --- | --- |
| 商品原图和文字 | 管理页保存名称 `合成验收护理精华·图像核验`。`catalog_product` 中 `synthetic-acceptance-serum` 的 `image_path=/assets/cisme/synthetic-owned-acceptance.jpg`、`version=4`；小程序 `wx.getImageInfo` 返回 320×320，用户侧列表与详情均渲染这张自生成 JPG。图片 SHA-256 `5c9871bc1ef2cca9292e02fb47097cde53823d4fe6a63bc69be99a70457ef348`。 |
| 结算与订单 | 430×932 模拟器点按 2→1→2，2 件报价 ¥538；再改 3 件重新报价 ¥807，提交一次。`commerce_order` 中新订单 `a7b68c90-6ff9-4f30-a8e9-8ede5ca04c10` 状态 `pending_payment`、`total_cents=80700`；`commerce_order_line` 数量 3、名称与原图路径均匹配。另有预置 2 件订单，不计作本次写入。 |
| 售后 | 从预置“已付”**合成夹具**订单 `bd0a2ec3-1017-4c36-9d01-1f4ea4dfa294` 点按提交 1 件。`commerce_aftersale_case` 记录 `801c9c12-bc3d-4c7c-919b-28219751df1b`，`state=requested`、`kind=return_refund`、`claim_basis=quality`、`amount_cents=26900`，`lines[0].quantity=1`。夹具状态不代表真实付款。 |
| 客服草稿交接 | 在订单售后面板输入 `本机合成草稿交接：订单售后范围。`，点“展开”后完整客服页保留文本；点“发送”后 UI 显示“已发送”，`support_message` 对该正文读回恰好 1 条 `sender_type=user`。草稿交接仍是同会话、一次性、10 分钟内存范围。 |

读回使用该 runId 独占 Postgres 容器的只读 `SELECT`，针对 `catalog_product`、`commerce_order`/`commerce_order_line`、`commerce_aftersale_case`、`support_message`，按上述 SKU、订单 ID、案件 ID 和合成正文精确过滤；未连接正式库。原生连续关键帧在 [screenshots](screenshots/)；上轮隐私补充和四步护理读回仍见 [历史记录](../native-device-closure-20260925/README.md)，不把其旧哈希画面声明为本轮执行。

该 runId 的 18080 监听已停止；`docker inspect` 校验两个容器 `cisme.synthetic.run` 与 `cisme.synthetic.purpose` 标签后定向删除，临时对象目录也按 `.ownership.json` 校验并删除。后续本轮最终路由捕获使用另一 runId，另见本轮主报告。

## 最终源码候选的隐私与护理读回

最终源码哈希 `e96dc0f6c375e952b153266b483d008a7d7807a9a20844286ca3987cbc99e990`、一次性 runId `6e290c829b156a2a5e142172`。先由 Computer 在管理员原生页面选择“请用户补充”并保存受控回复，再由会员原生页提交补充。`privacy_request` `6de7d0d2-6f6e-4406-97fe-af6a0fa1184d` 的状态为 `reviewing`、类型 `access`；`privacy_request_operator_reply` 与 `privacy_request_member_reply` 各 1 行，后者正文为“补充：请查阅 D14 护理记录及本轮服务端保留的四步事实。”。会员页重进显示工作人员回复与本人补充；[原图](screenshots/privacy-supplement-final-small.png)。

同一候选在首页依次点“完成本步，继续”经过 00 净澈、01 清洁、02 修护、03 精护，选“舒适轻盈”后点亮 D14。`care_record` 最新一行 `835c82c4-bdbf-48a9-ac4e-c250ae51bb5d` 为 `milestone=D14`、`self_assessment=comfortable`；四条 `care_record_step` 按 `sequence` 聚合为 `00,01,02,03`。记录页重进并点 D14 详情可见四步与感受；[原图](screenshots/care-d14-final-small.png)。这两项均是本机合成事实，仍不代表真机、真实微信身份或正式客服送达。
