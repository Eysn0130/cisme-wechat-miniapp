#!/usr/bin/env python3
"""Exact a189/schema100 -> new-main/schema101 daily-day upgrade, trial only.

Default is read-only. Migration101 is the only allowed schema delta.
No restore/down, business seeding, production switch or historical metadata rewrite.
The reviewed100 helper supplies baseline-only validation and protected primitives.
No application rollback after schema101: old100 ignores deletion and daily revisions.
"""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import stat
import subprocess
import sys
import tempfile
import threading
import time
import types
import urllib.request
from urllib.parse import unquote, urlsplit

sys.dont_write_bytecode = True
ROOT = Path('/opt/cisme-trial')
OWNER = 0
BASELINE_HEAD = 'a1899adc59f448b28be52211a9f09dc60393733a'
BASELINE_TREE = 'f7fbf92c5ca33360aa194a240f200aae34e1b691'
BASELINE_MANIFEST = '947a275aa3571c06bd421eaa85361c5d05814da8410461cfb8d6eceda251d4af'
BASELINE_ARCHIVE = '159ec204aeaba9fbf24ed98ef6e2968e01a418117829f785e3e51b14963898f6'
BASELINE_ARCHIVE_BYTES = 25638515
BASELINE_RUNNER = ROOT / 'daily-care-runners' / BASELINE_HEAD[:12]
BASELINE_HELPER_SHA = '877f25037940d1527ad5784c5014746553d5ad94714015bd7ab6b5c927e3eb3e'
BASELINE_BINDING_SHA = 'a5244f2d2165af7d95eb1e27f3642ec59d6da01755b865ef1fdd6bd1d5097849'
DEPENDENCIES = 'd9f03813fc808eced42eacb92db4530a2cd0e0824cab5d1beb9c3bdf08144bdd'
SOURCE_PACKAGE = 'c70b97f3ec0e6c339c5c27b0e9067549f9256287cfbfdf32f39ae46fcf54e231'
SOURCE_LOCK = '2a14af4f1bfdd86d0108015b43df14d62b2cc6e8eedcd3831446970a26d7d32a'
MIGRATION = '202610300001_daily_care_daily_latest.sql'
PREVIOUS_MIGRATION = '202610290001_daily_care_records.sql'
MIGRATION_SHA = 'ec196bd930234a5b70b1f8b87d64f6164c04a0030b0a5e9511de95fd79338241'
PREVIOUS_MIGRATION_SHA = 'd27269793c5be0111b53eaa6d655a2e63e04ff486bb044aaa0cdac6b6b468b49'
BASELINE_INDEX = '4aa9fa94d792fd0a77d50b3062b8781428b168313b71f5c5e6e9629cdde614cb'
STATE_PARENT = ROOT / 'daily-day-upgrades'
ACTIVE = STATE_PARENT / 'active-release.json'
STAGES = Path('/var/lib/cisme-dependency-stage')
HELPER_NAME = 'trial-daily-day-upgrade.py'
HELPER_SOURCE = 'infra/tencent/' + HELPER_NAME
NODE = '/opt/node-v24.14.0-linux-x64/bin/node'
CLEAN = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}
B = C = D = None


class Refused(RuntimeError):
    pass


