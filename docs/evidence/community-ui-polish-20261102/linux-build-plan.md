# 社区 UI 精修：Linux 候选构建计划

2026-11-02。本文件只记录只读调查和待执行命令；本轮没有执行构建、创建提交/分支、访问远端、部署或上传。候选 SHA 尚未冻结。调查时本地基线是 `18c673ecc9e8df1a4a278701b293a23397593ce0` / tree `0287f8d3021cc036b75e12f1e1c5b18a8c80d750`，不能把这个基线填成精修候选。

## 已有实现与本机可用材料

- delivery019 原构建器：`tmp/support-loop-acceptance-20261101/release-019/build-release.py`，SHA-256 `4ac3cd2cd64f732772d84dfdc6b11c0284b9223d8a19a52e56bc727870afb8d5`。
- delivery019 最终运输对应版本：`tmp/support-loop-acceptance-20261101/release-019-transport/build-release.py`，SHA-256 `759dace913b7176440d12b1827f2b230db236d6a11cf18604ac7067077bbc531`。同目录 `build.json` / `artifact-summary.json` 绑定 `6123a594cd673d8c72935e79d380320addcd127f` / tree `87483c74161100d4bdb37bcdc19d620503da13f9`。它的旧归档 SHA-256 为 `00c6c6e88750c29ac360bef8b9bdd93b98f1f490eb38958418e161bc9049c219`，不是本轮候选产物。
- 标准打包器：`scripts/package-tencent-release.mjs`，SHA-256 `1aefcb36fd7e66afb5765214d3b7abba70c19994300ad4db63e866c01954189c`。它强制 Linux x64 glibc、干净已提交源码，归档内写入 commit/tree/原始 lock 摘要和逐文件摘要；包内 `sharp` 会实际加载。其内部生产依赖安装继承 `npm_config_offline=true`。
- 已检查本机镜像 `sha256:43ffb442676c100df1e90d50b1d582c5af0b9dca1bdf7cbc9065dad0c5521044`：`linux/amd64`、无声明 volume。标签 `cisme-m-build:node24-git` 仅供识别；执行必须使用完整 ID。原构建器在容器内断言 Node `v24.14.0`。
- 仍保留的 delivery019 最终容器 `f6e4078a16f3556fcb24e26e50cd8d6c692b00725f34b3850d1eb9896aa5e7d4` 的只读检查结果：使用上面的镜像、`network=none`、`Mounts=[]`、非 privileged，已退出且 code 0 / OOM false。本轮未启动它。

| 输入 | 已重算的 SHA-256 |
|---|---|
| `tmp/launch-20261026/public-npm-cache-87588175-17fded74/public-npm-cacache.tar`（94,668,800 字节） | `8b8edff3b2de63e4986ca33a5d800c274dbf7758278ee30fb9acf8ab50848a63` |
| 同目录 `cache-source-receipt.json` | `83a569d073e552bf6c037406956756533b22784c450efd5bb0d0e8519ddb1d6d` |
| 同目录 `cache-integrity-readback.json` | `835d9e37ab610f84c5559f603800816a15e39ba8b6c0caf55deca479627be0f7` |
| 提交内 `package.json` | `c70b97f3ec0e6c339c5c27b0e9067549f9256287cfbfdf32f39ae46fcf54e231` |
| 提交内 `package-lock.json` | `2a14af4f1bfdd86d0108015b43df14d62b2cc6e8eedcd3831446970a26d7d32a` |
| 严格 tar 读取/依赖摘要工具 `infra/tencent/trial-editorial-comments-stage.py` | `99a2c97bb429c56149c615396810899a5e13bc5c5d2500040aec33e69327e0f5` |

当前 package、lock、打包器与 delivery019 `6123` 提交逐字节一致。相同锁文件的历史离线安装成功，不等于本轮安装已执行；候选冻结后仍须通过真实离线安装。若这些固定输入改变，先审阅变化，不能把缺包错误改成联网重试。

