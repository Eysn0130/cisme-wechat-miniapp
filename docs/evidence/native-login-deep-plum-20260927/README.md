# 第三版登录页原生精修

## 来源与范围

- 用户选定的第三版原图：`reference-selected.png`，SHA-256 `d08bf5380b37d8ea2c32f3ebe557d1082e56e83650c7673adc9579b9ff6a4280`。它是视觉参考，不是小程序运行截图。
- 从该图生成了**不含文字**的紫色缎面、珠光和弧线背景：`hero-generated-source.png`，SHA-256 `47a5e42e2558c24cd42f057f599d9761ccd7ea77eb57167526be58f51a14266f`。打包素材是 `apps/miniprogram/assets/cisme/cisme-login-hero-plum-r10.jpg`，780×780、60 KB，SHA-256 `01943ee5a9767eee91e6dd8c6fe98e4753af467d15370f7b66cbcba8ca39de39`。
- 所有标题、说明、协议、按钮和状态仍由 `pages/account/index.wxml` 渲染，图片只提供装饰。原生导航返回与胶囊空间保留。
- 范围仅为 PRD V2.1 R4 的 P02 登录页展示、协议入口、手机号说明和游客入口；A21 身份事实、微信授权与服务端行为未更改。订单页及既有 R8 收货联动未修改。

## 交互与动效

- 顶部文案一次 650 ms 轻入场；珠光叠层以 5.4 s 周期改变局部透明度和大小，不移动版面、不遮盖操作。低性能设备和系统减动效样式下禁用；页面隐藏时暂停，返回时恢复。
- 勾选区与协议链接分开：点击链接不自动同意。真实协议状态与“本地测试协议”说明沿用既有条件显示；协议未就绪时主按钮仍禁用。手机号说明是普通文字，微信手机号授权仍只由既有登录按钮触发。
- 使用微信开发者工具 Nightly `wechatide` 0.3.11、AppID `wx4eac2d4fb11d299b` 的 361×804 模拟器。当前小程序完整输入 SHA-256 为 `a906df8d768766209ac5a1dd5d180550752268785dc7d23c7db4fa1572669492`。

## 原生证据

| 文件 | 范围 |
| --- | --- |
| `simulator-final-disabled.png` | 本地协议已就绪、未勾选、主按钮禁用 |
| `simulator-final-enabled.png` | 人工点原生勾选后，主按钮启用；未点击登录 |
| `simulator-final-legal-link.png` | 本地协议说明弹窗；同意值保持 `false` |
| `simulator-motion-a.png` / `simulator-motion-b.png` | 同一可见页面的两帧；珠光周围平均 RGB 差异 1.113，静止紫色区及下方正文区均为 0 |

进入协议页时，账号页 `heroMotionActive=false`；返回后为 `true`。最后将勾选重置为 `false`，模拟器恢复到进入前的 `pages/home/index`。没有调用微信登录、索取手机号或制造交易。

这些截图只证明上述模拟器状态。未取得真机、正式协议、真实微信授权或完整页面状态矩阵验收。原 R9 截图继续绑定其原始源码哈希，旧验收清单保存在 `docs/evidence/visual/source-acceptance-bcbd6232f910.json`。本次本地精修不解除原 PR22 GitHub 写入限制，也不构成 main、生产部署或微信上传回执。
