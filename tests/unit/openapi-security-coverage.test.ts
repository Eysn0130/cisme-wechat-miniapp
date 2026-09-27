import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { expect, it } from "vitest";
import { documentedOperations, registeredSourceOperations } from "../../scripts/route-contract-lib.js";

// Public here means no member session, not no authorization: upload and
// preview routes use short signed tokens; platform callbacks verify signatures.
// Keep this reviewed exception list explicit so a new route cannot silently
// become public merely by adding `security: []` to OpenAPI.
const publicOperations = new Set([
  "GET /v1/capabilities",
  "GET /v1/identity/capabilities",
  "GET /v1/legal",
  "POST /v1/identity/dev",
  "POST /v1/identity/wechat",
  "POST /v1/identity/wechat/privacy-rights",
  "POST /v1/uploads/{mediaId}",
  "POST /v1/uploads/{mediaId}/chunks",
  "POST /v1/uploads/{mediaId}/assemble",
  "GET /v1/feed",
  "GET /v1/feed/page",
  "GET /v1/feed/{postId}",
  "GET /v1/catalog",
  "GET /v1/catalog/{productCode}",
  "GET /v1/commerce/orders/status",
  "POST /v1/payments/wechat/callback",
  "POST /v1/payments/wechat/refund-callback",
  "POST /v1/payments/wechat/transfer-callback",
  "GET /v1/shares/{shareId}",
  "POST /v1/shares/{shareId}/visits",
  "GET /v1/ugc/status",
  "GET /v1/ugc/posts",
  "GET /v1/ugc/posts/{postId}",
  "GET /v1/ugc/posts/{postId}/comments",
  "GET /v1/ugc/authors/{authorId}",
  "GET /v1/ugc/media/{mediaId}",
  "GET /v1/ugc/review-preview/{mediaId}",
  "GET /v1/ugc/own-preview/{ownerId}/{mediaId}",
  "GET /v1/ugc/scan-source/{mediaId}",
  "GET /v1/ugc/safety-callback",
  "POST /v1/ugc/safety-callback"
]);
const optionalSessionOperations = new Set(["GET /v1/community/{postId}"]);

it("declares a supported security policy for every registered versioned operation", () => {
  const source = readFileSync("services/api/src/server.ts", "utf8");
  const spec = readFileSync("openapi/openapi.yaml", "utf8");
  const registered = registeredSourceOperations(source);
  const documented = documentedOperations(spec);
  expect(documented).toEqual(registered);
  const document = yaml.load(spec) as { paths: Record<string, Record<string,
    { security?: Array<Record<string, unknown>> }>>; components: { securitySchemes: Record<string, unknown> } };
  const allowedSchemes = new Set(Object.keys(document.components.securitySchemes));
  const seenPublic = new Set<string>();
  const seenOptional = new Set<string>();
  for (const operation of registered) {
    const route = document.paths[operation.path];
    const policy = route?.[operation.method.toLowerCase()]?.security;
    const key = `${operation.method} ${operation.path}`;
    expect(policy, `${key} must state its security policy`).toBeDefined();
    for (const alternative of policy ?? [])
      for (const scheme of Object.keys(alternative))
        expect(allowedSchemes.has(scheme), `${key}: ${scheme}`).toBe(true);
    if (publicOperations.has(key)) {
      seenPublic.add(key);
      expect(policy, `${key}: reviewed public/signed-token/callback exception`).toEqual([]);
    } else if (optionalSessionOperations.has(key)) {
      seenOptional.add(key);
      expect(policy, `${key}: reviewed optional member context`).toEqual([{}, { session: [] }]);
    } else {
      expect(policy, `${key}: signed session required unless explicitly reviewed`).toEqual([{ session: [] }]);
    }
  }
  expect(seenPublic).toEqual(publicOperations);
  expect(seenOptional).toEqual(optionalSessionOperations);
  expect(allowedSchemes).toEqual(new Set(["session"]));
});
