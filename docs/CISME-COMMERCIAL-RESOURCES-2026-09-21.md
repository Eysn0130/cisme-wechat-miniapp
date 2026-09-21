# 资源选择：原生商业闭环优先

2026-09-21 07:29:21 UTC 完成11仓库只读元数据核验，原始 JSON 见 [readiness run](https://github.com/Eysn0130/cisme-wechat-miniapp/actions/runs/35573153488) 的 commercial-preparation-evidence 工件；其中页面矩阵属于中间447包，不可作为最终8fca包矩阵。重新生成当前矩阵使用 scripts/audit-commercial-lifecycle.ts。根许可证读到并计算哈希不代表字体、图标、图片、runtime插件或付费案例均可复制。本轮新增依赖0，没有安装或执行这些上游仓库。

| 问题 / 资源 | 固定提交 / 根许可证观察 | 采用或拒绝、成本、验证与回滚 |
|---|---|---|
| 完整流程 / Appllama/appllama-skills | dd5caaec3d5d50ad7fc0324da238119c6b7c3707 / MIT | 采用先研究旅程与状态的方法；不复用 Expo/React Native/Reanimated 代码。未接通付费案例库。无包成本；以原生交互证据验证，不用替栈来回滚。 |
| 动效清理 / greensock/gsap-skills | aed9cfd3277740755f6bfc1155c7aa645403b760 / MIT | 借鉴退出清理、减少布局开销；不装GSAP/ScrollTrigger、不每帧setData，不将Skills MIT扩大到全部runtime资源。无运行依赖；设备帧耗时待测。 |
| 动效时序 / Jakubantalik/transitions.dev | 598d3d6ad89dabb4bdf742fd2e887ca53914a888 / 根license接口404、SPDX未知 | 仅参考有目的、短而一致的时序；拒绝复制未核准授权代码、Pro绕付费和hover/3D栈。验证原生兼容再实施；本轮无复制需撤销。 |
| 原生API / wechat-miniprogram/miniprogram-demo | 0fe5c7df8e90582dd0b89e283df7fe32e04413f9 / MIT | 官方最小组件/API示例优先；本轮没有整仓移植或新增分包。必要摘取前单文件许可及基础库兼容验证；保持原工程。 |
| 长列表 / wechat-miniprogram/recycle-view | 70a5b5af37c52ad4263d40bb9d5e2b48a7484ced / MIT | 暂不采用。先测现有分页、增量投影和图片；只有真机长列表超预算才做隔离试验，可撤回到现有分页。 |
| 服务端期限 / fastify/fastify | 630acd0b6cf8a91322ff05c3d95feb991091866d / MIT | 不因最新tip升级。研究项目锁定5.12.3，保留PR4正常body-close/期限/取消回归；当前无新包成本。 |
| SQL/事务 / brianc/node-postgres | 2759b2ccf70535d425688dca8a6aec79de49c1ea / MIT | 保留锁定8.23.0及既有取消/释放/未知提交；本批历史读取复用原transaction实现，REPEATABLE READ受集成验证，无迁移。 |
| HTTP测量 / mcollina/autocannon | 9d645c3ba48bade008f1785991b2c660e0be3b15 / MIT | 既有smoke/capacity脚本优先，不新增工具；后续明确真实HTTP覆盖缺口才独立运行、限制目标/预算，不能证明微信FPS。 |
| HTTP测量 / grafana/k6 | cff7da7c101ac30179bd7b1b4bd5f71c7435ca7b / AGPL-3.0 | 暂不采用运行依赖；如需用作外部压测需单独许可/运行范围评估、隔离staging和停止阈值。退出删除独立配置，不改业务架构。 |
| 分阶段观测 / open-telemetry/opentelemetry-js | 8bae5f0135ebb5748da6d87da63ac45738ac9f2d / Apache-2.0 | tip变化不自动升级。当前不装；若现有指标不足，仅Node侧最小采样/脱敏，不把浏览器SDK放小程序，不向外部SaaS发送个人内容。 |
| 类型 / wechat-miniprogram/api-typings | 6092df9100c73b84e140c20b9a42a8e8799e0660 / MIT | 继续项目现有5.2.3类型；api存在不证明所有基础库行为，物理取消和性能指标须当前设备核验。 |

Apple [Motion](https://developer.apple.com/design/human-interface-guidelines/motion) 的目的性、可停止、短反馈用于原生交互原则；不是复制SwiftUI/Apple字体图标的许可。加载原则对应本批主事实先展示，但没有本轮设备“更丝滑”的测量结论。Mobbin 未获得登录付费完整旅程，只能保留研究身份恢复、结算、客服和草稿的后续清单，不编造已浏览案例。

正式支付继续按[微信支付官方适用产品文档](https://pay.wechatpay.cn/doc/v3/merchant/4012791911)核对；客户端success/cancel不能单独确立支付事实，正式provider还需查单、回调和对账。第三方SDK热度不能替代平台主体、产品适用和资金授权证据。

本次Chat可用Skill目录没有直接提供用户指定的四个本机Codex Skill，因此没有宣称已调用它们。已有AGENTS决策顺序继续生效；Mac Codex执行时先实际读取已安装对应Skill，再翻译到WXML/WXSS/TypeScript。Product Design的Web原型工作流不用于替换本次原生修复；缺付费案例、原生工具或真机时明确缺证，不安装多Agent框架来绕过。
