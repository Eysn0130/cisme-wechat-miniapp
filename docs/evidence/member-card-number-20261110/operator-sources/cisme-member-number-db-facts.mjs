import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
const [mode,state,packageFile]=process.argv.slice(2);
if(!['before','after'].includes(mode)||!/^\/opt\/cisme-trial\/member-card-upgrades\/apply-[a-f0-9]{12}$/.test(state)||!/^\/opt\/cisme-trial\/releases\/tencent-release-[a-f0-9]{12}\/package.json$/.test(packageFile))throw Error('FACT_CONTEXT_INVALID');
const u=new URL(process.env.DATABASE_URL);if(u.hostname!=='127.0.0.1'||u.username!=='cisme_trial'||u.pathname!=='/cisme_trial')throw Error('TRIAL_DATABASE_REQUIRED');
const {default:pg}=await import(createRequire(packageFile).resolve('pg'));
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000}),c=await pool.connect();
const q=v=>{if(!/^[a-z_][a-z0-9_]*$/.test(v))throw Error('IDENTIFIER_INVALID');return '"'+v+'"';};
try{
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TIME ZONE 'UTC'");
 const identity=(await c.query('SELECT current_database() AS db,current_user AS role')).rows[0];if(identity.db!=='cisme_trial'||identity.role!=='cisme_trial')throw Error('ISOLATION_REQUIRED');
 const tables=(await c.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name<>'member_card_number' AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') ORDER BY table_name,ordinal_position")).rows;
 const current={schemaVersion:1,tables:{}};for(const row of tables)(current.tables[row.table_name]??={columns:[],rows:[]}).columns.push(row.column_name);
 for(const [name,t] of Object.entries(current.tables)){
  const expr='jsonb_build_array('+t.columns.map(n=>'t.'+q(n)).join(',')+')::text';
  t.rows=(await c.query('SELECT encode(digest('+expr+",'sha256'),'hex') AS fingerprint,count(*)::text AS n FROM "+q(name)+' t'+(name==='schema_migration'?" WHERE version<>'202611100006_member_card_number.sql'":'')+' GROUP BY 1 ORDER BY 1')).rows;
 }
 const products=(await c.query("SELECT p.code,p.version,p.shopping_points_multiplier AS multiplier,inventory.stock_on_hand,inventory.reserved_quantity,price.amount_cents FROM catalog_product p JOIN catalog_sku s ON s.product_id=p.id JOIN catalog_price price ON price.sku_id=s.id JOIN catalog_inventory_level inventory ON inventory.sku_id=s.id WHERE p.code=ANY($1::text[]) ORDER BY p.code",[['aigerong-moisture-shampoo-280','aigerong-scalp-repair-essence-100']])).rows;
 let numbers=null;
 if(mode==='after'){
  numbers=(await c.query(`SELECT (SELECT count(*)::int FROM member) AS members,count(*)::int AS numbers,
    count(DISTINCT number)::int AS unique_numbers,min(number)::text AS first_number,
    bool_and(number>0) AS all_positive FROM member_card_number`)).rows[0];
  if(numbers.members!==numbers.numbers||numbers.numbers!==numbers.unique_numbers||numbers.all_positive!==true)throw Error('MEMBER_NUMBER_INTEGRITY_FAILED');
  const ordered=(await c.query(`SELECT NOT EXISTS(SELECT 1 FROM (SELECT id,row_number() OVER(ORDER BY created_at,id) AS n FROM member) m JOIN member_card_number mc ON mc.member_id=m.id WHERE mc.number<>m.n) AS matched`)).rows[0].matched;
  if(!ordered)throw Error('MEMBER_NUMBER_BACKFILL_ORDER_FAILED');
  const history=(await c.query('SELECT version FROM schema_migration ORDER BY version')).rows;
  if(history.length!==114||history.at(-1).version!=='202611100006_member_card_number.sql')throw Error('MEMBER_NUMBER_MIGRATION_REQUIRED');
 }
 await c.query('COMMIT');
 if(mode==='before')await writeFile(state+'/facts-private.json',JSON.stringify(current)+'\n',{mode:0o600,flag:'wx'});
 else{
  const prior=JSON.parse(await readFile(state+'/facts-private.json','utf8'));
  if(JSON.stringify(prior)!==JSON.stringify(current))throw Error('ORIGINAL_FACT_CHANGED');
 }
 console.log(JSON.stringify({mode,allFactsPreserved:mode==='after',tableCount:Object.keys(current.tables).length,numbers,products}));
}catch(error){await c.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({code:/^[A-Z_]{5,80}$/.test(error?.message??'')?error.message:'FACT_CHECK_FAILED'}));process.exitCode=1;}finally{c.release();await pool.end();}
