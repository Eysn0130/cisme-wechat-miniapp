# 普通帖子作者与共用详情

对应 PRD：COMM-STORY-IDENTITY-01、COMM-STORY-DETAIL-01、COMM-STORY-OWNER-01/02、COMM-STORY-COMMENT-01。

公开普通帖只投影实际会员昵称、头像；不改变私人资料的 public_status、community_visible，不公开联系方式。官方发布身份与个人会员仍分离。普通帖进入 pages/post 的同一原生详情，通过真实 UGC 读写接口适配共用视图；旧 community-post 链接仅重定向。本人底部增加编辑、删除，服务端继续核验归属、版本。普通评论的心形按钮连接幂等点赞；reader 视图只加入当前读者本人的非公开评论，原公开游标不变。

`package-source.json` 固定本轮 305 文件、40 路由源码哈希。`native/validation.json` 与各步 JSON、截图记录本机官方微信开发者工具中 375 / 390 / 430 宽度的合成原生检查：本人署名与按钮、取消删除、编辑后一次提交返回同一详情、访客无本人按钮、与精选共用布局的测量一致、游客评论门禁。仅替换 app.ts 的合成传输与 app.json 的入口，其余源码逐文件一致；无真实账户写入。原生 fixture 不含图片；真实 UGC 媒体路径映射与共用渲染由单元及接口检查覆盖，不能据此声称真机图片表现通过。

`validation-summary.json` 保留本地检查真实范围。全量接口首次运行的迁移测试因新增110后的历史边界断言失败，已修正并单独通过；两项既有客服素材到期测试受本机 Docker 数据库比宿主快 1929ms、用例只倒退 1000ms 的时钟差影响，未修改其业务逻辑或放宽用例，交付需另核对 GitHub 同机 CI 完整结果。

全站40页状态矩阵与iOS/Android真机矩阵仍未完成，current-source-acceptance.json 保持 blocked。历史截图不作为本轮证据。服务器和上传回执在完成后另存本轮私有交付目录；本文不预声明部署或体验版上传成功。
