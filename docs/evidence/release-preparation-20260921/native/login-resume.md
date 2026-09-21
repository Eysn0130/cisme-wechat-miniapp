# 本机原生登录反例

在当前工程的开发者工具中保留上一一次性 API 的旧会话，然后启动新的独立合成 API。进入账号页、选择明确标注“仅供本地测试”的协议并点击继续：资料校验 401 清掉旧 token 后，页面仍 loading，identityCommitStarted=false，无法再次点击登录。`account-stale-session-before.png` 保留原图，原包为 `003a1a24ce2e13fe4303c8bcad4456dc6263fc8b5d6319e04fff7f1d3b67dcdf`。未接受真实法律协议，未注入会话 token。

修复：继续已有会话的分支增加 attempt 归属及 finally 释放 loading；会话变化提示重新确认；资料暂不可用不被当作缺头像。新身份确认后的资料加载失败也保留重试入口。两个新增反例修复前失败，修复后账号 Page 11 项通过。实际原生复测另记，单元测试不是设备通过。

修复后包 `91a37de8a3572417148929564cfa9cfeea696d73094a60938b6b68d8b45ed3a6`，259 文件、37 路由。此前截图/74 模板编译归属旧包，不自动继承；当前正式 manifest 重新绑定且继续 blocked。

## 同一缺陷的当前包原生复验

2026-09-21 17:31–17:33 UTC，在 `91a37de8…` 的原生账号页保留 run `87ef08239acd4617a4f2f800` 的旧会话，仅停止该归属 API/容器；新建 run `f1386bc5978fb16582be2066`（新库、新对象实例、新会话签名秘密）。点击原页面“继续使用”后，旧凭据被拒绝，实际页面显示“登录状态已变化，请重新确认身份。”；`account-expired-session-after.json` 记录 loading=false、identityCommitStarted=false、hasSession=false，不包含 token。重新勾选明确注明仅本地测试的说明、点击继续，实际恢复到有会员称呼的首页（`account-expired-session-recovered.png`）。两张原图未缩放，无真实法律协议/资金操作。此用例在开发者工具观察通过；不是第二真机、完整生命周期矩阵或正式版本验收。

同包还通过原生按钮完成合成 D14 护理：00→01→02→03，完成四步但未选择感受时提交不可用，选“舒适轻盈”后提交；记录详情能查看四步及感受。`current-care-assessment-required.png` 与 `current-care-record-detail.png` 保存原图。合成数据来自一次性 run `87ef08239acd4617a4f2f800`，不是个人真实护理记录。
