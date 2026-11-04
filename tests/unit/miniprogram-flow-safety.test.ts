import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(resolve(path), "utf8");
}

describe("mini program submission flow safety", () => {


  it("keeps the task in history and gives progress a non-circular return path", async () => {

    expect(await source("apps/miniprogram/pages/shop/index.ts")).toContain('wx.switchTab({ url: "/pages/community/index" })');
  });

  it("keeps authentication, navigation and draft exits recoverable", async () => {
    const api = await source("apps/miniprogram/services/api.ts");
    const account = await source("apps/miniprogram/pages/account/index.ts");
    const layout = await source("apps/miniprogram/services/layout.ts");

    expect(api).toContain("export function cancelAuthentication(flowId?: string)");
    expect(api).toContain("export function suppressAuthenticationRedirectOnce(returnUrl: string)");
    expect(api).toContain("if (suppressedAuthRedirectPath === authPath)");
    expect(api).toContain("export function resumeAuthentication(returnUrl = currentRouteUrl())");
    expect(api).toMatch(/if \(authMode === "required" && !token\) \{[\s\S]*?beginAuthentication\(origin\);[\s\S]*?status: 401, code: "AUTHENTICATION_REQUIRED"/);
    expect(api).toContain('problem?.code === "MEMBER_NOT_FOUND"');
    expect(api).toContain("const previous = pages[pages.length - 2]");
    expect(api).toContain("previous?.route === path.slice(1)");
    expect(api).toContain("wx.navigateBack({");
    expect(api).toMatch(/if \(previous\?\.route === path\.slice\(1\)\)[\s\S]*?wx\.navigateBack\([\s\S]*?fail: \(\) => wx\.reLaunch/);
    expect(account).toContain("this.data.authAttempt += 1");
    expect(account).toContain("this.stopAuthenticationWait(true)");
    expect(account).toContain('return returnUrl.startsWith("/pages/") && !returnUrl.startsWith("/pages/account/") ? returnUrl : "/pages/home/index"');
    expect(account).toContain("wx.navigateBack({ delta: 1, fail: openSource })");
    expect(account).toContain("const legalDocuments = this.documents()");
    expect(account).not.toContain('version: "2026-08-14"');
    expect(account).toContain("if (!this.data.pageAlive || this.data.authAttempt !== attempt) return");
    expect(account).toContain("void attributePendingShare()");
    expect(layout).toMatch(/export function motionDuration\(_duration: number\): number \{[\s\S]*?return 0;/);
  });

  it("keeps unsigned legal text fail closed while exposing an explicit local-only fixture", async () => {
    const releaseConfig = await source("apps/miniprogram/release-config.ts");
    const account = await source("apps/miniprogram/pages/account/index.ts");
    const accountView = await source("apps/miniprogram/pages/account/index.wxml");

    expect(releaseConfig).toContain("approvedLegalDocumentVersions: LegalDocumentVersions | null = null");
    expect(releaseConfig).toContain('terms: "local-visual-fixture-2026-08-16"');
    expect(releaseConfig).toContain("shouldUseDevelopmentIdentity(envVersion, platform, remoteDebugMode, cloudTransport) ? localLegalFixture : approvedLegalDocumentVersions");
    expect(releaseConfig).toContain('query.cisme_remote_debug !== "1"');
    expect(releaseConfig).toContain('envVersion !== "develop"');
    expect(account).not.toContain("const initialLegalDocuments = currentLegalDocuments()");
    const accountOnShow = account.slice(account.indexOf("  onShow() {"), account.indexOf("  onHide()"));
    expect(accountOnShow).toContain("void this.syncLegalDocuments();");
    expect(accountOnShow).toContain("if(this.data.renewalMode)");
    expect(account).toMatch(/syncLegalDocuments\(\)\s*\{[\s\S]*legalTextsReady:\s*Boolean\(documents\)/);
    expect(account).toContain("legalDocuments.privacy");
    expect(account).toContain("legalDocuments.terms");
    expect(account).toContain("不是正式用户协议");
    expect(accountView).toContain('bindtap="openTerms"');
    expect(accountView).toContain('bindtap="openPrivacy"');
    expect(accountView).toMatch(/<\/checkbox-group>\s*<view class="account-legal-links">/);
    expect(accountView).toContain('disabled="{{loading || leaving || !legalTextsReady}}"');
    expect(accountView).toContain("暂时无法登录");
    expect(accountView).toContain("协议暂时无法加载，请重试");
    expect(accountView).toContain("协议信息暂不可用，请稍后重试");
    expect(accountView).toContain("重新加载协议");
    expect(accountView).toContain("协议暂未发布，请稍后重试");
  });

  it("keeps public entry APIs public while preventing no-session protected requests", async () => {
    const account = await source("apps/miniprogram/pages/account/index.ts");
    const commerce = await source("apps/miniprogram/services/commerce.ts");
    const post = await source("apps/miniprogram/pages/post/index.ts");
    const share = await source("apps/miniprogram/services/share.ts");

    expect(account.match(/authMode: "public"/g)).toHaveLength(2);
    expect(commerce).toMatch(/path: `\/v1\/catalog\?limit=20\$\{cursor/);
    expect(commerce).toMatch(/authMode: "public"/);
    expect(commerce).toMatch(/path: `\/v1\/catalog\/\$\{encodeURIComponent\(code\)\}`/);
    expect(post).toMatch(/path: `\/v1\/feed\/\$\{encodeURIComponent\(this\.data\.id\)\}`, authMode: "public"/);
    expect(share.match(/authMode: "public"/g)).toHaveLength(2);
  });

  it("fails closed when authoritative consumer state cannot be refreshed", async () => {
    const community = await source("apps/miniprogram/pages/community/index.ts");
    const home = await source("apps/miniprogram/pages/home/index.ts");
    const homeView = await source("apps/miniprogram/pages/home/index.wxml");
    const records = await source("apps/miniprogram/pages/records/index.ts");
    const recordsView = await source("apps/miniprogram/pages/records/index.wxml");

    expect(community).toContain('if (this.data.feedAttempt === attempt && session === getApp<IAppOption>().globalData.sessionToken) { feedModel(this).feed = [];feedModel(this).editorial=[];this.setData({ feedReady:false,error: this.data.mode==="featured"?"精选内容暂时无法加载，请重试。":"社区内容暂时无法加载，请重试。" }); this.renderFeed(); }');
    expect(community).toContain("this.data.feedAttempt === attempt");
    expect(home).toContain("authorityAvailable: false");
    expect(home).toContain("care: null, view: homeView(null, homeDisplayName(this)), authorityAvailable: false");
    expect(home).toContain("onUnload() { cancelPageReads(this); this.data.pageAlive = false");
    expect(home).toContain("const refreshed = await this.load(true)");
    expect(homeView).toContain('disabled="{{loading || working || activationConfirming || (!authorityAvailable && !needsAuthentication) || !view.actionable}}"');
    expect(records).toContain("care: null, timeline: [], records: [], recordGroups: [], visibleRecordGroups: [], visibleCycleCount: archivePageSize, hiddenCycleCount: 0, summary: emptySummary");
    expect(records).toContain("onUnload() { this.onHide(); this.data.pageAlive = false");
    expect(records).toContain("if (!current()) return");
    expect(records).toContain("return this.data.pageAlive && token === getApp<IAppOption>().globalData.sessionToken && revision === commerceContextRevision()");
    expect(recordsView).toContain("authorityAvailable && care");
    expect(recordsView).toContain("authorityAvailable && !care");
  });

  it("keeps the last authoritative care view mounted while a mutation is being reconciled", async () => {
    const home = await source("apps/miniprogram/pages/home/index.ts");
    const homeView = await source("apps/miniprogram/pages/home/index.wxml");
    const records = await source("apps/miniprogram/pages/records/index.ts");
    const recordsView = await source("apps/miniprogram/pages/records/index.wxml");

    expect(home).toContain("async load(preserveSnapshot = false)");
    expect(records).toContain("async load(preserveSnapshot = false, failClosed = false)");
    expect(home).toContain("preserveSnapshot && sameSession && this.data.authorityAvailable");
    expect(records).toContain("preserveSnapshot && this.data.authorityAvailable");
    expect(home).toContain("await this.load(true)");
    expect(records).toContain("await this.load(true, true)");
    expect(home).toMatch(/await request<T>\([\s\S]*?await this\.load\(true\)/);
    expect(records).toMatch(/await request\([\s\S]*?await this\.load\(true, true\)/);
    expect(home).toMatch(/retryLoad\(\) \{[^}]*void this\.load\(\); \}/);
    expect(records).toContain("if (this.data.authorityAvailable) void this.load(true); else void this.load()");
    for (const view of [homeView, recordsView]) {
      expect(view).toContain('bindtap="retryLoad"');
      expect(view).not.toMatch(/<button[^>]*bindtap="load"[^>]*>重试<\/button>/);
    }
    expect(records).toContain("if (this.data.authorityAvailable) void this.load(true); else void this.load()");
    expect(records).toContain("await this.load(true, true)");
  });

  it("keeps button busy states, navigation recovery, and unavailable sharing fail closed", async () => {
    const account = await source("apps/miniprogram/pages/account/index.ts");
    const accountView = await source("apps/miniprogram/pages/account/index.wxml");
    const community = await source("apps/miniprogram/pages/community/index.ts");
    const profile = await source("apps/miniprogram/pages/profile/index.ts");
    const shop = await source("apps/miniprogram/pages/shop/index.ts");
    const shopView = await source("apps/miniprogram/pages/shop/index.wxml");
    const points = await source("apps/miniprogram/pages/points/index.ts");
    const pointsView = await source("apps/miniprogram/pages/points/index.wxml");
    const tab = await source("apps/miniprogram/custom-tab-bar/index.ts");
    const tabView = await source("apps/miniprogram/custom-tab-bar/index.wxml");
    const post = await source("apps/miniprogram/pages/post/index.ts");
    const product = await source("apps/miniprogram/pages/product/index.ts");
    const productView = await source("apps/miniprogram/pages/product/index.wxml");

    expect(account).toContain("if (this.data.loading && (this.data.identityCommitStarted||this.data.legalAcceptanceStarted))");
    expect(account).toContain("登录仍在处理中");
    expect(account).toContain("登录结果尚未确认。返回后请先查看账号状态。");
    expect(account).toContain("登录仍在处理中。前往社区后，请重新确认登录状态。");
    expect(accountView).toContain('disabled="{{leavePromptOpen || leaving || avatarBusy}}"');
    expect(account).toContain('confirmIdentityLeave(destination: "source" | "community")');
    expect(account).toContain('wx.navigateBack({ delta: 1');
    expect(accountView).toContain("停止等待，浏览公开社区");


    expect(profile).toContain("设置与隐私暂时无法打开");
    for (const [logic, view] of [[shop, shopView], [points, pointsView]]) {
      expect(logic).toContain("if (this.data.navigating) return");
      expect(logic).toContain("this.setData({ navigating: true })");
      expect(logic).toContain("this.setData({ navigating: false })");
      expect(view).toContain("{{navigating ? 'control--disabled' : ''}}");
      expect(view).toContain('disabled="{{navigating}}"');
    }
    expect(tab).toContain("页面切换失败，请重试");
    expect(tabView).toContain('disabled="{{switching || externalBusy || chromeHidden}}"');
    expect(tab).toContain("this.data.switching || this.data.externalBusy");

    for (const route of [post, product]) {
      expect(route).toContain("wx.hideShareMenu()");
      expect(route).toContain("wx.showShareMenu");
    }
    expect(productView).toContain("autoplay=\"{{false}}\"");
    expect(product).not.toContain("createIntersectionObserver");
  });



  it("guards consent revocation exits and distinguishes unknown session state", async () => {
    const settings = await source("apps/miniprogram/pages/settings/index.ts");
    const settingsView = await source("apps/miniprogram/pages/settings/index.wxml");

    expect(settings).toContain('sessionStatus: "unknown"');
    expect(settings).toContain('problem.status === 401 || problem.code === "MEMBER_NOT_FOUND"');
    expect(settings).toContain("this.data.revokeAttempt !== attempt");
    expect(settings).toContain("正在确认撤回结果");
    expect(settings).toContain("confirmingLogout: false");
    expect(settings).toContain('title: "确认退出当前账号？"');
    expect(settings).toContain("this.data.workingConsentId || this.data.confirmingLogout || this.data.loggingOut");
    expect(settings).toMatch(/logout\(\) \{[\s\S]*?this\.data\.loadAttempt \+= 1;[\s\S]*?setSessionToken\(""\);/);
    expect(settings).toContain('loading: false, consents: [], sessionStatus: "invalid"');
    expect(settings).toContain("设置暂时无法加载，请检查网络后重试。");
    expect(settingsView).toContain('wx:if="{{error}}"');
    expect(settingsView).toContain('disabled="{{!!workingConsentId || confirmingLogout || loggingOut || profileBusy || avatarBusy || phoneBusy || addressBusy || leavePromptOpen}}"');
  });

  it("sends versioned idempotent care-cycle mutations from the home route", async () => {
    const home = await source("apps/miniprogram/pages/home/index.ts");

    expect(home).toContain("care-activate-${care.id}-v${care.version}");
    expect(home).toContain("care-milestone-${care.id}-${care.due}-v${care.version}");
    expect(home).toContain("stepCodes: this.data.sessionCompletedCodes, selfAssessment: this.data.sessionAssessment");
    expect(home).toContain('await request<T>({ path, method: "POST", idempotencyKey, data: command.data })');
  });

  it("removes task invitations while keeping publication gates and catalog states truthful", async () => {
    const community = await source("apps/miniprogram/pages/community/index.ts");
    const communityView = await source("apps/miniprogram/pages/community/index.wxml");
    const profile = await source("apps/miniprogram/pages/profile/index.ts");
    const profileView = await source("apps/miniprogram/pages/profile/index.wxml");
    const shopView = await source("apps/miniprogram/pages/shop/index.wxml");
    const editorial = await source("apps/miniprogram/services/editorial.ts");

    for (const route of [community, profile]) expect(route).not.toContain("/v1/me/tasks");
    expect(communityView).not.toContain("邀请活动");
    expect(profileView).not.toContain("我的活动");
    expect(profileView).not.toContain("微信支付与真实配送尚未开放");
    expect(shopView).toContain("全部商品");
    expect(shopView).toContain("catalog && catalog.items.length && !purchaseAvailable");
    expect(shopView).toContain("可先了解商品，下单暂未开放。");
    expect(editorial).toContain("export const editorialStories: EditorialStory[] = []");
    expect(editorial).not.toContain("内容授权尚待确认");
  });

  it("rejects stale profile and post responses and revalidates UGC on foreground", async () => {
    const profile = await source("apps/miniprogram/pages/profile/index.ts");
    const post = await source("apps/miniprogram/pages/post/index.ts");
    const tab = await source("apps/miniprogram/custom-tab-bar/index.ts");
    const tabView = await source("apps/miniprogram/custom-tab-bar/index.wxml");

    expect(profile).toContain("loadAttempt: 0, snapshotVersion: 0, auxiliaryAttempt: 0, pageAlive: true");
    expect(profile).toContain("this.data.loadAttempt === attempt");
    expect(profile).toContain("member:null, points:null, care:null, coreUnavailable:false, authority:null,managementEntryAvailable:false, commercialEligible:false, commercialAccessible:false, supportUnread:null");
    expect(post).toContain("onShow() { this.readVisible=true;this.setData({ pageAlive: true, leaving: false }); void this.load(true); }");
    expect(post).toContain("async load(restoreGallery = false)");
    expect(post).toContain("const article=await publishedEditorialArticle(this.data.id,this);");
    expect(post).toContain("if(!this.currentArticleLoad(attempt,token)){this.dropChangedArticleOwner(attempt);return;}");
    expect(post).toContain("gallery.id===article.id && gallery.version===article.version");
    expect(post).toContain("gallery.ownerToken===token && gallery.media.length===display.images.length");
    expect(post).not.toContain("allowPublicBrowsing");
    expect(post).toContain("this.data.loadAttempt !== attempt");
    expect(post).toContain('loadAttempt: attempt, socialEnabled: false, socialBusy: false, socialLoading: false, social: emptyCommunity, threads: [], following: false, followBusy:false,followError: "", item: null, media: [], video:null,videoHeightRpx:1000,videoInitialTime:0,videoEventId:"",imageEventId:"", mediaIndex: 0, galleryHeight:1000, mediaError:"",shareId: "", loading: true');
    expect(post).toContain('currentEditorial(attempt:number,token:string){return this.readVisible&&this.data.pageAlive&&this.data.loadAttempt===attempt&&token===getApp<IAppOption>().globalData.sessionToken;}');
    expect(post.slice(post.indexOf("onHide()"),post.indexOf("onUnload()"))).toContain('this.pauseVideo();');
    expect(post).toContain('this.readVisible=false;cancelPageReads(this);if(this.data.loading)this.clearArticlePresentation();if(this.data.editorialSource)this.clearPrivateComments();this.data.loadAttempt += 1;');
    expect(tab).toContain("wx.pageScrollTo({ scrollTop: 0, duration: 0 })");
    expect(tab).toContain("reducedMotion: shouldReduceMotion()");
    expect(tabView).toContain("bar--reduced-motion");
  });

  it("announces operation results and blocks mutation-time exits", async () => {
    const accountView = await source("apps/miniprogram/pages/account/index.wxml");
    const recordsView = await source("apps/miniprogram/pages/records/index.wxml");
    const settingsView = await source("apps/miniprogram/pages/settings/index.wxml");

    expect(accountView).toContain('aria-live="assertive" aria-atomic="true"');
    expect(recordsView).toContain('class="records-operation-status" aria-live="polite"');
    expect(recordsView).toContain('id="records-error-summary"');
    expect(settingsView).toContain('class="settings-operation-status" aria-live="polite"');
  });

  it("invalidates stale authority and navigation locks across authentication and tab transitions", async () => {
    const home = await source("apps/miniprogram/pages/home/index.ts");
    const community = await source("apps/miniprogram/pages/community/index.ts");
    const tab = await source("apps/miniprogram/custom-tab-bar/index.ts");
    const account = await source("apps/miniprogram/pages/account/index.ts");

    expect(home).toContain('loading: false, authorityAvailable: false, needsAuthentication: true');
    expect(home).toContain('action: "授权身份并开始"');
    expect(home).not.toContain("onShow() { if (!requireMemberAccess()) return;");
    expect(tab).toContain("current?.data?.working || current?.data?.navigating");
    expect(tab).toContain("liveExternalBusy");
    expect(account).toContain("if (this.data.authAttempt === attempt)");
  });

  it("keeps stacked-page chrome on measured capsule and safe-area variables", async () => {
    const appStyle = await source("apps/miniprogram/app.wxss");
    const postStyle = await source("apps/miniprogram/pages/post/index.wxss");
    const productStyle = await source("apps/miniprogram/pages/product/index.wxss");

    expect(appStyle).toMatch(/\.page--stack\s*\{[^}]*padding-top:\s*var\(--cisme-stack-top/s);
    for (const style of [postStyle, productStyle]) {
      expect(style).not.toContain("padding:calc(env(safe-area-inset-top) + 188rpx)");
      expect(style).toContain("var(--cisme-safe-bottom,env(safe-area-inset-bottom))");
    }
    expect(productStyle).toContain("padding-top:var(--cisme-stack-top");
    // The author now belongs to document flow below media, while only native
    // navigation reserves the measured capsule row.
    const authorStyle=postStyle.match(/\.post-authorbar\s*\{([^}]*)\}/)?.[1];
    expect(authorStyle).toBeDefined();expect(authorStyle).not.toMatch(/position\s*:\s*fixed|top\s*:/);
    expect(postStyle).toMatch(/\.post-page\s*\{[^}]*padding:var\(--cisme-topbar-height\)/);
    expect(postStyle).not.toContain(".post-page--with-author");
  });

  it("serializes public catalog, financial and review loads across hide and unload", async () => {
    const shop = await source("apps/miniprogram/pages/shop/index.ts");
    const product = await source("apps/miniprogram/pages/product/index.ts");
    const points = await source("apps/miniprogram/pages/points/index.ts");

    for (const route of [shop, product, points]) {
      expect(route).toContain("loadAttempt: 0");
      expect(route).toContain("this.data.loadAttempt += 1");
      expect(route).toContain("this.data.loadAttempt !== attempt");
      expect(route).toContain("this.data.pageAlive = false");
    }
    expect(shop).toContain("...(!preserve ? { catalog: null, featured: null, purchaseAvailable:false } : {}), loading: true");
    expect(shop).toContain("const preserve = retainReadPresentation(this)");
    expect(product).toContain('...(!preserve ? { item: null, catalog: null } : {}), shareId: "", loading: true');
    expect(product).toContain("formatCnyCents(raw.price)");
    expect(product).toContain('throw new Error("CATALOG_PRICE_INVALID")');
    expect(product).toContain('wx.redirectTo({ url: "/pages/shop/index"');
    expect(product).toContain('wx.switchTab({ url: "/pages/community/index", fail: failed })');
    expect(points).toContain('points: null as any, balanceClass: "", loading: true');
  });

  it("keeps care controls and progress recovery visually aligned with their busy predicates", async () => {
    const records = await source("apps/miniprogram/pages/records/index.wxml");

    expect(records.match(/loading="\{\{workingAction === '(?:pause|resume)'\}\}" disabled="\{\{!writeReady \|\| working \|\| confirmingCycleAction\}\}"/g)).toHaveLength(2);
    expect(records.match(/\{\{!writeReady \|\| working \|\| confirmingCycleAction \? 'control--disabled' : ''\}\}/g)).toHaveLength(3);
    expect(records.match(/\{\{working \|\| confirmingCycleAction \? 'control--disabled' : ''\}\}/g)).toHaveLength(3);
  });

  it("labels unavailable content and destructive consent actions without ambiguity", async () => {
    const postView = await source("apps/miniprogram/pages/post/index.wxml");
    const settings = await source("apps/miniprogram/pages/settings/index.ts");
    const settingsView = await source("apps/miniprogram/pages/settings/index.wxml");

    expect(postView).toContain('wx:if="{{!item && error}}"');
    expect(postView).toContain('{{errorTitle}}');
    expect(postView).toContain('{{error}}');
    expect(postView).toContain('class="glass error-scene post-unavailable" aria-live="assertive" aria-atomic="true"');
    expect(settingsView).toContain('data-purpose="{{item.purposeLabel}}"');
    expect(settingsView).toContain('aria-label="撤回{{item.purposeLabel}}用途许可"');
    expect(settings).toContain('title: `确认撤回“${purpose}”？`');
    expect(settings).toContain("scrollToSettingsError");
  });

  it("keeps long member names and authoritative balances fully visible", async () => {
    const home = await source("apps/miniprogram/pages/home/index.ts");
    const homeView = await source("apps/miniprogram/pages/home/index.wxml");
    const homeStyle = await source("apps/miniprogram/pages/home/index.wxss");
    const profile = await source("apps/miniprogram/pages/profile/index.ts");
    const profileStyle = await source("apps/miniprogram/pages/profile/index.wxss");
    const points = await source("apps/miniprogram/pages/points/index.ts");
    const pointsView = await source("apps/miniprogram/pages/points/index.wxml");
    const pointsStyle = await source("apps/miniprogram/pages/points/index.wxss");

    expect(home).toContain('displayName.length > 24 ? "care-greeting--very-long"');
    expect(homeView).toContain("care-greeting {{view.greetingClass}}");
    expect(homeStyle).toContain(".care-greeting--very-long");
    expect(profile).toContain('String(points.projection.available).length >= 8 ? "pass-stat__value--compact"');
    expect(profileStyle).toContain(".care-status__stats strong.pass-stat__value--compact");
    expect(profileStyle).toContain("overflow-wrap:anywhere;white-space:normal");
    expect(points).toContain('balanceClass = String(points.projection.available).length >= 8 ? "points-hero__balance--compact"');
    expect(points).toContain('throw new Error("POINTS_VALUE_INVALID")');
    expect(pointsView).toContain("points-hero__balance {{balanceClass}}");
    expect(pointsStyle).toContain(".points-hero__balance--compact");
  });

  it("exposes modal and tab state without leaving background Home actions reachable", async () => {
    const homeView = await source("apps/miniprogram/pages/home/index.wxml");
    const communityView = await source("apps/miniprogram/pages/community/index.wxml");

    expect(homeView).toContain('disabled="{{accountOpening || sessionMounted}}" aria-hidden="{{sessionMounted}}"');
    expect(homeView).toContain('class="care-console" aria-hidden="{{sessionMounted}}"');
    expect(homeView).toContain('aria-role="dialog" aria-modal="true"');
    expect(communityView).toContain('aria-role="tablist" aria-label="社区内容分类"');
    expect(communityView.match(/aria-role="tab"/g)).toHaveLength(4);
    expect(communityView.match(/aria-selected=/g)).toHaveLength(4);
  });

  it("scrolls long-page failures into view and names recovery accurately", async () => {
    const account = await source("apps/miniprogram/pages/account/index.ts");
    const accountView = await source("apps/miniprogram/pages/account/index.wxml");
    const settingsView = await source("apps/miniprogram/pages/settings/index.wxml");

    expect(account).toContain('selector: "#account-error-summary"');
    expect(accountView).toContain('id="account-error-summary"');
    expect(settingsView).toContain("刷新许可状态后重新选择撤回");
  });
});
