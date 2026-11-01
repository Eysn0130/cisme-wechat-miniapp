#!/usr/bin/env python3
"""Pinned schema101 -> 103 comment/support upgrade, isolated trial only.

Default preflight is read-only. Candidates must already be staged immutably.
No restore/down or application rollback exists after comment publication facts.
"""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import types
import urllib.request

sys.dont_write_bytecode = True
ROOT = Path('/opt/cisme-trial')
OWNER = 0
BASELINE_HEAD = 'a4afe72b4b3a55c246cc5690390a80bf323b5e42'
BASELINE_TREE = '39d2a6e1f4a9d732f92ea9626b9a3825db1e5dd6'
BASELINE_RUNNER = ROOT / 'daily-day-runners' / BASELINE_HEAD[:12]
BASELINE_HELPER_SHA = '5394c9f4719319b0ca534c63ca65bcb3b003c6331585901ddea0aee348c3d8e2'
BASELINE_BINDING_SHA = 'aa61c490ed0516b751194f76c973eb4c9a5bac8ebf62baf01a4793b9938287b8'
DEPENDENCIES = 'd9f03813fc808eced42eacb92db4530a2cd0e0824cab5d1beb9c3bdf08144bdd'
MIGRATIONS = ('202610300002_editorial_comment_direct_publication.sql', '202610300003_support_explicit_ai_resume.sql')
STATE_PARENT = ROOT / 'comment-support-upgrades'
ACTIVE = STATE_PARENT / 'active-release.json'
STAGES = Path('/var/lib/cisme-dependency-stage')
HELPER_SOURCE = 'infra/tencent/trial-comment-support-upgrade.py'
NODE = '/opt/node-v24.14.0-linux-x64/bin/node'
CLEAN = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}
IMDS = {'instance-id': 'ins-l9utqwxv', 'local-ipv4': '10.0.0.10', 'public-ipv4': '124.223.74.198'}
AI_KEYS = ('SUPPORT_AI_ENABLED', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'SUPPORT_AI_TIMEOUT_MS')
HISTORY_ROOT = ('dependency-active-release.json', 'application-active-release.json', 'editorial-comments-active-release.json',
                'ownership.json', 'empty-database.json', 'migration-complete.json')
B = C = D = None


class Refused(RuntimeError):
    pass


def need(value, code):
    if not value:
        raise Refused(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def unique(pairs):
    value = {}
    for key, item in pairs:
        need(key not in value, 'COMMENT_SUPPORT_DUPLICATE_JSON_KEY')
        value[key] = item
    return value


def parse(raw):
    return json.loads(raw, object_pairs_hook=unique)


def read(path, limit=1024 * 1024, private=True):
    need(path.is_absolute() and '..' not in path.parts, 'COMMENT_SUPPORT_ABSOLUTE_PATH_REQUIRED')
    for parent in reversed(path.parents):
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == OWNER and not info.st_mode & 0o022,
             'COMMENT_SUPPORT_PROTECTED_PARENT_REQUIRED')
    if private:
        permitted = (0o700, 0o750, 0o755) if path.parent == ROOT and path.name in HISTORY_ROOT else (0o700,)
        need(stat.S_IMODE(path.parent.lstat().st_mode) in permitted, 'COMMENT_SUPPORT_PRIVATE_PARENT_REQUIRED')
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == OWNER and before.st_nlink == 1
             and (not private or stat.S_IMODE(before.st_mode) == 0o600)
             and not before.st_mode & 0o022 and 0 < before.st_size <= limit, 'COMMENT_SUPPORT_PROTECTED_FILE_REQUIRED')
        data = bytearray()
        while chunk := os.read(fd, min(65536, limit + 1 - len(data))):
            data.extend(chunk)
            need(len(data) <= limit, 'COMMENT_SUPPORT_FILE_TOO_LARGE')
        after = os.fstat(fd)
        need(len(data) == before.st_size and (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
             == (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'COMMENT_SUPPORT_FILE_CHANGED')
        return bytes(data)
    finally:
        os.close(fd)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Refused('COMMENT_SUPPORT_REDIRECT_REFUSED')


def response(url, limit):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json',
        'Cache-Control': 'no-cache', 'User-Agent': 'cisme-trial-comment-support'})
    with opener.open(request, timeout=12) as remote:
        need(remote.status == 200, 'COMMENT_SUPPORT_SOURCE_UNAVAILABLE')
        declared = remote.headers.get('Content-Length')
        need(declared is None or re.fullmatch(r'[0-9]+', declared) and 0 < int(declared) <= limit,
             'COMMENT_SUPPORT_RESPONSE_SIZE_REQUIRED')
        data = remote.read(limit + 1)
        need(0 < len(data) <= limit and (declared is None or len(data) == int(declared)), 'COMMENT_SUPPORT_RESPONSE_TRUNCATED')
    return data


