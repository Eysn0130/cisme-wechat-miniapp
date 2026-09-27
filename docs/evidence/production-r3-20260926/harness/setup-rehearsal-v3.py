#!/usr/bin/env python3
"""R3 non-main runtime rehearsal; never connects to or changes the live DB."""
import hashlib, json, os, pathlib, pwd, secrets, shutil, socket, subprocess

BASE = pathlib.Path('/opt/cisme/rehearsals/r3-20260926-1100')
ARCHIVE = pathlib.Path('/home/ubuntu/cisme-r3-d3b9a3c85718-linux-x64-clean.tar.gz')
BACKUP = pathlib.Path('/var/backups/cisme/cisme-20260925T191941Z.dump')
NODE = '/opt/node-v24.14.0-linux-x64/bin/node'
PG = '/usr/lib/postgresql/16/bin/'
PORT = 31956
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def run(args, *, data=None, env=None, user=False, log=None):
    command = (['/usr/sbin/runuser','-u','cisme','--'] if user else []) + args
    result = subprocess.run(command,input=data,text=True,capture_output=True,env=env)
    if log: (BASE/log).write_text(result.stdout+result.stderr)
    if result.returncode: raise RuntimeError('STEP_FAILED:'+args[0]+':'+str(result.returncode))
    return result.stdout.strip()
def sql(statement, database='postgres'):
    return run([PG+'psql','-X','-v','ON_ERROR_STOP=1','-h',str(BASE/'socket'),'-p',str(PORT),'-d',database,'-At'],data=statement,user=True)
assert os.geteuid()==0, 'ROOT_SETUP_REQUIRED'
assert digest(ARCHIVE)=='22aa66ddd08f07541abe4d568fd26c86d832d30cfb700b23f696edc5fe38c3cf', 'ARCHIVE_MISMATCH'
assert digest(BACKUP)=='e2f8bdb66c79d9d0f1072a9d5c71c0f6f3b7e3f20afaaa64dc3740b82fbaacca', 'BACKUP_MISMATCH'
if BASE.exists():
    assert not (BASE/'pgdata').exists() and not list((BASE/'candidate').iterdir()), 'ONLY_EMPTY_EXTRACTION_RETRY_ALLOWED'
with socket.socket() as probe: probe.bind(('127.0.0.1',PORT))
account=pwd.getpwnam('cisme')
BASE.mkdir(parents=True,mode=0o700,exist_ok=True)
os.chown(BASE,account.pw_uid,account.pw_gid)
for name in ['candidate','socket','suppression','logs']:
    path=BASE/name;path.mkdir(mode=0o700,exist_ok=True);os.chown(path,account.pw_uid,account.pw_gid)
