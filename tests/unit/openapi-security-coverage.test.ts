import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { expect, it } from "vitest";
import { documentedOperations, registeredSourceOperations } from "../../scripts/route-contract-lib.js";

it("declares a supported security policy for every registered versioned operation", () => {
  const source = readFileSync("services/api/src/server.ts", "utf8");
  const spec = readFileSync("openapi/openapi.yaml", "utf8");
  const registered = registeredSourceOperations(source);
  const documented = documentedOperations(spec);
  expect(documented).toEqual(registered);
  const document = yaml.load(spec) as { paths: Record<string, Record<string,
    { security?: Array<Record<string, unknown>> }>>; components: { securitySchemes: Record<string, unknown> } };
  const allowedSchemes = new Set(Object.keys(document.components.securitySchemes));
  for (const operation of registered) {
    const route = document.paths[operation.path];
    const policy = route?.[operation.method.toLowerCase()]?.security;
    expect(policy, `${operation.method} ${operation.path} must state its security policy`).toBeDefined();
    for (const alternative of policy ?? [])
      for (const scheme of Object.keys(alternative))
        expect(allowedSchemes.has(scheme), `${operation.method} ${operation.path}: ${scheme}`).toBe(true);
    if (operation.path.startsWith("/v1/admin/") || operation.path.startsWith("/v1/management/"))
      expect(policy, `${operation.method} ${operation.path} must require the signed operator session`).toEqual([{ session: [] }]);
  }
  expect(allowedSchemes).toEqual(new Set(["session"]));
});