def target():
    need(os.geteuid() == OWNER, 'COMMENT_SUPPORT_ROOT_REQUIRED')
    observed = {name: response('http://metadata.tencentyun.com/latest/meta-data/' + name, 128).decode('ascii').strip()
                for name in IMDS}
    need(observed == IMDS, 'COMMENT_SUPPORT_EXACT_IMDS_TARGET_REQUIRED')
    if D is not None:
        value = D.general.observe.identity()
        need(value.get('instanceId') == 'lhins-61ikz4mi' and value.get('publicIpv4') == IMDS['public-ipv4'],
             'COMMENT_SUPPORT_EXACT_INSTANCE_REQUIRED')


def load_baseline(active=True):
    global B, C, D
    target()
    path = BASELINE_RUNNER / 'trial-daily-day-upgrade.py'
    raw = read(path, 128 * 1024)
    need(sha(raw) == BASELINE_HELPER_SHA, 'COMMENT_SUPPORT_PINNED_BASELINE_HELPER_REQUIRED')
    B = types.ModuleType('reviewed_schema101_baseline')
    B.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), B.__dict__)
    binding = B.binding(BASELINE_RUNNER / 'application-binding.json', BASELINE_BINDING_SHA)
    need(binding.get('sourceHead') == BASELINE_HEAD and binding.get('sourceTree') == BASELINE_TREE,
         'COMMENT_SUPPORT_BASELINE_BINDING_REQUIRED')
    if active:
        value = B.active_context(binding)
        C, D = value['C'], value['D']
        need(value['release'] == ROOT / 'releases' / ('tencent-release-' + BASELINE_HEAD[:12]),
             'COMMENT_SUPPORT_BASELINE_RELEASE_REQUIRED')
        return value
    B.load_baseline(False)
    C, D = B.C, B.D
    return None


def validate_binding(b):
    need(b.get('schemaVersion') == 1 and b.get('kind') == 'trial-comment-support-upgrade'
         and b.get('baselineHead') == BASELINE_HEAD and b.get('baselineTree') == BASELINE_TREE,
         'COMMENT_SUPPORT_BASELINE_BINDING_REQUIRED')
    need(all(isinstance(b.get(k), str) and re.fullmatch(r'[0-9a-f]{40}', b[k]) and b[k] != '0' * 40
             for k in ('sourceHead', 'sourceTree')) and b['sourceHead'] != BASELINE_HEAD,
         'COMMENT_SUPPORT_EXACT_COMMITTED_SOURCE_REQUIRED')
    need(all(isinstance(b.get(k), str) and re.fullmatch(r'[0-9a-f]{64}', b[k])
             for k in ('helperSha256', 'manifestSha256', 'archiveSha256'))
         and type(b.get('archiveBytes')) is int and 0 < b['archiveBytes'] <= 512 * 1024 ** 2,
         'COMMENT_SUPPORT_EXACT_ARTIFACT_REQUIRED')
    need(b.get('dependenciesSha256') == DEPENDENCIES and b.get('migrations') == 103
         and b.get('applicationRollbackAllowed') is False
         and isinstance(b.get('migrationSha256'), dict) and set(b['migrationSha256']) == set(MIGRATIONS)
         and all(isinstance(v, str) and re.fullmatch(r'[0-9a-f]{64}', v) for v in b['migrationSha256'].values()),
         'COMMENT_SUPPORT_ONLY_SCHEMA102_103_REQUIRED')
    archive = Path(b.get('archivePath', ''))
    need(archive.name == 'archive.tar.gz' and archive.parent.parent == STAGES
         and re.fullmatch(r'comment-support-' + b['sourceHead'][:12] + r'-[a-z0-9_-]{8,40}', archive.parent.name),
         'COMMENT_SUPPORT_PRIVATE_ARCHIVE_PATH_REQUIRED')
    need(isinstance(b.get('deepseekKeyFile'), str) and Path(b['deepseekKeyFile']).is_absolute()
         and Path(b['deepseekKeyFile']) != ROOT / 'runtime.env', 'COMMENT_SUPPORT_PRIVATE_KEY_PATH_REQUIRED')
    need(sha(read(Path(__file__), 128 * 1024)) == b['helperSha256'], 'COMMENT_SUPPORT_EXACT_HELPER_REQUIRED')
    return b


