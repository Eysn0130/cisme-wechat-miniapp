# 独立体验日常护理：schema99 → 100 运维候选

本工具只用于 `lhins-61ikz4mi / 124.223.74.198` 的 `cisme-trial` 环境。默认只读；本文件不代表已经部署或验收。

## 固定来源与阶段

- 旧应用精确绑定 `f8dbc55df6c002289005c65969ef68966d206968` / `ec3014e066434b988fef7005344dc539c6e1a2b3`，预检查仅调用已安装且 SHA 固定的 `trial-schema99-application-update.py::active_context`。
- 前99份 SQL、迁移器、package/lock 和 d9f 全依赖树保持逐字节一致。只允许 `202610290001_daily_care_records.sql`，SHA `d27269793c5be0111b53eaa6d655a2e63e04ff486bb044aaa0cdac6b6b468b49`。
- 新来源必须是准确 GitHub main commit/tree、该 main 的成功 push CI、Linux/amd64 Node v24.14.0 glibc 制品及精确 archive/manifest。迁移器自身 verify 必须报告100。
- 新 runner 使用 `/opt/cisme-trial/daily-care-runners/<head12>/`，root0700；helper 与 binding 均 root0600。stage 使用 `/var/lib/cisme-dependency-stage/daily100-<head12>-<8>/`，root0700，不覆写任何历史目录。
- stage 先固定原始 `rollback-compatibility.json`，再生成不可变 stage receipt，最后 binding 引用 receipt SHA，避免循环绑定。stage 不启动服务、不碰数据库或生产。

## 兼容回执

`validate_compatibility_facts(r)` 是无 I/O 的纯校验；`validate_compatibility(b)` 只读取 stage 同目录回执、比对精确 SHA 并调用纯校验。`compatibility(b,old)` 还验证旧 index.js 实际字节。

回执 kind 为 `trial-f8-schema100-compatibility`，须包含精确 f8 head/tree、archive/manifest/index、d9f、100 SQL SHA、最终 inner harness SHA、Node/Linux/x64/glibc，及实际 Linux 制品执行、disposable DB 与6项旧功能验证成功。当前 inner harness 固定 SHA 为 `0bf9830586a5532179da4b52112e344234ba701c2ff2a1ac35a9ad8c5d34aba0`。harness SHA 未冻结时工具拒绝许可；不能用 mock、macOS 执行或手填 passed 替代。

这只证明旧 f8 业务可在100表结构下运行，不证明旧应用支持日常记录的读取、导出或注销。应用回退前，100中的 daily 表必须实际为空；非空、未知或检查失败一律保持体验服务停止，交人工核对，绝不删除新记录迁就回退。

## 运行合同

安装与来源绑定由独立 stager 完成后，使用固定 Node 与 root 环境运行 Python 工具。CLI 仅接受：

```text
python3 -I -B trial-daily-care-upgrade.py preflight --binding <private-binding> --binding-sha256 <exact-sha>
python3 -I -B trial-daily-care-upgrade.py apply --binding <private-binding> --binding-sha256 <exact-sha> --operation-reference <reviewed-reference>
python3 -I -B trial-daily-care-upgrade.py active --binding <private-binding> --binding-sha256 <exact-sha>
```

`apply` 在同一实例锁下创建独占 started 标记；未知结果不能重放。停止两个体验 unit、排空 DB 连接后，新建全库加密 snapshot，AAD 绑定 f8、操作编号和本次 state。真实 AES-GCM认证、完整明文哈希与 `pg_restore --list` 验证后，才能以 `cisme-trial` 执行唯一 `up`。不执行 down、数据库恢复、资料补写、权限授予或协议同意。

成功后使用独立 `/opt/cisme-trial/daily-care-upgrades/active-release.json` 和100 journal/schema检查，不再调用旧99 active guard。旧 active、units、drop-ins、环境、私有输入、生产 PID/制品/97迁移与六类秘密隔离均保持验证。

20篇文章及真实作者/发布者归属在切换时保持精确 fence。评论、点赞、评论策略和举报业务事实在切换期间保持全行哈希；扫描结果和 claims 是 worker 可继续处理的派生数据，不锁其瞬时状态。独立 active 读取不把未来合法评论永久锁成部署前内容。

snapshot 是同机数据库保护点，不含媒体或远端副本，不代表全量灾备恢复已合格。失败仅在所有边界、兼容回执及空 daily 条件都成立时恢复旧应用；其他情况保持停止，不覆盖未知漂移。

## 离线检查

```text
python3 -I -B -W error::ResourceWarning -m unittest discover -s infra/tencent -p test_trial_daily_care_upgrade.py -v
```

测试不访问服务器、真实账号或网络；快照测试使用真实 Node AES-GCM及完整管道，只有 pg_dump/list 输入为合成内容。新 main、实际制品和回执尚未生成前，不能据离线结果声明已部署。
