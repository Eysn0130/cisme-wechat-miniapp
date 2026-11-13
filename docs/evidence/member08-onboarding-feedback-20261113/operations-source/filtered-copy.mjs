import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const {default:pg}=await import(createRequire('/opt/cisme-trial/releases/tencent-release-eeeb891cfa36/package.json').resolve('pg'));
const destination=process.env.RESET_DESTINATION; if(!/^cisme_trial_reset_[a-z0-9_]+$/.test(destination??''))throw Error('DESTINATION_INVALID');
const original=JSON.parse(readFileSync('/tmp/cisme-trial-reset-members-private.json','utf8'));
const admin=original.members.filter(m=>m.card_number==='1'&&m.active_capabilities===11&&m.display_name==='ʜᴇ ʜᴇ ʜᴇ');if(admin.length!==1)throw Error('ADMIN_CANONICAL_PROOF_REQUIRED');
const keep=admin[0].id,targets=original.members.filter(m=>m.id!==keep).map(m=>m.id),q=n=>{if(!/^[a-z_][a-z0-9_]*$/.test(n))throw Error('IDENTIFIER_INVALID');return '"'+n+'"';};
const targetPool=new pg.Pool({host:'/var/run/postgresql',user:'postgres',database:destination,max:1});const target=await targetPool.connect();
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1}),c=await pool.connect();
try{
 await c.query("SET TIME ZONE 'UTC'");await target.query("SET TIME ZONE 'UTC'");
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL statement_timeout='30s'");
 const identity=(await c.query('SELECT current_database() AS db,current_user AS role')).rows[0];if(identity.db!=='cisme_trial'||identity.role!=='cisme_trial')throw Error('TRIAL_REQUIRED');
 const columns=(await c.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') ORDER BY table_name,ordinal_position")).rows;
 const generated=(await c.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND is_generated<>'NEVER'")).rows[0].n;if(generated)throw Error('GENERATED_COLUMNS_REQUIRE_PLAN');
 const tableNames=[...new Set(columns.map(x=>x.table_name))];if(tableNames.length!==180)throw Error('SCHEMA_DRIFT');
 const fks=(await c.query(`SELECT conrelid::regclass::text AS child,confrelid::regclass::text AS parent,
 ARRAY(SELECT a.attname::text FROM unnest(conkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=conrelid AND a.attnum=k.attnum ORDER BY k.n) AS child_cols,
 ARRAY(SELECT a.attname::text FROM unnest(confkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=confrelid AND a.attnum=k.attnum ORDER BY k.n) AS parent_cols
 FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace`)).rows;
 const primary=(await c.query(`SELECT conrelid::regclass::text AS name,ARRAY(SELECT a.attname::text FROM unnest(conkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=conrelid AND a.attnum=k.attnum ORDER BY k.n) AS cols FROM pg_constraint WHERE contype='p' AND connamespace='public'::regnamespace`)).rows;
 const required=Object.fromEntries(tableNames.map(n=>[n,new Set()]));for(const f of fks){f.child_cols.forEach(x=>required[f.child].add(x));f.parent_cols.forEach(x=>required[f.parent].add(x));}for(const p of primary)p.cols.forEach(x=>required[p.name].add(x));
 const tables={};let bytes=0,count=0;
 for(const name of tableNames){const keys=[...required[name]];const expr=keys.length?'json_build_object('+keys.map(x=>"'"+x+"',t."+q(x)+'::text').join(',')+')':"'{}'::json";
 const rows=(await c.query('SELECT ctid::text AS tuple,row_to_json(t)::text AS raw,'+expr+' AS keys FROM '+q(name)+' t ORDER BY ctid')).rows;
 for(const r of rows){r.removed=false;bytes+=r.raw.length;count++;}tables[name]=rows;}
 if(bytes>64*1024*1024||count>100000)throw Error('PREVIEW_MEMORY_BOUND');
 // Recheck the exact target list against current business facts; a new real order must not disappear during a member reset.
 for(const name of ['commerce_order','points_redemption_order','reward_claim','transaction_order','payout_order','commission_payout'])for(const row of tables[name]??[]){const value=JSON.parse(row.raw);if(targets.includes(value.member_id)||targets.includes(value.owner_member_id))throw Error('TARGET_BUSINESS_ORDER_REQUIRES_REVIEW:'+name);}
 for(const row of tables.authority_grant??[]){const value=JSON.parse(row.raw);if(targets.includes(value.member_id)&&!value.revoked_at)throw Error('TARGET_NEW_AUTHORITY_REQUIRES_REVIEW');}
 const tokens=new Set(targets);for(const w of tables.wechat_identity){const v=JSON.parse(w.raw);if(targets.includes(v.member_id)){tokens.add(v.id);if(typeof v.openid==='string'&&v.openid.length>=8)tokens.add(v.openid);}}
 const pk=Object.fromEntries(primary.map(x=>[x.name,x.cols]));let changed=true,iterations=0;
 while(changed){if(++iterations>300)throw Error('CLOSURE_DID_NOT_CONVERGE');changed=false;const identifiers=[...tokens];
  const mark=(name,r)=>{if(r.removed)return;r.removed=true;changed=true;for(const col of pk[name]??[]){const value=r.keys[col];if(typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(value))tokens.add(value);}};
  for(const[name,rows]of Object.entries(tables))for(const r of rows)if(!r.removed&&identifiers.some(token=>r.raw.includes(token)))mark(name,r);
  for(const f of fks){const parents=new Set(tables[f.parent].filter(r=>r.removed).map(r=>JSON.stringify(f.parent_cols.map(x=>r.keys[x]))));
   for(const r of tables[f.child]){const values=f.child_cols.map(x=>r.keys[x]);if(values.every(x=>x!==null)&&parents.has(JSON.stringify(values)))mark(f.child,r);}}
 }
 const protectedTables=['member','wechat_identity','member_card_number','member_profile','member_contact','member_care_profile','member_points_profile','authority_grant','points_grant','points_lot','points_entry','points_projection','commerce_order'];
 const violations=[];
 for(const name of protectedTables)for(const r of tables[name]??[]){const v=JSON.parse(r.raw);const owner=name==='member'?v.id:v.member_id;if(owner&&!targets.includes(owner)&&r.removed)violations.push(name);}
 for(const[name,rows]of Object.entries(tables))if(name.startsWith('catalog_')||['legal_document','schema_migration','member_points_policy','reward_component_inventory','reward_activity','editorial_publisher'].includes(name))if(rows.some(r=>r.removed))violations.push(name);
 for(const r of tables.ugc_post??[])if(!targets.includes(JSON.parse(r.raw).author_member_id)&&r.removed)violations.push('admin_own_post');
 for(const r of tables.ugc_media_asset??[])if(!targets.includes(JSON.parse(r.raw).owner_member_id)&&r.removed)violations.push('admin_own_media');
 for(const r of tables.editorial_article??[]){const v=JSON.parse(r.raw);if(v.publisher_id==='fe841ebb-1db1-57de-988b-4ff1534f23e6'&&r.removed)violations.push('official_article');}
 if(violations.length)throw Error('PROTECTED_ROWS:'+violations.join(','));
 const sequences=(await c.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public'")).rows;
 const sequenceStates=[];for(const row of sequences){const value=(await c.query('SELECT last_value::text,is_called FROM '+q(row.sequencename))).rows[0];sequenceStates.push({name:row.sequencename,...value});}
 const allSchemas=(await c.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema' ORDER BY nspname")).rows;if(allSchemas.length!==1||allSchemas[0].nspname!=='public')throw Error('UNEXPECTED_USER_SCHEMA');
 await target.query('BEGIN');
 for(const[name,rows]of Object.entries(tables))for(const r of rows)if(!r.removed)await target.query('INSERT INTO '+q(name)+' OVERRIDING SYSTEM VALUE SELECT (json_populate_record(NULL::'+q(name)+',$1::json)).*',[r.raw]);
 for(const seq of sequenceStates)await target.query('SELECT setval($1::regclass,$2::bigint,$3)',[seq.name,seq.last_value,seq.is_called]);
 const report={schemaVersion:1,destination,memberCountBefore:tables.member.length,removedMembers:targets.length,retainedMemberNumbers:tables.member_card_number.filter(r=>!r.removed).map(r=>String(JSON.parse(r.raw).number)),schemaTables:tableNames.length,exactRowsVerified:0,derivedChanged:{},sequencesPreserved:sequenceStates.length,excludedMediaAssets:tables.ugc_media_asset.filter(r=>r.removed).length,mediaAccess:'UGC public and private routes require retained database rows and active canonical authors; physical private objects retained for reversible archive recovery',protectedViolations:violations};
 const fingerprint=rows=>createHash('sha256').update(rows.slice().sort().join('\n')).digest('hex');
 // Compare every retained raw row before repairing only the two derived counters.
 for(const[name,rows]of Object.entries(tables)){const expected=rows.filter(r=>!r.removed).map(r=>r.raw),actual=(await target.query('SELECT row_to_json(t)::text AS raw FROM '+q(name)+' t')).rows.map(r=>r.raw);if(fingerprint(expected)!==fingerprint(actual))throw Error('RETAINED_ROW_DRIFT:'+name);report.exactRowsVerified+=actual.length;}
 report.derivedChanged.pointsBudget=(await target.query(`UPDATE member_points_budget b SET issued=COALESCE((SELECT sum(g.amount) FROM points_grant g WHERE g.rule_version=b.policy_version AND to_char(g.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM')=b.month_bucket AND g.source_type<>'refund_recovery'),0) WHERE issued IS DISTINCT FROM COALESCE((SELECT sum(g.amount) FROM points_grant g WHERE g.rule_version=b.policy_version AND to_char(g.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM')=b.month_bucket AND g.source_type<>'refund_recovery'),0)`)).rowCount;
 report.derivedChanged.communityStats=(await target.query(`WITH counts AS (SELECT s.post_id,(SELECT count(*)::int FROM community_reaction r JOIN member m ON m.id=r.member_id AND m.status='active' WHERE r.post_id=s.post_id AND r.kind='like') likes,(SELECT count(*)::int FROM community_reaction r JOIN member m ON m.id=r.member_id AND m.status='active' WHERE r.post_id=s.post_id AND r.kind='save') saves,(SELECT count(*)::int FROM community_comment r JOIN member m ON m.id=r.member_id AND m.status='active' WHERE r.post_id=s.post_id AND r.status='published') comments FROM community_post_stats s) UPDATE community_post_stats s SET like_count=c.likes,save_count=c.saves,comment_count=c.comments,version=s.version+1,updated_at=clock_timestamp() FROM counts c WHERE s.post_id=c.post_id AND (s.like_count,s.save_count,s.comment_count) IS DISTINCT FROM (c.likes,c.saves,c.comments)`)).rowCount;
 for(const name of ['member','wechat_identity','member_card_number','authority_grant','points_projection','commerce_order']){const rows=(await target.query('SELECT row_to_json(t)::text AS raw FROM '+q(name)+' t')).rows;if(rows.some(r=>targets.some(id=>r.raw.includes(id))))throw Error('TARGET_REMAINS:'+name);}
 report.retainedAdmin={capabilities:(await target.query("SELECT count(*)::int n FROM authority_grant WHERE member_id=$1 AND revoked_at IS NULL",[keep])).rows[0].n,points:(await target.query('SELECT available FROM points_projection WHERE member_id=$1',[keep])).rows[0]?.available,orders:(await target.query('SELECT count(*)::int n FROM commerce_order WHERE member_id=$1',[keep])).rows[0].n};
 const expectedAdmin={capabilities:tables.authority_grant.map(r=>JSON.parse(r.raw)).filter(v=>v.member_id===keep&&!v.revoked_at).length,points:tables.points_projection.map(r=>JSON.parse(r.raw)).find(v=>v.member_id===keep)?.available,orders:tables.commerce_order.map(r=>JSON.parse(r.raw)).filter(v=>v.member_id===keep).length};if(JSON.stringify(report.retainedAdmin)!==JSON.stringify(expectedAdmin))throw Error('ADMIN_ASSET_DRIFT');
 await target.query('COMMIT');await c.query('COMMIT');
 console.log(JSON.stringify(report));
}finally{c.release();target.release();await pool.end();await targetPool.end();}
