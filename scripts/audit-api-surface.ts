import { readFile,writeFile,mkdir,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { registeredSourceOperations,assertOperationCoverage } from './route-contract-lib.js';
const source=await readFile('services/api/src/server.ts','utf8');
const spec=await readFile('openapi/openapi.yaml','utf8');
assertOperationCoverage(source,spec);
const normalize=(s:string)=>s.replace(/:([A-Za-z][A-Za-z0-9_]*)/g,'{$1}');
const registrations=[...source.matchAll(/\b(?:app|callbackScope)\.(get|post|put|patch|delete)\b/g)].map(m=>m.index);
const chunks=registrations.map((start,i)=>({start,text:source.slice(start,registrations[i+1]??source.length)}));
const imports=new Map([...source.matchAll(/import \{ ([A-Za-z0-9_]+)[^\n]* from "\.\/(.*?)\.js"/g)].map(m=>[m[1],`services/api/src/${m[2]}.ts`]));
const owners=new Map([...source.matchAll(/const (\w+)\s*=\s*new (\w+)/g)].map(m=>[m[1],imports.get(m[2])]));
for(const [variable,file] of Object.entries({payment:'paymentAttempt',refunds:'refundCommand',settlement:'settlementCommand',moneyOps:'moneyOperations',tradeBills:'tradeBillReconciliation',shipment:'orderFulfillment'}))owners.set(variable,`services/api/src/${file}.ts`);
const operations=[...registeredSourceOperations(source),{method:'GET',path:'/health/live'},{method:'GET',path:'/health/ready'}];
const files=async(dir:string):Promise<string[]>=>{const output:string[]=[];for(const entry of await readdir(dir,{withFileTypes:true})){const p=`${dir}/${entry.name}`;if(entry.isDirectory())output.push(...await files(p));else if(p.endsWith('.ts'))output.push(p);}return output;};
const clients=await Promise.all((await files('apps/miniprogram')).map(async path=>({path,source:await readFile(path,'utf8')})));
const tests=await Promise.all((await files('tests/integration')).map(async path=>({path,source:await readFile(path,'utf8')})));
const entries=operations.map(operation=>{
  const literal=operation.path.replace(/\{(\w+)\}/g,':$1');
  let chunk=chunks.find(c=>c.text.includes(`"${literal}"`)&&new RegExp(`^(app|callbackScope)\\.${operation.method.toLowerCase()}\\b`).test(c.text));
  if(!chunk){const template=operation.path.startsWith('/v1/bootstrap/')?'/v1/bootstrap/${scope}':operation.path.startsWith('/v1/care-cycles/')?'/v1/care-cycles/:cycleId/${action}':'/v1/admin/points/actions/:requestId/${decision}';chunk=chunks.find(c=>c.text.includes('`'+template+'`'));}
  if(!chunk)throw new Error(`UNMAPPED_HANDLER:${operation.method} ${operation.path}`);
  const calls=[...chunk.text.matchAll(/\b(\w+)(?:Required\(\))?\.(\w+)\(/g)].filter(m=>owners.has(m[1]));
  const stem=literal.split('/:')[0]!;
  const family=/ugc|community/.test(literal)?'UGC':/orders|catalog|commerce|commission|money|payments|refund|fulfillment/.test(literal)?'commerce':/support/.test(literal)?'support':/privacy|export|erasure/.test(literal)?'privacy':/identity|phone|profile|member|bootstrap/.test(literal)?'identity-member':'care-platform';
  return {...operation,family,handler:`services/api/src/server.ts:${source.slice(0,chunk.start).split('\n').length}`,
    handlerSliceSha256:createHash('sha256').update(chunk.text).digest('hex'),
    serviceCalls:[...new Map(calls.map(m=>[`${m[1]}.${m[2]}`,{owner:owners.get(m[1]),method:m[2]}])).values()],
    nativeReferenceCandidates:clients.filter(c=>c.source.includes(stem)).map(c=>c.path),
    testReferenceCandidates:tests.filter(c=>c.source.includes(stem)).map(c=>c.path),
    commonControls:['server preHandler identity/active member or explicit public/callback exception','rateLimits.ts','operationBudget.ts'],
    requiredReview:{prdBusinessId:'UNREVIEWED',identity:'UNREVIEWED',roleCapability:'UNREVIEWED',objectRow:'UNREVIEWED',fieldProjection:'UNREVIEWED',actionState:'UNREVIEWED',environment:'UNREVIEWED',inputBoundary:'UNREVIEWED',idempotencyVersion:'UNREVIEWED',concurrency:'UNREVIEWED',databaseExternalEffects:'UNREVIEWED',limitsTimeoutPagination:'UNREVIEWED',positiveNegativeEvidence:'UNREVIEWED'},
    status:'SOURCE_MAPPED_NOT_SECURITY_ACCEPTED'};
});
await mkdir('docs/evidence/release-preparation-20260921/audit',{recursive:true});
await writeFile('docs/evidence/release-preparation-20260921/audit/api-surface.json',JSON.stringify({schemaVersion:1,routeCount:entries.length,
  sourceSha256:createHash('sha256').update(source).digest('hex'),releaseReady:false,
  scope:'Exact method denominator. Candidate references are discovery aids, not per-axis security proof. Service source review and executed semantic tests must supply acceptance.',
  nonRouteSurfaces:['services/worker/src/jobs.ts','services/worker/src/moneyJobs.ts','services/worker/src/formalRecovery.ts','services/api/src/wechatPayV3.ts','services/api/src/ugcSafety.ts','services/api/src/phoneBinding.ts','services/api/src/storage.ts','services/api/src/cloudUpload.ts'],entries},null,2)+'\n');
console.log(JSON.stringify({mapped:entries.length,accepted:0,releaseReady:false}));
