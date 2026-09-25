#!/usr/bin/env python3
"""Restore rehearsal confined to databases and local objects owned by this run.

No cleanup/down migration, production access, payment or WeChat outbound calls.
Backups remain root-only on staging. Evidence contains counts and hashes only.
"""
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path('/opt/cisme')
SOURCE = '2df301818c550ae6d19649d44f785d02fb58b276'


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def command(args, data=None):
    completed = subprocess.run(args, input=data, capture_output=True, timeout=120)
    require(completed.returncode == 0, 'BOUNDED_COMMAND_FAILED')
    return completed.stdout


def sql(database, query):
    require(re.fullmatch(r'cisme_accept_rc20260922_[a-f0-9]{8}(_restore)?', database), 'OWNED_DATABASE_REQUIRED')
    return command(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At',
                    '-d', database, '-c', query]).decode().strip()


def status(path):
    try:
        with urllib.request.urlopen('https://staging-api.cisme.cn' + path, timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (OSError, urllib.error.URLError):
        return 0


def main(run_id):
    require(os.geteuid() == 0 and socket.gethostname() == 'VM-4-15-ubuntu', 'STAGING_ROOT_REQUIRED')
    require(re.fullmatch(r'rc20260922-[a-f0-9]{8}', run_id), 'RUN_ID_INVALID')
    state = ROOT / 'staging-acceptance' / run_id
    ownership = json.loads((state / 'ownership.json').read_text())
    activated = json.loads((state / 'activated.json').read_text())
    require(ownership['runId'] == run_id and ownership['instanceId'] == 'lhins-ei4hz4fi'
            and activated['sourceHead'] == SOURCE and activated['activated'], 'ACTIVATED_OWNERSHIP_REQUIRED')
    require(str((ROOT / 'current').resolve()) == ownership['directory'], 'CURRENT_RELEASE_DRIFT')
    require(hashlib.sha256(pathlib.Path('/etc/cisme/runtime.env').read_bytes()).hexdigest()
            == activated['candidateEnvSha256'], 'CURRENT_ENV_DRIFT')
    database = 'cisme_accept_' + run_id.replace('-', '_')
    require(database == ownership['database'], 'OWNED_DATABASE_REQUIRED')
    restore = database + '_restore'
    require(not (state / 'acceptance-started.json').exists(), 'REHEARSAL_ALREADY_STARTED')
    os.umask(0o077)
    (state / 'acceptance-started.json').write_text(json.dumps({'database': database, 'restoreDatabase': restore,
        'sourceHead': SOURCE, 'runId': run_id, 'syntheticOnly': True}))
    # Marker is a separate schema in this run's fresh DB. No existing app rows change.
    sql(database, "CREATE SCHEMA acceptance_probe; CREATE TABLE acceptance_probe.marker(id text PRIMARY KEY, value text NOT NULL); "
                  "INSERT INTO acceptance_probe.marker VALUES('synthetic-restore','CISME staging acceptance');")
    backup = command(['runuser', '-u', 'postgres', '--', 'pg_dump', '--format=custom', '--no-owner', '--no-acl', '-d', database])
    (state / 'isolated-backup.dump').write_bytes(backup)
    command(['runuser', '-u', 'postgres', '--', 'createdb', '--owner=cisme_staging', restore])
    command(['runuser', '-u', 'postgres', '--', 'pg_restore', '--exit-on-error', '--no-owner', '--no-acl', '-d', restore], backup)
    checks = {
        'migrations': 'SELECT count(*) FROM schema_migration',
        'tables': "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
        'members': 'SELECT count(*) FROM member',
        'privacyRequests': 'SELECT count(*) FROM privacy_request',
        'privacyEvents': 'SELECT count(*) FROM privacy_request_event',
        'auditEvents': 'SELECT count(*) FROM audit_log',
        'revokedGrants': 'SELECT count(*) FROM authority_grant WHERE revoked_at IS NOT NULL',
        'legalDocuments': 'SELECT count(*) FROM legal_document WHERE active=true',
        'marker': "SELECT count(*) FROM acceptance_probe.marker WHERE id='synthetic-restore' AND value='CISME staging acceptance'"
    }
    counts = {name: {'source': int(sql(database, query)), 'restored': int(sql(restore, query))} for name, query in checks.items()}
    require(all(row['source'] == row['restored'] for row in counts.values())
            and counts['migrations']['restored'] == 75 and counts['marker']['restored'] == 1, 'RESTORE_COUNTS_MISMATCH')
    business_sql="SELECT md5(jsonb_build_object('members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM member m),'privacy',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM privacy_request p),'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM privacy_request_event e),'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM authority_grant g))::text)"
    business_digest={'source': sql(database,business_sql), 'restored': sql(restore,business_sql)}
    require(business_digest['source']==business_digest['restored'], 'BUSINESS_RESTORE_MISMATCH')
    require(counts['members']['source']==2 and counts['privacyRequests']['source']==1 and counts['revokedGrants']['source']==1,'SYNTHETIC_BUSINESS_FACTS_REQUIRED')
    # Local api_gateway storage: isolated marker, own backup and independent restore file.
    # This is local-volume evidence, deliberately not an S3/COS compatibility claim.
    objects = pathlib.Path(ownership['objects'])
    require(objects == ROOT / 'tmp' / run_id, 'OWNED_OBJECT_ROOT_REQUIRED')
    marker = objects / 'acceptance-synthetic-object.bin'
    with marker.open('xb') as stream:
        stream.write(b'CISME synthetic staging object restore probe\n')
    object_backup = state / 'isolated-object-backup.bin'
    object_restore = state / 'isolated-object-restored.bin'
    object_backup.write_bytes(marker.read_bytes())
    object_restore.write_bytes(object_backup.read_bytes())
    object_hash = hashlib.sha256(marker.read_bytes()).hexdigest()
    require(hashlib.sha256(object_restore.read_bytes()).hexdigest() == object_hash, 'OBJECT_RESTORE_MISMATCH')
    expected = {'/health/ready': 200, '/v1/legal': 200, '/v1/capabilities': 200,
                '/v1/admin/runtime-metrics': 401, '/v1/me': 401}
    observed = {path: status(path) for path in expected}
    require(observed == expected, 'PUBLIC_REGRESSION_FAILED')
    samples = []
    for index in range(61):
        units = command(['systemctl', 'show', 'cisme-staging-api', 'cisme-staging-worker',
                         '-p', 'ActiveState', '-p', 'SubState', '-p', 'NRestarts']).decode().splitlines()
        sample = {'timeUtc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                  'health': status('/health/ready'), 'units': units}
        samples.append(sample)
        require(sample['health'] == 200 and units.count('ActiveState=active') == 2
                and units.count('SubState=running') == 2 and units.count('NRestarts=0') == 2, 'STABILITY_SAMPLE_FAILED')
        if index < 60:
            time.sleep(5)
    report = {'runId': run_id, 'instanceId': 'lhins-ei4hz4fi', 'sourceHead': SOURCE,
              'database': database, 'restoreDatabase': restore, 'restoreCounts': counts,
              'syntheticBusinessDigest':business_digest, 'stabilityWindowSeconds':300,
              'backupSha256': hashlib.sha256(backup).hexdigest(), 'localObjectRestoreSha256': object_hash,
              'publicChecks': observed, 'stabilitySamples': samples, 'realFundsExecuted': False,
              'productionTouched': False, 'existingStagingDatabaseTouched': False,
              'oldCismeTestImpact': 'UNKNOWN', 's3CosRestoreVerified': False,
              'fullAcceptanceComplete': False, 'releaseReady': False}
    (state / 'acceptance.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 2, 'RUN_ID_REQUIRED')
        main(sys.argv[1])
    except Exception as error:
        print(json.dumps({'ok': False, 'code': str(error) if type(error) is RuntimeError else 'ACCEPTANCE_FAILED_REVIEW_REQUIRED'}))
        sys.exit(1)
