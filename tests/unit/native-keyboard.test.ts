import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it("keeps field-to-field focus and dismisses the keyboard after the original outside tap", async () => {
  vi.resetModules();
  const registerHeight = vi.fn<(listener: (event: { height: number }) => void) => void>();
  const nextTick = vi.fn<(run: () => void) => void>();
  const hideKeyboard = vi.fn();
  vi.stubGlobal("wx", { onKeyboardHeightChange: registerHeight, nextTick, hideKeyboard });
  const { observeNativeKeyboard, dismissNativeKeyboardOnTap } = await import("../../apps/miniprogram/services/native-keyboard");
  observeNativeKeyboard();
  observeNativeKeyboard();
  expect(registerHeight).toHaveBeenCalledTimes(1);
  const keyboard = registerHeight.mock.calls[0]![0];
  const tap = (dataset: Record<string, string> = {}) => ({ target: { dataset } }) as WechatMiniprogram.TouchEvent;

  dismissNativeKeyboardOnTap(tap());
  expect(nextTick).not.toHaveBeenCalled();
  keyboard({ height: 280 });
  dismissNativeKeyboardOnTap(tap({ keyboardField: "input" }));
  dismissNativeKeyboardOnTap(tap({ keyboardField: "editor" }));
  expect(nextTick).not.toHaveBeenCalled();

  dismissNativeKeyboardOnTap(tap());
  dismissNativeKeyboardOnTap(tap());
  expect(hideKeyboard).not.toHaveBeenCalled();
  expect(nextTick).toHaveBeenCalledTimes(1);
  nextTick.mock.calls[0]![0]();
  expect(hideKeyboard).toHaveBeenCalledTimes(1);

  dismissNativeKeyboardOnTap(tap());
  keyboard({ height: 0 });
  nextTick.mock.calls[1]![0]();
  expect(hideKeyboard).toHaveBeenCalledTimes(1);
});
