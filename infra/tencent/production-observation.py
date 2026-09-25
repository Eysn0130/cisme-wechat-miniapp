#!/usr/bin/env python3
"""Live, read-only input collector for production-target.py.

Never accepts identity JSON from the caller. The Lighthouse-to-host mapping was
observed through its authenticated TAT session on 2026-09-23 (see evidence).
This collects facts; it does not grant migration, network or credential approval.
"""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import stat
import urllib.request

HERE = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


target = module('production_target', 'production-target.py')
audit = module('production_audit', 'production-security-audit.py')
LIVE_ENV = Path('/opt/cisme/runtime.env')
HOST_BINDING = {'instance-id': 'ins-l9utqwxv', 'local-ipv4': '10.0.0.10',
                'public-ipv4': '124.223.74.198'}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise target.Refused('METADATA_REDIRECT_REFUSED')


def metadata(field):
    target.require(field in HOST_BINDING, 'METADATA_FIELD_REFUSED')
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open('http://metadata.tencentyun.com/latest/meta-data/' + field, timeout=3) as response:
        target.require(response.status == 200, 'METADATA_RESPONSE_REQUIRED')
        value = response.read(129)
    target.require(len(value) <= 128, 'METADATA_RESPONSE_TOO_LARGE')
    text = value.decode('ascii').strip()
    target.require(re.fullmatch(r'[A-Za-z0-9.-]{1,80}', text), 'METADATA_FORMAT_INVALID')
    return text


def identity(read_metadata=metadata, resolve=socket.getaddrinfo, hostname=socket.gethostname):
    observed = {key: read_metadata(key) for key in HOST_BINDING}
    target.require(observed == HOST_BINDING and hostname() == 'VM-0-10-ubuntu', 'LIVE_PRODUCTION_HOST_MISMATCH')
    addresses = sorted({row[4][0] for row in resolve('api.cisme.cn', 443, socket.AF_INET, socket.SOCK_STREAM)})
    target.require(addresses == [observed['public-ipv4']], 'LIVE_PRODUCTION_DNS_MISMATCH')
    return {'schemaVersion': 1, 'instanceId': target.TARGET['instanceId'],
            'metadataInstanceId': observed['instance-id'], 'privateIpv4': observed['local-ipv4'],
            'publicIpv4': observed['public-ipv4'], 'domain': 'api.cisme.cn', 'dnsA': addresses[0],
            'observedAtUtc': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'mappingEvidence': 'PRODUCTION-LIVE-METADATA-20260923.json'}


def protected_environment(path):
    path = Path(path)
    target.require(path.is_absolute(), 'ABSOLUTE_ENV_PATH_REQUIRED')
    # Refuse link substitution and world-readable configuration. Never echo data
    # or parser exceptions; the CLI emits only an allowlisted error code.
    flags = os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        target.require(stat.S_ISREG(info.st_mode) and info.st_size <= 65536
                       and info.st_uid in (0, os.geteuid())
                       and info.st_mode & 0o027 == 0, 'PROTECTED_ENV_REQUIRED')
        content = os.read(fd, 65537)
        target.require(len(content) <= 65536, 'ENV_TOO_LARGE')
        return audit.environment(content.decode('utf-8'))
    finally:
        os.close(fd)


def runtime(config):
    safe, _ = audit.database(config.get('DATABASE_URL', ''))
    target.require(safe['role'] == 'cisme' and safe['port'] == 5432, 'ORIGINAL_PRODUCTION_DATABASE_REQUIRED')
    # All returned values are checked against the fixed resource identities.
    value = {'appEnv': config.get('APP_ENV'), 'databaseHost': safe['host'],
             'databaseName': safe['databaseName'], 'objectStorageDriver': config.get('OBJECT_STORAGE_DRIVER'),
             'objectBucket': config.get('S3_BUCKET')}
    target.require(all(value.get(k) == v for k, v in target.RESOURCES.items() if k != 'appEnv'),
                   'ORIGINAL_PRODUCTION_RESOURCES_REQUIRED')
    target.require(value['appEnv'] in ('production', 'staging'), 'PRODUCTION_ENV_LABEL_UNEXPECTED')
    return value


def guard_for_upgrade(candidate_env, manifest, main_sha, main_tree):
    """Deployment entry calls immediately before migration and activation.

    main binding must independently come from GitHub and the verified artifact;
    this function does not assert CI, backup, policy or device acceptance.
    """
    live_identity = identity()
    live = protected_environment(LIVE_ENV)
    runtime(live)
    candidate = protected_environment(candidate_env)
    target.require(candidate.get('DATABASE_URL') == live.get('DATABASE_URL'), 'DATABASE_REPLACEMENT_OR_ROTATION_REFUSED')
    for key in ('S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET', 'S3_ENDPOINT', 'S3_REGION'):
        target.require(candidate.get(key) == live.get(key), 'STORAGE_REBINDING_REFUSED')
    return target.assert_production_target(live_identity, runtime(candidate), manifest, main_sha, main_tree)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate-env')
    parser.add_argument('--manifest')
    parser.add_argument('--main-sha')
    parser.add_argument('--main-tree')
    args = parser.parse_args()
    try:
        fields = [args.candidate_env, args.manifest, args.main_sha, args.main_tree]
        if any(fields):
            target.require(all(fields), 'COMPLETE_CANDIDATE_BINDING_REQUIRED')
            result = guard_for_upgrade(args.candidate_env, target.read_json(args.manifest), args.main_sha, args.main_tree)
        else:
            result = {'identity': identity(), 'actualRuntime': runtime(protected_environment(LIVE_ENV)),
                      'readOnly': True, 'deployed': False, 'permissionGranted': False}
        print(json.dumps(result, sort_keys=True))
        return 0
    except target.Refused as error:
        print(json.dumps({'ok': False, 'code': str(error)}))
    except Exception:
        print(json.dumps({'ok': False, 'code': 'LIVE_PRODUCTION_OBSERVATION_FAILED'}))
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
