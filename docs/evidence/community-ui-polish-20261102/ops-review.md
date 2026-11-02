# 体验环境105兼容部署：独立审阅

2026-11-02。审阅绑定helper SHA-256 `cefbe7fc98d4918e649b21db41816e65253207c67708f31f9d221d326a0057ce`，范围为独立104→105更新工具的ugc_guards、journal、快照绑定、切换和active恢复校验。未修改helper/test，未执行SSH、真实快照、迁移或服务切换。原3501/34项/schema104审阅已按原字节归档为[历史审阅](ops-review-schema104-historical.md)，不改标为105证据。

**结论：未发现确定性部署安全缺陷。** 此结论来自源码审阅、38项独立离线回归及一次性PostgreSQL目录查询实测；不代表服务器候选部署通过。

| 检查 | 结论与证据范围 |
|---|---|
| 精确基线和来源 | 固定已验证6123 head/tree/manifest及原closure helper/binding SHA。新binding仅允许105 SQL `8b9fd5aed32f0583161f1be6de867eb59bb1c7b3a6ac33fcea2d30d9104d6eb8`，原104 SQL、migrator/package/lock、完整dependency摘要保持。preflight真实核当前main及指定push/verify来源；切后active只加载原语，不要求旧6123运行路径或未来main保持不变。 |
| ugc_guards查询 | 从cef源码AST提取实际函数构造的SQL，在独立PostgreSQL18.4上真实执行。`pg_proc`属性、`tgattr::smallint[]`、WITH ORDINALITY、触发列顺序和function/trigger digest查询均可执行，未用手写近似SQL替代。104/105两种实际迁移状态均交回同一原函数校验通过，查询SHA `9c032a9582d0268928187e768aa13f8987d9d388fb000ddd91c4980e9252431d`。 |
| 两代UGC契约 | 104 post prosrc为`21aea3c71b6c2053fb22a9d0cb723d9190e346ee1920b9c6bfeda186e18f7669`；105为`2b12016e0aa44aed7322d2922b2319e64964eac88980b1a83825239cec433256`。revision immutable prosrc始终`6725e8839be8893b2c6d399e37479e790041221cfde058af9f85297fbb6d6dd8`。同一before/after结果确认revision完整定义、两trigger完整定义和列序均不变。 |
| schema105下保留104 | 新journal只向C.database_guard传明确允许的104或105有序journal；不再调用旧K.journal中`len(value)==104`的判断。`K.schema104(profile,True)`的True是“已有104协作列/约束/受控trigger/索引必须存在”，不是“journal只能104条”，所以105继续True正确。101、103原契约也继续检查。 |
| 停写与迁移事实 | 停止两trial unit后确认drain，先保存全部public表整行count/hash和所有104 journal时间事实；只排除本次授权的105新journal行。加密快照认证完成后才执行已钉住migrator up，先核105+原事实相同，再切应用、再启动。没有忽略旧协作字段或删业务列来让比较通过。 |
| 快照与来源 | 复用原固定a4afe72的snapshot/validate_snapshot，限定cisme_trial本机角色/数据库、root私有密文和key、AES-GCM验证及pg_restore --list。原语AAD历史baseline标签如实保留，另存actual6123/tree/manifest/schema104与candidate、operation、snapshot receipt hash绑定，并进入受保护plan/active。active再次认证密文、key、receipt与实际来源绑定。此处只审阅代码和离线契约，没有在本轮生成快照，不声称可恢复演练通过。 |
| 隔离与失败 | profile固定正式机上的独立trial目录/角色/数据库及两个trial unit；保留生产有效单元/入口/配置/PID、原env和全部私有链。停前错误不停止旧服务；开始停写后的错误尝试封停并保留前向核对现场，无自动旧应用rollback、down或整库restore。公开UGC/真实交易配置闭合不变。 |

实际验证：

- `python3 -I -B infra/tencent/test_trial_community_compose_update.py`：本次独立执行38项通过，原始结果[ops-offline-schema105.log](ops-offline-schema105.log)。
- 一次`node scripts/disposable-test.mjs npx tsx tmp/community-ui-polish-20261102/ops-catalog-smoke.ts`：先跑privacy-schema-inventory的1项集成检查，再在同一owned DB实际回退/应用105验证104/105目录结果与cef原函数；日志[privacy-and-ops-catalog-smoke.log](privacy-and-ops-catalog-smoke.log)，结果[ops-catalog-smoke.json](ops-catalog-smoke.json)。runId `428fc903d1f6e58e3454fdea`，数据库和对象实例均已按精确归属销毁。
- query smoke在一次性容器内明确创建了合成`cisme_trial`角色来模拟函数owner；这是测试fixture，不是对真实主机owner的额外证明。真实owner/trigger来源由主线程可信只读catalog回执独立确定。
- `npx vitest run tests/unit/privacy-inventory-gate.test.ts`：1文件4项通过；subject-data-map只更新filename+SQL迁移摘要，未改变保留期限、接收方、导出字段或删除策略。此算法与小程序清单的带路径摘要不同，未直接互抄。

局限：此次没有运行远端preflight/apply/active、pg_dump加密、真实恢复或完整业务验收。目录smoke证明SQL语法与所测PG版本的目录语义，离线测试证明受控分支，不证明线上私有输入/运行进程正确。性能阈值维持原1000ms，当前本地性能结果由主线程单独记录，本审阅不标记性能通过，也不将未完成的40路由/手机证据写成通过。
