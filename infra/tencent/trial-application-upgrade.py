#!/usr/bin/env python3
"""Trial-only application upgrade from dbd2b88, with one additive owned-editorial migration.

Default is read-only preflight. Uses the protected, exact-reviewed dbd operations
modules for low-level input/unit/runtime checks, never their dependency-only
preflight, equal-runtime permit, provisioning, restore or production switch.
"""
import argparse
import base64
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time
from urllib.parse import unquote, urlsplit
import urllib.request

BASELINE_HEAD = 'dbd2b88a47f622621c2b226b03339677b183fef8'
BASELINE_TREE = '7ced9ed2248a1e27a9f30f2995badab21fdddf79'
PACKAGE_SHA = 'c70b97f3ec0e6c339c5c27b0e9067549f9256287cfbfdf32f39ae46fcf54e231'
LOCK_SHA = '2a14af4f1bfdd86d0108015b43df14d62b2cc6e8eedcd3831446970a26d7d32a'
MIGRATION = '202610260001_owned_editorial.sql'
NODE = '/opt/node-v24.14.0-linux-x64/bin/node'
ROOT = Path('/opt/cisme-trial')
STAGES = Path('/var/lib/cisme-dependency-stage')
OPS = Path('/opt/cisme/operations/dependency-only-dbd2b88a47f6')
PEERS = {
 'dependency-only-upgrade.py':'fd8328947cda8d86cbc1577b0754bf74d6f479f153640bf585c5f1b496747172',
 'production-release.py':'b5b0a3e6645a8a244ba732fae1883ecba961b7fbc4e297b497bb0ede92a566cb',
 'production-trial.py':'e49d669715581ade8726e23830903c386fcb9764b1e11e2a2727c7957a364f2b',
 'production-observation.py':'69e1d1638b86798791bd41a5a99d6fddf2822dc3ca5ca4881274994f841ee8e4',
 'production-target.py':'4fc403288db9486f7ad721617ab3c8edfd5cc0643c15ec52179b042119e36f74',
 'production-security-audit.py':'0e8f209d19f0e1b62f3ec31f5eec93f1ff99faac3c8a3b3c2cbb7ff11461cb82',
 'production-migration-audit.py':'470b78ab3af29aabcb3259c85a92124f184c4b879579e688606674a7e31d4dee',
}
CLEAN = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'}
OWNER = 0
D = None


class Refused(RuntimeError):
    pass


def need(value, code):
    if not value:
        raise Refused(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path, limit=1024 * 1024, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER and info.st_nlink == 1
             and info.st_mode & (0o077 if private else 0o022) == 0 and 0 < info.st_size <= limit,
             'APPLICATION_PROTECTED_FILE_REQUIRED')
        parts = bytearray()
        while chunk := os.read(fd, min(65536, limit + 1 - len(parts))):
            parts.extend(chunk)
            need(len(parts) <= limit, 'APPLICATION_FILE_TOO_LARGE')
        after = os.fstat(fd)
        need(len(parts) == info.st_size and (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
             == (info.st_size, info.st_mtime_ns, info.st_ctime_ns), 'APPLICATION_FILE_CHANGED')
        return bytes(parts)
    finally:
        os.close(fd)


def parents(path, private=False):
    need(path.is_absolute() and '..' not in path.parts, 'APPLICATION_ABSOLUTE_PATH_REQUIRED')
    for parent in reversed(path.parents):
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == OWNER and info.st_mode & 0o022 == 0,
             'APPLICATION_PARENT_UNSAFE')
    if private:
        info = path.parent.lstat()
        need(info.st_mode & 0o077 == 0, 'APPLICATION_PRIVATE_PARENT_REQUIRED')


def configure_shared():
    global D
    need(os.geteuid() == OWNER, 'APPLICATION_ROOT_REQUIRED')
    parents(OPS / 'dependency-only-upgrade.py', private=True)
    for name, expected in PEERS.items():
        need(sha(read(OPS / name)) == expected, 'APPLICATION_REVIEWED_PEER_REQUIRED')
    spec = importlib.util.spec_from_file_location('application_reviewed_dependency', OPS / 'dependency-only-upgrade.py')
    D = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(D)
    need(D.NODE == NODE, 'APPLICATION_NODE_REQUIRED')