def binding(path, expected):
    need(re.fullmatch(r'[0-9a-f]{64}', expected or ''), 'COMMENT_SUPPORT_BINDING_SHA_REQUIRED')
    raw = read(path, 65536)
    need(sha(raw) == expected, 'COMMENT_SUPPORT_BINDING_HASH_MISMATCH')
    return validate_binding(parse(raw))


def artifact_contract(old, candidate, b):
    before, after = old['manifest'], candidate['manifest']
    need(before.get('sourceHead') == BASELINE_HEAD and before.get('sourceTree') == BASELINE_TREE
         and len(before.get('migrations', [])) == 101, 'COMMENT_SUPPORT_SCHEMA101_BASELINE_REQUIRED')
    need(after.get('sourceHead') == b['sourceHead'] and after.get('sourceTree') == b['sourceTree']
         and candidate['manifestSha256'] == b['manifestSha256'] and after.get('node') == 'v24.14.0'
         and after.get('buildPlatform') == {'os': 'linux', 'arch': 'x64', 'libc': 'glibc'}
         and all(after.get(k) is False for k in ('configurationIncluded', 'deployed', 'releaseReady')),
         'COMMENT_SUPPORT_EXACT_LINUX_ARTIFACT_REQUIRED')
    sql = before['migrations']
    need(sql == sorted(set(sql)) and sql[-1] == '202610300001_daily_care_daily_latest.sql'
         and after.get('migrations') == sql + list(MIGRATIONS) and old['directory'] != candidate['directory'],
         'COMMENT_SUPPORT_ONLY_TWO_MIGRATIONS_REQUIRED')
    names = ['migrate.mjs', 'package.json', 'package-lock.json'] + ['db/migrations/' + name for name in sql]
    need(all(old['files'].get(name) and old['files'][name] == candidate['files'].get(name) for name in names),
         'COMMENT_SUPPORT_OLD_SQL_PACKAGE_OR_MIGRATOR_CHANGED')
    need(all(sha(candidate['files'].get('db/migrations/' + name, b'')) == b['migrationSha256'][name] for name in MIGRATIONS),
         'COMMENT_SUPPORT_NEW_SQL_HASH_MISMATCH')
    need(old['dependenciesSha256'] == candidate['dependenciesSha256'] == DEPENDENCIES,
         'COMMENT_SUPPORT_FULL_DEPENDENCY_TREE_CHANGED')


def source_bytes(name, head):
    permitted = (HELPER_SOURCE, 'package.json', 'package-lock.json', 'scripts/release-migrate.mjs',
                 *('db/migrations/' + value for value in MIGRATIONS))
    need(name in permitted and re.fullmatch(r'[0-9a-f]{40}', head), 'COMMENT_SUPPORT_SOURCE_PATH_REQUIRED')
    maximum = 1024 * 1024 if name == 'package-lock.json' else 128 * 1024
    value = parse(response('https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/contents/' + name + '?ref=' + head, 2 * 1024 * 1024 if name == 'package-lock.json' else 256 * 1024))
    need(value.get('type') == 'file' and value.get('path') == name and value.get('encoding') == 'base64'
         and type(value.get('size')) is int and 0 < value['size'] <= maximum,
         'COMMENT_SUPPORT_SOURCE_METADATA_REQUIRED')
    raw = base64.b64decode(value['content'].replace('\n', '').replace('\r', ''), validate=True)
    need(len(raw) == value['size'] and hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == value.get('sha'),
         'COMMENT_SUPPORT_SOURCE_BLOB_MISMATCH')
    return raw