旧脚本锁定旧 helper、baseline、104 个迁移、依赖摘要、旧输出目录，并以独占创建保护旧产物。**不要直接在旧目录对新候选运行，也不要只替换旧 SHA 来绕过检查。** 新 helper 提交并通过 CI 后，应以原脚本为模板创建独立的本轮构建目录，重新固定 helper 的提交内路径和摘要，保留原 `start / status / collect` 分离及所有检查。当前基线有 104 个 SQL 迁移，最终以候选提交与已审核基线逐文件比较为准。

## 最小离线重放命令

以下是供根代理在最终候选 commit/tree 冻结后执行的构建核心。这里没有运行。新目录位于系统临时目录，容器只接收已提交 Git bundle 和已经固定的公开 npm 缓存；不挂载源码工作目录、Git 配置、宿主 npm 配置、凭据或 Docker socket。Git bundle 保留原 commit/tree，所以标准打包器能核验真实 Git 身份；单纯 `git archive` 后重新 `git init` 不能伪称原 commit。

```bash
set -eu
cisme_repo=/Users/mini/CISME
cisme_head=REPLACE_WITH_REVIEWED_40_HEX_COMMIT
cisme_tree=REPLACE_WITH_REVIEWED_40_HEX_TREE
cisme_image=sha256:43ffb442676c100df1e90d50b1d582c5af0b9dca1bdf7cbc9065dad0c5521044
cisme_cache="$cisme_repo/tmp/launch-20261026/public-npm-cache-87588175-17fded74/public-npm-cacache.tar"
export cisme_repo cisme_head cisme_tree cisme_image cisme_cache

python3 -I -B - <<'PY'
import hashlib,json,os,re,subprocess
from pathlib import Path
r=Path(os.environ['cisme_repo']); h=os.environ['cisme_head']; t=os.environ['cisme_tree']
assert re.fullmatch('[0-9a-f]{40}',h) and re.fullmatch('[0-9a-f]{40}',t)
git=lambda *a:subprocess.check_output(['git',*a],cwd=r)
assert git('rev-parse','HEAD').decode().strip()==h
assert git('rev-parse','HEAD^{tree}').decode().strip()==t
assert not git('status','--porcelain').strip()
pins={'package.json':'c70b97f3ec0e6c339c5c27b0e9067549f9256287cfbfdf32f39ae46fcf54e231',
      'package-lock.json':'2a14af4f1bfdd86d0108015b43df14d62b2cc6e8eedcd3831446970a26d7d32a',
      'scripts/package-tencent-release.mjs':'1aefcb36fd7e66afb5765214d3b7abba70c19994300ad4db63e866c01954189c'}
for path,digest in pins.items(): assert hashlib.sha256(git('show',h+':'+path)).hexdigest()==digest
cache=Path(os.environ['cisme_cache'])
for path,digest in [(cache,'8b8edff3b2de63e4986ca33a5d800c274dbf7758278ee30fb9acf8ab50848a63'),
 (cache.with_name('cache-source-receipt.json'),'83a569d073e552bf6c037406956756533b22784c450efd5bb0d0e8519ddb1d6d'),
 (cache.with_name('cache-integrity-readback.json'),'835d9e37ab610f84c5559f603800816a15e39ba8b6c0caf55deca479627be0f7')]:
 with path.open('rb') as stream: assert hashlib.file_digest(stream,'sha256').hexdigest()==digest
assert cache.stat().st_size==94668800
image=json.loads(subprocess.check_output(['docker','image','inspect',os.environ['cisme_image']]))[0]
assert image['Id']==os.environ['cisme_image'] and image['Os']=='linux' and image['Architecture']=='amd64'
assert not image['Config'].get('Volumes')
assert {v.split('=',1)[0] for v in image['Config'].get('Env',[])} <= {'PATH','NODE_VERSION','YARN_VERSION','GIT_TERMINAL_PROMPT'}
PY

cisme_out=$(mktemp -d /private/tmp/cisme-community-ui-linux.XXXXXXXX)
chmod 700 "$cisme_out"
git -C "$cisme_repo" bundle create "$cisme_out/source.bundle" HEAD
git -C "$cisme_repo" bundle verify "$cisme_out/source.bundle"
test "$(git -C "$cisme_repo" bundle list-heads "$cisme_out/source.bundle")" = "$cisme_head HEAD"
test "$(git -C "$cisme_repo" rev-parse HEAD)" = "$cisme_head"
cisme_bundle_sha=$(shasum -a 256 "$cisme_out/source.bundle" | cut -d ' ' -f 1)
cisme_container=$(docker create --pull=never --platform linux/amd64 --network none \
  --label cisme.purpose=community-ui-polish-offline-build \
  "$cisme_image" /bin/sh -c '
set -eu
export GIT_TERMINAL_PROMPT=0
export npm_config_offline=true npm_config_cache=/root/.npm npm_config_audit=false npm_config_fund=false
export npm_config_fetch_retries=0 npm_config_fetch_timeout=1000
printf "%s  %s\n" "$3" /tmp/source.bundle | sha256sum --check --status
printf "%s  %s\n" 8b8edff3b2de63e4986ca33a5d800c274dbf7758278ee30fb9acf8ab50848a63 /tmp/public-cacache.tar | sha256sum --check --status
mkdir -p /root/.npm /tmp/cisme-source
tar -xf /tmp/public-cacache.tar -C /root/.npm --no-same-owner --no-same-permissions
cd /tmp/cisme-source
git init -q
git fetch --no-tags --no-write-fetch-head /tmp/source.bundle HEAD:refs/heads/reviewed-source
git -c advice.detachedHead=false checkout --detach "$1"
test "$(git rev-parse HEAD)" = "$1"
test "$(git rev-parse HEAD^{tree})" = "$2"
git fsck --full --strict
test "$(node --version)" = v24.14.0
timeout --kill-after=10s 300 npm ci --offline --cache=/root/.npm --no-audit --no-fund
timeout --kill-after=10s 300 node scripts/package-tencent-release.mjs
' cisme-offline "$cisme_head" "$cisme_tree" "$cisme_bundle_sha")
export cisme_out cisme_bundle_sha cisme_container

python3 -I -B - <<'PY'
import json,os,subprocess
from pathlib import Path
x=json.loads(subprocess.check_output(['docker','inspect',os.environ['cisme_container']]))[0]
assert x['Image']==os.environ['cisme_image'] and not x['Mounts'] and not x['HostConfig'].get('Binds')
assert not x['HostConfig']['Privileged'] and x['HostConfig']['NetworkMode']=='none'
Path(os.environ['cisme_out'],'build-input.json').write_text(json.dumps({
 'sourceHead':os.environ['cisme_head'],'sourceTree':os.environ['cisme_tree'],
 'sourceBundleSha256':os.environ['cisme_bundle_sha'],'builderImage':x['Image'],'containerId':x['Id'],
 'npmCacheSha256':'8b8edff3b2de63e4986ca33a5d800c274dbf7758278ee30fb9acf8ab50848a63',
 'network':'none','hostMounts':[],'serverMutations':False,'deployed':False},sort_keys=True,indent=2)+'\n')
PY
docker cp "$cisme_out/source.bundle" "$cisme_container:/tmp/source.bundle"
docker cp "$cisme_cache" "$cisme_container:/tmp/public-cacache.tar"
docker start "$cisme_container"
```

