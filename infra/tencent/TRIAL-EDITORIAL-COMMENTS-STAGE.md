# 精选评论应用候选暂存

这组工具只准备独立体验环境的候选，不执行数据库迁移、服务切换、协议发布、授权或内容写入。当前正式运行记录与历史操作工具保留。真实微信及原生页面验收另行记录。

## 输入与本地生成

须先有已提交的准确新 main、对应成功 main push CI 和固定 Linux/amd64 builder 的真实构建摘要。不得以 PR CI、未提交工作区或历史归档代替。构建继续使用 Node 24.14、builder `43ffb442…1044`，不挂载工作区或秘密。runtime 依赖树必须保持 `d9f03813…44bdd`，旧 98 个 SQL、迁移器、发布依赖包及锁保持字节一致；仅新增 `202610280001_editorial_comments.sql`（`cd945b21…4f3c1`）。

本地执行（尖括号表示尚未提供的实际值，不能照抄）：

```sh
python3 -I -B infra/tencent/finalize-trial-editorial-comments-stage.py \
  --artifact-summary /absolute/path/to/artifact-summary.json \
  --expected-summary-sha256 <actual-summary-sha256> \
  --ci-run-id <successful-main-push-ci-id> \
  --compatibility-receipt /Users/mini/CISME/tmp/community-refinement-20261028/backend-compat-45091-schema99-attempt2/actual-receipt.json \
  --output-dir /Users/mini/CISME/tmp/<new-unused-directory>
```

输出的父目录须已存在且位于项目 `tmp/` 内；目标必须全新。Finalizer 核对 Git 对象 head/tree、已提交的新升级 helper、完整归档/manifest、全部旧 SQL 和新 99 的 Git 来源、发布包/锁转换以及完整 node_modules 哈希。它只在独立临时目录安全解包并以本机 UID 验证文件，不运行候选代码、不连接服务器。

固定兼容证据为 SHA `2f23b820857ce98fcb916e6848adba796522b9a2c81333c069a50631000137ef`：真实旧 45091 Linux index 和原生依赖，在 owned disposable schema99 数据库上以合成 20 篇文章/26 张图/4 封面/4 个视频条目验证健康、协议读取、媒体与旧赞藏。4 个条目共享一个合成视频二进制。该证据不代表真实会员、原帖素材、真实评论或真机验收。

## 明确执行边界

本地生成 `root-installer-final.py`、`run-stage.py`、`stage-command.json`，均为新目录内 0600 文件。准备阶段不调用 runner。父代理独立审查实际生成文件、归档和主线 CI 后，才可显式执行：

```sh
python3 -I -B /absolute/new-directory/run-stage.py \
  --host ubuntu@124.223.74.198 \
  --identity-file /absolute/path/to/existing-key \
  --known-hosts /absolute/path/to/existing-known-hosts
```

runner 仅允许此固定主机，强制已固定 known host、BatchMode、独立认证路径；不读取或打印私钥。stdin 仅发送已经验证的归档缓冲。helper 和兼容回执嵌入经过哈希绑定的 installer，不与归档 stdin 混装。

## 失败定位与私有证据

新模板绑定升级 helper SHA `7a67c3b3c6d76b1b2f2ff23fc69f34081ad54b5e1e5e94d5f1b8f9ced28dc99b`。三个 helper pin 以及 finalizer 内模板/runner pin 必须一起核对；模板和 runner 不引用 finalizer 自身哈希，不形成循环绑定。它们仍须来自后续准确已提交 main 的实际构建。旧 `2992fce2a726` 的失败 stage、原归档和诊断独立保留，不能按新工具成功收据使用。

