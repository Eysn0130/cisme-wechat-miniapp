#!/usr/bin/env python3
"""DRAFT: root-reviewed trial application switch from 0d3ff, without migrations.

No default mutation. Requires a separately finalized exact-source binding and
the existing protected baseline owner/runtime guard. Never calls its business
actions, old application preflight/apply/migrate, or dependency-only permit.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import types
from urllib.parse import unquote, urlsplit

sys.dont_write_bytecode = True
ROOT = Path('/opt/cisme-trial')
BASELINE_HEAD = '0d3ff1c8d2cb6e2f53233e2cf6ca1efc62280527'
BASELINE_TREE = '53fb703b81332ca0cadccaafc3b537e7c5c7afde'
BASELINE_MANIFEST = '48ce6db4ea9108224cc20ddf2a6d1382b272f2cfade68e0615ec3a9cc153bee3'
DEPENDENCIES = 'd9f03813fc808eced42eacb92db4530a2cd0e0824cab5d1beb9c3bdf08144bdd'
SOURCE_PACKAGE = 'c70b97f3ec0e6c339c5c27b0e9067549f9256287cfbfdf32f39ae46fcf54e231'
SOURCE_LOCK = '2a14af4f1bfdd86d0108015b43df14d62b2cc6e8eedcd3831446970a26d7d32a'
OWNER_RUNNER = ROOT/'editorial-owner-runners'/BASELINE_HEAD[:12]
OWNER_SHA = '4d8d8e32db3aa892a30e1b4bfb520b22a75d22a63ade82d8998bcd58c4352890'
OWNER_BINDING_SHA = '5e1fcd52819bba02dbbcf9c034a77fb121e4bcf36aff2d8cd3a11539ccae371e'
NODE = '/opt/node-v24.14.0-linux-x64/bin/node'
CLEAN = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'}
STAGES = Path('/var/lib/cisme-dependency-stage')
APP_ID = 'wx4eac2d4fb11d299b'
OWNER = 0
D = None
A = None


class Refused(RuntimeError): pass


def need(value, code='NO_SCHEMA_UPGRADE_REFUSED'):
    if not value: raise Refused(code)


def sha(data): return hashlib.sha256(data).hexdigest()


def unique(pairs):
    value = {}
    for key, item in pairs:
        need(key not in value, 'NO_SCHEMA_DUPLICATE_JSON_KEY')
        value[key] = item
    return value


def parse(raw): return json.loads(raw, object_pairs_hook=unique)


def parents(path, private=False):
    need(path.is_absolute() and '..' not in path.parts, 'NO_SCHEMA_ABSOLUTE_PATH_REQUIRED')
    for parent in reversed(path.parents):
        st = parent.lstat()
        need(stat.S_ISDIR(st.st_mode) and st.st_uid == OWNER and not st.st_mode & 0o022,
             'NO_SCHEMA_ROOT_PROTECTED_PARENT_REQUIRED')
    if private:
        # These root-only records share the service-traversable application root.
        # Their bytes still require a single-link, root-owned 0600 file in read().
        # Every ancestor must remain root-owned and non-writable by other users.
        root_record = path.parent == ROOT and path.name in (
            'application-active-release.json', 'dependency-active-release.json')
        allowed_modes = (0o700, 0o750, 0o755) if root_record else (0o700,)
        need(stat.S_IMODE(path.parent.lstat().st_mode) in allowed_modes,
             'NO_SCHEMA_PRIVATE_PARENT_REQUIRED')


def read(path, limit=1024*1024, private=False):
    parents(path, private)
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_uid == OWNER and st.st_nlink == 1
             and not st.st_mode & (0o077 if private else 0o022) and 0 < st.st_size <= limit,
             'NO_SCHEMA_ROOT_PROTECTED_FILE_REQUIRED')
        data = bytearray()
        while chunk := os.read(fd, min(65536, limit + 1 - len(data))):
            data.extend(chunk)
            need(len(data) <= limit, 'NO_SCHEMA_FILE_TOO_LARGE')
        after = os.fstat(fd)
        need(len(data) == st.st_size and (after.st_size,after.st_mtime_ns,after.st_ctime_ns)
             == (st.st_size,st.st_mtime_ns,st.st_ctime_ns), 'NO_SCHEMA_FILE_CHANGED')
        return bytes(data)
    finally: os.close(fd)


def fixed_profile(profile):
    need(profile == {'root':'/opt/cisme-trial','user':'cisme-trial','database':'cisme_trial',
        'domain':'staging-api.cisme.cn','units':('cisme-trial-api.service','cisme-trial-worker.service'),
        'lock':'/run/lock/cisme-production-trial.lock','name':'trial'}, 'NO_SCHEMA_TRIAL_ONLY')


def binding(path, expected):
    need(re.fullmatch(r'[a-f0-9]{64}', expected or ''), 'NO_SCHEMA_FINAL_BINDING_REQUIRED')
    raw = read(path, 65536, private=True)
    need(sha(raw) == expected, 'NO_SCHEMA_BINDING_HASH_MISMATCH')
    b = parse(raw)
    need(b.get('schemaVersion') == 1 and b.get('kind') == 'trial-no-schema-application-upgrade'
         and b.get('baselineHead') == BASELINE_HEAD and b.get('baselineTree') == BASELINE_TREE,
         'NO_SCHEMA_BASELINE_BINDING_REQUIRED')
    need(all(re.fullmatch(r'[a-f0-9]{40}', b.get(k) or '') and b[k] != '0'*40 for k in ('sourceHead','sourceTree'))
         and b['sourceHead'] != BASELINE_HEAD and type(b.get('ciRunId')) is int and b['ciRunId'] > 0,
         'NO_SCHEMA_EXACT_NEW_MAIN_REQUIRED')
    need(all(re.fullmatch(r'[a-f0-9]{64}', b.get(k) or '') for k in
         ('archiveSha256','manifestSha256','stageReceiptSha256','helperSha256'))
         and type(b.get('archiveBytes')) is int and 0 < b['archiveBytes'] <= 512*1024**2,
         'NO_SCHEMA_ACTUAL_ARTIFACT_BINDING_REQUIRED')
    need(b.get('dependenciesSha256') == DEPENDENCIES and b.get('migrations') == 98,
         'NO_SCHEMA_DEPENDENCIES_AND_SCHEMA_REQUIRED')
    need(sha(read(Path(__file__), private=True)) == b['helperSha256'], 'NO_SCHEMA_EXACT_HELPER_REQUIRED')
    return b


def owner_module():
    need(os.geteuid() == OWNER, 'NO_SCHEMA_ROOT_REQUIRED')
    owner_bytes = read(OWNER_RUNNER/'trial-owner-operations.py', 128*1024, True)
    old_binding = read(OWNER_RUNNER/'binding.json', 65536, True)
    need(sha(owner_bytes) == OWNER_SHA and sha(old_binding) == OWNER_BINDING_SHA,
         'NO_SCHEMA_REVIEWED_BASELINE_GUARD_REQUIRED')
    owner = types.ModuleType('reviewed_no_schema_baseline_owner')
    owner.__file__ = str(OWNER_RUNNER/'trial-owner-operations.py')
    exec(compile(owner_bytes, owner.__file__, 'exec'), owner.__dict__)
    return owner, owner.validate_binding(parse(old_binding))


def load_baseline():
    global D, A
    owner, old_binding = owner_module()
    context = owner.runtime(old_binding)
    D, A = context['D'], context['A']
    need(A.NODE == NODE and sha(read(Path(A.__file__), private=True)) == owner.HELPER_SHA,
         'NO_SCHEMA_REVIEWED_PRIMITIVES_REQUIRED')
    fixed_profile(context['profile'])
    return context


def artifact_contract(old, candidate, b):
    before, after = old['manifest'], candidate['manifest']
    need(before.get('sourceHead') == BASELINE_HEAD and before.get('sourceTree') == BASELINE_TREE
         and old['manifestSha256'] == BASELINE_MANIFEST, 'NO_SCHEMA_0D3_BASELINE_REQUIRED')
    need(after.get('sourceHead') == b['sourceHead'] and after.get('sourceTree') == b['sourceTree']
         and candidate['manifestSha256'] == b['manifestSha256']
         and after.get('sourceLockSha256') == SOURCE_LOCK and after.get('node') == 'v24.14.0'
         and after.get('buildPlatform') == {'os':'linux','arch':'x64','libc':'glibc'}
         and all(after.get(k) is False for k in ('configurationIncluded','deployed','releaseReady')),
         'NO_SCHEMA_EXACT_LINUX_ARTIFACT_REQUIRED')
    need(old['directory'] != candidate['directory'] and after.get('migrations') == before.get('migrations')
         and len(before.get('migrations', [])) == 98, 'NO_SCHEMA_NO_SQL_DELTA_REQUIRED')
    names = ['migrate.mjs','package.json','package-lock.json'] + ['db/migrations/'+n for n in before['migrations']]
    need(all(old['files'][n] == candidate['files'][n] for n in names), 'NO_SCHEMA_SQL_OR_DEPENDENCY_BYTES_CHANGED')
    need(old['dependenciesSha256'] == candidate['dependenciesSha256'] == DEPENDENCIES,
         'NO_SCHEMA_FULL_DEPENDENCY_TREE_CHANGED')


def source_permit(b, candidate, main):
    need(main.get('sha') == b['sourceHead'] and main.get('tree') == b['sourceTree']
         and main.get('ciRunId') == b['ciRunId'], 'NO_SCHEMA_EXACT_MAIN_PUSH_CI_REQUIRED')
    package = A.github_source('package.json', b['sourceHead'])
    lock = A.github_source('package-lock.json', b['sourceHead'])
    need(sha(package) == SOURCE_PACKAGE and sha(lock) == SOURCE_LOCK, 'NO_SCHEMA_SOURCE_DEPENDENCY_INPUT_CHANGED')
    for file, source in [('migrate.mjs','scripts/release-migrate.mjs'),
       ('db/migrations/202610260001_owned_editorial.sql','db/migrations/202610260001_owned_editorial.sql')]:
        need(candidate['files'][file] == A.github_source(source, b['sourceHead']), 'NO_SCHEMA_SOURCE_FILE_MISMATCH')
    # verify is the unchanged read-only migrator verification mode; never up/down.
    value = parse(D.command([NODE,str(Path(candidate['directory'])/'migrate.mjs'),'verify']))
    need(value.get('verified') is True and value.get('sourceHead') == b['sourceHead']
         and value.get('sourceTree') == b['sourceTree'] and value.get('migrations') == 98,
         'NO_SCHEMA_COMPLETE_ARTIFACT_REQUIRED')


def stage_binding(b, candidate):
    path = Path(b.get('stageReceipt', ''))
    need(path.name == 'stage-receipt.json' and path.parent.parent == STAGES,
         'NO_SCHEMA_REVIEWED_STAGE_REQUIRED')
    raw = read(path, private=True)
    need(sha(raw) == b['stageReceiptSha256'], 'NO_SCHEMA_STAGE_RECEIPT_DRIFT')
    r = parse(raw)
    need(r.get('staged') is True and r.get('deployed') is False and r.get('instanceId') == 'lhins-61ikz4mi'
         and r.get('publicIpv4') == '124.223.74.198' and r.get('sourceHead') == b['sourceHead']
         and r.get('sourceTree') == b['sourceTree'] and r.get('archiveSha256') == b['archiveSha256']
         and r.get('archiveSize') == b['archiveBytes'] and r.get('manifestSha256') == b['manifestSha256']
         and r.get('dependenciesSha256') == DEPENDENCIES and r.get('migrations') == 98
         and r.get('privateStage') == str(path.parent) and r.get('candidateDirectories') == [candidate['directory']]
         and all(r.get(k) is False for k in ('servicesChanged','databaseChanged','configurationChanged','productionChanged','peerFilesChanged')),
         'NO_SCHEMA_STAGE_BINDING_MISMATCH')
    archive = read(path.parent/'archive.tar.gz', 512*1024**2, True)
    need(len(archive) == b['archiveBytes'] and sha(archive) == b['archiveSha256'], 'NO_SCHEMA_ARCHIVE_MISMATCH')
    return str(path)


def production_capture():
    p = {**D.PROFILES['production'],'name':'production'}
    cfg_bytes = D.read_owned(Path(p['root'])/'runtime.env', private=True)
    cfg = D.general.observe.audit.environment(cfg_bytes.decode())
    unit_bytes = {u:D.read_owned(D.unit_path(u)) for u in p['units']}
    dirs = {D.unit_entry(unit_bytes[u], e, p) for u,e in zip(p['units'],('index.js','worker.js'))}
    need(len(dirs) == 1, 'NO_SCHEMA_PRODUCTION_RELEASE_SPLIT')
    release = D.artifact(dirs.pop(), Path(p['root']))
    need(release['manifest'].get('sourceHead') == 'dbd2b88a47f622621c2b226b03339677b183fef8'
         and release['manifest'].get('sourceTree') == '7ced9ed2248a1e27a9f30f2995badab21fdddf79'
         and release['manifestSha256'] == '9dbf6789d5ab3e632929ae81e26180540786db7dbb8863354432e35772a18e00'
         and len(release['manifest']['migrations']) == 97 and release['dependenciesSha256'] == DEPENDENCIES,
         'NO_SCHEMA_PRODUCTION_BASELINE_REQUIRED')
    need(cfg.get('APP_ENV') == 'production' and D.closed_context(p,cfg)
         and cfg.get('WECHAT_PHONE_BINDING_ENABLED','false') == 'false', 'NO_SCHEMA_PRODUCTION_CONTEXT_REQUIRED')
    facts=D.database_facts(p)
    need(facts.get('database') == facts.get('owner') == 'cisme'
         and facts.get('journal') == release['manifest']['migrations'], 'NO_SCHEMA_PRODUCTION_DATABASE_REQUIRED')
    dropins={u:D.dropin_inputs(u) for u in p['units']}
    definitions={u:D.unit_definition(u,unit_bytes[u],entry,p,dropins[u])
                 for u,entry in zip(p['units'],('index.js','worker.js'))}
    return {'profile':p,'env':cfg_bytes,'config':cfg,'environmentMetadata':D.environment_metadata(p),
        'units':unit_bytes,'dropIns':dropins,'unitDefinitions':definitions,
        'privateInputs':D.private_inputs(p,cfg),'directory':release['directory'],
        'manifestBytes':D.read_owned(Path(release['directory'])/'release-manifest.json'),
        'activeBytes':D.read_owned(Path(p['root'])/'dependency-active-release.json',private=True),
        'journal':facts['journal'],'pids':D.running(p,release['directory'],cfg)}


def production_preserved(old):
    p = old['profile']; root = Path(p['root'])
    need(D.read_owned(root/'runtime.env',private=True) == old['env']
         and D.environment_metadata(p) == old['environmentMetadata']
         and D.private_inputs(p,old['config']) == old['privateInputs']
         and D.read_owned(root/'dependency-active-release.json',private=True) == old['activeBytes']
         and D.read_owned(Path(old['directory'])/'release-manifest.json') == old['manifestBytes']
         and D.running(p,old['directory'],old['config']) == old['pids'], 'NO_SCHEMA_PRODUCTION_DRIFT')
    for u,entry in zip(p['units'],('index.js','worker.js')):
        need(D.read_owned(D.unit_path(u)) == old['units'][u] and D.dropin_inputs(u) == old['dropIns'][u],
             'NO_SCHEMA_PRODUCTION_UNIT_DRIFT')
        need(D.unit_definition(u,old['units'][u],entry,p)==old['unitDefinitions'][u],
             'NO_SCHEMA_PRODUCTION_EFFECTIVE_UNIT_DRIFT')
    facts=D.database_facts(p)
    need(facts.get('database') == facts.get('owner') == 'cisme' and facts.get('journal') == old['journal'],
         'NO_SCHEMA_PRODUCTION_DATABASE_DRIFT')


def article_fence(profile):
    return D.query(profile, "SELECT json_build_object('publishedCount',count(*) FILTER(WHERE status='published'),"
        "'items',coalesce(json_agg(json_build_array(id::text,version,content_sha256,status,media) ORDER BY id),'[]'::json)) FROM editorial_article")


def six_keys(trial, production):
    keys = ('APP_SESSION_SECRET','UPLOAD_TOKEN_SECRET','CONTACT_ENCRYPTION_KEY','CONTACT_HASH_KEY','PRIVACY_FORMAL_EXPORT_KEY')
    need(all(trial.get(k) and production.get(k) and trial[k] != production[k] for k in keys),
         'NO_SCHEMA_SECRET_ISOLATION_REQUIRED')
    t,p = urlsplit(trial.get('DATABASE_URL','')),urlsplit(production.get('DATABASE_URL',''))
    need(t.hostname == p.hostname == '127.0.0.1' and (t.port or 5432) == (p.port or 5432) == 5432
         and unquote(t.username or '') == unquote(t.path.lstrip('/')) == 'cisme_trial'
         and unquote(p.username or '') == unquote(p.path.lstrip('/')) == 'cisme'
         and t.password and p.password and unquote(t.password) != unquote(p.password)
         and not any((t.query,t.fragment,p.query,p.fragment)),
         'NO_SCHEMA_DATABASE_ISOLATION_REQUIRED')


def preflight(b):
    context = load_baseline()
    profile, config = context['profile'], context['config']
    need(config.get('APP_ENV') == 'staging' and config.get('WECHAT_APP_ID') == APP_ID
         and D.closed_context(profile,config) and config.get('WECHAT_PHONE_BINDING_ENABLED','false') == 'false'
         and config.get('COS_DIRECT_UPLOAD_ENABLED','false') == 'false', 'NO_SCHEMA_CLOSED_TRIAL_REQUIRED')
    old = D.artifact(str(context['release']), ROOT)
    candidate = D.artifact(str(ROOT/'releases'/('tencent-release-'+b['sourceHead'][:12])), ROOT)
    artifact_contract(old,candidate,b)
    main = D.general.reviewed_main()
    source_permit(b,candidate,main)
    stage = stage_binding(b,candidate)
    units = {u:D.read_owned(D.unit_path(u)) for u in profile['units']}
    dropins = {u:D.dropin_inputs(u) for u in profile['units']}
    definitions = {u:D.unit_definition(u,units[u],e,profile,dropins[u]) for u,e in zip(profile['units'],('index.js','worker.js'))}
    production = production_capture()
    six_keys(config, production['config'])
    fence = article_fence(profile)
    need(fence.get('publishedCount') == 6, 'NO_SCHEMA_DEPLOY_BEFORE_NEW_BATCH_REQUIRED')
    versions = D.native_smoke(profile,candidate['directory'],True)
    need(versions == D.native_smoke(profile,old['directory'],True), 'NO_SCHEMA_NATIVE_RUNTIME_CHANGED')
    initial = {name:D.read_owned(ROOT/name,private=True) for name in ('ownership.json','empty-database.json','migration-complete.json')}
    return {'profile':profile,'main':main,'old':old,'candidate':candidate,
        'env':D.read_owned(ROOT/'runtime.env',private=True),'config':config,
        'environmentMetadata':D.environment_metadata(profile),'privateInputs':D.private_inputs(profile,config),
        'units':units,'unitDefinitions':definitions,'dropIns':dropins,
        'ownership':parse(initial['ownership.json']),'initialRecords':initial,
        'dependencyActiveBytes':read(ROOT/'dependency-active-release.json',private=True),
        'applicationActiveBytes':read(ROOT/'application-active-release.json',private=True),
        'production':production,'articleFence':fence,'stageReceipt':stage,'binding':b,'versions':versions}


def verify_active(plan, allowed=()):
    need(read(ROOT/'dependency-active-release.json',private=True) == plan['dependencyActiveBytes'],
         'NO_SCHEMA_DEPENDENCY_HISTORY_DRIFT')
    need(read(ROOT/'application-active-release.json',private=True) in (plan['applicationActiveBytes'],*allowed),
         'NO_SCHEMA_ACTIVE_RECORD_DRIFT')


def verify_context(plan, provenance=True, candidate_allowed=False, active_allowed=()):
    fixed_profile(plan['profile'])
    D.verify_context(plan,provenance=provenance,allow_candidate=candidate_allowed)
    verify_active(plan,active_allowed)
    production_preserved(plan['production'])
    six_keys(plan['config'],plan['production']['config'])
    need(sha(read(Path(plan['stageReceipt']),private=True)) == plan['binding']['stageReceiptSha256'],
         'NO_SCHEMA_STAGE_RECEIPT_DRIFT')


def journal(plan, drain=False):
    facts = D.database_facts(plan['profile'])
    need(facts.get('database') == facts.get('owner') == 'cisme_trial'
         and facts.get('journal') == plan['old']['manifest']['migrations']
         and (not drain or facts.get('otherClients') == 0), 'NO_SCHEMA_DATABASE_OR_DRAIN_DRIFT')
    need(article_fence(plan['profile']) == plan['articleFence'], 'NO_SCHEMA_EDITORIAL_BATCH_CHANGED')


# Audited snapshot primitives are appended verbatim from the pinned 2d3a source.
# They use THIS module's BASELINE_HEAD=0d3ff in AAD; no old preflight/migrate/apply
# function is included or called. All encryption keys/raw data remain root-private.



SNAPSHOT_JS = r"""
import {constants,createReadStream,createWriteStream} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {Transform} from 'node:stream';import {pipeline} from 'node:stream/promises';
const [mode,file,keyPath,aad]=process.argv.slice(1),MAX=2*1024**3;
const need=x=>{if(!x)throw Error('SNAPSHOT_INVALID')};
async function protectedFile(path,max){
 const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const st=await h.stat();
 need(st.isFile()&&st.uid===process.getuid()&&(st.mode&0o777)===0o600&&st.nlink===1&&st.size<=max&&st.size>0);
 return {h,st};
}
try{
 if(mode==='encrypt'){
  const key=randomBytes(32),iv=randomBytes(12),kh=await open(keyPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  await kh.writeFile(key);await kh.sync();await kh.close();
  const out=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  await out.write(Buffer.concat([Buffer.from('CTS1'),iv]));
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));
  const digest=createHash('sha256');let bytes=0,prefix=Buffer.alloc(0);
  const inspect=new Transform({transform(chunk,enc,cb){bytes+=chunk.length;if(bytes>MAX){cb(Error('SIZE'));return;}
   if(prefix.length<5)prefix=Buffer.concat([prefix,chunk]).subarray(0,5);digest.update(chunk);cb(null,chunk);}});
  await pipeline(process.stdin,inspect,cipher,createWriteStream(file,{fd:out.fd,autoClose:false}));
  need(bytes>5&&prefix.equals(Buffer.from('PGDMP')));await out.write(cipher.getAuthTag());await out.sync();await out.close();
  console.log(JSON.stringify({plainSha256:digest.digest('hex'),plainBytes:bytes,encrypted:true}));
 }else{
  need(mode==='verify'||mode==='decrypt');const keyFile=await protectedFile(keyPath,32);need(keyFile.st.size===32);
  const key=await keyFile.h.readFile();await keyFile.h.close();
  const {h,st}=await protectedFile(file,MAX+32);need(st.size>37);
  const header=Buffer.alloc(16),tag=Buffer.alloc(16);need((await h.read(header,0,16,0)).bytesRead===16);
  need(header.subarray(0,4).equals(Buffer.from('CTS1')));need((await h.read(tag,0,16,st.size-16)).bytesRead===16);
  const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(4));decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(tag);
  const digest=createHash('sha256');let bytes=0;
  const sink=new Transform({transform(chunk,enc,cb){digest.update(chunk);bytes+=chunk.length;cb(null,mode==='decrypt'?chunk:undefined);}});
  const output=mode==='decrypt'?process.stdout:new Transform({transform(c,e,cb){cb();}});
  await pipeline(createReadStream(file,{fd:h.fd,autoClose:false,start:16,end:st.size-17}),decipher,sink,output);
  await h.close();if(mode==='verify')console.log(JSON.stringify({plainSha256:digest.digest('hex'),plainBytes:bytes,authenticated:true}));
 }
}catch{process.stderr.write('SNAPSHOT_OPERATION_FAILED\n');process.exitCode=1;}
"""


def crypto_args(mode, file, key, aad):
    return [NODE,'--input-type=module','-e',SNAPSHOT_JS,mode,str(file),str(key),aad]


def private_hash(path, limit=2 * 1024 ** 3 + 32):
    parents(path,private=True)
    fd = os.open(path,os.O_RDONLY | getattr(os,'O_NOFOLLOW',0))
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER and stat.S_IMODE(info.st_mode) == 0o600
             and info.st_nlink == 1 and 0 < info.st_size <= limit, 'APPLICATION_SNAPSHOT_FILE_UNSAFE')
        result = hashlib.sha256()
        size = 0
        while chunk := os.read(fd,65536):
            size += len(chunk)
            need(size <= limit,'APPLICATION_SNAPSHOT_TOO_LARGE')
            result.update(chunk)
        after = os.fstat(fd)
        need(size == info.st_size and (after.st_size,after.st_mtime_ns,after.st_ctime_ns)
             == (info.st_size,info.st_mtime_ns,info.st_ctime_ns),'APPLICATION_SNAPSHOT_CHANGED')
        return {'sha256':result.hexdigest(),'bytes':size}
    finally:
        os.close(fd)


def snapshot(plan, state, approval):
    fixed_profile(plan['profile'])
    url = urlsplit(plan['config']['DATABASE_URL'])
    need(unquote(url.username or '') == 'cisme_trial' and url.hostname == '127.0.0.1'
         and (url.port or 5432) == 5432 and unquote(url.path.lstrip('/')) == 'cisme_trial',
         'APPLICATION_SNAPSHOT_TRIAL_DATABASE_REQUIRED')
    directory = state / 'predeploy-database'
    directory.mkdir(mode=0o700)
    D.owned_directory(directory,True)
    encrypted,key = directory / 'cisme_trial.dump.aesgcm',directory / 'snapshot.key'
    aad = json.dumps({'database':'cisme_trial','baseline':BASELINE_HEAD,'operationReference':approval,
                      'operation':state.name},sort_keys=True,separators=(',',':'))
    env = {**CLEAN,'PGPASSWORD':unquote(url.password or ''),
           'PGOPTIONS':'-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=5000'}
    dump = subprocess.Popen(['/usr/sbin/runuser','-u','cisme-trial','--','/usr/bin/pg_dump','--format=custom',
           '--no-owner','--no-acl','--no-password','--host=127.0.0.1','--port=5432','--username=cisme_trial',
           '--dbname=cisme_trial'],env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    encrypt = None
    try:
        encrypt = subprocess.Popen(crypto_args('encrypt',encrypted,key,aad),env=CLEAN,
                                   stdin=dump.stdout,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        dump.stdout.close()
        raw,_ = encrypt.communicate(timeout=600)
        need(encrypt.returncode == 0 and dump.wait(timeout=20) == 0 and len(raw) <= 4096,
             'APPLICATION_SNAPSHOT_DUMP_FAILED')
    finally:
        for process in (encrypt,dump):
            if process is not None and process.poll() is None:
                process.kill()
                process.wait()
        if dump.stdout is not None and not dump.stdout.closed:
            dump.stdout.close()
    plain = D.json_bytes(raw)
    need(plain.get('encrypted') is True and re.fullmatch(r'[a-f0-9]{64}',plain.get('plainSha256',''))
         and type(plain.get('plainBytes')) is int and plain['plainBytes'] > 5,'APPLICATION_SNAPSHOT_DUMP_INVALID')
    cipher = private_hash(encrypted)
    key_binding = private_hash(key,32)
    need(key_binding['bytes'] == 32,'APPLICATION_SNAPSHOT_KEY_INVALID')
    verified = D.json_bytes(D.command(crypto_args('verify',encrypted,key,aad),timeout=600))
    need(verified.get('authenticated') is True and all(verified.get(k) == plain[k] for k in ('plainSha256','plainBytes')),
         'APPLICATION_SNAPSHOT_AUTHENTICATION_FAILED')
    decrypt = subprocess.Popen(crypto_args('decrypt',encrypted,key,aad),env=CLEAN,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    listing = None
    try:
        listing = subprocess.Popen(['/usr/bin/pg_restore','--list'],env=CLEAN,stdin=decrypt.stdout,
                                   stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        decrypt.stdout.close()
        table_of_contents,_ = listing.communicate(timeout=180)
        need(listing.returncode == 0 and decrypt.wait(timeout=20) == 0 and len(table_of_contents) <= 1024 * 1024
             and b'dbname: cisme_trial' in table_of_contents
             and b'TABLE DATA public schema_migration' in table_of_contents,'APPLICATION_SNAPSHOT_STRUCTURE_FAILED')
    finally:
        for process in (listing,decrypt):
            if process is not None and process.poll() is None:
                process.kill()
                process.wait()
        if decrypt.stdout is not None and not decrypt.stdout.closed:
            decrypt.stdout.close()
    need(private_hash(encrypted) == cipher and private_hash(key,32) == key_binding,'APPLICATION_SNAPSHOT_CHANGED')
    record = {'scope':'same-host-database-only','database':'cisme_trial','baseline':BASELINE_HEAD,
              'backupReference':'TRIAL-SNAPSHOT-' + state.name,'encryptedFile':str(encrypted),'keyFile':str(key),
              'aad':aad,**plain,'cipher':cipher,'keyBinding':key_binding,
              'structureListSha256':sha(table_of_contents),'authenticated':True,'pgRestoreListVerified':True,
              'fullRecoveryQualified':False,'restorePerformed':False,'mediaIncluded':False,'remoteCopyCreated':False}
    D.general.store(directory / 'snapshot-private.json',(json.dumps(record,sort_keys=True)+'\n').encode())
    return record


def validate_snapshot(backup, state, approval):
    directory = state / 'predeploy-database'
    encrypted, key = directory / 'cisme_trial.dump.aesgcm', directory / 'snapshot.key'
    expected_aad = json.dumps({'database':'cisme_trial','baseline':BASELINE_HEAD,'operationReference':approval,
                              'operation':state.name},sort_keys=True,separators=(',',':'))
    need(backup.get('authenticated') is True and backup.get('pgRestoreListVerified') is True
         and backup.get('database') == 'cisme_trial' and backup.get('baseline') == BASELINE_HEAD
         and backup.get('scope') == 'same-host-database-only' and backup.get('restorePerformed') is False
         and backup.get('backupReference') == 'TRIAL-SNAPSHOT-' + state.name
         and backup.get('encryptedFile') == str(encrypted) and backup.get('keyFile') == str(key)
         and backup.get('aad') == expected_aad,
         'APPLICATION_REAL_SNAPSHOT_REQUIRED')
    need(D.json_bytes(read(directory / 'snapshot-private.json',private=True)) == backup
         and private_hash(encrypted) == backup['cipher'] and private_hash(key,32) == backup['keyBinding'],
         'APPLICATION_SNAPSHOT_CHANGED')
    verified = D.json_bytes(D.command(crypto_args('verify',encrypted,key,expected_aad),timeout=600))
    need(verified.get('authenticated') is True and all(verified.get(k) == backup[k] for k in ('plainSha256','plainBytes')),
         'APPLICATION_SNAPSHOT_AUTHENTICATION_FAILED')


def active_record(plan, state, selected, rollback=False):
    return (json.dumps({'schemaVersion':1,'kind':'trial-application-active-release','environment':'trial',
        'instanceId':'lhins-61ikz4mi','database':'cisme_trial','directory':selected['directory'],
        'sourceHead':selected['manifest']['sourceHead'],'sourceTree':selected['manifest']['sourceTree'],
        'manifestSha256':selected['manifestSha256'],'dependenciesSha256':selected['dependenciesSha256'],
        'ownershipId':plan['ownership']['ownershipId'],'initialSourcePreserved':True,'dependencyHistoryPreserved':True,
        'upgradeState':str(state),'applicationRollback':rollback,'databaseRestored':False,
        'schemaChanged':False,'migrationCount':98,'databaseMayIncludeAdditiveEditorialMigration':True},sort_keys=True)+'\n').encode()


def save_plan(plan,state):
    D.general.store(state/'previous.env',plan['env'])
    D.general.store(state/'previous-dependency-active.json',plan['dependencyActiveBytes'])
    D.general.store(state/'previous-application-active.json',plan['applicationActiveBytes'])
    for name,data in plan['initialRecords'].items(): D.general.store(state/('initial-'+name),data)
    for unit,data in plan['units'].items(): D.general.store(state/unit,data)
    for unit,inputs in plan['dropIns'].items():
        if inputs['files']:
            parent=state/'drop-ins';parent.mkdir(mode=0o700,exist_ok=True);D.owned_directory(parent,True)
            directory=parent/unit;directory.mkdir(mode=0o700)
            for path,data in inputs['files'].items(): D.general.store(directory/Path(path).name,data)
    omitted={'env','config','units','dropIns','initialRecords','old','candidate','production','dependencyActiveBytes','applicationActiveBytes'}
    saved={k:v for k,v in plan.items() if k not in omitted}
    saved['old']={k:v for k,v in plan['old'].items() if k!='files'}
    saved['candidate']={k:v for k,v in plan['candidate'].items() if k!='files'}
    D.general.store(state/'binding-private.json',(json.dumps(saved,sort_keys=True)+'\n').encode())


def active_context(b):
    """Read-only post-switch guard for separately bound owner/content wrappers.

    b is THIS helper's validated deployment binding, not an owner-input payload.
    No old baseline runtime guard, GitHub request, CLI or consent/grant is run.
    """
    global A, D
    need(b.get('kind')=='trial-no-schema-application-upgrade' and b.get('baselineHead')==BASELINE_HEAD
         and b.get('dependenciesSha256')==DEPENDENCIES and b.get('migrations')==98
         and sha(read(Path(__file__),private=True))==b.get('helperSha256'),
         'NO_SCHEMA_FINAL_ACTIVE_BINDING_REQUIRED')
    owner, old_binding=owner_module()
    A=owner.load_helper(old_binding);D=A.D
    identity=D.general.observe.identity()
    need(identity.get('instanceId')=='lhins-61ikz4mi' and identity.get('publicIpv4')=='124.223.74.198',
         'NO_SCHEMA_EXACT_INSTANCE_REQUIRED')
    profile={**D.PROFILES['trial'],'name':'trial'};fixed_profile(profile)
    release=ROOT/'releases'/('tencent-release-'+b['sourceHead'][:12])
    candidate=D.artifact(str(release),ROOT)
    need(candidate['manifest'].get('sourceHead')==b['sourceHead'] and candidate['manifest'].get('sourceTree')==b['sourceTree']
         and candidate['manifestSha256']==b['manifestSha256'] and candidate['dependenciesSha256']==DEPENDENCIES
         and candidate['manifest'].get('sourceLockSha256')==SOURCE_LOCK and len(candidate['manifest']['migrations'])==98,
         'NO_SCHEMA_ACTIVE_ARTIFACT_REQUIRED')
    active=parse(read(ROOT/'application-active-release.json',private=True))
    need(active.get('kind')=='trial-application-active-release' and active.get('environment')=='trial'
         and active.get('instanceId')=='lhins-61ikz4mi' and active.get('database')=='cisme_trial'
         and active.get('directory')==str(release) and active.get('sourceHead')==b['sourceHead']
         and active.get('sourceTree')==b['sourceTree'] and active.get('manifestSha256')==b['manifestSha256']
         and active.get('dependenciesSha256')==DEPENDENCIES and active.get('applicationRollback')is False
         and active.get('databaseRestored')is False and active.get('schemaChanged')is False,
         'NO_SCHEMA_NEW_APPLICATION_REQUIRED')
    state=Path(active.get('upgradeState',''))
    need(state.parent==ROOT/'application-upgrades' and re.fullmatch(r'main-'+b['sourceHead'][:12]+r'-[0-9]+',state.name),
         'NO_SCHEMA_ACTIVE_STATE_REQUIRED')
    parents(state/'binding-private.json',True)
    saved=parse(read(state/'binding-private.json',private=True))
    need(saved.get('binding')==b and saved.get('candidate',{}).get('directory')==str(release)
         and saved['candidate'].get('manifestSha256')==b['manifestSha256']
         and saved['candidate'].get('dependenciesSha256')==DEPENDENCIES
         and saved.get('old',{}).get('manifestSha256')==BASELINE_MANIFEST
         and active.get('ownershipId')==saved.get('ownership',{}).get('ownershipId'), 'NO_SCHEMA_ACTIVE_STATE_BINDING_REQUIRED')
    env=D.read_owned(ROOT/'runtime.env',private=True)
    need(env==read(state/'previous.env',private=True) and D.environment_metadata(profile)==saved['environmentMetadata'],
         'NO_SCHEMA_ACTIVE_ENVIRONMENT_DRIFT')
    config=D.general.observe.audit.environment(env.decode())
    safe,settings=D.general.observe.audit.database(config.get('DATABASE_URL',''))
    need(safe['databaseName']==safe['role']=='cisme_trial' and safe['host']=='127.0.0.1' and safe['port']==5432
         and config.get('APP_ENV')=='staging' and config.get('WECHAT_APP_ID')==APP_ID
         and D.closed_context(profile,config) and config.get('WECHAT_PHONE_BINDING_ENABLED','false')=='false'
         and config.get('COS_DIRECT_UPLOAD_ENABLED','false')=='false', 'NO_SCHEMA_ACTIVE_CLOSED_TRIAL_REQUIRED')
    need(D.private_inputs(profile,config)==saved['privateInputs'], 'NO_SCHEMA_ACTIVE_PRIVATE_INPUT_DRIFT')
    for name in ('ownership.json','empty-database.json','migration-complete.json'):
        need(D.read_owned(ROOT/name,private=True)==read(state/('initial-'+name),private=True),
             'NO_SCHEMA_ACTIVE_INITIAL_HISTORY_DRIFT')
    need(D.read_owned(ROOT/'dependency-active-release.json',private=True)==read(state/'previous-dependency-active.json',private=True),
         'NO_SCHEMA_ACTIVE_DEPENDENCY_HISTORY_DRIFT')
    for unit,entry in zip(profile['units'],('index.js','worker.js')):
        previous=read(state/unit,private=True);actual=D.read_owned(D.unit_path(unit))
        expected=D.replacement_unit(previous,saved['old']['directory'],str(release),entry,profile)
        need(actual==expected,'NO_SCHEMA_ACTIVE_UNIT_DRIFT')
        definition=D.unit_definition(unit,actual,entry,profile)
        need(definition=={**saved['unitDefinitions'][unit],'ExecStartArgv':NODE+' '+str(release/entry)},
             'NO_SCHEMA_ACTIVE_EFFECTIVE_UNIT_OR_DROPIN_DRIFT')
    D.running(profile,str(release),config)
    actual_role=parse(D.command(['/usr/bin/psql','-XAt','-v','ON_ERROR_STOP=1','-c',
        "SELECT json_build_object('database',current_database(),'role',current_user)"],
        env={**CLEAN,**settings,'PGOPTIONS':'-c default_transaction_read_only=on -c statement_timeout=10000'}))
    need(actual_role=={'database':'cisme_trial','role':'cisme_trial'},'NO_SCHEMA_ACTUAL_TRIAL_ROLE_REQUIRED')
    facts=D.database_facts(profile)
    need(facts.get('database')==facts.get('owner')=='cisme_trial' and facts.get('journal')==candidate['manifest']['migrations'],
         'NO_SCHEMA_ACTIVE_DATABASE_DRIFT')
    return {'A':A,'D':D,'profile':profile,'config':config,'release':release,'binding':b}


def cutover(plan,state,approval):
    fixed_profile(plan['profile'])
    save_plan(plan,state)
    halted=False; published=None
    try:
        verify_context(plan); journal(plan)
        halted=True
        D.command(['systemctl','stop',*plan['profile']['units']],timeout=90)
        D.stopped(plan['profile'])
        verify_context(plan,provenance=False); journal(plan,True)
        backup=snapshot(plan,state,approval)
        validate_snapshot(backup,state,approval)
        journal(plan,True); verify_context(plan)
        # No schema command or data mutation occurs between snapshot and switch.
        D.switch(plan,plan['candidate']['directory'])
        D.verify_units(plan,allow_candidate=True)
        verify_active(plan); journal(plan,True)
        started=time.time()
        D.command(['systemctl','start',*plan['profile']['units']],timeout=60)
        versions=D.healthy(plan,plan['candidate']['directory'],started,True)
        verify_context(plan,candidate_allowed=True); journal(plan)
        published=active_record(plan,state,plan['candidate'])
        D.atomic_bytes(ROOT/'application-active-release.json',published)
        verify_context(plan,provenance=False,candidate_allowed=True,active_allowed=(published,)); journal(plan)
        report={'deployed':True,'environment':'trial','sourceHead':plan['main']['sha'],
            'migrationCountBefore':98,'migrationCountAfter':98,'migrationCommandExecuted':False,
            'snapshotAuthenticated':True,'snapshotScope':'same-host-database-only','databaseRestored':False,
            'fullRecoveryQualified':False,'versions':versions,'existingEditorialBatchPreserved':True,
            'configurationChanged':False,'credentialsChanged':False,'networkChanged':False,
            'productionChanged':False,'contentPublished':False,'consentCreated':False,'authorityGranted':False}
        D.general.store(state/'deployed.json',(json.dumps(report,sort_keys=True)+'\n').encode())
        return report
    except Exception:
        if not halted: raise
        try:
            D.command(['systemctl','stop',*plan['profile']['units']],timeout=90); D.stopped(plan['profile'])
            # New content/unknown env/unit/drop-in/active drift must not be overwritten.
            verify_context(plan,provenance=False,candidate_allowed=True,active_allowed=(published,) if published else ())
            journal(plan,True)
            D.switch(plan,plan['old']['directory']); D.verify_units(plan)
            started=time.time();D.command(['systemctl','start',*plan['profile']['units']],timeout=60)
            D.healthy(plan,plan['old']['directory'],started,True)
            verify_context(plan,provenance=False,active_allowed=(published,) if published else ());journal(plan)
            # Restore the exact previous 0d3 record and its original provenance chain.
            D.atomic_bytes(ROOT/'application-active-release.json',plan['applicationActiveBytes'])
            verify_context(plan,provenance=False)
            D.general.store(state/'application-rollback.json',b'{"applicationRestored":true,"databaseRestored":false,"schemaCommandExecuted":false}\n')
        except Exception:
            stopped=False
            try:
                D.command(['systemctl','stop',*plan['profile']['units']],timeout=90);D.stopped(plan['profile']);stopped=True
            except Exception: pass
            D.general.store(state/'manual-recovery-required.json',(json.dumps({'servicesStopped':stopped,
                'unknownInputsOverwritten':False,'applicationRollbackVerified':False,'databaseRestored':False})+'\n').encode())
            raise Refused('NO_SCHEMA_FAILED_FENCED_REVIEW_REQUIRED') from None
        raise Refused('NO_SCHEMA_FAILED_0D3_APPLICATION_RESTORED') from None


def apply(b,approval):
    need(re.fullmatch(r'[-A-Za-z0-9_:.]{8,120}',approval or ''), 'NO_SCHEMA_OPERATION_REFERENCE_REQUIRED')
    need(os.geteuid()==OWNER,'NO_SCHEMA_ROOT_REQUIRED')
    lock_path=Path('/run/lock/cisme-production-trial.lock')
    parent=lock_path.parent.lstat()
    need(stat.S_ISDIR(parent.st_mode) and parent.st_uid==0 and stat.S_IMODE(parent.st_mode)==0o1777,
         'NO_SCHEMA_LOCK_PARENT_REQUIRED')
    fd=os.open(lock_path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        st=os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o600 and st.st_nlink==1,
             'NO_SCHEMA_LOCK_REQUIRED')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        plan=preflight(b)
        parent=ROOT/'application-upgrades';parent.mkdir(mode=0o700,exist_ok=True);D.owned_directory(parent,True)
        marker=parent/('no-schema-'+b['sourceHead'][:12]+'.started.json')
        # One marker per exact target; unknown/failed attempts require reviewed recovery.
        raw=(json.dumps({'sourceHead':b['sourceHead'],'operationReference':approval},sort_keys=True)+'\n').encode()
        out=os.open(marker,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(out,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
        state=parent/('main-'+b['sourceHead'][:12]+'-'+str(time.time_ns()));state.mkdir(mode=0o700)
        return cutover(plan,state,approval)
    finally: os.close(fd)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('preflight','apply'),nargs='?',default='preflight')
    parser.add_argument('--binding',type=Path,required=True);parser.add_argument('--binding-sha256',required=True)
    parser.add_argument('--operation-reference')
    args=parser.parse_args()
    try:
        b=binding(args.binding,args.binding_sha256)
        if args.action=='apply': result=apply(b,args.operation_reference)
        else:
            plan=preflight(b)
            result={'readOnly':True,'deployed':False,'sourceHead':plan['main']['sha'],'migrationCountBefore':98,
                'migrationCountAfter':98,'sameHostSnapshotNotYetCreated':True,'productionPreserved':True,
                'allSixSecretCategoriesDistinct':True,'contentPublished':False,'businessAdmissionGranted':False}
        print(json.dumps(result,sort_keys=True));return 0
    except Exception as error:
        value=str(error) if isinstance(error,Refused) else ''
        code=value if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}',value) else 'NO_SCHEMA_REVIEW_REQUIRED'
        print(json.dumps({'ok':False,'code':code,'privateValuesExported':False}));return 1


if __name__=='__main__': raise SystemExit(main())
