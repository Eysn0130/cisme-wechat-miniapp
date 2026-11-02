# PNG到发布页等待衔接：独立原生确认

对应产品包eba9bd7c894fae4f46f05f10ad89c4cc65ff135213235d528ca3f24b93360df4。24实际文件与该包fixture哈希保持一致。未改产品源码。

真实Canvas六PNG完成并最终确认后，仅在隔离offline API暂缓POST-create回执。客户端已验证PNG后隐藏组件，busy=true、operation=creating、loading=false、postId空、error空、files0；截图逐张查看，确实只剩禁用header与白页。模拟服务端已记入一篇假草稿，客户端未拿到回执，不把这个阶段称为创建成功。

最小裁决：等待时保留已验证真实PNG与轻量“正在准备…”反馈，原生有效canonical归属确认才交既有publisher；无图body/save至少显示等待反馈。失败沿同候选/同createKey重试，不新增路由、API、设置或百分比。

释放回执后正常导入一图、title/body空、无error。随后删除精确隔离样本，完整还原offline API原字节并refresh，最终community投稿0、写调用0、公开关闭、latency不存在。原始回执、刺激adapter前后哈希见本目录。旧eba9九张静态图仍保原范围，不作为等待状态通过。
