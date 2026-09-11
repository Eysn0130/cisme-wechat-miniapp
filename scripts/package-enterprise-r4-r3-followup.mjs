import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const root=resolve(import.meta.dirname,"..");
const releaseId=process.argv[2]??`enterprise-r4-r3-followup-${new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z")}`;
if(!/^enterprise-r4-r3-followup-[A-Za-z0-9._-]+$/.test(releaseId))throw new Error("RELEASE_ID_INVALID");
const destination=resolve(root,"dist",releaseId);
try{await stat(destination);throw new Error("RELEASE_DESTINATION_ALREADY_EXISTS");}catch(error){if(error.code!=="ENOENT")throw error;}
const parent=resolve(root,"dist/r1-r2-staging-slice-20260911T080300Z");
const runtime=resolve(root,"dist/tencent-release");
const canonicalAppId="wx4eac2d4fb11d299b";

async function listFiles(path){const entries=await readdir(path,{withFileTypes:true});return(await Promise.all(entries.map(async entry=>{const next=join(path,entry.name);return entry.isDirectory()?listFiles(next):[next];}))).flat();}
async function sha(path){return createHash("sha256").update(await readFile(path)).digest("hex");}
async function copyFile(source,target){await mkdir(dirname(target),{recursive:true});await cp(source,target);}
async function copyTree(source,target,excluded=()=>false){for(const file of await listFiles(source)){const name=relative(source,file);if(!excluded(name))await copyFile(file,join(target,name));}}
async function summary(path){const files=(await listFiles(path)).sort();const hash=createHash("sha256");let bytes=0;for(const file of files){const name=relative(path,file),body=await readFile(file);bytes+=body.length;hash.update(name).update("\0").update(body);}return{sha256:hash.digest("hex"),files:files.length,bytes};}

await mkdir(destination,{recursive:true});
await copyFile(join(parent,"MANIFEST.json"),join(destination,"parent/R1-R2-MANIFEST.json"));
await copyFile(join(parent,"SHA256SUMS"),join(destination,"parent/R1-R2-SHA256SUMS"));
for(const name of ["index.js","worker.js","worker-once.js","package.json","package-lock.json","release-manifest.json"])await copyFile(join(runtime,name),join(destination,"runtime",name));
for(const name of ["202609110005_enterprise_identity_namespace.sql","202609110006_commerce_catalog.sql"])await copyFile(join(root,"db/migrations",name),join(destination,"migrations",name));
const miniExcluded=name=>name==="project.private.config.json"||basename(name)===".DS_Store";
await copyTree(join(root,"apps/miniprogram"),join(destination,"miniprogram"),miniExcluded);
for(const name of ["services/api/src","services/worker/src","packages/config/src","packages/contracts/src","packages/domain/src","openapi","docs/legal","docs/privacy","docs/adr"])await copyTree(join(root,name),join(destination,"source",name));
for(const name of ["package.json","package-lock.json","design-qa.md","docs/EVENT-CATALOG.md","docs/MAKE-BUY-EVIDENCE.md","docs/ROUTE-STATE-ACTION-API-ACCEPTANCE.md","docs/THIRD-PARTY-NOTICES.md","docs/evidence/LICENSE-REPORT.md","docs/evidence/visual/current-source-acceptance.json","docs/evidence/deployment/CISME-ENTERPRISE-RECONCILIATION-R4-R3-2026-09-11.md","scripts/authority-grants.ts","scripts/team-access.ts","scripts/validate-contracts.ts","scripts/package-enterprise-r4-r3-followup.mjs"])await copyFile(join(root,name),join(destination,"source",name));
for(const name of ["commerce-catalog.test.ts","community-access.test.ts","member-profile-display.test.ts","migration-lifecycle.test.ts","role-aware-support.test.ts"])await copyFile(join(root,"tests/integration",name),join(destination,"source/tests/integration",`${name}.snapshot`));
for(const name of ["auth.test.ts","commerce-ui.test.ts","config.test.ts","native-route-access.test.ts","privacy-inventory-gate.test.ts","support-ai-boundary.test.ts"])await copyFile(join(root,"tests/unit",name),join(destination,"source/tests/unit",`${name}.snapshot`));

