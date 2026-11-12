# 真机弱网、冷启动与页面切换验收

基线为已上传体验版0.1.43，main 420375f1，原生源包30713a08。当前仅确认官方自动化目标platform=devtools，真机尚未接入；coverage.json全部保留未测，先记录事实再推进。

1. 手机接入后记录型号、系统、微信/基础库版本、实际envVersion、网络类型、来源包哈希及连接方式。用调试包检查功能，体验版未连接调试器的冷启动和耗时另行测量；不混用两类结果。
2. 弱网必须记录真实设备/路由器上的带宽、延迟、丢包及启用证据。模拟器延迟HTTP、在Mac限速、使用reLaunch不能作为手机链路/冷启动证据。未配置或未确认的参数记unknown，实际样本数不足不输出P95。
3. 区分首次下载、包已缓存的新进程冷启动和后台热恢复；appLaunch、route、firstRender、downloadPackage分别记录，FP/FCP/LCP是时间点，平台不支持的字段记null。首屏可交互、业务关键资料确认、按钮禁用/恢复及位移分别核对。
4. 全41注册路由按正常网络、真实弱网、断网/恢复、读取中快速切换核验；受权限、真实商品/订单参数及已弃用兼容路由分别按真实状态验收。未获权限不伪造角色、不改真实订单来凑状态。
5. 操作真实会员前先保留只读基线；新增验收事实按精确记录ID可恢复隔离，核对原有/并发事实。未指定订单和金额的实付、退款、转账不执行。
6. 观察到的问题才做最小修改；新源包重新验收、CI通过后再合并main与上传下一体验版。本轮无代码改动时不为文档重复上传0.1.43。

依据：[真机自动化](https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/remote)、[性能数据](https://developers.weixin.qq.com/miniprogram/dev/framework/performance/perf_data)、[PerformanceEntry](https://developers.weixin.qq.com/miniprogram/dev/api/base/performance/PerformanceEntry)、[网络性能](https://developers.weixin.qq.com/miniprogram/dev/framework/performance/network)。
