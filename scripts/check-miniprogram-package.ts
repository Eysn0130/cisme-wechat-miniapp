import { inspectMiniProgramPackage } from "./miniprogram-package-lib";

const result = await inspectMiniProgramPackage();

console.log(JSON.stringify({
  ok: result.ok,
  internalBudgets: result.internalBudgets,
  actual: result.actual,
  errors: result.errors
}, null, 2));
if (result.errors.length) process.exitCode = 1;
