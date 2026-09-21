# CISME PR6 断点接续与支付查单修复

## 已完成与未完成的断点

接续时 PR5 已合并，main 为 `42e9b44db959000b10c8e6f4d0fd0e150fe69b89`。PR6 仍开放，原受审 HEAD 为 `e856d2a085c8a875bf4d2b2dc49bdd7e07be5b9b`。不能把“上轮回答中断”解释为没有施工，也不能把 PR6 已提交解释为已合并。

下载并校验当前 e856 对应的正常 CI 工件：run `35574380048`，artifact `10627533220`，ZIP SHA-256 `485311a6d5c4ef9e46f5e04a21398ee7e38c130f4121f84ae950f2e8c7168b7d`。原始日志实际为 532 单测、601 集成测试通过，两个根依赖审计均为 0，六组隔离性能脚本退出 0。checkout 为 PR 合成合并 `4483ded1e05c0257f38d4a08cbd909e163680b04`；这些是修复本次发现前的结果，不继承为最终提交的结果。

现有三页渐进读取、本人历史与写入门禁分离、退款数量未知状态保留。PR4/PR5 不重复施工。商业正式版、原生37页验收和 Mac 同步均未因此完成。

## PAY-FOLLOWUP-01 / P2：父操作提前解除查单忙态

位置：`apps/miniprogram/pages/order-detail/index.ts` 的 `preparePayment`。原先原生付款面板返回后以 `void this.recheckPayment()` 发起服务器查单，父函数立即进入 `finally/finishAction`，把仍在查单的 `busy` 清为 false；连点可再次查询或准备付款。不是重复真实扣款的证据，现有服务端门禁和幂等未被绕过。

独立诊断加载真实 TS Page、orders/page-requests/commerce-runtime/commerce 模块，仅将 API、布局和 wx 交互替换为明确合成依赖。付款成功/取消 × 查单成功/失败四种组合均观察到旧源码 `busy=false`、二次点击产生 2 个查询；修复后四种组合均为 `busy=true`、仅 1 个查询，查单结束释放忙态。Linux Node22.16.0 + TypeScript5.8.3 转译，仅为确定性行为诊断，不是锁定 Node24/TS7 全量验证或原生渲染。

修复：父操作等待 `await this.recheckPayment()`。保留服务端查单为权威、账户与页面世代、隐藏后不主动拉起资金面板以及原单查询路径。新增 `tests/unit/native-payment-followup.test.ts` 六项真实 Page 回归：四种结果组合、隐藏后返回、切换账号后拒绝旧查单结果。全量结果必须以最终 HEAD 和合并后的 main 各自的正常 CI 为准。

PRD 对应：§4.3、§8.2、§13、WX-PAY-MAKE-01。微信官方指南：<https://pay.wechatpay.cn/doc/v3/merchant/4012791911>，本次读取版本标记 2026-06-09；支付成功或用户取消后均需查询权威订单，前端回调不等于成交。没有调用真实微信支付或外部商户。

## 当前包与证据

执行既有 `scripts/update-current-source-manifest.ts` 的等义 TypeScript 转译脚本后，包 SHA-256 为 `b7a948c4aca654f060a9d4c2f617f63fd5354e25fa6cc014ced06acb74ed11a3`；255 文件、37 路由；主包 1,431,193 bytes、总包 2,177,041 bytes、全局 WXSS 8,137/8,192 bytes。相对8fca包仅增加98 bytes，总样式与依赖不变。旧8fca验收绑定另存追溯，当前依然 blocked。原生编译、截图、iOS/Android、真实HTTPS、体验版、部署、正式审核与发布均未执行。

当前容器无法直连克隆，改用既有只读证据工作流归档精确已提交源码；档案经过外层/内层校验，临时索引树等于 GitHub 的 `a7a1b0a4c7edb1667fbf2dc90045e14c4da39fe6`。没有导出 .git 凭据、环境或用户工作树。完整源码档案较大，最终工作流将其改为显式 workflow_dispatch 输入 `include_source=true` 才执行，默认 PR 不再生成此档案。普通 ci.yml、发布作业和所有安全门禁未改。

## 后续与回滚

`MONEY-RECOVERY-01` 仍开放：编辑金额或理由、卸载/进程重启后丢失原幂等键/载荷，不是本次 await 修复可以解决的。下一源码批沿当前 main 完成按主体隔离、最小持久命令记录、未知先查原结果、原载荷重试与拒绝静默换键；不要等待商户才能施工。其余页生命周期、全接口对象权限、正式 provider、隐私全量执行继续按原完整提示词推进。

Mac Codex 负责仅在 `/Users/mini/CISME` 保存未提交工作后合法 ff 同步最终 main，并使用 `apps/miniprogram` 为 DevTools 项目参数验证当前包；Chat 本轮没有本机控制权，不声称目录已同步。账户、平台、值班、政策和生产决策仍按已有 Owner 台账提供最小脱敏证据，不要求聊天提供私钥。

回滚使用新 revert 提交、完整回归及重新生成当前包绑定；本次无数据库迁移、依赖更新或生产配置。撤销本次运行代码会恢复已知查单忙态缺陷，不作为默认回退方案。最终 PR/merge/main/Actions 回执记录于 PR6 评论与会话交付，避免文件自指提交号无限生成提交。`releaseReady=false`。