def need(value, code='DAILY_CARE_APPLICATION_REFUSED'):
    if not value:
        raise Refused(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def unique(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, 'DAILY_CARE_DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def parse(raw):
    return json.loads(raw, object_pairs_hook=unique)


def parents(path, private=False):
    need(path.is_absolute() and '..' not in path.parts, 'DAILY_CARE_ABSOLUTE_PATH_REQUIRED')
    for parent in reversed(path.parents):
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == OWNER and not info.st_mode & 0o022,
             'DAILY_CARE_ROOT_PROTECTED_PARENT_REQUIRED')
    if private:
        record = path.parent == ROOT and path.name in (
            'dependency-active-release.json', 'application-active-release.json',
            'editorial-comments-active-release.json', 'ownership.json',
            'empty-database.json', 'migration-complete.json')
        need(stat.S_IMODE(path.parent.lstat().st_mode) in ((0o700, 0o750, 0o755) if record else (0o700,)),
             'DAILY_CARE_PRIVATE_PARENT_REQUIRED')


def read(path, limit=1024 * 1024, private=False):
    parents(path, private)
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == OWNER and before.st_nlink == 1
             and not before.st_mode & (0o077 if private else 0o022) and 0 < before.st_size <= limit,
             'DAILY_CARE_PROTECTED_FILE_REQUIRED')
        data = bytearray()
        while chunk := os.read(fd, min(65536, limit + 1 - len(data))):
            data.extend(chunk)
            need(len(data) <= limit, 'DAILY_CARE_FILE_TOO_LARGE')
        after = os.fstat(fd)
        need(len(data) == before.st_size and (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
             == (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'DAILY_CARE_FILE_CHANGED')
        return bytes(data)
    finally:
        os.close(fd)


def load_baseline(active=False):
    global B, C, D
    need(os.geteuid() == OWNER, 'DAILY_CARE_ROOT_REQUIRED')
    path = BASELINE_RUNNER / 'trial-daily-care-upgrade.py'
    raw = read(path, 128 * 1024, True)
    need(sha(raw) == BASELINE_HELPER_SHA, 'DAILY_CARE_PINNED_A189_GUARD_REQUIRED')
    B = types.ModuleType('reviewed_a189_schema100_baseline')
    B.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), B.__dict__)
    value = B.binding(BASELINE_RUNNER / 'application-binding.json', BASELINE_BINDING_SHA)
    need(value['sourceHead'] == BASELINE_HEAD and value['sourceTree'] == BASELINE_TREE
         and value['manifestSha256'] == BASELINE_MANIFEST and value['archiveSha256'] == BASELINE_ARCHIVE
         and value['archiveBytes'] == BASELINE_ARCHIVE_BYTES, 'DAILY_CARE_A189_BINDING_REQUIRED')
    if active:
        result = B.active_context(value)
        C, D = result['C'], result['D']
        return result
    B.load_baseline(False)
    C, D = B.C, B.D
    return None



def validate_binding(b):
    need(b.get('schemaVersion') == 1 and b.get('kind') == 'trial-daily-day-upgrade'
         and b.get('baselineHead') == BASELINE_HEAD and b.get('baselineTree') == BASELINE_TREE,
         'DAILY_CARE_BASELINE_BINDING_REQUIRED')
    need(all(isinstance(b.get(key), str) and re.fullmatch(r'[0-9a-f]{40}', b[key]) and b[key] != '0' * 40
             for key in ('sourceHead', 'sourceTree')) and b['sourceHead'] != BASELINE_HEAD
         and type(b.get('ciRunId')) is int and b['ciRunId'] > 0, 'DAILY_CARE_EXACT_NEW_MAIN_REQUIRED')
    need(all(isinstance(b.get(key), str) and re.fullmatch(r'[0-9a-f]{64}', b[key])
             for key in ('helperSha256', 'manifestSha256', 'archiveSha256', 'stageReceiptSha256'))
         and type(b.get('archiveBytes')) is int and 0 < b['archiveBytes'] <= 512 * 1024 ** 2,
         'DAILY_CARE_FINAL_ARTIFACT_REQUIRED')
    need(b.get('migrationSha256') == MIGRATION_SHA, 'DAILY_CARE_SQL101_BINDING_REQUIRED')
    need(b.get('dependenciesSha256') == DEPENDENCIES and type(b.get('migrations')) is int and b['migrations'] == 101,
         'DAILY_CARE_ONLY_SCHEMA101_REQUIRED')
    need(sha(read(Path(__file__), 128 * 1024, True)) == b['helperSha256'], 'DAILY_CARE_EXACT_HELPER_REQUIRED')
    return b


def binding(path, expected):
    need(re.fullmatch(r'[0-9a-f]{64}', expected or ''), 'DAILY_CARE_BINDING_SHA_REQUIRED')
    raw = read(path, 65536, True)
    need(sha(raw) == expected, 'DAILY_CARE_BINDING_HASH_MISMATCH')
    return validate_binding(parse(raw))


def artifact_contract(old, candidate, b):
    before, after = old['manifest'], candidate['manifest']
    need(before.get('sourceHead') == BASELINE_HEAD and before.get('sourceTree') == BASELINE_TREE
         and old['manifestSha256'] == BASELINE_MANIFEST and before.get('hashes', {}).get('index.js') == BASELINE_INDEX,
         'DAILY_CARE_A189_ARTIFACT_REQUIRED')
    need(after.get('sourceHead') == b['sourceHead'] and after.get('sourceTree') == b['sourceTree']
         and candidate['manifestSha256'] == b['manifestSha256'] and after.get('sourceLockSha256') == SOURCE_LOCK
         and after.get('node') == 'v24.14.0' and after.get('buildPlatform') == {'os': 'linux', 'arch': 'x64', 'libc': 'glibc'}
         and all(after.get(key) is False for key in ('configurationIncluded', 'deployed', 'releaseReady')),
         'DAILY_CARE_EXACT_LINUX_ARTIFACT_REQUIRED')
    sql = before.get('migrations', [])
    need(len(sql) == 100 and sql == sorted(set(sql)) and sql[-1] == PREVIOUS_MIGRATION
         and after.get('migrations') == sql + [MIGRATION] and old['directory'] != candidate['directory'],
         'DAILY_CARE_ONLY_ONE_MIGRATION_REQUIRED')
    names = ['migrate.mjs', 'package.json', 'package-lock.json'] + ['db/migrations/' + name for name in sql]
    need(all(old['files'].get(name) and old['files'][name] == candidate['files'].get(name) for name in names),
         'DAILY_CARE_OLD_SQL_MIGRATOR_OR_PACKAGE_CHANGED')
    need(sha(candidate['files'].get('db/migrations/' + MIGRATION, b'')) == MIGRATION_SHA
         and sha(candidate['files']['db/migrations/' + PREVIOUS_MIGRATION]) == PREVIOUS_MIGRATION_SHA,
         'DAILY_CARE_PINNED_SQL_REQUIRED')
    need(old['dependenciesSha256'] == candidate['dependenciesSha256'] == DEPENDENCIES,
         'DAILY_CARE_FULL_DEPENDENCY_TREE_CHANGED')



