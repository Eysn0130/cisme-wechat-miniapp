#!/usr/bin/env python3
"""Prepare the real WeChat encrypted callback on the isolated trial runtime.

Default preflight is read-only. Apply preserves all106 SQL files, dependencies,
existing private inputs, production and business facts. It switches only the two
trial applications and adds three callback settings. Public UGC and money flags
are not changed. Platform registration remains the owner's separate operation.
"""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import time
import types

ROOT = Path('/opt/cisme-trial')
BASELINE_HEAD = '97acb0028aad7b9c832c01b80ad3d4e7da1ffdac'
BASELINE_TREE = '80a104e50377af2ddc57a133d5e346fc9f1de996'
BASELINE_MANIFEST = 'c03064904c11ef42b11abc724f53c9d2d5acdc2ae1941af26a9ceaa2ed44ecb5'
BASELINE_RUNNER = ROOT / 'community-direct-publication-runners' / BASELINE_HEAD[:12]
BASELINE_HELPER_SHA = '049e0e9d3d978f92ca94605288fa451323dc8a502a66b78778e6b6a83538a385'
BASELINE_BINDING_SHA = '245a85106e3bf0de481cd92ec36ae83e26acda1c5149c159603a71760b284e04'
RUNNERS = ROOT / 'message-callback-runners'
STATES = ROOT / 'message-callback-updates'
ACTIVE = STATES / 'active-release.json'
SOURCE = 'infra/tencent/trial-message-callback-update.py'
SCAN_ORIGIN = 'https://staging-api.cisme.cn'
CALLBACK_URL = SCAN_ORIGIN + '/v1/ugc/safety-callback'
KEYS = ('WECHAT_MESSAGE_TOKEN', 'WECHAT_MESSAGE_AES_KEY', 'UGC_SCAN_BASE_URL')
H = C = D = None


class Refused(RuntimeError):
    pass


def need(value, code):
    if not value:
        raise Refused('CALLBACK_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def protected(path, limit=8 * 1024 ** 2):
    need(path.is_absolute() and '..' not in path.parts, 'ABSOLUTE_PATH_REQUIRED')
    for parent in reversed(path.parents):
        s = parent.lstat()
        need(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o022, 'PROTECTED_PARENT_REQUIRED')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_nlink == 1
             and stat.S_IMODE(s.st_mode) == 0o600 and 0 < s.st_size <= limit, 'PROTECTED_FILE_REQUIRED')
        with os.fdopen(fd, 'rb', closefd=False) as f:
            raw = f.read(limit + 1)
        end = os.fstat(fd)
        need(len(raw) == s.st_size and (s.st_size, s.st_mtime_ns, s.st_ctime_ns) ==
             (end.st_size, end.st_mtime_ns, end.st_ctime_ns), 'PROTECTED_FILE_CHANGED')
        return raw
    finally:
        os.close(fd)


def load_baseline(active):
    global H, C, D
    need(os.geteuid() == 0, 'ROOT_REQUIRED')
    path = BASELINE_RUNNER / 'trial-community-direct-publication-update.py'
    raw = protected(path, 128 * 1024)
    need(sha(raw) == BASELINE_HELPER_SHA, 'BASELINE_HELPER_DRIFT')
    H = types.ModuleType('pinned_callback_baseline'); H.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), H.__dict__)
    b = H.binding(BASELINE_RUNNER / 'application-binding.json', BASELINE_BINDING_SHA)
    context = H.active_context(b) if active else None
    if not active:
        H.load_baseline(False)
    C, D = H.C, H.D
    H.target()
    return context, b


def callback_config(config, env, token, aes_key):
    need(not any(config.get(k) for k in KEYS), 'EXISTING_CALLBACK_CONFIG_REQUIRES_REVIEW')
    need(re.fullmatch(r'[A-Za-z0-9]{3,32}', token or '') and
         re.fullmatch(r'[A-Za-z0-9+/]{43}', aes_key or ''), 'GENERATED_KEY_FORMAT_REQUIRED')
    values = {KEYS[0]: token, KEYS[1]: aes_key, KEYS[2]: SCAN_ORIGIN}
    expected = {**config, **values}
    updated = env.rstrip(b'\n') + b'\n' + ''.join(k + '=' + values[k] + '\n' for k in KEYS).encode()
    need(D.general.observe.audit.environment(updated.decode()) == expected, 'EXACT_CALLBACK_DELTA_REQUIRED')
    return expected, updated


