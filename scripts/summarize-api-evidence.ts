import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const input=process.argv[2];if(!input)throw new Error('EXPLICIT_EVIDENCE_INPUT_REQUIRED');
const raw=await readFile(input,'utf8');
type Row={runId:string;method:string;route:string;status:number;test:string;file:string;count:number};
const rows=raw.trim().split('\n').map(line=>JSON.parse(line) as Row);
const runId=rows.at(-1)?.runId;if(!/^[a-f0-9]{24}$/.test(runId??''))throw new Error('INVALID_RUN_ID');
const current=rows.filter(row=>row.runId===runId);
const inventory=JSON.parse(await readFile('docs/evidence/release-preparation-20260921/audit/api-surface.json','utf8'));
const normalize=(s:string)=>s.replace(/:([A-Za-z][A-Za-z0-9_]*)/g,'{$1}');
const entries=inventory.entries.map((operation:{method:string;path:string})=>{
 const executed=current.filter(row=>row.method===operation.method&&normalize(row.route)===operation.path);
 const evidence=executed.map(({status,test,file,count})=>({status,test,file,count}));
 const entryRejections=executed.filter(row=>row.file.endsWith('/protected-route-entry.test.ts')&&row.status===401);
 return {method:operation.method,path:operation.path,requests:executed.reduce((n,row)=>n+row.count,0),
  statuses:[...new Set(executed.map(row=>row.status))].sort(),evidence,
  identityEntry:entryRejections.length>=2?'UNAUTHENTICATED_AND_FORGED_SESSION_REJECTED':'REQUIRES_SPECIFIC_REVIEW',
  fullSecurityAcceptance:'NOT_COMPLETE'};
});
const result={schemaVersion:1,runId,sourceHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 sourceState:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()?'working-tree':'committed',
 serverSha256:inventory.sourceSha256,rawEvidenceSha256:createHash('sha256').update(raw).digest('hex'),
 scope:'HTTP onResponse from an owned synthetic integration run. Status/test occurrence is not proof of object, field, state, concurrency or external-effect correctness. Service-direct tests are outside this measurement.',
 routes:entries.length,executedRoutes:entries.filter((r:{requests:number})=>r.requests>0).length,
 entryRejectionRoutes:entries.filter((r:{identityEntry:string})=>r.identityEntry==='UNAUTHENTICATED_AND_FORGED_SESSION_REJECTED').length,
 releaseReady:false,entries};
const output=process.argv[3]??'docs/evidence/release-preparation-20260921/audit/executed-http-evidence.json';
await writeFile(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({routes:result.routes,executed:result.executedRoutes,entryRejections:result.entryRejectionRoutes,releaseReady:false}));