def github_new_source(name, head):
    need(re.fullmatch(r'[0-9a-f]{40}', head or '') and head != '0' * 40, 'DAILY_CARE_SOURCE_HEAD_REQUIRED')
    need(name in (HELPER_SOURCE, 'db/migrations/' + MIGRATION), 'DAILY_CARE_SOURCE_PATH_REQUIRED')
    # Only two fixed repository paths, official HTTPS endpoint and exact ref.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), D.general.observe.NoRedirect())
    request = urllib.request.Request('https://api.github.com/repos/' + D.general.REPO + '/contents/' + name + '?ref=' + head,
        headers={'Accept': 'application/vnd.github+json', 'Cache-Control': 'no-cache', 'User-Agent': 'cisme-daily-care-upgrade'})
    value = parse(C.source_response(opener, request, 256 * 1024))
    need(isinstance(value, dict) and value.get('type') == 'file' and value.get('path') == name
         and value.get('encoding') == 'base64' and type(value.get('size')) is int and 0 < value['size'] <= 128 * 1024
         and isinstance(value.get('sha'), str) and re.fullmatch(r'[0-9a-f]{40}', value['sha'])
         and isinstance(value.get('content'), str), 'DAILY_CARE_HELPER_SOURCE_METADATA_REQUIRED')
    try:
        raw = base64.b64decode(value['content'].replace('\r', '').replace('\n', ''), validate=True)
    except (ValueError, TypeError):
        raise Refused('DAILY_CARE_HELPER_SOURCE_ENCODING_INVALID') from None
    need(len(raw) == value['size'] and hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == value['sha'],
         'DAILY_CARE_HELPER_SOURCE_BLOB_MISMATCH')
    return raw


def source_permit(b, candidate, main):
    need(main.get('sha') == b['sourceHead'] and main.get('tree') == b['sourceTree']
         and main.get('ciRunId') == b['ciRunId'], 'DAILY_CARE_LATEST_MAIN_PUSH_CI_REQUIRED')
    need(sha(C.github_source('package.json', b['sourceHead'])) == SOURCE_PACKAGE
         and sha(C.github_source('package-lock.json', b['sourceHead'])) == SOURCE_LOCK,
         'DAILY_CARE_SOURCE_DEPENDENCY_INPUT_CHANGED')
    need(candidate['files']['migrate.mjs'] == C.github_source('scripts/release-migrate.mjs', b['sourceHead'])
         and candidate['files']['db/migrations/' + MIGRATION] == github_new_source('db/migrations/' + MIGRATION, b['sourceHead'])
         and sha(github_new_source(HELPER_SOURCE, b['sourceHead'])) == b['helperSha256'],
         'DAILY_CARE_SOURCE_BYTES_MISMATCH')
    value = parse(D.command([NODE, str(Path(candidate['directory']) / 'migrate.mjs'), 'verify']))
    need(value.get('verified') is True and value.get('sourceHead') == b['sourceHead']
         and value.get('sourceTree') == b['sourceTree'] and value.get('migrations') == 101,
         'DAILY_CARE_COMPLETE_ARTIFACT_REQUIRED')



