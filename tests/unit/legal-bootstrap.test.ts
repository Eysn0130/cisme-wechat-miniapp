import { describe, expect, it } from "vitest";
import { legalRequestFailure, parseLegalBootstrap } from "../../apps/miniprogram/services/legal-bootstrap";
import { nativeNetworkFailure } from "../../apps/miniprogram/services/network-failure";

const valid = () => ({ ready: true, documents: [
  { document_type: "privacy", version: "v1" }, { document_type: "terms", version: "v1" }
] });

describe("legal bootstrap is a runtime contract, not a truthy consent gate", () => {
  it("projects only active versions and never publishes response bodies to diagnostics", () => {
    const input = valid(); Object.assign(input.documents[0]!, { body: "private-fixture", ignored: "fixture" });
    const result = parseLegalBootstrap(input);
    expect(result.documents).toEqual({ privacy: "v1", terms: "v1", localFixture: false });
    expect(JSON.stringify(result)).not.toContain("private-fixture");
  });
  it.each([null, "<html>gateway</html>", [], {}, { ready: true },
    { ready: "false", documents: valid().documents }, { ready: 1, documents: valid().documents },
    { ready: true, documents: {} }, { ready: true, documents: [null] },
    { ready: true, documents: [{ document_type: "privacy", version: 1 }, valid().documents[1]] },
    { ready: true, documents: [{ document_type: "privacy", version: "  " }, valid().documents[1]] },
    { ready: true, documents: [valid().documents[0]] },
    { ready: true, documents: [...valid().documents, { document_type: "terms", version: "v2" }] }
  ].map(input => ({ input }))) ("rejects malformed, misleading or ambiguous response %#", ({ input }) => {
    expect(parseLegalBootstrap(input)).toEqual({ documents: null, error: "invalid", diagnostic: "LEGAL_RESPONSE_INVALID" });
  });
  it("distinguishes an explicit unpublished response from transport/format failure", () => {
    expect(parseLegalBootstrap({ ready: false, documents: [] })).toEqual({ documents: null, error: "unpublished", diagnostic: "LEGAL_NOT_PUBLISHED" });
  });
  it("preserves optional cross-border consent and rejects ambiguous cross-border versions", () => {
    const input = valid(); input.documents.push({ document_type: "cross_border", version: "c1" });
    expect(parseLegalBootstrap(input).documents?.crossBorder).toBe("c1");
    input.documents.push({ document_type: "cross_border", version: "c2" });
    expect(parseLegalBootstrap(input).error).toBe("invalid");
  });
  it("ignores unrelated legal metadata without weakening required-document validation", () => {
    const input = valid(); input.documents.push({ document_type: "marketing", version: "m1" });
    expect(parseLegalBootstrap(input).documents?.terms).toBe("v1");
  });
});

describe("bounded legal and native-network failure categories", () => {
  it.each([
    ["request:fail url not in domain list", "NETWORK_DOMAIN_NOT_ALLOWED"],
    ["request:fail ssl hand shake error", "NETWORK_TLS_ERROR"],
    ["request:fail ERR_CERT_DATE_INVALID", "NETWORK_TLS_ERROR"],
    ["request:fail ERR_NAME_NOT_RESOLVED", "NETWORK_DNS_ERROR"],
    ["request:fail ECONNREFUSED", "NETWORK_CONNECTION_REFUSED"],
    ["request:fail timeout", "NETWORK_TIMEOUT"],
    ["request:fail abort", "REQUEST_ABORTED"],
    ["request:fail interrupted", "NETWORK_ERROR"]
  ])("classifies %s without copying errMsg", (message, code) => {
    const result = nativeNetworkFailure(`${message}; fixture-sensitive-value`);
    expect(result.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain("fixture-sensitive-value");
    expect(legalRequestFailure(result).diagnostic).toBe(code);
  });
  it("records an HTTP status without retaining the server's message or trace payload", () => {
    expect(legalRequestFailure({ status: 502, code: "untrusted", title: "fixture-sensitive-value" }))
      .toEqual({ error: "unreachable", diagnostic: "HTTP_502" });
  });
  it.each([null, { code: "fixture-sensitive-value" }, { status: "503" }, { status: 999 }, { errMsg: "fixture-sensitive-value" }])(
    "drops unrecognised diagnostics %#", (value) => {
      expect(legalRequestFailure(value)).toEqual({ error: "unreachable", diagnostic: "LEGAL_REQUEST_FAILED" });
    });
});
