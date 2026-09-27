# 已执行核验器的源记录

这些是本轮核验源码的归档，不是可盲目重跑的生产安装脚本。原本机执行/编译路径为 `/Users/mini/CISME/tmp/production-r5/`；TypeScript 相对导入按该原路径解析。归档文件不得直接从当前目录编译。构建使用仓库 tsup、Node24、ESM、`noExternal: [/^@cisme\//]`；实际服务器一次性进程通过原systemd运行身份和sandbox执行。

- `material-runtime-check.ts`：不联网、不访问数据库，真实材料装载与13项有限能力检查。最终f627重建产物与初次上传产物SHA256相同，见主报告。不是主API/worker替换。
- `payment-readonly-check.ts`：CLI `--single-synthetic-order-query`，单次随机未建订单查询，只允许官方支付域名的固定GET路径，资金写入0。已取得实际签名404，无需重复此渠道请求。
- `shipping-readiness.ts`：CLI `--read-only-app-status`，使用现有AppID/AppSecret，固定两项账户状态查询。v2输出已观察到48001；没有发送订单或物流消息。
- `export-production-status.py`：调用原安装器的真实私有输入检查及只读DB计数，导出明确筛选的公开字段。初次因父目录属主失败，未生成成功回执。
- `relocate-private-inputs.py`：一次性的本轮目录修正，原材料移至 `/etc/cisme-wechat-pay`，生成v2 env/私有保护副本、重验身份；随后修正上一导出脚本的env路径并执行成功。含目标不存在/输出独占创建保护，不能作为通用重复部署或回滚工具。

服务器部署检查器源码从最终API受测相同的 `production-release.py`、`production-observation.py`、`production-security-audit.py`、`production-migration-audit.py`、`production-target.py` 复制到 `/opt/cisme/prepared/r5-status-tools`。主报告的 `production-status.json` 是经原文件管理器下载的实际脱敏回执，不含私有材料或其摘要。下载事件工具曾超时，但页面显示传输成功，已从实际 `/Users/mini/Downloads/r5-public-production-status.json` 读取验证，未因事件超时重发查询。