def stage_binding(b, candidate):
    path = Path(b.get('stageReceipt', ''))
    need(path.name == 'stage-receipt.json' and path.parent.parent == STAGES
         and re.fullmatch(r'daily101-' + b['sourceHead'][:12] + r'-[a-z0-9_]{8}', path.parent.name),
         'DAILY_CARE_STAGE_PATH_REQUIRED')
    raw = read(path, 65536, True)
    need(sha(raw) == b['stageReceiptSha256'], 'DAILY_CARE_STAGE_RECEIPT_DRIFT')
    r = parse(raw)
    need(r.get('kind') == 'trial-daily-day-stage' and r.get('staged') is True and r.get('deployed') is False
         and r.get('instanceId') == 'lhins-61ikz4mi' and r.get('publicIpv4') == '124.223.74.198'
         and r.get('baselineHead') == BASELINE_HEAD and r.get('sourceHead') == b['sourceHead'] and r.get('sourceTree') == b['sourceTree']
         and r.get('archiveSha256') == b['archiveSha256'] and r.get('archiveSize') == b['archiveBytes']
         and r.get('manifestSha256') == b['manifestSha256'] and r.get('dependenciesSha256') == DEPENDENCIES
         and r.get('migrations') == 101 and r.get('helperSha256') == b['helperSha256']
         and r.get('migrationSha256') == MIGRATION_SHA
         and r.get('privateStage') == str(path.parent) and r.get('candidateDirectories') == [candidate['directory']]
         and all(r.get(key) is False for key in ('servicesChanged', 'databaseChanged', 'configurationChanged', 'productionChanged', 'peerFilesChanged')),
         'DAILY_CARE_STAGE_BINDING_MISMATCH')
    archive = read(path.parent / 'archive.tar.gz', 512 * 1024 ** 2, True)
    need(len(archive) == b['archiveBytes'] and sha(archive) == b['archiveSha256'], 'DAILY_CARE_ARCHIVE_MISMATCH')
    return str(path)


def optional_active():
    if STATE_PARENT.exists() or STATE_PARENT.is_symlink():
        D.owned_directory(STATE_PARENT, True)
    return read(ACTIVE, 65536, True) if ACTIVE.exists() or ACTIVE.is_symlink() else None


def verify_history(plan, active_allowed=()):
    need(all(read(ROOT / name, private=True) == value for name, value in plan['historicalActive'].items()),
         'DAILY_CARE_HISTORICAL_ACTIVE_DRIFT')
    need(read(B.ACTIVE, 65536, True) == plan['baselineUpdateActive'], 'DAILY_CARE_A189_ACTIVE_HISTORY_DRIFT')
    need(optional_active() in (active_allowed or (None,)), 'DAILY_CARE_UNKNOWN_ACTIVE_DRIFT')


def verify_context(plan, provenance=True, candidate_allowed=False, active_allowed=(), exact_production_pids=True, preserve_comments=True):
    C.fixed_profile(plan['profile'])
    D.verify_context(plan, provenance=provenance, allow_candidate=candidate_allowed)
    verify_history(plan, active_allowed)
    C.production_preserved(plan['production'], exact_production_pids)
    C.six_keys(plan['config'], plan['production']['config'])
    need(sha(read(Path(plan['stageReceipt']), 65536, True)) == plan['binding']['stageReceiptSha256'],
         'DAILY_CARE_STAGE_RECEIPT_DRIFT')
    compatibility(plan['binding'], plan['old'])
    need(C.article_fence(plan['profile']) == plan['articleFence'], 'DAILY_CARE_EXISTING_ARTICLE_FACTS_DRIFT')
    if preserve_comments:
        need(comments_fence(plan['profile']) == plan['commentsFence'], 'DAILY_CARE_EXISTING_COMMENTS_DRIFT')


def journal(plan, allowed, drain=False):
    result = C.database_guard(plan['profile'], plan['config'], plan['ownership'], allowed, drain)
    if len(result) == 101:
        schema101(plan['profile'])
    else:
        B.schema100(plan['profile'])
        schema101_absent(plan['profile'])
    return result



def fixed_profile(profile):
    need(profile == {'root':'/opt/cisme-trial','user':'cisme-trial','database':'cisme_trial',
        'domain':'staging-api.cisme.cn','units':('cisme-trial-api.service','cisme-trial-worker.service'),
        'lock':'/run/lock/cisme-production-trial.lock','name':'trial'}, 'DAILY_CARE_TRIAL_PROFILE_REQUIRED')


def validate_compatibility(b):
    # There is deliberately no old100-at101 rollback permit. The old application
    # cannot enforce the new day/deletion contract, even before any user edit.
    need(b.get('applicationRollbackAllowed') is False, 'DAILY_CARE_ROLLBACK_FORBIDDEN')
    return {'applicationRollbackAllowed': False}


def validate_compatibility_facts(value):
    need(value == {'applicationRollbackAllowed': False}, 'DAILY_CARE_ROLLBACK_FORBIDDEN')
    return value


def compatibility(b, old):
    need(sha(old['files']['index.js']) == old['manifest']['hashes']['index.js'] == BASELINE_INDEX, 'DAILY_CARE_BASELINE_INDEX_DRIFT')
    return validate_compatibility(b)