def artifact_contract(old, candidate, b):
    before, after = old['manifest'], candidate['manifest']
    need(before['sourceHead'] == BASELINE_HEAD and before['sourceTree'] == BASELINE_TREE
         and old['manifestSha256'] == BASELINE_MANIFEST, 'EXACT_BASELINE_REQUIRED')
    need(after['sourceHead'] == b['sourceHead'] and after['sourceTree'] == b['sourceTree']
         and candidate['manifestSha256'] == b['manifestSha256'] and after.get('configurationIncluded') is False
         and after.get('buildPlatform') == {'os': 'linux', 'arch': 'x64', 'libc': 'glibc'}, 'EXACT_CANDIDATE_REQUIRED')
    sql = before['migrations']
    need(len(sql) == 106 and after['migrations'] == sql and set(b['migrationSha256']) == set(sql), 'SCHEMA_CHANGE_REFUSED')
    immutable = ['migrate.mjs', 'package.json', 'package-lock.json'] + ['db/migrations/' + name for name in sql]
    need(all(old['files'][name] == candidate['files'][name] for name in immutable), 'SQL_PACKAGE_OR_MIGRATOR_DRIFT')
    need(all(sha(candidate['files']['db/migrations/' + name]) == b['migrationSha256'][name] for name in sql), 'SQL_BINDING_DRIFT')
    need(old['dependenciesSha256'] == candidate['dependenciesSha256'] == H.DEPENDENCIES, 'DEPENDENCY_DRIFT')


def binding(path, expected):
    raw = protected(path, 128 * 1024)
    need(sha(raw) == expected, 'BINDING_HASH_REQUIRED')
    b = json.loads(raw)
    need(b.get('kind') == 'trial-message-callback-update' and b.get('baselineHead') == BASELINE_HEAD,
         'BINDING_KIND_REQUIRED')
    need(all(isinstance(b.get(k), str) and re.fullmatch(r'[0-9a-f]{40}', b[k]) for k in ('sourceHead', 'sourceTree'))
         and b['sourceHead'] != BASELINE_HEAD, 'COMMITTED_SOURCE_REQUIRED')
    need(Path(__file__) == RUNNERS / b['sourceHead'][:12] / Path(SOURCE).name, 'PINNED_RUNNER_REQUIRED')
    archive = Path(b.get('archivePath', ''))
    need(archive.is_relative_to('/var/lib/cisme-dependency-stage') and archive.name == 'archive.tar.gz', 'STAGED_ARCHIVE_REQUIRED')
    need(type(b.get('archiveBytes')) is int and 0 < b['archiveBytes'] <= 512 * 1024 ** 2, 'ARCHIVE_SIZE_REQUIRED')
    return b


def source_permit(b, candidate):
    H.source_permit(b, candidate)
    tree = H.parse(H.response('https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/git/trees/'
        + b['sourceTree'] + '?recursive=1', 4 * 1024 ** 2))
    need(tree.get('truncated') is False and tree.get('sha') == b['sourceTree'], 'COMPLETE_SOURCE_REQUIRED')
    entry = [r for r in tree.get('tree', []) if r.get('path') == SOURCE]
    need(len(entry) == 1 and entry[0].get('type') == 'blob'
         and entry[0].get('sha') == H.git_blob(protected(Path(__file__), 128 * 1024)), 'COMMITTED_HELPER_REQUIRED')
    archive = protected(Path(b['archivePath']), 512 * 1024 ** 2)
    need(len(archive) == b['archiveBytes'] and sha(archive) == b['archiveSha256'], 'ARCHIVE_DRIFT')


