#!/usr/bin/env python3
"""Exact deployed d6dd/schema105 -> direct-publication/schema106 trial update.

Trial only; the default preflight is read-only. Never changes environment,
credentials, authority or original business facts. Only the pinned106 index
migration may run after an authenticated encrypted snapshot and writer drain.
Only the existing two trial units switch; any failure requires forward recovery.
"""
import argparse
import base64
import fcntl
import hashlib
import http.client
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
BASELINE_HEAD = 'd6dda6399b373be96296f37a6fd749537f1b4712'
BASELINE_TREE = '9f83d9e55bb5efef3e1ffc63f884d45ddb143d50'
BASELINE_MANIFEST = 'd435eb1d9496ff9eb6c8b8b3a2f1bac3952550f24051d513259fe4e3ac383e80'
BASELINE_RUNNER = ROOT / 'community-compose-runners' / BASELINE_HEAD[:12]
BASELINE_HELPER_SHA = 'cefbe7fc98d4918e649b21db41816e65253207c67708f31f9d221d326a0057ce'
BASELINE_BINDING_SHA = 'a0ac016773a0d39703e05bc931432b55b383cd6eea65ea0f5550feb37eac3023'
DEPENDENCIES = 'd9f03813fc808eced42eacb92db4530a2cd0e0824cab5d1beb9c3bdf08144bdd'
SOURCE_PACKAGE = 'c70b97f3ec0e6c339c5c27b0e9067549f9256287cfbfdf32f39ae46fcf54e231'
SOURCE_LOCK = '2a14af4f1bfdd86d0108015b43df14d62b2cc6e8eedcd3831446970a26d7d32a'
STATE_PARENT = ROOT / 'community-direct-publication-updates'
ACTIVE = STATE_PARENT / 'active-release.json'
RUNNERS = ROOT / 'community-direct-publication-runners'
STAGES = Path('/var/lib/cisme-dependency-stage')
HELPER_SOURCE = 'infra/tencent/trial-community-direct-publication-update.py'
NODE = '/opt/node-v24.14.0-linux-x64/bin/node'
IMDS = {'instance-id': 'ins-l9utqwxv', 'local-ipv4': '10.0.0.10', 'public-ipv4': '124.223.74.198'}
HISTORY_ROOT = ('dependency-active-release.json', 'application-active-release.json', 'editorial-comments-active-release.json',
                'ownership.json', 'empty-database.json', 'migration-complete.json')
MIGRATION = '202611030001_direct_publication_lookup.sql'
MIGRATION_SHA = 'f69195ea062737f462026be02af20c0c462cb9c9c7ab03612df672e1aa2022c2'
POST_GUARD_104_SHA = '21aea3c71b6c2053fb22a9d0cb723d9190e346ee1920b9c6bfeda186e18f7669'
POST_GUARD_105_SHA = '2b12016e0aa44aed7322d2922b2319e64964eac88980b1a83825239cec433256'
REVISION_GUARD_SHA = '6725e8839be8893b2c6d399e37479e790041221cfde058af9f85297fbb6d6dd8'
SNAPSHOT_RUNNER = ROOT / 'daily-day-runners' / 'a4afe72b4b3a'
SNAPSHOT_HELPER_SHA = '5394c9f4719319b0ca534c63ca65bcb3b003c6331585901ddea0aee348c3d8e2'
CLEAN = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}
H = C = D = S = K = None


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
        need(key not in result, 'COMMUNITY_DIRECT_DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def parse(raw):
    return json.loads(raw, object_pairs_hook=unique)


def read(path, limit=1024 * 1024):
    need(path.is_absolute() and '..' not in path.parts, 'COMMUNITY_DIRECT_ABSOLUTE_PATH_REQUIRED')
    for parent in reversed(path.parents):
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == OWNER and not info.st_mode & 0o022,
             'COMMUNITY_DIRECT_PROTECTED_PARENT_REQUIRED')
    permitted = (0o700, 0o750, 0o755) if path.parent == ROOT and path.name in HISTORY_ROOT else (0o700,)
    need(stat.S_IMODE(path.parent.lstat().st_mode) in permitted, 'COMMUNITY_DIRECT_PRIVATE_PARENT_REQUIRED')
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == OWNER and before.st_nlink == 1
             and stat.S_IMODE(before.st_mode) == 0o600 and 0 < before.st_size <= limit,
             'COMMUNITY_DIRECT_PROTECTED_FILE_REQUIRED')
        data = bytearray()
        while chunk := os.read(fd, min(65536, limit + 1 - len(data))):
            data.extend(chunk)
            need(len(data) <= limit, 'COMMUNITY_DIRECT_FILE_TOO_LARGE')
        after = os.fstat(fd)
        need(len(data) == before.st_size and (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
             == (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'COMMUNITY_DIRECT_FILE_CHANGED')
        return bytes(data)
    finally:
        os.close(fd)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Refused('COMMUNITY_DIRECT_REDIRECT_REFUSED')


def response(url, limit):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json',
        'Cache-Control': 'no-cache', 'User-Agent': 'cisme-trial-community-direct-publication'})
    attempts = 3 if re.fullmatch(r'https://api\.github\.com/repos/Eysn0130/cisme-wechat-miniapp/'
        r'(?:git/commits/[0-9a-f]{40}|git/trees/[0-9a-f]{40}\?recursive=1|contents/package(?:-lock)?\.json\?ref=[0-9a-f]{40})', url) else 1
    for attempt in range(attempts):
        with opener.open(request, timeout=12) as remote:
            need(remote.status == 200, 'COMMUNITY_DIRECT_SOURCE_UNAVAILABLE')
            declared = remote.headers.get('Content-Length')
            need(declared is None or re.fullmatch(r'[0-9]+', declared) and 0 < int(declared) <= limit,
                 'COMMUNITY_DIRECT_RESPONSE_SIZE_REQUIRED')
            try:
                raw = remote.read(limit + 1)
            except http.client.IncompleteRead as error:
                need(isinstance(error.partial, bytes) and len(error.partial) <= limit
                     and (declared is None or len(error.partial) < int(declared)), 'COMMUNITY_DIRECT_RESPONSE_TRUNCATED')
                if attempt == attempts - 1:
                    raise Refused('COMMUNITY_DIRECT_RESPONSE_TRUNCATED') from None
                continue
            # Retry only a proven short transport read. Each attempt uses the
            # same endpoint and full size checks; partial bodies are discarded.
            if declared is not None and len(raw) < int(declared):
                if attempt == attempts - 1:
                    raise Refused('COMMUNITY_DIRECT_RESPONSE_TRUNCATED')
                continue
            need(0 < len(raw) <= limit and (declared is None or len(raw) == int(declared)), 'COMMUNITY_DIRECT_RESPONSE_TRUNCATED')
            return raw