暂存脚本按固定阶段返回失败位置，仅接受完整大写码及已知命名空间 `STAGE_`、`COMMENTS_`、`NO_SCHEMA_`、`DEPENDENCY_`、`PRODUCTION_`、`GITHUB_`，另允许两项已有 main CI 稳定码。跨模块 `Refused` 不再因 Python 类不同丢失码。未知异常正文、路径、URL、秘密或非白名单错误仍统一为 `STAGE_REVIEW_REQUIRED`；位置仅包括预定阶段、本暂存脚本函数名和行号，不返回异常栈。

runner 在 SSH 前验证本地输出父目录为当前用户或 root 拥有的 0700 目录。每次 SSH 结束或超时，都先新建 `stage-attempt-<random>/` 0700 子目录，以 `O_EXCL`/no-follow 写入 0600 的 `stdout.bin`、`stderr.bin`、`transport.json`，再解释远端结果。原始输出只在这个私有目录；元数据记录实际退出码、超时、输出长度/哈希、固定来源与归档绑定，不包含认证参数、私钥内容或环境。该传输元数据在解析前不可变保存，不是部署成功凭证。

非零退出也会安全解析有界、无重复键的失败 JSON；公开输出只有允许的错误码、阶段/函数/行号、私有证据目录位置和需核查标记。HTTP 正文、SSH stderr、任意异常正文及额外 JSON 字段不会透传。退出码为零但收据不完整仍拒绝；超时或未知结果不声明服务器未写入，也不重试或自动重放。必须先只读核对实例、原服务及残留，再决定后续新操作，禁止覆盖未知候选和旧证据。

服务器执行前必须 root、固定 IMDS/hostname 映射到 `lhins-61ikz4mi / 124.223.74.198`。通过新 99 helper 的 `load_primitives(True)`，只读认证当前真实 45091/schema98 上下文；不调用旧 0d/6 篇门禁、新 helper 的迁移入口或任何部署 apply。核对当前 20 篇的版本、媒体、作者及发布者归属，保持正式 dbd/schema97、单元、配置、私有输入和六类密钥隔离。当前公开 main/tree/成功 push CI 须与绑定一致。

唯一新增目标：

- `/var/lib/cisme-dependency-stage/<head12>-<random>/` root0700，归档、兼容回执、stage 收据 root0600。
- `/opt/cisme-trial/releases/tencent-release-<head12>/` root0755，代码0644及必要可执行位，完整依赖树不允许外部链接或组/其他用户可写。
- `/opt/cisme-trial/editorial-comment-runners/<head12>/` root0700，仅 `trial-editorial-comments-upgrade.py` 和 `application-binding.json` root0600。

所有候选及 runner 目录必须不存在，未知或失败残留不能覆盖。完整 tar 先作结构验证，再按顺序流式解包逐个核对 header；最后创建合法 contained npm 链接，重验 manifest 和完整依赖。源许可通过新 helper 的 `artifact_contract` 与 `source_permit` 核验；只执行迁移器的只读 `verify`，不执行 `up/down`。

`stage-receipt.json` 先不可变写入；兼容回执以原字节保存为同 stage 下 `rollback-compatibility.json`；最后 binding 引用二者实际路径与 SHA。收据不回填 binding 自身哈希，避免循环绑定。新 helper 会再次验证实际安装路径及绑定。stdout 只返回来源/候选/收据定位等非秘密元数据。

暂存不授予激活权限。后续由 `trial-editorial-comments-upgrade.py` 独立 preflight/apply，先真实加密数据库快照，再唯一 99 迁移和应用切换；失败回退只切回已经验证兼容的旧应用，保持 99 数据，不执行 down 或恢复数据库。此处不实现或重复该切换逻辑。

## 离线验证

```sh
python3 -I -B infra/tencent/test_trial_editorial_comments_stage.py
```

测试自包含合成 tar/归档、假命令适配和临时文件，并覆盖跨模块稳定码、私有消息不导出、非零远端真码、超时局部输出、无覆盖证据和严格 SSH。它们不导入 ignored tmp 历史测试，不连接 SSH、数据库或外部网络，不代替最终新 main 的真实构建、实际暂存和原生验收。
