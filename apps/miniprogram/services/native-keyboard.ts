let keyboardHeight = 0;
let listening = false;
let dismissalScheduled = false;

export function observeNativeKeyboard(): void {
  if (listening || typeof wx.onKeyboardHeightChange !== "function") return;
  listening = true;
  wx.onKeyboardHeightChange(({ height }) => { keyboardHeight = height; });
}

export function dismissNativeKeyboardOnTap(event: WechatMiniprogram.TouchEvent): void {
  // Native fields and editors can transfer focus without closing the input method.
  if (keyboardHeight <= 0 || event.target?.dataset?.keyboardField !== undefined || dismissalScheduled) return;
  if (typeof wx.hideKeyboard !== "function") return;
  dismissalScheduled = true;
  // Leave the original tap available to navigation, form controls and buttons.
  wx.nextTick(() => {
    dismissalScheduled = false;
    if (keyboardHeight > 0) wx.hideKeyboard({ fail: () => {} });
  });
}
