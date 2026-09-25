# 当前包微信模拟器局部截图（2026-09-23）

- 源码包 SHA-256：`980483b32413cf44b9324085d4cc0aed1e88fed70af6acee4feffb40d92b9245`。
- 工具：微信开发者工具 Nightly `wechatide` 0.3.9；项目 `apps/miniprogram`，AppID `wx4eac2d4fb11d299b`；模拟器截图原始尺寸 333 × 719。
- `privacy-rights.png`：直接打开隐私页后的本机状态。表单、主按钮、刷新按钮可见，无明显文字横向溢出或按钮偏移；接口显示“网络连接未完成”，不能证明法律信息加载、正式身份数据请求或提交成功。
- `account-local-fixture.png`：用 `intent=manual` 打开的账号页。本机显示“仅供本地调试，正式协议尚未发布”；按钮文字未见明显偏移。这是开发者工具本地协议状态，不能当作正式协议发布或真实注册验收。
- 只覆盖上述两页、两个状态和模拟器尺寸。未执行键盘、系统大字、全屏客服、iOS、Android 或当前包全部 40 路由状态矩阵。`current-source-acceptance.json` 保持 `blocked`。