def fixed_profile(profile):
    need(profile == {**D.PROFILES['trial'], 'name':'trial'} and Path(profile['root']) == ROOT
         and profile['database'] == 'cisme_trial' and profile['user'] == 'cisme-trial'
         and profile['units'] == ('cisme-trial-api.service','cisme-trial-worker.service'),
         'APPLICATION_TRIAL_ONLY')


def github_source(name, head):
    need(name in ('package.json','package-lock.json','scripts/release-migrate.mjs','db/migrations/' + MIGRATION)
         and D.general.observe.target.git_sha(head), 'APPLICATION_GITHUB_RESOURCE_REFUSED')
    url = 'https://api.github.com/repos/' + D.general.REPO + '/contents/' + name + '?ref=' + head
    request = urllib.request.Request(url, headers={'Accept':'application/vnd.github+json',
                'Cache-Control':'no-cache','User-Agent':'cisme-trial-application-source'})
    with urllib.request.build_opener(D.general.observe.NoRedirect()).open(request, timeout=15) as response:
        need(response.status == 200, 'APPLICATION_SOURCE_UNAVAILABLE')
        length = response.headers.get('Content-Length')
        need(length is None or re.fullmatch(r'[0-9]+', length), 'APPLICATION_SOURCE_LENGTH_INVALID')
        expected = int(length) if length is not None else None
        limit = 2 * 1024 * 1024
        need(expected is None or 0 < expected <= limit, 'APPLICATION_SOURCE_TOO_LARGE')
        raw = bytearray()
        while chunk := response.read(min(65536, limit + 1 - len(raw))):
            raw.extend(chunk)
            need(len(raw) <= limit, 'APPLICATION_SOURCE_TOO_LARGE')
        need(expected is None or len(raw) == expected, 'APPLICATION_SOURCE_TRUNCATED')
    document = D.json_bytes(bytes(raw))
    need(document.get('type') == 'file' and document.get('path') == name and document.get('encoding') == 'base64'
         and type(document.get('size')) is int and 0 < document['size'] <= 1024 * 1024
         and D.general.observe.target.git_sha(document.get('sha')) and isinstance(document.get('content'), str),
         'APPLICATION_SOURCE_METADATA_INVALID')
    data = base64.b64decode(document['content'].replace('\n',''), validate=True)
    need(len(data) == document['size'] and hashlib.sha1(('blob ' + str(len(data)) + '\0').encode() + data).hexdigest()
         == document['sha'], 'APPLICATION_SOURCE_BLOB_MISMATCH')
    return data


def capability_set(sql):
    matches = re.findall(r'ADD\s+CONSTRAINT\s+authority_grant_capability_check\s+CHECK\s*\(\s*capability\s+IN\s*\((.*?)\)\s*\)',
                         sql, re.I | re.S)
    need(bool(matches), 'APPLICATION_CAPABILITY_CHECK_REQUIRED')
    names = re.findall(r"'([a-z][a-z_.]+)'", matches[-1])
    need(names and len(names) == len(set(names)) and re.sub(r"'[a-z][a-z_.]+'|[\s,]",'',matches[-1]) == '',
         'APPLICATION_CAPABILITY_CHECK_INVALID')
    return set(names)


def migration_contract(old, candidate):
    before = old['manifest']['migrations']
    after = candidate['manifest']['migrations']
    need(len(before) == 97 and MIGRATION not in before and after == before + [MIGRATION],
         'APPLICATION_ONLY_EDITORIAL_MIGRATION_PERMITTED')
    need(all(old['files'][name] == candidate['files'][name] for name in
             ['migrate.mjs','package.json','package-lock.json'] + ['db/migrations/' + name for name in before]),
         'APPLICATION_BASELINE_SQL_OR_DEPENDENCIES_CHANGED')
    prior = None
    for name in before:
        up = old['files']['db/migrations/' + name].decode().split('-- migrate:down')[0]
        if re.search(r'ADD\s+CONSTRAINT\s+authority_grant_capability_check', up, re.I):
            prior = capability_set(up)
    need(prior is not None and 'editorial.manage' not in prior, 'APPLICATION_CAPABILITY_BASELINE_REQUIRED')
    new = capability_set(candidate['files']['db/migrations/' + MIGRATION].decode().split('-- migrate:down')[0])
    need(new == prior | {'editorial.manage'}, 'APPLICATION_CAPABILITY_MUST_ONLY_ADD_EDITORIAL')
    return {'before':sorted(prior), 'after':sorted(new)}