def target():
    need(os.geteuid() == OWNER, 'COMMUNITY_DIRECT_ROOT_REQUIRED')
    actual = {name: response('http://metadata.tencentyun.com/latest/meta-data/' + name, 128).decode('ascii').strip() for name in IMDS}
    need(actual == IMDS, 'COMMUNITY_DIRECT_EXACT_IMDS_TARGET_REQUIRED')
    if D is not None:
        identity = D.general.observe.identity()
        need(identity.get('instanceId') == 'lhins-61ikz4mi' and identity.get('publicIpv4') == IMDS['public-ipv4'],
             'COMMUNITY_DIRECT_EXACT_INSTANCE_REQUIRED')


def load_baseline(active=True):
    global H, C, D
    target()
    path = BASELINE_RUNNER / 'trial-community-compose-update.py'
    raw = read(path, 128 * 1024)
    need(sha(raw) == BASELINE_HELPER_SHA, 'COMMUNITY_DIRECT_PINNED_D6DD_HELPER_REQUIRED')
    H = types.ModuleType('reviewed_d6dd_schema105_baseline')
    H.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), H.__dict__)
    old_binding = H.binding(BASELINE_RUNNER / 'application-binding.json', BASELINE_BINDING_SHA)
    need(old_binding.get('sourceHead') == BASELINE_HEAD and old_binding.get('sourceTree') == BASELINE_TREE
         and old_binding.get('manifestSha256') == BASELINE_MANIFEST and old_binding.get('migrations') == 105,
         'COMMUNITY_DIRECT_D6DD_BASELINE_BINDING_REQUIRED')
    if active:
        # The deployed d6dd guard recursively verifies all original105 inputs,
        # exact current units, private AI configuration and previous history.
        current = H.active_context(old_binding)
        C, D = H.C, H.D
        need(current['release'] == ROOT / 'releases' / ('tencent-release-' + BASELINE_HEAD[:12]),
             'COMMUNITY_DIRECT_BASELINE_RELEASE_REQUIRED')
        load_upgrade_primitives()
        return current, old_binding
    # After our switch, load only pinned lower primitives. Never invoke the old
    # active guard, which correctly requires its originald6dd unit paths.
    H.load_baseline(False)
    C, D = H.C, H.D
    load_upgrade_primitives()
    return None, old_binding


def load_upgrade_primitives():
    global K, S
    H.load_upgrade_primitives()
    K, S = H.K, H.S
    snapshot_path = SNAPSHOT_RUNNER / 'trial-daily-day-upgrade.py'
    need(Path(S.__file__) == snapshot_path and sha(read(snapshot_path, 128 * 1024)) == SNAPSHOT_HELPER_SHA
         and all(callable(getattr(S, name, None)) for name in ('snapshot', 'validate_snapshot', 'schema101')),
         'COMMUNITY_DIRECT_PINNED_SNAPSHOT_PRIMITIVE_REQUIRED')


def validate_binding(b):
    need(b.get('schemaVersion') == 1 and b.get('kind') == 'trial-community-direct-publication-update'
         and b.get('baselineHead') == BASELINE_HEAD and b.get('baselineTree') == BASELINE_TREE,
         'COMMUNITY_DIRECT_BASELINE_BINDING_REQUIRED')
    need(all(isinstance(b.get(key), str) and re.fullmatch(r'[0-9a-f]{40}', b[key]) and b[key] != '0' * 40
             for key in ('sourceHead', 'sourceTree')) and b['sourceHead'][:12] != BASELINE_HEAD[:12]
         and type(b.get('ciRunId')) is int and b['ciRunId'] > 0
         and type(b.get('ciVerifyJobId')) is int and b['ciVerifyJobId'] > 0,
         'COMMUNITY_DIRECT_EXACT_NEW_SOURCE_REQUIRED')
    need(all(isinstance(b.get(key), str) and re.fullmatch(r'[0-9a-f]{64}', b[key])
             for key in ('helperSha256', 'manifestSha256', 'archiveSha256'))
         and type(b.get('archiveBytes')) is int and 0 < b['archiveBytes'] <= 512 * 1024 ** 2,
         'COMMUNITY_DIRECT_EXACT_ARTIFACT_REQUIRED')
    need(b.get('dependenciesSha256') == DEPENDENCIES and type(b.get('migrations')) is int and b['migrations'] == 106
         and b.get('applicationRollbackAllowed') is False and isinstance(b.get('migrationSha256'), dict)
         and len(b['migrationSha256']) == 106 and b['migrationSha256'].get(MIGRATION) == MIGRATION_SHA
         and all(isinstance(name, str) and re.fullmatch(r'\d+_[A-Za-z0-9_-]+\.sql', name)
                 and isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) for name, value in b['migrationSha256'].items()),
         'COMMUNITY_DIRECT_ONLY_SCHEMA106_REQUIRED')
    archive = Path(b.get('archivePath', ''))
    need(archive.name == 'archive.tar.gz' and archive.parent.parent == STAGES
         and re.fullmatch(r'community-direct-publication-' + b['sourceHead'][:12] + r'-[a-z0-9_-]{8,40}', archive.parent.name),
         'COMMUNITY_DIRECT_PRIVATE_ARCHIVE_PATH_REQUIRED')
    need(Path(__file__) == RUNNERS / b['sourceHead'][:12] / 'trial-community-direct-publication-update.py',
         'COMMUNITY_DIRECT_EXACT_RUNNER_PATH_REQUIRED')
    need(sha(read(Path(__file__), 128 * 1024)) == b['helperSha256'], 'COMMUNITY_DIRECT_EXACT_HELPER_REQUIRED')
    return b