不要用长时间阻塞等待。单独查询 `docker inspect "$cisme_container" --format '{{json .State}}'`，退出后保留其 `Status=exited`、`ExitCode=0`、`OOMKilled=false` 事实；随后收集 `docker logs`、`/tmp/cisme-source/dist/tencent-release-<head前12位>.tar.gz` 及其对应目录内的 `release-manifest.json`，写到唯一的 `cisme_out`，禁止覆盖历史候选。Docker 状态不成功时不进入收集通过状态。不要仅因为旧容器仍在就复用它的文件。

## 收集与绑定要求

沿用原构建器 `collect()` 的严格 tar 读取方式；不能以只读 manifest 的几个字段代替验证归档。新收集器应完成：

1. 再核对输入 commit/tree、容器完整 ID/固定 image ID、无挂载、网络 none、成功退出及本轮 source bundle 摘要；保存构建日志和输入记录。对最终部署 helper 的提交内路径、字节摘要另行固定，不能使用旧 helper 摘要。
2. 对复制回来的完整归档计算 SHA-256 和字节数，对**归档内实际 manifest 字节**计算 SHA-256。顶层必须恰为 `tencent-release-<候选前12位>`，不能有绝对路径、重复成员、越界链接、AppleDouble、配置/凭据或多余顶层。
3. 固定上述 SHA 后使用 `infra/tencent/trial-editorial-comments-stage.py` 的 `unpack` / `dependency_digest`，`OWNER=os.getuid()`、`TOP` 为本轮候选，置于新的私有临时目录验证；该工具本身须先符合表中 SHA，不执行其中任何 stage/deploy 入口。
4. manifest 的 `sourceHead/sourceTree` 必须等于候选、`sourceLockSha256` 必须等于该提交的原 lock；`node=v24.14.0`、`buildPlatform={os:linux,arch:x64,libc:glibc}`；`configurationIncluded/deployed/releaseReady` 必须均为 false。
5. manifest `hashes` 的键必须精确覆盖 `index.js, worker.js, worker-once.js, package.json, package-lock.json, migrate.mjs` 和全部已审核 SQL 文件，并逐项验证归档解出字节。迁移集合必须与候选 `git ls-tree` 的有序 SQL 集合完全相等；迁移字节与候选 `git show` 一致，且与审核基线保持本轮允许的差异。`migrate.mjs` 与候选 `scripts/release-migrate.mjs` 相等。
6. 若依赖输入未变，完整 `node_modules` 摘要应仍为 `d9f03813fc808eced42eacb92db4530a2cd0e0824cab5d1beb9c3bdf08144bdd`，fastify `5.12.6`、sharp `0.35.5`；失败应审阅，不能改预期值来消除报错。standard manifest **不包含 node_modules 全树摘要**，这项必须独立记录。
7. 新的本轮产物摘要至少记录 `sourceHead/sourceTree/sourceBundleSha256/sourceLockSha256/builderImage/containerId/npmCacheSha256/manifestSha256/archiveSha256/archiveBytes/dependenciesSha256/packagerSha256/helperPath/helperSha256`，并保留 `network:none/hostMounts:[]/deployed:false/activationAllowedByBuild:false`。摘要自身和应用 binding 各自计算 SHA，后续 transfer/stage 只接受这些精确值，不按文件名或最新时间推断。

