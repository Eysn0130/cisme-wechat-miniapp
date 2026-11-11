// @vitest-environment jsdom
import {nativePageTemplate} from "../helpers/native-page-template";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ token: "member-a", revision: 0, origin: "https://synthetic.invalid", request: vi.fn(), authority: vi.fn() }));
vi.mock("../../apps/miniprogram/services/api", () => ({
  request: m.request, requireMemberAccess: () => Boolean(m.token), retainMemberSnapshot: () => true,
  requireHistoricalCommerceAccess: () => Boolean(m.token), historicalCommerceToken: () => m.token, historicalCommerceClosed: () => false,
  submissionReturnUrl: () => "", clearAuthenticationRedirectSuppression: vi.fn(), resumeAuthentication: vi.fn(), beginLegalRenewal: vi.fn()
}));
vi.mock("../../apps/miniprogram/services/layout", () => ({ currentChromeStyle: () => "", shouldReduceMotion: () => true, motionDuration: () => 0 }));
vi.mock("../../apps/miniprogram/services/share", () => ({ registerIncomingShare: vi.fn(), prepareShareLink: async () => "" }));
vi.mock("../../apps/miniprogram/services/commerce-command-store", () => ({ commerceContextRevision: () => m.revision }));
vi.mock("../../apps/miniprogram/services/member-avatar", () => ({
  defaultMemberAvatar: "/neutral-avatar", localMemberAvatar: async () => "/confirmed-avatar",
  prepareFeedPage: async (page: any) => page.items, prepareFeedAuthors: async (items: any) => items
}));
vi.mock("../../apps/miniprogram/services/authority", () => ({
  authorityProjection: m.authority, hasNativeManagementEntry: (authority: any) => Boolean(authority?.managementAvailable)
}));