def database_contract(profile, allowed):
    value = D.query(profile, "SELECT json_build_object('definition',pg_get_constraintdef(oid)) FROM pg_constraint "
                    "WHERE conrelid='authority_grant'::regclass AND conname='authority_grant_capability_check'")
    names = set(re.findall(r"'([a-z][a-z_.]+)'", value.get('definition','')))
    need(names == set(allowed), 'APPLICATION_DATABASE_CAPABILITY_DRIFT')


def archive_binding(args, candidate):
    path = Path(args.stage_receipt)
    need(path.name == 'stage-receipt.json' and path.parent.parent == STAGES,
         'APPLICATION_REVIEWED_STAGE_RECEIPT_REQUIRED')
    parents(path, private=True)
    receipt_bytes = read(path, private=True)
    receipt = D.json_bytes(receipt_bytes)
    need(receipt.get('staged') is True and receipt.get('deployed') is False
         and receipt.get('instanceId') == 'lhins-61ikz4mi' and receipt.get('publicIpv4') == '124.223.74.198'
         and receipt.get('privateStage') == str(path.parent)
         and receipt.get('sourceHead') == args.head and receipt.get('sourceTree') == args.tree
         and receipt.get('archiveSha256') == args.archive_sha256 and receipt.get('archiveSize') == args.archive_bytes
         and receipt.get('manifestSha256') == args.manifest_sha256 == candidate['manifestSha256']
         and receipt.get('dependenciesSha256') == candidate['dependenciesSha256'] and receipt.get('migrations') == 98
         and receipt.get('candidateDirectories') == [candidate['directory']]
         and all(receipt.get(key) is False for key in ('servicesChanged','databaseChanged','configurationChanged',
                                                       'productionChanged','peerFilesChanged')),
         'APPLICATION_STAGE_BINDING_MISMATCH')
    archive = path.parent / 'archive.tar.gz'
    need(0 < args.archive_bytes <= 512 * 1024 * 1024, 'APPLICATION_ARCHIVE_SIZE_INVALID')
    data = read(archive, 512 * 1024 * 1024, private=True)
    need(len(data) == args.archive_bytes and sha(data) == args.archive_sha256, 'APPLICATION_ARCHIVE_HASH_MISMATCH')
    return {'receipt':str(path), 'receiptSha256':sha(receipt_bytes),
            'archiveSha256':args.archive_sha256,'archiveBytes':args.archive_bytes}


def source_permit(args, old, candidate, main):
    need(main['sha'] == args.head and main['tree'] == args.tree and main['ciRunId'] == args.ci_run_id,
         'APPLICATION_EXACT_MAIN_LATEST_CI_REQUIRED')
    manifest = candidate['manifest']
    need(manifest.get('sourceHead') == main['sha'] and manifest.get('sourceTree') == main['tree']
         and main['sha'] != BASELINE_HEAD and manifest.get('sourceLockSha256') == LOCK_SHA
         and manifest.get('buildPlatform') == {'os':'linux','arch':'x64','libc':'glibc'},
         'APPLICATION_EXACT_ARTIFACT_REQUIRED')
    package_bytes = github_source('package.json', main['sha'])
    lock_bytes = github_source('package-lock.json', main['sha'])
    need(sha(package_bytes) == PACKAGE_SHA and sha(lock_bytes) == LOCK_SHA, 'APPLICATION_PACKAGE_LOCK_CHANGED')
    source = D.json_bytes(package_bytes)
    release = {'name':'cisme-tencent-release','version':source['version'],'private':True,'type':'module',
               'engines':source['engines'],'dependencies':source['dependencies']}
    need(D.json_bytes(candidate['files']['package.json']) == release, 'APPLICATION_RELEASE_PACKAGE_MISMATCH')
    lock = D.json_bytes(lock_bytes)
    lock['name'] = release['name']
    lock['packages'][''] = {k:v for k,v in release.items() if k not in ('private','type')}
    lock['packages'] = {k:v for k,v in lock['packages'].items() if not k or (k.startswith('node_modules/') and not v.get('link'))}
    need(D.json_bytes(candidate['files']['package-lock.json']) == lock, 'APPLICATION_RELEASE_LOCK_MISMATCH')
    for name, source_name in [('migrate.mjs','scripts/release-migrate.mjs'),('db/migrations/' + MIGRATION,'db/migrations/' + MIGRATION)]:
        need(candidate['files'][name] == github_source(source_name, main['sha']), 'APPLICATION_SOURCE_BYTES_MISMATCH')
    verified = D.json_bytes(D.command([NODE,str(Path(candidate['directory']) / 'migrate.mjs'),'verify']))
    need(verified.get('verified') is True and verified.get('sourceHead') == main['sha']
         and verified.get('sourceTree') == main['tree'] and verified.get('migrations') == 98,
         'APPLICATION_FULL_ARTIFACT_REQUIRED')