def original_plan():
    raw = H.read(H.ACTIVE, 65536); active = H.parse(raw)
    state = Path(active['upgradeState']); saved = H.read(state / 'protected-plan.json', 8 * 1024 ** 2)
    need(sha(saved) == active['privatePlanSha256'], 'BASELINE_PLAN_DRIFT')
    return C.decode_private(H.parse(saved)), raw, state, saved


def preflight(b):
    context, old_binding = load_baseline(True)
    need(not ACTIVE.exists(), 'EXISTING_UPDATE_REQUIRES_REVIEW')
    old, active_raw, old_state, saved = original_plan()
    need(old['binding'] == old_binding, 'BASELINE_BINDING_DRIFT')
    profile, config = context['profile'], context['config']
    need(config['APP_ENV'] == 'staging' and D.closed_context(profile, config)
         and not any(config.get(k) for k in KEYS), 'CLOSED_UNCONFIGURED_TRIAL_REQUIRED')
    candidate = D.artifact(str(ROOT / 'releases' / ('tencent-release-' + b['sourceHead'][:12])), ROOT)
    baseline = D.artifact(str(context['release']), ROOT)
    artifact_contract(baseline, candidate, b); source_permit(b, candidate)
    units = {u: D.read_owned(D.unit_path(u)) for u in profile['units']}
    dropins = {u: D.dropin_inputs(u) for u in profile['units']}
    inputs = dict(old['protectedBaselineInputs'])
    for path in (BASELINE_RUNNER / 'trial-community-direct-publication-update.py',
                 BASELINE_RUNNER / 'application-binding.json', old_state / 'protected-plan.json'):
        inputs[str(path)] = {'sha256': sha(protected(path)), 'limit': 8 * 1024 ** 2}
    plan = {**old, 'old': baseline, 'candidate': candidate, 'binding': b,
        'units': units, 'dropIns': dropins,
        'unitDefinitions': {u: D.unit_definition(u, units[u], e, profile, dropins[u])
            for u, e in zip(profile['units'], ('index.js', 'worker.js'))},
        'history': {**old['history'], str(H.ACTIVE): active_raw}, 'protectedBaselineInputs': inputs,
        'production': C.production_capture(), 'versions': D.native_smoke(profile, candidate['directory'], True)}
    need(plan['versions'] == D.native_smoke(profile, baseline['directory'], True), 'NATIVE_RUNTIME_DRIFT')
    verify(plan); H.journal(plan, [baseline['manifest']['migrations']])
    return plan


def effective(plan, prepared):
    if not prepared:
        return plan
    return {**plan, 'config': plan['callbackConfig'], 'env': plan['callbackEnv']}


def verify(plan, prepared=False, switched=False, active_raw=None, exact_pids=True):
    H.target(); C.fixed_profile(plan['profile'])
    current = effective(plan, prepared)
    D.verify_context(current, provenance=False, allow_candidate=switched)
    need(D.closed_context(plan['profile'], current['config']), 'BUSINESS_FLAGS_CHANGED')
    if prepared:
        need({k: v for k, v in current['config'].items() if k not in KEYS} == plan['config']
             and current['config'].get(KEYS[2]) == SCAN_ORIGIN, 'UNRELATED_CONFIG_CHANGED')
    need(all(H.read(Path(path), 65536) == raw for path, raw in plan['history'].items()), 'HISTORY_DRIFT')
    need(all(sha(protected(Path(path), item['limit'])) == item['sha256']
             for path, item in plan['protectedBaselineInputs'].items()), 'PRIVATE_INPUT_DRIFT')
    need((protected(ACTIVE, 65536) if ACTIVE.exists() else None) == active_raw, 'ACTIVE_RECORD_DRIFT')
    C.production_preserved(plan['production'], exact_pids)
    C.six_keys(current['config'], plan['production']['config'])
    artifact_contract(D.artifact(plan['old']['directory'], ROOT), D.artifact(plan['candidate']['directory'], ROOT), plan['binding'])