def comments_fence(profile):
    # Authored business facts are fixed during the cutover. Content-safety scan
    # results/claims are live worker projections and may legitimately progress.
    names = ('editorial_comment', 'editorial_comment_like', 'editorial_comment_policy', 'editorial_comment_report')
    parts = []
    for name in names:
        parts.append("'" + name + "',(SELECT json_build_object('count',count(*),'sha256',"
                     "encode(digest(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'sha256'),'hex')) FROM " + name + " t)")
    return D.query(profile, 'SELECT json_build_object(' + ','.join(parts) + ')')


def schema101_absent(profile):
    value = D.query(profile, "SELECT json_build_object('revisionAbsent',to_regclass('public.daily_care_record_revision') IS NULL,'dayAbsent',NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='daily_care_record' AND column_name='care_day'))")
    need(value == {'revisionAbsent': True, 'dayAbsent': True}, 'DAILY_CARE_UNEXPECTED_PREEXISTING_SCHEMA101')


def schema101(profile):
    C.schema99(profile)
    value = D.query(profile, "SELECT json_build_object('columns',(SELECT json_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='daily_care_record'),'revisionOwner',(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='daily_care_record_revision'::regclass),'uniqueDay',EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='daily_care_record'::regclass AND c.relname='daily_care_record_live_day' AND i.indisvalid AND i.indisready AND i.indisunique),'duplicateLive',EXISTS(SELECT 1 FROM daily_care_record WHERE suppressed_at IS NULL AND deleted_at IS NULL AND superseded_by IS NULL GROUP BY member_id,care_day HAVING count(*)>1))")
    need(value.get('columns') == ['id','member_id','operation_id','request_sha256','completed_at','timezone','protocol_version','step_codes','self_assessment','suppressed_at','care_day','version','updated_at','latest_operation_id','deleted_at','superseded_by']
         and value.get('revisionOwner') == 'cisme_trial' and value.get('uniqueDay') is True and value.get('duplicateLive') is False,
         'DAILY_CARE_SCHEMA101_OBJECTS_REQUIRED')


def daily_fence(profile):
    # Original100 columns only; migration may add projection columns, never alter
    # a user's or previously isolated QA fact. Hash is saved only in root-private plan.
    return D.query(profile, "SELECT json_build_object('count',count(*),'sha256',encode(digest(COALESCE(jsonb_agg(jsonb_build_object('id',id,'member_id',member_id,'operation_id',operation_id,'request_sha256',request_sha256,'completed_at',completed_at,'timezone',timezone,'protocol_version',protocol_version,'step_codes',step_codes,'self_assessment',self_assessment,'suppressed_at',suppressed_at) ORDER BY id)::text,'[]'),'sha256'),'hex')) FROM daily_care_record")


def migrate(plan, backup, state, approval):
    validate_snapshot(backup, state, approval)
    journal(plan, [plan['old']['manifest']['migrations']], True)
    D.command(['/usr/sbin/runuser', '-u', 'cisme-trial', '--', NODE,
        str(Path(plan['candidate']['directory']) / 'migrate.mjs'), 'up'],
        env={**CLEAN, **plan['config'], 'CISME_MIGRATION_APPROVAL_REF': approval,
             'CISME_PREDEPLOY_BACKUP_REF': backup['backupReference']}, cwd=ROOT, timeout=180)
    journal(plan, [plan['candidate']['manifest']['migrations']], True)
    need(daily_fence(plan['profile']) == plan['dailyFence'], 'DAILY_CARE_ORIGINAL100_FACTS_CHANGED')