def optional_private(path):
    return read(path, private=True) if path.exists() or path.is_symlink() else None


def verify_active(plan, allowed=()):
    need(optional_private(ROOT / 'dependency-active-release.json') == plan['dependencyActiveBytes'],
         'APPLICATION_DEPENDENCY_HISTORY_DRIFT')
    need(optional_private(ROOT / 'application-active-release.json') in (plan['applicationActiveBytes'], *allowed),
         'APPLICATION_ACTIVE_RECORD_DRIFT')


def preflight(args):
    need(os.geteuid() == OWNER, 'APPLICATION_ROOT_REQUIRED')
    identity = D.general.observe.identity()
    profile = {**D.PROFILES['trial'], 'name':'trial'}
    fixed_profile(profile)
    D.owned_directory(ROOT)
    env_metadata = D.environment_metadata(profile)
    env_bytes = D.read_owned(ROOT / 'runtime.env', private=True)
    config = D.general.observe.audit.environment(env_bytes.decode())
    safe, _ = D.general.observe.audit.database(config.get('DATABASE_URL',''))
    need(safe['databaseName'] == safe['role'] == 'cisme_trial' and safe['host'] == '127.0.0.1'
         and safe['port'] == 5432 and config.get('APP_ENV') == 'staging' and D.closed_context(profile,config),
         'APPLICATION_TRIAL_DATABASE_AND_CLOSED_CONTEXT_REQUIRED')
    units = {unit:D.read_owned(D.unit_path(unit)) for unit in profile['units']}
    dirs = {D.unit_entry(units[unit],entry,profile) for unit,entry in zip(profile['units'],('index.js','worker.js'))}
    need(len(dirs) == 1, 'APPLICATION_RUNNING_RELEASE_SPLIT')
    old = D.artifact(dirs.pop(), ROOT)
    candidate = D.artifact(args.release, ROOT)
    need(old['directory'] != candidate['directory'] and old['manifest'].get('sourceHead') == BASELINE_HEAD
         and old['manifest'].get('sourceTree') == BASELINE_TREE and old['manifest'].get('sourceLockSha256') == LOCK_SHA,
         'APPLICATION_DBD_BASELINE_REQUIRED')
    capabilities = migration_contract(old,candidate)
    main = D.general.reviewed_main()
    source_permit(args,old,candidate,main)
    archive = archive_binding(args,candidate)
    facts = D.database_facts(profile)
    need(facts['database'] == facts['owner'] == 'cisme_trial' and facts['journal'] == old['manifest']['migrations'],
         'APPLICATION_DATABASE_BASELINE_DRIFT')
    database_contract(profile,capabilities['before'])
    initial = {name:D.read_owned(ROOT / name,private=True) for name in ('ownership.json','empty-database.json','migration-complete.json')}
    ownership = D.json_bytes(initial['ownership.json'])
    need(ownership.get('kind') == 'cisme-isolated-trial' and ownership.get('instanceId') == identity['instanceId']
         and ownership.get('root') == str(ROOT) and ownership.get('database') == ownership.get('role') == 'cisme_trial'
         and ownership.get('user') == 'cisme-trial' and re.fullmatch(r'[a-f0-9]{32}',ownership.get('ownershipId','')),
         'APPLICATION_OWNERSHIP_REQUIRED')
    D.trial.db_owned(ownership)
    completed = D.json_bytes(initial['migration-complete.json'])
    need(completed.get('ownershipId') == ownership['ownershipId'] and completed.get('source') == ownership.get('source')
         and completed.get('migrations') == 97, 'APPLICATION_INITIAL_HISTORY_DRIFT')
    dependency_active = read(ROOT / 'dependency-active-release.json',private=True)
    prior = D.json_bytes(dependency_active)
    need(prior.get('kind') == 'dependency-only-active-release' and prior.get('directory') == old['directory']
         and prior.get('manifestSha256') == old['manifestSha256'] and prior.get('dependenciesSha256') == old['dependenciesSha256']
         and prior.get('sourceHead') == BASELINE_HEAD and prior.get('sourceTree') == BASELINE_TREE,
         'APPLICATION_DEPENDENCY_BASELINE_RECORD_REQUIRED')
    need(optional_private(ROOT / 'application-active-release.json') is None, 'APPLICATION_PREEXISTING_ACTIVE_RECORD_REFUSED')
    dropins = {unit:D.dropin_inputs(unit) for unit in profile['units']}
    definitions = {unit:D.unit_definition(unit,units[unit],entry,profile,dropins[unit])
                   for unit,entry in zip(profile['units'],('index.js','worker.js'))}
    pids = D.running(profile,old['directory'],config)
    versions = D.native_smoke(profile,candidate['directory'],True)
    old_versions = D.native_smoke(profile,old['directory'],True)
    need(versions == old_versions, 'APPLICATION_NATIVE_BASELINE_CHANGED')
    return {'profile':profile,'main':main,'old':old,'candidate':candidate,'env':env_bytes,'config':config,
            'environmentMetadata':env_metadata,'privateInputs':D.private_inputs(profile,config),
            'units':units,'unitDefinitions':definitions,'dropIns':dropins,'ownership':ownership,
            'initialRecords':initial,'activeBytes':dependency_active,'dependencyActiveBytes':dependency_active,
            'applicationActiveBytes':None,'versions':versions,'oldVersions':old_versions,'pids':pids,
            'capabilities':capabilities,'archiveBinding':archive}


