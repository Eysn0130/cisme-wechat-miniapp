import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const literal=value=>JSON.stringify(value);
const check=(value,code)=>{if(!value)throw Error(code);};
const same=(a,b)=>literal(a)===literal(b);

/** Called only by the bound release operation, never by a member/API route.
 * It creates release facts, not a member acceptance or publication intent. */
export async function activateTrialCommunity(client,input){
  check(input.reference==='cisme-user-direct-publication-20261104'&&
    /^[0-9a-f]{40}$/.test(input.sourceHead)&&/^[0-9a-f]{64}$/.test(input.probeSha256)&&
    Array.isArray(input.documents)&&input.documents.length===2,'ACTIVATION_INPUT_REQUIRED');
  for(const d of input.documents)check(['terms','privacy'].includes(d.type)&&d.version==='2026-11-03-v5'&&
    typeof d.body==='string'&&d.body.length>100&&d.body.length<100000,'ACTIVATION_DOCUMENT_INVALID');
  check(new Set(input.documents.map(d=>d.type)).size===2,'ACTIVATION_DOCUMENT_TYPES_REQUIRED');
  await client.query('BEGIN');
  try{
    await client.query('LOCK TABLE legal_document,ugc_go_live_approval,emergency_switch IN EXCLUSIVE MODE');
    const before=(await client.query('SELECT * FROM legal_document ORDER BY document_type,version')).rows;
    const legalHash=(await client.query("SELECT encode(digest(jsonb_agg(to_jsonb(l) ORDER BY document_type,version)::text,'sha256'),'hex') hash FROM legal_document l")).rows[0].hash;
    check(legalHash===input.legalBaselineSha256,'ACTIVATION_LEGAL_DRIFT');
    const active=before.filter(d=>d.active);
    check(active.length===2&&active.every(d=>['privacy','terms'].includes(d.document_type)&&d.version==='2026-10-28-v4'),
      'ACTIVATION_CURRENT_LEGAL_REQUIRED');
    check(!before.some(d=>d.version==='2026-11-03-v5'),'ACTIVATION_EXISTING_VERSION_REFUSED');
    check(!(await client.query("SELECT 1 FROM ugc_go_live_approval WHERE approval_reference=$1 OR revoked_at IS NULL AND signed_at<=now() AND expires_at>now()",[input.reference])).rowCount,'ACTIVATION_EXISTING_APPROVAL_REFUSED');
    const prior=(await client.query("SELECT * FROM emergency_switch WHERE key='community' FOR UPDATE")).rows[0];
    check(prior?.enabled===false,'ACTIVATION_EXISTING_SWITCH_REFUSED');
    const added=[];
    await client.query("UPDATE legal_document SET active=false WHERE active AND document_type IN ('privacy','terms')");
    for(const d of input.documents){
      const previous=active.find(row=>row.document_type===d.type);
      check(previous.operator_name===d.operatorName&&previous.contact===d.contact,'ACTIVATION_OPERATOR_DRIFT');
      added.push((await client.query(`INSERT INTO legal_document(document_type,version,title,body,operator_name,contact,active)
        VALUES($1,$2,$3,$4,$5,$6,true) RETURNING *`,[d.type,d.version,d.title,d.body,d.operatorName,d.contact])).rows[0]);
    }
    const expected=[...before.map(d=>d.active?{...d,active:false}:d),...added]
      .sort((a,b)=>a.document_type.localeCompare(b.document_type)||a.version.localeCompare(b.version));
    check(same((await client.query('SELECT * FROM legal_document ORDER BY document_type,version')).rows,expected),'ACTIVATION_UNRELATED_LEGAL_CHANGED');
    const approval=(await client.query(`INSERT INTO ugc_go_live_approval(approval_reference,signed_by,evidence,signed_at,expires_at)
      VALUES($1,'codex:workspace-owner-authorized',$2,now(),now()+interval '1 year') RETURNING id,expires_at`,
      [input.reference,{authorization:'User explicitly requested public posting and all required functionality; no prepublication human review; proceed without message push.',
        scope:'isolated trial ordinary community publication',sourceHead:input.sourceHead,provider:'wechat_v1_sync',probeSha256:input.probeSha256,
        legalVersion:'2026-11-03-v5',memberAcceptanceCreated:false,authorityGranted:false,productionChanged:false}])).rows[0];
    const changed=(await client.query("UPDATE emergency_switch SET enabled=true,version=version+1,updated_at=clock_timestamp(),updated_by='codex:workspace-owner-authorized' WHERE key='community' AND enabled=false RETURNING *")).rows;
    check(changed.length===1&&same({...changed[0],enabled:prior.enabled,version:prior.version,updated_at:prior.updated_at,updated_by:prior.updated_by},prior),'ACTIVATION_SWITCH_DELTA_INVALID');
    const trace=randomUUID();
    await client.query(`INSERT INTO audit_log(principal_id,action,object_type,reason_code,after_state,trace_id)
      VALUES('codex:workspace-owner-authorized','community.direct_publication_enabled','release','USER_AUTHORIZED_AUTOMATIC_PUBLICATION',$1,$2)`,
      [{sourceHead:input.sourceHead,approvalId:approval.id,legalDocuments:input.documents.map(d=>({type:d.type,version:d.version})),
        provider:'wechat_v1_sync',prepublicationHumanReview:false,messagePushRequired:false,memberConsentCreated:false},trace]);
    await client.query('COMMIT');
    return {approvalId:approval.id,approvalReference:input.reference,expiresAt:approval.expires_at,auditTrace:trace,
      publicSwitchEnabled:true,legalVersion:'2026-11-03-v5',memberConsentCreated:false,authorityGranted:false};
  }catch(error){await client.query('ROLLBACK');throw error;}
}

if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  const require=createRequire(process.env.TASK_RELEASE+'/package.json'),{Client}=require('pg');
  const client=new Client({connectionString:process.env.DATABASE_URL});
  await client.connect();
  try{console.log(JSON.stringify(await activateTrialCommunity(client,JSON.parse(readFileSync(process.argv[2]??0,'utf8')))));}
  catch{console.error('ACTIVATION_REQUIRES_REVIEW');process.exitCode=1;}
  finally{await client.end();}
}
