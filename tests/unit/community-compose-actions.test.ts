// @vitest-environment jsdom
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";

const simulate = createRequire(import.meta.url)("miniprogram-simulate");
const markup = readFileSync("apps/miniprogram/pages/community-compose/index.wxml", "utf8");
const start = markup.indexOf('<view wx:if="{{!listMode && !loading && !publicationComplete && postId');
const template = markup.slice(start, markup.indexOf('<view wx:if="{{mediaDragging}}"', start));
const mounted: any[] = [];
afterEach(() => { for (const page of mounted.splice(0)) page.detach(); document.body.innerHTML = ""; });
function render(patch: Record<string, unknown> = {}) {
  const id = simulate.load({ template, data: {
    listMode: false, loading: false, postId: "synthetic-post", state: "draft", keyboardVisible: false,
    busy: false, mediaDragging: false, uploadBusy: false, recoveryBusy: false, writeRecovery: "", imageEditRecovery: false,
    publicGateLoaded: true, publicGateEnabled: true, publicGateUnknown: false, operation: "idle", ...patch
  } });
  const page = simulate.render(id); page.attach(document.body); mounted.push(page); return page;
}

it.each(["draft", "rejected", "published"])("keeps separate draft and publish actions visible for editable %s content", state => {
  const page = render({ state, publicGateEnabled: false });
  expect(page.querySelector(".composer-actions__save").dom.textContent).toBe("存草稿");
  expect(page.querySelector(".composer-actions__submit")?.dom.textContent).toBe("去发布");
  expect(page.querySelector(".composer-actions__submit").dom.className).toContain("primary--disabled");
  expect(page.dom.textContent).toContain("公开发布暂未开放");
});

it("keeps both controls mounted when publication availability changes", () => {
  const page = render({ publicGateEnabled: false });
  const save = page.querySelector(".composer-actions__save").dom, publish = page.querySelector(".composer-actions__submit")?.dom;
  expect(publish).toBeTruthy();
  page.setData({ publicGateEnabled: true });
  expect(page.querySelector(".composer-actions__save").dom).toBe(save);
  expect(page.querySelector(".composer-actions__submit").dom).toBe(publish);
  expect(publish.className).not.toContain("primary--disabled");
  expect(publish.textContent).toBe("去发布");
  expect(page.dom.textContent).not.toMatch(/审核|公开发布暂未开放/);
});

it("offers a retry when publication availability cannot be checked", () => {
  const page = render({ publicGateEnabled: false, publicGateUnknown: true });
  expect(page.querySelector(".composer-actions__gate-retry")?.dom.textContent).toContain("点此重试");
  expect(page.querySelector(".composer-actions__save").dom.className).not.toContain("secondary--disabled");
});

it.each(["uploadBusy", "writeRecovery", "imageEditRecovery", "mediaDragging"])("explains %s while preventing duplicate actions", key => {
  const page = render({ [key]: key === "writeRecovery" ? "save" : true });
  expect(page.querySelector(".composer-actions__save").dom.className).toContain("secondary--disabled");
  expect(page.querySelector(".composer-actions__submit").dom.className).toContain("primary--disabled");
  expect(page.querySelector(".composer-actions__hint")?.dom.textContent.trim()).toBeTruthy();
});

it.each([{ keyboardVisible: true }, { listMode: true }, { loading: true }, { publicationComplete: true }, { state: "hidden" }, { state: "pending_review" }])("keeps the existing non-editing/keyboard footer boundary: %j", state => {
  expect(render(state).querySelector(".composer-actions")).toBeFalsy();
});
