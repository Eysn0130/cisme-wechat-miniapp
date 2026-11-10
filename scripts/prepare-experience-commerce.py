"""Prepare the authorised experience merchant profile on the existing server.
Does not restart services, modify production configuration, or issue a transaction.
Never prints configuration values or credentials.
"""
from pathlib import Path
import os, json, pwd, shutil, hashlib, datetime

if os.geteuid() != 0:
    raise SystemExit('ROOT_OPERATOR_REQUIRED')
production=Path('/opt/cisme/runtime.env')
experience=Path('/opt/cisme-trial/runtime.env')
operation=Path('/opt/cisme-trial/operations/commerce-closure-20261110')
secrets=operation/'merchant'
operator=pwd.getpwnam('cisme-trial')
def env(path):
    values={}
    for line in path.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key,value=line.split('=',1);values[key.strip()]=value.strip().strip('"').strip("'")
    return values
source,current=env(production),env(experience)
if source.get('APP_ENV')!='production' or current.get('APP_ENV')!='staging' or source.get('WECHAT_APP_ID')!='wx4eac2d4fb11d299b' or current.get('WECHAT_APP_ID')!=source.get('WECHAT_APP_ID'):
    raise SystemExit('EXPERIENCE_CONFIG_TARGET_MISMATCH')
isolated_keys=['APP_SESSION_SECRET','UPLOAD_TOKEN_SECRET','CONTACT_ENCRYPTION_KEY','CONTACT_HASH_KEY']
if any(not current.get(k) or current[k]==source.get(k) for k in isolated_keys):
    raise SystemExit('EXPERIENCE_MEMBER_ENCRYPTION_AND_SESSION_ISOLATION_REQUIRED')
def protected(path):
    p=Path(path);stat=p.lstat()
    if not p.is_file() or p.is_symlink() or stat.st_size>65536 or stat.st_mode&0o077:
        raise SystemExit('MERCHANT_SOURCE_PROTECTION_INVALID')
    return p.read_bytes()
grant=json.loads(protected(source['COMMERCE_FORMAL_COMMERCE_AUTHORIZATION_FILE']))
expires=grant['expiresAt']
if datetime.datetime.fromisoformat(expires.replace('Z','+00:00'))<=datetime.datetime.now(datetime.timezone.utc):
    raise SystemExit('MERCHANT_SOURCE_GRANT_EXPIRED')
operation.mkdir(parents=True,exist_ok=True,mode=0o700)
os.chmod(operation,0o700);os.chown(operation,operator.pw_uid,operator.pw_gid)
secrets.mkdir(exist_ok=True,mode=0o700);os.chown(secrets,operator.pw_uid,operator.pw_gid)
backup=operation/'runtime-before.env'
if not backup.exists():shutil.copy2(experience,backup);os.chmod(backup,0o600);os.chown(backup,0,0)
def put(path,data):
    if path.exists() and path.read_bytes()!=data:raise SystemExit('PREPARED_PROFILE_IMMUTABLE_CONFLICT')
    if not path.exists():
        with path.open('xb') as f:f.write(data)
    os.chmod(path,0o600);os.chown(path,operator.pw_uid,operator.pw_gid)
def copy(key,name):
    path=secrets/name;put(path,protected(source[key]));return str(path)
