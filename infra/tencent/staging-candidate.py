#!/usr/bin/env python3
"""Bounded staging deployment. Never migrates an existing database or production.

prepare ARCHIVE POLICY RUN_ID creates an isolated candidate; activate RUN_ID
switches only the two existing staging services. Secrets stay in root-owned
server configuration and are never included in stdout or evidence.
"""
import hashlib
import json
import os
import pathlib
import pwd
import re
import shlex
import signal
import socket
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path('/opt/cisme')
ENV = pathlib.Path('/etc/cisme/runtime.env')
CURRENT = ROOT / 'current'
SERVICES = ['cisme-staging-api', 'cisme-staging-worker']
SOURCE = 'ae31437652e2fe3fbb24e7ac493d3b60ad747d27'
ARCHIVE_SHA = '02b1538879f168abcf76a1b1cf43fe06777b2abe798c877acc8ddd4d3144cf58'
POLICY_SHA = '4cbbfd9f1b50ed4f9d02fbf80f0b5433bf371b10bc4aa3b60c67a39dbc1118a3'
OLD_API_SHA = '7df242062417c1190b5c714ba4a34fb46cf927508989514d9e9aa5c088ed7f8b'
EXPECTED_POLICY = {'terms': '2026-09-11-v4-staging', 'privacy': '2026-09-11-v7-staging-support'}


