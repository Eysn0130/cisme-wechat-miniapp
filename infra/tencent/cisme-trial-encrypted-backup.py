#!/opt/cisme-maintenance/bin/python
"""Database-only trial backups. Default preflight is read-only; never restores SQL.

Run as cisme-trial, never root/postgres. All targets are fixed and independent of
production. PostgreSQL plaintext travels only through pipes. A verified archive
is not full recovery qualification: objects and latest erasure markers are not
part of this snapshot and must be recovered separately before serving members.
"""
import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import tempfile
import uuid

USER = 'cisme-trial'
DATABASE = ROLE = 'cisme_trial'
DIRECTORY = Path('/var/backups/cisme-trial-encrypted')
CONFIG_DIRECTORY = Path('/etc/cisme-trial-backup')
RUNTIME = Path('/opt/cisme-trial/runtime.env')
KEY_FILE = CONFIG_DIRECTORY / 'backup-aes256.key'
COS_FILE = CONFIG_DIRECTORY / 'cos.json'
BUCKET = 'lhcos-81ddf-1257392443'
REGION = 'ap-shanghai'
PREFIX = 'backups/cisme-trial/postgres/'
MANIFEST = PREFIX + 'manifest.json'
MAGIC = b'CISMETRIALBK1'
AAD = MAGIC + b'\0cisme_trial\0' + PREFIX.encode()
CHUNK = 1024 * 1024
NAME = re.compile(r'cisme-trial-(\d{8}T\d{6}Z)-[0-9a-f]{32}\.dump\.aesgcm')


class Refused(RuntimeError):
    pass


def require(condition, code):
    if not condition:
        raise Refused(code)


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'TRIAL_BACKUP_DUPLICATE_SETTING')
        result[key] = value
    return result


def checked_parents(path):
    for parent in reversed(path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and info.st_mode & 0o022 == 0, 'TRIAL_BACKUP_PARENT_UNSAFE')


def protected_file(path, group, limit):
    checked_parents(path)
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == group
                and stat.S_IMODE(info.st_mode) == 0o640 and info.st_nlink == 1
                and info.st_size <= limit, 'TRIAL_BACKUP_PRIVATE_INPUT_UNSAFE')
        data = os.read(fd, limit + 1)
        require(len(data) == info.st_size, 'TRIAL_BACKUP_PRIVATE_INPUT_CHANGED')
        return data
    finally:
        os.close(fd)


def check_directory(account):
    checked_parents(DIRECTORY)
    info = DIRECTORY.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == account.pw_uid
            and info.st_gid == account.pw_gid and stat.S_IMODE(info.st_mode) == 0o700,
            'TRIAL_BACKUP_DIRECTORY_UNSAFE')


def pg_environment(config):
    url = config.get('DATABASE_URL', '')
    match = re.fullmatch(r'postgresql://cisme_trial:([a-f0-9]{64})@127\.0\.0\.1:5432/cisme_trial', url)
    require(match and config.get('APP_ENV') == 'staging'
            and config.get('PRIVACY_SUPPRESSION_DIR') == '/opt/cisme-trial/privacy-suppression'
            and config.get('OBJECT_STORAGE_DRIVER') == 'api_gateway', 'TRIAL_BACKUP_RUNTIME_REQUIRED')
    for name in ('COMMERCE_ORDER_FLOW_ENABLED', 'COMMERCE_SIMULATED_PAYMENT_ENABLED',
                 'COMMERCE_FULFILLMENT_ENABLED', 'POINTS_REDEMPTION_ENABLED',
                 'POINTS_RULES_ENABLED', 'UGC_GO_LIVE_GATE', 'COS_DIRECT_UPLOAD_ENABLED'):
        require(config.get(name) == 'false', 'TRIAL_BACKUP_CLOSED_CAPABILITIES_REQUIRED')
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'PGHOST': '127.0.0.1',
            'PGPORT': '5432', 'PGUSER': ROLE, 'PGDATABASE': DATABASE,
            'PGPASSWORD': match[1], 'PGCONNECT_TIMEOUT': '5',
            'PGAPPNAME': 'cisme-trial-encrypted-backup',
            'PGOPTIONS': '-c default_transaction_read_only=on'}


