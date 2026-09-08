import { evaluateDesignQaEvidence } from "./design-qa-lib";

const requirePassed = process.argv.includes("--require-passed");
const result = await evaluateDesignQaEvidence();
console.log(JSON.stringify(result, null, 2));
if (!result.ok || (requirePassed && !result.releaseReady)) process.exitCode = 1;
