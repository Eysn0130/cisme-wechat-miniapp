import { readFile } from "node:fs/promises";
import { describe,expect,it } from "vitest";
const read=(path:string)=>readFile(path,"utf8");

describe("role-aware native support UX",()=>{
 it("replaces the care account chip with the semantic support icon and one unread badge",async()=>{
  const [view,logic]=await Promise.all([read("apps/miniprogram/pages/home/index.wxml"),read("apps/miniprogram/pages/home/index.ts")]);
  expect(view).toContain("chat-circle-plum.svg");expect(view).toContain("home-support__badge");expect(view).not.toContain(">会员账号</button>");
  expect(logic).toContain('requireMemberAccess("/pages/support/index")');expect(logic).toContain('/v1/me/support/summary');
  expect(logic).toContain("care: null, supportUnread: 0");
 });
 it("shows support to members and management only from server authority",async()=>{
  const [view,logic,authority]=await Promise.all([read("apps/miniprogram/pages/profile/index.wxml"),read("apps/miniprogram/pages/profile/index.ts"),read("apps/miniprogram/services/authority.ts")]);
  expect(view).toContain("客服</strong>");expect(view).toContain('wx:if="{{authority.managementAvailable}}"');expect(view).toContain("管理中心");
  expect(logic).toContain("authorityProjection()");expect(authority).toContain('/v1/me/authority');expect(authority).not.toContain("isAdmin");
  expect(logic).toMatch(/!requireMemberAccess\(\).*authority:null,supportUnread:0/);
 });
 it("uses a shared cursor state machine, bounded non-overlapping polling and explicit AI/human labels",async()=>{
  const [userLogic,userView,operatorLogic,operatorView,state]=await Promise.all([read("apps/miniprogram/pages/support/index.ts"),read("apps/miniprogram/pages/support/index.wxml"),read("apps/miniprogram/pages/management-support-chat/index.ts"),read("apps/miniprogram/pages/management-support-chat/index.wxml"),read("apps/miniprogram/services/support-thread-state.ts")]);
  for(const logic of [userLogic,operatorLogic]){expect(logic).toContain("?after=");expect(logic).toContain("?before=");expect(logic).toContain("mergeSyncPage");expect(logic).toContain("pollInFlight");expect(logic).not.toContain("setInterval");}
  expect(state).toContain("Only a response from the synchronization endpoint may advance");
  for(const logic of [userLogic,operatorLogic])expect(logic).toContain("retainMemberSnapshot(this)");
 expect(userLogic).toContain("AI 助手");expect(userView).toContain("人工");expect(operatorView).toContain("接管会话");expect(operatorView).toContain("标记已解决");
  expect(operatorLogic).toContain("wx.showModal");expect(operatorLogic).toContain("member.support_view");
  for(const logic of [userLogic,operatorLogic]){expect(logic).toMatch(/sendAttempt\?\.body\s*===\s*body/);expect(logic).toContain("sendAttempt.id");}
 });
 it("keeps the first chat version text-only and does not add WebSocket or AI dependencies",async()=>{
  const [app,user,operator,lock]=await Promise.all([read("apps/miniprogram/app.json"),read("apps/miniprogram/pages/support/index.ts"),read("apps/miniprogram/pages/management-support-chat/index.ts"),read("package-lock.json")]);
  expect(app).not.toContain("connectSocket");expect(user).not.toContain("chooseMedia");expect(operator).not.toContain("chooseMedia");expect(lock).not.toContain("@langchain/langgraph");
 });
});
