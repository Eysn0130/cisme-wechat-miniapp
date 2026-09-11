import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

if (process.env.APP_ENV !== "staging") throw new Error("STAGING_ENV_REQUIRED");
for (const key of ["DATABASE_URL", "APP_SESSION_SECRET", "ADMIN_API_TOKEN", "STAGING_ORIGIN"]) if (!process.env[key]) throw new Error(`${key}_REQUIRED`);
const require = createRequire(process.env.CISME_RUNTIME_REQUIRE_PATH ?? "/opt/cisme/current/index.js");
const pg = require("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const origin = process.env.STAGING_ORIGIN.replace(/\/$/, "");
const runId = randomUUID(); const marker = `synthetic-r1r2-perf-${runId}`;
const members = []; const conversationIds = new Set();
const sampleCount = 25;
function assert(value, code) { if (!value) throw new Error(code); }
function token(memberId) { const payload = Buffer.from(JSON.stringify({ principalId: `member:${memberId}:perf`, memberId, adapter: "dev", expiresAt: Date.now() + 30 * 60_000 })).toString("base64url"); return `${payload}.${createHmac("sha256", process.env.APP_SESSION_SECRET).update(payload).digest("base64url")}`; }
async function api(path, options = {}) { const started = performance.now(); const response = await fetch(`${origin}${path}`, { method: options.method ?? "GET", headers: { "content-type": "application/json", "x-request-id": `r1r2-perf-${randomUUID()}`,
  ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}), ...(options.admin ? { "x-admin-token": process.env.ADMIN_API_TOKEN, "x-principal-id": marker } : {}) },
  ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }); const text = await response.text(); let body = null; try { body = JSON.parse(text); } catch {} return { status: response.status, body, ms: performance.now() - started, bytes: Buffer.byteLength(text) }; }