def facts(profile):
    tables = D.query(profile, "SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]'::json) FROM pg_tables WHERE schemaname='public'")
    need(isinstance(tables, list) and tables and all(re.fullmatch('[a-z][a-z0-9_]*', t) for t in tables), 'TABLE_SET_REQUIRED')
    sql = ["SELECT '" + t + "' name,jsonb_build_object('count',count(*),'sha256',encode(digest(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]'),'sha256'),'hex')) fact FROM " + t + ' t' for t in tables]
    return D.query(profile, 'SELECT jsonb_object_agg(name,fact ORDER BY name) FROM (' + ' UNION ALL '.join(sql) + ') s')


def callback_document(config):
    return ('# 微信小程序消息推送配置（私有）\n\n此文件含回调密钥，请只在本人微信公众平台填写，不发到聊天或提交仓库。\n\n'
        + '服务器地址（URL）：' + CALLBACK_URL + '\n\n令牌（Token）：' + config[KEYS[0]]
        + '\n\n消息加密密钥（EncodingAESKey）：' + config[KEYS[1]]
        + '\n\n消息加解密方式：安全模式\n\n数据格式：JSON\n\n不要点击随机生成或修改以上密钥。保存并启用后，请在聊天回复“已保存并启用”；不要复制密钥。\n'
        + '\n范围：仅准备内容安全回调。公开发帖仍须以真实联调与服务端启用读回为准。\n').encode()