updates={
    'COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED':'true','COMMERCE_ORDER_FLOW_ENABLED':'true','COMMERCE_FULFILLMENT_ENABLED':'true',
    'COMMERCE_FORMAL_MERCHANT_ID':source['COMMERCE_FORMAL_MERCHANT_ID'],
    'COMMERCE_FORMAL_MERCHANT_SERIAL':source['COMMERCE_FORMAL_MERCHANT_SERIAL'],
    'COMMERCE_FORMAL_MERCHANT_PRIVATE_KEY_FILE':copy('COMMERCE_FORMAL_MERCHANT_PRIVATE_KEY_FILE','merchant-private.pem'),
    'COMMERCE_FORMAL_MERCHANT_CERTIFICATE_FILE':copy('COMMERCE_FORMAL_MERCHANT_CERTIFICATE_FILE','merchant-certificate.pem'),
    'COMMERCE_FORMAL_API_V3_KEY_FILE':copy('COMMERCE_FORMAL_API_V3_KEY_FILE','provider-api-v3.key'),
    'COMMERCE_FORMAL_PAYMENT_NOTIFY_URL':'https://staging-api.cisme.cn/v1/payments/wechat/callback',
    'COMMERCE_FORMAL_REFUND_NOTIFY_URL':'https://staging-api.cisme.cn/v1/payments/wechat/refund-callback',
    'COMMERCE_FULFILLMENT_MERCHANT_ID':source['COMMERCE_FORMAL_MERCHANT_ID']
}
trust=json.loads(protected(source['COMMERCE_FORMAL_PLATFORM_TRUST_FILE']))
for index,key in enumerate(trust['keys']):
    path=secrets/f'platform-key-{index}.pem';put(path,protected(key['publicKeyFile']));key['publicKeyFile']=str(path)
trust_path=secrets/'platform-trust.json';put(trust_path,(json.dumps(trust,ensure_ascii=False,indent=2)+'\n').encode());updates['COMMERCE_FORMAL_PLATFORM_TRUST_FILE']=str(trust_path)
common={'schemaVersion':1,'environment':'staging','appId':current['WECHAT_APP_ID'],'merchantId':source['COMMERCE_FORMAL_MERCHANT_ID'],
    'dataScope':'owner-authorized-experience-commerce','databaseName':'cisme_trial','approvalReference':'OWNER-COMMERCE-CLOSURE-20261110','expiresAt':expires}
profiles=[('COMMERCE_FORMAL_COMMERCE_AUTHORIZATION_FILE','commands.json','ordinary-merchant-commerce-commands',['order.create','payment.prepare','payment.close','refund.request']),
    ('COMMERCE_FORMAL_RECOVERY_AUTHORIZATION_FILE','recovery.json','ordinary-merchant-recovery-only',['payment.query','refund.query','bill.read','payment.callback','refund.callback']),
    ('COMMERCE_FULFILLMENT_AUTHORIZATION_FILE','shipping.json','wechat-shipping-sync',['shipping.query','shipping.upload','logistics.accounts.read','logistics.tracking.read'])]
for key,name,mode,capabilities in profiles:
    path=secrets/name;put(path,(json.dumps({**common,'mode':mode,'capabilities':capabilities},indent=2)+'\n').encode());updates[key]=str(path)
lines=[];seen=set()
for line in experience.read_text().splitlines():
    key=line.split('=',1)[0].strip() if '=' in line and not line.lstrip().startswith('#') else ''
    if key in updates:lines.append(key+'='+updates[key]);seen.add(key)
    else:lines.append(line)
lines.extend(k+'='+v for k,v in updates.items() if k not in seen)
next_env=operation/'runtime-next.env';put(next_env,('\n'.join(lines)+'\n').encode())
report={'prepared':True,'activated':False,'environment':'staging','database':'cisme_trial','approvalReference':common['approvalReference'],
    'memberSessionAndEncryptionKeysPreserved':True,'memberSessionAndEncryptionKeysDistinctFromProduction':True,
    'productionConfigurationUnchanged':True,'providerCredentials':'Existing canonical WeChat merchant account; private files copied under the experience service identity. These are provider credentials, not member-data encryption keys.',
    'callbackOrigin':'https://staging-api.cisme.cn','expiresAt':expires,'nextEnvironmentFile':str(next_env),
    'backupEnvironmentFile':str(backup),'transactionIssued':False}
put(operation/'prepared.json',(json.dumps(report,indent=2)+'\n').encode())
print(json.dumps(report))
