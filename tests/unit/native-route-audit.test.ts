import { describe, expect, it } from "vitest";
import { auditNativeRoutes } from "../../scripts/audit-native-routes";

describe("native route source audit", () => {
  it("keeps all registered routes, access policies, source paths and evidence gates inspectable", async () => {
    const audit = await auditNativeRoutes();
    expect(audit.routes).toHaveLength(38);
    expect(audit.evidenceManifestMatchesSource).toBe(true);
    expect(audit.routes.every(row => !row.stateGate.matrixComplete && row.stateGate.result === "blocked")).toBe(true);
    expect(audit.routes.find(row => row.route === "pages/home/index")?.access).toBe("public");
    expect(audit.routes.find(row => row.route === "pages/points/index")).toMatchObject({
      access: "member", sourceMarkers: { memberAccessCall: true, snapshotOwnerCall: true }
    });
    expect(audit.routes.find(row => row.route === "pages/points/index")?.apiPathExpressions).toContain("/v1/me/points");
  });
});
