"""Prepare private installation inputs; never replace live configuration or units."""
import pathlib,os,secrets,json,hashlib,subprocess,stat
b=pathlib.Path('/opt/cisme/rehearsals/r3-20260926-1100')
live=pathlib.Path('/opt/cisme/runtime.env').read_text()
values={}
for line in live.splitlines():
 if '=' in line and line.split('=',1)[0].replace('_','').isalnum():
  key,value=line.split('=',1);values[key]=value.strip().strip('"').strip("'")
assert values['S3_BUCKET']=='lhcos-81ddf-1257392443'
target=pathlib.Path('/opt/cisme/prepared/r3-20260926');target.mkdir(parents=True,mode=0o700,exist_ok=True)
assert target.stat().st_uid==0 and stat.S_IMODE(target.stat().st_mode)==0o700
candidate=target/'runtime.production.closed.env'
changes={'APP_ENV':'production','ALLOW_DEV_ADAPTERS':'false','COMMERCE_ORDER_FLOW_ENABLED':'false',
 'COMMERCE_FULFILLMENT_ENABLED':'false','CISME_MIGRATION_READ_ONLY':'true','RUN_BACKGROUND_WORKER':'false',
 'COS_BUCKET_PRODUCT':'lighthouse','COS_READINESS_OBJECT_KEY':'submissions/00000000-0000-4000-8000-000000000026/probe/r3-20260926-1035z-original.txt',
 'COS_READINESS_OBJECT_SHA256':'25f62e1c96e45bb05478d2ee960b21b28dbd8fb834d7ddb1bb3580f6bbd86f07',
 'PRIVACY_SUPPRESSION_BUCKET':'cisme-privacy-1257392443','PRIVACY_SUPPRESSION_DIR':'/var/lib/cisme/privacy-suppression',
 'UGC_SCAN_WORKER_MODE':'standalone'}
initialized=not bool(values.get('PRIVACY_FORMAL_EXPORT_KEY'))
if initialized:
 if candidate.exists():
  existing=dict(line.split('=',1) for line in candidate.read_text().splitlines() if '=' in line)
  key=existing['PRIVACY_FORMAL_EXPORT_KEY'];assert len(key)==64 and all(c in '0123456789abcdef' for c in key)
 else:key=secrets.token_hex(32)
 changes['PRIVACY_FORMAL_EXPORT_KEY']=key
lines=[line for line in live.splitlines() if line.split('=',1)[0] not in changes]
data='\n'.join(lines+[f'{k}={v}' for k,v in changes.items()])+'\n'
if candidate.exists():assert candidate.read_text()==data
else:
 fd=os.open(candidate,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:f.write(data)
dropin=target/'privacy-write-path.conf';dropin.write_text('[Service]\nReadWritePaths=/var/lib/cisme/privacy-suppression\n');os.chmod(dropin,0o600)
directory=pathlib.Path('/var/lib/cisme/privacy-suppression')
directory_state={'exists':directory.exists()}
if directory.exists():
 s=directory.lstat();directory_state.update({'uid':s.st_uid,'gid':s.st_gid,'mode':oct(stat.S_IMODE(s.st_mode)),'symlink':directory.is_symlink()})
units={unit:subprocess.check_output(['systemctl','show',unit,'-p','User','-p','ReadWritePaths','-p','ProtectSystem','-p','ActiveState'],text=True).strip() for unit in ['cisme-api.service','cisme-worker.service']}
facts={'liveConfigChanged':False,'preparedConfig':str(candidate),'ownerUid':candidate.stat().st_uid,'mode':oct(stat.S_IMODE(candidate.stat().st_mode)),
 'formalExportKeyInitializedInPrivateCandidateOnly':initialized,'existingSecretsPreserved':True,
 'nonSecretChanges':{k:v for k,v in changes.items() if k!='PRIVACY_FORMAL_EXPORT_KEY'},'suppressionDirectory':directory_state,'serviceState':units,
 'pendingInstallation':['create/validate private suppression directory','install reviewed systemd write-path drop-ins and daemon-reload','fresh DB/object protection point','main-bound release and current switch'],
 'openingDependenciesPresent':{k:bool(values.get(k)) for k in ['WECHAT_MESSAGE_TOKEN','WECHAT_MESSAGE_AES_KEY','UGC_SCAN_BASE_URL','UGC_LEGAL_APPROVAL_ID','COMMERCE_FORMAL_AUTHORIZATION_FILE','COMMERCE_RECOVERY_AUTHORIZATION_FILE','COMMERCE_FULFILLMENT_AUTHORIZATION_FILE']}}
(b/'prepared-config-result.json').write_text(json.dumps(facts,indent=2)+'\n');os.chmod(b/'prepared-config-result.json',0o600)
print(json.dumps(facts))
