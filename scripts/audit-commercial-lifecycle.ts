import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditNativeRoutes } from "./audit-native-routes";
import { inspectMiniProgramPackage } from "./miniprogram-package-lib";

type Requirement = { route:string; primaryContract:string; acceptanceReferences:string[]; statesRequired:string[] };
const sha = (bytes:Buffer) => createHash("sha256").update(bytes).digest("hex");
const unique = (values:string[]) => [...new Set(values)].sort();
/** Inventory and requirements, never a WXML interpreter or a device PASS.
 * No source, historical acceptance or deployment configuration is modified. */
export async function auditCommercialLifecycle(root=resolve(".")) {
  const native=resolve(root,"apps/miniprogram"), audit=await auditNativeRoutes(native);
  if(!audit.evidenceManifestMatchesSource)throw new Error("CURRENT_NATIVE_SOURCE_MANIFEST_MISMATCH");
  const baseline="docs/evidence/native-repair-20260920/interaction-contracts.json";
  const requirements=JSON.parse(await readFile(resolve(root,baseline),"utf8")) as {commonRequiredStates:Record<string,string>;routes:Requirement[]};
  const byRoute=new Map(requirements.routes.map(row=>[row.route,row]));
  const privacyContractPath="docs/evidence/production-closure-20260922/native-privacy-interaction-contract.json";
  const privacyContract=JSON.parse(await readFile(resolve(root,privacyContractPath),"utf8")) as Requirement;
  byRoute.set(privacyContract.route,privacyContract);
  const fulfillmentContract=JSON.parse(await readFile(resolve(root,"docs/evidence/production-closure-20260922/native-fulfillment-interaction-contract.json"),"utf8")) as Requirement;
  byRoute.set(fulfillmentContract.route,fulfillmentContract);
  const pack=await inspectMiniProgramPackage(native);
  const routes=await Promise.all(audit.routes.map(async route=>{
    const sourceFiles=await Promise.all(["ts","wxml","wxss"].map(async extension=>{
      const file=`apps/miniprogram/${route.route}.${extension}`,bytes=await readFile(resolve(root,file));
      return {file,bytes:bytes.length,sha256:sha(bytes),text:bytes.toString("utf8")};
    }));
    const logic=sourceFiles[0]!.text,markup=sourceFiles[1]!.text,style=sourceFiles[2]!.text;
    const markers=(pattern:RegExp)=>[...logic.matchAll(pattern)].map(match=>({line:logic.slice(0,match.index).split("\n").length,token:match[0]}));
    const contract=byRoute.get(route.route);
    const directReadOwner=/\b(?:pageRead|cancelPageReads|runtimeReadOwner)\s*(?:<[^;]*?>)?\(/.test(logic);
    const behaviorTests:Record<string,string>={
      "pages/management/index":"tests/unit/native-commerce-runtime.test.ts",
      "pages/commission/index":"tests/unit/native-commerce-runtime.test.ts;tests/unit/native-commerce-recovery.test.ts",
      "pages/order-detail/index":"tests/unit/native-commerce-runtime.test.ts;tests/unit/native-commerce-recovery.test.ts;tests/unit/native-payment-followup.test.ts",
      "pages/orders/index":"tests/unit/native-order-list-lifecycle.test.ts",
      "pages/management-orders/index":"tests/unit/native-order-list-lifecycle.test.ts",
      "pages/management-support/index":"tests/unit/native-support-queue-ownership.test.ts;tests/unit/management-support-queue-lifecycle.test.ts",
      "pages/records/index":"tests/unit/native-records-lifecycle.test.ts"
      ,"pages/management-privacy/index":"tests/unit/native-privacy-management.test.ts;tests/integration/native-privacy-management.test.ts"
    };
    return {...route,sourceFiles:sourceFiles.map(({text,...identity})=>identity),
      observedOnly:{directReadOwner,readCancellation:markers(/\b(?:cancelPageReads|cancelRuntimeRead)\s*\(/g),
        timers:markers(/\b(?:setTimeout|setInterval|clearTimeout|clearInterval)\s*\(/g),
        parallelBarriers:markers(/\bPromise\.all\s*\(/g),
        eventHandlers:unique([...markup.matchAll(/(?:bind|catch)(?::?\w+)=["']([^"']+)["']/g)].map(match=>match[1]!)),
        localFontSizes:unique([...style.matchAll(/font-size\s*:\s*([^;}]+)/g)].map(match=>match[1]!)),
        localMotion:unique([...style.matchAll(/(?:animation|transition|backdrop-filter)\s*:\s*([^;}]+)/g)].map(match=>match[1]!))},
      rolesToVerify:route.access==="public"?["visitor","member","session_changed"]:
        ["member_self","other_object_denied","expired_session","blocked_member","session_changed",
          ...(route.route.includes("management")||route.route.includes("community-review")?["current_capability","revoked_capability"]:[])],
      requirement:{source:route.route===privacyContract.route?privacyContractPath:baseline,primaryContract:contract?.primaryContract??null,acceptanceReferences:contract?.acceptanceReferences??[],
        states:contract?.statesRequired??Object.keys(requirements.commonRequiredStates),needsRequirementReview:!contract},
      behaviorEvidenceScope:behaviorTests[route.route]?`${behaviorTests[route.route]}: synthetic Page logic; see exact-head test logs, not native rendering`:"existing tests require scenario-level mapping; not re-accepted by this inventory",
      lifecycleAssessment:directReadOwner?"Owner/cancel callsites observed; wrapper, transport and shared-consumer behavior still need trace evidence":"No direct page-read owner marker; inspect wrappers/polls before classifying as a defect",
      nativeAcceptance:{devtools:"not_executed_this_round",iOS:"not_executed_this_round",Android:"not_executed_this_round",allStatesPassed:false},
      uiReviewRequired:["card/type/spacing","button-text/line-height/touch-target","long-text/amount/narrow-screen","keyboard/safe-area/focus","reduce-motion/offline/resume"]};
  }));
  return {schemaVersion:1,kind:"current-source-inventory-and-required-contract-NOT-release-acceptance",releaseReady:false,
    packageSourceSha256:audit.packageSourceSha256,package:pack.actual,routeCount:routes.length,
    sourceFileCount:routes.reduce((count,row)=>count+row.sourceFiles.length,0),
    directReadOwnerMarkerCount:routes.filter(row=>row.observedOnly.directReadOwner).length,
    limits:"Lexical markers omit imported wrapper internals, WXML template scope and execution paths. Marker presence is not proof of cancellation, role coverage, typography or lifecycle correctness. Inherited requirements are not inherited acceptance.",
    commonRequiredStates:requirements.commonRequiredStates,routes};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.log(JSON.stringify(await auditCommercialLifecycle(),null,2));
}