def binding(path, expected):
    need(re.fullmatch(r'[0-9a-f]{64}', expected or ''), 'COMMUNITY_DIRECT_BINDING_SHA_REQUIRED')
    raw = read(path, 65536)
    need(sha(raw) == expected, 'COMMUNITY_DIRECT_BINDING_HASH_MISMATCH')
    value = validate_binding(parse(raw))
    need(path == RUNNERS / value['sourceHead'][:12] / 'application-binding.json',
         'COMMUNITY_DIRECT_EXACT_BINDING_PATH_REQUIRED')
    return value


def artifact_contract(old, candidate, b):
    before, after = old['manifest'], candidate['manifest']
    need(before.get('sourceHead') == BASELINE_HEAD and before.get('sourceTree') == BASELINE_TREE
         and old['manifestSha256'] == BASELINE_MANIFEST
         and old['directory'] == str(ROOT / 'releases' / ('tencent-release-' + BASELINE_HEAD[:12])),
         'COMMUNITY_DIRECT_EXACT_D6DD_ARTIFACT_REQUIRED')
    need(after.get('sourceHead') == b['sourceHead'] and after.get('sourceTree') == b['sourceTree']
         and candidate['manifestSha256'] == b['manifestSha256'] and after.get('sourceLockSha256') == SOURCE_LOCK
         and candidate['directory'] == str(ROOT / 'releases' / ('tencent-release-' + b['sourceHead'][:12]))
         and after.get('node') == 'v24.14.0' and after.get('buildPlatform') == {'os': 'linux', 'arch': 'x64', 'libc': 'glibc'}
         and all(after.get(key) is False for key in ('configurationIncluded', 'deployed', 'releaseReady')),
         'COMMUNITY_DIRECT_EXACT_LINUX_ARTIFACT_REQUIRED')
    sql = before.get('migrations', [])
    need(len(sql) == 105 and sql == sorted(set(sql)) and sql[-1] == '202611020001_ugc_publish_intent.sql'
         and after.get('migrations') == sql + [MIGRATION] and set(b['migrationSha256']) == set(sql + [MIGRATION])
         and b['migrationSha256'].get(MIGRATION) == MIGRATION_SHA,
         'COMMUNITY_DIRECT_ONLY_MIGRATION106_REQUIRED')
    names = ['migrate.mjs', 'package.json', 'package-lock.json'] + ['db/migrations/' + name for name in sql]
    need(all(old['files'].get(name) and old['files'][name] == candidate['files'].get(name) for name in names),
         'COMMUNITY_DIRECT_SQL_MIGRATOR_OR_PACKAGE_CHANGED')
    need(all(sha(candidate['files']['db/migrations/' + name]) == b['migrationSha256'][name] for name in sql + [MIGRATION]),
         'COMMUNITY_DIRECT_SQL_BINDING_HASH_MISMATCH')
    need(old['dependenciesSha256'] == candidate['dependenciesSha256'] == DEPENDENCIES,
         'COMMUNITY_DIRECT_FULL_DEPENDENCY_TREE_CHANGED')


def source_bytes(name, head):
    need(name in ('package.json', 'package-lock.json') and re.fullmatch(r'[0-9a-f]{40}', head), 'COMMUNITY_DIRECT_SOURCE_PATH_REQUIRED')
    value = parse(response('https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/contents/' + name + '?ref=' + head, 2 * 1024 ** 2))
    need(value.get('type') == 'file' and value.get('path') == name and value.get('encoding') == 'base64'
         and type(value.get('size')) is int and 0 < value['size'] <= 1024 * 1024 and isinstance(value.get('content'), str),
         'COMMUNITY_DIRECT_SOURCE_METADATA_REQUIRED')
    raw = base64.b64decode(value['content'].replace('\r', '').replace('\n', ''), validate=True)
    need(len(raw) == value['size'] and git_blob(raw) == value.get('sha'), 'COMMUNITY_DIRECT_SOURCE_BLOB_MISMATCH')
    return raw


def git_blob(raw):
    return hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()


