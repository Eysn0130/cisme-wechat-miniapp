#!/usr/bin/env python3
"""Read the original production migration journal without executing candidate SQL.

Uses local peer authentication to the fixed cisme database. No connection URL,
business row, role password, query text or driver error is exported. A valid
name prefix is necessary but does not prove that historical SQL was unchanged.
"""
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('production_observation', HERE / 'production-observation.py')
observation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observation)
require = observation.target.require


def query(sql):
    result = subprocess.run(['/usr/sbin/runuser', '-u', 'postgres', '--', '/usr/bin/psql', '-XAt',
                             '-v', 'ON_ERROR_STOP=1', '-d', 'cisme', '-c', sql],
                            capture_output=True, timeout=15,
                            env={'PATH': '/usr/bin:/bin', 'PGOPTIONS':
                                 '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000'})
    require(result.returncode == 0 and len(result.stdout) <= 1024 * 1024,
            'PRODUCTION_JOURNAL_READ_FAILED')
    return json.loads(result.stdout)


def versions(value):
    require(isinstance(value, list) and 0 < len(value) <= 10000, 'MIGRATION_JOURNAL_REQUIRED')
    require(all(isinstance(v, str) and re.fullmatch(r'\d+_[A-Za-z0-9_-]+\.sql', v) for v in value),
            'MIGRATION_VERSION_INVALID')
    require(value == sorted(set(value)), 'MIGRATION_JOURNAL_ORDER_INVALID')
    return value


def compare(applied, candidate):
    applied, candidate = versions(applied), versions(candidate)
    require(candidate[:len(applied)] == applied, 'PRODUCTION_HISTORY_NOT_CANDIDATE_PREFIX')
    return {'applied': len(applied), 'pending': candidate[len(applied):],
            'journalIsCandidatePrefix': True, 'historicalSqlIntegrityVerified': False,
            'migrationApproved': False}


def inspect(read=query):
    # Live target/resource guard precedes even the read-only database session.
    identity = observation.identity()
    runtime = observation.runtime(observation.protected_environment(observation.LIVE_ENV))
    found = read("SELECT json_build_object('database',current_database(),'readOnly',current_setting('transaction_read_only'),"
                 "'journalPresent',to_regclass('public.schema_migration') IS NOT NULL)")
    require(found.get('database') == 'cisme' and found.get('readOnly') == 'on', 'ORIGINAL_READ_ONLY_DATABASE_REQUIRED')
    require(found.get('journalPresent') is True, 'EXISTING_PRODUCTION_JOURNAL_REQUIRED')
    journal = versions(read("SELECT coalesce(json_agg(version ORDER BY version),'[]') FROM public.schema_migration"))
    metadata = read("SELECT json_build_object('tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'),"
                    "'constraints',(SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace),"
                    "'unvalidatedConstraints',(SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated))")
    require(set(metadata) == {'tables', 'constraints', 'unvalidatedConstraints'} and
            all(type(v) is int and v >= 0 for v in metadata.values()), 'SCHEMA_METADATA_INVALID')
    fingerprint = hashlib.sha256(json.dumps(journal, separators=(',', ':')).encode()).hexdigest()
    return {'schemaVersion': 1, 'observedAtUtc': datetime.now(timezone.utc).isoformat(),
            'identity': identity, 'actualRuntime': runtime, 'journal': journal,
            'journalNamesSha256': fingerprint, 'schemaCounts': metadata, 'readOnly': True,
            'historicalSqlIntegrityVerified': False, 'productionRestoreVerified': False,
            'migrationExecuted': False, 'permissionGranted': False}


if __name__ == '__main__':
    try:
        print(json.dumps(inspect(), sort_keys=True))
    except observation.target.Refused as error:
        print(json.dumps({'ok': False, 'code': str(error), 'readOnly': True}))
        raise SystemExit(1)
    except Exception:
        print('{"ok":false,"code":"PRODUCTION_JOURNAL_AUDIT_FAILED","readOnly":true}')
        raise SystemExit(1)
