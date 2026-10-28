# 精选评论 schema99：独立体验应用升级入口

本入口仅用于已运行的 `45091a1259c2` / schema98 到带精选评论 schema99 的准确新主线。正式环境仍为原 dbd / schema97，不创建正式候选目录。旧 `trial-application-upgrade.py`、`trial-no-schema-upgrade.py` 及其安装记录保持原样。

`trial-editorial-comments-upgrade.py` 默认只读 `preflight`。`apply` 必须显式提供操作编号；`active` 是 schema99 后独立的只读运行守卫。没有 down、整库 restore、造账号、授权、代写同意或内容发布动作。

## 已绑定基线

- 旧 head：`45091a1259c2731eda21db7c367dff28513472bd`，tree：`e367fb91ca0f0442226271e055bb37af8b8b38e7`。
- 旧实际 manifest：`42d5df695132e1cf47668b5193823a900f3a8070ee1a0b3a6d1319833f56a61e`；归档：`2a9c2faad2a7a8c344bf9cb2fac985e19261b59037ff97aeb2182213e6692b04`。
- 已安装旧 helper：`/opt/cisme-trial/xhs-operator-runners/45091a1259c2/trial-no-schema-upgrade.py`，SHA `1209a10685e9d85d1f9104d7f5cff0300bbbe012be61163f31188c650143b0e3`；同目录旧 application-binding SHA `9510fb0828657558859cafe5825122f747239081d24fb5ddc9de98d2df1f3c7a`。
- 根 package、lock 和完整 d9f 依赖树保持不变。旧 98 个 SQL、迁移器、release package/lock 必须逐字一致；唯一新增 SQL 为 `202610280001_editorial_comments.sql`，SHA `cd945b213a0c546d27ff2a1ef6e7d1a90a232ec25d680415d45aa7113c64f3c1`。

新 head/tree、最新成功 main push CI、实际 Linux x64 glibc 归档及本 helper SHA 必须在真实构建后填写，不从 PR head 或历史构建推断。新 runner、binding、compatibility receipt 和 stage 都只能新建；未知既存路径不覆盖。

## Binding 合同

root0700 的新 runner 目录内，helper 与 binding 均为 root0600。绑定 JSON 包含：

```json
{
  "schemaVersion": 1,
  "kind": "trial-editorial-comments-upgrade",
  "baselineHead": "45091a1259c2731eda21db7c367dff28513472bd",
  "baselineTree": "e367fb91ca0f0442226271e055bb37af8b8b38e7",
  "sourceHead": "必须绑定实际新main，不可使用此占位值",
  "sourceTree": "必须绑定实际tree",
  "ciRunId": 0,
  "helperSha256": "实际新helper SHA",
  "manifestSha256": "实际新manifest SHA",
  "archiveSha256": "实际归档SHA",
  "archiveBytes": 0,
  "stageReceipt": "/var/lib/cisme-dependency-stage/新私有stage/stage-receipt.json",
  "stageReceiptSha256": "实际receipt SHA",
  "compatibilityReceipt": "/var/lib/cisme-dependency-stage/同stage/rollback-compatibility.json",
  "compatibilitySha256": "已独审的实际Linux旧包兼容receipt SHA",
  "dependenciesSha256": "d9f03813fc808eced42eacb92db4530a2cd0e0824cab5d1beb9c3bdf08144bdd",
  "migrations": 99,
  "migrationSha256": "cd945b213a0c546d27ff2a1ef6e7d1a90a232ec25d680415d45aa7113c64f3c1"
}
```

此示例故意不可执行。stage receipt 先写入，再由实际 SHA 绑定，避免循环哈希。它必须明确只暂存一个 trial 候选、未修改服务/数据库/配置/生产/旧 peer 文件。compatibility receipt 必须绑定实际旧归档/index/d9f/99 SQL，以及真实 Linux 旧制品在 disposable schema99 的 API 检查；单独一个 `rollbackCompatible=true` 不构成资格。

## 调用与运行状态

仅在 root 审阅精确绑定后，通过现有 strict SSH 和干净环境调用绝对 Python：

```text
sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 /usr/bin/python3 -I -B /新root私有目录/trial-editorial-comments-upgrade.py preflight --binding /新root私有目录/binding.json --binding-sha256 实际SHA
```

`apply` 另需 `--operation-reference`。本说明不执行该命令。新 `active` 或模块 `active_context(validated_binding)` 不调用旧 schema98 active guard，只加载已固定的基础检查原语。

升级持有原 trial 锁，保存私有上下文，停止并排空 trial API/worker，然后生成真实 pg_dump custom 同机快照。独立随机 AES256GCM key、密文、认证/解密摘要及 pg_restore --list 校验都留 root0700/0600 私有状态，AAD 绑定45091和本次操作。它是同机数据库快照，不含媒体、远端副本或完整恢复资格，不把商业 DR/RPO 前移为此依赖。

仅以 `cisme-trial` OS 用户和 `cisme_trial` 数据库角色执行候选迁移器 up。核对精确99 journal、六张表/触发器及所有原20篇文章事实后，只替换原 trial ExecStart 路径，保留 env、密钥、unit/drop-in其它字节、对象目录、nginx/UFW和原始 ownership/initial migration/dependency历史。TLS readiness、进程/原生版本、新worker心跳、法律与关闭能力和精选评论读取检查成功后，发布新的私有 `editorial-comments-active-release.json`；完整私有保护上下文位于 `editorial-comment-upgrades`。

失败只恢复已验证45091应用。99已提交时保留99及新评论事实，回退记录准确标记旧应用、schema99、未还原数据库；不把旧schema98 active记录复制成当前事实。未知 active/unit/drop-in/env/文章/生产漂移保持停机，不自动覆盖。已发布新 active 后，该文件被删除也属于未知漂移。

## 本地验证范围

Python离线测试覆盖101旧输入逐字拒绝、唯一99/source/CI/平台/完整依赖、实际兼容receipt资格、root私有文件/链接、跨数据库拒绝、角色/排空、六类密钥、快照认证/篡改、迁移前后失败、仅应用回退和未知状态停机。Node密码学与管道实际执行；pg_dump/pg_restore管道测试使用显式合成子进程。它们不冒充现网备份或真实微信内容安全、评论与原生验收。
