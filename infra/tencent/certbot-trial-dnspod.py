#!/opt/cisme-maintenance/bin/python
"""Root-only Certbot DNS hooks for staging-api.cisme.cn, using existing IAM.

No new credential, DNS read/list permission, other certificate or record scope.
Cleanup deletes only the RecordId saved after this hook's own CreateRecord.
State is separate from the existing api.cisme.cn hook and retained on failure.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

CERTIFICATE_DOMAIN = 'staging-api.cisme.cn'
DOMAIN = 'cisme.cn'
DOMAIN_ID = 99932402
HOST = '_acme-challenge.staging-api'
CREDENTIAL_FILE = Path('/etc/cisme/maintenance.json')
STATE_DIR = Path('/var/lib/cisme-acme-trial')
AUTHORITIES = ('wood.dnspod.net', 'bee.dnspod.net')
POLL_ATTEMPTS = 60


class HookError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise HookError(code)


def challenge(action):
    require(action in ('auth', 'cleanup'), 'TRIAL_ACME_ACTION_REQUIRED')
    require(os.geteuid() == 0, 'TRIAL_ACME_ROOT_REQUIRED')
    require(os.environ.get('CERTBOT_DOMAIN') == CERTIFICATE_DOMAIN, 'TRIAL_ACME_DOMAIN_REFUSED')
    validation = os.environ.get('CERTBOT_VALIDATION', '')
    require(re.fullmatch(r'[A-Za-z0-9_-]{43}', validation), 'TRIAL_ACME_VALIDATION_INVALID')
    return validation, hashlib.sha256(validation.encode('ascii')).hexdigest()


def root_parents(path):
    require(path.is_absolute() and '..' not in path.parts, 'TRIAL_ACME_PATH_UNSAFE')
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o022 == 0,
                'TRIAL_ACME_PARENT_UNSAFE')


def protected_bytes(path, limit=65536):
    root_parents(path)
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600
                and info.st_size <= limit, 'TRIAL_ACME_FILE_UNSAFE')
        data = os.read(fd, limit + 1)
        require(len(data) == info.st_size, 'TRIAL_ACME_FILE_CHANGED')
        return data
    finally:
        os.close(fd)


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'TRIAL_ACME_DUPLICATE_STATE_KEY')
        result[key] = value
    return result


def ensure_state_directory(create):
    root_parents(STATE_DIR)
    if not STATE_DIR.exists() and not STATE_DIR.is_symlink():
        if not create:
            return False
        STATE_DIR.mkdir(mode=0o700)
    info = STATE_DIR.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
            'TRIAL_ACME_STATE_DIRECTORY_UNSAFE')
    return True


def cloud_client():
    # Imported only after action/domain/state checks. Unit tests are offline and
    # do not need the maintenance environment's Tencent SDK or real credentials.
    from tencentcloud.common import credential
    from tencentcloud.dnspod.v20210323 import dnspod_client, models
    settings = json.loads(protected_bytes(CREDENTIAL_FILE), object_pairs_hook=unique_keys)
    require(all(isinstance(settings.get(key), str) and settings[key] for key in ('accessKeyId', 'secretAccessKey')),
            'TRIAL_ACME_EXISTING_CREDENTIAL_REQUIRED')
    return dnspod_client.DnspodClient(credential.Credential(settings['accessKeyId'], settings['secretAccessKey']), ''), models


def read_state(path, digest):
    record = json.loads(protected_bytes(path), object_pairs_hook=unique_keys)
    expected = {'schemaVersion': 1, 'certificateDomain': CERTIFICATE_DOMAIN, 'domain': DOMAIN,
                'domainId': DOMAIN_ID, 'subdomain': HOST, 'validationSha256': digest}
    require(set(record) == set(expected) | {'recordId'} and all(record.get(key) == value for key, value in expected.items())
            and type(record.get('recordId')) is int and record['recordId'] > 0, 'TRIAL_ACME_STATE_BINDING_REQUIRED')
    return record


def write_created_state(path, digest, record_id):
    require(type(record_id) is int and record_id > 0, 'TRIAL_ACME_CREATE_RECEIPT_INVALID')
    record = {'schemaVersion': 1, 'certificateDomain': CERTIFICATE_DOMAIN, 'domain': DOMAIN,
              'domainId': DOMAIN_ID, 'subdomain': HOST, 'validationSha256': digest, 'recordId': record_id}
    data = (json.dumps(record, sort_keys=True) + '\n').encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(fd)


def delete_saved_record(path, digest, client, models):
    if not path.exists() and not path.is_symlink():
        return
    record = read_state(path, digest)
    request = models.DeleteRecordRequest()
    request.from_json_string(json.dumps({'Domain': DOMAIN, 'DomainId': DOMAIN_ID, 'RecordId': record['recordId']}))
    client.DeleteRecord(request)
    # Retain the protected RecordId if the API fails. Never infer a replacement
    # from hostname lookup or delete other TXT values at the same challenge host.
    require(read_state(path, digest) == record, 'TRIAL_ACME_STATE_CHANGED_BEFORE_CLEANUP')
    path.unlink()


def propagated(validation):
    for server in AUTHORITIES:
        result = subprocess.run(['dig', '+time=3', '+tries=1', '+short', '@' + server,
                                 HOST + '.' + DOMAIN, 'TXT'], capture_output=True, text=True, timeout=5)
        if result.returncode != 0 or ('"' + validation + '"') not in result.stdout.splitlines():
            return False
    return True


def run_hook(action):
    validation, digest = challenge(action)
    if not ensure_state_directory(action == 'auth'):
        return
    state = STATE_DIR / (digest + '.json')
    if action == 'cleanup' and not state.exists() and not state.is_symlink():
        return
    lock = STATE_DIR / (digest + '.lock')
    fd = os.open(lock, os.O_WRONLY | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600,
                'TRIAL_ACME_LOCK_UNSAFE')
        fcntl.flock(fd, fcntl.LOCK_EX)
        if state.exists() or state.is_symlink():
            read_state(state, digest)  # Refuse unknown IDs before loading credentials.
        client, models = cloud_client()
        if action == 'cleanup':
            delete_saved_record(state, digest, client, models)
            return
        if not state.exists():
            request = models.CreateRecordRequest()
            request.from_json_string(json.dumps({'Domain': DOMAIN, 'DomainId': DOMAIN_ID, 'SubDomain': HOST,
                                                'RecordType': 'TXT', 'RecordLine': '默认', 'Value': validation, 'TTL': 600}))
            record_id = client.CreateRecord(request).RecordId
            # No record deletion is attempted unless its own ID was successfully
            # persisted. An interrupted write remains a protected manual-review
            # state, rather than guessing which TXT record belongs to this run.
            write_created_state(state, digest, record_id)
        try:
            for attempt in range(POLL_ATTEMPTS):
                if propagated(validation):
                    return
                if attempt + 1 < POLL_ATTEMPTS:
                    time.sleep(10)
            raise HookError('TRIAL_ACME_DNS_PROPAGATION_TIMEOUT')
        except BaseException:
            delete_saved_record(state, digest, client, models)
            raise
    finally:
        os.close(fd)


def main():
    try:
        require(len(sys.argv) == 2, 'TRIAL_ACME_ACTION_REQUIRED')
        run_hook(sys.argv[1])
        return 0
    except BaseException as error:
        # SDK errors can contain request details. Only our stable error codes
        # leave the hook; credential values, tokens and RecordIds are never logged.
        code = str(error) if isinstance(error, HookError) else 'TRIAL_ACME_OPERATION_FAILED_REVIEW_REQUIRED'
        # Surface an existing-credential permission refusal without raw SDK text
        # and without attempting another identity or widening its IAM policy.
        provider_code = error.get_code() if callable(getattr(error, 'get_code', None)) else ''
        if isinstance(provider_code, str) and provider_code.startswith(('UnauthorizedOperation', 'AuthFailure')):
            code = 'TRIAL_ACME_EXISTING_CREDENTIAL_PERMISSION_DENIED'
        print(code, file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
