# 社区创作界面精修：体验版发布准备

后续K.11更新：用户在本准备快照后明确删除权利／公开开关，schema104因不可变字段和旧rights硬门槛无法诚实承载新规则。本轮已新增105 `202611020001_ugc_publish_intent.sql`及成功提交追加不可变公开意图快照，见`publish-intent-validation.json`、`publish-intent-schema-contract.json`。下文3501版104→104 helper及对应旧准备说明保留其原时间范围，不能用于本次最终部署；主线程正在独立审查104→105的新guard、pins及构建/暂存材料。0.1.25版本建议和官方上传参数不变，本文件不声称已部署或上传。

记录日期：2026-11-02。本记录是发布准备与已完成的只读核对，不是上传或部署成功回执。本子任务未SSH、未读取密钥、未操作远端数据、未上传；仅新增独立体验更新helper、安全测试和本说明，CI仅追加一条测试调用。用户已授权完善现有功能闭环并上传新体验版；不另设聊天审批，不开启真实交易或普通公开UGC。

## 版本、项目与环境

- 项目：`/Users/mini/CISME/apps/miniprogram`；AppID `wx4eac2d4fb11d299b`；`miniprogramRoot=./`；基础库3.15.2；`urlCheck=true`；`app.json`隐私检查开启。
- 最近连续成功官方上传为0.1.22、0.1.23、0.1.24，原回执分别在`editorial-brand-package-20261101/delivery-022`、`post-bar-20261101/delivery-023`、`composer-dismiss-20261101/delivery-024`。0.1.24任务`confirmation_upload_eacf67e0-7b9d-4f4f-860b-9ff383209837`已有终态success，不得重放。
- 未检出0.1.25及以上本地成功回执，建议新版本0.1.25；执行前仍核对平台当前版本与本轮旧pending任务，避免并发操作导致版本判断过时。
- `release-config.ts`：devtools/preview/trial均指`https://staging-api.cisme.cn`，release指`https://api.cisme.cn`；`miniProgramCloudFunctions={}`，不走CloudBase转发或临时隧道。
- 唯一正式主机`lhins-61ikz4mi / 124.223.74.198`。体验环境是同机独立`/opt/cisme-trial`、OS用户`cisme-trial`、数据库/role `cisme_trial`、独立媒体目录与runtime.env/私有配置；生产环境为`/opt/cisme`、`cisme`、`api.cisme.cn`，不操作。旧`150.158.39.74`不使用。
- 当前体验是systemd `cisme-trial-api.service`和`cisme-trial-worker.service`，不是Docker Compose。容器只用于无秘密的本地Linux构建和一次性测试。

## 只读在线基线及兼容性

正常TLS证书校验的匿名GET（无Cookie/Authorization）结果：

| UTC时间 | Origin / 路径 | HTTP及非敏感结果 |
|---|---|---|
| 2026-11-02T09:39:44.549478Z | staging-api.cisme.cn `/v1/ugc/status` | 200 JSON：`publicEnabled=false,draftsEnabled=true` |
| 2026-11-02T09:39:44.698416Z | api.cisme.cn `/v1/ugc/status` | 200 JSON：`publicEnabled=false,draftsEnabled=true` |

这些结果只说明当次公开状态接口的返回，不能证明当前API来源、上传开关、微信合法域名/隐私指引、身份、私稿保存或所有媒体链路兼容。微信后台域名、体验成员与平台资格需主线程按现有授权现场核对；不将旧截图改标为当前证据。

主线程随后通过既有固定SSH连接运行019原active守卫，返回6123 source、104迁移、activeVerified/readOnly为true、privateValuesExported为false，见本目录`trial-active-before.json`。该新回执确认了先前delivery019部署记录仍是当前基线：

- head `6123a594cd673d8c72935e79d380320addcd127f`
- tree `87483c74161100d4bdb37bcdc19d620503da13f9`
- manifest SHA256 `0c4b707fd7b884678e4741799eeacf0a73cc6ef0914d8316e008660e7b7f88b5`
- release `/opt/cisme-trial/releases/tencent-release-6123a594cd67`

该旧API的`formalUgc.ts:68–73`强制`input.aiUsage`为四种值之一，缺省直接422 `UGC_AI_DECLARATION_INVALID`；当前新客户端按K.9不再提交这个字段。因此先上传客户端会让私稿保存失败。旧`myPosts`不接收状态筛选，且approved修订没有awaiting_publication投影，当前筛选和状态UI也不能靠旧API完整工作。

当前后端修复使AI字段可缺省：保留历史值，新稿未知，不伪造“纯人工”或主动选择；同一批已验证实现还包括真实状态筛选/游标/总数、修订状态、所有权/有效账号与审核末端门禁。图片/文字制卡仍复用JPEG/PNG/WebP新素材授权→上传→complete，不新增媒体类型。27项隔离接口证据位于`../community-compose-minimal-20261101/integration-validation.json`，不是线上验收；最终候选仍须绑定准确源码与CI。

## 官方上传路径与已有授权