def runtime_settings(data):
    pairs = []
    for line in data.decode().splitlines():
        if not line or line.startswith('#'):
            continue
        require('=' in line, 'TRIAL_BACKUP_RUNTIME_INVALID')
        pairs.append(line.split('=', 1))
    return unique_pairs(pairs)


def check_database(env):
    # Reads metadata in cisme_trial only; never attempts a production connection.
    sql = """SELECT json_build_object('database',current_database(),'role',current_user,
      'owner',pg_get_userbyid(d.datdba),'superuser',r.rolsuper,'createdb',r.rolcreatedb,
      'createrole',r.rolcreaterole,'replication',r.rolreplication,'bypassrls',r.rolbypassrls,
      'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=r.oid))
      FROM pg_roles r CROSS JOIN pg_database d
      WHERE r.rolname=current_user AND d.datname=current_database();"""
    result = subprocess.run(['/usr/bin/psql', '-X', '-A', '-t', '--set=ON_ERROR_STOP=1',
                             '--command', sql], env=env, capture_output=True, timeout=15)
    require(result.returncode == 0 and len(result.stdout) < 4096, 'TRIAL_BACKUP_DATABASE_CHECK_FAILED')
    facts = json.loads(result.stdout)
    require(facts.get('database') == DATABASE and facts.get('role') == ROLE
            and facts.get('owner') == ROLE and facts.get('memberships') == 0
            and all(facts.get(field) is False for field in ('superuser', 'createdb', 'createrole',
                'replication', 'bypassrls')), 'TRIAL_BACKUP_DATABASE_ISOLATION_REQUIRED')


def make_client(settings):
    from qcloud_cos import CosConfig, CosS3Client
    require(set(settings) == {'accessKeyId', 'secretAccessKey'}
            and all(isinstance(value, str) and 8 <= len(value) <= 256
                    and not any(char.isspace() for char in value) for value in settings.values()),
            'TRIAL_BACKUP_DEDICATED_COS_SETTINGS_REQUIRED')
    return CosS3Client(CosConfig(Region=REGION, SecretId=settings['accessKeyId'],
                               SecretKey=settings['secretAccessKey'], Scheme='https'))