def verify_context(plan, provenance=True, candidate_allowed=False):
    fixed_profile(plan['profile'])
    D.verify_context(plan,provenance=provenance,allow_candidate=candidate_allowed)
    verify_active(plan)
    path = Path(plan['archiveBinding']['receipt'])
    need(sha(read(path,private=True)) == plan['archiveBinding']['receiptSha256'], 'APPLICATION_STAGE_RECEIPT_DRIFT')


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


def journal(plan, allowed):
    facts = D.database_facts(plan['profile'])
    need(facts['database'] == facts['owner'] == 'cisme_trial' and facts['otherClients'] == 0
         and facts['journal'] in allowed,'APPLICATION_DATABASE_OR_DRAIN_DRIFT')
    capabilities = plan['capabilities']['after' if facts['journal'] == plan['candidate']['manifest']['migrations'] else 'before']
    database_contract(plan['profile'],capabilities)
    return facts['journal']


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


def migrate(plan, backup, approval, state):
    validate_snapshot(backup,state,approval)
    D.command(['/usr/sbin/runuser','-u','cisme-trial','--',NODE,str(Path(plan['candidate']['directory'])/'migrate.mjs'),'up'],
              env={**CLEAN,**plan['config'],'CISME_MIGRATION_APPROVAL_REF':approval,
                   'CISME_PREDEPLOY_BACKUP_REF':backup['backupReference']},cwd=ROOT,timeout=180)
    journal(plan,[plan['candidate']['manifest']['migrations']])


