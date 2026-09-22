import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
const cancelAuthenticationMock = vi.hoisted(() => vi.fn());
const suppressAuthenticationRedirectOnceMock = vi.hoisted(() => vi.fn());
const clearAuthenticationRedirectSuppressionMock = vi.hoisted(() => vi.fn());
const requireMemberAccessMock = vi.hoisted(() => vi.fn(() => true));
const retainMemberSnapshotMock = vi.hoisted(() => vi.fn(() => true));
const resumeAuthenticationMock = vi.hoisted(() => vi.fn());
const uploadAuthorizedMock = vi.hoisted(() => vi.fn());

vi.mock("../../apps/miniprogram/services/api", () => ({
  allowPublicBrowsing: vi.fn(() => true),
  requireMemberAccess: requireMemberAccessMock,
  retainMemberSnapshot: retainMemberSnapshotMock,
  beginAuthentication: vi.fn(),
  cancelAuthentication: cancelAuthenticationMock,
  suppressAuthenticationRedirectOnce: suppressAuthenticationRedirectOnceMock,
  clearAuthenticationRedirectSuppression: clearAuthenticationRedirectSuppressionMock,
  resumeAuthentication: resumeAuthenticationMock,
  consumeAuthReturnUrl: vi.fn(() => "/pages/home/index"),
  navigateAfterAuthentication: vi.fn(async () => "target"),
  request: requestMock,
  uploadAuthorized: uploadAuthorizedMock,
  setSessionToken: vi.fn(),
  submissionReturnUrl: () => "/pages/task/index?id=task-1"
}));

vi.mock("../../apps/miniprogram/services/layout", () => ({
  currentChromeStyle: () => "",
  motionDuration: () => 0,
  shouldReduceMotion: () => false
}));

type PageDefinition = Record<string, any> & { data: Record<string, any> };

let capturedPage: PageDefinition | null = null;
let wxMock: Record<string, ReturnType<typeof vi.fn>>;

function mountedPage(definition: PageDefinition, overrides: Record<string, any> = {}) {
  const context: Record<string, any> = {
    ...definition,
    data: { ...definition.data, ...overrides },
    setData(patch: Record<string, any>, callback?: () => void) {
      Object.assign(this.data, patch);
      callback?.();
    }
  };
  for (const [key, value] of Object.entries(definition)) {
    if (typeof value === "function") context[key] = value;
  }
  return context;
}

beforeEach(() => {
  vi.resetModules();
  requestMock.mockReset();
  cancelAuthenticationMock.mockReset();
  suppressAuthenticationRedirectOnceMock.mockReset();
  clearAuthenticationRedirectSuppressionMock.mockReset();
  requireMemberAccessMock.mockReset();
  requireMemberAccessMock.mockReturnValue(true);
  retainMemberSnapshotMock.mockReset();
  retainMemberSnapshotMock.mockReturnValue(true);
  resumeAuthenticationMock.mockReset();
  uploadAuthorizedMock.mockReset();
  capturedPage = null;
  wxMock = {
    navigateTo: vi.fn(),
    redirectTo: vi.fn(),
    navigateBack: vi.fn(),
    switchTab: vi.fn(),
    showToast: vi.fn(),
    vibrateShort: vi.fn(),
    pageScrollTo: vi.fn(),
    enableAlertBeforeUnload: vi.fn(),
    disableAlertBeforeUnload: vi.fn(),
    getAccountInfoSync: vi.fn(() => ({ miniProgram: { envVersion: "develop" } })),
    getDeviceInfo: vi.fn(() => ({ platform: "devtools" })),
    getStorageSync: vi.fn(() => ""),
    setStorageSync: vi.fn(),
    removeStorageSync: vi.fn(),
    getClipboardData: vi.fn(),
    reLaunch: vi.fn(),
    hideShareMenu: vi.fn(),
    showShareMenu: vi.fn(),
    showModal: vi.fn(),
    requirePrivacyAuthorize: vi.fn(),
    chooseMedia: vi.fn(),
    nextTick: vi.fn((callback: () => void) => callback()),
    stopPullDownRefresh: vi.fn()
  };
  (globalThis as any).wx = wxMock;
  (globalThis as any).getApp = () => ({ globalData: { sessionToken: "" } });
  (globalThis as any).getCurrentPages = () => [];
  (globalThis as any).Page = (definition: PageDefinition) => { capturedPage = definition; };
});