def candidate_ci(b):
    # Match019's exact-main push/verify-job acceptance. A failed or incomplete
    # full-route visual matrix remains separately reported; it cannot be
    # relabelled as product release acceptance by this application-only guard.
    base = 'https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/'
    main = parse(response(base + 'git/ref/heads/main', 256 * 1024))
    need(main.get('object', {}).get('sha') == b['sourceHead'], 'COMMUNITY_DIRECT_CURRENT_MAIN_REQUIRED')
    run_path = 'actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=' + b['sourceHead'] + '&per_page=20'
    runs = parse(response(base + run_path, 2 * 1024 ** 2)).get('workflow_runs')
    need(isinstance(runs, list), 'COMMUNITY_DIRECT_CI_RUN_LIST_REQUIRED')
    eligible = [run for run in runs if isinstance(run, dict) and run.get('head_sha') == b['sourceHead']
        and run.get('head_branch') == 'main' and run.get('event') == 'push' and run.get('path') == '.github/workflows/ci.yml'
        and run.get('repository', {}).get('full_name') == 'Eysn0130/cisme-wechat-miniapp'
        and type(run.get('id')) is int]
    need(eligible, 'COMMUNITY_DIRECT_EXACT_MAIN_PUSH_CI_REQUIRED')
    latest = max(eligible, key=lambda value: value['id'])
    need(latest['id'] == b['ciRunId'] and latest.get('status') == 'completed', 'COMMUNITY_DIRECT_LATEST_MAIN_PUSH_CI_REQUIRED')
    jobs = parse(response(base + 'actions/runs/' + str(b['ciRunId']) + '/jobs?filter=latest&per_page=100', 2 * 1024 ** 2))
    need(type(jobs.get('total_count')) is int and 0 < jobs['total_count'] <= 100
         and isinstance(jobs.get('jobs'), list) and len(jobs['jobs']) == jobs['total_count'], 'COMMUNITY_DIRECT_COMPLETE_CI_JOB_LIST_REQUIRED')
    verify = [job for job in jobs['jobs'] if isinstance(job, dict) and job.get('name') == 'verify']
    need(len(verify) == 1 and verify[0].get('id') == b['ciVerifyJobId'] and verify[0].get('run_id') == b['ciRunId']
         and verify[0].get('head_sha') == b['sourceHead'] and verify[0].get('status') == 'completed'
         and verify[0].get('conclusion') == 'success', 'COMMUNITY_DIRECT_EXACT_VERIFY_JOB_REQUIRED')


def source_permit(b, candidate):
    candidate_ci(b)
    base = 'https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/git/'
    commit = parse(response(base + 'commits/' + b['sourceHead'], 256 * 1024))
    need(commit.get('sha') == b['sourceHead'] and commit.get('tree', {}).get('sha') == b['sourceTree'],
         'COMMUNITY_DIRECT_COMMITTED_TREE_MISMATCH')
    tree = parse(response(base + 'trees/' + b['sourceTree'] + '?recursive=1', 4 * 1024 ** 2))
    need(tree.get('sha') == b['sourceTree'] and tree.get('truncated') is False and isinstance(tree.get('tree'), list),
         'COMMUNITY_DIRECT_COMPLETE_SOURCE_TREE_REQUIRED')
    entries = {}
    for item in tree['tree']:
        need(isinstance(item, dict) and isinstance(item.get('path'), str) and item['path'] not in entries,
             'COMMUNITY_DIRECT_SOURCE_TREE_ENTRY_INVALID')
        entries[item['path']] = item
    required = {HELPER_SOURCE: read(Path(__file__), 128 * 1024), 'scripts/release-migrate.mjs': candidate['files']['migrate.mjs']}
    required.update({'db/migrations/' + name: candidate['files']['db/migrations/' + name] for name in candidate['manifest']['migrations']})
    for name, raw in required.items():
        item = entries.get(name, {})
        need(item.get('type') == 'blob' and item.get('mode') in ('100644', '100755') and item.get('sha') == git_blob(raw),
             'COMMUNITY_DIRECT_COMMITTED_ARTIFACT_MISMATCH')
    need(sha(source_bytes('package.json', b['sourceHead'])) == SOURCE_PACKAGE
         and sha(source_bytes('package-lock.json', b['sourceHead'])) == SOURCE_LOCK,
         'COMMUNITY_DIRECT_COMMITTED_PACKAGE_OR_LOCK_CHANGED')
    # verify checks the immutable artifact only; it does not open a database.
    verified = parse(D.command([NODE, str(Path(candidate['directory']) / 'migrate.mjs'), 'verify']))
    need(verified.get('verified') is True and verified.get('sourceHead') == b['sourceHead']
         and verified.get('sourceTree') == b['sourceTree'] and verified.get('migrations') == 106,
         'COMMUNITY_DIRECT_COMPLETE_CANDIDATE_REQUIRED')


def optional_active():
    if STATE_PARENT.exists() or STATE_PARENT.is_symlink():
        D.owned_directory(STATE_PARENT, True)
    return read(ACTIVE, 65536) if ACTIVE.exists() or ACTIVE.is_symlink() else None


def capture_history():
    # Preserve the deployed105 active record and every earlier original byte.
    history = H.capture_history()
    history[str(H.ACTIVE)] = read(H.ACTIVE, 65536)
    return history

