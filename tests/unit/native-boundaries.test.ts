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
    expect(checkout).toContain("价格会在提交前再次确认");
  });

  it("contains no React DOM, browser globals or deferred social routes", async () => {
    const source = await sources(resolve("apps/miniprogram"));
    for (const forbidden of ["react-dom", "window.", "document.", "localStorage", "pages/growth", "pages/messages", "pages/comments", "pages/search", "pages/cart", "pages/coupons"]) expect(source).not.toContain(forbidden);
    expect(source).toContain("wx.chooseMedia");
    expect(source).toContain("wx.uploadFile");
    expect(source).toContain("wx.login");
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
      "--cisme-text-micro: 10px",
      "--cisme-text-small: 12px",
      "--cisme-text-body: 14px",
      "--cisme-text-action: 16px",
      "--cisme-hit-target: 44px"
    ]) expect(appStyle).toContain(token);
    expect(appStyle).toContain("min-height: var(--cisme-hit-target)");

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
      "checkout/index.wxml": 3,
      "settings/index.wxml": 1,
      "post/index.wxml": 1,
      "privacy-rights/index.wxml": 1,
      "product/index.wxml": 2,
      "progress/index.wxml": 3,
      "submit/index.wxml": 3,
      "task/index.wxml": 5
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
    const publishButton = tabButtons.find((tag) => attributeValue(tag, "wx:if") === "{{communityFabMounted}}")!;
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
      account: ["back", "openLegalDocuments", "openCrossBorder", "loginTap", "browseCommunity"],
      community: ["selectMode", "selectMode", "selectMode", "selectMode", "loadReview", "reviewMemberProfile", "reviewMemberProfile", "copyPostUrl", "reviewSubmission", "reviewSubmission", "reviewSubmission", "copyPostUrl", "publishSubmission", "load", "loadTasks", "openInvite", "openPost"],
      home: ["openSupport", "primaryAction", "selectProtocolStep", "retryLoad", "closeCareSession", "advanceCareStep", "selectAssessment", "submitCareSession"],
      invite: ["back", "prepare", "@share", "load"],
      legal: ["back", "load", "privacyRights"],
      management: ["back", "retry", "openSupport", "openCatalog", "openOrders"],
      "management-catalog": ["back", "create", "load", "open", "loadMore"],
      "management-product": ["back", "keepLocalDraft", "loadRemoteDraft", "save", "qualify", "qualify", "qualify", "publication", "publication", "inventory"],
      "management-orders": ["back", "load", "open", "loadMore"],
      "management-order-detail": ["back", "load"],
      "management-support": ["back", "open", "retry"],
      "management-support-chat": ["back", "openContext", "loadOlder", "retry", "jumpToLatest", "claim", "suggest", "send", "resolve", "closeContext"],
      points: ["back", "openShop", "load"],
      post: ["likeComment", "replyComment", "deleteComment", "back", "@share", "toggleFollow", "expandReplies", "load", "back", "loadSocial", "cancelReply", "sendComment", "toggleLike", "toggleSave", "showComments", "@share"],
      "privacy-rights": ["back", "submit", "load", "login", "@feedback"],
      product: ["back", "galleryPrevious", "galleryNext", "selectSku", "decrease", "increase", "openCheckout", "load", "back"],
      checkout: ["back", "selectSku", "decrease", "increase", "editAddresses", "selectAddress", "requestQuote", "refreshQuote", "confirmOrder"],
      orders: ["back", "load", "open", "openShop", "loadMore"],
      "order-detail": ["back", "load", "cancel"],
      profile: ["openAccount", "openSettings", "openRecords", "openSupport", "openPoints", "openShop", "openOrders", "openInvite", "openManagement", "openTasks", "openSettings", "load", "retryTasks"],
      progress: ["back", "revise", "revise", "appeal", "load", "back", "goCommunity", "load", "back", "goCommunity"],
      records: ["authenticate", "retryLoad", "goHome", "changeCycle", "changeCycle", "changeCycle", "goHome", "openRecordDetail", "showEarlierCycles", "goHome", "goShop", "closeRecordDetail"],
      settings: ["back", "openAccount", "openAddresses", "chooseAvatar", "removeAvatar", "saveProfile", "bindPhone", "unbindPhone", "reloadProfile", "newAddress", "loadAddresses", "discardRecoveredAddressDraft", "restoreAddressDraft", "newAddress", "editAddress", "setDefaultAddress", "deleteAddress", "revoke", "openLegal", "openPrivacyRights", "toggleAbout", "copyMemberId", "logout", "reauthenticate", "load"],
      shop: ["back", "openProduct", "openProduct", "load"],
      submit: ["back", "load", "back", "copySubmissionId", "retryDraftSave", "resolveDraftConflict", "focusPostUrl", "load", "openMediaPrivacy", "openMediaSettings", "load", "chooseMedia", "load", "focusPostUrl", "submit", "chooseMedia", "chooseMedia", "submit", "openProgress"],
      support: ["back", "loadOlder", "retry", "jumpToLatest", "@disabled", "send", "requestHuman"],
      task: ["back", "continueSubmission", "load", "back", "goCommunity", "claim", "@disabled", "continueSubmission"]
    };

    const actual: Record<string, string[]> = {};
    for (const { path, source } of await pageMarkup(root)) {
      const route = path.slice(root.length + 1).split("/")[0]!;
      const actions = buttonStartTags(source).map((tag) => {
        const handler = attributeValue(tag, "bindtap") ?? attributeValue(tag, "catchtap") ?? attributeValue(tag, "bindgetphonenumber") ?? attributeValue(tag,"bindchooseavatar") ?? (attributeValue(tag,"form-type") === "submit" ? source.match(/<form[^>]*bindsubmit="([^"]+)"/)?.[1] : undefined);
        if (handler) return handler;
        if (attributeValue(tag, "open-type") === "share") return "@share";
        if (attributeValue(tag, "open-type") === "feedback") return "@feedback";
        if (attributeValue(tag, "disabled") !== undefined) return "@disabled";
        return "@missing";
      });
      if (actions.length) actual[route] = actions;
    }
    expect(actual).toEqual(expected);

    for (const [route, actions] of Object.entries(expected)) {
      const logic = await readFile(resolve(root, route, "index.ts"), "utf8");
      for (const handler of new Set(actions.filter((action) => !action.startsWith("@")))) {
        expect(logic, `${route}.${handler}`).toMatch(new RegExp(`(?:async\\s+)?${handler}\\s*\\(`));
      }
    }
  });

  it("pins the Web-truth button baselines and fixed action geometry", async () => {
    const appStyle = await readFile(resolve("apps/miniprogram/app.wxss"), "utf8");
    const account = await readFile(resolve("apps/miniprogram/pages/account/index.wxss"), "utf8");
    const accountMarkup = await readFile(resolve("apps/miniprogram/pages/account/index.wxml"), "utf8");
    const records = await readFile(resolve("apps/miniprogram/pages/records/index.wxss"), "utf8");
    const task = await readFile(resolve("apps/miniprogram/pages/task/index.wxss"), "utf8");
    const submit = await readFile(resolve("apps/miniprogram/pages/submit/index.wxss"), "utf8");
    const submitMarkup = await readFile(resolve("apps/miniprogram/pages/submit/index.wxml"), "utf8");
    const post = await readFile(resolve("apps/miniprogram/pages/post/index.wxss"), "utf8");
    const product = await readFile(resolve("apps/miniprogram/pages/product/index.wxss"), "utf8");
    const profile = await readFile(resolve("apps/miniprogram/pages/profile/index.wxss"), "utf8");
    const points = await readFile(resolve("apps/miniprogram/pages/points/index.wxss"), "utf8");
    const customTab = await readFile(resolve("apps/miniprogram/custom-tab-bar/index.wxss"), "utf8");

    expect(appStyle).toMatch(/button\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;[^}]*font-weight:\s*400;[^}]*line-height:\s*1\.25;/s);
    expect(appStyle).toMatch(/\.primary,\s*\.secondary\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*min-height:\s*50px;[^}]*font-family:\s*-apple-system[^}]*font-size:\s*var\(--cisme-text-action\);[^}]*line-height:\s*20px;/s);
    expect(appStyle).toMatch(/\.action-label\s*\{[^}]*font-size:\s*var\(--cisme-text-action\);[^}]*font-weight:\s*400;[^}]*line-height:\s*20px;[^}]*transform:\s*translateY\(1px\);/s);
    expect(account).toContain(".account-login { flex:0 0 50px; height:50px; margin-top:36rpx; padding-top:0; padding-bottom:0; font-size:var(--cisme-text-action); line-height:20px; }");
    expect(account).toContain(".account-browse { flex:0 0 50px; height:50px; margin-top:18rpx; padding-top:0; padding-bottom:0; font-size:var(--cisme-text-action); line-height:20px; }");
    expect(account).toContain(".account-checkbox { flex:0 0 auto; width:60rpx; height:60rpx; transform:none; }");
    expect(account).toContain(".account-checkbox .wx-checkbox-input { width:38rpx; height:38rpx; margin:10rpx; border-radius:12rpx; }");
    expect(account).toMatch(/\.account-row \{[^}]*min-height:104rpx;/);
    expect(account).toMatch(/\.account-legal-entry \{[^}]*display:flex;[^}]*align-items:center;[^}]*justify-content:center;[^}]*min-height:44px;[^}]*line-height:20px;/);
    expect(accountMarkup).not.toContain('class="account-caret"');
    expect(accountMarkup).toContain("已有账号直接登录，首次登录自动注册");
    expect(account).toMatch(/\.account-agreement__label \{[^}]*min-height:128rpx;/);
    expect(account).toMatch(/@media \(max-height:820px\)[\s\S]*\.account-card \{ margin-top:32rpx; \}/);
    expect(account).toMatch(/@media \(max-height:820px\)[\s\S]*\.account-login \{ margin-top:24rpx; \}[\s\S]*\.account-browse \{ margin-top:12rpx; \}/);
    expect(await readFile(resolve("apps/miniprogram/pages/home/index.wxml"), "utf8")).toContain('<text class="care-cta__label">{{view.action}}</text>');
    expect(await readFile(resolve("apps/miniprogram/pages/home/index.wxss"), "utf8")).toMatch(/\.care-cta\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s);
    expect(records).toContain(".cycle-button--single { grid-column:1/-1; width:100%; }");
    for (const styles of [task, submit, product]) {
      expect(styles).toMatch(/position:fixed;[^}]*right:20rpx;[^}]*bottom:calc\([^}]*\+ 16rpx\);[^}]*left:20rpx;/);
      expect(styles).toContain("min-height:50px");
    }
    expect(customTab).toContain('font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif');
    expect(post).toMatch(/\.post-action \{[^}]*align-items:center;[^}]*justify-content:center;[^}]*min-height:48px;[^}]*font-size:var\(--cisme-text-small\);[^}]*line-height:1\.5;/);
    expect(profile).toContain(".profile-row{display:flex;align-items:center");
    expect(profile).toContain(".profile-row__copy strong{color:#403545;font-size:27rpx;font-weight:500}");
    expect(points).toMatch(/\.points-shop \{[^}]*display:flex;[^}]*align-items:center;[^}]*justify-content:center;[^}]*min-height:44px;[^}]*font-size:var\(--cisme-text-small\);/);
    expect(customTab).toContain(".bar__item.control--disabled { color:#746979; background:transparent; opacity:.58; }");
    expect(submitMarkup).toMatch(/bindtap="retryDraftSave"\s+loading="\{\{savingDraft\}\}"\s+disabled="\{\{savingDraft\}\}"/);
    expect(submitMarkup).toMatch(/class="primary submit-action__button[^>]*loading="\{\{working\}\}"\s+disabled="\{\{!canSubmit\}\}"/);
    expect(submitMarkup).not.toContain('loading="{{working || savingDraft}}"');
    expect(submitMarkup).toContain('<text class="action-label">提交人工审核</text>');
  });
});