def preflight(b):
    current = load_baseline(True)
    profile, config = current['profile'], current['config']
    C.fixed_profile(profile)
    need(optional_active() is None, 'DAILY_CARE_EXISTING_UPDATE_REFUSED')
    need(config.get('APP_ENV') == 'staging' and config.get('WECHAT_APP_ID') == C.APP_ID and D.closed_context(profile, config)
         and config.get('WECHAT_PHONE_BINDING_ENABLED', 'false') == 'false'
         and config.get('COS_DIRECT_UPLOAD_ENABLED', 'false') == 'false', 'DAILY_CARE_CLOSED_TRIAL_REQUIRED')
    old = D.artifact(str(current['release']), ROOT)
    candidate = D.artifact(str(ROOT / 'releases' / ('tencent-release-' + b['sourceHead'][:12])), ROOT)
    artifact_contract(old, candidate, b)
    main = D.general.reviewed_main()
    source_permit(b, candidate, main)
    stage = stage_binding(b, candidate)
    compatibility(b, old)
    initial = {name: read(ROOT / name, private=True) for name in ('ownership.json', 'empty-database.json', 'migration-complete.json')}
    ownership = parse(initial['ownership.json'])
    production = C.production_capture()
    C.six_keys(config, production['config'])
    C.database_guard(profile, config, ownership, [old['manifest']['migrations']])
    C.schema99(profile)
    B.schema100(profile)
    schema101_absent(profile)
    fence = C.article_fence(profile)
    need(fence.get('publishedCount') == 20, 'DAILY_CARE_CURRENT20_REQUIRED')
    comment_facts = comments_fence(profile)
    units = {unit: D.read_owned(D.unit_path(unit)) for unit in profile['units']}
    dropins = {unit: D.dropin_inputs(unit) for unit in profile['units']}
    definitions = {unit: D.unit_definition(unit, units[unit], entry, profile, dropins[unit])
                   for unit, entry in zip(profile['units'], ('index.js', 'worker.js'))}
    versions = D.native_smoke(profile, old['directory'], True)
    need(versions == D.native_smoke(profile, candidate['directory'], True), 'DAILY_CARE_NATIVE_RUNTIME_CHANGED')
    # D.read_owned(private=True) permits service-group read (mask 0027),
    # unlike this module's root-only metadata reader. Metadata requires 0640.
    return {'profile': profile, 'main': main, 'old': old, 'candidate': candidate, 'config': config,
        'env': D.read_owned(ROOT / 'runtime.env', private=True), 'environmentMetadata': D.environment_metadata(profile),
        'privateInputs': D.private_inputs(profile, config), 'units': units, 'dropIns': dropins, 'unitDefinitions': definitions,
        'ownership': ownership, 'initialRecords': initial, 'production': production, 'articleFence': fence, 'commentsFence': comment_facts, 'dailyFence': daily_fence(profile), 'versions': versions,
        'baselineUpdateActive': read(B.ACTIVE, 65536, True),
        'historicalActive': {name: read(ROOT / name, private=True) for name in
            ('dependency-active-release.json', 'application-active-release.json', 'editorial-comments-active-release.json')},
        'stageReceipt': stage, 'binding': b}


def save_plan(plan, state):
    saved = dict(plan)
    for name in ('old', 'candidate'):
        saved[name] = {key: value for key, value in plan[name].items() if key != 'files'}
    raw = (json.dumps(C.encode_private(saved), sort_keys=True) + '\n').encode()
    need(len(raw) <= 8 * 1024 ** 2, 'DAILY_CARE_PRIVATE_PLAN_TOO_LARGE')
    D.general.store(state / 'protected-plan.json', raw)
    return sha(raw)


def active_record(plan, state, plan_sha, selected, migrations, rollback=False):
    return (json.dumps({'schemaVersion': 1, 'kind': 'trial-daily-day-active-release',
        'environment': 'trial', 'instanceId': 'lhins-61ikz4mi', 'database': 'cisme_trial',
        'sourceHead': selected['manifest']['sourceHead'], 'sourceTree': selected['manifest']['sourceTree'],
        'directory': selected['directory'], 'manifestSha256': selected['manifestSha256'],
        'dependenciesSha256': DEPENDENCIES, 'baselineHead': BASELINE_HEAD, 'migrationCount': len(migrations),
        'ownershipId': plan['ownership']['ownershipId'], 'upgradeState': str(state), 'privatePlanSha256': plan_sha,
        'schemaChanged': len(migrations) == 101, 'databaseRestored': False, 'applicationRollback': rollback,
        'previousActiveHistoryPreserved': True}, sort_keys=True) + '\n').encode()



