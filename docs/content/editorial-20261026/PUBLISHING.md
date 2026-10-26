# 2026-10-26 CISME 精选发布工具

此目录保存公开原稿、来源和AI配图原稿。真实会员/身份绑定、授权账号权限、运行环境、发布输入和回执保存在受保护的运维位置，不放入公开仓库。`articles.original.json` 为六篇原稿；按 `coverKey` 关联素材，不依赖文章或图片数组排序。

新增迁移只有 `202610260001_owned_editorial.sql`（第98个）。它新增 `editorial_article` / `editorial_article_revision`、索引和不可变证明触发器，向原 `authority_grant` CHECK 的完整允许集合追加 `editorial.manage`。不修改旧迁移，不更新旧业务行。独立精选使用已发布文章及活跃真实作者作为可见条件，不打开普通投稿UGC或旧开发预览。消费者不能通过HTTP发布精选。

当前正文可撤回和清理。revision仅保留版本、动作、正文指纹、授权编号/权利证明指纹和真实操作者ID，不永久保存正文或昵称快照。`content_sha256` 指向最后发布内容的指纹，撤回/清理后不代表已清理正文的新指纹。作者非活跃或文章撤回后，详情和图片旧链接均404；API响应含 `Cache-Control: private, no-store`。已经下载到设备的资料不能被远程收回。

配图源PNG保留原始生成元信息。公开服务只使用去除元信息、最长边1536像素、受限像素/字节的WebP衍生，数据库同时保留 sourceKind=`ai_generated_editorial_artwork`、aiUsage=`generated`、来源SHA和衍生SHA。正文显示“AI辅助配图”，不能解释为真人头像、实际商品或使用效果。

本地 `derive-media` 不需要会员身份，不连接数据库、不发布：

```sh
node_modules/.bin/tsx scripts/editorial-publish.ts derive-media docs/content/editorial-20261026/MANIFEST.json tmp/launch-20261026/editorial-derived-20261026
```

`prepare` 输入为原稿JSON的私有副本，保留 posts / authorDisplayName，并补入：

- schemaVersion=1、environment=`staging`、databaseName=`cisme_trial`、canonical appId。
- 通过真实微信身份核验得到的 authorMemberId、operatorMemberId、operatorPrincipalId；昵称或微信号不能作身份依据。作者可以与获授权操作者是同一真实会员。
- authorizationRef：通用可追溯授权编号，例如 `cisme-editorial-owner-20261026`，不写聊天原文、微信号、秘密或证件资料。
- mediaRoot：仅本地准备时使用的原稿根目录绝对路径，不进入发布JSON或公开API。
- images：`[{key,path,sha256,rightsRef,kind:"ai_generated_illustration"}]`；path为mediaRoot内相对PNG路径；六个key为 journal-comb、scalp-hair-still-life、water-linen、gentle-towel、drying-comb、feeling-diary。后两项须按实际主题对应。

```sh
node_modules/.bin/tsx scripts/editorial-publish.ts prepare PRIVATE_INPUT_JSON PRIVATE_PREPARED_DIRECTORY
```

输出 `publication-bundle.json` 和逐SHA命名的WebP，准备回执给出JSON精确SHA。输入只有显式 `prepare` / `apply` / `withdraw` / `purge-withdrawn` 才执行对应行为，没有默认发布。正式执行只使用独立Linux运维bundle，不改变API/worker/migrator四入口的制品契约。

发布前由运维部署新应用和第98迁移，核对当前协议范围，并按现有 authority-grants 工具给真实操作者最小 `editorial.manage`。发布工具不会自授权限。root安装的运维代码保持0755/0644；输入目录root所属0750/group服务账号、文件0640只读。**运行publisher须使用 cisme-trial 服务账号、独立体验环境及 `/opt/cisme-trial` 工作目录**，使图片写入与API同一隔离对象目录且归服务账号所有。不能用root写出API读不到的root600对象。

```sh
node OPERATOR_BUNDLE/editorial-publish.js apply PREPARED_JSON EXACT_JSON_SHA256
node OPERATOR_BUNDLE/editorial-publish.js withdraw PREPARED_JSON EXACT_JSON_SHA256 ARTICLE_UUID EXPECTED_VERSION
node OPERATOR_BUNDLE/editorial-publish.js purge-withdrawn PREPARED_JSON EXACT_JSON_SHA256 ARTICLE_UUID EXPECTED_VERSION
```

应用前再次核对环境/实际数据库名、canonical真实操作者与独立权限、真实活跃作者、WebP SHA和大小。逐篇事务发布且同来源/同指纹重复执行幂等；多篇过程中若失败，需读回实际结果再重试，不能把整批当作原子提交。未引用的已写对象不等于已发布文章。

withdraw只撤回。purge-withdrawn只清理准确版本的撤回内容，检查必要保全及其他文章的共享素材引用，随后清理正文/显示名/素材；不承诺自动清理期限。账号注销事务先隐藏作者文章并清理不受保全的文本和本人互动，素材哈希继续作为私有清理定位信息，后续由该工具受控清理。独立恢复抑制通过既有注销标记阻止旧作者资料重新公开。

公开阅读无需同意新协议；点赞、收藏、关注只允许真实当前会员，并在同一事务检查当前terms/privacy。旧确认缺少当前版本返回409 `CURRENT_LEGAL_CONSENT_REQUIRED`，不写互动或互动审计。用户显式勾选后调用 `POST /v1/me/legal-acceptances`，输入 `{consents:[{documentType:"terms",version:"..."},{documentType:"privacy",version:"..."}]}`，返回 `{accepted:true,documents:[{documentType,version}]}`。版本变化会拒绝；重试幂等；不要求再取微信登录code，也不自动补发原互动。

本人的数据副本包含文章、最小发布证明、本人点赞收藏/关注及现存衍生图片。raw rights_evidence 不导出给作者，其他操作者的身份和授权原文不作为本人数据复制。带素材副本走现有受限、加密、可撤销的分片路径。

`wechat-identity-probe.js` 是默认不执行的第四运维工具：仅独立体验上下文，检查固定本地cisme_trial数据库/角色后，使用stdin的一次性code调用官方身份交换并精确查找既有canonical微信身份；不注册会员、不创建会话或协议确认。实际ID写受保护0600新文件，stdout只给脱敏状态。它不能替代用户手动勾选协议与完整登录验收。