这是固定输入与来源可重放流程，不承诺跨次生成的 tar.gz 逐字节相同：标准打包器写入 `generatedAt`，归档也带文件时间。每次产物需绑定本次实际摘要。构建成功不授予服务激活、公开 UGC 或小程序体验版上传权限。

## GitHub CI 产物可用范围

调查时 `.github/workflows/ci.yml` 使用 Node `24.18.0`；`npm run build` 生成普通 API/worker/admin 构建，其 `actions/upload-artifact` 只上传 `cisme-r0-evidence`（日志、SBOM、license、native-validation），**未执行或上传 `package-tencent-release.mjs` 的腾讯运行归档**。因此当前官方 CI artifact 可以证明对应源码的 CI 检查结果，不能直接当 Node24.14 Linux 正式候选，不能凭 CI 绿灯复用本机旧 tar。

若根代理后续明确新增官方归档产物，则至少绑定仓库 `Eysn0130/cisme-wechat-miniapp`、workflow/run/job ID、事件、`head_sha`、实际 checkout SHA/tree、artifact ID/digest、下载 zip 摘要及内层 manifest/archive 摘要，并检查与冻结候选完全一致。PR 的 synthetic merge checkout 与 PR head 必须分清。Node 或打包器与部署 helper 的已审核条件不一致时，仍须重新审核，不能从 24.18 的 CI 日志推断 24.14 运行包通过。此轮只读调查未下载或访问任何远端产物。
