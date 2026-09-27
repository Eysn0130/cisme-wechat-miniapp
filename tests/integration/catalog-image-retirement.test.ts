import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {promisify} from 'node:util';
import pg from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {TEST_DATABASE_URL,assertDisposableTarget,testPool} from '@cisme/testkit';

const exec=promisify(execFile);
const adminUrl=new URL(TEST_DATABASE_URL);
adminUrl.pathname='/postgres';
const databaseName='cisme_catalog_retirement_'+randomUUID().replaceAll('-','');
const migrationUrl=new URL(adminUrl);
migrationUrl.pathname='/'+databaseName;
const admin=new pg.Pool({connectionString:adminUrl.toString()});
const db=new pg.Pool({connectionString:migrationUrl.toString()});
const env={...process.env,DATABASE_URL:migrationUrl.toString()};
const latest='202609250001_retire_unapproved_catalog_images.sql';
let laterCount=0;
let databaseCreated=false;

beforeAll(async()=>{
  const owned=testPool();
  try{await assertDisposableTarget(owned);}finally{await owned.end();}
  await admin.query(`CREATE DATABASE ${databaseName}`);
  databaseCreated=true;
  await db.query('CREATE TABLE schema_migration(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  const files=(await readdir('db/migrations')).filter(file=>file.endsWith('.sql')).sort();
  expect(files).toContain(latest);
  laterCount=files.filter(file=>file>latest).length;
  for(const file of files.filter(file=>file<latest)){
    const up=(await readFile('db/migrations/'+file,'utf8')).split('-- migrate:down')[0]!;
    await db.query(up);
    await db.query('INSERT INTO schema_migration(version) VALUES($1)',[file]);
  }
},90_000);
afterAll(async()=>{
  try{
    await db.end();
    if(databaseCreated)await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
  }finally{await admin.end();}
},60_000);

it('reviews unknown retired references, preserves admin images, and rolls back partial attempts atomically',async()=>{
  const approved='/assets/cisme/admin-approved-product.jpg';
  const retired='/assets/cisme/community-card-glossy-hair-v1.jpg';
  await db.query(`INSERT INTO catalog_product(code,name,image_path,created_by,updated_by)
    VALUES('synthetic-approved','Synthetic approved product',$1,'synthetic','synthetic'),
      ('synthetic-retired','Synthetic retired reference',$2,'synthetic','synthetic')`,[approved,retired]);
  const countBefore=(await db.query('SELECT count(*)::int n FROM schema_migration')).rows[0].n as number;
  await expect(exec('./node_modules/.bin/tsx',['scripts/migrate.ts','up'],{env})).rejects.toMatchObject({
    stderr:expect.stringContaining('CATALOG_RETIRED_IMAGE_REVIEW_REQUIRED')
  });
  expect((await db.query('SELECT count(*)::int n FROM schema_migration')).rows[0].n).toBe(countBefore);
  expect((await db.query("SELECT image_path,version FROM catalog_product WHERE code='synthetic-retired'")).rows[0])
    .toEqual({image_path:retired,version:1});

  await db.query("DELETE FROM catalog_product WHERE code='synthetic-retired'");
  await db.query(`CREATE FUNCTION reject_retirement_journal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.version='202609250001_retire_unapproved_catalog_images.sql' THEN
      RAISE EXCEPTION 'SYNTHETIC_JOURNAL_FAILURE'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_retirement_journal BEFORE INSERT ON schema_migration
      FOR EACH ROW EXECUTE FUNCTION reject_retirement_journal()`);
  await expect(exec('./node_modules/.bin/tsx',['scripts/migrate.ts','up'],{env})).rejects.toMatchObject({
    stderr:expect.stringContaining('SYNTHETIC_JOURNAL_FAILURE')
  });
  expect((await db.query('SELECT count(*)::int n FROM schema_migration')).rows[0].n).toBe(countBefore);
  expect((await db.query("SELECT image_path,version FROM catalog_product WHERE code='care-serum-30'")).rows[0])
    .toEqual({image_path:'/assets/cisme/community-card-purple-bottle-v1.jpg',version:1});
  await db.query('DROP TRIGGER reject_retirement_journal ON schema_migration; DROP FUNCTION reject_retirement_journal()');

  await exec('./node_modules/.bin/tsx',['scripts/migrate.ts','up'],{env});
  expect((await db.query('SELECT count(*)::int n FROM schema_migration')).rows[0].n).toBe(countBefore+1+laterCount);
  const seed=(await db.query(`SELECT code,image_path,version,updated_by FROM catalog_product
    WHERE source_kind='legacy_preview' ORDER BY code`)).rows;
  expect(seed).toHaveLength(3);
  expect(seed.every(row=>row.image_path===null&&row.version===2&&row.updated_by==='migration:retire-unapproved-images')).toBe(true);
  expect((await db.query("SELECT image_path,version,updated_by FROM catalog_product WHERE code='synthetic-approved'")).rows[0])
    .toEqual({image_path:approved,version:1,updated_by:'synthetic'});
  await expect(db.query(`INSERT INTO catalog_product(code,name,image_path,created_by,updated_by)
    VALUES('synthetic-forbidden','Synthetic retired image',$1,'synthetic','synthetic')`,[retired]))
    .rejects.toThrow(/catalog_product_image_path_check/);
  await db.query(`INSERT INTO catalog_product(code,name,image_path,created_by,updated_by)
    VALUES('synthetic-placeholder','Synthetic placeholder',$1,'synthetic','synthetic')`,
    ['/assets/icons/spray-bottle-plum.svg']);
  for(let n=0;n<laterCount;n++)await exec('./node_modules/.bin/tsx',['scripts/migrate.ts','down'],{env});
  await expect(exec('./node_modules/.bin/tsx',['scripts/migrate.ts','down'],{env})).rejects.toMatchObject({
    stderr:expect.stringContaining('CATALOG_IMAGE_RETIREMENT_ROLLBACK_REQUIRES_DATA_PRESERVATION')
  });
  expect((await db.query('SELECT count(*)::int n FROM schema_migration')).rows[0].n).toBe(countBefore+1);
  await db.query("DELETE FROM catalog_product WHERE code='synthetic-placeholder'");
  await exec('./node_modules/.bin/tsx',['scripts/migrate.ts','down'],{env});
  expect((await db.query("SELECT image_path,version FROM catalog_product WHERE code='care-serum-30'")).rows[0])
    .toEqual({image_path:null,version:1});
  expect((await db.query("SELECT image_path,version FROM catalog_product WHERE code='synthetic-approved'")).rows[0])
    .toEqual({image_path:approved,version:1});

  // A retry after the safe down has zero matching retired references.
  await exec('./node_modules/.bin/tsx',['scripts/migrate.ts','up'],{env});
  expect((await db.query("SELECT image_path,version FROM catalog_product WHERE code='care-serum-30'")).rows[0])
    .toEqual({image_path:null,version:1});
  expect((await db.query('SELECT count(*)::int n FROM schema_migration')).rows[0].n).toBe(countBefore+1+laterCount);
},90_000);
