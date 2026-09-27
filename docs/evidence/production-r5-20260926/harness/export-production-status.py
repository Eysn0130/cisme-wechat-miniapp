"""Read-only runtime/private-input binding and explicitly sanitized evidence export."""
import importlib.util,json,os,pwd,subprocess,hashlib
from pathlib import Path
from datetime import datetime,timezone
base=Path('/opt/cisme/prepared/r5-20260926')
spec=importlib.util.spec_from_file_location('r5_release',Path(__file__).parent/'production-release.py')
release=importlib.util.module_from_spec(spec);spec.loader.exec_module(release)
identity=release.observe.identity()
live=release.observe.protected_environment('/opt/cisme/runtime.env')
config=release.observe.protected_environment(base/'runtime.production.closed.authorized.env')
previous=release.observe.protected_environment('/opt/cisme/prepared/r3-20260926/runtime.production.closed.env')
inputs=release.private_inputs(config)
for item in inputs:subprocess.run(['runuser','-u','cisme','--','/usr/bin/test','-r',item['path']],check=True)
os.umask(0o077)
binding={'privateInputs':inputs,'candidateEnvironmentSha256':release.sha((base/'runtime.production.closed.authorized.env').read_bytes()),'observedAtUtc':datetime.now(timezone.utc).isoformat()}
fd=os.open(base/'installer-private-input-binding.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:json.dump(binding,f)
sql="BEGIN READ ONLY; SELECT json_build_object('migrations',(SELECT count(*) FROM schema_migration),'pendingIdentityEvents',(SELECT count(*) FROM outbox_event WHERE event_type='identity.accepted.v1' AND processed_at IS NULL)); COMMIT;"
facts=json.loads(subprocess.check_output(['runuser','-u','postgres','--','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-d','cisme','-c',sql],text=True))
current=Path('/opt/cisme/current').resolve()
units={unit:subprocess.check_output(['systemctl','show',unit,'--property=ActiveState,User,Group,MainPID,ExecStart'],text=True).splitlines() for unit in ['cisme-api','cisme-worker']}
paylines=[json.loads(line) for line in (base/'payment-readonly-result.json').read_text().splitlines() if line.startswith('{')]
pay=[line for line in paylines if 'signedNotFoundVerified' in line][0]
prepared=json.loads((base/'authorized-preparation-result.json').read_text())
protected_keys=('DATABASE_URL','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','S3_BUCKET','S3_ENDPOINT','S3_REGION','CONTACT_ENCRYPTION_KEY','CONTACT_HASH_KEY','CONTACT_KEY_VERSION','PRIVACY_FORMAL_EXPORT_KEY')
report={'schemaVersion':1,'observedAtUtc':datetime.now(timezone.utc).isoformat(),'identity':identity,'current':str(current),'liveAppEnv':live['APP_ENV'],'units':units,'database':facts,
 'runtimeFileSha256':{name:hashlib.sha256((current/name).read_bytes()).hexdigest() for name in ['index.js','worker.js']},
 'prepared':prepared,'paymentReadOnly':pay,'privateRuntimeInputCount':len(inputs),'privateInputsReadableAsCisme':True,
 'preparedPreservesR3ExistingValues':{key:config.get(key)==previous.get(key) for key in protected_keys},
 'deployed':False,'mainArtifactInstalled':False,'mainVersion':None,'firewallChanged':False,'syntheticOrderCreated':False,'fundsWrites':0}
out=Path('/home/ubuntu/cisme-r5-private-incoming/r5-public-production-status.json')
fd=os.open(out,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:json.dump(report,f,indent=2)
owner=pwd.getpwnam('ubuntu');os.chown(out,owner.pw_uid,owner.pw_gid)
print(json.dumps({'export':str(out),'migrations':facts['migrations'],'pendingIdentityEvents':facts['pendingIdentityEvents'],'privateRuntimeInputCount':len(inputs),'privateInputsReadableAsCisme':True,'preparedExistingValuesPreserved':all(report['preparedPreservesR3ExistingValues'].values()),'paymentReadOnlyVerified':pay['signedNotFoundVerified'],'productionDeployed':False}))