const project=JSON.parse(await readFile(join(destination,"miniprogram/project.config.json"),"utf8"));
if(project.appid!==canonicalAppId)throw new Error("MINIPROGRAM_APP_ID_NOT_CANONICAL");
const mini=await summary(join(destination,"miniprogram"));
const app=JSON.parse(await readFile(join(destination,"miniprogram/app.json"),"utf8"));
mini.routes=(app.pages??[]).length+(app.subPackages??[]).reduce((sum,item)=>sum+item.pages.length,0);
const source=await summary(join(destination,"source"));
const candidate={migrationCount:33,physicalTableCount:75,contractRequiredTableCount:65,indexCount:177,constraintCount:1013,apiSha256:await sha(join(destination,"runtime/index.js")),workerSha256:await sha(join(destination,"runtime/worker.js")),workerOnceSha256:await sha(join(destination,"runtime/worker-once.js")),packageLockSha256:await sha(join(destination,"runtime/package-lock.json")),migration032Sha256:await sha(join(destination,"migrations/202609110005_enterprise_identity_namespace.sql")),migration033Sha256:await sha(join(destination,"migrations/202609110006_commerce_catalog.sql")),miniprogram:mini,source};
const manifest={schemaVersion:1,releaseId,createdAt:new Date().toISOString(),parent:{releaseId:"r1-r2-staging-slice-20260911T080300Z",manifestSha256:await sha(join(destination,"parent/R1-R2-MANIFEST.json")),immutable:true,deployed:false},target:{environment:"local-and-staging-followup",canonicalMiniProgramAppId:canonicalAppId,company:"熹芃（上海）生物科技有限公司"},candidate,scope:{identityNamespace:"provider+appid+openid",r4:"single-SKU first-party catalog with qualification/publication/inventory; purchase disabled",r3:"offline provider/knowledge/readonly-tool boundary; runtime provider pending",excluded:["cart","order","payment","fulfillment","refund","multi-merchant","real AI provider","AI auto-send"]},safety:{productionAuthorized:false,formalMiniProgramUploadAuthorized:false,paymentAuthorized:false,containsPublicConfiguration:true,containsCredentials:false,containsRealUserData:false,gitMutationAuthorized:false,mediaUploadEnabledBySlice:false},remoteStatus:"NOT DEPLOYED; authorized staging channel unavailable"};
await writeFile(join(destination,"MANIFEST.json"),`${JSON.stringify(manifest,null,2)}\n`);
await writeFile(join(destination,"README.md"),`# ${releaseId}\n\nIndependent follow-up to the immutable, not-deployed R1/R2 candidate. It targets the canonical enterprise AppID, adds migrations 32–33, R4-A catalog and bounded offline R3. It contains public configuration but no credentials or real user data. It is not authorized for production, formal Mini Program upload, payment or public AI.\n`);
const forbiddenNames=/(^|\/)(\.env($|\.)|project\.private\.config\.json|[^/]+\.(pem|key|p12|crt))$/i;
const forbiddenContent=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKID[A-Za-z0-9]{13,}\b/;
for(const file of await listFiles(destination)){const name=relative(destination,file);if(forbiddenNames.test(name))throw new Error(`FORBIDDEN_SECRET_FILE:${name}`);const body=await readFile(file);if(body.length<=5_000_000&&forbiddenContent.test(body.toString("utf8")))throw new Error(`FORBIDDEN_SECRET_CONTENT:${name}`);}
const sums=[];for(const file of (await listFiles(destination)).sort()){const name=relative(destination,file);if(name!=="SHA256SUMS")sums.push(`${await sha(file)}  ${name}`);}await writeFile(join(destination,"SHA256SUMS"),`${sums.join("\n")}\n`);
console.log(JSON.stringify({packaged:true,destination,manifest},null,2));
