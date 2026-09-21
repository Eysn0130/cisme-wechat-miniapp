import {afterAll,expect,vi} from 'vitest';
import {appendFileSync,mkdirSync} from 'node:fs';
import {resolve,relative} from 'node:path';
const evidence=vi.hoisted(()=>({rows:new Map<string,{method:string;route:string;status:number;test:string;file:string;count:number}>()}));
// Opt-in measurement in the already owned integration runner. No production
// hook and no URL/IDs/header/body capture; a status is not an authorization proof.
vi.mock('fastify',async importOriginal=>{
 const actual=await importOriginal<typeof import('fastify')>();
 if(process.env.CISME_CAPTURE_API_EVIDENCE!=='true')return actual;
 if(!process.env.CISME_TEST_RUN_ID)throw new Error('OWNED_API_EVIDENCE_RUN_REQUIRED');
 const create=actual.default as unknown as (options:import('fastify').FastifyServerOptions)=>import('fastify').FastifyInstance;
 const wrapped=((options:import('fastify').FastifyServerOptions={})=>{
  const app=create(options);
  app.addHook('onResponse',(request,reply,done)=>{
   const state=expect.getState(),row={method:request.method,route:request.routeOptions.url??'<unmatched>',
    status:reply.statusCode,test:state.currentTestName??'<fixture/setup>',file:relative(process.cwd(),state.testPath??''),count:1};
   const key=JSON.stringify([row.method,row.route,row.status,row.test,row.file]);
   const existing=evidence.rows.get(key);if(existing)existing.count++;else evidence.rows.set(key,row);
   done();
  });return app;
 }) as unknown as typeof actual.default;
 return {...actual,default:wrapped};
});
afterAll(()=>{
 if(process.env.CISME_CAPTURE_API_EVIDENCE!=='true'||!evidence.rows.size)return;
 const output=process.env.RUNNER_TEMP?resolve(process.env.RUNNER_TEMP,'native-validation'):resolve('tmp/release-preparation');
 mkdirSync(output,{recursive:true});
 appendFileSync(resolve(output,'api-request-evidence.jsonl'),[...evidence.rows.values()].map(row=>JSON.stringify({runId:process.env.CISME_TEST_RUN_ID,...row})).join('\n')+'\n');
 evidence.rows.clear();
});