已读本机入口`/Users/mini/.codex/skills/wechatide-skill/SKILL.md`、已安装App官方原Skill0.3.14、previewer/async/approval/environment-readiness，以及miniprogram skill引用的change-safety/deployment-gate。前者本机用户覆盖已明确：CISME已授权编译、预览、体验上传的Allow窗口由代理核对后确认；pending最多6次、约5秒查询同一task，不因等候重发。本人扫码或真实系统凭据仍按实际要求处理。

官方来源位于：

- `/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/wechatide-skill/skills/previewer/SKILL.md`
- 同包`wechatide-tools/references/tools.yaml`的upload登记，以及`references/async-task-polling.md`
- 本次只读`wechatide -c Codex upload --help`与`polling_task_result --help`实际返回同样参数。

主线程在当前会话未检查时，先执行（只做状态检查，不主动重开项目）：

```sh
wechatide -c Codex check_wechatide_status --skill-version 0.3.14
```

需versionRelation equal/agent_ahead、loginExpired=false；仅实际返回CLI token required才用既有私有token，不翻工具目录或打印token。随后在全部源码/兼容准备就绪时只调用一次：

```sh
wechatide -c Codex upload --project /Users/mini/CISME/apps/miniprogram --upload-version 0.1.25 --desc '精修社区创作按钮与文案，完善既有图片文字私稿闭环'
wechatide -c Codex polling_task_result --task-id <同一次返回的taskId>
```

第二条仅在真实pending后按上述覆盖有界查询。保留原请求参数、taskId、确认后终态、包字节数和冻结源码hash；pending/超时不等于失败，不自动重发。官方包装是`--upload-version`；原App CLI则为`upload --version`，两套参数不能混用。

工具登记将upload称为“发布体验版”；019真实原生确认曾明确“上次上传已选体验版，本次覆盖当前体验版”。但仓库`wechat-release.ts:142`只把源码上传标为`developer_version_only`，且没有单独注册的“设为体验版”CLI。本轮须读实际确认及平台结果：若提示覆盖现体验版，应作为本次已授权体验更新核对；若只增加开发版本，应在微信后台确认选为体验版本并核对版本/体验成员。不能用upload success单独声称后台体验指派已完成，也不编造set-trial参数。

`miniprogram-ci`是另一工具链；其上传IP白名单/私钥前置不强行套到已授权官方登录工具链。本轮不引入新私钥或CI上传工具。

## 上传前现有门禁

`wechat-release.ts`/`wechat-release-lib.ts`现有规则须保留：正确AppID、隐私检查、trial/release公共HTTPS、设计证据结构及当前包hash、工作树干净、HEAD等于当前远端main。界面本轮精修会改变包hash，旧三入口截图及2922单元测试记录保持其原指纹，不能自动充作精修后全状态证据。

源码上传与trial/release门禁分开。trial还核隐私指引、法律文本、合法域名、已授权体验范围、体验名单、真实微信身份、独立测试目标与真实支付/公开UGC关闭证明；env flag只记录已证事实，不能随意设true让脚本通过。正式release另需备案/产品适用门禁，当前不执行正式发布。PRD§15.6允许先进入受控体验，再在体验中补iOS/Android/弱网等候选证据；既有full40矩阵缺口继续如实保留，不新设“必须先全真机验完才允许受控体验”的审批。

## 独立104→104体验更新工具

新增`infra/tencent/trial-community-compose-update.py`，不修改旧helper/binding。默认preflight只读，另有apply/active。它先从下面精确旧guard认证6123基线，再复用其已审核低层artifact、unit、config、生产隔离、六类密钥及历史原语；不调用旧preflight/apply，也不运行迁移、restore、业务种子或授权。

| 项目 | 固定契约 |
|---|---|
| 旧guard | `/opt/cisme-trial/support-closure-runners/6123a594cd67/trial-support-closure-update.py` |
| 旧helper SHA256 | `0ec259652485bb620c0f683e8dff34666e6d6a86cef6c62e872015effd7a9053` |
| 旧binding SHA256 | `41256e4675b825f546432326f5c8aad8701d047132df6368143a7ddccb69da39` |
| 新kind | `trial-community-compose-update` |
| 新runner | `/opt/cisme-trial/community-compose-runners/<sourceHead前12位>/`，root0700，helper/binding root0600 |
| 新stage | `/var/lib/cisme-dependency-stage/community-compose-<head12>-<8至40位a-z0-9_连字符>/archive.tar.gz` |
| 新candidate | `/opt/cisme-trial/releases/tencent-release-<head12>`，全新不可变目录 |
| 新state | `/opt/cisme-trial/community-compose-updates/`，独立active-release.json和commit状态 |
| 不变项 | 全104个SQL、migrate.mjs、发布package/lock逐字节不变；完整依赖树SHA `d9f03813fc808eced42eacb92db4530a2cd0e0824cab5d1beb9c3bdf08144bdd` |

binding须准确提供sourceHead/sourceTree、ciRunId/ciVerifyJobId正整数、helper/manifest/archive SHA、archiveBytes/Path、104项migrationSha256及`applicationRollbackAllowed:false`，并绑定上述baselineHead/Tree。helper本身须来自候选准确Git tree。