def apply(b, approval):
    need(re.fullmatch(r'[-A-Za-z0-9_:.]{8,120}', approval or ''), 'OPERATION_REFERENCE_REQUIRED')
    fd = os.open('/run/lock/cisme-production-trial.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        s = os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and stat.S_IMODE(s.st_mode) == 0o600 and s.st_nlink == 1, 'LOCK_REQUIRED')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan = preflight(b)
        STATES.mkdir(mode=0o700, exist_ok=True); D.owned_directory(STATES, True)
        marker = STATES / ('update-' + b['sourceHead'][:12] + '.started.json')
        D.general.store(marker, (json.dumps({'sourceHead': b['sourceHead'], 'operationReference': approval}) + '\n').encode())
        state = STATES / ('commit-' + b['sourceHead'][:12] + '-' + str(time.time_ns())); state.mkdir(mode=0o700)
        plan['callbackConfig'], plan['callbackEnv'] = callback_config(plan['config'], plan['env'],
            secrets.token_hex(16), base64.b64encode(secrets.token_bytes(32)).decode().rstrip('='))
        H.backup_inputs(plan, state)
        stopped = False
        try:
            verify(plan); source_permit(b, plan['candidate'])
            stopped = True; D.command(['systemctl', 'stop', *plan['profile']['units']], timeout=90); D.stopped(plan['profile'])
            verify(plan); H.journal(plan, [plan['old']['manifest']['migrations']], True)
            fence = facts(plan['profile'])
            backup = H.S.snapshot(plan, state, approval); H.S.validate_snapshot(backup, state, approval)
            plan.update(operationReference=approval, drainedFacts=fence, snapshotReceiptSha256=sha(protected(state / 'predeploy-database/snapshot-private.json')))
            saved = {**plan, 'old': {k:v for k,v in plan['old'].items() if k != 'files'},
                'candidate': {k:v for k,v in plan['candidate'].items() if k != 'files'}}
            saved_raw = (json.dumps(C.encode_private(saved), sort_keys=True) + '\n').encode()
            D.general.store(state / 'protected-plan.json', saved_raw)
            verify(plan); need(facts(plan['profile']) == fence, 'STOPPED_FACTS_CHANGED')
            env_path = ROOT / 'runtime.env'; metadata = plan['environmentMetadata']
            temporary = env_path.with_name('.callback-runtime-' + str(time.time_ns()))
            D.general.store(temporary, plan['callbackEnv'], 0o600)
            os.chown(temporary, metadata['uid'], metadata['gid']); os.chmod(temporary, metadata['mode'])
            os.replace(temporary, env_path)
            current = effective(plan, True)
            D.switch(current, plan['candidate']['directory']); verify(plan, True, True)
            H.journal(current, [plan['old']['manifest']['migrations']], True)
            need(facts(plan['profile']) == fence, 'APPLICATION_FACTS_CHANGED')
            started = time.time(); D.command(['systemctl', 'start', *plan['profile']['units']], timeout=60)
            D.healthy(current, plan['candidate']['directory'], started, True); H.public_contract(current)
            verify(plan, True, True)
            D.general.store(state / 'configuration.private.md', callback_document(plan['callbackConfig']))
            report = {'sourceHead': b['sourceHead'], 'sourceTree': b['sourceTree'], 'upgradeState': str(state),
                'privatePlanSha256': sha(saved_raw), 'environment': 'trial', 'migrationCount': 106,
                'callbackPrepared': True, 'changedConfigKeys': list(KEYS), 'publicUgcEnabled': False,
                'productionChanged': False, 'schemaChanged': False, 'databaseRestored': False,
                'drainedAll106FactsPreserved': True, 'platformRegistered': False, 'privateValuesExported': False,
                'ciRunId': b['ciRunId'], 'ciVerifyJobId': b['ciVerifyJobId']}
            active_raw = (json.dumps(report, sort_keys=True) + '\n').encode()
            D.atomic_bytes(ACTIVE, active_raw); verify(plan, True, True, active_raw)
            D.general.store(state / 'deployed.json', active_raw)
            return report
        except Exception:
            if stopped:
                D.command(['systemctl', 'stop', *plan['profile']['units']], timeout=90)
                D.general.store(state / 'forward-recovery-required.json', b'{"forwardRecoveryRequired":true,"databaseRestored":false}\n')
            raise
    finally:
        os.close(fd)


def active(b):
    load_baseline(False)
    raw = protected(ACTIVE, 65536); record = json.loads(raw); state = Path(record['upgradeState'])
    need(state.parent == STATES and re.fullmatch('commit-' + b['sourceHead'][:12] + '-[0-9]+', state.name), 'ACTIVE_STATE_REQUIRED')
    saved = protected(state / 'protected-plan.json'); need(sha(saved) == record['privatePlanSha256'], 'ACTIVE_PLAN_DRIFT')
    plan = C.decode_private(json.loads(saved)); need(plan['binding'] == b, 'ACTIVE_BINDING_DRIFT')
    for name in ('old', 'candidate'):
        plan[name] = D.artifact(plan[name]['directory'], ROOT)
    H.S.validate_snapshot(json.loads(protected(state / 'predeploy-database/snapshot-private.json')), state, plan['operationReference'])
    need(sha(protected(state / 'predeploy-database/snapshot-private.json')) == plan['snapshotReceiptSha256'], 'SNAPSHOT_BINDING_DRIFT')
    verify(plan, True, True, raw, False)
    D.running(plan['profile'], plan['candidate']['directory'], plan['callbackConfig'])
    H.journal(effective(plan, True), [plan['old']['manifest']['migrations']]); H.public_contract(effective(plan, True))
    return {**record, 'readOnly': True, 'activeVerified': True}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=('preflight', 'apply', 'active'), default='preflight', nargs='?')
    p.add_argument('--binding', type=Path, required=True); p.add_argument('--binding-sha256', required=True)
    p.add_argument('--operation-reference'); args = p.parse_args()
    try:
        b = binding(args.binding, args.binding_sha256)
        result = apply(b, args.operation_reference) if args.action == 'apply' else active(b) if args.action == 'active' else (
            {'readOnly': True, 'callbackPrepared': False, 'sourceHead': preflight(b)['binding']['sourceHead']})
        print(json.dumps({**result, 'privateValuesExported': False}, sort_keys=True)); return 0
    except Exception as error:
        code = str(error) if isinstance(error, Refused) else 'CALLBACK_REVIEW_REQUIRED'
        print(json.dumps({'ok': False, 'code': code, 'privateValuesExported': False})); return 1


if __name__ == '__main__':
    raise SystemExit(main())
