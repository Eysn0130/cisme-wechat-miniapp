import {readFile} from 'node:fs/promises';
import {createPool,transaction} from '../services/api/src/db.js';
const [file,operator]=process.argv.slice(2);
if(!file || !operator || !process.env.DATABASE_URL)throw new Error('Usage: DATABASE_URL=… tsx scripts/publish-legal-documents.ts APPROVED_JSON OPERATOR');
const input=JSON.parse(await readFile(file,'utf8')) as Array<{type:string;version:string;title:string;body:string;operatorName:string;contact:string}>;
if(!Array.isArray(input) || ![2,3].includes(input.length) || new Set(input.map(doc=>doc.type)).size!==input.length || input.some(doc=>!['terms','privacy','cross_border'].includes(doc.type)) || !['terms','privacy'].every(type=>input.some(doc=>doc.type===type)))throw new Error('Both terms and privacy are required');
for(const doc of input)if(!doc.version?.trim() || !doc.title?.trim() || doc.body?.trim().length<100 || !doc.operatorName?.trim() || !doc.contact?.trim() || /TBD|待填写|example\.invalid|测试占位/.test(JSON.stringify(doc)))throw new Error('Incomplete publication data');
const pool=createPool(process.env.DATABASE_URL);
try{await transaction(pool,async client=>{
 await client.query('LOCK TABLE legal_document IN EXCLUSIVE MODE');
 if (!input.some(doc=>doc.type==='cross_border')) {
  const activeCross=await client.query("SELECT 1 FROM legal_document WHERE document_type='cross_border' AND active=true");
  if(activeCross.rowCount && !process.argv.includes('--retire-cross-border'))throw new Error('Explicit domestic cutover required before retiring cross-border notice');
  if(process.argv.includes('--retire-cross-border'))await client.query("UPDATE legal_document SET active=false WHERE document_type='cross_border'");
 }
 for(const doc of input){
  const existing=await client.query('SELECT body,title,operator_name,contact FROM legal_document WHERE document_type=$1 AND version=$2',[doc.type,doc.version]);
  if(existing.rows[0] && (existing.rows[0].body!==doc.body || existing.rows[0].title!==doc.title || existing.rows[0].operator_name!==doc.operatorName || existing.rows[0].contact!==doc.contact))throw new Error('Published versions are immutable; use a new version');
  await client.query('UPDATE legal_document SET active=false WHERE document_type=$1',[doc.type]);
  await client.query('INSERT INTO legal_document(document_type,version,title,body,operator_name,contact,active) VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT(document_type,version) DO UPDATE SET active=true',[doc.type,doc.version,doc.title,doc.body,doc.operatorName,doc.contact]);
 }
 await client.query(`INSERT INTO audit_log(principal_id,action,object_type,reason_code,after_state,trace_id) VALUES($1,'legal.publish','legal_document','OPERATOR_PUBLICATION',$2,gen_random_uuid()::text)`,[operator,JSON.stringify(input.map(doc=>({type:doc.type,version:doc.version})))]);
});console.log('Legal documents published atomically; no member consent was created.');}finally{await pool.end();}
