# PR16 接续施工与原生复核（2026-09-22 UTC）

状态：PARTIAL ENGINEERING DELIVERY；releaseReady=false。已接续原 PR16，未合并、未正式提审或发布。正式新资金、完整主体隐私执行、全接口13维验收、全原生状态/真机与目标环境恢复仍未完成，不能写“只剩备案”。

## 接管与来源

唯一工程 `/Users/mini/CISME`；仓库 `Eysn0130/cisme-wechat-miniapp`。接管时 main `35a9cfa7d67b66c1c7d982a8940a86ab300a874e`，PR16 Draft OPEN，HEAD `79bf741528feb4f9028fc7ee7dce560949fd82b8`，tree `7255d669a335338d19f0cc4a8d2f2c8f0f00fa9a`。工作区起初干净、唯一 worktree，同根其他任务无正在运行者。未启动 Goal，未建立第二长期工程，未重放 PR4–15。

交接 ZIP 先检查目录穿越、重复路径、symlink 与解压规模；CHECKSUMS.json 67 项全部匹配。外层68项；内层原证据ZIP114项只读检查，没有执行附件脚本。已阅读01 A–P、02–05、CURRENT-STATE、78图JSON及reference原报告。交接 CI35685559540 verify成功，970单元/722集成；设计门与凭据预览 skipped，原生/真机/发布不因此通过。

## 源码切片

1. **社区写后收敛**：复现三个写操作在隐藏恢复或标签A→B→A后，先发出的GET复活旧行。独立mutation serial释放后用新GET收敛，既有请求owner/revision阻止晚读，不重放写入。新增9项RED→GREEN，原19项保留。
2. **原生局部控件**：作者/帖子/审核/成员错误区与隐私刷新44px；缺成员ID提供返回列表；审核按钮、成员标签/弹层、帖子互动按钮按局部所有者居中。社区低性能设备复用shouldReduceMotion，CSS保留OS媒体查询；未新增依赖或全局样式。
3. **有效对象**：现有 disposable miniprogram-acceptance 增加显式 `--synthetic-community`，经真实API创建草稿/提交/另一人审核与公开、删除；只在test/loopback/所属本轮DB使用。补齐作者、已公开帖子、待审帖子、真实成员及删除反例。没有用真实用户或开启公网UGC。
4. **内容同源**：privacy-rights 从与legal相同的 `/v1/legal` 读取主体、隐私版本、联系渠道。加载失败不回退到硬编码公司或虚构邮件；本地fixture继续诚实显示本地验收内容。正式内容尚未替换或批准。
5. **隐私执行边界**：worker在执行事务重查主体active/dev_test、当前maker/checker权限、请求和范围；下载锁住制品/作业/请求并与审计同事务。独立连接中的撤销先提交，下载拒绝。失败重试不覆盖已取消状态。另复现文件在等待作业行锁期间过期仍被交付，取得全部行锁后增加数据库时钟复核；新反例确认旧代码delivered=true，修复后拒绝。9项新增反例加原13项通过。随后发现handle-only范围错误删除整行：已改为仅清空wechat_handle并推进profile_revision，保留头像、公开审核及其余资料；反例确认旧代码整行消失，修复后字段与双主体边界保持。执行器仍仅合成会员profile子集，绝不是完整隐私执行。
6. **支付查单与库存**：签名有效仍须绑定原AppID/mchid/单号，存在的金额/币种/payer/交易类型须匹配，SUCCESS仍完整校验。修复迟到ORDER_NOT_EXIST响应在prepay已发出后取消并释放库存。dispatch决定与订单取消用订单锁串行，并在事务重查active主体。新增6项真实隔离DB/签名HTTP反例，最初CLOSED错绑定4项与缺单并发1项RED已保存于临时日志。没有真实支付操作。

7. **审核撤权原生反例**：真实隔离 grant 撤销后发现内部 capability 名被直接显示；动作失败后还可能残留私有候选。CAPABILITY_REQUIRED 现在清空候选/媒体/操作，显示可理解说明和返回社区；包括私有图片读取中途撤权。4个原始反例RED，修复后新增5项通过，完整单元985通过、1跳过。未更改任何真实权限。

## 当前原生证据

当前包 `a296da16a0edafe3d1fc988b94539a52a23f2d7e8b1fa85d9702e96b4276161c`，259文件/37路由；global WXSS仍8137/8192。`native-candidate/` 为本轮最后采集；`native/`、`native-current/`、`native-final/`、`native-reviewed/` 是不同包的中间观察，不能沿用为当前包全状态验收。

