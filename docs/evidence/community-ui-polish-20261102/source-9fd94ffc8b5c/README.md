# 最终文字入口导航清理（9fd）

包SHA-256：`9fd94ffc8b5c0431e5cdce16d190e7e2613703afa5804ff3f3c98c6bb3d9d830`。24实际页面／Tab／组件／helper与隔离fixture逐字节一致，原生操作后再次核对。当前仅390输入／模板／publisher三张截图，均逐张查看；真实Canvas图正常，publisher标题正文空。

unknowncreate回执之后，用官方showModal mock表示用户明确确认离开，真正执行showMyPosts到列表，local entry/pending/import/resume/context/handoff全部清空。打开受控既有草稿后可重新编辑卡片，原正文保留。另以programmatic loadDraft在create等待中换scope，释放旧回执后当前post/title/body/files/epoch不变，旧候选失效，媒体写入0。这是受控原生方法和mock服务响应证明，不是真实账号或手指触摸验收。

c4ee三尺寸与保图等待／错误同键重试保原hash，本包不重标；3127生成取消／快切和hide-show亦只保历史原范围。eba9旧白页帧保失败证据。模板／WXML／WXSS与c4ee未变有逐文件哈希比对，但不据此继承全状态通过。

已restore showModal/chooseMedia/requirePrivacyAuthorize；offline API还原原字节，精确离线样本清除并refresh后community投稿0／写调用0／模拟公开关闭／入口关闭，latency不存在。SDK clickCheckTask错误、左上极小截线未明、物理键盘／手势／读屏／相机／真实后台仍未验，40路由矩阵blocked。未操作s0、真实账号、受限后台或上传。
