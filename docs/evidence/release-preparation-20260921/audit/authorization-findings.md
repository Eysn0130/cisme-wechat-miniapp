# 本轮授权反例与修复

范围依据 PRD §3、§4.3、§5.1、§6.6.2、§11。当前审计仍未逐条验收全部接口；`api-surface.json` 的测试引用只是定位候选，不是覆盖结论。

| 缺陷 | 修复前合成反例 | 修复与已执行证据 |
|---|---|---|
| 会员被停用后，仍有效的上传 token 可写入护理/UGC 图片 | cloud-upload 新增用例失败；UGC chunks/assemble 反例失败 | 同事务锁定 active 主体，写入提交前维持授权顺序。`cloud-upload.test.ts`、`formal-ugc-editor.test.ts`。正式直接 S3 的签名授权撤销能力不能从此推断；UGC 直接 S3 仍禁用。 |
| UGC 原草稿已删除后，未消耗的上传授权仍可写入 | `invalidates unconsumed upload grants when their source draft is deleted` 修复前收到成功，预期锁定错误 | post→asset 与 complete/submit 使用一致锁顺序；检查原作者/原内容和 uploads 开关。chunks/assemble 两路径均拒绝。 |
| 已获权限事务与撤权更新没有数据库锁序 | 两个真实 PG 连接：命令持有事务时，撤权 UPDATE 原先立即成功 | `AuthorityService.requireWithClient` 锁定 grant/member；撤权等待提交，后续调用拒绝。`authority-revocation.test.ts`。非事务入口不借此继承全部并发保证。 |
| blocked 主体仍获得 capability projection/has=true | 独立新授予权限后将会员停用，原测试失败 | require/has/requireAny/projection 统一校验 active 会员。 |

定向修复后 4 文件 14 测试通过；此前完整 706 集成通过发生在原草稿状态修复前，最终准确 HEAD CI 必须另核。补丁中一次范围过宽的替换曾误影响审核路径，测试发现并修正，审核用例已重新通过。

安全边界：没有对生产角色或商户权限进行修改；所有反例仅在本次新建实例的合成主体/对象上执行。原始本机日志位于 `tmp/release-preparation/{upload-revocation-before,ugc-upload-before,authority-before,ugc-source-before,authorization-after-final}.log`，不会把这些日志中的历史失败覆盖成通过。
