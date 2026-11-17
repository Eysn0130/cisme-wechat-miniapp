/** Use WeChat's official privacy dialog at the first user-requested private
 * capability. No onNeedPrivacyAuthorization listener suppresses its fallback.
 * Our versioned legal acceptance remains independent of platform consent. */
export async function ensureWechatPrivacy(): Promise<void> {
  if (typeof wx.requirePrivacyAuthorize !== "function") return; // pre-2.32.3
  try {
    await new Promise<void>((resolve, reject) => wx.requirePrivacyAuthorize({
      success: () => resolve(), fail: reject
    }));
  } catch {
    throw {code:"WECHAT_PRIVACY_DECLINED", title:"未完成隐私确认，可稍后继续或先浏览公开内容"};
  }
}