class Refused(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Refused(code)


def digest(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def run(args, *, label, cwd=None, env=None, data=None):
    result = subprocess.run(args, cwd=cwd, env=env, input=data, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=240)
    require(result.returncode == 0, label)
    return result.stdout


def parse_env(raw):
    result = {}
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        pieces = shlex.split(line, comments=False, posix=True)
        require(len(pieces) == 1 and '=' in pieces[0], 'ENV_FORMAT_UNSUPPORTED')
        key, value = pieces[0].split('=', 1)
        require(re.fullmatch(r'[A-Z][A-Z0-9_]*', key), 'ENV_KEY_INVALID')
        result[key] = value
    return result


def assert_target(hostname, config, old_hash):
    db = urllib.parse.urlsplit(config.get('DATABASE_URL', ''))
    require(hostname == 'VM-4-15-ubuntu', 'STAGING_HOST_REQUIRED')
    require(config.get('APP_ENV') == 'staging', 'STAGING_LABEL_REQUIRED')
    require(db.hostname == '127.0.0.1' and db.path == '/cisme_staging'
            and db.username == 'cisme_staging', 'EXACT_EXISTING_STAGING_IDENTITY_REQUIRED')
    require(config.get('OBJECT_STORAGE_DRIVER') == 'api_gateway', 'STAGING_LOCAL_STORAGE_REQUIRED')
    require(old_hash == OLD_API_SHA, 'EXISTING_RELEASE_DRIFT')


def safe_members(archive, manifest):
    expected = {'release-manifest.json', *manifest['hashes']}
    members = archive.getmembers()
    require(len(members) == len(expected), 'ARCHIVE_MEMBERS_MISMATCH')
    require(sum(m.size for m in members) < 20 * 1024 * 1024, 'ARCHIVE_TOO_LARGE')
    seen = set()
    for member in members:
        name = member.name
        require(name in expected and name not in seen and member.isfile()
                and not pathlib.PurePosixPath(name).is_absolute()
                and '..' not in pathlib.PurePosixPath(name).parts, 'ARCHIVE_MEMBER_UNSAFE')
        seen.add(name)
    return members


def validate_policy(documents):
    require(isinstance(documents, list) and len(documents) == 2, 'STAGING_POLICY_REQUIRED')
    require({d.get('type'): d.get('version') for d in documents} == EXPECTED_POLICY,
            'STAGING_POLICY_VERSION_MISMATCH')
    for document in documents:
        require(all(isinstance(document.get(k), str) and document[k].strip()
                    for k in ['title', 'body', 'operatorName', 'contact']), 'POLICY_FIELD_MISSING')


def own(path, mode=0o750):
    identity = pwd.getpwnam('cisme')
    os.chown(path, identity.pw_uid, identity.pw_gid)
    os.chmod(path, mode)


def write_private(path, data):
    with open(path, 'x', encoding='utf-8') as stream:
        os.chmod(path, 0o600)
        stream.write(data)


def as_cisme(args, *, label, cwd, env):
    # Environment is passed through the process API, never command-line argv.
    return run(['runuser', '-u', 'cisme', '--', *args], label=label, cwd=cwd, env=env)


def http_status(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (OSError, urllib.error.URLError):
        return 0


def wait_ready(url, process=None):
    for _ in range(40):
        require(process is None or process.poll() is None, 'CANDIDATE_PROCESS_EXITED')
        if http_status(url) == 200:
            return
        time.sleep(0.5)
    raise Refused('CANDIDATE_NOT_READY')


def verify_files(directory, manifest):
    require(manifest.get('sourceHead') == SOURCE and manifest.get('schemaVersion') == 1,
            'PINNED_SOURCE_REQUIRED')
    for name, sha in manifest['hashes'].items():
        require(not pathlib.PurePosixPath(name).is_absolute()
                and '..' not in pathlib.PurePosixPath(name).parts, 'MANIFEST_PATH_UNSAFE')
        require(digest(directory / name) == sha, 'CANDIDATE_HASH_MISMATCH')


def assert_candidate(config, database):
    db = urllib.parse.urlsplit(config.get('DATABASE_URL', ''))
    require(config.get('APP_ENV') == 'staging' and db.hostname == '127.0.0.1'
            and db.username == 'cisme_staging' and db.path == '/' + database
            and database.startswith('cisme_accept_rc20260922_'), 'FRESH_CANDIDATE_IDENTITY_REQUIRED')
    require(config.get('OBJECT_STORAGE_DRIVER') == 'api_gateway'
            and config.get('COMMERCE_ORDER_FLOW_ENABLED') == 'false'
            and config.get('ALLOW_DEV_ADAPTERS') == 'false'
            and config.get('API_LISTEN_HOST') == '127.0.0.1', 'CANDIDATE_SAFETY_CONFIG_REQUIRED')


def public_policies(url):
    with urllib.request.urlopen(url, timeout=5) as response:
        policies = json.load(response)['documents']
    require({d['document_type']: d['version'] for d in policies} == EXPECTED_POLICY,
            'PUBLIC_POLICY_MISMATCH')


def prepare(archive_path, policy_path, run_id):
    old_bytes = ENV.read_bytes()
    config = parse_env(old_bytes.decode())
    require(CURRENT.is_symlink(), 'CURRENT_SYMLINK_REQUIRED')
    assert_target(socket.gethostname(), config, digest(CURRENT / 'index.js'))
    require(digest(archive_path) == ARCHIVE_SHA, 'PINNED_ARCHIVE_REQUIRED')
    require(digest(policy_path) == POLICY_SHA, 'PINNED_POLICY_REQUIRED')
    documents = json.loads(pathlib.Path(policy_path).read_text())
    validate_policy(documents)
    state = ROOT / 'staging-acceptance' / run_id
    directory = ROOT / 'releases' / (run_id + '-' + SOURCE[:12])
    objects = ROOT / 'tmp' / run_id
    database = 'cisme_accept_' + run_id.replace('-', '_')
    require(len(database) <= 55, 'DATABASE_NAME_TOO_LONG')
    require(not any(p.exists() for p in [state, directory, objects]), 'RUN_ALREADY_EXISTS')
    state.mkdir(parents=True, mode=0o700)
    write_private(state / 'ownership.json', json.dumps({'runId': run_id,
                  'instanceId': 'lhins-ei4hz4fi', 'database': database,
                  'directory': str(directory), 'objects': str(objects),
                  'purpose': 'isolated-staging-acceptance', 'sourceHead': SOURCE}))
    directory.mkdir(mode=0o750)
    objects.mkdir(mode=0o750)
    own(directory)
    own(objects)
    with tarfile.open(archive_path, 'r:gz') as archive:
        manifest = json.load(archive.extractfile('release-manifest.json'))
        for member in safe_members(archive, manifest):
            target = directory / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(member).read())
    verify_files(directory, manifest)
    for path in directory.rglob('*'):
        own(path, 0o750 if path.is_dir() else 0o640)
    (directory / 'tmp').symlink_to(objects, target_is_directory=True)
    clean_env = {'PATH': os.environ['PATH'], 'HOME': str(objects), 'npm_config_cache': str(objects / 'npm-cache')}
    as_cisme(['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
             label='LOCKED_LINUX_DEPENDENCIES_FAILED', cwd=directory, env=clean_env)
    verify_files(directory, manifest)
    run(['runuser', '-u', 'postgres', '--', 'createdb', '--owner=cisme_staging', database],
        label='FRESH_DATABASE_CREATE_FAILED')
    db_url = urllib.parse.urlsplit(config['DATABASE_URL'])._replace(path='/' + database).geturl()
    # Existing data/objects and all money channels remain outside this candidate.
    candidate = {k: v for k, v in config.items()
                 if not k.startswith(('COMMERCE_', 'S3_', 'DATABASE_TLS_', 'PRIVACY_SYNTHETIC_'))}
    candidate.update({'DATABASE_URL': db_url, 'OBJECT_STORAGE_DRIVER': 'api_gateway',
                      'OBJECT_STORAGE_PROFILE': 'isolated-staging-' + run_id,
                      'COMMERCE_ORDER_FLOW_ENABLED': 'false', 'UGC_GO_LIVE_GATE': 'false',
                      'POINTS_REDEMPTION_ENABLED': 'false', 'POINTS_RULES_ENABLED': 'false',
                      'COS_DIRECT_UPLOAD_ENABLED': 'false', 'WECHAT_PHONE_BINDING_ENABLED': 'false',
                      'ALLOW_DEV_ADAPTERS': 'false', 'RUN_BACKGROUND_WORKER': 'false',
                      'API_LISTEN_HOST': '127.0.0.1', 'PORT': '3100',
                      'DATABASE_POOL_MAX': '5', 'SERVICE_INSTANCE_COUNT': '2',
                      'DATABASE_GLOBAL_CONNECTION_BUDGET': '20'})
    assert_candidate(candidate, database)
    process_env = {**clean_env, **candidate,
                   'CISME_MIGRATION_APPROVAL_REF': 'user-staging-deploy-20260922',
                   'CISME_PREDEPLOY_BACKUP_REF': 'fresh-isolated-empty:' + database}
    first = as_cisme(['node', str(directory / 'migrate.mjs'), 'up'],
                    label='CANDIDATE_MIGRATION_FAILED', cwd=directory, env=process_env)
    second = as_cisme(['node', str(directory / 'migrate.mjs'), 'up'],
                     label='CANDIDATE_REPEAT_MIGRATION_FAILED', cwd=directory, env=process_env)
    require(len(first.strip().splitlines()) == len(manifest['migrations']) and not second.strip(),
            'MIGRATION_COUNT_MISMATCH')
    publisher = '''import pg from 'pg'; import fs from 'node:fs';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
const client=await pool.connect();
try { await client.query('BEGIN');
if((await client.query('SELECT count(*)::int n FROM member')).rows[0].n!==0)throw Error('FRESH_TARGET_REQUIRED');
for(const d of JSON.parse(fs.readFileSync(0,'utf8'))) await client.query(
'INSERT INTO legal_document(document_type,version,title,body,operator_name,contact,active) VALUES($1,$2,$3,$4,$5,$6,true)',
[d.type,d.version,d.title,d.body,d.operatorName,d.contact]);
await client.query('COMMIT');
} finally {client.release(); await pool.end();}'''
    # Policy text travels via stdin, not argv or logs.
    run(['runuser', '-u', 'cisme', '--', 'node', '--input-type=module', '-e', publisher],
        label='STAGING_POLICY_PUBLISH_FAILED', cwd=directory, env=process_env,
        data=json.dumps(documents, ensure_ascii=False))
    write_private(state / 'old-runtime.env', old_bytes.decode())
    write_private(state / 'candidate.env', '\n'.join(k + '=' + json.dumps(v) for k, v in sorted(candidate.items())) + '\n')
    report = {'runId': run_id, 'instanceId': 'lhins-ei4hz4fi', 'sourceHead': SOURCE,
              'directory': str(directory), 'database': database, 'objectRoot': str(objects / 'object-storage'),
              'oldDirectory': str(CURRENT.resolve()), 'oldEnvSha256': hashlib.sha256(old_bytes).hexdigest(),
              'candidateEnvSha256': digest(state / 'candidate.env'),
              'policySha256': digest(policy_path), 'migrationApplied': len(manifest['migrations']),
              'migrationRepeated': 0, 'oldDatabaseTouched': False, 'productionTouched': False,
              'realMoneyEnabled': False, 'activated': False, 'releaseReady': False}
    # Temporary HTTP server binds loopback only; no public route changes in prepare.
    smoke_env = {**process_env, 'PORT': '3310'}
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 3310))
    process = subprocess.Popen(['runuser', '-u', 'cisme', '--', 'node', str(directory / 'index.js')],
                               cwd=directory, env=smoke_env, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        wait_ready('http://127.0.0.1:3310/health/ready', process)
        public_policies('http://127.0.0.1:3310/v1/legal')
        require(http_status('http://127.0.0.1:3310/v1/admin/runtime-metrics') == 401, 'METRICS_AUTH_FAILED')
        report['loopbackSmoke'] = {'health': 200, 'unauthenticatedMetrics': 401}
    finally:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
    write_private(state / 'prepared.json', json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


def activate(run_id):
    state = ROOT / 'staging-acceptance' / run_id
    report = json.loads((state / 'prepared.json').read_text())
    require(not report['activated'] and report['instanceId'] == 'lhins-ei4hz4fi', 'PREPARED_STAGING_REQUIRED')
    require(socket.gethostname() == 'VM-4-15-ubuntu', 'STAGING_HOST_REQUIRED')
    require(report['runId'] == run_id and report['sourceHead'] == SOURCE
            and not (state / 'activated.json').exists(), 'PREPARED_IDENTITY_REQUIRED')
    require(str(CURRENT.resolve()) == report['oldDirectory'] and digest(ENV) == report['oldEnvSha256'],
            'CURRENT_CONFIGURATION_DRIFT')
    directory = pathlib.Path(report['directory'])
    require(directory == ROOT / 'releases' / (run_id + '-' + SOURCE[:12]), 'CANDIDATE_PATH_REQUIRED')
    require(digest(state / 'candidate.env') == report['candidateEnvSha256'], 'CANDIDATE_ENV_DRIFT')
    assert_candidate(parse_env((state / 'candidate.env').read_text()), report['database'])
    verify_files(directory, json.loads((directory / 'release-manifest.json').read_text()))
    old_env = ENV.read_bytes()
    old_stat = ENV.stat()
    def switch(target, content, phase):
        link = ROOT / ('current-' + run_id + '-' + phase)
        require(not link.exists() and not link.is_symlink(), 'TEMP_LINK_EXISTS')
        temp = ENV.with_name('runtime-' + run_id + '-' + phase + '.env')
        with open(temp, 'xb') as output:
            os.chmod(temp, old_stat.st_mode & 0o777)
            os.chown(temp, old_stat.st_uid, old_stat.st_gid)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        link.symlink_to(target, target_is_directory=True)
        os.replace(temp, ENV)
        os.replace(link, CURRENT)
    try:
        run(['systemctl', 'stop', *SERVICES], label='STAGING_STOP_FAILED')
        switch(directory, (state / 'candidate.env').read_bytes(), 'activate')
        run(['systemctl', 'start', *SERVICES], label='STAGING_START_FAILED')
        wait_ready('https://staging-api.cisme.cn/health/ready')
        require(run(['systemctl', 'is-active', *SERVICES], label='STAGING_SERVICES_INACTIVE').split() == ['active', 'active'],
                'STAGING_SERVICES_INACTIVE')
        public_policies('https://staging-api.cisme.cn/v1/legal')
        require(http_status('https://staging-api.cisme.cn/v1/admin/runtime-metrics') == 401, 'PUBLIC_METRICS_AUTH_FAILED')
    except Exception:
        run(['systemctl', 'stop', *SERVICES], label='ROLLBACK_STOP_FAILED')
        switch(report['oldDirectory'], old_env, 'rollback')
        run(['systemctl', 'start', *SERVICES], label='ROLLBACK_START_FAILED')
        wait_ready('https://staging-api.cisme.cn/health/ready')
        raise Refused('STAGING_ACTIVATION_FAILED_OLD_RELEASE_RESTORED')
    report.update({'activated': True, 'verifiedPublicHttps': 200, 'publicMetricsUnauthenticated': 401,
                   'publishedPolicies': EXPECTED_POLICY})
    write_private(state / 'activated.json', json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


def main():
    require(os.geteuid() == 0, 'ROOT_FOR_BOUNDED_DEPLOY_REQUIRED')
    require(len(sys.argv) >= 3 and re.fullmatch(r'rc20260922-[a-f0-9]{8}', sys.argv[-1]), 'RUN_ID_INVALID')
    if sys.argv[1] == 'prepare' and len(sys.argv) == 5:
        prepare(sys.argv[2], sys.argv[3], sys.argv[4])
    elif sys.argv[1] == 'activate' and len(sys.argv) == 3:
        activate(sys.argv[2])
    else:
        raise Refused('USAGE_PREPARE_ARCHIVE_POLICY_RUN_OR_ACTIVATE_RUN')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'code': str(error) if isinstance(error, Refused) else 'STAGING_DEPLOY_FAILED_REVIEW_REQUIRED'}))
        sys.exit(1)
