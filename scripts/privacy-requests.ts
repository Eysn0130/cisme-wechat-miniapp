import {readFile} from 'node:fs/promises';
import {createPool} from '../services/api/src/db.js';
import {PrivacyRights} from '../services/api/src/privacyRights.js';
// Operations CLI for the same role-checked service; never prints credentials.
const [action,principal,id,inputFile,idempotencyKey]=process.argv.slice(2);
if(!process.env.DATABASE_URL || !principal || !['list','respond','plan'].includes(action || ''))throw new Error('Usage: DATABASE_URL=… tsx scripts/privacy-requests.ts list PRINCIPAL | respond PRINCIPAL REQUEST_ID RESPONSE_JSON | plan PRINCIPAL REQUEST_ID PLAN_JSON IDEMPOTENCY_KEY');
const pool=createPool(process.env.DATABASE_URL);const rights=new PrivacyRights(pool);
try{
 await rights.requireOperator(principal);
 if(action==='list')console.log(JSON.stringify(await rights.queue(),null,2));
 else{
  if(!id || !inputFile)throw new Error('Request ID and input JSON file required');
  const body=JSON.parse(await readFile(inputFile,'utf8'));
  if(action==='respond')console.log(JSON.stringify(await rights.respond(principal,id,body),null,2));
  else{
   if(!idempotencyKey || idempotencyKey.length<8 || idempotencyKey.length>200)throw new Error('Plan requires an 8-200 character idempotency key');
   console.log(JSON.stringify(await rights.planExecution(principal,id,idempotencyKey,body),null,2));
  }
 }
}finally{await pool.end();}
