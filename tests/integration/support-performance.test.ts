import {afterAll,beforeAll,expect,it} from "vitest";
import type {FastifyInstance} from "fastify";
import {loadConfig} from "@cisme/config";
import {TEST_DATABASE_URL,resetDatabase,testPool} from "@cisme/testkit";
import {createApp} from "../../services/api/src/server";
import {createApiGatewayStorage} from "../../services/api/src/storage";
const pool=testPool();const config=loadConfig({APP_ENV:"test",DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:"support-perf-session",ADMIN_API_TOKEN:"support-perf-admin",UPLOAD_TOKEN_SECRET:"support-perf-upload",OBJECT_STORAGE_DRIVER:"api_gateway"});let app:FastifyInstance;
beforeAll(async()=>{await resetDatabase(pool);app=await createApp({config,pool,storage:createApiGatewayStorage(config)});});afterAll(async()=>{await app.close();await pool.end();});
it("accepts one first support message from 100 isolated members without failure",async()=>{
 const members=await Promise.all(Array.from({length:100},(_,index)=>app.inject({method:"POST",url:"/v1/identity/dev",payload:{externalUserId:`support-perf-${index}`,displayName:`成员 ${index}`,consents:[{documentType:"privacy",version:"v1"},{documentType:"terms",version:"v1"}]}}).then(response=>response.json())));
 const latencies:number[]=[];const responses=await Promise.all(members.map(async(member,index)=>{const started=performance.now();const response=await app.inject({method:"POST",url:"/v1/me/support/messages",headers:{authorization:`Bearer ${member.sessionToken}`},payload:{body:`并发客服消息 ${index}`,clientMessageId:`support-perf-message-${index}`}});latencies.push(performance.now()-started);return response;}));
 expect(responses.map(response=>response.statusCode)).toEqual(Array(100).fill(200));
 expect((await pool.query("SELECT count(*)::int AS count FROM support_conversation")).rows[0].count).toBe(100);expect((await pool.query("SELECT count(*)::int AS count FROM support_message")).rows[0].count).toBe(100);
 latencies.sort((a,b)=>a-b);const p95=latencies[Math.ceil(latencies.length*.95)-1]!;const queueStarted=performance.now();
 const operator=members[0];await pool.query("INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,'support.read','performance-test','bounded local performance test','test','integration_fixture')",[operator.memberId]);
 const queue=await app.inject({method:"GET",url:"/v1/management/support/conversations?limit=100",headers:{authorization:`Bearer ${operator.sessionToken}`}});const queueMs=performance.now()-queueStarted;
 expect(queue.statusCode).toBe(200);expect(queue.json().items).toHaveLength(100);expect(p95).toBeLessThan(1000);expect(queueMs).toBeLessThan(1000);
 console.log(JSON.stringify({scenario:"100 isolated first messages",failures:0,p95Ms:Number(p95.toFixed(2)),queue100Ms:Number(queueMs.toFixed(2))}));
},15000);