describe("mini-program page behavior", () => {
  it("clears task, review, and settings snapshots before a guest can return from login", async () => {
    retainMemberSnapshotMock.mockReturnValue(false);
    requireMemberAccessMock.mockReturnValue(false);

    await vi.importActual("../../apps/miniprogram/pages/task/index");
    const task = mountedPage(capturedPage!, { task: { id: "previous-task", submission_id: "previous-submission" },
      continuationSubmissionId: "previous-submission", working: true });
    task.onShow();
    expect(task.data).toMatchObject({ task: null, continuationSubmissionId: "", working: false, errorTitle: "请先确认身份" });

    await vi.importActual("../../apps/miniprogram/pages/progress/index");
    const progress = mountedPage(capturedPage!, { submission: { id: "previous-submission", status: "rejected" },
      appealReason: "private appeal", reviewReason: "private review", working: true });
    progress.onShow();
    expect(progress.data).toMatchObject({ submission: null, appealReason: "", reviewReason: "", working: false, errorTitle: "请先确认身份" });

    await vi.importActual("../../apps/miniprogram/pages/settings/index");
    const settings = mountedPage(capturedPage!, { memberId: "previous-member", displayName: "上一位会员",
      phoneMasked: "138****0000", addresses: [{ id: "previous-address" }], addressQuickInput: "旧地址",
      addressDraft: { phone: "13800000000" }, consents: [{ purpose: "private" }], profileDirty: true });
    settings.profileSessionToken = "previous-token";
    settings.addressRecoverySnapshot = { ownerMemberId: "previous-member" };
    settings.onShow();
    expect(settings.data).toMatchObject({ memberId: "", displayName: "", phoneMasked: "", addresses: [],
      addressQuickInput: "", consents: [], profileDirty: false, errorAction: "auth" });
    expect(settings.data.addressDraft.phone).toBe("");
    expect(settings.profileSessionToken).toBe("");
    expect(settings.addressRecoverySnapshot).toBeNull();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("keeps the address deep link after authentication without showing a guest editor", async () => {
    retainMemberSnapshotMock.mockReturnValue(false);
    requireMemberAccessMock.mockReturnValueOnce(false).mockReturnValue(true);
    requestMock.mockImplementation(() => new Promise(() => undefined));
    await vi.importActual("../../apps/miniprogram/pages/settings/index");
    const settings = mountedPage(capturedPage!);
    settings.onLoad({ section: "addresses" });
    settings.onShow();
    expect(settings.data.editingAddresses).toBe(false);
    (globalThis as any).getApp = () => ({ globalData: { sessionToken: "new-member" } });
    settings.onShow();
    expect(settings.data.editingAddresses).toBe(true);
  });

  it("does not import a previous member's WeChat address after the session changes", async () => {
    let session = "member-a";
    (globalThis as any).getApp = () => ({ globalData: { sessionToken: session } });
    wxMock.chooseAddress = vi.fn();
    await vi.importActual("../../apps/miniprogram/pages/settings/index");
    const settings = mountedPage(capturedPage!, { memberId: "member-a", addressesReady: true });
    settings.importWechatAddress();
    const callback = wxMock.chooseAddress.mock.calls[0]![0].success as (result: Record<string, string>) => void;
    session = "member-b";
    settings.data.memberId = "member-b";
    callback({ userName: "上一位会员", telNumber: "13800000000", provinceName: "广东省" });
    expect(settings.data.addressDraft.recipientName).toBe("");
    expect(settings.data.addressDraft.phone).toBe("");
    expect(wxMock.setStorageSync).not.toHaveBeenCalled();
  });

  it("leaves no settings PII visible if the login relaunch fails after logout", async () => {
    wxMock.showModal!.mockResolvedValue({ confirm: true });
    wxMock.reLaunch!.mockImplementation(({ fail }: { fail: () => void }) => fail());
    await vi.importActual("../../apps/miniprogram/pages/settings/index");
    const settings = mountedPage(capturedPage!, { memberId: "previous-member", displayName: "上一位会员",
      phoneMasked: "138****0000", addresses: [{ id: "previous-address" }], consents: [{ purpose: "private" }] });
    await settings.logout();
    expect(settings.data).toMatchObject({ memberId: "", displayName: "", phoneMasked: "", addresses: [], consents: [], loggingOut: false });
    expect(settings.data.error).toContain("会话已经安全退出");
  });

  it("scrubs member-only points, orders, and invitation data before a guest login overlay", async () => {
    retainMemberSnapshotMock.mockReturnValue(false);
    requireMemberAccessMock.mockReturnValue(false);

    await vi.importActual("../../apps/miniprogram/pages/points/index");
    const points = mountedPage(capturedPage!, { points: { projection: { available: 888 } }, balanceClass: "private", loading: false });
    points.onShow();
    expect(points.data).toMatchObject({ points: null, balanceClass: "", loading: false, error: "请先确认身份后查看积分账本。" });

    await vi.importActual("../../apps/miniprogram/pages/orders/index");
    const orders = mountedPage(capturedPage!, { items: [{ id: "previous-order" }], nextCursor: "private-cursor", loading: false });
    orders.onShow();
    expect(orders.data).toMatchObject({ items: [], nextCursor: null, loading: false, error: "请先确认身份后查看订单。" });

    await vi.importActual("../../apps/miniprogram/pages/invite/index");
    const invite = mountedPage(capturedPage!, { displayName: "上一位会员", shareId: "previous-share", shareCode: "PRIVATE",
      commercialEligible: true, referralCode: "PRIVATE-CODE", history: [{ shareId: "previous-share" }], loading: false });
    invite.onShow();
    expect(invite.data).toMatchObject({ displayName: "CISME 会员", shareId: "", shareCode: "待生成",
      commercialEligible: false, referralCode: "", history: [], loading: false, error: "请先确认身份后查看邀请资料。" });
    expect(wxMock.hideShareMenu).toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("ignores an old order response after the active member changes", async () => {
    let session = "member-a";
    (globalThis as any).getApp = () => ({ globalData: { sessionToken: session } });
    let finishOld: (value: unknown) => void = () => undefined;
    requestMock.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValue({ items: [], nextCursor: null });
    await vi.importActual("../../apps/miniprogram/pages/orders/index");
    const orders = mountedPage(capturedPage!);
    orders.onShow();
    session = "member-b";
    orders.onShow();
    await vi.waitFor(() => expect(orders.data.loading).toBe(false));
    finishOld({ items: [{ id: "member-a-order", lines: [], totalCents: 100, createdAt: "2026-09-13T00:00:00Z" }], nextCursor: null });
    await Promise.resolve();
    expect(orders.data.items).toEqual([]);
  });

  it("does not retain an invitation code when its refresh fails", async () => {
    (globalThis as any).getApp = () => ({ globalData: { sessionToken: "member-a" } });
    requestMock.mockRejectedValue(new Error("offline"));
    await vi.importActual("../../apps/miniprogram/pages/invite/index");
    const invite = mountedPage(capturedPage!, { commercialEligible: true, referralCode: "OLD-CODE", shareId: "old-link", loading: false });
    invite.onShow();
    await vi.waitFor(() => expect(invite.data.loading).toBe(false));
    expect(invite.data).toMatchObject({ commercialEligible: false, referralCode: "", shareId: "", error: "邀请资料暂时无法同步，请重试。" });
  });

  it("preserves the new-draft deep link when guest authentication must restart the page", async () => {
    requestMock.mockResolvedValue({ publicEnabled: false });
    await vi.importActual("../../apps/miniprogram/pages/community-compose/index");
    const page = mountedPage(capturedPage!);

    page.onLoad({ new: "1" });

    expect(resumeAuthenticationMock).toHaveBeenCalledWith("/pages/community-compose/index?new=1");
    expect(page.data.requestedNew).toBe(true);
    expect(page.data.loading).toBe(false);
  });

  it("reads the clipboard only from the explicit address action and keeps parsing local", async () => {
    Object.assign(globalThis, { getApp: () => ({ globalData: { sessionToken: "member-session" } }) });
    wxMock.getClipboardData!.mockImplementation((options) => options.success({ data: "林女士 13800000001 广东省深圳市南山区 护理路8号" }));
    await vi.importActual("../../apps/miniprogram/pages/settings/index");
    const page = mountedPage(capturedPage!, { pageAlive: true, memberId: "member-a", addressEditorOpen: true, addressDirty: false, addressQuickInput: "林女士 13800000001 广东省深圳市南山区 护理路8号" });

    page.recognizeAddressText();
    expect(wxMock.getClipboardData).not.toHaveBeenCalled();
    expect(page.data.addressDraft).toMatchObject({ recipientName: "林女士", regionNeedsConfirmation: true });

    page.pasteAndRecognizeAddress();
    expect(wxMock.getClipboardData).toHaveBeenCalledTimes(1);
    expect(page.data.addressParseStatus).toBe("success");
    expect(wxMock.setStorageSync).toHaveBeenCalledWith("cisme.addressDraft.v1", expect.objectContaining({ ownerMemberId: "member-a" }));
  });

  it("drops late clipboard content after settings is hidden or the member changes", async () => {
    const app = { globalData: { sessionToken: "member-a-token" } };
    (globalThis as any).getApp = () => app;
    let complete!: (result: { data: string }) => void;
    wxMock.getClipboardData!.mockImplementation(({ success }: { success(result: { data: string }): void }) => { complete = success; });
    await vi.importActual("../../apps/miniprogram/pages/settings/index");
    const context = mountedPage(capturedPage!, { pageAlive: true, memberId: "member-a", addressQuickInput: "手工输入仍在", addressBusy: false, addressParsing: false });
    context.clipboardAttempt = 0;
    context.addressImportAttempt = 0;
    context.avatarAttempt = 0;
    context.pasteAndRecognizeAddress();
    context.onHide();
    complete({ data: "OLD_MEMBER_PRIVATE_ADDRESS" });
    expect(context.data.addressQuickInput).toBe("手工输入仍在");
    context.pasteAndRecognizeAddress();
    app.globalData.sessionToken = "member-b-token";
    context.data.memberId = "member-b";
    complete({ data: "SECOND_OLD_MEMBER_PRIVATE_ADDRESS" });
    expect(context.data.addressQuickInput).toBe("手工输入仍在");
    expect(wxMock.setStorageSync).not.toHaveBeenCalled();
  });

  it("keeps an address draft on version conflict instead of overwriting the server", async () => {
    Object.assign(globalThis, { getApp: () => ({ globalData: { sessionToken: "member-session" } }) });
    requestMock.mockRejectedValueOnce({ status: 409, code: "DELIVERY_ADDRESS_CHANGED", title: "地址已更新" });
    const { emptyAddressDraft, mergeAddressDraft } = await vi.importActual<typeof import("../../apps/miniprogram/services/address-draft")>("../../apps/miniprogram/services/address-draft");
    const base = mergeAddressDraft(emptyAddressDraft(1, 0.5), { recipientName: "林女士", phone: "13800000001", region: ["广东省", "深圳市", "南山区"], regionCodes: ["440000", "440300", "440305"], regionSource: "picker", regionNeedsConfirmation: false, detail: "护理路 8 号" }, false);
    await vi.importActual("../../apps/miniprogram/pages/settings/index");
    const page = mountedPage(capturedPage!, { pageAlive: true, memberId: "member-a", addressEditorOpen: true, addressDirty: true, addressesEnabled: true, addressDraft: { ...base, id: "address-1", expectedVersion: 2, clientRequestKey: "" } });

    await page.saveAddress();

    expect(page.data.addressConflict).toBe(true);
    expect(page.data.addressDirty).toBe(true);
    expect(page.data.addressEditorOpen).toBe(true);
    expect(page.data.addressesError).toContain("另存为新地址");
    expect(wxMock.setStorageSync).toHaveBeenCalledWith("cisme.addressDraft.v1", expect.objectContaining({ ownerMemberId: "member-a" }));
  });

  it("coordinates the care sheet mount, exit, and navigation recovery without an abrupt unmount", async () => {
    vi.useFakeTimers();
    await vi.importActual("../../apps/miniprogram/pages/home/index");
    const tab = { setPresentation: vi.fn() };
    const page = mountedPage(capturedPage!, { care: null, working: false, authorityAvailable: true, reducedMotion: false });
    page.getTabBar = () => tab;

    page.openCareSession();
    expect(page.data).toMatchObject({ sessionMounted: true, sessionOpen: true, sessionVisible: true, sessionClosing: false });
    expect(tab.setPresentation).toHaveBeenLastCalledWith("care-sheet", true);

    page.resetCareSession();
    expect(page.data).toMatchObject({ sessionMounted: true, sessionOpen: false, sessionVisible: false, sessionClosing: true });
    expect(tab.setPresentation).toHaveBeenLastCalledWith("care-sheet", false);
    vi.advanceTimersByTime(299);
    expect(page.data.sessionMounted).toBe(true);
    vi.advanceTimersByTime(1);
    expect(page.data).toMatchObject({ sessionMounted: false, sessionClosing: false });
    vi.useRealTimers();
  });

  it("hides Community chrome only after intentional travel and restores it promptly when scrolling stops", async () => {
    vi.useFakeTimers();
    await vi.importActual("../../apps/miniprogram/pages/community/index");
    const tab = { setPresentation: vi.fn() };
    const page = mountedPage(capturedPage!, { chromeHidden: false });
    page.getTabBar = () => tab;
    page.resetChromeMotion();

    page.onPageScroll({ scrollTop: 13 });
    expect(page.data.chromeHidden).toBe(false);
    page.onPageScroll({ scrollTop: 30 });
    expect(page.data.chromeHidden).toBe(false);
    page.onPageScroll({ scrollTop: 45 });
    expect(page.data.chromeHidden).toBe(true);
    expect(tab.setPresentation).toHaveBeenLastCalledWith("community-scroll", true);
    vi.advanceTimersByTime(179);
    expect(page.data.chromeHidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(page.data.chromeHidden).toBe(false);
    expect(tab.setPresentation).toHaveBeenLastCalledWith("community-scroll", false);
    vi.useRealTimers();
  });

  it.each(["product", "task", "settings"])("serializes %s back navigation and permits retry only after fallback failure", async (route) => {
    await vi.importActual(`../../apps/miniprogram/pages/${route}/index`);
    const page = mountedPage(capturedPage!);
    page.back();
    page.back();
    if (route === "task") page.goCommunity();
    expect(wxMock.navigateBack).toHaveBeenCalledTimes(1);
    expect(wxMock.switchTab).not.toHaveBeenCalled();
    wxMock.navigateBack!.mock.calls[0]![0].fail();
    if (route === "product") wxMock.redirectTo!.mock.calls[0]![0].fail();
    page.back();
    expect(wxMock.navigateBack).toHaveBeenCalledTimes(1);
    wxMock.switchTab!.mock.calls[0]![0].fail();
    expect(page.data.leaving).toBe(false);
    page.back();
    expect(wxMock.navigateBack).toHaveBeenCalledTimes(2);
  });


  it("serializes Post back taps and recovers when both navigation paths fail", async () => {
    await vi.importActual("../../apps/miniprogram/pages/post/index");
    const post = mountedPage(capturedPage!);
    post.back();
    post.back();
    expect(wxMock.navigateBack).toHaveBeenCalledTimes(1);
    wxMock.navigateBack!.mock.calls[0]![0].fail();
    post.back();
    expect(wxMock.navigateBack).toHaveBeenCalledTimes(1);
    expect(wxMock.switchTab).toHaveBeenCalledTimes(1);
    wxMock.switchTab!.mock.calls[0]![0].fail();
    expect(post.data.leaving).toBe(false);
    expect(wxMock.showToast).toHaveBeenCalledTimes(1);
    post.back();
    expect(wxMock.navigateBack).toHaveBeenCalledTimes(2);
  });


  it("does not attach a local person's photo or brand cover to server UGC", async () => {
    (globalThis as any).getApp = () => ({ globalData: { sessionToken: "", apiBaseUrl: "https://synthetic.invalid" } });
    const item = { id: "real-submission", title: "Submitted story", excerpt: "Submitted text", cover_object_key: "private/object.jpg" };
    requestMock.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "/v1/capabilities") return { ugcGoLiveGate: true, communityPreviewEnabled: false };
      if (path === "/v1/ugc/status") return { publicEnabled: false };
      if (path.startsWith("/v1/ugc/posts")) return { items: [], nextCursor: null };
      if (path.startsWith("/v1/feed/page")) return { items: [item], authors: {} };
      if (path.startsWith("/v1/feed/")) return item;
      return [];
    });
    await vi.importActual("../../apps/miniprogram/pages/community/index");
    const community = mountedPage(capturedPage!);
    await community.load();
    community.setData({ mode: "recommend" });
    community.renderFeed();
    const card = community.data.feedColumns.flat().find((item: any) => item.id === "real-submission");
    expect(card).toMatchObject({ title: "Submitted story", image: "", avatar: "/assets/icons/user-circle-plum.svg" });
    expect(community.data.hero.image).toContain("community-hero-scalp-ritual");

    await vi.importActual("../../apps/miniprogram/pages/post/index");
    const post = mountedPage(capturedPage!, { id: "real-submission" });
    await post.load();
    expect(post.data.item).toMatchObject({ title: "Submitted story", image: "", avatar: "/assets/icons/user-circle-plum.svg" });
  });

  it("does not read or mutate follows when the runtime social preview is closed", async () => {
    Object.assign(globalThis, { getApp: () => ({ globalData: { sessionToken: "member-session" } }) });
    requestMock.mockResolvedValueOnce({ communityPreviewEnabled: false });
    await vi.importActual("../../apps/miniprogram/pages/post/index");
    const post = mountedPage(capturedPage!, { pageAlive: true, loadAttempt: 1, socialEnabled: true, authorId: "brand:cisme" });

    await post.loadSocial();
    post.toggleFollow();

    expect(post.data.socialEnabled).toBe(false);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith({ path: "/v1/capabilities", authMode: "public" });
  });


  it("serializes Shop product navigation and unlocks only after a failed transition", async () => {
    await vi.importActual("../../apps/miniprogram/pages/shop/index");
    const page = capturedPage!;
    const context = mountedPage(page, { pageAlive: true, navigating: false });
    const event = { currentTarget: { dataset: { id: "sku-1" } } };

    page.openProduct.call(context, event);
    page.openProduct.call(context, event);

    expect(wxMock.navigateTo).toHaveBeenCalledTimes(1);
    expect(context.data.navigating).toBe(true);

    wxMock.navigateTo!.mock.calls[0]![0].fail();
    expect(context.data.navigating).toBe(false);

    page.openProduct.call(context, event);
    expect(wxMock.navigateTo).toHaveBeenCalledTimes(2);
  });

  it("serializes Points-to-Shop navigation and recovers after navigateTo failure", async () => {
    await vi.importActual("../../apps/miniprogram/pages/points/index");
    const page = capturedPage!;
    const context = mountedPage(page, { pageAlive: true, navigating: false });

    page.openShop.call(context);
    page.openShop.call(context);

    expect(wxMock.navigateTo).toHaveBeenCalledTimes(1);
    expect(context.data.navigating).toBe(true);

    wxMock.navigateTo!.mock.calls[0]![0].fail();
    expect(context.data.navigating).toBe(false);
    expect(wxMock.showToast).toHaveBeenCalledWith({ title: "商品目录暂时无法打开", icon: "none" });
  });

  it("blocks a stale appeal after an authority conflict until a successful reload", async () => {
    requestMock.mockRejectedValueOnce({ status: 409, code: "APPEAL_STATE_INVALID" });
    await vi.importActual("../../apps/miniprogram/pages/progress/index");
    const page = capturedPage!;
    const context = mountedPage(page, {
      submissionId: "submission-1",
      submission: { id: "submission-1", status: "rejected", version: 3, review: {} },
      appealReason: "请重新核验",
      appealValid: true,
      appealBlocked: false,
      working: false,
      pageAlive: true,
      loadAttempt: 0
    });

    await page.appeal.call(context);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(context.data.appealBlocked).toBe(true);
    expect(context.data.working).toBe(false);
    expect(context.data.errorTitle).toBe("申诉资格已变化");

    await page.appeal.call(context);
    expect(requestMock).toHaveBeenCalledTimes(1);

    requestMock.mockResolvedValueOnce({
      id: "submission-1",
      status: "rejected",
      version: 4,
      reward_enabled: false,
      review: { reason_summary: "权威状态已刷新" }
    });
    await page.load.call(context);

    expect(context.data.appealBlocked).toBe(false);
    expect(context.data.submission.version).toBe(4);
  });

  it("returns Progress only to the matching Task source and serializes fallback navigation", async () => {
    await vi.importActual("../../apps/miniprogram/pages/progress/index");
    const page = capturedPage!;
    const matchingContext = mountedPage(page, { submissionId: "submission-1", pageAlive: true, navigatingAway: false });
    (globalThis as any).getCurrentPages = () => [
      { route: "pages/task/index", options: { id: "task-1" } },
      { route: "pages/progress/index", options: { id: "submission-1" } }
    ];

    page.back.call(matchingContext);

    expect(wxMock.navigateBack).toHaveBeenCalledWith(expect.objectContaining({ delta: 1 }));
    expect(wxMock.redirectTo).not.toHaveBeenCalled();

    wxMock.navigateBack!.mockClear();
    wxMock.showToast!.mockClear();
    const unrelatedContext = mountedPage(page, { submissionId: "submission-1", pageAlive: true, navigatingAway: false });
    (globalThis as any).getCurrentPages = () => [
      { route: "pages/post/index", options: { id: "post-1" } },
      { route: "pages/progress/index", options: { id: "submission-1" } }
    ];

    page.back.call(unrelatedContext);
    page.back.call(unrelatedContext);

    expect(wxMock.navigateBack).not.toHaveBeenCalled();
    expect(wxMock.redirectTo).toHaveBeenCalledTimes(1);
    expect(wxMock.redirectTo).toHaveBeenCalledWith(expect.objectContaining({ url: "/pages/task/index?id=task-1" }));
    expect(wxMock.showToast).toHaveBeenCalledWith({ title: "正在返回投稿来源", icon: "none" });

    wxMock.redirectTo!.mock.calls[0]![0].fail();
    expect(wxMock.switchTab).toHaveBeenCalledWith(expect.objectContaining({ url: "/pages/community/index" }));
    wxMock.switchTab!.mock.calls[0]![0].fail();
    expect(unrelatedContext.data.navigatingAway).toBe(false);
    expect(wxMock.showToast).toHaveBeenCalledWith({ title: "投稿来源暂时无法打开", icon: "none" });
  });

  it.each(["home", "records"])("does not pass a tap event into %s preserveSnapshot retries", async (route) => {
    await vi.importActual(`../../apps/miniprogram/pages/${route}/index`);
    const page = capturedPage!;
    const load = vi.fn();
    const context = mountedPage(page, { pageAlive: true });
    context.load = load;

    page.retryLoad.call(context, { currentTarget: { dataset: {} } });

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith();
  });

  it("renders a recoverable Records login state when automatic authentication is cancelled", async () => {
    requireMemberAccessMock.mockReturnValue(false);
    await vi.importActual("../../apps/miniprogram/pages/records/index");
    const page = capturedPage!;
    const tab = { setData: vi.fn(), syncActive: vi.fn(), setPresentation: vi.fn() };
    const context = mountedPage(page, { pageAlive: false, care: { id: "private-care" }, authorityAvailable: true, loading: true });
    context.getTabBar = () => tab;

    page.onShow.call(context);

    expect(context.data).toMatchObject({ pageAlive: true, care: null, authorityAvailable: false, accessRequired: true, loading: false });
    expect(requestMock).not.toHaveBeenCalled();
    page.authenticate.call(context);
    expect(resumeAuthenticationMock).toHaveBeenCalledWith("/pages/records/index");
  });

  it("preserves a labeled Records snapshot on ordinary refresh failure but clears it on auth failure", async () => {
    await vi.importActual("../../apps/miniprogram/pages/records/index");
    const page = capturedPage!;
    const context = mountedPage(page, { pageAlive: true, loadAttempt: 0, authorityAvailable: true, care: { id: "care-1" }, lastSyncedLabel: "09:30 已同步" });
    context.getTabBar = () => ({ setPresentation: vi.fn() });
    requestMock.mockRejectedValueOnce({ code: "NETWORK_UNAVAILABLE" });

    await page.load.call(context, true);

    expect(context.data.care).toEqual({ id: "care-1" });
    expect(context.data.authorityAvailable).toBe(true);
    expect(context.data.error).toContain("09:30 已同步");

    requestMock.mockRejectedValueOnce({ status: 401, code: "AUTHENTICATION_REQUIRED" });
    await page.load.call(context, true);
    expect(context.data).toMatchObject({ care: null, authorityAvailable: false, accessRequired: true, loading: false });
  });

  it("clears stale Home authority while keeping the public authorization CTA available", async () => {
    await vi.importActual("../../apps/miniprogram/pages/home/index");
    const page = capturedPage!;
    const context = mountedPage(page, {
      pageAlive: true,
      care: { id: "old-care", phase: "active" },
      view: { actionable: true, action: "旧操作" },
      authorityAvailable: true,
      loadAttempt: 0
    });

    await page.load.call(context, true);

    expect(context.data.care).toBeNull();
    expect(context.data.authorityAvailable).toBe(false);
    expect(context.data.needsAuthentication).toBe(true);
    expect(context.data.view.actionable).toBe(true);
    expect(context.data.view.action).toBe("授权身份并开始");
  });

  it("links all four Home protocol steps and submits the complete care facts only after assessment", async () => {
    await vi.importActual("../../apps/miniprogram/pages/home/index");
    const page = capturedPage!;
    const care = { id: "cycle-1", version: 4, phase: "active", due: "D7", next: "D7", completed: ["D1"], records: [] };
    const context = mountedPage(page, { pageAlive: true, care, authorityAvailable: true, working: false });
    const act = vi.fn(async () => true);
    const resetCareSession = vi.fn();
    context.act = act;
    context.resetCareSession = resetCareSession;

    page.openCareSession.call(context);
    expect(context.data.sessionStep.code).toBe("00");
    expect(context.data.view.signalTitle).toBe("完成后点亮第 2 条记录");
    for (let index = 0; index < 4; index += 1) page.advanceCareStep.call(context);
    expect(context.data.sessionStage).toBe("assessment");
    expect(context.data.sessionCompletedCodes).toEqual(["00", "01", "02", "03"]);
    expect(context.data.sessionProgressLabel).toBe("4 / 4");
    expect(context.data.view.steps.every((step: { done: boolean }) => step.done)).toBe(true);
    page.selectAssessment.call(context, { currentTarget: { dataset: { value: "comfortable" } } });
    await page.submitCareSession.call(context);

    expect(act).toHaveBeenCalledWith(
      "/v1/care-cycles/cycle-1/milestones/D7/complete",
      "care-milestone-cycle-1-D7-v4",
      { expectedVersion: 4, stepCodes: ["00", "01", "02", "03"], selfAssessment: "comfortable" }
    );
    expect(resetCareSession).toHaveBeenCalledTimes(1);
    expect(wxMock.vibrateShort).toHaveBeenCalledTimes(6);
  });

  it("starts a complete non-recordable care session when no dedicated cycle exists", async () => {
    await vi.importActual("../../apps/miniprogram/pages/home/index");
    const page = capturedPage!;
    const context = mountedPage(page, { pageAlive: true, care: null, authorityAvailable: true, loading: false, working: false });
    const resetCareSession = vi.fn(page.resetCareSession.bind(context));
    context.resetCareSession = resetCareSession;

    await page.primaryAction.call(context);

    expect(context.data.sessionOpen).toBe(true);
    expect(context.data.sessionRecordable).toBe(false);
    expect(context.data.sessionLabel).toBe("DAILY CARE");
    expect(context.data.sessionSubmitLabel).toBe("完成本次护理");
    expect(wxMock.navigateTo).not.toHaveBeenCalled();
    for (let index = 0; index < 4; index += 1) page.advanceCareStep.call(context);
    page.selectAssessment.call(context, { currentTarget: { dataset: { value: "comfortable" } } });
    await page.submitCareSession.call(context);

    expect(resetCareSession).toHaveBeenCalledTimes(1);
    expect(requestMock).not.toHaveBeenCalled();
    expect(wxMock.showToast).toHaveBeenCalledWith({ title: "四步练习已完成，未生成记录", icon: "none" });
  });

  it("requires explicit confirmation before activating a planned Home care cycle", async () => {
    await vi.importActual("../../apps/miniprogram/pages/home/index");
    const page = capturedPage!;
    const care = { id: "cycle-planned", version: 2, phase: "planned", due: null, completed: [], records: [] };
    const context = mountedPage(page, { pageAlive: true, care, authorityAvailable: true, activationConfirming: false, working: false });
    const act = vi.fn(async () => true);
    context.act = act;
    wxMock.showModal!.mockResolvedValueOnce({ confirm: true, cancel: false });

    await page.confirmCycleStart.call(context);

    expect(wxMock.showModal).toHaveBeenCalledWith(expect.objectContaining({ title: "从今天开始护理周期？", confirmText: "确认开始" }));
    expect(act).toHaveBeenCalledWith("/v1/care-cycles/cycle-planned/activate", "care-activate-cycle-planned-v2", { expectedVersion: 2 });
  });

  it("refreshes Submit authority after returning to an existing page", async () => {
    await vi.importActual("../../apps/miniprogram/pages/submit/index");
    const page = capturedPage!;
    const context = mountedPage(page, { pageAlive: true, hasShown: false, draftDirty: false, savingDraft: false, working: false, uploadingKind: "", navigatingToProgress: true });
    context.load = vi.fn();

    page.onShow.call(context);
    expect(context.load).toHaveBeenCalledTimes(1);
    context.load.mockClear();
    page.onShow.call(context);

    expect(context.load).toHaveBeenCalledTimes(1);
    expect(context.data.navigatingToProgress).toBe(false);
  });

  it("blocks Submit media access before privacy, chooser, or network calls when uploads are disabled", async () => {
    await vi.importActual("../../apps/miniprogram/pages/submit/index");
    const page = capturedPage!;
    const context = mountedPage(page, {
      pageAlive: true,
      editable: true,
      mediaUploadsEnabled: false,
      working: false,
      uploadingKind: "",
      savingDraft: false,
      draftDirty: false
    });

    await page.chooseMedia.call(context, { currentTarget: { dataset: { kind: "original" } } });

    expect(context.data.error).toContain("不会请求相册或相机权限");
    expect(requestMock).not.toHaveBeenCalled();
    expect(wxMock.requirePrivacyAuthorize).not.toHaveBeenCalled();
    expect(wxMock.chooseMedia).not.toHaveBeenCalled();
    expect(uploadAuthorizedMock).not.toHaveBeenCalled();
  });

  it("does not enter the chooser or network path when WeChat privacy authorization is refused", async () => {
    wxMock.requirePrivacyAuthorize!.mockImplementation(({ fail }: { fail(error: unknown): void }) => fail({ errMsg: "privacy deny" }));
    await vi.importActual("../../apps/miniprogram/pages/submit/index");
    const page = capturedPage!;
    const context = mountedPage(page, {
      pageAlive: true, editable: true, mediaUploadsEnabled: true,
      working: false, uploadingKind: "", savingDraft: false, draftDirty: false
    });

    await page.chooseMedia.call(context, { currentTarget: { dataset: { kind: "original" } } });

    expect(context.data.error).toContain("隐私授权");
    expect(wxMock.chooseMedia).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
    expect(uploadAuthorizedMock).not.toHaveBeenCalled();
  });

  it("keeps support text and blocks repeated image taps while privacy consent is pending or refused", async () => {
    const app = { globalData: { sessionToken: "support-member-a" } };
    (globalThis as any).getApp = () => app;
    let refuse!: (error: unknown) => void;
    wxMock.requirePrivacyAuthorize!.mockImplementation(({ fail }: { fail(error: unknown): void }) => { refuse = fail; });
    await vi.importActual("../../apps/miniprogram/pages/support/index");
    const page = capturedPage!;
    const context = mountedPage(page, { pageAlive: true, visible: true, input: "保留这段文字", selectedImage: null });
    context.lifecycleEpoch = 1;
    context.choosingImage = false;
    const first = page.chooseImage.call(context, { currentTarget: { dataset: { source: "album" } } });
    await page.chooseImage.call(context, { currentTarget: { dataset: { source: "camera" } } });
    expect(wxMock.requirePrivacyAuthorize).toHaveBeenCalledTimes(1);
    refuse({ errMsg: "privacy deny" });
    await first;
    expect(context.data.input).toBe("保留这段文字");
    expect(wxMock.chooseMedia).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
    expect(uploadAuthorizedMock).not.toHaveBeenCalled();
  });

  it("drops support image callbacks after account switch or page hide", async () => {
    const app = { globalData: { sessionToken: "support-member-a" } };
    (globalThis as any).getApp = () => app;
    let allow!: () => void;
    wxMock.requirePrivacyAuthorize!.mockImplementation(({ success }: { success(): void }) => { allow = success; });
    await vi.importActual("../../apps/miniprogram/pages/support/index");
    const page = capturedPage!;
    const context = mountedPage(page, { pageAlive: true, visible: true, input: "尚未发送的文字", selectedImage: null });
    context.lifecycleEpoch = 1;
    context.choosingImage = false;
    const switched = page.chooseImage.call(context, { currentTarget: { dataset: { source: "album" } } });
    app.globalData.sessionToken = "support-member-b";
    allow();
    await switched;
    expect(wxMock.chooseMedia).not.toHaveBeenCalled();

    app.globalData.sessionToken = "support-member-a";
    let resolveChosen!: (value: unknown) => void;
    wxMock.requirePrivacyAuthorize!.mockImplementation(({ success }: { success(): void }) => success());
    wxMock.chooseMedia!.mockImplementation(() => new Promise(resolve => { resolveChosen = resolve; }));
    const hidden = page.chooseImage.call(context, { currentTarget: { dataset: { source: "album" } } });
    await vi.waitFor(() => expect(wxMock.chooseMedia).toHaveBeenCalledTimes(1));
    context.publishPresence = vi.fn(async () => {});
    context.stopPolling = vi.fn();
    context.clearPresenceTimer = vi.fn();
    context.abortTransientWork = vi.fn();
    page.onHide.call(context);
    resolveChosen({ tempFiles: [{ tempFilePath: "/synthetic/private.jpg", size: 100 }] });
    await hidden;
    expect(context.data.input).toBe("尚未发送的文字");
    expect(context.data.selectedImage).toBeNull();
    expect(requestMock).not.toHaveBeenCalled();
    expect(uploadAuthorizedMock).not.toHaveBeenCalled();
  });

  it("does not choose or upload Submit evidence after privacy authorization returns to another session", async () => {
    const app = { globalData: { sessionToken: "submit-member-a" } };
    (globalThis as any).getApp = () => app;
    let allow!: () => void;
    wxMock.requirePrivacyAuthorize!.mockImplementation(({ success }: { success(): void }) => { allow = success; });
    await vi.importActual("../../apps/miniprogram/pages/submit/index");
    const page = capturedPage!;
    const context = mountedPage(page, { pageAlive: true, editable: true, mediaUploadsEnabled: true,
      working: false, uploadingKind: "", savingDraft: false, draftDirty: false, submissionId: "submission-a" });
    const pending = page.chooseMedia.call(context, { currentTarget: { dataset: { kind: "original" } } });
    app.globalData.sessionToken = "submit-member-b";
    allow();
    await pending;
    expect(wxMock.chooseMedia).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
    expect(uploadAuthorizedMock).not.toHaveBeenCalled();
  });

  it("invalidates a pending Submit chooser on page hide without replacing old evidence", async () => {
    (globalThis as any).getApp = () => ({ globalData: { sessionToken: "submit-member-a" } });
    wxMock.requirePrivacyAuthorize!.mockImplementation(({ success }: { success(): void }) => success());
    let resolveChosen!: (value: unknown) => void;
    wxMock.chooseMedia!.mockImplementation(() => new Promise(resolve => { resolveChosen = resolve; }));
    await vi.importActual("../../apps/miniprogram/pages/submit/index");
    const page = capturedPage!;
    const oldMedia = [{ kind: "original", upload_state: "uploaded", id: "confirmed-old-evidence" }];
    const context = mountedPage(page, { pageAlive: true, editable: true, mediaUploadsEnabled: true,
      working: false, uploadingKind: "", savingDraft: false, draftDirty: false, submissionId: "submission-a",
      submission: { media: oldMedia } });
    const pending = page.chooseMedia.call(context, { currentTarget: { dataset: { kind: "original" } } });
    await vi.waitFor(() => expect(wxMock.chooseMedia).toHaveBeenCalledTimes(1));
    page.onHide.call(context);
    resolveChosen({ tempFiles: [{ tempFilePath: "/synthetic/private.jpg", size: 100 }] });
    await pending;
    expect(context.data.submission.media).toEqual(oldMedia);
    expect(context.data.uploadRecovery).toBe("retry");
    expect(requestMock).not.toHaveBeenCalled();
    expect(uploadAuthorizedMock).not.toHaveBeenCalled();
  });

  it("keeps community text intact on privacy refusal and permits a later explicit retry", async () => {
    (globalThis as any).getApp = () => ({ globalData: { sessionToken: "community-member-a" } });
    wxMock.requirePrivacyAuthorize!.mockImplementation(({ fail }: { fail(error: unknown): void }) => fail({ errMsg: "privacy deny" }));
    await vi.importActual("../../apps/miniprogram/pages/community-compose/index");
    const page = capturedPage!;
    const context = mountedPage(page, { postId: "post-a", ownerId: "community-member-a", title: "草稿标题", body: "已写的正文",
      files: [], busy: false, uploadBusy: false, epoch: 1 });
    context.mediaVisible = true;
    context.mediaEpoch = 0;
    await page.chooseImages.call(context);
    expect(wxMock.chooseMedia).not.toHaveBeenCalled();
    expect(context.data).toMatchObject({ title: "草稿标题", body: "已写的正文", uploadBusy: false });
    expect(requestMock).not.toHaveBeenCalled();
    expect(uploadAuthorizedMock).not.toHaveBeenCalled();

    wxMock.requirePrivacyAuthorize!.mockImplementation(({ success }: { success(): void }) => success());
    wxMock.chooseMedia!.mockResolvedValue({ tempFiles: [] });
    await page.chooseImages.call(context);
    expect(wxMock.chooseMedia).toHaveBeenCalledTimes(1);
    expect(context.data).toMatchObject({ title: "草稿标题", body: "已写的正文", uploadBusy: false });
  });

  it("drops community chooser results after page hide or session switch", async () => {
    const app = { globalData: { sessionToken: "community-member-a" } };
    (globalThis as any).getApp = () => app;
    wxMock.requirePrivacyAuthorize!.mockImplementation(({ success }: { success(): void }) => success());
    let resolveChosen!: (value: unknown) => void;
    wxMock.chooseMedia!.mockImplementation(() => new Promise(resolve => { resolveChosen = resolve; }));
    await vi.importActual("../../apps/miniprogram/pages/community-compose/index");
    const page = capturedPage!;
    const context = mountedPage(page, { postId: "post-a", ownerId: "community-member-a", title: "草稿标题", body: "保留正文",
      files: [], busy: false, uploadBusy: false, epoch: 1, dirty: true });
    context.mediaVisible = true;
    context.mediaEpoch = 0;
    context.flushLocalBackup = vi.fn();
    const hidden = page.chooseImages.call(context);
    await vi.waitFor(() => expect(wxMock.chooseMedia).toHaveBeenCalledTimes(1));
    page.onHide.call(context);
    resolveChosen({ tempFiles: [{ tempFilePath: "/synthetic/private.jpg", size: 100 }] });
    await hidden;
    expect(context.data.files).toEqual([]);
    expect(context.data.body).toBe("保留正文");
    expect(requestMock).not.toHaveBeenCalled();
    expect(uploadAuthorizedMock).not.toHaveBeenCalled();

    context.mediaVisible = true;
    let allow!: () => void;
    wxMock.chooseMedia!.mockClear();
    wxMock.requirePrivacyAuthorize!.mockImplementation(({ success }: { success(): void }) => { allow = success; });
    const switched = page.chooseImages.call(context);
    app.globalData.sessionToken = "community-member-b";
    allow();
    await switched;
    expect(wxMock.chooseMedia).not.toHaveBeenCalled();
  });

  it("scrubs the previous member submission before reloading after an account switch", async () => {
    retainMemberSnapshotMock.mockReturnValue(false);
    await vi.importActual("../../apps/miniprogram/pages/submit/index");
    const page = capturedPage!;
    const context = mountedPage(page, {
      pageAlive: true, hasShown: true, submissionId: "submission-old", submission: { id: "submission-old" },
      mediaUploadsEnabled: true, originalReady: true, screenshotReady: true,
      postUrl: "https://personal.example/old", platformAccount: "old-account", disclosure: "old disclosure",
      permissions: { content_storage: true, human_review: true, feed_readonly: true }, editable: true, draftDirty: true
    });
    context.load = vi.fn();

    page.onShow.call(context);

    expect(context.data).toMatchObject({
      submission: null, mediaUploadsEnabled: false, originalReady: false, screenshotReady: false,
      postUrl: "", platformAccount: "", disclosure: "", editable: false, draftDirty: false
    });
    expect(context.data.permissions).toEqual({ content_storage: false, human_review: false, feed_readonly: false });
    expect(context.load).toHaveBeenCalledTimes(1);
  });

  it("recovers when a rendered Community invitation is stale", async () => {
    await vi.importActual("../../apps/miniprogram/pages/community/index");
    const page = capturedPage!;
    const context = mountedPage(page, { tasks: [], tasksLoading: false, navigating: false });
    context.loadTasks = vi.fn();

    page.openInvite.call(context, { currentTarget: { dataset: { id: "stale-task" } } });

    expect(wxMock.showToast).toHaveBeenCalledWith({ title: "邀请状态已更新，请重试", icon: "none" });
    expect(context.loadTasks).toHaveBeenCalledTimes(1);
    expect(wxMock.navigateTo).not.toHaveBeenCalled();
  });

  it("returns an authenticated member from Account to its source while keeping public browsing separate", async () => {
    Object.assign(globalThis,{getApp:()=>({globalData:{sessionToken:"valid-member"}})});
    wxMock.getStorageSync!.mockReturnValue("/pages/home/index");
    await vi.importActual("../../apps/miniprogram/pages/account/index");
    const page = capturedPage!;
    const backContext = mountedPage(page, { pageAlive: true, loading: false, identityCommitStarted: false, leavePromptOpen: false, leaving: false });

    await page.back.call(backContext);

    expect(cancelAuthenticationMock).toHaveBeenCalledTimes(1);
    expect(suppressAuthenticationRedirectOnceMock).toHaveBeenCalledWith("/pages/home/index");
    expect(wxMock.removeStorageSync).toHaveBeenCalledWith("cisme.authReturnUrl");
    expect(wxMock.navigateBack).toHaveBeenCalledWith(expect.objectContaining({ delta: 1 }));
    expect(wxMock.switchTab).not.toHaveBeenCalled();
    expect(backContext.data.leaving).toBe(true);

    const browseContext = mountedPage(page, { pageAlive: true, loading: false, identityCommitStarted: false, leavePromptOpen: false, leaving: false });
    await page.browseCommunity.call(browseContext);

    expect(wxMock.switchTab).toHaveBeenCalledWith(expect.objectContaining({ url: "/pages/community/index" }));
    expect(suppressAuthenticationRedirectOnceMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses concurrent automatic redirects until the source explicitly resumes authentication", async () => {
    const api = await vi.importActual<any>("../../apps/miniprogram/services/api");

    api.suppressAuthenticationRedirectOnce("/pages/home/index?from=tab");
    api.beginAuthentication("/pages/home/index");
    api.beginAuthentication("/pages/home/index");
    expect(wxMock.navigateTo).not.toHaveBeenCalled();
    expect(wxMock.setStorageSync).not.toHaveBeenCalledWith("cisme.authReturnUrl", expect.anything());

    api.resumeAuthentication("/pages/home/index");
    expect(wxMock.setStorageSync).toHaveBeenCalledWith("cisme.authReturnUrl", "/pages/home/index");
    expect(wxMock.navigateTo).toHaveBeenCalledWith(expect.objectContaining({ url: "/pages/account/index?intent=login" }));
  });

  it("confirms a committed Account exit, serializes taps, and falls back safely when Back has no source", async () => {
    wxMock.showModal!.mockResolvedValue({ confirm: true });
    await vi.importActual("../../apps/miniprogram/pages/account/index");
    const page = capturedPage!;
    const context = mountedPage(page, { pageAlive: true, loading: true, identityCommitStarted: true, leavePromptOpen: false, leaving: false });

    await page.back.call(context);
    await page.back.call(context);

    expect(wxMock.showModal).toHaveBeenCalledWith(expect.objectContaining({ confirmText: "仍然返回" }));
    expect(wxMock.navigateBack).toHaveBeenCalledTimes(1);
    expect(wxMock.switchTab).not.toHaveBeenCalled();
    wxMock.navigateBack!.mock.calls[0]![0].fail();
    expect(wxMock.switchTab).toHaveBeenCalledTimes(1);
    expect(wxMock.switchTab).toHaveBeenCalledWith(expect.objectContaining({ url: "/pages/home/index" }));
  });

  it("serializes simultaneous Account back and browse taps before the async leave check resumes", async () => {
    await vi.importActual("../../apps/miniprogram/pages/account/index");
    const page = capturedPage!;
    const context = mountedPage(page);
    await Promise.all([page.back.call(context), page.browseCommunity.call(context), page.back.call(context)]);
    expect(wxMock.navigateBack).toHaveBeenCalledTimes(1);
    expect(wxMock.switchTab).not.toHaveBeenCalled();
    expect(cancelAuthenticationMock).toHaveBeenCalledTimes(1);
  });

  it("does not claim server identity creation failed when its response is lost", async () => {
    requestMock.mockRejectedValueOnce(new Error("response lost after server commit"));
    await vi.importActual("../../apps/miniprogram/pages/account/index");
    const page = capturedPage!;
    const context = mountedPage(page, { agreementAccepted: true, legalTextsReady: true });
    await page.login.call(context);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(context.data.error).toContain("服务端可能已完成核验");
    expect(context.data.loading).toBe(false);
    expect(context.data.identityCommitStarted).toBe(false);
  });
  it("drops a late Account avatar result after the page is hidden", async () => {
    (globalThis as any).getApp = () => ({ globalData: { sessionToken: "member-a" } });
    let complete!: (results: unknown[]) => void;
    wxMock.createSelectorQuery = vi.fn(() => ({
      in() { return this; }, select() { return this; }, fields() { return this; },
      exec(callback: (results: unknown[]) => void) { complete = callback; }
    }));
    await vi.importActual("../../apps/miniprogram/pages/account/index");
    const context = mountedPage(capturedPage!, { loginStage: "avatar", pageAlive: true, pageVisible: true });
    const pending = context.chooseLoginAvatar({ detail: { avatarUrl: "wxfile://private-avatar" } });
    expect(context.data.avatarBusy).toBe(true);
    context.onHide();
    complete([]);
    await pending;
    expect(context.data.avatarBusy).toBe(false);
    expect(requestMock).not.toHaveBeenCalled();
  });
  it("preserves a comment draft and operation after a lost response, then retries once", async () => {
    await vi.importActual("../../apps/miniprogram/pages/post/index");
    const page = mountedPage(capturedPage!, { id: "brand-scalp-ritual", socialEnabled: true, draft: "测试护理评论", loadAttempt: 1 });
    requestMock.mockRejectedValueOnce(new Error("lost response"));
    await page.sendComment();
    const operation = page.data.draftOperation;
    expect(page.data.draft).toBe("测试护理评论");
    expect(operation).toBeTruthy();
    requestMock.mockResolvedValueOnce({ ...page.data.social, comments: [] });
    wxMock.hideKeyboard = vi.fn();
    await page.sendComment();
    expect(requestMock.mock.calls[1]![0].idempotencyKey).toBe(operation);
    expect(page.data.draft).toBe("");
    expect(page.data.socialBusy).toBe(false);
  });

  it("does not erase newly typed text when an earlier comment finishes sending", async () => {
    await vi.importActual("../../apps/miniprogram/pages/post/index");
    const page = mountedPage(capturedPage!, { id: "brand-scalp-ritual", socialEnabled: true, draft: "第一条测试评论", loadAttempt: 1 });
    let resolve!: (value: unknown) => void;
    requestMock.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const pending = page.sendComment();
    page.inputComment({ detail: { value: "继续输入下一条评论" } });
    resolve({ ...page.data.social, comments: [] });
    await pending;
    expect(page.data.draft).toBe("继续输入下一条评论");
  });

  it("ignores social responses after leaving the post and blocks concurrent reactions", async () => {
    await vi.importActual("../../apps/miniprogram/pages/post/index");
    const page = mountedPage(capturedPage!, { id: "brand-scalp-ritual", socialEnabled: true, loadAttempt: 1 });
    let resolve!: (value: unknown) => void;
    requestMock.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const pending = page.mutateSocial("/reaction", "PUT", { kind: "like", active: true });
    expect(await page.mutateSocial("/reaction", "PUT", { kind: "save", active: true })).toBe(false);
    page.onHide();
    resolve({ ...page.data.social, liked: true, comments: [] });
    expect(await pending).toBe(false);
    expect(page.data.social.liked).toBe(false);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("does not reopen a photo or show its failure after leaving the source page", async () => {
    await vi.importActual("../../apps/miniprogram/pages/post/index");
    const callbacks: any[] = [];
    const previewImage = vi.fn();
    Object.assign(wxMock, {
      env: { USER_DATA_PATH: "wxfile://usr" },
      getFileSystemManager: () => ({ copyFile: (options: any) => callbacks.push(options) }),
      previewImage
    });
    const page = mountedPage(capturedPage!, { media: ["/assets/one.jpg"], loadAttempt: 1 });
    const pending = page.previewMedia({ currentTarget: { dataset: { src: "/assets/one.jpg" } } });
    page.onHide();
    callbacks[0].success();
    await pending;
    expect(previewImage).not.toHaveBeenCalled();
    const failed = page.previewMedia({ currentTarget: { dataset: { src: "/assets/one.jpg" } } });
    page.onHide();
    callbacks[1].fail({ errMsg: "copy failed" });
    await failed;
    expect(wxMock.showToast).not.toHaveBeenCalled();
  });

  it("distinguishes an absent care cycle from a cycle awaiting activation", async () => {
    await vi.importActual("../../apps/miniprogram/pages/records/index");
    const page = mountedPage(capturedPage!);
    requestMock.mockResolvedValueOnce(null);
    await page.load();
    expect(page.data.authorityAvailable).toBe(true);
    expect(page.data.care).toBeNull();
    expect(page.data.summary.phaseLabel).toBe("尚无护理周期");
    requestMock.mockResolvedValueOnce({ id: "cycle", phase: "planned", completed: [], records: [] });
    await page.load();
    expect(page.data.summary.phaseLabel).toBe("待确认开始");
  });

  it("opens a saved record with its four protocol steps and self-assessment", async () => {
    await vi.importActual("../../apps/miniprogram/pages/records/index");
    const page = mountedPage(capturedPage!);
    requestMock.mockResolvedValueOnce({
      id: "cycle", phase: "active", startedOn: "2026-09-01", scheduleOffsetDays: 0, completed: ["D1"], due: null, next: "D7",
      records: [{ milestone: "D1", completedAt: "2026-09-01T08:30:00.000Z", stepCodes: ["00", "01", "02", "03"], selfAssessment: "comfortable" }]
    });
    await page.load();
    page.openRecordDetail({ currentTarget: { dataset: { key: "cycle:D1" } } });

    expect(page.data.recordDetailOpen).toBe(true);
    expect(page.data.recordDetailMounted).toBe(true);
    expect(page.data.recordDetailVisible).toBe(true);
    expect(page.data.selectedRecord).toMatchObject({ milestone: "D1", hasDetails: true, assessmentLabel: "舒适轻盈" });
    expect(page.data.selectedRecord.steps.map((step: { code: string }) => step.code)).toEqual(["00", "01", "02", "03"]);
  });

  it("keeps the record detail mounted through its exit and hides primary navigation while open", async () => {
    vi.useFakeTimers();
    await vi.importActual("../../apps/miniprogram/pages/records/index");
    const tab = { setPresentation: vi.fn() };
    const page = mountedPage(capturedPage!, {
      records: [{ recordKey: "cycle:D1", milestone: "D1", steps: [], stepSummary: "旧记录", assessmentAvailable: false }],
      reducedMotion: false,
      pageAlive: true
    });
    page.getTabBar = () => tab;

    page.openRecordDetail({ currentTarget: { dataset: { key: "cycle:D1" } } });
    expect(page.data).toMatchObject({ recordDetailMounted: true, recordDetailOpen: true, recordDetailVisible: true, recordDetailClosing: false });
    expect(tab.setPresentation).toHaveBeenLastCalledWith("record-detail", true);

    page.closeRecordDetail();
    expect(page.data).toMatchObject({ recordDetailMounted: true, recordDetailOpen: false, recordDetailVisible: false, recordDetailClosing: true });
    expect(tab.setPresentation).toHaveBeenLastCalledWith("record-detail", false);
    vi.advanceTimersByTime(239);
    expect(page.data.recordDetailMounted).toBe(true);
    vi.advanceTimersByTime(1);
    expect(page.data).toMatchObject({ recordDetailMounted: false, recordDetailClosing: false, selectedRecord: null });
    vi.useRealTimers();
  });

  it("groups the current and previous cycles without losing legacy-detail honesty", async () => {
    await vi.importActual("../../apps/miniprogram/pages/records/index");
    const page = mountedPage(capturedPage!);
    requestMock.mockResolvedValueOnce({
      id: "cycle-2", phase: "planned", completed: [], records: [],
      history: [{
        id: "cycle-1", phase: "completed", startedOn: "2026-08-01", timezone: "Asia/Shanghai", protocolVersion: "care-r0-v1", completed: ["D1", "D7", "D14", "D28"],
        records: [{ milestone: "D28", completedAt: "2026-08-28T16:30:00.000Z", stepCodes: [], selfAssessment: null }]
      }]
    });
    await page.load();

    expect(page.data.summary).toMatchObject({ totalRecords: 1, cycleCount: 2, phaseLabel: "待确认开始" });
    expect(page.data.recordGroups.map((group: { label: string }) => group.label)).toEqual(["当前周期", "第 1 个护理周期"]);
    expect(page.data.records[0]).toMatchObject({ recordKey: "cycle-1:D28", hasDetails: false, assessmentAvailable: false, assessmentLabel: "旧记录未包含护理后感受" });
    expect(page.data.records[0].stepSummary).toContain("尚未记录分步事实");
  });

  it("reveals long care archives in bounded groups without hiding the exact total", async () => {
    await vi.importActual("../../apps/miniprogram/pages/records/index");
    const page = mountedPage(capturedPage!);
    requestMock.mockResolvedValueOnce({
      id: "cycle-5", phase: "planned", completed: [], records: [],
      history: [4, 3, 2, 1].map((order) => ({ id: `cycle-${order}`, phase: "completed", startedOn: `2026-0${order}-01`, completed: ["D1"], records: [{ milestone: "D1", completedAt: `2026-0${order}-01T08:00:00.000Z`, stepCodes: [], selfAssessment: null }] }))
    });

    await page.load();
    expect(page.data.summary).toMatchObject({ cycleCount: 5, totalRecords: 4 });
    expect(page.data.visibleRecordGroups).toHaveLength(3);
    expect(page.data.hiddenCycleCount).toBe(2);
    page.showEarlierCycles();
    expect(page.data.visibleRecordGroups).toHaveLength(5);
    expect(page.data.hiddenCycleCount).toBe(0);
  });

  it("does not present paused or terminated milestones as fixed future dates", async () => {
    await vi.importActual("../../apps/miniprogram/pages/records/index");
    const page = mountedPage(capturedPage!);
    requestMock.mockResolvedValueOnce({ id: "cycle", phase: "paused", startedOn: "2026-09-01", completed: ["D1"], next: "D7", records: [] });
    await page.load();
    expect(page.data.timeline.map((item: { status: string }) => item.status)).toEqual(["已完成", "暂停中", "恢复后安排", "恢复后安排"]);
    expect(page.data.summary.cycleSummary).toContain("恢复后重新安排");
  });

});

it("keeps cross-border acceptance separate and refuses identity before it is selected",async()=>{
 await vi.importActual("../../apps/miniprogram/pages/account/index");
 const page=mountedPage(capturedPage!,{agreementAccepted:true,legalTextsReady:true,crossBorderRequired:true,crossBorderAccepted:false});
 page.documents=()=>({privacy:"v1",terms:"v1",crossBorder:"v1",localFixture:false});
 await page.login();expect(requestMock).not.toHaveBeenCalled();expect(page.data.error).toContain("单独选择");
 page.toggleAgreement({detail:{value:["accepted"]}});expect(page.data.crossBorderAccepted).toBe(false);
 page.toggleCrossBorder({detail:{value:["accepted"]}});expect(page.data.crossBorderAccepted).toBe(true);
});

it('discards a late synthetic privacy export after leaving the page or switching identity',async()=>{
 await vi.importActual('../../apps/miniprogram/pages/privacy-rights/index');
 const appState={globalData:{sessionToken:'owner-token'}};
 (globalThis as any).getApp=()=>appState;
 const page=mountedPage(capturedPage!,{authenticated:true,alive:true});
 let resolveArchive!: (value:unknown)=>void;
 requestMock.mockImplementationOnce(()=>new Promise(resolve=>{resolveArchive=resolve;}));
 const pending=page.viewExport({currentTarget:{dataset:{id:'request-a'}}});
 page.onHide();appState.globalData.sessionToken='other-token';
 resolveArchive({scope:'member_profile_only',member:{displayName:'OWNER_PRIVATE'},profile:null});
 await pending;
 expect(page.data.visibleExport).toBeNull();
});

it('shows only an explicitly opened own profile subset and clears it on hide',async()=>{
 await vi.importActual('../../apps/miniprogram/pages/privacy-rights/index');
 (globalThis as any).getApp=()=>({globalData:{sessionToken:'owner-token'}});
 const page=mountedPage(capturedPage!,{authenticated:true,alive:true});
 requestMock.mockResolvedValueOnce({scope:'member_profile_only',member:{displayName:'Owner'},profile:{wechatHandle:'ownerwx'}});
 await page.viewExport({currentTarget:{dataset:{id:'request-a'}}});
 expect(page.data.visibleExport).toEqual({requestId:'request-a',displayName:'Owner',wechatHandle:'ownerwx'});
 page.onHide();
 expect(page.data.visibleExport).toBeNull();
});

it('labels a synthetic scoped erasure as partial and leaves unrelated data unclaimed',async()=>{
 await vi.importActual('../../apps/miniprogram/pages/privacy-rights/index');
 (globalThis as any).getApp=()=>({globalData:{sessionToken:'owner-token'}});
 const page=mountedPage(capturedPage!,{authenticated:true,alive:true});
 requestMock.mockResolvedValueOnce([{id:'request-a',kind:'delete',status:'partially_completed',execution:{type:'erasure',status:'partially_succeeded',scopeCode:'member_profile_handle_v1'}}]);
 await page.load();
 expect(page.data.records[0].executionSummary).toContain('仅清除自报微信号，其他资料未删除');
 expect(page.data.records[0].statusLabel).toBe('部分完成');
});


it('loads privacy operator, version and contact from the shared public legal source',async()=>{
 await vi.importActual('../../apps/miniprogram/pages/privacy-rights/index');
 const page=mountedPage(capturedPage!,{alive:true});
 requestMock.mockResolvedValueOnce({documents:[{document_type:'privacy',operator_name:'Approved operator fixture',version:'fixture-v2',contact:'Approved contact fixture'}]});
 await page.loadLegalIdentity();
 expect(requestMock).toHaveBeenCalledWith({path:'/v1/legal',authMode:'public'});
 expect(page.data.legalIdentity).toEqual({operator:'Approved operator fixture',version:'fixture-v2',contact:'Approved contact fixture'});
 requestMock.mockRejectedValueOnce(new Error('network'));
 await page.loadLegalIdentity();expect(page.data.legalIdentity).toBeNull();
});
