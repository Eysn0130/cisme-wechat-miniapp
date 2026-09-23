import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { resetDatabase, testPool } from "@cisme/testkit";
const pool=testPool();
beforeAll(async()=>{
  // Never use an inferred production URL. The existing reset helper also
  // verifies the server's actual current_database() before replacing schema.
  expect(process.env.TEST_DATABASE_URL).toBeTruthy();await resetDatabase(pool);
});
afterAll(async()=>{await pool.end();});
it("exports only migrated schema metadata as a complete policy-review denominator",async()=>{
  const tableRows=(await pool.query<{name:string}>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows;
  const columns=(await pool.query<{table_name:string;column_name:string;ordinal_position:number;data_type:string;is_nullable:string}>(
    "SELECT table_name,column_name,ordinal_position,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
  const references=(await pool.query<{table_name:string;column_name:string;referenced_table:string;referenced_column:string}>(`SELECT src.relname AS table_name,sa.attname AS column_name,
    dst.relname AS referenced_table,da.attname AS referenced_column FROM pg_constraint c
    JOIN pg_class src ON src.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=src.relnamespace
    JOIN pg_class dst ON dst.oid=c.confrelid
    CROSS JOIN LATERAL unnest(c.conkey,c.confkey) AS k(source_att,target_att)
    JOIN pg_attribute sa ON sa.attrelid=src.oid AND sa.attnum=k.source_att
    JOIN pg_attribute da ON da.attrelid=dst.oid AND da.attnum=k.target_att
    WHERE c.contype='f' AND ns.nspname='public'
    ORDER BY src.relname,sa.attname,dst.relname,da.attname`)).rows;
  expect(tableRows.length).toBeGreaterThan(100);expect(tableRows.length).toBeLessThan(1000);
  expect(columns.length).toBeLessThan(20000);
  const migrations=[];const hash=createHash("sha256");
  for(const name of (await readdir("db/migrations")).filter(n=>n.endsWith(".sql")).sort()){
    const bytes=await readFile(join("db/migrations",name));const sha256=createHash("sha256").update(bytes).digest("hex");
    migrations.push({name,sha256});hash.update(name+"\0").update(bytes).update("\0");
  }
  const tables=tableRows.map(({name})=>({table:name,columns:columns.filter(c=>c.table_name===name).map(c=>({name:c.column_name,type:c.data_type,nullable:c.is_nullable==="YES"})),
    foreignKeys:references.filter(f=>f.table_name===name).map(f=>({column:f.column_name,table:f.referenced_table,referencedColumn:f.referenced_column})),
    subjectObjectFieldReview:"unreviewed",exportDeletionPolicy:"unreviewed",legalHoldPolicy:"unreviewed"}));
  const result={schemaVersion:1,kind:"synthetic-migrated-schema-only-NOT-personal-data-export",releaseReady:false,
    privacyPolicyApproved:false,productionInspected:false,memberRowsRead:0,
    scope:"All public BASE TABLE metadata after the current ordered migrations, including metadata/audit/reference tables. Not every table contains personal data; FK presence is not a retention or authorization decision. No row content, defaults, connection URL or credentials are exported.",
    tableCount:tables.length,columnCount:tables.reduce((n,t)=>n+t.columns.length,0),foreignKeyColumnCount:references.length,
    migrationSetSha256:hash.digest("hex"),migrationHashAlgorithm:"ordered UTF8 filename + NUL + raw SQL bytes + NUL",migrations,tables};
  // Capture only schema metadata before comparison so drift is inspectable.
  if(process.env.RUNNER_TEMP){const output=join(process.env.RUNNER_TEMP,"native-validation");await mkdir(output,{recursive:true});await writeFile(join(output,"privacy-schema-inventory.json"),JSON.stringify(result,null,2)+"\n");}
  expect(tables.map(t=>t.table)).toEqual(expect.arrayContaining(["member","member_profile","commerce_order","commerce_refund_request","commission_settlement_request","support_message","legal_hold","privacy_request"]));
  expect(tables.every(t=>t.columns.length>0)).toBe(true);
  const subjectMap=JSON.parse(await readFile('docs/privacy/subject-data-map.json','utf8')) as {
    migrationSetSha256:string;tables:Array<{table:string;exportFields:string[];excludedFields:string[];productionErasure:string}>};
  expect(subjectMap.migrationSetSha256).toBe(result.migrationSetSha256);
  expect(subjectMap.tables.map(t=>t.table).sort()).toEqual(tables.map(t=>t.table).sort());
  for(const table of tables){
    const policy=subjectMap.tables.find(t=>t.table===table.table)!;
    expect([...policy.exportFields,...policy.excludedFields].sort(),table.table).toEqual(table.columns.map(c=>c.name).sort());
    expect(policy.productionErasure).toBe('DISABLED');
  }

  expect(new Set(tables.map(t=>t.table)).size).toBe(tableRows.length);
  console.log(JSON.stringify({schemaMetadataOnly:true,tableCount:result.tableCount,columnCount:result.columnCount,foreignKeyColumnCount:result.foreignKeyColumnCount,privacyPolicyApproved:false}));
});
