#!/usr/bin/env python3
"""Install an isolated trial runtime on the existing production host.

Default preflight is read-only. Apply creates only the owned trial user/database,
configuration and systemd units plus access rules for only the new database role.
It never changes production data/runtime, DNS, TLS or Nginx.
Code is copied from the pinned, already deployed production release, not rebuilt.
No production rows, money grants, storage credentials or private keys are copied.
An interrupted partial database/migration requires review; nothing is reset.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import socket
import stat
import subprocess
import time
import urllib.request

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('trial_observation', HERE / 'production-observation.py')
observation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observation)
require = observation.target.require
ROOT = Path('/opt/cisme-trial')
LIVE = Path('/opt/cisme/runtime.env')
PRODUCTION_CURRENT = Path('/opt/cisme/current')
NODE = '/opt/node-v24.14.0-linux-x64/bin/node'
USER = 'cisme-trial'
DATABASE = ROLE = 'cisme_trial'
SOURCE_HEAD = '751f7407af4e525c5b6c09c6997800acfb4048fc'
SOURCE_TREE = 'd23e42b55843000ac5e97af108f404e7a12e92e8'
MIGRATIONS = 97
DOMAIN = 'staging-api.cisme.cn'
UNIT_ROOT = Path('/etc/systemd/system')
UNITS = ('cisme-trial-api.service', 'cisme-trial-worker.service')
CLEAN_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}
SECRET_KEYS = ('APP_SESSION_SECRET', 'UPLOAD_TOKEN_SECRET', 'CONTACT_ENCRYPTION_KEY',
               'CONTACT_HASH_KEY', 'PRIVACY_FORMAL_EXPORT_KEY')
CLOSED = {'APP_ENV': 'staging', 'ALLOW_DEV_ADAPTERS': 'false',
          'API_LISTEN_HOST': '127.0.0.1', 'PORT': '3101',
          'OBJECT_STORAGE_DRIVER': 'api_gateway', 'OBJECT_STORAGE_PROFILE': 'production-host-isolated-trial',
          'RUN_BACKGROUND_WORKER': 'false', 'CISME_MIGRATION_READ_ONLY': 'false',
          'COMMERCE_ORDER_FLOW_ENABLED': 'false', 'COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED': 'false',
          'COMMERCE_SIMULATED_PAYMENT_ENABLED': 'false', 'COMMERCE_FULFILLMENT_ENABLED': 'false',
          'UGC_GO_LIVE_GATE': 'false', 'UGC_SCAN_WORKER_MODE': 'embedded',
          'POINTS_REDEMPTION_ENABLED': 'false', 'POINTS_RULES_ENABLED': 'false',
          'COS_DIRECT_UPLOAD_ENABLED': 'false', 'WECHAT_PHONE_BINDING_ENABLED': 'false',
          'DATABASE_POOL_MAX': '3', 'SERVICE_INSTANCE_COUNT': '2',
          'DATABASE_GLOBAL_CONNECTION_BUDGET': '6', 'LOG_LEVEL': 'info', 'CONTACT_KEY_VERSION': 'trial-v1'}
HBA_BLOCK = ("# BEGIN CISME ISOLATED TRIAL\n"
             "host cisme_trial cisme_trial 127.0.0.1/32 scram-sha-256\n"
             "local all cisme_trial reject\n"
             "host all cisme_trial 0.0.0.0/0 reject\n"
             "host all cisme_trial ::/0 reject\n"
             "# END CISME ISOLATED TRIAL\n").encode()


def utc():
    return datetime.now(timezone.utc).isoformat()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.digest()


def command(args, *, input_data=None, env=None, cwd=None, timeout=30):
    result = subprocess.run(args, input=input_data, env=env or CLEAN_ENV, cwd=cwd,
                            capture_output=True, timeout=timeout)
    require(result.returncode == 0 and len(result.stdout) <= 1024 * 1024, 'TRIAL_COMMAND_FAILED')
    return result.stdout


def protected(path, max_bytes=65536, readable_group=False, public=False):
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(fd)
        mask = 0o022 if public else (0o027 if readable_group else 0o077)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_mode & mask == 0
                and info.st_size <= max_bytes, 'TRIAL_PROTECTED_FILE_REQUIRED')
        data = os.read(fd, max_bytes + 1)
        require(len(data) == info.st_size, 'TRIAL_FILE_CHANGED')
        return data
    finally:
        os.close(fd)


def checked_directory(path):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o022 == 0,
            'TRIAL_DIRECTORY_UNSAFE')


def dependency_digest(directory, required_uid=0):
    """Bind every copied dependency; reject links escaping node_modules."""
    checked_directory(directory)
    digest = hashlib.sha256()
    count = 0
    total = 0
    for parent, names, files in os.walk(directory, followlinks=False):
        names.sort()
        for name in sorted(names + files):
            path = Path(parent) / name
            relative = path.relative_to(directory).as_posix()
            info = path.lstat()
            require(info.st_uid == required_uid and (stat.S_ISLNK(info.st_mode) or info.st_mode & 0o022 == 0), 'TRIAL_DEPENDENCY_UNSAFE')
            if stat.S_ISLNK(info.st_mode):
                require(not Path(os.readlink(path)).is_absolute() and path.resolve().is_relative_to(directory),
                        'TRIAL_DEPENDENCY_LINK_UNSAFE')
                value = b'link:' + os.readlink(path).encode()
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
                require(total <= 1024 ** 3, 'TRIAL_DEPENDENCY_SIZE_EXCEEDED')
                value = b'file:' + file_sha(path)
            else:
                require(stat.S_ISDIR(info.st_mode), 'TRIAL_DEPENDENCY_UNSAFE')
                value = b'directory'
            digest.update(relative.encode() + b'\0' + value + b'\0')
            count += 1
            require(count <= 30000, 'TRIAL_DEPENDENCY_SIZE_EXCEEDED')
    return digest.hexdigest()


def verified_source(source):
    source = Path(source)
    require(source.is_absolute() and '..' not in source.parts and not source.is_symlink()
            and source.parent == Path('/opt/cisme/releases')
            and PRODUCTION_CURRENT.is_symlink() and PRODUCTION_CURRENT.resolve() == source,
            'TRIAL_DEPLOYED_SOURCE_REQUIRED')
    for directory in (Path('/opt'), Path('/opt/cisme'), source.parent, source):
        checked_directory(directory)
    manifest_bytes = protected(source / 'release-manifest.json', 1024 * 1024, readable_group=True)
    manifest = json.loads(manifest_bytes, object_pairs_hook=observation.target.unique_keys)
    require(manifest.get('schemaVersion') == 1 and manifest.get('sourceHead') == SOURCE_HEAD
            and manifest.get('sourceTree') == SOURCE_TREE and manifest.get('configurationIncluded') is False
            and len(manifest.get('migrations', [])) == MIGRATIONS, 'TRIAL_SOURCE_BINDING_REQUIRED')
    # The existing runner validates all API/worker/lock/migration bytes and the
    # exact migration file set before importing pg or connecting to any database.
    result = json.loads(command([NODE, str(source / 'migrate.mjs'), 'verify'], timeout=60))
    require(result.get('verified') is True and result.get('sourceHead') == SOURCE_HEAD
            and result.get('sourceTree') == SOURCE_TREE and result.get('migrations') == MIGRATIONS,
            'TRIAL_FULL_ARTIFACT_REQUIRED')
    return {'release': str(source), 'sourceHead': SOURCE_HEAD, 'sourceTree': SOURCE_TREE,
            'manifestSha256': sha(manifest_bytes), 'dependenciesSha256': dependency_digest(source / 'node_modules')}


def copied_release(source):
    """Copy only approved artifacts/dependencies; never configuration or tmp."""
    directory = ROOT / 'releases' / SOURCE_HEAD
    manifest = json.loads(protected(Path(source['release']) / 'release-manifest.json', 1024 * 1024, readable_group=True))
    if not directory.parent.exists():
        directory.parent.mkdir(mode=0o755)
        os.chmod(directory.parent, 0o755)
    checked_directory(directory.parent)
    if directory.exists() or directory.is_symlink():
        checked_directory(directory)
    else:
        directory.mkdir(parents=True, mode=0o755)
        os.chmod(directory, 0o755)
    for relative in list(manifest['hashes']) + ['release-manifest.json']:
        path = directory / relative
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        for parent in (directory, *path.relative_to(directory).parents):
            if parent == Path('.'):
                continue
            absolute = parent if parent.is_absolute() else directory / parent
            checked_directory(absolute)
            os.chmod(absolute, 0o755)
        data = (Path(source['release']) / relative).read_bytes()
        expected = source['manifestSha256'] if relative == 'release-manifest.json' else manifest['hashes'][relative]
        require(sha(data) == expected, 'TRIAL_COPY_SOURCE_DRIFT')
        existing_file(path, data, mode=0o644)
    modules = directory / 'node_modules'
    if not modules.exists():
        temporary = directory / '.node_modules-copy'
        require(not temporary.exists() and not temporary.is_symlink(), 'TRIAL_PARTIAL_DEPENDENCY_COPY_REVIEW_REQUIRED')
        shutil.copytree(Path(source['release']) / 'node_modules', temporary, symlinks=True)
        for parent, names, files in os.walk(temporary, followlinks=False):
            os.chmod(parent, 0o755)
            for name in names + files:
                path = Path(parent) / name
                if not path.is_symlink():
                    os.chmod(path, 0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
        require(dependency_digest(temporary) == source['dependenciesSha256'], 'TRIAL_COPIED_DEPENDENCY_DRIFT')
        temporary.rename(modules)
    require(dependency_digest(modules) == source['dependenciesSha256'], 'TRIAL_COPIED_DEPENDENCY_DRIFT')
    expected_names = {Path(relative).parts[0] for relative in manifest['hashes']} | {'release-manifest.json', 'node_modules'}
    require({path.name for path in directory.iterdir()} == expected_names, 'TRIAL_UNKNOWN_RELEASE_FILE')
    result = json.loads(command([NODE, str(directory / 'migrate.mjs'), 'verify'], timeout=60))
    require(result.get('verified') is True and result.get('sourceHead') == SOURCE_HEAD, 'TRIAL_COPIED_ARTIFACT_DRIFT')
    return directory


def production_wechat():
    config = observation.audit.environment(protected(LIVE, readable_group=True).decode())
    require(config.get('APP_ENV') == 'production' and config.get('WECHAT_APP_ID') == 'wx4eac2d4fb11d299b'
            and re.fullmatch(r'[A-Za-z0-9_-]{16,128}', config.get('WECHAT_APP_SECRET', '')),
            'TRIAL_PRODUCTION_WECHAT_REQUIRED')
    # Return only these two fields; all other production configuration is discarded.
    return {key: config[key] for key in ('WECHAT_APP_ID', 'WECHAT_APP_SECRET')}


def query(sql, database='postgres'):
    require(database in ('postgres', DATABASE), 'TRIAL_DATABASE_REFUSED')
    return command(['runuser', '-u', 'postgres', '--', 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1',
                    '-d', database], input_data=(sql + '\n').encode()).decode().strip()


def hba_observation():
    path = Path(query('SHOW hba_file'))
    require(path.is_absolute() and not path.is_symlink() and '..' not in path.parts,
            'TRIAL_HBA_PATH_UNSAFE')
    postgres_uid = pwd.getpwnam('postgres').pw_uid
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, postgres_uid) and info.st_mode & 0o022 == 0,
                'TRIAL_HBA_PARENT_UNSAFE')
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid in (0, postgres_uid) and info.st_mode & 0o022 == 0
                and info.st_size <= 1024 * 1024, 'TRIAL_HBA_FILE_UNSAFE')
        data = os.read(fd, 1024 * 1024 + 1)
        require(len(data) == info.st_size, 'TRIAL_HBA_FILE_CHANGED')
    finally:
        os.close(fd)
    return path, data, info


def hba_content(original):
    require(b'CISME ISOLATED TRIAL' not in original and b'cisme_trial' not in original,
            'TRIAL_UNKNOWN_HBA_RULE_EXISTS')
    return HBA_BLOCK + original


def install_hba():
    """Only new-role rules precede original bytes; preserve a protected backup."""
    path, data, info = hba_observation()
    backup = ROOT / 'original-pg-hba.conf'
    if backup.exists():
        original = protected(backup, 1024 * 1024)
        require(data in (original, hba_content(original)), 'TRIAL_HBA_DRIFT')
    else:
        original = data
        hba_content(original)
        existing_file(backup, original)
    expected = hba_content(original)
    if data != expected:
        temporary = path.with_name('.cisme-trial-pg-hba.conf')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            os.fchown(fd, info.st_uid, info.st_gid)
            os.fchmod(fd, stat.S_IMODE(info.st_mode))
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(expected)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            os.close(fd)
        require(hba_observation()[1] == original, 'TRIAL_HBA_CHANGED_BEFORE_INSTALL')
        os.replace(temporary, path)
    require(query('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL') == '0', 'TRIAL_HBA_RULE_PARSE_FAILED')
    require(query('SELECT pg_reload_conf()') == 't', 'TRIAL_HBA_RELOAD_FAILED')


def connection_isolation(config):
    password = config['DATABASE_URL'].split(':', 2)[2].split('@', 1)[0]
    env = {**CLEAN_ENV, 'PGHOST': '127.0.0.1', 'PGPORT': '5432', 'PGUSER': ROLE,
           'PGPASSWORD': password, 'PGCONNECT_TIMEOUT': '3', 'PGSSLMODE': 'disable'}
    require(command(['psql', '-XAt', '-d', DATABASE, '-c', 'SELECT current_database()'], env=env).decode().strip() == DATABASE,
            'TRIAL_DATABASE_AUTHENTICATION_FAILED')
    denied = subprocess.run(['psql', '-XAt', '-d', 'cisme', '-c', 'SELECT true'], env=env, capture_output=True, timeout=5)
    require(denied.returncode != 0 and b'pg_hba.conf rejects connection' in denied.stderr,
            'TRIAL_PRODUCTION_DATABASE_ISOLATION_FAILED')


def resources():
    result = json.loads(query("SELECT json_build_object('role', EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cisme_trial'),"
                              "'database', EXISTS(SELECT 1 FROM pg_database WHERE datname='cisme_trial'))"))
    try:
        account = pwd.getpwnam(USER)
        result['user'] = True
        result['userSafe'] = account.pw_uid < 1000 and account.pw_uid > 0 and account.pw_dir == str(ROOT) and account.pw_shell == '/usr/sbin/nologin'
    except KeyError:
        result['user'] = False
    result['units'] = any((UNIT_ROOT / unit).exists() or (UNIT_ROOT / unit).is_symlink() for unit in UNITS)
    return result


def marker(source):
    if not ROOT.exists() and not ROOT.is_symlink():
        return None
    checked_directory(ROOT)
    record = json.loads(protected(ROOT / 'ownership.json'), object_pairs_hook=observation.target.unique_keys)
    require(record.get('kind') == 'cisme-isolated-trial' and record.get('schemaVersion') == 1
            and record.get('instanceId') == 'lhins-61ikz4mi' and record.get('root') == str(ROOT)
            and record.get('database') == DATABASE and record.get('role') == ROLE and record.get('user') == USER
            and record.get('source') == source and re.fullmatch(r'[a-f0-9]{32}', record.get('ownershipId', '')),
            'TRIAL_OWNERSHIP_REQUIRED')
    return record


def db_owned(record):
    tag = 'CISME-TRIAL:' + record['ownershipId']
    result = json.loads(query("SELECT json_build_object('roleTag', shobj_description(r.oid,'pg_authid'),"
                              "'databaseTag', shobj_description(d.oid,'pg_database'),'owner', pg_get_userbyid(d.datdba),"
                              "'superuser',r.rolsuper,'createdb',r.rolcreatedb,'createrole',r.rolcreaterole,'replication',r.rolreplication,"
                              "'bypassrls',r.rolbypassrls,'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=r.oid)) "
                              "FROM pg_roles r CROSS JOIN pg_database d WHERE r.rolname='cisme_trial' AND d.datname='cisme_trial'"))
    require(result['roleTag'] == tag and result['databaseTag'] == tag and result['owner'] == ROLE
            and not any(result[key] for key in ('superuser', 'createdb', 'createrole', 'replication', 'bypassrls', 'memberships')),
            'TRIAL_DATABASE_OWNERSHIP_REQUIRED')


def unit_text(kind, source):
    require(kind in ('api', 'worker'), 'TRIAL_UNIT_KIND_REQUIRED')
    entry = 'index.js' if kind == 'api' else 'worker.js'
    return f'''[Unit]
Description=CISME isolated trial {kind}
After=network-online.target postgresql.service
Requires=postgresql.service
ConditionPathExists={ROOT}/migration-complete.json
[Service]
Type=simple
User={USER}
Group={USER}
WorkingDirectory={ROOT}
EnvironmentFile={ROOT}/runtime.env
Environment=TMPDIR={ROOT}/tmp
ExecStart={NODE} {source}/{entry}
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={ROOT}/tmp {ROOT}/privacy-suppression
MemoryMax=384M
CPUQuota=40%
TasksMax=128
UMask=0077
[Install]
WantedBy=multi-user.target
'''


def nginx_template():
    return f'''# Review/enable separately after DNS and TLS are ready. This script does not install it.
server {{
    listen 443 ssl;
    server_name {DOMAIN};
    ssl_certificate /etc/letsencrypt/live/{DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    server_tokens off;
    client_max_body_size 11m;
    add_header X-Content-Type-Options nosniff always;
    location / {{
        proxy_pass http://127.0.0.1:3101;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }}
}}
'''


def candidate_config(wechat):
    result = {**CLOSED, **wechat, **{key: secrets.token_hex(32) for key in SECRET_KEYS},
              'DATABASE_URL': f'postgresql://{ROLE}:{secrets.token_hex(32)}@127.0.0.1:5432/{DATABASE}',
              'PRIVACY_SUPPRESSION_DIR': str(ROOT / 'privacy-suppression')}
    return result


def validate_config(config, wechat):
    allowed = set(CLOSED) | set(SECRET_KEYS) | {'DATABASE_URL', 'WECHAT_APP_ID', 'WECHAT_APP_SECRET', 'PRIVACY_SUPPRESSION_DIR'}
    require(set(config) == allowed and all(config.get(key) == value for key, value in CLOSED.items())
            and all(config.get(key) == value for key, value in wechat.items())
            and config.get('PRIVACY_SUPPRESSION_DIR') == str(ROOT / 'privacy-suppression')
            and all(re.fullmatch(r'[a-f0-9]{64}', config.get(key, '')) for key in SECRET_KEYS)
            and len({config[key] for key in SECRET_KEYS}) == len(SECRET_KEYS)
            and re.fullmatch(r'postgresql://cisme_trial:[a-f0-9]{64}@127\.0\.0\.1:5432/cisme_trial', config.get('DATABASE_URL', '')),
            'TRIAL_CONFIGURATION_REQUIRED')


def existing_file(path, expected, *, group=None, mode=0o600):
    """Exclusive creation or byte-identical reuse, never overwrite an unknown file."""
    if path.exists() or path.is_symlink():
        require(protected(path, max(65536, len(expected)), readable_group=mode == 0o640, public=mode == 0o644) == expected,
                'TRIAL_EXISTING_FILE_DRIFT')
        info = path.stat()
        require(stat.S_IMODE(info.st_mode) == mode and (group is None or info.st_gid == group),
                'TRIAL_EXISTING_FILE_MODE_DRIFT')
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), mode)
    try:
        if group is not None:
            os.fchown(fd, 0, group)
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(expected)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(fd)


def preflight(source_release):
    require(os.geteuid() == 0, 'TRIAL_ROOT_REQUIRED')
    identity = observation.identity()
    source = verified_source(source_release)
    wechat = production_wechat()
    record = marker(source)
    found = resources()
    _, hba, _ = hba_observation()
    if record is None:
        require(not any(found[key] for key in ('user', 'role', 'database', 'units')), 'TRIAL_UNKNOWN_TARGET_EXISTS')
        # Refuse an occupied loopback port before creating any resources.
        with socket.socket() as check:
            require(check.connect_ex(('127.0.0.1', 3101)) != 0, 'TRIAL_PORT_OCCUPIED')
        hba_content(hba)
    else:
        require(not found['user'] or found.get('userSafe') is True, 'TRIAL_USER_DRIFT')
        if found['role'] or found['database']:
            require(found['role'] and found['database'], 'TRIAL_PARTIAL_DATABASE_REVIEW_REQUIRED')
            db_owned(record)
        if (ROOT / 'runtime.env').exists():
            validate_config(observation.audit.environment(protected(ROOT / 'runtime.env', readable_group=True).decode()), wechat)
        for kind, unit in zip(('api', 'worker'), UNITS):
            path = UNIT_ROOT / unit
            if path.exists() or path.is_symlink():
                require(protected(path, public=True) == unit_text(kind, str(ROOT / 'releases' / SOURCE_HEAD)).encode(), 'TRIAL_UNIT_DRIFT')
        if (ROOT / 'original-pg-hba.conf').exists():
            original = protected(ROOT / 'original-pg-hba.conf', 1024 * 1024)
            require(hba in (original, hba_content(original)), 'TRIAL_HBA_DRIFT')
        else:
            hba_content(hba)
    return {'schemaVersion': 1, 'readOnly': True, 'instanceId': identity['instanceId'], 'source': source,
            'database': DATABASE, 'root': str(ROOT), 'ownedExistingTarget': record is not None,
            'productionChanged': False, 'networkChanged': False, 'deployed': False}


def runtime_status(source, config):
    uid = pwd.getpwnam(USER).pw_uid
    for kind, unit in zip(('api', 'worker'), UNITS):
        pid = command(['systemctl', 'show', unit, '--property=MainPID', '--value']).decode().strip()
        require(re.fullmatch(r'[1-9][0-9]*', pid), 'TRIAL_SERVICE_NOT_RUNNING')
        process = Path('/proc') / pid
        require(process.stat().st_uid == uid and (process / 'cwd').resolve() == ROOT,
                'TRIAL_RUNNING_PROCESS_MISMATCH')
        args = (process / 'cmdline').read_bytes().split(b'\0')
        entry = 'index.js' if kind == 'api' else 'worker.js'
        require(args[:2] == [NODE.encode(), (source + '/' + entry).encode()], 'TRIAL_RUNNING_PROCESS_MISMATCH')
        observed = dict(item.split('=', 1) for item in (process / 'environ').read_text().split('\0') if '=' in item)
        require(all(observed.get(key) == value for key, value in config.items()), 'TRIAL_RUNNING_ENVIRONMENT_MISMATCH')
    with urllib.request.urlopen('http://127.0.0.1:3101/health/ready', timeout=3) as response:
        require(response.status == 200, 'TRIAL_NOT_READY')
    heartbeat = json.loads((ROOT / 'tmp/cisme-worker-heartbeat.json').read_text())
    at = datetime.fromisoformat(heartbeat['completedAtUtc'].replace('Z', '+00:00'))
    require(0 <= time.time() - at.timestamp() <= 120, 'TRIAL_WORKER_HEARTBEAT_REQUIRED')


def apply(source_release, approval_ref):
    require(re.fullmatch(r'[-A-Za-z0-9_:.]{8,120}', approval_ref or ''), 'TRIAL_APPROVAL_REFERENCE_REQUIRED')
    preflight(source_release)
    lock_path = Path('/run/lock/cisme-production-trial.lock')
    fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o077 == 0, 'TRIAL_LOCK_UNSAFE')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan = preflight(source_release)
        source = plan['source']
        record = marker(source)
        if record is None:
            ROOT.mkdir(mode=0o755)
            os.chmod(ROOT, 0o755)
            record = {'schemaVersion': 1, 'kind': 'cisme-isolated-trial', 'instanceId': 'lhins-61ikz4mi',
                      'root': str(ROOT), 'database': DATABASE, 'role': ROLE, 'user': USER, 'source': source,
                      'ownershipId': secrets.token_hex(16), 'createdAtUtc': utc(), 'approvalReference': approval_ref}
            existing_file(ROOT / 'ownership.json', (json.dumps(record, sort_keys=True) + '\n').encode())
        if not resources()['user']:
            command(['useradd', '--system', '--user-group', '--home-dir', str(ROOT), '--no-create-home',
                     '--shell', '/usr/sbin/nologin', USER])
        account = pwd.getpwnam(USER)
        require(resources().get('userSafe'), 'TRIAL_USER_DRIFT')
        for directory in (ROOT / 'tmp', ROOT / 'tmp/object-storage', ROOT / 'privacy-suppression'):
            if not directory.exists():
                directory.mkdir(mode=0o700)
                os.chown(directory, account.pw_uid, account.pw_gid)
            info = directory.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == account.pw_uid
                    and info.st_gid == account.pw_gid and stat.S_IMODE(info.st_mode) == 0o700, 'TRIAL_DATA_DIRECTORY_DRIFT')
        env_path = ROOT / 'runtime.env'
        wechat = production_wechat()
        config = observation.audit.environment(protected(env_path, readable_group=True).decode()) if env_path.exists() else candidate_config(wechat)
        validate_config(config, wechat)
        existing_file(env_path, ''.join(f'{key}={value}\n' for key, value in sorted(config.items())).encode(),
                      group=account.pw_gid, mode=0o640)
        runtime_release = copied_release(source)
        # No services are installed yet; only the fresh, tagged trial DB is eligible.
        found = resources()
        if not found['role'] and not found['database']:
            password = config['DATABASE_URL'].split(':', 2)[2].split('@', 1)[0]
            tag = 'CISME-TRIAL:' + record['ownershipId']
            # Secrets are supplied through stdin, never argv, receipts or console.
            query(f"BEGIN; SET LOCAL password_encryption='scram-sha-256'; CREATE ROLE {ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '{password}'; "
                  f"COMMENT ON ROLE {ROLE} IS '{tag}'; COMMIT;")
            query(f'CREATE DATABASE {DATABASE} OWNER {ROLE} TEMPLATE template0;')
            query(f"COMMENT ON DATABASE {DATABASE} IS '{tag}'; REVOKE ALL ON DATABASE {DATABASE} FROM PUBLIC;")
        db_owned(record)
        install_hba()
        for attempt in range(20):
            try:
                connection_isolation(config)
                break
            except Exception:
                if attempt == 19:
                    raise
                time.sleep(0.1)
        completed_path = ROOT / 'migration-complete.json'
        if not completed_path.exists():
            require(not any((UNIT_ROOT / unit).exists() for unit in UNITS), 'TRIAL_MIGRATION_SERVICES_ALREADY_INSTALLED')
            require(query("SELECT count(*) FROM pg_tables WHERE schemaname='public'", DATABASE) == '0',
                    'TRIAL_PARTIAL_MIGRATION_REVIEW_REQUIRED')
            empty = {'kind': 'new-empty-trial-database', 'ownershipId': record['ownershipId'], 'source': source,
                     'database': DATABASE, 'publicTablesBeforeMigration': 0}
            existing_file(ROOT / 'empty-database.json', (json.dumps(empty, sort_keys=True) + '\n').encode())
            migration_env = {**CLEAN_ENV, 'DATABASE_URL': config['DATABASE_URL'],
                             'CISME_MIGRATION_APPROVAL_REF': approval_ref,
                             'CISME_PREDEPLOY_BACKUP_REF': 'TRIAL-EMPTY-' + record['ownershipId']}
            command([NODE, str(runtime_release / 'migrate.mjs'), 'up'], env=migration_env, cwd=ROOT, timeout=600)
            require(query('SELECT count(*) FROM schema_migration', DATABASE) == str(MIGRATIONS), 'TRIAL_MIGRATION_COUNT_MISMATCH')
            existing_file(completed_path, (json.dumps(empty | {'migrations': MIGRATIONS}, sort_keys=True) + '\n').encode())
        else:
            completed = json.loads(protected(completed_path))
            require(completed.get('ownershipId') == record['ownershipId'] and completed.get('source') == source
                    and completed.get('migrations') == MIGRATIONS
                    and query('SELECT count(*) FROM schema_migration', DATABASE) == str(MIGRATIONS), 'TRIAL_MIGRATION_RECORD_DRIFT')
        # Check runtime read access without granting the trial user membership in
        # the production group (which would expose production runtime secrets).
        for entry in ('index.js', 'worker.js'):
            command(['runuser', '-u', USER, '--', NODE, '--check', str(runtime_release / entry)], cwd=ROOT)
        command(['runuser', '-u', USER, '--', NODE, '--input-type=module', '-e',
                 "import {createRequire} from 'node:module';const sharp=createRequire(process.argv[1])('sharp');if(!sharp.versions?.vips)process.exit(1)",
                 str(runtime_release / 'index.js')], cwd=ROOT)
        for kind, unit in zip(('api', 'worker'), UNITS):
            existing_file(UNIT_ROOT / unit, unit_text(kind, str(runtime_release)).encode(), mode=0o644)
        existing_file(ROOT / 'nginx-trial.conf.template', nginx_template().encode(), mode=0o644)
        command(['systemctl', 'daemon-reload'])
        command(['systemctl', 'enable', '--now', *UNITS])
        for attempt in range(30):
            try:
                runtime_status(str(runtime_release), config)
                break
            except Exception:
                if attempt == 29:
                    raise
                time.sleep(0.5)
        legal_ready = query("SELECT count(DISTINCT document_type) FROM legal_document WHERE document_type IN ('terms','privacy') AND active=true", DATABASE) == '2'
        return {'deployed': True, 'sourceHead': SOURCE_HEAD, 'instanceId': 'lhins-61ikz4mi',
                'database': DATABASE, 'loopbackReady': True, 'independentWorkerReady': True,
                'legalDocumentsReady': legal_ready, 'realWeChatLoginVerified': False,
                'publicHttpsReady': False, 'dnsTlsNginxActivationRequired': True,
                'productionDataChanged': False, 'trialRoleDatabaseAccessRestricted': True,
                'moneyEnabled': False, 'publicUgcEnabled': False}
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', nargs='?', choices=('preflight', 'apply'), default='preflight')
    parser.add_argument('--source-release', required=True, help='Absolute deployed 751f release directory, not /opt/cisme/current')
    parser.add_argument('--approval-ref')
    args = parser.parse_args()
    try:
        result = apply(args.source_release, args.approval_ref) if args.command == 'apply' else preflight(args.source_release)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        # Never print parser/driver errors, connection strings or private config.
        code = str(error) if isinstance(error, observation.target.Refused) else 'ISOLATED_TRIAL_REVIEW_REQUIRED'
        print(json.dumps({'ok': False, 'code': code, 'productionChanged': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