def cutover(plan,state,approval):
    C.fixed_profile(plan['profile']);halted=False;published=None
    old_sql,new_sql=plan['old']['manifest']['migrations'],plan['candidate']['manifest']['migrations']
    try:
        verify_context(plan);journal(plan,[old_sql]);halted=True
        D.command(['systemctl','stop',*plan['profile']['units']],timeout=90);D.stopped(plan['profile'])
        verify_context(plan,provenance=False);journal(plan,[old_sql],True)
        # Include legitimate requests completed between preflight and drain.
        # This fence is captured after writers stop, before the sole migration.
        plan['dailyFence']=daily_fence(plan['profile'])
        plan_sha=save_plan(plan,state)
        backup=snapshot(plan,state,approval);validate_snapshot(backup,state,approval)
        verify_context(plan);migrate(plan,backup,state,approval)
        verify_context(plan,provenance=False);journal(plan,[new_sql],True)
        D.switch(plan,plan['candidate']['directory']);D.verify_units(plan,allow_candidate=True);verify_history(plan)
        started=time.time();D.command(['systemctl','start',*plan['profile']['units']],timeout=60)
        versions=D.healthy(plan,plan['candidate']['directory'],started,True);C.public_contract(plan,True)
        verify_context(plan,candidate_allowed=True);journal(plan,[new_sql]);schema101(plan['profile'])
        published=active_record(plan,state,plan_sha,plan['candidate'],new_sql)
        D.atomic_bytes(ACTIVE,published)
        verify_context(plan,provenance=False,candidate_allowed=True,active_allowed=(published,));journal(plan,[new_sql])
        report={'deployed':True,'environment':'trial','sourceHead':plan['main']['sha'],'migrationCountBefore':100,'migrationCountAfter':101,
          'snapshotAuthenticated':True,'snapshotScope':'same-host-database-only','fullRecoveryQualified':False,'databaseRestored':False,
          'versions':versions,'existing20ArticlesPreserved':True,'configurationChanged':False,'credentialsChanged':False,
          'productionChanged':False,'businessDataSeeded':False,'consentCreated':False,'authorityGranted':False}
        D.general.store(state/'deployed.json',(json.dumps(report,sort_keys=True)+'\n').encode());return report
    except Exception:
        if not halted:raise
        # Never invoke the old application's switch after101, and never restore
        # or down. Preserve exact state for reviewed forward recovery.
        stopped = False
        try:
            D.command(['systemctl','stop',*plan['profile']['units']],timeout=90)
            D.stopped(plan['profile']);stopped=True
        except Exception:
            pass
        D.general.store(state/'manual-recovery-required.json',(json.dumps({'servicesStopped':stopped,'unknownInputsOverwritten':False,'databaseRestored':False,'applicationRollbackExecuted':False})+'\n').encode())
        raise Refused('DAILY_CARE_FAILED_FENCED_FORWARD_REVIEW_REQUIRED')from None



def active_context(b):
    validate_binding(b)
    load_baseline(False)
    identity = D.general.observe.identity()
    need(identity.get('instanceId') == 'lhins-61ikz4mi' and identity.get('publicIpv4') == '124.223.74.198',
         'DAILY_CARE_EXACT_INSTANCE_REQUIRED')
    raw = read(ACTIVE, 65536, True)
    active = parse(raw)
    state = Path(active.get('upgradeState', ''))
    need(state.parent == STATE_PARENT and re.fullmatch(r'main-' + b['sourceHead'][:12] + r'-[0-9]+', state.name),
         'DAILY_CARE_ACTIVE_STATE_PATH_REQUIRED')
    saved = read(state / 'protected-plan.json', 8 * 1024 ** 2, True)
    need(sha(saved) == active.get('privatePlanSha256'), 'DAILY_CARE_PRIVATE_PLAN_DRIFT')
    plan = C.decode_private(parse(saved))
    need(plan.get('binding') == b, 'DAILY_CARE_ACTIVE_BINDING_DRIFT')
    C.fixed_profile(plan['profile'])
    old, candidate = (D.artifact(plan[key]['directory'], ROOT) for key in ('old', 'candidate'))
    artifact_contract(old, candidate, b)
    plan.update(old=old, candidate=candidate)
    need(raw == active_record(plan, state, sha(saved), candidate, candidate['manifest']['migrations']), 'DAILY_CARE_NEW_ACTIVE_RELEASE_REQUIRED')
    verify_context(plan, provenance=False, candidate_allowed=True, active_allowed=(raw,), exact_production_pids=False, preserve_comments=False)
    for unit, entry in zip(plan['profile']['units'], ('index.js', 'worker.js')):
        need(D.unit_entry(D.read_owned(D.unit_path(unit)), entry, plan['profile']) == Path(candidate['directory']),
             'DAILY_CARE_ACTIVE_UNIT_PATH_REQUIRED')
    D.running(plan['profile'], candidate['directory'], plan['config'])
    journal(plan, [candidate['manifest']['migrations']])
    return {'C': C, 'D': D, 'profile': plan['profile'], 'config': plan['config'],
            'release': Path(candidate['directory']), 'binding': b}


def apply(b, approval):
    need(re.fullmatch(r'[-A-Za-z0-9_:.]{8,120}', approval or ''), 'DAILY_CARE_OPERATION_REFERENCE_REQUIRED')
    need(os.geteuid() == OWNER, 'DAILY_CARE_ROOT_REQUIRED')
    load_baseline(False)
    identity = D.general.observe.identity()
    need(identity.get('instanceId') == 'lhins-61ikz4mi' and identity.get('publicIpv4') == '124.223.74.198',
         'DAILY_CARE_EXACT_INSTANCE_REQUIRED')
    lock = Path('/run/lock/cisme-production-trial.lock')
    before = lock.parent.lstat()
    need(stat.S_ISDIR(before.st_mode) and before.st_uid == OWNER and stat.S_IMODE(before.st_mode) == 0o1777,
         'DAILY_CARE_LOCK_PARENT_REQUIRED')
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
             'DAILY_CARE_LOCK_REQUIRED')
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


