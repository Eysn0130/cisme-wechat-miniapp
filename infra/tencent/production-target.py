#!/usr/bin/env python3
"""Read-only wrong-target guard, NOT a deployment or release approval tool.

Inputs must be collected by the authenticated operator on the actual target.
This checks consistency/freshness, not the authenticity of operator-supplied JSON.
Run again immediately before migration/activation; keep input files protected.
Do not use a historical ENVIRONMENTS.json as a current identity observation.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys

TARGET = {'instanceId': 'lhins-61ikz4mi', 'publicIpv4': '124.223.74.198',
          'domain': 'api.cisme.cn', 'dnsA': '124.223.74.198'}
# These resource identities preserve the existing production data, not staging.
RESOURCES = {'appEnv': 'production', 'databaseHost': '127.0.0.1',
             'databaseName': 'cisme', 'objectStorageDriver': 'cos_gateway',
             'objectBucket': 'lhcos-81ddf-1257392443'}
MAX_AGE_SECONDS = 900


class Refused(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Refused(code)


def git_sha(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{40}', value) is not None and value != '0' * 40


def assert_production_target(identity, runtime, manifest, main_sha, main_tree, now=None):
    """Validate sanitized current observations and a reviewed main candidate.

    runtime describes the CANDIDATE configuration, not the legacy APP_ENV label.
    Returned success grants no permission and proves no live platform acceptance.
    """
    require(all(isinstance(value, dict) for value in [identity, runtime, manifest]), 'INPUT_OBJECT_REQUIRED')
    require(type(identity.get('schemaVersion')) is int and identity['schemaVersion'] == 1,
            'IDENTITY_SCHEMA_REQUIRED')
    require(all(identity.get(key) == value for key, value in TARGET.items()), 'EXACT_PRODUCTION_TARGET_REQUIRED')
    try:
        text = identity['observedAtUtc']
        require(isinstance(text, str) and text.endswith('Z'), 'UTC_OBSERVATION_REQUIRED')
        observed = datetime.fromisoformat(text[:-1] + '+00:00')
        current = now or datetime.now(timezone.utc)
        require(current.tzinfo is not None, 'UTC_OBSERVATION_REQUIRED')
        age = (current - observed).total_seconds()
        require(0 <= age <= MAX_AGE_SECONDS, 'FRESH_TARGET_OBSERVATION_REQUIRED')
    except (KeyError, ValueError, TypeError):
        raise Refused('UTC_OBSERVATION_REQUIRED') from None
    require(all(runtime.get(key) == value for key, value in RESOURCES.items()), 'PRODUCTION_RESOURCE_BINDING_REQUIRED')
    require(git_sha(main_sha) and git_sha(main_tree), 'REVIEWED_MAIN_BINDING_REQUIRED')
    require(type(manifest.get('schemaVersion')) is int and manifest['schemaVersion'] == 1,
            'CANDIDATE_MANIFEST_REQUIRED')
    require(manifest.get('sourceHead') == main_sha and manifest.get('sourceTree') == main_tree,
            'CANDIDATE_NOT_REVIEWED_MAIN')
    require(manifest.get('configurationIncluded') is False, 'SEPARATE_PRODUCTION_CONFIGURATION_REQUIRED')
    return {'targetVerified': True, 'instanceId': TARGET['instanceId'], 'domain': TARGET['domain'],
            'sourceHead': main_sha, 'sourceTree': main_tree, 'permissionGranted': False,
            'deployed': False, 'releaseReady': False}


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def read_json(path):
    with Path(path).open('rb') as stream:
        data = stream.read(65537)
    require(len(data) <= 65536, 'INPUT_TOO_LARGE')
    return json.loads(data.decode('utf-8'), object_pairs_hook=unique_keys)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ['identity', 'runtime', 'manifest', 'main-sha', 'main-tree']:
        parser.add_argument('--' + flag, required=True)
    args = parser.parse_args()
    try:
        result = assert_production_target(read_json(args.identity), read_json(args.runtime),
                                          read_json(args.manifest), args.main_sha, args.main_tree)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Refused as error:
        print(str(error), file=sys.stderr)
    except (OSError, ValueError, TypeError, RecursionError):
        print('PRODUCTION_TARGET_INPUT_INVALID', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