def protected_baseline_inputs(old_binding, history):
    # load_baseline(True) already authenticated this savedd6dd plan with the
    # original guard. Preserve its entire inherited private-input chain, then
    # add the immutabled6dd guard, binding and saved plan as a new layer.
    active = parse(history[str(H.ACTIVE)])
    state = Path(active.get('upgradeState', ''))
    need(state.parent == H.STATE_PARENT and re.fullmatch(r'commit-' + BASELINE_HEAD[:12] + r'-[0-9]+', state.name),
         'COMMUNITY_DIRECT_D6DD_PRIVATE_PLAN_PATH_REQUIRED')
    saved = read(state / 'protected-plan.json', 8 * 1024 ** 2)
    need(sha(saved) == active.get('privatePlanSha256'), 'COMMUNITY_DIRECT_D6DD_PRIVATE_PLAN_HASH_REQUIRED')
    prior = C.decode_private(parse(saved))
    need(prior.get('binding') == old_binding and prior.get('candidate', {}).get('directory') ==
         str(ROOT / 'releases' / ('tencent-release-' + BASELINE_HEAD[:12])), 'COMMUNITY_DIRECT_D6DD_PRIVATE_BINDING_REQUIRED')
    prior_history = prior.get('history')
    need(isinstance(prior_history, dict) and prior_history and all(isinstance(raw, bytes) and history.get(path) == raw
         for path, raw in prior_history.items()), 'COMMUNITY_DIRECT_INHERITED_ACTIVE_HISTORY_DRIFT')
    inherited = prior.get('protectedBaselineInputs')
    need(isinstance(inherited, dict) and inherited, 'COMMUNITY_DIRECT_INHERITED_PRIVATE_CHAIN_REQUIRED')
    result = {}
    for path, value in inherited.items():
        need(isinstance(path, str) and isinstance(value, dict) and type(value.get('limit')) is int
             and 0 < value['limit'] <= 8 * 1024 ** 2 and isinstance(value.get('sha256'), str)
             and re.fullmatch(r'[0-9a-f]{64}', value['sha256']), 'COMMUNITY_DIRECT_INHERITED_PRIVATE_INPUT_REQUIRED')
        need(sha(read(Path(path), value['limit'])) == value['sha256'], 'COMMUNITY_DIRECT_INHERITED_PRIVATE_INPUT_DRIFT')
        result[path] = {'sha256': value['sha256'], 'limit': value['limit']}
    paths = [(BASELINE_RUNNER / 'trial-community-compose-update.py', 128 * 1024),
             (BASELINE_RUNNER / 'application-binding.json', 65536), (state / 'protected-plan.json', 8 * 1024 ** 2)]
    for path, limit in paths:
        need(str(path) not in result, 'COMMUNITY_DIRECT_INHERITED_INPUT_COLLISION')
        result[str(path)] = {'sha256': sha(read(path, limit)), 'limit': limit}
    need(result[str(paths[0][0])]['sha256'] == BASELINE_HELPER_SHA
         and result[str(paths[1][0])]['sha256'] == BASELINE_BINDING_SHA
         and result[str(paths[2][0])]['sha256'] == active['privatePlanSha256'],
         'COMMUNITY_DIRECT_D6DD_CAPTURED_INPUT_DRIFT')
    return result

def verify_history(plan, allowed=()):
    need(all(read(Path(path), 65536) == raw for path, raw in plan['history'].items()), 'COMMUNITY_DIRECT_HISTORY_DRIFT')
    need(all(sha(read(Path(path), value['limit'])) == value['sha256'] for path, value in plan['protectedBaselineInputs'].items()),
         'COMMUNITY_DIRECT_BASELINE_PRIVATE_INPUT_DRIFT')
    need(optional_active() in (allowed or (None,)), 'COMMUNITY_DIRECT_UNKNOWN_ACTIVE_RECORD')


def verify_context(plan, candidate_allowed=False, allowed=(), exact_pids=True):
    target()
    C.fixed_profile(plan['profile'])
    D.verify_context(plan, provenance=False, allow_candidate=candidate_allowed)
    verify_history(plan, allowed)
    C.production_preserved(plan['production'], exact_pids)
    C.six_keys(plan['config'], plan['production']['config'])
    need(D.closed_context(plan['profile'], plan['config']) and plan['config'].get('APP_ENV') == 'staging',
         'COMMUNITY_DIRECT_CLOSED_TRIAL_REQUIRED')
    artifact_contract(D.artifact(plan['old']['directory'], ROOT), D.artifact(plan['candidate']['directory'], ROOT), plan['binding'])
    archive = read(Path(plan['binding']['archivePath']), 512 * 1024 ** 2)
    need(len(archive) == plan['binding']['archiveBytes'] and sha(archive) == plan['binding']['archiveSha256'],
         'COMMUNITY_DIRECT_PRIVATE_ARCHIVE_DRIFT')


def ugc_guards(profile, baseline=None):
    value = H.ugc_guards(profile, True)
    if baseline is not None:
        need(value == baseline, 'COMMUNITY_DIRECT_UGC_GUARD_DRIFT')
    return value


def direct_index(profile, upgraded):
    value = D.query(profile, "SELECT CASE WHEN to_regclass('public.ugc_direct_publication_intent_idx') IS NULL THEN 'null'::jsonb ELSE coalesce((SELECT jsonb_build_object('owner',pg_get_userbyid(c.relowner),"
        "'table',t.relname,'method',am.amname,'valid',i.indisvalid,'ready',i.indisready,'unique',i.indisunique,"
        "'primary',i.indisprimary,'keys',i.indnkeyatts,'attributes',i.indnatts,'definition',pg_get_indexdef(i.indexrelid)) "
        "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_index i ON i.indexrelid=c.oid "
        "JOIN pg_class t ON t.oid=i.indrelid JOIN pg_am am ON am.oid=c.relam WHERE n.nspname='public' "
        "AND c.relname='ugc_direct_publication_intent_idx'),'{}'::jsonb) END")
    if not upgraded:
        need(value is None, 'COMMUNITY_DIRECT_INDEX_PREEXISTS')
        return
    expected = {'owner': 'cisme_trial', 'table': 'audit_log', 'method': 'btree', 'valid': True, 'ready': True,
        'unique': False, 'primary': False, 'keys': 2, 'attributes': 2,
        'definition': "CREATE INDEX ugc_direct_publication_intent_idx ON public.audit_log USING btree (object_id, ((after_state ->> 'newRevision'::text))) WHERE ((object_type = 'ugc_post'::text) AND (action = 'ugc.post_submitted'::text) AND ((after_state ->> 'directPublication'::text) = 'true'::text))"}
    need(value == expected, 'COMMUNITY_DIRECT_INDEX_CATALOG_DRIFT')


