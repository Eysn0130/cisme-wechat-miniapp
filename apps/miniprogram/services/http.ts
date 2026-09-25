import { measurementClock, metricAction, projectNetworkPhases, recordClientMetric } from "./performance-metrics";
import type { CloudHttpTarget } from "../release-config";
import { nativeNetworkFailure } from "./network-failure";
type JsonResponse = WechatMiniprogram.RequestSuccessCallbackResult<WechatMiniprogram.IAnyObject>;
interface JsonRequest {
  path: string;
  origin: string;
  cloud?: CloudHttpTarget | null;
  method: "GET" | "POST" | "PUT" | "DELETE";
  data?: WechatMiniprogram.IAnyObject;
  header: Record<string, string>;
  timeoutMs?: number;
  success: (response: JsonResponse) => void;
  fail: (error: unknown) => void;
}
interface NativeCloudHttp {
  init: (options: { env: string; traceUser: boolean }) => void;
  callHTTPFunction?: (options: {
    name: string;
    config: { env: string };
    path: string;
    method: JsonRequest["method"];
    data?: WechatMiniprogram.IAnyObject;
    header: Record<string, string>;
    timeout: number;
    success: JsonRequest["success"];
    fail: JsonRequest["fail"];
  }) => unknown;
}
export interface TransportHandle { abort(): void }
let initializedCloudEnv = "";
export function normalizeTransportError(error: unknown): unknown {
  const input = error as { code?: string; errMsg?: string } | null;
  if (input?.code) return error;
  return nativeNetworkFailure(input?.errMsg);
}

function timeoutProblem() {
  return { code: "NETWORK_TIMEOUT", title: "网络响应超时，请检查网络后重试" };
}

export function sendJsonRequest(options: JsonRequest): TransportHandle {
  const { cloud, path, origin } = options;
  if (!cloud && !origin) throw new Error("MINIPROGRAM_API_BASE_URL_MISSING");

  const transportTimeoutMs = options.timeoutMs ?? 12_000;
  if (!Number.isFinite(transportTimeoutMs) || transportTimeoutMs <= 0) throw new Error("INVALID_REQUEST_TIMEOUT");
  let physicalAbort = () => {};
  const started = measurementClock();
  let settled = false;
  const finish = <T>(callback: (value: T) => void, value: T) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    callback(value);
  };
  const succeed = (response: JsonResponse) => {
    if (!settled) recordClientMetric({ action: metricAction(path), stage: "transport", durationMs: measurementClock() - started, transport: cloud ? "cloud" : "direct", status: response.statusCode,
      ...(!cloud ? { phases: projectNetworkPhases(response.profile) } : {}) });
    finish(options.success, response);
  };
  const fail = (error: unknown) => {
    if (!settled) recordClientMetric({ action: metricAction(path), stage: "transport", durationMs: measurementClock() - started, transport: cloud ? "cloud" : "direct" });
    finish(options.fail, normalizeTransportError(error));
  };
  const timeout = setTimeout(() => { if (!settled) { fail(timeoutProblem()); physicalAbort(); } }, transportTimeoutMs);

  if (cloud) {
    const sdk = (wx as unknown as { cloud?: NativeCloudHttp }).cloud;
    if (!sdk?.callHTTPFunction) {
      fail({ code: "CLOUD_HTTP_UNAVAILABLE", title: "请升级微信后重试" });
      return { abort() { fail({ code: "REQUEST_ABORTED", title: "请求已取消" }); } };
    }
    try {
      if (initializedCloudEnv !== cloud.env) {
        sdk.init({ env: cloud.env, traceUser: false });
        initializedCloudEnv = cloud.env;
      }
      sdk.callHTTPFunction({
        method: options.method,
        ...(options.data ? { data: options.data } : {}),
        header: { ...options.header, "X-CISME-Transport": "cloud-http-v1" },
        name: cloud.name, config: { env: cloud.env }, path, timeout: transportTimeoutMs,
        success: (response) => {
          const envelope = response.data?.cismeHttpError as { version?: number; statusCode?: number; data?: unknown } | undefined;
          if (envelope?.version === 1 && Number.isInteger(envelope.statusCode) && envelope.statusCode! >= 400 && envelope.statusCode! <= 599 && envelope.data && typeof envelope.data === "object") {
            succeed({ ...response, statusCode: envelope.statusCode!, data: envelope.data as WechatMiniprogram.IAnyObject });
            return;
          }
          succeed(response);
        },
        fail
      });
    } catch (error) { fail(error); }
    return { abort() { fail({ code: "REQUEST_ABORTED", title: "请求已取消" }); } };
  }
  try {
  const task = wx.request({
    method: options.method,
    ...(options.data ? { data: options.data } : {}),
    header: options.header,
    url: `${origin}${path}`,
    timeout: transportTimeoutMs,
    success: succeed,
    fail
  });
  physicalAbort = () => task.abort();
  } catch (error) { fail(error); }
  return { abort() { if (!settled) { fail({ code: "REQUEST_ABORTED", title: "请求已取消" }); physicalAbort(); } } };
}