def safe_error_code(error):
    known = (Refused,) + tuple(kind for module in (B, C) if module is not None
        for kind in (getattr(module, 'Refused', None),) if isinstance(kind, type))
    value = str(error) if isinstance(error, known) else ''
    if re.fullmatch(r'(?:DAILY_CARE_|COMMENTS_SOURCE_|SCHEMA99_)[A-Z0-9_]{1,100}', value):
        return value
    return 'DAILY_CARE_APPLICATION_REVIEW_REQUIRED'


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
            result = {'readOnly': True, 'activeVerified': True, 'sourceHead': b['sourceHead'], 'migrationCount': 101}
        else:
            plan = preflight(b)
            result = {'readOnly': True, 'deployed': False, 'sourceHead': plan['main']['sha'],
                      'migrationCountBefore': 100, 'migrationCountAfter': 101, 'schemaChanged': True, 'sameHostSnapshotNotYetCreated': True, 'productionPreserved': True}
        print(json.dumps({**result, 'privateValuesExported': False}, sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({'ok': False, 'code': safe_error_code(error), 'privateValuesExported': False}))
        return 1


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


SNAPSHOT_STRUCTURE_TIMEOUT = 180
SNAPSHOT_TOC_LIMIT = 1024 * 1024


def snapshot_table_of_contents(encrypted, key, aad):
    # pg_restore --list may finish after the custom archive's TOC. Keep
    # draining/authenticating the decryptor even after its consumer closes.
    decrypt = listing = watchdog = None
    expired = threading.Event()

    def kill_running():
        expired.set()
        for process in (listing, decrypt):
            if process is not None and process.poll() is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass

    def limit_toc_file():
        resource.setrlimit(resource.RLIMIT_FSIZE, (SNAPSHOT_TOC_LIMIT + 1, SNAPSHOT_TOC_LIMIT + 1))

    try:
        with tempfile.TemporaryFile(mode='w+b', dir=encrypted.parent, prefix='.snapshot-toc-') as toc:
            info = os.fstat(toc.fileno())
            need(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER
                 and stat.S_IMODE(info.st_mode) == 0o600, 'APPLICATION_SNAPSHOT_FILE_UNSAFE')
            decrypt = subprocess.Popen(crypto_args('decrypt', encrypted, key, aad), env=CLEAN,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            listing = subprocess.Popen(['/usr/bin/pg_restore', '--list'], env=CLEAN,
                                       stdin=subprocess.PIPE, stdout=toc, stderr=subprocess.DEVNULL,
                                       preexec_fn=limit_toc_file)
            watchdog = threading.Timer(SNAPSHOT_STRUCTURE_TIMEOUT, kill_running)
            watchdog.daemon = True
            watchdog.start()
            feeding = True
            while chunk := decrypt.stdout.read(65536):
                if feeding:
                    try:
                        listing.stdin.write(chunk)
                        listing.stdin.flush()
                    except BrokenPipeError:
                        feeding = False
            try:
                listing.stdin.close()
            except BrokenPipeError:
                pass
            decrypt_exit = decrypt.wait(timeout=20)
            listing_exit = listing.wait(timeout=20)
            need(not expired.is_set() and decrypt_exit == 0 and listing_exit == 0,
                 'APPLICATION_SNAPSHOT_STRUCTURE_FAILED')
            toc.seek(0)
            table_of_contents = toc.read(SNAPSHOT_TOC_LIMIT + 1)
            need(len(table_of_contents) <= SNAPSHOT_TOC_LIMIT
                 and b'dbname: cisme_trial' in table_of_contents
                 and b'TABLE DATA public schema_migration' in table_of_contents,
                 'APPLICATION_SNAPSHOT_STRUCTURE_FAILED')
            return table_of_contents
    finally:
        if watchdog is not None:
            watchdog.cancel()
            watchdog.join()
        for process in (listing, decrypt):
            if process is not None:
                if process.poll() is None:
                    process.kill()
                process.wait()
                for stream in (process.stdin, process.stdout):
                    if stream is not None and not stream.closed:
                        try:
                            stream.close()
                        except BrokenPipeError:
                            pass


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
    table_of_contents = snapshot_table_of_contents(encrypted, key, aad)
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

if __name__ == '__main__':
    raise SystemExit(main())
