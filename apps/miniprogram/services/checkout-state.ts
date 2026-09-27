export interface QuoteClock {
  expiresAtMs: number;
  serverOffsetMs: number;
}

export function createQuoteClock(expiresAt: string, serverTime: string, receivedAtMs = Date.now()): QuoteClock {
  const expiresAtMs = Date.parse(expiresAt);
  const serverTimeMs = Date.parse(serverTime);
  return {
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0,
    serverOffsetMs: Number.isFinite(serverTimeMs) ? serverTimeMs - receivedAtMs : 0
  };
}

export function quoteClockView(clock: QuoteClock, nowMs = Date.now()): { expired: boolean; remainingMs: number; label: string } {
  const remainingMs = Math.max(0, clock.expiresAtMs - (nowMs + clock.serverOffsetMs));
  const seconds = Math.ceil(remainingMs / 1_000);
  return {
    expired: seconds <= 0,
    remainingMs,
    label: seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "已过期"
  };
}

const quoteDefaults = {
  quote: null,
  quoteClock: null,
  quoteKey: "",
  createKey: "",
  countdown: "",
  subtotalYuan: "",
  discountYuan: "",
  shippingYuan: "",
  totalYuan: "",
  creditYuan:"",
  cashYuan:"",
  error: ""
};

const privateDefaults = {
  formalPayment:false,isolatedPayment:false,runtimeEnabled:false,
  addresses: [] as unknown[],
  selectedAddressId: "",
  creditEnabled:false,
  creditAvailableCents:0,
  creditAvailableYuan:"0.00",
  creditInput:"",
  creditReadError:"",
  ...quoteDefaults
};

export function clearCheckoutPrivateState<TState extends Record<string, unknown>>(state: TState): TState & typeof privateDefaults {
  return { ...state, ...privateDefaults };
}

export function invalidateCheckoutQuote<TState extends Record<string, unknown>>(state: TState, patch: Record<string, unknown> = {}, preserveError = false): TState & typeof quoteDefaults {
  const error = preserveError ? String(state.error ?? "") : "";
  return { ...state, ...quoteDefaults, ...patch, error };
}

export function requestStillOwned(
  state: { mounted: boolean; visible: boolean; epoch: number; sessionToken: string },
  requestEpoch: number,
  requestSessionToken: string
): boolean {
  return state.mounted && state.visible && state.epoch === requestEpoch && state.sessionToken === requestSessionToken;
}
