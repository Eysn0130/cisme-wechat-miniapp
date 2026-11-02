# 体验环境兼容部署：独立只读审阅

2026-11-02。范围仅为 `infra/tencent/trial-community-compose-update.py`、`test_trial_community_compose_update.py` 和 `.github/workflows/ci.yml` 新增的一行离线测试命令。对照已部署 6123/schema104 的旧 closure helper。未执行远端操作，未修改部署 helper、测试或 CI。

**Findings：未发现确定性发布安全缺陷。** 本结论是源码与离线契约审阅，不是服务器部署或社区功能验收。

| 检查 | 已核对事实 |
| --- | --- |
| 目标与基线 | IMDS 与实例身份双重限定正式腾讯云实例；固定 `/opt/cisme-trial`、`cisme_trial` 与两个 trial unit。读取且校验旧 helper、binding SHA 和精确 6123 head/tree/manifest；preflight 调用旧 `active_context` 验证原链。 |
| preflight | 默认只读；没有停服务、建状态目录、迁移、数据库还原或配置覆盖。检查旧/新制品、原私有输入、历史记录、生产配置隔离与原生依赖。候选仅执行已钉住 migrator 的 `verify` 与依赖 smoke。 |
| 来源与 CI | 新 binding 绑定 helper、archive、manifest、source head/tree、CI run/job ID。要求当前 main 的同一仓库 push、最新匹配 run 已完成且精确 `verify` job 成功；完整 Git tree 绑定 helper、migrator、104 SQL。该策略没有把其他视觉 job 的结果伪称产品通过。 |
| schema104 | 新旧 104 个 SQL、migrator、package、lock 与完整依赖树保持精确字节/hash；不调用 up/down。停写后对全部 public 表的完整行及迁移日志做 count/hash fence，切换后、启动前再次比较；不忽略 schema104 协作字段。 |
| 正式环境与私有链 | 沿用固定 profile、数据库/会话/加密密钥隔离、原 env 和私有文件字节校验。切换阶段保持正式服务原有效 unit、入口、配置与 PIDs；无正式服务 stop/switch。继承全部原私有输入和历史 active 记录，并新增本层钉住 guard。 |
| apply 与失败 | 共用独占部署锁、单次 started 标记；停服务前重新核对来源/CI。只停、切、启两个 trial unit。停写后任一失败尝试封停，写明停机是否确认与前向人工核对要求；不回滚旧应用、不还原数据库、不覆盖未知输入。停服务前失败不停止原服务。 |
| active | 切后不再调用要求旧 unit 路径的旧 active guard，只加载 SHA 固定原语；校验新 active/private-plan/fence receipt、候选 unit 与运行状态。后续只读审计允许正式服务合法重启，但仍保持其配置与有效入口事实。 |
| 业务探针 | 公共契约复用 GET article 200 / guest comments 401；不创建账号、会话、消息、权限或 UGC 测试内容，不修改公开 UGC 开关。 |

离线验证：独立执行 `python3 -I -B infra/tencent/test_trial_community_compose_update.py`，**34 项通过（0.193 秒）**。测试覆盖来源拒绝、只读 preflight、104 全事实 fence、完整私有链、两 unit 切换、停前/停后失败以及错误不外输私有信息。

审阅绑定 SHA-256：

- helper：`3501b22efcee99b239037f3382bdff4dda65ff56b432c178d35c8501f79f23c9`
- tests：`627369631b528d98d82a786f846030af01d1f541905214a9aab77596cee2f950`
- CI 文件：`d5261a76c363a184ede56bfe42588d5112832234f3c7a265231a961431312b7c`
- 旧 closure helper：`0ec259652485bb620c0f683e8dff34666e6d6a86cef6c62e872015effd7a9053`，与新 helper 的固定值一致。

局限：本轮没有读取真实服务器私有 binding、env、数据库或 systemd，也没有请求 GitHub 线上 CI/main；这些事实由部署时 preflight/apply 的精确检查确定。没有验证候选应用已经上线或旧 API 的 AI 字段兼容问题已在线解决。停后 fence 证明停写切换阶段事实保持，不承诺启动后合法业务写入永远不发生；失败恢复是保留现场后前向核对，并非自动恢复服务。
