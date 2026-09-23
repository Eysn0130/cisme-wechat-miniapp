import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueSessionToken, verifySessionToken } from "../../services/api/src/auth";

const secret = "unit-session-secret";

function signedPayload(payload: unknown): string {
  const encoded = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function expectAuthError(work: () => unknown, code: string): void {
  try {
    work();
    throw new Error("EXPECTED_AUTH_ERROR");
  } catch (error) {
    expect(error).toMatchObject({ code, status: 401 });
  }
}

describe("session token verification", () => {
  it("accepts issued tokens and rejects expired tokens", () => {
    const audience = { wechatAppId: "wx4eac2d4fb11d299b", allowDevAdapters: true };
    const token = issueSessionToken({ principalId: "dev:identity-1", memberId: "member-1", adapter: "dev", provider: "dev_test", appId: "dev" }, secret, 1_000);
    expect(verifySessionToken(token, secret, audience, 2_000)).toMatchObject({ id: "dev:identity-1", memberId: "member-1", adapter: "dev" });
    expectAuthError(() => verifySessionToken(token, secret, audience, 1_000 + 12 * 60 * 60 * 1_000), "AUTH_EXPIRED");
    expectAuthError(() => verifySessionToken(token, secret, { ...audience, allowDevAdapters: false }, 2_000), "AUTH_AUDIENCE_INVALID");
  });

  it("maps signed malformed or structurally invalid payloads to 401", () => {
    const audience = { wechatAppId: "wx4eac2d4fb11d299b", allowDevAdapters: true };
    expectAuthError(() => verifySessionToken(signedPayload("not-json"), secret, audience), "AUTH_INVALID");
    expectAuthError(() => verifySessionToken(signedPayload({ principalId: "dev:1", memberId: "", adapter: "dev", provider: "dev_test", appId: "dev", expiresAt: Date.now() + 60_000 }), secret, audience), "AUTH_INVALID");
    expectAuthError(() => verifySessionToken(signedPayload({ principalId: "dev:1", memberId: "member-1", adapter: "other", provider: "dev_test", appId: "dev", expiresAt: Date.now() + 60_000 }), secret, audience), "AUTH_INVALID");
    expectAuthError(() => verifySessionToken(signedPayload({ principalId: "wechat:1", memberId: "member-1", adapter: "wechat", provider: "wechat_miniprogram", appId: "wx-other", expiresAt: Date.now() + 60_000 }), secret, audience), "AUTH_AUDIENCE_INVALID");
    expectAuthError(() => verifySessionToken(`${signedPayload({ principalId: "dev:1", memberId: "member-1", adapter: "dev", provider: "dev_test", appId: "dev", expiresAt: Date.now() + 60_000 })}.extra`, secret, audience), "AUTH_INVALID");
  });

  it("bounds a closed-account rights token to WeChat and thirty minutes",()=>{
    const audience={wechatAppId:'wx4eac2d4fb11d299b',allowDevAdapters:true};
    const rights=issueSessionToken({principalId:'wechat_miniprogram:identity-1',memberId:'member-1',
      adapter:'wechat',provider:'wechat_miniprogram',appId:audience.wechatAppId,scope:'privacy_rights'},secret,1_000);
    expect(verifySessionToken(rights,secret,audience,2_000)).toMatchObject({scope:'privacy_rights',memberId:'member-1'});
    expectAuthError(()=>verifySessionToken(rights,secret,audience,1_000+30*60*1_000),'AUTH_EXPIRED');
    expectAuthError(()=>verifySessionToken(signedPayload({principalId:'dev:1',memberId:'member-1',adapter:'dev',
      provider:'dev_test',appId:'dev',scope:'privacy_rights',expiresAt:Date.now()+30_000}),secret,audience),'AUTH_INVALID');
    expectAuthError(()=>verifySessionToken(signedPayload({principalId:'wechat_miniprogram:1',memberId:'member-1',
      adapter:'wechat',provider:'wechat_miniprogram',appId:audience.wechatAppId,scope:'privacy_rights',
      expiresAt:Date.now()+12*60*60*1_000}),secret,audience),'AUTH_INVALID');
  });
});
