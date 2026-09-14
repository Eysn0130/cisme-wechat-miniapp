import type { AppConfig } from "@cisme/config";
import { issueSessionToken } from "../../services/api/src/auth";

// Legacy role fixtures exercise historical service decisions. The HTTP actor
// is nevertheless a signed, active synthetic member session, never a header.
export function operatorHeaders(config: AppConfig, principalId: string, memberId: string, extras: Record<string, string> = {}) {
  const token = issueSessionToken({ principalId, memberId, adapter: "dev", provider: "dev_test", appId: "dev" }, config.sessionSecret);
  return { authorization: `Bearer ${token}`, ...extras };
}
