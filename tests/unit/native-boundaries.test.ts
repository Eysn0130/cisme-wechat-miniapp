import {nativePageTemplate} from "../helpers/native-page-template";
import { nativeCatalogImage } from "../../apps/miniprogram/services/catalog";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function sources(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) chunks.push(await sources(path));
    else if (/\.(ts|wxml|wxss|json)$/.test(entry.name)) chunks.push(await readFile(path, "utf8"));
  }
  return chunks.join("\n");
}

async function pageStyles(directory: string): Promise<Array<{ path: string; source: string }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const styles: Array<{ path: string; source: string }> = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) styles.push(...await pageStyles(path));
    else if (entry.name.endsWith(".wxss")) styles.push({ path, source: await readFile(path, "utf8") });
  }
  return styles;
}

async function pageMarkup(directory: string): Promise<Array<{ path: string; source: string }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const markup: Array<{ path: string; source: string }> = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) markup.push(...await pageMarkup(path));
    else if (entry.name.endsWith(".wxml")) markup.push({ path, source: await readFile(path, "utf8") });
  }
  return markup;
}

// Detect property access, including optional/computed access, without treating
// a sentence ending in "document." as a browser DOM dependency.
const browserGlobalAccess = /\b(?:window|document)\s*(?:(?:\?\.)?\s*\[|(?:\?\.|\.)\s*[A-Za-z_$])/;

function buttonStartTags(source: string): string[] {
  return [...source.matchAll(/<button\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)].map((match) => match[0]!);
}

function attributeValue(tag: string, name: string): string | null | undefined {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}(?:\\s*=\\s*"([^"]*)")?(?=\\s|/?>)`));
  if (!match) return undefined;
  return match[1] ?? null;
}

