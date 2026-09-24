import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(resolve(path), "utf8");
}

describe("mini program submission flow safety", () => {
  it("requires explicit storage and review consent instead of defaulting missing grants on", async () => {
    const submit = await source("apps/miniprogram/pages/submit/index.ts");
    const view = await source("apps/miniprogram/pages/submit/index.wxml");
    const styles = await source("apps/miniprogram/pages/submit/index.wxss");

    expect(submit).toContain("permissions: { content_storage: false, human_review: false, feed_readonly: false }");
    expect(submit).toContain("content_storage: license.content_storage === true");
    expect(submit).toContain("human_review: license.human_review === true");
    expect(submit).toContain("data.permissions.content_storage");
    expect(submit).toContain("data.permissions.human_review");
    expect(submit).toContain('data.postUrl.trim().startsWith("https://")');
    expect(view).toContain("disabled=\"{{!canSubmit}}\"");
    expect(styles).toContain("height:108rpx; min-height:108rpx");
  });

  it("keeps the task in history and gives progress a non-circular return path", async () => {
    const task = await source("apps/miniprogram/pages/task/index.ts");
    const progress = await source("apps/miniprogram/pages/progress/index.ts");
    const progressView = await source("apps/miniprogram/pages/progress/index.wxml");

    expect(task).toContain("wx.navigateTo({ url: `/pages/submit/index?id=${claim.submissionId}`");
    expect(task).toContain("if (!retainMemberSnapshot(this)) this.setData({ task: null");
    expect(task).toContain("if (!requireMemberAccess()) { this.setData({ loading: false");
    expect(task).toContain("loadAttempt: 0");
    expect(task).toContain("this.data.loadAttempt === attempt");
    expect(task).toContain('errorTitle: "无法打开邀请详情"');
    expect(task).toContain('errorAction: "missing"');
    expect(task).not.toContain("wx.redirectTo({ url: `/pages/submit/index?id=${claim.submissionId}`");
    expect(progress).toContain("if (previousIsSource) wx.navigateBack({ delta: 1, fail: openSource });");
    expect(progress).toContain('previous?.route === "pages/task/index" && previous.options?.id === expectedTaskId');
    expect(progress).toContain('wx.switchTab({ url: "/pages/community/index", fail: failed })');
    expect(await source("apps/miniprogram/pages/shop/index.ts")).toContain('wx.switchTab({ url: "/pages/community/index" })');
    expect(progress).toContain("statusTitle: view.title, statusSubtitle: view.subtitle, timeline: progressTimeline(status)");
    expect(progress).toContain('reviewState = status === "needs_changes" ? "待补件" : status === "rejected" ? "未通过"');
    expect(progressView).toContain("返回投稿来源");
    expect(progressView).toContain("返回社区首页");
  });

  it("keeps authentication, navigation and draft exits recoverable", async () => {
    const api = await source("apps/miniprogram/services/api.ts");
    const account = await source("apps/miniprogram/pages/account/index.ts");
    const task = await source("apps/miniprogram/pages/task/index.ts");
    const taskView = await source("apps/miniprogram/pages/task/index.wxml");
    const submit = await source("apps/miniprogram/pages/submit/index.ts");
    const submitView = await source("apps/miniprogram/pages/submit/index.wxml");
    const layout = await source("apps/miniprogram/services/layout.ts");

    expect(api).toContain("export function cancelAuthentication()");
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
    expect(task).toContain("投稿页面暂未打开，请点击“继续完成投稿”再次进入");
    expect(task).toContain("任务正在领取并生成唯一投稿编号");
    expect(task).toContain("if (this.data.working) { wx.showToast");
    expect(task).toContain("if (!this.data.pageAlive) return");
    expect(taskView).toContain('disabled="{{working}}"');
    expect(submit).toContain("wx.enableAlertBeforeUnload");
    expect(submit).toContain('confirmText: "放弃并返回"');
    expect(submit).toContain("if (!this.data.pageAlive) return");
    expect(submit).toContain("this.data.working || this.data.uploadingKind");
    expect(submit).toContain("motionDuration(200)");
    expect(layout).toMatch(/export function motionDuration\(_duration: number\): number \{[\s\S]*?return 0;/);
    expect(submit).toContain("审核进度页暂时无法打开。投稿权威状态不会改变");
    expect(submitView).toContain('disabled="{{working || !!uploadingKind || savingDraft || resolvingDraftConflict || navigatingToProgress || confirmingExit}}"');
    expect(submit).toContain("confirmingExit: false");
    expect(submit).toContain("草稿离开确认窗口暂时无法打开");
    expect(api).toContain("rememberSubmissionReturn");
    expect(api).toContain("context?.submissionId !== submissionId");
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
    expect(account).toMatch(/onShow\(\)\s*\{[^\n]*this\.syncLegalDocuments\(\)/);
    expect(account).toMatch(/onShow\(\)\s*\{[^\n]*void this\.syncLegalDocuments\(\);/);
    expect(account).toMatch(/syncLegalDocuments\(\)\s*\{[\s\S]*legalTextsReady:\s*Boolean\(documents\)/);
    expect(account).toContain("legalDocuments.privacy");
    expect(account).toContain("legalDocuments.terms");
    expect(account).toContain("不是正式用户协议");
    expect(accountView).toContain('bindtap="openLegalDocuments"');
    expect(accountView).toContain("选择查看用户协议或隐私保护指引");
    expect(accountView).toContain('disabled="{{loading || leaving || !legalTextsReady}}"');
    expect(accountView).toContain("协议暂不可用");
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

    expect(community).toContain('feedModel(this).feed = []; this.setData({ error: "社区内容暂时无法加载');
    expect(community).toContain("this.data.feedAttempt === attempt");
    expect(home).toContain("authorityAvailable: false");
    expect(home).toContain("care: null, view: homeView(null)");
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
    const submit = await source("apps/miniprogram/pages/submit/index.ts");
    const submitView = await source("apps/miniprogram/pages/submit/index.wxml");
    const task = await source("apps/miniprogram/pages/task/index.ts");
    const taskView = await source("apps/miniprogram/pages/task/index.wxml");
    const community = await source("apps/miniprogram/pages/community/index.ts");
    const profile = await source("apps/miniprogram/pages/profile/index.ts");
    const shop = await source("apps/miniprogram/pages/shop/index.ts");
    const shopView = await source("apps/miniprogram/pages/shop/index.wxml");
    const points = await source("apps/miniprogram/pages/points/index.ts");
    const pointsView = await source("apps/miniprogram/pages/points/index.wxml");
    const progress = await source("apps/miniprogram/pages/progress/index.ts");
    const progressView = await source("apps/miniprogram/pages/progress/index.wxml");
    const tab = await source("apps/miniprogram/custom-tab-bar/index.ts");
    const tabView = await source("apps/miniprogram/custom-tab-bar/index.wxml");
    const post = await source("apps/miniprogram/pages/post/index.ts");
    const product = await source("apps/miniprogram/pages/product/index.ts");
    const productView = await source("apps/miniprogram/pages/product/index.wxml");

    expect(account).toContain("if (this.data.loading && this.data.identityCommitStarted)");
    expect(account).toContain("身份请求已发送");
    expect(account).toContain("离开页面不会撤回已提交的身份确认");
    expect(accountView).toContain('disabled="{{leavePromptOpen || leaving || avatarBusy}}"');
    expect(account).toContain('confirmIdentityLeave(destination: "source" | "community")');
    expect(account).toContain('wx.navigateBack({ delta: 1');
    expect(accountView).toContain("停止等待，浏览公开社区");

    expect(submit).toContain("this.setData({ uploadAttempt, uploadingKind: kind, lastUploadKind: kind, canSubmit: false");
    expect(submit).toMatch(/if \(!this\.data\.mediaUploadsEnabled\)[\s\S]*?return;[\s\S]*?if \(this\.data\.draftDirty\) await this\.saveDraft\(\)/);
    expect(submitView).toContain('disabled="{{!mediaUploadsEnabled || !editable || working || !!uploadingKind || savingDraft}}"');
    expect(submitView).toContain("本页不会请求相册或相机权限，也不会上传图片");
    expect(submit).toContain("this.setData({ working: true, canSubmit: false");
    expect(submitView).toContain('data-kind="{{lastUploadKind}}"');
    expect(submitView).toContain('disabled="{{working || !!uploadingKind || savingDraft}}"');
    expect(submit).toContain('submitRecovery: "" as "" | "retry" | "reload" | "edit"');
    expect(submit).toContain('failure.recovery !== "retry"');
    expect(submit).toContain('["SUBMISSION_LOCKED", "SUBMISSION_STATE_INVALID", "SUBMISSION_NOT_FOUND"]');
    expect(submit).toContain('working: true, canSubmit: false, draftRecovery: "", uploadRecovery: "", submitRecovery: ""');
    expect(submit).toContain('uploadingKind: kind, lastUploadKind: kind, canSubmit: false, draftRecovery: "", uploadRecovery: "", submitRecovery: ""');
    expect(submitView).toContain("重新加载权威投稿状态");

    expect(task).toContain("continuationSubmissionId");
    expect(task).toContain("this.data.task?.submission_id || this.data.continuationSubmissionId");
    expect(task).toContain("const refreshed = await this.load()");
    expect(task).toContain("邀请资格已更新");
    expect(taskView).toContain("继续完成投稿");
    expect(community).toContain("投稿与邀请暂时无法打开");
    expect(profile).toContain("设置与隐私暂时无法打开");
    for (const [logic, view] of [[shop, shopView], [points, pointsView]]) {
      expect(logic).toContain("if (this.data.navigating) return");
      expect(logic).toContain("this.setData({ navigating: true })");
      expect(logic).toContain("this.setData({ navigating: false })");
      expect(view).toContain("{{navigating ? 'control--disabled' : ''}}");
      expect(view).toContain('disabled="{{navigating}}"');
    }
    expect(progress).toContain('errorAction: "revise"');
    expect(progress).toContain('"APPEAL_STATE_INVALID"');
    expect(progress).toContain("if (this.data.working || this.data.navigatingAway || this.data.appealBlocked || !this.data.appealValid) return");
    expect(progressView).toContain('disabled="{{!appealValid || working || appealBlocked}}"');
    expect(progressView).toContain("再次打开补件页面");
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

  it("serializes draft loads and drops async work after page unload", async () => {
    const submit = await source("apps/miniprogram/pages/submit/index.ts");
    const submitView = await source("apps/miniprogram/pages/submit/index.wxml");

    expect(submit).toContain("loadAttempt: 0");
    expect(submit).toContain("uploadAttempt: 0");
    expect(submit).toContain("this.data.uploadAttempt += 1");
    expect(submit).toContain("this.data.loadAttempt !== attempt");
    expect(submit).toContain("this.data.draftRevision !== revisionAtLoad");
    expect(submit).toMatch(/const saved = await request<any>\([\s\S]*?if \(!this\.data\.pageAlive\) return;[\s\S]*?const changedWhileSaving/);
    expect(submit).toMatch(/if \(this\.data\.draftDirty\) await this\.saveDraft\(\);\n\s+if \(!this\.data\.pageAlive\) return;/);
    expect(submit).toMatch(/catch \(error\) \{\n\s+if \(!this\.data\.pageAlive\) return;\n\s+const failure = draftFailure\(error\);/);
    expect(submit).toMatch(/wx\.requirePrivacyAuthorize[\s\S]*?if \(!uploadIsCurrent\(\)\) return;[\s\S]*?wx\.chooseMedia/);
    expect(submit).toMatch(/wx\.chooseMedia[\s\S]*?if \(!uploadIsCurrent\(\)\) return;[\s\S]*?media\/authorize/);
    expect(submit).toMatch(/wx\.showModal\([\s\S]*?if \(!uploadIsCurrent\(\)\) return;[\s\S]*?media\/authorize/);
    expect(submit).toMatch(/media\/authorize[\s\S]*?if \(!uploadIsCurrent\(\)\) return;[\s\S]*?uploadAuthorized/);
    expect(submit).toMatch(/uploadAuthorized[\s\S]*?if \(!uploadIsCurrent\(\)\) return;[\s\S]*?\/complete/);
    expect(submit).toMatch(/\/complete[\s\S]*?if \(!uploadIsCurrent\(\)\) return;[\s\S]*?await this\.load\(\)/);
    expect(submit).toMatch(/requireMemberAccess\(\)[\s\S]*?retainMemberSnapshot\(this\)[\s\S]*?clearMemberSnapshot\(\)/);
    expect(submit).toMatch(/clearMemberSnapshot\(\)[\s\S]*?submission: null[\s\S]*?mediaUploadsEnabled: false[\s\S]*?postUrl: ""[\s\S]*?permissions: \{ content_storage: false, human_review: false, feed_readonly: false \}/);
    expect(submitView).toContain('bindtap="load" disabled="{{loading}}"');
  });

  it("guards consent revocation exits and distinguishes unknown session state", async () => {
    const settings = await source("apps/miniprogram/pages/settings/index.ts");
    const settingsView = await source("apps/miniprogram/pages/settings/index.wxml");

    expect(settings).toContain('sessionStatus: "unknown"');
    expect(settings).toContain('problem.status === 401 || problem.code === "MEMBER_NOT_FOUND"');
    expect(settings).toContain("this.data.revokeAttempt !== attempt");
    expect(settings).toContain("用途许可撤回正在确认");
    expect(settings).toContain("confirmingLogout: false");
    expect(settings).toContain('title: "确认退出当前账号？"');
    expect(settings).toContain("this.data.workingConsentId || this.data.confirmingLogout || this.data.loggingOut");
    expect(settings).toMatch(/logout\(\) \{[\s\S]*?this\.data\.loadAttempt \+= 1;[\s\S]*?setSessionToken\(""\);/);
    expect(settings).toContain('loading: false, consents: [], sessionStatus: "invalid"');
    expect(settings).toContain("设置快照暂时无法加载，请检查网络后重试。");
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

  it("only presents authoritative actionable invitations and truthful gated fixtures", async () => {
    const community = await source("apps/miniprogram/pages/community/index.ts");
    const communityView = await source("apps/miniprogram/pages/community/index.wxml");
    const profile = await source("apps/miniprogram/pages/profile/index.ts");
    const profileView = await source("apps/miniprogram/pages/profile/index.wxml");
    const shopView = await source("apps/miniprogram/pages/shop/index.wxml");
    const editorial = await source("apps/miniprogram/services/editorial.ts");
    const taskEntries = await source("apps/miniprogram/services/task-entry.ts");

    for (const route of [community, profile]) {
      expect(route).toContain("consumerTaskEntries(taskHistory)");
      expect(route).toContain("tasksError");
      expect(route).not.toContain(".catch(() => [])");
    }
    expect(taskEntries).toContain('case "rejected"');
    expect(taskEntries).toContain('case "needs_changes"');
    expect(taskEntries).toContain("task.claimable === true || Boolean(task.submission_id)");
    expect(communityView).toContain("活动暂未加载，请重试。");
    expect(communityView).toContain('bindtap="loadTasks"');
    expect(profileView).toContain("同步失败 · 点此重试");
    expect(profileView).toContain('wx:if="{{tasksError && member}}"');
    expect(profileView).not.toContain("微信支付与真实配送尚未开放");
    expect(shopView).toContain("全部商品");
    expect(shopView).toContain("catalog && catalog.items.length && !purchaseAvailable");
    expect(shopView).toContain("商品可浏览，暂不能下单。");
    expect(editorial).toContain("内容授权尚待确认");
  });

  it("rejects stale profile and post responses and revalidates UGC on foreground", async () => {
    const profile = await source("apps/miniprogram/pages/profile/index.ts");
    const post = await source("apps/miniprogram/pages/post/index.ts");
    const tab = await source("apps/miniprogram/custom-tab-bar/index.ts");
    const tabView = await source("apps/miniprogram/custom-tab-bar/index.wxml");

    expect(profile).toContain("loadAttempt: 0, snapshotVersion: 0, tasksAttempt: 0, auxiliaryAttempt: 0, pageAlive: true");
    expect(profile).toContain("this.data.loadAttempt === attempt");
    expect(profile).toContain("this.data.tasksAttempt !== attempt");
    expect(profile).toContain("member:null, points:null, care:null, authority:null, commercialEligible:false, commercialAccessible:false, supportUnread:null");
    expect(post).toContain("onShow() { this.setData({ pageAlive: true, leaving: false }); void this.load(); }");
    expect(post).not.toContain("allowPublicBrowsing");
    expect(post).toContain("this.data.loadAttempt !== attempt");
    expect(post).toContain('this.setData({ loadAttempt: attempt, socialEnabled: false, socialBusy: false, socialLoading: false, social: emptyCommunity, threads: [], following: false, followError: "", item: null, media: [], mediaIndex: 0, shareId: "", loading: true');
    expect(tab).toContain("wx.pageScrollTo({ scrollTop: 0, duration: 0 })");
    expect(tab).toContain("reducedMotion: shouldReduceMotion()");
    expect(tabView).toContain("bar--reduced-motion");
  });

  it("announces operation results and blocks mutation-time exits", async () => {
    const accountView = await source("apps/miniprogram/pages/account/index.wxml");
    const recordsView = await source("apps/miniprogram/pages/records/index.wxml");
    const settingsView = await source("apps/miniprogram/pages/settings/index.wxml");
    const progress = await source("apps/miniprogram/pages/progress/index.ts");
    const progressView = await source("apps/miniprogram/pages/progress/index.wxml");

    expect(accountView).toContain('aria-live="assertive" aria-atomic="true"');
    expect(recordsView).toContain('class="records-operation-status" aria-live="polite"');
    expect(recordsView).toContain('id="records-error-summary"');
    expect(settingsView).toContain('class="settings-operation-status" aria-live="polite"');
    expect(progress).toContain("申诉正在提交并确认权威状态");
    expect(progress).toContain("if (this.data.working || this.data.navigatingToRevision || this.data.navigatingAway) { wx.showToast");
    expect(progress).toContain("if (this.data.pageAlive) await this.load()");
    expect(progress).toContain("onUnload() { this.data.pageAlive = false");
    expect(progressView).toContain('disabled="{{working}}"');
    expect(progressView).toContain('class="progress-status" aria-live="polite" aria-atomic="true"');
  });

  it("invalidates stale authority and navigation locks across authentication and tab transitions", async () => {
    const home = await source("apps/miniprogram/pages/home/index.ts");
    const submit = await source("apps/miniprogram/pages/submit/index.ts");
    const community = await source("apps/miniprogram/pages/community/index.ts");
    const tab = await source("apps/miniprogram/custom-tab-bar/index.ts");
    const account = await source("apps/miniprogram/pages/account/index.ts");

    expect(home).toContain('loading: false, authorityAvailable: false, needsAuthentication: true');
    expect(home).toContain('action: "授权身份并开始"');
    expect(home).not.toContain("onShow() { if (!requireMemberAccess()) return;");
    expect(submit).toContain("if (!this.data.hasShown)");
    expect(submit).toContain("!this.data.draftDirty && !this.data.savingDraft && !this.data.working && !this.data.uploadingKind");
    expect(community).toContain("邀请状态已更新，请重试");
    expect(tab).toContain("current?.data?.working || current?.data?.navigating");
    expect(tab).toContain("liveExternalBusy");
    expect(account).toContain("if (this.data.authAttempt === attempt)");
  });

  it("keeps stacked-page chrome on measured capsule and safe-area variables", async () => {
    const appStyle = await source("apps/miniprogram/app.wxss");
    const postStyle = await source("apps/miniprogram/pages/post/index.wxss");
    const productStyle = await source("apps/miniprogram/pages/product/index.wxss");
    const submitStyle = await source("apps/miniprogram/pages/submit/index.wxss");

    expect(appStyle).toMatch(/\.page--stack\s*\{[^}]*padding-top:\s*var\(--cisme-stack-top/s);
    for (const style of [postStyle, productStyle]) {
      expect(style).not.toContain("padding:calc(env(safe-area-inset-top) + 188rpx)");
      expect(style).toContain("padding-top:var(--cisme-stack-top");
      expect(style).toContain("var(--cisme-safe-bottom,env(safe-area-inset-bottom))");
    }
    expect(submitStyle).toContain("var(--cisme-safe-bottom,env(safe-area-inset-bottom))");
  });

  it("serializes public catalog, financial and review loads across hide and unload", async () => {
    const shop = await source("apps/miniprogram/pages/shop/index.ts");
    const product = await source("apps/miniprogram/pages/product/index.ts");
    const points = await source("apps/miniprogram/pages/points/index.ts");
    const progress = await source("apps/miniprogram/pages/progress/index.ts");

    for (const route of [shop, product, points, progress]) {
      expect(route).toContain("loadAttempt: 0");
      expect(route).toContain("this.data.loadAttempt += 1");
      expect(route).toContain("this.data.loadAttempt !== attempt");
      expect(route).toContain("this.data.pageAlive = false");
    }
    expect(shop).toContain("catalog: null, featured: null, purchaseAvailable:false, loading: true");
    expect(product).toContain('item: null, catalog: null, shareId: "", loading: true');
    expect(product).toContain("formatCnyCents(raw.price)");
    expect(product).toContain('throw new Error("CATALOG_PRICE_INVALID")');
    expect(product).toContain('wx.redirectTo({ url: "/pages/shop/index"');
    expect(product).toContain('wx.switchTab({ url: "/pages/community/index", fail: failed })');
    expect(points).toContain('points: null as any, balanceClass: "", loading: true');
    expect(progress).toContain('errorTitle: "无法打开审核进度"');
    expect(progress).toContain('problem.code === "SUBMISSION_NOT_FOUND"');
    expect(progress).not.toContain('(error as { title?: string }).title ?? "进度加载失败"');
    expect(progress).toContain('throw new Error("SUBMISSION_STATUS_INVALID")');
    expect(progress).not.toContain("views[submission.status] ?? views.draft");
    expect(progress).toContain('submission: null, statusTitle: "", statusSubtitle: "", statusLabel: "", reviewReason: ""');
  });

  it("keeps care controls and progress recovery visually aligned with their busy predicates", async () => {
    const records = await source("apps/miniprogram/pages/records/index.wxml");
    const progressLogic = await source("apps/miniprogram/pages/progress/index.ts");
    const progress = await source("apps/miniprogram/pages/progress/index.wxml");

    expect(records.match(/loading="\{\{workingAction === '(?:pause|resume)'\}\}" disabled="\{\{!writeReady \|\| working \|\| confirmingCycleAction\}\}"/g)).toHaveLength(2);
    expect(records.match(/\{\{!writeReady \|\| working \|\| confirmingCycleAction \? 'control--disabled' : ''\}\}/g)).toHaveLength(3);
    expect(records.match(/\{\{working \|\| confirmingCycleAction \? 'control--disabled' : ''\}\}/g)).toHaveLength(3);
    expect(progressLogic).toContain("未找到这份投稿记录");
    expect(progress).toContain("返回投稿来源");
    expect(progress).toContain("重新加载审核进度");
    expect(progress).toContain("inline-action-error");
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
    const progress = await source("apps/miniprogram/pages/progress/index.ts");
    const progressView = await source("apps/miniprogram/pages/progress/index.wxml");
    const settingsView = await source("apps/miniprogram/pages/settings/index.wxml");

    expect(account).toContain('selector: "#account-error-summary"');
    expect(accountView).toContain('id="account-error-summary"');
    expect(progress).toContain('errorAction: "appeal"');
    expect(progressView).toContain("刷新审核状态后重试申诉");
    expect(settingsView).toContain("刷新许可状态后重新选择撤回");
  });
});