def source_permit(b, candidate):
    commit = parse(response('https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/git/commits/' + b['sourceHead'], 256 * 1024))
    need(commit.get('sha') == b['sourceHead'] and commit.get('tree', {}).get('sha') == b['sourceTree'],
         'COMMENT_SUPPORT_COMMITTED_TREE_MISMATCH')
    need(source_bytes(HELPER_SOURCE, b['sourceHead']) == read(Path(__file__), 128 * 1024),
         'COMMENT_SUPPORT_COMMITTED_HELPER_MISMATCH')
    need(all(candidate['files']['db/migrations/' + name] == source_bytes('db/migrations/' + name, b['sourceHead']) for name in MIGRATIONS)
         and candidate['files']['migrate.mjs'] == source_bytes('scripts/release-migrate.mjs', b['sourceHead'])
         and sha(source_bytes('package-lock.json', b['sourceHead'])) == candidate['manifest'].get('sourceLockSha256'),
         'COMMENT_SUPPORT_COMMITTED_ARTIFACT_MISMATCH')
    # source package has workspace/dev fields; the release package is reduced.
    package = parse(source_bytes('package.json', b['sourceHead']))
    release_package = parse(candidate['files']['package.json'])
    need(package.get('dependencies') == release_package.get('dependencies'), 'COMMENT_SUPPORT_COMMITTED_DEPENDENCIES_MISMATCH')
    value = parse(D.command([NODE, str(Path(candidate['directory']) / 'migrate.mjs'), 'verify']))
    need(value.get('verified') is True and value.get('sourceHead') == b['sourceHead']
         and value.get('sourceTree') == b['sourceTree'] and value.get('migrations') == 103,
         'COMMENT_SUPPORT_COMPLETE_CANDIDATE_REQUIRED')


def key_bytes(b):
    raw = read(Path(b['deepseekKeyFile']), 256)
    value = raw.rstrip(b'\r\n')
    need(raw in (value, value + b'\n', value + b'\r\n') and re.fullmatch(rb'sk-[A-Za-z0-9_-]{16,200}', value),
         'COMMENT_SUPPORT_PRIVATE_KEY_FORMAT_REQUIRED')
    return value


def append_ai_environment(previous, config, key):
    need(b'\0' not in previous and isinstance(config, dict), 'COMMENT_SUPPORT_ENV_INVALID')
    # Only append previously absent keys: all prior bytes/credentials stay exact.
    need(not any(key in config for key in AI_KEYS)
         and not any(re.match(rb'\s*(?:export\s+)?' + name.encode() + rb'\s*=', line)
                     for name in AI_KEYS for line in previous.splitlines()), 'COMMENT_SUPPORT_AI_ENV_ALREADY_CONFIGURED')
    addition = (b'' if previous.endswith(b'\n') else b'\n') + b'SUPPORT_AI_ENABLED=true\nDEEPSEEK_API_KEY=' + key + b'\nDEEPSEEK_MODEL=deepseek-flash\nSUPPORT_AI_TIMEOUT_MS=4000\n'
    result = previous + addition
    values = D.general.observe.audit.environment(result.decode('utf8'))
    expected = {**config, 'SUPPORT_AI_ENABLED': 'true', 'DEEPSEEK_API_KEY': key.decode('ascii'),
                'DEEPSEEK_MODEL': 'deepseek-flash', 'SUPPORT_AI_TIMEOUT_MS': '4000'}
    need(values == expected and result.startswith(previous), 'COMMENT_SUPPORT_UNRELATED_ENV_CHANGED')
    return result, values


def optional_active():
    if STATE_PARENT.exists() or STATE_PARENT.is_symlink():
        D.owned_directory(STATE_PARENT, True)
    return read(ACTIVE, 65536) if ACTIVE.exists() or ACTIVE.is_symlink() else None


def capture_history():
    paths = [ROOT / name for name in HISTORY_ROOT]
    module, seen = B, set()
    while module is not None and id(module) not in seen:
        seen.add(id(module))
        if hasattr(module, 'ACTIVE'):
            paths.append(module.ACTIVE)
        module = getattr(module, 'B', None)
    return {str(path): read(path, 65536) for path in paths}


def verify_history(plan, allowed=()):
    need(all(read(Path(path), 65536) == data for path, data in plan['history'].items()), 'COMMENT_SUPPORT_HISTORY_DRIFT')
    need(optional_active() in (allowed or (None,)), 'COMMENT_SUPPORT_UNKNOWN_ACTIVE_RECORD')