function stats(rows) { const sorted = rows.map(row => row.ms).sort((a,b) => a-b); const bytes = rows.map(row => row.bytes).sort((a,b) => a-b); const pick = (values,p) => values[Math.min(values.length-1,Math.ceil(values.length*p)-1)] ?? 0; return { samples: rows.length, latencyMs: { p50: pick(sorted,.5), p95: pick(sorted,.95), p99: pick(sorted,.99) }, responseBytes: { p50: pick(bytes,.5), p95: pick(bytes,.95), p99: pick(bytes,.99) }, errors: rows.filter(row => row.status<200 || row.status>=300).length }; }
async function measured(count, work) { const rows=[]; for(let index=0;index<count;index+=1) rows.push(await work(index)); assert(rows.every(row=>row.status>=200&&row.status<300),"PERFORMANCE_PATH_ERROR"); return stats(rows); }
const before=(await pool.query("SELECT (SELECT count(*) FROM member)::int member,(SELECT count(*) FROM authority_grant)::int authority_grants,(SELECT count(*) FROM support_conversation)::int conversation,(SELECT count(*) FROM support_message)::int message")).rows[0];
for(const key of Object.keys(before))assert(before[key]===0,`PERF_BASELINE_${key}_NOT_EMPTY`);
let report;
try {
  for(let index=0;index<sampleCount;index+=1){const id=(await pool.query("INSERT INTO member(display_name) VALUES($1) RETURNING id",[`${marker}-user-${index}`])).rows[0].id;members.push({id,token:token(id)});}
  const adminId=(await pool.query("INSERT INTO member(display_name) VALUES($1) RETURNING id",[`${marker}-admin`])).rows[0].id;const admin={id:adminId,token:token(adminId)};members.push(admin);
  for(const capability of ["support.read","support.reply","support.assign"])await pool.query("INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason) VALUES($1,$2,$3,'Synthetic staging performance')",[admin.id,capability,marker]);
  const firstMessage = await measured(sampleCount,async index=>{const row=await api("/v1/me/support/messages",{method:"POST",bearer:members[index].token,body:{body:`合成性能消息 ${index}`,clientMessageId:`${marker}-first-${index}`}});if(row.body?.conversation?.id)conversationIds.add(row.body.conversation.id);return row;});
  const incrementalPoll = await measured(sampleCount,index=>api("/v1/me/support/messages?after=0",{bearer:members[index].token}));
  const history = await measured(sampleCount,index=>api("/v1/me/support/messages?limit=50",{bearer:members[index].token}));
  const adminQueue = await measured(sampleCount,()=>api("/v1/management/support/conversations?limit=50",{bearer:admin.token}));
  const queue=(await api("/v1/management/support/conversations?limit=50",{bearer:admin.token})).body;const first=queue.items[0];
  const adminOpen = await measured(sampleCount,()=>api(`/v1/management/support/conversations/${first.id}/messages?limit=50`,{bearer:admin.token}));
  const claim=await api(`/v1/management/support/conversations/${first.id}/claim`,{method:"POST",bearer:admin.token,body:{expectedVersion:first.version}});assert(claim.status===200,"PERF_CLAIM_FAILED");
  const adminReply = await measured(sampleCount,index=>api(`/v1/management/support/conversations/${first.id}/messages`,{method:"POST",bearer:admin.token,body:{body:`合成性能回复 ${index}`,clientMessageId:`${marker}-reply-${index}`}}));
  const metrics=await api("/v1/admin/runtime-metrics",{admin:true});assert(metrics.status===200,"RUNTIME_METRICS_FAILED");
  report={mode:origin.startsWith("https://")?"real_staging_https":"local_staging_profile_http",origin,sampleCount,paths:{firstMessage,incrementalPoll,conversationHistory:history,adminQueue,adminOpenConversation:adminOpen,adminReply},runtime:{sqlMs:metrics.body.sqlMs,poolWaitMs:metrics.body.poolWaitMs,pool:metrics.body.pool,http:metrics.body.http.durationMs},allPathErrors:Object.values({firstMessage,incrementalPoll,history,adminQueue,adminOpen,adminReply}).reduce((sum,item)=>sum+item.errors,0)};
} finally {
  const client=await pool.connect();try{await client.query("BEGIN");const rows=await client.query("SELECT id FROM support_conversation WHERE member_id=ANY($1::uuid[]) FOR UPDATE",[members.map(item=>item.id)]);for(const row of rows.rows){conversationIds.add(row.id);await client.query("SELECT set_config('cisme.support_purge_conversation_id',$1,true)",[row.id]);await client.query("DELETE FROM support_message WHERE conversation_id=$1",[row.id]);await client.query("DELETE FROM support_conversation WHERE id=$1",[row.id]);}
    const ids=[...conversationIds];if(ids.length){await client.query("DELETE FROM outbox_event WHERE aggregate_type='support_conversation' AND aggregate_id=ANY($1::uuid[])",[ids]);await client.query("DELETE FROM audit_log WHERE object_id=ANY($1::uuid[])",[ids]);}
    await client.query("DELETE FROM audit_log WHERE principal_id=$1",[marker]);const grants=await client.query("SELECT count(*)::int total,count(*) FILTER(WHERE granted_by=$1)::int ours FROM authority_grant",[marker]);assert(grants.rows[0].total===grants.rows[0].ours,"NON_SYNTHETIC_GRANT_DURING_PERF_CLEANUP");await client.query("TRUNCATE authority_grant");if(members.length)await client.query("DELETE FROM member WHERE id=ANY($1::uuid[])",[members.map(item=>item.id)]);await client.query("COMMIT");}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}
const after=(await pool.query("SELECT (SELECT count(*) FROM member)::int member,(SELECT count(*) FROM authority_grant)::int authority_grants,(SELECT count(*) FROM support_conversation)::int conversation,(SELECT count(*) FROM support_message)::int message")).rows[0];assert(JSON.stringify(after)===JSON.stringify(before),"PERF_CLEANUP_DRIFT");await pool.end();
console.log(JSON.stringify({...report,cleanup:{exactBaselineCountsRestored:true}},null,2));