def journal(plan, allowed, drain=False):
    old_sql, new_sql = plan['old']['manifest']['migrations'], plan['candidate']['manifest']['migrations']
    value = C.database_guard(plan['profile'], plan['config'], plan['ownership'], allowed, drain)
    need(value in allowed and value in (old_sql, new_sql), 'COMMUNITY_DIRECT_EXACT_MIGRATION_JOURNAL_REQUIRED')
    S.schema101(plan['profile'])
    K.B.schema103(plan['profile'])
    K.schema104(plan['profile'], True)
    ugc_guards(plan['profile'], plan['ugcGuardBaseline'])
    direct_index(plan['profile'], value == new_sql)
    return value


def business_fence(profile):
    # Every existing105 journal row (including applied_at) and every complete
    #business row stays exact. Exclude only the one authorized106 journal row.
    names = D.query(profile, "SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]'::json) FROM pg_tables WHERE schemaname='public'")
    need(isinstance(names, list) and 'schema_migration' in names and names == sorted(set(names))
         and all(isinstance(name, str) and re.fullmatch(r'[a-z][a-z0-9_]*', name) for name in names),
         'COMMUNITY_DIRECT_BUSINESS_TABLE_SET_REQUIRED')
    parts = ["SELECT '" + name + "'::text AS name,jsonb_build_object('count',count(*),'sha256',encode(digest(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]'),'sha256'),'hex')) AS fact FROM " + name + " t"
             + (" WHERE version<>'" + MIGRATION + "'" if name == 'schema_migration' else '') for name in names]
    value = D.query(profile, 'SELECT jsonb_object_agg(name,fact ORDER BY name) FROM (' + ' UNION ALL '.join(parts) + ') snapshot')
    need(isinstance(value, dict) and set(value) == set(names) and all(isinstance(row, dict)
         and type(row.get('count')) is int and row['count'] >= 0 and isinstance(row.get('sha256'), str)
         and re.fullmatch(r'[0-9a-f]{64}', row['sha256']) and set(row) == {'count', 'sha256'} for row in value.values()),
         'COMMUNITY_DIRECT_FULL_FACT_FENCE_REQUIRED')
    return value


def public_contract(plan):
    # Reused6dd's reviewed GET-only public article200 / guest comments401
    # contract without creating a session, conversation, presence or message.
    H.public_contract(plan)

def preflight(b):
    current, old_binding = load_baseline(True)
    profile, config = current['profile'], current['config']
    C.fixed_profile(profile)
    need(optional_active() is None, 'COMMUNITY_DIRECT_EXISTING_UPDATE_REFUSED')
    need(config.get('APP_ENV') == 'staging' and config.get('WECHAT_APP_ID') == C.APP_ID and D.closed_context(profile, config)
         and config.get('WECHAT_PHONE_BINDING_ENABLED', 'false') == 'false'
         and config.get('COS_DIRECT_UPLOAD_ENABLED', 'false') == 'false'
         and config.get('SUPPORT_AI_ENABLED') == 'true' and config.get('DEEPSEEK_MODEL') == 'deepseek-flash'
         and config.get('SUPPORT_AI_TIMEOUT_MS') == '4000' and config.get('DEEPSEEK_API_KEY'),
         'COMMUNITY_DIRECT_CURRENT_TRIAL_AND_AI_CONTEXT_REQUIRED')
    old = D.artifact(str(current['release']), ROOT)
    candidate = D.artifact(str(ROOT / 'releases' / ('tencent-release-' + b['sourceHead'][:12])), ROOT)
    artifact_contract(old, candidate, b)
    archive = read(Path(b['archivePath']), 512 * 1024 ** 2)
    need(len(archive) == b['archiveBytes'] and sha(archive) == b['archiveSha256'], 'COMMUNITY_DIRECT_ARCHIVE_HASH_MISMATCH')
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
    need(versions == D.native_smoke(profile, old['directory'], True), 'COMMUNITY_DIRECT_NATIVE_RUNTIME_CHANGED')
    plan = {'profile': profile, 'config': config, 'env': D.read_owned(ROOT / 'runtime.env', private=True),
        'environmentMetadata': D.environment_metadata(profile), 'privateInputs': D.private_inputs(profile, config),
        'old': old, 'candidate': candidate, 'units': units, 'dropIns': dropins, 'unitDefinitions': definitions,
        'ownership': ownership, 'initialRecords': {name: history[str(ROOT / name)] for name in HISTORY_ROOT[-3:]},
        'history': history, 'protectedBaselineInputs': protected, 'production': production, 'binding': b, 'versions': versions,
        'ugcGuardBaseline': ugc_guards(profile)}
    verify_context(plan)
    journal(plan, [old['manifest']['migrations']])
    return plan


def save_plan(plan, state):
    saved = dict(plan)
    for name in ('old', 'candidate'):
        saved[name] = {key: value for key, value in plan[name].items() if key != 'files'}
    raw = (json.dumps(C.encode_private(saved), sort_keys=True) + '\n').encode()
    need(len(raw) <= 8 * 1024 ** 2, 'COMMUNITY_DIRECT_PRIVATE_PLAN_TOO_LARGE')
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


def snapshot_binding(plan, state, approval, backup):
    # Preserve the authenticated primitive's historical AAD label honestly;
    #separately bind the snapshot to the actual reviewed d6dd/schema105 source.
    return {'schemaVersion': 1, 'kind': 'trial-community-direct-publication-snapshot-current-release',
        'snapshotReceiptSha256': sha(read(state / 'predeploy-database' / 'snapshot-private.json', 65536)),
        'actualBaselineHead': BASELINE_HEAD, 'actualBaselineTree': BASELINE_TREE,
        'actualBaselineManifestSha256': plan['old']['manifestSha256'], 'actualMigrationCount': 105,
        'candidateHead': plan['binding']['sourceHead'], 'candidateTree': plan['binding']['sourceTree'],
        'backupReference': backup['backupReference'], 'operationReference': approval,
        'cryptoAadBaselineLabel': S.BASELINE_HEAD, 'aadClaimsCurrentBaseline': False}


