#!/usr/bin/env python3
"""Actual candidate migration runner against a fresh synthetic PG16 baseline.
Never connects to cisme, cisme_test, the active staging DB, or production.
"""
import hashlib, importlib.util, json, os, pathlib, re, socket, subprocess, sys, urllib.parse
ROOT=pathlib.Path('/opt/cisme')
SOURCE='f346736d379e9d8b177426f17ffb58a4e4e32cca'
def require(ok,code):
    if not ok: raise RuntimeError(code)
def command(args,env=None,data=None,success=True):
    r=subprocess.run(args,env=env,input=data,text=True,capture_output=True,timeout=120)
    require((r.returncode==0)==success,'BASELINE_COMMAND_FAILED')
    return r.stdout
def main(run):
    require(os.geteuid()==0 and socket.gethostname()=='VM-4-15-ubuntu' and re.fullmatch(r'rc20260922-[a-f0-9]{8}',run),'STAGING_OWNED_TARGET_REQUIRED')
    state=ROOT/'staging-acceptance'/run
    owned=json.loads((state/'ownership.json').read_text())
    release=ROOT/'releases'/(run+'-'+SOURCE[:12]);manifest=json.loads((release/'release-manifest.json').read_text())
    require(owned['directory']==str(release) and owned['sourceHead']==SOURCE and owned['instanceId']=='lhins-ei4hz4fi' and manifest['sourceHead']==SOURCE,'CANDIDATE_IDENTITY_REQUIRED')
    base=pathlib.Path('/home/ubuntu/staging-candidate.py')
    require(hashlib.sha256(base.read_bytes()).hexdigest()=='bcecc4c0ef31e2c36a149e46030be3264bf8ec556de168fb83e218f6eb8d9741','BASE_SCRIPT_DRIFT')
    spec=importlib.util.spec_from_file_location('base',base);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    config=m.parse_env((state/'candidate.env').read_text());m.assert_candidate(config,owned['database'])
    database=owned['database']+'_baseline'
    require(re.fullmatch(r'cisme_accept_rc20260922_[a-f0-9]{8}_baseline',database),'SYNTHETIC_DATABASE_REQUIRED')
    os.umask(0o077)
    with (state/'baseline-started.json').open('x') as f:json.dump({'database':database,'syntheticOnly':True,'sourceHead':SOURCE},f)
    command(['runuser','-u','postgres','--','createdb','--owner=cisme_staging',database])
    url=urllib.parse.urlsplit(config['DATABASE_URL'])._replace(path='/'+database)
    env={**os.environ,**config,'DATABASE_URL':url.geturl(),'PGHOST':'127.0.0.1','PGPORT':'5432','PGUSER':'cisme_staging','PGPASSWORD':urllib.parse.unquote(url.password or ''),'PGDATABASE':database,'PGCONNECT_TIMEOUT':'4',
         'CISME_MIGRATION_APPROVAL_REF':'user-owned-synthetic-baseline-20260922','CISME_PREDEPLOY_BACKUP_REF':'synthetic-new-empty:'+database}
    def sql(text):return command(['psql','-X','-v','ON_ERROR_STOP=1','-At'],env=env,data=text).strip()
    require(json.loads(command(['node',str(release/'migrate.mjs'),'verify'],env=env))['verified'],'ARTIFACT_UNVERIFIED')
    baseline=[n for n in manifest['migrations'] if n<='202609090006_member_identity_display.sql'];require(len(baseline)==23,'BASELINE_COUNT_MISMATCH')
    sql('CREATE TABLE schema_migration(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());')
    for name in baseline:
        content=(release/'db/migrations'/name).read_text();require(hashlib.sha256(content.encode()).hexdigest()==manifest['hashes']['db/migrations/'+name],'BASELINE_SQL_HASH_DRIFT')
        sql(content.split('-- migrate:down')[0]);sql("INSERT INTO schema_migration(version) VALUES('"+name+"');")
    member=sql("INSERT INTO member(display_name) VALUES('SYNTHETIC PG16 old member') RETURNING id;").splitlines()[0]
    sql("INSERT INTO privacy_request(member_id,kind,message) VALUES('"+member+"','access','SYNTHETIC baseline request');")
    sql("INSERT INTO consent_acceptance(member_id,document_type,document_version,accepted_at,principal_id) VALUES('"+member+"','privacy','synthetic-baseline-v1',now(),'synthetic-baseline');")
    invariant="SELECT md5(jsonb_build_object('members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM member m),'consents',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM consent_acceptance c))::text);"
    before=sql(invariant)
    sql("CREATE FUNCTION reject_probe_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version='202609100001_care_record_details.sql' THEN RAISE EXCEPTION 'SYNTHETIC_JOURNAL_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_probe_journal BEFORE INSERT ON schema_migration FOR EACH ROW EXECUTE FUNCTION reject_probe_journal();")
    command(['node',str(release/'migrate.mjs'),'up'],env=env,success=False)
    require(sql("SELECT to_regclass('public.care_record_step') IS NULL;")=='t' and sql('SELECT count(*) FROM schema_migration;')=='23','MIGRATION_ATOMICITY_FAILED')
    sql('DROP TRIGGER reject_probe_journal ON schema_migration; DROP FUNCTION reject_probe_journal();')
    command(['node',str(release/'migrate.mjs'),'up'],env=env)
    require(sql('SELECT count(*) FROM schema_migration;')=='76' and sql(invariant)==before,'FORWARD_PRESERVATION_FAILED')
    require(sql("SELECT count(*) FROM privacy_request WHERE message='SYNTHETIC baseline request' AND status='received' AND version=1;")=='1','REQUEST_PRESERVATION_FAILED')
    require(not command(['node',str(release/'migrate.mjs'),'up'],env=env).strip(),'REPEATED_MIGRATION_CHANGED')
    report={'runId':run,'sourceHead':SOURCE,'database':database,'postgresVersion':sql('SHOW server_version;'),'baseline':23,'final':76,'injectedJournalFailureRolledBack':True,'syntheticMemberAndConsentDigestPreserved':True,'syntheticRequestPreserved':True,'repeatApplied':0,'productionTouched':False,'oldCismeTestImpact':'UNKNOWN / 未恢复'}
    (state/'baseline-rehearsal.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
if __name__=='__main__':
    try:
        require(len(sys.argv)==2,'RUN_ID_REQUIRED');main(sys.argv[1])
    except Exception as e:
        print(json.dumps({'ok':False,'code':str(e) if type(e) is RuntimeError else 'BASELINE_REHEARSAL_FAILED'}));sys.exit(1)