const simulate = createRequire(import.meta.url)("miniprogram-simulate");
const later = () => {
  let resolve!: (value: any) => void, reject!: (error: any) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 70; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
const dailyRecord = {
  id: "11111111-1111-4111-8111-111111111111", source: "daily", careDay: "2026-11-03", version: 1,
  deleted: false, operationId: "synthetic-daily-operation", completedAt: "2026-11-03T10:00:00Z",
  updatedAt: "2026-11-03T10:00:00Z", timezone: "Asia/Shanghai", protocolVersion: "daily-care-v1",
  stepCodes: ["00", "01", "02", "03"], selfAssessment: "neutral"
};
const dailyPage = (items: any[] = [dailyRecord]) => ({
  items, loadedCount: items.length, hasMore: false, nextCursor: null, serverDay: "2026-11-03",
  today: items.find(row => row.careDay === "2026-11-03") ?? null, totalCount: items.length
});
const task = { id: "synthetic-task", name: "合成邀请", claimable: true };
const story = { id: "22222222-2222-4222-8222-222222222222", title: "合成护理故事", author: "合成作者", authorId: "author-a", coverUrl: null, avatar: "", likeCount: 0, saveCount: 0, publishedAt: "2026-11-03T10:00:00Z" };
const authorId = "33333333-3333-4333-8333-333333333333";
const product = { id: "synthetic-product", code: "synthetic-product", name: "合成商品", price: 2000, image: null, purchaseEnabled: true,
  variants: ["sku-a", "sku-b"].map(id => ({ id, active: true, inStock: true, availableQuantity: 10, purchaseEnabled: true, label: id })) };
let pages: any[], components: any[], replies: Map<string, any>, held: Map<string, ReturnType<typeof later>>, wxMock: any;

async function mount(route: string, template?: string) {
  let definition: any;
  (globalThis as any).Page = (value: any) => { definition = value; };
  await import(`../../apps/miniprogram/pages/${route}/index.ts`);
  let rendered: any;
  const samples: string[] = [];
  const states: any[] = [];
  const patches: any[] = [];
  const page: any = { ...definition, data: structuredClone(definition.data),
    setData(patch: any, callback?: () => void) {
      patches.push(structuredClone(patch));
      for (const [path, value] of Object.entries(patch)) {
        const keys = path.replace(/\[(\d+)\]/g, ".$1").split(".");
        let target = this.data;
        for (const key of keys.slice(0, -1)) target = target[key];
        target[keys[keys.length - 1]!] = value;
      }
      states.push(structuredClone(this.data));
      // The JS renderer leaks nested default `item` aliases across partial updates.
      // Render the complete serializable state; native bridge behavior is checked separately.
      if (rendered) { rendered.setData(structuredClone(this.data)); samples.push(rendered.dom.textContent); }
      callback?.();
    }
  };
  pages.push(page);
  // This suite exercises tab snapshots with onboarding closed. The full native
  // onboarding component is exercised by care-onboarding-native.test.ts.
  const id = simulate.load({ template: template ?? nativePageTemplate(`apps/miniprogram/pages/${route}/index.wxml`), data: structuredClone(page.data),
    usingComponents:{'care-onboarding':simulate.load({template:'<view></view>'})} });
  rendered = simulate.render(id);
  rendered.attach(document.body);
  components.push(rendered);
  return { page, rendered, samples, states, patches };
}

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  m.token = "member-a"; m.revision = 0; m.origin = "https://synthetic.invalid";
  pages = []; components = []; held = new Map();
  const member = { id: "member-a", display_name: "合成会员", profile_revision: 1 };
  replies = new Map<string, any>([
    ["/v1/bootstrap/home", { member, care: null, businessVersion: 1 }],
    ["/v1/bootstrap/profile", { member, points: { projection: { available: 20, frozen: 0, debt: 0, reserved: 0, version: 1 } }, care: null, businessVersion: 1 }],
    ["/v1/me/care", null], ["/v1/me/daily-care-records?limit=20", dailyPage()],
    ["/v1/me/tasks", [task]], ["/v1/me/support/summary", { unreadCount: 2 }],
    ["/v1/me/commercial-membership", { eligible: true, membershipState: "active", verifiedOrderCount: 1, commission: { netEarnedCents: 0 } }],
    ["/v1/capabilities", { communityPreviewEnabled: false }], ["/v1/ugc/status", { publicEnabled: false, draftsEnabled: false }],
    ["/v1/feed/page?limit=30", { items: [], authors: {} }], ["/v1/ugc/posts?limit=30", { items: [], nextCursor: null }],
    ["/v1/editorial/articles?limit=20", { items: [story], nextCursor: null }], ["/v1/me/community-access", { canReview: false }]
  ]);
  replies.set("/v1/me/points?limit=20&source=all", { projection: { available: 20, frozen: 0, debt: 0,reserved:0,version:1 }, entries: [], rulesEnabled: true,nextCursor:null,totalCount:0,lifetimeEarned:20,used:0,expired:0,expiring:{points:0,earliestAt:null,withinDays:30},clubPolicy:null });
  replies.set('/v1/me/points/club',{memberId:authorId,enabled:false,policy:null,serverDay:'2026-11-10',checkedIn:false,streak:0,today:null,badges:[],pendingRewardSources:0,birthday:null,questionnaireCompleted:false});
  replies.set('/v1/me/points/gifts',{enabled:false,items:[]});replies.set('/v1/me/points/redemptions',{items:[],nextCursor:null});replies.set('/v1/me/addresses',{addresses:[]});
  replies.set("/v1/tasks/synthetic-task", { ...task, reward_enabled: false });
  replies.set("/v1/submissions/synthetic-submission", { id: "synthetic-submission", status: "rejected", media: [], version: 1, review: { reason_summary: "合成审核说明" } });
  replies.set("/v1/catalog?limit=20", { items: [product], nextCursor: null });
  replies.set("/v1/catalog/synthetic-product", product);
  replies.set(`/v1/community/authors/${authorId}?limit=20`, { author: { id: authorId, name: "合成作者", avatar:"",avatarRevision:null,membershipLabel:"CISME会员",bio:"",bioRevision:null,following:false,isMine:false,canFollow:true,followArticleId:story.id,postCount:1 }, items:[{...story,authorId,kind:"editorial"}], nextCursor: null });
  replies.set("/v1/me", member); replies.set("/v1/me/shares?targetType=invite", []);
  replies.set("/v1/me/orders?limit=20", { items: [{ id: "synthetic-order", status: "paid", createdAt: "2026-11-03T10:00:00Z", totalCents: 2000, orderNumber: "SYNTHETIC", lines: [{ productName: "合成商品", skuLabel: "规格甲", quantity: 1 }] }], nextCursor: null });
  m.request.mockImplementation(async ({ path }: any) => {
    if (held.has(path)) return held.get(path)!.promise;
    if (!replies.has(path)) throw new Error(`Unexpected synthetic route: ${path}`);
    return replies.get(path);
  });
  m.authority.mockResolvedValue({ managementAvailable: true, capabilities: ["support.read"] });
  wxMock = { disableAlertBeforeUnload: vi.fn(), enableAlertBeforeUnload: vi.fn(), navigateTo: vi.fn(), switchTab: vi.fn(),
    showToast: vi.fn(), pageScrollTo: vi.fn(), hideShareMenu: vi.fn(), showShareMenu: vi.fn(), nextTick: (callback: () => void) => callback() };
  Object.assign(globalThis, { wx: wxMock, getApp: () => ({ globalData: { sessionToken: m.token, apiBaseUrl: m.origin, cloudFunction: null } }), getCurrentPages: () => [] });
});
afterEach(() => {
  for (const page of pages) page.onUnload?.();
  for (const component of components) component.detach();
  document.body.innerHTML = "";
});