def verify_context(plan, activated=False, allowed=(), exact_pids=True):
    target()
    C.fixed_profile(plan['profile'])
    view = dict(plan)
    if activated:
        view.update(env=plan['newEnv'], config=plan['newConfig'])
    D.verify_context(view, provenance=False, allow_candidate=activated)
    verify_history(plan, allowed)
    C.production_preserved(plan['production'], exact_pids)
    C.six_keys(view['config'], plan['production']['config'])
    need(D.closed_context(plan['profile'], view['config']) and view['config'].get('APP_ENV') == 'staging',
         'COMMENT_SUPPORT_TRIAL_CLOSED_CONTEXT_REQUIRED')
    need(sha(key_bytes(plan['binding'])) == plan['keySha256'], 'COMMENT_SUPPORT_PRIVATE_KEY_DRIFT')
    artifact_contract(D.artifact(plan['old']['directory'], ROOT), D.artifact(plan['candidate']['directory'], ROOT), plan['binding'])


def journal(plan, allowed, drain=False):
    value = C.database_guard(plan['profile'], plan['config'], plan['ownership'], allowed, drain)
    B.schema101(plan['profile'])
    return value


def schema103(profile):
    result = D.query(profile, "SELECT json_build_object('commentDefault',(SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='editorial_comment' AND column_name='state'),'resumeGuard',position('cisme.support_resume_ai_conversation_id' in pg_get_functiondef('enforce_support_conversation_transition()'::regprocedure))>0,'guardOwner',(SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='enforce_support_conversation_transition()'::regprocedure))")
    need(result == {'commentDefault': "'published'::text", 'resumeGuard': True, 'guardOwner': 'cisme_trial'},
         'COMMENT_SUPPORT_SCHEMA103_OBJECTS_REQUIRED')


def business_fence(profile):
    # Exclude the solely migration-authorized comment state/version/updated_at.
    # Core comments, member assets, authored content and support facts stay exact.
    parts = []
    for table in ('member', 'member_profile', 'editorial_article', 'editorial_comment', 'editorial_comment_like',
                  'editorial_comment_policy', 'editorial_comment_report', 'support_conversation', 'support_message',
                  'daily_care_record', 'daily_care_record_revision'):
        projection = "to_jsonb(t)-'state'-'version'-'updated_at'" if table == 'editorial_comment' else 'to_jsonb(t)'
        parts.append("'" + table + "',(SELECT json_build_object('count',count(*),'sha256',encode(digest(coalesce(jsonb_agg(" + projection + " ORDER BY (" + projection + ")::text)::text,'[]'),'sha256'),'hex')) FROM " + table + ' t)')
    return D.query(profile, 'SELECT json_build_object(' + ','.join(parts) + ')')


def preflight(b):
    current = load_baseline(True)
    target()
    profile, config = current['profile'], current['config']
    C.fixed_profile(profile)
    need(optional_active() is None, 'COMMENT_SUPPORT_EXISTING_UPGRADE_REFUSED')
    need(config.get('APP_ENV') == 'staging' and config.get('WECHAT_APP_ID') == C.APP_ID and D.closed_context(profile, config)
         and config.get('WECHAT_PHONE_BINDING_ENABLED', 'false') == 'false'
         and config.get('COS_DIRECT_UPLOAD_ENABLED', 'false') == 'false', 'COMMENT_SUPPORT_CLOSED_TRIAL_REQUIRED')
    old = D.artifact(str(current['release']), ROOT)
    candidate = D.artifact(str(ROOT / 'releases' / ('tencent-release-' + b['sourceHead'][:12])), ROOT)
    artifact_contract(old, candidate, b)
    archive = read(Path(b['archivePath']), 512 * 1024 ** 2)
    need(len(archive) == b['archiveBytes'] and sha(archive) == b['archiveSha256'], 'COMMENT_SUPPORT_ARCHIVE_HASH_MISMATCH')
    source_permit(b, candidate)
    previous = D.read_owned(ROOT / 'runtime.env', private=True)
    key = key_bytes(b)
    new_env, new_config = append_ai_environment(previous, config, key)
    production = C.production_capture()
    C.six_keys(config, production['config'])
    history = capture_history()
    ownership = parse(history[str(ROOT / 'ownership.json')])
    C.database_guard(profile, config, ownership, [old['manifest']['migrations']])
    units = {unit: D.read_owned(D.unit_path(unit)) for unit in profile['units']}
    dropins = {unit: D.dropin_inputs(unit) for unit in profile['units']}
    definitions = {unit: D.unit_definition(unit, units[unit], entry, profile, dropins[unit])
                   for unit, entry in zip(profile['units'], ('index.js', 'worker.js'))}
    versions = D.native_smoke(profile, candidate['directory'], True)
    need(versions == D.native_smoke(profile, old['directory'], True), 'COMMENT_SUPPORT_NATIVE_RUNTIME_CHANGED')
    return {'profile': profile, 'config': config, 'env': previous, 'newEnv': new_env, 'newConfig': new_config,
        'environmentMetadata': D.environment_metadata(profile), 'privateInputs': D.private_inputs(profile, config),
        'old': old, 'candidate': candidate, 'units': units, 'dropIns': dropins, 'unitDefinitions': definitions,
        'ownership': ownership, 'initialRecords': {name: history[str(ROOT / name)] for name in HISTORY_ROOT[-3:]},
        'history': history, 'production': production, 'binding': b, 'keySha256': sha(key), 'versions': versions}


