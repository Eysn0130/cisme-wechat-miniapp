# 文字分段流程边界审阅

审阅日期：2026-11-02。范围为已有本地文字卡片、排版、社区交付和精确草稿备份；依据用户新增流程截图任务与 PRD K.13，使用 `mobile-ui-ux-designer` 的状态／中断／恢复契约。前半部分保留首次只读审阅的输入与风险；随后获主线程明确分工，实施父页／本机备份集成，组件／排版由另一代理负责。未执行微信 UI、真实Canvas、接口或正式数据操作，本记录不是原生或真机验收。

## 现状与应保持的事实

审阅输入为文字组件 `index.ts`（SHA256 `0ea355ada059dd4499c8d32e4718d12d4c9217cea982c813cc3de1284884a8c2`）、`ugc-text-card-layout.ts`（`9cc4ceb439b2fe56f51f241c895b4be0c76f440946291c46c07b48b829183783`）、compose `index.ts`（`4eb1ac47e3f7a2c7782086238eac106b54eb216d68884da9efb4a5610e5b9ad1`）、`ugc-local-backup.ts`（`ca198c95ce22bb7cff1a03bd8c21cb9065202b70387f85a44ba99b3f15d25a47`）和 `community-compose-intent.ts`（`f255f69f8a4aa5ec64d70b296f779ef0a77f8193368a5caf1b25ada2174536c5`）。这些是本次只读输入指纹，后续修改须另验。

- 现 layout 以可见字形计数，300字并不保证任意换行都能放入一张卡；`layoutTextCard` 同时检查单卡超页，失败保留输入，不得改成只检查字符数。见 layout 第51–75行。
- 现组件在每次输入／模板变化后同步 `change` 给父页；组件内部以 generation、renderRevision、contextKey 和会话在导出、文件信息和预览回调后复验。已有单测覆盖旧PNG、旧图片错误、切号、隐藏与重开。新分段不能用纯计时结束替代实际Canvas完成，也不能丢掉这些后验守卫。
- compose 第370–372行保护已有超过300字的正文及9图上限；第201–210、265–279行将文字、模板与图片引用按本人／稿件／基础版本备份和恢复。服务端普通正文上限仍为5000字，卡片限制不是正文裁切规则。
- 媒体intent仅适用于相册／相机本地路径，安全随机编号、2分钟、同账号同环境、一次消费（intent 第1–39行）。本轮文字步骤在同一创作页内分段时不需把文字或本地路径塞入URL；若另作导航交付，须有相同边界，不能直接滥用source白名单。

## 必要调整与风险

| 优先级 | 具体源码与风险 | 本轮最小约束／归属 |
|---|---|---|
| 高 | compose 第98–99、160、240–251行在文字组件出现前已新建服务端稿件，取消后再精确DELETE仍不是零写入。 | root负责首次文字入口先走本地输入→生成→模板，用户明确确认交回publisher才创建；生成取消／失败／模板切换不POST新稿、不授权素材、不上传。已有稿继续使用既有ID。 |
| 高 | createDraft 第247行直接 `applyDraft`，第272–279行使用服务端空内容覆盖本地body、template并清dirty。延后创建若直接复用将丢掉刚输入的文字。 | root负责一次handoff捕获 text/template/PNG/输入版本与账号环境意图；回执仍属当前scope才交回，保留可编辑文字。未知创建沿原createKey核对，保留候选，不重复造稿。 |
| 高 | TextCardContext 第23、374–380行有身份、稿件、epoch、会话和环境，但缺基础version。分段增加等待窗口，旧导出不能落入新版本。 | root在parent context加入version并在change／cancel／confirm后验。生成预览仍须使用输入+模板对应的renderRevision，切换立即失效旧路径与下一步资格。 |
| 中 | 模板合法值分散于layout联合、组件isTemplate/data、compose data/applyDraft/textCardChanged和backup类型。只扩组件会将新模板恢复为plain。 | implementation导出共享6项常量、守卫和normalizer；root将compose/backup复用，保留plain/lilac/memo旧标识；新minimal/care/border不得只出现在按钮上。 |
| 中 | 现cancel始终发parent cancel，初始entry会走confirmLeave；新增“取消生成”若复用该事件会误退出整段创作。 | component负责生成取消只回input，模板返回也只回input，文字和模板保留；只有明确退出文字创作才使用parent cancel。直接写正文仍保留当前已同步文字。 |
| 中 | 尚无postId的本地输入无法写入当前本人／稿件／version备份；不能为得到备份而偷偷创建私稿或声称列表可恢复。 | root明确当前页内存保留／后台返回范围；已有稿继续精确备份；初始阶段退出不作跨重启恢复承诺。未新增独立持久草稿系统。 |
| 中 | 卡片最终confirm从PNG走现有importLocalImages；预览成功不代表素材授权、上传complete或私稿已保存。 | parent接受当前一次handoff后复用10MB／MIME／媒体归属／上传守卫；重复下一步不重复追加。保存／提交原unknown-write归属、版本和审核锁不变。 |

以上已消息同步root及implementation。后端公开门禁、发布意图与schema105无需为本地分段改变；权利开关、AI、长文、视频、音乐、话题、位置等不恢复。隐私数据类别、接收方及保留期限不因6个本地preset发生变化；若实际预览调用时点改变，可再同步现有Canvas API的触发描述，不扩大采集范围。

## 当前验收限度及后续最小核对

首次只读审阅未运行测试；后续父级实现及聚焦验证另见 `text-parent-validation.log`、`text-parent-typecheck.log` 与 `text-parent-validation.json`，不把组件模拟或旧notice／photo-drag截图认作本轮原生通过。冻结后应以新包指纹分别核对：输入空／300／超300／超页及emoji、生成取消／失败／重试、六模板真实导出和快速切换、返回继续编辑、重复下一步、已有长正文及0／8／9图、精确版本备份、后台／换号／换环境／版本变化与迟到导出、首次create未知结果和上传中断。原生Canvas／键盘／触摸、隔离接口与正式体验账号各自记录范围，当前没有发布／部署／真机通过结论。

## 父级实施收口

初始文字阶段以空postId／ownerId、版本0和本轮nonce限定内存输入，最终有效PNG经真实文件大小和PNG签名检查后才沿原createKey建稿。未知创建不在onShow自动POST，显式重试沿同键和候选；已确认但后台收到的成功回执只在同scope回前台后交回，不在后台上传。私稿能力临时关闭／未知时保留本页输入；明确退出可保存原始文字、继续本机编辑或放弃，未建稿不发DELETE、不新增持久化缓存。

卡片文字与正文独立，图片forward不自动重复正文；只有直接写正文／退出明确保存原始文字才转换。已有非空且不同正文的替换需本人确认，迟到确认须再核对版本／身份。新建幂等回执若已有并发版本或非空正文／素材，保留canonical标题／正文／素材，另保本机卡片文字并进入冲突核对，不自动授权或上传。已有短卡片与后续长正文可以独立继续，首次仅长正文仍拒绝制卡且不截断。

六模板共用layout正常化，新增可选textCardText只沿既有本人／稿件／版本的未保存编辑备份，7日期限与原清理规则不变；空卡片输入也不会在后台恢复时被旧正文回填。服务端draft payload仍仅标题／正文／mediaIds与expectedVersion，后端、schema105、公开门禁和运维helper未改。