shutil.copyfile(ARCHIVE,BASE/'input.tar.gz');os.chmod(BASE/'input.tar.gz',0o600);os.chown(BASE/'input.tar.gz',account.pw_uid,account.pw_gid)
run(['tar','-xzf',str(BASE/'input.tar.gz'),'-C',str(BASE/'candidate'),'--strip-components=1','--no-same-owner'],user=True,log='logs/extract.log')
manifest=json.loads((BASE/'candidate/release-manifest.json').read_text())
assert manifest['sourceHead']=='d3b9a3c85718a0378db8144e19584487c469a18a'
assert manifest['sourceTree']=='494b890c9fba470a211fb51fbb804f935efc50c9'
verified=json.loads(run([NODE,str(BASE/'candidate/migrate.mjs'),'verify'],user=True,log='logs/verify.log'))
run([PG+'initdb','-D',str(BASE/'pgdata'),'--username=cisme','--auth-local=peer','--auth-host=scram-sha-256','--no-instructions'],user=True,log='logs/initdb.log')
run([PG+'pg_ctl','-D',str(BASE/'pgdata'),'-l',str(BASE/'postgres.log'),'-o',f'-h 127.0.0.1 -p {PORT} -k {BASE}/socket','-w','start'],user=True,log='logs/pg-start.log')
password=secrets.token_hex(32)
sql(f"CREATE ROLE r3_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD '{password}';\nCREATE DATABASE cisme_r3_original OWNER r3_runtime TEMPLATE template0;\n")
shutil.copyfile(BACKUP,BASE/'source.dump');os.chmod(BASE/'source.dump',0o600);os.chown(BASE/'source.dump',account.pw_uid,account.pw_gid)
run([PG+'pg_restore','--exit-on-error','--single-transaction','--no-owner','--no-acl','--role=r3_runtime','-h',str(BASE/'socket'),'-p',str(PORT),'-d','cisme_r3_original',str(BASE/'source.dump')],user=True,log='logs/restore.log')
original=sql("SELECT json_build_object('migrations',(SELECT count(*) FROM schema_migration),'members',(SELECT count(*) FROM member),'outboxPending',(SELECT count(*) FROM outbox_event WHERE processed_at IS NULL));",'cisme_r3_original')
sql("ALTER DATABASE cisme_r3_original SET default_transaction_read_only=on;\nCREATE DATABASE cisme_r3_runtime OWNER r3_runtime TEMPLATE cisme_r3_original;\nALTER DATABASE cisme_r3_runtime SET default_transaction_read_only=off;\n")
env={'PATH':'/opt/node-v24.14.0-linux-x64/bin:/usr/bin:/bin','APP_ENV':'test','DATABASE_URL':f'postgresql://r3_runtime:{password}@127.0.0.1:{PORT}/cisme_r3_runtime','APP_SESSION_SECRET':secrets.token_hex(32),'UPLOAD_TOKEN_SECRET':secrets.token_hex(32),'OBJECT_STORAGE_DRIVER':'api_gateway','RUN_BACKGROUND_WORKER':'false','CISME_MIGRATION_READ_ONLY':'false','API_LISTEN_HOST':'127.0.0.1','PORT':'31957','LOG_LEVEL':'warn','PRIVACY_SUPPRESSION_DIR':str(BASE/'suppression'),'CONTACT_ENCRYPTION_KEY':secrets.token_hex(32),'CONTACT_HASH_KEY':secrets.token_hex(32),'CONTACT_KEY_VERSION':'r3-synthetic-v1','COMMERCE_ORDER_FLOW_ENABLED':'true','ALLOW_DEV_ADAPTERS':'true','CISME_MIGRATION_APPROVAL_REF':'user-r3-isolated-20260926','CISME_PREDEPLOY_BACKUP_REF':'r2-verified-backup-e2f8bdb66c79'}
(BASE/'runtime.json').write_text(json.dumps(env));os.chmod(BASE/'runtime.json',0o600);os.chown(BASE/'runtime.json',account.pw_uid,account.pw_gid)
run([NODE,str(BASE/'candidate/migrate.mjs'),'up'],env=env,user=True,log='logs/migrate.log')
runtime=sql("SELECT json_build_object('migrations',(SELECT count(*) FROM schema_migration),'members',(SELECT count(*) FROM member),'identityPending',(SELECT count(*) FROM outbox_event WHERE event_type='identity.accepted.v1' AND processed_at IS NULL));",'cisme_r3_runtime')
summary={'runId':BASE.name,'sourceHead':manifest['sourceHead'],'sourceTree':manifest['sourceTree'],'archiveSha256':digest(ARCHIVE),'backupSha256':digest(BACKUP),'manifestVerify':verified,'original':json.loads(original),'runtime':json.loads(runtime),'port':PORT,'databaseRole':'r3_runtime','roleProperties':{'superuser':False,'createdb':False,'createrole':False,'inherit':True},'target':'isolated-postgres-cluster','productionDatabaseTouched':False,'mainArtifact':False}
(BASE/'setup-result.json').write_text(json.dumps(summary,indent=2)+'\n');os.chmod(BASE/'setup-result.json',0o600)
print(json.dumps(summary))
