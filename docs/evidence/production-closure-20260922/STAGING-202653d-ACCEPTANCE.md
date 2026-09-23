# staging 202653d：准确候选现场验收

仅 lhins-ei4hz4fi / cisme-staging-shanghai /150.158.39.74/staging-api.cisme.cn。run rc20260922-00c7d2e9；source 202653d35b745c9cad2e47cba248dcf9e4706946；release /opt/cisme/releases/rc20260922-00c7d2e9-202653d35b74；新建所属 DB cisme_accept_rc20260922_00c7d2e9；本地对象 /opt/cisme/tmp/rc20260922-00c7d2e9/object-storage。旧 DB、production、旧cisme_test均未改动。

原始回执由已认证 OrcaTerm 文件管理器下载，不是手填JSON。STAGING-202653d-RAW.json 与现场同为25532字节，SHA256 ec2a40edaabb2bdba06113727de8977f4d308d36f380ea31d6f2785fcdc6c866。精确执行输入位于 staging-202653d-inputs，基脚本hash bcecc4c0ef31e2c36a149e46030be3264bf8ec556de168fb83e218f6eb8d9741。该目录脚本只供审计，不能不经现场复核重放。

## 实际通过的范围

- 制品完整校验；75项迁移，重复0；API/Worker激活，正常证书验证公网HTTPS200、未登录metrics401。
- 15项隔离合成HTTP业务检查及18次 no-store 校验，含隐私所有者隔离、幂等、版本并发、管理员capability、撤权读写拒绝。合成签名会话仅在内存，未声称真实微信身份验证。正式交易关闭，无支付/退款/真实物流调用。
- 新建独立PG16.15 baseline库模拟production旧23项迁移：注入journal写入失败，DDL与journal回滚；随后前向升级至75项；合成member、consent及privacy request保留，重复0。不是生产库恢复或实际生产迁移。
- 从当前run DB备份到独立_restore库：75迁移、129表、2合成会员、1请求、3事件、6审计、2撤权、2政策和1marker一致；选定业务JSON摘要一致。备份hash 061daf0038756875838853dd6ca6ba5925b7df636309b7a7591b61b6f776d88e。只恢复本地合成对象marker，不是COS、完整key/role/ACL恢复。
- 2026-09-23T00:50:39Z至00:55:41Z共61次HTTPS健康采样，API/Worker active/running，重启次数0。仅约5分钟，不代表长期稳定。
- 实际从202653d回滚到f4c8df9应用，再恢复202653d，整个过程使用同一所属DB/对象目录。备份后新增的合成privacy request在两版本可读取，新增对象保留；未恢复旧DB、未执行down migration。
- 监控脚本明确从f4c8df9绑定到202653d，原脚本root-only保留；新hash ddcc6b124d63b9d8df23f63571c444483a61975af4ed057c053f5ff9e65fadd2。回滚后重新执行监控Result=success。外部告警未配置/未验收。

首次prepare参数错用了不存在的政策文件名，资源创建前拒绝；现场核验实际publication-staging-2026-09-11.json及SHA后重试成功，没有放宽guard。公开staging政策仍为terms v4-staging与privacy v7-staging-support，不是已批准production政策。

## 分开的现场外部探测

回滚后从staging主机在00:57:02Z探测production，DNS为124.223.74.198，正常证书检查路径在8秒预算内URLError不可达；不能仅凭此判断唯一根因。00:57:10Z探测staging，DNS150.158.39.74，HTTPS200。

本机探针返回198.18/15解析且两个域名均失败，已明确标为本机路径限制，不拿它替代上述实例/DNS事实。

production尚未部署，main未合并。此验收不是完整支付/售后/隐私/COS/真机验收。旧cisme_test继续UNKNOWN / 未恢复。
