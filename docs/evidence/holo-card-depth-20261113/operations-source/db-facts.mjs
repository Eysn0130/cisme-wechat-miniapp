import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const migration='202611130001_activity_travel_rewards.sql';
const newTables=['activity_reward_claim','member_purchase_coupon','reward_activity','reward_award','reward_component_inventory','reward_event','reward_quote','reward_stock_reservation','reward_voucher'].sort();
const additions={commerce_checkout_quote:['coupon_id','coupon_discount_cents','coupon_version'],commerce_order:['coupon_id','coupon_discount_cents']};
function requireTrue(value,code){if(!value)throw Error(code);}
function compare(before,after){
 requireTrue(JSON.stringify(Object.keys(after.tables).sort())===JSON.stringify([...Object.keys(before.tables),...newTables].sort()),'TABLE_SET_DRIFT');
 for(const[name,old]of Object.entries(before.tables)){
  const current=after.tables[name];requireTrue(JSON.stringify(current.columns.slice(0,old.columns.length))===JSON.stringify(old.columns),'ORIGINAL_COLUMNS_CHANGED');
  requireTrue(JSON.stringify(current.columns.slice(old.columns.length).map(x=>x.name))===JSON.stringify(additions[name]||[]),'UNEXPECTED_ADDED_COLUMNS');
  requireTrue(JSON.stringify(current.rows)===JSON.stringify(old.rows),'ORIGINAL_ROW_CHANGED');
 }
}
if(process.argv[2]==='--self-test'){
 const before={tables:{commerce_order:{columns:[{name:'id'}],rows:[{fingerprint:'stable',n:'1'}]},member:{columns:[{name:'id'}],rows:[{fingerprint:'original',n:'1'}]}}};
 const fixture=()=>({tables:{...structuredClone(before.tables),commerce_order:{columns:[{name:'id'},...additions.commerce_order.map(name=>({name}))],rows:[{fingerprint:'stable',n:'1'}]},...Object.fromEntries(newTables.map(name=>[name,{columns:[],rows:[]}]))}});
 compare(before,fixture());
 for(const mutate of [x=>{x.tables.member.rows=[];},x=>{x.tables.member.columns=[];},x=>{x.tables.commerce_order.columns.push({name:'unreviewed'});},x=>{delete x.tables.reward_voucher;},x=>{x.tables.extra={columns:[],rows:[]};},x=>{x.tables.member.rows[0].fingerprint='changed';}]){const x=fixture();mutate(x);assert.throws(()=>compare(before,x));}
 console.log(JSON.stringify({offlineAssertions:7,passed:true}));
}else await run().catch(error=>{console.error(JSON.stringify({code:/^[A-Z_]{5,80}$/.test(error?.message??'')?error.message:'FACT_CHECK_FAILED'}));process.exitCode=1;});
async function run(){
 const[mode,state,packageFile]=process.argv.slice(2);
 requireTrue(['before','after','preflight','history'].includes(mode)&&/^\/opt\/cisme-trial\/reward-holo-upgrades\/apply-[a-f0-9]{12}(?:-r[0-9]+)?$/.test(state)&&/^\/opt\/cisme-trial\/releases\/tencent-release-[a-f0-9]{12}\/package.json$/.test(packageFile),'FACT_CONTEXT_INVALID');
 const u=new URL(process.env.DATABASE_URL);requireTrue(u.hostname==='127.0.0.1'&&u.username==='cisme_trial'&&u.pathname==='/cisme_trial','TRIAL_DATABASE_REQUIRED');
 const{default:pg}=await import(createRequire(packageFile).resolve('pg'));const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000}),c=await pool.connect();
 const q=v=>{requireTrue(/^[a-z_][a-z0-9_]*$/.test(v),'IDENTIFIER_INVALID');return'"'+v+'"';};
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TIME ZONE 'UTC'");await c.query("SET LOCAL statement_timeout='60s'");
  const identity=(await c.query('SELECT current_database() AS db,current_user AS role')).rows[0];requireTrue(identity.db==='cisme_trial'&&identity.role==='cisme_trial','ISOLATION_REQUIRED');
  if(mode==='history'){const h=(await c.query('SELECT version FROM schema_migration ORDER BY version')).rows;await c.query('COMMIT');console.log(JSON.stringify({migrations:h.length,lastMigration:h.at(-1)?.version}));return;}
  const prior=mode==='after'?JSON.parse(await readFile(state+'/facts-private.json','utf8')):null;
  const schema=(await c.query("SELECT table_name,column_name AS name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') ORDER BY table_name,ordinal_position")).rows;
  const current={schemaVersion:1,tables:{}};
  for(const{table_name,...column}of schema)(current.tables[table_name]??={columns:[],rows:[]}).columns.push(column);
  for(const[name,t]of Object.entries(current.tables)){
   const columns=prior?.tables[name]?.columns||t.columns,expr='jsonb_build_array('+columns.map(x=>'t.'+q(x.name)).join(',')+')::text';
   const filter=name==='schema_migration'?' WHERE version<>$1':'';
   t.rows=(await c.query('SELECT encode(digest('+expr+",'sha256'),'hex') AS fingerprint,count(*)::text AS n FROM "+q(name)+' t'+filter+' GROUP BY 1 ORDER BY 1',filter?[migration]:[])).rows;
  }
  const history=(await c.query('SELECT version FROM schema_migration ORDER BY version')).rows;
  if(mode==='after'){
   requireTrue(history.length===115&&history.at(-1).version===migration,'NEW_SCHEMA_HISTORY_INVALID');compare(prior,current);
   for(const[name,cols]of Object.entries(additions)){
    const conditions=cols.map(x=>x==='coupon_discount_cents'?q(x)+'<>0':q(x)+' IS NOT NULL').join(' OR ');
    requireTrue((await c.query('SELECT count(*)::int AS n FROM '+q(name)+' WHERE '+conditions)).rows[0].n===0,'EXISTING_ORDER_COUPON_CHANGED');
   }
   for(const name of newTables.filter(x=>x!=='reward_component_inventory'))requireTrue((await c.query('SELECT count(*)::int AS n FROM '+q(name))).rows[0].n===0,'UNEXPECTED_REWARD_ASSET');
   const stock=(await c.query('SELECT code,stock_on_hand,reserved_quantity,confirmed,version FROM reward_component_inventory ORDER BY code')).rows;
   requireTrue(JSON.stringify(stock)===JSON.stringify(['conditioner100','dandruff50','moisture100'].map(code=>({code,stock_on_hand:0,reserved_quantity:0,confirmed:false,version:1}))),'REAL_STOCK_WAS_INFERRED');
  }else{
   requireTrue(history.length===114&&history.at(-1).version==='202611100006_member_card_number.sql','BASELINE_SCHEMA_INVALID');
   requireTrue(Object.keys(current.tables).length===171&&!newTables.some(name=>current.tables[name]),'BASELINE_TABLE_SET_INVALID');
  }
  const products=(await c.query("SELECT p.code,p.version,p.shopping_points_multiplier AS multiplier,i.stock_on_hand,i.reserved_quantity,price.amount_cents FROM catalog_product p JOIN catalog_sku s ON s.product_id=p.id JOIN catalog_price price ON price.sku_id=s.id JOIN catalog_inventory_level i ON i.sku_id=s.id WHERE p.code=ANY($1::text[]) ORDER BY p.code",[['aigerong-moisture-shampoo-280','aigerong-scalp-repair-essence-100']])).rows;
  await c.query('COMMIT');if(mode==='before')await writeFile(state+'/facts-private.json',JSON.stringify(current)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({mode,allOriginalColumnsAndRowsPreserved:mode==='after',tableCount:Object.keys(current.tables).length,migrations:history.length,products,unconfiguredRewardStock:mode==='after'}));
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();await pool.end();}
}
