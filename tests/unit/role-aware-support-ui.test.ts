import { readFile } from "node:fs/promises";
import { describe,expect,it } from "vitest";
const read=(path:string)=>readFile(path,"utf8");

describe("role-aware native support UX",()=>{
 it("replaces the care account chip with the semantic support icon and one unread badge",async()=>{
  const [view,logic]=await Promise.all([read("apps/miniprogram/pages/home/index.wxml"),read("apps/miniprogram/pages/home/index.ts")]);
  expect(view).toContain("chat-circle-plum.svg");expect(view).toContain("home-support__badge");expect(view).not.toContain(">会员账号</button>");
  expect(logic).toContain('requireMemberAccess("/pages/support/index")');expect(logic).toContain('/v1/me/support/summary');
  expect(logic).toContain("care: null, supportUnread: null");
 });
 it("shows support to members and management only from server authority",async()=>{
  const [view,logic,authority]=await Promise.all([read("apps/miniprogram/pages/profile/index.wxml"),read("apps/miniprogram/pages/profile/index.ts"),read("apps/miniprogram/services/authority.ts")]);
  expect(view).toContain("客服</strong>");expect(view).toContain('wx:if="{{authority.managementAvailable && managementEntryAvailable}}"');expect(view).toContain("管理中心");
  expect(logic).toContain("authorityProjection(this)");expect(authority).toContain('/v1/me/authority');expect(authority).not.toContain("isAdmin");
  expect(logic).toMatch(/!requireMemberAccess\(\).*authority:null,managementEntryAvailable:false,commercialEligible:false,commercialAccessible:false,supportUnread:null/);
 });
 it("uses a shared cursor state machine, bounded non-overlapping polling and explicit AI/human labels",async()=>{
  const [userLogic,userView,operatorLogic,operatorView,state]=await Promise.all([read("apps/miniprogram/pages/support/index.ts"),read("apps/miniprogram/pages/support/index.wxml"),read("apps/miniprogram/pages/management-support-chat/index.ts"),read("apps/miniprogram/pages/management-support-chat/index.wxml"),read("apps/miniprogram/services/support-thread-state.ts")]);
  for(const logic of [userLogic,operatorLogic]){expect(logic).toContain("?after=");expect(logic).toContain("?before=");expect(logic).toContain("mergeSyncPage");expect(logic).toContain("pollInFlight");expect(logic).not.toContain("setInterval");}
  expect(state).toContain("Only a response from the synchronization endpoint may advance");
  for(const logic of [userLogic,operatorLogic])expect(logic).toContain("retainMemberSnapshot(this)");
 expect(state).toContain("CISME AI 客服");expect(userView).toContain("{{item.senderLabel}}");expect(userView).toContain("申请人工客服");expect(operatorView).toContain("接管会话");expect(operatorView).toContain("标记已解决");
  expect(operatorLogic).toContain("wx.showModal");expect(operatorLogic).toContain("member.support_view");
  expect(userLogic).toContain("const sendAttempt = previous ??");expect(userLogic).toContain("linkedOrderId = previous ? previous.linkedOrderId");expect(operatorLogic).toMatch(/sendAttempt\?\.body\s*===\s*body/);
  for(const logic of [userLogic,operatorLogic])expect(logic).toContain("sendAttempt.id");
 });
 it('separates a local empty-thread welcome, real waiting and explicit queue actions',async()=>{
  const [view,style]=await Promise.all([read('apps/miniprogram/pages/support/index.wxml'),read('apps/miniprogram/pages/support/index.wxss')]);
  expect(view.startsWith('<page-meta root-font-size="system"/>')).toBe(true);
  const welcome=view.match(/<view wx:if="([^"]+)" class="support-message[^"\n]*support-welcome-message"/);
  expect(welcome?.[1]).toContain('historyLoaded && !loading && !closedRights');expect(welcome?.[1]).toContain('!messages.length && !pendingMessage && !error');
  expect(welcome?.[1]).toContain("!conversation || conversation.status === 'ai_active'");
  expect(view).toContain('你好呀，我是 CISME AI 客服 😊 护理或使用小程序有疑问，都可以问我～');
  expect(view).toContain('你好呀 😊 有问题可以留言，也可以申请人工客服。');expect(view).toContain('正在等待 AI 回复…');
  expect(view).toContain("handoffFailed ? '重试申请' : '申请人工客服'");expect(view).not.toContain('重新提交');
  expect(view).toContain("!conversation || conversation.status === 'ai_active' || conversation.status === 'resolved'");
  expect(view.match(/人工接待 09:00–22:00/g)).toHaveLength(1);expect(view).toContain("conversation.status === 'waiting_human'");
  expect(style).toContain('min-height: 44px');expect(style).toContain('@media (prefers-reduced-motion: reduce)');
  const chatFonts={'.support-bubble':'.875rem','.support-message__sender':'.75rem','.support-message__meta':'.6875rem','.support-input':'.875rem','.support-human':'.75rem','.support-system text':'.8125rem','.support-ai-notice':'.75rem','.support-presence':'.75rem'};
  for(const [selector,size] of Object.entries(chatFonts)){
    const declaration=style.split(`${selector} {`)[1]?.split('}')[0];
    expect(declaration,selector).toMatch(new RegExp(`font-size:\\s*${size.replace('.','\\.')}\\s*;`));
  }
  expect(style).not.toContain('.support-bubble--welcome');
 });
 it("uses owned secure image and order references without adding WebSocket or AI framework dependencies",async()=>{
  const [app,user,userView,operator,operatorView,lock]=await Promise.all([read("apps/miniprogram/app.json"),read("apps/miniprogram/pages/support/index.ts"),read("apps/miniprogram/pages/support/index.wxml"),read("apps/miniprogram/pages/management-support-chat/index.ts"),read("apps/miniprogram/pages/management-support-chat/index.wxml"),read("package-lock.json")]);
  expect(app).not.toContain("connectSocket");expect(user).toContain("wx.chooseMedia");expect(user).toContain("/v1/me/support/media/authorize");expect(user).toContain("linkedOrderId");
  expect(userView).toContain("图片");expect(userView).toContain("拍照");expect(userView).toContain("选择订单");expect(operator).toContain("downloadPrivateMedia");expect(operatorView).toContain("operator-order-card");
  expect(lock).not.toContain("@langchain/langgraph");
 });
});