def verify_snapshot(plan, state):
    backup = parse(read(state / 'predeploy-database' / 'snapshot-private.json', 65536))
    S.validate_snapshot(backup, state, plan['operationReference'])
    raw = read(state / 'snapshot-current-release.json', 65536)
    need(sha(raw) == plan['snapshotBindingSha256']
         and parse(raw) == snapshot_binding(plan, state, plan['operationReference'], backup),
         'COMMUNITY_DIRECT_ACTUAL_BASELINE_SNAPSHOT_BINDING_DRIFT')


def active_record(plan, state, plan_sha):
    selected = plan['candidate']
    return (json.dumps({'schemaVersion': 1, 'kind': 'trial-community-direct-publication-active-release',
        'environment': 'trial', 'instanceId': 'lhins-61ikz4mi', 'database': 'cisme_trial',
        'sourceHead': selected['manifest']['sourceHead'], 'sourceTree': selected['manifest']['sourceTree'],
        'ciRunId': plan['binding']['ciRunId'], 'ciVerifyJobId': plan['binding']['ciVerifyJobId'],
        'directory': selected['directory'], 'manifestSha256': selected['manifestSha256'],
        'dependenciesSha256': DEPENDENCIES, 'migrationCount': 106, 'baselineHead': BASELINE_HEAD,
        'ownershipId': plan['ownership']['ownershipId'], 'upgradeState': str(state), 'privatePlanSha256': plan_sha,
        'drainedBusinessFenceSha256': sha((json.dumps(plan['drainedBusinessFence'], sort_keys=True) + '\n').encode()),
        'snapshotBindingSha256': plan['snapshotBindingSha256'], 'snapshotAuthenticated': True,
        'schemaChanged': True, 'configurationChanged': False, 'databaseRestored': False, 'drainedFull105FactsPreserved': True,
        'publishIntentGuard105Verified': True, 'directPublicationIndex106Verified': True, 'immutableRevisionGuardPreserved': True,
        'applicationRollbackAllowed': False, 'applicationRollbackExecuted': False,
        'commentLoginEnforced': True, 'guestCommentReadExposureRestored': False,
        'humanHandoffPolicy': 'user-request-only', 'questionScopedCollaborationPreserved': True,
        'previousActiveHistoryPreserved': True}, sort_keys=True) + '\n').encode()


def cutover(plan, state, approval):
    halted = False
    try:
        backup_inputs(plan, state)
        verify_context(plan)
        old_sql, new_sql = plan['old']['manifest']['migrations'], plan['candidate']['manifest']['migrations']
        journal(plan, [old_sql])
        source_permit(plan['binding'], plan['candidate'])
        halted = True
        D.command(['systemctl', 'stop', *plan['profile']['units']], timeout=90)
        D.stopped(plan['profile'])
        verify_context(plan)
        journal(plan, [old_sql], True)
        facts = business_fence(plan['profile'])
        D.general.store(state / 'drained-business-fence.json', (json.dumps(facts, sort_keys=True) + '\n').encode())
        backup = S.snapshot(plan, state, approval)
        S.validate_snapshot(backup, state, approval)
        snapshot_raw = (json.dumps(snapshot_binding(plan, state, approval, backup), sort_keys=True) + '\n').encode()
        D.general.store(state / 'snapshot-current-release.json', snapshot_raw)
        receipt_plan = {**plan, 'drainedBusinessFence': facts, 'operationReference': approval,
                        'snapshotBindingSha256': sha(snapshot_raw)}
        plan_sha = save_plan(receipt_plan, state)
        verify_context(plan)
        journal(plan, [old_sql], True)
        D.command(['/usr/sbin/runuser', '-u', 'cisme-trial', '--', NODE,
            str(Path(plan['candidate']['directory']) / 'migrate.mjs'), 'up'],
            env={**CLEAN, **plan['config'], 'CISME_MIGRATION_APPROVAL_REF': approval,
                 'CISME_PREDEPLOY_BACKUP_REF': backup['backupReference']}, cwd=ROOT, timeout=180)
        journal(plan, [new_sql], True)
        need(business_fence(plan['profile']) == facts, 'COMMUNITY_DIRECT_EXISTING105_BUSINESS_FACTS_CHANGED')
        verify_context(plan)
        D.switch(plan, plan['candidate']['directory'])
        D.verify_units(plan, allow_candidate=True)
        verify_history(plan)
        verify_context(plan, candidate_allowed=True)
        journal(plan, [new_sql], True)
        need(business_fence(plan['profile']) == facts, 'COMMUNITY_DIRECT_STOPPED_BUSINESS_FACTS_CHANGED')
        started = time.time()
        D.command(['systemctl', 'start', *plan['profile']['units']], timeout=60)
        versions = D.healthy(plan, plan['candidate']['directory'], started, True)
        public_contract(plan)
        verify_context(plan, candidate_allowed=True)
        journal(plan, [new_sql])
        published = active_record(receipt_plan, state, plan_sha)
        D.atomic_bytes(ACTIVE, published)
        verify_context(plan, candidate_allowed=True, allowed=(published,))
        journal(plan, [new_sql])
        report = {'deployed': True, 'environment': 'trial', 'sourceHead': plan['binding']['sourceHead'],
            'migrationCountBefore': 105, 'migrationCountAfter': 106, 'schemaChanged': True,
            'commentLoginEnforced': True, 'publicArticleReadable': True, 'guestCommentStatus': 401,
            'humanHandoffPolicy': 'user-request-only', 'questionScopedCollaborationPreserved': True, 'liveChatProbePerformed': False,
            'configurationChanged': False, 'credentialsChanged': False, 'authorityGranted': False,
            'businessDataSeeded': False, 'databaseRestored': False, 'databaseSnapshotCreated': True, 'drainedFull105FactsPreserved': True,
            'snapshotAuthenticated': True, 'snapshotScope': 'same-host-database-only', 'fullRecoveryQualified': False,
            'publishIntentGuard105Verified': True, 'directPublicationIndex106Verified': True, 'immutableRevisionGuardPreserved': True,
            'applicationRollbackExecuted': False, 'previousActiveHistoryPreserved': True, 'productionChanged': False,
            'versions': versions, 'ciRunId': plan['binding']['ciRunId'], 'ciVerifyJobId': plan['binding']['ciVerifyJobId']}
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
        try:
            D.general.store(state / 'manual-recovery-required.json', (json.dumps({'servicesStopped': stopped,
                'unknownInputsOverwritten': False, 'databaseRestored': False, 'configurationChanged': False,
                'applicationRollbackExecuted': False, 'forwardRecoveryRequired': True,
                'previousApplicationRollbackForbidden': True, 'schemaMayHaveChanged': True}) + '\n').encode())
        except Exception:
            pass
        raise Refused('COMMUNITY_DIRECT_FAILED_FENCED_FORWARD_REVIEW_REQUIRED') from None