def active_record(plan, state, directory, rollback=False):
    selected = plan['old'] if rollback else plan['candidate']
    return (json.dumps({'schemaVersion':1,'kind':'trial-application-active-release','environment':'trial',
            'instanceId':'lhins-61ikz4mi','database':'cisme_trial','directory':directory,
            'sourceHead':selected['manifest']['sourceHead'],'sourceTree':selected['manifest']['sourceTree'],
            'manifestSha256':selected['manifestSha256'],'dependenciesSha256':selected['dependenciesSha256'],
            'ownershipId':plan['ownership']['ownershipId'],'initialSourcePreserved':True,
            'dependencyHistoryPreserved':True,'upgradeState':str(state),'applicationRollback':rollback,
            'databaseRestored':False,'databaseMayIncludeAdditiveEditorialMigration':True},sort_keys=True)+'\n').encode()


def cutover(plan, state, approval):
    fixed_profile(plan['profile'])
    D.general.store(state/'previous.env',plan['env'])
    for unit,data in plan['units'].items():
        D.general.store(state/unit,data)
    for unit,inputs in plan['dropIns'].items():
        if inputs['files']:
            parent = state/'drop-ins'
            parent.mkdir(mode=0o700,exist_ok=True)
            D.owned_directory(parent,True)
            target = parent/unit
            target.mkdir(mode=0o700)
            for path,data in inputs['files'].items():
                D.general.store(target/Path(path).name,data)
    for name,data in plan['initialRecords'].items():
        D.general.store(state/('initial-'+name),data)
    D.general.store(state/'previous-dependency-active.json',plan['dependencyActiveBytes'])
    binding = {k:v for k,v in plan.items() if k not in ('env','config','units','dropIns','initialRecords',
                 'old','candidate','activeBytes','dependencyActiveBytes','applicationActiveBytes')}
    binding['old'] = {k:v for k,v in plan['old'].items() if k!='files'}
    binding['candidate'] = {k:v for k,v in plan['candidate'].items() if k!='files'}
    D.general.store(state/'binding-private.json',(json.dumps(binding,sort_keys=True)+'\n').encode())
    halted,published = False,None
    try:
        verify_context(plan)
        halted = True
        D.command(['systemctl','stop',*plan['profile']['units']],timeout=90)
        D.stopped(plan['profile'])
        journal(plan,[plan['old']['manifest']['migrations']])
        verify_context(plan,provenance=False)
        backup = snapshot(plan,state,approval)
        journal(plan,[plan['old']['manifest']['migrations']])
        verify_context(plan)
        migrate(plan,backup,approval,state)
        verify_context(plan,provenance=False)
        D.switch(plan,plan['candidate']['directory'])
        D.verify_units(plan,allow_candidate=True)
        verify_active(plan)
        started = time.time()
        D.command(['systemctl','start',*plan['profile']['units']],timeout=60)
        versions = D.healthy(plan,plan['candidate']['directory'],started,True)
        verify_context(plan,candidate_allowed=True)
        published = active_record(plan,state,plan['candidate']['directory'])
        D.atomic_bytes(ROOT/'application-active-release.json',published)
        report = {'deployed':True,'environment':'trial','sourceHead':plan['main']['sha'],'versions':versions,
                  'migrationCount':98,'snapshotAuthenticated':True,'snapshotScope':'same-host-database-only',
                  'fullRecoveryQualified':False,'databaseRestored':False,'configurationChanged':False,
                  'credentialsChanged':False,'networkChanged':False,'productionChanged':False,
                  'publicReachabilityVerified':False,'businessAdmissionGranted':False}
        D.general.store(state/'deployed.json',(json.dumps(report,sort_keys=True)+'\n').encode())
        return report
    except Exception:
        if not halted:
            raise
        try:
            D.command(['systemctl','stop',*plan['profile']['units']],timeout=90)
            D.stopped(plan['profile'])
            # Detect all unknown active/config/unit/drop-in changes BEFORE old API restart.
            fixed_profile(plan['profile'])
            D.verify_context(plan,provenance=False,allow_candidate=True)
            verify_active(plan,(published,) if published is not None else ())
            journal(plan,[plan['old']['manifest']['migrations'],plan['candidate']['manifest']['migrations']])
            D.switch(plan,plan['old']['directory'])
            D.verify_units(plan)
            started = time.time()
            D.command(['systemctl','start',*plan['profile']['units']],timeout=60)
            D.healthy(plan,plan['old']['directory'],started,True)
            D.verify_context(plan,provenance=False)
            verify_active(plan,(published,) if published is not None else ())
            rollback = active_record(plan,state,plan['old']['directory'],True)
            D.atomic_bytes(ROOT/'application-active-release.json',rollback)
            D.general.store(state/'application-rollback.json',b'{"applicationRestored":true,"databaseRestored":false,"downMigrationExecuted":false}\n')
        except Exception:
            fenced = False
            try:
                D.command(['systemctl','stop',*plan['profile']['units']],timeout=90)
                D.stopped(plan['profile'])
                fenced = True
            except Exception:
                pass
            D.general.store(state/'manual-recovery-required.json',(json.dumps({'servicesStopped':fenced,
                'unknownInputsOverwritten':False,'applicationRollbackVerified':False,'databaseRestored':False})+'\n').encode())
            raise Refused('APPLICATION_UPGRADE_FAILED_FENCED_REVIEW_REQUIRED') from None
        raise Refused('APPLICATION_UPGRADE_FAILED_OLD_APPLICATION_RESTORED') from None