describe("native tab return presentation while real read paths revalidate", () => {
  it("renders both columns through real incremental bridge patches without aliasing cards or remounting columns", () => {
    const wxml = nativePageTemplate("apps/miniprogram/pages/community/index.wxml");
    const template = wxml.slice(wxml.indexOf('<view class="feed-grid">'), wxml.indexOf('<view wx:if="{{moreError}}"'));
    const id = simulate.load({ template, data: { feedColumns: [[], []], navigating: false } });
    const rendered = simulate.render(id); rendered.attach(document.body); components.push(rendered);
    const columns = rendered.querySelectorAll(".feed-column").map((column: any) => column.dom);
    const card = (id: string, title: string) => ({ id, title, author: "合成作者", image: "", avatar: "", engagementLabel: "" });
    rendered.setData({ "feedColumns[0]": [card("left", "左列故事")] });
    rendered.setData({ "feedColumns[1]": [card("right", "右列故事")] });
    expect(columns[0].textContent).toContain("左列故事");
    expect(columns[0].textContent).not.toContain("右列故事");
    expect(columns[1].textContent).toContain("右列故事");
    rendered.setData({ "feedColumns[0][0].title": "左列更新" });
    expect(columns[0].textContent).toContain("左列更新");
    rendered.setData({ feedColumns: [[], []] });
    expect(rendered.querySelectorAll(".feed-card")).toHaveLength(0);
    rendered.setData({ feedColumns: [[card("new-left", "新左列")], [card("new-right", "新右列")]] });
    expect(rendered.querySelectorAll(".feed-column").map((column: any) => column.dom)).toEqual(columns);
    expect(columns[0].textContent).toContain("新左列");
    expect(columns[1].textContent).toContain("新右列");
  });

  it.each(["/v1/capabilities", "/v1/me/community-access", "/v1/feed/page?limit=30", "/v1/ugc/posts?limit=30"])("renders returned Featured content while ancillary %s is still pending", async path => {
    const pending = later(); held.set(path, pending);
    const { page, rendered, states } = await mount("community");
    const reading = page.load();
    try {
      await flush();
      expect(page.data).toMatchObject({ loading: false, feedReady: true, displayFeedCount: 1 });
      expect(rendered.querySelector(".feed-card").dom.textContent).toContain(story.title);
      const firstReady = states.find(state => state.feedReady);
      expect(firstReady.feedColumns.flat()).toHaveLength(1);
      expect(firstReady.displayFeedCount).toBe(1);
    } finally { pending.resolve(replies.get(path)); await reading; }
  });

  it("does not reset the two empty column arrays on the first Community read", async () => {
    const pending = later(); held.set("/v1/editorial/articles?limit=20", pending);
    const { page, patches } = await mount("community"); const reading = page.load();
    try {
      await flush();
      expect(patches.filter(patch => "feedColumns" in patch)).toEqual([]);
    } finally { pending.resolve({ items: [story], nextCursor: null }); await reading; }
  });

  it("clears previously visible Featured cards immediately when its authoritative read fails, even while capabilities are pending", async () => {
    const { page, rendered } = await mount("community"); await page.load();
    const capabilities = later(), editorial = later();
    held.set("/v1/capabilities", capabilities); held.set("/v1/editorial/articles?limit=20", editorial);
    const reading = page.load();
    try {
      editorial.reject({status:503}); await flush();
      expect(page.data).toMatchObject({loading:false,feedReady:false,displayFeedCount:0,error:expect.stringContaining("无法加载")});
      expect(rendered.querySelector(".feed-card")).toBeFalsy();
      expect(rendered.querySelector(".state-error__action").dom.textContent).toContain("重新加载");
    } finally { capabilities.resolve(replies.get("/v1/capabilities")); await reading; }
  });

  it("retains the Home signal throughout a delayed return and applies the new daily fact", async () => {
    const { page, rendered, samples } = await mount("home");
    await page.load(); await flush();
    const signal = rendered.querySelector(".care-signal").dom;
    const daily = later(), core = later();
    held.set("/v1/me/daily-care-records?limit=20", daily); held.set("/v1/bootstrap/home", core);
    page.onHide(); page.onShow(); await flush();
    expect(page.data).toMatchObject({ loading: true, dailyLoading: true, supportUnread: 2 });
    expect(rendered.querySelector(".care-signal").dom).toBe(signal);
    expect(signal.textContent).toContain("今天的护理已记录");
    expect(signal.textContent).not.toMatch(/加载|读取/);
    await page.primaryAction(); expect(page.data.sessionMounted).toBe(false);
    samples.length = 0;
    core.resolve(replies.get("/v1/bootstrap/home")); await flush();
    expect(samples.join("\n")).not.toMatch(/从四步护理开始|正在读取|正在加载/);
    daily.resolve(dailyPage([])); await flush();
    expect(signal.textContent).toContain("今天还未记录");
    expect(m.request.mock.calls.filter(([options]) => options.method && options.method !== "GET")).toEqual([]);
  });

  it("keeps Home cold loading and clears retained daily facts when preservation is denied", async () => {
    const { page, rendered } = await mount("home");
    const read = later(); held.set("/v1/bootstrap/home", read);
    const cold = page.load(); await flush();
    expect(rendered.dom.textContent).toContain("正在加载护理安排");
    read.resolve(replies.get("/v1/bootstrap/home")); await cold; await flush();
    held.delete("/v1/bootstrap/home");
    const daily = later(); held.set("/v1/me/daily-care-records?limit=20", daily);
    await page.load(false);
    expect(page.data).toMatchObject({ dailyReady: false, dailyToday: null, serverDay: "" });
    expect(page.data.view.signalTitle).toBe("正在读取日常护理记录");
    page.onHide(); daily.resolve(dailyPage()); await flush();
    expect(page.data.dailyToday).toBeNull();
  });

  it("keeps Profile cards mounted through independent core, daily, tasks and authority reads", async () => {
    const { page, rendered, samples } = await mount("profile");
    await page.load(); await flush();
    const card = rendered.querySelector(".member-card").dom;
    const original = card.textContent;
    for (const path of ["/v1/bootstrap/profile", "/v1/me/daily-care-records?limit=20", "/v1/me/tasks", "/v1/me/commercial-membership", "/v1/me/support/summary"]) held.set(path, later());
    const authority = later(); m.authority.mockReturnValue(authority.promise);
    page.onHide(); page.onShow(); await flush();
    expect(rendered.querySelector(".member-card").dom).toBe(card);
    expect(card.textContent).toBe(original);
    expect(rendered.querySelector(".profile-sync-status")).toBeFalsy();
    expect(rendered.dom.textContent).toContain("2 条未读回复");
    expect(rendered.dom.textContent).not.toContain("正在查看活动");
    page.openManagement(); expect(wxMock.navigateTo).not.toHaveBeenCalled();
    samples.length = 0;
    held.get("/v1/bootstrap/profile")!.resolve({ ...replies.get("/v1/bootstrap/profile"), points: { projection: { available: 35, frozen: 0, debt: 0, reserved: 0, version: 1 } }, businessVersion: 2 });
    await flush();
    expect(samples.join("\n")).not.toMatch(/尚无护理周期|正在读取日常护理记录/);
    expect(rendered.querySelector(".member-card").dom.textContent).toContain("35");
    held.get("/v1/me/daily-care-records?limit=20")!.resolve(dailyPage([]));
    held.get("/v1/me/tasks")!.resolve([]);
    held.get("/v1/me/commercial-membership")!.resolve({ eligible: false, membershipState: "none", verifiedOrderCount: 0, commission: { netEarnedCents: 0 } });
    held.get("/v1/me/support/summary")!.resolve({ unreadCount: 0 });
    authority.resolve({ managementAvailable: false, capabilities: [] }); await flush();
    expect(card.textContent).toContain("35");
    expect(card.textContent).not.toContain("护理");
    expect(rendered.dom.textContent).not.toMatch(/管理中心|商业资格与佣金|2 条未读回复/);
  });

  it("clears Profile on actor change and ignores an older result after a fast hide/show", async () => {
    const { page } = await mount("profile"); await page.load(); await flush();
    const old = later(); held.set("/v1/bootstrap/profile", old);
    page.onHide(); page.onShow(); await flush(); page.onHide();
    m.token = "member-b"; const current = later(); held.set("/v1/bootstrap/profile", current);
    held.set("/v1/me/tasks", later()); held.set("/v1/me/daily-care-records?limit=20", later());
    page.onShow(); await flush();
    expect(page.data).toMatchObject({ member: null, retainingSnapshot: false });
    expect(page.dailySnapshot).toBeNull();
    old.resolve(replies.get("/v1/bootstrap/profile")); await flush(); expect(page.data.member).toBeNull();
    current.resolve({ ...replies.get("/v1/bootstrap/profile"), member: { id: "member-b", display_name: "另一位合成会员", profile_revision: 1 } });
    await flush(); expect(page.data.member.id).toBe("member-b");
  });

  it("reports an actual Profile revalidation failure and removes unconfirmed privilege entries", async () => {
    const { page, rendered } = await mount("profile"); await page.load(); await flush();
    m.authority.mockRejectedValue({ status: 403 });
    const commercial = later(); held.set("/v1/me/commercial-membership", commercial);
    const daily = later(); held.set("/v1/me/daily-care-records?limit=20", daily);
    const reading = page.load(undefined, true);
    commercial.reject({ status: 503 }); daily.reject({ status: 503 }); await reading; await flush();
    expect(rendered.dom.textContent).toContain("身份待更新");
    expect(rendered.dom.textContent).not.toContain("日常护理记录暂未更新");
    expect(rendered.dom.textContent).toContain("重试");
    expect(rendered.dom.textContent).not.toMatch(/管理中心|商业资格与佣金/);
    page.openManagement(); expect(wxMock.navigateTo).not.toHaveBeenCalled();
  });

  it.each(["member-a", ""])("keeps Community cards in place on a delayed return for viewer %s", async token => {
    m.token = token;
    const { page, rendered } = await mount("community"); await page.load(); await flush();
    const card = rendered.querySelector(".feed-card").dom;
    const editorial = later(); held.set("/v1/editorial/articles?limit=20", editorial);
    const tasks = later(); held.set("/v1/me/tasks", tasks);
    page.onHide(); page.onShow(); await flush();
    expect(rendered.querySelector(".feed-card").dom).toBe(card);
    expect(rendered.querySelector(".community-loading")).toBeFalsy();
    expect(card.textContent).toContain(story.title);
    expect(rendered.dom.textContent).not.toContain(task.name);
    editorial.resolve({ items: [{ ...story, title: "更新后的合成故事" }], nextCursor: null });
    tasks.resolve([task]); await flush();
    expect(rendered.querySelector(".feed-card").dom).toBe(card);
    expect(card.textContent).toContain("更新后的合成故事");
    expect(m.request.mock.calls.filter(([options]) => options.path === "/v1/editorial/articles?limit=20")).toHaveLength(2);
  });

  it.each(["actor", "environment"])("clears Community snapshots before reading a different %s", async kind => {
    const { page, rendered } = await mount("community"); await page.load(); await flush();
    if (kind === "actor") m.token = "member-b"; else { m.revision++; m.origin = "https://other-synthetic.invalid"; }
    const editorial = later(); held.set("/v1/editorial/articles?limit=20", editorial);
    const tasks = later(); held.set("/v1/me/tasks", tasks);
    page.onHide(); page.onShow(); await flush();
    expect(rendered.querySelector(".feed-card")).toBeFalsy();
    expect(page.data.tasks).toBeUndefined();
    editorial.resolve({ items: [], nextCursor: null }); tasks.resolve([]); await flush();
    expect(rendered.dom.textContent).toContain("还没有精选内容");
  });

  it("retains the Records count and list during refresh and replaces them with new confirmed facts", async () => {
    const { page, rendered } = await mount("records"); await page.load(); await flush();
    const row = rendered.querySelector(".record-row").dom;
    const daily = later(); held.set("/v1/me/daily-care-records?limit=20", daily);
    page.onHide(); page.onShow(); await flush();
    expect(rendered.querySelector(".record-row").dom).toBe(row);
    expect(rendered.querySelector(".records-summary").dom.textContent).toBe("已记录 1 天");
    expect(rendered.dom.textContent).not.toMatch(/正在加载日常/);
    daily.resolve(dailyPage([])); await flush();
    expect(rendered.querySelector(".records-summary").dom.textContent).toBe("已记录 0 天");
    expect(rendered.dom.textContent).toContain("还没有护理记录");
  });

  it("retains a confirmed empty Records card while rechecking instead of replacing it with a loading list", async () => {
    replies.set("/v1/me/daily-care-records?limit=20", dailyPage([]));
    const { page, rendered } = await mount("records"); await page.load(); await flush();
    const empty = rendered.querySelector(".records-empty").dom;
    const daily = later(); held.set("/v1/me/daily-care-records?limit=20", daily);
    page.onHide(); page.onShow(); await flush();
    expect(rendered.querySelector(".records-empty").dom).toBe(empty);
    expect(rendered.querySelector(".record-list--recent")).toBeFalsy();
    expect(rendered.dom.textContent).not.toContain("正在加载日常");
    daily.resolve(dailyPage()); await flush();
    expect(rendered.querySelector(".records-empty")).toBeFalsy();
    expect(rendered.querySelector(".record-row")).toBeTruthy();
  });

  it.each([
    ["points", "/v1/me/points?limit=20&source=all", ".points-hero", {}],
    ["shop", "/v1/catalog?limit=20", ".shop-hero", {}],
    ["product", "/v1/catalog/synthetic-product", ".product-gallery", { id: "synthetic-product" }],
    ["community-author", `/v1/community/authors/${authorId}?limit=20`, ".author-head", { authorId, editorialSource: true }],
    ["invite", "/v1/me", ".invite-card", {}],
    ["orders", "/v1/me/orders?limit=20", ".order-card", {}]
  ])("keeps %s content mounted on return while its actual read remains pending", async (route, path, selector, initial) => {
    const { page, rendered } = await mount(route as string); page.setData(initial);
    if (route === "community-author") page.lastSessionToken = m.token;
    if(route==='points'){page.visible=true;page.token=m.token;page.context=m.revision;}
    await page.load(); await flush();
    const card = rendered.querySelector(selector).dom, text = card.textContent;
    const pending = later(); held.set(path as string, pending);
    page.onHide(); page.onShow(); await flush();
    expect(rendered.querySelector(selector).dom).toBe(card);
    expect(card.textContent).toBe(text);
    expect(rendered.querySelector(".page-read-loading")).toBeFalsy();
    expect(page.data.loading || page.data.refreshing).toBe(true);
    pending.resolve(replies.get(path as string)); await flush();
    expect(page.data.loading).toBe(false);
    expect(m.request.mock.calls.filter(([input]) => input.path === path)).toHaveLength(2);
  });

  it("keeps the confirmed empty author state while returning to an author with no public stories", async () => {
    const path = `/v1/community/authors/${authorId}?limit=20`;
    replies.set(path, { author: { id: authorId, name: "合成作者", avatar:"",avatarRevision:null,membershipLabel:"CISME会员",bio:"",bioRevision:0,following:false,isMine:true,canFollow:true,followArticleId:null,postCount:0 }, items:[], nextCursor: null });
    const { page, rendered } = await mount("community-author");
    page.setData({ authorId, editorialSource: true }); page.lastSessionToken = m.token;
    await page.load(); await flush();
    const empty = rendered.querySelector(".author-empty").dom;
    const pending = later(); held.set(path, pending);
    page.onHide(); page.onShow(); await flush();
    expect(page.data).toMatchObject({ loading: true, author: { postCount: 0 }, feedColumns:[[],[]] });
    expect(rendered.querySelector(".author-empty").dom).toBe(empty);
    expect(empty.textContent).toContain("还没有故事");
    pending.resolve(replies.get(path)); await flush();
  });

  it("preserves a valid product selection while refreshing and clamps quantity to freshly confirmed inventory", async () => {
    const { page, rendered } = await mount("product"); page.setData({ id: "synthetic-product" }); await page.load();
    page.openSku(); page.selectSku({ currentTarget: { dataset: { id: "sku-b" } } }); page.confirmSku(); page.setData({ quantity: 4 });
    const pending = later(); held.set("/v1/catalog/synthetic-product", pending);
    const reading = page.load(); await flush();
    expect(page.data).toMatchObject({ selectedSku: { id: "sku-b" }, quantity: 4, loading: true });
    page.openCheckout(); expect(wxMock.navigateTo).not.toHaveBeenCalled();
    expect(rendered.querySelector(".page-read-loading")).toBeFalsy();
    pending.resolve({ ...product, variants: product.variants.map(sku => ({ ...sku, availableQuantity: 2 })) });
    await reading;
    expect(page.data).toMatchObject({ selectedSku: { id: "sku-b" }, quantity: 2, loading: false });
  });

  it("retains a public article on same-viewer return, uses a non-flow cold indicator and clears a withdrawn article", async () => {
    m.token = "";
    const article = { ...story, version: 1, body: "合成正文", media: [], interactionsEnabled: false, commentsEnabled: false };
    const path = `/v1/editorial/articles/${story.id}`; replies.set(path, article);
    const { page, rendered } = await mount("post"); page.setData({ id: story.id, editorialSource: true });
    const cold = later(); held.set(path, cold); const first = page.load(); await flush();
    expect(rendered.querySelector(".page-read-loading")).toBeTruthy();
    expect(rendered.dom.textContent).not.toMatch(/正在加载护理故事/);
    cold.resolve(article); await first; await flush(); held.delete(path);
    const content = rendered.querySelector(".post-content").dom;
    const pending = later(); held.set(path, pending);
    page.onHide(); page.onShow(); await flush();
    expect(rendered.querySelector(".post-content").dom).toBe(content);
    expect(rendered.querySelector(".page-read-loading")).toBeFalsy();
    pending.reject({ status: 404 }); await flush();
    expect(page.data).toMatchObject({ item: null, media: [], errorKind: "missing", loading: false });
  });

  it("does not flash a login prompt for a signed-in article viewer while private comments are reauthorized", async () => {
    const article = { ...story, version: 1, body: "合成正文", media: [], interactionsEnabled: false, commentsEnabled: true };
    const path = `/v1/editorial/articles/${story.id}`; replies.set(path, article);
    // Isolate these actual controls from the JS renderer's nested `item` alias limit.
    const controls = readFileSync("apps/miniprogram/pages/post/index.wxml", "utf8").split("\n")
      .filter(line => line.includes('class="post-comment-entry ') || line.includes('class="comment-login-mask"')).join("\n");
    const { page, rendered } = await mount("post", controls); page.setData({ id: story.id, editorialSource: true });
    await page.load(); await flush();
    const entryText = rendered.querySelector(".post-comment-entry").dom.textContent;
    const pending = later(); held.set(path, pending);
    page.onHide(); page.onShow(); await flush();
    expect(page.data).toMatchObject({ viewerHasSession: true, commentAuthenticated: false, loading: true, threads: [], editorialCommentItems: [] });
    expect(entryText).toBe("说点什么…");
    expect(rendered.querySelector(".post-comment-entry").dom.textContent).toBe(entryText);
    expect(rendered.querySelector(".comment-login-mask")).toBeFalsy();
    page.startComment(); expect(wxMock.navigateTo).not.toHaveBeenCalled();
    pending.resolve(article); await flush();
    expect(page.data.loading).toBe(false);
  });

  it.each(["actor", "environment", "resource"])("does not retain a Product snapshot after a different %s becomes current", async change => {
    const { page } = await mount("product"); page.setData({ id: "synthetic-product" }); await page.load();
    if (change === "actor") m.token = "member-b";
    else if (change === "environment") { m.revision++; m.origin = "https://another-synthetic.invalid"; }
    else page.setData({ id: "another-product" });
    const path = `/v1/catalog/${page.data.id}`, pending = later(); held.set(path, pending);
    const reading = page.load(); await flush(); expect(page.data.item).toBeNull();
    pending.resolve(null); await reading; expect(page.data.item).toBeNull();
  });

  it("keeps a confirmed empty Community state through a return read", async () => {
    replies.set("/v1/editorial/articles?limit=20", { items: [], nextCursor: null });
    replies.set("/v1/me/tasks", []);
    const { page, rendered } = await mount("community"); await page.load(); await flush();
    const pending = later(); held.set("/v1/editorial/articles?limit=20", pending);
    page.onHide(); page.onShow(); await flush();
    expect(page.data).toMatchObject({ feedReady: true, displayFeedCount: 0, loading: true });
    expect(rendered.dom.textContent).toContain("还没有精选内容");
    expect(rendered.querySelector(".page-read-loading")).toBeFalsy();
    expect(rendered.dom.textContent).not.toContain("正在加载");
    pending.resolve({ items: [], nextCursor: null }); await flush();
  });

  it("keeps the selected empty care-day row in place while revalidating its coverage", async () => {
    const { page, rendered } = await mount("records"); await page.load(); await flush();
    page.selectCalendarDay({ currentTarget: { dataset: { day: "2026-11-02" } } });
    const empty = rendered.querySelector(".review-calendar-empty").dom;
    const pending = later(); held.set("/v1/me/daily-care-records?limit=20", pending);
    page.onHide(); page.onShow(); await flush();
    expect(page.data).toMatchObject({ calendarSelectedDay: "2026-11-02", calendarStale: true, dailyLoading: true });
    expect(rendered.querySelector(".review-calendar-empty").dom).toBe(empty);
    pending.resolve(dailyPage()); await flush();
  });
});
