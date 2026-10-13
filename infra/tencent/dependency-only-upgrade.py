#!/usr/bin/env python3
"""Preserve-data upgrade for the specifically reviewed Fastify/Sharp patch.

Read-only preflight by default. Never invokes migrations, restores, npm, DNS,
database provisioning or credential/configuration changes. Runtime bytes and
every SQL byte must match the currently running immutable release exactly.
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
import pwd
import re
import stat
import time
import urllib.request

HERE = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


general = module('dependency_upgrade_general', 'production-release.py')
trial = module('dependency_upgrade_trial', 'production-trial.py')
NODE = general.NODE
OWNER = 0
PACKAGE_PERMIT = '64eb8819e2c7ae109586daa3fe6108d3079a21f0bc2f21f719cd970efe5e75f5'
LOCK_PERMIT = 'd86ed2df5d94478e0a189393dba1ce10207ecf50cd77f0ca0b6f172247399be9'
PATCHES = {'fastify': ('5.12.3', '5.12.5'), 'sharp': ('0.35.4', '0.35.5')}
CLOSED_FLAGS = ('COMMERCE_ORDER_FLOW_ENABLED',
                'COMMERCE_SIMULATED_PAYMENT_ENABLED', 'COMMERCE_SIMULATED_TRANSFER_ENABLED',
                'POINTS_REDEMPTION_ENABLED', 'POINTS_RULES_ENABLED', 'UGC_GO_LIVE_GATE')
PREPARATION_FLAGS = ('COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED', 'COMMERCE_FULFILLMENT_ENABLED')
ENTRIES = ('index.js', 'worker.js', 'worker-once.js', 'migrate.mjs')
PROFILES = {
    'production': {'root': '/opt/cisme', 'user': 'cisme', 'database': 'cisme',
                   'domain': 'api.cisme.cn', 'units': ('cisme-api.service', 'cisme-worker.service'),
                   'lock': '/opt/cisme/.production-upgrade.lock'},
    'trial': {'root': '/opt/cisme-trial', 'user': 'cisme-trial', 'database': 'cisme_trial',
              'domain': 'staging-api.cisme.cn', 'units': ('cisme-trial-api.service', 'cisme-trial-worker.service'),
              'lock': '/run/lock/cisme-production-trial.lock'},
}
CLEAN = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}


class Refused(RuntimeError):
    pass


def require(value, code):
    if not value:
        raise Refused(code)


def closed_context(profile, values):
    return (values.get('ALLOW_DEV_ADAPTERS') == 'false'
            and all(values.get(key, 'false') == 'false' for key in CLOSED_FLAGS)
            and (profile['name'] == 'production'
                 or all(values.get(key, 'false') == 'false' for key in PREPARATION_FLAGS)))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def command(args, **kwargs):
    # The shared wrapper captures stderr and never exports driver/SDK failures.
    return general.command(args, env=kwargs.pop('env', CLEAN), **kwargs)


def owned_directory(path, private=False):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == OWNER
            and info.st_mode & (0o077 if private else 0o022) == 0, 'DEPENDENCY_DIRECTORY_UNSAFE')


def read_owned(path, limit=20 * 1024 * 1024, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER
                and info.st_mode & (0o027 if private else 0o022) == 0
                and info.st_size <= limit, 'DEPENDENCY_FILE_UNSAFE')
        data = bytearray()
        while chunk := os.read(fd, min(65536, limit + 1 - len(data))):
            data.extend(chunk)
            require(len(data) <= limit, 'DEPENDENCY_FILE_TOO_LARGE')
        require(len(data) == info.st_size, 'DEPENDENCY_FILE_CHANGED')
        return bytes(data)
    finally:
        os.close(fd)


def json_bytes(data):
    return json.loads(data, object_pairs_hook=general.observe.target.unique_keys)


def artifact(directory, root):
    directory = Path(directory)
    require(directory.is_absolute() and directory.parent == root / 'releases'
            and re.fullmatch(r'[A-Za-z0-9_-]{8,100}', directory.name), 'DEPENDENCY_RELEASE_PATH_REQUIRED')
    for parent in reversed(directory.parents):
        owned_directory(parent)
    owned_directory(directory)
    manifest_bytes = read_owned(directory / 'release-manifest.json')
    manifest = json_bytes(manifest_bytes)
    migrations = manifest.get('migrations')
    require(manifest.get('schemaVersion') == 1 and manifest.get('configurationIncluded') is False
            and isinstance(migrations, list) and migrations and migrations == sorted(set(migrations))
            and all(isinstance(name, str) and re.fullmatch(r'\d+_[A-Za-z0-9_-]+\.sql', name) for name in migrations),
            'DEPENDENCY_MANIFEST_INVALID')
    expected = set(ENTRIES) | {'package.json', 'package-lock.json'} | {'db/migrations/' + name for name in migrations}
    require(set(manifest.get('hashes', {})) == expected, 'DEPENDENCY_ARTIFACT_SET_INVALID')
    for parent in (directory / 'db', directory / 'db/migrations'):
        owned_directory(parent)
    require({path.name for path in (directory / 'db/migrations').iterdir()} == set(migrations),
            'DEPENDENCY_SQL_SET_CHANGED')
    require({path.name for path in directory.iterdir()} == {'node_modules', 'db', 'release-manifest.json',
            'package.json', 'package-lock.json', *ENTRIES}, 'DEPENDENCY_EXTRA_RELEASE_FILE')
    files = {name: read_owned(directory / name) for name in expected}
    require(all(digest(data) == manifest['hashes'][name] for name, data in files.items()),
            'DEPENDENCY_ARTIFACT_HASH_MISMATCH')
    return {'directory': str(directory), 'manifest': manifest, 'manifestSha256': digest(manifest_bytes),
            'dependenciesSha256': trial.dependency_digest(directory / 'node_modules'), 'files': files}


def equal_runtime(previous, candidate):
    require(previous['manifest']['migrations'] == candidate['manifest']['migrations'], 'DEPENDENCY_SQL_SET_CHANGED')
    names = set(ENTRIES) | {'db/migrations/' + name for name in previous['manifest']['migrations']}
    require(all(previous['files'][name] == candidate['files'][name] for name in names),
            'DEPENDENCY_RUNTIME_OR_SQL_CHANGED')
    before, after = (json_bytes(value['files']['package.json']) for value in (previous, candidate))
    expected = json.loads(json.dumps(before))
    require(isinstance(expected.get('dependencies'), dict), 'DEPENDENCY_PACKAGE_INVALID')
    for name, (old, new) in PATCHES.items():
        require(expected['dependencies'].get(name) == old, 'DEPENDENCY_PATCH_BASELINE_REFUSED')
        expected['dependencies'][name] = new
    require(after == expected, 'DEPENDENCY_DIRECT_CHANGE_NOT_PERMITTED')


def github_source(name, head):
    require(name in ('package.json', 'package-lock.json', 'scripts/release-migrate.mjs')
            and general.observe.target.git_sha(head), 'DEPENDENCY_GITHUB_RESOURCE_REFUSED')
    request = urllib.request.Request('https://api.github.com/repos/' + general.REPO + '/contents/' + name + '?ref=' + head,
                                    headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'cisme-dependency-preflight'})
    with urllib.request.build_opener(general.observe.NoRedirect()).open(request, timeout=12) as response:
        require(response.status == 200, 'DEPENDENCY_SOURCE_UNAVAILABLE')
        data = response.read(1024 * 1024 + 1)
    require(len(data) <= 1024 * 1024, 'DEPENDENCY_SOURCE_TOO_LARGE')
    value = json_bytes(data)
    require(value.get('path') == name and value.get('type') == 'file' and value.get('encoding') == 'base64',
            'DEPENDENCY_SOURCE_BINDING_REQUIRED')
    return base64.b64decode(value['content'].replace('\n', ''), validate=True)


def permit(candidate, main):
    manifest = candidate['manifest']
    require(manifest.get('sourceHead') == main['sha'] and manifest.get('sourceTree') == main['tree']
            and manifest.get('sourceLockSha256') == LOCK_PERMIT
            and manifest.get('buildPlatform') == {'os': 'linux', 'arch': 'x64', 'libc': 'glibc'},
            'DEPENDENCY_REVIEWED_CANDIDATE_REQUIRED')
    package_bytes = github_source('package.json', main['sha'])
    lock_bytes = github_source('package-lock.json', main['sha'])
    require(digest(package_bytes) == PACKAGE_PERMIT and digest(lock_bytes) == LOCK_PERMIT,
            'DEPENDENCY_SOURCE_PERMIT_MISMATCH')
    source = json_bytes(package_bytes)
    package = {'name': 'cisme-tencent-release', 'version': source['version'], 'private': True,
               'type': 'module', 'engines': source['engines'], 'dependencies': source['dependencies']}
    require(json_bytes(candidate['files']['package.json']) == package, 'DEPENDENCY_PACKAGE_NOT_REVIEWED_SOURCE')
    lock = json_bytes(lock_bytes)
    lock['name'] = package['name']
    lock['packages'][''] = {key: value for key, value in package.items() if key not in ('private', 'type')}
    lock['packages'] = {key: value for key, value in lock['packages'].items()
                        if not key or (key.startswith('node_modules/') and not value.get('link'))}
    require(json_bytes(candidate['files']['package-lock.json']) == lock, 'DEPENDENCY_LOCK_NOT_REVIEWED_SOURCE')
    require(candidate['files']['migrate.mjs'] == github_source('scripts/release-migrate.mjs', main['sha']),
            'DEPENDENCY_MIGRATOR_NOT_REVIEWED_SOURCE')
    verified = json_bytes(command([NODE, str(Path(candidate['directory']) / 'migrate.mjs'), 'verify']))
    require(verified.get('verified') is True and verified.get('sourceHead') == main['sha']
            and verified.get('sourceTree') == main['tree'], 'DEPENDENCY_FULL_ARTIFACT_REQUIRED')


def unit_path(unit):
    return Path('/etc/systemd/system') / unit


def unit_entry(data, entry, profile):
    lines = data.decode().splitlines()
    matches = [line[len('ExecStart='):] for line in lines if line.startswith('ExecStart=')]
    require(len(matches) == 1, 'DEPENDENCY_UNIT_EXECSTART_REQUIRED')
    args = matches[0].split()
    require(len(args) == 2 and args[0] == NODE, 'DEPENDENCY_UNIT_EXECSTART_REQUIRED')
    root = Path(profile['root'])
    require('User=' + profile['user'] in lines and 'Group=' + profile['user'] in lines
            and 'EnvironmentFile=' + str(root / 'runtime.env') in lines
            and 'Environment=TMPDIR=' + str(root / 'tmp') in lines, 'DEPENDENCY_UNIT_CONTEXT_REQUIRED')
    if profile['name'] == 'production':
        require(args[1] == entry and 'WorkingDirectory=' + str(root / 'current') in lines,
                'DEPENDENCY_PRODUCTION_UNIT_REQUIRED')
        return (root / 'current').resolve(strict=True)
    require('WorkingDirectory=' + str(root) in lines and Path(args[1]).is_absolute()
            and Path(args[1]).name == entry, 'DEPENDENCY_TRIAL_UNIT_REQUIRED')
    return Path(args[1]).parent


def replacement_unit(data, old, new, entry, profile):
    require(unit_entry(data, entry, profile) == Path(old), 'DEPENDENCY_OLD_UNIT_BINDING_REQUIRED')
    old_line = ('ExecStart=' + NODE + ' ' + str(Path(old) / entry)).encode()
    new_line = ('ExecStart=' + NODE + ' ' + str(Path(new) / entry)).encode()
    require(data.splitlines().count(old_line) == 1, 'DEPENDENCY_OLD_UNIT_BINDING_REQUIRED')
    return b''.join(new_line + line[len(old_line):] if line.rstrip(b'\r\n') == old_line else line
                    for line in data.splitlines(keepends=True))


def property_value(unit, name):
    return command(['systemctl', 'show', unit, '--property=' + name, '--value']).decode().strip()


UNIT_PROPERTIES = ('FragmentPath', 'DropInPaths', 'LoadState', 'NeedDaemonReload', 'User', 'Group',
                   'WorkingDirectory', 'EnvironmentFiles', 'Environment', 'ProtectSystem', 'ReadWritePaths',
                   'ReadOnlyPaths', 'InaccessiblePaths', 'RootDirectory', 'RootImage', 'BindPaths',
                   'BindReadOnlyPaths', 'SupplementaryGroups', 'NoNewPrivileges', 'PrivateTmp',
                   'ProtectHome', 'KillMode', 'TimeoutStopUSec', 'Restart', 'Type',
                   'ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'ExecReload')


def unit_definition(unit, data, entry, profile):
    definition = {name: property_value(unit, name) for name in UNIT_PROPERTIES}
    require(definition['FragmentPath'] == str(unit_path(unit)) and definition['DropInPaths'] == ''
            and definition['LoadState'] == 'loaded' and definition['NeedDaemonReload'] == 'no',
            'DEPENDENCY_UNIT_DEFINITION_REQUIRED')
    require(definition['User'] == profile['user'] and definition['Group'] == profile['user']
            and definition['WorkingDirectory'] == str(Path(profile['root']) /
                'current' if profile['name'] == 'production' else Path(profile['root']))
            and definition['EnvironmentFiles'] == str(Path(profile['root']) / 'runtime.env') + ' (ignore_errors=no)'
            and definition['Environment'] == 'TMPDIR=' + str(Path(profile['root']) / 'tmp')
            and definition['ProtectSystem'] == 'strict'
            and all(definition[name] == '' for name in ('ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'ExecReload')),
            'DEPENDENCY_EFFECTIVE_UNIT_CONTEXT_REQUIRED')
    exec_value = property_value(unit, 'ExecStart')
    matches = re.findall(r'\{ path=([^;]+) ; argv\[\]=(.*?) ; ignore_errors=no ;', exec_value)
    expected = next(line[len('ExecStart='):] for line in data.decode().splitlines() if line.startswith('ExecStart='))
    require(len(matches) == 1 and exec_value.count('argv[]=') == 1
            and matches[0] == (NODE, expected), 'DEPENDENCY_EFFECTIVE_EXECSTART_REQUIRED')
    unit_entry(data, entry, profile)
    definition['ExecStartArgv'] = expected
    return definition


def verify_units(plan, allow_candidate=False):
    profile = plan['profile']
    for unit, entry in zip(profile['units'], ('index.js', 'worker.js')):
        original = plan['units'][unit]
        allowed = [original]
        if allow_candidate and profile['name'] == 'trial':
            allowed.append(replacement_unit(original, plan['old']['directory'], plan['candidate']['directory'], entry, profile))
        data = read_owned(unit_path(unit))
        require(data in allowed, 'DEPENDENCY_UNKNOWN_UNIT_DRIFT')
        expected = dict(plan['unitDefinitions'][unit])
        if data != original:
            expected['ExecStartArgv'] = NODE + ' ' + str(Path(plan['candidate']['directory']) / entry)
        require(unit_definition(unit, data, entry, profile) == expected, 'DEPENDENCY_EFFECTIVE_UNIT_DRIFT')


def environment_metadata(profile):
    path = Path(profile['root']) / 'runtime.env'
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER and stat.S_IMODE(info.st_mode) == 0o640
            and info.st_gid == pwd.getpwnam(profile['user']).pw_gid, 'DEPENDENCY_ENV_PERMISSION_REQUIRED')
    command(['/usr/sbin/runuser', '-u', profile['user'], '--', '/usr/bin/test', '-r', str(path)])
    return {'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}


def private_inputs(profile, config):
    uid = pwd.getpwnam(profile['user']).pw_uid
    result = []
    for key in general.PRIVATE_FILE_KEYS:
        if not config.get(key):
            continue
        data, descriptor = general.private_file(config[key], uid)
        command(['/usr/sbin/runuser', '-u', profile['user'], '--', '/usr/bin/test', '-r', descriptor['path']])
        result.append({'key': key, **descriptor})
        if key == 'COMMERCE_FORMAL_PLATFORM_TRUST_FILE':
            manifest = json_bytes(data)
            anchors = manifest.get('keys')
            require(manifest.get('schemaVersion') == 1 and isinstance(anchors, list) and 1 <= len(anchors) <= 8,
                    'DEPENDENCY_TRUST_MANIFEST_REQUIRED')
            ids = set()
            for anchor in anchors:
                require(isinstance(anchor, dict) and isinstance(anchor.get('id'), str) and anchor['id'] not in ids
                        and isinstance(anchor.get('publicKeyFile'), str), 'DEPENDENCY_TRUST_MANIFEST_REQUIRED')
                ids.add(anchor['id'])
                _, descriptor = general.private_file(anchor['publicKeyFile'], uid)
                command(['/usr/sbin/runuser', '-u', profile['user'], '--', '/usr/bin/test', '-r', descriptor['path']])
                result.append({'key': 'wechat-pay-trust:' + anchor['id'], **descriptor})
    return sorted(result, key=lambda item: item['key'])


def query(profile, sql):
    return json_bytes(command(['/usr/sbin/runuser', '-u', 'postgres', '--', '/usr/bin/psql', '-XAt',
                             '-v', 'ON_ERROR_STOP=1', '-d', profile['database'], '-c', sql],
                             env={**CLEAN, 'PGOPTIONS': '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000'}))


def database_facts(profile):
    return query(profile, "SELECT json_build_object('database',current_database(),"
                 "'owner',(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()),"
                 "'journal',(SELECT json_agg(version ORDER BY version) FROM schema_migration),"
                 "'otherClients',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
                 "AND backend_type='client backend' AND pid<>pg_backend_pid()))")


def running(profile, directory, config):
    root = Path(profile['root'])
    uid = pwd.getpwnam(profile['user']).pw_uid
    result = {}
    for unit, entry in zip(profile['units'], ('index.js', 'worker.js')):
        require(property_value(unit, 'User') == profile['user'] and property_value(unit, 'ProtectSystem') == 'strict',
                'DEPENDENCY_SERVICE_SANDBOX_REQUIRED')
        writable = [Path(value.lstrip('-+')).resolve() for value in property_value(unit, 'ReadWritePaths').split()]
        secret_paths = [Path(item['path']) for item in private_inputs(profile, config)]
        for protected in (root / 'runtime.env', root / 'releases', unit_path(unit), Path(NODE), *secret_paths):
            require(not any(protected.resolve() == path or protected.resolve().is_relative_to(path) for path in writable),
                    'DEPENDENCY_SERVICE_WRITE_ACCESS_REFUSED')
        pid = property_value(unit, 'MainPID')
        require(property_value(unit, 'ActiveState') == 'active' and re.fullmatch(r'[1-9][0-9]*', pid),
                'DEPENDENCY_SERVICE_NOT_RUNNING')
        proc = Path('/proc') / pid
        cwd = proc.joinpath('cwd').resolve()
        args = proc.joinpath('cmdline').read_bytes().split(b'\0')
        expected_cwd = Path(directory) if profile['name'] == 'production' else root
        require(proc.stat().st_uid == uid and cwd == expected_cwd and len(args) >= 2 and args[0] == NODE.encode()
                and (cwd / os.fsdecode(args[1])).resolve() == Path(directory) / entry
                and proc.joinpath('exe').resolve() == Path(NODE).resolve(), 'DEPENDENCY_PROCESS_BINDING_REQUIRED')
        process_env = dict(item.split('=', 1) for item in proc.joinpath('environ').read_text().split('\0') if '=' in item)
        require(all(process_env.get(key) == value for key, value in config.items())
                and closed_context(profile, process_env)
                and all(process_env.get(key, 'false') == config.get(key, 'false') for key in PREPARATION_FLAGS),
                'DEPENDENCY_RUNNING_ENV_DRIFT')
        result[unit] = pid
    return result


SMOKE = """import {createRequire} from 'node:module';import assert from 'node:assert/strict';
const require=createRequire(process.argv[1]),sharp=require('sharp');
const png=await sharp({create:{width:16,height:24,channels:4,background:'#a56789'}}).png().toBuffer();
for(const format of ['webp','jpeg']){const bytes=await sharp(png,{limitInputPixels:36000000}).rotate().resize(128,128,{fit:'cover'})[format]({quality:80}).toBuffer();const m=await sharp(bytes).metadata();assert.equal(m.width,128);assert.equal(m.height,128);assert.equal(m.format,format);}
console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,
glibc:process.report.getReport().header.glibcVersionRuntime,fastify:require('fastify/package.json').version,sharp:sharp.versions.sharp,
rsvg:sharp.versions.rsvg,vips:sharp.versions.vips,fastifyPath:require.resolve('fastify'),sharpPath:require.resolve('sharp'),smoke:true}));"""


def native_smoke_entry(profile, directory, entry, patched):
    result = json_bytes(command(['/usr/sbin/runuser', '-u', profile['user'], '--', NODE, '--input-type=module', '-e',
                                 SMOKE, str(Path(directory) / entry)], cwd=Path(profile['root'])))
    require(result.get('smoke') is True and all(Path(result[key]).is_relative_to(Path(directory) / 'node_modules')
            for key in ('fastifyPath', 'sharpPath')) and result.get('node') == 'v24.14.0'
            and result.get('platform') == 'linux' and result.get('arch') == 'x64'
            and bool(result.get('glibc')), 'DEPENDENCY_RUNTIME_RESOLUTION_REQUIRED')
    side = 1 if patched else 0
    require(all(result.get(name) == versions[side] for name, versions in PATCHES.items()), 'DEPENDENCY_RUNTIME_VERSION_REQUIRED')
    if patched:
        require(re.fullmatch(r'\d+\.\d+\.\d+', result.get('rsvg', ''))
                and tuple(map(int, result['rsvg'].split('.'))) >= (2, 63, 2), 'DEPENDENCY_PATCHED_NATIVE_REQUIRED')
    return {key: result[key] for key in ('fastify', 'sharp', 'rsvg', 'vips')}


def native_smoke(profile, directory, patched=True):
    versions = [native_smoke_entry(profile, directory, entry, patched) for entry in ('index.js', 'worker.js')]
    require(versions[0] == versions[1], 'DEPENDENCY_API_WORKER_RESOLUTION_SPLIT')
    return versions[0]


def preflight(environment, directory):
    require(os.geteuid() == 0, 'DEPENDENCY_ROOT_REQUIRED')
    identity = general.observe.identity()
    profile = {**PROFILES[environment], 'name': environment}
    root = Path(profile['root'])
    owned_directory(root)
    env_metadata = environment_metadata(profile)
    env_bytes = read_owned(root / 'runtime.env', private=True)
    config = general.observe.audit.environment(env_bytes.decode())
    safe, _ = general.observe.audit.database(config.get('DATABASE_URL', ''))
    require(safe['databaseName'] == profile['database'] and safe['role'] == profile['database']
            and safe['host'] == '127.0.0.1' and safe['port'] == 5432
            and config.get('APP_ENV') == ('production' if environment == 'production' else 'staging'),
            'DEPENDENCY_DATABASE_CONTEXT_REQUIRED')
    require(closed_context(profile, config), 'DEPENDENCY_CLOSED_CONTEXT_REQUIRED')
    units = {unit: read_owned(unit_path(unit)) for unit in profile['units']}
    previous_dirs = {unit_entry(units[unit], entry, profile) for unit, entry in zip(profile['units'], ('index.js', 'worker.js'))}
    require(len(previous_dirs) == 1, 'DEPENDENCY_RUNNING_RELEASE_SPLIT')
    definitions = {unit: unit_definition(unit, units[unit], entry, profile)
                   for unit, entry in zip(profile['units'], ('index.js', 'worker.js'))}
    old = artifact(previous_dirs.pop(), root)
    candidate = artifact(directory, root)
    require(old['directory'] != candidate['directory'], 'DEPENDENCY_CANDIDATE_ALREADY_ACTIVE')
    equal_runtime(old, candidate)
    main = general.reviewed_main()
    permit(candidate, main)
    facts = database_facts(profile)
    require(facts['database'] == profile['database'] and facts['owner'] == profile['database']
            and facts['journal'] == old['manifest']['migrations'], 'DEPENDENCY_DATABASE_OR_HISTORY_DRIFT')
    ownership = None
    initial_records = {}
    if environment == 'production':
        general.observe.runtime(config)
    else:
        ownership = json_bytes(read_owned(root / 'ownership.json', private=True))
        require(ownership.get('kind') == 'cisme-isolated-trial' and ownership.get('instanceId') == identity['instanceId']
                and ownership.get('root') == str(root) and ownership.get('database') == profile['database']
                and ownership.get('role') == profile['database'] and ownership.get('user') == profile['user']
                and re.fullmatch(r'[a-f0-9]{32}', ownership.get('ownershipId', '')), 'DEPENDENCY_TRIAL_OWNERSHIP_REQUIRED')
        trial.db_owned(ownership)
        for name in ('ownership.json', 'empty-database.json', 'migration-complete.json'):
            initial_records[name] = read_owned(root / name, private=True)
        completed = json_bytes(initial_records['migration-complete.json'])
        require(completed.get('ownershipId') == ownership['ownershipId']
                and completed.get('source') == ownership['source']
                and completed.get('migrations') == len(old['manifest']['migrations']), 'DEPENDENCY_INITIAL_MIGRATION_DRIFT')
    active = root / 'dependency-active-release.json'
    active_bytes = read_owned(active, private=True) if active.exists() or active.is_symlink() else None
    if active_bytes is not None:
        prior = json_bytes(active_bytes)
        require(prior.get('directory') == old['directory'] and prior.get('manifestSha256') == old['manifestSha256']
                and prior.get('dependenciesSha256') == old['dependenciesSha256'], 'DEPENDENCY_ACTIVE_RECORD_DRIFT')
    elif ownership:
        require(ownership['source']['sourceHead'] == old['manifest']['sourceHead']
                and ownership['source']['sourceTree'] == old['manifest']['sourceTree']
                and ownership['source']['dependenciesSha256'] == old['dependenciesSha256'], 'DEPENDENCY_INITIAL_SOURCE_DRIFT')
    pids = running(profile, old['directory'], config)
    old_versions = native_smoke(profile, old['directory'], False)
    versions = native_smoke(profile, candidate['directory'])
    return {'profile': profile, 'main': main, 'old': old, 'candidate': candidate, 'env': env_bytes,
            'units': units, 'unitDefinitions': definitions, 'config': config, 'privateInputs': private_inputs(profile, config),
            'environmentMetadata': env_metadata, 'oldVersions': old_versions,
            'ownership': ownership, 'initialRecords': initial_records,
            'activeBytes': active_bytes, 'pids': pids, 'versions': versions}


def verify_context(plan, provenance=True, allow_candidate=False):
    profile = plan['profile']
    root = Path(profile['root'])
    require(environment_metadata(profile) == plan['environmentMetadata']
            and read_owned(root / 'runtime.env', private=True) == plan['env']
            and private_inputs(profile, plan['config']) == plan['privateInputs'], 'DEPENDENCY_ENV_OR_SECRET_DRIFT')
    verify_units(plan, allow_candidate)
    if plan['ownership']:
        require(json_bytes(read_owned(root / 'ownership.json', private=True)) == plan['ownership'], 'DEPENDENCY_OWNERSHIP_DRIFT')
    require(all(read_owned(root / name, private=True) == data for name, data in plan['initialRecords'].items()),
            'DEPENDENCY_INITIAL_MIGRATION_DRIFT')
    general.observe.identity()
    if provenance:
        require(general.reviewed_main() == plan['main'], 'DEPENDENCY_MAIN_OR_CI_DRIFT')
    for label in ('old', 'candidate'):
        current = artifact(plan[label]['directory'], root)
        require(current['manifestSha256'] == plan[label]['manifestSha256']
                and current['dependenciesSha256'] == plan[label]['dependenciesSha256'], 'DEPENDENCY_RELEASE_DRIFT')


def stopped(profile):
    require(all(property_value(unit, 'ActiveState') == 'inactive' and property_value(unit, 'MainPID') == '0'
                for unit in profile['units']), 'DEPENDENCY_SERVICES_NOT_STOPPED')


def healthy(plan, directory, started, patched):
    profile = plan['profile']
    last = None
    for _ in range(40):
        try:
            running(profile, directory, plan['config'])
            code = command(['/usr/bin/curl', '--silent', '--output', '/dev/null', '--write-out', '%{http_code}',
                            '--noproxy', '*', '--connect-timeout', '3', '--max-time', '8', '--proto', '=https',
                            '--resolve', profile['domain'] + ':443:127.0.0.1', 'https://' + profile['domain'] + '/health/ready'])
            require(code == b'200', 'DEPENDENCY_LOCAL_TLS_NOT_READY')
            heartbeat = Path(profile['root']) / 'tmp/cisme-worker-heartbeat.json'
            info = heartbeat.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid == pwd.getpwnam(profile['user']).pw_uid
                    and info.st_mode & 0o077 == 0, 'DEPENDENCY_HEARTBEAT_UNSAFE')
            value = json_bytes(heartbeat.read_bytes())
            at = datetime.fromisoformat(value['completedAtUtc'].replace('Z', '+00:00')).timestamp()
            require(started <= at <= time.time() and time.time() - at <= 120, 'DEPENDENCY_NEW_HEARTBEAT_REQUIRED')
            return native_smoke(profile, directory, patched)
        except Exception as error:
            last = error
            time.sleep(0.5)
    raise Refused('DEPENDENCY_ACTIVATION_FAILED') from last


def atomic_bytes(path, data, mode=0o600):
    temporary = path.with_name('.' + path.name + '-' + str(time.time_ns()))
    general.store(temporary, data, mode)
    os.replace(temporary, path)


def switch(plan, destination):
    profile = plan['profile']
    root = Path(profile['root'])
    verify_units(plan, allow_candidate=True)
    if profile['name'] == 'production':
        require((root / 'current').is_symlink() and (root / 'current').resolve() in
                (Path(plan['old']['directory']), Path(plan['candidate']['directory'])), 'DEPENDENCY_CURRENT_DRIFT')
        temporary = root / ('.dependency-current-' + str(time.time_ns()))
        temporary.symlink_to(destination, target_is_directory=True)
        os.replace(temporary, root / 'current')
    else:
        for unit, entry in zip(profile['units'], ('index.js', 'worker.js')):
            new = replacement_unit(plan['units'][unit], plan['old']['directory'], plan['candidate']['directory'], entry, profile)
            require(read_owned(unit_path(unit)) in (plan['units'][unit], new), 'DEPENDENCY_UNKNOWN_UNIT_DRIFT')
            atomic_bytes(unit_path(unit), plan['units'][unit] if destination == plan['old']['directory'] else new, 0o644)
        command(['systemctl', 'daemon-reload'])


def cutover(plan, state, approval):
    profile = plan['profile']
    root = Path(profile['root'])
    old, candidate = plan['old']['directory'], plan['candidate']['directory']
    general.store(state / 'previous.env', plan['env'])
    for unit, data in plan['units'].items():
        general.store(state / unit, data)
    # Private binding contains fingerprints, never public stdout or repository data.
    binding = {key: value for key, value in plan.items() if key not in ('env', 'units', 'config', 'activeBytes', 'initialRecords')}
    binding['old'] = {key: value for key, value in plan['old'].items() if key != 'files'}
    binding['candidate'] = {key: value for key, value in plan['candidate'].items() if key != 'files'}
    binding['environmentSha256'] = digest(plan['env'])
    general.store(state / 'binding.json', (json.dumps(binding, sort_keys=True) + '\n').encode())
    if plan['activeBytes']:
        general.store(state / 'previous-active-release.json', plan['activeBytes'])
    for name, data in plan['initialRecords'].items():
        general.store(state / ('initial-' + name), data)
    halted = False
    published_active = None
    try:
        verify_context(plan)
        halted = True
        command(['systemctl', 'stop', *profile['units']], timeout=90)
        stopped(profile)
        facts = database_facts(profile)
        require(facts['database'] == profile['database'] and facts['owner'] == profile['database']
                and facts['journal'] == plan['candidate']['manifest']['migrations'] and facts['otherClients'] == 0,
                'DEPENDENCY_WRITERS_NOT_DRAINED')
        verify_context(plan)
        switch(plan, candidate)
        verify_units(plan, allow_candidate=True)
        started = time.time()
        command(['systemctl', 'start', *profile['units']], timeout=60)
        versions = healthy(plan, candidate, started, True)
        verify_context(plan, allow_candidate=True)
        active = {'schemaVersion': 1, 'kind': 'dependency-only-active-release', 'environment': profile['name'],
                  'instanceId': 'lhins-61ikz4mi', 'database': profile['database'], 'directory': candidate,
                  'sourceHead': plan['main']['sha'], 'sourceTree': plan['main']['tree'],
                  'manifestSha256': plan['candidate']['manifestSha256'],
                  'dependenciesSha256': plan['candidate']['dependenciesSha256'],
                  'ownershipId': plan['ownership']['ownershipId'] if plan['ownership'] else None,
                  'initialSourcePreserved': True, 'upgradeState': str(state)}
        active_path = root / 'dependency-active-release.json'
        require((read_owned(active_path, private=True) if active_path.exists() or active_path.is_symlink() else None)
                == plan['activeBytes'], 'DEPENDENCY_ACTIVE_RECORD_DRIFT')
        published_active = (json.dumps(active, sort_keys=True) + '\n').encode()
        atomic_bytes(active_path, published_active)
        report = {'deployed': True, 'environment': profile['name'], 'sourceHead': plan['main']['sha'],
                  'versions': versions, 'databaseMigrated': False, 'databaseRestored': False,
                  'configurationChanged': False, 'credentialsChanged': False, 'networkChanged': False,
                  'publicReachabilityVerified': False, 'businessAdmissionGranted': False, 'approvalReference': approval}
        general.store(state / 'deployed.json', (json.dumps(report, sort_keys=True) + '\n').encode())
        return report
    except Exception:
        if halted:
            try:
                command(['systemctl', 'stop', *profile['units']], timeout=90)
                stopped(profile)
                # Never overwrite concurrent configuration, secrets or unknown units.
                verify_context(plan, provenance=False, allow_candidate=True)
                active = root / 'dependency-active-release.json'
                current_active = read_owned(active, private=True) if active.exists() or active.is_symlink() else None
                require(current_active in (plan['activeBytes'], published_active), 'DEPENDENCY_ACTIVE_RECORD_DRIFT')
                switch(plan, old)
                verify_units(plan)
                started = time.time()
                command(['systemctl', 'start', *profile['units']], timeout=60)
                healthy(plan, old, started, False)
                current_active = read_owned(active, private=True) if active.exists() or active.is_symlink() else None
                require(current_active in (plan['activeBytes'], published_active), 'DEPENDENCY_ACTIVE_RECORD_DRIFT')
                if plan['activeBytes']:
                    atomic_bytes(active, plan['activeBytes'])
                else:
                    active.unlink(missing_ok=True)
                general.store(state / 'application-rollback.json', b'{"databaseRestored":false,"applicationRestored":true,"securityPatchInstalled":false}\n')
            except Exception:
                fenced = False
                try:
                    command(['systemctl', 'stop', *profile['units']], timeout=90)
                    stopped(profile)
                    fenced = True
                except Exception:
                    pass
                try:
                    general.store(state / 'manual-recovery-required.json', (json.dumps({'databaseRestored': False,
                                  'unknownInputsOverwritten': False, 'applicationRollbackVerified': False,
                                  'servicesStopped': fenced}) + '\n').encode())
                except OSError:
                    pass
                raise Refused('DEPENDENCY_UPGRADE_FAILED_FENCED_REVIEW_REQUIRED') from None
            raise Refused('DEPENDENCY_UPGRADE_FAILED_APPLICATION_RESTORED') from None
        raise


def apply(environment, directory, approval):
    require(re.fullmatch(r'[-A-Za-z0-9_:.]{8,120}', approval or ''), 'DEPENDENCY_APPROVAL_REFERENCE_REQUIRED')
    plan = preflight(environment, directory)
    profile = plan['profile']
    fd = os.open(profile['lock'], os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER and info.st_mode & 0o077 == 0,
                'DEPENDENCY_LOCK_UNSAFE')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan = preflight(environment, directory)
        parent = Path(profile['root']) / 'dependency-upgrades'
        parent.mkdir(mode=0o700, exist_ok=True)
        owned_directory(parent, True)
        state = parent / ('main-' + plan['main']['sha'][:12] + '-' + str(time.time_ns()))
        state.mkdir(mode=0o700)
        return cutover(plan, state, approval)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', choices=('preflight', 'apply'), default='preflight')
    parser.add_argument('--environment', required=True, choices=tuple(PROFILES))
    parser.add_argument('--release', required=True)
    parser.add_argument('--approval-ref')
    args = parser.parse_args()
    try:
        if args.action == 'apply':
            result = apply(args.environment, args.release, args.approval_ref)
        else:
            plan = preflight(args.environment, args.release)
            result = {'readOnly': True, 'environment': args.environment, 'sourceHead': plan['main']['sha'],
                      'versions': plan['versions'], 'rollbackVersions': plan['oldVersions'],
                      'runtimeAndSqlIdentical': True, 'deployed': False,
                      'businessAdmissionGranted': False}
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({'ok': False, 'code': str(error) if isinstance(error, Refused) else 'DEPENDENCY_UPGRADE_REVIEW_REQUIRED'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