def active_context(b):
    validate_binding(b)
    load_baseline(False)
    target()
    raw = read(ACTIVE, 65536)
    active = parse(raw)
    state = Path(active.get('upgradeState', ''))
    need(state.parent == STATE_PARENT and re.fullmatch(r'commit-' + b['sourceHead'][:12] + r'-[0-9]+', state.name),
         'COMMUNITY_DIRECT_ACTIVE_STATE_PATH_REQUIRED')
    saved = read(state / 'protected-plan.json', 8 * 1024 ** 2)
    need(sha(saved) == active.get('privatePlanSha256'), 'COMMUNITY_DIRECT_ACTIVE_PRIVATE_PLAN_DRIFT')
    plan = C.decode_private(parse(saved))
    need(plan.get('binding') == b, 'COMMUNITY_DIRECT_ACTIVE_BINDING_DRIFT')
    need(isinstance(plan.get('drainedBusinessFence'), dict) and plan['drainedBusinessFence']
         and parse(read(state / 'drained-business-fence.json', 8 * 1024 ** 2)) == plan['drainedBusinessFence'],
         'COMMUNITY_DIRECT_ACTIVE_DRAINED_FACT_FENCE_DRIFT')
    verify_snapshot(plan, state)
    for label in ('old', 'candidate'):
        plan[label] = D.artifact(plan[label]['directory'], ROOT)
    artifact_contract(plan['old'], plan['candidate'], b)
    selected = plan['candidate']
    need(raw == active_record(plan, state, sha(saved)), 'COMMUNITY_DIRECT_ACTIVE_RECORD_DRIFT')
    # A later read-only audit may follow a legitimate production restart.
    # Original bytes/entry/config remain exact; cutover checks keep exact PIDs.
    verify_context(plan, candidate_allowed=True, allowed=(raw,), exact_pids=False)
    for unit, entry in zip(plan['profile']['units'], ('index.js', 'worker.js')):
        need(D.unit_entry(D.read_owned(D.unit_path(unit)), entry, plan['profile']) == Path(selected['directory']),
             'COMMUNITY_DIRECT_ACTIVE_UNIT_PATH_REQUIRED')
    D.running(plan['profile'], selected['directory'], plan['config'])
    journal(plan, [selected['manifest']['migrations']])
    public_contract(plan)
    return {'profile': plan['profile'], 'config': plan['config'], 'release': Path(selected['directory']),
            'sourceHead': selected['manifest']['sourceHead'], 'commentLoginEnforced': True}


def apply(b, approval):
    need(re.fullmatch(r'[-A-Za-z0-9_:.]{8,120}', approval or ''), 'COMMUNITY_DIRECT_OPERATION_REFERENCE_REQUIRED')
    target()
    lock = Path('/run/lock/cisme-production-trial.lock')
    parent = lock.parent.lstat()
    need(stat.S_ISDIR(parent.st_mode) and parent.st_uid == OWNER and stat.S_IMODE(parent.st_mode) == 0o1777,
         'COMMUNITY_DIRECT_LOCK_PARENT_REQUIRED')
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
             'COMMUNITY_DIRECT_LOCK_REQUIRED')
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
    return value if re.fullmatch(r'COMMUNITY_DIRECT_[A-Z0-9_]{1,110}', value) else 'COMMUNITY_DIRECT_REVIEW_REQUIRED'


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
                'migrationCount': 106, 'commentLoginEnforced': value['commentLoginEnforced'], 'ciRunId': b['ciRunId'], 'ciVerifyJobId': b['ciVerifyJobId']}
        else:
            plan = preflight(b)
            result = {'readOnly': True, 'deployed': False, 'sourceHead': plan['binding']['sourceHead'],
                'migrationCountBefore': 105, 'migrationCountAfter': 106, 'schemaChanged': True,
                'configurationChanged': False, 'productionPreserved': True, 'databaseSnapshotRequired': True,
                'ciRunId': b['ciRunId'], 'ciVerifyJobId': b['ciVerifyJobId']}
        print(json.dumps({**result, 'privateValuesExported': False}, sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({'ok': False, 'code': safe_error_code(error), 'privateValuesExported': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
