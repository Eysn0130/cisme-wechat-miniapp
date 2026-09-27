# 独立生产故障探测

此探测器是独立的 systemd timer，不依赖小程序客服、API 进程或 Worker 进程来发送通知。每分钟核对 `cisme-api.service`、`cisme-worker.service`、`postgresql.service`，通过正式 HTTPS `/health/ready` 执行数据库查询，并检查 Worker 成功完成基础循环后的心跳文件是否在 120 秒内更新。连续两次失败才通知，同一故障最多每 30 分钟重复一次；发送失败后至少间隔 5 分钟重试，恢复时发送一次恢复消息。探测器不自动修复服务或修改业务数据。

源码在 `infra/tencent/production-health-monitor.py`，systemd 模板在同目录的 `cisme-production-health.service` 和 `.timer`。正式安装应在核验生产实例、`main` 制品与原数据部署后，由运维将审核过的脚本放入 `/opt/cisme/operations/production-health-monitor.py`，将两个单元文件放入 `/etc/systemd/system/` 并启用 timer。服务使用 `StateDirectory=cisme-monitor` 保存去重状态；`cisme-worker.service` 的 `TMPDIR=/opt/cisme/tmp` 保存心跳，两个文件都不得作为用户数据导出或发布。

唯一必须另行配置的外部接收项是 `/etc/cisme/monitor.env` 中的 `CISME_MONITOR_WEBHOOK_URL`，值须为真实可接收 JSON POST 的 HTTPS 地址。此配置文件不入库，权限仅给运维。未设置时探测仍运行并记录故障，但输出 `externalChannelConfigured=false`、`externalNotificationDelivered=false`，不得宣称告警已送达。配置后须分别模拟 API、数据库和 Worker 故障并核对接收端实际收到告警及恢复消息；本地单元测试只验证机制。网页或小程序内的客服消息不计为独立告警通道。

离线测试：`python3 -m unittest infra/tencent/test_production_health_monitor.py`。正式安装、发真实测试告警和任何生产服务停启须另行记录执行范围与回滚操作。