describe("native mini program boundary", () => {
  it("keeps internal pricing rule identifiers out of the buyer checkout surface", async () => {
    const checkout = await readFile(resolve("apps/miniprogram/pages/checkout/index.wxml"), "utf8");
    expect(checkout).not.toContain("quote.pricingRuleVersion");
    expect(checkout).toContain("费用已过期，请重新确认。");
    expect(checkout).toContain('bindtap="refreshQuote"');
  });

  it("contains no React DOM, browser globals or deferred social routes", async () => {
    const source = await sources(resolve("apps/miniprogram"));
    for (const forbidden of ["react-dom", "localStorage", "pages/growth", "pages/messages", "pages/comments", "pages/search", "pages/cart", "pages/coupons"]) expect(source).not.toContain(forbidden);
    expect(source).not.toMatch(browserGlobalAccess);
    expect(source).toContain("wx.chooseMedia");
    expect(source).toContain("wx.uploadFile");
    expect(source).toContain("wx.login");
  });

  it("rejects actual browser global access rather than legal-document prose", () => {
    for (const forbidden of ["document.createElement('div')", "window.location", "document . body", "window?.location", "document['body']", 'window?.["location"]']) expect(forbidden).toMatch(browserGlobalAccess);
    expect("Never parse HTML supplied by a document. */").not.toMatch(browserGlobalAccess);
  });

  it("does not reference packaged WebP assets that can disappear on physical devices", async () => {
    const source = await sources(resolve("apps/miniprogram"));
    const legacyInputs = [...source.matchAll(/["'](\/assets\/[^"']+\.webp)["']/g)].map(match => match[1]!);
    for (const input of legacyInputs) {
      // Legacy catalog inputs must resolve to a packaged non-WebP output.
      const output = nativeCatalogImage(input);
      expect(output).not.toMatch(/\.webp$/);
      await expect(readFile(resolve("apps/miniprogram", output.slice(1)))).resolves.toBeDefined();
    }
  });

  it("keeps page WXSS free of structural and pseudo-element selectors", async () => {
    const styles = await pageStyles(resolve("apps/miniprogram/pages"));
    const unsupported = /(?:\s[>+~]\s|:(?:first|last|nth-[a-z-]+|not)\s*\(|::(?:before|after)\b|\[[^\]]+\])/g;
    const findings = styles.flatMap(({ path, source }) => [...source.matchAll(/([^{}]+)\{/g)]
      .flatMap((selectorMatch) => [...selectorMatch[1]!.matchAll(unsupported)].map((match) => `${path}:${match[0].trim()}`)));
    expect(findings).toEqual([]);
  });

  it("keeps native typography and hit targets on the frozen legibility tokens", async () => {
    const appStyle = await readFile(resolve("apps/miniprogram/app.wxss"), "utf8");
    for (const token of [
      "--cisme-text-micro: 11px",
      "--cisme-text-small: 12px",
      "--cisme-text-body: 14px",
      "--cisme-text-action: 16px",
      "--cisme-hit-target: 44px"
    ]) expect(appStyle).toContain(token);
    expect(appStyle).toMatch(/min-height:\s*var\(--cisme-hit-target\)/);

    const styles = await pageStyles(resolve("apps/miniprogram/pages"));
    const undersized = styles.flatMap(({ path, source }) => [
      ...[...source.matchAll(/font-size:\s*(\d+)rpx/g)].map((match) => ({ path, value: Number(match[1]), rule: match[0] })),
      ...[...source.matchAll(/font:[^;{}]*?\b(\d+)rpx\b/g)].map((match) => ({ path, value: Number(match[1]), rule: match[0] }))
    ]).filter(({ value }) => value < 20);
    expect(undersized).toEqual([]);
  });

  it("overrides native disabled opacity with an explicit visual state", async () => {
    const appStyle = await readFile(resolve("apps/miniprogram/app.wxss"), "utf8");
    expect(appStyle).not.toContain(".primary[disabled]");
    expect(appStyle).toContain(".primary--disabled");
    expect(appStyle).toMatch(/\.primary--disabled\s*\{[^}]*background:\s*linear-gradient\(180deg,\s*#78528f,\s*#3e2454\)\s*!important;/s);
    expect(appStyle).toMatch(/\.primary--disabled\s*\{[^}]*opacity:\s*\.38\s*!important;/s);

    const root = resolve("apps/miniprogram/pages");
    const disabledPrimaryByFile = new Map<string, string[]>();
    for (const { path, source } of await pageMarkup(root)) {
      const tags = buttonStartTags(source)
        .filter((tag) => {
          const classValue = attributeValue(tag, "class") ?? "";
          return /(?:^|\s)primary(?:\s|$)/.test(classValue) && attributeValue(tag, "disabled") !== undefined;
        });
      if (tags.length) disabledPrimaryByFile.set(path.slice(root.length + 1), tags);
    }

    expect(Object.fromEntries([...disabledPrimaryByFile].map(([path, tags]) => [path, tags.length]))).toEqual({
      "account/index.wxml": 1,
      "aftersale/index.wxml": 1,
      "community-compose/index.wxml": 1,
      "commission/index.wxml": 2,
      "checkout/index.wxml": 3,
      "management-catalog/index.wxml": 1,
      "management-points/index.wxml": 2,
      "management-product/index.wxml": 1,
      "order-detail/index.wxml": 2,
      "settings/index.wxml": 1,
      "post/index.wxml": 1,
      "privacy-rights/index.wxml": 1,
      "management-privacy/index.wxml": 1,
      "management-fulfillment/index.wxml": 1,
      "product/index.wxml": 3,
      "referral/index.wxml": 2,
    });

    const normalize = (expression: string) => expression.replace(/\s+/g, "");
    for (const tags of disabledPrimaryByFile.values()) {
      for (const tag of tags) {
        const classValue = attributeValue(tag, "class") ?? "";
        const disabledValue = attributeValue(tag, "disabled");
        const disabledExpression = disabledValue?.match(/^\{\{([\s\S]+)\}\}$/)?.[1];
        if (!disabledExpression || normalize(disabledExpression) === "true") {
          expect(classValue).toMatch(/(?:^|\s)primary--disabled(?:\s|$)/);
          continue;
        }
        const modifierCondition = classValue.match(/\{\{(.+?)\?\s*'primary--disabled'\s*:\s*''\}\}/)?.[1];
        expect(modifierCondition, tag).toBeDefined();
        expect(normalize(modifierCondition!), tag).toBe(normalize(disabledExpression));
      }
    }
  });

  it("registers every native button action and keeps disabled visuals in lockstep", async () => {
    const root = resolve("apps/miniprogram/pages");
    const buttons = (await pageMarkup(root)).flatMap(({ path, source }) => buttonStartTags(source).map((tag) => ({ path, tag })));
    expect(buttons.length).toBeGreaterThan(0);

    const tabView = await readFile(resolve("apps/miniprogram/custom-tab-bar/index.wxml"), "utf8");
    const tabLogic = await readFile(resolve("apps/miniprogram/custom-tab-bar/index.ts"), "utf8");
    const tabButtons = buttonStartTags(tabView);
    expect(tabButtons).toHaveLength(2);
    const publishButton = tabButtons.find((tag) => attributeValue(tag, "wx:if") === "{{communityFabMounted && communityPublisherAvailable}}")!;
    const navigationButton = tabButtons.find((tag) => attributeValue(tag, "wx:for") === "{{items}}")!;
    expect(attributeValue(publishButton, "bindtap")).toBe("activateCommunityFab");
    expect(attributeValue(publishButton, "disabled")).toBe("{{switching || externalBusy || chromeHidden}}");
    expect(attributeValue(navigationButton, "bindtap")).toBe("switchTab");
    expect(attributeValue(navigationButton, "disabled")).toBe("{{switching || externalBusy || chromeHidden}}");
    expect([...tabLogic.matchAll(/path:\s*"\/pages\//g)]).toHaveLength(4);
    expect(tabLogic).toMatch(/switchTab\s*\(/);
    expect(tabLogic).toMatch(/activateCommunityFab\s*\(/);

    const normalize = (expression: string) => expression.replace(/\s+/g, "");
    const visualModifiers = ["primary--disabled", "control--disabled", "secondary--disabled", "text-button--disabled"];
    for (const { path, tag } of buttons) {
      const disabledValue = attributeValue(tag, "disabled");
      const hasAction = attributeValue(tag, "bindtap") !== undefined || attributeValue(tag, "catchtap") !== undefined || attributeValue(tag, "open-type") !== undefined || attributeValue(tag,"form-type") === "submit";
      expect(hasAction || disabledValue !== undefined, `${path}: ${tag}`).toBe(true);
      if (disabledValue === undefined) continue;

      const classValue = attributeValue(tag, "class") ?? "";
      const disabledExpression = disabledValue?.match(/^\{\{([\s\S]+)\}\}$/)?.[1];
      if (!disabledExpression || normalize(disabledExpression) === "true") {
        expect(visualModifiers.some((modifier) => new RegExp(`(?:^|\\s)${modifier}(?:\\s|$)`).test(classValue)), `${path}: ${tag}`).toBe(true);
        continue;
      }
      const conditions = [...classValue.matchAll(/\{\{([^{}]+?)\?\s*'(primary--disabled|control--disabled|secondary--disabled|text-button--disabled)'\s*:\s*''\}\}/g)].map((match) => normalize(match[1]!));
      expect(conditions, `${path}: ${tag}`).toContain(normalize(disabledExpression));
    }
  });

  it("locks the per-route button action inventory and verifies every handler exists", async () => {
    const root = resolve("apps/miniprogram/pages");
    const expected: Record<string, string[]> = {
      account: ["back", "openTerms", "openPrivacy", "openCrossBorder", "syncLegalDocuments", "openAccountHelp", "@contact", "restartLogin", "loginTap", "browseCommunity"],
      "community-activity": ["back", "selectSource", "selectSection", "retry", "openPost", "deleteComment", "openPost", "removeSaved", "openAppealedPost", "unblock", "loadMore"],
      commission: ["back", "load", "retryRuntime", "resolveRecovery", "loadRecovery", "showCreditForm", "closeCreditForm", "submitCredit", "cancelCredit", "retryCredits", "moreCredits", "showForm", "closeForm", "submit", "confirmReceipt", "retryList", "more"],
      "community-author": ["back", "back", "load", "openSettings", "toggleFollow", "openBio", "openDrafts", "openActivity", "openPost", "openDrafts", "onReachBottom", "closeBio", "saveBio", "reloadBio"],
      "community-compose": ["back", "showMyPosts", "retryPendingImageEdit", "discardPendingImageEdit", "openComposerMediaSettings", "retryChoosingMedia", "retryLoad", "verifyWriteResult", "reloadRemoteDraft", "startNew", "selectDraftFilter", "openDraft", "deleteListDraft", "loadMoreList", "openPublicationResult", "returnToCommunity", "refreshPublication", "editPendingPublication", "showMyPosts", "returnToCommunity", "submitAppeal", "retryPreview", "retryImage", "retryPreview", "removeImage", "addContent", "showMyPosts", "returnToCommunity", "refreshPublicGate", "saveDraft", "submit"],
      "community-post": ["back", "open"],
      "community-review": ["back", "back", "load", "back", "selectEditorialQueue", "openEditorialArticle", "reviewEditorial", "reviewEditorial", "reviewEditorial", "deleteEditorial", "loadMoreEditorialQueue"],
      community: ["selectMode", "selectMode", "selectMode", "selectMode", "loadReview", "reviewMemberProfile", "reviewMemberProfile", "decideFormalAppeal", "decideFormalAppeal", "loadMoreAppeals", "openReportTarget", "decideFormalReport", "decideFormalReport", "decideFormalReport", "loadMoreReports", "selectMode", "load", "openPost", "onReachBottom", "openMyPosts", "choosePublisherSource", "choosePublisherSource", "choosePublisherSource", "openPublisherMediaSettings", "retryPublisherMedia", "closePublisherEntry"],
      home: ["openSupport", "primaryAction", "selectProtocolStep", "openRecords", "retryLoad", "retryCareMutation", "closeCareSession", "retryLoad", "retryCareMutation", "toggleCareProduct", "continueCareUsage", "advanceCareStep", "selectAssessment", "submitCareSession"],
      invite: ["back", "prepare", "@share", "copyReferralCode", "@share", "openReferralConfirm", "load"],
      legal: ["back", "load", "privacyRights"],
      "management-member": ["back", "back", "load", "selectSection", "changeMembership", "changeMembership", "openRateForm", "selectOrderMode", "selectOrderMode", "openRow", "loadMoreSection", "retrySection", "closeRateForm", "selectRateMode", "selectRateMode", "closeRateForm", "submitRateForm"],
      "management-members": ["back", "openGlobalRateForm", "togglePending", "reviewRate", "reviewRate", "loadMoreRates", "search", "selectFilter", "load", "openMember", "loadMore", "closeGlobalRateForm", "closeGlobalRateForm", "submitGlobalRateForm"],
      management: ["back", "retry", "retryRuntime", "openSupport", "openAftersale", "openAftersale", "openAftersale", "openAftersale", "openAftersale", "openFinance", "openPrivacy", "openEditorialComments", "openSupport", "openPoints", "openCatalog", "openOrders", "openFulfillment", "openAftersale", "openMembers", "openPrivacy", "openFinance"],
      "management-catalog": ["back", "create", "load", "open", "loadMore"],
      "management-product": ["back", "keepLocalDraft", "loadRemoteDraft", "save", "qualify", "qualify", "qualify", "publication", "publication", "inventory"],
      "management-orders": ["back", "load", "open", "loadMore"],
      "management-order-detail": ["back", "back", "load", "reconcile", "submitShipment", "load"],
      aftersale: ["back", "retry", "retry", "clearAttention", "submit", "reconcile", "open", "next", "chooseOrderItems", "list", "openChat", "submit"],
      "management-fulfillment": ["back", "retry", "retry", "next", "exportExcel", "chooseXlsx", "submit", "reconcileBatch", "newBatch", "openImportOrder"],
      "management-privacy": ["back", "retry", "retry", "select", "loadMore", "retry", "executeCorrection", "submit", "closeDetail"],
      "management-finance": ["back", "selectSection", "importBill", "importBill", "prepareCycle", "approveCycleMember", "retry", "decide", "decide", "decide", "operateIssue", "operateIssue", "loadMore"],
      "management-support": ["back", "open", "retry"],
      "management-support-chat": ["back", "openContext", "loadOlder", "selectReplyTarget", "previewImage", "openOrder", "retrySend", "retry", "jumpToLatest", "openAftersales", "claim", "suggest", "send", "resolve", "closeContext", "approveReturn", "selectReturnCase", "openManageAftersale", "sendReturnInstruction", "closeAftersales"],
      "management-points": ["back", "load", "selectState", "choose", "more", "multiplier", "multiplier", "approve", "openPolicy", "feature", "close", "fulfill", "propose"],
      points: ["back", "openRules", "selectSection", "load", "openCommunity", "openShop", "openInvite", "load", "selectSource", "loadMore", "recoverGift", "recoverGift", "recoverGift", "chooseGift", "load", "giftAction", "giftAction", "giftAction", "openSupport", "load", "closeRules", "closeGift", "changeGiftQuantity", "changeGiftQuantity", "chooseAddress", "load", "openAddresses", "redeemGift"],
      post: ["replyComment", "deleteComment", "likeComment", "back", "load", "openAuthor", "toggleFollow", "loadSocial", "copySource", "loginToViewComments", "retryEditorialComments", "expandReplies", "loadMoreEditorialComments", "expandReplies", "load", "backToCommunity", "loadSocial", "cancelReply", "sendComment", "startComment", "toggleLike", "toggleSave", "@share", "sendComment", "toggleLike", "toggleSave", "showComments", "@share", "load", "editOwn", "deleteOwn", "closeEditorialBlocks", "loadEditorialBlocks", "unblockEditorialAuthor", "loadMoreEditorialBlocks"],
      "privacy-rights": ["back", "openSupport", "@contact", "openHistoricalOrders", "submit", "load", "startReply", "cancelReply", "sendReply", "viewSupplementary", "viewExport", "revokeExport", "retryExport", "changeManifestPage", "changeManifestPage", "sendManifestPage", "changePart", "changePart", "sendPart", "copyRequestId", "loadMore", "login"],
      product: ["back", "jumpAnchor", "jumpAnchor", "jumpAnchor", "previewGallery", "selectGallery", "load", "openSku", "previewDetail", "load", "back", "openSupport", "buy", "closeSku", "selectSku", "decrease", "increase", "confirmSku"],
      checkout: ["back", "retryLoad", "selectSku", "decrease", "increase", "editAddresses", "selectAddress", "retryLoad", "applyPoints", "requestQuote", "refreshQuote", "confirmOrder"],
      orders: ["back", "load", "open", "openShop", "loadMore"],
      "order-detail": ["back", "back", "load", "retryRuntime", "resolveRecovery", "loadRecovery", "expandSupport", "closeSupportSheet", "copySheetReturnInstruction", "openFullAftersale", "openFullAftersale", "chooseSheetQuantity", "chooseSheetQuantity", "loadSupportSheet", "submitSheetAftersale", "toggleSheetConsulting", "sendSheetMessage", "loadSupportSheet", "loadShipment", "copyWaybill", "openLogistics", "confirmWechatReceipt", "refreshWechatReceipt", "confirmReceipt", "openAftersale", "showRefundForm", "closeRefundForm", "submitRefund", "retryRefunds", "loadMoreRefunds", "preparePayment", "recheckPayment", "cancel"],
      profile: ["openAccount", "openSettings", "openPoints", "load", "openSupport", "openOrders", "openInvite", "openCommission", "retryAuxiliary", "openManagement", "openCommunityActivity", "openMyPosts", "openSettings"],
      progress: ["returnToCommunity"],
      records: ["backRecords", "selectCalendarDay", "retryUsageRecords", "moreUsageRecords", "authenticate", "retryLoad", "goHome", "changeCycle", "changeCycle", "changeCycle", "goHome", "showRecentRecords", "retryDailyMutation", "retryDailyRecords", "undoDailyDelete", "retryDailyRecords", "deleteDailyRecord", "openRecordDetail", "loadMoreDailyRecords", "openRecordDetail", "showEarlierCycles", "goHome", "goShop", "closeRecordDetail", "deleteDailyRecord"],
      referral: ["back", "preview", "confirm"],
      settings: ["back", "openAccount", "openCareProfile", "openAddresses", "chooseAvatar", "removeAvatar", "clearBirthday", "saveProfile", "bindPhone", "unbindPhone", "reloadProfile", "newAddress", "loadAddresses", "discardRecoveredAddressDraft", "restoreAddressDraft", "newAddress", "editAddress", "setDefaultAddress", "deleteAddress", "revoke", "openMemberManagement", "openLegal", "openPrivacyRights", "toggleAbout", "copyMemberId", "logout", "reauthenticate", "load"],
      shop: ["openOrders", "openProduct", "load", "openProduct"],
      submit: ["returnToCommunity"],
      support: ["back", "loadOlder", "openAftersaleCase", "previewImage", "openOrder", "retrySend", "retry", "retryHandoff", "jumpToLatest", "requestHuman", "startNewTopic", "retryImageUpload", "removeImage", "removeOrder", "openImageSheet", "openAttachmentSheet", "send", "chooseImage", "chooseImage", "openOrderPicker", "closeAttachmentSheet", "selectOrder", "loadMoreOrders", "openOrderPicker", "closeOrderPicker"],
      task: ["returnToCommunity"]
    };

    const actual: Record<string, string[]> = {};
    for (const { path, source } of await pageMarkup(root)) {
      const route = path.slice(root.length + 1).split("/")[0]!;
      const actions = buttonStartTags(nativePageTemplate(path)).map((tag) => {
        const handler = attributeValue(tag, "bindtap") ?? attributeValue(tag, "catchtap") ?? attributeValue(tag, "bindgetphonenumber") ?? attributeValue(tag,"bindchooseavatar") ?? (attributeValue(tag,"form-type") === "submit" ? source.match(/<form[^>]*bindsubmit="([^"]+)"/)?.[1] : undefined);
        if (handler) return handler;
        if (attributeValue(tag, "open-type") === "share") return "@share";
        if (attributeValue(tag, "open-type") === "contact") return "@contact";
        if (attributeValue(tag, "open-type") === "feedback") return "@feedback";
        if (attributeValue(tag, "disabled") !== undefined) return "@disabled";
        return "@missing";
      });
      if (actions.length) actual[route] = actions;
    }
    expect(actual).toEqual(expected);

    for (const [route, actions] of Object.entries(expected)) {
      let logic = await readFile(resolve(root, route, "index.ts"), "utf8");
      if (logic.includes("retiredTaskProofPage")) logic += await readFile(resolve("apps/miniprogram/services/retired-task-proof.ts"), "utf8");
      for (const handler of new Set(actions.filter((action) => !action.startsWith("@")))) {
        expect(logic, `${route}.${handler}`).toMatch(new RegExp(`(?:async\\s+)?${handler}\\s*\\(`));
      }
      // A native button may bind several callbacks, e.g. tap plus phone/avatar.
      // Lock its inventory above and verify every bound callback, not just tap.
      const markup = await readFile(resolve(root, route, "index.wxml"), "utf8");
      for (const tag of buttonStartTags(markup)) {
        for (const event of ["bindtap", "catchtap", "bindgetphonenumber", "bindchooseavatar"]) {
          const handler = attributeValue(tag, event);
          if (handler) expect(logic, `${route}.${event}:${handler}`).toMatch(new RegExp(`(?:async\\s+)?${handler}\\s*\\(`));
        }
      }
    }
  });

  it("keeps both chat composers native, height-bounded, and honest about attachment capability", async () => {
    const memberMarkup = await readFile(resolve("apps/miniprogram/pages/support/index.wxml"), "utf8");
    const memberStyles = await readFile(resolve("apps/miniprogram/pages/support/index.wxss"), "utf8");
    const operatorMarkup = await readFile(resolve("apps/miniprogram/pages/management-support-chat/index.wxml"), "utf8");
    const operatorStyles = await readFile(resolve("apps/miniprogram/pages/management-support-chat/index.wxss"), "utf8");

    expect(memberMarkup).not.toContain("support-plus");
    expect(memberMarkup).not.toContain(">＋<");
    expect(memberMarkup).toContain('bindtap="openImageSheet"');
    expect(memberMarkup).toContain('bindtap="openAttachmentSheet"');
    expect(memberMarkup).toContain('/assets/icons/composer-image-plum.svg');
    expect(memberMarkup).toContain('/assets/icons/composer-paperclip-plum.svg');
    expect(memberMarkup).toContain('/assets/icons/composer-send-white.svg');
    expect(memberMarkup).toMatch(/<textarea[^>]*auto-height="\{\{!composerCapped\}\}"[^>]*fixed="true"[^>]*adjust-position="true"[^>]*hold-keyboard="true"[^>]*disable-default-padding="true"/);
    expect(memberMarkup).toContain('bindkeyboardheightchange="onKeyboardHeightChange"');
    expect(memberStyles).toMatch(/\.support-input\s*\{[^}]*min-height:\s*224rpx;[^}]*max-height:\s*344rpx;[^}]*padding:\s*22rpx 22rpx 104rpx;/s);
    expect(memberStyles).toMatch(/\.support-composer__tools\s*\{[^}]*position:\s*absolute;[^}]*right:\s*10rpx;[^}]*bottom:\s*10rpx;/s);

    expect(operatorMarkup).toMatch(/<textarea[^>]*auto-height="\{\{!composerCapped\}\}"[^>]*fixed="true"[^>]*adjust-position="true"[^>]*hold-keyboard="true"[^>]*disable-default-padding="true"/);
    expect(operatorMarkup).not.toContain('bindtap="openImageSheet"');
    expect(operatorMarkup).not.toContain('bindtap="openAttachmentSheet"');
    expect(operatorStyles).toMatch(/\.operator-input\s*\{[^}]*min-height:\s*224rpx;[^}]*max-height:\s*344rpx;[^}]*padding:\s*22rpx 22rpx 104rpx;/s);
    expect(operatorStyles).toMatch(/\.operator-compose__tools\s*\{[^}]*position:\s*absolute;[^}]*right:\s*10rpx;[^}]*bottom:\s*10rpx;/s);
  });

  it("pins accepted native button geometry and truthful busy/unknown labels", async () => {
    const appStyle = await readFile(resolve("apps/miniprogram/app.wxss"), "utf8");
    const account = await readFile(resolve("apps/miniprogram/pages/account/index.wxss"), "utf8");
    const accountMarkup = await readFile(resolve("apps/miniprogram/pages/account/index.wxml"), "utf8");
    const actionStyles = await readFile(resolve("apps/miniprogram/styles/action-hierarchy.wxss"), "utf8");
    const records = await readFile(resolve("apps/miniprogram/pages/records/index.wxss"), "utf8");
    const post = await readFile(resolve("apps/miniprogram/pages/post/index.wxss"), "utf8");
    const product = await readFile(resolve("apps/miniprogram/pages/product/index.wxss"), "utf8");
    const profile = await readFile(resolve("apps/miniprogram/pages/profile/index.wxss"), "utf8");
    const points = await readFile(resolve("apps/miniprogram/pages/points/index.wxss"), "utf8");
    const customTab = await readFile(resolve("apps/miniprogram/custom-tab-bar/index.wxss"), "utf8");
    const communityCompose = await readFile(resolve("apps/miniprogram/pages/community-compose/index.wxss"), "utf8");
    const communityComposeMarkup = await readFile(resolve("apps/miniprogram/pages/community-compose/index.wxml"), "utf8");

    expect(appStyle).toMatch(/button\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;[^}]*font-weight:\s*400;[^}]*line-height:\s*1\.25;/s);
    expect(appStyle).toMatch(/\.primary,\s*\.secondary\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*min-height:\s*50px;[^}]*font-family:\s*-apple-system[^}]*font-size:\s*var\(--cisme-text-action\);[^}]*line-height:\s*1\.25;/s);
    expect(appStyle).toMatch(/\.action-label\s*\{[^}]*font-size:\s*var\(--cisme-text-action\);[^}]*font-weight:\s*400;[^}]*line-height:\s*1\.25;/s);
    expect(appStyle).not.toMatch(/\.action-label\s*\{[^}]*transform:/s);
    expect(account).toContain('@import "../../styles/action-hierarchy.wxss"');
    expect(actionStyles).toMatch(/\.action-main,\.action-secondary\{[^}]*min-height:50px;/);
    expect(actionStyles).toMatch(/\.action-text\{[^}]*min-height:44px;[^}]*border:0;/);
    expect(actionStyles).toMatch(/\.action-main\.primary--disabled\{[^}]*background:#e9e1ec!important;[^}]*opacity:1!important/);
    expect(account).toMatch(/\.account-login\{[^}]*min-height:50px;/);
    expect(account).toMatch(/\.account-browse\{[^}]*min-height:44px;/);
    expect(account).toMatch(/\.account-checkbox \.wx-checkbox-input\{[^}]*width:40rpx;height:40rpx;/);
    expect(account).toMatch(/\.account-legal-entry\{[^}]*min-height:44px;[^}]*white-space:nowrap;/);
    expect(accountMarkup).not.toContain('class="account-caret"');
    expect(accountMarkup).not.toContain("同意协议后即可登录");
    expect(accountMarkup).toContain("我已阅读并同意以下条款");
    expect(accountMarkup).toContain('bindtap="openTerms"');
    expect(accountMarkup).toContain('bindtap="openPrivacy"');
    expect(account).toMatch(/\.account-agreement__label\{[^}]*min-height:44px[;}]/);
    expect(account).toMatch(/\.account-hero\{[^}]*height:100vw;/);
    expect(account).toMatch(/@media \(max-height:700px\)[\s\S]*\.account-phone-note\{margin-top:20rpx\}/);
    expect(await readFile(resolve("apps/miniprogram/pages/home/index.wxml"), "utf8")).toContain("<text class=\"care-cta__label\">{{working ? '正在提交…' : mutationState === 'unknown' ? '重试操作' : view.action}}</text>");
    expect(await readFile(resolve("apps/miniprogram/pages/home/index.wxss"), "utf8")).toMatch(/\.care-cta\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s);
    expect(records).toContain(".cycle-button--single { grid-column:1/-1; width:100%; }");
    for (const styles of [product]) {
      expect(styles).toMatch(/\.product-buybar\{[^}]*position:fixed;[^}]*bottom:0;[^}]*safe-area-inset-bottom/);
      expect(styles).toContain("min-height:48px");
    }
    expect(customTab).toContain('font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif');
    expect(post).toMatch(/\.post-action \{[^}]*align-items:center;[^}]*justify-content:center;[^}]*min-height:44px;/);
    expect(post).toMatch(/\.post-bottom-action \{[^}]*align-items:center;[^}]*justify-content:center;[^}]*min-width:44px;[^}]*min-height:44px;/);
    expect(post).toMatch(/\.post-interaction-icon \{[^}]*width:24px;[^}]*height:24px;/);
    expect(post).toMatch(/\.post-comment-entry \{[^}]*min-height:44px;/);
    for(const selector of ["post-action","post-comment-entry"]){
      const rule=post.match(new RegExp(`\\.${selector} \\{([^}]*)\\}`))?.[1];
      const size=rule?.match(/font-size:\s*([\d.]+)(px|rem);/);
      expect(size,`${selector} default font`).toBeDefined();
      expect(Number(size![1])*(size![2]==="rem"?16:1)).toBe(selector==="post-comment-entry"?16:14);
    }
    expect(profile).toContain(".profile-row{display:flex;align-items:center");
    expect(profile).toContain(".profile-row__copy strong{color:#403545;font-size:27rpx;font-weight:500}");
    expect(points).toMatch(/\.points-shop \{[^}]*display:flex;[^}]*align-items:center;[^}]*justify-content:center;[^}]*min-height:44px;[^}]*font-size:var\(--cisme-text-small\);/);
    expect(customTab).toContain(".bar__item.control--disabled { color:#746979; background:transparent; opacity:.58; }");
    expect(communityCompose).toMatch(/\.composer-media__actions button\s*\{[^}]*width:44px;[^}]*height:44px;/);
    expect(communityCompose).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.composer-media--shifting,\.composer-drag-photo--dropping\s*\{\s*transition:none;/);
    expect(communityComposeMarkup).toMatch(/<scroll-view class="composer-media-scroll" scroll-x="\{\{true\}\}" scroll-left="\{\{mediaScrollLeft\}\}" bindscroll="onMediaScroll"/);
    expect(communityComposeMarkup).toContain('catchtouchmove="{{mediaDragging ? \'moveMediaDrag\' : \'\'}}"');
  });
});
