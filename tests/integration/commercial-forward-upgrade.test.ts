import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { TEST_DATABASE_URL, assertDisposableTarget, testPool } from "@cisme/testkit";
import { assertFinalSchemaContract } from "../../scripts/final-schema-contract";

const exec=promisify(execFile);
const adminUrl=new URL(TEST_DATABASE_URL);
adminUrl.pathname="/postgres";
const databaseName=`cisme_upgrade_test_${randomUUID().replaceAll("-","")}`;
const databaseUrl=new URL(adminUrl);
databaseUrl.pathname=`/${databaseName}`;
const admin=new pg.Pool({connectionString:adminUrl.toString()});
const db=new pg.Pool({connectionString:databaseUrl.toString()});
let created=false;

beforeAll(async()=>{
  const owned = testPool();
  try { await assertDisposableTarget(owned); } finally { await owned.end(); }
  await admin.query(`CREATE DATABASE ${databaseName}`);
  created=true;
});
afterAll(async()=>{
  try{
    await db.end();
    if(created)await admin.query(`DROP DATABASE ${databaseName}`);
  }finally{await admin.end();}
});

it("upgrades PR #1 members through the prior PR #2 commercial schema and preserves unknown transfers",async()=>{
  await db.query(`CREATE TABLE schema_migration(version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now())`);
  const files=(await readdir("db/migrations")).filter(file=>file.endsWith(".sql")).sort();
  const pr1Head="202609120001_support_commercial_chat.sql";
  const priorPr2Head="202609120021_ugc_report_target_revision.sql";
  expect(files).toContain(pr1Head);
  expect(files).toContain(priorPr2Head);
  async function applyOldFiles(selected:string[]){
    for(const file of selected){
      const source=await readFile(resolve("db/migrations",file),"utf8");
      const client=await db.connect();
      try{
        await client.query("BEGIN");
        await client.query(source.split("-- migrate:down")[0]!);
        await client.query("INSERT INTO schema_migration(version) VALUES($1)",[file]);
        await client.query("COMMIT");
      }catch(error){await client.query("ROLLBACK");throw error;}
      finally{client.release();}
    }
  }
  await applyOldFiles(files.filter(file=>file<=pr1Head));
  const owner=(await db.query<{id:string}>("INSERT INTO member(display_name) VALUES('Legacy payee') RETURNING id")).rows[0]!.id;
  const reviewer=(await db.query<{id:string}>("INSERT INTO member(display_name) VALUES('Legacy reviewer') RETURNING id")).rows[0]!.id;
  expect((await db.query("SELECT to_regclass('public.commission_settlement_request') AS name")).rows[0].name)
    .toBeNull();
  await applyOldFiles(files.filter(file=>file>pr1Head&&file<=priorPr2Head));
  await db.query(`INSERT INTO commercial_membership(member_id,state,effective_at,expires_at,
    changed_by,change_reason) VALUES($1,'active','2026-01-31T00:00:00+08:00',NULL,
      'fixture:prior-pr2','Existing indefinite grant must remain indefinite')`,[owner]);
  const rule=(await db.query<{id:string;effective_at:Date}>(`INSERT INTO commission_rate_rule
    (member_id,basis_points,state,effective_at,created_by,approved_by,reason,decided_at)
    VALUES($1,2200,'active','2026-02-01T00:00:00+08:00','fixture:proposer',
      'fixture:checker','Old intermediate rate remains historical only',now()) RETURNING id,effective_at`,[owner])).rows[0]!;
  const transfer=(await db.query<{id:string;created_at:Date}>(`INSERT INTO commission_settlement_request
    (member_id,requested_by_member_id,idempotency_key,request_hash,amount_cents,reason,
      policy_version,state,version,approved_by_member_id,decision_key,decision_hash,
      decision_reason,app_id,merchant_id,payee_openid,out_bill_no,scene_id,transfer_remark,decided_at)
    VALUES($1,$1,'prior-unknown-transfer-001',$3,10000,'Old unknown payout intent',
      'isolated-settlement-v1','unknown',2,$2,'prior-approval-001',$3,
      'Independent historical approval','wxfixtureold','1234567890','legacy-openid',
      'CSLEGACY00000001','OLD_TEST','Previous test transfer',now()) RETURNING id,created_at`,
    [owner,reviewer,"a".repeat(64)])).rows[0]!;
  await exec("./node_modules/.bin/tsx",["scripts/migrate.ts","up"],
    {env:{...process.env,DATABASE_URL:databaseUrl.toString()}});
  expect((await db.query("SELECT count(*)::int AS n FROM schema_migration")).rows[0].n).toBe(files.length);
  expect(await assertFinalSchemaContract(db)).toEqual({tables:41,constraints:47,indexes:36,triggers:36});
  expect((await db.query(`SELECT state,expires_at FROM commercial_membership WHERE member_id=$1`,[owner])).rows[0])
    .toMatchObject({state:"active",expires_at:null});
  const upgradedRule=(await db.query(`SELECT basis_points,rule_version,proposed_effective_at,effective_at
    FROM commission_rate_rule WHERE id=$1`,[rule.id])).rows[0];
  expect(upgradedRule.basis_points).toBe(2200);
  expect(upgradedRule.rule_version).toBe("legacy-v1");
  expect(new Date(upgradedRule.proposed_effective_at).toISOString()).toBe(rule.effective_at.toISOString());
  const upgradedTransfer=(await db.query(`SELECT state,first_dispatch_started_at,created_at,cycle_id,
    gross_cents,withholding_cents,out_bill_no FROM commission_settlement_request WHERE id=$1`,[transfer.id])).rows[0];
  expect(upgradedTransfer).toMatchObject({state:"unknown",cycle_id:null,gross_cents:null,
    withholding_cents:null,out_bill_no:"CSLEGACY00000001"});
  expect(new Date(upgradedTransfer.first_dispatch_started_at).toISOString())
    .toBe(transfer.created_at.toISOString());
  await expect(db.query(`UPDATE commission_settlement_request SET first_dispatch_started_at=NULL WHERE id=$1`,
    [transfer.id])).rejects.toMatchObject({code:"55000"});
  await exec("./node_modules/.bin/tsx",["scripts/migrate.ts","up"],
    {env:{...process.env,DATABASE_URL:databaseUrl.toString()}});
  expect((await db.query("SELECT count(*)::int AS n FROM schema_migration")).rows[0].n).toBe(files.length);
},90_000);
