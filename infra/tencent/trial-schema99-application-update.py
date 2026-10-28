#!/usr/bin/env python3
"""Exact da7/schema99 -> new-main/schema99 application update, trial only.

Default is read-only. Never migrates, restores, seeds, changes configuration or
rewrites earlier active records. The installed da7 guard is only a baseline
reader; this update owns its independent active record after the switch.
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
BASELINE_HEAD = 'da7f4c9ac858e557d2876349fb169dade45cf1b2'
BASELINE_TREE = '799ec66034d90b293a01fa1a3d2dd2729a759afc'
BASELINE_MANIFEST = '9a640fc359ac843c5e427bc08cac2240e56e6a81828513377c2cc27cfc6618b9'
BASELINE_ARCHIVE = 'ea3158071eb5dfdd5815da58828cdf30e18f752b47a3d0b53d09163eb67bdbd1'
BASELINE_ARCHIVE_BYTES = 25628134
BASELINE_RUNNER = ROOT / 'editorial-comment-runners' / BASELINE_HEAD[:12]
BASELINE_HELPER_SHA = '7a67c3b3c6d76b1b2f2ff23fc69f34081ad54b5e1e5e94d5f1b8f9ced28dc99b'
BASELINE_BINDING_SHA = '3af97906e01f64d7479850bb46ad6f21cd04d20694610f8fb4dad621cab9efe0'
DEPENDENCIES = 'd9f03813fc808eced42eacb92db4530a2cd0e0824cab5d1beb9c3bdf08144bdd'
SOURCE_PACKAGE = 'c70b97f3ec0e6c339c5c27b0e9067549f9256287cfbfdf32f39ae46fcf54e231'
SOURCE_LOCK = '2a14af4f1bfdd86d0108015b43df14d62b2cc6e8eedcd3831446970a26d7d32a'
MIGRATION = '202610280001_editorial_comments.sql'
MIGRATION_SHA = 'cd945b213a0c546d27ff2a1ef6e7d1a90a232ec25d680415d45aa7113c64f3c1'
STATE_PARENT = ROOT / 'schema99-application-updates'
ACTIVE = STATE_PARENT / 'active-release.json'
STAGES = Path('/var/lib/cisme-dependency-stage')
HELPER_NAME = 'trial-schema99-application-update.py'
HELPER_SOURCE = 'infra/tencent/' + HELPER_NAME
NODE = '/opt/node-v24.14.0-linux-x64/bin/node'
C = D = None


class Refused(RuntimeError):
    pass


def need(value, code='SCHEMA99_APPLICATION_REFUSED'):
    if not value:
        raise Refused(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def unique(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, 'SCHEMA99_DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def parse(raw):
    return json.loads(raw, object_pairs_hook=unique)


def parents(path, private=False):
    need(path.is_absolute() and '..' not in path.parts, 'SCHEMA99_ABSOLUTE_PATH_REQUIRED')
    for parent in reversed(path.parents):
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == OWNER and not info.st_mode & 0o022,
             'SCHEMA99_ROOT_PROTECTED_PARENT_REQUIRED')
    if private:
        record = path.parent == ROOT and path.name in (
            'dependency-active-release.json', 'application-active-release.json',
            'editorial-comments-active-release.json', 'ownership.json',
            'empty-database.json', 'migration-complete.json')
        need(stat.S_IMODE(path.parent.lstat().st_mode) in ((0o700, 0o750, 0o755) if record else (0o700,)),
             'SCHEMA99_PRIVATE_PARENT_REQUIRED')


def read(path, limit=1024 * 1024, private=False):
    parents(path, private)
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == OWNER and before.st_nlink == 1
             and not before.st_mode & (0o077 if private else 0o022) and 0 < before.st_size <= limit,
             'SCHEMA99_PROTECTED_FILE_REQUIRED')
        data = bytearray()
        while chunk := os.read(fd, min(65536, limit + 1 - len(data))):
            data.extend(chunk)
            need(len(data) <= limit, 'SCHEMA99_FILE_TOO_LARGE')
        after = os.fstat(fd)
        need(len(data) == before.st_size and (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
             == (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'SCHEMA99_FILE_CHANGED')
        return bytes(data)
    finally:
        os.close(fd)


def load_baseline(active=False):
    global C, D
    need(os.geteuid() == OWNER, 'SCHEMA99_ROOT_REQUIRED')
    path = BASELINE_RUNNER / 'trial-editorial-comments-upgrade.py'
    raw = read(path, 128 * 1024, True)
    need(sha(raw) == BASELINE_HELPER_SHA, 'SCHEMA99_PINNED_DA7_GUARD_REQUIRED')
    C = types.ModuleType('reviewed_da7_schema99_baseline')
    C.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), C.__dict__)
    binding = C.binding(BASELINE_RUNNER / 'application-binding.json', BASELINE_BINDING_SHA)
    need(binding['sourceHead'] == BASELINE_HEAD and binding['sourceTree'] == BASELINE_TREE
         and binding['manifestSha256'] == BASELINE_MANIFEST and binding['archiveSha256'] == BASELINE_ARCHIVE
         and binding['archiveBytes'] == BASELINE_ARCHIVE_BYTES, 'SCHEMA99_DA7_BINDING_REQUIRED')
    if active:
        result = C.active_context(binding)
        D = result['D']
        return result
    # Loading pinned primitives is safe after the switch; invoking the old
    # da7/98 active guard here would reject the deliberately changed units.
    C.load_primitives(False)
    D = C.D
    return None


def validate_binding(b):
    need(b.get('schemaVersion') == 1 and b.get('kind') == 'trial-schema99-application-update'
         and b.get('baselineHead') == BASELINE_HEAD and b.get('baselineTree') == BASELINE_TREE,
         'SCHEMA99_BASELINE_BINDING_REQUIRED')
    need(all(isinstance(b.get(key), str) and re.fullmatch(r'[0-9a-f]{40}', b[key]) and b[key] != '0' * 40
             for key in ('sourceHead', 'sourceTree')) and b['sourceHead'] != BASELINE_HEAD
         and type(b.get('ciRunId')) is int and b['ciRunId'] > 0, 'SCHEMA99_EXACT_NEW_MAIN_REQUIRED')
    need(all(isinstance(b.get(key), str) and re.fullmatch(r'[0-9a-f]{64}', b[key])
             for key in ('helperSha256', 'manifestSha256', 'archiveSha256', 'stageReceiptSha256'))
         and type(b.get('archiveBytes')) is int and 0 < b['archiveBytes'] <= 512 * 1024 ** 2,
         'SCHEMA99_FINAL_ARTIFACT_REQUIRED')
    need(b.get('dependenciesSha256') == DEPENDENCIES and type(b.get('migrations')) is int and b['migrations'] == 99,
         'SCHEMA99_UNCHANGED_SCHEMA_REQUIRED')
    need(sha(read(Path(__file__), 128 * 1024, True)) == b['helperSha256'], 'SCHEMA99_EXACT_HELPER_REQUIRED')
    return b


def binding(path, expected):
    need(re.fullmatch(r'[0-9a-f]{64}', expected or ''), 'SCHEMA99_BINDING_SHA_REQUIRED')
    raw = read(path, 65536, True)
    need(sha(raw) == expected, 'SCHEMA99_BINDING_HASH_MISMATCH')
    return validate_binding(parse(raw))


def artifact_contract(old, candidate, b):
    before, after = old['manifest'], candidate['manifest']
    need(before.get('sourceHead') == BASELINE_HEAD and before.get('sourceTree') == BASELINE_TREE
         and old['manifestSha256'] == BASELINE_MANIFEST, 'SCHEMA99_DA7_ARTIFACT_REQUIRED')
    need(after.get('sourceHead') == b['sourceHead'] and after.get('sourceTree') == b['sourceTree']
         and candidate['manifestSha256'] == b['manifestSha256'] and after.get('sourceLockSha256') == SOURCE_LOCK
         and after.get('node') == 'v24.14.0' and after.get('buildPlatform') == {'os': 'linux', 'arch': 'x64', 'libc': 'glibc'}
         and all(after.get(key) is False for key in ('configurationIncluded', 'deployed', 'releaseReady')),
         'SCHEMA99_EXACT_LINUX_ARTIFACT_REQUIRED')
    sql = before.get('migrations', [])
    need(len(sql) == 99 and sql == sorted(set(sql)) and sql[-1] == MIGRATION
         and after.get('migrations') == sql and old['directory'] != candidate['directory'],
         'SCHEMA99_NO_SQL_DELTA_REQUIRED')
    names = ['migrate.mjs', 'package.json', 'package-lock.json'] + ['db/migrations/' + name for name in sql]
    need(all(old['files'].get(name) and old['files'][name] == candidate['files'].get(name) for name in names),
         'SCHEMA99_SQL_MIGRATOR_OR_PACKAGE_CHANGED')
    need(sha(candidate['files']['db/migrations/' + MIGRATION]) == MIGRATION_SHA, 'SCHEMA99_SQL99_HASH_REQUIRED')
    need(old['dependenciesSha256'] == candidate['dependenciesSha256'] == DEPENDENCIES,
         'SCHEMA99_FULL_DEPENDENCY_TREE_CHANGED')


def github_helper_source(head):
    need(re.fullmatch(r'[0-9a-f]{40}', head or ''), 'SCHEMA99_SOURCE_HEAD_REQUIRED')
    # Only this one repository path, official HTTPS endpoint and exact ref.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), D.general.observe.NoRedirect())
    request = urllib.request.Request('https://api.github.com/repos/' + D.general.REPO + '/contents/' + HELPER_SOURCE + '?ref=' + head,
        headers={'Accept': 'application/vnd.github+json', 'Cache-Control': 'no-cache', 'User-Agent': 'cisme-schema99-application-update'})
    value = parse(C.source_response(opener, request, 256 * 1024))
    need(isinstance(value, dict) and value.get('type') == 'file' and value.get('path') == HELPER_SOURCE
         and value.get('encoding') == 'base64' and type(value.get('size')) is int and 0 < value['size'] <= 128 * 1024
         and isinstance(value.get('sha'), str) and re.fullmatch(r'[0-9a-f]{40}', value['sha'])
         and isinstance(value.get('content'), str), 'SCHEMA99_HELPER_SOURCE_METADATA_REQUIRED')
    try:
        raw = base64.b64decode(value['content'].replace('\r', '').replace('\n', ''), validate=True)
    except (ValueError, TypeError):
        raise Refused('SCHEMA99_HELPER_SOURCE_ENCODING_INVALID') from None
    need(len(raw) == value['size'] and hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == value['sha'],
         'SCHEMA99_HELPER_SOURCE_BLOB_MISMATCH')
    return raw


def source_permit(b, candidate, main):
    C.source_permit(b, candidate, main)
    need(sha(github_helper_source(b['sourceHead'])) == b['helperSha256'], 'SCHEMA99_HELPER_NOT_COMMITTED_MAIN')


def stage_binding(b, candidate):
    path = Path(b.get('stageReceipt', ''))
    need(path.name == 'stage-receipt.json' and path.parent.parent == STAGES
         and re.fullmatch(r'schema99-' + b['sourceHead'][:12] + r'-[a-z0-9_]{8}', path.parent.name),
         'SCHEMA99_STAGE_PATH_REQUIRED')
    raw = read(path, 65536, True)
    need(sha(raw) == b['stageReceiptSha256'], 'SCHEMA99_STAGE_RECEIPT_DRIFT')
    r = parse(raw)
    need(r.get('kind') == 'trial-schema99-application-stage' and r.get('staged') is True and r.get('deployed') is False
         and r.get('instanceId') == 'lhins-61ikz4mi' and r.get('publicIpv4') == '124.223.74.198'
         and r.get('baselineHead') == BASELINE_HEAD and r.get('sourceHead') == b['sourceHead'] and r.get('sourceTree') == b['sourceTree']
         and r.get('archiveSha256') == b['archiveSha256'] and r.get('archiveSize') == b['archiveBytes']
         and r.get('manifestSha256') == b['manifestSha256'] and r.get('dependenciesSha256') == DEPENDENCIES
         and r.get('migrations') == 99 and r.get('helperSha256') == b['helperSha256']
         and r.get('privateStage') == str(path.parent) and r.get('candidateDirectories') == [candidate['directory']]
         and all(r.get(key) is False for key in ('servicesChanged', 'databaseChanged', 'configurationChanged', 'productionChanged', 'peerFilesChanged')),
         'SCHEMA99_STAGE_BINDING_MISMATCH')
    archive = read(path.parent / 'archive.tar.gz', 512 * 1024 ** 2, True)
    need(len(archive) == b['archiveBytes'] and sha(archive) == b['archiveSha256'], 'SCHEMA99_ARCHIVE_MISMATCH')
    return str(path)


def optional_active():
    if STATE_PARENT.exists() or STATE_PARENT.is_symlink():
        D.owned_directory(STATE_PARENT, True)
    return read(ACTIVE, 65536, True) if ACTIVE.exists() or ACTIVE.is_symlink() else None


def verify_history(plan, active_allowed=()):
    need(all(read(ROOT / name, private=True) == value for name, value in plan['historicalActive'].items()),
         'SCHEMA99_HISTORICAL_ACTIVE_DRIFT')
    need(optional_active() in (active_allowed or (None,)), 'SCHEMA99_UNKNOWN_ACTIVE_DRIFT')


def verify_context(plan, provenance=True, candidate_allowed=False, active_allowed=(), exact_production_pids=True):
    C.fixed_profile(plan['profile'])
    D.verify_context(plan, provenance=provenance, allow_candidate=candidate_allowed)
    verify_history(plan, active_allowed)
    C.production_preserved(plan['production'], exact_production_pids)
    C.six_keys(plan['config'], plan['production']['config'])
    need(sha(read(Path(plan['stageReceipt']), 65536, True)) == plan['binding']['stageReceiptSha256'],
         'SCHEMA99_STAGE_RECEIPT_DRIFT')
    need(C.article_fence(plan['profile']) == plan['articleFence'], 'SCHEMA99_EXISTING_ARTICLE_FACTS_DRIFT')


def journal(plan, drain=False):
    result = C.database_guard(plan['profile'], plan['config'], plan['ownership'], [plan['old']['manifest']['migrations']], drain)
    C.schema99(plan['profile'])
    return result


def preflight(b):
    current = load_baseline(True)
    profile, config = current['profile'], current['config']
    C.fixed_profile(profile)
    need(optional_active() is None, 'SCHEMA99_EXISTING_UPDATE_REFUSED')
    need(config.get('APP_ENV') == 'staging' and config.get('WECHAT_APP_ID') == C.APP_ID and D.closed_context(profile, config)
         and config.get('WECHAT_PHONE_BINDING_ENABLED', 'false') == 'false'
         and config.get('COS_DIRECT_UPLOAD_ENABLED', 'false') == 'false', 'SCHEMA99_CLOSED_TRIAL_REQUIRED')
    old = D.artifact(str(current['release']), ROOT)
    candidate = D.artifact(str(ROOT / 'releases' / ('tencent-release-' + b['sourceHead'][:12])), ROOT)
    artifact_contract(old, candidate, b)
    main = D.general.reviewed_main()
    source_permit(b, candidate, main)
    stage = stage_binding(b, candidate)
    initial = {name: read(ROOT / name, private=True) for name in ('ownership.json', 'empty-database.json', 'migration-complete.json')}
    ownership = parse(initial['ownership.json'])
    production = C.production_capture()
    C.six_keys(config, production['config'])
    C.database_guard(profile, config, ownership, [old['manifest']['migrations']])
    C.schema99(profile)
    fence = C.article_fence(profile)
    need(fence.get('publishedCount') == 20, 'SCHEMA99_CURRENT20_REQUIRED')
    units = {unit: D.read_owned(D.unit_path(unit)) for unit in profile['units']}
    dropins = {unit: D.dropin_inputs(unit) for unit in profile['units']}
    definitions = {unit: D.unit_definition(unit, units[unit], entry, profile, dropins[unit])
                   for unit, entry in zip(profile['units'], ('index.js', 'worker.js'))}
    versions = D.native_smoke(profile, old['directory'], True)
    need(versions == D.native_smoke(profile, candidate['directory'], True), 'SCHEMA99_NATIVE_RUNTIME_CHANGED')
    # D.read_owned(private=True) permits service-group read (mask 0027),
    # unlike this module's root-only metadata reader. Metadata requires 0640.
    return {'profile': profile, 'main': main, 'old': old, 'candidate': candidate, 'config': config,
        'env': D.read_owned(ROOT / 'runtime.env', private=True), 'environmentMetadata': D.environment_metadata(profile),
        'privateInputs': D.private_inputs(profile, config), 'units': units, 'dropIns': dropins, 'unitDefinitions': definitions,
        'ownership': ownership, 'initialRecords': initial, 'production': production, 'articleFence': fence, 'versions': versions,
        'historicalActive': {name: read(ROOT / name, private=True) for name in
            ('dependency-active-release.json', 'application-active-release.json', 'editorial-comments-active-release.json')},
        'stageReceipt': stage, 'binding': b}


def save_plan(plan, state):
    saved = dict(plan)
    for name in ('old', 'candidate'):
        saved[name] = {key: value for key, value in plan[name].items() if key != 'files'}
    raw = (json.dumps(C.encode_private(saved), sort_keys=True) + '\n').encode()
    need(len(raw) <= 8 * 1024 ** 2, 'SCHEMA99_PRIVATE_PLAN_TOO_LARGE')
    D.general.store(state / 'protected-plan.json', raw)
    return sha(raw)


def active_record(plan, state, plan_sha, selected, rollback=False):
    return (json.dumps({'schemaVersion': 1, 'kind': 'trial-schema99-application-active-release',
        'environment': 'trial', 'instanceId': 'lhins-61ikz4mi', 'database': 'cisme_trial',
        'sourceHead': selected['manifest']['sourceHead'], 'sourceTree': selected['manifest']['sourceTree'],
        'directory': selected['directory'], 'manifestSha256': selected['manifestSha256'],
        'dependenciesSha256': DEPENDENCIES, 'baselineHead': BASELINE_HEAD, 'migrationCount': 99,
        'ownershipId': plan['ownership']['ownershipId'], 'upgradeState': str(state), 'privatePlanSha256': plan_sha,
        'schemaChanged': False, 'databaseRestored': False, 'applicationRollback': rollback,
        'previousActiveHistoryPreserved': True}, sort_keys=True) + '\n').encode()


def cutover(plan, state, approval):
    C.fixed_profile(plan['profile'])
    plan_sha = save_plan(plan, state)
    halted, published = False, None
    try:
        verify_context(plan)
        journal(plan)
        halted = True
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
        C.public_contract(plan, True)
        verify_context(plan, candidate_allowed=True)
        journal(plan)
        published = active_record(plan, state, plan_sha, plan['candidate'])
        D.atomic_bytes(ACTIVE, published)
        verify_context(plan, provenance=False, candidate_allowed=True, active_allowed=(published,))
        journal(plan)
        report = {'deployed': True, 'environment': 'trial', 'sourceHead': plan['main']['sha'],
            'migrationCountBefore': 99, 'migrationCountAfter': 99, 'schemaChanged': False,
            'databaseRestored': False, 'existing20ArticlesPreserved': True, 'commentsDatabaseRetained': True,
            'configurationChanged': False, 'credentialsChanged': False, 'productionChanged': False,
            'businessDataSeeded': False, 'consentCreated': False, 'authorityGranted': False}
        D.general.store(state / 'deployed.json', (json.dumps(report, sort_keys=True) + '\n').encode())
        return report
    except Exception:
        if not halted:
            raise
        try:
            D.command(['systemctl', 'stop', *plan['profile']['units']], timeout=90)
            D.stopped(plan['profile'])
            verify_context(plan, provenance=False, candidate_allowed=True, active_allowed=(published,) if published else ())
            journal(plan, True)
            D.switch(plan, plan['old']['directory'])
            D.verify_units(plan)
            # Unknown unit/active/input drift must be rejected before restart.
            verify_history(plan, (published,) if published else ())
            started = time.time()
            D.command(['systemctl', 'start', *plan['profile']['units']], timeout=60)
            D.healthy(plan, plan['old']['directory'], started, True)
            C.public_contract(plan, True)
            verify_context(plan, provenance=False, active_allowed=(published,) if published else ())
            journal(plan)
            restored = active_record(plan, state, plan_sha, plan['old'], True)
            D.atomic_bytes(ACTIVE, restored)
            verify_context(plan, provenance=False, active_allowed=(restored,))
            D.general.store(state / 'application-rollback.json', b'{"applicationRestored":true,"databaseRestored":false,"migrationCount":99}\n')
        except Exception:
            stopped = False
            try:
                D.command(['systemctl', 'stop', *plan['profile']['units']], timeout=90)
                D.stopped(plan['profile'])
                stopped = True
            except Exception:
                pass
            D.general.store(state / 'manual-recovery-required.json', (json.dumps({
                'servicesStopped': stopped, 'unknownInputsOverwritten': False, 'databaseRestored': False}) + '\n').encode())
            raise Refused('SCHEMA99_FAILED_FENCED_REVIEW_REQUIRED') from None
        raise Refused('SCHEMA99_FAILED_DA7_APPLICATION_RESTORED_DATABASE_RETAINED') from None


def active_context(b):
    validate_binding(b)
    load_baseline(False)
    identity = D.general.observe.identity()
    need(identity.get('instanceId') == 'lhins-61ikz4mi' and identity.get('publicIpv4') == '124.223.74.198',
         'SCHEMA99_EXACT_INSTANCE_REQUIRED')
    raw = read(ACTIVE, 65536, True)
    active = parse(raw)
    state = Path(active.get('upgradeState', ''))
    need(state.parent == STATE_PARENT and re.fullmatch(r'main-' + b['sourceHead'][:12] + r'-[0-9]+', state.name),
         'SCHEMA99_ACTIVE_STATE_PATH_REQUIRED')
    saved = read(state / 'protected-plan.json', 8 * 1024 ** 2, True)
    need(sha(saved) == active.get('privatePlanSha256'), 'SCHEMA99_PRIVATE_PLAN_DRIFT')
    plan = C.decode_private(parse(saved))
    need(plan.get('binding') == b, 'SCHEMA99_ACTIVE_BINDING_DRIFT')
    C.fixed_profile(plan['profile'])
    old, candidate = (D.artifact(plan[key]['directory'], ROOT) for key in ('old', 'candidate'))
    artifact_contract(old, candidate, b)
    need(raw == active_record(plan, state, sha(saved), candidate), 'SCHEMA99_NEW_ACTIVE_RELEASE_REQUIRED')
    verify_context(plan, provenance=False, candidate_allowed=True, active_allowed=(raw,), exact_production_pids=False)
    for unit, entry in zip(plan['profile']['units'], ('index.js', 'worker.js')):
        need(D.unit_entry(D.read_owned(D.unit_path(unit)), entry, plan['profile']) == Path(candidate['directory']),
             'SCHEMA99_ACTIVE_UNIT_PATH_REQUIRED')
    D.running(plan['profile'], candidate['directory'], plan['config'])
    journal(plan)
    return {'C': C, 'D': D, 'profile': plan['profile'], 'config': plan['config'],
            'release': Path(candidate['directory']), 'binding': b}


def apply(b, approval):
    need(re.fullmatch(r'[-A-Za-z0-9_:.]{8,120}', approval or ''), 'SCHEMA99_OPERATION_REFERENCE_REQUIRED')
    need(os.geteuid() == OWNER, 'SCHEMA99_ROOT_REQUIRED')
    load_baseline(False)
    identity = D.general.observe.identity()
    need(identity.get('instanceId') == 'lhins-61ikz4mi' and identity.get('publicIpv4') == '124.223.74.198',
         'SCHEMA99_EXACT_INSTANCE_REQUIRED')
    lock = Path('/run/lock/cisme-production-trial.lock')
    before = lock.parent.lstat()
    need(stat.S_ISDIR(before.st_mode) and before.st_uid == OWNER and stat.S_IMODE(before.st_mode) == 0o1777,
         'SCHEMA99_LOCK_PARENT_REQUIRED')
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
             'SCHEMA99_LOCK_REQUIRED')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan = preflight(b)
        STATE_PARENT.mkdir(mode=0o700, exist_ok=True)
        D.owned_directory(STATE_PARENT, True)
        fd_marker = os.open(STATE_PARENT / ('update-' + b['sourceHead'][:12] + '.started.json'),
                            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd_marker, 'wb') as stream:
            stream.write((json.dumps({'sourceHead': b['sourceHead'], 'operationReference': approval}, sort_keys=True) + '\n').encode())
            stream.flush()
            os.fsync(stream.fileno())
        state = STATE_PARENT / ('main-' + b['sourceHead'][:12] + '-' + str(time.time_ns()))
        state.mkdir(mode=0o700)
        return cutover(plan, state, approval)
    finally:
        os.close(fd)


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
            result = {'readOnly': True, 'activeVerified': True, 'sourceHead': b['sourceHead'], 'migrationCount': 99}
        else:
            plan = preflight(b)
            result = {'readOnly': True, 'deployed': False, 'sourceHead': plan['main']['sha'],
                      'migrationCountBefore': 99, 'migrationCountAfter': 99, 'schemaChanged': False, 'productionPreserved': True}
        print(json.dumps({**result, 'privateValuesExported': False}, sort_keys=True))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, Refused) else ''
        print(json.dumps({'ok': False, 'code': code if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', code)
                         else 'SCHEMA99_APPLICATION_REVIEW_REQUIRED', 'privateValuesExported': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
