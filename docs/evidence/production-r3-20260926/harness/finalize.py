"""Collect redacted receipts and remove only this run's disposable isolation."""
import pathlib, subprocess, json, hashlib, os, pwd, shutil, socket, datetime
B=pathlib.Path('/opt/cisme/rehearsals/r3-20260926-1100')
OLD=pathlib.Path('/opt/cisme/rehearsals/r3-20260926-1050')
def cmd(args): return subprocess.check_output(args,text=True).strip()
def live():
 return {'current':str(pathlib.Path('/opt/cisme/current').resolve()),'api':cmd(['systemctl','is-active','cisme-api']), 'worker':cmd(['systemctl','is-active','cisme-worker']), 'migrationCount':int(cmd(['/usr/sbin/runuser','-u','postgres','--','psql','-X','-At','-d','cisme','-c','SELECT count(*) FROM schema_migration'])), 'pendingOutbox':int(cmd(['/usr/sbin/runuser','-u','postgres','--','psql','-X','-At','-d','cisme','-c','SELECT count(*) FROM outbox_event WHERE processed_at IS NULL']))}
facts={'observedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mainArtifact':False,'productionDeployed':False,'beforeCleanup':live()}
for name in ['final-runtime-result.json','partial-resume-result.json']:
 facts[name]=json.loads((B/name).read_text());assert facts[name]['ok'] is True
values={}
for line in pathlib.Path('/opt/cisme/runtime.env').read_text().splitlines():
 if '=' in line and line.split('=',1)[0].replace('_','').isalnum():
  k,v=line.split('=',1);values[k]=v.strip().strip('"').strip("'")
keys=['COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED','COMMERCE_FORMAL_COMMERCE_AUTHORIZATION_FILE','COMMERCE_FORMAL_RECOVERY_AUTHORIZATION_FILE','COMMERCE_FORMAL_MERCHANT_ID','COMMERCE_FORMAL_MERCHANT_SERIAL','COMMERCE_FORMAL_MERCHANT_PRIVATE_KEY_FILE','COMMERCE_FORMAL_MERCHANT_CERTIFICATE_FILE','COMMERCE_FORMAL_API_V3_KEY_FILE','COMMERCE_FORMAL_PLATFORM_TRUST_FILE','COMMERCE_FORMAL_PAYMENT_NOTIFY_URL','COMMERCE_FORMAL_REFUND_NOTIFY_URL','COMMERCE_FULFILLMENT_MERCHANT_ID','COMMERCE_FULFILLMENT_AUTHORIZATION_FILE','WECHAT_MESSAGE_TOKEN','WECHAT_MESSAGE_AES_KEY','UGC_SCAN_BASE_URL','UGC_LEGAL_APPROVAL_ID']
facts['openingDependencyPresence']={k:{'configured':bool(values.get(k)),**({'fileExists':pathlib.Path(values[k]).is_file()} if k.endswith('_FILE') and values.get(k) else {})} for k in keys}
facts['openingDependencyPresence']['COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED']['enabled']=values.get('COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED','').lower()=='true'
backup=B/'r3-20260926-1135z.bin';digest='dacaec8ca8a4045b037550cecccf5c659ac6267b42d2fe974fb87ea0ed976219'
assert hashlib.sha256(backup.read_bytes()).hexdigest()==digest
dest=pathlib.Path('/opt/cisme/backups/r3-20260926-1135z.bin')
if dest.exists(): assert hashlib.sha256(dest.read_bytes()).hexdigest()==digest
else: shutil.copyfile(backup,dest)
u=pwd.getpwnam('cisme');os.chown(dest,u.pw_uid,u.pw_gid);os.chmod(dest,0o600)
facts['privacyCanaryBackup']={'path':str(dest),'sha256':digest,'mode':'0600','originalAndRestoredObjectsRetained':True}
evidence=pathlib.Path('/opt/cisme/rehearsal-evidence/r3-20260926');evidence.mkdir(parents=True,mode=0o700,exist_ok=True);os.chmod(evidence,0o700)
for name in ['logs','harness']:
 shutil.copytree(B/name,evidence/name,dirs_exist_ok=True)
for file in B.glob('*result.json'): shutil.copyfile(file,evidence/file.name)
for label in ['candidate','final-candidate']:
 shutil.copyfile(B/label/'release-manifest.json',evidence/(label+'-manifest.json'))
active=cmd(['systemctl','list-units','cisme-r3-*','--state=active','--no-legend','--plain'])
assert not active, 'OWNED_UNIT_STILL_ACTIVE'
cmd(['/usr/sbin/runuser','-u','cisme','--','/usr/lib/postgresql/16/bin/pg_ctl','-D',str(B/'pgdata'),'-m','fast','-w','stop'])
ports={}
for port in range(31956,31962):
 with socket.socket() as s:s.settimeout(1);ports[str(port)]=s.connect_ex(('127.0.0.1',port))==0
assert not any(ports.values()),'ISOLATED_PORT_STILL_LISTENING'
for process in pathlib.Path('/proc').glob('[0-9]*/cmdline'):
 if int(process.parent.name)==os.getpid():continue
 try: text=process.read_bytes().replace(b'\0',b' ').decode(errors='replace')
 except (FileNotFoundError,PermissionError):continue
 assert str(B) not in text and str(OLD) not in text,'ISOLATED_PROCESS_STILL_RUNNING'
for target in [B,OLD]:
 assert target.parent==pathlib.Path('/opt/cisme/rehearsals') and not target.is_symlink()
 if target.exists():shutil.rmtree(target)
facts['cleanup']={'removedDisposableDirectories':[str(B),str(OLD)],'isolatedPortsListening':ports,'activeOwnedUnits':[],'privateEvidenceDirectory':str(evidence),'productionBackupRemoved':False,'cosObjectsDeleted':False}
facts['afterCleanup']=live();assert facts['beforeCleanup']==facts['afterCleanup']
out=pathlib.Path('/home/ubuntu/cisme-r3-final-receipts.json');out.write_text(json.dumps(facts,indent=2)+'\n');ubuntu=pwd.getpwnam('ubuntu');os.chown(out,ubuntu.pw_uid,ubuntu.pw_gid);os.chmod(out,0o600)
shutil.copyfile(out,evidence/'final-receipts.json');os.chmod(evidence/'final-receipts.json',0o600)
print(json.dumps({'ok':True,'receipt':str(out),'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'production':facts['afterCleanup'],'isolatedPortsListening':ports}))