def apply(args):
    need(re.fullmatch(r'[-A-Za-z0-9_:.]{8,120}',args.approval_ref or ''),'APPLICATION_APPROVAL_REFERENCE_REQUIRED')
    plan = preflight(args)
    # The existing shared trial lock lives in root-owned sticky /run/lock.
    # O_NOFOLLOW + UID/mode/nlink validation rejects a pre-created foreign file.
    lock_parent = Path(plan['profile']['lock']).parent
    info = lock_parent.lstat()
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == OWNER
         and (info.st_mode & 0o022 == 0 or (lock_parent == Path('/run/lock')
              and stat.S_IMODE(info.st_mode) == 0o1777)), 'APPLICATION_LOCK_PARENT_UNSAFE')
    fd = os.open(plan['profile']['lock'],os.O_RDWR | os.O_CREAT | getattr(os,'O_NOFOLLOW',0),0o600)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER and stat.S_IMODE(info.st_mode) == 0o600
             and info.st_nlink == 1,'APPLICATION_LOCK_UNSAFE')
        fcntl.flock(fd,fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan = preflight(args)
        parent = ROOT/'application-upgrades'
        parent.mkdir(mode=0o700,exist_ok=True)
        D.owned_directory(parent,True)
        state = parent/('main-'+args.head[:12]+'-'+str(time.time_ns()))
        state.mkdir(mode=0o700)
        return cutover(plan,state,args.approval_ref)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',nargs='?',choices=('preflight','apply'),default='preflight')
    parser.add_argument('--release',required=True)
    parser.add_argument('--head',required=True)
    parser.add_argument('--tree',required=True)
    parser.add_argument('--ci-run-id',type=int,required=True)
    parser.add_argument('--manifest-sha256',required=True)
    parser.add_argument('--archive-sha256',required=True)
    parser.add_argument('--archive-bytes',type=int,required=True)
    parser.add_argument('--stage-receipt',required=True)
    parser.add_argument('--approval-ref')
    args = parser.parse_args()
    try:
        need(all(re.fullmatch(r'[a-f0-9]{40}',v) for v in (args.head,args.tree))
             and all(re.fullmatch(r'[a-f0-9]{64}',v) for v in (args.manifest_sha256,args.archive_sha256))
             and args.ci_run_id > 0,'APPLICATION_EXACT_PUBLIC_BINDING_REQUIRED')
        configure_shared()
        if args.action == 'apply':
            result = apply(args)
        else:
            plan = preflight(args)
            result = {'readOnly':True,'environment':'trial','sourceHead':plan['main']['sha'],
                      'migrationCountBefore':97,'migrationCountAfter':98,'versions':plan['versions'],
                      'sameHostSnapshotNotYetCreated':True,'deployed':False,'businessAdmissionGranted':False}
        print(json.dumps(result,sort_keys=True))
        return 0
    except Exception as error:
        value = str(error) if isinstance(error,Refused) else ''
        code = value if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}',value) else 'APPLICATION_UPGRADE_REVIEW_REQUIRED'
        print(json.dumps({'ok':False,'code':code,'privateValuesExported':False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