def archive_date(key):
    require(isinstance(key, str) and key.startswith(PREFIX), 'TRIAL_BACKUP_FOREIGN_OBJECT_REFUSED')
    match = NAME.fullmatch(key[len(PREFIX):])
    require(match, 'TRIAL_BACKUP_FOREIGN_OBJECT_REFUSED')
    return datetime.strptime(match[1], '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)


def validate_manifest(objects):
    require(isinstance(objects, list) and len(objects) <= 10000, 'TRIAL_BACKUP_MANIFEST_INVALID')
    seen = set()
    for item in objects:
        require(isinstance(item, dict) and set(item) == {'Key', 'sha256', 'bytes'},
                'TRIAL_BACKUP_MANIFEST_INVALID')
        archive_date(item['Key'])
        require(item['Key'] not in seen and isinstance(item['sha256'], str)
                and re.fullmatch(r'[a-f0-9]{64}', item['sha256']) and type(item['bytes']) is int
                and item['bytes'] > len(MAGIC) + 28, 'TRIAL_BACKUP_MANIFEST_INVALID')
        seen.add(item['Key'])
    return objects


def read_manifest(client):
    try:
        response = client.get_object(Bucket=BUCKET, Key=MANIFEST)
    except Exception as error:
        # Only a genuine missing manifest permits first use. 403 never becomes []
        if (getattr(error, 'get_status_code', lambda: None)() == 404
                and getattr(error, 'get_error_code', lambda: None)() == 'NoSuchKey'):
            return []
        raise Refused('TRIAL_BACKUP_REMOTE_MANIFEST_READ_DENIED') from None
    stream = response['Body'].get_raw_stream()
    try:
        data = stream.read(1024 * 1024 + 1)
        require(len(data) <= 1024 * 1024, 'TRIAL_BACKUP_MANIFEST_TOO_LARGE')
        return validate_manifest(json.loads(data, object_pairs_hook=unique_pairs))
    finally:
        stream.close()


def preflight():
    account = pwd.getpwnam(USER)
    require(os.geteuid() == account.pw_uid and account.pw_uid != 0
            and os.getegid() == account.pw_gid and set(os.getgroups()) <= {account.pw_gid},
            'TRIAL_BACKUP_DEDICATED_IDENTITY_REQUIRED')
    check_directory(account)
    key = protected_file(KEY_FILE, account.pw_gid, 32)
    require(len(key) == 32, 'TRIAL_BACKUP_AES256_KEY_REQUIRED')
    config = runtime_settings(protected_file(RUNTIME, account.pw_gid, 65536))
    env = pg_environment(config)
    check_database(env)
    settings = json.loads(protected_file(COS_FILE, account.pw_gid, 4096), object_pairs_hook=unique_pairs)
    client = make_client(settings)
    objects = read_manifest(client)
    return key, env, client, objects


def encrypt_stream(source, key, destination):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    nonce = os.urandom(12)
    encryptor = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
    encryptor.authenticate_additional_data(AAD)
    with destination.open('xb') as output:
        try:
            output.write(MAGIC + nonce)
            while chunk := source.read(CHUNK):
                output.write(encryptor.update(chunk))
            output.write(encryptor.finalize())
            output.write(encryptor.tag)
            output.flush()
            os.fsync(output.fileno())
        except BaseException:
            destination.unlink(missing_ok=True)
            raise


def decrypt_to_stream(source, key, output):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    require(source.stat().st_size > len(MAGIC) + 28, 'TRIAL_BACKUP_ARCHIVE_TRUNCATED')
    with source.open('rb') as input_file:
        require(input_file.read(len(MAGIC)) == MAGIC, 'TRIAL_BACKUP_ARCHIVE_CONTEXT_REQUIRED')
        nonce = input_file.read(12)
        input_file.seek(-16, 2)
        tag = input_file.read(16)
        remaining = source.stat().st_size - len(MAGIC) - 28
        input_file.seek(len(MAGIC) + 12)
        decryptor = Cipher(algorithms.AES(key), modes.GCM(nonce, tag)).decryptor()
        decryptor.authenticate_additional_data(AAD)
        while remaining:
            chunk = input_file.read(min(CHUNK, remaining))
            require(chunk, 'TRIAL_BACKUP_ARCHIVE_TRUNCATED')
            output.write(decryptor.update(chunk))
            remaining -= len(chunk)
        output.write(decryptor.finalize())


def file_sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def encrypted_dump(key, env, destination):
    process = subprocess.Popen(['/usr/bin/pg_dump', '--format=custom', '--no-owner', '--no-acl'],
                               env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        with process.stdout:
            encrypt_stream(process.stdout, key, destination)
        if process.wait(timeout=30) != 0:
            destination.unlink(missing_ok=True)
            raise Refused('TRIAL_BACKUP_DUMP_FAILED')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def verify_archive(path, key):
    class DiscardSink:
        def write(self, data):
            pass

    # Authenticate first, before any PostgreSQL parser consumes plaintext.
    # The second pass still uses only pipes; no plaintext archive reaches disk.
    decrypt_to_stream(path, key, DiscardSink())
    # --list may exit after the TOC without consuming the complete custom dump.
    # Still authenticate every ciphertext byte; its pipe is only a read-only
    # parser and never receives database credentials or runs restored SQL.
    class ListSink:
        def __init__(self, stream):
            self.stream = stream
            self.closed_early = False

        def write(self, data):
            if not self.closed_early:
                try:
                    self.stream.write(data)
                except BrokenPipeError:
                    self.closed_early = True

    process = subprocess.Popen(['/usr/bin/pg_restore', '--list'], stdin=subprocess.PIPE,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    try:
        decrypt_to_stream(path, key, ListSink(process.stdin))
        try:
            process.stdin.close()
        except BrokenPipeError:
            pass
        require(process.wait(timeout=30) == 0, 'TRIAL_BACKUP_ARCHIVE_UNREADABLE')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        if not process.stdin.closed:
            try:
                process.stdin.close()
            except BrokenPipeError:
                pass


def retention_plan(objects, now):
    validate_manifest(objects)
    require(now.tzinfo is not None, 'TRIAL_BACKUP_RETENTION_TIME_REQUIRED')
    ordered = sorted(objects, key=lambda item: archive_date(item['Key']), reverse=True)
    require(all(archive_date(item['Key']) <= now for item in ordered), 'TRIAL_BACKUP_MANIFEST_FUTURE_DATE')
    retained, removed = ordered[:7], []
    for item in ordered[7:]:
        (removed if archive_date(item['Key']) < now - timedelta(days=30) else retained).append(item)
    return retained, removed


def write_receipt(evidence):
    with tempfile.NamedTemporaryFile(dir=DIRECTORY, prefix='.receipt-', delete=False) as output:
        temporary = Path(output.name)
        try:
            output.write((json.dumps(evidence, sort_keys=True) + '\n').encode())
            output.flush()
            os.fsync(output.fileno())
            os.replace(temporary, DIRECTORY / 'last-success.json')
        finally:
            temporary.unlink(missing_ok=True)


def backup():
    os.umask(0o077)
    key, env, client, previous = preflight()
    fd = os.open(DIRECTORY / '.backup.lock', os.O_WRONLY | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0,
                'TRIAL_BACKUP_LOCK_UNSAFE')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Read again under the lock; preflight and another run can overlap.
        previous = read_manifest(client)
        now = datetime.now(timezone.utc)
        filename = f'cisme-trial-{now:%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex}.dump.aesgcm'
        encrypted = DIRECTORY / filename
        encrypted_dump(key, env, encrypted)
        digest = file_sha(encrypted)
        verify_archive(encrypted, key)
        object_key = PREFIX + filename
        with encrypted.open('rb') as source:
            client.put_object(Bucket=BUCKET, Key=object_key, Body=source, ContentType='application/octet-stream')
        with tempfile.TemporaryDirectory(prefix='.remote-', dir=DIRECTORY) as scratch:
            downloaded = Path(scratch) / 'verified.aesgcm'
            client.get_object(Bucket=BUCKET, Key=object_key)['Body'].get_stream_to_file(str(downloaded))
            require(file_sha(downloaded) == digest, 'TRIAL_BACKUP_REMOTE_CHECKSUM_MISMATCH')
            verify_archive(downloaded, key)
        new = {'Key': object_key, 'sha256': digest, 'bytes': encrypted.stat().st_size}
        retained, removed = retention_plan(previous + [new], datetime.now(timezone.utc))
        for item in removed:
            client.delete_object(Bucket=BUCKET, Key=item['Key'])
        client.put_object(Bucket=BUCKET, Key=MANIFEST, Body=json.dumps(retained).encode(), ContentType='application/json')
        require(read_manifest(client) == retained, 'TRIAL_BACKUP_REMOTE_MANIFEST_VERIFY_FAILED')
        evidence = {'schemaVersion': 1, 'atUtc': now.isoformat(), 'database': DATABASE,
                    'scope': 'database-only', 'objectKey': object_key, 'sha256': digest, 'bytes': new['bytes'],
                    'remoteChecksumVerified': True, 'authenticationVerified': True, 'archiveReadable': True,
                    'remoteRetentionDays': 30, 'remoteMinimumCopies': 7, 'remoteDeleted': len(removed),
                    'fullRecoveryQualified': False, 'admissionMayOpen': False}
        write_receipt(evidence)
        # Never treat an interrupted/untracked local archive as a verified copy.
        verified_names = {item['Key'][len(PREFIX):] for item in previous + [new]}
        candidates = sorted((path for path in DIRECTORY.iterdir() if path.name in verified_names), reverse=True)
        for old in candidates[7:]:
            info = old.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                    and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
                    'TRIAL_BACKUP_LOCAL_RETENTION_FILE_UNSAFE')
            old.unlink()
        return evidence
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', choices=('preflight', 'backup'), default='preflight')
    args = parser.parse_args()
    try:
        if args.action == 'preflight':
            preflight()
            result = {'schemaVersion': 1, 'preflight': True, 'database': DATABASE, 'prefix': PREFIX,
                      'scope': 'database-only', 'readOnly': True, 'fullRecoveryQualified': False,
                      'admissionMayOpen': False}
        else:
            result = backup()
        print(json.dumps(result, sort_keys=True))
    except Exception as error:
        # SDK/Pg error text can contain private inputs. Only our bounded codes escape.
        code = str(error) if isinstance(error, Refused) else 'TRIAL_BACKUP_OPERATION_FAILED'
        print(json.dumps({'ok': False, 'code': code}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
