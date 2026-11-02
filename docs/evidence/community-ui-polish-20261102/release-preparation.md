# 0.1.25 最终交付约束

初始104→104计划已废弃，原文见release-preparation-initial-historical.md。最终唯一新迁移是202611020001_ugc_publish_intent.sql（105）；不运行旧3501 helper或104候选模板。

- 仅lhins-61ikz4mi / 124.223.74.198；可信Ubuntu SSH+固定known_hosts。
- 独立/opt/cisme-trial、cisme_trial及原两个trial units，生产不改。
- 已核实基线6123a594cd673d8c72935e79d380320addcd127f / tree87483c74161100d4bdb37bcdc19d620503da13f9 / schema104。
- 新helper SHA256 cefbe7fc98d4918e649b21db41816e65253207c67708f31f9d221d326a0057ce。
- SQL105 SHA256 8b9fd5aed32f0583161f1be6de867eb59bb1c7b3a6ac33fcea2d30d9104d6eb8；旧104SQL、migrator/package/lock/依赖保持。
- AppID wx4eac2d4fb11d299b；项目/Users/mini/CISME/apps/miniprogram；体验staging-api.cisme.cn、正式api.cisme.cn分离。

顺序：冻结最新照片修正及新包原生证据 → 本地检查/独立review/PR CI → 合并准确main push verify成功 → release-025固定公开cache/git bundle的Node24.14 Linux离线制品 → collect绑定准确main run/job/105SQL/helper/archive → 仅stage → readonly preflight → 停trial writers/drain/认证加密snapshot与实际6123绑定/全旧行及104journal fence → 唯一105up/catalog与不可变revision guard核对 → 原两trial units切换/健康/active105 → 干净当前remote main的官方0.1.25单次upload。

常规工具确认代理核对项目/操作/版本后点允许；保存原task ID，最多6次有界查同任务，不重发上传。保留真实上传终态及体验版覆盖提示，仅开发版本成功不声称已设置体验版。文档归档不重复上传。

不改交易/公开UGC gates，不写真实会员测试内容。停后失败封停保留现场供前向恢复，不自动数据库恢复或旧应用回滚。原生受控fixture、隔离接口、真实账号、真机和全路由范围分别诚实记录。
