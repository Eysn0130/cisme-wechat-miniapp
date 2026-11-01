#!/usr/bin/env python3
"""Exact deployed 83a/schema103 -> committed-source/schema104 support upgrade.

Trial only; the default preflight is read-only. Never changes environment,
credentials, authority or original business facts. Only the reviewed collaboration migration104 is applied; no restore.
There is no automatic application rollback. Any cutover failure stops trial
services for forward review, preserving the new conversation semantics.
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
BASELINE_HEAD = '83a59649715d150a1f71d7c0209fb7f126552b37'
BASELINE_TREE = '334924d64940b934a1632cd538eec0771a956c14'
BASELINE_MANIFEST = '2b501c6652e96865b945381a5d1d2d396d376e3e8440f5779069d2ae7c9ecf37'
BASELINE_RUNNER = ROOT / 'support-fresh-runners' / BASELINE_HEAD[:12]
BASELINE_HELPER_SHA = 'aa71d4373f32074eef6ce8c9e3927a6d1a62d739452ae8af9050bad0a4fbbda9'
BASELINE_BINDING_SHA = 'b55434bf2ab897cf96011a18a036748963aa46355753f27e8f04fc070cd8d36b'
DEPENDENCIES = 'd9f03813fc808eced42eacb92db4530a2cd0e0824cab5d1beb9c3bdf08144bdd'
SOURCE_PACKAGE = 'c70b97f3ec0e6c339c5c27b0e9067549f9256287cfbfdf32f39ae46fcf54e231'
SOURCE_LOCK = '2a14af4f1bfdd86d0108015b43df14d62b2cc6e8eedcd3831446970a26d7d32a'
STATE_PARENT = ROOT / 'support-ai-human-collaboration-updates'
ACTIVE = STATE_PARENT / 'active-release.json'
RUNNERS = ROOT / 'support-ai-human-collaboration-runners'
STAGES = Path('/var/lib/cisme-dependency-stage')
HELPER_SOURCE = 'infra/tencent/trial-support-ai-human-collaboration-upgrade.py'
NODE = '/opt/node-v24.14.0-linux-x64/bin/node'
IMDS = {'instance-id': 'ins-l9utqwxv', 'local-ipv4': '10.0.0.10', 'public-ipv4': '124.223.74.198'}
HISTORY_ROOT = ('dependency-active-release.json', 'application-active-release.json', 'editorial-comments-active-release.json',
                'ownership.json', 'empty-database.json', 'migration-complete.json')
MIGRATION = '202610310001_support_ai_human_collaboration.sql'
MIGRATION_SHA = 'ddb39dc44dc70514ddfd012906cfe39ef7a2082448831b0ad42540b5de03b543'
COLLABORATION_MARKER = 'cisme.support_ai_reply'
COLLABORATION_COLUMNS = [
    {'table': 'support_conversation', 'name': 'human_request_anchor_sequence', 'type': 'bigint', 'notNull': False, 'default': None},
    {'table': 'support_conversation', 'name': 'human_request_context_version', 'type': 'integer', 'notNull': True, 'default': '0'},
    {'table': 'support_conversation', 'name': 'human_request_generation', 'type': 'integer', 'notNull': True, 'default': '0'},
    {'table': 'support_message', 'name': 'reply_to_message_id', 'type': 'uuid', 'notNull': False, 'default': None},
]
COLLABORATION_CONSTRAINTS = [
    {'name': 'support_conversation_human_request_anchor_sequence_check', 'definition': 'CHECKhuman_request_anchor_sequenceISNULLORhuman_request_anchor_sequence>0', 'validated': True},
    {'name': 'support_conversation_human_request_context_version_check', 'definition': 'CHECKhuman_request_context_version>=0', 'validated': True},
    {'name': 'support_conversation_human_request_generation_check', 'definition': 'CHECKhuman_request_generation>=0', 'validated': True},
]
REPLY_INDEX = {'definition': 'CREATEINDEXsupport_message_reply_targetONpublic.support_messageUSINGbtreeconversation_id,reply_to_message_id,sender_typeWHEREreply_to_message_idISNOTNULL',
               'valid': True, 'ready': True, 'unique': False, 'owner': 'cisme_trial'}
CLEAN = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}
P = C = D = B = S = None


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
        need(key not in result, 'SUPPORT_COLLAB_DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def parse(raw):
    return json.loads(raw, object_pairs_hook=unique)


def read(path, limit=1024 * 1024):
    need(path.is_absolute() and '..' not in path.parts, 'SUPPORT_COLLAB_ABSOLUTE_PATH_REQUIRED')
    for parent in reversed(path.parents):
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == OWNER and not info.st_mode & 0o022,
             'SUPPORT_COLLAB_PROTECTED_PARENT_REQUIRED')
    permitted = (0o700, 0o750, 0o755) if path.parent == ROOT and path.name in HISTORY_ROOT else (0o700,)
    need(stat.S_IMODE(path.parent.lstat().st_mode) in permitted, 'SUPPORT_COLLAB_PRIVATE_PARENT_REQUIRED')
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == OWNER and before.st_nlink == 1
             and stat.S_IMODE(before.st_mode) == 0o600 and 0 < before.st_size <= limit,
             'SUPPORT_COLLAB_PROTECTED_FILE_REQUIRED')
        data = bytearray()
        while chunk := os.read(fd, min(65536, limit + 1 - len(data))):
            data.extend(chunk)
            need(len(data) <= limit, 'SUPPORT_COLLAB_FILE_TOO_LARGE')
        after = os.fstat(fd)
        need(len(data) == before.st_size and (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
             == (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'SUPPORT_COLLAB_FILE_CHANGED')
        return bytes(data)
    finally:
        os.close(fd)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Refused('SUPPORT_COLLAB_REDIRECT_REFUSED')


def response(url, limit):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json',
        'Cache-Control': 'no-cache', 'User-Agent': 'cisme-trial-support-ai-human-collaboration'})
    with opener.open(request, timeout=12) as remote:
        need(remote.status == 200, 'SUPPORT_COLLAB_SOURCE_UNAVAILABLE')
        declared = remote.headers.get('Content-Length')
        need(declared is None or re.fullmatch(r'[0-9]+', declared) and 0 < int(declared) <= limit,
             'SUPPORT_COLLAB_RESPONSE_SIZE_REQUIRED')
        raw = remote.read(limit + 1)
        need(0 < len(raw) <= limit and (declared is None or len(raw) == int(declared)), 'SUPPORT_COLLAB_RESPONSE_TRUNCATED')
    return raw


def target():
    need(os.geteuid() == OWNER, 'SUPPORT_COLLAB_ROOT_REQUIRED')
    actual = {name: response('http://metadata.tencentyun.com/latest/meta-data/' + name, 128).decode('ascii').strip() for name in IMDS}
    need(actual == IMDS, 'SUPPORT_COLLAB_EXACT_IMDS_TARGET_REQUIRED')
    if D is not None:
        identity = D.general.observe.identity()
        need(identity.get('instanceId') == 'lhins-61ikz4mi' and identity.get('publicIpv4') == IMDS['public-ipv4'],
             'SUPPORT_COLLAB_EXACT_INSTANCE_REQUIRED')


def load_baseline(active=True):
    global P, C, D, B, S
    target()
    path = BASELINE_RUNNER / 'trial-support-fresh-update.py'
    raw = read(path, 128 * 1024)
    need(sha(raw) == BASELINE_HELPER_SHA, 'SUPPORT_COLLAB_PINNED_83A_HELPER_REQUIRED')
    P = types.ModuleType('reviewed_83a_schema103_baseline')
    P.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), P.__dict__)
    old_binding = P.binding(BASELINE_RUNNER / 'application-binding.json', BASELINE_BINDING_SHA)
    need(old_binding.get('sourceHead') == BASELINE_HEAD and old_binding.get('sourceTree') == BASELINE_TREE
         and old_binding.get('manifestSha256') == BASELINE_MANIFEST and old_binding.get('migrations') == 103,
         'SUPPORT_COLLAB_83A_BASELINE_BINDING_REQUIRED')
    if active:
        # The deployed 83a guard recursively verifies its original103 inputs,
        # exact current units, private AI configuration and previous history.
        current = P.active_context(old_binding)
        C, D = P.C, P.D
        B = P.P.P.A.B
        S = B.B
        need(current['release'] == ROOT / 'releases' / ('tencent-release-' + BASELINE_HEAD[:12]),
             'SUPPORT_COLLAB_BASELINE_RELEASE_REQUIRED')
        return current, old_binding
    # After our units change, only load 83a's pinned primitive chain; calling
    # 83a's active_context would incorrectly require its old unit paths.
    P.load_baseline(False)
    C, D = P.C, P.D
    B = P.P.P.A.B
    S = B.B
    return None, old_binding

def validate_binding(b):
    need(b.get('schemaVersion') == 1 and b.get('kind') == 'trial-support-ai-human-collaboration-upgrade'
         and b.get('baselineHead') == BASELINE_HEAD and b.get('baselineTree') == BASELINE_TREE,
         'SUPPORT_COLLAB_BASELINE_BINDING_REQUIRED')
    need(all(isinstance(b.get(key), str) and re.fullmatch(r'[0-9a-f]{40}', b[key]) and b[key] != '0' * 40
             for key in ('sourceHead', 'sourceTree')) and b['sourceHead'][:12] != BASELINE_HEAD[:12],
         'SUPPORT_COLLAB_EXACT_NEW_SOURCE_REQUIRED')
    need(all(isinstance(b.get(key), str) and re.fullmatch(r'[0-9a-f]{64}', b[key])
             for key in ('helperSha256', 'manifestSha256', 'archiveSha256'))
         and type(b.get('archiveBytes')) is int and 0 < b['archiveBytes'] <= 512 * 1024 ** 2,
         'SUPPORT_COLLAB_EXACT_ARTIFACT_REQUIRED')
    need(b.get('dependenciesSha256') == DEPENDENCIES and type(b.get('migrations')) is int and b['migrations'] == 104
         and b.get('applicationRollbackAllowed') is False and isinstance(b.get('migrationSha256'), dict)
         and len(b['migrationSha256']) == 104 and b['migrationSha256'].get(MIGRATION) == MIGRATION_SHA
         and all(isinstance(name, str) and re.fullmatch(r'\d+_[A-Za-z0-9_-]+\.sql', name)
                 and isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) for name, value in b['migrationSha256'].items()),
         'SUPPORT_COLLAB_EXACT_SCHEMA104_REQUIRED')
    archive = Path(b.get('archivePath', ''))
    need(archive.name == 'archive.tar.gz' and archive.parent.parent == STAGES
         and re.fullmatch(r'support-ai-human-collaboration-' + b['sourceHead'][:12] + r'-[a-z0-9_-]{8,40}', archive.parent.name),
         'SUPPORT_COLLAB_PRIVATE_ARCHIVE_PATH_REQUIRED')
    need(Path(__file__) == RUNNERS / b['sourceHead'][:12] / 'trial-support-ai-human-collaboration-upgrade.py',
         'SUPPORT_COLLAB_EXACT_RUNNER_PATH_REQUIRED')
    need(sha(read(Path(__file__), 128 * 1024)) == b['helperSha256'], 'SUPPORT_COLLAB_EXACT_HELPER_REQUIRED')
    return b


def binding(path, expected):
    need(re.fullmatch(r'[0-9a-f]{64}', expected or ''), 'SUPPORT_COLLAB_BINDING_SHA_REQUIRED')
    raw = read(path, 65536)
    need(sha(raw) == expected, 'SUPPORT_COLLAB_BINDING_HASH_MISMATCH')
    value = validate_binding(parse(raw))
    need(path == RUNNERS / value['sourceHead'][:12] / 'application-binding.json',
         'SUPPORT_COLLAB_EXACT_BINDING_PATH_REQUIRED')
    return value


def artifact_contract(old, candidate, b):
    before, after = old['manifest'], candidate['manifest']
    need(before.get('sourceHead') == BASELINE_HEAD and before.get('sourceTree') == BASELINE_TREE
         and old['manifestSha256'] == BASELINE_MANIFEST
         and old['directory'] == str(ROOT / 'releases' / ('tencent-release-' + BASELINE_HEAD[:12])),
         'SUPPORT_COLLAB_EXACT_83A_ARTIFACT_REQUIRED')
    need(after.get('sourceHead') == b['sourceHead'] and after.get('sourceTree') == b['sourceTree']
         and candidate['manifestSha256'] == b['manifestSha256'] and after.get('sourceLockSha256') == SOURCE_LOCK
         and candidate['directory'] == str(ROOT / 'releases' / ('tencent-release-' + b['sourceHead'][:12]))
         and after.get('node') == 'v24.14.0' and after.get('buildPlatform') == {'os': 'linux', 'arch': 'x64', 'libc': 'glibc'}
         and all(after.get(key) is False for key in ('configurationIncluded', 'deployed', 'releaseReady')),
         'SUPPORT_COLLAB_EXACT_LINUX_ARTIFACT_REQUIRED')
    sql = before.get('migrations', [])
    need(len(sql) == 103 and sql == sorted(set(sql)) and sql[-1] == '202610300003_support_explicit_ai_resume.sql'
         and after.get('migrations') == sql + [MIGRATION] and set(b['migrationSha256']) == set(sql + [MIGRATION])
         and b['migrationSha256'].get(MIGRATION) == MIGRATION_SHA,
         'SUPPORT_COLLAB_ONLY_MIGRATION104_REQUIRED')
    names = ['migrate.mjs', 'package.json', 'package-lock.json'] + ['db/migrations/' + name for name in sql]
    need(all(old['files'].get(name) and old['files'][name] == candidate['files'].get(name) for name in names),
         'SUPPORT_COLLAB_SQL_MIGRATOR_OR_PACKAGE_CHANGED')
    need(all(sha(candidate['files']['db/migrations/' + name]) == b['migrationSha256'][name] for name in sql + [MIGRATION]),
         'SUPPORT_COLLAB_SQL_BINDING_HASH_MISMATCH')
    need(old['dependenciesSha256'] == candidate['dependenciesSha256'] == DEPENDENCIES,
         'SUPPORT_COLLAB_FULL_DEPENDENCY_TREE_CHANGED')


def source_bytes(name, head):
    need(name in ('package.json', 'package-lock.json') and re.fullmatch(r'[0-9a-f]{40}', head), 'SUPPORT_COLLAB_SOURCE_PATH_REQUIRED')
    value = parse(response('https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/contents/' + name + '?ref=' + head, 2 * 1024 ** 2))
    need(value.get('type') == 'file' and value.get('path') == name and value.get('encoding') == 'base64'
         and type(value.get('size')) is int and 0 < value['size'] <= 1024 * 1024 and isinstance(value.get('content'), str),
         'SUPPORT_COLLAB_SOURCE_METADATA_REQUIRED')
    raw = base64.b64decode(value['content'].replace('\r', '').replace('\n', ''), validate=True)
    need(len(raw) == value['size'] and git_blob(raw) == value.get('sha'), 'SUPPORT_COLLAB_SOURCE_BLOB_MISMATCH')
    return raw


def git_blob(raw):
    return hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()


def source_permit(b, candidate):
    base = 'https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/git/'
    commit = parse(response(base + 'commits/' + b['sourceHead'], 256 * 1024))
    need(commit.get('sha') == b['sourceHead'] and commit.get('tree', {}).get('sha') == b['sourceTree'],
         'SUPPORT_COLLAB_COMMITTED_TREE_MISMATCH')
    tree = parse(response(base + 'trees/' + b['sourceTree'] + '?recursive=1', 4 * 1024 ** 2))
    need(tree.get('sha') == b['sourceTree'] and tree.get('truncated') is False and isinstance(tree.get('tree'), list),
         'SUPPORT_COLLAB_COMPLETE_SOURCE_TREE_REQUIRED')
    entries = {}
    for item in tree['tree']:
        need(isinstance(item, dict) and isinstance(item.get('path'), str) and item['path'] not in entries,
             'SUPPORT_COLLAB_SOURCE_TREE_ENTRY_INVALID')
        entries[item['path']] = item
    required = {HELPER_SOURCE: read(Path(__file__), 128 * 1024), 'scripts/release-migrate.mjs': candidate['files']['migrate.mjs']}
    required.update({'db/migrations/' + name: candidate['files']['db/migrations/' + name] for name in candidate['manifest']['migrations']})
    for name, raw in required.items():
        item = entries.get(name, {})
        need(item.get('type') == 'blob' and item.get('mode') in ('100644', '100755') and item.get('sha') == git_blob(raw),
             'SUPPORT_COLLAB_COMMITTED_ARTIFACT_MISMATCH')
    need(sha(source_bytes('package.json', b['sourceHead'])) == SOURCE_PACKAGE
         and sha(source_bytes('package-lock.json', b['sourceHead'])) == SOURCE_LOCK,
         'SUPPORT_COLLAB_COMMITTED_PACKAGE_OR_LOCK_CHANGED')
    # verify checks the immutable artifact only; it does not open a database.
    verified = parse(D.command([NODE, str(Path(candidate['directory']) / 'migrate.mjs'), 'verify']))
    need(verified.get('verified') is True and verified.get('sourceHead') == b['sourceHead']
         and verified.get('sourceTree') == b['sourceTree'] and verified.get('migrations') == 104,
         'SUPPORT_COLLAB_COMPLETE_CANDIDATE_REQUIRED')


def optional_active():
    if STATE_PARENT.exists() or STATE_PARENT.is_symlink():
        D.owned_directory(STATE_PARENT, True)
    return read(ACTIVE, 65536) if ACTIVE.exists() or ACTIVE.is_symlink() else None


def capture_history():
    # Preserve 83a,de9,0ca and every earlier active record as their original bytes.
    history = P.capture_history()
    history[str(P.ACTIVE)] = read(P.ACTIVE, 65536)
    return history

def protected_baseline_inputs(old_binding, history):
    active = parse(history[str(P.ACTIVE)])
    state = Path(active.get('upgradeState', ''))
    need(state.parent == P.STATE_PARENT and re.fullmatch(r'commit-' + BASELINE_HEAD[:12] + r'-[0-9]+', state.name),
         'SUPPORT_COLLAB_83A_PRIVATE_PLAN_PATH_REQUIRED')
    saved = read(state / 'protected-plan.json', 8 * 1024 ** 2)
    need(sha(saved) == active.get('privatePlanSha256'), 'SUPPORT_COLLAB_83A_PRIVATE_PLAN_HASH_REQUIRED')
    prior = C.decode_private(parse(saved))
    need(prior.get('binding') == old_binding and prior.get('candidate', {}).get('directory') ==
         str(ROOT / 'releases' / ('tencent-release-' + BASELINE_HEAD[:12])), 'SUPPORT_COLLAB_83A_PRIVATE_BINDING_REQUIRED')
    prior_history = prior.get('history')
    need(isinstance(prior_history, dict) and prior_history and all(isinstance(raw, bytes) and history.get(path) == raw
         for path, raw in prior_history.items()), 'SUPPORT_COLLAB_INHERITED_ACTIVE_HISTORY_DRIFT')
    inherited = prior.get('protectedBaselineInputs')
    support_binding = B.binding(P.P.P.A.BASELINE_RUNNER / 'binding.json', P.P.P.A.BASELINE_BINDING_SHA)
    # The approved key path comes from the original pinned binding, never a
    # guessed filename, environment dump or a newly supplied key location.
    key_path = support_binding.get('deepseekKeyFile')
    need(isinstance(inherited, dict) and inherited and isinstance(key_path, str) and key_path in inherited,
         'SUPPORT_COLLAB_INHERITED_AI_KEY_GUARD_REQUIRED')
    result = {}
    for path, value in inherited.items():
        need(isinstance(path, str) and isinstance(value, dict) and type(value.get('limit')) is int
             and 0 < value['limit'] <= 8 * 1024 ** 2 and isinstance(value.get('sha256'), str)
             and re.fullmatch(r'[0-9a-f]{64}', value['sha256']), 'SUPPORT_COLLAB_INHERITED_PRIVATE_INPUT_REQUIRED')
        need(sha(read(Path(path), value['limit'])) == value['sha256'], 'SUPPORT_COLLAB_INHERITED_PRIVATE_INPUT_DRIFT')
        result[path] = {'sha256': value['sha256'], 'limit': value['limit']}
    paths = [(BASELINE_RUNNER / 'trial-support-fresh-update.py', 128 * 1024),
             (BASELINE_RUNNER / 'application-binding.json', 65536), (state / 'protected-plan.json', 8 * 1024 ** 2)]
    for path, limit in paths:
        need(str(path) not in result, 'SUPPORT_COLLAB_INHERITED_INPUT_COLLISION')
        result[str(path)] = {'sha256': sha(read(path, limit)), 'limit': limit}
    need(result[str(paths[0][0])]['sha256'] == BASELINE_HELPER_SHA
         and result[str(paths[1][0])]['sha256'] == BASELINE_BINDING_SHA
         and result[str(paths[2][0])]['sha256'] == active['privatePlanSha256'],
         'SUPPORT_COLLAB_83A_CAPTURED_INPUT_DRIFT')
    return result

def verify_history(plan, allowed=()):
    need(all(read(Path(path), 65536) == raw for path, raw in plan['history'].items()), 'SUPPORT_COLLAB_HISTORY_DRIFT')
    need(all(sha(read(Path(path), value['limit'])) == value['sha256'] for path, value in plan['protectedBaselineInputs'].items()),
         'SUPPORT_COLLAB_BASELINE_PRIVATE_INPUT_DRIFT')
    need(optional_active() in (allowed or (None,)), 'SUPPORT_COLLAB_UNKNOWN_ACTIVE_RECORD')


def verify_context(plan, candidate_allowed=False, allowed=(), exact_pids=True):
    target()
    C.fixed_profile(plan['profile'])
    D.verify_context(plan, provenance=False, allow_candidate=candidate_allowed)
    verify_history(plan, allowed)
    C.production_preserved(plan['production'], exact_pids)
    C.six_keys(plan['config'], plan['production']['config'])
    need(D.closed_context(plan['profile'], plan['config']) and plan['config'].get('APP_ENV') == 'staging',
         'SUPPORT_COLLAB_CLOSED_TRIAL_REQUIRED')
    artifact_contract(D.artifact(plan['old']['directory'], ROOT), D.artifact(plan['candidate']['directory'], ROOT), plan['binding'])
    archive = read(Path(plan['binding']['archivePath']), 512 * 1024 ** 2)
    need(len(archive) == plan['binding']['archiveBytes'] and sha(archive) == plan['binding']['archiveSha256'],
         'SUPPORT_COLLAB_PRIVATE_ARCHIVE_DRIFT')


def schema104(profile, expected):
    value = D.query(profile, "SELECT json_build_object('columns',(SELECT coalesce(json_agg(json_build_object('table',c.relname,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attname),'[]'::json) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='public' AND NOT a.attisdropped AND ((c.relname='support_conversation' AND a.attname IN ('human_request_generation','human_request_anchor_sequence','human_request_context_version')) OR (c.relname='support_message' AND a.attname='reply_to_message_id'))),'controlledReplyGuard',position('cisme.support_ai_reply' in pg_get_functiondef('enforce_support_message_sender()'::regprocedure))>0,'controlledReplyStates',position('current_state.statusNOTIN(''waiting_human'',''human_active'',''resolved'')ORNEW.reply_to_message_idISNULL' in regexp_replace(pg_get_functiondef('enforce_support_message_sender()'::regprocedure),'[[:space:]]','','g'))>0,'senderOwner',(SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='enforce_support_message_sender()'::regprocedure),'senderTrigger',EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='support_message'::regclass AND tgname='support_message_sender_guard' AND tgenabled='O' AND tgfoid='enforce_support_message_sender()'::regprocedure))")
    need(value == {'columns': COLLABORATION_COLUMNS if expected else [], 'controlledReplyGuard': expected,
                   'controlledReplyStates': expected, 'senderOwner': 'cisme_trial', 'senderTrigger': True}, 'SUPPORT_COLLAB_SCHEMA104_CONTRACT_REQUIRED')
    objects = D.query(profile, "SELECT json_build_object('metadataGuard',position('cisme.support_human_request_transition' in pg_get_functiondef('enforce_support_conversation_transition()'::regprocedure))>0 AND position('cisme.support_human_anchor_bind' in pg_get_functiondef('enforce_support_conversation_transition()'::regprocedure))>0,'constraints',(SELECT coalesce(json_agg(json_build_object('name',conname,'definition',regexp_replace(pg_get_constraintdef(oid),'[[:space:]()]','','g'),'validated',convalidated) ORDER BY conname),'[]'::json) FROM pg_constraint WHERE conrelid='support_conversation'::regclass AND contype='c' AND conname IN ('support_conversation_human_request_anchor_sequence_check','support_conversation_human_request_context_version_check','support_conversation_human_request_generation_check')),'replyIndex',(SELECT json_build_object('definition',regexp_replace(pg_get_indexdef(i.indexrelid),'[[:space:]()]','','g'),'valid',i.indisvalid,'ready',i.indisready,'unique',i.indisunique,'owner',pg_get_userbyid(c.relowner)) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace='public'::regnamespace AND c.relname='support_message_reply_target'),'replyForeignKeys',(SELECT count(*) FROM pg_constraint c WHERE c.conrelid='support_message'::regclass AND c.contype='f' AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attname='reply_to_message_id' AND a.attnum=ANY(c.conkey))))")
    need(objects == {'metadataGuard': expected, 'constraints': COLLABORATION_CONSTRAINTS if expected else [],
                     'replyIndex': REPLY_INDEX if expected else None, 'replyForeignKeys': 0},
         'SUPPORT_COLLAB_SCHEMA104_OBJECTS_REQUIRED')


def journal(plan, allowed, drain=False):
    value = C.database_guard(plan['profile'], plan['config'], plan['ownership'], allowed, drain)
    S.schema101(plan['profile'])
    B.schema103(plan['profile'])
    schema104(plan['profile'], len(value) == 104)
    return value


def business_fence(profile):
    # Only the exact new104 keys are omitted. Every preexisting public row and
    # field, including status, handler, old messages and unread facts, stays exact.
    names = D.query(profile, "SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]'::json) FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migration'")
    need(isinstance(names, list) and names and all(re.fullmatch(r'[a-z][a-z0-9_]*', name) for name in names), 'SUPPORT_COLLAB_BUSINESS_TABLE_SET_REQUIRED')
    parts = []
    for name in names:
        projection = 'to_jsonb(t)'
        if name == 'support_conversation':
            projection += "-ARRAY['human_request_generation','human_request_anchor_sequence','human_request_context_version']"
        elif name == 'support_message':
            projection += "-'reply_to_message_id'"
        parts.append("SELECT '" + name + "'::text AS name,jsonb_build_object('count',count(*),'sha256',encode(digest(coalesce(jsonb_agg(" + projection + " ORDER BY (" + projection + ")::text)::text,'[]'),'sha256'),'hex')) AS fact FROM " + name + " t")
    return D.query(profile, 'SELECT jsonb_object_agg(name,fact ORDER BY name) FROM (' + ' UNION ALL '.join(parts) + ') snapshot')


def neutral_initial_fields(profile):
    # Only called while writers remain stopped, immediately after sole104 up.
    value = D.query(profile, "SELECT json_build_object('conversationFieldsNeutral',NOT EXISTS(SELECT 1 FROM support_conversation WHERE human_request_generation IS DISTINCT FROM 0 OR human_request_anchor_sequence IS NOT NULL OR human_request_context_version IS DISTINCT FROM 0),'replyLinksNeutral',NOT EXISTS(SELECT 1 FROM support_message WHERE reply_to_message_id IS NOT NULL))")
    need(value == {'conversationFieldsNeutral': True, 'replyLinksNeutral': True},
         'SUPPORT_COLLAB_EXISTING_ROWS_NOT_NEUTRAL')


def public_contract(plan):
    # Reuse 83a's reviewed GET-only public article200 / guest comments401
    # contract without creating a session, conversation, presence or message.
    P.public_contract(plan)

def preflight(b):
    current, old_binding = load_baseline(True)
    profile, config = current['profile'], current['config']
    C.fixed_profile(profile)
    need(optional_active() is None, 'SUPPORT_COLLAB_EXISTING_UPDATE_REFUSED')
    need(config.get('APP_ENV') == 'staging' and config.get('WECHAT_APP_ID') == C.APP_ID and D.closed_context(profile, config)
         and config.get('WECHAT_PHONE_BINDING_ENABLED', 'false') == 'false'
         and config.get('COS_DIRECT_UPLOAD_ENABLED', 'false') == 'false'
         and config.get('SUPPORT_AI_ENABLED') == 'true' and config.get('DEEPSEEK_MODEL') == 'deepseek-flash'
         and config.get('SUPPORT_AI_TIMEOUT_MS') == '4000' and config.get('DEEPSEEK_API_KEY'),
         'SUPPORT_COLLAB_CURRENT_TRIAL_AND_AI_CONTEXT_REQUIRED')
    old = D.artifact(str(current['release']), ROOT)
    candidate = D.artifact(str(ROOT / 'releases' / ('tencent-release-' + b['sourceHead'][:12])), ROOT)
    artifact_contract(old, candidate, b)
    archive = read(Path(b['archivePath']), 512 * 1024 ** 2)
    need(len(archive) == b['archiveBytes'] and sha(archive) == b['archiveSha256'], 'SUPPORT_COLLAB_ARCHIVE_HASH_MISMATCH')
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
    need(versions == D.native_smoke(profile, old['directory'], True), 'SUPPORT_COLLAB_NATIVE_RUNTIME_CHANGED')
    plan = {'profile': profile, 'config': config, 'env': D.read_owned(ROOT / 'runtime.env', private=True),
        'environmentMetadata': D.environment_metadata(profile), 'privateInputs': D.private_inputs(profile, config),
        'old': old, 'candidate': candidate, 'units': units, 'dropIns': dropins, 'unitDefinitions': definitions,
        'ownership': ownership, 'initialRecords': {name: history[str(ROOT / name)] for name in HISTORY_ROOT[-3:]},
        'history': history, 'protectedBaselineInputs': protected, 'production': production, 'binding': b, 'versions': versions}
    verify_context(plan)
    journal(plan, [old['manifest']['migrations']])
    return plan


def save_plan(plan, state):
    saved = dict(plan)
    for name in ('old', 'candidate'):
        saved[name] = {key: value for key, value in plan[name].items() if key != 'files'}
    raw = (json.dumps(C.encode_private(saved), sort_keys=True) + '\n').encode()
    need(len(raw) <= 8 * 1024 ** 2, 'SUPPORT_COLLAB_PRIVATE_PLAN_TOO_LARGE')
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
    return (json.dumps({'schemaVersion': 1, 'kind': 'trial-support-ai-human-collaboration-active-release',
        'environment': 'trial', 'instanceId': 'lhins-61ikz4mi', 'database': 'cisme_trial',
        'sourceHead': selected['manifest']['sourceHead'], 'sourceTree': selected['manifest']['sourceTree'],
        'directory': selected['directory'], 'manifestSha256': selected['manifestSha256'],
        'dependenciesSha256': DEPENDENCIES, 'migrationCount': 104, 'baselineHead': BASELINE_HEAD,
        'ownershipId': plan['ownership']['ownershipId'], 'upgradeState': str(state), 'privatePlanSha256': plan_sha,
        'schemaChanged': True, 'configurationChanged': False, 'databaseRestored': False,
        'applicationRollbackAllowed': False, 'applicationRollbackExecuted': False,
        'commentLoginEnforced': True, 'guestCommentReadExposureRestored': False,
        'humanHandoffPolicy': 'user-request-only',
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
        backup = S.snapshot(plan, state, approval)
        S.validate_snapshot(backup, state, approval)
        # The pinned authenticated encryption primitive retains its historical
        # AAD label; bind the actual current83a snapshot separately and exactly.
        D.general.store(state / 'snapshot-current-release.json', (json.dumps({
            'snapshotReceiptSha256': sha(read(state / 'predeploy-database' / 'snapshot-private.json')),
            'actualBaselineHead': BASELINE_HEAD, 'actualBaselineTree': BASELINE_TREE,
            'actualBaselineManifestSha256': plan['old']['manifestSha256'], 'actualMigrationCount': 103,
            'candidateHead': plan['binding']['sourceHead'], 'candidateTree': plan['binding']['sourceTree'],
            'backupReference': backup['backupReference'], 'cryptoAadBaselineLabel': S.BASELINE_HEAD,
            'aadClaimsCurrentBaseline': False}, sort_keys=True) + '\n').encode())
        verify_context(plan)
        journal(plan, [plan['old']['manifest']['migrations']], True)
        D.command(['/usr/sbin/runuser', '-u', 'cisme-trial', '--', NODE,
            str(Path(plan['candidate']['directory']) / 'migrate.mjs'), 'up'],
            env={**CLEAN, **plan['config'], 'CISME_MIGRATION_APPROVAL_REF': approval,
                 'CISME_PREDEPLOY_BACKUP_REF': backup['backupReference']}, cwd=ROOT, timeout=180)
        journal(plan, [plan['candidate']['manifest']['migrations']], True)
        neutral_initial_fields(plan['profile'])
        need(business_fence(plan['profile']) == plan['businessFence'], 'SUPPORT_COLLAB_EXISTING_BUSINESS_FACTS_CHANGED')
        verify_context(plan)
        D.switch(plan, plan['candidate']['directory'])
        D.verify_units(plan, allow_candidate=True)
        verify_history(plan)
        started = time.time()
        D.command(['systemctl', 'start', *plan['profile']['units']], timeout=60)
        versions = D.healthy(plan, plan['candidate']['directory'], started, True)
        public_contract(plan)
        verify_context(plan, candidate_allowed=True)
        journal(plan, [plan['candidate']['manifest']['migrations']])
        published = active_record(plan, state, plan_sha)
        D.atomic_bytes(ACTIVE, published)
        verify_context(plan, candidate_allowed=True, allowed=(published,))
        journal(plan, [plan['candidate']['manifest']['migrations']])
        report = {'deployed': True, 'environment': 'trial', 'sourceHead': plan['binding']['sourceHead'],
            'migrationCountBefore': 103, 'migrationCountAfter': 104, 'schemaChanged': True,
            'snapshotAuthenticated': True, 'snapshotScope': 'same-host-database-only', 'fullRecoveryQualified': False,
            'existingBusinessFactsPreservedDuringMigration': True, 'newCollaborationFieldsInitiallyNeutral': True, 'liveChatProbePerformed': False,
            'configurationChanged': False, 'credentialsChanged': False, 'authorityGranted': False,
            'businessDataSeeded': False, 'databaseRestored': False, 'databaseSnapshotCreated': True,
            'applicationRollbackExecuted': False, 'previousActiveHistoryPreserved': True, 'productionChanged': False,
            'versions': versions}
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
                'previousApplicationRollbackForbidden': True}) + '\n').encode())
        except Exception:
            pass
        raise Refused('SUPPORT_COLLAB_FAILED_FENCED_FORWARD_REVIEW_REQUIRED') from None


def active_context(b):
    validate_binding(b)
    load_baseline(False)
    target()
    raw = read(ACTIVE, 65536)
    active = parse(raw)
    state = Path(active.get('upgradeState', ''))
    need(state.parent == STATE_PARENT and re.fullmatch(r'commit-' + b['sourceHead'][:12] + r'-[0-9]+', state.name),
         'SUPPORT_COLLAB_ACTIVE_STATE_PATH_REQUIRED')
    saved = read(state / 'protected-plan.json', 8 * 1024 ** 2)
    need(sha(saved) == active.get('privatePlanSha256'), 'SUPPORT_COLLAB_ACTIVE_PRIVATE_PLAN_DRIFT')
    plan = C.decode_private(parse(saved))
    need(plan.get('binding') == b, 'SUPPORT_COLLAB_ACTIVE_BINDING_DRIFT')
    for label in ('old', 'candidate'):
        plan[label] = D.artifact(plan[label]['directory'], ROOT)
    artifact_contract(plan['old'], plan['candidate'], b)
    selected = plan['candidate']
    need(raw == active_record(plan, state, sha(saved)), 'SUPPORT_COLLAB_ACTIVE_RECORD_DRIFT')
    verify_context(plan, candidate_allowed=True, allowed=(raw,), exact_pids=False)
    for unit, entry in zip(plan['profile']['units'], ('index.js', 'worker.js')):
        need(D.unit_entry(D.read_owned(D.unit_path(unit)), entry, plan['profile']) == Path(selected['directory']),
             'SUPPORT_COLLAB_ACTIVE_UNIT_PATH_REQUIRED')
    D.running(plan['profile'], selected['directory'], plan['config'])
    journal(plan, [selected['manifest']['migrations']])
    public_contract(plan)
    return {'profile': plan['profile'], 'config': plan['config'], 'release': Path(selected['directory']),
            'sourceHead': selected['manifest']['sourceHead'], 'commentLoginEnforced': True}


def apply(b, approval):
    need(re.fullmatch(r'[-P-Za-z0-9_:.]{8,120}', approval or ''), 'SUPPORT_COLLAB_OPERATION_REFERENCE_REQUIRED')
    target()
    lock = Path('/run/lock/cisme-production-trial.lock')
    parent = lock.parent.lstat()
    need(stat.S_ISDIR(parent.st_mode) and parent.st_uid == OWNER and stat.S_IMODE(parent.st_mode) == 0o1777,
         'SUPPORT_COLLAB_LOCK_PARENT_REQUIRED')
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
             'SUPPORT_COLLAB_LOCK_REQUIRED')
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
    return value if re.fullmatch(r'SUPPORT_COLLAB_[A-Z0-9_]{1,110}', value) else 'SUPPORT_COLLAB_REVIEW_REQUIRED'


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
                'migrationCount': 104, 'commentLoginEnforced': value['commentLoginEnforced']}
        else:
            plan = preflight(b)
            result = {'readOnly': True, 'deployed': False, 'sourceHead': plan['binding']['sourceHead'],
                'migrationCountBefore': 103, 'migrationCountAfter': 104, 'schemaChanged': True,
                'configurationChanged': False, 'productionPreserved': True, 'databaseSnapshotRequired': True}
        print(json.dumps({**result, 'privateValuesExported': False}, sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({'ok': False, 'code': safe_error_code(error), 'privateValuesExported': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
