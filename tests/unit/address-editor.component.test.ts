// @vitest-environment jsdom
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyAddressDraft } from "../../apps/miniprogram/services/address-draft";

const require = createRequire(import.meta.url);
const simulate = require("miniprogram-simulate") as {
  load(path: string, options?: Record<string, unknown>): string;
  render(id: string, properties?: Record<string, unknown>): any;
};
const componentPath = resolve(process.cwd(), "apps/miniprogram/components/address-editor/index");
const componentId = simulate.load(componentPath, { compiler: "simulate" });

function renderEditor(overrides: Record<string, unknown> = {}) {
  const component = simulate.render(componentId, { draft: emptyAddressDraft(1, 0.5), ...overrides });
  component.attach(document.body);
  return component;
}

describe("address editor custom component", () => {
  it("renders quick fill, native region picker contract, and explicit label-button geometry hooks", () => {
    const component = renderEditor({ quickInput: "林女士 13800000001 广东省深圳市南山区" });
    expect(component.querySelector(".quick-fill__input")).toBeTruthy();
    expect(component.dom.querySelector("wx-picker")).toBeTruthy();
    expect(component.querySelectorAll(".label-option")).toHaveLength(3);
    expect(component.querySelector(".label-option--selected").dom.textContent).toContain("家");
    expect(component.dom.textContent).toContain("粘贴并识别");
    const source = readFileSync(`${componentPath}.wxml`, "utf8");
    expect(source).toContain('<picker mode="region"');
    expect(source).toContain('bindchange="emitRegion"');
    expect(source).toContain("aria-checked");
    expect(readFileSync(`${componentPath}.js`, "utf8")).toContain('styleIsolation: "isolated"');
    expect(readFileSync(resolve(process.cwd(), "apps/miniprogram/pages/settings/index.wxss"), "utf8")).not.toContain(".label-option");
    component.detach();
  });

  it("surfaces field errors, parsing feedback, conflict actions and disabled state", () => {
    const component = renderEditor({ busy: true, parseStatus: "partial", parseSummary: "已识别：联系电话", parseWarnings: ["仍需补充：收货人"], fieldErrors: { region: "请确认行政区划" }, conflict: true });
    expect(component.dom.textContent).toContain("仍需补充：收货人");
    expect(component.dom.textContent).toContain("请确认行政区划");
    expect(component.dom.textContent).toContain("加载服务器版本");
    expect(component.querySelectorAll(".is-disabled").length).toBeGreaterThan(3);
    component.detach();
  });

  it("emits a semantic label change instead of leaking native button padding behavior", () => {
    const component = renderEditor();
    let selected = "";
    component.addEventListener("labelchange", (event: { detail: { label: string } }) => { selected = event.detail.label; });
    component.instance.emitLabel({ currentTarget: { dataset: { label: "company" } } });
    expect(selected).toBe("company");
    component.detach();
  });
});