def save_plan(plan, state):
    saved = dict(plan)
    for name in ('old', 'candidate'):
        saved[name] = {key: value for key, value in plan[name].items() if key != 'files'}
    raw = (json.dumps(C.encode_private(saved), sort_keys=True) + '\n').encode()
    need(len(raw) <= 8 * 1024 ** 2, 'COMMENT_SUPPORT_PRIVATE_PLAN_TOO_LARGE')
    D.general.store(state / 'protected-plan.json', raw)
    return sha(raw)


def backup_inputs(plan, state):
    D.general.store(state / 'previous.env', plan['env'])
    for unit, raw in plan['units'].items():
        D.general.store(state / unit, raw)
        if plan['dropIns'][unit]['files']:
            directory = state / 'drop-ins' / unit
            directory.parent.mkdir(mode=0o700, exist_ok=True)
            directory.mkdir(mode=0o700)
            for path, data in plan['dropIns'][unit]['files'].items():
                D.general.store(directory / Path(path).name, data)


def activate(plan):
    # Write exactly the old bytes plus the four specified AI settings, preserving
    # runtime.env's service-group ownership and 0640 mode before atomic replace.
    need(D.read_owned(ROOT / 'runtime.env', private=True) == plan['env'], 'COMMENT_SUPPORT_ENV_DRIFT')
    path = ROOT / 'runtime.env'
    temporary = ROOT / ('.runtime.env-comment-support-' + str(time.time_ns()))
    metadata = plan['environmentMetadata']
    try:
        D.general.store(temporary, plan['newEnv'], 0o600)
        os.chown(temporary, metadata['uid'], metadata['gid'])
        os.chmod(temporary, metadata['mode'])
        need(D.read_owned(temporary, private=True) == plan['newEnv'], 'COMMENT_SUPPORT_NEW_ENV_WRITE_FAILED')
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()
    D.switch(plan, plan['candidate']['directory'])


def active_record(plan, state, plan_sha):
    return (json.dumps({'schemaVersion': 1, 'kind': 'trial-comment-support-active-release',
        'environment': 'trial', 'instanceId': 'lhins-61ikz4mi', 'database': 'cisme_trial',
        'sourceHead': plan['binding']['sourceHead'], 'sourceTree': plan['binding']['sourceTree'],
        'directory': plan['candidate']['directory'], 'manifestSha256': plan['candidate']['manifestSha256'],
        'dependenciesSha256': DEPENDENCIES, 'migrationCount': 103, 'baselineHead': BASELINE_HEAD,
        'ownershipId': plan['ownership']['ownershipId'], 'upgradeState': str(state), 'privatePlanSha256': plan_sha,
        'applicationRollbackAllowed': False, 'databaseRestored': False,
        'previousActiveHistoryPreserved': True}, sort_keys=True) + '\n').encode()


