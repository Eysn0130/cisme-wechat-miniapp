# 输入页“下一步”右下角：原生有限复核

当前包：`7fd3e10ec169581684ff01f5161e82c62fd065f74d3b16560dcb894ce2d8a6f2`。验收ID：COMPOSE-TEXT-CTA-01。实际页面、Tab、组件和helper共24文件在隔离fixture逐字节一致，检查后再次核对；服务／身份／备份为明确离线适配，不接触真实账号或生产。

5张截图均逐张查看：390空输入、390与用户相同两行文字的启用按钮、390实际生成后的模板页，以及361／430输入页。三尺寸按钮均112×48px、右侧22px，安全区由footer保留；原头部按钮不存在。390 input与templates同为x256–368／y750–798。card与直接正文在各尺寸滚动视口内，没有压住底部CTA。

空输入canProceed=false、灰态，真实confirm处理拒绝生成。长输入native scrollHeight1289px／视口651px，说明存在638px可滚范围且footer保持原位；没有做物理或程序滚动，不把几何当手势通过。受控keyboardChange300时footer消失，0时恢复同几何；没有弹真实键盘，不宣称真实Done／adjust-position实测。实际调用绑定的confirm处理和Canvas，成功生成6张本地PNG并进入templates，未最终确认publisher、无POST。没有重试已知不支持的App.CDPEnable坐标路径，不声称物理tap。

两个启动时序工具错误原样保留，明确page ready后有限重试成功。当前console原始回执保留，左上极小截线未在本轮扩查。全40路由、真机、真实后台及上传不在此定位修正范围，继续blocked；此前原图未改标。

已restore showModal／chooseMedia／requirePrivacyAuthorize。未创建API mock或服务端投稿；清理隔离内存并刷新后community投稿0、写调用0、模拟公开与入口均关闭。UI已交还根代理。

给用户展示启用按钮建议使用[native-input-bottom-next-filled-390.png](native-input-bottom-next-filled-390.png)。