CI核对固定仓库当前main、该head最新main push的ci.yml run，以及指定verify job真实completed/success；其来源语义与019的root-activation-gates一致。full40设计缺口不伪装全产品PASS。source检查在stage/preflight及最后停服务前完成；active只验证保存来源、旧baseline输入、新binding/制品/单元与私有配置，绝不在新服务切换后再调用要求current6123的旧active，也不因未来main变化废掉当前部署凭据。

停服务后先确认drain，再保存所有public表的整行count/hash（含schema_migration时间及全部104协作字段），切换后仍停服务时逐项比较；不删列、不忽略会话/权限/历史。随后仅启动两条trial unit，核健康/原生依赖/公开文章与游客评论登录保护，并保存新active。停止前失败不触碰旧运行；开始停止后的任何失败均再次尝试停两trial unit并留manual-recovery-required，供明确前向修复，不自动回退旧应用或恢复数据库。生产原PID/启动事实、配置及密钥保持不变。

## 可信运输与执行顺序

019真实执行方式存于本机`tmp/support-loop-acceptance-20261101/release-019-transport/reviewed-command-plan.json`和`root-remote-operation.py`。SSH用户是ubuntu，远端sudo，而非root直连；既有固定参数如下，仅示例当前只读旧guard：

```sh
ssh -i /Users/mini/.ssh/cisme/tencent-shanghai -o UserKnownHostsFile=/Users/mini/.ssh/cisme/tencent-shanghai.known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes ubuntu@124.223.74.198 'sudo -n /usr/bin/python3 -I -B /opt/cisme-trial/support-closure-runners/6123a594cd67/trial-support-closure-update.py active --binding /opt/cisme-trial/support-closure-runners/6123a594cd67/application-binding.json --binding-sha256 41256e4675b825f546432326f5c8aad8701d047132df6368143a7ddccb69da39'
```

不读取或输出私钥/known_hosts正文，不用accept-new/no绕过主机校验。主线程已按该可信路径核验本轮基线；本子任务未执行此命令。

主线程可按以下顺序准备新的精确输入，不能重放历史019写命令：

1. 冻结UI及helper，提交/合并准确main并等待该head最新push verify通过；保留原三入口证据hash。旧源码上传worktree/main门禁继续执行。
2. 在固定Linux/amd64 glibc、Node24.14.0 builder构建，使用既有`scripts/package-tencent-release.mjs`。019 builder image SHA为`43ffb442676c100df1e90d50b1d582c5af0b9dca1bdf7cbc9065dad0c5521044`，无主机挂载/秘密、network none，使用经摘要验证的公开npm cache。不可把本机macOS Sharp拷上服务器，不在服务器npm install。
3. 核对真实归档和manifest全文件hash、104 SQL/107个保护文件、完整dependencies；根生成全新binding和stageplan，不填占位SHA/CI、不覆盖旧目录。
4. 适配019 stage-template及transfer-stage的新命名空间和当前6123 closure bootstrap。旧stage-template SHA为`c0c9dea28328956457eb3546fab644b09ec3807ab8bfd374ac18653b5c939da6`；其内嵌contained-tar原语来自`trial-editorial-comments-stage.py`，SHA `99a2c97bb429c56149c615396810899a5e13bc5c5d2500040aec33e69327e0f5`，可保持原字节复用。必须更改runner/stage/upload前缀、helper文件及新SHA，允许COMMUNITY_COMPOSE稳定错误码，meta保留新增CI字段。transfer bootstrap必须从旧6c guard改为上表6123 guard+原helper/binding SHA；不能只改远端目录却仍验证6c。所有本地/远端stage、runner、receipt均新建不可覆盖，传输未知结果先精确只读核对，不自动重发。
5. 暂存只写新candidate/runner/stage，不改服务/配置/DB；按新helper的`preflight --binding <新绝对路径> --binding-sha256 <实际SHA>`核验，保存只读结果。
6. 主线程独立review后，同一新helper执行`apply --binding ... --binding-sha256 ... --operation-reference cisme-community-compose-20261102`一次；随后同binding执行`active`只读核验。operation-reference记录本轮既有用户授权，不生成新的业务准入批准。新helper不提供rollback动作。
7. 当前体验API完成兼容后再官方上传0.1.25并确认真实体验指派；按授权体验身份核验私稿/图片链路的实际状态，任何新增验收数据先保留基线并按精确ID隔离清理，不将mock当作真打通。交易/公开UGC继续关闭，生产单元和原数据事实需独立保持。

本轮新增offline命令：`python3 -I -B infra/tencent/test_trial_community_compose_update.py`，实际34项通过（0.215秒）；覆盖精确旧guard/切后加载原语、所有104 SQL和私有链、错误main/CI/job、只读preflight、仅两trial unit、停后事实比较、失败前向保全及不外输私有错误。CI仅追加同一行。`git diff --check`通过。以上不代表新helper已经在服务器执行。
