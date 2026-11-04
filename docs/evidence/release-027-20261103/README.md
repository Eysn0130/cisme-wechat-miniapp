# 0.1.27 体验版发布准备

用户明确要求发布最新体验版。本次合并此前尚未发布的原生切页稳定性修复、社区关注与直接发布调整；小程序源码包 SHA-256 为 `a7aabbf0057d51b0728c8c98864174910122fbe903ab18e2d2086d3f634dceb2`（301文件、40路由）。本文件是发布前记录，不把计划写成已部署或上传。

已通过3049项单元测试（1项原有跳过）、两端类型检查、285条v1接口/32事件契约检查及原生包检查。旧人工审核/任务证明用例已改为停用校验，护理、历史积分双人复核、客服上传、社区举报/申诉和评论检查保留。完整集成回归与准确提交的CI状态以随后实际回执为准。

原生范围见此前三份独立证据目录：`../navigation-continuity-20261103/`、`../community-following-20261103/`、`../community-direct-publication-20261103/`。当前源码的完整40路由全状态矩阵仍为blocked，真机键盘/手势未全覆盖；本次为受控体验版，不能据此宣称全产品发布验收通过。

服务端基线只允许正式腾讯实例 `lhins-61ikz4mi / 124.223.74.198` 上独立 `/opt/cisme-trial`、`cisme_trial` 和原两个trial units。已读回105基线 `d6dda6399b373be96296f37a6fd749537f1b4712`、tree `9f83d9e55bb5efef3e1ffc63f884d45ddb143d50`、manifest `d435eb1d9496ff9eb6c8b8b3a2f1bac3952550f24051d513259fe4e3ac383e80`。新helper `infra/tencent/trial-community-direct-publication-update.py` 固定认证旧helper、binding和递归私有输入链；仅在准确main push verify成功、完整Linux制品、停trial writers与认证加密snapshot后执行唯一106索引迁移。前105 SQL、所有旧行与journal事实、原配置/密钥/权限、生产服务和依赖保持；失败停体验服务供前向恢复，不自动回滚数据库或旧应用。

新SQL `202611030001_direct_publication_lookup.sql` SHA-256 `f69195ea062737f462026be02af20c0c462cb9c9c7ab03612df672e1aa2022c2`，仅增加当前发布意图的审计索引，无数据迁移。helper SHA-256 `049e0e9d3d978f92ca94605288fa451323dc8a502a66b78778e6b6a83538a385`；原38项部署guard和新6项guard（含108保护文件逐项变异）离线通过。

继续使用AppID `wx4eac2d4fb11d299b`、体验域名 `staging-api.cisme.cn`；不改正式域名、交易或公开UGC开关，不新增真实会员测试数据。匿名TLS GET已核对体验/正式法律入口正常、公开UGC仍关闭。后台域名/备案没有在此重新宣称完成。

原生官方工具单次上传0.1.27；若出现确认，核对项目、版本与实际覆盖体验版提示后操作，保存同task终态，不重发pending上传。只有真实覆盖提示和终态成功才能记录体验版更新成功，单独developer upload不等同设置体验版。发布后仅追加实际回执，不因归档文档重新上传。