工具：WeChat DevTools 2.02.2608070，wechatide skill/CLI 0.3.9，基础库3.15.2；iPhone12/13 Pro模拟器逻辑390×844，原始截图242×524，不放大、不冒称真机。用户未在操作IDE时执行。fixture运行ID `f363dfe8f593340d5dcba97d`，新建DB/S3，API仅127.0.0.1:18080。API fixture进程启动于本次后端修复之前，因此这些截图不是新后端支付/隐私运行验收。

14个页面/对象观察覆盖四个PR16目标页、privacy-rights、有效作者/帖子/审核/成员、删除帖子、四个缺参数错误；另有费率弹层/刷新滚动交互图，以及审核权限撤销/未公开帖子不可见2个反例。截图前先检查loading=false和渲染控件文本，避免仅凭Page data领先于渲染导致错误匹配。此前一张缺参数帖子图控件仍是旧帧，保留为中间观察，最后重新采集并核对“返回社区”。

五个标签真实逐一点击均能切换；40ms间隔A→B→A为受控Page handler压力，单独标记，不冒充真人快速连点。原生transform采样出现中间帧；reduced-motion class注入时transition=0s，真实OS减少动画/低性能真机未验。会员搜索输入与按钮均44px，提议按钮88×44，弹层两按钮各178×44；资金重试340×44；隐私刷新362×44。声明范围限该模拟器该状态。键盘、OS大字、第二设备、iOS/Android真机、全37路由适用状态未通过。

## 后台/环境事实

工程已有2026-09-11 OWNER-CONFIRMED公司名称、当前AppID；legal有2026-09-09-v3-profile与2026-09-11-v4-staging历史发布文本。不能把历史确认当成本次新交易范围政策批准。原环境记录为cisme_staging，staging-api.cisme.cn；历史实例/IP映射不一致，必须实时核验后才能部署。

本次公众平台mp.weixin.qq.com与商户平台pay.weixin.qq.com均被浏览器site-safety明确阻止，无审批提示、未绕过；腾讯云已有登录标签两次工具超时，未取得当前控制台状态。staging HTTPS健康读取curl TLS握手失败（exit35/HTTP000），未关闭证书验证、未创建资源、未部署。用户表示服务已开通、备案审核中，保持该事实，待核具体AppID/mchid绑定、产品权限/回调与目标环境身份。

官方协议参考：[小程序JSAPI下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791897)、[商户订单号查单](https://pay.wechatpay.cn/doc/v3/merchant/4012791859)、[申请退款](https://pay.wechatpay.cn/doc/v3/merchant/4013071036)，2026-09-22公开官方检索；直接页面抓取部分超时，未将平台配置认定已验。

## 审计与恢复范围

实时方法分母仍228，索引沿 `../release-preparation-20260921/audit/api-surface.json` 更新发现候选。`audit/reviewed-13-axes.json`记录7个高风险HTTP方法切片及两个隐私worker的13维具体事实和缺口，fullyAcceptedMethods=0；没有用同文件测试或匿名拒绝批量关闭全量审计。

恢复演练只用本轮新建 `67415ed3954bd1979e127b3a`，72迁移/拥有标记/探针恢复通过；一个合成对象的内存备份恢复通过。不是生产备份持久性/灾备或目标RPO/RTO。旧cisme_test事故影响UNKNOWN、未恢复，旧Docker实例没有连接或清理。

源码提交见 SOURCE-ANCHOR.json；最终交付HEAD、CI checkout/source/base、分类差异和清理见复核ZIP根目录 RECOVERY-ANCHOR.json（生成于最后提交与CI之后，避免自引用SHA）；未完成技术和外部条件见 REMAINING.md。历史截图、交接CI与各中间包都保留原范围。独立人工审批未由施工者代签。

原生工具限频中断记录保留在 native-reviewed/compile-rate-limit.json 与 interactions-rate-limit.json。后续按1.3秒最小调用间隔顺序重采；编译只验证WXML/WXSS，不替代运行时/设备。施工者复核不是独立人工批准。

当前包原生编译：37路由的WXML/WXSS共74次全部成功，结束包哈希未漂移，见 native-candidate/compile.json。完整本机回归985单元通过/1平台跳过、737集成通过，build/typecheck/contracts/package/route检查通过；design仍blocked。
