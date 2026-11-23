// @vitest-environment jsdom
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";

const simulate = createRequire(import.meta.url)("miniprogram-simulate");
const template = readFileSync("apps/miniprogram/pages/settings/index.wxml", "utf8");
const empty = simulate.load({ template: "<view></view>" });
const rendered: any[] = [];
function mount(patch: Record<string, unknown> = {}) {
  const id = simulate.load({ template, data: {
    loading: false, sessionStatus: "valid", profileReady: true,
    memberCode: "TESTCODE0001", displayName: "合成会员",
    addresses: [], addressesReady: true, addressesLoading: false, addressesError: "",
    consents: [], editingProfile: false, editingAddresses: false,
    careProfileOpen: false, canManageMembers: false, ...patch
  }, usingComponents: { "address-editor": empty, "care-onboarding": empty, "points-celebration": empty } });
  const view = simulate.render(id);
  view.attach(document.body);
  rendered.push(view);
  return view;
}
const status = (view: any) => view.dom.querySelector(".settings-row--status .settings-row__subtitle")?.textContent;
const address = (view: any) => [...view.dom.querySelectorAll(".settings-row")]
  .find((row: any) => row.textContent.includes("收货地址")) as HTMLElement;
afterEach(() => { for (const view of rendered.splice(0)) { view.detach(); } });

it("does not turn pending or failed authorization reads into a confirmed empty result", () => {
  expect(status(mount({ loading: true, sessionStatus: "unknown" }))).not.toContain("尚无");
  expect(status(mount({ sessionStatus: "unknown", error: "许可记录暂时无法加载" }))).toContain("暂未确认");
  expect(status(mount({ sessionStatus: "invalid", errorAction: "auth" }))).not.toContain("尚无");
  expect(mount().dom.textContent).not.toContain("内容使用授权");
});

it("keeps historical authorization purposes and dates visible without offering withdrawal again", () => {
  const view = mount({ consents: [
    { id: "synthetic-a", purposeLabel: "保存投稿资料", statusLabel: "已撤回", grantedDate: "2026-11-21", canRevoke: false },
    { id: "synthetic-b", purposeLabel: "社区精选展示", statusLabel: "已失效", grantedDate: "", canRevoke: false }
  ] });
  expect(view.dom.textContent).toContain("保存投稿资料");
  expect(view.dom.textContent).toContain("授权于 2026-11-21");
  expect(view.dom.querySelectorAll(".consent-item .text-button")).toHaveLength(0);
});

it("keeps withdrawal available only on currently active records", () => {
  const view = mount({ consents: [
    { id: "synthetic-a", purposeLabel: "保存投稿资料", statusLabel: "已授权", canRevoke: true },
    { id: "synthetic-b", purposeLabel: "社区精选展示", statusLabel: "已撤回", canRevoke: false }
  ] });
  expect(view.dom.querySelectorAll(".consent-item .text-button")).toHaveLength(1);
});

it("distinguishes an address read failure, an update and confirmed empty addresses", () => {
  expect(address(mount({ addressesReady: false, addressesError: "合成离线" })).textContent).toContain("暂未更新");
  expect(address(mount({ addressesReady: true, addressesLoading: true })).textContent).toContain("正在更新");
  expect(address(mount()).textContent).toContain("尚未添加收货地址");
});

it("does not leave an admin section or duplicate heading in an ordinary member's settings", () => {
  expect(mount().dom.textContent).not.toContain("管理工具");
  expect(mount({ canManageMembers: true }).dom.textContent.match(/管理工具/g)).toHaveLength(1);
  expect(mount().dom.textContent).not.toContain("账号与服务");
});

it("keeps one user-code copy destination without redundant About or environment details", () => {
  const view = mount();
  expect(view.dom.textContent.match(/TESTCODE0001/g)).toHaveLength(1);
  expect(view.dom.textContent).not.toContain("会员编号");
  expect(view.dom.textContent).not.toContain("关于 CISME");
  expect(view.dom.textContent).not.toContain("运行环境");
  expect(template).toMatch(/<button[^>]*settings-row--copy[^>]*aria-label="复制用户编号"/);
});
