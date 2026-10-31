#!/usr/bin/env python3
"""Exact 0ca/schema103 -> committed-source/schema103 application update.

Trial only; the default preflight is read-only. Never changes environment,
credentials, authority or database facts, and never migrates or restores.
There is no automatic application rollback: 0ca would restore anonymous
comment access. Any cutover failure stops trial services for forward review.
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
BASELINE_HEAD = '0caed61677dfc874f5162d99854a9bd54a199b7b'
BASELINE_TREE = '21fe1201068ee570088fbc8ffec6993d55859adc'
BASELINE_MANIFEST = '97af96c44f69a4590b3500b75a1877c3fe78fd2f414b68f3a1ce7152f7347940'
BASELINE_RUNNER = ROOT / 'comment-support-runners' / BASELINE_HEAD[:12]
BASELINE_HELPER_SHA = '071fb25edbdd62d9980912bcd20c90f015b5d7d29b5dfd2fbc4e8406e3966de8'
BASELINE_BINDING_SHA = 'd6b22836ac36e4536f6ec04bea42a548610b468fb088709a4db911a0a2991f34'
DEPENDENCIES = 'd9f03813fc808eced42eacb92db4530a2cd0e0824cab5d1beb9c3bdf08144bdd'
SOURCE_PACKAGE = 'c70b97f3ec0e6c339c5c27b0e9067549f9256287cfbfdf32f39ae46fcf54e231'
SOURCE_LOCK = '2a14af4f1bfdd86d0108015b43df14d62b2cc6e8eedcd3831446970a26d7d32a'
STATE_PARENT = ROOT / 'comment-access-updates'
ACTIVE = STATE_PARENT / 'active-release.json'
STAGES = Path('/var/lib/cisme-dependency-stage')
HELPER_SOURCE = 'infra/tencent/trial-comment-access-update.py'
NODE = '/opt/node-v24.14.0-linux-x64/bin/node'
IMDS = {'instance-id': 'ins-l9utqwxv', 'local-ipv4': '10.0.0.10', 'public-ipv4': '124.223.74.198'}
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
    result = {}
    for key, value in pairs:
        need(key not in result, 'COMMENT_ACCESS_DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def parse(raw):
    return json.loads(raw, object_pairs_hook=unique)


def read(path, limit=1024 * 1024):
    need(path.is_absolute() and '..' not in path.parts, 'COMMENT_ACCESS_ABSOLUTE_PATH_REQUIRED')
    for parent in reversed(path.parents):
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == OWNER and not info.st_mode & 0o022,
             'COMMENT_ACCESS_PROTECTED_PARENT_REQUIRED')
    permitted = (0o700, 0o750, 0o755) if path.parent == ROOT and path.name in HISTORY_ROOT else (0o700,)
    need(stat.S_IMODE(path.parent.lstat().st_mode) in permitted, 'COMMENT_ACCESS_PRIVATE_PARENT_REQUIRED')
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == OWNER and before.st_nlink == 1
             and stat.S_IMODE(before.st_mode) == 0o600 and 0 < before.st_size <= limit,
             'COMMENT_ACCESS_PROTECTED_FILE_REQUIRED')
        data = bytearray()
        while chunk := os.read(fd, min(65536, limit + 1 - len(data))):
            data.extend(chunk)
            need(len(data) <= limit, 'COMMENT_ACCESS_FILE_TOO_LARGE')
        after = os.fstat(fd)
        need(len(data) == before.st_size and (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
             == (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'COMMENT_ACCESS_FILE_CHANGED')
        return bytes(data)
    finally:
        os.close(fd)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Refused('COMMENT_ACCESS_REDIRECT_REFUSED')


def response(url, limit):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json',
        'Cache-Control': 'no-cache', 'User-Agent': 'cisme-trial-comment-access'})
    with opener.open(request, timeout=12) as remote:
        need(remote.status == 200, 'COMMENT_ACCESS_SOURCE_UNAVAILABLE')
        declared = remote.headers.get('Content-Length')
        need(declared is None or re.fullmatch(r'[0-9]+', declared) and 0 < int(declared) <= limit,
             'COMMENT_ACCESS_RESPONSE_SIZE_REQUIRED')
        raw = remote.read(limit + 1)
        need(0 < len(raw) <= limit and (declared is None or len(raw) == int(declared)), 'COMMENT_ACCESS_RESPONSE_TRUNCATED')
    return raw


def target():
    need(os.geteuid() == OWNER, 'COMMENT_ACCESS_ROOT_REQUIRED')
    actual = {name: response('http://metadata.tencentyun.com/latest/meta-data/' + name, 128).decode('ascii').strip() for name in IMDS}
    need(actual == IMDS, 'COMMENT_ACCESS_EXACT_IMDS_TARGET_REQUIRED')
    if D is not None:
        identity = D.general.observe.identity()
        need(identity.get('instanceId') == 'lhins-61ikz4mi' and identity.get('publicIpv4') == IMDS['public-ipv4'],
             'COMMENT_ACCESS_EXACT_INSTANCE_REQUIRED')


def load_baseline(active=True):
    global B, C, D
    target()
    path = BASELINE_RUNNER / 'trial-comment-support-upgrade.py'
    raw = read(path, 128 * 1024)
    need(sha(raw) == BASELINE_HELPER_SHA, 'COMMENT_ACCESS_PINNED_SCHEMA103_HELPER_REQUIRED')
    B = types.ModuleType('reviewed_schema103_baseline')
    B.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), B.__dict__)
    old_binding = B.binding(BASELINE_RUNNER / 'application-binding.json', BASELINE_BINDING_SHA)
    need(old_binding.get('sourceHead') == BASELINE_HEAD and old_binding.get('sourceTree') == BASELINE_TREE
         and old_binding.get('manifestSha256') == BASELINE_MANIFEST and old_binding.get('migrations') == 103,
         'COMMENT_ACCESS_SCHEMA103_BASELINE_BINDING_REQUIRED')
    if active:
        current = B.active_context(old_binding)
        C, D = B.C, B.D
        need(current['release'] == ROOT / 'releases' / ('tencent-release-' + BASELINE_HEAD[:12]),
             'COMMENT_ACCESS_BASELINE_RELEASE_REQUIRED')
        return current, old_binding
    # The current103 guard is only valid before changing units. Once switched,
    # load its pinned D/C primitives, never its old apply/preflight/active guard.
    B.load_baseline(False)
    C, D = B.C, B.D
    return None, old_binding


def validate_binding(b):
    need(b.get('schemaVersion') == 1 and b.get('kind') == 'trial-comment-access-update'
         and b.get('baselineHead') == BASELINE_HEAD and b.get('baselineTree') == BASELINE_TREE,
         'COMMENT_ACCESS_BASELINE_BINDING_REQUIRED')
    need(all(isinstance(b.get(key), str) and re.fullmatch(r'[0-9a-f]{40}', b[key]) and b[key] != '0' * 40
             for key in ('sourceHead', 'sourceTree')) and b['sourceHead'][:12] != BASELINE_HEAD[:12],
         'COMMENT_ACCESS_EXACT_NEW_SOURCE_REQUIRED')
    need(all(isinstance(b.get(key), str) and re.fullmatch(r'[0-9a-f]{64}', b[key])
             for key in ('helperSha256', 'manifestSha256', 'archiveSha256'))
         and type(b.get('archiveBytes')) is int and 0 < b['archiveBytes'] <= 512 * 1024 ** 2,
         'COMMENT_ACCESS_EXACT_ARTIFACT_REQUIRED')
    need(b.get('dependenciesSha256') == DEPENDENCIES and type(b.get('migrations')) is int and b['migrations'] == 103
         and b.get('applicationRollbackAllowed') is False and isinstance(b.get('migrationSha256'), dict)
         and len(b['migrationSha256']) == 103
         and all(isinstance(name, str) and re.fullmatch(r'\d+_[A-Za-z0-9_-]+\.sql', name)
                 and isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) for name, value in b['migrationSha256'].items()),
         'COMMENT_ACCESS_UNCHANGED_SCHEMA103_REQUIRED')
    archive = Path(b.get('archivePath', ''))
    need(archive.name == 'archive.tar.gz' and archive.parent.parent == STAGES
         and re.fullmatch(r'comment-access-' + b['sourceHead'][:12] + r'-[a-z0-9_-]{8,40}', archive.parent.name),
         'COMMENT_ACCESS_PRIVATE_ARCHIVE_PATH_REQUIRED')
    need(sha(read(Path(__file__), 128 * 1024)) == b['helperSha256'], 'COMMENT_ACCESS_EXACT_HELPER_REQUIRED')
    return b


def binding(path, expected):
    need(re.fullmatch(r'[0-9a-f]{64}', expected or ''), 'COMMENT_ACCESS_BINDING_SHA_REQUIRED')
    raw = read(path, 65536)
    need(sha(raw) == expected, 'COMMENT_ACCESS_BINDING_HASH_MISMATCH')
    return validate_binding(parse(raw))


def artifact_contract(old, candidate, b):
    before, after = old['manifest'], candidate['manifest']
    need(before.get('sourceHead') == BASELINE_HEAD and before.get('sourceTree') == BASELINE_TREE
         and old['manifestSha256'] == BASELINE_MANIFEST
         and old['directory'] == str(ROOT / 'releases' / ('tencent-release-' + BASELINE_HEAD[:12])),
         'COMMENT_ACCESS_EXACT_0CA_ARTIFACT_REQUIRED')
    need(after.get('sourceHead') == b['sourceHead'] and after.get('sourceTree') == b['sourceTree']
         and candidate['manifestSha256'] == b['manifestSha256'] and after.get('sourceLockSha256') == SOURCE_LOCK
         and candidate['directory'] == str(ROOT / 'releases' / ('tencent-release-' + b['sourceHead'][:12]))
         and after.get('node') == 'v24.14.0' and after.get('buildPlatform') == {'os': 'linux', 'arch': 'x64', 'libc': 'glibc'}
         and all(after.get(key) is False for key in ('configurationIncluded', 'deployed', 'releaseReady')),
         'COMMENT_ACCESS_EXACT_LINUX_ARTIFACT_REQUIRED')
    sql = before.get('migrations', [])
    need(len(sql) == 103 and sql == sorted(set(sql)) and sql[-1] == '202610300003_support_explicit_ai_resume.sql'
         and after.get('migrations') == sql and set(b['migrationSha256']) == set(sql),
         'COMMENT_ACCESS_NO_SQL_DELTA_REQUIRED')
    names = ['migrate.mjs', 'package.json', 'package-lock.json'] + ['db/migrations/' + name for name in sql]
    need(all(old['files'].get(name) and old['files'][name] == candidate['files'].get(name) for name in names),
         'COMMENT_ACCESS_SQL_MIGRATOR_OR_PACKAGE_CHANGED')
    need(all(sha(candidate['files']['db/migrations/' + name]) == b['migrationSha256'][name] for name in sql),
         'COMMENT_ACCESS_SQL_BINDING_HASH_MISMATCH')
    need(old['dependenciesSha256'] == candidate['dependenciesSha256'] == DEPENDENCIES,
         'COMMENT_ACCESS_FULL_DEPENDENCY_TREE_CHANGED')


def source_bytes(name, head):
    need(name in ('package.json', 'package-lock.json') and re.fullmatch(r'[0-9a-f]{40}', head), 'COMMENT_ACCESS_SOURCE_PATH_REQUIRED')
    value = parse(response('https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/contents/' + name + '?ref=' + head, 2 * 1024 ** 2))
    need(value.get('type') == 'file' and value.get('path') == name and value.get('encoding') == 'base64'
         and type(value.get('size')) is int and 0 < value['size'] <= 1024 * 1024 and isinstance(value.get('content'), str),
         'COMMENT_ACCESS_SOURCE_METADATA_REQUIRED')
    raw = base64.b64decode(value['content'].replace('\r', '').replace('\n', ''), validate=True)
    need(len(raw) == value['size'] and git_blob(raw) == value.get('sha'), 'COMMENT_ACCESS_SOURCE_BLOB_MISMATCH')
    return raw


def git_blob(raw):
    return hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()


def source_permit(b, candidate):
    base = 'https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/git/'
    commit = parse(response(base + 'commits/' + b['sourceHead'], 256 * 1024))
    need(commit.get('sha') == b['sourceHead'] and commit.get('tree', {}).get('sha') == b['sourceTree'],
         'COMMENT_ACCESS_COMMITTED_TREE_MISMATCH')
    tree = parse(response(base + 'trees/' + b['sourceTree'] + '?recursive=1', 4 * 1024 ** 2))
    need(tree.get('sha') == b['sourceTree'] and tree.get('truncated') is False and isinstance(tree.get('tree'), list),
         'COMMENT_ACCESS_COMPLETE_SOURCE_TREE_REQUIRED')
    entries = {}
    for item in tree['tree']:
        need(isinstance(item, dict) and isinstance(item.get('path'), str) and item['path'] not in entries,
             'COMMENT_ACCESS_SOURCE_TREE_ENTRY_INVALID')
        entries[item['path']] = item
    required = {HELPER_SOURCE: read(Path(__file__), 128 * 1024), 'scripts/release-migrate.mjs': candidate['files']['migrate.mjs']}
    required.update({'db/migrations/' + name: candidate['files']['db/migrations/' + name] for name in candidate['manifest']['migrations']})
    for name, raw in required.items():
        item = entries.get(name, {})
        need(item.get('type') == 'blob' and item.get('mode') in ('100644', '100755') and item.get('sha') == git_blob(raw),
             'COMMENT_ACCESS_COMMITTED_ARTIFACT_MISMATCH')
    need(sha(source_bytes('package.json', b['sourceHead'])) == SOURCE_PACKAGE
         and sha(source_bytes('package-lock.json', b['sourceHead'])) == SOURCE_LOCK,
         'COMMENT_ACCESS_COMMITTED_PACKAGE_OR_LOCK_CHANGED')
    # verify checks the immutable artifact only; it does not open a database.
    verified = parse(D.command([NODE, str(Path(candidate['directory']) / 'migrate.mjs'), 'verify']))
    need(verified.get('verified') is True and verified.get('sourceHead') == b['sourceHead']
         and verified.get('sourceTree') == b['sourceTree'] and verified.get('migrations') == 103,
         'COMMENT_ACCESS_COMPLETE_CANDIDATE_REQUIRED')


def optional_active():
    if STATE_PARENT.exists() or STATE_PARENT.is_symlink():
        D.owned_directory(STATE_PARENT, True)
    return read(ACTIVE, 65536) if ACTIVE.exists() or ACTIVE.is_symlink() else None


def capture_history():
    history = B.capture_history()
    history[str(B.ACTIVE)] = read(B.ACTIVE, 65536)
    return history


def protected_baseline_inputs(old_binding, history):
    active = parse(history[str(B.ACTIVE)])
    state = Path(active.get('upgradeState', ''))
    need(state.parent == B.STATE_PARENT and re.fullmatch(r'commit-' + BASELINE_HEAD[:12] + r'-[0-9]+', state.name),
         'COMMENT_ACCESS_BASELINE_PRIVATE_PLAN_PATH_REQUIRED')
    paths = [(BASELINE_RUNNER / 'trial-comment-support-upgrade.py', 128 * 1024),
             (BASELINE_RUNNER / 'application-binding.json', 65536),
             (Path(old_binding['deepseekKeyFile']), 256), (state / 'protected-plan.json', 8 * 1024 ** 2)]
    result = {str(path): {'sha256': sha(read(path, limit)), 'limit': limit} for path, limit in paths}
    need(result[str(state / 'protected-plan.json')]['sha256'] == active.get('privatePlanSha256'),
         'COMMENT_ACCESS_BASELINE_PRIVATE_PLAN_HASH_REQUIRED')
    return result


def verify_history(plan, allowed=()):
    need(all(read(Path(path), 65536) == raw for path, raw in plan['history'].items()), 'COMMENT_ACCESS_HISTORY_DRIFT')
    need(all(sha(read(Path(path), value['limit'])) == value['sha256'] for path, value in plan['protectedBaselineInputs'].items()),
         'COMMENT_ACCESS_BASELINE_PRIVATE_INPUT_DRIFT')
    need(optional_active() in (allowed or (None,)), 'COMMENT_ACCESS_UNKNOWN_ACTIVE_RECORD')


def verify_context(plan, candidate_allowed=False, allowed=(), exact_pids=True):
    target()
    C.fixed_profile(plan['profile'])
    D.verify_context(plan, provenance=False, allow_candidate=candidate_allowed)
    verify_history(plan, allowed)
    C.production_preserved(plan['production'], exact_pids)
    C.six_keys(plan['config'], plan['production']['config'])
    need(D.closed_context(plan['profile'], plan['config']) and plan['config'].get('APP_ENV') == 'staging',
         'COMMENT_ACCESS_CLOSED_TRIAL_REQUIRED')
    artifact_contract(D.artifact(plan['old']['directory'], ROOT), D.artifact(plan['candidate']['directory'], ROOT), plan['binding'])
    archive = read(Path(plan['binding']['archivePath']), 512 * 1024 ** 2)
    need(len(archive) == plan['binding']['archiveBytes'] and sha(archive) == plan['binding']['archiveSha256'],
         'COMMENT_ACCESS_PRIVATE_ARCHIVE_DRIFT')


def journal(plan, drain=False):
    value = C.database_guard(plan['profile'], plan['config'], plan['ownership'], [plan['old']['manifest']['migrations']], drain)
    B.schema103(plan['profile'])
    return value


def public_get(plan, path):
    profile = plan['profile']
    need(path.startswith('/v1/') and not any(value in path for value in ('\r', '\n', '#', '..')),
         'COMMENT_ACCESS_PUBLIC_PATH_REQUIRED')
    raw = D.command(['/usr/bin/curl', '--silent', '--show-error', '--noproxy', '*', '--connect-timeout', '3',
        '--max-time', '8', '--max-filesize', '262144', '--proto', '=https', '--request', 'GET',
        '--resolve', profile['domain'] + ':443:127.0.0.1', '--write-out', '\n%{http_code}', 'https://' + profile['domain'] + path])
    need(0 < len(raw) <= 262148 and b'\n' in raw, 'COMMENT_ACCESS_PUBLIC_RESPONSE_INVALID')
    body, code = raw.rsplit(b'\n', 1)
    need(re.fullmatch(rb'[0-9]{3}', code), 'COMMENT_ACCESS_PUBLIC_STATUS_INVALID')
    return int(code), parse(body)


def contains_comment_data(value):
    if isinstance(value, dict):
        return any(key in ('comments', 'authors', 'body') or contains_comment_data(item) for key, item in value.items())
    return isinstance(value, list) and any(contains_comment_data(item) for item in value)


def public_contract(plan):
    # Retain capabilities/legal gates without the historical anonymous-comment
    # success assumption in C.public_contract(..., True).
    C.public_contract(plan, False)
    status, listing = public_get(plan, '/v1/editorial/articles?limit=1')
    items = listing.get('items', []) if isinstance(listing, dict) else []
    need(status == 200 and len(items) == 1 and re.fullmatch(r'[0-9a-f-]{36}', items[0].get('id', '')),
         'COMMENT_ACCESS_PUBLIC_ARTICLE_LIST_REQUIRED')
    path = '/v1/editorial/articles/' + items[0]['id']
    status, article = public_get(plan, path)
    need(status == 200 and isinstance(article, dict) and article.get('id') == items[0]['id'],
         'COMMENT_ACCESS_PUBLIC_ARTICLE_REQUIRED')
    status, comments = public_get(plan, path + '/comments?limit=1')
    need(status == 401 and isinstance(comments, dict) and comments.get('status') == 401
         and comments.get('code') == 'AUTH_REQUIRED' and not contains_comment_data(comments),
         'COMMENT_ACCESS_GUEST_COMMENTS_NOT_CLOSED')


def preflight(b):
    current, old_binding = load_baseline(True)
    profile, config = current['profile'], current['config']
    C.fixed_profile(profile)
    need(optional_active() is None, 'COMMENT_ACCESS_EXISTING_UPDATE_REFUSED')
    need(config.get('APP_ENV') == 'staging' and config.get('WECHAT_APP_ID') == C.APP_ID and D.closed_context(profile, config)
         and config.get('WECHAT_PHONE_BINDING_ENABLED', 'false') == 'false'
         and config.get('COS_DIRECT_UPLOAD_ENABLED', 'false') == 'false'
         and config.get('SUPPORT_AI_ENABLED') == 'true' and config.get('DEEPSEEK_MODEL') == 'deepseek-flash'
         and config.get('SUPPORT_AI_TIMEOUT_MS') == '4000' and config.get('DEEPSEEK_API_KEY'),
         'COMMENT_ACCESS_CURRENT_TRIAL_AND_AI_CONTEXT_REQUIRED')
    old = D.artifact(str(current['release']), ROOT)
    candidate = D.artifact(str(ROOT / 'releases' / ('tencent-release-' + b['sourceHead'][:12])), ROOT)
    artifact_contract(old, candidate, b)
    archive = read(Path(b['archivePath']), 512 * 1024 ** 2)
    need(len(archive) == b['archiveBytes'] and sha(archive) == b['archiveSha256'], 'COMMENT_ACCESS_ARCHIVE_HASH_MISMATCH')
    source_permit(b, candidate)
    history = capture_history()
    protected = protected_baseline_inputs(old_binding, history)
    ownership = parse(history[str(ROOT / 'ownership.json')])
    production = C.production_capture()
    C.six_keys(config, production['config'])
    units = {unit: D.read_owned(D.unit_path(unit)) for unit in profile['units']}
    dropins = {unit: D.dropin_inputs(unit) for unit in profile['units']}
    definitions = {unit: D.unit_definition(unit, units[unit], entry, profile, dropins[unit])
                   for unit, entry in zip(profile['units'], ('index.js', 'worker.js'))}
    versions = D.native_smoke(profile, candidate['directory'], True)
    need(versions == D.native_smoke(profile, old['directory'], True), 'COMMENT_ACCESS_NATIVE_RUNTIME_CHANGED')
    plan = {'profile': profile, 'config': config, 'env': D.read_owned(ROOT / 'runtime.env', private=True),
        'environmentMetadata': D.environment_metadata(profile), 'privateInputs': D.private_inputs(profile, config),
        'old': old, 'candidate': candidate, 'units': units, 'dropIns': dropins, 'unitDefinitions': definitions,
        'ownership': ownership, 'initialRecords': {name: history[str(ROOT / name)] for name in HISTORY_ROOT[-3:]},
        'history': history, 'protectedBaselineInputs': protected, 'production': production, 'binding': b, 'versions': versions}
    verify_context(plan)
    journal(plan)
    return plan


def save_plan(plan, state):
    saved = dict(plan)
    for name in ('old', 'candidate'):
        saved[name] = {key: value for key, value in plan[name].items() if key != 'files'}
    raw = (json.dumps(C.encode_private(saved), sort_keys=True) + '\n').encode()
    need(len(raw) <= 8 * 1024 ** 2, 'COMMENT_ACCESS_PRIVATE_PLAN_TOO_LARGE')
    D.general.store(state / 'protected-plan.json', raw)
    return sha(raw)


def backup_inputs(plan, state):
    # Protected copies only. The original environment and private files are
    # never replaced or chmod/chown'ed by this application-only helper.
    D.general.store(state / 'previous.env', plan['env'])
    for unit, raw in plan['units'].items():
        D.general.store(state / unit, raw)
        if plan['dropIns'][unit]['files']:
            directory = state / 'drop-ins' / unit
            directory.parent.mkdir(mode=0o700, exist_ok=True)
            directory.mkdir(mode=0o700)
            for path, data in plan['dropIns'][unit]['files'].items():
                D.general.store(directory / Path(path).name, data)


def active_record(plan, state, plan_sha):
    selected = plan['candidate']
    return (json.dumps({'schemaVersion': 1, 'kind': 'trial-comment-access-active-release',
        'environment': 'trial', 'instanceId': 'lhins-61ikz4mi', 'database': 'cisme_trial',
        'sourceHead': selected['manifest']['sourceHead'], 'sourceTree': selected['manifest']['sourceTree'],
        'directory': selected['directory'], 'manifestSha256': selected['manifestSha256'],
        'dependenciesSha256': DEPENDENCIES, 'migrationCount': 103, 'baselineHead': BASELINE_HEAD,
        'ownershipId': plan['ownership']['ownershipId'], 'upgradeState': str(state), 'privatePlanSha256': plan_sha,
        'schemaChanged': False, 'configurationChanged': False, 'databaseRestored': False,
        'applicationRollbackAllowed': False, 'applicationRollbackExecuted': False,
        'commentLoginEnforced': True, 'guestCommentReadExposureRestored': False,
        'previousActiveHistoryPreserved': True}, sort_keys=True) + '\n').encode()


def cutover(plan, state, approval):
    try:
        plan_sha = save_plan(plan, state)
        backup_inputs(plan, state)
        verify_context(plan)
        journal(plan)
        D.command(['systemctl', 'stop', *plan['profile']['units']], timeout=90)
        D.stopped(plan['profile'])
        verify_context(plan)
        journal(plan, True)
        D.switch(plan, plan['candidate']['directory'])
        D.verify_units(plan, allow_candidate=True)
        verify_history(plan)
        started = time.time()
        D.command(['systemctl', 'start', *plan['profile']['units']], timeout=60)
        versions = D.healthy(plan, plan['candidate']['directory'], started, True)
        public_contract(plan)
        verify_context(plan, candidate_allowed=True)
        journal(plan)
        published = active_record(plan, state, plan_sha)
        D.atomic_bytes(ACTIVE, published)
        verify_context(plan, candidate_allowed=True, allowed=(published,))
        journal(plan)
        report = {'deployed': True, 'environment': 'trial', 'sourceHead': plan['binding']['sourceHead'],
            'migrationCountBefore': 103, 'migrationCountAfter': 103, 'schemaChanged': False,
            'commentLoginEnforced': True, 'publicArticleReadable': True, 'guestCommentStatus': 401,
            'configurationChanged': False, 'credentialsChanged': False, 'authorityGranted': False,
            'businessDataSeeded': False, 'databaseRestored': False, 'databaseSnapshotCreated': False,
            'applicationRollbackExecuted': False, 'previousActiveHistoryPreserved': True, 'productionChanged': False,
            'versions': versions}
        D.general.store(state / 'deployed.json', (json.dumps(report, sort_keys=True) + '\n').encode())
        return report
    except Exception:
        stopped = False
        try:
            D.command(['systemctl', 'stop', *plan['profile']['units']], timeout=90)
            D.stopped(plan['profile'])
            stopped = True
        except Exception:
            pass
        try:
            D.general.store(state / 'manual-recovery-required.json', (json.dumps({'servicesStopped': stopped,
                'unknownInputsOverwritten': False, 'databaseRestored': False, 'configurationChanged': False,
                'applicationRollbackExecuted': False, 'forwardRecoveryRequired': True,
                'legacyAnonymousReadExposurePreventsRollback': True}) + '\n').encode())
        except Exception:
            pass
        raise Refused('COMMENT_ACCESS_FAILED_FENCED_FORWARD_REVIEW_REQUIRED') from None


def active_context(b):
    validate_binding(b)
    load_baseline(False)
    target()
    raw = read(ACTIVE, 65536)
    active = parse(raw)
    state = Path(active.get('upgradeState', ''))
    need(state.parent == STATE_PARENT and re.fullmatch(r'commit-' + b['sourceHead'][:12] + r'-[0-9]+', state.name),
         'COMMENT_ACCESS_ACTIVE_STATE_PATH_REQUIRED')
    saved = read(state / 'protected-plan.json', 8 * 1024 ** 2)
    need(sha(saved) == active.get('privatePlanSha256'), 'COMMENT_ACCESS_ACTIVE_PRIVATE_PLAN_DRIFT')
    plan = C.decode_private(parse(saved))
    need(plan.get('binding') == b, 'COMMENT_ACCESS_ACTIVE_BINDING_DRIFT')
    for label in ('old', 'candidate'):
        plan[label] = D.artifact(plan[label]['directory'], ROOT)
    artifact_contract(plan['old'], plan['candidate'], b)
    selected = plan['candidate']
    need(raw == active_record(plan, state, sha(saved)), 'COMMENT_ACCESS_ACTIVE_RECORD_DRIFT')
    verify_context(plan, candidate_allowed=True, allowed=(raw,), exact_pids=False)
    for unit, entry in zip(plan['profile']['units'], ('index.js', 'worker.js')):
        need(D.unit_entry(D.read_owned(D.unit_path(unit)), entry, plan['profile']) == Path(selected['directory']),
             'COMMENT_ACCESS_ACTIVE_UNIT_PATH_REQUIRED')
    D.running(plan['profile'], selected['directory'], plan['config'])
    journal(plan)
    public_contract(plan)
    return {'profile': plan['profile'], 'config': plan['config'], 'release': Path(selected['directory']),
            'sourceHead': selected['manifest']['sourceHead'], 'commentLoginEnforced': True}


def apply(b, approval):
    need(re.fullmatch(r'[-A-Za-z0-9_:.]{8,120}', approval or ''), 'COMMENT_ACCESS_OPERATION_REFERENCE_REQUIRED')
    target()
    lock = Path('/run/lock/cisme-production-trial.lock')
    parent = lock.parent.lstat()
    need(stat.S_ISDIR(parent.st_mode) and parent.st_uid == OWNER and stat.S_IMODE(parent.st_mode) == 0o1777,
         'COMMENT_ACCESS_LOCK_PARENT_REQUIRED')
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
             'COMMENT_ACCESS_LOCK_REQUIRED')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan = preflight(b)
        STATE_PARENT.mkdir(mode=0o700, exist_ok=True)
        D.owned_directory(STATE_PARENT, True)
        marker = STATE_PARENT / ('update-' + b['sourceHead'][:12] + '.started.json')
        created = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(created, 'wb') as stream:
            stream.write((json.dumps({'sourceHead': b['sourceHead'], 'operationReference': approval}) + '\n').encode())
            stream.flush()
            os.fsync(stream.fileno())
        state = STATE_PARENT / ('commit-' + b['sourceHead'][:12] + '-' + str(time.time_ns()))
        state.mkdir(mode=0o700)
        return cutover(plan, state, approval)
    finally:
        os.close(fd)


def safe_error_code(error):
    value = str(error) if isinstance(error, Refused) else ''
    return value if re.fullmatch(r'COMMENT_ACCESS_[A-Z0-9_]{1,110}', value) else 'COMMENT_ACCESS_REVIEW_REQUIRED'


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
            value = active_context(b)
            result = {'readOnly': True, 'activeVerified': True, 'sourceHead': value['sourceHead'],
                'migrationCount': 103, 'commentLoginEnforced': value['commentLoginEnforced']}
        else:
            plan = preflight(b)
            result = {'readOnly': True, 'deployed': False, 'sourceHead': plan['binding']['sourceHead'],
                'migrationCountBefore': 103, 'migrationCountAfter': 103, 'schemaChanged': False,
                'configurationChanged': False, 'productionPreserved': True, 'databaseSnapshotRequired': False}
        print(json.dumps({**result, 'privateValuesExported': False}, sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({'ok': False, 'code': safe_error_code(error), 'privateValuesExported': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