def cutover(plan, state, approval):
    halted = False
    try:
        verify_context(plan)
        journal(plan, [plan['old']['manifest']['migrations']])
        backup_inputs(plan, state)
        halted = True
        D.command(['systemctl', 'stop', *plan['profile']['units']], timeout=90)
        D.stopped(plan['profile'])
        verify_context(plan)
        journal(plan, [plan['old']['manifest']['migrations']], True)
        plan['businessFence'] = business_fence(plan['profile'])
        plan_sha = save_plan(plan, state)
        backup = B.snapshot(plan, state, approval)
        B.validate_snapshot(backup, state, approval)
        # The reused crypto helper keeps its original historical AAD label.
        # This separate protected receipt binds the actual current101 release.
        D.general.store(state / 'snapshot-current-release.json', (json.dumps({
            'snapshotReceiptSha256': sha(read(state / 'predeploy-database' / 'snapshot-private.json')),
            'actualBaselineHead': BASELINE_HEAD, 'actualBaselineTree': BASELINE_TREE,
            'actualBaselineManifestSha256': plan['old']['manifestSha256'], 'actualMigrationCount': 101,
            'candidateHead': plan['binding']['sourceHead'], 'candidateTree': plan['binding']['sourceTree'],
            'backupReference': backup['backupReference'], 'cryptoAadBaselineLabel': B.BASELINE_HEAD,
            'aadClaimsCurrentBaseline': False}, sort_keys=True) + '\n').encode())
        verify_context(plan)
        journal(plan, [plan['old']['manifest']['migrations']], True)
        D.command(['/usr/sbin/runuser', '-u', 'cisme-trial', '--', NODE,
            str(Path(plan['candidate']['directory']) / 'migrate.mjs'), 'up'],
            env={**CLEAN, **plan['config'], 'CISME_MIGRATION_APPROVAL_REF': approval,
                 'CISME_PREDEPLOY_BACKUP_REF': backup['backupReference']}, cwd=ROOT, timeout=180)
        journal(plan, [plan['candidate']['manifest']['migrations']], True)
        schema103(plan['profile'])
        need(business_fence(plan['profile']) == plan['businessFence'], 'COMMENT_SUPPORT_ORIGINAL_BUSINESS_FACTS_CHANGED')
        verify_context(plan)
        activate(plan)
        verify_context(plan, activated=True)
        started = time.time()
        D.command(['systemctl', 'start', *plan['profile']['units']], timeout=60)
        running_plan = {**plan, 'env': plan['newEnv'], 'config': plan['newConfig']}
        versions = D.healthy(running_plan, plan['candidate']['directory'], started, True)
        C.public_contract(running_plan, True)
        verify_context(plan, activated=True)
        journal(plan, [plan['candidate']['manifest']['migrations']])
        schema103(plan['profile'])
        active = active_record(plan, state, plan_sha)
        D.atomic_bytes(ACTIVE, active)
        verify_context(plan, activated=True, allowed=(active,))
        journal(plan, [plan['candidate']['manifest']['migrations']])
        report = {'deployed': True, 'environment': 'trial', 'sourceHead': plan['binding']['sourceHead'],
            'migrationCountBefore': 101, 'migrationCountAfter': 103, 'aiConfigured': True,
            'model': 'deepseek-flash', 'snapshotAuthenticated': True, 'snapshotScope': 'same-host-database-only',
            'fullRecoveryQualified': False, 'databaseRestored': False, 'applicationRollbackExecuted': False,
            'previousActiveHistoryPreserved': True, 'productionChanged': False, 'versions': versions}
        D.general.store(state / 'deployed.json', (json.dumps(report, sort_keys=True) + '\n').encode())
        return report
    except Exception:
        if not halted:
            raise
        stopped = False
        try:
            D.command(['systemctl', 'stop', *plan['profile']['units']], timeout=90)
            D.stopped(plan['profile'])
            stopped = True
        except Exception:
            pass
        D.general.store(state / 'manual-recovery-required.json', (json.dumps({'servicesStopped': stopped,
            'unknownInputsOverwritten': False, 'databaseRestored': False, 'applicationRollbackExecuted': False,
            'forwardRecoveryRequired': True}) + '\n').encode())
        raise Refused('COMMENT_SUPPORT_FAILED_FENCED_FORWARD_REVIEW_REQUIRED') from None


