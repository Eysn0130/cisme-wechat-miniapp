# 本机原生登录反例

在当前工程的开发者工具中保留上一一次性 API 的旧会话，然后启动新的独立合成 API。进入账号页、选择明确标注“仅供本地测试”的协议并点击继续：资料校验 401 清掉旧 token 后，页面仍 loading，identityCommitStarted=false，无法再次点击登录。`account-stale-session-before.png` 保留原图，原包为 `003a1a24ce2e13fe4303c8bcad4456dc6263fc8b5d6319e04fff7f1d3b67dcdf`。未接受真实法律协议，未注入会话 token。

修复：继续已有会话的分支增加 attempt 归属及 finally 释放 loading；会话变化提示重新确认；资料暂不可用不被当作缺头像。新身份确认后的资料加载失败也保留重试入口。两个新增反例修复前失败，修复后账号 Page 11 项通过。实际原生复测另记，单元测试不是设备通过。

修复后包 `91a37de8a3572417148929564cfa9cfeea696d73094a60938b6b68d8b45ed3a6`，259 文件、37 路由。此前截图/74 模板编译归属旧包，不自动继承；当前正式 manifest 重新绑定且继续 blocked。
