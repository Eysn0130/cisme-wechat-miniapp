/** Synthetic HTTP probes for this exact, newly-owned staging database only.
 * No provider calls, real identity, production target, cleanup or secrets output. */
import {createRequire} from 'node:module';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {createHmac,createHash} from 'node:crypto';
import {hostname} from 'node:os';
// The caller supplies the exact CI-verified candidate, not a moving branch.
const SOURCE=process.argv[3];
const run=process.argv[2],root='/opt/cisme';
function requireFact(ok,code){if(!ok)throw Error(code);}
let pool;
try{
 requireFact(hostname()==='VM-4-15-ubuntu'&&/^rc20260922-[a-f0-9]{8}$/.test(run)&&/^[a-f0-9]{40}$/.test(SOURCE??''),'STAGING_OWNERSHIP_REQUIRED');
 const state=`${root}/staging-acceptance/${run}`,owned=JSON.parse(await readFile(`${state}/ownership.json`,'utf8'));
 const prepared=JSON.parse(await readFile(`${state}/prepared.json`,'utf8'));
 const database='cisme_accept_'+run.replaceAll('-','_'),release=`${root}/releases/${run}-${SOURCE.slice(0,12)}`;
 requireFact(owned.database===database&&owned.directory===release&&owned.instanceId==='lhins-ei4hz4fi'&&prepared.sourceHead===SOURCE,'EXACT_OWNED_CANDIDATE_REQUIRED');
 const activated=JSON.parse(await readFile(`${state}/activated.json`,'utf8'));
 requireFact(activated.activated&&activated.sourceHead===SOURCE&&await realpath(`${root}/current`)===release&&createHash('sha256').update(await readFile('/etc/cisme/runtime.env')).digest('hex')===activated.candidateEnvSha256,'ACTIVATED_CANDIDATE_REQUIRED');
 const url=new URL(process.env.DATABASE_URL);
 requireFact(process.env.APP_ENV==='staging'&&url.hostname==='127.0.0.1'&&url.pathname==='/'+database&&url.username==='cisme_staging'&&process.env.COMMERCE_ORDER_FLOW_ENABLED==='false'&&process.env.ALLOW_DEV_ADAPTERS==='false','ISOLATED_CONFIG_REQUIRED');
 await writeFile(`${state}/business-probe-started.json`,JSON.stringify({run,sourceHead:SOURCE,syntheticOnly:true}),{flag:'wx',mode:0o600});
 const {default:pg}=await import(createRequire(`${release}/package.json`).resolve('pg'));pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});
 requireFact((await pool.query('SELECT count(*)::int n FROM member')).rows[0].n===0,'EMPTY_OWNED_FIXTURE_REQUIRED');
 const ids=(await pool.query("INSERT INTO member(display_name) VALUES('SYNTHETIC acceptance owner'),('SYNTHETIC acceptance operator') RETURNING id")).rows.map(r=>r.id);
 const owner=ids[0],operator=ids[1],principal='synthetic-staging:'+run,checks=[];
 await pool.query("INSERT INTO principal_role(principal_id,role) VALUES($1,'support')",[principal]);
 await pool.query("INSERT INTO authority_grant(member_id,capability,environment,granted_by,grant_reason) VALUES($1,'commerce.order.read','staging',$2,'Synthetic owned acceptance only')",[operator,principal]);
 function token(memberId,principalId='member:'+memberId){const payload=Buffer.from(JSON.stringify({memberId,principalId,adapter:'wechat',provider:'wechat_miniprogram',appId:process.env.WECHAT_APP_ID,expiresAt:Date.now()+300000})).toString('base64url');return payload+'.'+createHmac('sha256',process.env.APP_SESSION_SECRET).update(payload).digest('base64url');}
 const ownerToken=token(owner),operatorToken=token(operator,principal);let cacheChecks=0;
 async function http(path,auth,method='GET',data){const response=await fetch('http://127.0.0.1:3100'+path,{method,headers:{...(auth?{authorization:'Bearer '+auth}:{}),...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(8000),redirect:'error'});requireFact(response.headers.get('cache-control')==='private, no-store','API_CACHE_BOUNDARY_FAILED');cacheChecks++;const body=await response.json();return{status:response.status,body};}
 let result=await http('/v1/me/privacy-requests');requireFact(result.status===401,'UNAUTHENTICATED_READ_REQUIRED');checks.push('unauthenticated-owner-denied');
 const input={kind:'access',message:'SYNTHETIC staging portable-data request'};
 const first=await http('/v1/me/privacy-requests',ownerToken,'POST',input),duplicate=await http('/v1/me/privacy-requests',ownerToken,'POST',input);
 requireFact(first.status===200&&duplicate.status===200&&first.body.id===duplicate.body.id,'PRIVACY_DEDUP_FAILED');checks.push('privacy-request-deduplicated');
 result=await http('/v1/me/privacy-requests',operatorToken);requireFact(result.status===200&&result.body.length===0,'OWNER_ISOLATION_FAILED');checks.push('privacy-owner-isolation');
 const path=`/v1/admin/privacy-requests/${first.body.id}/response`,reply={status:'responded',response:'SYNTHETIC received only; export is not complete.',expectedVersion:1};
 result=await http(path,ownerToken,'POST',reply);requireFact(result.status===403,'PRIVACY_OPERATOR_DENIAL_FAILED');checks.push('privacy-operator-denial');
 const race=await Promise.all([http(path,operatorToken,'POST',reply),http(path,operatorToken,'POST',reply)]);
 requireFact(race.map(r=>r.status).sort().join(',')==='200,409','PRIVACY_VERSION_RACE_FAILED');checks.push('privacy-concurrent-version-conflict');
 result=await http('/v1/me/privacy-requests',ownerToken);requireFact(result.body[0].status==='responded'&&result.body[0].execution===null,'FALSE_EXECUTION_CLAIM');checks.push('reply-not-misrepresented-as-export');
 const nativePath=`/v1/management/privacy-requests/${first.body.id}/response`;
 result=await http('/v1/management/privacy-requests',operatorToken);requireFact(result.status===403,'LEGACY_ROLE_BYPASSED_NATIVE_CAPABILITY');checks.push('native-privacy-legacy-role-insufficient');
 await pool.query("INSERT INTO authority_grant(member_id,capability,environment,granted_by,grant_reason) VALUES($1,'privacy.request.manage','staging',$2,'Synthetic native privacy acceptance only')",[operator,principal]);
 result=await http('/v1/management/privacy-requests',operatorToken);requireFact(result.status===200&&result.body.length===1&&result.body[0].id===first.body.id,'NATIVE_PRIVACY_QUEUE_FAILED');checks.push('native-privacy-authorized-queue');
 result=await http(nativePath,operatorToken,'POST',{status:'reviewing',response:'SYNTHETIC native review; no data execution performed.',expectedVersion:2});requireFact(result.status===200,'NATIVE_PRIVACY_RESPONSE_FAILED');checks.push('native-privacy-versioned-response');
 await pool.query("UPDATE authority_grant SET revoked_at=now(),revoked_by=$2,revoke_reason='Synthetic native privacy revocation' WHERE member_id=$1 AND capability='privacy.request.manage' AND revoked_at IS NULL",[operator,principal]);
 const revokedReply=await http(nativePath,operatorToken,'POST',{status:'responded',response:'SYNTHETIC revoked attempt',expectedVersion:3});
 result=await http('/v1/management/privacy-requests',operatorToken);requireFact(result.status===403&&revokedReply.status===403,'NATIVE_PRIVACY_REVOCATION_FAILED');checks.push('native-privacy-revoked-read-and-write');
 result=await http('/v1/me/privacy-requests',ownerToken);requireFact(result.body[0].version===3&&result.body[0].execution===null&&result.body[0].status==='reviewing','NATIVE_PRIVACY_REVOKED_WRITE_CHANGED_FACT');checks.push('native-privacy-revoked-write-no-effect');
 result=await http('/v1/management/commerce/orders',operatorToken);requireFact(result.status===200,'ORDER_AUTHORITY_READ_FAILED');checks.push('authorized-order-management-read');
 await pool.query("UPDATE authority_grant SET revoked_at=now(),revoked_by=$2,revoke_reason='Synthetic revocation acceptance' WHERE member_id=$1 AND capability='commerce.order.read' AND revoked_at IS NULL",[operator,principal]);
 result=await http('/v1/management/commerce/orders',operatorToken);requireFact(result.status===403,'REVOKED_ORDER_AUTHORITY_ACCEPTED');checks.push('immediate-management-revocation');
 result=await http('/v1/me/authority',operatorToken);requireFact(result.status===200&&!result.body.capabilities.includes('commerce.order.read'),'STALE_AUTHORITY_PROJECTION');checks.push('revoked-authority-projection');
 result=await http('/v1/commerce/orders/status');requireFact(result.status===200&&result.body.paymentAvailable===false&&result.body.orderFlowEnabled===false,'MONEY_GATE_OPEN');checks.push('real-money-remains-disabled');
 requireFact((await pool.query('SELECT count(*)::int n FROM commerce_order')).rows[0].n===0,'UNEXPECTED_ORDER_CREATED');
 const report={runId:run,instanceId:'lhins-ei4hz4fi',sourceHead:SOURCE,syntheticOnly:true,realWechatLoginVerified:false,realFundsExecuted:false,checks,passed:checks.length,cacheChecks,productionTouched:false,fullAcceptanceComplete:false};
 await writeFile(`${state}/business-probe.json`,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(report));
}catch(error){console.log(JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(error?.message??'')?error.message:'SYNTHETIC_BUSINESS_PROBE_FAILED'}));process.exitCode=1;}finally{if(pool)await pool.end();}