def active_context(b):
    validate_binding(b)
    # The previous active101 guard intentionally cannot validate a new103 env.
    # Load only its pinned primitives, then validate this upgrade's own record.
    load_baseline(False)
    target()
    raw = read(ACTIVE, 65536)
    active = parse(raw)
    state = Path(active.get('upgradeState', ''))
    need(state.parent == STATE_PARENT and re.fullmatch(r'commit-' + b['sourceHead'][:12] + r'-[0-9]+', state.name),
         'COMMENT_SUPPORT_ACTIVE_STATE_PATH_REQUIRED')
    saved = read(state / 'protected-plan.json', 8 * 1024 ** 2)
    need(sha(saved) == active.get('privatePlanSha256'), 'COMMENT_SUPPORT_ACTIVE_PRIVATE_PLAN_DRIFT')
    plan = C.decode_private(parse(saved))
    need(plan.get('binding') == b, 'COMMENT_SUPPORT_ACTIVE_BINDING_DRIFT')
    for label in ('old', 'candidate'):
        plan[label] = D.artifact(plan[label]['directory'], ROOT)
    artifact_contract(plan['old'], plan['candidate'], b)
    need(raw == active_record(plan, state, sha(saved)), 'COMMENT_SUPPORT_ACTIVE_RECORD_DRIFT')
    verify_context(plan, activated=True, allowed=(raw,), exact_pids=False)
    for unit, entry in zip(plan['profile']['units'], ('index.js', 'worker.js')):
        need(D.unit_entry(D.read_owned(D.unit_path(unit)), entry, plan['profile']) == Path(plan['candidate']['directory']),
             'COMMENT_SUPPORT_ACTIVE_UNIT_PATH_REQUIRED')
    D.running(plan['profile'], plan['candidate']['directory'], plan['newConfig'])
    journal(plan, [plan['candidate']['manifest']['migrations']])
    schema103(plan['profile'])
    return {'profile': plan['profile'], 'config': plan['newConfig'], 'release': Path(plan['candidate']['directory'])}


def apply(b, approval):
    need(re.fullmatch(r'[-A-Za-z0-9_:.]{8,120}', approval or ''), 'COMMENT_SUPPORT_OPERATION_REFERENCE_REQUIRED')
    target()
    lock = Path('/run/lock/cisme-production-trial.lock')
    parent = lock.parent.lstat()
    need(stat.S_ISDIR(parent.st_mode) and parent.st_uid == OWNER and stat.S_IMODE(parent.st_mode) == 0o1777,
         'COMMENT_SUPPORT_LOCK_PARENT_REQUIRED')
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
             'COMMENT_SUPPORT_LOCK_REQUIRED')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan = preflight(b)
        STATE_PARENT.mkdir(mode=0o700, exist_ok=True)
        D.owned_directory(STATE_PARENT, True)
        D.general.store(STATE_PARENT / ('update-' + b['sourceHead'][:12] + '.started.json'),
                        (json.dumps({'sourceHead': b['sourceHead'], 'operationReference': approval}) + '\n').encode())
        state = STATE_PARENT / ('commit-' + b['sourceHead'][:12] + '-' + str(time.time_ns()))
        state.mkdir(mode=0o700)
        return cutover(plan, state, approval)
    finally:
        os.close(fd)


def safe_error_code(error):
    # Even reviewed imported exceptions can contain subprocess/connection prose.
    value = str(error) if isinstance(error, Refused) else ''
    return value if re.fullmatch(r'COMMENT_SUPPORT_[A-Z0-9_]{1,100}', value) else 'COMMENT_SUPPORT_REVIEW_REQUIRED'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', choices=('preflight', 'apply', 'active'), default='preflight')
    parser.add_argument('--binding', type=Path, required=True)
    parser.add_argument('--binding-sha256', required=True)
    parser.add_argument('--operation-reference')
    args = parser.parse_args()
    try:
        b = binding(args.binding, args.binding_sha256)
        if args.action == 'apply':
            result = apply(b, args.operation_reference)
        elif args.action == 'active':
            active_context(b)
            result = {'readOnly': True, 'activeVerified': True, 'sourceHead': b['sourceHead'], 'migrationCount': 103}
        else:
            plan = preflight(b)
            result = {'readOnly': True, 'deployed': False, 'sourceHead': plan['binding']['sourceHead'],
                'migrationCountBefore': 101, 'migrationCountAfter': 103, 'productionPreserved': True,
                'sameHostSnapshotNotYetCreated': True, 'aiKeyValidated': True}
        print(json.dumps({**result, 'privateValuesExported': False}, sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({'ok': False, 'code': safe_error_code(error), 'privateValuesExported': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
