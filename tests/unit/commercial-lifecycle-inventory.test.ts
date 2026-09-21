import { beforeAll, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { auditCommercialLifecycle } from "../../scripts/audit-commercial-lifecycle";
let audit:Awaited<ReturnType<typeof auditCommercialLifecycle>>;
beforeAll(async()=>{audit=await auditCommercialLifecycle();});
it("covers each current registered route once without copying prior acceptance",()=>{
  expect(audit.routes).toHaveLength(audit.package.routes);
  expect(new Set(audit.routes.map(row=>row.route)).size).toBe(audit.routeCount);
  expect(audit.sourceFileCount).toBe(audit.routeCount*3);
  expect(audit.routes.every(row=>row.requirement.primaryContract&&row.nativeAcceptance.allStatesPassed===false)).toBe(true);
  expect(audit.releaseReady).toBe(false);
});
it("binds every source file to the actual current bytes",async()=>{
  for(const row of audit.routes)for(const file of row.sourceFiles){
    expect(createHash("sha256").update(await readFile(file.file)).digest("hex")).toBe(file.sha256);
  }
});
it("records the repaired pages' hide/unload ownership without claiming native PASS",()=>{
  for(const name of ["management","commission","order-detail","orders","management-orders","management-support","records"]){
    const row=audit.routes.find(item=>item.route===`pages/${name}/index`)!;
    expect(row.observedOnly.directReadOwner).toBe(true);
    expect(row.lifecycleHooks).toEqual(expect.arrayContaining(["onShow","onHide","onUnload"]));
    expect(row.nativeAcceptance.devtools).toBe("not_executed_this_round");
    expect(row.uiReviewRequired).toContain("button-text/line-height/touch-target");
  }
});
it("keeps public browsing and explicit role/unknown-state verification requirements",()=>{
  expect(audit.routes.find(row=>row.route==="pages/home/index")!.rolesToVerify).toContain("visitor");
  expect(audit.routes.find(row=>row.route==="pages/management/index")!.rolesToVerify).toContain("revoked_capability");
  expect(audit.routes.every(row=>row.requirement.states.includes("error")&&row.requirement.states.includes("resume"))).toBe(true);
});
