# 生产前向续跑

`production-release.py` 的默认 `preflight` 只读。`apply` 仍要求准确 main/push CI、目标实例、完整制品、候选与 live env 摘要、SQL 内容审阅、实际保护点和全部写入者围栏。资格 JSON 不是微信申请资料，也不能由测试夹具替代。

`forward-only` 失败后再次停止并确认 API、独立 worker 的 ActiveState=inactive/MainPID=0，才记录 `forward-recovery-required.json`。该文件只证明安装失败后的停止状态，不表示恢复完成。外部消费者须由写入者清单单独排空，API 的维护 503 不足以替代。

对于同一不可变候选的运行环境故障（例如锁持有者或短暂服务依赖故障），完成修复后：

1. 保留失败目录中的 `previous.env`、`preflight.json`、`qualification.json` 和失败回执；不要篡改旧回执。
2. 执行 `preflight --release <原候选目录> --candidate-env <原候选env> --resume-state <失败目录>`。它重新检查真实 main/CI、制品/SQL、目标、当前 env、已完成迁移前缀和服务停止状态；不要求已停止的 API 返回 200。
3. 基于新的只读结果重新审阅资格。绑定新的 live env 摘要和精确剩余 SQL；写入者材料仍须新鲜，保护点与恢复材料仍须实际有效。不得把旧资格机械改成成功。
4. 执行 `resume --release <原候选目录> --candidate-env <原候选env> --resume-state <失败目录> --qualification <新资格文件> --approval-ref <真实审批引用>`。它使用独占锁并生成独立的新执行目录，再次重验后续跑迁移、切换、启动和验证实际 PID/cwd 与本机 HTTPS。
5. 实际业务读回、worker 队列和版本核验仍须完成；`deployed=true` 不代表营业开通。若再次失败，依据最新失败目录继续处理，禁止恢复旧数据库覆盖新事实。

此入口只支持候选字节和配置不变的运行环境修复；换源码、换密钥/配置、main 变化均会拒绝，须重新形成相应修复发布和审阅，不能编辑原失败记录冒充同一候选。旧程序自动回退只适用于已通过同数据兼容验证的独立模式。

回归范围：`test_staging_production_release.py` 验证准确 main/CI、输入绑定、停止确认、失败记录、资格失效与续跑拒绝路径。`test_production_forward_resume_linux.py` 在无网络的临时 Linux 容器内运行真实 API/worker 子进程和磁盘业务事实，覆盖失败→修复→新资格→续跑→业务读取；云身份、GitHub、数据库及审批边界为明确合成夹具，不产生真实生产资格，也不代替 R3 的实际 PostgreSQL 恢复/迁移结果。
